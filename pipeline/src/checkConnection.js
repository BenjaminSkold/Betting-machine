import { getDb } from "./firestore.js";

async function main() {
  const db = getDb();
  const ref = db.collection("_diagnostics").doc("connectionCheck");
  await ref.set({ checkedAt: new Date().toISOString() });
  const snap = await ref.get();
  console.log("Wrote and read back:", snap.data());
  console.log("Firestore connection OK.");
}

main().catch((err) => {
  console.error("Connection check FAILED:", err.message);
  process.exit(1);
});
