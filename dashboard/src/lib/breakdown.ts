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
