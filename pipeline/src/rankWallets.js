// Milestone 3, Tier 2: turns the raw Tier 1 trade log into per-wallet
// aggregate + sliced stats, with shrinkage so small samples don't outrank
// proven wallets by luck. Read PROJECT.md's "Wallet tracking logic" section
// before changing the thresholds below — they're deliberately simple,
// documented guesses meant to be revisited once real data exists, not
// tuned constants.
import { getClient } from "./db.js";
import { readAllTradesForMatch } from "./tradeArchive.js";
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

// Reads every resolved match's condition ids from Turso, then reads and
// flattens that match's batched trade files from R2. This is the same
// full-rescan-every-run shape the old SQL version had (just against R2
// instead of a trades table) -- fine at today's scale (well within R2's
// free read quota even run daily), worth revisiting only if match count
// grows by an order of magnitude (many more seasons/platforms).
async function loadResolvedMatchesWithTrades(client) {
  const { rows: matchRows } = await client.execute(
    `SELECT event_id AS "id", competition, home_team AS "homeTeam", away_team AS "awayTeam", result,
            home_condition_id AS "home", draw_condition_id AS "draw", away_condition_id AS "away"
     FROM matches
     WHERE resolved = 1 AND result IS NOT NULL
       AND home_condition_id IS NOT NULL AND draw_condition_id IS NOT NULL AND away_condition_id IS NOT NULL`
  );

  const matches = [];
  for (const m of matchRows) {
    const trades = await readAllTradesForMatch(client, m.id);
    matches.push({
      id: m.id,
      competition: m.competition,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      result: m.result,
      marketConditionIds: { home: m.home, draw: m.draw, away: m.away },
      trades,
    });
  }
  return matches;
}

// Same as loadResolvedMatchesWithTrades, but for exactly one match --
// used by the match-resolution-triggered recompute (recompute.js) so it
// doesn't have to rescan every resolved match just to update the handful
// of wallets that traded on the one that just finished.
export async function loadOneResolvedMatchWithTrades(client, matchId) {
  const { rows } = await client.execute({
    sql: `SELECT event_id AS "id", competition, home_team AS "homeTeam", away_team AS "awayTeam", result,
                 home_condition_id AS "home", draw_condition_id AS "draw", away_condition_id AS "away"
          FROM matches WHERE event_id = ? AND resolved = 1 AND result IS NOT NULL`,
    args: [matchId],
  });
  if (rows.length === 0) return null;
  const m = rows[0];
  const trades = await readAllTradesForMatch(client, m.id);
  return {
    id: m.id,
    competition: m.competition,
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    result: m.result,
    marketConditionIds: { home: m.home, draw: m.draw, away: m.away },
    trades,
  };
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
// thing shrinkage toward a single career-long prior can hide. Sort a
// wallet's own trades chronologically, split into an early half and a
// recent half by count, and compare shrunk win rates. Requires MIN_TRADES
// on *both* halves independently.
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

// Turns a flat list of trade rows into the same {wallet, ...} result shape
// main() below writes to Turso -- factored out so recompute.js can reuse it
// for a single-match, single-wallet-set recompute after a resolution.
export function rankWallets(rows, existingByWallet = new Map()) {
  if (rows.length === 0) return [];
  const globalWins = rows.filter((r) => r.win).length;
  const globalPrior = globalWins / rows.length;

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

    results.push({
      wallet,
      totalResolvedTrades: aggregate.trades,
      aggregateWinRate: aggregate.shrunkWinRate,
      aggregateROI: aggregate.roi,
      tier,
      bySlice: {
        byCompetition: sliceBy(walletRows, (r) => r.competition, globalPrior, aggregate),
        byTeam: sliceBy(walletRows, (r) => r.team, globalPrior, aggregate),
        byMonth: sliceBy(walletRows, (r) => monthKey(r.timestamp), globalPrior, aggregate),
      },
      trend: computeTrend(walletRows, globalPrior),
      lastUpdated: new Date().toISOString(),
    });
  }
  return results;
}

const WALLET_UPSERT_CHUNK = 100; // conservative re: SQLite's bind-parameter ceiling (8 cols/row)
const WALLET_COLS = ["address", "total_resolved_trades", "aggregate_win_rate", "aggregate_roi", "tier", "by_slice", "trend", "last_updated"];

export async function upsertWallets(client, wallets) {
  for (let i = 0; i < wallets.length; i += WALLET_UPSERT_CHUNK) {
    const group = wallets.slice(i, i + WALLET_UPSERT_CHUNK);
    const values = [];
    const args = [];
    for (const w of group) {
      values.push(`(${WALLET_COLS.map(() => "?").join(", ")})`);
      args.push(w.wallet, w.totalResolvedTrades, w.aggregateWinRate, w.aggregateROI, w.tier, JSON.stringify(w.bySlice), JSON.stringify(w.trend), w.lastUpdated);
    }
    await client.execute({
      sql: `INSERT INTO wallets (${WALLET_COLS.join(", ")}) VALUES ${values.join(", ")}
            ON CONFLICT(address) DO UPDATE SET
              total_resolved_trades = excluded.total_resolved_trades,
              aggregate_win_rate = excluded.aggregate_win_rate,
              aggregate_roi = excluded.aggregate_roi,
              tier = excluded.tier,
              by_slice = excluded.by_slice,
              trend = excluded.trend,
              last_updated = excluded.last_updated`,
      args,
    });
    console.log(`  ${Math.min(i + WALLET_UPSERT_CHUNK, wallets.length)}/${wallets.length} wallet(s) written...`);
  }
}

async function main() {
  const client = getClient();
  console.log("Loading resolved matches + trades...");
  const matches = await loadResolvedMatchesWithTrades(client);
  console.log(`${matches.length} resolved match(es) with a determined result.`);

  const rows = buildTradeRows(matches);
  console.log(`${rows.length} trade row(s) joined to a match result.`);
  if (rows.length === 0) {
    console.log("Nothing to rank yet.");
    return;
  }

  const results = rankWallets(rows);
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

  // Only wallets that clear the activity bar are analytically meaningful.
  // This dataset has hundreds of thousands of distinct wallets, the
  // overwhelming majority one-off/low-volume noise traders that will
  // never be tier:"watch". Tier 1's "log everyone, no filtering" is about
  // the raw trade archive in R2, not about every one-off trader needing a
  // processed ranking row in Turso.
  const toWrite = results.filter((r) => r.totalResolvedTrades >= MIN_TRADES);
  console.log(`\n${results.length} distinct wallet(s) total, ${toWrite.length} clear the ${MIN_TRADES}-trade activity bar and will be written.`);

  console.log("\nWriting wallets...");
  await upsertWallets(client, toWrite);
  console.log(`\nDone. ${toWrite.length} wallet(s) written this run.`);
}

export { shrink, pnlAndStake, legFor, buildTradeRows, summarize, sliceBy, monthKey, computeTrend, loadResolvedMatchesWithTrades, MIN_TRADES, SHRINKAGE_K, TREND_THRESHOLD };

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("Wallet ranking FAILED:", err);
    process.exit(1);
  });
}
