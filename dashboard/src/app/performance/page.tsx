import StatTile from "@/components/StatTile";
import { getPaperBets } from "@/lib/data";
import { MIN_SETTLED_BETS_TO_TRUST } from "@/lib/types";

export default async function PerformancePage() {
  const bets = await getPaperBets();
  const settled = bets.filter((b) => b.data.outcome !== "pending");
  const wins = settled.filter((b) => b.data.outcome === "win");
  const pending = bets.filter((b) => b.data.outcome === "pending");

  const bankroll = settled.reduce((sum, b) => sum + (b.data.pnl ?? 0), 0);
  const totalStaked = settled.reduce((sum, b) => sum + b.data.stake, 0);
  const winRate = settled.length > 0 ? wins.length / settled.length : null;
  const roi = totalStaked > 0 ? bankroll / totalStaked : null;

  const trustworthy = settled.length >= MIN_SETTLED_BETS_TO_TRUST;

  return (
    <div className="max-w-4xl">
      <h1 className="mb-1 text-2xl font-semibold text-[var(--text-primary)]">My Performance</h1>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">
        The user&apos;s own paper-bet ledger — separate from the wallet leaderboard. Flat stake, placed whenever a frozen confluence
        score&apos;s edge clears the configured threshold.
      </p>

      {!trustworthy && (
        <div
          className="mb-6 rounded-lg px-4 py-3 text-sm"
          style={{ background: "color-mix(in srgb, var(--status-warning) 15%, var(--surface-1))", border: "1px solid var(--status-warning)" }}
        >
          <span className="font-medium text-[var(--text-primary)]">N={settled.length}, too early to tell.</span>{" "}
          <span className="text-[var(--text-secondary)]">
            PROJECT.md&apos;s own bar is {MIN_SETTLED_BETS_TO_TRUST}+ settled bets (or a full season) before treating win rate, ROI, or
            any edge-by-segment finding as real rather than noise. The numbers below are shown for visibility, not as a verdict.
          </span>
        </div>
      )}

      <div className="grid grid-cols-4 gap-4">
        <StatTile label="Fake bankroll" value={`$${bankroll.toFixed(2)}`} delta={settled.length > 0 ? `${settled.length} settled` : undefined} deltaGood={bankroll >= 0} />
        <StatTile label="Win rate" value={winRate !== null ? `${(winRate * 100).toFixed(1)}%` : "—"} />
        <StatTile label="ROI" value={roi !== null ? `${(roi * 100).toFixed(1)}%` : "—"} deltaGood={roi !== null ? roi >= 0 : undefined} delta={roi !== null ? (roi >= 0 ? "profitable" : "down") : undefined} />
        <StatTile label="Pending bets" value={String(pending.length)} />
      </div>

      <h2 className="mt-8 mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Bet log</h2>
      {bets.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-6 text-sm text-[var(--text-muted)]">
          No paper bets placed yet.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th className="px-4 py-3">Match</th>
                <th className="px-4 py-3">Leg</th>
                <th className="tabular px-4 py-3 text-right">Edge at bet</th>
                <th className="tabular px-4 py-3 text-right">Stake</th>
                <th className="px-4 py-3">Outcome</th>
                <th className="tabular px-4 py-3 text-right">PnL</th>
              </tr>
            </thead>
            <tbody>
              {bets
                .sort((a, b) => b.data.placedAt.localeCompare(a.data.placedAt))
                .map((b) => (
                  <tr key={b.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-4 py-2.5 font-mono text-xs text-[var(--text-secondary)]">{b.data.matchId}</td>
                    <td className="px-4 py-2.5 text-[var(--text-secondary)]">{b.data.trackedLeg}</td>
                    <td className="tabular px-4 py-2.5 text-right text-[var(--text-primary)]">{(b.data.edgeAtBet * 100).toFixed(1)}pp</td>
                    <td className="tabular px-4 py-2.5 text-right text-[var(--text-primary)]">${b.data.stake.toFixed(0)}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge outcome={b.data.outcome} />
                    </td>
                    <td
                      className="tabular px-4 py-2.5 text-right font-medium"
                      style={{ color: b.data.pnl === null ? "var(--text-muted)" : b.data.pnl >= 0 ? "var(--status-good-text)" : "var(--status-critical)" }}
                    >
                      {b.data.pnl === null ? "—" : `${b.data.pnl >= 0 ? "+" : ""}$${b.data.pnl.toFixed(2)}`}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ outcome }: { outcome: "win" | "loss" | "pending" }) {
  const color = outcome === "win" ? "var(--status-good)" : outcome === "loss" ? "var(--status-critical)" : "var(--text-muted)";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      {outcome}
    </span>
  );
}
