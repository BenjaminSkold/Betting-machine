"use client";

import { useEffect, useRef, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { EDGE_BUCKETS, TIMING_BUCKETS } from "@/lib/breakdown";
import type { Competition } from "@/lib/types";

export type FilterField = "competition" | "dateRange" | "team" | "wallet" | "edgeMin" | "favorite" | "checkpoint";

const COMPETITIONS: Competition[] = ["EPL", "UCL", "UEL", "UECL"];
const DATE_PRESETS = [
  { label: "All time", days: null },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// One row, above the content it scopes, standard HTML controls styled to
// match the chart chrome (per the dataviz skill's interaction.md) --
// filters are not chart marks. `fields` lets each page show only the
// controls that apply to it; the URL is the single source of truth so
// every chart/stat/table on the page re-renders against the same slice.
export default function FilterBar({ fields, teamsByCompetition }: { fields: FilterField[]; teamsByCompetition?: Record<string, string[]> }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function update(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });
  }

  // Text inputs (team/wallet) navigate on every keystroke otherwise -- each
  // navigation re-renders the Server Component tree around this input,
  // which steals focus after the very first character typed. Debouncing
  // means the URL (and the page's data) only updates once the user pauses,
  // so the input stays focused and mid-word.
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); }, []);
  function updateDebounced(key: string, value: string) {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => update(key, value), 400);
  }

  const has = (f: FilterField) => fields.includes(f);
  const inputClass =
    "rounded-md border border-[var(--border)] bg-[var(--page-plane)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] transition-colors focus:border-[var(--diverging-pos)] focus:outline-none";

  const activeCount = fields.filter((f) => {
    if (f === "dateRange") return searchParams.get("from") || searchParams.get("to");
    const key = f === "edgeMin" ? "edgeMin" : f;
    return !!searchParams.get(key);
  }).length;

  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2.5">
      <span className="mr-1 flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
        Filters
        {isPending && <Loader2 size={12} className="animate-spin" />}
      </span>

      {has("competition") && (
        <select className={inputClass} value={searchParams.get("competition") ?? ""} onChange={(e) => update("competition", e.target.value || null)}>
          <option value="">All competitions</option>
          {COMPETITIONS.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      )}

      {has("dateRange") && (
        <select
          className={inputClass}
          value=""
          onChange={(e) => {
            const days = e.target.value ? Number(e.target.value) : null;
            const params = new URLSearchParams(searchParams.toString());
            if (days === null) {
              params.delete("from");
              params.delete("to");
            } else {
              params.set("from", isoDaysAgo(days));
              params.delete("to");
            }
            startTransition(() => router.replace(`${pathname}?${params.toString()}`, { scroll: false }));
          }}
        >
          <option value="">
            {searchParams.get("from") || searchParams.get("to") ? `${searchParams.get("from") ?? "…"} → ${searchParams.get("to") ?? "now"}` : "Date range"}
          </option>
          {DATE_PRESETS.map((p) => (
            <option key={p.label} value={p.days ?? ""}>{p.label}</option>
          ))}
        </select>
      )}

      {has("team") &&
        (teamsByCompetition ? (
          <select className={inputClass} value={searchParams.get("team") ?? ""} onChange={(e) => update("team", e.target.value || null)}>
            <option value="">All teams</option>
            {(() => {
              const selectedCompetition = searchParams.get("competition");
              const teams = selectedCompetition
                ? (teamsByCompetition[selectedCompetition] ?? [])
                : [...new Set(Object.values(teamsByCompetition).flat())].sort();
              return teams.map((t) => (
                <option key={t} value={t}>{t}</option>
              ));
            })()}
          </select>
        ) : (
          <input
            className={`${inputClass} w-32`}
            placeholder="Team"
            defaultValue={searchParams.get("team") ?? ""}
            onChange={(e) => updateDebounced("team", e.target.value)}
          />
        ))}

      {has("wallet") && (
        <input
          className={`${inputClass} w-36 font-mono`}
          placeholder="Wallet 0x…"
          defaultValue={searchParams.get("wallet") ?? ""}
          onChange={(e) => updateDebounced("wallet", e.target.value)}
        />
      )}

      {has("edgeMin") && (
        <select className={inputClass} value={searchParams.get("edgeMin") ?? ""} onChange={(e) => update("edgeMin", e.target.value || null)}>
          <option value="">Any edge</option>
          {EDGE_BUCKETS.map((b) => (
            <option key={b.label} value={String(b.min)}>{b.label}+</option>
          ))}
        </select>
      )}

      {has("favorite") && (
        <select className={inputClass} value={searchParams.get("favorite") ?? ""} onChange={(e) => update("favorite", e.target.value || null)}>
          <option value="">Favorite + underdog</option>
          <option value="favorite">Favorite only</option>
          <option value="underdog">Underdog only</option>
        </select>
      )}

      {has("checkpoint") && (
        <select className={inputClass} value={searchParams.get("checkpoint") ?? ""} onChange={(e) => update("checkpoint", e.target.value || null)}>
          <option value="">Any timing</option>
          {TIMING_BUCKETS.map((b) => (
            <option key={b.label} value={b.label}>{b.label}</option>
          ))}
        </select>
      )}

      {activeCount > 0 && (
        <button
          className="ml-1 text-xs text-[var(--text-muted)] underline decoration-dotted hover:text-[var(--text-primary)]"
          onClick={() => startTransition(() => router.replace(pathname, { scroll: false }))}
        >
          Clear all
        </button>
      )}
    </div>
  );
}
