import Link from "next/link";
import { notFound } from "next/navigation";
import { getMatch, getMatchScores, getMatchTrades } from "@/lib/data";
import PriceHistoryChart, { type PricePoint } from "@/components/PriceHistoryChart";
import type { Leg } from "@/lib/types";
import { isValidMatchId } from "@/lib/validate";

function pct(x: number | null | undefined): string {
  if (x === null || x === undefined) return "—";
  return `${(x * 100).toFixed(1)}%`;
}

function legSeries(trades: Awaited<ReturnType<typeof getMatchTrades>>, conditionId: string | undefined): PricePoint[] {
  if (!conditionId) return [];
  return trades
    .filter((t) => t.conditionId === conditionId)
    .map((t) => ({ t: t.timestamp, p: t.outcome === "Yes" ? t.price : 1 - t.price }))
    .sort((a, b) => a.t - b.t);
}

export async function generateMetadata({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  if (!isValidMatchId(matchId)) return { title: "Match not found" };
  const match = await getMatch(matchId);
  return { title: match ? `${match.data.homeTeam} vs. ${match.data.awayTeam}` : "Match not found" };
}

export default async function MatchDetailPage({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  if (!isValidMatchId(matchId)) notFound();
  const match = await getMatch(matchId);
  if (!match) notFound();

  const [scores, trades] = await Promise.all([getMatchScores(matchId), getMatchTrades(matchId)]);
  const sortedScores = [...scores].sort((a, b) => b.data.minutesBeforeKickoff - a.data.minutesBeforeKickoff);

  const ids = match.data.marketConditionIds;
  const home = legSeries(trades, ids?.home);
  const draw = legSeries(trades, ids?.draw);
  const away = legSeries(trades, ids?.away);

  return (
    <div className="max-w-4xl">
      <Link href="/matches" className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        ← Matches
      </Link>

      <div className="mt-2 mb-6">
        <div className="text-xs font-medium text-[var(--text-muted)]">{match.data.competition}</div>
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">
          {match.data.homeTeam} vs. {match.data.awayTeam}
        </h1>
        <div className="text-sm text-[var(--text-secondary)]">
          {new Date(match.data.kickoffTime).toLocaleString()}
          {match.data.resolved && match.data.result && ` · Result: ${match.data.result}`}
        </div>
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Price history</h2>
      <PriceHistoryChart home={home} draw={draw} away={away} homeLabel={match.data.homeTeam} awayLabel={match.data.awayTeam} />

      <h2 className="mt-8 mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Confluence scores</h2>
      {sortedScores.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-6 text-sm text-[var(--text-muted)]">
          No confluence score frozen for this match yet — scores are computed at the 60/15/10-minute checkpoints once watchlisted
          wallets exist.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {sortedScores.map((s) => (
            <ScoreCard key={s.id} score={s.data} homeTeam={match!.data.homeTeam} awayTeam={match!.data.awayTeam} />
          ))}
        </div>
      )}
    </div>
  );
}

function ScoreCard({
  score,
  homeTeam,
  awayTeam,
}: {
  score: Awaited<ReturnType<typeof getMatchScores>>[number]["data"];
  homeTeam: string;
  awayTeam: string;
}) {
  const legLabel: Record<Leg, string> = { home: homeTeam, draw: "Draw", away: awayTeam };
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-1">
        <div className="text-sm font-medium text-[var(--text-primary)]">{score.minutesBeforeKickoff} min before kickoff</div>
        <div className="text-xs text-[var(--text-muted)]">frozen {new Date(score.frozenAt).toLocaleString()}</div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(["home", "draw", "away"] as Leg[]).map((leg) => {
          const b = score.breakdown[leg];
          const tracked = leg === score.trackedLeg;
          return (
            <div
              key={leg}
              className="rounded-md p-3"
              style={{ background: tracked ? "var(--page-plane)" : "transparent", border: tracked ? "1px solid var(--baseline)" : "1px solid transparent" }}
            >
              <div className="text-xs font-medium text-[var(--text-secondary)]">{legLabel[leg]}</div>
              <div
                className="tabular text-lg font-semibold"
                style={{ color: (b.edge ?? 0) >= 0 ? "var(--diverging-pos)" : "var(--diverging-neg)" }}
              >
                {b.edge !== null ? `${b.edge >= 0 ? "+" : ""}${(b.edge * 100).toFixed(1)}pp` : "—"}
              </div>
              <div className="text-xs text-[var(--text-muted)]">
                {pct(b.probabilityEstimate)} vs mkt {pct(b.marketImpliedProbability)}
              </div>
              <div className="text-xs text-[var(--text-muted)]">
                {b.watchlistedTradeCount} watchlisted trade(s), ${b.watchlistedVolume.toFixed(0)} vol
              </div>
            </div>
          );
        })}
      </div>

      {/* full breakdown — never just a headline number */}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-[var(--text-secondary)]">Contributing wallets</summary>
        <div className="mt-2 flex flex-col gap-2 text-xs">
          {(["home", "draw", "away"] as Leg[]).map((leg) => {
            const wallets = score.breakdown[leg].contributingWallets;
            if (wallets.length === 0) return null;
            return (
              <div key={leg}>
                <div className="font-medium text-[var(--text-secondary)]">{legLabel[leg]}</div>
                <table className="w-full text-[var(--text-secondary)]">
                  <thead>
                    <tr>
                      <th scope="col" className="py-0.5 text-left font-medium">Wallet</th>
                      <th scope="col" className="py-0.5 text-left font-medium">Direction</th>
                      <th scope="col" className="py-0.5 text-left font-medium">Size</th>
                      <th scope="col" className="py-0.5 text-left font-medium">Win rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wallets.map((w, i) => (
                      <tr key={i}>
                        <td className="py-0.5 font-mono">{w.wallet.slice(0, 10)}…</td>
                        <td className="tabular py-0.5">{w.direction > 0 ? "for" : "against"}</td>
                        <td className="tabular py-0.5">${w.size.toFixed(0)}</td>
                        <td className="tabular py-0.5">winRate {(w.winRate * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}
