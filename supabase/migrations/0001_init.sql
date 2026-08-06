-- Initial Postgres schema for the betting pipeline, replacing Firestore.
--
-- The Firestore schema denormalized trades into tradeBatches (arrays of
-- ~300 trades per doc) purely to stay under the free-tier 20k-writes/day
-- quota. That constraint doesn't exist in Postgres, so trades go back to
-- one row per trade here. Similarly, rankWallets.js/scoreMatches.js used
-- to `list()` (full scan) the entire matches collection every run because
-- Firestore has no server-side filtering in this REST client -- here they
-- should use indexed WHERE queries instead (e.g. WHERE resolved = true).

create table matches (
  event_id text primary key,               -- Polymarket event id
  competition text not null,               -- 'EPL' | 'UCL' | 'UEL'
  home_team text not null,
  away_team text not null,
  kickoff_time timestamptz not null,
  polymarket_market_id text,
  resolved boolean not null default false,
  result text,                             -- 'home' | 'draw' | 'away' | null
  home_condition_id text,
  draw_condition_id text,
  away_condition_id text,
  last_seen_timestamp jsonb not null default '{}',      -- {conditionId: unix_seconds}
  last_seen_keys_at_cursor jsonb not null default '{}',  -- {conditionId: [tradeKey, ...]}
  trades_backfilled boolean not null default false,
  updated_at timestamptz not null default now()
);

create index matches_competition_idx on matches (competition);
create index matches_resolved_idx on matches (resolved);
create index matches_kickoff_time_idx on matches (kickoff_time);

create table snapshots (
  match_id text not null references matches (event_id) on delete cascade,
  checkpoint text not null,                -- '60' | '15' | '10'
  captured_at timestamptz,
  minutes_before_kickoff numeric,
  price_home numeric,
  price_draw numeric,
  price_away numeric,
  liquidity numeric,
  backfilled boolean not null default false,
  primary key (match_id, checkpoint)
);

-- Primary key doubles as the de-dup key that tradeId used to serve in
-- Firestore (transactionHash_asset_outcomeIndex) -- reruns can upsert
-- safely without creating duplicate trades.
create table trades (
  id text primary key,                     -- {transactionHash}_{asset}_{outcomeIndex}
  match_id text not null references matches (event_id) on delete cascade,
  condition_id text not null,
  wallet text not null,
  side text not null,                      -- 'BUY' | 'SELL'
  size numeric not null,
  price numeric not null,
  timestamp bigint not null,               -- unix seconds
  outcome text not null
);

create index trades_match_id_idx on trades (match_id);
create index trades_wallet_idx on trades (wallet);
create index trades_condition_id_idx on trades (condition_id);

create table wallets (
  address text primary key,
  total_resolved_trades integer not null default 0,
  aggregate_win_rate numeric,
  aggregate_roi numeric,
  tier text not null default 'unranked',   -- 'watch' | 'unranked'
  by_slice jsonb not null default '{}',    -- {byCompetition, byTeam, byMonth}
  trend jsonb not null default '{}',       -- {early, recent, delta, label}
  last_updated timestamptz not null default now()
);

create index wallets_tier_idx on wallets (tier);

create table confluence_scores (
  id text primary key,                     -- {matchId}_{snapshotId}
  match_id text not null references matches (event_id) on delete cascade,
  snapshot_id text not null,
  minutes_before_kickoff numeric,
  tracked_leg text,
  score numeric,
  probability_estimate numeric,
  market_implied_probability numeric,
  edge numeric,
  breakdown jsonb not null default '{}',
  frozen_at timestamptz not null default now()
);

create index confluence_scores_match_id_idx on confluence_scores (match_id);

create table paper_bets (
  id text primary key,                     -- same id as the confluence_scores row it came from
  match_id text not null references matches (event_id) on delete cascade,
  score_id text not null references confluence_scores (id) on delete cascade,
  tracked_leg text,
  edge_at_bet numeric,
  price_at_bet numeric,
  stake numeric not null,
  outcome text not null default 'pending', -- 'pending' | 'win' | 'loss' | 'void'
  pnl numeric,
  placed_at timestamptz not null default now(),
  settled_at timestamptz
);

create index paper_bets_outcome_idx on paper_bets (outcome);

create table pipeline_status (
  key text primary key,                    -- singleton row, key = 'status'
  last_successful_run timestamptz,
  matches_processed integer,
  matches_failed integer
);
