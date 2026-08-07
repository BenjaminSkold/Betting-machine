// Match-resolution-triggered Tier 2 recompute (PROJECT.md's "Recompute on
// match resolution"): keeps wallet win rates/ROI/tiers current by the time
// the *next* match needs them, instead of working from up-to-a-day-stale
// numbers.
//
// Deliberately just re-runs the same full rankWallets computation
// immediately, rather than a separate "only this match's wallets" path --
// a wallet's aggregate stats span its ENTIRE trade history, not just the
// match that just resolved, so an incremental version would still need to
// load each of those wallets' other matches anyway. Reusing the exact same
// full-rescan logic the daily job uses is simpler and can't drift out of
// sync with it. Cheap enough at personal-project scale even if several
// matches resolve close together and each triggers its own recompute.
import { loadResolvedMatchesWithTrades, buildTradeRows, rankWallets, upsertWallets, MIN_TRADES } from "./rankWallets.js";

export async function recomputeWalletsOnResolution(client, matchId) {
  console.log(`  [recompute] match ${matchId} resolved — running an immediate Tier 2 recompute...`);
  const matches = await loadResolvedMatchesWithTrades(client);
  const rows = buildTradeRows(matches);
  if (rows.length === 0) return 0;

  const results = rankWallets(rows);
  const toWrite = results.filter((r) => r.totalResolvedTrades >= MIN_TRADES);
  await upsertWallets(client, toWrite);
  console.log(`  [recompute] done — ${toWrite.length} wallet(s) updated.`);
  return toWrite.length;
}
