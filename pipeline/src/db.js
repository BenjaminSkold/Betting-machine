// Turso (libSQL) client. Replaces the Postgres pool from the abandoned
// Supabase attempt. Raw trades are never queried here -- see
// tradeArchive.js for R2.
import "dotenv/config";
import { createClient } from "@libsql/client";

let client;
export function getClient() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) {
      throw new Error("TURSO_DATABASE_URL is not set (see pipeline/.env locally, or the GitHub Actions secret in CI).");
    }
    client = createClient({ url, authToken });
  }
  return client;
}

// SQLite has no native boolean -- convert JS booleans to 0/1 at the
// boundary. Other JS values pass through unchanged (libSQL's client
// already handles numbers/strings/null natively).
function toSqliteValue(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

// A live smoke test caught a real bug this exists to prevent: backfill.js
// used to call upsertMatch(..., {trades_backfilled: true}) BEFORE writing
// that match's snapshots, so a failure in between left the match
// permanently marked done with no snapshots ever written -- silently
// skipped forever on every future run. Wrapping the "mark as processed"
// write together with its snapshot writes means a mid-match failure rolls
// back cleanly and the next run retries the whole match, not half of it.
// `fn` receives a transaction object with the same `.execute()` shape as
// the regular client, so upsertMatch/insertSnapshot work unchanged with it.
export async function withTransaction(client, fn) {
  const tx = await client.transaction("write");
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export async function getMatchRow(client, eventId) {
  const { rows } = await client.execute({ sql: "SELECT * FROM matches WHERE event_id = ?", args: [eventId] });
  return rows[0] || null;
}

// `fields` uses the table's own snake_case column names directly -- this is
// trusted, application-defined data (never user input), so building the
// column/placeholder lists from Object.keys is safe. JSON-shaped fields
// must be pre-stringified by the caller.
export async function upsertMatch(client, eventId, fields) {
  // updated_at is set here, not by callers -- it was forgotten at every
  // call site once (matches.updated_at is NOT NULL with no SQL-side
  // default, since SQLite's CURRENT_TIMESTAMP formats differently than the
  // ISO strings used everywhere else), which failed every single upsert
  // until caught by a live smoke test. Centralizing it means it can't be
  // forgotten again.
  const allFields = { ...fields, updated_at: new Date().toISOString() };
  const cols = Object.keys(allFields);
  const values = cols.map((c) => toSqliteValue(allFields[c]));
  const setClause = cols.map((c) => `${c} = excluded.${c}`).join(", ");
  const colList = ["event_id", ...cols].join(", ");
  const placeholders = cols.map(() => "?").join(", ");
  await client.execute({
    sql: `INSERT INTO matches (${colList}) VALUES (?, ${placeholders})
          ON CONFLICT(event_id) DO UPDATE SET ${setClause}`,
    args: [eventId, ...values],
  });
}

// Snapshots are append-only (one row per poll, not upserted into a fixed
// set of checkpoints) -- the adaptive polling schedule means the number of
// snapshots per match varies, so there's nothing to check for existence.
export async function insertSnapshot(client, matchId, data) {
  await client.execute({
    sql: `INSERT INTO snapshots (match_id, captured_at, minutes_before_kickoff, price_home, price_draw, price_away, liquidity, backfilled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      matchId,
      data.capturedAt,
      data.minutesBeforeKickoff,
      data.prices.home,
      data.prices.draw,
      data.prices.away,
      data.liquidity,
      toSqliteValue(Boolean(data.backfilled)),
    ],
  });
}
