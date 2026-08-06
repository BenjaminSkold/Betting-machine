# Confluence

A personal, single-user research tool that watches Polymarket's prediction markets for Premier League, Champions League, and Europa League matches, tracks which wallets are consistently right, and computes an "edge" — how far our estimate (based on those wallets' current activity) disagrees with what the market is already pricing in. Every recommendation is logged as a **fake bet with fake money** — nothing here ever touches a real account or places a real trade, and real money is not a planned future phase; see `PROJECT.md`'s hard constraints for the full reasoning.

## Start here

- **[`PROJECT.md`](./PROJECT.md)** — the project brief. Read this first; every design decision in this repo traces back to it.
- **[`NOTES.md`](./NOTES.md)** — the running log of real findings: what's actually true about Polymarket's APIs (not assumed), every non-obvious bug hit while building this and how it was actually fixed, and the current status of anything still in progress or blocked.

## Layout

| Path | What it is |
|---|---|
| `pipeline/` | Node.js scripts that pull Polymarket data and read/write Supabase (Postgres), run on a schedule via GitHub Actions. See `pipeline/README.md`. |
| `dashboard/` | Next.js dashboard reading the same Supabase data, read-only. See `dashboard/README.md`. Not deployed yet — local only. |
| `milestone1-probe/` | Throwaway script from the very first milestone (verifying what Polymarket's APIs actually return before building anything real on top of them). Kept for reference, not part of the running system. |

## Status

Migrated off Firestore to Supabase (Postgres) after hitting a write-rate ceiling far below documented free-tier quotas, then a comparable read-quota wall — see `NOTES.md` for the full history. The dashboard and pipeline now both read/write the same Postgres database directly.
