# Confluence pipeline

Node.js scripts that pull Polymarket data and read/write Firestore for the Confluence project — see `../PROJECT.md` for what this is and why, `../NOTES.md` for the real bugs found and fixed while building this and the reasoning behind every non-obvious choice below.

## Scripts

| Script | Milestone | What it does | Schedule |
|---|---|---|---|
| `src/collect.js` | 2 | Discovers live EPL/UCL/UEL matches, writes price snapshots at the 60/15/10-min checkpoints, logs new Tier 1 trades, writes `_system/status.lastSuccessfulRun` | every 15 min (GitHub Actions) |
| `src/backfill.js` | 3 | One-time backfill of last season's matches + trades for EPL/UCL/UEL, resumable | manual (`npm run backfill`) |
| `src/rankWallets.js` | 3 (Tier 2) | Shrinkage-adjusted win rate/ROI per wallet, sliced by competition/team, promotes to `tier:"watch"` | daily (GitHub Actions) |
| `src/scoreMatches.js` | 4 | Confluence/edge score per match per checkpoint, from watchlisted wallets' activity | every 15 min, after `collect.js` |
| `src/paperBets.js` | 5 | Places/settles the user's own flat-stake paper bets against frozen scores | every 15 min, after `scoreMatches.js` |

Run any of them locally with `GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node src/<script>.js`. `npm test` runs the `*.test.js` files (synthetic, hand-worked expected values — no Firestore access needed).

## Why no Firebase Admin SDK

`src/firestoreRest.js` is a hand-rolled REST client, not `firebase-admin`. On this network, the Admin SDK's write path took ~90 seconds per call (almost certainly an initial gRPC connection attempt timing out before falling back to something usable), which looked exactly like a hung/throttled Firestore project until it was isolated with a raw authenticated REST call (272ms, no issue at all). Full story in `../NOTES.md`. If you're tempted to switch back to the Admin SDK for convenience, test write latency on your actual network first.

## Why trades are batched, not one-doc-per-trade

PROJECT.md's data model literally specifies `matches/{matchId}/trades/{tradeId}` — one document per trade. That blew through Firestore's write-quota headroom almost immediately (a single active match can have 1,000-2,000+ trades). `src/tradeBatches.js` chunks trades into ~300-per-document arrays instead (`matches/{matchId}/tradeBatches/{batchId}`), cutting writes by ~270x. Nothing downstream needs a per-trade document — `rankWallets.js` and `scoreMatches.js` both read and flatten every trade in memory regardless.

## Why every write goes through one atomic batch commit per match

Each match's writes (the match doc, any due snapshots, all trade-batch chunks, the live-collection cursor update) are combined into a single `batch.commit()` — not because Firestore requires it, but because this project's real write-rate ceiling turned out to be much lower than documented free-tier quotas would suggest (see the write-quota saga in `../NOTES.md`). Fewer write *requests* per match matters more than fewer *documents* once you're this close to a throttle.

## Resumability

`backfill.js` is safe to kill and rerun at any point — it checks `tradesBackfilled && marketConditionIds` on each match before doing any work, and retries a failing match with cooldown (30/60/90s) before giving up on it and moving to the next (logged at the end so you know what to rerun). `collect.js` keeps a per-market `lastSeenTimestamp` cursor so a rerun only fetches genuinely new trades, not a match's full history every 15 minutes.

## Known limitation

As of this writing, this Firestore project has an unresolved write throttle (`RESOURCE_EXHAUSTED`) that doesn't match any documented daily quota math for the data volumes actually involved — see `../NOTES.md`'s "Status" section for the live details and what to do once it clears.
