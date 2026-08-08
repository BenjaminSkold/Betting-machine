import AnimatedNumber from "./AnimatedNumber";
import type { ConfluenceScore } from "@/lib/types";

// Confluence score + edge as a compact badge, per the Nansen/Dexscreener
// "confidence signal without feeling like a spreadsheet" direction --
// used everywhere a match's current edge needs to show up in a list. Only
// reads the four scalar fields below, so callers with the lighter
// ConfluenceScoreLight shape (no breakdown/score/snapshotId/frozenAt) work too.
export default function EdgeBadge({
  score,
}: {
  score: Pick<ConfluenceScore, "edge" | "trackedLeg" | "probabilityEstimate" | "marketImpliedProbability">;
}) {
  const positive = score.edge >= 0;
  const color = positive ? "var(--diverging-pos)" : "var(--diverging-neg)";
  return (
    <div className="flex flex-col items-end gap-0.5">
      <div
        className="tabular flex items-center gap-1 rounded-full px-2.5 py-1 text-sm font-semibold"
        style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
      >
        {positive ? "+" : ""}
        <AnimatedNumber value={score.edge * 100} format="decimal1" />
        pp
      </div>
      <div className="text-[11px] capitalize text-[var(--text-muted)]">
        {score.trackedLeg} · {(score.probabilityEstimate * 100).toFixed(0)}% vs {(score.marketImpliedProbability * 100).toFixed(0)}%
      </div>
    </div>
  );
}
