export default function Loading() {
  return (
    <div className="max-w-4xl">
      <div className="mb-1 h-8 w-40 animate-pulse rounded bg-[var(--surface-1)]" />
      <div className="mb-6 h-4 w-96 animate-pulse rounded bg-[var(--surface-1)]" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg border border-[var(--border)] bg-[var(--surface-1)]" />
        ))}
      </div>
    </div>
  );
}
