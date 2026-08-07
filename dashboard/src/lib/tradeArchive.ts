// Read-only client for the raw trade archive on Cloudflare R2. Mirrors
// pipeline/src/tradeArchive.js's read side (including its usage guard) --
// the dashboard never writes trade data, only the pipeline does.
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { gunzipSync } from "node:zlib";
import { getClient } from "./db";
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
    s3 = new S3Client({ region: "auto", endpoint: `https://${accountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey } });
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

async function assertReadAllowed(): Promise<void> {
  const { rows } = await getClient().execute({
    sql: "SELECT value FROM usage_stats WHERE metric = 'r2_class_b_ops' AND period = ?",
    args: [currentMonthPeriod()],
  });
  const classBOps = rows.length > 0 ? Number(rows[0].value) : 0;
  if (classBOps + 1 > R2_CLASS_B_SAFETY_LIMIT) {
    throw new Error(`R2 usage guard: this month's read operation count (${classBOps}) is at the safety limit. Refusing to read.`);
  }
}

async function incrementReadUsage(): Promise<void> {
  await getClient().execute({
    sql: `INSERT INTO usage_stats (metric, period, value) VALUES ('r2_class_b_ops', ?, 1)
          ON CONFLICT(metric, period) DO UPDATE SET value = value + 1`,
    args: [currentMonthPeriod()],
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
  await assertReadAllowed();
  const res = await getS3Client().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
  await incrementReadUsage();
  const compressed = Buffer.from(await res.Body!.transformToByteArray());
  return JSON.parse(gunzipSync(compressed).toString("utf8"));
}

export async function readAllTradesForMatch(matchId: string): Promise<RawTrade[]> {
  const keys = await listTradeBatchKeys(matchId);
  const batches = await Promise.all(keys.map(readTradeBatch));
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
