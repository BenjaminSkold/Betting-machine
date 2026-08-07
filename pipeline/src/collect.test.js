import { planNewTrades, pollIntervalMsFor, isDue } from "./collect.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK  " : "FAIL"} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

async function main() {
  // --- Adaptive polling schedule ---
  check("multiple days out: daily", pollIntervalMsFor({ minutesToKickoff: 5000, isLive: false }), 24 * 60 * 60_000);
  check("~1 day out: every 4 hours", pollIntervalMsFor({ minutesToKickoff: 30 * 60, isLive: false }), 4 * 60 * 60_000);
  check("several hours out: hourly", pollIntervalMsFor({ minutesToKickoff: 10 * 60, isLive: false }), 60 * 60_000);
  check("~1hr out (90min): 15 minutes", pollIntervalMsFor({ minutesToKickoff: 90, isLive: false }), 15 * 60_000);
  check("final hour: every minute", pollIntervalMsFor({ minutesToKickoff: 45, isLive: false }), 60_000);
  check("final 15 minutes: every 30s", pollIntervalMsFor({ minutesToKickoff: 10, isLive: false }), 30_000);
  check("live: every minute (not 30s)", pollIntervalMsFor({ minutesToKickoff: -5, isLive: true }), 60_000);

  // --- isDue ---
  check("never polled before -> always due", isDue(null, 60_000), true);
  const now = Date.parse("2026-03-01T12:00:00.000Z");
  check("polled 30s ago, needs 60s -> not due yet", isDue(new Date(now - 30_000).toISOString(), 60_000, now), false);
  check("polled 61s ago, needs 60s -> due", isDue(new Date(now - 61_000).toISOString(), 60_000, now), true);

  // --- Regression: a trade tying the previous poll's max timestamp exactly
  // used to be silently and permanently dropped by a strict `timestamp >
  // since` cursor filter. Found by an independent code review — plausible
  // on an actively-trading market where two trades land in the same second.
  const trade = (hash, ts) => ({ transactionHash: hash, asset: "A1", outcomeIndex: 0, wallet: "W", timestamp: ts, price: 0.5, size: 10, outcome: "Yes" });
  const market = { conditionId: "C1" };

  // Poll 1: two trades, both at t=100. Both are new (empty cursor).
  const poll1Trades = [trade("0x1", 100), trade("0x2", 100)];
  const poll1 = await planNewTrades([market], {}, async () => poll1Trades);
  check("poll 1: both same-second trades counted as new", poll1.newTrades.length, 2);
  check("poll 1: cursor timestamp advances to the tied max", poll1.lastSeenTimestamp.C1, 100);
  check("poll 1: cursor remembers both trade keys at that timestamp", poll1.lastSeenKeysAtCursor.C1.length, 2);

  // Poll 2: same two trades PLUS a third that ALSO landed at t=100 (arrived
  // late — e.g. on-chain indexing lag). The old strict `>` filter would
  // drop it forever since 100 > 100 is false.
  const poll2Trades = [...poll1Trades, trade("0x3", 100)];
  const poll2 = await planNewTrades([market], poll1, async () => poll2Trades);
  check("poll 2: the late-arriving same-second trade is NOT dropped", poll2.newTrades.length, 1);
  check("poll 2: the late trade is the one identified as new", poll2.newTrades[0].transactionHash, "0x3");

  // Poll 3: nothing new at all — cursor doesn't regress or duplicate.
  const poll3 = await planNewTrades([market], poll2, async () => poll2Trades);
  check("poll 3: no new trades once everything's already been seen", poll3.newTrades.length, 0);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
