# Status as of 2026-08-05 night — overnight autonomous session

Working solo overnight per the user's request ("finish as much as possible, don't deploy yet, keep checking the data pipeline"). Summary for anyone (human or a fresh Claude session) picking this up:

**Blocked, not broken:** Firestore's write throttle on this project (`betting-machine-cd81a`) has not cleared since ~19:00 UTC. A background poll (`pipeline` dir, single-write probe every 20 min) is still running and will be the signal that it's cleared — check `pipeline/src/waitForQuota.js`'s poll loop output, or just try `node src/backfill.js` again. Once it clears: resume `backfill.js` (self-healing, resumable — already has retry/cooldown logic and skips already-done matches), then verify the GitHub Action runs cleanly twice, then run `rankWallets.js` → `scoreMatches.js` → `paperBets.js` for real data, then re-verify the dashboard against real data (it currently only has partial/stale data — enough to prove the UI works, not enough to trust any numbers).

**Milestones 1-5 (pipeline)**: all built, unit-tested against synthetic data, wired into GitHub Actions cron. Genuinely blocked on the quota clearing before they can be validated end-to-end with real data — see the write-quota and wallet-ranking sections below for the full story of what went wrong and how it was fixed.

**Milestone 6 (dashboard)**: built ahead of PROJECT.md's own "don't start early" guidance, with the user's explicit go-ahead once we hit the pipeline block — reasoned as "the backend design is stable even if unvalidated with real data yet, so the plumbing isn't wasted work; only the final visual polish would be." Design takes inspiration from Polymarket (light mode, bold probability numbers, data-dense-but-organized) and general modern dashboard conventions (sidebar nav, KPI stat tiles) since two of the four reference links the user gave were Dribbble shots that don't respond to a plain fetch (JS-heavy SPA, no server-rendered content) — flagged to the user, who could paste screenshots directly for a closer match later. Pages: Overview (new, not in the original spec — system-wide KPIs), Matches (list + detail with price-history chart and full score breakdown), Wallets (leaderboard + detail pages with full trade history), Trades (global explorer, added per the user's explicit "let me track all the trades myself" request), My Performance (paper-bet ledger, kept structurally separate from the wallet leaderboard per PROJECT.md's hard constraint). Local only — not deployed, not linked to Vercel, per explicit instruction.

