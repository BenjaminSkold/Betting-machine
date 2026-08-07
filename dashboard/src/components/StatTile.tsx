import AnimatedNumber from "./AnimatedNumber";
import type { LucideIcon } from "lucide-react";

// Stat tile per the dataviz skill's figure contract: label (sentence case,
// no trailing colon), value (sans semibold, proportional figures — never
// tabular at this size), optional delta (signed, colored by direction).
//
// `value` is a pre-formatted string (existing call sites, unchanged).
// Passing `animate` + `format` instead renders the number counting up/down
// to its new value rather than snapping -- opt-in per call site.
export default function StatTile({
  label,
  value,
  animate,
  format,
  delta,
  deltaGood,
  icon: Icon,
}: {
  label: string;
  value?: string;
  animate?: number;
  format?: (n: number) => string;
  delta?: string;
  deltaGood?: boolean;
  icon?: LucideIcon;
}) {
  return (
    <div
      className="group rounded-xl border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_4px_16px_rgba(0,0,0,0.08)]"
    >
      <div className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
        {Icon && <Icon size={14} strokeWidth={2} className="opacity-70" />}
        {label}
      </div>
      <div className="mt-1.5 text-3xl font-semibold tracking-tight text-[var(--text-primary)]">
        {animate !== undefined && format ? <AnimatedNumber value={animate} format={format} /> : value}
      </div>
      {delta && (
        <div className="mt-1 text-sm font-medium" style={{ color: deltaGood ? "var(--status-good-text)" : "var(--status-critical)" }}>
          {delta}
        </div>
      )}
    </div>
  );
}
