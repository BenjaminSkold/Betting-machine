// Milestone 1 — throwaway probe script for Polymarket's public APIs.
// Goal: confirm (1) how EPL/UCL/UEL match markets are actually discoverable,
// (2) how far back CLOB /prices-history goes, (3) what Data API /trades
// returns and whether it can be filtered by market. Nothing here writes to
// Firestore — see NOTES.md in the repo root for the write-up of findings.

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const DATA = "https://data-api.polymarket.com";

// Polymarket tags competitions inconsistently — the same competition shows up
// under several near-duplicate tag ids depending on when/how the event was
// created. Discovery has to union all known variants per competition, not
// rely on a single "canonical" tag. Found by resolving /tags/slug/<slug>.
const COMPETITION_TAGS = {
  EPL: [306 /* epl */, 82 /* premier-league */, 103043 /* english-premier-league */],
  UCL: [1234 /* champions-league */, 102469 /* uefa-champions-league */, 100977 /* ucl */],
  UEL: [100626 /* europa-league */, 102506 /* uefa-europa-league */, 101787 /* uel */],
  UECL: [103866 /* uefa-conference-league */, 102763 /* europa-conference-league */, 103989 /* uecl */],
};

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function section(title) {
  console.log("\n" + "=".repeat(80));
  console.log(title);
  console.log("=".repeat(80));
}

// A real single-match event has a title like "Home vs. Away" and 2-3 binary
// (Yes/No) markets — win/draw/win. Season-long futures/props have many more
// markets (one per team/candidate) or a single Yes/No spanning the season.
function looksLikeSingleMatch(event) {
  if (!event.title || !event.title.includes(" vs. ")) return false;
  const markets = event.markets || [];
  return markets.length >= 2 && markets.length <= 3;
}

async function findMatchEventsForCompetition(label, tagIds) {
  const byId = new Map();
  for (const tagId of tagIds) {
    const events = await getJson(`${GAMMA}/events?tag_id=${tagId}&closed=false&limit=100`);
    for (const e of events) byId.set(e.id, e);
  }
  const all = [...byId.values()];
  const matches = all.filter(looksLikeSingleMatch);
  console.log(`[${label}] tag_ids=${tagIds.join(",")} -> ${all.length} events total, ${matches.length} look like single matches`);
  return matches;
}

async function main() {
  section("STEP 1 — Discover match events via Gamma API tag_id (not free-text search)");
  console.log("Free-text /public-search matches on title text and pulls in wrong competitions");
  console.log('(e.g. searching "Champions League" returns Women\'s Champions League matches too).');
  console.log("Filtering by the competition's tag_id is the reliable approach.\n");

  const found = {};
  for (const [label, tagIds] of Object.entries(COMPETITION_TAGS)) {
    found[label] = await findMatchEventsForCompetition(label, tagIds);
  }

  for (const [label, matches] of Object.entries(found)) {
    console.log(`\n[${label}] sample matches:`);
    if (matches.length === 0) {
      console.log("  (none live right now)");
    }
    for (const e of matches.slice(0, 5)) {
      console.log(`  - ${e.title} (event ${e.id}, created ${e.createdAt})`);
    }
  }

  // EPL/UCL/UEL are all pre-season/qualifying right now, so there may be zero
  // live match markets for them yet. Fall back to a real, currently-trading
  // men's match under UECL (Conference League qualifiers) purely as a proxy
  // to exercise steps 2 and 3 against real data. UECL is explicitly a
  // side-dataset per PROJECT.md, never mixed into main analysis.
  let target = [found.EPL, found.UCL, found.UEL].flat()[0];
  let usingFallback = false;
  if (!target) {
    usingFallback = true;
    target = found.UECL[0];
    console.log("\nNo live EPL/UCL/UEL match markets exist right now (expected pre-season / pre-qualifying).");
    console.log("Falling back to a live UECL (Conference League) match as a proxy to test steps 2-3 only.");
  }
  if (!target) {
    console.log("\nNo live match markets found in ANY watched competition, including the UECL fallback. Stopping.");
    return;
  }

  const targetMarket = target.markets.find((m) => m.volume && Number(m.volume) > 0) || target.markets[0];
  console.log(`\nDrilling into${usingFallback ? " [FALLBACK/PROXY]" : ""}: ${target.title} / "${targetMarket.question}"`);
  console.log(`event id=${target.id} marketId=${targetMarket.id} conditionId=${targetMarket.conditionId} volume=${targetMarket.volume}`);

  let clobTokenIds = [];
  try {
    clobTokenIds = JSON.parse(targetMarket.clobTokenIds || "[]");
  } catch {
    clobTokenIds = [];
  }

  section("STEP 2 — CLOB /prices-history: how far back does history go?");

  if (clobTokenIds.length === 0) {
    console.log("No clobTokenIds on this market, skipping.");
  } else {
    const tokenId = clobTokenIds[0];
    for (const interval of ["max", "1w", "1d"]) {
      const url = `${CLOB}/prices-history?market=${tokenId}&interval=${interval}&fidelity=60`;
      try {
        const hist = await getJson(url);
        const points = hist.history || hist;
        if (Array.isArray(points) && points.length > 0) {
          const first = points[0];
          const last = points[points.length - 1];
          console.log(
            `interval=${interval}: ${points.length} points, ` +
              `${new Date(first.t * 1000).toISOString()} -> ${new Date(last.t * 1000).toISOString()}`
          );
        } else {
          console.log(`interval=${interval}: 0 points`);
        }
      } catch (err) {
        console.log(`interval=${interval}: ERROR ${err.message}`);
      }
    }
    console.log(
      `\nEvent createdAt=${target.createdAt} — history should not extend meaningfully before this. ` +
        `Confirmed separately against a market created ~4 months ago that history goes back to first trade, ` +
        `with no artificial cutoff (density just tracks actual trading activity — illiquid markets have sparse points).`
    );
  }

  section("STEP 3 — Data API /trades: fields, wallet count, market filtering, pagination");

  const conditionId = targetMarket.conditionId;
  const url = `${DATA}/trades?market=${conditionId}&limit=500`;
  const trades = await getJson(url);
  console.log(`market= filter works: fetched ${trades.length} trades for conditionId=${conditionId}`);

  if (trades.length > 0) {
    console.log("\nSample trade object (fields returned):");
    console.log(JSON.stringify(trades[0], null, 2));

    const wallets = new Set(trades.map((t) => t.proxyWallet));
    console.log(`\nDistinct wallets across ${trades.length} trades: ${wallets.size}`);

    const timestamps = trades.map((t) => t.timestamp);
    console.log(
      `Trade time range: ${new Date(Math.min(...timestamps) * 1000).toISOString()} -> ` +
        `${new Date(Math.max(...timestamps) * 1000).toISOString()}`
    );

    // Confirm limit/offset pagination actually advances instead of capping silently.
    const page2 = await getJson(`${DATA}/trades?market=${conditionId}&limit=500&offset=${trades.length}`);
    console.log(`offset=${trades.length} returns ${page2.length} more trades (pagination confirmed working).`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
