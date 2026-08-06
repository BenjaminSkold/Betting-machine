// Milestone 4: the confluence/edge scoring engine. Reads watchlisted
// ("tier":"watch") wallets' activity on each upcoming match, turns it into
// a simple weighted signal, translates that into an estimated probability,
// and compares it against the market's own price at that checkpoint. No
// ML — see the "Weighting scheme, and why" comment block below for the
// full, documented formula. Read PROJECT.md's "Why edge, not just
// confidence" and "Timing snapshots" sections before changing this.
import { getDb } from "./firestoreRest.js";
import { isMainModule } from "./isMain.js";

const CHECKPOINTS_MIN = [60, 15, 10];

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
// "No" or selling "Yes" both mean betting AGAINST it. This is the same
// direction convention as rankWallets.js's win/loss check, just phrased as
// "which way is this trade betting" instead of "did this trade win".
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
 *    one produces a signal near zero. This is the "raw confluence" —
 *    literally just a weighted vote, no fitting involved.
 * 2. Normalize each leg's signal by the match's TOTAL watchlisted volume
 *    (not that leg's own volume) so a leg with only a little watchlisted
 *    money doesn't look artificially overconfident just because whatever
 *    little volume it has happens to agree. `score` in the output is this
 *    normalized number for whichever leg ends up tracked.
 * 3. Translate to a probability by nudging the market's own price for that
 *    leg by `MAX_SHIFT * (normalizedSignal / MAX_SKILL_WEIGHT)` — i.e. the
 *    nudge scales linearly from 0 up to ±MAX_SHIFT at maximum signal — then
 *    clip and renormalize the three legs back to summing to 1.
 * 4. The leg reported at the top level (probabilityEstimate/edge/etc.) is
 *    whichever of the three has the largest |edge| — that's the leg that
 *    would actually be worth a paper bet, per "Why edge, not just
 *    confidence". All three legs' numbers are kept in `breakdown` either
 *    way, since the confidence score must always show its breakdown.
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
    // unclipped. Clipping unconditionally to [0.01, 0.99] used to move a
    // lopsided-but-legitimate market price (e.g. 0.995 on a near-certain
    // favorite) even with no watchlisted activity at all, manufacturing a
    // nonzero "edge" purely from the clip bounds — found by an independent
    // code review. A system with no signal must report no edge.
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

  // Renormalize the three raw estimates so they sum to 1, same as the
  // market's own prices do.
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

async function loadWatchlistedWallets(db) {
  const docs = await db.collection("wallets").list();
  const map = new Map();
  for (const doc of docs) map.set(doc.id, doc.data());
  return map;
}

async function main() {
  const db = getDb();
  const walletsByAddress = await loadWatchlistedWallets(db);
  const watchCount = [...walletsByAddress.values()].filter((w) => w.tier === "watch").length;
  console.log(`${walletsByAddress.size} wallet(s) loaded, ${watchCount} on tier:"watch".`);
  if (watchCount === 0) {
    console.log("No watchlisted wallets yet — nothing to score. Run rankWallets.js once there's trade history.");
    return;
  }

  const matches = await db.collection("matches").list();
  let scored = 0;

  for (const matchDoc of matches) {
    const match = matchDoc.data();
    if (match.resolved || !match.marketConditionIds) continue; // scoring is for upcoming matches

    const snapshots = await matchDoc.ref.collection("snapshots").list();
    if (snapshots.length === 0) continue;

    const batches = await matchDoc.ref.collection("tradeBatches").list();
    const allTrades = batches.flatMap((b) => b.data().trades || []);

    for (const snapDoc of snapshots) {
      const snapshot = snapDoc.data();
      const scoreId = `${matchDoc.id}_${snapDoc.id}`;
      const existing = await db.collection("confluenceScores").doc(scoreId).get();
      if (existing.exists) continue;

      // Only trades that happened at-or-before this checkpoint — otherwise
      // a score computed for "60 min before kickoff" would be leaking in
      // trades that actually happened later, which would make the 60/15/10
      // checkpoint comparison Milestone 4 exists to enable meaningless.
      const kickoffMs = new Date(match.kickoffTime).getTime();
      const checkpointMs = kickoffMs - snapshot.minutesBeforeKickoff * 60 * 1000;
      const tradesSoFar = allTrades.filter((t) => t.timestamp * 1000 <= checkpointMs);

      const result = computeMatchScore(tradesSoFar, walletsByAddress, snapshot.prices, match.marketConditionIds);
      if (!result) continue;

      await db.collection("confluenceScores").doc(scoreId).set({
        matchId: matchDoc.id,
        snapshotId: snapDoc.id,
        minutesBeforeKickoff: snapshot.minutesBeforeKickoff,
        trackedLeg: result.trackedLeg,
        score: result.score,
        probabilityEstimate: result.probabilityEstimate,
        marketImpliedProbability: result.marketImpliedProbability,
        edge: result.edge,
        breakdown: result.breakdown,
        frozenAt: new Date().toISOString(),
      });
      scored++;
      console.log(
        `  ${match.homeTeam} vs. ${match.awayTeam} @ ${snapshot.minutesBeforeKickoff}min: ` +
          `tracked=${result.trackedLeg} edge=${(result.edge * 100).toFixed(1)}pp`
      );
    }
  }

  console.log(`\nDone. ${scored} new confluence score(s) written.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("Scoring FAILED:", err);
    process.exit(1);
  });
}
