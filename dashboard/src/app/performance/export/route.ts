import { getPaperBets } from "@/lib/data";
import { toCsv } from "@/lib/csv";

export async function GET() {
  const bets = await getPaperBets();
  const sorted = [...bets].sort((a, b) => b.data.placedAt.localeCompare(a.data.placedAt));

  const csv = toCsv(
    ["match_id", "tracked_leg", "edge_at_bet_pp", "price_at_bet", "stake", "outcome", "pnl", "placed_at", "settled_at"],
    sorted.map((b) => [
      b.data.matchId,
      b.data.trackedLeg,
      (b.data.edgeAtBet * 100).toFixed(2),
      b.data.priceAtBet,
      b.data.stake,
      b.data.outcome,
      b.data.pnl ?? "",
      b.data.placedAt,
      b.data.settledAt ?? "",
    ])
  );

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="paper-bets-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
