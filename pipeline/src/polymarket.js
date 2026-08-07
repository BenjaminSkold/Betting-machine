// Thin client around Polymarket's public read APIs. Every choice here is
// backed by a real, verified finding — see NOTES.md in the repo root.

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const DATA = "https://data-api.polymarket.com";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Backfill fires hundreds of requests back-to-back with no pacing, which
// trips Polymarket's rate limiting even though steady-state usage is nowhere
// near their documented limits. Retry with backoff on 429/408/5xx instead of
// failing the whole run over a transient throttle or timeout. 408 was found
// live during a long rankWallets.js run (thousands of requests across ~900
// matches) — a single unretried 408 killed the entire run after it had
// already done ~20 minutes of real work. 408 means the server gave up
// waiting on THIS request, which says nothing about whether an identical
// retry will fare any better, but it's the same class of "worth one more
// try" transient failure 429/5xx already are, and NOT retrying it is
// strictly worse for a long-running batch job like this one.
async function getJson(url, attempt = 1) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    // fetch() itself rejecting (DNS failure, connection reset, TLS drop,
    // etc.) is a different failure mode from an HTTP error status below —
    // there's no res.status to check, because no response ever arrived.
    // Found live: an ECONNRESET killed a long rankWallets.js run outright,
    // since the retry logic only ever looked at res.status and never ran
    // for a fetch() that rejected before producing a response at all. Same
    // "worth one more try" reasoning as the status-code cases, just for a
    // network-level failure instead of an application-level one.
    if (attempt <= 5) {
      const delayMs = 500 * 2 ** (attempt - 1); // 500ms, 1s, 2s, 4s, 8s
      await sleep(delayMs);
      return getJson(url, attempt + 1);
    }
    throw err;
  }
  if (res.ok) return res.json();

  if ((res.status === 429 || res.status === 408 || res.status >= 500) && attempt <= 5) {
    const delayMs = 500 * 2 ** (attempt - 1); // 500ms, 1s, 2s, 4s, 8s
    await sleep(delayMs);
    return getJson(url, attempt + 1);
  }
  throw new Error(`${res.status} ${res.statusText} for ${url}`);
}

// A competition's matches are split across several near-duplicate tags
// depending on when/how each event was tagged (verified in Milestone 1).
// Querying just one misses real matches.
export const COMPETITION_TAGS = {
  EPL: [306, 82, 103043],
  UCL: [1234, 102469, 100977],
  UEL: [100626, 102506, 101787],
  UECL: [103866, 102763, 103989],
};

// Season-spanning series ids, used for backfill (and are a cleaner discovery
// key than tag_id union in general — verified against the 2025-26 season).
// The 2024-25 season isn't reachable this way: EPL never got its own series
// id for that season at all, and UCL/UEL's old series only covers a partial
// knockout-rounds tail. See findResolvedMatches below for how 2024-25 is
// actually discovered instead (tag-based, date-bounded).
export const COMPETITION_SERIES = {
  EPL: [10188], // "Premier League 2025" — 2025-26 season, currently still the active series
  UCL: [10204], // "UEFA Champions League 2025" — 2025-26 season + 2026-27 qualifiers so far
  UEL: [10209], // "UEFA Europa League 2025"
};

// 2024-25 season window, used only for the tag-based discovery fallback
// below. Verified live: tag-based + this date filter surfaces 375 EPL,
// 185 UCL, and 179 UEL 2024-25 matches -- full or near-full season
// coverage, unlike the fragmentary old series ids.
const LAST_SEASON_START = "2024-07-01";
const LAST_SEASON_END = "2025-06-15";

// Current-season events title as plain "Home vs. Away". 2024-25 events
// (discovered via findResolvedMatches's tag-based fallback) are prefixed
// with a competition label instead -- "EPL: Home vs. Away", "UCL: Home vs.
// Away", "Europa League: Home vs. Away" (sometimes with stray leading
// whitespace). Stripping this is a no-op on current-season titles, so
// classifyMarkets can call this unconditionally regardless of season.
export function stripCompetitionPrefix(title) {
  return title.replace(/^\s*(EPL|UCL|UEL|UECL|Europa League|Europa Conference League|Champions League)\s*:\s*/i, "");
}

// A real single-match event has a title like "Home vs. Away" (moneyline) and
// 2-3 binary Yes/No markets. Sub-markets ("- Total Corners", "- Halftime
// Result", etc.) share the same "X vs. Y" prefix but have a " - " suffix —
// exclude those to isolate the moneyline event.
export function looksLikeSingleMatch(event) {
  if (!event.title || !event.title.includes(" vs. ")) return false;
  if (event.title.includes(" - ")) return false;
  const markets = event.markets || [];
  return markets.length >= 2 && markets.length <= 3;
}

async function paginateEvents(paramName, id, { closed }) {
  const byId = new Map();
  let offset = 0;
  // Gamma silently caps `limit` at 100 regardless of what's requested.
  while (true) {
    const url = `${GAMMA}/events?${paramName}=${id}&closed=${closed}&limit=100&offset=${offset}`;
    const page = await getJson(url);
    if (page.length === 0) break;
    for (const e of page) byId.set(e.id, e);
    offset += 100;
  }
  return [...byId.values()];
}

