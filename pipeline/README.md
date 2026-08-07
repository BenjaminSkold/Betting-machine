# Confluence pipeline

Node.js scripts that pull Polymarket data and write aggregates to Turso + raw trades to Cloudflare R2 for the Confluence project — see `../PROJECT.md` for what this is and why, `../NOTES.md` for the real bugs found and fixed while building this and the reasoning behind every non-obvious choice below.

## Scripts

| Script | Milestone | What it does | Schedule |
|---|---|---|---|
| `src/collect.js` | 2 | Discovers live EPL/UCL/UEL matches, polls each one at the adaptive schedule's current cadence, writes a price snapshot to Turso and any new trades to R2, updates `pipeline_status.last_successful_run` | every 5 min (GitHub Actions; loops internally to hit tighter cadences — see PROJECT.md's "Adaptive polling schedule") |
| `src/backfill.js` | 3 | Historical backfill of last season's matches + trades for EPL/UCL/UEL, one bounded batch per run, resumable | every 3 hours (GitHub Actions) |
| `src/rankWallets.js` | 3 (Tier 2) | Reads resolved matches' trades from R2, computes shrinkage-adjusted win rate/ROI per wallet, writes only the summary to Turso, promotes to `tier:"watch"` | daily (GitHub Actions), plus immediately on match resolution (`recompute.js`) |
| `src/scoreMatches.js` | 4 | Confluence/edge score per match per snapshot, from watchlisted wallets' activity | every 5 min, after `collect.js` |
| `src/paperBets.js` | 5 | Places/settles the user's own flat-stake paper bets against frozen scores | every 5 min, after `scoreMatches.js` |

Run any of them locally with `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`/`R2_*` set (or drop them in `pipeline/.env`, loaded automatically via `dotenv`). `npm test` runs the `*.test.js` files (synthetic, hand-worked expected values — no live database/R2 access needed).

## Why Turso + R2, not one database

This project tried Firestore, then Postgres/Supabase, and hit the same underlying wall both times: raw trade data (millions of rows a season) doesn't fit in any single relational/document database's free tier once real volume exists, regardless of provider. See `../NOTES.md` for the full history of both lockouts. The fix here isn't a third database swap — it's splitting the data by access pattern: **Turso** holds the small, frequently-queried aggregates (matches, snapshots, wallets, scores, bets); **Cloudflare R2** holds the large, rarely-read raw trade archive as gzipped batch files, never as database rows. Nothing crosses from R2 back into a database except the tiny computed results `rankWallets.js` writes.

`src/db.js` wraps `@libsql/client`. `src/tradeArchive.js` wraps `@aws-sdk/client-s3` (R2 is S3-compatible) and includes a self-tracked usage guard — see PROJECT.md's "R2 usage guard" for why (enabling R2 required a card on file, unlike Turso).

## Schema

Table definitions live in `../turso/schema.sql`. Snapshots are append-only (one row per poll, not a fixed 60/15/10 set) under the adaptive schedule. Trades never appear in Turso at all — they're batched files in R2, keyed `trades/{matchId}/{pollTimestamp}.json.gz`, each trade carrying its natural id (`key`, from `tradeKey()`) so `readAllTradesForMatch` can dedupe if a retry ever wrote the same trades twice under different keys (R2 and Turso have no shared transaction, so this is possible in a narrow failure window — see NOTES.md).

## Resumability

`backfill.js` processes one bounded batch (default 15 matches) per invocation, checks `trades_backfilled` + condition ids before doing any work on a match, and stops itself early after a few consecutive failures rather than hammering a struggling service. Marking a match "backfilled" happens in the same Turso transaction as writing its snapshots (`withTransaction` in `db.js`) — a live bug once let a mid-match failure mark a match done with zero snapshots ever written, silently skipped forever after; this is what fixed it. `collect.js` keeps a per-market `lastSeenTimestamp` cursor so a rerun only fetches genuinely new trades, not a match's full history every poll.
