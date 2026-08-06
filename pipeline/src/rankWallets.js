// Milestone 3, Tier 2: turns the raw Tier 1 trade log into per-wallet
// aggregate + sliced stats, with shrinkage so small samples don't outrank
// proven wallets by luck. Read PROJECT.md's "Wallet tracking logic" section
// before changing the thresholds below — they're deliberately simple,
// documented guesses meant to be revisited once real data exists, not
// tuned constants.
import { getPool } from "./db.js";
import { isMainModule } from "./isMain.js";

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

// How far a wallet's early-vs-recent shrunk win rate has to move before
// it's called a real trend rather than noise — same 5pp bar used elsewhere
// in this project (paperBets.js's edge threshold) for "a meaningful signal,"
// not a fitted constant.
const TREND_THRESHOLD = 0.05;

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

// Postgres has server-side WHERE filtering, so this is one indexed query
// per table instead of Firestore's full-collection `list()` scans (which is
// what used to blow the read quota and required the whole
// straight-from-Polymarket bypass this file no longer has).
async function loadResolvedMatchesWithTrades(pool) {
  const { rows: matchRows } = await pool.query(
    `SELECT event_id AS "id", competition, home_team AS "homeTeam", away_team AS "awayTeam", result,
            home_condition_id AS "home", draw_condition_id AS "draw", away_condition_id AS "away"
     FROM matches
     WHERE resolved = true AND result IS NOT NULL
       AND home_condition_id IS NOT NULL AND draw_condition_id IS NOT NULL AND away_condition_id IS NOT NULL`
  );
  const { rows: tradeRows } = await pool.query(
    `SELECT t.match_id AS "matchId", t.wallet, t.side, t.size, t.price, t.timestamp, t.outcome, t.condition_id AS "conditionId"
     FROM trades t
     JOIN matches m ON m.event_id = t.match_id
     WHERE m.resolved = true AND m.result IS NOT NULL`
  );

  const tradesByMatch = new Map();
  for (const t of tradeRows) {
    if (!tradesByMatch.has(t.matchId)) tradesByMatch.set(t.matchId, []);
    tradesByMatch.get(t.matchId).push(t);
  }

  return matchRows.map((m) => ({
    id: m.id,
    competition: m.competition,
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    result: m.result,
    marketConditionIds: { home: m.home, draw: m.draw, away: m.away },
    trades: tradesByMatch.get(m.id) || [],
  }));
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
        timestamp: trade.timestamp,
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

// "YYYY-MM" bucket, in UTC — coarse enough that even a moderately active
// wallet clears MIN_TRADES within a bucket most months, fine enough to
// actually show a within-season trend on a chart.
function monthKey(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 7);
}

// A wallet "starting hot and fading" (or the reverse) is exactly the kind of
// thing shrinkage toward a single career-long prior can hide — one aggregate
// win rate has no way to say a wallet's edge has decayed. Deliberately
// simple and hand-checkable rather than a fitted trend model (see
// PROJECT.md's "no ML" constraint): sort a wallet's own trades
// chronologically, split into an early half and a recent half by count (not
// by calendar window, so both halves get a comparably-sized sample instead
// of one side being starved by an uneven trading cadence), and compare
// shrunk win rates. Requires MIN_TRADES on *both* halves independently —
// a wallet that barely clears the aggregate activity bar shouldn't have a
// trend claimed about it from an even thinner half-sample.
function computeTrend(walletRows, prior) {
  const sorted = [...walletRows].sort((a, b) => a.timestamp - b.timestamp);
  const mid = Math.floor(sorted.length / 2);
  const early = summarize(sorted.slice(0, mid), prior);
  const recent = summarize(sorted.slice(mid), prior);
  const earlyEnough = early.trades >= MIN_TRADES;
  const recentEnough = recent.trades >= MIN_TRADES;

  let label = "insufficient data";
  let delta = null;
  if (earlyEnough && recentEnough) {
    delta = recent.shrunkWinRate - early.shrunkWinRate;
    label = delta <= -TREND_THRESHOLD ? "declining" : delta >= TREND_THRESHOLD ? "improving" : "stable";
  }

  return {
    early: { trades: early.trades, winRate: early.shrunkWinRate, roi: early.roi, usedFallback: !earlyEnough },
    recent: { trades: recent.trades, winRate: recent.shrunkWinRate, roi: recent.roi, usedFallback: !recentEnough },
    delta,
    label,
  };
}

