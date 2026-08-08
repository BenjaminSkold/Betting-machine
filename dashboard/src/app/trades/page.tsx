import Link from "next/link";
import { getFilteredTradeRows } from "@/lib/data";
import { positionLabel, outcomeLabel } from "@/lib/tradeOutcome";
import type { Competition } from "@/lib/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function TradesPage({
  searchParams,
}: {
  searchParams: Promise<{ wallet?: string; competition?: string; outcome?: string; page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);

  const rows = await getFilteredTradeRows(params);
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const shown = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const competitions: Competition[] = ["EPL", "UCL", "UEL", "UECL"];

  // Preserves the active filters when moving between pages or exporting.
  function filterQs() {
    const qs = new URLSearchParams();
    if (params.wallet) qs.set("wallet", params.wallet);
    if (params.competition) qs.set("competition", params.competition);
    if (params.outcome) qs.set("outcome", params.outcome);
    return qs;
  }
  function pageHref(targetPage: number) {
    const qs = filterQs();
    qs.set("page", String(targetPage));
    return `/trades?${qs.toString()}`;
  }
  const exportHref = `/trades/export?${filterQs().toString()}`;

  return (
    <div className="max-w-5xl">
      <h1 className="mb-1 text-2xl font-semibold text-[var(--text-primary)]">Trades</h1>
      <p className="mb-6 text-sm text-[var(--text-secondary)]">Every Tier 1 trade log, across every tracked match.</p>

      {!params.competition && (
        <p className="mb-4 text-xs text-[var(--text-muted)]">
          No competition selected — showing the most recent matches only. Pick a competition above to see its full season.
        </p>
      )}

      <form role="search" aria-label="Filter trades" className="mb-4 flex flex-wrap gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3">
        <label htmlFor="trade-wallet" className="sr-only">
          Filter by wallet address
        </label>
        <input
          id="trade-wallet"
          type="text"
          name="wallet"
          defaultValue={params.wallet}
          placeholder="Filter by wallet address"
          className="flex-1 min-w-[220px] rounded-md border border-[var(--border)] bg-[var(--page-plane)] px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
        />
        <label htmlFor="trade-competition" className="sr-only">
          Filter by competition
        </label>
        <select
          id="trade-competition"
          name="competition"
          defaultValue={params.competition ?? ""}
          className="rounded-md border border-[var(--border)] bg-[var(--page-plane)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
        >
          <option value="">All competitions</option>
          {competitions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label htmlFor="trade-outcome" className="sr-only">
          Filter by outcome
        </label>
        <select
          id="trade-outcome"
          name="outcome"
          defaultValue={params.outcome ?? ""}
          className="rounded-md border border-[var(--border)] bg-[var(--page-plane)] px-3 py-1.5 text-sm text-[var(--text-primary)]"
        >
          <option value="">Any outcome</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </select>
        <button
          type="submit"
          className="rounded-md px-4 py-1.5 text-sm font-medium text-[var(--text-primary)]"
          style={{ background: "var(--diverging-pos)", color: "white" }}
        >
          Filter
        </button>
      </form>

      <div className="mb-3 flex items-center justify-between text-xs text-[var(--text-muted)]">
        <span>
          {total === 0
            ? "No trades match these filters."
            : `Showing ${((currentPage - 1) * PAGE_SIZE + 1).toLocaleString()}–${Math.min(currentPage * PAGE_SIZE, total).toLocaleString()} of ${total.toLocaleString()} trade(s).`}
        </span>
        <span className="flex items-center gap-3">
          {totalPages > 1 && <span>Page {currentPage} of {totalPages}</span>}
          {total > 0 && (
            <a href={exportHref} className="text-[var(--diverging-pos)] hover:underline">
              Export CSV
            </a>
          )}
        </span>
      </div>

      {shown.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th scope="col" className="px-4 py-3">When</th>
                <th scope="col" className="px-4 py-3">Match</th>
                <th scope="col" className="px-4 py-3">Wallet</th>
                <th scope="col" className="px-4 py-3">Position</th>
                <th scope="col" className="px-4 py-3">Result</th>
                <th scope="col" className="tabular px-4 py-3 text-right">Price</th>
                <th scope="col" className="tabular px-4 py-3 text-right">Size</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t, i) => {
                const outcome = outcomeLabel(t.won);
                const outcomeColor = t.won === null ? "var(--text-muted)" : t.won ? "var(--status-good-text)" : "var(--status-critical)";
                return (
                  <tr key={i} className="border-b border-[var(--border)] last:border-0">
                    <td className="tabular px-4 py-2 text-[var(--text-secondary)]">{new Date(t.timestamp * 1000).toLocaleString()}</td>
                    <td className="px-4 py-2 text-[var(--text-primary)]">
                      <span className="text-xs text-[var(--text-muted)]">{t.competition}</span> {t.homeTeam} vs. {t.awayTeam}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-[var(--text-secondary)]">{t.wallet.slice(0, 12)}…</td>
                    <td className="px-4 py-2 text-[var(--text-secondary)]">{positionLabel(t, t.leg, t.homeTeam, t.awayTeam)}</td>
                    <td className="px-4 py-2 font-medium" style={{ color: outcomeColor }}>{outcome}</td>
                    <td className="tabular px-4 py-2 text-right text-[var(--text-primary)]">{(t.price * 100).toFixed(1)}%</td>
                    <td className="tabular px-4 py-2 text-right text-[var(--text-primary)]">${t.size.toFixed(0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <nav className="mt-4 flex items-center justify-center gap-2" aria-label="Trades pagination">
          <Link
            href={pageHref(currentPage - 1)}
            aria-disabled={currentPage <= 1}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-secondary)] aria-disabled:pointer-events-none aria-disabled:opacity-40 hover:text-[var(--text-primary)]"
          >
            ← Prev
          </Link>
          <span className="text-sm text-[var(--text-secondary)]">
            {currentPage} / {totalPages}
          </span>
          <Link
            href={pageHref(currentPage + 1)}
            aria-disabled={currentPage >= totalPages}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-secondary)] aria-disabled:pointer-events-none aria-disabled:opacity-40 hover:text-[var(--text-primary)]"
          >
            Next →
          </Link>
        </nav>
      )}
    </div>
  );
}
