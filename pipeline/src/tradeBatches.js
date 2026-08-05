// Storing one Firestore document per trade blew through the free-tier
// 20,000 writes/day quota almost immediately (a single match can have
// thousands of trades). Instead, trades are grouped into arrays of
// BATCH_SIZE and stored a few-hundred-to-a-doc, cutting write volume by
// ~100-300x. Nothing downstream needs a per-trade document — the wallet
// aggregation job reads and flattens all trades in-memory regardless.

export const BATCH_SIZE = 300;

export function chunk(items, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function toStoredTrade(t) {
  return {
    wallet: t.proxyWallet,
    side: t.side,
    size: t.size,
    price: t.price,
    timestamp: t.timestamp,
    outcome: t.outcome,
    conditionId: t.conditionId,
  };
}
