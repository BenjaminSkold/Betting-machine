import { getDb } from "./firestoreRest.js";
import { findResolvedMatches, getAllTrades, getPriceHistory, clobTokenIdsFor } from "./polymarket.js";
import { chunk, toStoredTrade } from "./tradeBatches.js";

const COMPETITIONS = ["EPL", "UCL", "UEL"];
const CHECKPOINTS_MIN = [60, 15, 10];
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

// Figures out which checkpoint snapshots are missing and what they should
// contain, without writing anything yet — the actual write is folded into
// the single combined batch commit in processMatch, to keep write-request
// count to one per match regardless of how many checkpoints/trade-chunks
// there are (this project's real write-rate ceiling turned out to be the
// binding constraint, not raw compute time).
async function planSnapshots(matchRef, home, draw, away, kickoffTime) {
  const tokens = {
    home: clobTokenIdsFor(home)[0],
    draw: clobTokenIdsFor(draw)[0],
    away: clobTokenIdsFor(away)[0],
  };
  const plan = [];
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

    plan.push({
      ref: snapRef,
      data: {
        capturedAt: null, // backfilled — there was no live "capture" moment
        minutesBeforeKickoff: checkpoint,
        prices: { home: homeP, draw: drawP, away: awayP },
        liquidity: null,
        backfilled: true,
      },
    });
  }
  return plan;
}

async function fetchAllTrades(markets) {
  const allTrades = [];
  for (const market of markets) {
    const trades = await getAllTrades(market.conditionId);
    allTrades.push(...trades);
  }
  return allTrades;
}

async function processMatch(db, competition, event) {
  const { homeTeam, awayTeam, home, draw, away } = classifyMarkets(event);
  if (!home || !draw || !away) {
    console.log(`  SKIP "${event.title}" — could not classify all 3 markets`);
    return;
  }

  const matchRef = db.collection("matches").doc(String(event.id));
  const existing = await matchRef.get();
  if (existing.exists && existing.data().tradesBackfilled) {
    console.log(`  SKIP "${event.title}" — already backfilled (resumed run)`);
    return;
  }

  const kickoffTime = kickoffTimeOf(home, event);
  const result = resultFrom(home, draw, away);
  const snapshotPlan = await planSnapshots(matchRef, home, draw, away, kickoffTime);
  const trades = await fetchAllTrades([home, draw, away]);

  // Everything for this match lands in one atomic commit — one write
  // request no matter how many snapshots/trade-chunks it contains.
  const batch = db.batch();
  batch.set(
    matchRef,
    {
      competition,
      homeTeam,
      awayTeam,
      kickoffTime: kickoffTime.toISOString(),
      polymarketMarketId: String(event.id),
      resolved: true,
      result,
      tradesBackfilled: true,
    },
    { merge: true }
  );
  for (const { ref, data } of snapshotPlan) batch.set(ref, data);
  let batchIndex = 0;
  for (const group of chunk(trades)) {
    batch.set(matchRef.collection("tradeBatches").doc(`batch_${batchIndex}`), {
      trades: group.map(toStoredTrade),
      count: group.length,
      writtenAt: new Date().toISOString(),
    });
    batchIndex++;
  }
  await batch.commit();

  console.log(`  ${event.title}: result=${result ?? "unknown"} snapshots=${snapshotPlan.length} trades=${trades.length}`);
}

async function main() {
  const db = getDb();
  let total = 0;
  const permanentlyFailed = [];

  for (const competition of COMPETITIONS) {
    const matches = await findResolvedMatches(competition);
    const toProcess = matches.slice(0, LIMIT);
    console.log(`\n[${competition}] ${matches.length} resolved match(es) found, processing ${toProcess.length}`);
    for (const event of toProcess) {
      // This project's real write-rate ceiling is well under what a fresh,
      // unbilled Firestore project's documented quotas would suggest —
      // plausibly a provisional throttle that eases as the project ages.
      // Treat failures as recoverable: cool down and retry a few times
      // before giving up on this one match and moving on (it'll be picked
      // up on the next run, since already-done matches are skipped).
      let attempt = 1;
      const maxAttempts = 4;
      while (true) {
        try {
          await processMatch(db, competition, event);
          total++;
          break;
        } catch (err) {
          console.log(`  ERROR on "${event.title}" (attempt ${attempt}/${maxAttempts}): ${err.message}`);
          if (attempt >= maxAttempts) {
            permanentlyFailed.push(event.title);
            break;
          }
          const cooldownMs = 30_000 * attempt; // 30s, 60s, 90s
          console.log(`    cooling down ${cooldownMs / 1000}s before retry...`);
          await new Promise((resolve) => setTimeout(resolve, cooldownMs));
          attempt++;
        }
      }
    }
  }

  console.log(`\nBackfill run done. ${total} match(es) processed.`);
  if (permanentlyFailed.length > 0) {
    console.log(`${permanentlyFailed.length} match(es) failed after 4 attempts each — rerun the script to retry them:`);
    for (const title of permanentlyFailed) console.log(`  - ${title}`);
  }
}

main().catch((err) => {
  console.error("Backfill FAILED:", err);
  process.exit(1);
});
