"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import type { Wallet, WalletTrend } from "@/lib/types";

function pct(x: number | null | undefined): string {
  if (x === null || x === undefined) return "—";
  return `${(x * 100).toFixed(1)}%`;
}

function TrendCell({ trend }: { trend: WalletTrend }) {
  if (trend.label === "insufficient data") return <span className="text-xs text-[var(--text-muted)]">—</span>;
  const color = trend.label === "declining" ? "var(--status-critical)" : trend.label === "improving" ? "var(--status-good)" : "var(--text-muted)";
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]"
      title={`recent half ${pct(trend.recent.winRate)} vs early half ${pct(trend.early.winRate)}`}
    >
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      {trend.label}
    </span>
  );
}

type SortKey = "trades" | "winRate" | "roi";
type ViewMode = "aggregate" | "byCompetition" | "byTeam";

// Win rate is shrinkage-adjusted toward the population average for thin
// samples (see rankWallets.js's shrink()) -- ROI is NOT, and never has
// been. Sorting the whole leaderboard by raw ROI (its own default sort)
// means the top of the list is structurally guaranteed to surface thin,
// lucky samples: with ~20k+ watchlisted wallets and only MIN_TRADES=8
// required to qualify at all, some will show a huge ROI from noise alone,
// the same way flipping enough coins guarantees a lucky streak somewhere.
// This doesn't change the ranking itself (that's a scoring-weight decision,
// not a display one) -- it flags which numbers are backed by enough
// history to mean anything, same "must look visibly different" principle
// TrustGate/BarChart already apply elsewhere.
const MIN_TRADES_FOR_ROI_TRUST = 30;