const WALLET_UPSERT_CHUNK = 500;
const WALLET_COLS = ["address", "total_resolved_trades", "aggregate_win_rate", "aggregate_roi", "tier", "by_slice", "trend", "last_updated"];

// Firestore's write-rate ceiling forced these out one at a time, paced
// ~1.1s apart, with a local resume file to survive a run that took hours.
// Postgres has no comparable per-request quota, so this is just a handful
// of chunked bulk upserts.
async function upsertWallets(pool, wallets) {
  for (let i = 0; i < wallets.length; i += WALLET_UPSERT_CHUNK) {
    const group = wallets.slice(i, i + WALLET_UPSERT_CHUNK);
    const values = [];
    const params = [];
    group.forEach((w, idx) => {
      const base = idx * WALLET_COLS.length;
      values.push(`(${WALLET_COLS.map((_, j) => `$${base + j + 1}`).join(", ")})`);
      params.push(w.wallet, w.totalResolvedTrades, w.aggregateWinRate, w.aggregateROI, w.tier, JSON.stringify(w.bySlice), JSON.stringify(w.trend), w.lastUpdated);
    });
    await pool.query(
      `INSERT INTO wallets (${WALLET_COLS.join(", ")}) VALUES ${values.join(", ")}
       ON CONFLICT (address) DO UPDATE SET
         total_resolved_trades = EXCLUDED.total_resolved_trades,
         aggregate_win_rate = EXCLUDED.aggregate_win_rate,
         aggregate_roi = EXCLUDED.aggregate_roi,
         tier = EXCLUDED.tier,
         by_slice = EXCLUDED.by_slice,
         trend = EXCLUDED.trend,
         last_updated = EXCLUDED.last_updated`,
      params
    );
    console.log(`  ${Math.min(i + WALLET_UPSERT_CHUNK, wallets.length)}/${wallets.length} wallet(s) written...`);
  }
}

async function main() {
  const pool = getPool();
  console.log("Loading resolved matches + trades...");
  const matches = await loadResolvedMatchesWithTrades(pool);
  console.log(`${matches.length} resolved match(es) with a determined result.`);

  const rows = buildTradeRows(matches);
  console.log(`${rows.length} trade row(s) joined to a match result.`);
  if (rows.length === 0) {
    console.log("Nothing to rank yet.");
    await pool.end();
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
    const byMonth = sliceBy(walletRows, (r) => monthKey(r.timestamp), globalPrior, aggregate);
    const trend = computeTrend(walletRows, globalPrior);

    results.push({
      wallet,
      totalResolvedTrades: aggregate.trades,
      aggregateWinRate: aggregate.shrunkWinRate,
      aggregateROI: aggregate.roi,
      tier,
      bySlice: { byCompetition, byTeam, byMonth },
      trend,
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

  const decliningWatch = results.filter((r) => r.tier === "watch" && r.trend.label === "declining");
  if (decliningWatch.length > 0) {
    console.log(`\n${decliningWatch.length} watched wallet(s) trending down (recent half well below their own early half):`);
    for (const r of decliningWatch) {
      console.log(
        `  ${r.wallet.slice(0, 10)}... early=${(r.trend.early.winRate * 100).toFixed(1)}% ` +
          `recent=${(r.trend.recent.winRate * 100).toFixed(1)}% (${(r.trend.delta * 100).toFixed(1)}pp)`
      );
    }
  }

  // Only wallets that clear the activity bar are analytically meaningful —
  // the same MIN_TRADES bar already used everywhere else in this file (see
  // sliceBy's own "enough" check). This dataset has ~200k distinct wallets,
  // the overwhelming majority one-off/low-volume noise traders that will
  // never be tier:"watch" and are unlikely to ever be looked up
  // individually. Tier 1's "log everyone, no filtering" is about the raw
  // trade log (PROJECT.md), not about every one-off trader needing a
  // processed ranking row.
  const toWrite = results.filter((r) => r.totalResolvedTrades >= MIN_TRADES);
  console.log(`\n${results.length} distinct wallet(s) total, ${toWrite.length} clear the ${MIN_TRADES}-trade activity bar and will be written.`);

  console.log("\nWriting wallets...");
  await upsertWallets(pool, toWrite);
  console.log(`\nDone. ${toWrite.length} wallet(s) written this run.`);
  await pool.end();
}

export { shrink, pnlAndStake, legFor, buildTradeRows, summarize, sliceBy, monthKey, computeTrend, MIN_TRADES, SHRINKAGE_K, TREND_THRESHOLD };

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("Wallet ranking FAILED:", err);
    process.exit(1);
  });
}
