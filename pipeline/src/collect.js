import { getClient, getMatchRow, upsertMatch, insertSnapshot } from "./db.js";
import { writeTradeBatch } from "./tradeArchive.js";
import { findLiveMatches, getAllTrades, tradeKey, stripCompetitionPrefix } from "./polymarket.js";
import { isMainModule } from "./isMain.js";
import { recomputeWalletsOnResolution } from "./recompute.js";

const COMPETITIONS = ["EPL", "UCL", "UEL"];

// GitHub Actions' cron scheduler can't go below 5 minutes, and isn't even
// guaranteed to fire exactly on schedule under load -- so getting the
// adaptive schedule's tightest tier (every 30s in the final 15 minutes)
// means looping INSIDE one invocation for the whole gap until the next
// cron tick, rather than relying on cron itself for fine-grained timing.
// The 20s safety margin means this run finishes before the next tick fires
// rather than racing it (the workflow also sets concurrency: cancel
// in-progress, as a second guard).
const CRON_TICK_MS = 5 * 60 * 1000;
const RUN_BUDGET_MS = CRON_TICK_MS - 20_000;
const MIN_INNER_LOOP_INTERVAL_MS = 30_000; // the tightest cadence tier below needs

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The adaptive polling schedule from PROJECT.md. The source table's ranges
// overlap slightly around the "~1 hour out" transition (both "every 30/15
// min" and "final hour: every minute" describe roughly the same window) --
// read as a ramp rather than disjoint buckets: frequency increases in
// several small steps as kickoff approaches, then stays at "every minute"
// once inside the truly final hour and while live.
export function pollIntervalMsFor({ minutesToKickoff, isLive }) {
  if (isLive) return 60_000; // every minute during the match
  if (minutesToKickoff <= 15) return 30_000; // final 15 minutes
  if (minutesToKickoff <= 60) return 60_000; // final hour
  if (minutesToKickoff <= 90) return 15 * 60_000; // ~1hr out, ramping down from 30 -> 15
  if (minutesToKickoff <= 180) return 30 * 60_000; // approaching an hour out
  if (minutesToKickoff <= 24 * 60) return 60 * 60_000; // several hours out: hourly
  if (minutesToKickoff <= 2 * 24 * 60) return 4 * 60 * 60_000; // ~1 day out: every 4 hours
  return 24 * 60 * 60_000; // multiple days out: daily
}

export function isDue(lastPolledAt, intervalMs, now = Date.now()) {
  if (!lastPolledAt) return true;
  return now - new Date(lastPolledAt).getTime() >= intervalMs;
}

// A match event has 3 markets (home-win/draw/away-win), each phrased as
// "Will {team} win on {date}?" or "... end in a draw?". Match them back to
// home/draw/away using the team names parsed from the event title.
function classifyMarkets(event) {
  const [homeTeam, awayTeam] = stripCompetitionPrefix(event.title).split(" vs. ").map((s) => s.trim());
  const found = {};
  for (const m of event.markets) {
    if (/end in a draw/i.test(m.question)) found.draw = m;
    else if (m.question.startsWith(`Will ${homeTeam} `)) found.home = m;
    else if (m.question.startsWith(`Will ${awayTeam} `)) found.away = m;
  }
  return { homeTeam, awayTeam, ...found };
}

function yesPrice(market) {
  try {
    const prices = JSON.parse(market.outcomePrices || "[]");
    return prices.length ? Number(prices[0]) : null;
  } catch {
    return null;
  }
}

// Resolved markets settle to ~1/~0. Whichever leg settled to ~1 is the result.
function resultFrom(home, draw, away) {
  if (yesPrice(home) > 0.9) return "home";
  if (yesPrice(draw) > 0.9) return "draw";
  if (yesPrice(away) > 0.9) return "away";
  return null;
}

