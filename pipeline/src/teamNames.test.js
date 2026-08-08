import { canonicalTeamName, TEAM_ALIASES } from "./teamNames.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

check("strips FC suffix via alias", canonicalTeamName("Arsenal FC"), "Arsenal");
check("merges short/full/FC forms", canonicalTeamName("Newcastle"), "Newcastle United");
check("merges FC-suffixed full form", canonicalTeamName("Newcastle United FC"), "Newcastle United");
check("already-canonical name passes through unchanged", canonicalTeamName("Newcastle United"), "Newcastle United");
check("merges common abbreviation", canonicalTeamName("Man City"), "Manchester City");
check("merges common abbreviation", canonicalTeamName("Man Utd"), "Manchester United");
check("merges Spurs colloquialism", canonicalTeamName("Spurs"), "Tottenham Hotspur");
check("trims incidental whitespace", canonicalTeamName("  Arsenal FC  "), "Arsenal");
check("unknown name passes through unchanged, not dropped", canonicalTeamName("Some Obscure FC"), "Some Obscure FC");

// Regression: two DIFFERENT real clubs must never collapse into each
// other just because they share a word -- this was the actual risk in
// hand-building this table (e.g. "Inter" the Milan giant vs "Inter Club
// d'Escaldes", a small Andorran club, both contain "Inter").
check("does NOT merge an unrelated club sharing a word", canonicalTeamName("Inter Club d'Escaldes"), "Inter Club d'Escaldes");
check("does NOT merge a different city's club", canonicalTeamName("Universitatea Craiova CS"), "Universitatea Craiova CS");
check("does NOT merge a different city's club", canonicalTeamName("FC Universitatea Cluj"), "FC Universitatea Cluj");

// No alias should point at a name that is ITSELF also a key -- that would
// mean a chain (A -> B -> C) instead of everything settling in one hop,
// silently leaving some names one step short of their real canonical form.
const canonicalTargets = new Set(Object.values(TEAM_ALIASES));
const aliasKeys = new Set(Object.keys(TEAM_ALIASES));
const chained = [...canonicalTargets].filter((t) => aliasKeys.has(t));
check("no alias chains (every mapping settles in one hop)", chained.length, 0);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
