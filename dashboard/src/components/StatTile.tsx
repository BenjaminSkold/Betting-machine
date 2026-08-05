// Stat tile per the dataviz skill's figure contract: label (sentence case,
// no trailing colon), value (sans semibold, proportional figures — never
// tabular at this size), optional delta (signed, colored by direction).
export default function StatTile({
  label,
  value,
  delta,
  deltaGood,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaGood?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4">
      <div className="text-sm text-[var(--text-secondary)]">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-[var(--text-primary)]">{value}</div>
      {delta && (
        <div
          className="mt-1 text-sm font-medium"
          style={{ color: deltaGood ? "var(--status-good-text)" : "var(--status-critical)" }}
        >
          {delta}
        </div>
      )}
    </div>
  );
}
