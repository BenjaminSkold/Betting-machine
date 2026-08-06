import { getPool, withTransaction, getMatchRow, upsertMatch, getExistingSnapshotCheckpoints, insertSnapshot, insertTrades } from "./db.js";
import { findResolvedMatches, getAllTrades, getPriceHistory, clobTokenIdsFor } from "./polymarket.js";

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
// contain, given the checkpoints already stored for this match.
async function planSnapshots(existingCheckpoints, home, draw, away, kickoffTime) {
  const tokens = {
    home: clobTokenIdsFor(home)[0],
    draw: clobTokenIdsFor(draw)[0],
    away: clobTokenIdsFor(away)[0],
  };
  const plan = [];
  for (const checkpoint of CHECKPOINTS_MIN) {
    if (existingCheckpoints.has(String(checkpoint))) continue;

    const [homeP, drawP, awayP] = await Promise.all([
      nearestPriceAt(tokens.home, kickoffTime, checkpoint),
      nearestPriceAt(tokens.draw, kickoffTime, checkpoint),
      nearestPriceAt(tokens.away, kickoffTime, checkpoint),
    ]);
    if (homeP === null && drawP === null && awayP === null) continue;

    plan.push({
      checkpoint,
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

async function processMatch(pool, competition, event) {
  const { homeTeam, awayTeam, home, draw, away } = classifyMarkets(event);
  if (!home || !draw || !away) {
    console.log(`  SKIP "${event.title}" — could not classify all 3 markets`);
    return;
  }

  const eventId = String(event.id);
  const existing = await getMatchRow(pool, eventId);
  // home_condition_id was added after some matches were already backfilled
  // — require it too so those older rows get naturally healed on resume
  // instead of staying permanently missing the field.
  if (existing && existing.trades_backfilled && existing.home_condition_id) {
    console.log(`  SKIP "${event.title}" — already backfilled (resumed run)`);
    return;
  }

  const kickoffTime = kickoffTimeOf(home, event);
  const result = resultFrom(home, draw, away);
  const existingCheckpoints = existing ? await getExistingSnapshotCheckpoints(pool, eventId) : new Set();
  const snapshotPlan = await planSnapshots(existingCheckpoints, home, draw, away, kickoffTime);
  const trades = await fetchAllTrades([home, draw, away]);

  await withTransaction(pool, async (client) => {
    await upsertMatch(client, eventId, {
      competition,
      home_team: homeTeam,
      away_team: awayTeam,
      kickoff_time: kickoffTime.toISOString(),
      polymarket_market_id: eventId,
      resolved: true,
      result,
      trades_backfilled: true,
      // Lets the wallet-ranking job join a trade's conditionId back to
      // which leg (home/draw/away) it was betting on, and combined with
      // `result`, whether that trade's side actually won.
      home_condition_id: home.conditionId,
      draw_condition_id: draw.conditionId,
      away_condition_id: away.conditionId,
    });
    for (const { checkpoint, data } of snapshotPlan) await insertSnapshot(client, eventId, checkpoint, data);
    await insertTrades(client, eventId, trades);
  });

  console.log(`  ${event.title}: result=${result ?? "unknown"} snapshots=${snapshotPlan.length} trades=${trades.length}`);
}

async function main() {
  const pool = getPool();
  let total = 0;
  const permanentlyFailed = [];

  for (const competition of COMPETITIONS) {
    const matches = await findResolvedMatches(competition);
    const toProcess = matches.slice(0, LIMIT);
    console.log(`\n[${competition}] ${matches.length} resolved match(es) found, processing ${toProcess.length}`);
    for (const event of toProcess) {
      // Treat failures as recoverable: cool down and retry a few times
      // before giving up on this one match and moving on (it'll be picked
      // up on the next run, since already-done matches are skipped).
      let attempt = 1;
      const maxAttempts = 4;
      while (true) {
        try {
          await processMatch(pool, competition, event);
          total++;
          break;
        } catch (err) {
          console.log(`  ERROR on "${event.title}" (attempt ${attempt}/${maxAttempts}): ${err.message}`);
          if (attempt >= maxAttempts) {
            permanentlyFailed.push(event.title);
            break;
          }
          const cooldownMs = 5_000 * attempt; // 5s, 10s, 15s — Postgres has no comparable quota-recovery wait to Firestore's
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
  await pool.end();
}

main().catch((err) => {
  console.error("Backfill FAILED:", err);
  process.exit(1);
});
