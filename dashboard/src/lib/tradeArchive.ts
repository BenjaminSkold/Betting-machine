// Read-only client for the raw trade archive on Cloudflare R2. Mirrors
// pipeline/src/tradeArchive.js's read side (including its usage guard) --
// the dashboard never writes trade data, only the pipeline does.
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { gunzipSync } from "node:zlib";
import { getClient } from "./db";
import { mapWithConcurrency } from "./concurrency";
import type { RawTrade } from "./types";

let s3: S3Client | null = null;
function getS3Client(): S3Client {
  if (!s3) {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!accountId || !accessKeyId || !secretAccessKey) {
      throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY must all be set.");
    }
    s3 = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      // Default maxSockets (50) was hit live once real match volume existed
      // (300+ matches, each needing a LIST + several GETs). Raising this
      // lets mapWithConcurrency actually use higher concurrency safely
      // instead of just avoiding the crash at a slow, low limit.
      requestHandler: new NodeHttpHandler({ httpsAgent: { maxSockets: 200 } }),
    });
  }
  return s3;
}

function bucketName(): string {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME is not set.");
  return bucket;
}

// See pipeline/src/tradeArchive.js for the write-side half of this guard
// and why it exists (R2 required a card on file to enable at all). This
// half only needs to protect against read-operation overage.
const R2_CLASS_B_SAFETY_LIMIT = 8_000_000; // 80% of R2's 10M reads/month free tier

function currentMonthPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

// Checked/incremented once per match (covering every batch file that match
// needs) rather than once per object read. The original per-object version
// put a Turso round trip before AND after every single GetObjectCommand --
// with pages scanning 150+ matches at several batch files each, that was
// thousands of serialized Turso round trips and was the actual dominant
// cost of the wallet detail page's slow load (not R2/socket throughput,
// which raising maxSockets confirmed by leaving load time basically
// unchanged). Per-match granularity is still precise enough for a guard
// whose whole job is staying under 80% of a monthly quota.
async function assertReadAllowed(count: number): Promise<void> {
  const { rows } = await getClient().execute({
    sql: "SELECT value FROM usage_stats WHERE metric = 'r2_class_b_ops' AND period = ?",
    args: [currentMonthPeriod()],
  });
  const classBOps = rows.length > 0 ? Number(rows[0].value) : 0;
  if (classBOps + count > R2_CLASS_B_SAFETY_LIMIT) {
    throw new Error(`R2 usage guard: this month's read operation count (${classBOps}) is at the safety limit. Refusing to read.`);
  }
}

async function incrementReadUsage(count: number): Promise<void> {
  if (count === 0) return;
  await getClient().execute({
    sql: `INSERT INTO usage_stats (metric, period, value) VALUES ('r2_class_b_ops', ?, ?)
          ON CONFLICT(metric, period) DO UPDATE SET value = value + ?`,
    args: [currentMonthPeriod(), count, count],
  });
}

async function listTradeBatchKeys(matchId: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await getS3Client().send(
      new ListObjectsV2Command({ Bucket: bucketName(), Prefix: `trades/${matchId}/`, ContinuationToken: continuationToken })
    );
    for (const obj of res.Contents || []) if (obj.Key) keys.push(obj.Key);
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

async function readTradeBatch(key: string): Promise<RawTrade[]> {
  const res = await getS3Client().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
  const compressed = Buffer.from(await res.Body!.transformToByteArray());
  return JSON.parse(gunzipSync(compressed).toString("utf8"));
}

export async function readAllTradesForMatch(matchId: string): Promise<RawTrade[]> {
  const keys = await listTradeBatchKeys(matchId);
  if (keys.length === 0) return [];
  await assertReadAllowed(keys.length);
  const batches = await mapWithConcurrency(keys, 10, readTradeBatch);
  await incrementReadUsage(keys.length);
  const trades = batches.flat();

  // Collapse duplicates by natural trade key -- see pipeline/src/tradeArchive.js's
  // identical logic and comment for why a retry can legitimately write the
  // same trade twice under two different R2 object keys.
  const seen = new Set<string>();
  const deduped: RawTrade[] = [];
  for (const t of trades) {
    if (t.key && seen.has(t.key)) continue;
    if (t.key) seen.add(t.key);
    deduped.push(t);
  }
  return deduped;
}
