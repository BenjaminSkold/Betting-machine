// Milestone 4: the confluence/edge scoring engine. Reads watchlisted
// ("tier":"watch") wallets' activity on each upcoming match, turns it into
// a simple weighted signal, translates that into an estimated probability,
// and compares it against the market's own price at that checkpoint. No
// ML — see the "Weighting scheme, and why" comment block below for the
// full, documented formula. Read PROJECT.md's "Why edge, not just
// confidence" and "Timing snapshots" sections before changing this.
import { getDb } from "./firestoreRest.js";
import { findLiveMatches, getAllTrades, getPriceHistory, clobTokenIdsFor } from "./polymarket.js";
import { toStoredTrade } from "./tradeBatches.js";
import { isMainModule } from "./isMain.js";

const CHECKPOINTS_MIN = [60, 15, 10];
const LIVE_COMPETITIONS = ["EPL", "UCL", "UEL"];

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

// Firestore-backed loader — normalizes each match to
// {id, homeTeam, awayTeam, kickoffTime, marketConditionIds, snapshots, trades}
// so it can go through the same scoreMatch() as the Polymarket-direct path
// below, regardless of which one main() picks.
async function loadUpcomingMatchesFromFirestore(db) {
  const matchDocs = await db.collection("matches").list();
  const matches = [];
  for (const matchDoc of matchDocs) {
    const data = matchDoc.data();
    if (data.resolved || !data.marketConditionIds) continue; // scoring is for upcoming matches
    const snapshotDocs = await matchDoc.ref.collection("snapshots").list();
    if (snapshotDocs.length === 0) continue;
    const batches = await matchDoc.ref.collection("tradeBatches").list();
    matches.push({
      id: matchDoc.id,
      homeTeam: data.homeTeam,
      awayTeam: data.awayTeam,
      kickoffTime: data.kickoffTime,
      marketConditionIds: data.marketConditionIds,
      snapshots: snapshotDocs.map((s) => ({ id: s.id, minutesBeforeKickoff: s.data().minutesBeforeKickoff, prices: s.data().prices })),
      trades: batches.flatMap((b) => b.data().trades || []),
    });
  }
  return matches;
}

// A match event has 3 markets (home-win/draw/away-win) — same parsing as
// backfill.js/collect.js/rankWallets.js (duplicated for the same reason as
// rankWallets.js: backfill.js has no import.meta.main gate to import from).
export function classifyMarketsFromEvent(event) {
  const [homeTeam, awayTeam] = event.title.split(" vs. ").map((s) => s.trim());
  const found = {};
  for (const m of event.markets) {
    if (/end in a draw/i.test(m.question)) found.draw = m;
    else if (m.question.startsWith(`Will ${homeTeam} `)) found.home = m;
    else if (m.question.startsWith(`Will ${awayTeam} `)) found.away = m;
  }
  return { homeTeam, awayTeam, ...found };
}

