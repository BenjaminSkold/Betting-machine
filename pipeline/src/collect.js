import { getDb } from "./firestore.js";
import { findLiveMatches, getAllTrades } from "./polymarket.js";

const COMPETITIONS = ["EPL", "UCL", "UEL"];
const CHECKPOINTS_MIN = [60, 15, 10];
const CHECKPOINT_TOLERANCE_MIN = 5; // catches a checkpoint even if cron cadence doesn't land exactly on it
const BATCH_LIMIT = 500; // Firestore's per-batch write cap

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
    const existing = await snapRef.get();
    if (existing.exists) continue;
    await snapRef.set({
      capturedAt: new Date().toISOString(),
      minutesBeforeKickoff: checkpoint,
      prices: { home: yesPrice(home), draw: yesPrice(draw), away: yesPrice(away) },
      liquidity: Number(home.liquidity || 0) + Number(draw.liquidity || 0) + Number(away.liquidity || 0),
    });
    console.log(`    snapshot @ ${checkpoint}min written`);
  }
}

async function writeTrades(db, matchRef, markets) {
  let batch = db.batch();
  let opsInBatch = 0;
  let total = 0;

  for (const market of markets) {
    const trades = await getAllTrades(market.conditionId);
    for (const t of trades) {
      const tradeId = `${t.transactionHash}_${t.asset}_${t.outcomeIndex}`;
      const tradeRef = matchRef.collection("trades").doc(tradeId);
      batch.set(
        tradeRef,
        {
          wallet: t.proxyWallet,
          side: t.side,
          size: t.size,
          price: t.price,
          timestamp: t.timestamp,
          outcome: t.outcome,
          conditionId: t.conditionId,
        },
        { merge: true }
      );
      opsInBatch++;
      total++;
      if (opsInBatch >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        opsInBatch = 0;
      }
    }
  }
  if (opsInBatch > 0) await batch.commit();
  return total;
}

async function processMatch(db, competition, event) {
  const { homeTeam, awayTeam, home, draw, away } = classifyMarkets(event);
  if (!home || !draw || !away) {
    console.log(`  SKIP "${event.title}" — could not classify all 3 markets`);
    return;
  }

  const kickoffTime = kickoffTimeOf(home, event);
  const matchRef = db.collection("matches").doc(String(event.id));
  await matchRef.set(
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
  );

  await writeSnapshotIfDue(matchRef, home, draw, away, kickoffTime);
  const tradeCount = await writeTrades(db, matchRef, [home, draw, away]);
  console.log(`  ${event.title}: ${tradeCount} trades logged`);
}

async function main() {
  const db = getDb();
  let totalMatches = 0;

  for (const competition of COMPETITIONS) {
    const matches = await findLiveMatches(competition);
    console.log(`[${competition}] ${matches.length} live match(es)`);
    for (const event of matches) {
      await processMatch(db, competition, event);
      totalMatches++;
    }
  }

  await db.collection("_system").doc("status").set({
    lastSuccessfulRun: new Date().toISOString(),
    matchesProcessed: totalMatches,
  });
  console.log(`\nDone. ${totalMatches} match(es) processed. lastSuccessfulRun updated.`);
}

main().catch((err) => {
  console.error("Collection run FAILED:", err);
  process.exit(1);
});
