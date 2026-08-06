// Milestone 5: the user's own paper-bet ledger — deliberately separate from
// the wallet-ranking system (see PROJECT.md's hard constraints). Two steps
// each run: place a flat-stake bet on any frozen confluence score whose
// edge clears a threshold, then settle any pending bet whose match has
// since resolved.
import { getPool } from "./db.js";
import { isMainModule } from "./isMain.js";

// "A meaningful positive edge" and "flat stake" per Milestone 5's prompt —
// both explicitly meant to be configurable, not fitted constants.
const EDGE_THRESHOLD = process.env.PAPER_BET_EDGE_THRESHOLD ? Number(process.env.PAPER_BET_EDGE_THRESHOLD) : 0.05;
const STAKE = process.env.PAPER_BET_STAKE ? Number(process.env.PAPER_BET_STAKE) : 10;

// Buying `stake` dollars of shares at `price` buys `stake/price` shares.
// A bet only ever gets placed on positive edge (we think the leg is more
// likely than the market does), so this always means BUYing that leg's
// "Yes" side, never selling or betting against it — keeps the model simple
// and matches "bet a flat stake whenever edge exceeds a threshold" literally.
export function decideBet(score, { edgeThreshold = EDGE_THRESHOLD, stake = STAKE } = {}) {
  if (score.edge === null || score.edge === undefined) return null;
  if (score.edge <= edgeThreshold) return null;
  // A price of exactly 0 divides-by-zero in settleBet's stake/priceAtBet;
  // a price of exactly 1 has zero possible upside. Found by an independent
  // code review — Polymarket's quantized outcomePrices can legitimately
  // show "0" for a near-dead leg, and scoreMatches.js's marketImpliedProbability
  // is the raw, unclipped market price (unlike probabilityEstimate).
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
// Loss: shares resolve to $0, pnl = -stake (the whole stake is lost).
//
// A match can be `resolved: true` with `result: null` — Polymarket voided
// or postponed it without any leg settling ~1 (see resultFrom() in
// collect.js/backfill.js). Without this case, settleBet returned null for
// that match forever (the same as "not yet resolved"), so its paper bet
// stayed "pending" indefinitely with no way to ever close it out. Found by
// an independent code review. A void settles as its own outcome — not a
// win, not a loss, stake refunded (pnl 0) — rather than silently
// disappearing into the loss bucket or staying open forever.
export function settleBet(bet, match) {
  if (!match || !match.resolved) return null;
  if (!match.result) return { outcome: "void", pnl: 0, settledAt: new Date().toISOString() };
  const win = bet.trackedLeg === match.result;
  const pnl = win ? bet.stake / bet.priceAtBet - bet.stake : -bet.stake;
  return { outcome: win ? "win" : "loss", pnl, settledAt: new Date().toISOString() };
}

// A single LEFT JOIN replaces the per-score existence check Firestore
// needed (one .get() per confluence score, every run).
async function placeBets(pool) {
  const { rows } = await pool.query(
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

    await pool.query(
      `INSERT INTO paper_bets (id, match_id, score_id, tracked_leg, edge_at_bet, price_at_bet, stake, outcome, pnl, placed_at, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      [bet.scoreId, bet.matchId, bet.scoreId, bet.trackedLeg, bet.edgeAtBet, bet.priceAtBet, bet.stake, bet.outcome, bet.pnl, bet.placedAt, bet.settledAt]
    );
    placed++;
    console.log(`  placed bet on ${bet.matchId}/${bet.trackedLeg}: edge=${(bet.edgeAtBet * 100).toFixed(1)}pp stake=$${bet.stake}`);
  }
  return placed;
}

// A JOIN against matches replaces the per-bet match lookup Firestore needed.
// A pending bet whose match doesn't exist (yet) simply won't appear here —
// same as settleBet(bet, null) returning null, just without the extra round trip.
async function settleBets(pool) {
  const { rows } = await pool.query(
    `SELECT pb.id, pb.match_id AS "matchId", pb.tracked_leg AS "trackedLeg", pb.price_at_bet AS "priceAtBet", pb.stake,
            m.resolved, m.result
     FROM paper_bets pb
     JOIN matches m ON m.event_id = pb.match_id
     WHERE pb.outcome = 'pending'`
  );

  let settled = 0;
  for (const row of rows) {
    const settlement = settleBet(row, { resolved: row.resolved, result: row.result });
    if (!settlement) continue;

    await pool.query(`UPDATE paper_bets SET outcome = $1, pnl = $2, settled_at = $3 WHERE id = $4`, [
      settlement.outcome,
      settlement.pnl,
      settlement.settledAt,
      row.id,
    ]);
    settled++;
    console.log(`  settled ${row.matchId}/${row.trackedLeg}: ${settlement.outcome} pnl=${settlement.pnl.toFixed(2)}`);
  }
  return settled;
}

async function main() {
  const pool = getPool();
  console.log(`Edge threshold: ${(EDGE_THRESHOLD * 100).toFixed(1)}pp, flat stake: $${STAKE}`);

  console.log("\nPlacing new bets...");
  const placed = await placeBets(pool);
  console.log(`${placed} new bet(s) placed.`);

  console.log("\nSettling pending bets...");
  const settled = await settleBets(pool);
  console.log(`${settled} bet(s) settled.`);
  await pool.end();
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("Paper-bet run FAILED:", err);
    process.exit(1);
  });
}
