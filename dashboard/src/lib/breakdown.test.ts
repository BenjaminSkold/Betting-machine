import { edgeBucketLabel, favoriteUnderdogLabel, segmentStats, sortByBucketOrder } from "./breakdown.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK  " : "FAIL"} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

const bets = [
  { key: "EPL", outcome: "win", pnl: 15, stake: 10 },
  { key: "EPL", outcome: "loss", pnl: -10, stake: 10 },
  { key: "UCL", outcome: "win", pnl: 5, stake: 10 },
];
const stats = segmentStats(bets, (b) => b.key, (b) => b);

check("EPL segment count", stats.find((s) => s.key === "EPL")?.count, 2);
check("EPL segment win rate (1 of 2)", stats.find((s) => s.key === "EPL")?.winRate, 0.5);
check("EPL segment ROI ((15-10)/20)", stats.find((s) => s.key === "EPL")?.roi, 0.25);
check("UCL segment win rate (1 of 1)", stats.find((s) => s.key === "UCL")?.winRate, 1);
check("segments sorted by count descending (EPL before UCL)", stats[0].key, "EPL");
check("empty input produces no segments", segmentStats([], () => "x", () => ({ outcome: "win", pnl: 0, stake: 0 })), []);

check("edge just above threshold buckets to 5-10pp", edgeBucketLabel(0.05), "5–10pp");
check("edge just under 10pp still buckets to 5-10pp", edgeBucketLabel(0.0999), "5–10pp");
check("edge at exactly 10pp buckets to 10-15pp (bucket boundaries are half-open)", edgeBucketLabel(0.1), "10–15pp");
check("very large edge buckets to 25pp+", edgeBucketLabel(0.5), "25pp+");

const scrambled = [
  { key: "25pp+", count: 1, winRate: 1, roi: 1 },
  { key: "5–10pp", count: 5, winRate: 0.5, roi: 0.1 },
  { key: "15–25pp", count: 2, winRate: 0.5, roi: 0.1 },
];
check(
  "sortByBucketOrder restores low-to-high edge order regardless of count",
  sortByBucketOrder(scrambled).map((s) => s.key),
  ["5–10pp", "15–25pp", "25pp+"]
);

check("priceAtBet just above 50% is a favorite", favoriteUnderdogLabel(0.51), "Favorite");
check("priceAtBet at exactly 50% is an underdog (not a favorite)", favoriteUnderdogLabel(0.5), "Underdog");
check("priceAtBet just below 50% is an underdog", favoriteUnderdogLabel(0.49), "Underdog");
check("a heavy favorite is still just 'Favorite'", favoriteUnderdogLabel(0.9), "Favorite");
check("a heavy underdog is still just 'Underdog'", favoriteUnderdogLabel(0.05), "Underdog");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
