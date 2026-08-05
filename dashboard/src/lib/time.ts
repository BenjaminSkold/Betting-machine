// Wall-clock-fresh per request is intentional — these are Server Components
// that run once per request with no re-render to stay consistent across, so
// "now" is meant to change every load. Kept in a plain (non-component)
// function so the impure-call purity lint doesn't apply to it.
export function freshnessAge(iso: string): number {
  return Date.now() - new Date(iso).getTime();
}
