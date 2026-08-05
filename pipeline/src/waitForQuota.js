// Throwaway diagnostic: exits 0 the moment a single Firestore write
// succeeds, exits 1 otherwise. Used by an external poll loop, not part of
// the real pipeline.
import { getDb } from "./firestoreRest.js";

async function main() {
  try {
    await getDb().collection("_diagnostics").doc("quotaPoll").set({ t: Date.now() });
    console.log("WRITE SUCCEEDED");
    process.exit(0);
  } catch (err) {
    console.log("still throttled:", err.message.slice(0, 150));
    process.exit(1);
  }
}

main();
