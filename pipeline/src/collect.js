import { getDb, withTimeout } from "./firestore.js";
import { findLiveMatches, getAllTrades } from "./polymarket.js";
import { chunk, toStoredTrade } from "./tradeBatches.js";

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

async function writeSnapshotIfDue(matchRef, home, draw, away, kickoffTime) {
  const minutesToKickoff = (kickoffTime.getTime() - Date.now()) / 60000;
  for (const checkpoint of CHECKPOINTS_MIN) {
    if (Math.abs(minutesToKickoff - checkpoint) > CHECKPOINT_TOLERANCE_MIN) continue;
    const snapRef = matchRef.collection("snapshots").doc(`checkpoint_${checkpoint}`);
    const existing = await withTimeout(snapRef.get(), 15000, "snapshot get");
    if (existing.exists) continue;
    await withTimeout(
      snapRef.set({
        capturedAt: new Date().toISOString(),
        minutesBeforeKickoff: checkpoint,
        prices: { home: yesPrice(home), draw: yesPrice(draw), away: yesPrice(away) },
        liquidity: Number(home.liquidity || 0) + Number(draw.liquidity || 0) + Number(away.liquidity || 0),
      }),
      15000,
      "snapshot set"
    );
    console.log(`    snapshot @ ${checkpoint}min written`);
  }
}

// Only fetches/writes trades newer than what we've already stored per
// market (cursor kept on the match doc), so a match with thousands of
// historical trades doesn't get rewritten in full on every 15-min run —
// only genuinely new trades cost a write. The batch-doc set and the cursor
// update commit atomically so a crash mid-write can't double-count trades
// on the next run.
async function writeNewTrades(db, matchRef, markets, cursor) {
  const lastSeenTimestamp = { ...(cursor.lastSeenTimestamp || {}) };
  let nextBatchIndex = cursor.nextBatchIndex || 0;
  const newTrades = [];

  for (const market of markets) {
    const trades = await getAllTrades(market.conditionId);
    const since = lastSeenTimestamp[market.conditionId] || 0;
    const fresh = trades.filter((t) => t.timestamp > since);
    if (trades.length > 0) {
      lastSeenTimestamp[market.conditionId] = Math.max(...trades.map((t) => t.timestamp));
    }
    newTrades.push(...fresh);
  }

  if (newTrades.length === 0) return 0;

  const batch = db.batch();
  for (const group of chunk(newTrades)) {
    const batchRef = matchRef.collection("tradeBatches").doc(`batch_${nextBatchIndex}`);
    batch.set(batchRef, {
      trades: group.map(toStoredTrade),
      count: group.length,
      writtenAt: new Date().toISOString(),
    });
    nextBatchIndex++;
  }
  batch.update(matchRef, { lastSeenTimestamp, nextBatchIndex });
  await withTimeout(batch.commit(), 20000, "trades batch commit");
  return newTrades.length;
}

async function processMatch(db, competition, event) {
  const { homeTeam, awayTeam, home, draw, away } = classifyMarkets(event);
  if (!home || !draw || !away) {
    console.log(`  SKIP "${event.title}" — could not classify all 3 markets`);
    return;
  }

  const kickoffTime = kickoffTimeOf(home, event);
  const matchRef = db.collection("matches").doc(String(event.id));
  const existing = await withTimeout(matchRef.get(), 15000, "match get");
  const cursor = existing.exists ? existing.data() : {};

  await withTimeout(
    matchRef.set(
      {
        competition,
        homeTeam,
        awayTeam,
        kickoffTime: kickoffTime.toISOString(),
        polymarketMarketId: String(event.id),
        resolved: Boolean(home.closed),
        result: null, // settlement logic is a later milestone
      },
      { merge: true }
    ),
    15000,
    "match set"
  );

  await writeSnapshotIfDue(matchRef, home, draw, away, kickoffTime);
  const newTradeCount = await writeNewTrades(db, matchRef, [home, draw, away], cursor);
  console.log(`  ${event.title}: ${newTradeCount} new trade(s)`);
}

async function main() {
  const db = getDb();
  let totalMatches = 0;
  let failedMatches = 0;

  for (const competition of COMPETITIONS) {
    const matches = await findLiveMatches(competition);
    console.log(`[${competition}] ${matches.length} live match(es)`);
    for (const event of matches) {
      try {
        await processMatch(db, competition, event);
        totalMatches++;
      } catch (err) {
        // Cron runs every 15 min, which is itself a natural retry — better
        // to skip one throttled/flaky match than abort the whole run and
        // lose every other match's snapshot/trade update for this cycle.
        failedMatches++;
        console.log(`  ERROR on "${event.title}", skipping this run: ${err.message}`);
      }
    }
  }

  await withTimeout(
    db.collection("_system").doc("status").set({
      lastSuccessfulRun: new Date().toISOString(),
      matchesProcessed: totalMatches,
      matchesFailed: failedMatches,
    }),
    15000,
    "status set"
  );
  console.log(`\nDone. ${totalMatches} match(es) processed, ${failedMatches} failed. lastSuccessfulRun updated.`);
}

main().catch((err) => {
  console.error("Collection run FAILED:", err);
  process.exit(1);
});
