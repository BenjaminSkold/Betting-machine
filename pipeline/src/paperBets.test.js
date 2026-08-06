// Throwaway synthetic check for paperBets.js's compute logic.
import { decideBet, settleBet } from "./paperBets.js";

let failures = 0;
function check(label, actual, expected, tolerance = 1e-9) {
  const ok = typeof expected === "number" ? Math.abs(actual - expected) <= tolerance : actual === expected;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

const opts = { edgeThreshold: 0.05, stake: 10 };

// --- decideBet ---
check(
  "edge above threshold places a bet",
  decideBet({ id: "s1", matchId: "m1", trackedLeg: "home", edge: 0.06, marketImpliedProbability: 0.4 }, opts) !== null,
  true
);
check("edge exactly at threshold does NOT bet", decideBet({ id: "s1", edge: 0.05, matchId: "m1" }, opts), null);
check("edge below threshold does NOT bet", decideBet({ id: "s1", edge: 0.03, matchId: "m1" }, opts), null);
check("negative edge does NOT bet", decideBet({ id: "s1", edge: -0.2, matchId: "m1" }, opts), null);
check("null edge does NOT bet", decideBet({ id: "s1", edge: null, matchId: "m1" }, opts), null);

// --- Regression: a price of exactly 0 or 1 must not place a bet (found by
// an independent code review — settleBet divides stake/priceAtBet, so a
// zero price is a division-by-zero waiting to happen on settlement, and
// Polymarket's quantized outcomePrices can legitimately show "0" for a
// near-dead leg on an otherwise-real edge).
check(
  "price of exactly 0 does NOT bet, even with a real edge",
  decideBet({ id: "s1", matchId: "m1", trackedLeg: "home", edge: 0.06, marketImpliedProbability: 0 }, opts),
  null
);
check(
  "price of exactly 1 does NOT bet",
  decideBet({ id: "s1", matchId: "m1", trackedLeg: "home", edge: 0.06, marketImpliedProbability: 1 }, opts),
  null
);
check(
  "null price does NOT bet",
  decideBet({ id: "s1", matchId: "m1", trackedLeg: "home", edge: 0.06, marketImpliedProbability: null }, opts),
  null
);

const bet = decideBet({ id: "s1", matchId: "m1", trackedLeg: "home", edge: 0.06, marketImpliedProbability: 0.4 }, opts);
check("bet stake matches configured stake", bet.stake, 10);
check("bet priceAtBet matches market price at bet time", bet.priceAtBet, 0.4);
check("bet starts pending", bet.outcome, "pending");

// --- settleBet ---
check("unresolved match -> not settled", settleBet({ stake: 10, priceAtBet: 0.4, trackedLeg: "home" }, { resolved: false }), null);
check(
  "no match -> not settled",
  settleBet({ stake: 10, priceAtBet: 0.4, trackedLeg: "home" }, null),
  null
);

// Win: bought $10 of shares at 0.4 -> 25 shares -> resolve to $1 each = $25, pnl = $15
const winSettlement = settleBet(
  { stake: 10, priceAtBet: 0.4, trackedLeg: "home" },
  { resolved: true, result: "home" }
);
check("win outcome", winSettlement.outcome, "win");
check("win pnl", winSettlement.pnl, 15);

// Loss: bought $10 of shares at 0.4, leg didn't happen -> lose the full stake
const lossSettlement = settleBet(
  { stake: 10, priceAtBet: 0.4, trackedLeg: "home" },
  { resolved: true, result: "away" }
);
check("loss outcome", lossSettlement.outcome, "loss");
check("loss pnl", lossSettlement.pnl, -10);

// --- Regression: resolved: true with result: null (voided/postponed, per
// resultFrom()'s documented ambiguous case) must settle as its own "void"
// outcome, not stay pending forever. Found by an independent code review.
const voidSettlement = settleBet({ stake: 10, priceAtBet: 0.4, trackedLeg: "home" }, { resolved: true, result: null });
check("voided match settles (not null/still-pending)", voidSettlement !== null, true);
check("voided match outcome is 'void', not win/loss", voidSettlement.outcome, "void");
check("voided match refunds the stake (pnl 0), doesn't count as a loss", voidSettlement.pnl, 0);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
