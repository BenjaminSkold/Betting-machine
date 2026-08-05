import { getDb } from "./firestore.js";
import { findResolvedMatches, getAllTrades, getPriceHistory, clobTokenIdsFor } from "./polymarket.js";

const COMPETITIONS = ["EPL", "UCL", "UEL"];
const CHECKPOINTS_MIN = [60, 15, 10];
const BATCH_LIMIT = 500;
// Optional cap per competition for smoke-testing before a full run.
const LIMIT = process.env.BACKFILL_LIMIT ? Number(process.env.BACKFILL_LIMIT) : Infinity;

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
  if (market.gameStartTime) {
    const iso = market.gameStartTime.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(event.endDate);
}

// Resolved markets settle to ~1/~0. Whichever leg settled to ~1 is the result.
function resultFrom(home, draw, away) {
  if (yesPrice(home) > 0.9) return "home";
  if (yesPrice(draw) > 0.9) return "draw";
  if (yesPrice(away) > 0.9) return "away";
  return null; // postponed/voided/ambiguous — store the match, skip declaring a result
}

async function nearestPriceAt(tokenId, kickoffTime, minutesBefore) {
  if (!tokenId) return null;
  const targetTs = Math.floor(kickoffTime.getTime() / 1000) - minutesBefore * 60;
  const points = await getPriceHistory(tokenId, {
    startTs: targetTs - 15 * 60,
    endTs: targetTs + 15 * 60,
    fidelity: 1,
  });
  if (points.length === 0) return null;
  let best = points[0];
  for (const p of points) {
    if (Math.abs(p.t - targetTs) < Math.abs(best.t - targetTs)) best = p;
  }
  return best.p;
}

async function writeSnapshots(matchRef, home, draw, away, kickoffTime) {
  const tokens = {
    home: clobTokenIdsFor(home)[0],
    draw: clobTokenIdsFor(draw)[0],
    away: clobTokenIdsFor(away)[0],
  };
  let written = 0;
  for (const checkpoint of CHECKPOINTS_MIN) {
    const snapRef = matchRef.collection("snapshots").doc(`checkpoint_${checkpoint}`);
    const existing = await snapRef.get();
    if (existing.exists) continue;

    const [homeP, drawP, awayP] = await Promise.all([
      nearestPriceAt(tokens.home, kickoffTime, checkpoint),
      nearestPriceAt(tokens.draw, kickoffTime, checkpoint),
      nearestPriceAt(tokens.away, kickoffTime, checkpoint),
    ]);
    if (homeP === null && drawP === null && awayP === null) continue;

    await snapRef.set({
      capturedAt: null, // backfilled — there was no live "capture" moment
      minutesBeforeKickoff: checkpoint,
      prices: { home: homeP, draw: drawP, away: awayP },
      liquidity: null,
      backfilled: true,
    });
    written++;
  }
  return written;
}

async function writeTrades(db, matchRef, markets) {
  let batch = db.batch();
  let opsInBatch = 0;
  let total = 0;

  for (const market of markets) {
    const trades = await getAllTrades(market.conditionId);
    for (const t of trades) {
      const tradeId = `${t.transactionHash}_${t.asset}_${t.outcomeIndex}`;
      batch.set(
        matchRef.collection("trades").doc(tradeId),
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
  const result = resultFrom(home, draw, away);
  const matchRef = db.collection("matches").doc(String(event.id));
  await matchRef.set(
    {
      competition,
      homeTeam,
      awayTeam,
      kickoffTime: kickoffTime.toISOString(),
      polymarketMarketId: String(event.id),
      resolved: true,
      result,
    },
    { merge: true }
  );

  const snapCount = await writeSnapshots(matchRef, home, draw, away, kickoffTime);
  const tradeCount = await writeTrades(db, matchRef, [home, draw, away]);
  console.log(`  ${event.title}: result=${result ?? "unknown"} snapshots=${snapCount} trade-ops=${tradeCount}`);
}

async function main() {
  const db = getDb();
  let total = 0;

  for (const competition of COMPETITIONS) {
    const matches = await findResolvedMatches(competition);
    const toProcess = matches.slice(0, LIMIT);
    console.log(`\n[${competition}] ${matches.length} resolved match(es) found, processing ${toProcess.length}`);
    for (const event of toProcess) {
      await processMatch(db, competition, event);
      total++;
    }
  }

  console.log(`\nBackfill run done. ${total} match(es) processed.`);
}

main().catch((err) => {
  console.error("Backfill FAILED:", err);
  process.exit(1);
});
