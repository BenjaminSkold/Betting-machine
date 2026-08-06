// Milestone 3, Tier 2: turns the raw Tier 1 trade log into per-wallet
// aggregate + sliced stats, with shrinkage so small samples don't outrank
// proven wallets by luck. Read PROJECT.md's "Wallet tracking logic" section
// before changing the thresholds below — they're deliberately simple,
// documented guesses meant to be revisited once real data exists, not
// tuned constants.
import { appendFileSync, createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDb } from "./firestoreRest.js";
import { chunk, toStoredTrade } from "./tradeBatches.js";
import { findResolvedMatches, getAllTrades } from "./polymarket.js";
import { isMainModule } from "./isMain.js";

const BACKFILL_COMPETITIONS = ["EPL", "UCL", "UEL"];

// loadResolvedMatchesFromPolymarket's local resume cache — deliberately NOT
// Firestore (that's the whole point of this bypass) and deliberately NOT in
// $CLAUDE_JOB_DIR/tmp (that's wiped between sessions; this needs to survive
// a crashed run). One JSON object per line, appended as each match finishes,
// so a killed process loses at most its one in-flight match, not the whole
// run — found necessary live, after an unretried 408 killed a run ~20
// minutes and ~600 matches in. Delete this file to force a fully fresh
// re-fetch (e.g. once Firestore's read quota is healthy again and this
// bypass is no longer needed).
const POLYMARKET_CACHE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".rankwallets-polymarket-cache.jsonl");

// Found this needs to be far smaller than Firestore's own 500-write limit
// once writing hit the current project's real (severely constrained) write
// ceiling: a 500-write commit consistently 429'd even after the full retry
// budget, while a single isolated write always succeeds. Not confirmed
// exactly where the real ceiling sits, but small batches are the pragmatic
// middle ground between "1 at a time" (reliable but ~200k writes would take
// a day) and "500 at once" (fast but doesn't land at all right now).
const FIRESTORE_BATCH_LIMIT = 25;

// "Enough resolved trades to say anything meaningful" — PROJECT.md's own
// suggested starting point. Below this, a slice/wallet falls back to a
// coarser number instead of reporting its own (too-noisy) rate.
const MIN_TRADES = 8;

// Shrinkage strength: pulls a wallet's raw win rate toward the global
// average proportional to k / (n + k) — a wallet with exactly k trades gets
// its estimate weighted half raw, half prior. k=10 roughly matches the
// 8-10 minimum-sample guidance: a wallet right at the activity bar is still
// pulled hard toward the average, and needs a real edge to clear the
// quality bar below.
const SHRINKAGE_K = 10;

// How far a wallet's early-vs-recent shrunk win rate has to move before
// it's called a real trend rather than noise — same 5pp bar used elsewhere
// in this project (paperBets.js's edge threshold) for "a meaningful signal,"
// not a fitted constant.
const TREND_THRESHOLD = 0.05;

function shrink(wins, n, prior) {
  if (n === 0) return prior;
  return (wins + SHRINKAGE_K * prior) / (n + SHRINKAGE_K);
}

// Simplified, transparent P&L model (per PROJECT.md: hand-checkable, no
// ML). A binary market share bought at `price` pays $1 if its side wins,
// $0 otherwise. SELL is modeled as the mirror image of a BUY on the same
// side — Polymarket's actual short/exit mechanics are more nuanced than
// this, but this is a deliberate v1 simplification, not a bug.
function pnlAndStake(trade, sideWon) {
  const { side, price, size } = trade;
  if (side === "BUY") {
    return sideWon ? { pnl: size * (1 - price), stake: price * size } : { pnl: -size * price, stake: price * size };
  }
  // SELL
  return sideWon
    ? { pnl: -size * (1 - price), stake: (1 - price) * size }
    : { pnl: size * price, stake: (1 - price) * size };
}

// Which leg (home/draw/away) a trade's conditionId corresponds to, and
// whether that leg was the one that actually happened.
function legFor(trade, match) {
  const { home, draw, away } = match.marketConditionIds || {};
  if (trade.conditionId === home) return "home";
  if (trade.conditionId === draw) return "draw";
  if (trade.conditionId === away) return "away";
  return null;
}

async function loadResolvedMatchesWithTrades(db) {
  const matchDocs = await db.collection("matches").list();
  const matches = [];
  for (const doc of matchDocs) {
    const data = doc.data();
    if (!data.resolved || !data.result || !data.marketConditionIds) continue;
    const batches = await doc.ref.collection("tradeBatches").list();
    const trades = batches.flatMap((b) => b.data().trades || []);
    matches.push({ id: doc.id, ...data, trades });
  }
  return matches;
}