Real bugs found and fixed while building the dashboard (all verified before/after, not just asserted):
- Firestore REST calls needed the full `datastore` OAuth scope, not `datastore.readonly` (the latter returns `ACCESS_TOKEN_SCOPE_INSUFFICIENT` against v1 REST list/get in Native mode).
- The Trades page did one Firestore round-trip per match (60 matches → ~24s wall time even with `Promise.all`, since Node's per-host connection limit queues well before 60-way concurrency). Fixed with a Firestore collection-group query (`listCollectionGroup` in `dashboard/src/lib/firestore.ts`) — one bounded query across every match's `tradeBatches` instead of N of them. Down to ~12s; the remaining time is `runQuery`'s own latency on this project (~5s regardless of result size), not something more code can fix.
- `PriceHistoryChart`'s direct end-labels could overlap when two series' values converge — fixed per the dataviz skill's sanctioned fallback (suppress the direct label on collision, rely on the always-present legend + tooltip), verified with a synthetic before/after screenshot.
- `ThemeToggle` hit React's new "no setState synchronously in a mount effect" lint rule — fixed properly with `useSyncExternalStore` (the sanctioned way to read external mutable state like `localStorage`), not suppressed.
- No mobile breakpoint at all originally (fixed-width sidebar always visible) — added a proper slide-in drawer + hamburger button, verified via real CDP mobile-emulation screenshots after an earlier round of "fixes" turned out to be chasing a measurement artifact from the `--screenshot` CLI flag (see git log for the full story — worth reading before trusting any future screenshot-based visual QA in this repo without cross-checking via CDP).

**If resuming fresh**: read this file top to bottom, then `git log --oneline -20` for the exact sequence. `pipeline/serviceAccountKey.json` and `dashboard/.env.local` both hold live credentials (gitignored) — don't need to redo that setup.

**Known, investigated, unresolved limitation**: `notFound()` (e.g. visiting `/matches/<bad-id>` or `/wallets/<bad-address>`) renders the correct not-found content in the body, but returns HTTP 200 instead of 404 — **only in a production build** (`next build && next start`). Dev mode (`next dev`) gets this right. Methodically ruled out as the cause, each verified with a real before/after test against a real production server, not assumed:
- Any `loading.tsx` in the ancestor chain (confirmed: breaks it in *both* dev and prod, but that's a separate mechanism — the 200-in-prod-only issue persists even with zero `loading.tsx` files anywhere in the app)
- The root `error.tsx` boundary
- `export const dynamic = "force-dynamic"` on the affected pages
This looks like a Next.js 16.3.0-specific framework behavior (possibly related to its new Cache Components/PPR direction generating a static shell for dynamic segments even without `cacheComponents` explicitly enabled) rather than anything fixable from application code. Not blocking — the page content is correct either way, this only affects the HTTP status code's correctness (matters for SEO/tooling, not for what a user sees). Worth re-checking against a newer Next.js patch release before spending more time on it.

# Milestone 4 — confluence/edge scoring engine, as actually implemented

`pipeline/src/scoreMatches.js`. Also unit-tested against hand-worked synthetic numbers (`scoreMatches.test.js`) since it depends on `wallets/{wallet}.tier === "watch"`, which doesn't exist yet (rankWallets.js hasn't had real data to run against — see below).

- **Weighting scheme**: for each leg (home/draw/away), sum `trade.size * (wallet.aggregateWinRate - 0.5) * direction` across every *watchlisted-only* wallet's trades on that leg, where `direction` is +1 for betting the leg WILL happen (BUY Yes / SELL No) and -1 for betting against it. Normalize by the match's total watchlisted volume (not each leg's own volume, so a leg with only a trickle of watchlisted money can't look artificially overconfident). This is the `score` field — a plain weighted vote, no fitting.
- **Translating score to probability**: nudge the market's own price for that leg by `MAX_SHIFT * (normalizedSignal / 0.5)`, where `MAX_SHIFT = 0.15` — i.e. smart-wallet signal can move the estimate at most 15 percentage points from market price, at maximum one-sidedness and maximum wallet skill. Clip and renormalize the three legs back to summing to 1. `MAX_SHIFT` is a documented guess, not fitted — PROJECT.md's "open questions" already flags revisiting this once paper-bet results exist.
- **Which leg gets reported at the top level**: whichever of the three has the largest `|edge|` — that's the one that would actually be worth a paper bet. All three legs' full numbers (including a `contributingWallets` list) still live in `breakdown` regardless, per the hard constraint that a score must always show its breakdown.
- **No lookahead bias**: trades are filtered to `timestamp <= kickoffTime - minutesBeforeKickoff*60s` before scoring a given checkpoint, so a "60 min before kickoff" score can't see trades that actually happened later. Without this, Milestone 4's whole point — comparing which checkpoint is actually predictive — would be silently invalidated.
- Depends on `rankWallets.js` having run against real data first (needs `tier:"watch"` wallets to exist) — blocked on the same write-quota issue as the backfill. Confirmed to behave correctly (does nothing, no errors) when no watchlisted wallets exist yet.

# Milestone 3 (Tier 2) — wallet-ranking model, as actually implemented

`pipeline/src/rankWallets.js` reads every resolved match's trades and computes per-wallet stats. Written and unit-tested (`rankWallets.test.js`, hand-worked expected values) against synthetic data — real Firestore data doesn't exist yet as of this writing because the backfill is blocked (see the write-quota section below), and the 24 matches that *were* backfilled predate the `marketConditionIds` field this job needs, so they'll be re-processed once backfill resumes (see the skip-condition fix below).

- **Win/loss determination** needs to know which of a match's 3 markets (home/draw/away) a trade's `conditionId` belongs to. That mapping wasn't being stored anywhere, so `matches/{matchId}` now also gets a `marketConditionIds: {home, draw, away}` field (added in both `collect.js` and `backfill.js`). Backfill's "already done, skip" check now requires this field too, so the matches backfilled before this change get healed automatically on the next run instead of being silently stuck without it.
- **P&L model is a deliberate simplification**: a BUY at price `p` for `size` shares pays `size*(1-p)` if its side wins, `-size*p` if it loses. SELL is modeled as the exact mirror of a BUY on the same side. Polymarket's real short/exit mechanics are more nuanced than this, but PROJECT.md is explicit that the scoring/stats should stay "simple enough for a human to check by hand" — this extends that same philosophy to wallet P&L. Revisit if SELL volume turns out to be significant.
- **Shrinkage**: `shrunkRate = (wins + k*prior) / (n + k)`, k=10, prior = the global average win rate across every trade seen. A wallet with exactly 10 trades gets pulled halfway between its raw rate and the average; more trades pull less. This is the standard Bayesian-shrinkage-toward-a-prior formula, chosen for being transparent and hand-checkable rather than for statistical optimality.
- **Tier promotion ("watch")** requires both: activity bar (`totalResolvedTrades >= 8`, PROJECT.md's own suggested minimum) and quality bar (shrunk win rate strictly above the global average). This is a first guess, explicitly flagged in PROJECT.md's "open questions" as something to revisit once real data shows how noisy small samples actually are.
- **bySlice fallback**: a competition/team slice only reports its own number if it has ≥8 trades; below that it reports the wallet's aggregate number instead (with `usedFallback: true`), per PROJECT.md's explicit instruction not to trust small slices.
- **byTeam** only slices home/away-leg trades (a draw bet isn't "about" either team specifically); byCompetition includes all trades.

# Milestone 2 finding — Firestore free-tier write quota forced a schema change

While running the first real backfill (2026-08-05), writing one Firestore document per trade — as PROJECT.md's data model literally specifies (`matches/{matchId}/trades/{tradeId}`) — hit `RESOURCE_EXHAUSTED: Quota exceeded` after only 10 matches (8,222 trade writes). A single active match can have 1,000-2,000+ trades; backfilling ~890 EPL/UCL/UEL matches at that rate would mean roughly 700k+ writes, dwarfing what the Spark (free) plan allows.

**Fix:** trades are now stored as chunked arrays — `matches/{matchId}/tradeBatches/{batchId}` with a `trades: [...]` array field, ~300 trades per doc — instead of one doc per trade. This cut writes by ~270x in testing (2,192 trades → 8 docs) with no loss of function: nothing downstream needs to query individual trade documents directly, since the wallet-ranking job (Milestone 3) reads and aggregates every trade in memory regardless.

- `collect.js` (live, ongoing) keeps a per-market cursor (`lastSeenTimestamp`) on each match doc so a rerun only fetches/writes trades newer than what's already stored, instead of rewriting a match's full trade history every 15 minutes. The new batch doc(s) and the cursor update commit in the same atomic Firestore batch, so a crash mid-write can't double-count trades on the next run.
- `backfill.js` (one-time, historical) has no such concern — a resolved match's trades never change — so it just chunks the full list once and marks the match `tradesBackfilled: true` to make reruns skip already-done matches (resumable if interrupted).
- This deviates from PROJECT.md's literal per-trade-document schema; the user chose this over throttling the same schema across ~5-7 weeks to stay under the daily quota, or skipping trade backfill entirely (which would have defeated the point of backfilling).

# Milestone 1 findings — Polymarket API probe

Ran against the live Polymarket APIs on **2026-08-05**. Script: `milestone1-probe/probe.js` (throwaway, not production code — no Firestore writes).

## Summary

Both "unverified" questions from PROJECT.md are answered below. One assumption in PROJECT.md's data model needed correcting first: **event discovery by free-text search is unreliable; discovery must use `tag_id`, and even then a competition's matches are split across several near-duplicate tag ids.**

## 1. How matches are actually discoverable (not one of the original questions, but this had to be solved first)

- Gamma's `/public-search?q=...` matches on title text. Searching "Champions League" returns Women's Champions League matches too (they're tagged `womens-champions-league`, not `champions-league`) — text search is not a safe filter for competition.
- The correct approach is `GET /events?tag_id=<id>&closed=false`, filtering by the tag id(s) for the competition.
- **Each competition's matches are split across multiple near-duplicate tags**, not one canonical tag. A given match event gets exactly one of them (plus generic `sports`/`games`/`soccer` tags) — which one seems to depend on when/how it was created. Confirmed ids:
  - EPL: `epl` (306), `premier-league` (82), `english-premier-league` (103043)
  - UCL: `champions-league` (1234), `uefa-champions-league` (102469), `ucl` (100977)
  - UEL: `europa-league` (100626), `uefa-europa-league` (102506), `uel` (101787)
  - UECL (side dataset only, per PROJECT.md): `uefa-conference-league` (103866), `europa-conference-league` (102763), `uecl` (103989)
  - **Any Firestore-writing job in Milestone 2 must query the union of a competition's tag ids and dedupe by event id** — querying just `champions-league` (1234) alone found only 2 (futures) events; adding `uefa-champions-league` + `ucl` surfaced 48 real matches.
- A single real match is one Gamma **event** containing 2-3 **markets**, each a binary Yes/No token pair: home-win, draw, away-win (Polymarket models 3-way outcomes as `negRisk`-linked binary markets, not one 3-way market). `event.markets[i].conditionId` is the stable id to key off; `event.markets[i].clobTokenIds` (a JSON-encoded array, needs `JSON.parse`) gives the CLOB token ids for price history.
- Caveat for Milestone 2's discovery filter: some fixtures also spin up sibling events for prop markets — e.g. `"X vs. Y - Halftime Result"`, `"... - Second Half Result"`, `"... - First Team to Score"`. These also match a naive `title contains " vs. "` + `2-3 markets` filter, so the discovery query needs to explicitly exclude titles with a `" - "` suffix to keep only the full-match event.
- As of today, **EPL has zero live match markets** (season starts mid-August, real world) — only season-long futures/props (top scorer, next manager, etc). **UCL and UEL both have real live qualifying-round matches already** (e.g. "Aarhus GF vs. Sabah FK", "Jagiellonia Białystok vs. Rangers FC"). This is expected and will resolve itself as the season starts — just don't be surprised if Milestone 2's first runs show an empty EPL bucket.

## 2. How far back does `/prices-history` go?

`GET https://clob.polymarket.com/prices-history?market=<clobTokenId>&interval=<max|1w|1d>&fidelity=<minutes>`

- History goes back to the market's **first trade / creation** — no artificial cutoff was found. Tested on:
  - A live UCL match (Aarhus GF vs. Sabah FK, created 2026-07-30): `interval=max` and `interval=1w` both returned the same 145 points spanning creation to now, `interval=1d` returned 25 points for the last day. Consistent — density scales with the requested window, not a hidden cap.
  - A ~4-month-old, effectively illiquid futures market: `interval=max` returned only 2 points total, both from right after creation, and 0 points for a recent `1w` window. This isn't a cutoff — it's an untraded, already-closed market with only $86 of total volume ever. **Data density reflects actual trading activity, not an API limit.**
- Practical implication for Milestone 4's timing checkpoints (60/15/10 min before kickoff): for a typical match, `fidelity=60` (minute-level-ish) over the match's short life is plenty granular; no need to worry about hitting a depth ceiling since match markets only exist ~1-2 weeks before kickoff anyway.

## 3. What does `/trades` return, how many wallets, can it filter by market?

`GET https://data-api.polymarket.com/trades?market=<conditionId>&limit=<n>&offset=<n>`

- **Yes, filters by market** — pass the market's `conditionId` (not the CLOB token id) as `market=`. Confirmed with both `limit`/`offset` pagination advancing correctly (no silent cap; requested 500, got 500, then `offset=500` returned the remaining 315 for an 815-trade match).
- Fields returned per trade: `proxyWallet` (the wallet identifier — there's no separate `wallet` field), `side` (BUY/SELL), `asset` (CLOB token id), `conditionId`, `size`, `price`, `timestamp` (unix seconds), `title`, `slug`, `eventSlug`, `outcome`, `outcomeIndex`, plus cosmetic profile fields (`name`, `pseudonym`, `bio`, `profileImage`) and `transactionHash`.
- Wallet counts on real matches: **160 distinct wallets in the first 500 trades** on a moderately active live UCL qualifier (815 trades total so far, match hadn't kicked off yet), and **256 distinct wallets in 477 trades** on a similarly active UECL qualifier. Order of magnitude for a match with real volume: **on the order of 150-250+ distinct wallets**, comfortably enough for Tier 1 logging to be useful and for Tier 2's 8-10-resolved-trade minimum to be reachable by a meaningful subset of wallets over a season.

## Corrections to PROJECT.md's assumptions

- The Data model section didn't specify the `/trades` market filter's param name/value — it's `market=<conditionId>` (not a CLOB token id, not a separate "market id"). Worth noting explicitly for Milestone 2's implementation.
- Match discovery needs a `tag_id`-union step that PROJECT.md didn't anticipate (it assumed Gamma's `/events`/`/markets`/`/public-search` would be straightforward). Recorded above so Milestone 2 doesn't have to rediscover this.

## Backfill feasibility (pulled forward from Milestone 3, checked 2026-08-05)

Checked whether last season's (2025-26) matches — and their full trade/price history — are actually still retrievable, since Milestone 3's backfill depends on it. **Yes, fully:**

- **`series_id` is a better discovery key than `tag_id` for backfill**, and probably better for live discovery too. Every competition has a season-spanning series (Gamma events carry a `series: [{id, title, ...}]` field): EPL 2025-26 is series `10188` ("Premier League 2025"), UCL's current season is series `10204` ("UEFA Champions League 2025"), UEL's is `10209` ("UEFA Europa League 2025"). `GET /events?series_id=<id>&closed=true` (paginated 100 at a time via `offset` — `limit` is silently capped at 100 regardless of what's requested) returns every match cleanly, already deduped by competition, without needing the tag-union workaround from Milestone 1.
  - Confirmed **all 380** EPL 2025-26 matches present (20 teams × 38 games — exact expected count), spanning 2025-08-15 to 2026-05-24.
  - UCL/UEL each have **two** series in play: an older one that only covers the tail of 2024-25's knockout rounds (~36-37 matches), and the current one ("... 2025") that covers all of 2025-26 *and* is still being used for 2026-27's ongoing qualifiers (264 and 245 matches respectively so far). Use the "... 2025" series id for both backfill and, likely, ongoing discovery once the 2026-27 season fully kicks off — worth re-checking whether Polymarket rolls over to a new series id later in the season or keeps using this one.
  - Sub-markets like "- Total Corners" / "- Total Cards" share the same series — keep filtering to `title contains ' vs. '` and `not containing ' - '` to isolate the moneyline event.
- **Trade history has no expiry.** Pulled 500 trades from the *first EPL match of last season* (Liverpool vs. Bournemouth, 2025-08-15, over a year ago from a wallet-history perspective): full data returned, 228 distinct wallets in that sample alone.
- **Price history is intact but `interval=max` is unreliable for old markets** — for that same year-old match, `interval=max` combined with any coarse `fidelity` (1/5/60 min) returned **0 points**, and `fidelity=1440` (daily) returned only 14. Switching to **explicit `startTs`/`endTs` params** (rather than the `interval=` shorthand) returned full 10-minute-resolution history across the whole match window, no gaps. **Backfill code should always use explicit `startTs`/`endTs`, not `interval=max`.**

Bottom line: a full-season backfill (matches, price history at the 60/15/10-minute checkpoints, and Tier 1 trade logs) for EPL 2025-26, and for UCL/UEL's "2025" series, is straightforward and low-risk. The blocker isn't data availability — it's that there's nowhere to write it yet, since Firestore hasn't been set up (that's Milestone 2).
