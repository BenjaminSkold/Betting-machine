import { cache } from "react";
import { getClient } from "./db";
import { readAllTradesForMatch } from "./tradeArchive";
import type { ConfluenceScore, Match, PaperBet, RawTrade, TradeFilters, TradeRow, Wallet } from "./types";

const MATCH_COLS = `event_id AS id, competition, home_team AS "homeTeam", away_team AS "awayTeam",
  kickoff_time AS "kickoffTime", polymarket_market_id AS "polymarketMarketId", resolved, result,
  home_condition_id AS home, draw_condition_id AS draw, away_condition_id AS away`;

type MatchRow = {
  id: string;
  competition: Match["competition"];
  homeTeam: string;
  awayTeam: string;
  kickoffTime: string;
  polymarketMarketId: string;
  resolved: number;
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
      kickoffTime: r.kickoffTime,
      polymarketMarketId: r.polymarketMarketId,
      resolved: Boolean(r.resolved),
      result: r.result,
      marketConditionIds: r.home && r.draw && r.away ? { home: r.home, draw: r.draw, away: r.away } : undefined,
    },
  };
}

export async function getMatches(): Promise<{ id: string; data: Match }[]> {
  const { rows } = await getClient().execute(`SELECT ${MATCH_COLS} FROM matches`);
  return (rows as unknown as MatchRow[]).map(mapMatchRow);
}

// Cached per-request: generateMetadata and the page component both need
// this for matches/[matchId], and React's cache() dedupes the two calls
// into one fetch instead of two.
export const getMatch = cache(async (id: string): Promise<{ id: string; data: Match } | null> => {
  const { rows } = await getClient().execute({ sql: `SELECT ${MATCH_COLS} FROM matches WHERE event_id = ?`, args: [id] });
  return rows.length > 0 ? mapMatchRow(rows[0] as unknown as MatchRow) : null;
});

const SCORE_COLS = `id, match_id AS "matchId", snapshot_id AS "snapshotId", minutes_before_kickoff AS "minutesBeforeKickoff",
  tracked_leg AS "trackedLeg", score, probability_estimate AS "probabilityEstimate",
  market_implied_probability AS "marketImpliedProbability", edge, breakdown, frozen_at AS "frozenAt"`;

type ScoreRow = Omit<ConfluenceScore, "breakdown"> & { id: string; breakdown: string };

function mapScoreRow(r: ScoreRow): { id: string; data: ConfluenceScore } {
  const { id, breakdown, ...rest } = r;
  return { id, data: { ...rest, breakdown: JSON.parse(breakdown) } };
}

export async function getMatchScores(matchId: string): Promise<{ id: string; data: ConfluenceScore }[]> {
  const { rows } = await getClient().execute({ sql: `SELECT ${SCORE_COLS} FROM confluence_scores WHERE match_id = ?`, args: [matchId] });
  return (rows as unknown as ScoreRow[]).map(mapScoreRow);
}

// Used by the Matches list page to show each match's latest edge without a
// per-match round trip.
export async function getAllConfluenceScores(): Promise<{ id: string; data: ConfluenceScore }[]> {
  const { rows } = await getClient().execute(`SELECT ${SCORE_COLS} FROM confluence_scores`);
  return (rows as unknown as ScoreRow[]).map(mapScoreRow);
}

// Reads one match's full trade history from R2 -- bounded to a single
// match's batch files, so this stays fast regardless of how much history
// the whole project has accumulated.
export async function getMatchTrades(matchId: string): Promise<RawTrade[]> {
  return readAllTradesForMatch(matchId);
}

const WALLET_COLS = `address AS id, total_resolved_trades AS "totalResolvedTrades", aggregate_win_rate AS "aggregateWinRate",
  aggregate_roi AS "aggregateROI", tier, by_slice AS "bySlice", trend, last_updated AS "lastUpdated"`;

type WalletRow = Omit<Wallet, "bySlice" | "trend"> & { id: string; bySlice: string; trend: string };

function mapWalletRow(r: WalletRow): { id: string; data: Wallet } {
  const { id, bySlice, trend, ...rest } = r;
  return { id, data: { ...rest, bySlice: JSON.parse(bySlice), trend: JSON.parse(trend) } };
}

export async function getWallets(): Promise<{ id: string; data: Wallet }[]> {
  const { rows } = await getClient().execute(`SELECT ${WALLET_COLS} FROM wallets`);
  return (rows as unknown as WalletRow[]).map(mapWalletRow);
}

export const getWallet = cache(async (address: string): Promise<{ id: string; data: Wallet } | null> => {
  const { rows } = await getClient().execute({ sql: `SELECT ${WALLET_COLS} FROM wallets WHERE address = ?`, args: [address] });
  return rows.length > 0 ? mapWalletRow(rows[0] as unknown as WalletRow) : null;
});

const PAPER_BET_COLS = `id, match_id AS "matchId", score_id AS "scoreId", tracked_leg AS "trackedLeg", edge_at_bet AS "edgeAtBet",
  price_at_bet AS "priceAtBet", stake, outcome, pnl, placed_at AS "placedAt", settled_at AS "settledAt"`;

type PaperBetRow = PaperBet & { id: string };

export async function getPaperBets(): Promise<{ id: string; data: PaperBet }[]> {
  const { rows } = await getClient().execute(`SELECT ${PAPER_BET_COLS} FROM paper_bets`);
  return (rows as unknown as PaperBetRow[]).map((r) => {
    const { id, ...rest } = r;
    return { id, data: rest };
  });
}

export async function getSystemStatus(): Promise<{ lastSuccessfulRun?: string; matchesProcessed?: number } | null> {
  const { rows } = await getClient().execute(
    `SELECT last_successful_run AS "lastSuccessfulRun", matches_processed AS "matchesProcessed" FROM pipeline_status WHERE key = 'status'`
  );
  if (rows.length === 0) return null;
  const row = rows[0] as unknown as { lastSuccessfulRun: string | null; matchesProcessed: number | null };
  return { lastSuccessfulRun: row.lastSuccessfulRun ?? undefined, matchesProcessed: row.matchesProcessed ?? undefined };
}

// Shared between the Trades page and its CSV export, so the two can't
// silently apply different filters.
//
// IMPORTANT caveat this design has that the old SQL-table version didn't:
// with raw trades in R2 instead of a queryable table, an unfiltered
// whole-season view means reading EVERY match's R2 files, which will get
// slow (and could hit a serverless function's execution time limit) once
// there's a full season of history. Requiring a competition filter before
// doing a broad scan keeps this bounded -- worth revisiting (e.g. a
// periodically-refreshed lightweight index) if the unfiltered view is
// actually needed once real data volume exists.
export async function getFilteredTradeRows(filters: TradeFilters): Promise<TradeRow[]> {
  const allMatches = await getMatches();
  const matches = filters.competition ? allMatches.filter((m) => m.data.competition === filters.competition) : allMatches;

  const rows: TradeRow[] = [];
  for (const match of matches) {
    const trades = await readAllTradesForMatch(match.id);
    for (const t of trades) {
      if (filters.wallet && !t.wallet.toLowerCase().includes(filters.wallet.toLowerCase())) continue;
      if (filters.outcome && t.outcome !== filters.outcome) continue;
      rows.push({
        matchId: match.id,
        competition: match.data.competition,
        homeTeam: match.data.homeTeam,
        awayTeam: match.data.awayTeam,
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