// Live/upcoming matches for a competition, unioned across its known tag ids.
export async function findLiveMatches(competition) {
  const tagIds = COMPETITION_TAGS[competition];
  if (!tagIds) throw new Error(`Unknown competition: ${competition}`);
  const byId = new Map();
  for (const tagId of tagIds) {
    const events = await paginateEvents("tag_id", tagId, { closed: false });
    for (const e of events) byId.set(e.id, e);
  }
  return [...byId.values()].filter(looksLikeSingleMatch);
}

// Resolved matches for a competition's backfill season(s): the current
// season via its series id, unioned with last season (2024-25) via a
// date-bounded tag search -- 2024-25 has no usable series id for any of
// these three competitions (see COMPETITION_SERIES's comment). Older
// 2024-25 events use a different title format ("EPL: Team vs. Team",
// "UCL: Team vs. Team", "Europa League: Team vs. Team" — see
// stripCompetitionPrefix in collect.js/backfill.js) and different market
// question phrasing ("Will X beat Y?" instead of "Will X win on <date>?"),
// but classifyMarkets's startsWith() check already generalizes across
// both once the title prefix is stripped correctly.
export async function findResolvedMatches(competition) {
  const seriesIds = COMPETITION_SERIES[competition] || [];
  const tagIds = COMPETITION_TAGS[competition];
  if (!tagIds) throw new Error(`Unknown competition: ${competition}`);

  const byId = new Map();
  for (const seriesId of seriesIds) {
    const events = await paginateEvents("series_id", seriesId, { closed: true });
    for (const e of events) byId.set(e.id, e);
  }
  for (const tagId of tagIds) {
    const events = await paginateEvents("tag_id", tagId, { closed: true });
    for (const e of events) {
      if (e.startDate >= LAST_SEASON_START && e.startDate < LAST_SEASON_END) byId.set(e.id, e);
    }
  }
  return [...byId.values()].filter(looksLikeSingleMatch);
}

export function clobTokenIdsFor(market) {
  try {
    return JSON.parse(market.clobTokenIds || "[]");
  } catch {
    return [];
  }
}

// `interval=max` is unreliable for markets more than a few weeks old — it can
// silently return near-empty history for coarse fidelities (verified against
// a year-old match). Always pass an explicit timestamp range instead.
export async function getPriceHistory(tokenId, { startTs, endTs, fidelity = 10 }) {
  const url = `${CLOB}/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=${fidelity}`;
  const data = await getJson(url);
  return data.history || [];
}

// A trade's stable identity — same shape as the old per-trade Firestore doc
// ID, before that schema was dropped for the batched-array one (see
// NOTES.md). Shared by dedupeTrades here and collect.js's live-polling
// cursor, which needs the same identity to avoid dropping a trade that ties
// the previous run's max timestamp exactly.
export function tradeKey(t) {
  return `${t.transactionHash}_${t.asset}_${t.outcomeIndex}`;
}

// Offset-based pagination on a market that's still actively trading is
// inherently racy — a new trade landing between page fetches shifts every
// earlier row down by one position, so a later page can re-return a row a
// previous page already returned. Found by an independent code review; not
// confirmed which way the Data API actually sorts under concurrent inserts,
// but deduping here is correct regardless of the answer and costs nothing
// when there's no overlap. Exported standalone so it's testable without
// mocking network calls.
export function dedupeTrades(trades) {
  const seen = new Set();
  const out = [];
  for (const t of trades) {
    const key = tradeKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function fetchTradesPage(conditionId, offset, pageSize) {
  return getJson(`${DATA}/trades?market=${conditionId}&limit=${pageSize}&offset=${offset}`);
}

// Fetches every trade for a market (conditionId), paginating past the
// per-request limit. `market=` takes the conditionId, not a CLOB token id.
// `fetchPage` is injectable so the deep-offset-ceiling handling below is
// testable without a live network call.
export async function getAllTrades(conditionId, { pageSize = 500, fetchPage = fetchTradesPage } = {}) {
  const all = [];
  let offset = 0;
  while (true) {
    let page;
    try {
      page = await fetchPage(conditionId, offset, pageSize);
    } catch (err) {
      // Polymarket's Data API returns 400 (not an empty page) once offset
      // pagination goes deep enough — observed consistently at offset=10500
      // on two of the highest-volume markets backfilled so far (a two-legged
      // tie's both fixtures, so not a one-off fluke). Treating this like any
      // other error meant retrying it 4x with cooldowns that can never
      // succeed, then discarding the match's ENTIRE trade history — exactly
      // the highest-signal markets losing all their data. Once we already
      // have real pages (offset > 0), take the ceiling as "no more data
      // available" and keep what was fetched, same as an empty page would
      // mean. A 400 on the very FIRST page (offset=0) is a different,
      // real error (bad conditionId, etc.) and still throws.
      if (offset > 0 && err.message.startsWith("400 ")) {
        console.log(`    trade pagination ceiling hit at offset=${offset} for market ${conditionId} — keeping ${all.length} trade(s) fetched so far`);
        break;
      }
      throw err;
    }
    if (page.length === 0) break;
    all.push(...page);
    offset += page.length;
    if (page.length < pageSize) break;
  }
  return dedupeTrades(all);
}