// A match event has 3 markets (home-win/draw/away-win), each phrased as
// "Will {team} win on {date}?" or "... end in a draw?" — same parsing as
// backfill.js/collect.js (duplicated rather than imported: backfill.js has
// no import.meta.main gate, so importing it would run its whole main()).
function classifyMarketsFromEvent(event) {
  const [homeTeam, awayTeam] = event.title.split(" vs. ").map((s) => s.trim());
  const found = {};
  for (const m of event.markets) {
    if (/end in a draw/i.test(m.question)) found.draw = m;
    else if (m.question.startsWith(`Will ${homeTeam} `)) found.home = m;
    else if (m.question.startsWith(`Will ${awayTeam} `)) found.away = m;
  }
  return { homeTeam, awayTeam, ...found };
}

function yesPriceFromMarket(market) {
  try {
    const prices = JSON.parse(market.outcomePrices || "[]");
    return prices.length ? Number(prices[0]) : null;
  } catch {
    return null;
  }
}

function resultFromMarkets(home, draw, away) {
  if (yesPriceFromMarket(home) > 0.9) return "home";
  if (yesPriceFromMarket(draw) > 0.9) return "draw";
  if (yesPriceFromMarket(away) > 0.9) return "away";
  return null;
}

// Rebuilds the exact same {competition, homeTeam, awayTeam, result,
// marketConditionIds, trades} shape loadResolvedMatchesWithTrades reads back
// out of Firestore — but straight from Polymarket instead. For when
// Firestore's own READ quota is what's blocking us, not Polymarket's (a
// completely separate service with unrelated rate limits) — see NOTES.md
// for how this was found. Deliberately not the default path: re-fetching
// everything Firestore already has is wasteful once Firestore itself is
// healthy again, so this is opt-in via RANK_WALLETS_FROM_POLYMARKET=1.
// Streams the cache line-by-line rather than reading the whole file into one
// JS string — found necessary live once the cache grew past 800MB (892
// matches, many with 10-20k+ trades each) and readFileSync threw
// ERR_STRING_TOO_LONG (Node's ~512MB single-string ceiling). A stream has no
// such limit regardless of file size.
async function loadPolymarketCache() {
  const byId = new Map();
  if (!existsSync(POLYMARKET_CACHE_PATH)) return byId;
  const rl = createInterface({ input: createReadStream(POLYMARKET_CACHE_PATH, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const match = JSON.parse(line);
      byId.set(match.id, match);
    } catch {
      // A truncated trailing line (process killed mid-write) — the match it
      // belongs to just gets re-fetched below, same as if it were missing.
    }
  }
  return byId;
}

async function loadResolvedMatchesFromPolymarket() {
  const cached = await loadPolymarketCache();
  if (cached.size > 0) console.log(`Resuming from local cache: ${cached.size} match(es) already fetched in a previous run.`);
  const matches = [...cached.values()];

  for (const competition of BACKFILL_COMPETITIONS) {
    const events = await findResolvedMatches(competition);
    console.log(`[${competition}] ${events.length} resolved event(s) found, fetching trades for each...`);
    for (const event of events) {
      const id = String(event.id);
      if (cached.has(id)) continue; // already fetched (and cached) in a previous, possibly-interrupted run

      const { homeTeam, awayTeam, home, draw, away } = classifyMarketsFromEvent(event);
      if (!home || !draw || !away) {
        console.log(`  SKIP "${event.title}" — could not classify all 3 markets`);
        continue;
      }
      const result = resultFromMarkets(home, draw, away);
      if (!result) {
        console.log(`  SKIP "${event.title}" — no determined result (postponed/voided)`);
        continue; // matches this file's own filter: needs a determined result
      }
      const rawTrades = [...(await getAllTrades(home.conditionId)), ...(await getAllTrades(draw.conditionId)), ...(await getAllTrades(away.conditionId))];
      console.log(`  ${event.title}: result=${result} trades=${rawTrades.length}`);
      const match = {
        id,
        competition,
        homeTeam,
        awayTeam,
        result,
        marketConditionIds: { home: home.conditionId, draw: draw.conditionId, away: away.conditionId },
        trades: rawTrades.map(toStoredTrade),
      };
      matches.push(match);
      appendFileSync(POLYMARKET_CACHE_PATH, JSON.stringify(match) + "\n");
    }
    console.log(`  ${matches.length} total match(es) with a determined result so far, across all competitions processed.`);
  }
  return matches;
}

// Flattens every (wallet, trade, match) triple into a single row with the
// win/pnl/stake/slice info already resolved, so aggregation below is just
// grouping and summing.
function buildTradeRows(matches) {
  const rows = [];
  for (const match of matches) {
    for (const trade of match.trades) {
      const leg = legFor(trade, match);
      if (!leg) continue; // trade on a market leg we can't identify — skip
      const legWon = leg === match.result;
      const sideWon = (trade.outcome === "Yes") === legWon;
      const { pnl, stake } = pnlAndStake(trade, sideWon);
      rows.push({
        wallet: trade.wallet,
        win: sideWon,
        pnl,
        stake,
        competition: match.competition,
        team: leg === "home" ? match.homeTeam : leg === "away" ? match.awayTeam : null,
        timestamp: trade.timestamp,
      });
    }
  }
  return rows;
}

function summarize(rows, prior) {
  const n = rows.length;
  const wins = rows.filter((r) => r.win).length;
  const pnl = rows.reduce((sum, r) => sum + r.pnl, 0);
  const stake = rows.reduce((sum, r) => sum + r.stake, 0);
  return {
    trades: n,
    winRate: n > 0 ? wins / n : null,
    shrunkWinRate: shrink(wins, n, prior),
    roi: stake > 0 ? pnl / stake : null,
    pnl,
  };
}

function sliceBy(rows, keyFn, prior, fallback) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key === null || key === undefined) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const out = {};
  for (const [key, groupRows] of groups) {
    const summary = summarize(groupRows, prior);
    const enough = summary.trades >= MIN_TRADES;
    out[key] = {
      trades: summary.trades,
      winRate: enough ? summary.shrunkWinRate : fallback.shrunkWinRate,
      roi: enough ? summary.roi : fallback.roi,
      usedFallback: !enough,
    };
  }
  return out;
}

