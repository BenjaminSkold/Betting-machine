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
