import StatTile from "@/components/StatTile";
import BankrollChart, { type BankrollPoint } from "@/components/BankrollChart";
import TrustGate from "@/components/TrustGate";
import FadeIn from "@/components/FadeIn";
import { getMatches, getPaperBets } from "@/lib/data";
import { MIN_SETTLED_BETS_TO_TRUST } from "@/lib/types";
import { edgeBucketLabel, favoriteUnderdogLabel, segmentStats, sortByBucketOrder, type Segment } from "@/lib/breakdown";

export const dynamic = "force-dynamic";

function pct(x: number | null): string {
  return x !== null ? `${(x * 100).toFixed(1)}%` : "—";
}

export default async function PerformancePage() {
  const [bets, matches] = await Promise.all([getPaperBets(), getMatches()]);
  const competitionByMatch = new Map(matches.map((m) => [m.id, m.data.competition]));

  const pending = bets.filter((b) => b.data.outcome === "pending");
  const voided = bets.filter((b) => b.data.outcome === "void");
  // "Decided" excludes void (postponed/voided match, stake refunded) from
  // win rate/ROI and the trust threshold — a void carries no information
  // about whether the edge strategy works.
  const decided = bets.filter((b) => b.data.outcome === "win" || b.data.outcome === "loss");
  const wins = decided.filter((b) => b.data.outcome === "win");

  const bankroll = decided.reduce((sum, b) => sum + (b.data.pnl ?? 0), 0);
  const totalStaked = decided.reduce((sum, b) => sum + b.data.stake, 0);
  const winRate = decided.length > 0 ? wins.length / decided.length : null;
  const roi = totalStaked > 0 ? bankroll / totalStaked : null;

  const bySettled = [...decided].filter((b) => b.data.settledAt).sort((a, b) => a.data.settledAt!.localeCompare(b.data.settledAt!));
  let running = 0;
  const bankrollPoints: BankrollPoint[] = bySettled.map((b) => {
    running += b.data.pnl ?? 0;
    return { t: new Date(b.data.settledAt!).getTime() / 1000, cumulativePnl: running };
  });

  const byCompetition = segmentStats(decided, (b) => competitionByMatch.get(b.data.matchId) ?? "Unknown", (b) => b.data);
  const byEdgeBucket = sortByBucketOrder(segmentStats(decided, (b) => edgeBucketLabel(b.data.edgeAtBet), (b) => b.data));
  const byFavoriteUnderdog = segmentStats(decided, (b) => favoriteUnderdogLabel(b.data.priceAtBet), (b) => b.data);

  return (
    <div className="max-w-4xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">My Performance</h1>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">
        The user&apos;s own paper-bet ledger — separate from the wallet leaderboard. Flat stake, placed whenever a frozen confluence score&apos;s
        edge clears the configured threshold.
      </p>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Fake bankroll" animate={bankroll} format={(n) => `${n >= 0 ? "" : "-"}$${Math.abs(n).toFixed(2)}`} delta={decided.length > 0 ? `${decided.length} decided` : undefined} deltaGood={bankroll >= 0} />
        <StatTile label="Win rate" animate={winRate !== null ? winRate * 100 : 0} format={(n) => (winRate !== null ? `${n.toFixed(1)}%` : "—")} />
        <StatTile label="ROI" animate={roi !== null ? roi * 100 : 0} format={(n) => (roi !== null ? `${n.toFixed(1)}%` : "—")} deltaGood={roi !== null ? roi >= 0 : undefined} delta={roi !== null ? (roi >= 0 ? "profitable" : "down") : undefined} />
        <StatTile label="Pending / voided" value={`${pending.length} / ${voided.length}`} />
      </div>

      <FadeIn className="mt-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Bankroll over time</h2>
        <TrustGate n={decided.length} threshold={MIN_SETTLED_BETS_TO_TRUST}>
          <BankrollChart points={bankrollPoints} />
        </TrustGate>
      </FadeIn>

      {decided.length > 0 && (
        <FadeIn className="mt-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Breakdown</h2>
          <p className="mb-3 text-xs text-[var(--text-secondary)]">Same &quot;decided&quot; denominator as the numbers above.</p>
          <TrustGate n={decided.length} threshold={MIN_SETTLED_BETS_TO_TRUST}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <SegmentTable title="By competition" segments={byCompetition} />
              <SegmentTable title="By edge at bet" segments={byEdgeBucket} />
              <SegmentTable title="Favorite vs. underdog" segments={byFavoriteUnderdog} />
            </div>
          </TrustGate>
        </FadeIn>
      )}

      <div className="mt-8 mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Bet log</h2>
        {bets.length > 0 && (
          <a href="/performance/export" className="text-xs text-[var(--diverging-pos)] hover:underline">
            Export CSV
          </a>
        )}
      </div>
      {bets.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-6 text-sm text-[var(--text-muted)]">No paper bets placed yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th scope="col" className="px-4 py-3">Match</th>
                <th scope="col" className="px-4 py-3">Leg</th>
                <th scope="col" className="tabular px-4 py-3 text-right">Edge at bet</th>
                <th scope="col" className="tabular px-4 py-3 text-right">Stake</th>
                <th scope="col" className="px-4 py-3">Outcome</th>
                <th scope="col" className="tabular px-4 py-3 text-right">PnL</th>
              </tr>
            </thead>
            <tbody>
              {bets
                .sort((a, b) => b.data.placedAt.localeCompare(a.data.placedAt))
                .map((b) => (
                  <tr key={b.id} className="border-b border-[var(--border)] transition-colors last:border-0 hover:bg-[var(--page-plane)]">
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

function SegmentTable({ title, segments }: { title: string; segments: Segment[] }) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-[var(--text-secondary)]">{title}</div>
      <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
              <th scope="col" className="px-3 py-2">Segment</th>
              <th scope="col" className="tabular px-3 py-2 text-right">Bets</th>
              <th scope="col" className="tabular px-3 py-2 text-right">Win rate</th>
              <th scope="col" className="tabular px-3 py-2 text-right">ROI</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((s) => (
              <tr key={s.key} className="border-b border-[var(--border)] last:border-0">
                <td className="px-3 py-2 text-[var(--text-primary)]">{s.key}</td>
                <td className="tabular px-3 py-2 text-right text-[var(--text-secondary)]">{s.count}</td>
                <td className="tabular px-3 py-2 text-right text-[var(--text-primary)]">{pct(s.winRate)}</td>
                <td
                  className="tabular px-3 py-2 text-right font-medium"
                  style={{ color: s.roi === null ? "var(--text-muted)" : s.roi >= 0 ? "var(--status-good-text)" : "var(--status-critical)" }}
                >
                  {pct(s.roi)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ outcome }: { outcome: "win" | "loss" | "pending" | "void" }) {
  const color = outcome === "win" ? "var(--status-good)" : outcome === "loss" ? "var(--status-critical)" : "var(--text-muted)";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      {outcome}
    </span>
  );
}
