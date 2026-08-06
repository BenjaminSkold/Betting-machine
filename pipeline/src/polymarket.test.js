// Throwaway synthetic check for polymarket.js's pure helpers.
import { dedupeTrades, getAllTrades } from "./polymarket.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK  " : "FAIL"} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

function describe(actual) {
  return Array.isArray(actual) && actual.length > 5 ? `Array(${actual.length})` : JSON.stringify(actual);
}

async function checkAsync(label, promise, expectedOrCheck) {
  try {
    const actual = await promise;
    if (typeof expectedOrCheck === "function") {
      const ok = expectedOrCheck(actual);
      console.log(`${ok ? "OK  " : "FAIL"} ${label}: got ${describe(actual)}`);
      if (!ok) failures++;
    } else {
      const ok = JSON.stringify(actual) === JSON.stringify(expectedOrCheck);
      console.log(`${ok ? "OK  " : "FAIL"} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expectedOrCheck)}`);
      if (!ok) failures++;
    }
  } catch (err) {
    console.log(`FAIL ${label}: threw ${err.message}`);
    failures++;
  }
}

const t = (transactionHash, asset, outcomeIndex, extra = {}) => ({ transactionHash, asset, outcomeIndex, ...extra });

// --- Regression: offset-pagination on a live market can return the same
// trade twice across two pages (found by an independent code review — a
// new trade landing between page fetches shifts every earlier row down,
// so a later page can re-return a row an earlier page already returned).
check(
  "exact duplicate (same tx+asset+outcomeIndex) across two 'pages' is removed",
  dedupeTrades([t("0xabc", "A1", 0), t("0xdef", "A1", 1), t("0xabc", "A1", 0)]).length,
  2
);

check(
  "same transactionHash but different asset (multi-leg tx) are both kept",
  dedupeTrades([t("0xabc", "A1", 0), t("0xabc", "A2", 0)]).length,
  2
);

check("no duplicates -> nothing removed", dedupeTrades([t("0x1", "A", 0), t("0x2", "A", 0), t("0x3", "A", 0)]).length, 3);

check("empty input -> empty output", dedupeTrades([]), []);

// Order and content of the surviving trades is preserved (first occurrence wins).
const withData = dedupeTrades([t("0xabc", "A1", 0, { price: 0.4 }), t("0xabc", "A1", 0, { price: 0.9 })]);
check("first occurrence's data is kept, not overwritten by the duplicate", withData[0].price, 0.4);

// --- Regression: getAllTrades must survive Polymarket's Data API 400ing
// past a deep-offset pagination ceiling instead of returning an empty page
// (observed live at offset=10500 on two of the highest-volume markets
// backfilled so far). Keep whatever was already fetched instead of
// discarding the whole match's trade history.
const page = (n, offset) => Array.from({ length: n }, (_, i) => t(`0x${offset + i}`, "A", 0));

await checkAsync(
  "400 past offset 0 keeps the trades already fetched, doesn't throw",
  getAllTrades("cond1", {
    pageSize: 500,
    fetchPage: async (_id, offset) => {
      if (offset === 0) return page(500, 0);
      if (offset === 500) return page(500, 500);
      throw new Error(`400 Bad Request for https://data-api.polymarket.com/trades?market=cond1&limit=500&offset=${offset}`);
    },
  }),
  (trades) => trades.length === 1000
);

let threw = false;
try {
  await getAllTrades("cond2", {
    pageSize: 500,
    fetchPage: async () => {
      throw new Error("400 Bad Request for https://data-api.polymarket.com/trades?market=cond2&limit=500&offset=0");
    },
  });
} catch {
  threw = true;
}
check("400 on the very first page (offset=0) still throws", threw, true);

await checkAsync(
  "a non-400 error past offset 0 still throws, not swallowed",
  (async () => {
    try {
      await getAllTrades("cond3", {
        pageSize: 500,
        fetchPage: async (_id, offset) => {
          if (offset === 0) return page(500, 0);
          throw new Error("503 Service Unavailable for https://data-api.polymarket.com/trades?market=cond3&limit=500&offset=500");
        },
      });
      return "did not throw";
    } catch (err) {
      return err.message;
    }
  })(),
  (result) => result.startsWith("503")
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
