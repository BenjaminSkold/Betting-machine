import Link from "next/link";
import { getWallets } from "@/lib/data";
import type { WalletTrend } from "@/lib/types";

export const dynamic = "force-dynamic";

function pct(x: number | null | undefined): string {
  if (x === null || x === undefined) return "—";
  return `${(x * 100).toFixed(1)}%`;
}

// Early-vs-recent-half comparison (see rankWallets.js's computeTrend) —
// surfaced here so a wallet quietly fading after a hot start doesn't hide
// behind one all-time aggregate win rate.
function TrendCell({ trend }: { trend: WalletTrend }) {
  if (trend.label === "insufficient data") {
    return <span className="text-xs text-[var(--text-muted)]">—</span>;
  }
  const color = trend.label === "declining" ? "var(--status-critical)" : trend.label === "improving" ? "var(--status-good)" : "var(--text-muted)";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]" title={`recent half ${pct(trend.recent.winRate)} vs early half ${pct(trend.early.winRate)}`}>
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      {trend.label}
    </span>
  );
}

export default async function WalletsPage() {
  const wallets = await getWallets();
  const watchlisted = wallets
    .filter((w) => w.data.tier === "watch")
    .sort((a, b) => b.data.aggregateWinRate - a.data.aggregateWinRate);
  const anyThinBestComp = watchlisted.some((w) => {
    const best = Object.values(w.data.bySlice.byCompetition).sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))[0];
    return best?.usedFallback;
  });

  return (
    <div className="max-w-4xl">
      <h1 className="mb-1 text-2xl font-semibold text-[var(--text-primary)]">Wallets</h1>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">
        Tier &quot;watch&quot; wallets — {wallets.length} tracked, {watchlisted.length} promoted. Win rate is shrinkage-adjusted, not raw.
      </p>

      {watchlisted.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-6 text-sm text-[var(--text-muted)]">
          No wallets have cleared the activity + quality bar yet. This fills in once the wallet-ranking job has real trade history to
          work with.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th scope="col" className="px-4 py-3">Wallet</th>
                <th scope="col" className="tabular px-4 py-3 text-right">Trades</th>
                <th scope="col" className="tabular px-4 py-3 text-right">Win rate</th>
                <th scope="col" className="tabular px-4 py-3 text-right">ROI</th>
                <th scope="col" className="px-4 py-3">Best competition</th>
                <th scope="col" className="px-4 py-3">Trend</th>
              </tr>
            </thead>
            <tbody>
              {watchlisted.map((w) => {
                const bestComp = Object.entries(w.data.bySlice.byCompetition).sort((a, b) => (b[1].winRate ?? 0) - (a[1].winRate ?? 0))[0];
                return (
                  <tr key={w.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-4 py-2.5 font-mono text-xs">
                      <Link href={`/wallets/${w.id}`} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline">
                        {w.id.slice(0, 12)}…
                      </Link>
                    </td>
                    <td className="tabular px-4 py-2.5 text-right text-[var(--text-primary)]">{w.data.totalResolvedTrades}</td>
                    <td className="tabular px-4 py-2.5 text-right font-medium text-[var(--text-primary)]">{pct(w.data.aggregateWinRate)}</td>
                    <td className="tabular px-4 py-2.5 text-right text-[var(--text-primary)]">{pct(w.data.aggregateROI)}</td>
                    <td className="px-4 py-2.5 text-[var(--text-secondary)]">
                      {bestComp ? (
                        <>
                          {bestComp[0]} ({pct(bestComp[1].winRate)})
                          {bestComp[1].usedFallback && (
                            <span className="ml-1 text-[var(--text-muted)]" title="Thin sample — this slice fell back to the shrinkage prior">
                              *
                            </span>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <TrendCell trend={w.data.trend} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {anyThinBestComp && (
        <p className="mt-2 text-xs text-[var(--text-muted)]">* thin sample — that slice fell back to the shrinkage prior rather than a raw win rate.</p>
      )}
    </div>
  );
}
