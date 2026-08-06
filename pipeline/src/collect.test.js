// Regression test for a real bug: planSnapshots used to `return` the first
// due checkpoint instead of collecting every due one. The 15±5=[10,20] and
// 10±5=[5,15] tolerance windows overlap in [10,15] minutes-to-kickoff, so a
// single cron run landing there must be able to write both checkpoints —
// found by an independent code review, verified here, then fixed.
import { planSnapshots, planNewTrades, CHECKPOINTS_MIN, CHECKPOINT_TOLERANCE_MIN } from "./collect.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK  " : "FAIL"} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

// A fake matchRef whose snapshot docs never exist yet, so every due
// checkpoint should come back as "needs writing".
function fakeMatchRef() {
  return {
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: false }) }),
    }),
  };
}

const fakeMarket = (price) => ({ outcomePrices: JSON.stringify([String(price), String(1 - price)]), liquidity: "100" });

async function main() {
  // Sanity check on the tolerance math itself, since the bug depends on it.
  check("windows overlap (15's window reaches down to 10)", 15 - CHECKPOINT_TOLERANCE_MIN <= 10 + CHECKPOINT_TOLERANCE_MIN, true);

  // kickoff exactly 12 minutes from now sits inside BOTH the 15±5=[10,20]
  // and 10±5=[5,15] windows — the exact overlap scenario.
  const kickoffTime = new Date(Date.now() + 12 * 60 * 1000);
  const due = await planSnapshots(fakeMatchRef(), fakeMarket(0.5), fakeMarket(0.25), fakeMarket(0.25), kickoffTime);
  const dueCheckpoints = due.map((d) => d.data.minutesBeforeKickoff).sort((a, b) => a - b);
  check("both overlapping checkpoints (10 and 15) are returned, not just one", dueCheckpoints, [10, 15]);

  // kickoff 62 minutes out: only the 60-min window (55-65) is due.
  const due60 = await planSnapshots(fakeMatchRef(), fakeMarket(0.5), fakeMarket(0.25), fakeMarket(0.25), new Date(Date.now() + 62 * 60 * 1000));
  check("only checkpoint 60 due at 62min out", due60.map((d) => d.data.minutesBeforeKickoff), [60]);

  // kickoff already passed (negative minutesToKickoff): nothing is due.
  const duePast = await planSnapshots(fakeMatchRef(), fakeMarket(0.5), fakeMarket(0.25), fakeMarket(0.25), new Date(Date.now() - 5 * 60 * 1000));
  check("nothing due once kickoff has passed", duePast.length, 0);

  // --- Regression: a trade tying the previous run's max timestamp exactly
  // used to be silently and permanently dropped by a strict `timestamp >
  // since` cursor filter. Found by an independent code review — plausible
  // on an actively-trading market where two trades land in the same second.
  const trade = (hash, ts) => ({ transactionHash: hash, asset: "A1", outcomeIndex: 0, wallet: "W", timestamp: ts, price: 0.5, size: 10, outcome: "Yes" });
  const market = { conditionId: "C1" };

  // Run 1: two trades, both at t=100. Both are new (empty cursor).
  const run1Trades = [trade("0x1", 100), trade("0x2", 100)];
  const run1 = await planNewTrades([market], {}, async () => run1Trades);
  check("run 1: both same-second trades counted as new", run1.newTrades.length, 2);
  check("run 1: cursor timestamp advances to the tied max", run1.lastSeenTimestamp.C1, 100);
  check("run 1: cursor remembers both trade keys at that timestamp", run1.lastSeenKeysAtCursor.C1.length, 2);

  // Run 2: same two trades PLUS a third that ALSO landed at t=100 (arrived
  // late — e.g. on-chain indexing lag). The old strict `>` filter would
  // drop it forever since 100 > 100 is false.
  const run2Trades = [...run1Trades, trade("0x3", 100)];
  const run2 = await planNewTrades([market], run1, async () => run2Trades);
  check("run 2: the late-arriving same-second trade is NOT dropped", run2.newTrades.length, 1);
  check("run 2: the late trade is the one identified as new", run2.newTrades[0].transactionHash, "0x3");

  // Run 3: nothing new at all — cursor doesn't regress or duplicate.
  const run3 = await planNewTrades([market], run2, async () => run2Trades);
  check("run 3: no new trades once everything's already been seen", run3.newTrades.length, 0);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
