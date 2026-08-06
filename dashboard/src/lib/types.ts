// Mirrors the Firestore data model in PROJECT.md, as actually written by
// pipeline/src/{collect,backfill,rankWallets,scoreMatches,paperBets}.js.

export type Competition = "EPL" | "UCL" | "UEL" | "UECL";
export type Leg = "home" | "draw" | "away";

// Flattened, match-annotated trade row — shared shape between the Trades
// page and its CSV export so they can't silently drift apart.
export interface TradeRow {
  matchId: string;
  competition: Competition;
  homeTeam: string;
  awayTeam: string;
  wallet: string;
  side: string;
  outcome: string;
  size: number;
  price: number;
  timestamp: number;
}

export interface TradeFilters {
  wallet?: string;
  competition?: string;
  outcome?: string;
}

export interface Match {
  competition: Competition;
  homeTeam: string;
  awayTeam: string;
  kickoffTime: string; // ISO
  polymarketMarketId: string;
  resolved: boolean;
  result: Leg | null;
  marketConditionIds?: { home: string; draw: string; away: string };
}

export interface Snapshot {
  capturedAt: string | null;
  minutesBeforeKickoff: number;
  prices: { home: number | null; draw: number | null; away: number | null };
  liquidity: number | null;
  backfilled?: boolean;
}

export interface WalletSlice {
  trades: number;
  winRate: number | null;
  roi: number | null;
  usedFallback: boolean;
}

export interface Wallet {
  totalResolvedTrades: number;
  aggregateWinRate: number;
  aggregateROI: number | null;
  tier: "watch" | "unranked";
  bySlice: {
    byCompetition: Record<string, WalletSlice>;
    byTeam: Record<string, WalletSlice>;
  };
  lastUpdated: string;
}

export interface ContributingWallet {
  wallet: string;
  size: number;
  direction: 1 | -1;
  winRate: number;
  weightedContribution: number;
}

export interface LegBreakdown {
  score: number;
  marketImpliedProbability: number | null;
  watchlistedTradeCount: number;
  watchlistedVolume: number;
  contributingWallets: ContributingWallet[];
  probabilityEstimate: number | null;
  edge: number | null;
}

export interface ConfluenceScore {
  matchId: string;
  snapshotId: string;
  minutesBeforeKickoff: number;
  trackedLeg: Leg;
  score: number;
  probabilityEstimate: number;
  marketImpliedProbability: number;
  edge: number;
  breakdown: Record<Leg, LegBreakdown>;
  frozenAt: string;
}

export interface PaperBet {
  matchId: string;
  scoreId: string;
  trackedLeg: Leg;
  edgeAtBet: number;
  priceAtBet: number;
  stake: number;
  outcome: "win" | "loss" | "pending" | "void"; // void: match was postponed/voided, stake refunded (pnl 0)
  pnl: number | null;
  placedAt: string;
  settledAt: string | null;
}

// PROJECT.md's "When you're allowed to trust the results" — don't present
// confident-looking win rate/ROI numbers below this many settled bets.
export const MIN_SETTLED_BETS_TO_TRUST = 150;
