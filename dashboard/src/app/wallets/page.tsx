import { getWallets } from "@/lib/data";

function pct(x: number | null | undefined): string {
  if (x === null || x === undefined) return "—";
  return `${(x * 100).toFixed(1)}%`;
}

export default async function WalletsPage() {
  const wallets = await getWallets();
  const watchlisted = wallets
    .filter((w) => w.data.tier === "watch")
    .sort((a, b) => b.data.aggregateWinRate - a.data.aggregateWinRate);

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
                <th className="px-4 py-3">Wallet</th>
                <th className="tabular px-4 py-3 text-right">Trades</th>
                <th className="tabular px-4 py-3 text-right">Win rate</th>
                <th className="tabular px-4 py-3 text-right">ROI</th>
                <th className="px-4 py-3">Best competition</th>
              </tr>
            </thead>
            <tbody>
              {watchlisted.map((w) => {
                const bestComp = Object.entries(w.data.bySlice.byCompetition).sort((a, b) => (b[1].winRate ?? 0) - (a[1].winRate ?? 0))[0];
                return (
                  <tr key={w.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-secondary)]">{w.id.slice(0, 12)}…</td>
                    <td className="tabular px-4 py-2.5 text-right text-[var(--text-primary)]">{w.data.totalResolvedTrades}</td>
                    <td className="tabular px-4 py-2.5 text-right font-medium text-[var(--text-primary)]">{pct(w.data.aggregateWinRate)}</td>
                    <td className="tabular px-4 py-2.5 text-right text-[var(--text-primary)]">{pct(w.data.aggregateROI)}</td>
                    <td className="px-4 py-2.5 text-[var(--text-secondary)]">
                      {bestComp ? `${bestComp[0]} (${pct(bestComp[1].winRate)})` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
