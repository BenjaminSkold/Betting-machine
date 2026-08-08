import StatTile from "@/components/StatTile";
import CalibrationChart from "@/components/CalibrationChart";
import TrustGate from "@/components/TrustGate";
import FadeIn from "@/components/FadeIn";
import { getCalibrationInputs } from "@/lib/data";
import { computeCalibration } from "@/lib/calibration";
import { MIN_SETTLED_BETS_TO_TRUST } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CalibrationPage() {
  const inputs = await getCalibrationInputs();
  const buckets = computeCalibration(inputs);
  const correct = inputs.filter((i) => i.correct).length;
  const overallRate = inputs.length > 0 ? correct / inputs.length : null;

  // Mean absolute calibration error, weighted by bucket size -- a single
  // number for "how far off are we, on average" alongside the chart.
  const totalN = buckets.reduce((s, b) => s + b.n, 0);
  const mace = totalN > 0 ? buckets.reduce((s, b) => s + Math.abs(b.predictedMean - b.realizedRate) * b.n, 0) / totalN : null;

  return (
    <div className="max-w-4xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">Calibration</h1>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">
        PROJECT.md&apos;s &quot;does this even work&quot; chart. When the system said 70%, did the tracked leg actually happen about 70% of
        the time? A point on the dashed diagonal is well-calibrated; above it means underconfident, below means overconfident.
      </p>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatTile label="Scored predictions" animate={inputs.length} format="integer" />
        {overallRate !== null ? (
          <StatTile label="Overall realized rate" animate={overallRate * 100} format="percent1" />
        ) : (
          <StatTile label="Overall realized rate" value="—" />
        )}
        {mace !== null ? (
          <StatTile
            label="Mean calibration error"
            animate={mace * 100}
            format="pp1"
            deltaGood={mace < 0.1}
            delta={mace < 0.1 ? "reasonably calibrated" : "notably off"}
          />
        ) : (
          <StatTile label="Mean calibration error" value="—" />
        )}
      </div>

      <FadeIn>
        <TrustGate n={inputs.length} threshold={MIN_SETTLED_BETS_TO_TRUST} unit="scored predictions">
          <CalibrationChart buckets={buckets} />
        </TrustGate>
      </FadeIn>
    </div>
  );
}
