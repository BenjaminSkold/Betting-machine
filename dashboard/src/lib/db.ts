// Server-only Turso (libSQL) client. Replaces the Postgres pool from the
// abandoned Supabase attempt.
import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;
export function getClient(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) {
      throw new Error("TURSO_DATABASE_URL is not set (dashboard/.env.local locally, or the Vercel project env var in production).");
    }
    client = createClient({ url, authToken });
  }
  return client;
}
