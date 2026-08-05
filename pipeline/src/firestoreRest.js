// Minimal Firestore client over plain REST, bypassing the
// firebase-admin/@google-cloud/firestore SDK entirely.
//
// On this network, the SDK's write path (even with preferRest:true) takes
// ~90s per call — almost certainly an initial gRPC channel attempt that
// times out before falling back — while reads are instant. A raw
// authenticated REST call to the same API is consistently ~200-300ms.
// Rather than fight the SDK, this talks to Firestore's REST API directly
// with just enough of the data model we actually use: get/set on documents,
// and atomic multi-document batch commits.
import { readFileSync } from "node:fs";
import { GoogleAuth } from "google-auth-library";

function loadCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
  }
  throw new Error(
    "No Firebase credentials found. Set GOOGLE_APPLICATION_CREDENTIALS (local, path to key file) " +
      "or FIREBASE_SERVICE_ACCOUNT_JSON (CI, raw JSON content)."
  );
}

let authClient;
async function getToken() {
  if (!authClient) {
    const credentials = loadCredential();
    const auth = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/datastore"] });
    authClient = await auth.getClient();
  }
  const { token } = await authClient.getAccessToken();
  return token;
}

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === "object") return { mapValue: { fields: encodeFields(v) } };
  throw new Error(`Cannot encode value of type ${typeof v}`);
}

function encodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = encodeValue(v);
  return fields;
}

function decodeValue(v) {
  if (!v) return null;
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  if ("timestampValue" in v) return v.timestampValue;
  return null;
}

function decodeFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) obj[k] = decodeValue(v);
  return obj;
}

const BASE = "https://firestore.googleapis.com/v1";

// Once the SDK's ~90s-per-write bug was fixed, writes started landing fast
// enough to trip a real 429 RESOURCE_EXHAUSTED from Firestore itself — this
// project's actual write-rate ceiling is apparently quite low (plausibly a
// conservative baseline for a fresh, unbilled Spark-plan project that ramps
// up with sustained legitimate traffic). Serialize writes with a minimum
// spacing here so every caller gets this for free instead of trusting every
// call site to pace itself correctly.
const MIN_WRITE_INTERVAL_MS = 1100;
let lastWriteAt = 0;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceWrite() {
  const elapsed = Date.now() - lastWriteAt;
  if (elapsed < MIN_WRITE_INTERVAL_MS) await sleep(MIN_WRITE_INTERVAL_MS - elapsed);
  lastWriteAt = Date.now();
}

async function request(method, url, body) {
  if (method !== "GET") await paceWrite();
  const token = await getToken();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return { status: 404, body: null };
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Firestore REST ${method} ${url} -> ${res.status}: ${text.slice(0, 500)}`);
  return { status: res.status, body: parsed };
}

class DocRef {
  constructor(projectId, path) {
    this.projectId = projectId;
    this.path = path; // e.g. "matches/123/snapshots/checkpoint_60"
  }

  get name() {
    return `projects/${this.projectId}/databases/(default)/documents/${this.path}`;
  }

  get url() {
    return `${BASE}/${this.name}`;
  }

  collection(sub) {
    return new CollectionRef(this.projectId, `${this.path}/${sub}`);
  }

  async get() {
    const { status, body } = await request("GET", this.url);
    if (status === 404) return { exists: false, data: () => undefined, id: this.path.split("/").pop() };
    const data = decodeFields(body.fields || {});
    return { exists: true, data: () => data, id: this.path.split("/").pop() };
  }

  async set(data, opts = {}) {
    const fields = encodeFields(data);
    let url = this.url;
    if (opts.merge) {
      const params = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
      url += `?${params}`;
    }
    await request("PATCH", url, { fields });
  }
}

class CollectionRef {
  constructor(projectId, path) {
    this.projectId = projectId;
    this.path = path;
  }
  doc(id) {
    return new DocRef(this.projectId, `${this.path}/${id}`);
  }
}

class Batch {
  constructor(projectId) {
    this.projectId = projectId;
    this.writes = [];
  }
  set(docRef, data, opts = {}) {
    const write = { update: { name: docRef.name, fields: encodeFields(data) } };
    if (opts.merge) write.updateMask = { fieldPaths: Object.keys(data) };
    this.writes.push(write);
  }
  update(docRef, data) {
    this.writes.push({
      update: { name: docRef.name, fields: encodeFields(data) },
      updateMask: { fieldPaths: Object.keys(data) },
    });
  }
  async commit() {
    if (this.writes.length === 0) return;
    const url = `${BASE}/projects/${this.projectId}/databases/(default)/documents:commit`;
    await request("POST", url, { writes: this.writes });
  }
}

class Db {
  constructor(projectId) {
    this.projectId = projectId;
  }
  collection(name) {
    return new CollectionRef(this.projectId, name);
  }
  batch() {
    return new Batch(this.projectId);
  }
}

let db;
export function getDb() {
  if (!db) {
    const projectId = loadCredential().project_id;
    db = new Db(projectId);
  }
  return db;
}

// No-op here (kept so callers written for the old timeout wrapper don't need
// to change) — every call in this module is already a fast, direct REST
// request with no SDK-side hang to guard against.
export function withTimeout(promise) {
  return promise;
}
