// Calibration/reliability math -- PROJECT.md's "does this even work" chart.
// For every resolved match's frozen confluence score, was the tracked leg's
// probabilityEstimate actually realized? A well-calibrated system's 70%
// calls should come true about 70% of the time -- this buckets predictions
// by confidence and compares against the realized rate, per bucket.

export interface CalibrationInput {
  probabilityEstimate: number; // 0..1, the tracked leg's estimate
  correct: boolean; // did the tracked leg actually win
}

export interface CalibrationBucket {
  label: string; // "40-50%"
  bucketMid: number; // 0.45 -- where "perfectly calibrated" would sit on the realized axis
  n: number;
  predictedMean: number;
  realizedRate: number;
}

const BUCKET_WIDTH = 0.1;

export function calibrationBucketIndex(p: number): number {
  return Math.min(9, Math.max(0, Math.floor(p / BUCKET_WIDTH)));
}

export function calibrationBucketLabel(index: number): string {
  return `${Math.round(index * BUCKET_WIDTH * 100)}-${Math.round((index + 1) * BUCKET_WIDTH * 100)}%`;
}

// Only buckets with at least one point are returned -- an empty bucket has
// no meaningful "realized rate" to plot, and a caller can still tell it's
// missing from a 10-bucket x-axis.
export function computeCalibration(points: CalibrationInput[]): CalibrationBucket[] {
  const buckets = new Map<number, { n: number; predictedSum: number; correct: number }>();
  for (const p of points) {
    const idx = calibrationBucketIndex(p.probabilityEstimate);
    const b = buckets.get(idx) ?? { n: 0, predictedSum: 0, correct: 0 };
    b.n += 1;
    b.predictedSum += p.probabilityEstimate;
    if (p.correct) b.correct += 1;
    buckets.set(idx, b);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([idx, b]) => ({
      label: calibrationBucketLabel(idx),
      bucketMid: idx * BUCKET_WIDTH + BUCKET_WIDTH / 2,
      n: b.n,
      predictedMean: b.predictedSum / b.n,
      realizedRate: b.correct / b.n,
    }));
}
