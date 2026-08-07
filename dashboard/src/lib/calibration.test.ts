import { calibrationBucketIndex, calibrationBucketLabel, computeCalibration } from "./calibration.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown, tolerance = 1e-9) {
  const ok = typeof expected === "number" && typeof actual === "number" ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK  " : "FAIL"} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

check("bucket index for 0.0", calibrationBucketIndex(0), 0);
check("bucket index for 0.45", calibrationBucketIndex(0.45), 4);
check("bucket index for exactly 1.0 clamps to last bucket", calibrationBucketIndex(1.0), 9);
check("bucket index for 0.99999", calibrationBucketIndex(0.99999), 9);
check("bucket label", calibrationBucketLabel(4), "40-50%");
check("bucket label first", calibrationBucketLabel(0), "0-10%");

// Perfectly calibrated: 10 predictions at ~0.7, 7 correct -> realized 0.7.
const perfectlyCalibrated = [
  ...Array.from({ length: 7 }, () => ({ probabilityEstimate: 0.72, correct: true })),
  ...Array.from({ length: 3 }, () => ({ probabilityEstimate: 0.72, correct: false })),
];
const result = computeCalibration(perfectlyCalibrated);
check("one bucket produced", result.length, 1);
check("bucket n", result[0].n, 10);
check("predicted mean", result[0].predictedMean, 0.72);
check("realized rate matches predicted (well-calibrated)", result[0].realizedRate, 0.7);

// Overconfident: predicts 90% but only right half the time.
const overconfident = [
  ...Array.from({ length: 5 }, () => ({ probabilityEstimate: 0.92, correct: true })),
  ...Array.from({ length: 5 }, () => ({ probabilityEstimate: 0.92, correct: false })),
];
const overResult = computeCalibration(overconfident);
check("overconfident: realized well below predicted", overResult[0].realizedRate < overResult[0].predictedMean, true);

// Multiple buckets, sorted low to high.
const spread = [
  { probabilityEstimate: 0.15, correct: true },
  { probabilityEstimate: 0.85, correct: true },
  { probabilityEstimate: 0.45, correct: false },
];
const spreadResult = computeCalibration(spread);
check("multiple buckets sorted ascending", spreadResult.map((b) => b.label), ["10-20%", "40-50%", "80-90%"]);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
