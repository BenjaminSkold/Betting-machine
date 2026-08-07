// Milestone 4: the confluence/edge scoring engine. Reads watchlisted
// ("tier":"watch") wallets' activity on each upcoming match, turns it into
// a simple weighted signal, translates that into an estimated probability,
// and compares it against the market's own price at that checkpoint. No
// ML — see the "Weighting scheme, and why" comment block below for the
// full, documented formula. Read PROJECT.md's "Why edge, not just
// confidence" and "Adaptive polling schedule" sections before changing this.
//
// Under the adaptive schedule, snapshots are append-only (one per poll,
// not a fixed set of 60/15/10-min checkpoints) -- so every not-yet-scored
// snapshot gets its own confluence score, not just three per match.
import { getClient } from "./db.js";
import { readAllTradesForMatch } from "./tradeArchive.js";
import { isMainModule } from "./isMain.js";

// How far smart-wallet signal is allowed to move our probability estimate
// away from the market's own price, at maximum one-sidedness and maximum
// wallet skill. A deliberately conservative, explainable cap rather than a
// fitted parameter — revisit once real paper-bet results exist to judge
// whether 15 points is too timid or too aggressive.
const MAX_SHIFT = 0.15;

// A wallet's shrunk win rate ranges roughly 0-1 with 0.5 as "no edge over
// average". (winRate - 0.5) is therefore the wallet's per-trade skill
// weight, bounded to about ±0.5 for a maximally (im)precise wallet.
const MAX_SKILL_WEIGHT = 0.5;

// Buying "Yes" or selling "No" both mean betting a leg WILL happen; buying
// "No" or selling "Yes" both mean betting AGAINST it.
function direction(trade) {
  const betsFor = (trade.outcome === "Yes") === (trade.side === "BUY");
  return betsFor ? 1 : -1;
}

function legFor(trade, marketConditionIds) {
  const { home, draw, away } = marketConditionIds || {};
  if (trade.conditionId === home) return "home";
  if (trade.conditionId === draw) return "draw";
  if (trade.conditionId === away) return "away";
  return null;
}

