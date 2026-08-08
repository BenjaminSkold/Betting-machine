import { getBacktestInputs } from "@/lib/data";
import BacktestSandbox from "@/components/BacktestSandbox";

export const dynamic = "force-dynamic";

export default async function BacktestPage() {
  const data = await getBacktestInputs();

  return (
    <div className="max-w-4xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-[var(--text-primary)]">Backtest</h1>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">
        Explore what a different edge threshold, entry timing, or bet direction would have returned against every frozen confluence score with a
        known outcome — not just the ones that cleared the live automatic threshold. Everything below recomputes instantly as you move the
        controls; nothing here changes your real paper-bet ledger.
      </p>

      {data.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-6 text-sm text-[var(--text-muted)]">
          No scored, resolved matches yet — nothing to backtest against.
        </div>
      ) : (
        <BacktestSandbox data={data} />
      )}
    </div>
  );
}
