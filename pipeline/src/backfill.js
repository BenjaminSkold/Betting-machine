// One-time historical backfill. Deliberately paced -- see PROJECT.md's
// "Batching writes and pacing the backfill": a large burst of activity
// against a brand-new Turso/R2 project is the most likely thing that
// caused the earlier ~2-day Firestore lockout (never fully confirmed
// whether it was the documented quota or an anti-abuse hold, which is
// exactly why this doesn't take the risk again). This processes one
// bounded batch of matches per invocation and exits -- meant to be run on
// a schedule (see .github/workflows/backfill.yml) so the full backfill
// spreads across many runs over hours/days, not one long burst.
import { getClient, upsertMatch, insertSnapshot, getMatchRow, withTransaction } from "./db.js";
import { writeTradeBatch } from "./tradeArchive.js";
import { findResolvedMatches, getAllTrades, getPriceHistory, clobTokenIdsFor, tradeKey, stripCompetitionPrefix } from "./polymarket.js";

const COMPETITIONS = ["EPL", "UCL", "UEL"];
// Historical price-history reconstruction only has fixed sample points to
// work with (unlike live collection's continuous adaptive polling) -- these
// three checkpoints match the original timing-analysis goal from PROJECT.md.
const CHECKPOINTS_MIN = [60, 15, 10];

