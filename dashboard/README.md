# Confluence dashboard

Read-only Next.js dashboard for the Confluence project — see `../PROJECT.md` for what this is and why. This app never writes to Firestore; all writes happen in `../pipeline`.

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
2. Create `.env.local` with either:
   - `GOOGLE_APPLICATION_CREDENTIALS=<absolute path to a Firebase service account key file>` (local dev), or
   - `FIREBASE_SERVICE_ACCOUNT_JSON=<the key file's raw JSON content>` (matches how Vercel env vars work — no filesystem path available there)
3. `npm run dev`

The key needs read access to the same Firestore project the pipeline writes to. Nothing here needs write access, but the working credential currently requires the full `datastore` OAuth scope, not `datastore.readonly` — see `src/lib/firestore.ts` for why.

## Architecture notes

- **No Firebase Admin SDK.** `src/lib/firestore.ts` is a small hand-rolled REST client (`getDoc`, `listCollection`, `listCollectionGroup`) using `google-auth-library` directly for the same reason the pipeline avoids it — see `../NOTES.md`.
- **`listCollectionGroup`** exists specifically for `/trades`, which needs every match's `tradeBatches` in one request instead of one round-trip per match (a real ~24s-load bug, fixed — see `../NOTES.md` for the story and the numbers).
- **Design system**: the dataviz skill's validated default palette (light+dark both selected, categorical/diverging/status roles), defined as CSS custom properties in `src/app/globals.css`. Don't invent new colors ad hoc — reuse the existing `var(--...)` roles.
- **Theme**: `useSyncExternalStore` reads `localStorage` (`ThemeToggle.tsx`) rather than the more common `useState`+`useEffect`, specifically to avoid React's "setState synchronously in a mount effect" lint rule. A pre-hydration inline script in `layout.tsx` prevents a flash of the wrong theme on load.
- **`loading.tsx`/`error.tsx` are deliberately absent from `matches/wallets` and their `[id]` detail routes.** Any `loading.tsx` in that ancestor chain broke `notFound()`'s HTTP status code in *both* dev and production (confirmed by removal/retest, not assumed). Production also has a second, separate quirk where `notFound()` returns 200 instead of 404 even with zero `loading.tsx`/`error.tsx` present anywhere — investigated and documented in `../NOTES.md`, not yet resolved. Don't add a `loading.tsx` to those two route trees without re-testing against a real `next build && next start`, not just `next dev`.
- Every screenshot-based visual check in this project's history should go through a real browser (CDP mobile emulation, or just open it) — the `--screenshot` CLI flag on headless Chromium/Edge produced a false-positive "page overflows on mobile" signal at one point. See `../NOTES.md` for the full story before trusting a `--screenshot` capture over what the page actually does.

## Known limitations

- `/trades` and `/wallets/[address]` do a full scan (trades page: one collection-group query; wallet page: one query per match) rather than a proper wallet/competition index. Fine at today's data volume; revisit if either gets slow as the season's data grows.
- Not deployed to Vercel yet — deliberately local-only until the pipeline is validated against real data (currently blocked on a Firestore write throttle, see `../NOTES.md`).
