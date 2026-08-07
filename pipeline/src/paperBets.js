// Milestone 5: the user's own paper-bet ledger — deliberately separate from
// the wallet-ranking system (see PROJECT.md's hard constraints). Two steps
// each run: place a flat-stake bet on any frozen confluence score whose
// edge clears a threshold, then settle any pending bet whose match has
// since resolved.
import { getClient } from "./db.js";
import { isMainModule } from "./isMain.js";

// "A meaningful positive edge" and "flat stake" per Milestone 5's prompt —
// both explicitly meant to be configurable, not fitted constants.
const EDGE_THRESHOLD = process.env.PAPER_BET_EDGE_THRESHOLD ? Number(process.env.PAPER_BET_EDGE_THRESHOLD) : 0.05;
const STAKE = process.env.PAPER_BET_STAKE ? Number(process.env.PAPER_BET_STAKE) : 10;

// Buying `stake` dollars of shares at `price` buys `stake/price` shares.
// A bet only ever gets placed on positive edge, so this always means
// BUYing that leg's "Yes" side, never selling or betting against it.
export function decideBet(score, { edgeThreshold = EDGE_THRESHOLD, stake = STAKE } = {}) {
  if (score.edge === null || score.edge === undefined) return null;
  if (score.edge <= edgeThreshold) return null;
  // A price of exactly 0 divides-by-zero in settleBet's stake/priceAtBet;
  // a price of exactly 1 has zero possible upside.
  const price = score.marketImpliedProbability;
  if (price === null || price === undefined || price <= 0 || price >= 1) return null;
  return {
    matchId: score.matchId,
    scoreId: score.id,
    trackedLeg: score.trackedLeg,
    edgeAtBet: score.edge,
    priceAtBet: score.marketImpliedProbability,
    stake,
    outcome: "pending",
    pnl: null,
    placedAt: new Date().toISOString(),
    settledAt: null,
  };
}

// Buying `stake` dollars of shares at `price` -> `stake/price` shares.
// Win: shares resolve to $1 each, pnl = stake/price - stake.
// Loss: shares resolve to $0, pnl = -stake.
//
// A match can be `resolved: true` with `result: null` — Polymarket voided
// or postponed it without any leg settling ~1. A void settles as its own
// outcome — not a win, not a loss, stake refunded (pnl 0).
export function settleBet(bet, match) {
  if (!match || !match.resolved) return null;
  if (!match.result) return { outcome: "void", pnl: 0, settledAt: new Date().toISOString() };
  const win = bet.trackedLeg === match.result;
  const pnl = win ? bet.stake / bet.priceAtBet - bet.stake : -bet.stake;
  return { outcome: win ? "win" : "loss", pnl, settledAt: new Date().toISOString() };
}

// A single LEFT JOIN replaces a per-score existence check.
async function placeBets(client) {
  const { rows } = await client.execute(
    `SELECT cs.id, cs.match_id AS "matchId", cs.tracked_leg AS "trackedLeg", cs.edge,
            cs.market_implied_probability AS "marketImpliedProbability"
     FROM confluence_scores cs
     LEFT JOIN paper_bets pb ON pb.id = cs.id
     WHERE pb.id IS NULL`
  );

  let placed = 0;
  for (const score of rows) {
    const bet = decideBet(score);
    if (!bet) continue;

    await client.execute({
      sql: `INSERT INTO paper_bets (id, match_id, score_id, tracked_leg, edge_at_bet, price_at_bet, stake, outcome, pnl, placed_at, settled_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING`,
      args: [bet.scoreId, bet.matchId, bet.scoreId, bet.trackedLeg, bet.edgeAtBet, bet.priceAtBet, bet.stake, bet.outcome, bet.pnl, bet.placedAt, bet.settledAt],
    });
    placed++;
    console.log(`  placed bet on ${bet.matchId}/${bet.trackedLeg}: edge=${(bet.edgeAtBet * 100).toFixed(1)}pp stake=$${bet.stake}`);
  }
  return placed;
}

// A JOIN against matches replaces a per-bet match lookup.
async function settleBets(client) {
  const { rows } = await client.execute(
    `SELECT pb.id, pb.match_id AS "matchId", pb.tracked_leg AS "trackedLeg", pb.price_at_bet AS "priceAtBet", pb.stake,
            m.resolved, m.result
     FROM paper_bets pb
     JOIN matches m ON m.event_id = pb.match_id
     WHERE pb.outcome = 'pending'`
  );

  let settled = 0;
  for (const row of rows) {
    const settlement = settleBet(row, { resolved: Boolean(row.resolved), result: row.result });
    if (!settlement) continue;

    await client.execute({
      sql: `UPDATE paper_bets SET outcome = ?, pnl = ?, settled_at = ? WHERE id = ?`,
      args: [settlement.outcome, settlement.pnl, settlement.settledAt, row.id],
    });
    settled++;
    console.log(`  settled ${row.matchId}/${row.trackedLeg}: ${settlement.outcome} pnl=${settlement.pnl.toFixed(2)}`);
  }
  return settled;
}

async function main() {
  const client = getClient();
  console.log(`Edge threshold: ${(EDGE_THRESHOLD * 100).toFixed(1)}pp, flat stake: $${STAKE}`);

  console.log("\nPlacing new bets...");
  const placed = await placeBets(client);
  console.log(`${placed} new bet(s) placed.`);

  console.log("\nSettling pending bets...");
  const settled = await settleBets(client);
  console.log(`${settled} bet(s) settled.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("Paper-bet run FAILED:", err);
    process.exit(1);
  });
}
