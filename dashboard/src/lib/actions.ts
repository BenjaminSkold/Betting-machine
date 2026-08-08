"use server";

// The dashboard's one write path -- everywhere else it's read-only from
// Turso/R2 (see tradeArchive.ts's header comment). Manual bets are placed
// against a specific frozen confluence score (never freely), so the user
// always sees that score's actual edge before deciding to back it -- there
// is no "just bet on this match" path with no score to judge against.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getClient } from "./db";
import type { Leg } from "./types";

interface ScoreBreakdownLeg {
  marketImpliedProbability: number | null;
  edge: number | null;
}

export async function placeManualBet(scoreId: string, leg: Leg, stake: number): Promise<{ error?: string }> {
  if (!Number.isFinite(stake) || stake <= 0) return { error: "Stake must be a positive number." };

  const client = getClient();
  const { rows } = await client.execute({
    sql: `SELECT match_id AS "matchId", breakdown FROM confluence_scores WHERE id = ?`,
    args: [scoreId],
  });
  if (rows.length === 0) return { error: "That confluence score no longer exists." };

  const row = rows[0] as unknown as { matchId: string; breakdown: string };
  const breakdown = JSON.parse(row.breakdown) as Record<Leg, ScoreBreakdownLeg>;
  const legData = breakdown[leg];
  const price = legData?.marketImpliedProbability;
  // Same guard paperBets.js's decideBet() uses: a price of 0 divides-by-zero
  // at settlement, a price of 1 has zero possible upside.
  if (price === null || price === undefined || price <= 0 || price >= 1) {
    return { error: "No valid market price for that leg at this checkpoint — can't place a bet." };
  }

  // "manual_<uuid>" rather than reusing the score's own id: an auto bet's id
  // IS its triggering score's id (a 1:1 relationship paperBets.js's dedup
  // relies on), but more than one manual bet can target the same score.
  const id = `manual_${randomUUID()}`;
  await client.execute({
    sql: `INSERT INTO paper_bets (id, match_id, score_id, tracked_leg, edge_at_bet, price_at_bet, stake, outcome, pnl, placed_at, settled_at, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, 'manual')`,
    args: [id, row.matchId, scoreId, leg, legData.edge, price, stake, new Date().toISOString()],
  });

  revalidatePath(`/matches/${row.matchId}`);
  revalidatePath("/performance");
  return {};
}
