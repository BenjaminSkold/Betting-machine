// Milestone 3, Tier 2: turns the raw Tier 1 trade log into per-wallet
// aggregate + sliced stats, with shrinkage so small samples don't outrank
// proven wallets by luck. Read PROJECT.md's "Wallet tracking logic" section
// before changing the thresholds below — they're deliberately simple,
// documented guesses meant to be revisited once real data exists, not
// tuned constants.
import { getDb } from "./firestoreRest.js";
import { chunk } from "./tradeBatches.js";

const FIRESTORE_BATCH_LIMIT = 500;

// "Enough resolved trades to say anything meaningful" — PROJECT.md's own
// suggested starting point. Below this, a slice/wallet falls back to a
// coarser number instead of reporting its own (too-noisy) rate.
const MIN_TRADES = 8;

// Shrinkage strength: pulls a wallet's raw win rate toward the global
// average proportional to k / (n + k) — a wallet with exactly k trades gets
// its estimate weighted half raw, half prior. k=10 roughly matches the
// 8-10 minimum-sample guidance: a wallet right at the activity bar is still
// pulled hard toward the average, and needs a real edge to clear the
// quality bar below.
const SHRINKAGE_K = 10;

function shrink(wins, n, prior) {
  if (n === 0) return prior;
  return (wins + SHRINKAGE_K * prior) / (n + SHRINKAGE_K);
}

// Simplified, transparent P&L model (per PROJECT.md: hand-checkable, no
// ML). A binary market share bought at `price` pays $1 if its side wins,
// $0 otherwise. SELL is modeled as the mirror image of a BUY on the same
// side — Polymarket's actual short/exit mechanics are more nuanced than
// this, but this is a deliberate v1 simplification, not a bug.
function pnlAndStake(trade, sideWon) {
  const { side, price, size } = trade;
  if (side === "BUY") {
    return sideWon ? { pnl: size * (1 - price), stake: price * size } : { pnl: -size * price, stake: price * size };
  }
  // SELL
  return sideWon
    ? { pnl: -size * (1 - price), stake: (1 - price) * size }
    : { pnl: size * price, stake: (1 - price) * size };
}

// Which leg (home/draw/away) a trade's conditionId corresponds to, and
// whether that leg was the one that actually happened.
function legFor(trade, match) {
  const { home, draw, away } = match.marketConditionIds || {};
  if (trade.conditionId === home) return "home";
  if (trade.conditionId === draw) return "draw";
  if (trade.conditionId === away) return "away";
  return null;
}

async function loadResolvedMatchesWithTrades(db) {
  const matchDocs = await db.collection("matches").list();
  const matches = [];
  for (const doc of matchDocs) {
    const data = doc.data();
    if (!data.resolved || !data.result || !data.marketConditionIds) continue;
    const batches = await doc.ref.collection("tradeBatches").list();
    const trades = batches.flatMap((b) => b.data().trades || []);
    matches.push({ id: doc.id, ...data, trades });
  }
  return matches;
}

// Flattens every (wallet, trade, match) triple into a single row with the
// win/pnl/stake/slice info already resolved, so aggregation below is just
// grouping and summing.
function buildTradeRows(matches) {
  const rows = [];
  for (const match of matches) {
    for (const trade of match.trades) {
      const leg = legFor(trade, match);
      if (!leg) continue; // trade on a market leg we can't identify — skip
      const legWon = leg === match.result;
      const sideWon = (trade.outcome === "Yes") === legWon;
      const { pnl, stake } = pnlAndStake(trade, sideWon);
      rows.push({
        wallet: trade.wallet,
        win: sideWon,
        pnl,
        stake,
        competition: match.competition,
        team: leg === "home" ? match.homeTeam : leg === "away" ? match.awayTeam : null,
      });
    }
  }
  return rows;
}

