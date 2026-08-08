import { cache } from "react";
import { getClient } from "./db";
import { readAllTradesForMatch } from "./tradeArchive";
import { mapWithConcurrency } from "./concurrency";
import { legFor, tradeWon } from "./tradeOutcome";
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

// Powers the team filter's dropdown (competition -> its teams) so picking a
// team is a select, not free-text typing -- distinct home/away team names
// per competition, straight from the matches already on record.
export async function getTeamsByCompetition(): Promise<Record<string, string[]>> {
  const { rows } = await getClient().execute(
    `SELECT DISTINCT competition, home_team AS team FROM matches
     UNION
     SELECT DISTINCT competition, away_team AS team FROM matches`
  );
  const out: Record<string, string[]> = {};
  for (const r of rows as unknown as { competition: string; team: string }[]) {
    (out[r.competition] ??= []).push(r.team);
  }
  for (const teams of Object.values(out)) teams.sort();
  return out;
}

// Live/upcoming matches aren't in wallet_matches yet -- rankWallets.js only
// indexes RESOLVED matches (it needs a known result to rank against). A
// small bounded scan of the most recent unresolved matches covers current
// activity; the wallet detail page filters this down further to whichever
// of these the wallet actually has a trade on.
const RECENT_UNRESOLVED_SCAN = 50;

