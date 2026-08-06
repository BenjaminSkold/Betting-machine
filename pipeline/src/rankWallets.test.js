// Throwaway synthetic check for rankWallets.js's compute logic — hand-worked
// expected numbers, run before trusting it against real Firestore data.
import {
  shrink,
  pnlAndStake,
  legFor,
  buildTradeRows,
  summarize,
  monthKey,
  computeTrend,
  classifyMarketsFromEvent,
  resultFromMarkets,
  MIN_TRADES,
  SHRINKAGE_K,
} from "./rankWallets.js";

let failures = 0;
function check(label, actual, expected, tolerance = 1e-9) {
  const ok = typeof expected === "number" ? Math.abs(actual - expected) <= tolerance : actual === expected;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

// --- pnlAndStake ---
// BUY 10 shares @ 0.4, side wins -> pnl = 10*(1-0.4)=6, stake=10*0.4=4
check("BUY win pnl", pnlAndStake({ side: "BUY", price: 0.4, size: 10 }, true).pnl, 6);
check("BUY win stake", pnlAndStake({ side: "BUY", price: 0.4, size: 10 }, true).stake, 4);
// BUY 10 shares @ 0.4, side loses -> pnl = -10*0.4 = -4
check("BUY lose pnl", pnlAndStake({ side: "BUY", price: 0.4, size: 10 }, false).pnl, -4);
// SELL 10 @ 0.4, side wins (bad for seller) -> pnl = -10*(1-0.4) = -6
check("SELL win(for side) pnl", pnlAndStake({ side: "SELL", price: 0.4, size: 10 }, true).pnl, -6);
// SELL 10 @ 0.4, side loses (good for seller) -> pnl = 10*0.4 = 4
check("SELL lose(for side) pnl", pnlAndStake({ side: "SELL", price: 0.4, size: 10 }, false).pnl, 4);

// --- legFor ---
const match = { marketConditionIds: { home: "H", draw: "D", away: "A" }, result: "home" };
check("legFor home", legFor({ conditionId: "H" }, match), "home");
check("legFor draw", legFor({ conditionId: "D" }, match), "draw");
check("legFor unknown", legFor({ conditionId: "X" }, match), null);

// --- buildTradeRows + win determination ---
// Match resolves "home". Wallet W1 bought Yes on the home leg -> should win.
// Wallet W2 bought Yes on the away leg -> should lose.
// Wallet W3 bought No on the home leg -> should lose (home leg's Yes won, so betting No on it loses).
const fakeMatch = {
  competition: "EPL",
  homeTeam: "Arsenal",
  awayTeam: "Chelsea",
  result: "home",
  marketConditionIds: { home: "H", draw: "D", away: "A" },
  trades: [
    { wallet: "W1", side: "BUY", price: 0.6, size: 100, outcome: "Yes", conditionId: "H" },
    { wallet: "W2", side: "BUY", price: 0.3, size: 100, outcome: "Yes", conditionId: "A" },
    { wallet: "W3", side: "BUY", price: 0.5, size: 100, outcome: "No", conditionId: "H" },
  ],
};
const rows = buildTradeRows([fakeMatch]);
check("row count", rows.length, 3);
const w1 = rows.find((r) => r.wallet === "W1");
const w2 = rows.find((r) => r.wallet === "W2");
const w3 = rows.find((r) => r.wallet === "W3");
check("W1 wins (bought Yes on winning home leg)", w1.win, true);
check("W1 team slice", w1.team, "Arsenal");
check("W2 loses (bought Yes on losing away leg)", w2.win, false);
check("W2 team slice", w2.team, "Chelsea");
check("W3 loses (bought No on the leg that won)", w3.win, false);
check("W3 team slice", w3.team, "Arsenal");

// --- shrink ---
// n=0 -> exactly the prior
check("shrink n=0", shrink(0, 0, 0.5), 0.5);
// n=SHRINKAGE_K, all wins -> (k*1 + k*prior)/(2k) = (1+prior)/2, halfway between raw(1.0) and prior
check("shrink halfway point", shrink(SHRINKAGE_K, SHRINKAGE_K, 0.5), (1 + 0.5) / 2);
// large n should approach the raw rate regardless of prior
check("shrink large n approaches raw", shrink(900, 1000, 0.1) > 0.85, true);

// --- summarize ---
const summary = summarize(rows, 0.5);
check("summarize trade count", summary.trades, 3);
check("summarize raw win count via winRate*n", Math.round(summary.winRate * summary.trades), 1);

// --- monthKey ---
check("monthKey buckets to YYYY-MM (UTC)", monthKey(new Date("2026-03-15T00:00:00Z").getTime() / 1000), "2026-03");
check("monthKey pads single-digit months", monthKey(new Date("2026-01-01T00:00:00Z").getTime() / 1000), "2026-01");

// --- computeTrend ---
// Helper: n rows all with the same win/loss outcome, at consecutive
// timestamps starting from `startTs`, so the caller can build an early
// block and a recent block with a controlled win rate in each.
function trendRows(wins, losses, startTs) {
  const rows = [];
  for (let i = 0; i < wins; i++) rows.push({ win: true, pnl: 0, stake: 1, timestamp: startTs + i });
  for (let i = 0; i < losses; i++) rows.push({ win: false, pnl: 0, stake: 1, timestamp: startTs + wins + i });
  return rows;
}

// Early half: 9 wins/1 loss (n=10, shrunk=(9+5)/20=0.70). Recent half: 1
// win/9 losses (n=10, shrunk=(1+5)/20=0.30). delta=-0.40, well past the
// -5pp threshold. Rows passed in reverse chronological order deliberately —
// computeTrend must sort by timestamp itself, not trust input order.
const decliningRows = [...trendRows(1, 9, 100), ...trendRows(9, 1, 0)].reverse();
const declining = computeTrend(decliningRows, 0.5);
check("declining: early half shrunk win rate", declining.early.winRate, 0.7);
check("declining: recent half shrunk win rate", declining.recent.winRate, 0.3);
check("declining: delta", declining.delta, -0.4);
check("declining: label", declining.label, "declining");

const improvingRows = [...trendRows(1, 9, 0), ...trendRows(9, 1, 100)];
const improving = computeTrend(improvingRows, 0.5);
check("improving: label", improving.label, "improving");
check("improving: delta", improving.delta, 0.4);

const stableRows = [...trendRows(5, 5, 0), ...trendRows(5, 5, 100)];
const stable = computeTrend(stableRows, 0.5);
check("stable: delta is exactly 0", stable.delta, 0);
check("stable: label", stable.label, "stable");

// Only 10 rows total -> mid=5, both halves below MIN_TRADES(8) -> no trend
// claimed at all, regardless of how lopsided the (too-thin) halves look.
const thinRows = trendRows(5, 5, 0);
check("thin sample: activity bar itself", thinRows.length < MIN_TRADES * 2, true);
const thin = computeTrend(thinRows, 0.5);
check("thin sample: label is insufficient data", thin.label, "insufficient data");
check("thin sample: delta is null, not a misleading number", thin.delta, null);
check("thin sample: still flags which half was thin", thin.early.usedFallback, true);

// --- classifyMarketsFromEvent / resultFromMarkets (the read-quota-bypass
// path's Polymarket-event parsing, mirrored from backfill.js/collect.js) ---
const fakeEvent = {
  title: "Arsenal vs. Chelsea",
  markets: [
    { question: "Will Arsenal win on 2026-03-01?", outcomePrices: "[0.02, 0.98]" },
    { question: "Will the match end in a draw?", outcomePrices: "[0.01, 0.99]" },
    { question: "Will Chelsea win on 2026-03-01?", outcomePrices: "[0.97, 0.03]" },
  ],
};
const classified = classifyMarketsFromEvent(fakeEvent);
check("classifyMarketsFromEvent: home team parsed from title", classified.homeTeam, "Arsenal");
check("classifyMarketsFromEvent: away team parsed from title", classified.awayTeam, "Chelsea");
check("classifyMarketsFromEvent: home market matched by team name prefix", classified.home?.outcomePrices, "[0.02, 0.98]");
check("classifyMarketsFromEvent: draw market matched by 'end in a draw'", classified.draw?.outcomePrices, "[0.01, 0.99]");
check("classifyMarketsFromEvent: away market matched by team name prefix", classified.away?.outcomePrices, "[0.97, 0.03]");

check(
  "resultFromMarkets: away leg's Yes price > 0.9 -> away won",
  resultFromMarkets(classified.home, classified.draw, classified.away),
  "away"
);
check(
  "resultFromMarkets: no leg above 0.9 -> undetermined (postponed/voided)",
  resultFromMarkets({ outcomePrices: "[0.4,0.6]" }, { outcomePrices: "[0.3,0.7]" }, { outcomePrices: "[0.3,0.7]" }),
  null
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
