// One-time (re-runnable) migration: rewrites matches.home_team/away_team to
// their canonical form (see teamNames.js for why ~284 raw strings collapse
// to far fewer real clubs). Safe to re-run -- rows already canonical are
// simply no-ops (WHERE clause won't match anything left to rename).
// Wallets' own by_slice.byTeam is keyed off these same team names, so
// rankWallets.js needs a full re-run after this to pick up the merge.
import { getClient } from "./db.js";
import { TEAM_ALIASES } from "./teamNames.js";
import { isMainModule } from "./isMain.js";

async function main() {
  const client = getClient();
  let homeUpdated = 0;
  let awayUpdated = 0;

  for (const [raw, canonical] of Object.entries(TEAM_ALIASES)) {
    const home = await client.execute({ sql: `UPDATE matches SET home_team = ? WHERE home_team = ?`, args: [canonical, raw] });
    const away = await client.execute({ sql: `UPDATE matches SET away_team = ? WHERE away_team = ?`, args: [canonical, raw] });
    if (home.rowsAffected > 0 || away.rowsAffected > 0) {
      console.log(`  "${raw}" -> "${canonical}": ${home.rowsAffected} home, ${away.rowsAffected} away`);
    }
    homeUpdated += home.rowsAffected;
    awayUpdated += away.rowsAffected;
  }

  console.log(`\nDone. ${homeUpdated} home_team row(s) and ${awayUpdated} away_team row(s) updated.`);
  console.log("Run rankWallets.js next so wallets' by_slice.byTeam picks up the merge.");
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("Team name migration FAILED:", err);
    process.exit(1);
  });
}
