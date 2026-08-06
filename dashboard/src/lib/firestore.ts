// Read-only server-side Firestore REST client — same approach as
// pipeline/src/firestoreRest.js (see that file's comment for why this
// bypasses the firebase-admin SDK). Only get/list are needed here; the
// dashboard never writes.
import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";

function loadCredential(): { project_id: string; [key: string]: unknown } {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
  }
  throw new Error(
    "No Firebase credentials found. Set GOOGLE_APPLICATION_CREDENTIALS (local, path to key file) " +
      "or FIREBASE_SERVICE_ACCOUNT_JSON (Vercel env var, raw JSON content)."
  );
}

let authClient: Awaited<ReturnType<GoogleAuth["getClient"]>> | null = null;
async function getToken(): Promise<string> {
  if (!authClient) {
    const credentials = loadCredential();
    // datastore.readonly returns ACCESS_TOKEN_SCOPE_INSUFFICIENT against
    // Firestore's v1 REST list/get methods in Native mode — the full
    // datastore scope is what actually works (same as the pipeline's
    // client). This module never issues a write regardless of what the
    // credential is capable of.
    const auth = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/datastore"] });
    authClient = await auth.getClient();
  }
  const { token } = await authClient.getAccessToken();
  if (!token) throw new Error("Failed to obtain Firestore access token");
  return token;
}

// Firestore's typed-value wire format decoders — see firestoreRest.js for
// the encoder side, which this dashboard doesn't need since it never writes.
type FirestoreValue = Record<string, unknown>;

function decodeValue(v: FirestoreValue | undefined): unknown {
  if (!v) return null;
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("arrayValue" in v) {
    const arr = v.arrayValue as { values?: FirestoreValue[] };
    return (arr.values || []).map(decodeValue);
  }
  if ("mapValue" in v) {
    const map = v.mapValue as { fields?: Record<string, FirestoreValue> };
    return decodeFields(map.fields || {});
  }
  if ("timestampValue" in v) return v.timestampValue;
  return null;
}

function decodeFields(fields: Record<string, FirestoreValue>): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) obj[k] = decodeValue(v);
  return obj;
}

const BASE = "https://firestore.googleapis.com/v1";

// Mirrors pipeline/src/firestoreRest.js's request() — same underlying
// project, same quota, same two gaps found there: no retry at all (a single
// transient 429 anywhere in a page's data fetch turned into a hard 500), and
// no spacing between requests (listCollection/listCollectionGroup's
// paginated calls fire back-to-back). See NOTES.md for how this was found.
const MIN_REQUEST_INTERVAL_MS = 1100;
let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceRequest(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
  lastRequestAt = Date.now();
}

async function request(url: string, init?: RequestInit, attempt = 1): Promise<{ status: number; body: unknown }> {
  await paceRequest();
  const token = await getToken();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
    cache: "no-store",
  });
  if (res.status === 404) return { status: 404, body: null };
  const text = await res.text();
  if ((res.status === 429 || res.status >= 500) && attempt <= 6) {
    const delayMs = 500 * 2 ** attempt; // 1s, 2s, 4s, 8s, 16s, 32s
    await sleep(delayMs);
    return request(url, init, attempt + 1);
  }
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Firestore REST ${init?.method ?? "GET"} ${url} -> ${res.status}: ${text.slice(0, 500)}`);
  return { status: res.status, body: parsed };
}

let cachedProjectId: string | null = null;
function projectId(): string {
  if (!cachedProjectId) cachedProjectId = loadCredential().project_id;
  return cachedProjectId;
}

export type Doc<T> = { id: string; data: T; parentId?: string };

export async function getDoc<T = Record<string, unknown>>(path: string): Promise<Doc<T> | null> {
  const url = `${BASE}/projects/${projectId()}/databases/(default)/documents/${path}`;
  const { status, body } = await request(url);
  if (status === 404) return null;
  const record = body as { name: string; fields?: Record<string, FirestoreValue> };
  return { id: path.split("/").pop()!, data: decodeFields(record.fields || {}) as T };
}

export async function listCollection<T = Record<string, unknown>>(path: string): Promise<Doc<T>[]> {
  const base = `${BASE}/projects/${projectId()}/databases/(default)/documents/${path}`;
  const docs: Doc<T>[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(base);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const { body } = await request(url.toString());
    const page = body as { documents?: { name: string; fields?: Record<string, FirestoreValue> }[]; nextPageToken?: string };
    for (const d of page.documents || []) {
      const id = d.name.split("/").pop()!;
      docs.push({ id, data: decodeFields(d.fields || {}) as T });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return docs;
}

// Fetches every document across every "{collectionId}" subcollection in the
// database in a bounded number of requests, instead of one request per
// parent — the fix for a real bug: N separate listCollection calls (one per
// match) queue behind Node's per-host connection limit and get slower as N
// grows (60 matches measured at ~24s total, even though each individual
// call is issued in parallel — Node's default per-host connection limit is
// well under 60). One collection-group query, paginated via a __name__
// cursor, replaces all of them; runQuery itself runs ~5s regardless of
// result size (collection-group queries have real Firestore-side cost this
// project hasn't amortized yet, separate from the connection-limit bug) —
// still a large net win over 24s, and it's one bounded cost instead of one
// that scales with match count.
export async function listCollectionGroup<T = Record<string, unknown>>(collectionId: string): Promise<Doc<T>[]> {
  const url = `${BASE}/projects/${projectId()}/databases/(default)/documents:runQuery`;
  const docs: Doc<T>[] = [];
  let cursor: string | null = null;

  while (true) {
    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId, allDescendants: true }],
      orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
      limit: 300,
    };
    if (cursor) structuredQuery.startAt = { values: [{ referenceValue: cursor }], before: false };

    const { body } = await request(url, { method: "POST", body: JSON.stringify({ structuredQuery }) });
    const page = body as { document?: { name: string; fields?: Record<string, FirestoreValue> } }[];
    let count = 0;
    let last: string | null = null;
    for (const entry of page) {
      if (!entry.document) continue;
      count++;
      last = entry.document.name;
      const parts = entry.document.name.split("/");
      const id = parts.pop()!;
      parts.pop(); // collectionId
      const parentId = parts.pop();
      docs.push({ id, parentId, data: decodeFields(entry.document.fields || {}) as T });
    }
    if (count < 300 || !last) break;
    cursor = last;
  }
  return docs;
}
