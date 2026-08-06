// Regression test for a real bug: planSnapshots used to `return` the first
// due checkpoint instead of collecting every due one. The 15±5=[10,20] and
// 10±5=[5,15] tolerance windows overlap in [10,15] minutes-to-kickoff, so a
// single cron run landing there must be able to write both checkpoints —
// found by an independent code review, verified here, then fixed.
import { planSnapshots, CHECKPOINTS_MIN, CHECKPOINT_TOLERANCE_MIN } from "./collect.js";

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

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
