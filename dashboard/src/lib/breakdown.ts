// Shared bet-segmentation math for the Performance page's "Breakdown"
// section. Pulled out of the page component so the aggregation logic gets
// its own test, same as csv.ts/validate.ts.

export interface SegmentInput {
  outcome: string;
  pnl: number | null;
  stake: number;
}

export interface Segment {
  key: string;
  count: number;
  winRate: number | null;
  roi: number | null;
}

// Segments a list of decided bets by a caller-supplied key, computing win
// rate and ROI per segment. Callers pass in only "decided" (win/loss) bets
// so a segment can never look better than the page's headline numbers by
// quietly counting pending or voided bets in its denominator.
export function segmentStats<T>(items: T[], keyOf: (item: T) => string, betOf: (item: T) => SegmentInput): Segment[] {
  const byKey = new Map<string, { count: number; wins: number; pnl: number; staked: number }>();
  for (const item of items) {
    const key = keyOf(item);
    const bet = betOf(item);
    const s = byKey.get(key) ?? { count: 0, wins: 0, pnl: 0, staked: 0 };
    s.count += 1;
    if (bet.outcome === "win") s.wins += 1;
    s.pnl += bet.pnl ?? 0;
    s.staked += bet.stake;
    byKey.set(key, s);
  }
  return [...byKey.entries()]
    .map(([key, s]) => ({
      key,
      count: s.count,
      winRate: s.count > 0 ? s.wins / s.count : null,
      roi: s.staked > 0 ? s.pnl / s.staked : null,
    }))
    .sort((a, b) => b.count - a.count);
}

// Ordered low-to-high; edgeBucketLabel finds the first bucket whose [min,
// max) contains the edge. Bounds start at 0.05 to match paperBets.js's
// default EDGE_THRESHOLD — bets below that threshold are never placed, so
// there's no "0-5pp" bucket to bin them into.
export const EDGE_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "5–10pp", min: 0.05, max: 0.1 },
  { label: "10–15pp", min: 0.1, max: 0.15 },
  { label: "15–25pp", min: 0.15, max: 0.25 },
  { label: "25pp+", min: 0.25, max: Infinity },
];

export function edgeBucketLabel(edge: number): string {
  return EDGE_BUCKETS.find((b) => edge >= b.min && edge < b.max)?.label ?? EDGE_BUCKETS[0].label;
}

// Sorts segments produced from edgeBucketLabel() back into bucket order
// (segmentStats itself sorts by count, which scrambles the natural
// low-to-high edge progression a reader expects).
export function sortByBucketOrder(segments: Segment[]): Segment[] {
  return [...segments].sort(
    (a, b) => EDGE_BUCKETS.findIndex((e) => e.label === a.key) - EDGE_BUCKETS.findIndex((e) => e.label === b.key)
  );
}

// PROJECT.md lists this as an explicit open question: "whether underdog-
// favoring edge or roughly-agrees-with-the-market edge is where the actual
// paper profit comes from" — segment paper-bet profit by favorite-vs-
// underdog and report back honestly, whichever way it points. A bet only
// ever gets placed on the leg paperBets.js's decideBet already picked (the
// one with positive edge clearing the threshold), so priceAtBet IS that
// leg's own market-implied probability at bet time — no extra data or
// join back to the full ConfluenceScore needed. In a 3-way market, >50% on
// one leg is a strictly stronger claim than "plurality favorite" (the other
// two legs must combine to under 50%), so this threshold doesn't need the
// other two legs' prices to be a meaningful, hand-checkable favorite/dog
// split.
export function favoriteUnderdogLabel(priceAtBet: number): string {
  return priceAtBet > 0.5 ? "Favorite" : "Underdog";
}

// Timing-checkpoint segmentation: which pre-kickoff moment a bet's
// underlying confluence score was frozen at. The adaptive polling schedule
// (see PROJECT.md) produces a near-continuous range of minutesBeforeKickoff
// values now, not a fixed 60/15/10 set, so this buckets into the same
// ramp the schedule itself uses -- the empirical question ("what's the
// best entry timing") only makes sense sliced the same way polling
// actually ramps up.
export const TIMING_BUCKETS: { label: string; max: number }[] = [
  { label: "Live (post-kickoff)", max: 0 },
  { label: "0–15 min", max: 15 },
  { label: "15–60 min", max: 60 },
  { label: "1–4 hr", max: 240 },
  { label: "4–24 hr", max: 1440 },
  { label: "1+ day", max: Infinity },
];

export function timingBucketLabel(minutesBeforeKickoff: number): string {
  if (minutesBeforeKickoff <= 0) return TIMING_BUCKETS[0].label;
  return TIMING_BUCKETS.find((b) => minutesBeforeKickoff <= b.max)?.label ?? TIMING_BUCKETS[TIMING_BUCKETS.length - 1].label;
}

export function sortByTimingBucketOrder(segments: Segment[]): Segment[] {
  return [...segments].sort((a, b) => TIMING_BUCKETS.findIndex((t) => t.label === a.key) - TIMING_BUCKETS.findIndex((t) => t.label === b.key));
}