// "YYYY-MM" bucket, in UTC — coarse enough that even a moderately active
// wallet clears MIN_TRADES within a bucket most months, fine enough to
// actually show a within-season trend on a chart.
function monthKey(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 7);
}

// A wallet "starting hot and fading" (or the reverse) is exactly the kind of
// thing shrinkage toward a single career-long prior can hide — one aggregate
// win rate has no way to say a wallet's edge has decayed. Deliberately
// simple and hand-checkable rather than a fitted trend model (see
// PROJECT.md's "no ML" constraint): sort a wallet's own trades
// chronologically, split into an early half and a recent half by count (not
// by calendar window, so both halves get a comparably-sized sample instead
// of one side being starved by an uneven trading cadence), and compare
// shrunk win rates. Requires MIN_TRADES on *both* halves independently —
// a wallet that barely clears the aggregate activity bar shouldn't have a
// trend claimed about it from an even thinner half-sample.
function computeTrend(walletRows, prior) {
  const sorted = [...walletRows].sort((a, b) => a.timestamp - b.timestamp);
  const mid = Math.floor(sorted.length / 2);
  const early = summarize(sorted.slice(0, mid), prior);
  const recent = summarize(sorted.slice(mid), prior);
  const earlyEnough = early.trades >= MIN_TRADES;
  const recentEnough = recent.trades >= MIN_TRADES;

  let label = "insufficient data";
  let delta = null;
  if (earlyEnough && recentEnough) {
    delta = recent.shrunkWinRate - early.shrunkWinRate;
    label = delta <= -TREND_THRESHOLD ? "declining" : delta >= TREND_THRESHOLD ? "improving" : "stable";
  }

  return {
    early: { trades: early.trades, winRate: early.shrunkWinRate, roi: early.roi, usedFallback: !earlyEnough },
    recent: { trades: recent.trades, winRate: recent.shrunkWinRate, roi: recent.roi, usedFallback: !recentEnough },
    delta,
    label,
  };
}