export function kickoffTimeFromMarket(market, event) {
  if (market.gameStartTime) {
    const iso = market.gameStartTime.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(event.endDate);
}

// Same technique as backfill.js's own nearestPriceAt — finds the CLOB price
// point closest to a given checkpoint's exact timestamp.
async function nearestPriceAt(tokenId, kickoffTime, minutesBefore) {
  if (!tokenId) return null;
  const targetTs = Math.floor(kickoffTime.getTime() / 1000) - minutesBefore * 60;
  const points = await getPriceHistory(tokenId, { startTs: targetTs - 15 * 60, endTs: targetTs + 15 * 60, fidelity: 1 });
  if (points.length === 0) return null;
  let best = points[0];
  for (const p of points) {
    if (Math.abs(p.t - targetTs) < Math.abs(best.t - targetTs)) best = p;
  }
  return best.p;
}

// Rebuilds the same normalized match shape straight from Polymarket instead
// of reading matches/{id}/{snapshots,tradeBatches} back out of Firestore —
// for when Firestore's own read quota is what's blocking us, not
// Polymarket's. See rankWallets.js's loadResolvedMatchesFromPolymarket for
// the identical pattern and NOTES.md for how this was found. Opt-in via
// SCORE_MATCHES_FROM_POLYMARKET=1.
async function loadUpcomingMatchesFromPolymarket() {
  const matches = [];
  for (const competition of LIVE_COMPETITIONS) {
    const events = await findLiveMatches(competition);
    console.log(`[${competition}] ${events.length} live event(s) found`);
    for (const event of events) {
      const { homeTeam, awayTeam, home, draw, away } = classifyMarketsFromEvent(event);
      if (!home || !draw || !away) continue;

      const kickoffTime = kickoffTimeFromMarket(home, event);
      const tokens = { home: clobTokenIdsFor(home)[0], draw: clobTokenIdsFor(draw)[0], away: clobTokenIdsFor(away)[0] };

      const snapshots = [];
      for (const checkpoint of CHECKPOINTS_MIN) {
        const [homeP, drawP, awayP] = await Promise.all([
          nearestPriceAt(tokens.home, kickoffTime, checkpoint),
          nearestPriceAt(tokens.draw, kickoffTime, checkpoint),
          nearestPriceAt(tokens.away, kickoffTime, checkpoint),
        ]);
        if (homeP === null && drawP === null && awayP === null) continue;
        snapshots.push({ id: `checkpoint_${checkpoint}`, minutesBeforeKickoff: checkpoint, prices: { home: homeP, draw: drawP, away: awayP } });
      }
      if (snapshots.length === 0) continue;

      const rawTrades = [...(await getAllTrades(home.conditionId)), ...(await getAllTrades(draw.conditionId)), ...(await getAllTrades(away.conditionId))];
      matches.push({
        id: String(event.id),
        homeTeam,
        awayTeam,
        kickoffTime: kickoffTime.toISOString(),
        marketConditionIds: { home: home.conditionId, draw: draw.conditionId, away: away.conditionId },
        snapshots,
        trades: rawTrades.map(toStoredTrade),
      });
      console.log(`  ${event.title}: ${snapshots.length} checkpoint(s), ${rawTrades.length} trade(s)`);
    }
  }
  return matches;
}

// Scores every not-yet-frozen checkpoint for one normalized match, writing
// each new confluenceScores doc. Shared by both loaders above so they can
// never silently drift in scoring behavior.
async function scoreMatch(db, match, walletsByAddress) {
  let scored = 0;
  const kickoffMs = new Date(match.kickoffTime).getTime();
  for (const snapshot of match.snapshots) {
    const scoreId = `${match.id}_${snapshot.id}`;
    const existing = await db.collection("confluenceScores").doc(scoreId).get();
    if (existing.exists) continue;

    // Only trades that happened at-or-before this checkpoint — otherwise a
    // score computed for "60 min before kickoff" would be leaking in trades
    // that actually happened later, which would make the 60/15/10
    // checkpoint comparison Milestone 4 exists to enable meaningless.
    const checkpointMs = kickoffMs - snapshot.minutesBeforeKickoff * 60 * 1000;
    const tradesSoFar = match.trades.filter((t) => t.timestamp * 1000 <= checkpointMs);

    const result = computeMatchScore(tradesSoFar, walletsByAddress, snapshot.prices, match.marketConditionIds);
    if (!result) continue;

    await db.collection("confluenceScores").doc(scoreId).set({
      matchId: match.id,
      snapshotId: snapshot.id,
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
  return scored;
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

  const fromPolymarket = process.env.SCORE_MATCHES_FROM_POLYMARKET === "1";
  console.log(fromPolymarket ? "Loading upcoming matches directly from Polymarket (Firestore reads bypassed)..." : "Loading upcoming matches...");
  const matches = fromPolymarket ? await loadUpcomingMatchesFromPolymarket() : await loadUpcomingMatchesFromFirestore(db);

  let scored = 0;
  for (const match of matches) {
    scored += await scoreMatch(db, match, walletsByAddress);
  }

  console.log(`\nDone. ${scored} new confluence score(s) written.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("Scoring FAILED:", err);
    process.exit(1);
  });
}
