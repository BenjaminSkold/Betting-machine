import { getPool, withTransaction, getMatchRow, upsertMatch, getExistingSnapshotCheckpoints, insertSnapshot, insertTrades } from "./db.js";
import { findLiveMatches, getAllTrades, tradeKey } from "./polymarket.js";
import { isMainModule } from "./isMain.js";

const COMPETITIONS = ["EPL", "UCL", "UEL"];
const CHECKPOINTS_MIN = [60, 15, 10];
const CHECKPOINT_TOLERANCE_MIN = 5; // catches a checkpoint even if cron cadence doesn't land exactly on it

// A match event has 3 markets (home-win/draw/away-win), each phrased as
// "Will {team} win on {date}?" or "... end in a draw?". Match them back to
// home/draw/away using the team names parsed from the event title.
function classifyMarkets(event) {
  const [homeTeam, awayTeam] = event.title.split(" vs. ").map((s) => s.trim());
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
  // gameStartTime looks like "2026-08-05 16:30:00+00" — valid Postgres
  // timestamptz text, but not valid ISO 8601 (needs "+00:00", not "+00").
  if (market.gameStartTime) {
    const iso = market.gameStartTime.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(event.endDate);
}

// Figures out which checkpoint snapshot(s) are due, given the checkpoints
// already stored for this match. Postgres has no per-doc existence-check
// cost the way Firestore did, so the caller just queries once for the whole
// match and passes the resulting Set in — no per-checkpoint round trip.
//
// Returns every due-and-missing checkpoint, not just the first: the
// checkpoints' tolerance windows overlap (15±5=[10,20] and 10±5=[5,15]
// share [10,15]), so a cron run landing in that overlap must be able to
// write both — an early `return` on the first match would silently lose
// checkpoint 10 for any match whose kickoff aligns with the 15-min cron
// grid, which is common. See NOTES.md.
function planSnapshots(existingCheckpoints, home, draw, away, kickoffTime) {
  const minutesToKickoff = (kickoffTime.getTime() - Date.now()) / 60000;
  const due = [];
  for (const checkpoint of CHECKPOINTS_MIN) {
    if (Math.abs(minutesToKickoff - checkpoint) > CHECKPOINT_TOLERANCE_MIN) continue;
    if (existingCheckpoints.has(String(checkpoint))) continue;
    due.push({
      checkpoint,
      data: {
        capturedAt: new Date().toISOString(),
        minutesBeforeKickoff: checkpoint,
        prices: { home: yesPrice(home), draw: yesPrice(draw), away: yesPrice(away) },
        liquidity: Number(home.liquidity || 0) + Number(draw.liquidity || 0) + Number(away.liquidity || 0),
      },
    });
  }
  return due;
}

// Only fetches trades newer than what we've already stored per market
// (cursor kept on the match row), so a match with thousands of historical
// trades doesn't get re-fetched in full on every 15-min run — only
// genuinely new trades cost anything against Polymarket's API.
async function planNewTrades(markets, cursor, fetchTrades = getAllTrades) {
  const lastSeenTimestamp = { ...(cursor.lastSeenTimestamp || {}) };
  // Trades sharing the cursor's exact max timestamp from the previous run —
  // needed because a strict `timestamp > since` filter silently and
  // permanently drops any trade that ties the previous run's max second
  // (plausible on an actively-trading market with many wallets). Found by
  // an independent code review.
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

async function processMatch(pool, competition, event) {
  const { homeTeam, awayTeam, home, draw, away } = classifyMarkets(event);
  if (!home || !draw || !away) {
    console.log(`  SKIP "${event.title}" — could not classify all 3 markets`);
    return;
  }

  const kickoffTime = kickoffTimeOf(home, event);
  const eventId = String(event.id);
  const existing = await getMatchRow(pool, eventId);
  const cursor = existing
    ? { lastSeenTimestamp: existing.last_seen_timestamp || {}, lastSeenKeysAtCursor: existing.last_seen_keys_at_cursor || {} }
    : {};
  const existingCheckpoints = existing ? await getExistingSnapshotCheckpoints(pool, eventId) : new Set();

  const snapshots = planSnapshots(existingCheckpoints, home, draw, away, kickoffTime);
  const { newTrades, lastSeenTimestamp, lastSeenKeysAtCursor } = await planNewTrades([home, draw, away], cursor);

  // All three legs are negRisk-linked and expected to close together, but
  // check all three rather than assume home's flag speaks for the others.
  const resolved = Boolean(home.closed && draw.closed && away.closed);

  await withTransaction(pool, async (client) => {
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
      ...(newTrades.length > 0
        ? {
            last_seen_timestamp: JSON.stringify(lastSeenTimestamp),
            last_seen_keys_at_cursor: JSON.stringify(lastSeenKeysAtCursor),
          }
        : {}),
    });

    for (const snapshot of snapshots) {
      await insertSnapshot(client, eventId, snapshot.checkpoint, snapshot.data);
      console.log(`    snapshot @ ${snapshot.data.minutesBeforeKickoff}min written`);
    }

    await insertTrades(client, eventId, newTrades);
  });

  console.log(`  ${event.title}: ${newTrades.length} new trade(s)`);
}

async function main() {
  const pool = getPool();
  let totalMatches = 0;
  let failedMatches = 0;

  for (const competition of COMPETITIONS) {
    const matches = await findLiveMatches(competition);
    console.log(`[${competition}] ${matches.length} live match(es)`);
    for (const event of matches) {
      try {
        await processMatch(pool, competition, event);
        totalMatches++;
      } catch (err) {
        // Cron runs every 15 min, which is itself a natural retry — better
        // to skip one flaky match than abort the whole run and lose every
        // other match's snapshot/trade update for this cycle.
        failedMatches++;
        console.log(`  ERROR on "${event.title}", skipping this run: ${err.message}`);
      }
    }
  }

  await pool.query(
    `INSERT INTO pipeline_status (key, last_successful_run, matches_processed, matches_failed)
     VALUES ('status', now(), $1, $2)
     ON CONFLICT (key) DO UPDATE SET
       last_successful_run = EXCLUDED.last_successful_run,
       matches_processed = EXCLUDED.matches_processed,
       matches_failed = EXCLUDED.matches_failed`,
    [totalMatches, failedMatches]
  );
  console.log(`\nDone. ${totalMatches} match(es) processed, ${failedMatches} failed. lastSuccessfulRun updated.`);
  await pool.end();
}

export { planSnapshots, planNewTrades, CHECKPOINTS_MIN, CHECKPOINT_TOLERANCE_MIN };

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("Collection run FAILED:", err);
    process.exit(1);
  });
}
