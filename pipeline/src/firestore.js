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
