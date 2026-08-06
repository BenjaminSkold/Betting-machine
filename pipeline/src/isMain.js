// `import.meta.main` isn't reliable across every environment this project
// runs in: it correctly reports true when a script is run directly on
// Windows (verified locally), but on the GitHub Actions Ubuntu runner the
// same check silently evaluated false — `main()` never ran, yet the step
// still exited 0, so the cron job reported a green "success" while doing
// nothing at all. Confirmed via the raw (unprocessed) Actions log archive:
// zero stdout from `node src/collect.js`, ~90ms wall time (too fast for even
// one real network call), and no error on either stream. See NOTES.md.
//
// This is the older, more portable "is this the entry point" idiom —
// comparing the module's own URL against the URL Node would give the script
// path it was actually invoked with — and doesn't depend on that newer API.
import { pathToFileURL } from "node:url";

export function isMainModule(moduleUrl) {
  return process.argv[1] !== undefined && moduleUrl === pathToFileURL(process.argv[1]).href;
}
