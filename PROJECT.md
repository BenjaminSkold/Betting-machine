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

- **Database:** Firestore (Firebase project, free Spark plan — no billing attached).
- **Frontend/hosting:** Vercel (user already has an account set up).
- **Scheduled data collection:** a GitHub Action on a cron schedule, calling Polymarket's public APIs and writing into Firestore via the Firebase Admin SDK. This avoids Firebase Cloud Functions, which requires a billing account even though usage itself would stay free.
- **Data source:** Polymarket's public, free, unauthenticated read APIs:
  - Gamma API (`https://gamma-api.polymarket.com`) — discover events/markets: `/events`, `/markets`, `/public-search`.
  - CLOB API (`https://clob.polymarket.com`) — prices and history: `/price`, `/prices`, `/book`, `/prices-history`.
  - Data API (`https://data-api.polymarket.com`) — wallet-level data: `/trades` (supports `?user=<address>` and, worth testing, likely a market filter too), `/positions?user=<address>`, `/activity?user=<address>`.
  - All of the above are public/free/no-auth for reading. Rate limits are generous (hundreds of requests per 10 seconds on the endpoints above) — nowhere near a limit at personal-project polling frequency.
  - **Unverified, test this first:** exactly how far back `/trades` and `/prices-history` go, and roughly how many distinct wallets trade a typical match. Don't assume — make a real call and look.

## Data model (Firestore collections)

```
matches/{matchId}
  competition: "EPL" | "UCL" | "UEL" | "UECL"
  homeTeam, awayTeam
  kickoffTime
  polymarketMarketId
  resolved: boolean
  result: "home" | "draw" | "away" | null

matches/{matchId}/snapshots/{snapshotId}
  capturedAt
  minutesBeforeKickoff        // e.g. 60, 15, 10 — the checkpoints we're testing
  prices: { home, draw, away }   // Polymarket implied probabilities at this moment
  liquidity

matches/{matchId}/trades/{tradeId}      // Tier 1: wide, cheap, log everyone
  wallet
  side
  size
  price
  timestamp

wallets/{walletAddress}
  totalResolvedTrades
  aggregateWinRate            // sample-size-adjusted (shrinkage), not raw
  aggregateROI
  tier: "watch" | "unranked"  // Tier 2 promotion status
  bySlice: {
    byCompetition: { EPL: {...}, UCL: {...}, UEL: {...} }
    byTeam: { "Newcastle United": {...}, ... }
  }
  lastUpdated

confluenceScores/{scoreId}
  matchId, snapshotId
  minutesBeforeKickoff
  probabilityEstimate         // our estimate, translated from the raw score
  marketImpliedProbability    // from the matching snapshot's price
  edge                        // probabilityEstimate - marketImpliedProbability
  breakdown: { ... }          // which wallets/signals drove this, and how much
  frozenAt

paperBets/{betId}             // the user's own simulated ledger — separate from wallets
  matchId, scoreId
  edgeAtBet
  stake
  outcome: "win" | "loss" | "pending"
  pnl
  placedAt, settledAt
```

## Wallet tracking logic (two-tier)

