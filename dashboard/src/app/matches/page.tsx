import Link from "next/link";
import { getAllConfluenceScores, getMatches, getSystemStatus } from "@/lib/data";
import type { ConfluenceScore } from "@/lib/types";
import { freshnessAge } from "@/lib/time";
import { parseFilters, isMatchInDateRange } from "@/lib/filters";
import FilterBar from "@/components/FilterBar";
import FadeIn from "@/components/FadeIn";
import EdgeBadge from "@/components/EdgeBadge";

export const dynamic = "force-dynamic";

function formatKickoff(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default async function MatchesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const rawParams = await searchParams;
  const filters = parseFilters(rawParams);
  const [allMatches, scores, status] = await Promise.all([getMatches(), getAllConfluenceScores(), getSystemStatus()]);

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

  const teamQuery = filters.team?.toLowerCase().trim();
  const edgeMin = filters.edgeMin ? Number(filters.edgeMin) : null;
  const matches = allMatches.filter((m) => {
    if (filters.competition && m.data.competition !== filters.competition) return false;
    if (teamQuery && !`${m.data.homeTeam} ${m.data.awayTeam}`.toLowerCase().includes(teamQuery)) return false;
    if (!isMatchInDateRange(m.data.kickoffTime, filters)) return false;
    if (edgeMin !== null) {
      const score = latestScoreFor(m.id);
      if (!score || Math.abs(score.edge) < edgeMin / 100) return false;
    }
    return true;
  });

  const upcoming = matches.filter((m) => !m.data.resolved).sort((a, b) => a.data.kickoffTime.localeCompare(b.data.kickoffTime));
  const recent = matches
    .filter((m) => m.data.resolved)
    .sort((a, b) => b.data.kickoffTime.localeCompare(a.data.kickoffTime))
    .slice(0, 30);

  const isStale = status?.lastSuccessfulRun ? freshnessAge(status.lastSuccessfulRun) > 30 * 60 * 1000 : true;

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)]">Matches</h1>
          <p className="text-sm text-[var(--text-secondary)]">Confluence score and edge, live as the market moves.</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: status?.lastSuccessfulRun ? (isStale ? "var(--status-warning)" : "var(--status-good)") : "var(--status-critical)" }}
          />
          {status?.lastSuccessfulRun ? `Last collected ${new Date(status.lastSuccessfulRun).toLocaleString()}` : "No collection run yet"}
        </div>
      </div>

      <FilterBar fields={["competition", "dateRange", "team", "edgeMin"]} />

      <Section title="Upcoming" matches={upcoming} latestScoreFor={latestScoreFor} emptyText="No upcoming matches match these filters." />
      <Section title="Recent" matches={recent} latestScoreFor={latestScoreFor} emptyText="No resolved matches match these filters." />
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
          {matches.map((m, i) => {
            const score = latestScoreFor(m.id);
            return (
              <FadeIn key={m.id} index={i}>
                <Link
                  href={`/matches/${m.id}`}
                  className="group flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all duration-150 hover:-translate-y-0.5 hover:border-[var(--baseline)] hover:shadow-[0_4px_16px_rgba(0,0,0,0.08)]"
                >
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{m.data.competition}</div>
                    <div className="font-medium text-[var(--text-primary)]">
                      {m.data.homeTeam} <span className="text-[var(--text-muted)]">vs.</span> {m.data.awayTeam}
                    </div>
                    <div className="text-xs text-[var(--text-secondary)]">{formatKickoff(m.data.kickoffTime)}</div>
                  </div>
                  <div className="shrink-0">{score ? <EdgeBadge score={score} /> : <div className="text-sm text-[var(--text-muted)]">No score yet</div>}</div>
                </Link>
              </FadeIn>
            );
          })}
        </div>
      )}
    </div>
  );
}
