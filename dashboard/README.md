# Confluence dashboard

Read-only Next.js dashboard for the Confluence project — see `../PROJECT.md` for what this is and why. This app never writes to the database; all writes happen in `../pipeline`.

## Pages

| Route | What it shows |
|---|---|
| `/` | Overview — system-wide KPI tiles, quick links, recently-resolved matches |
| `/matches` | Upcoming/recent matches, filterable by competition and team name |
| `/matches/[matchId]` | Price history chart + full confluence score breakdown per checkpoint |
| `/wallets` | Tier `"watch"` leaderboard |
| `/wallets/[address]` | One wallet's full trade history + sliced stats |
| `/trades` | Every Tier 1 trade across every match, filterable by wallet/competition/outcome |
| `/performance` | The user's own paper-bet ledger — kept structurally separate from `/wallets` per PROJECT.md's hard constraint |

## Local setup

1. `npm install`
2. Create `.env.local` with `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and the `R2_*` variables (same values the pipeline uses)
3. `npm run dev`

## Architecture notes

- **`src/lib/db.ts`** is a thin `@libsql/client` wrapper, same shape as `pipeline/src/db.js`.
- **`src/lib/tradeArchive.ts`** reads raw trades from R2 (never Turso — see `../PROJECT.md`'s "Data model"), including the same usage guard and dedup-by-natural-key logic as the pipeline's copy.
- **`/trades`** currently scans every match's R2 files when unfiltered — bounded by requiring a competition filter for now; see `data.ts`'s `getFilteredTradeRows` comment for the tradeoff this data split introduces (R2 has no server-side filtering the way a SQL table did) and why it hasn't needed fixing yet at today's data volume.
- **Design system**: the dataviz skill's validated default palette (light+dark both selected, categorical/diverging/status roles), defined as CSS custom properties in `src/app/globals.css`. Don't invent new colors ad hoc — reuse the existing `var(--...)` roles.
- **Theme**: `useSyncExternalStore` reads `localStorage` (`ThemeToggle.tsx`) rather than the more common `useState`+`useEffect`, specifically to avoid React's "setState synchronously in a mount effect" lint rule. A pre-hydration inline script in `layout.tsx` prevents a flash of the wrong theme on load.
- **`loading.tsx`/`error.tsx` are deliberately absent from `matches/wallets` and their `[id]` detail routes.** Any `loading.tsx` in that ancestor chain broke `notFound()`'s HTTP status code in *both* dev and production (confirmed by removal/retest, not assumed). Production also has a second, separate quirk where `notFound()` returns 200 instead of 404 even with zero `loading.tsx`/`error.tsx` present anywhere — investigated and documented in `../NOTES.md`, not yet resolved. Don't add a `loading.tsx` to those two route trees without re-testing against a real `next build && next start`, not just `next dev`.
- Every screenshot-based visual check in this project's history should go through a real browser (CDP mobile emulation, or just open it) — the `--screenshot` CLI flag on headless Chromium/Edge produced a false-positive "page overflows on mobile" signal at one point. See `../NOTES.md` for the full story before trusting a `--screenshot` capture over what the page actually does.

## Known limitations

- Not deployed to Vercel yet — local-only so far.
