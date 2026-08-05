// Throwaway synthetic check for rankWallets.js's compute logic — hand-worked
// expected numbers, run before trusting it against real Firestore data.
import { shrink, pnlAndStake, legFor, buildTradeRows, summarize, SHRINKAGE_K } from "./rankWallets.js";

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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
