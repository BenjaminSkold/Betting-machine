// Postgres (Supabase) connection pool. Replaces firestoreRest.js.
//
// Firestore's REST client needed hand-rolled auth, request pacing, and
// 429 backoff because Firestore itself rate-limited sustained request
// volume. None of that applies here: `pg` pools connections and the
// Supabase pooler has no comparable per-request quota, so this is just a
// singleton Pool. Callers write plain SQL against it directly.
import "dotenv/config";
import pg from "pg";
import { tradeKey } from "./polymarket.js";

const { Pool, types } = pg;

// node-postgres returns NUMERIC and INT8 (bigint) columns as strings by
// default, to avoid silently losing precision beyond what JS numbers can
// represent exactly. This project's numeric columns (trade size/price,
// scores, etc.) came from Firestore, where every number was already an
// IEEE double -- there's no extra precision to protect here, and leaving
// them as strings is actively dangerous: `totalVolume += trade.size` would
// silently do string concatenation instead of addition. Parse both back to
// JS numbers globally instead of hunting down every arithmetic call site.
// Trade timestamps (unix seconds) are the only INT8 column and are nowhere
// near Number.MAX_SAFE_INTEGER, so parseInt is safe here specifically.
types.setTypeParser(1700 /* NUMERIC */, (val) => (val === null ? null : parseFloat(val)));
types.setTypeParser(20 /* INT8 */, (val) => (val === null ? null : parseInt(val, 10)));

let pool;
export function getPool() {
  if (!pool) {
    const connectionString = process.env.SUPABASE_DB_URL;
    if (!connectionString) {
      throw new Error("SUPABASE_DB_URL is not set (see pipeline/.env locally, or the GitHub Actions secret in CI).");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getMatchRow(client, eventId) {
  const { rows } = await client.query("SELECT * FROM matches WHERE event_id = $1", [eventId]);
  return rows[0] || null;
}

// `fields` uses the table's own snake_case column names directly -- this is
// trusted, application-defined data (never user input), so building the
// column/placeholder lists from Object.keys is safe. jsonb fields must be
// pre-stringified by the caller.
export async function upsertMatch(client, eventId, fields) {
  const cols = Object.keys(fields);
  const values = Object.values(fields);
  const setClause = cols.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
  const colList = ["event_id", ...cols].join(", ");
  const placeholders = cols.map((_, i) => `$${i + 2}`);
  await client.query(
    `INSERT INTO matches (${colList}) VALUES ($1, ${placeholders.join(", ")})
     ON CONFLICT (event_id) DO UPDATE SET ${setClause}, updated_at = now()`,
    [eventId, ...values]
  );
}

export async function getExistingSnapshotCheckpoints(client, matchId) {
  const { rows } = await client.query("SELECT checkpoint FROM snapshots WHERE match_id = $1", [matchId]);
  return new Set(rows.map((r) => r.checkpoint));
}

export async function insertSnapshot(client, matchId, checkpoint, data) {
  await client.query(
    `INSERT INTO snapshots (match_id, checkpoint, captured_at, minutes_before_kickoff, price_home, price_draw, price_away, liquidity, backfilled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (match_id, checkpoint) DO NOTHING`,
    [
      matchId,
      String(checkpoint),
      data.capturedAt,
      data.minutesBeforeKickoff,
      data.prices.home,
      data.prices.draw,
      data.prices.away,
      data.liquidity,
      Boolean(data.backfilled),
    ]
  );
}

const TRADE_INSERT_CHUNK = 500;
const TRADE_COLS = ["id", "match_id", "condition_id", "wallet", "side", "size", "price", "timestamp", "outcome"];

// Trade rows are keyed by the same natural id Firestore used
// (transactionHash_asset_outcomeIndex) with ON CONFLICT DO NOTHING, so
// re-inserting trades the cursor already accounted for is a harmless no-op.
// That makes this naturally idempotent against a crash between inserting
// trades and updating the match's cursor -- unlike Firestore, correctness
// here doesn't depend on both landing in the same atomic write.
export async function insertTrades(client, matchId, trades) {
  for (let i = 0; i < trades.length; i += TRADE_INSERT_CHUNK) {
    const group = trades.slice(i, i + TRADE_INSERT_CHUNK);
    const values = [];
    const params = [];
    group.forEach((t, idx) => {
      const base = idx * TRADE_COLS.length;
      values.push(`(${TRADE_COLS.map((_, j) => `$${base + j + 1}`).join(", ")})`);
      params.push(tradeKey(t), matchId, t.conditionId, t.proxyWallet, t.side, t.size, t.price, t.timestamp, t.outcome);
    });
    await client.query(
      `INSERT INTO trades (${TRADE_COLS.join(", ")}) VALUES ${values.join(", ")} ON CONFLICT (id) DO NOTHING`,
      params
    );
  }
}
