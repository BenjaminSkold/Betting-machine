// Throwaway synthetic check for polymarket.js's pure helpers.
import { dedupeTrades } from "./polymarket.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "OK  " : "FAIL"} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (!ok) failures++;
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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
