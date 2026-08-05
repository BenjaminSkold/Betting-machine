import { getDoc, listCollection } from "./firestore";
import type { ConfluenceScore, Match, PaperBet, Wallet } from "./types";

export async function getMatches(): Promise<{ id: string; data: Match }[]> {
  return listCollection<Match>("matches");
}

export async function getMatch(id: string): Promise<{ id: string; data: Match } | null> {
  return getDoc<Match>(`matches/${id}`);
}

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

export async function getPaperBets(): Promise<{ id: string; data: PaperBet }[]> {
  return listCollection<PaperBet>("paperBets");
}

export async function getSystemStatus(): Promise<{ lastSuccessfulRun?: string; matchesProcessed?: number } | null> {
  const doc = await getDoc<{ lastSuccessfulRun?: string; matchesProcessed?: number }>("_system/status");
  return doc?.data ?? null;
}
