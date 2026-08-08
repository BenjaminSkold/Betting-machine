import StatTile from "@/components/StatTile";
import BarChart, { type BarDatum } from "@/components/BarChart";
import TrustGate from "@/components/TrustGate";
import FilterBar from "@/components/FilterBar";
import FadeIn from "@/components/FadeIn";
import { getMatches, getPaperBets } from "@/lib/data";
import { EDGE_BUCKETS, edgeBucketLabel, favoriteUnderdogLabel, segmentStats, sortByBucketOrder } from "@/lib/breakdown";
import { parseFilters, isMatchInDateRange } from "@/lib/filters";
import { MIN_SETTLED_BETS_TO_TRUST } from "@/lib/types";

export const dynamic = "force-dynamic";

// PROJECT.md's open question, directly: does paper profit concentrate in
// rare, big-edge underdog calls, or frequent near-consensus bets? This
// view exists specifically to answer that empirically rather than assume
// either way.
export default async function EdgeSegmentationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = parseFilters(await searchParams);
  const [bets, matches] = await Promise.all([getPaperBets(), getMatches()]);
  const matchById = new Map(matches.map((m) => [m.id, m.data]));

  const decided = bets.filter((b) => {
    if (b.data.outcome !== "win" && b.data.outcome !== "loss") return false;
    const match = matchById.get(b.data.matchId);
    if (!match) return false;
    if (filters.competition && match.competition !== filters.competition) return false;
    if (!isMatchInDateRange(match.kickoffTime, filters)) return false;
    return true;
  });

  const totalProfit = decided.reduce((s, b) => s + (b.data.pnl ?? 0), 0);

  const byEdge = sortByBucketOrder(segmentStats(decided, (b) => edgeBucketLabel(b.data.edgeAtBet), (b) => b.data));
  const edgeProfitBars: BarDatum[] = EDGE_BUCKETS.map((eb) => {
    const seg = byEdge.find((s) => s.key === eb.label);
    const rows = decided.filter((b) => edgeBucketLabel(b.data.edgeAtBet) === eb.label);
    return { label: eb.label, value: rows.reduce((s, b) => s + (b.data.pnl ?? 0), 0), n: seg?.count ?? 0 };
  });

  const byFavUnderdog = segmentStats(decided, (b) => favoriteUnderdogLabel(b.data.priceAtBet), (b) => b.data);
  const favUnderdogBars: BarDatum[] = ["Favorite", "Underdog"].map((label) => {
    const rows = decided.filter((b) => favoriteUnderdogLabel(b.data.priceAtBet) === label);
    const seg = byFavUnderdog.find((s) => s.key === label);
    return { label, value: rows.reduce((s, b) => s + (b.data.pnl ?? 0), 0), n: seg?.count ?? 0 };
  });

  return (
    <div className="max-w-4xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">Edge segmentation</h1>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">Profit broken down by edge size and by favorite-vs-underdog — where does the paper profit actually come from?</p>

      <FilterBar fields={["competition", "dateRange"]} />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatTile label="Decided bets" animate={decided.length} format="integer" />
        <StatTile label="Total PnL" animate={totalProfit} format="signedMoney2" deltaGood={totalProfit >= 0} />
      </div>

      <TrustGate n={decided.length} threshold={MIN_SETTLED_BETS_TO_TRUST}>
        <FadeIn>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Profit by edge size</h2>
          <BarChart data={edgeProfitBars} baseline={0} formatMode="signedMoney0" />
        </FadeIn>

        <FadeIn index={1} className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Favorite vs. underdog</h2>
          <BarChart data={favUnderdogBars} baseline={0} formatMode="signedMoney0" />
        </FadeIn>
      </TrustGate>
    </div>
  );
}
