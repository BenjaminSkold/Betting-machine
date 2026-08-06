import { toCsv } from "./csv.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

check("plain values need no quoting", toCsv(["a", "b"], [["1", "2"]]), "a,b\r\n1,2");
check("a comma in a field forces quoting", toCsv(["a"], [["x,y"]]), 'a\r\n"x,y"');
check("an embedded quote is doubled and the field is quoted", toCsv(["a"], [['say "hi"']]), 'a\r\n"say ""hi"""');
check("a newline in a field forces quoting", toCsv(["a"], [["line1\nline2"]]), 'a\r\n"line1\nline2"');
check("null/undefined become empty fields, not the literal string", toCsv(["a", "b"], [[null, undefined]]), "a,b\r\n,");
check("numbers are stringified plainly", toCsv(["a"], [[42]]), "a\r\n42");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
