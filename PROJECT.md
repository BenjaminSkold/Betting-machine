# Confluence — Project Brief

Read this whole file before doing anything. It's the shared context for every build session on this project. If anything you're about to build contradicts this file, stop and ask rather than guessing.

## What this is

A personal, single-user research tool. It watches football matches in the Premier League, Champions League, and Europa League, and tries to build one "confluence" number per match representing how much an informed source (mainly specific Polymarket wallets with a proven track record) disagrees with the market's own price — i.e., where's the edge. Every recommendation gets logged as a **fake bet** with fake money. Nothing here ever touches a real account or places a real trade. Real money is not a phase-1, phase-2, or even phase-3 goal — it only gets reconsidered later, and only if the paper-betting results genuinely earn it.

## Hard constraints — do not violate these

- **No real money, ever, anywhere in this build.** No live trading, no real sportsbook or exchange integration beyond read-only public data.
- **Free only.** Every service used must have a free tier sufficient for personal-scale use, and nothing should require attaching a credit card if avoidable (this is why Firebase Cloud Functions is avoided in favor of GitHub Actions — see below).
- **Premier League + Champions League + Europa League only** for the real analysis. Conference League may be logged too if it's nearly free to add, but never mixed into the main wallet-ranking or scoring logic — treat it as a separate, clearly-labeled side dataset if included at all. No Allsvenskan (Polymarket has no market for it).
- **Polymarket is the only signal source for v1.** No other odds vendors, no scraping other sites, no tipster tracking yet. That's explicitly a later phase.
- **The confidence score must always show its breakdown, never just a headline number.** Every score should be traceable back to which wallets/signals drove it.
- **Don't build machine learning yet.** Use a simple, transparent, hand-set weighting to start. Save every parameter that a future model might want (timing, team, competition, wallet consensus, betting volume, etc.) so ML can be added later without re-architecting, but the actual scoring formula for now should be simple enough for a human to check by hand.
- **The user's own paper-bet ledger is NOT a wallet in the wallet-ranking system.** It gets its own separate data and its own separate dashboard section — "my performance," not folded into a wallet leaderboard. The underlying win-rate/ROI calculation logic can be shared/reused, but the presentation and the data model should keep them apart.

## Why edge, not just confidence

A score like "70% confident" means nothing on its own — it has to be compared against what the market is already pricing in. If Polymarket's price already implies 65% for an outcome and our estimate is 70%, that's barely any edge. If the market implies 20% and our estimate is 70%, that's a real disagreement worth paying attention to. So: every confluence score must resolve to an estimated probability, and the actual decision signal is

```
edge = our_estimated_probability - market_implied_probability
```

Both the raw confluence score and the edge should be stored and shown — don't collapse them into one number.

## Tech stack

**Changed 2026 — read this if you built anything against Firestore before now:** this project moved off Firestore after a live test hit its 1 GiB storage cap and its daily read/write quota during a historical backfill, which caused an unexplained ~2-day project lockout (most likely either the daily quota or a new-project abuse/anomaly hold — never fully confirmed). Firestore is no longer part of this project. If a Firestore setup already exists in this repo, treat it as superseded — the live database is now Turso, and raw trade data goes to Cloudflare R2, not any live database. See "Batching writes" below for why this isn't just a database swap.

**Changed again, same year — a second migration attempt (Firestore → Postgres/Supabase) also hit a wall**, independently, for the same underlying reason: Supabase's free tier caps total database size at 500MB, which a historical backfill blew past, locking the database read-only mid-migration. That attempt is documented in NOTES.md rather than repeated here — the lesson from both failures is the same one this file now builds around: raw trade data cannot live in any single relational/document database's free tier, at any provider, once more than a few weeks of real trading volume exists. Splitting aggregates (small, live-queried) from raw trades (large, rarely queried) across two different systems is the actual fix, not swapping which database holds everything.

