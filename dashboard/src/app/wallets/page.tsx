import { getWalletCounts, getWatchlistedWallets, searchWatchlistedWallets, getTeamsByCompetition } from "@/lib/data";
import { parseFilters } from "@/lib/filters";
import FilterBar from "@/components/FilterBar";
import WalletTable from "@/components/WalletTable";
import StatTile from "@/components/StatTile";
import FadeIn from "@/components/FadeIn";

export const dynamic = "force-dynamic";

// Once real market volume backfilled, tier:"watch" itself can run into the
// tens of thousands -- shipping all of them to a client-side sortable table
// means a multi-MB payload and slow hydration for a page nobody scrolls
// past the first few hundred rows of anyway. Capped by ROI (the table's own
// default sort) so the leaderboard still shows its most interesting rows;
// a wallet search bypasses the cap entirely since it needs to find ANY
// matching address, not just one in the top slice.
const LEADERBOARD_DISPLAY_CAP = 300;

export default async function WalletsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = parseFilters(await searchParams);
  const walletQuery = filters.wallet?.toLowerCase().trim();

  const [counts, filtered, teamsByCompetition] = await Promise.all([
    getWalletCounts(),
    walletQuery ? searchWatchlistedWallets(walletQuery, LEADERBOARD_DISPLAY_CAP) : getWatchlistedWallets(LEADERBOARD_DISPLAY_CAP),
    getTeamsByCompetition(),
  ]);
  const capped = !walletQuery && filtered.length >= LEADERBOARD_DISPLAY_CAP && counts.watchlisted > LEADERBOARD_DISPLAY_CAP;

  const anyThinBestComp = filtered.some((w) => {
    const best = Object.values(w.data.bySlice.byCompetition).sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))[0];
    return best?.usedFallback;
  });

  return (
    <div className="max-w-4xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">Wallets</h1>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">The tier-&quot;watch&quot; leaderboard — win rate is shrinkage-adjusted, never raw.</p>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Wallets tracked" animate={counts.total} format="integer" />
        <StatTile label="Promoted to watch" animate={counts.watchlisted} format="integer" />
      </div>

      <FilterBar fields={["competition", "team", "wallet"]} teamsByCompetition={teamsByCompetition} />

      {capped && (
        <p className="mb-3 text-xs text-[var(--text-muted)]">
          Showing the top {LEADERBOARD_DISPLAY_CAP.toLocaleString()} of {counts.watchlisted.toLocaleString()} watchlisted wallets by ROI — search above to find a specific address.
        </p>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-6 text-sm text-[var(--text-muted)]">
          No wallets match these filters yet.
        </div>
      ) : (
        <FadeIn>
          <WalletTable wallets={filtered} competitionFilter={filters.competition} teamFilter={filters.team} />
        </FadeIn>
      )}
      {anyThinBestComp && <p className="mt-2 text-xs text-[var(--text-muted)]">* thin sample — that slice fell back to the shrinkage prior rather than a raw win rate.</p>}
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: "var(--status-warning)" }} /> next to a trade
        count means under 30 trades — this leaderboard is sorted by ROI, which (unlike win rate) is never shrunk toward the average, so a high ROI on
        a thin sample can easily be luck rather than skill.
      </p>
    </div>
  );
}
