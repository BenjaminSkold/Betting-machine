import { cache } from "react";
import { getDoc, listCollection, listCollectionGroup } from "./firestore";
import type { ConfluenceScore, Match, PaperBet, TradeFilters, TradeRow, Wallet } from "./types";

type RawTrade = { wallet: string; side: string; size: number; price: number; timestamp: number; outcome: string; conditionId: string };

export async function getMatches(): Promise<{ id: string; data: Match }[]> {
  return listCollection<Match>("matches");
}

// Cached per-request: generateMetadata and the page component both need
// this for matches/[matchId], and React's cache() dedupes the two calls
// into one fetch instead of two.
export const getMatch = cache(async (id: string): Promise<{ id: string; data: Match } | null> => {
  return getDoc<Match>(`matches/${id}`);
});

export async function getMatchScores(matchId: string): Promise<{ id: string; data: ConfluenceScore }[]> {
  const all = await listCollection<ConfluenceScore>("confluenceScores");
  return all.filter((s) => s.data.matchId === matchId);
}

export async function getMatchTrades(matchId: string): Promise<
  { wallet: string; side: string; size: number; price: number; timestamp: number; outcome: string; conditionId: string }[]
> {
  const batches = await listCollection<{ trades: unknown[] }>(`matches/${matchId}/tradeBatches`);
  return batches.flatMap((b) => (b.data.trades as never[]) || []);
}

export async function getWallets(): Promise<{ id: string; data: Wallet }[]> {
  return listCollection<Wallet>("wallets");
}

export const getWallet = cache(async (address: string): Promise<{ id: string; data: Wallet } | null> => {
  return getDoc<Wallet>(`wallets/${address}`);
});

export async function getPaperBets(): Promise<{ id: string; data: PaperBet }[]> {
  return listCollection<PaperBet>("paperBets");
}

export async function getSystemStatus(): Promise<{ lastSuccessfulRun?: string; matchesProcessed?: number } | null> {
  const doc = await getDoc<{ lastSuccessfulRun?: string; matchesProcessed?: number }>("_system/status");
  return doc?.data ?? null;
}

// Shared between the Trades page and its CSV export, so the two can't
// silently apply different filters. One collection-group query fetches
// every match's tradeBatches in a bounded number of requests instead of one
// round-trip per match (see NOTES.md — a real ~24s-load bug this fixed).
export async function getFilteredTradeRows(filters: TradeFilters): Promise<TradeRow[]> {
  const [matches, batches] = await Promise.all([getMatches(), listCollectionGroup<{ trades: RawTrade[] }>("tradeBatches")]);
  const matchById = new Map(matches.map((m) => [m.id, m.data]));

  const rows: TradeRow[] = [];
  for (const batch of batches) {
    const match = batch.parentId ? matchById.get(batch.parentId) : undefined;
    if (!match) continue;
    if (filters.competition && match.competition !== filters.competition) continue;
    for (const t of batch.data.trades || []) {
      if (filters.wallet && !t.wallet.toLowerCase().includes(filters.wallet.toLowerCase())) continue;
      if (filters.outcome && t.outcome !== filters.outcome) continue;
      rows.push({
        matchId: batch.parentId!,
        competition: match.competition,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        wallet: t.wallet,
        side: t.side,
        outcome: t.outcome,
        size: t.size,
        price: t.price,
        timestamp: t.timestamp,
      });
    }
  }
  rows.sort((a, b) => b.timestamp - a.timestamp);
  return rows;
}
