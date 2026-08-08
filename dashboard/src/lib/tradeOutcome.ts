import type { Leg, Match, RawTrade } from "./types";

// Which leg (home/draw/away) a trade's conditionId maps to. Shared so every
// page that lists raw trades computes this the same way -- was previously
// duplicated inline on the wallet detail page.
export function legFor(trade: Pick<RawTrade, "conditionId">, marketConditionIds: Match["marketConditionIds"]): Leg | null {
  if (!marketConditionIds) return null;
  if (trade.conditionId === marketConditionIds.home) return "home";
  if (trade.conditionId === marketConditionIds.draw) return "draw";
  if (trade.conditionId === marketConditionIds.away) return "away";
  return null;
}

export function legLabel(leg: Leg, homeTeam: string, awayTeam: string): string {
  if (leg === "draw") return "Draw";
  return leg === "home" ? homeTeam : awayTeam;
}

// Was this fill financially profitable -- NOT just "does the raw outcome
// flag match the winning leg" (that ignores BUY vs SELL direction: a SELL
// Yes that resolves Yes is a real loss for the seller, who owes the buyer
// $1/share, even though the outcome flag "matches"). Mirrors the same fix
// made to pipeline/src/rankWallets.js's buildTradeRows.
export function tradeWon(trade: Pick<RawTrade, "side" | "outcome">, leg: Leg | null, resolved: boolean, result: Leg | null): boolean | null {
  if (!resolved || !result || !leg) return null;
  const legWon = leg === result;
  const outcomeFlagMatchesResult = (trade.outcome === "Yes") === legWon;
  return trade.side === "BUY" ? outcomeFlagMatchesResult : !outcomeFlagMatchesResult;
}

// "BUY Yes" / "SELL No" is Polymarket's own share-type jargon -- whether a
// fill is actually betting FOR or AGAINST a leg happening.
export function isBacking(trade: Pick<RawTrade, "side" | "outcome">): boolean {
  return (trade.outcome === "Yes") === (trade.side === "BUY");
}

// "BUY Yes" / "SELL No" is Polymarket's own share-type jargon -- what a
// person actually did was back or fade a specific team (or the draw). Plain
// language for every page that lists raw fills.
export function positionLabel(trade: Pick<RawTrade, "side" | "outcome">, leg: Leg | null, homeTeam: string, awayTeam: string): string {
  if (!leg) return `${trade.side} ${trade.outcome}`;
  return `${isBacking(trade) ? "Backed" : "Faded"} ${legLabel(leg, homeTeam, awayTeam)}`;
}

export function outcomeLabel(won: boolean | null): "Win" | "Loss" | "Pending" {
  return won === null ? "Pending" : won ? "Win" : "Loss";
}