1. **Tier 1 (everyone, cheap):** every trade on every watched market gets logged to `matches/{matchId}/trades`, no filtering, no judgment. This is what makes new-wallet discovery automatic later — nobody has to notice a wallet early by hand.
2. **Tier 2 (promoted, ranked):** on a schedule (e.g. daily), recompute `wallets/{walletAddress}` for every wallet with enough resolved trades to say anything meaningful (set a minimum, e.g. 8-10 resolved trades). Use a shrinkage-adjusted win rate (pull small-sample wallets toward the overall average, proportional to how small their sample is) so lucky newcomers don't outrank proven ones. Promote to `tier: "watch"` only once both an activity bar and a quality bar are cleared. Compute the same stats sliced `byCompetition` and `byTeam`, with the same shrinkage applied per slice, falling back to the wallet's aggregate number whenever a slice's sample is too small to trust.
3. **Backfill:** before relying only on live data, pull already-resolved matches from earlier this season (Polymarket's `/trades` reads on-chain history, so this should be possible) so wallets don't all start at zero.

## Timing snapshots

Don't freeze one score right before kickoff. Take snapshots at multiple checkpoints counting down to kickoff — start with roughly 60, 15, and 10 minutes before, refine to finer granularity later once there's enough data to know it's worth it. Save every snapshot, tagged with `minutesBeforeKickoff`, so which checkpoint is actually best can be analyzed later — that question can't be answered retroactively if the snapshots weren't taken.

## Milestones

Work through these roughly in order. Each one should be small enough to actually finish and check before starting the next. Below each milestone is a ready-to-paste prompt for a fresh Claude Code session — paste the milestone prompt, and tell that session to read this file (`PROJECT.md`) first.

---

### Milestone 1 — Get real Polymarket data flowing

Goal: prove the data pipeline works before anything depends on it. No scoring, no wallets yet, no UI.

> **Prompt:**
> Read PROJECT.md in this repo for full context. Set up a Node.js (or Python, your choice — pick whichever you're more confident writing clean, well-tested code in) script that:
> 1. Calls Polymarket's Gamma API to find current and recent EPL, Champions League, and Europa League match markets.
> 2. For each match found, calls the CLOB API's `/prices-history` to test how far back price history actually goes for one real market, and prints/logs what you find.
> 3. Calls the Data API's `/trades` endpoint for one real match's market and inspects the response — how many distinct wallets appear, what fields are returned, and whether trades can be filtered by market.
> 4. Writes a short findings summary back into PROJECT.md (or a new NOTES.md) documenting the real answers to the two "unverified" questions in the Data Model section, so we stop guessing.
> Do not build Firestore integration yet — this milestone is only about confirming what the Polymarket API actually returns. Keep it a throwaway script, not production code.

---

### Milestone 2 — Firestore + scheduled collection

Goal: the pipeline described in "Data model" and "Tech stack" actually running on a schedule, writing real data.

> **Prompt:**
> Read PROJECT.md for context, including the findings from Milestone 1 (check NOTES.md if it exists). Set up a Firebase project (Firestore, free Spark plan) and the collections described in the Data model section. Write a script that pulls current Polymarket data for EPL/UCL/UEL matches (fixtures, price snapshots, and Tier 1 trade logs — see "Wallet tracking logic") and writes it into Firestore using the Firebase Admin SDK. Then wire this script up to run on a schedule via a GitHub Action (not Firebase Cloud Functions — we're avoiding that specifically to not need a billing account). Confirm it runs successfully at least twice on its schedule before considering this done.

---

### Milestone 3 — Backfill + wallet ranking

Goal: Tier 2 of the wallet logic — turning the raw trade log into an actual ranked watchlist.

> **Prompt:**
> Read PROJECT.md for full context on the two-tier wallet system. First, write a backfill script that pulls already-resolved matches from earlier this season and logs their historical trades into the same `trades` structure, so wallets don't start with zero history. Then write the Tier 2 job: for every wallet with enough resolved trades, compute a shrinkage-adjusted win rate and ROI, both in aggregate and sliced by competition and by team (falling back to the aggregate number when a slice's sample is too small — pick and document a reasonable minimum sample threshold). Promote qualifying wallets to `tier: "watch"`. Run this as a scheduled job (daily is fine) via GitHub Actions, same pattern as Milestone 2.

---

### Milestone 4 — The confluence/edge scoring engine

Goal: turn the watchlisted wallets' activity plus price data into the actual score described in "Why edge, not just confidence."

> **Prompt:**
> Read PROJECT.md, especially the "Why edge, not just confidence" and "Timing snapshots" sections. Write the scoring job: for each upcoming match, at each timing checkpoint (60/15/10 minutes before kickoff to start), compute a simple, transparent weighted score from the watchlisted wallets' current activity on that match, translate it into an estimated probability, compare it against the market-implied probability from the matching price snapshot, and store the result — score, probability estimate, market probability, edge, and a full breakdown of which wallets contributed — in the `confluenceScores` collection, exactly as described in the Data model. Do not use machine learning here; use a documented, simple weighting scheme and write down the weights you chose and why.

---

### Milestone 5 — The paper-bet simulator (the user's own ledger)

Goal: a simple, separate simulation of "what if I bet whenever the edge crosses a threshold."

> **Prompt:**
> Read PROJECT.md, especially the "Hard constraints" note that the user's paper ledger is NOT part of the wallet-ranking system and needs its own separate data/presentation. Write a job that, for every frozen confluence score, applies a simple rule (start with: bet a flat stake whenever edge exceeds a threshold, e.g. a meaningful positive edge — make the threshold configurable) and logs the resulting simulated bet into `paperBets`. Once matches resolve, settle those bets (win/loss, pnl) automatically. This should produce enough data to compute a running fake bankroll, win rate, and ROI — but don't build the dashboard for it yet, just get the data itself correct and settling properly.

---

### Milestone 6 — Dashboard (Vercel)

Goal: a real webpage, but only after everything above is solid. Do not start this early.

> **Prompt:**
> Read PROJECT.md for full context. Build a Vercel-hosted web app (framework your choice, but something that supports a clean, modern, responsive design working well on both desktop and phone — this matters to the user) that reads from Firestore and shows: a list of upcoming/recent matches with their current confluence score and edge; a per-match detail view with the full score breakdown and price history chart; a wallet leaderboard (tier: "watch" wallets, with aggregate and sliced stats); and a clearly separate "my performance" section showing the paper-bet ledger's running bankroll, win rate, and ROI — kept visually and structurally apart from the wallet leaderboard. Keep the visual design clean and modern but don't over-invest in styling choices yet — the user plans to provide specific design inspiration (sites/URLs) before a final visual pass.

---

## Open questions to keep in mind, not blockers

- Exact minimum sample size before trusting a wallet or a slice — start with a reasonable guess (e.g. 8-10 resolved trades) and revisit once real data shows how noisy small samples actually are here.
- Whether underdog-favoring edge or "meh," roughly-agrees-with-the-market edge turns out to be where the actual paper profit comes from — this is a real open question the user wants answered empirically, not assumed. Once Milestone 5 has real data, segment paper-bet profit by edge size and by favorite-vs-underdog and report back honestly, whichever way it points.
- Conference League as an optional side dataset — nice to have, never required, never mixed into the main analysis.