async function main() {
  const db = getDb();
  const fromPolymarket = process.env.RANK_WALLETS_FROM_POLYMARKET === "1";
  console.log(fromPolymarket ? "Loading resolved matches + trades directly from Polymarket (Firestore reads bypassed)..." : "Loading resolved matches + trades...");
  const matches = fromPolymarket ? await loadResolvedMatchesFromPolymarket() : await loadResolvedMatchesWithTrades(db);
  console.log(`${matches.length} resolved match(es) with a determined result.`);

  const rows = buildTradeRows(matches);
  console.log(`${rows.length} trade row(s) joined to a match result.`);
  if (rows.length === 0) {
    console.log("Nothing to rank yet.");
    return;
  }

  const globalWins = rows.filter((r) => r.win).length;
  const globalPrior = globalWins / rows.length;
  console.log(`Global baseline win rate: ${(globalPrior * 100).toFixed(1)}% across ${rows.length} trades.`);

  const byWallet = new Map();
  for (const row of rows) {
    if (!byWallet.has(row.wallet)) byWallet.set(row.wallet, []);
    byWallet.get(row.wallet).push(row);
  }

  const results = [];
  for (const [wallet, walletRows] of byWallet) {
    const aggregate = summarize(walletRows, globalPrior);
    const meetsActivityBar = aggregate.trades >= MIN_TRADES;
    const meetsQualityBar = aggregate.shrunkWinRate > globalPrior;
    const tier = meetsActivityBar && meetsQualityBar ? "watch" : "unranked";

    const byCompetition = sliceBy(walletRows, (r) => r.competition, globalPrior, aggregate);
    const byTeam = sliceBy(walletRows, (r) => r.team, globalPrior, aggregate);
    const byMonth = sliceBy(walletRows, (r) => monthKey(r.timestamp), globalPrior, aggregate);
    const trend = computeTrend(walletRows, globalPrior);

    results.push({
      wallet,
      totalResolvedTrades: aggregate.trades,
      aggregateWinRate: aggregate.shrunkWinRate,
      aggregateROI: aggregate.roi,
      tier,
      bySlice: { byCompetition, byTeam, byMonth },
      trend,
      lastUpdated: new Date().toISOString(),
    });
  }

  results.sort((a, b) => b.aggregateWinRate - a.aggregateWinRate);
  const watchCount = results.filter((r) => r.tier === "watch").length;
  console.log(`${results.length} distinct wallet(s), ${watchCount} promoted to tier:"watch".`);
  console.log("\nTop 10 by shrunk win rate:");
  for (const r of results.slice(0, 10)) {
    console.log(
      `  ${r.wallet.slice(0, 10)}... n=${r.totalResolvedTrades} winRate=${(r.aggregateWinRate * 100).toFixed(1)}% ` +
        `roi=${r.aggregateROI === null ? "n/a" : (r.aggregateROI * 100).toFixed(1) + "%"} tier=${r.tier}`
    );
  }

  const decliningWatch = results.filter((r) => r.tier === "watch" && r.trend.label === "declining");
  if (decliningWatch.length > 0) {
    console.log(`\n${decliningWatch.length} watched wallet(s) trending down (recent half well below their own early half):`);
    for (const r of decliningWatch) {
      console.log(
        `  ${r.wallet.slice(0, 10)}... early=${(r.trend.early.winRate * 100).toFixed(1)}% ` +
          `recent=${(r.trend.recent.winRate * 100).toFixed(1)}% (${(r.trend.delta * 100).toFixed(1)}pp)`
      );
    }
  }

  // Only wallets that clear the activity bar are analytically meaningful —
  // the same MIN_TRADES bar already used everywhere else in this file (see
  // sliceBy's own "enough" check). Found necessary live: this dataset has
  // ~200k distinct wallets, the overwhelming majority one-off/low-volume
  // noise traders that will never be tier:"watch" and are unlikely to ever
  // be looked up individually. Writing all of them isn't just slow under
  // the current write constraints, it's genuinely not useful — Tier 1's
  // "log everyone, no filtering" is about the raw trade log (PROJECT.md),
  // not about every one-off trader needing a processed ranking document.
  const toWrite = results.filter((r) => r.totalResolvedTrades >= MIN_TRADES);
  console.log(`\n${results.length} distinct wallet(s) total, ${toWrite.length} clear the ${MIN_TRADES}-trade activity bar and will be written.`);

  console.log("\nWriting wallets/ ...");
  for (const group of chunk(toWrite, FIRESTORE_BATCH_LIMIT)) {
    const batch = db.batch();
    for (const r of group) batch.set(db.collection("wallets").doc(r.wallet), r);
    await batch.commit();
  }
  console.log("Done.");
}

export {
  shrink,
  pnlAndStake,
  legFor,
  buildTradeRows,
  summarize,
  sliceBy,
  monthKey,
  computeTrend,
  classifyMarketsFromEvent,
  resultFromMarkets,
  MIN_TRADES,
  SHRINKAGE_K,
  TREND_THRESHOLD,
};

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("Wallet ranking FAILED:", err);
    process.exit(1);
  });
}
