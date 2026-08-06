// Throwaway synthetic check for validate.ts. Run with `node src/lib/validate.test.ts`
// (Node 24's built-in TypeScript support — no build step needed).
import { isValidMatchId, isValidWalletAddress } from "./validate.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

check("real matchId is valid", isValidMatchId("773388"), true);
check("empty string is invalid", isValidMatchId(""), false);
check("non-numeric is invalid", isValidMatchId("abc123"), false);
check("path traversal attempt is invalid", isValidMatchId("123/../../wallets"), false);
check("negative number (not a real Polymarket event id) is invalid", isValidMatchId("-1"), false);

const realAddress = "0x7f2cd519bd89ae371113d38a93e300a5352f8966";
check("real wallet address is valid", isValidWalletAddress(realAddress), true);
check("too short is invalid", isValidWalletAddress("0x1234"), false);
check("missing 0x prefix is invalid", isValidWalletAddress(realAddress.slice(2)), false);
check("path traversal attempt is invalid", isValidWalletAddress("0x..%2F..%2Fmatches"), false);
// EIP-55 checksummed addresses vary the case of the hex digits but always
// keep the "0x" prefix lowercase (unlike a blanket .toUpperCase(), which
// would also turn the prefix into "0X" — not a real address format).
check("mixed-case hex digits (EIP-55 checksum casing) is valid", isValidWalletAddress("0x7F2Cd519bD89aE371113d38A93e300A5352f8966"), true);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
