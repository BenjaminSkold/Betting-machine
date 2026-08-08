import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getMatch, getMatchScores, getMatchTrades } from "@/lib/data";
import PriceHistoryChart, { type PricePoint } from "@/components/PriceHistoryChart";
import EdgeBadge from "@/components/EdgeBadge";
import FadeIn from "@/components/FadeIn";
import ManualBetForm from "@/components/ManualBetForm";
import type { Leg } from "@/lib/types";
import { isValidMatchId } from "@/lib/validate";

export const dynamic = "force-dynamic";

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

const ACTIVITY_FEED_LIMIT = 50;

export default async function MatchDetailPage({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  if (!isValidMatchId(matchId)) notFound();
  const match = await getMatch(matchId);
  if (!match) notFound();

  const [scores, trades] = await Promise.all([getMatchScores(matchId), getMatchTrades(matchId)]);
  const sortedScores = [...scores].sort((a, b) => b.data.minutesBeforeKickoff - a.data.minutesBeforeKickoff);
  const latestScoreEntry = [...scores].sort((a, b) => a.data.minutesBeforeKickoff - b.data.minutesBeforeKickoff)[0];
  const latestScore = latestScoreEntry?.data;

  const ids = match.data.marketConditionIds;
  const home = legSeries(trades, ids?.home);
  const draw = legSeries(trades, ids?.draw);
  const away = legSeries(trades, ids?.away);

  const legByCondition = new Map<string, Leg>();
  if (ids?.home) legByCondition.set(ids.home, "home");
  if (ids?.draw) legByCondition.set(ids.draw, "draw");
  if (ids?.away) legByCondition.set(ids.away, "away");
  const recentTrades = [...trades].sort((a, b) => b.timestamp - a.timestamp).slice(0, ACTIVITY_FEED_LIMIT);
  const legLabel: Record<Leg, string> = { home: match.data.homeTeam, draw: "Draw", away: match.data.awayTeam };

  return (
    <div className="max-w-4xl">
      <Link href="/matches" className="inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        <ArrowLeft size={14} /> Matches
      </Link>

      <div className="mt-3 mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{match.data.competition}</div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)]">
            {match.data.homeTeam} <span className="text-[var(--text-muted)]">vs.</span> {match.data.awayTeam}
          </h1>
          <div className="text-sm text-[var(--text-secondary)]">
            {new Date(match.data.kickoffTime).toLocaleString()}
            {match.data.resolved && match.data.result && ` · Result: ${legLabel[match.data.result]}`}
          </div>
        </div>
        {latestScore && <EdgeBadge score={latestScore} />}
      </div>

      <FadeIn>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Price history</h2>
        <PriceHistoryChart home={home} draw={draw} away={away} homeLabel={match.data.homeTeam} awayLabel={match.data.awayTeam} />
      </FadeIn>

      <h2 className="mt-8 mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Confluence scores</h2>
      {sortedScores.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-6 text-sm text-[var(--text-muted)]">
          No confluence score frozen for this match yet — scores are computed per snapshot once watchlisted wallets exist.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {sortedScores.map((s, i) => (
            <FadeIn key={s.id} index={i}>
              <ScoreCard
                score={s.data}
                legLabel={legLabel}
                // Betting is only offered against the CURRENT checkpoint --
                // every earlier one reflects a market price that's since
                // moved, so acting on it now wouldn't get that price anyway.
                canBet={!match.data.resolved && s.id === latestScoreEntry?.id}
                scoreId={s.id}
              />
            </FadeIn>
          ))}
        </div>
      )}

      <h2 className="mt-8 mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Wallet activity</h2>
      {recentTrades.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-6 text-sm text-[var(--text-muted)]">No trades logged yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
          {trades.length > ACTIVITY_FEED_LIMIT && (
            <div className="border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--text-muted)]">
              Showing the most recent {ACTIVITY_FEED_LIMIT} of {trades.length} trades.
            </div>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th scope="col" className="px-4 py-2.5">Wallet</th>
                <th scope="col" className="px-4 py-2.5">Leg</th>
                <th scope="col" className="px-4 py-2.5">Side</th>
                <th scope="col" className="tabular px-4 py-2.5 text-right">Size</th>
                <th scope="col" className="tabular px-4 py-2.5 text-right">Price</th>
                <th scope="col" className="tabular px-4 py-2.5 text-right">When</th>
              </tr>
            </thead>
            <tbody>
              {recentTrades.map((t, i) => (
                <tr key={i} className="border-b border-[var(--border)] text-[var(--text-secondary)] last:border-0 hover:bg-[var(--page-plane)]">
                  <td className="px-4 py-2">
                    <Link href={`/wallets/${t.wallet}`} className="font-mono text-xs text-[var(--diverging-pos)] hover:underline">
                      {t.wallet.slice(0, 10)}…
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-xs">{legLabel[legByCondition.get(t.conditionId) ?? "draw"]}</td>
                  <td className="px-4 py-2 text-xs">
                    {t.side} {t.outcome}
                  </td>
                  <td className="tabular px-4 py-2 text-right text-xs text-[var(--text-primary)]">${t.size.toFixed(0)}</td>
                  <td className="tabular px-4 py-2 text-right text-xs text-[var(--text-primary)]">{(t.price * 100).toFixed(1)}%</td>
                  <td className="tabular px-4 py-2 text-right text-xs">{new Date(t.timestamp * 1000).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ScoreCard({
  score,
  legLabel,
  canBet = false,
  scoreId,
}: {
  score: Awaited<ReturnType<typeof getMatchScores>>[number]["data"];
  legLabel: Record<Leg, string>;
  canBet?: boolean;
  scoreId: string;
}) {
  const legEdges: Record<Leg, number | null> = {
    home: score.breakdown.home.edge,
    draw: score.breakdown.draw.edge,
    away: score.breakdown.away.edge,
  };
  const legPrices: Record<Leg, number | null> = {
    home: score.breakdown.home.marketImpliedProbability,
    draw: score.breakdown.draw.marketImpliedProbability,
    away: score.breakdown.away.marketImpliedProbability,
  };
  // Polymarket shares always resolve to exactly $1 -- buying at `price`
  // returns 1/price for every $1 staked if it wins, nothing if it doesn't.
  function payoutMultiplier(price: number | null): string {
    return price !== null && price > 0 ? `${(1 / price).toFixed(2)}x` : "—";
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-1">
        <div className="text-sm font-medium text-[var(--text-primary)]">{score.minutesBeforeKickoff.toFixed(0)} min before kickoff</div>
        <div className="text-xs text-[var(--text-muted)]">frozen {new Date(score.frozenAt).toLocaleString()}</div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(["home", "draw", "away"] as Leg[]).map((leg) => {
          const b = score.breakdown[leg];
          const tracked = leg === score.trackedLeg;
          return (
            <div
              key={leg}
              className="rounded-md p-3 transition-colors"
              style={{ background: tracked ? "var(--page-plane)" : "transparent", border: tracked ? "1px solid var(--baseline)" : "1px solid transparent" }}
            >
              <div className="text-xs font-medium text-[var(--text-secondary)]">{legLabel[leg]}</div>
              <div className="tabular text-lg font-semibold" style={{ color: (b.edge ?? 0) >= 0 ? "var(--diverging-pos)" : "var(--diverging-neg)" }}>
                {b.edge !== null ? `${b.edge >= 0 ? "+" : ""}${(b.edge * 100).toFixed(1)}pp` : "—"}
              </div>
              <div className="text-xs text-[var(--text-muted)]">
                {pct(b.probabilityEstimate)} vs fair {pct(b.marketFairProbability)}
              </div>
              <div className="text-xs text-[var(--text-muted)]">
                pays <span className="font-medium text-[var(--text-secondary)]">{payoutMultiplier(b.marketImpliedProbability)}</span> at the current price ({pct(b.marketImpliedProbability)})
              </div>
              <div className="text-xs text-[var(--text-muted)]">
                {b.watchlistedTradeCount} watchlisted trade(s), ${b.watchlistedVolume.toFixed(0)} vol
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        *pp = percentage points, a plain difference between two percentages (60% → 65% is +5pp) — not a percent change. &quot;Fair&quot; probability
        de-vigs the market&apos;s three raw prices (home/draw/away each trade as their own market, so they don&apos;t need to sum to 100% — the
        excess is the market&apos;s built-in edge, not a real 4th outcome) before comparing against our estimate, so a heavy favorite&apos;s raw
        price isn&apos;t mistaken for a real edge.
      </p>

      {canBet && <ManualBetForm scoreId={scoreId} legLabel={legLabel} legEdges={legEdges} legPrices={legPrices} defaultLeg={score.trackedLeg} />}

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
