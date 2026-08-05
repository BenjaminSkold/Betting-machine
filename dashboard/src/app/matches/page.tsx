import Link from "next/link";
import { getMatches, getSystemStatus } from "@/lib/data";
import type { ConfluenceScore } from "@/lib/types";
import { listCollection } from "@/lib/firestore";

function formatKickoff(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function pct(x: number | null | undefined): string {
  if (x === null || x === undefined) return "—";
  return `${(x * 100).toFixed(1)}%`;
}

export default async function MatchesPage() {
  const [matches, scores, status] = await Promise.all([
    getMatches(),
    listCollection<ConfluenceScore>("confluenceScores"),
    getSystemStatus(),
  ]);

  const scoresByMatch = new Map<string, ConfluenceScore[]>();
  for (const s of scores) {
    const list = scoresByMatch.get(s.data.matchId) ?? [];
    list.push(s.data);
    scoresByMatch.set(s.data.matchId, list);
  }
  const latestScoreFor = (matchId: string) => {
    const list = scoresByMatch.get(matchId);
    if (!list || list.length === 0) return null;
    return [...list].sort((a, b) => a.minutesBeforeKickoff - b.minutesBeforeKickoff)[0];
  };

  const upcoming = matches.filter((m) => !m.data.resolved).sort((a, b) => a.data.kickoffTime.localeCompare(b.data.kickoffTime));
  const recent = matches
    .filter((m) => m.data.resolved)
    .sort((a, b) => b.data.kickoffTime.localeCompare(a.data.kickoffTime))
    .slice(0, 30);

  // This is a Server Component: it runs once per request with no re-render
  // to stay consistent across, so "now" is meant to be wall-clock-fresh on
  // every load — the purity rule targets client re-render stability, which
  // doesn't apply here.
  // eslint-disable-next-line react-hooks/purity
  const isStale = status?.lastSuccessfulRun ? Date.now() - new Date(status.lastSuccessfulRun).getTime() > 30 * 60 * 1000 : true;

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Matches</h1>
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: status?.lastSuccessfulRun ? (isStale ? "var(--status-warning)" : "var(--status-good)") : "var(--status-critical)" }}
          />
          {status?.lastSuccessfulRun ? `Last collected ${new Date(status.lastSuccessfulRun).toLocaleString()}` : "No collection run yet"}
        </div>
      </div>

      <Section title="Upcoming" matches={upcoming} latestScoreFor={latestScoreFor} emptyText="No upcoming matches tracked yet." />
      <Section title="Recent" matches={recent} latestScoreFor={latestScoreFor} emptyText="No resolved matches yet." />
    </div>
  );
}

function Section({
  title,
  matches,
  latestScoreFor,
  emptyText,
}: {
  title: string;
  matches: Awaited<ReturnType<typeof getMatches>>;
  latestScoreFor: (id: string) => ConfluenceScore | null;
  emptyText: string;
}) {
  return (
    <div className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">{title}</h2>
      {matches.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-6 text-sm text-[var(--text-muted)]">{emptyText}</div>
      ) : (
        <div className="flex flex-col gap-2">
          {matches.map((m) => {
            const score = latestScoreFor(m.id);
            return (
              <Link
                key={m.id}
                href={`/matches/${m.id}`}
                className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 hover:border-[var(--baseline)]"
              >
                <div>
                  <div className="text-xs font-medium text-[var(--text-muted)]">{m.data.competition}</div>
                  <div className="font-medium text-[var(--text-primary)]">
                    {m.data.homeTeam} vs. {m.data.awayTeam}
                  </div>
                  <div className="text-xs text-[var(--text-secondary)]">{formatKickoff(m.data.kickoffTime)}</div>
                </div>
                <div className="text-right">
                  {score ? (
                    <>
                      <div
                        className="tabular text-xl font-semibold"
                        style={{ color: score.edge >= 0 ? "var(--diverging-pos)" : "var(--diverging-neg)" }}
                      >
                        {score.edge >= 0 ? "+" : ""}
                        {(score.edge * 100).toFixed(1)}pp
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">
                        {score.trackedLeg} · {pct(score.probabilityEstimate)} vs {pct(score.marketImpliedProbability)}
                      </div>
                    </>
                  ) : (
                    <div className="text-sm text-[var(--text-muted)]">No score yet</div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
