import { cache } from "react";
import { getPool } from "./db";
import type { ConfluenceScore, Match, PaperBet, TradeFilters, TradeRow, Wallet } from "./types";

const MATCH_COLS = `event_id AS id, competition, home_team AS "homeTeam", away_team AS "awayTeam",
  kickoff_time AS "kickoffTime", polymarket_market_id AS "polymarketMarketId", resolved, result,
  home_condition_id AS home, draw_condition_id AS draw, away_condition_id AS away`;

type MatchRow = {
  id: string;
  competition: Match["competition"];
  homeTeam: string;
  awayTeam: string;
  kickoffTime: Date;
  polymarketMarketId: string;
  resolved: boolean;
  result: Match["result"];
  home: string | null;
  draw: string | null;
  away: string | null;
};

function mapMatchRow(r: MatchRow): { id: string; data: Match } {
  return {
    id: r.id,
    data: {
      competition: r.competition,
      homeTeam: r.homeTeam,
      awayTeam: r.awayTeam,
      kickoffTime: r.kickoffTime.toISOString(),
      polymarketMarketId: r.polymarketMarketId,
      resolved: r.resolved,
      result: r.result,
      marketConditionIds: r.home && r.draw && r.away ? { home: r.home, draw: r.draw, away: r.away } : undefined,
    },
  };
}

export async function getMatches(): Promise<{ id: string; data: Match }[]> {
  const { rows } = await getPool().query<MatchRow>(`SELECT ${MATCH_COLS} FROM matches`);
  return rows.map(mapMatchRow);
}

// Cached per-request: generateMetadata and the page component both need
// this for matches/[matchId], and React's cache() dedupes the two calls
// into one fetch instead of two.
export const getMatch = cache(async (id: string): Promise<{ id: string; data: Match } | null> => {
  const { rows } = await getPool().query<MatchRow>(`SELECT ${MATCH_COLS} FROM matches WHERE event_id = $1`, [id]);
  return rows.length > 0 ? mapMatchRow(rows[0]) : null;
});

const SCORE_COLS = `id, match_id AS "matchId", snapshot_id AS "snapshotId", minutes_before_kickoff AS "minutesBeforeKickoff",
  tracked_leg AS "trackedLeg", score, probability_estimate AS "probabilityEstimate",
  market_implied_probability AS "marketImpliedProbability", edge, breakdown, frozen_at AS "frozenAt"`;

type ScoreRow = Omit<ConfluenceScore, "frozenAt"> & { id: string; frozenAt: Date };

function mapScoreRow(r: ScoreRow): { id: string; data: ConfluenceScore } {
  const { id, ...rest } = r;
  return { id, data: { ...rest, frozenAt: rest.frozenAt.toISOString() } };
}

export async function getMatchScores(matchId: string): Promise<{ id: string; data: ConfluenceScore }[]> {
  const { rows } = await getPool().query<ScoreRow>(`SELECT ${SCORE_COLS} FROM confluence_scores WHERE match_id = $1`, [matchId]);
  return rows.map(mapScoreRow);
}

// Used by the Matches list page to show each match's latest edge without a
// per-match round trip.
export async function getAllConfluenceScores(): Promise<{ id: string; data: ConfluenceScore }[]> {
  const { rows } = await getPool().query<ScoreRow>(`SELECT ${SCORE_COLS} FROM confluence_scores`);
  return rows.map(mapScoreRow);
}

export async function getMatchTrades(matchId: string): Promise<
  { wallet: string; side: string; size: number; price: number; timestamp: number; outcome: string; conditionId: string }[]
> {
  const { rows } = await getPool().query(
    `SELECT wallet, side, size, price, timestamp, outcome, condition_id AS "conditionId" FROM trades WHERE match_id = $1`,
    [matchId]
  );
  return rows;
}

const WALLET_COLS = `address AS id, total_resolved_trades AS "totalResolvedTrades", aggregate_win_rate AS "aggregateWinRate",
  aggregate_roi AS "aggregateROI", tier, by_slice AS "bySlice", trend, last_updated AS "lastUpdated"`;

type WalletRow = Omit<Wallet, "lastUpdated"> & { id: string; lastUpdated: Date };

function mapWalletRow(r: WalletRow): { id: string; data: Wallet } {
  const { id, ...rest } = r;
  return { id, data: { ...rest, lastUpdated: rest.lastUpdated.toISOString() } };
}

export async function getWallets(): Promise<{ id: string; data: Wallet }[]> {
  const { rows } = await getPool().query<WalletRow>(`SELECT ${WALLET_COLS} FROM wallets`);
  return rows.map(mapWalletRow);
}

export const getWallet = cache(async (address: string): Promise<{ id: string; data: Wallet } | null> => {
  const { rows } = await getPool().query<WalletRow>(`SELECT ${WALLET_COLS} FROM wallets WHERE address = $1`, [address]);
  return rows.length > 0 ? mapWalletRow(rows[0]) : null;
});

const PAPER_BET_COLS = `id, match_id AS "matchId", score_id AS "scoreId", tracked_leg AS "trackedLeg", edge_at_bet AS "edgeAtBet",
  price_at_bet AS "priceAtBet", stake, outcome, pnl, placed_at AS "placedAt", settled_at AS "settledAt"`;

type PaperBetRow = Omit<PaperBet, "placedAt" | "settledAt"> & { id: string; placedAt: Date; settledAt: Date | null };

export async function getPaperBets(): Promise<{ id: string; data: PaperBet }[]> {
  const { rows } = await getPool().query<PaperBetRow>(`SELECT ${PAPER_BET_COLS} FROM paper_bets`);
  return rows.map((r) => {
    const { id, ...rest } = r;
    return { id, data: { ...rest, placedAt: rest.placedAt.toISOString(), settledAt: rest.settledAt?.toISOString() ?? null } };
  });
}

export async function getSystemStatus(): Promise<{ lastSuccessfulRun?: string; matchesProcessed?: number } | null> {
  const { rows } = await getPool().query<{ lastSuccessfulRun: Date | null; matchesProcessed: number | null }>(
    `SELECT last_successful_run AS "lastSuccessfulRun", matches_processed AS "matchesProcessed" FROM pipeline_status WHERE key = 'status'`
  );
  if (rows.length === 0) return null;
  return {
    lastSuccessfulRun: rows[0].lastSuccessfulRun?.toISOString(),
    matchesProcessed: rows[0].matchesProcessed ?? undefined,
  };
}

// Shared between the Trades page and its CSV export, so the two can't
// silently apply different filters. One indexed JOIN replaces the
// collection-group-query-plus-in-memory-filter Firestore needed.
export async function getFilteredTradeRows(filters: TradeFilters): Promise<TradeRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.competition) {
    params.push(filters.competition);
    conditions.push(`m.competition = $${params.length}`);
  }
  if (filters.wallet) {
    params.push(`%${filters.wallet.toLowerCase()}%`);
    conditions.push(`lower(t.wallet) LIKE $${params.length}`);
  }
  if (filters.outcome) {
    params.push(filters.outcome);
    conditions.push(`t.outcome = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows } = await getPool().query<TradeRow>(
    `SELECT t.match_id AS "matchId", m.competition, m.home_team AS "homeTeam", m.away_team AS "awayTeam",
            t.wallet, t.side, t.outcome, t.size, t.price, t.timestamp
     FROM trades t
     JOIN matches m ON m.event_id = t.match_id
     ${where}
     ORDER BY t.timestamp DESC`,
    params
  );
  return rows;
}
