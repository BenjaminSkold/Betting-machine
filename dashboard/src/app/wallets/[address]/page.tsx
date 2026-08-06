import Link from "next/link";
import { notFound } from "next/navigation";
import { getMatches, getMatchTrades, getWallet } from "@/lib/data";
import type { Wallet } from "@/lib/types";
import { isValidWalletAddress } from "@/lib/validate";

function pct(x: number | null | undefined): string {
  if (x === null || x === undefined) return "—";
  return `${(x * 100).toFixed(1)}%`;
}

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!isValidWalletAddress(address)) return { title: "Wallet not found" };
  const wallet = await getWallet(address);
  return { title: wallet ? `${address.slice(0, 10)}… — Wallet` : "Wallet not found" };
}

export default async function WalletDetailPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!isValidWalletAddress(address)) notFound();
  const wallet = await getWallet(address);
  if (!wallet) notFound();

  const matches = await getMatches();
  const tradesByMatch = await Promise.all(
    matches.map(async (m) => ({ match: m, trades: (await getMatchTrades(m.id)).filter((t) => t.wallet === address) }))
  );
  const activity = tradesByMatch
    .filter((x) => x.trades.length > 0)
    .flatMap((x) => x.trades.map((t) => ({ ...t, match: x.match })))
    .sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div className="max-w-4xl">
      <Link href="/wallets" className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        ← Wallets
      </Link>

      <div className="mt-2 mb-6">
        <h1 className="break-all font-mono text-xl font-semibold text-[var(--text-primary)]">{address}</h1>
        <div className="mt-1 flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <span
            className="rounded-full px-2 py-0.5 text-xs font-medium"
            style={{ background: wallet.data.tier === "watch" ? "var(--status-good)" : "var(--gridline)", color: wallet.data.tier === "watch" ? "white" : "var(--text-secondary)" }}
          >
            {wallet.data.tier}
          </span>
          Last updated {new Date(wallet.data.lastUpdated).toLocaleString()}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4">
          <div className="text-sm text-[var(--text-secondary)]">Resolved trades</div>
          <div className="mt-1 text-3xl font-semibold text-[var(--text-primary)]">{wallet.data.totalResolvedTrades}</div>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4">
          <div className="text-sm text-[var(--text-secondary)]">Win rate (shrunk)</div>
          <div className="mt-1 text-3xl font-semibold text-[var(--text-primary)]">{pct(wallet.data.aggregateWinRate)}</div>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4">
          <div className="text-sm text-[var(--text-secondary)]">ROI</div>
          <div className="mt-1 text-3xl font-semibold text-[var(--text-primary)]">{pct(wallet.data.aggregateROI)}</div>
        </div>
      </div>

      <SliceTable title="By competition" slices={wallet.data.bySlice.byCompetition} />
      <SliceTable title="By team" slices={wallet.data.bySlice.byTeam} />

      <h2 className="mt-8 mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Recent activity</h2>
      {activity.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-6 text-sm text-[var(--text-muted)]">
          No trades found for this wallet yet.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th scope="col" className="px-4 py-3">When</th>
                <th scope="col" className="px-4 py-3">Match</th>
                <th scope="col" className="px-4 py-3">Side</th>
                <th scope="col" className="tabular px-4 py-3 text-right">Price</th>
                <th scope="col" className="tabular px-4 py-3 text-right">Size</th>
              </tr>
            </thead>
            <tbody>
              {activity.slice(0, 200).map((t, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  <td className="tabular px-4 py-2 text-[var(--text-secondary)]">{new Date(t.timestamp * 1000).toLocaleString()}</td>
                  <td className="px-4 py-2">
                    <Link href={`/matches/${t.match.id}`} className="text-[var(--text-primary)] hover:underline">
                      {t.match.data.homeTeam} vs. {t.match.data.awayTeam}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-[var(--text-secondary)]">
                    {t.side} {t.outcome}
                  </td>
                  <td className="tabular px-4 py-2 text-right text-[var(--text-primary)]">{(t.price * 100).toFixed(1)}%</td>
                  <td className="tabular px-4 py-2 text-right text-[var(--text-primary)]">${t.size.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SliceTable({ title, slices }: { title: string; slices: Wallet["bySlice"]["byCompetition"] }) {
  const entries = Object.entries(slices).sort((a, b) => (b[1].winRate ?? 0) - (a[1].winRate ?? 0));
  if (entries.length === 0) return null;
  return (
    <div className="mt-6">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">{title}</h2>
      <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
              <th scope="col" className="px-4 py-3">Slice</th>
              <th scope="col" className="tabular px-4 py-3 text-right">Trades</th>
              <th scope="col" className="tabular px-4 py-3 text-right">Win rate</th>
              <th scope="col" className="tabular px-4 py-3 text-right">ROI</th>
              <th scope="col" className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, s]) => (
              <tr key={key} className="border-b border-[var(--border)] last:border-0">
                <td className="px-4 py-2 text-[var(--text-primary)]">{key}</td>
                <td className="tabular px-4 py-2 text-right text-[var(--text-primary)]">{s.trades}</td>
                <td className="tabular px-4 py-2 text-right text-[var(--text-primary)]">{pct(s.winRate)}</td>
                <td className="tabular px-4 py-2 text-right text-[var(--text-primary)]">{pct(s.roi)}</td>
                <td className="px-4 py-2 text-xs text-[var(--text-muted)]">{s.usedFallback ? "fallback (thin sample)" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