// The wallet detail page used to scan the 150 most recent matches league-
// wide to find one wallet's activity -- a stopgap that was both slow (every
// R2 file, whether or not the wallet touched it) and wrong once a wallet's
// real history predates those 150 (a real case early in a new season, when
// few current matches exist yet but a wallet's whole history is last
// season). rankWallets.js already scans every resolved match's trades to
// rank wallets; wallet_matches is the same scan's byproduct, letting this
// look up exactly which matches a wallet touched instead of guessing.
export async function getMatchesForWallet(address: string): Promise<{ id: string; data: Match }[]> {
  const indexed = await getClient().execute({ sql: `SELECT match_id AS "matchId" FROM wallet_matches WHERE wallet = ?`, args: [address] });
  const indexedIds = (indexed.rows as unknown as { matchId: string }[]).map((r) => r.matchId);

  const unresolved = await getClient().execute({
    sql: `SELECT event_id AS "id" FROM matches WHERE resolved = 0 ORDER BY kickoff_time DESC LIMIT ?`,
    args: [RECENT_UNRESOLVED_SCAN],
  });
  const unresolvedIds = (unresolved.rows as unknown as { id: string }[]).map((r) => r.id);

  const idSet = new Set([...indexedIds, ...unresolvedIds]);
  if (idSet.size === 0) return [];

  const ids = [...idSet];
  const placeholders = ids.map(() => "?").join(", ");
  const { rows } = await getClient().execute({ sql: `SELECT ${MATCH_COLS} FROM matches WHERE event_id IN (${placeholders})`, args: ids });
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

const SCORE_COLS_LIGHT = `id, match_id AS "matchId", minutes_before_kickoff AS "minutesBeforeKickoff",
  tracked_leg AS "trackedLeg", probability_estimate AS "probabilityEstimate",
  market_implied_probability AS "marketImpliedProbability", edge`;

export type ConfluenceScoreLight = Omit<ConfluenceScore, "breakdown" | "score" | "snapshotId" | "frozenAt">;

// Used by the Matches list page's EdgeBadge, which only ever reads edge/
// trackedLeg/probabilityEstimate/marketImpliedProbability -- never the
// per-leg `breakdown` (each leg's full contributingWallets list). That
// field got large enough, once thousands of wallets could contribute to a
// single match, that selecting it for every one of 1000s of scores just to
// throw it away was the actual cost of the matches list page (confirmed:
// dropped from 20s+ to sub-second after switching to this column set).
export async function getAllConfluenceScoresLight(): Promise<{ id: string; data: ConfluenceScoreLight }[]> {
  const { rows } = await getClient().execute(`SELECT ${SCORE_COLS_LIGHT} FROM confluence_scores`);
  return (rows as unknown as ({ id: string } & ConfluenceScoreLight)[]).map(({ id, ...data }) => ({ id, data }));
}

// Reads one match's full trade history from R2 -- bounded to a single
// match's batch files, so this stays fast regardless of how much history
// the whole project has accumulated.
export async function getMatchTrades(matchId: string): Promise<RawTrade[]> {
  return readAllTradesForMatch(matchId);
}

const WALLET_COLS = `address AS id, total_resolved_trades AS "totalResolvedTrades", aggregate_win_rate AS "aggregateWinRate",
  aggregate_roi AS "aggregateROI", aggregate_pnl AS "aggregatePnl", aggregate_stake AS "aggregateStake",
  tier, by_slice AS "bySlice", trend, last_updated AS "lastUpdated"`;

type WalletRow = Omit<Wallet, "bySlice" | "trend"> & { id: string; bySlice: string; trend: string };

function mapWalletRow(r: WalletRow): { id: string; data: Wallet } {
  const { id, bySlice, trend, ...rest } = r;
  return { id, data: { ...rest, bySlice: JSON.parse(bySlice), trend: JSON.parse(trend) } };
}

export async function getWallets(): Promise<{ id: string; data: Wallet }[]> {
  const { rows } = await getClient().execute(`SELECT ${WALLET_COLS} FROM wallets`);
  return (rows as unknown as WalletRow[]).map(mapWalletRow);
}

// Once real market volume backfilled, most addresses are one-off bettors
// that never clear rankWallets.js's activity bar -- tier stays "unranked"
// forever, but tier:"watch" alone can still run into the tens of thousands.
// Fetching and JSON-parsing all of them (66k+ rows total) is what made the
// wallets leaderboard page take 26s; LIMIT is applied in SQL, not after the
// fact in JS, so a huge tier:"watch" population never leaves Turso at all.
// The leaderboard's own default sort is by ROI, so that's what bounds which
// rows this returns.
export async function getWatchlistedWallets(limit: number): Promise<{ id: string; data: Wallet }[]> {
  const { rows } = await getClient().execute({
    sql: `SELECT ${WALLET_COLS} FROM wallets WHERE tier = 'watch' ORDER BY aggregate_roi DESC LIMIT ?`,
    args: [limit],
  });
  return (rows as unknown as WalletRow[]).map(mapWalletRow);
}

// A wallet search needs to find ANY matching address, not just one in the
// ROI-ordered top slice above -- a separate query rather than a client-side
// filter over an unbounded fetch, for the same reason as the function above.
//
// Deliberately NOT `address LIKE ?` with a bound parameter: confirmed via
// EXPLAIN QUERY PLAN that Turso's planner doesn't rewrite a parameterized
// LIKE into an index range scan the way SQLite normally does for a literal
// prefix -- it fell back to a full table scan (5-6s over 40k+ rows) even
// with an index on `address` (it's the PRIMARY KEY). A plain `>=`/`<` range
// on the same index took 165ms. This only supports a prefix match (typing
// from the start of an address), which is what the "Wallet 0x…" placeholder
// already implies -- and tier is filtered in JS after, not in SQL, because
// adding it as a WHERE clause let the planner pick the tier index instead
// and scan every watchlisted row again regardless of the address range.
function exclusiveUpperBound(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

export async function searchWatchlistedWallets(query: string, limit: number): Promise<{ id: string; data: Wallet }[]> {
  const prefix = query.toLowerCase();
  const { rows } = await getClient().execute({
    sql: `SELECT ${WALLET_COLS} FROM wallets WHERE address >= ? AND address < ? LIMIT 1000`,
    args: [prefix, exclusiveUpperBound(prefix)],
  });
  return (rows as unknown as WalletRow[])
    .map(mapWalletRow)
    .filter((w) => w.data.tier === "watch")
    .sort((a, b) => (b.data.aggregateROI ?? -Infinity) - (a.data.aggregateROI ?? -Infinity))
    .slice(0, limit);
}

// Cheap counts for the overview page's "N / total" tile -- avoids fetching
// and JSON-parsing every wallet row just to report two numbers.
export async function getWalletCounts(): Promise<{ total: number; watchlisted: number }> {
  const { rows } = await getClient().execute(`SELECT tier, count(*) AS c FROM wallets GROUP BY tier`);
  let total = 0;
  let watchlisted = 0;
  for (const r of rows as unknown as { tier: string; c: number }[]) {
    total += r.c;
    if (r.tier === "watch") watchlisted = r.c;
  }
  return { total, watchlisted };
}

export const getWallet = cache(async (address: string): Promise<{ id: string; data: Wallet } | null> => {
  const { rows } = await getClient().execute({ sql: `SELECT ${WALLET_COLS} FROM wallets WHERE address = ?`, args: [address] });
  return rows.length > 0 ? mapWalletRow(rows[0] as unknown as WalletRow) : null;
});

const PAPER_BET_COLS = `id, match_id AS "matchId", score_id AS "scoreId", tracked_leg AS "trackedLeg", edge_at_bet AS "edgeAtBet",
  price_at_bet AS "priceAtBet", stake, outcome, pnl, placed_at AS "placedAt", settled_at AS "settledAt", source`;

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
// whole-season view means reading EVERY match's R2 files. Confirmed live
// once 300+ matches existed: this took ~60s and briefly exhausted the S3
// client's socket limit before mapWithConcurrency fixed the crash. Without
// a competition filter to narrow things, cap to the most recent matches --
// a scope limit, not a full fix; the real fix is a wallet/trade index
// written during rankWallets.js's own scan, not a per-request R2 sweep.
const UNFILTERED_MATCH_SCAN_LIMIT = 150;

export async function getFilteredTradeRows(filters: TradeFilters): Promise<TradeRow[]> {
  const allMatches = await getMatches();
  let matches = filters.competition ? allMatches.filter((m) => m.data.competition === filters.competition) : allMatches;
  if (!filters.competition && matches.length > UNFILTERED_MATCH_SCAN_LIMIT) {
    matches = [...matches].sort((a, b) => b.data.kickoffTime.localeCompare(a.data.kickoffTime)).slice(0, UNFILTERED_MATCH_SCAN_LIMIT);
  }

  // Bounded concurrency: sequential was safe from the socket-exhaustion
  // crash unbounded Promise.all hit elsewhere, but at 300+ matches it was
  // slow enough to risk a serverless timeout. 40 at a time matches the
  // wallet detail page, now that the S3 client's maxSockets was raised to
  // 200 (see tradeArchive.ts) so this no longer re-triggers the crash.
  const perMatch = await mapWithConcurrency(matches, 40, async (match) => {
    const trades = await readAllTradesForMatch(match.id);
    return trades
      .filter((t) => !filters.wallet || t.wallet.toLowerCase().includes(filters.wallet.toLowerCase()))
      .filter((t) => !filters.outcome || t.outcome === filters.outcome)
      .map((t) => {
        const leg = legFor(t, match.data.marketConditionIds);
        return {
          matchId: match.id,
          competition: match.data.competition,
          homeTeam: match.data.homeTeam,
          awayTeam: match.data.awayTeam,
          wallet: t.wallet,
          side: t.side,
          outcome: t.outcome,
          leg,
          won: tradeWon(t, leg, match.data.resolved, match.data.result),
          size: t.size,
          price: t.price,
          timestamp: t.timestamp,
        };
      });
  });

  const rows = perMatch.flat();
  rows.sort((a, b) => b.timestamp - a.timestamp);
  return rows;
}

// Every resolved match's frozen confluence scores, with whether the
// tracked leg actually happened -- the raw input to lib/calibration.ts's
// bucketing. One row per score, not per match (a match can have many
// scores under the adaptive polling schedule).
export async function getCalibrationInputs(): Promise<{ probabilityEstimate: number; correct: boolean }[]> {
  const { rows } = await getClient().execute(`
    SELECT cs.probability_estimate AS "probabilityEstimate", cs.tracked_leg AS "trackedLeg", m.result
    FROM confluence_scores cs
    JOIN matches m ON m.event_id = cs.match_id
    WHERE m.resolved = 1 AND m.result IS NOT NULL AND cs.probability_estimate IS NOT NULL
  `);
  return (rows as unknown as { probabilityEstimate: number; trackedLeg: string; result: string }[]).map((r) => ({
    probabilityEstimate: r.probabilityEstimate,
    correct: r.trackedLeg === r.result,
  }));
}

// Every decided (win/loss) paper bet, with the minutesBeforeKickoff of the
// confluence score it was placed against -- the raw input to
// lib/breakdown.ts's timingBucketLabel segmentation. matchId is included
// so the page can apply the shared competition/date filter bar.
export async function getTimingCheckpointInputs(): Promise<
  { outcome: string; pnl: number | null; stake: number; minutesBeforeKickoff: number; matchId: string }[]
> {
  const { rows } = await getClient().execute(`
    SELECT pb.outcome, pb.pnl, pb.stake, pb.match_id AS "matchId", cs.minutes_before_kickoff AS "minutesBeforeKickoff"
    FROM paper_bets pb
    JOIN confluence_scores cs ON cs.id = pb.score_id
    WHERE pb.outcome IN ('win', 'loss')
  `);
  return rows as unknown as { outcome: string; pnl: number | null; stake: number; minutesBeforeKickoff: number; matchId: string }[];
}

// One row per (frozen confluence score, known outcome) -- the raw material
// for the backtest sandbox's edge-threshold/timing/back-vs-fade sliders.
// Deliberately every frozen score with a resolved result, NOT just the ones
// that actually cleared paperBets.js's live 5pp threshold -- the whole
// point is letting the user explore OTHER thresholds against the same
// history. priceAtBet is the tracked leg's raw (tradeable) price; fading
// means buying the tracked leg's "No" side instead, at (1 - priceAtBet).
export interface BacktestInput {
  matchId: string;
  kickoffTime: string;
  minutesBeforeKickoff: number;
  edge: number;
  priceAtBet: number;
  trackedLegWon: boolean;
}

export async function getBacktestInputs(): Promise<BacktestInput[]> {
  const { rows } = await getClient().execute(`
    SELECT cs.match_id AS "matchId", m.kickoff_time AS "kickoffTime", cs.minutes_before_kickoff AS "minutesBeforeKickoff",
           cs.edge, cs.market_implied_probability AS "priceAtBet", cs.tracked_leg AS "trackedLeg", m.result
    FROM confluence_scores cs
    JOIN matches m ON m.event_id = cs.match_id
    WHERE m.resolved = 1 AND m.result IS NOT NULL AND cs.edge IS NOT NULL
      AND cs.market_implied_probability IS NOT NULL AND cs.market_implied_probability > 0 AND cs.market_implied_probability < 1
  `);
  return (rows as unknown as (Omit<BacktestInput, "trackedLegWon"> & { trackedLeg: string; result: string })[]).map((r) => ({
    matchId: r.matchId,
    kickoffTime: r.kickoffTime,
    minutesBeforeKickoff: r.minutesBeforeKickoff,
    edge: r.edge,
    priceAtBet: r.priceAtBet,
    trackedLegWon: r.trackedLeg === r.result,
  }));
}
