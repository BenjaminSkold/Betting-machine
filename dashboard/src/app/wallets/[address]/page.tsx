import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getMatches, getMatchTrades, getWallet } from "@/lib/data";
import type { Wallet, WalletTrend } from "@/lib/types";
import { isValidWalletAddress } from "@/lib/validate";
import StatTile from "@/components/StatTile";
import BarChart, { type BarDatum } from "@/components/BarChart";
import FadeIn from "@/components/FadeIn";

export const dynamic = "force-dynamic";

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

  // Win/loss per trade, for the activity feed's visual indicator -- needs
  // the match's eventual result and which leg this trade's conditionId
  // maps to, same logic rankWallets.js's legFor() uses server-side.
  function outcome(t: (typeof activity)[number]): "win" | "loss" | "pending" {
    if (!t.match.data.resolved || !t.match.data.result) return "pending";
    const ids = t.match.data.marketConditionIds;
    const leg = t.conditionId === ids?.home ? "home" : t.conditionId === ids?.draw ? "draw" : t.conditionId === ids?.away ? "away" : null;
    if (!leg) return "pending";
    const legWon = leg === t.match.data.result;
    const sideWon = (t.outcome === "Yes") === legWon;
    return sideWon ? "win" : "loss";
  }

  const competitionBars: BarDatum[] = Object.entries(wallet.data.bySlice.byCompetition)
    .map(([label, s]) => ({ label, value: (s.winRate ?? 0.5) - 0.5, n: s.trades }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="max-w-4xl">
      <Link href="/wallets" className="inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        <ArrowLeft size={14} /> Wallets
      </Link>

      <div className="mt-3 mb-6">
        <h1 className="break-all font-mono text-xl font-semibold text-[var(--text-primary)]">{address}</h1>
        <div className="mt-1.5 flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <span
            className="rounded-full px-2.5 py-0.5 text-xs font-medium"
            style={{ background: wallet.data.tier === "watch" ? "var(--status-good)" : "var(--gridline)", color: wallet.data.tier === "watch" ? "white" : "var(--text-secondary)" }}
          >
            {wallet.data.tier}
          </span>
          Last updated {new Date(wallet.data.lastUpdated).toLocaleString()}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Resolved trades" animate={wallet.data.totalResolvedTrades} format={(n) => n.toFixed(0)} />
        <StatTile label="Win rate (shrunk)" animate={wallet.data.aggregateWinRate * 100} format={(n) => `${n.toFixed(1)}%`} />
        <StatTile
          label="ROI"
          animate={(wallet.data.aggregateROI ?? 0) * 100}
          format={(n) => `${n.toFixed(1)}%`}
          deltaGood={(wallet.data.aggregateROI ?? 0) >= 0}
        />
      </div>

      <FadeIn className="mt-6">
        <TrendCard trend={wallet.data.trend} />
      </FadeIn>

      {competitionBars.length > 0 && (
        <FadeIn className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Edge over average, by competition</h2>
          <BarChart data={competitionBars} baseline={0} unit="pp" valueFormat={(v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}`} />
        </FadeIn>
      )}

      <SliceTable title="By team" slices={wallet.data.bySlice.byTeam} />
      <SliceTable title="By month" slices={wallet.data.bySlice.byMonth} chronological />

      <h2 className="mt-8 mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Trade history</h2>
      {activity.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-6 text-sm text-[var(--text-muted)]">No trades found for this wallet yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th scope="col" className="px-4 py-3"></th>
                <th scope="col" className="px-4 py-3">When</th>
                <th scope="col" className="px-4 py-3">Match</th>
                <th scope="col" className="px-4 py-3">Side</th>
                <th scope="col" className="tabular px-4 py-3 text-right">Price</th>
                <th scope="col" className="tabular px-4 py-3 text-right">Size</th>
              </tr>
            </thead>
            <tbody>
              {activity.slice(0, 200).map((t, i) => {
                const o = outcome(t);
                const dotColor = o === "win" ? "var(--status-good)" : o === "loss" ? "var(--status-critical)" : "var(--gridline)";
                return (
                  <tr key={i} className="border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--page-plane)]">
                    <td className="pl-4"><span className="inline-block h-2 w-2 rounded-full" style={{ background: dotColor }} title={o} /></td>
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SliceTable({ title, slices, chronological = false }: { title: string; slices: Wallet["bySlice"]["byCompetition"]; chronological?: boolean }) {
  const entries = Object.entries(slices).sort((a, b) => (chronological ? a[0].localeCompare(b[0]) : (b[1].winRate ?? 0) - (a[1].winRate ?? 0)));
  if (entries.length === 0) return null;
  return (
    <FadeIn className="mt-6">
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
    </FadeIn>
  );
}

function TrendCard({ trend }: { trend: WalletTrend }) {
  const dotColor = trend.label === "declining" ? "var(--status-critical)" : trend.label === "improving" ? "var(--status-good)" : "var(--text-muted)";
  const deltaColor = trend.delta === null ? "var(--text-muted)" : trend.delta >= 0 ? "var(--status-good-text)" : "var(--status-critical)";

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Trend</h2>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: dotColor }} />
          {trend.label}
        </span>
      </div>
      {trend.label === "insufficient data" ? (
        <p className="text-sm text-[var(--text-muted)]">
          Not enough trades in this wallet&apos;s early and recent halves yet to say anything about a trend — each half needs its own activity bar
          cleared independently.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          <div>
            <div className="text-xs text-[var(--text-secondary)]">Early half</div>
            <div className="tabular text-lg font-semibold text-[var(--text-primary)]">{pct(trend.early.winRate)}</div>
            <div className="text-xs text-[var(--text-muted)]">n={trend.early.trades}</div>
          </div>
          <div>
            <div className="text-xs text-[var(--text-secondary)]">Recent half</div>
            <div className="tabular text-lg font-semibold text-[var(--text-primary)]">{pct(trend.recent.winRate)}</div>
            <div className="text-xs text-[var(--text-muted)]">n={trend.recent.trades}</div>
          </div>
          <div>
            <div className="text-xs text-[var(--text-secondary)]">Change</div>
            <div className="tabular text-lg font-semibold" style={{ color: deltaColor }}>
              {trend.delta !== null && trend.delta >= 0 ? "+" : ""}
              {trend.delta !== null ? `${(trend.delta * 100).toFixed(1)}pp` : "—"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