function clip(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/*
 * Weighting scheme, and why:
 *
 * 1. For each leg (home/draw/away), sum `size * (winRate - 0.5) * direction`
 *    across every watchlisted wallet's trade on that leg. A big, one-sided,
 *    skilled-wallet position produces a big signal; a small or contested
 *    one produces a signal near zero.
 * 2. Normalize each leg's signal by the match's TOTAL watchlisted volume
 *    (not that leg's own volume) so a leg with only a little watchlisted
 *    money doesn't look artificially overconfident.
 * 3. Translate to a probability by nudging the market's own price for that
 *    leg by `MAX_SHIFT * (normalizedSignal / MAX_SKILL_WEIGHT)`, then clip
 *    and renormalize the three legs back to summing to 1.
 * 4. The leg reported at the top level is whichever of the three has the
 *    largest |edge| — the one that would actually be worth a paper bet.
 */
export function computeMatchScore(trades, walletsByAddress, marketPrices, marketConditionIds) {
  const watchlisted = trades.filter((t) => walletsByAddress.get(t.wallet)?.tier === "watch");

  const legs = { home: [], draw: [], away: [] };
  let totalVolume = 0;
  for (const trade of watchlisted) {
    const leg = legFor(trade, marketConditionIds);
    if (!leg) continue;
    legs[leg].push(trade);
    totalVolume += trade.size;
  }

  const breakdown = {};
  let bestLeg = null;
  let bestAbsEdge = -1;

  for (const leg of ["home", "draw", "away"]) {
    const legTrades = legs[leg];
    const contributingWallets = legTrades.map((t) => {
      const winRate = walletsByAddress.get(t.wallet).aggregateWinRate;
      const skillWeight = winRate - 0.5;
      return { wallet: t.wallet, size: t.size, direction: direction(t), winRate, weightedContribution: t.size * skillWeight * direction(t) };
    });
    const rawSignal = contributingWallets.reduce((sum, w) => sum + w.weightedContribution, 0);
    const normalizedSignal = totalVolume > 0 ? rawSignal / totalVolume : 0;

    const marketPrice = marketPrices[leg];
    const shift = MAX_SHIFT * (normalizedSignal / MAX_SKILL_WEIGHT);
    // With zero signal (shift === 0), pass the market price through
    // unclipped — a system with no signal must report no edge, not a clip
    // artifact from a lopsided-but-legitimate favorite.
    const rawEstimate =
      marketPrice === null || marketPrice === undefined ? null : shift === 0 ? marketPrice : clip(marketPrice + shift, 0.01, 0.99);

    breakdown[leg] = {
      score: normalizedSignal,
      marketImpliedProbability: marketPrice,
      rawEstimate,
      watchlistedTradeCount: legTrades.length,
      watchlistedVolume: legTrades.reduce((s, t) => s + t.size, 0),
      contributingWallets,
    };
  }

  const rawTotal = ["home", "draw", "away"].reduce((sum, leg) => sum + (breakdown[leg].rawEstimate ?? 0), 0);
  for (const leg of ["home", "draw", "away"]) {
    const b = breakdown[leg];
    b.probabilityEstimate = rawTotal > 0 && b.rawEstimate !== null ? b.rawEstimate / rawTotal : b.marketImpliedProbability;
    b.edge = b.marketImpliedProbability === null ? null : b.probabilityEstimate - b.marketImpliedProbability;
    delete b.rawEstimate;
    if (b.edge !== null && Math.abs(b.edge) > bestAbsEdge) {
      bestAbsEdge = Math.abs(b.edge);
      bestLeg = leg;
    }
  }

  if (!bestLeg) return null;
  return {
    trackedLeg: bestLeg,
    score: breakdown[bestLeg].score,
    probabilityEstimate: breakdown[bestLeg].probabilityEstimate,
    marketImpliedProbability: breakdown[bestLeg].marketImpliedProbability,
    edge: breakdown[bestLeg].edge,
    breakdown,
  };
}

async function loadWatchlistedWallets(client) {
  const { rows } = await client.execute(`SELECT address, tier, aggregate_win_rate AS "aggregateWinRate" FROM wallets`);
  const map = new Map();
  for (const r of rows) map.set(r.address, r);
  return map;
}

// Normalizes every not-yet-resolved match with a determined market into
// {id, homeTeam, awayTeam, kickoffTime, marketConditionIds, snapshots, trades}.
// Snapshots come from Turso (one row per poll); trades come from R2.
async function loadUpcomingMatches(client) {
  const { rows: matchRows } = await client.execute(
    `SELECT event_id AS "id", home_team AS "homeTeam", away_team AS "awayTeam", kickoff_time AS "kickoffTime",
            home_condition_id AS "home", draw_condition_id AS "draw", away_condition_id AS "away"
     FROM matches
     WHERE resolved = 0 AND home_condition_id IS NOT NULL AND draw_condition_id IS NOT NULL AND away_condition_id IS NOT NULL`
  );
  if (matchRows.length === 0) return [];

  const matches = [];
  for (const m of matchRows) {
    const { rows: snapshotRows } = await client.execute({
      sql: `SELECT id, minutes_before_kickoff AS "minutesBeforeKickoff", price_home AS "home", price_draw AS "draw", price_away AS "away"
            FROM snapshots WHERE match_id = ?`,
      args: [m.id],
    });
    if (snapshotRows.length === 0) continue;

    const trades = await readAllTradesForMatch(client, m.id);
    matches.push({
      id: m.id,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      kickoffTime: m.kickoffTime,
      marketConditionIds: { home: m.home, draw: m.draw, away: m.away },
      snapshots: snapshotRows.map((s) => ({
        id: String(s.id),
        minutesBeforeKickoff: s.minutesBeforeKickoff,
        prices: { home: s.home, draw: s.draw, away: s.away },
      })),
      trades,
    });
  }
  return matches;
}

// Scores every not-yet-frozen snapshot for one normalized match, writing
// each new confluence_scores row.
async function scoreMatch(client, match, walletsByAddress) {
  const scoreIds = match.snapshots.map((s) => `${match.id}_${s.id}`);
  const placeholders = scoreIds.map(() => "?").join(", ");
  const { rows: existingRows } = await client.execute({ sql: `SELECT id FROM confluence_scores WHERE id IN (${placeholders})`, args: scoreIds });
  const existing = new Set(existingRows.map((r) => r.id));

  let scored = 0;
  const kickoffMs = new Date(match.kickoffTime).getTime();
  for (const snapshot of match.snapshots) {
    const scoreId = `${match.id}_${snapshot.id}`;
    if (existing.has(scoreId)) continue;

    // Only trades that happened at-or-before this checkpoint — otherwise a
    // score would leak in trades that actually happened later.
    const checkpointMs = kickoffMs - snapshot.minutesBeforeKickoff * 60 * 1000;
    const tradesSoFar = match.trades.filter((t) => t.timestamp * 1000 <= checkpointMs);

    const result = computeMatchScore(tradesSoFar, walletsByAddress, snapshot.prices, match.marketConditionIds);
    if (!result) continue;

    await client.execute({
      sql: `INSERT INTO confluence_scores (id, match_id, snapshot_id, minutes_before_kickoff, tracked_leg, score, probability_estimate, market_implied_probability, edge, breakdown, frozen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING`,
      args: [
        scoreId,
        match.id,
        snapshot.id,
        snapshot.minutesBeforeKickoff,
        result.trackedLeg,
        result.score,
        result.probabilityEstimate,
        result.marketImpliedProbability,
        result.edge,
        JSON.stringify(result.breakdown),
        new Date().toISOString(),
      ],
    });
    scored++;
    console.log(
      `  ${match.homeTeam} vs. ${match.awayTeam} @ ${snapshot.minutesBeforeKickoff.toFixed(0)}min: ` +
        `tracked=${result.trackedLeg} edge=${(result.edge * 100).toFixed(1)}pp`
    );
  }
  return scored;
}

async function main() {
  const client = getClient();
  const walletsByAddress = await loadWatchlistedWallets(client);
  const watchCount = [...walletsByAddress.values()].filter((w) => w.tier === "watch").length;
  console.log(`${walletsByAddress.size} wallet(s) loaded, ${watchCount} on tier:"watch".`);
  if (watchCount === 0) {
    console.log("No watchlisted wallets yet — nothing to score. Run rankWallets.js once there's trade history.");
    return;
  }

  console.log("Loading upcoming matches...");
  const matches = await loadUpcomingMatches(client);

  let scored = 0;
  for (const match of matches) {
    scored += await scoreMatch(client, match, walletsByAddress);
  }

  console.log(`\nDone. ${scored} new confluence score(s) written.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("Scoring FAILED:", err);
    process.exit(1);
  });
}
