import { getWallets } from "@/lib/data";
import { parseFilters } from "@/lib/filters";
import FilterBar from "@/components/FilterBar";
import WalletTable from "@/components/WalletTable";
import StatTile from "@/components/StatTile";
import FadeIn from "@/components/FadeIn";

export const dynamic = "force-dynamic";

export default async function WalletsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = parseFilters(await searchParams);
  const wallets = await getWallets();
  const watchlisted = wallets.filter((w) => w.data.tier === "watch");

  const walletQuery = filters.wallet?.toLowerCase().trim();
  const filtered = walletQuery ? watchlisted.filter((w) => w.id.toLowerCase().includes(walletQuery)) : watchlisted;

  const anyThinBestComp = filtered.some((w) => {
    const best = Object.values(w.data.bySlice.byCompetition).sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))[0];
    return best?.usedFallback;
  });

  return (
    <div className="max-w-4xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">Wallets</h1>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">The tier-&quot;watch&quot; leaderboard — win rate is shrinkage-adjusted, never raw.</p>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Wallets tracked" animate={wallets.length} format={(n) => n.toFixed(0)} />
        <StatTile label="Promoted to watch" animate={watchlisted.length} format={(n) => n.toFixed(0)} />
      </div>

      <FilterBar fields={["competition", "team", "wallet"]} />

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
    </div>
  );
}