const BATCH_SIZE = process.env.BACKFILL_BATCH_SIZE ? Number(process.env.BACKFILL_BATCH_SIZE) : 15;
const DELAY_BETWEEN_MATCHES_MS = process.env.BACKFILL_DELAY_MS ? Number(process.env.BACKFILL_DELAY_MS) : 3000;
// Circuit breaker: if several matches in a row fail, something's more
// likely wrong with the service than with one match -- stop this run
// early and let the next scheduled run retry, rather than hammering
// something that's already struggling.
const MAX_CONSECUTIVE_FAILURES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function kickoffTimeOf(market, event) {
  if (market.gameStartTime) {
    const iso = market.gameStartTime.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(event.endDate);
}

function resultFrom(home, draw, away) {
  if (yesPrice(home) > 0.9) return "home";
  if (yesPrice(draw) > 0.9) return "draw";
  if (yesPrice(away) > 0.9) return "away";
  return null; // postponed/voided/ambiguous — store the match, skip declaring a result
}

async function nearestPriceAt(tokenId, kickoffTime, minutesBefore) {
  if (!tokenId) return null;
  const targetTs = Math.floor(kickoffTime.getTime() / 1000) - minutesBefore * 60;
  const points = await getPriceHistory(tokenId, { startTs: targetTs - 15 * 60, endTs: targetTs + 15 * 60, fidelity: 1 });
  if (points.length === 0) return null;
  let best = points[0];
  for (const p of points) {
    if (Math.abs(p.t - targetTs) < Math.abs(best.t - targetTs)) best = p;
  }
  return best.p;
}

async function buildSnapshotPlan(home, draw, away, kickoffTime) {
  const tokens = { home: clobTokenIdsFor(home)[0], draw: clobTokenIdsFor(draw)[0], away: clobTokenIdsFor(away)[0] };
  const plan = [];
  for (const checkpoint of CHECKPOINTS_MIN) {
    const [homeP, drawP, awayP] = await Promise.all([
      nearestPriceAt(tokens.home, kickoffTime, checkpoint),
      nearestPriceAt(tokens.draw, kickoffTime, checkpoint),
      nearestPriceAt(tokens.away, kickoffTime, checkpoint),
    ]);
    if (homeP === null && drawP === null && awayP === null) continue;
    plan.push({
      capturedAt: null, // backfilled — there was no live "capture" moment
      minutesBeforeKickoff: checkpoint,
      prices: { home: homeP, draw: drawP, away: awayP },
      liquidity: null,
      backfilled: true,
    });
  }
  return plan;
}

// See collect.js's identical comment: `key` lets readAllTradesForMatch
// collapse any duplicate trades a retry might have written under a
// different R2 key.
function toStoredTrade(t) {
  return { key: tradeKey(t), wallet: t.proxyWallet, side: t.side, size: t.size, price: t.price, timestamp: t.timestamp, outcome: t.outcome, conditionId: t.conditionId };
}

async function fetchAllTrades(markets) {
  const allTrades = [];
  for (const market of markets) allTrades.push(...(await getAllTrades(market.conditionId)));
  return allTrades;
}

async function processMatch(client, competition, event) {
  const { homeTeam, awayTeam, home, draw, away } = classifyMarkets(event);
  if (!home || !draw || !away) {
    console.log(`  SKIP "${event.title}" — could not classify all 3 markets`);
    return;
  }

  const eventId = String(event.id);
  const kickoffTime = kickoffTimeOf(home, event);
  const result = resultFrom(home, draw, away);
  const snapshotPlan = await buildSnapshotPlan(home, draw, away, kickoffTime);
  const trades = await fetchAllTrades([home, draw, away]);

  // R2 write first (idempotent -- always the same key for a given match,
  // "backfill" isn't a fresh timestamp like collect.js's polls use, so a
  // retry after a Turso failure below just overwrites the same object).
  // Only once that's landed does the transaction mark this match done --
  // see withTransaction's comment for the bug this ordering fixes.
  await writeTradeBatch(client, eventId, "backfill", trades.map(toStoredTrade));

  await withTransaction(client, async (tx) => {
    await upsertMatch(tx, eventId, {
      competition,
      home_team: homeTeam,
      away_team: awayTeam,
      kickoff_time: kickoffTime.toISOString(),
      polymarket_market_id: eventId,
      resolved: true,
      result,
      trades_backfilled: true,
      // Lets the wallet-ranking job join a trade's conditionId back to which
      // leg (home/draw/away) it was betting on, and combined with `result`,
      // whether that trade's side actually won.
      home_condition_id: home.conditionId,
      draw_condition_id: draw.conditionId,
      away_condition_id: away.conditionId,
    });
    for (const snapshot of snapshotPlan) await insertSnapshot(tx, eventId, snapshot);
  });

  console.log(`  ${event.title}: result=${result ?? "unknown"} snapshots=${snapshotPlan.length} trades=${trades.length}`);
}

async function main() {
  const client = getClient();
  let processedThisRun = 0;
  let consecutiveFailures = 0;
  let skippedAlreadyDone = 0;

  outer: for (const competition of COMPETITIONS) {
    const matches = await findResolvedMatches(competition);
    console.log(`\n[${competition}] ${matches.length} resolved match(es) found`);
    for (const event of matches) {
      if (processedThisRun >= BATCH_SIZE) break outer;

      const eventId = String(event.id);
      // home_condition_id was added after some matches were already
      // backfilled — require it too so those older rows get naturally
      // healed on resume instead of staying permanently incomplete.
      const existing = await getMatchRow(client, eventId);
      if (existing && existing.trades_backfilled && existing.home_condition_id) {
        skippedAlreadyDone++;
        continue;
      }

      try {
        await processMatch(client, competition, event);
        processedThisRun++;
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures++;
        console.log(`  ERROR on "${event.title}": ${err.message}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.log(`\n${MAX_CONSECUTIVE_FAILURES} consecutive failures — stopping this run early rather than continuing to hammer a possibly-struggling service. The next scheduled run will retry.`);
          break outer;
        }
      }
      await sleep(DELAY_BETWEEN_MATCHES_MS);
    }
  }

  console.log(`\nBackfill batch done. ${processedThisRun} match(es) processed this run, ${skippedAlreadyDone} already-done match(es) skipped.`);
}

main().catch((err) => {
  console.error("Backfill batch FAILED:", err);
  process.exit(1);
});