function summarize(rows, prior) {
  const n = rows.length;
  const wins = rows.filter((r) => r.win).length;
  const pnl = rows.reduce((sum, r) => sum + r.pnl, 0);
  const stake = rows.reduce((sum, r) => sum + r.stake, 0);
  return {
    trades: n,
    winRate: n > 0 ? wins / n : null,
    shrunkWinRate: shrink(wins, n, prior),
    roi: stake > 0 ? pnl / stake : null,
    pnl,
  };
}

function sliceBy(rows, keyFn, prior, fallback) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key === null || key === undefined) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const out = {};
  for (const [key, groupRows] of groups) {
    const summary = summarize(groupRows, prior);
    const enough = summary.trades >= MIN_TRADES;
    out[key] = {
      trades: summary.trades,
      winRate: enough ? summary.shrunkWinRate : fallback.shrunkWinRate,
      roi: enough ? summary.roi : fallback.roi,
      usedFallback: !enough,
    };
  }
  return out;
}

async function main() {
  const db = getDb();
  console.log("Loading resolved matches + trades...");
  const matches = await loadResolvedMatchesWithTrades(db);
  console.log(`${matches.length} resolved match(es) with a determined result.`);

  const rows = buildTradeRows(matches);
  console.log(`${rows.length} trade row(s) joined to a match result.`);
  if (rows.length === 0) {
    console.log("Nothing to rank yet.");
    return;
  }

  const globalWins = rows.filter((r) => r.win).length;
  const globalPrior = globalWins / rows.length;
  console.log(`Global baseline win rate: ${(globalPrior * 100).toFixed(1)}% across ${rows.length} trades.`);

  const byWallet = new Map();
  for (const row of rows) {
    if (!byWallet.has(row.wallet)) byWallet.set(row.wallet, []);
    byWallet.get(row.wallet).push(row);
  }

  const results = [];
  for (const [wallet, walletRows] of byWallet) {
    const aggregate = summarize(walletRows, globalPrior);
    const meetsActivityBar = aggregate.trades >= MIN_TRADES;
    const meetsQualityBar = aggregate.shrunkWinRate > globalPrior;
    const tier = meetsActivityBar && meetsQualityBar ? "watch" : "unranked";

    const byCompetition = sliceBy(walletRows, (r) => r.competition, globalPrior, aggregate);
    const byTeam = sliceBy(walletRows, (r) => r.team, globalPrior, aggregate);

    results.push({
      wallet,
      totalResolvedTrades: aggregate.trades,
      aggregateWinRate: aggregate.shrunkWinRate,
      aggregateROI: aggregate.roi,
      tier,
      bySlice: { byCompetition, byTeam },
      lastUpdated: new Date().toISOString(),
    });
  }

  results.sort((a, b) => b.aggregateWinRate - a.aggregateWinRate);
  const watchCount = results.filter((r) => r.tier === "watch").length;
  console.log(`${results.length} distinct wallet(s), ${watchCount} promoted to tier:"watch".`);
  console.log("\nTop 10 by shrunk win rate:");
  for (const r of results.slice(0, 10)) {
    console.log(
      `  ${r.wallet.slice(0, 10)}... n=${r.totalResolvedTrades} winRate=${(r.aggregateWinRate * 100).toFixed(1)}% ` +
        `roi=${r.aggregateROI === null ? "n/a" : (r.aggregateROI * 100).toFixed(1) + "%"} tier=${r.tier}`
    );
  }

  console.log("\nWriting wallets/ ...");
  for (const group of chunk(results, FIRESTORE_BATCH_LIMIT)) {
    const batch = db.batch();
    for (const r of group) batch.set(db.collection("wallets").doc(r.wallet), r);
    await batch.commit();
  }
  console.log("Done.");
}

export { shrink, pnlAndStake, legFor, buildTradeRows, summarize, sliceBy, MIN_TRADES, SHRINKAGE_K };

if (import.meta.main) {
  main().catch((err) => {
    console.error("Wallet ranking FAILED:", err);
    process.exit(1);
  });
}
