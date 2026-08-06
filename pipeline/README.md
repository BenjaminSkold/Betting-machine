# Confluence pipeline

Node.js scripts that pull Polymarket data and read/write Supabase (Postgres) for the Confluence project — see `../PROJECT.md` for what this is and why, `../NOTES.md` for the real bugs found and fixed while building this and the reasoning behind every non-obvious choice below.

## Scripts

| Script | Milestone | What it does | Schedule |
|---|---|---|---|
| `src/collect.js` | 2 | Discovers live EPL/UCL/UEL matches, writes price snapshots at the 60/15/10-min checkpoints, logs new Tier 1 trades, updates `pipeline_status.last_successful_run` | every 15 min (GitHub Actions) |
| `src/backfill.js` | 3 | One-time backfill of last season's matches + trades for EPL/UCL/UEL, resumable | manual (`npm run backfill`) |
| `src/rankWallets.js` | 3 (Tier 2) | Shrinkage-adjusted win rate/ROI per wallet, sliced by competition/team, promotes to `tier:"watch"` | daily (GitHub Actions) |
| `src/scoreMatches.js` | 4 | Confluence/edge score per match per checkpoint, from watchlisted wallets' activity | every 15 min, after `collect.js` |
| `src/paperBets.js` | 5 | Places/settles the user's own flat-stake paper bets against frozen scores | every 15 min, after `scoreMatches.js` |

Run any of them locally with `SUPABASE_DB_URL=postgresql://... node src/<script>.js` (or drop it in `pipeline/.env`, loaded automatically via `dotenv`). `npm test` runs the `*.test.js` files (synthetic, hand-worked expected values — no database access needed).

## Why Postgres, not Firestore

This project originally ran on Firestore. It hit two compounding problems there: a write-rate ceiling far below documented free-tier quotas (`RESOURCE_EXHAUSTED` after ~10 matches' worth of per-trade writes), and later a comparable read-quota wall once `rankWallets.js`/`scoreMatches.js` needed to scan the full `matches` collection every run. Both problems are specific to Firestore's request-based quota model — Postgres has no equivalent per-request throttle, so the migration also let several Firestore-specific workarounds get deleted outright rather than ported: trade array-batching (`tradeBatches.js`), the straight-from-Polymarket read-quota bypass in `rankWallets.js`/`scoreMatches.js` (and their local resume caches), and the one-wallet-at-a-time paced writes. See `../NOTES.md` for the full history of what was actually hit and when.

`src/db.js` is a thin wrapper around `pg` (node-postgres) — a real client library, not a hand-rolled REST client like Firestore needed. One thing it does set globally: node-postgres returns `NUMERIC`/`BIGINT` columns as strings by default, which would silently break plain `+=` arithmetic elsewhere in this codebase, so `db.js` registers type parsers to get plain JS numbers back.

## Schema

Table definitions live in `../supabase/migrations/`. Trades are one row per trade (`trades`, keyed by `{transactionHash}_{asset}_{outcomeIndex}`, same natural key Firestore used) — no batching needed once Firestore's write-quota constraint was gone.

## Resumability

`backfill.js` is safe to kill and rerun at any point — it checks `trades_backfilled` and that condition ids are populated on each match before doing any work, and retries a failing match with cooldown (5/10/15s) before giving up on it and moving to the next (logged at the end so you know what to rerun). `collect.js` keeps a per-market `last_seen_timestamp` cursor so a rerun only fetches genuinely new trades, not a match's full history every 15 minutes — and since trade rows upsert on a natural id (`ON CONFLICT DO NOTHING`), a crash between inserting trades and updating that cursor just means the same (already-stored) trades get harmlessly re-fetched and no-op'd next run, not double-counted.