function kickoffTimeOf(market, event) {
  if (market.gameStartTime) {
    const iso = market.gameStartTime.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(event.endDate);
}

// Only fetches trades newer than what we've already stored per market
// (cursor kept on the match row), so a match with thousands of historical
// trades doesn't get re-fetched in full on every poll -- only genuinely
// new trades cost anything against Polymarket's API.
async function planNewTrades(markets, cursor, fetchTrades = getAllTrades) {
  const lastSeenTimestamp = { ...(cursor.lastSeenTimestamp || {}) };
  // Trades sharing the cursor's exact max timestamp from the previous poll
  // -- needed because a strict `timestamp > since` filter silently and
  // permanently drops any trade that ties the previous poll's max second.
  const lastSeenKeysAtCursor = { ...(cursor.lastSeenKeysAtCursor || {}) };
  const newTrades = [];

  for (const market of markets) {
    const trades = await fetchTrades(market.conditionId);
    const since = lastSeenTimestamp[market.conditionId] || 0;
    const seenAtSince = new Set(lastSeenKeysAtCursor[market.conditionId] || []);

    const fresh = trades.filter((t) => {
      if (t.timestamp > since) return true;
      if (t.timestamp === since) return !seenAtSince.has(tradeKey(t));
      return false;
    });

    if (trades.length > 0) {
      const maxTs = Math.max(...trades.map((t) => t.timestamp));
      lastSeenTimestamp[market.conditionId] = maxTs;
      lastSeenKeysAtCursor[market.conditionId] = trades.filter((t) => t.timestamp === maxTs).map(tradeKey);
    }
    newTrades.push(...fresh);
  }

  return { newTrades, lastSeenTimestamp, lastSeenKeysAtCursor };
}

// `key` is the natural trade id (tradeKey) -- R2 and Turso are separate
// systems with no shared transaction, so a failure between an R2 write
// succeeding and the cursor-advancing Turso write committing could cause a
// retry to write the same trades again under a new R2 key. Storing the
// natural key lets readAllTradesForMatch collapse those duplicates on
// read instead of double-counting them in wallet stats.
function toStoredTrade(t) {
  return { key: tradeKey(t), wallet: t.proxyWallet, side: t.side, size: t.size, price: t.price, timestamp: t.timestamp, outcome: t.outcome, conditionId: t.conditionId };
}

// Returns true if this match was actually polled this pass, false if it
// wasn't due yet -- lets the caller count real work done vs. skipped checks.
async function maybeProcessMatch(client, competition, event, onResolved) {
  const eventId = String(event.id);
  const existing = await getMatchRow(client, eventId);
  if (existing && existing.resolved) return false; // stop polling entirely once resolved

  const { homeTeam, awayTeam, home, draw, away } = classifyMarkets(event);
  if (!home || !draw || !away) return false; // SKIP -- could not classify all 3 markets

  const kickoffTime = kickoffTimeOf(home, event);
  const now = Date.now();
  const minutesToKickoff = (kickoffTime.getTime() - now) / 60000;
  const isLive = minutesToKickoff <= 0;
  const interval = pollIntervalMsFor({ minutesToKickoff, isLive });
  if (!isDue(existing?.last_polled_at, interval, now)) return false;

  const cursor = existing
    ? { lastSeenTimestamp: JSON.parse(existing.last_seen_timestamp || "{}"), lastSeenKeysAtCursor: JSON.parse(existing.last_seen_keys_at_cursor || "{}") }
    : {};
  const { newTrades, lastSeenTimestamp, lastSeenKeysAtCursor } = await planNewTrades([home, draw, away], cursor);

  const resolved = Boolean(home.closed && draw.closed && away.closed);
  const wasResolved = Boolean(existing?.resolved);

  await upsertMatch(client, eventId, {
    competition,
    home_team: homeTeam,
    away_team: awayTeam,
    kickoff_time: kickoffTime.toISOString(),
    polymarket_market_id: eventId,
    resolved,
    result: resolved ? resultFrom(home, draw, away) : null,
    home_condition_id: home.conditionId,
    draw_condition_id: draw.conditionId,
    away_condition_id: away.conditionId,
    last_seen_timestamp: JSON.stringify(lastSeenTimestamp),
    last_seen_keys_at_cursor: JSON.stringify(lastSeenKeysAtCursor),
    last_polled_at: new Date(now).toISOString(),
  });

  await insertSnapshot(client, eventId, {
    capturedAt: new Date(now).toISOString(),
    minutesBeforeKickoff: minutesToKickoff,
    prices: { home: yesPrice(home), draw: yesPrice(draw), away: yesPrice(away) },
    liquidity: Number(home.liquidity || 0) + Number(draw.liquidity || 0) + Number(away.liquidity || 0),
  });

  if (newTrades.length > 0) {
    await writeTradeBatch(client, eventId, now, newTrades.map(toStoredTrade));
  }

  console.log(`  ${event.title}: polled (${minutesToKickoff.toFixed(0)}min to kickoff, next in ${Math.round(interval / 1000)}s), ${newTrades.length} new trade(s)`);

  if (resolved && !wasResolved && onResolved) {
    await onResolved(eventId);
  }
  return true;
}

async function main() {
  const client = getClient();

  console.log("Discovering matches...");
  const matchesByCompetition = {};
  for (const competition of COMPETITIONS) {
    matchesByCompetition[competition] = await findLiveMatches(competition);
    console.log(`[${competition}] ${matchesByCompetition[competition].length} live match(es)`);
  }

  const startedAt = Date.now();
  let totalPolled = 0;
  let totalFailed = 0;

  while (Date.now() - startedAt < RUN_BUDGET_MS) {
    const loopStart = Date.now();
    for (const competition of COMPETITIONS) {
      for (const event of matchesByCompetition[competition]) {
        try {
          const polled = await maybeProcessMatch(client, competition, event, (matchId) => recomputeWalletsOnResolution(client, matchId));
          if (polled) totalPolled++;
        } catch (err) {
          // A cron run every 5 min (with this inner loop covering the gap)
          // is itself a natural retry -- better to skip one flaky match
          // than abort the whole pass.
          totalFailed++;
          console.log(`  ERROR on "${event.title}": ${err.message}`);
        }
      }
    }

    const elapsed = Date.now() - loopStart;
    const remaining = RUN_BUDGET_MS - (Date.now() - startedAt);
    const sleepMs = Math.min(Math.max(0, MIN_INNER_LOOP_INTERVAL_MS - elapsed), remaining);
    if (sleepMs <= 0) break;
    await sleep(sleepMs);
  }

  await client.execute({
    sql: `INSERT INTO pipeline_status (key, last_successful_run, matches_processed, matches_failed)
          VALUES ('status', ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET last_successful_run = excluded.last_successful_run,
            matches_processed = excluded.matches_processed, matches_failed = excluded.matches_failed`,
    args: [new Date().toISOString(), totalPolled, totalFailed],
  });
  console.log(`\nDone. ${totalPolled} poll(s) actually performed, ${totalFailed} failed, over ${Math.round((Date.now() - startedAt) / 1000)}s.`);
}

export { planNewTrades, maybeProcessMatch, classifyMarkets, kickoffTimeOf };

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("Collection run FAILED:", err);
    process.exit(1);
  });
}
