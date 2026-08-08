import type { NextRequest } from "next/server";
import { getFilteredTradeRows } from "@/lib/data";
import { toCsv } from "@/lib/csv";
import { positionLabel, outcomeLabel } from "@/lib/tradeOutcome";

// Exports the SAME filtered set the Trades page shows (not just the
// current page) — the page paginates for display, but a CSV export should
// hand over everything matching the filters, since that's the whole point
// of exporting rather than just reading the table on screen.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const rows = await getFilteredTradeRows({
    wallet: sp.get("wallet") ?? undefined,
    competition: sp.get("competition") ?? undefined,
    outcome: sp.get("outcome") ?? undefined,
  });

  // "side"/"outcome" are Polymarket's own raw share-type fields (BUY/SELL,
  // Yes/No) -- kept for anyone doing further analysis. "position"/"result"
  // are the same fills translated to plain language (which team, win/loss).
  const csv = toCsv(
    ["timestamp_iso", "competition", "home_team", "away_team", "wallet", "side", "outcome", "position", "result", "price", "size"],
    rows.map((t) => [
      new Date(t.timestamp * 1000).toISOString(),
      t.competition,
      t.homeTeam,
      t.awayTeam,
      t.wallet,
      t.side,
      t.outcome,
      positionLabel(t, t.leg, t.homeTeam, t.awayTeam),
      outcomeLabel(t.won),
      t.price,
      t.size,
    ])
  );

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="trades-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
