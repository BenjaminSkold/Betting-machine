// Route params flow directly into a Firestore REST document path as a
// plain template string (see lib/firestore.ts) with no escaping. Next.js
// dynamic segments can decode a percent-encoded sequence into characters
// like `/` inside the extracted param, and a `..` segment could plausibly
// resolve outside the intended collection. Practical impact is low here —
// this credential already has full-database read access, and every
// document is already reachable through normal navigation — but validating
// the expected shape before it touches a query is a correct, cheap habit
// regardless. Found by an independent code review.
export function isValidMatchId(id: string): boolean {
  return /^\d+$/.test(id);
}

export function isValidWalletAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
