// Raw trade archive on Cloudflare R2. This is the reason raw trades no
// longer live in a database at all: one row per fill was what blew through
// Firestore's and then Supabase's free-tier storage caps. R2's free tier
// (10GB storage, 1M write-type ops/month, 10M read-type ops/month, zero
// egress fees) plus gzip-compressed batched files gets us an order of
// magnitude more headroom for the same data.
//
// One file per poll per match -- never one write per trade (see
// PROJECT.md's "Batching writes"). A poll that saw zero new trades writes
// nothing.
//
// Every write goes through a usage guard first (see below) -- unlike
// Turso, enabling R2 at all required putting a card on file, so silently
// drifting past the free tier here means a real charge, not just a
// lockout. The guard is self-tracked in Turso rather than trusting
// Cloudflare's own (slightly-delayed) usage dashboard.
import "dotenv/config";
import { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { gzipSync, gunzipSync } from "node:zlib";

let s3;
function getS3Client() {
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
    });
  }
  return s3;
}

function bucketName() {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME is not set.");
  return bucket;
}

function keyFor(matchId, pollTimestamp) {
  return `trades/${matchId}/${pollTimestamp}.json.gz`;
}

// --- Usage guard -----------------------------------------------------
// Tripped at 80% of Cloudflare's published free-tier numbers (10GB
// storage, 1M Class A ops/month, 10M Class B ops/month), leaving headroom
// for any drift between what we've counted and what R2 actually bills
// (e.g. object metadata overhead we don't account for byte-for-byte).
const R2_STORAGE_SAFETY_LIMIT_BYTES = 8 * 1024 ** 3;
const R2_CLASS_A_SAFETY_LIMIT = 800_000;
const R2_CLASS_B_SAFETY_LIMIT = 8_000_000;

function currentMonthPeriod() {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

async function getUsage(client, metric, period) {
  const { rows } = await client.execute({ sql: "SELECT value FROM usage_stats WHERE metric = ? AND period = ?", args: [metric, period] });
  return rows.length > 0 ? Number(rows[0].value) : 0;
}

async function incrementUsage(client, metric, period, amount) {
  await client.execute({
    sql: `INSERT INTO usage_stats (metric, period, value) VALUES (?, ?, ?)
          ON CONFLICT(metric, period) DO UPDATE SET value = value + excluded.value`,
    args: [metric, period, amount],
  });
}

// Throws rather than silently proceeding once within the safety margin --
// a loud, obvious failure here (a job errors, gets noticed) is a much
// better outcome than a quiet drift into a real Cloudflare bill.
async function assertWriteAllowed(client, addedBytes) {
  const period = currentMonthPeriod();
  const [bytesStored, classAOps] = await Promise.all([getUsage(client, "r2_bytes_stored", "total"), getUsage(client, "r2_class_a_ops", period)]);
  if (bytesStored + addedBytes > R2_STORAGE_SAFETY_LIMIT_BYTES) {
    throw new Error(
      `R2 usage guard: writing ${addedBytes} more bytes would push total stored (${bytesStored}) past the 8GB safety limit (80% of R2's 10GB free tier). Refusing to write.`
    );
  }
  if (classAOps + 1 > R2_CLASS_A_SAFETY_LIMIT) {
    throw new Error(
      `R2 usage guard: this month's write/list operation count (${classAOps}) is at the 800k safety limit (80% of R2's 1M/month free tier). Refusing to write.`
    );
  }
}

async function assertReadAllowed(client) {
  const classBOps = await getUsage(client, "r2_class_b_ops", currentMonthPeriod());
  if (classBOps + 1 > R2_CLASS_B_SAFETY_LIMIT) {
    throw new Error(
      `R2 usage guard: this month's read operation count (${classBOps}) is at the 8M safety limit (80% of R2's 10M/month free tier). Refusing to read.`
    );
  }
}
// -----------------------------------------------------------------------

// trades: array of {wallet, side, size, price, timestamp, outcome, conditionId}.
// Writes nothing and returns null if the batch is empty -- a poll with no
// new trades shouldn't cost a write.
export async function writeTradeBatch(client, matchId, pollTimestamp, trades) {
  if (trades.length === 0) return null;
  const body = gzipSync(Buffer.from(JSON.stringify(trades)));

  await assertWriteAllowed(client, body.length);
  const key = keyFor(matchId, pollTimestamp);
  await getS3Client().send(new PutObjectCommand({ Bucket: bucketName(), Key: key, Body: body, ContentType: "application/json", ContentEncoding: "gzip" }));
  await incrementUsage(client, "r2_bytes_stored", "total", body.length);
  await incrementUsage(client, "r2_class_a_ops", currentMonthPeriod(), 1);
  return key;
}

async function listTradeBatchKeys(client, matchId) {
  const keys = [];
  let continuationToken;
  do {
    await assertWriteAllowed(client, 0); // ListObjects is a Class A op, same as writes
    const res = await getS3Client().send(
      new ListObjectsV2Command({ Bucket: bucketName(), Prefix: `trades/${matchId}/`, ContinuationToken: continuationToken })
    );
    await incrementUsage(client, "r2_class_a_ops", currentMonthPeriod(), 1);
    for (const obj of res.Contents || []) keys.push(obj.Key);
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

async function readTradeBatch(client, key) {
  await assertReadAllowed(client);
  const res = await getS3Client().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
  await incrementUsage(client, "r2_class_b_ops", currentMonthPeriod(), 1);
  const compressed = Buffer.from(await res.Body.transformToByteArray());
  return JSON.parse(gunzipSync(compressed).toString("utf8"));
}

// Reads and flattens every batched trade file for one match. Used by
// rankWallets.js (resolved matches, once per run) and scoreMatches.js
// (upcoming matches, every run) -- the aggregation that used to be a SQL
// query against a trades table is now this plus in-memory JS grouping.
export async function readAllTradesForMatch(client, matchId) {
  const keys = await listTradeBatchKeys(client, matchId);
  const batches = await Promise.all(keys.map((key) => readTradeBatch(client, key)));
  const trades = batches.flat();

  // Collapse duplicates by natural trade key -- see collect.js/backfill.js's
  // toStoredTrade comment for why a retry can legitimately write the same
  // trade twice under two different R2 object keys. Trades written before
  // this field existed have no `key` and pass through unfiltered (nothing
  // to dedupe against for that batch anyway).
  const seen = new Set();
  const deduped = [];
  for (const t of trades) {
    if (t.key && seen.has(t.key)) continue;
    if (t.key) seen.add(t.key);
    deduped.push(t);
  }
  return deduped;
}
