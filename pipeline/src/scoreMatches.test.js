// Throwaway synthetic check for scoreMatches.js's compute logic — hand-worked
// expected numbers, run before trusting it against real Firestore data.
import { computeMatchScore, classifyMarketsFromEvent, kickoffTimeFromMarket } from "./scoreMatches.js";

let failures = 0;
function check(label, actual, expected, tolerance = 1e-6) {
  const ok = typeof expected === "number" ? Math.abs(actual - expected) <= tolerance : actual === expected;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

const marketConditionIds = { home: "H", draw: "D", away: "A" };
const marketPrices = { home: 0.5, draw: 0.25, away: 0.25 };

// W1 is skilled (winRate 0.8) and bets FOR home (BUY Yes, size 100).
// W2 is exactly average (winRate 0.5) and bets FOR away — contributes zero
// weight regardless of size, since (0.5-0.5)=0.
const walletsByAddress = new Map([
  ["W1", { tier: "watch", aggregateWinRate: 0.8 }],
  ["W2", { tier: "watch", aggregateWinRate: 0.5 }],
  ["W3-unranked", { tier: "unranked", aggregateWinRate: 0.9 }], // must be excluded entirely
]);

const trades = [
  { wallet: "W1", side: "BUY", outcome: "Yes", size: 100, conditionId: "H", timestamp: 0 },
  { wallet: "W2", side: "BUY", outcome: "Yes", size: 50, conditionId: "A", timestamp: 0 },
  { wallet: "W3-unranked", side: "BUY", outcome: "Yes", size: 1000, conditionId: "D", timestamp: 0 },
];

const result = computeMatchScore(trades, walletsByAddress, marketPrices, marketConditionIds);

// Hand-worked: totalVolume = 100+50 = 150 (unranked W3's 1000 excluded entirely)
// home rawSignal = 100*(0.8-0.5)*1 = 30 -> normalizedSignal = 30/150 = 0.2
// shift_home = 0.15 * (0.2/0.5) = 0.06 -> rawEstimate = 0.56
// draw/away rawSignal = 0 (W2 has zero skill weight) -> rawEstimate unchanged (0.25, 0.25)
// rawTotal = 0.56+0.25+0.25 = 1.06
// probEstimate_home = 0.56/1.06, edge_home = that - 0.5
const expectedProbHome = 0.56 / 1.06;
check("unranked wallet excluded (draw leg score stays 0)", result.breakdown.draw.score, 0);
check("home leg score (normalized signal)", result.breakdown.home.score, 0.2);
check("home probabilityEstimate", result.breakdown.home.probabilityEstimate, expectedProbHome);
check("home edge", result.breakdown.home.edge, expectedProbHome - 0.5);
check("draw probabilityEstimate", result.breakdown.draw.probabilityEstimate, 0.25 / 1.06);
check("tracked leg is home (largest |edge|)", result.trackedLeg, "home");
check("top-level score matches home leg", result.score, 0.2);
check("top-level marketImpliedProbability", result.marketImpliedProbability, 0.5);

// --- No watchlisted activity at all -> no leg has any signal, but market
// prices should still pass through unchanged (edge ~0 everywhere).
const noSignal = computeMatchScore([], walletsByAddress, marketPrices, marketConditionIds);
check("no-signal home probEstimate equals market price", noSignal.breakdown.home.probabilityEstimate, 0.5);
check("no-signal home edge is ~0", noSignal.breakdown.home.edge, 0);

// --- Regression: a lopsided-but-legitimate market price (a near-certain
// favorite) with ZERO watchlisted signal must not manufacture a phantom
// edge from the [0.01, 0.99] clip bounds. Found by an independent code
// review: the old code clipped marketPrice+shift unconditionally, even
// when shift was exactly 0, so 0.995 got forced down to 0.99 with no
// signal at all, producing a nonzero edge out of thin air.
const lopsidedPrices = { home: 0.995, draw: 0.003, away: 0.002 };
const noSignalLopsided = computeMatchScore([], walletsByAddress, lopsidedPrices, marketConditionIds);
check("no signal + lopsided price: probEstimate equals raw market price (not clipped)", noSignalLopsided.breakdown.home.probabilityEstimate, 0.995);
check("no signal + lopsided price: edge is exactly 0, not a clip artifact", noSignalLopsided.breakdown.home.edge, 0);

// --- Directionality: SELL Yes should count as betting AGAINST that leg.
const sellTrades = [{ wallet: "W1", side: "SELL", outcome: "Yes", size: 100, conditionId: "H", timestamp: 0 }];
const sellResult = computeMatchScore(sellTrades, walletsByAddress, marketPrices, marketConditionIds);
check("SELL Yes produces a negative home signal", sellResult.breakdown.home.score < 0, true);

// --- classifyMarketsFromEvent / kickoffTimeFromMarket (the read-quota-
// bypass path's Polymarket-event parsing, mirrored from
// backfill.js/collect.js/rankWallets.js) ---
const fakeEvent = {
  title: "Liverpool vs. Everton",
  endDate: "2026-05-01T14:00:00.000Z",
  markets: [
    { question: "Will Liverpool win on 2026-05-01?", gameStartTime: "2026-05-01 13:00:00+00" },
    { question: "Will the match end in a draw?" },
    { question: "Will Everton win on 2026-05-01?" },
  ],
};
const classified = classifyMarketsFromEvent(fakeEvent);
check("classifyMarketsFromEvent: home team from title", classified.homeTeam, "Liverpool");
check("classifyMarketsFromEvent: away team from title", classified.awayTeam, "Everton");
check("classifyMarketsFromEvent: home matched by team-name prefix", classified.home?.question, "Will Liverpool win on 2026-05-01?");
check("classifyMarketsFromEvent: away matched by team-name prefix", classified.away?.question, "Will Everton win on 2026-05-01?");

check(
  "kickoffTimeFromMarket: parses gameStartTime, fixing the missing ':00' UTC offset",
  kickoffTimeFromMarket(classified.home, fakeEvent).toISOString(),
  "2026-05-01T13:00:00.000Z"
);
check(
  "kickoffTimeFromMarket: falls back to event.endDate when gameStartTime is absent",
  kickoffTimeFromMarket({}, fakeEvent).toISOString(),
  "2026-05-01T14:00:00.000Z"
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
