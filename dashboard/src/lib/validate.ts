// Route params are passed as parameterized query values (see lib/data.ts),
// so this isn't protecting against SQL injection — Postgres handles that
// regardless of what the string contains. It's still worth rejecting
// obviously-malformed ids before they touch a query, so a garbage route
// param renders a clean 404 instead of an empty/confusing result.
export function isValidMatchId(id: string): boolean {
  return /^\d+$/.test(id);
}

export function isValidWalletAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