- **Live/aggregate database:** Turso (libSQL/SQLite-compatible), free tier — 5 GB storage, 500M row reads/month, 10M row writes/month, no credit card required. Holds the small, frequently-queried data: matches, snapshots, wallet aggregates, confluence scores, paper bets. Does NOT hold raw individual trades — see Data model.
- **Raw trade archive:** Cloudflare R2 (object storage), free tier — 10 GB storage, 1M write-type operations/month, 10M read-type operations/month, zero egress fees. Enabling R2 requires a card on file even though the free tier itself isn't charged — see "R2 usage guard" below for how this project protects against ever crossing into billed usage. Raw trade data (the couple-million-records-a-season stuff) is written here as batched files, not as database rows.
- **Frontend/hosting:** Vercel (user already has an account set up).
- **Scheduled data collection:** a GitHub Action on a cron schedule, calling Polymarket's public APIs and writing into Turso (aggregates) and R2 (raw trade batches). This avoids Firebase Cloud Functions entirely (no billing account needed anywhere in this stack).
- **Data source:** Polymarket's public, free, unauthenticated read APIs:
  - Gamma API (`https://gamma-api.polymarket.com`) — discover events/markets: `/events`, `/markets`, `/public-search`.
  - CLOB API (`https://clob.polymarket.com`) — prices and history: `/price`, `/prices`, `/book`, `/prices-history`.
  - Data API (`https://data-api.polymarket.com`) — wallet-level data: `/trades` (supports `?user=<address>` and a market filter), `/positions?user=<address>`, `/activity?user=<address>`.
  - All of the above are public/free/no-auth for reading. Rate limits are generous (hundreds of requests per 10 seconds on the endpoints above) — nowhere near a limit at personal-project polling frequency.

## Data model

Split across two places on purpose — see "Batching writes" for why.

**Turso (live, small, frequently queried) — see `turso/schema.sql` for the actual DDL:**

```
matches
  event_id, competition: "EPL" | "UCL" | "UEL" | "UECL"
  homeTeam, awayTeam
  kickoffTime
  polymarketMarketId
  resolved: boolean
  result: "home" | "draw" | "away" | null
  homeConditionId, drawConditionId, awayConditionId
  lastSeenTimestamp, lastSeenKeysAtCursor   // per-market cursor, avoids re-fetching a match's full trade history every poll
  lastPolledAt                              // adaptive-schedule bookkeeping -- see below
  tradesBackfilled

snapshots
  id (autoincrement), matchId
  capturedAt                  // null for backfilled snapshots -- there was no live "capture" moment
  minutesBeforeKickoff         // one row per POLL now, not a fixed 60/15/10 set -- see "Adaptive polling schedule"
  prices: { home, draw, away }
  liquidity
  backfilled

wallets
  address (primary key)
  totalResolvedTrades
  aggregateWinRate            // sample-size-adjusted (shrinkage), not raw
  aggregateROI
  tier: "watch" | "unranked"  // Tier 2 promotion status
  bySlice: { byCompetition: {...}, byTeam: {...}, byMonth: {...} }
  trend: { early, recent, delta, label }
  lastUpdated

confluenceScores
  id, matchId, snapshotId
  minutesBeforeKickoff
  probabilityEstimate, marketImpliedProbability, edge
  breakdown: { ... }
  frozenAt

paperBets
  id, matchId, scoreId
  edgeAtBet, stake
  outcome: "win" | "loss" | "pending" | "void"
  pnl
  placedAt, settledAt

usage_stats                   // R2 usage guard -- see below, not part of the original design
  metric, period, value
```

**Cloudflare R2 (raw trade archive — write-once, rarely read, never held in the live database):**

```
trades/{matchId}/{pollTimestamp}.json.gz
  // one batched, compressed file per poll per match — NOT one file/write per trade
  [ { key, wallet, side, size, price, timestamp, outcome, conditionId }, ... ]
  // `key` is the trade's natural id (transactionHash_asset_outcomeIndex) --
  // used to dedupe on read, since R2 and Turso are separate systems with
  // no shared transaction, so a retry after a partial failure can
  // legitimately write the same trades twice under two different keys.
```

Tier 1 logging (below) writes here, in batches. Tier 2's wallet-ranking job reads these files to compute aggregates, then writes only the small resulting aggregate into Turso's `wallets` table — the millions of raw rows never touch the live database at all.

