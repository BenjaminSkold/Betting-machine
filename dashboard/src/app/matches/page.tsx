import Link from "next/link";
import { getAllConfluenceScores, getMatches, getSystemStatus } from "@/lib/data";
import type { Competition, ConfluenceScore } from "@/lib/types";
import { freshnessAge } from "@/lib/time";

function formatKickoff(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function pct(x: number | null | undefined): string {
  if (x === null || x === undefined) return "—";
  return `${(x * 100).toFixed(1)}%`;
}

const COMPETITIONS: Competition[] = ["EPL", "UCL", "UEL", "UECL"];

export default async function MatchesPage({ searchParams }: { searchParams: Promise<{ competition?: string; q?: string }> }) {
  const params = await searchParams;
  const [allMatches, scores, status] = await Promise.all([getMatches(), getAllConfluenceScores(), getSystemStatus()]);

  const q = params.q?.toLowerCase().trim();
  const matches = allMatches.filter((m) => {
    if (params.competition && m.data.competition !== params.competition) return false;
    if (q && !`${m.data.homeTeam} ${m.data.awayTeam}`.toLowerCase().includes(q)) return false;
    return true;
  });

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

  const isStale = status?.lastSuccessfulRun ? freshnessAge(status.lastSuccessfulRun) > 30 * 60 * 1000 : true;

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Matches</h1>
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: status?.lastSuccessfulRun ? (isStale ? "var(--status-warning)" : "var(--status-good)") : "var(--status-critical)" }}
          />
          {status?.lastSuccessfulRun ? `Last collected ${new Date(status.lastSuccessfulRun).toLocaleString()}` : "No collection run yet"}
        </div>
      </div>

      <form role="search" aria-label="Filter matches" className="mb-6 flex flex-wrap gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3">
        <label htmlFor="match-search" className="sr-only">
          Search team name
        </label>
        <input
          id="match-search"
          type="text"
          name="q"
          defaultValue={params.q}
          placeholder="Search team name"
          className="flex-1 min-w-[220px] rounded-md border border-[var(--border)] bg-[var(--page-plane)] px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
        />
        <label htmlFor="match-competition" className="sr-only">
          Filter by competition
        </label>
        <select
          id="match-competition"
          name="competition"
          defaultValue={params.competition ?? ""}
          className="rounded-md border border-[var(--border)] bg-[var(--page-plane)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
        >
          <option value="">All competitions</option>
          {COMPETITIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded-md px-4 py-1.5 text-sm font-medium" style={{ background: "var(--diverging-pos)", color: "white" }}>
          Filter
        </button>
      </form>

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
                className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 hover:border-[var(--baseline)]"
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium text-[var(--text-muted)]">{m.data.competition}</div>
                  <div className="font-medium text-[var(--text-primary)]">
                    {m.data.homeTeam} vs. {m.data.awayTeam}
                  </div>
                  <div className="text-xs text-[var(--text-secondary)]">{formatKickoff(m.data.kickoffTime)}</div>
                </div>
                <div className="shrink-0 text-right">
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
