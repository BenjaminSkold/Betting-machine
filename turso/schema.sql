-- Turso (libSQL/SQLite) schema for aggregates. Raw trades are NOT stored
-- here -- they go to Cloudflare R2 as batched files (see
-- pipeline/src/tradeArchive.js). This split is the whole point of the
-- move off a single relational database: the millions-of-rows trade data
-- that blew through Firestore's and then Supabase's free-tier storage caps
-- never touches the live database at all.
--
-- SQLite/libSQL differences from the old Postgres schema, worth noting:
-- - No native jsonb -- JSON-shaped columns (by_slice, trend, breakdown)
--   are stored as TEXT containing JSON, parsed/stringified in JS.
-- - No native boolean -- 0/1 INTEGER, converted to/from JS booleans at
--   the data-access layer.
-- - No NUMERIC-returns-as-string gotcha like node-postgres had -- libSQL's
--   client returns REAL columns as proper JS numbers, so no type-parser
--   workaround is needed here.
-- - Timestamps are ISO 8601 TEXT, always written explicitly from JS
--   (new Date().toISOString()) rather than relying on SQL-side NOW()/
--   CURRENT_TIMESTAMP defaults, which format differently in SQLite.

CREATE TABLE matches (
  event_id TEXT PRIMARY KEY,               -- Polymarket event id
  competition TEXT NOT NULL,               -- 'EPL' | 'UCL' | 'UEL'
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  kickoff_time TEXT NOT NULL,              -- ISO 8601
  polymarket_market_id TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  result TEXT,                             -- 'home' | 'draw' | 'away' | null
  home_condition_id TEXT,
  draw_condition_id TEXT,
  away_condition_id TEXT,
  last_seen_timestamp TEXT NOT NULL DEFAULT '{}',      -- JSON {conditionId: unix_seconds}
  last_seen_keys_at_cursor TEXT NOT NULL DEFAULT '{}', -- JSON {conditionId: [tradeKey, ...]}
  -- Adaptive-polling bookkeeping: when this match was last polled, so
  -- collect.js can decide whether the current cadence tier's interval has
  -- elapsed yet. There's no separate "schedule" table -- the cadence
  -- lookup (days-out -> hours -> minutes -> seconds, per PROJECT.md's
  -- table) is computed live from kickoff_time, not persisted.
  last_polled_at TEXT,
  trades_backfilled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX matches_competition_idx ON matches (competition);
CREATE INDEX matches_resolved_idx ON matches (resolved);
CREATE INDEX matches_kickoff_time_idx ON matches (kickoff_time);

-- One row per poll (not per fixed checkpoint like the old 60/15/10 scheme)
-- -- the adaptive schedule means the number of snapshots per match varies
-- a lot, so this is append-only rather than upserted into fixed slots.
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES matches (event_id),
  captured_at TEXT, -- null for backfilled snapshots -- there was no live "capture" moment
  minutes_before_kickoff REAL,
  price_home REAL,
  price_draw REAL,
  price_away REAL,
  liquidity REAL,
  backfilled INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX snapshots_match_id_idx ON snapshots (match_id);

CREATE TABLE wallets (
  address TEXT PRIMARY KEY,
  total_resolved_trades INTEGER NOT NULL DEFAULT 0,
  aggregate_win_rate REAL,
  aggregate_roi REAL,
  tier TEXT NOT NULL DEFAULT 'unranked',   -- 'watch' | 'unranked'
  by_slice TEXT NOT NULL DEFAULT '{}',     -- JSON {byCompetition, byTeam, byMonth}
  trend TEXT NOT NULL DEFAULT '{}',        -- JSON {early, recent, delta, label}
  last_updated TEXT NOT NULL
);

CREATE INDEX wallets_tier_idx ON wallets (tier);

CREATE TABLE confluence_scores (
  id TEXT PRIMARY KEY,                     -- {matchId}_{snapshotId}
  match_id TEXT NOT NULL REFERENCES matches (event_id),
  snapshot_id TEXT NOT NULL,
  minutes_before_kickoff REAL,
  tracked_leg TEXT,
  score REAL,
  probability_estimate REAL,
  market_implied_probability REAL,
  edge REAL,
  breakdown TEXT NOT NULL DEFAULT '{}',    -- JSON
  frozen_at TEXT NOT NULL
);

CREATE INDEX confluence_scores_match_id_idx ON confluence_scores (match_id);

CREATE TABLE paper_bets (
  id TEXT PRIMARY KEY,                     -- same id as the confluence_scores row it came from
  match_id TEXT NOT NULL REFERENCES matches (event_id),
  score_id TEXT NOT NULL REFERENCES confluence_scores (id),
  tracked_leg TEXT,
  edge_at_bet REAL,
  price_at_bet REAL,
  stake REAL NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'win' | 'loss' | 'void'
  pnl REAL,
  placed_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE INDEX paper_bets_outcome_idx ON paper_bets (outcome);

CREATE TABLE pipeline_status (
  key TEXT PRIMARY KEY,                    -- singleton row, key = 'status'
  last_successful_run TEXT,
  matches_processed INTEGER,
  matches_failed INTEGER
);

-- Self-tracked R2 usage, checked BEFORE every write (see
-- pipeline/src/tradeArchive.js's usage guard). Cloudflare requires a card
-- on file to enable R2 at all, even though the first 10GB storage / 1M
-- writes / 10M reads per month are free -- this is what stops the pipeline
-- from ever silently crossing into billed usage, rather than trusting a
-- dashboard alert someone has to notice.
--
-- 'r2_bytes_stored' uses period='total' (storage never resets monthly).
-- 'r2_class_a_ops' (writes/lists) and 'r2_class_b_ops' (reads) use
-- period='YYYY-MM', since Cloudflare's operation quotas reset monthly.
CREATE TABLE usage_stats (
  metric TEXT NOT NULL,
  period TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (metric, period)
);
