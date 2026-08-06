import { getPool } from "./db.js";

async function main() {
  const pool = getPool();
  const { rows } = await pool.query("SELECT now() AS now");
  console.log("Connected. Server time:", rows[0].now);
  console.log("Supabase connection OK.");
  await pool.end();
}

main().catch((err) => {
  console.error("Connection check FAILED:", err.message);
  process.exit(1);
});