export default function WalletTable({
  wallets,
  competitionFilter,
  teamFilter,
}: {
  wallets: { id: string; data: Wallet }[];
  competitionFilter?: string;
  teamFilter?: string;
}) {
  // Matches the server's own selection criterion (getWatchlistedWallets
  // fetches the top N BY ROI) -- defaulting the client-side sort to
  // anything else meant the page's own "top N by ROI" disclosure text
  // didn't match what was actually on screen (found live: the highest-ROI
  // row wasn't even visible without scrolling, since it defaulted to
  // sorting the ROI-selected slice by win rate instead).
  const [sortKey, setSortKey] = useState<SortKey>("roi");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [viewMode, setViewMode] = useState<ViewMode>("aggregate");

  // Sliced view needs a specific slice key -- reuse whatever the shared
  // filter bar already has selected, since duplicating a second selector
  // just for this table would let it disagree with the rest of the page.
  const sliceKey = viewMode === "byCompetition" ? competitionFilter : viewMode === "byTeam" ? teamFilter : undefined;
  const sliceMissing = viewMode !== "aggregate" && !sliceKey;

  function statsFor(w: Wallet): { trades: number; winRate: number | null; roi: number | null; usedFallback: boolean; thin: boolean } {
    if (viewMode === "aggregate" || !sliceKey) {
      return {
        trades: w.totalResolvedTrades,
        winRate: w.aggregateWinRate,
        roi: w.aggregateROI,
        usedFallback: false,
        thin: w.totalResolvedTrades < MIN_TRADES_FOR_ROI_TRUST,
      };
    }
    const bucket = viewMode === "byCompetition" ? w.bySlice.byCompetition : w.bySlice.byTeam;
    // Team names/competition codes are exact-match keys; team filter is a
    // free-text field elsewhere, so fall back to a case-insensitive lookup.
    const matchKey = Object.keys(bucket).find((k) => k.toLowerCase() === sliceKey!.toLowerCase());
    const slice = matchKey ? bucket[matchKey] : undefined;
    return slice
      ? { trades: slice.trades, winRate: slice.winRate, roi: slice.roi, usedFallback: slice.usedFallback, thin: slice.trades < MIN_TRADES_FOR_ROI_TRUST }
      : { trades: 0, winRate: null, roi: null, usedFallback: false, thin: true };
  }

  const sorted = useMemo(() => {
    const withStats = wallets.map((w) => ({ ...w, stats: statsFor(w.data) }));
    return withStats.sort((a, b) => {
      const av = a.stats[sortKey] ?? -Infinity;
      const bv = b.stats[sortKey] ?? -Infinity;
      return sortDir === "desc" ? bv - av : av - bv;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    });
  }, [wallets, sortKey, sortDir, viewMode, sliceKey]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function SortHeader({ label, k }: { label: string; k: SortKey }) {
    const Icon = sortKey !== k ? ArrowUpDown : sortDir === "desc" ? ArrowDown : ArrowUp;
    return (
      <button onClick={() => toggleSort(k)} className="tabular flex items-center gap-1 text-right font-medium hover:text-[var(--text-primary)]">
        {label}
        <Icon size={11} className={sortKey === k ? "text-[var(--text-primary)]" : "opacity-50"} />
      </button>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-1 text-xs">
        {(["aggregate", "byCompetition", "byTeam"] as ViewMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className="rounded-md px-2.5 py-1 font-medium transition-colors"
            style={{
              background: viewMode === mode ? "color-mix(in srgb, var(--diverging-pos) 14%, transparent)" : "transparent",
              color: viewMode === mode ? "var(--diverging-pos)" : "var(--text-secondary)",
            }}
          >
            {mode === "aggregate" ? "Aggregate" : mode === "byCompetition" ? "By competition" : "By team"}
          </button>
        ))}
      </div>

      {sliceMissing && (
        <div className="mb-3 rounded-md px-3 py-2 text-xs text-[var(--text-secondary)]" style={{ background: "var(--page-plane)" }}>
          Pick a {viewMode === "byCompetition" ? "competition" : "team"} in the filter bar above to see stats sliced that way.
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
              <th scope="col" className="px-4 py-3">Wallet</th>
              <th scope="col" className="px-4 py-3 text-right"><SortHeader label="Trades" k="trades" /></th>
              <th scope="col" className="px-4 py-3 text-right"><SortHeader label="Win rate" k="winRate" /></th>
              <th scope="col" className="px-4 py-3 text-right"><SortHeader label="ROI" k="roi" /></th>
              <th scope="col" className="px-4 py-3">Trend</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((w) => (
              <tr key={w.id} className="border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--page-plane)]">
                <td className="px-4 py-2.5 font-mono text-xs">
                  <Link href={`/wallets/${w.id}`} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline">
                    {w.id.slice(0, 12)}…
                  </Link>
                </td>
                <td className="tabular px-4 py-2.5 text-right text-[var(--text-primary)]">
                  {w.stats.trades}
                  {w.stats.thin && (
                    <span
                      className="ml-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
                      style={{ background: "var(--status-warning)" }}
                      title={`Under ${MIN_TRADES_FOR_ROI_TRUST} trades — win rate/ROI here could easily be noise, not skill`}
                    />
                  )}
                </td>
                <td
                  className="tabular px-4 py-2.5 text-right font-medium text-[var(--text-primary)]"
                  style={w.stats.thin ? { opacity: 0.55 } : undefined}
                >
                  {pct(w.stats.winRate)}
                  {w.stats.usedFallback && (
                    <span className="ml-1 text-[var(--text-muted)]" title="Thin sample — fell back to the shrinkage prior">*</span>
                  )}
                </td>
                <td
                  className="tabular px-4 py-2.5 text-right font-medium"
                  style={{
                    color: w.stats.roi === null ? "var(--text-muted)" : w.stats.roi >= 0 ? "var(--status-good-text)" : "var(--status-critical)",
                    opacity: w.stats.thin ? 0.55 : 1,
                  }}
                  title={w.stats.thin ? `Under ${MIN_TRADES_FOR_ROI_TRUST} trades — ROI is not shrunk/regularized, so this can be pure noise` : undefined}
                >
                  {pct(w.stats.roi)}
                </td>
                <td className="px-4 py-2.5">
                  <TrendCell trend={w.data.trend} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