## Wallet tracking logic (two-tier)

1. **Tier 1 (everyone, cheap):** every trade on every watched market gets logged — but as **batched files in R2**, not as individual database writes (see "Batching writes"). One file per poll per match, containing every trade seen in that poll, not one write per trade. No filtering, no judgment about which wallets matter yet.
2. **Tier 2 (promoted, ranked):** on a schedule (daily, plus event-triggered right after each match resolves — see "Recompute on match resolution"), read the relevant R2 trade files and recompute the `wallets` row in Turso for every wallet with enough resolved trades to say anything meaningful (minimum 8-10 resolved trades). Use a shrinkage-adjusted win rate so lucky newcomers don't outrank proven ones. Promote to `tier: "watch"` only once both an activity bar and a quality bar are cleared. Compute the same stats sliced `byCompetition`, `byTeam`, and `byMonth`, falling back to the wallet's aggregate number whenever a slice's sample is too small to trust. Only this small, computed result is written to Turso — the raw trades stay in R2.
3. **Backfill:** already-resolved matches from earlier this season, pulled straight from Polymarket. **Must be paced deliberately** — see "Batching writes and pacing the backfill" below. This is the step that caused both prior lockouts; don't repeat that mistake against Turso/R2.

## Batching writes — this is not optional

A "write" is one save-operation. What quotas actually count is the number of separate operations, not the total bytes moved — and a single write/insert can carry many records at once. Writing millions of trades as millions of individual one-row-at-a-time writes is exactly what caused both earlier lockouts, and would blow through any provider's quota, free or paid. The rule: **always batch.** Collect everything seen in one polling cycle for one match into a single write (one file to R2) rather than writing record-by-record. This applies everywhere in this project, not just the backfill — live polling too.

**Pacing the backfill specifically:** `backfill.js` processes one bounded batch of matches (default 15) per invocation and exits, run on its own GitHub Actions schedule (every 3 hours) rather than as one long burst — spreading the full historical backfill over roughly a week. It also stops itself early if several matches in a row fail (a circuit breaker), rather than continuing to hammer a possibly-struggling service.

## R2 usage guard

Because enabling R2 required putting a card on file (unlike Turso, which needs none), a self-tracked usage guard exists in `pipeline/src/tradeArchive.js` (and mirrored read-side in the dashboard): before every write, and before every read, it checks a running total kept in Turso's `usage_stats` table against 80% of Cloudflare's published free-tier limits (10GB storage, 1M write-ops/month, 10M read-ops/month) and **throws rather than proceeding** once within that margin. This is deliberately self-tracked rather than relying on Cloudflare's own usage dashboard, so a silent drift into billed usage becomes a loud, immediately-noticed failure instead.

## Visibility into usage

Before building anything custom, check Turso's and Cloudflare's own web dashboards — both show live, accurate read/write/storage usage for free, no code required. The self-tracked `usage_stats` guard above is the automatic backstop; the dashboards are still worth glancing at periodically.

## Adaptive polling schedule

Don't poll every match at a fixed interval regardless of how close it is to kickoff. Ramp up as kickoff approaches, and stop polling entirely once a match ends:

| Time until kickoff | Poll frequency |
|---|---|
| Multiple days out | Once a day |
| ~1 day out | Every 4 hours |
| Several hours out | Every hour |
| ~1 hour out | Every 30 minutes, then every 15 |
| Final hour | Every minute |
| Final 15 minutes | Every 30 seconds |
| During the match | Every minute |
| After the match ends | Stop polling this match entirely |

**Implementation note:** GitHub Actions' cron scheduler can't go below 5 minutes and isn't guaranteed to fire exactly on schedule under load. `collect.js` handles this by looping internally for most of the 5-minute gap between cron ticks, checking each match's own due-time (`pollIntervalMsFor()` + `lastPolledAt`) every ~30 seconds within that loop — the cron tick is a "wake up and stay busy for a while" trigger, not the actual polling clock.

