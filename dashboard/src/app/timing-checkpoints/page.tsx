import StatTile from "@/components/StatTile";
import BarChart, { type BarDatum } from "@/components/BarChart";
import TrustGate from "@/components/TrustGate";
import FilterBar from "@/components/FilterBar";
import FadeIn from "@/components/FadeIn";
import { getMatches, getTimingCheckpointInputs } from "@/lib/data";
import { TIMING_BUCKETS, timingBucketLabel, segmentStats, sortByTimingBucketOrder } from "@/lib/breakdown";
import { parseFilters, isMatchInDateRange } from "@/lib/filters";
import { MIN_SETTLED_BETS_TO_TRUST } from "@/lib/types";

export const dynamic = "force-dynamic";

// PROJECT.md's adaptive polling schedule exists partly to make this
// question answerable: is a bet based on a score frozen an hour out
// better or worse than one frozen 30 seconds before kickoff?
export default async function TimingCheckpointsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = parseFilters(await searchParams);
  const [inputs, matches] = await Promise.all([getTimingCheckpointInputs(), getMatches()]);
  const matchById = new Map(matches.map((m) => [m.id, m.data]));

  const filtered = inputs.filter((i) => {
    const match = matchById.get(i.matchId);
    if (!match) return false;
    if (filters.competition && match.competition !== filters.competition) return false;
    if (!isMatchInDateRange(match.kickoffTime, filters)) return false;
    return true;
  });

  const winRateSegments = segmentStats(filtered, (i) => timingBucketLabel(i.minutesBeforeKickoff), (i) => i);
  const winRateBars: BarDatum[] = TIMING_BUCKETS.map((b) => {
    const seg = winRateSegments.find((s) => s.key === b.label);
    return { label: b.label, value: ((seg?.winRate ?? 0.5) - 0.5) * 100, n: seg?.count ?? 0 };
  }).filter((b) => b.n > 0);

  const roiSegments = sortByTimingBucketOrder(segmentStats(filtered, (i) => timingBucketLabel(i.minutesBeforeKickoff), (i) => i));

  return (
    <div className="max-w-4xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">Timing checkpoints</h1>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">
        Performance by how long before kickoff the underlying confluence score was frozen — finding the best entry timing empirically instead of
        guessing.
      </p>

      <FilterBar fields={["competition", "dateRange"]} />

      <StatTile label="Decided bets" animate={filtered.length} format="integer" />

      <TrustGate n={filtered.length} threshold={MIN_SETTLED_BETS_TO_TRUST}>
        <FadeIn className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Edge over average win rate, by timing</h2>
          <BarChart data={winRateBars} baseline={0} formatMode="signedPp1" />
        </FadeIn>

        <FadeIn index={1} className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Detail by checkpoint</h2>
          <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                  <th scope="col" className="px-4 py-3">Checkpoint</th>
                  <th scope="col" className="tabular px-4 py-3 text-right">Bets</th>
                  <th scope="col" className="tabular px-4 py-3 text-right">Win rate</th>
                  <th scope="col" className="tabular px-4 py-3 text-right">ROI</th>
                </tr>
              </thead>
              <tbody>
                {roiSegments.map((s) => (
                  <tr key={s.key} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-4 py-2 text-[var(--text-primary)]">{s.key}</td>
                    <td className="tabular px-4 py-2 text-right text-[var(--text-secondary)]">{s.count}</td>
                    <td className="tabular px-4 py-2 text-right text-[var(--text-primary)]">{s.winRate !== null ? `${(s.winRate * 100).toFixed(1)}%` : "—"}</td>
                    <td
                      className="tabular px-4 py-2 text-right font-medium"
                      style={{ color: s.roi === null ? "var(--text-muted)" : s.roi >= 0 ? "var(--status-good-text)" : "var(--status-critical)" }}
                    >
                      {s.roi !== null ? `${(s.roi * 100).toFixed(1)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </FadeIn>
      </TrustGate>
    </div>
  );
}
