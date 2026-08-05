export default function Loading() {
  return (
    <div className="max-w-5xl">
      <h1 className="mb-1 text-2xl font-semibold text-[var(--text-primary)]">Trades</h1>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">Every Tier 1 trade log, across every tracked match.</p>
      <div className="mb-4 h-[132px] animate-pulse rounded-lg border border-[var(--border)] bg-[var(--surface-1)]" />
      <div className="mb-3 h-3 w-64 animate-pulse rounded bg-[var(--surface-1)]" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-11 animate-pulse rounded-lg border border-[var(--border)] bg-[var(--surface-1)]" />
        ))}
      </div>
    </div>
  );
}
