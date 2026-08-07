// Shared filter-state shape for the persistent cross-view filter bar.
// Lives in the URL as search params (not React context) so it's
// shareable/bookmarkable and survives navigation without any client-side
// state management -- each server page just reads searchParams directly.
export interface FilterState {
  competition?: string;
  from?: string; // ISO date (yyyy-mm-dd)
  to?: string;
  team?: string;
  wallet?: string;
  edgeMin?: string; // percentage points, e.g. "5"
  favorite?: string; // "favorite" | "underdog"
  checkpoint?: string; // a TIMING_BUCKETS label
}

export const FILTER_KEYS: (keyof FilterState)[] = ["competition", "from", "to", "team", "wallet", "edgeMin", "favorite", "checkpoint"];

// Next 16's searchParams prop type varies per usage; this accepts the
// plain string-keyed shape every page actually receives.
export function parseFilters(searchParams: Record<string, string | string[] | undefined>): FilterState {
  const out: FilterState = {};
  for (const key of FILTER_KEYS) {
    const v = searchParams[key];
    if (typeof v === "string" && v !== "") out[key] = v;
  }
  return out;
}

export function isMatchInDateRange(kickoffTime: string, filters: FilterState): boolean {
  const d = kickoffTime.slice(0, 10);
  if (filters.from && d < filters.from) return false;
  if (filters.to && d > filters.to) return false;
  return true;
}