Every poll produces one snapshot (price) and one batched trade file (if any new trades occurred). Don't freeze one confluence score right before kickoff; every snapshot that has meaningfully new data should eventually get its own confluence score, tagged with `minutesBeforeKickoff`, so which checkpoint is actually the best moment to act on can be analyzed later.

## Recompute on match resolution

The moment a match resolves (result known), immediately trigger a Tier 2 recompute for every wallet that traded on it — don't wait for the next scheduled daily run. Implemented as a full re-run of the same daily wallet-ranking computation (not a separate incremental path — a wallet's aggregate stats span its entire trade history, not just the one match, so there's no meaningful shortcut, and reusing the exact same logic can't drift out of sync with the daily job).

## Milestones

Work through these roughly in order. Each one should be small enough to actually finish and check before starting the next.

---

### Milestone 1 — Get real Polymarket data flowing
Goal: prove the data pipeline works before anything depends on it. No scoring, no wallets yet, no UI. *(Done — see NOTES.md.)*

### Milestone 2 — Turso + R2 + scheduled collection
Goal: the pipeline described in "Data model" and "Tech stack" actually running on a schedule, writing real data, correctly split between Turso (aggregates) and R2 (raw batched trades). *(Done — see NOTES.md.)*

### Milestone 3 — Backfill + wallet ranking
Goal: Tier 2 of the wallet logic — turning the raw trade log into an actual ranked watchlist. *(Done — see NOTES.md.)*

### Milestone 4 — The confluence/edge scoring engine
Goal: turn the watchlisted wallets' activity plus price data into the actual score described in "Why edge, not just confidence." *(Done — see NOTES.md.)*

### Milestone 5 — The paper-bet simulator (the user's own ledger)
Goal: a simple, separate simulation of "what if I bet whenever the edge crosses a threshold." *(Done — see NOTES.md.)*

### Milestone 6 — Dashboard (Vercel)
Goal: a real webpage, but only after everything above is solid.

> Build a Vercel-hosted web app that reads from Turso and R2 and shows: a list of upcoming/recent matches with their current confluence score and edge; a per-match detail view with the full score breakdown and price history chart; a wallet leaderboard (tier: "watch" wallets, with aggregate and sliced stats); and a clearly separate "my performance" section showing the paper-bet ledger's running bankroll, win rate, and ROI. Not yet deployed to Vercel — local only so far.

---

## When you're allowed to trust the results

Don't draw conclusions — good or bad — from a small stretch of paper bets. Treat roughly **150-200 settled paper bets, or one full season, whichever comes later,** as the minimum before treating any win rate, ROI, or edge-by-segment finding as real rather than noise. Below that threshold, the dashboard should say so plainly (e.g. "N=32, too early to tell") rather than presenting a confident-looking number.

## Keep it running, not just built

Scheduled jobs fail quietly far more often than they fail loudly. `pipeline_status.lastSuccessfulRun` in Turso, updated on every successful `collect.js` run, is the freshness check — the dashboard's matches page shows a stale/fresh indicator from it.

## Open questions to keep in mind, not blockers

- Exact minimum sample size before trusting a wallet or a slice — start with a reasonable guess (8-10 resolved trades) and revisit once real data shows how noisy small samples actually are here.
- Whether underdog-favoring edge or "meh," roughly-agrees-with-the-market edge turns out to be where the actual paper profit comes from — a real open question, to be answered empirically once Milestone 5 has real settled-bet data.
- Whether a wallet's per-team/per-competition edge reflects genuine skill or just fandom-driven volume with good luck — no clean way to distinguish from trade data alone; worth watching once more slices have real volume.
- Conference League as an optional side dataset — nice to have, never required, never mixed into the main analysis.
- Deeper historical backfill (multiple past EPL seasons) is feasible for EPL specifically; UCL/UEL have real data-availability limits going back more than one season (Polymarket's series ids only cover partial knockout-round history further back).
- Multi-platform expansion (bet365, Stake, etc.) needs its own design conversation before assuming it's a simple "add another source" — those platforms don't expose any wallet-level/per-bettor data the way Polymarket's on-chain trades do, so the "follow smart wallets" mechanism doesn't translate directly.
