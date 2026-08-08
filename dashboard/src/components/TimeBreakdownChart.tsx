"use client";

import { useState } from "react";
import BarChart, { type BarDatum } from "./BarChart";

type Granularity = "week" | "month" | "year";

// Plain win rate (%) with the wallet's own overall win rate as the
// reference line, rather than the (winRate - 50%) "pp" convention used
// elsewhere -- this chart exists partly because "pp" wasn't landing as a
// unit, so it deliberately sidesteps it.
export default function TimeBreakdownChart({
  byWeek,
  byMonth,
  byYear,
  baseline,
}: {
  byWeek: BarDatum[];
  byMonth: BarDatum[];
  byYear: BarDatum[];
  baseline: number;
}) {
  const [granularity, setGranularity] = useState<Granularity>("month");
  const data = granularity === "week" ? byWeek : granularity === "year" ? byYear : byMonth;

  return (
    <div>
      <div className="mb-3 flex items-center gap-1 text-xs">
        {(["week", "month", "year"] as Granularity[]).map((g) => (
          <button
            key={g}
            onClick={() => setGranularity(g)}
            className="rounded-md px-2.5 py-1 font-medium capitalize transition-colors"
            style={{
              background: granularity === g ? "color-mix(in srgb, var(--diverging-pos) 14%, transparent)" : "transparent",
              color: granularity === g ? "var(--diverging-pos)" : "var(--text-secondary)",
            }}
          >
            {g}ly
          </button>
        ))}
      </div>
      <BarChart data={data} baseline={baseline} formatMode="percent1" />
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        The reference line marks this wallet&apos;s overall win rate ({baseline.toFixed(1)}%). One bar per {granularity} it had at least one resolved
        match-level bet in — a wallet betting many times on a single match counts as one bet here, not one per fill.
      </p>
    </div>
  );
}
