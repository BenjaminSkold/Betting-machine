// Server-only Postgres (Supabase) pool. Replaces firestore.ts.
import pg from "pg";

const { Pool, types } = pg;

// See pipeline/src/db.js's identical setup for why: node-postgres returns
// NUMERIC/INT8 columns as strings by default, which silently breaks plain
// `+`/`+=` arithmetic on them (string concatenation instead of addition).
// Every number in this schema originated as a Firestore double, so there's
// no extra precision to protect by leaving them as strings.
types.setTypeParser(1700 /* NUMERIC */, (val: string | null) => (val === null ? null : parseFloat(val)));
types.setTypeParser(20 /* INT8 */, (val: string | null) => (val === null ? null : parseInt(val, 10)));

let pool: pg.Pool | null = null;
export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.SUPABASE_DB_URL;
    if (!connectionString) {
      throw new Error("SUPABASE_DB_URL is not set (dashboard/.env.local locally, or the Vercel project env var in production).");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}
