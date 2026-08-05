import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Two ways credentials reach this process:
// - Locally: GOOGLE_APPLICATION_CREDENTIALS points at the downloaded service
//   account JSON file on disk.
// - In GitHub Actions: FIREBASE_SERVICE_ACCOUNT_JSON holds the raw JSON
//   content directly (set from a repo secret), since CI has no persistent
//   filesystem to point a path at.
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

let app;
export function getDb() {
  if (!app) {
    app = initializeApp({ credential: cert(loadCredential()) });
  }
  return getFirestore(app);
}

// The Firestore SDK's own internal retry (google-gax) waits up to 600s
// before surfacing a RESOURCE_EXHAUSTED/UNAVAILABLE error — far too long to
// sit inside an application-level retry loop. Race it against a short
// timeout so our own backoff (in backfill.js) controls the pacing instead.
// The abandoned underlying call is left to resolve/reject on its own; we
// just stop waiting on it.
export function withTimeout(promise, ms = 15000, label = "Firestore operation") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
