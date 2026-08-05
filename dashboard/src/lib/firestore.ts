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

async function request(url: string): Promise<{ status: number; body: unknown }> {
  const token = await getToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (res.status === 404) return { status: 404, body: null };
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Firestore REST GET ${url} -> ${res.status}: ${text.slice(0, 500)}`);
  return { status: res.status, body: parsed };
}

let cachedProjectId: string | null = null;
function projectId(): string {
  if (!cachedProjectId) cachedProjectId = loadCredential().project_id;
  return cachedProjectId;
}

export type Doc<T> = { id: string; data: T };

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
