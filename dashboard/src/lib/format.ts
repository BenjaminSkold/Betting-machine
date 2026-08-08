// Named format modes instead of formatter functions. AnimatedNumber,
// StatTile, and BarChart are Client Components, but they're constructed
// from Server Component pages -- a function prop crossing that boundary
// fails at runtime in production ("Functions cannot be passed directly to
// Client Components"), even though dev mode's error handling partially
// masked it. A serializable string enum is the actual fix, not a
// workaround.
export type FormatMode = "integer" | "decimal1" | "percent1" | "signedPercent1" | "pp1" | "signedPp1" | "money2" | "signedMoney0" | "signedMoney2";

export function formatValue(mode: FormatMode, n: number): string {
  switch (mode) {
    case "integer":
      return n.toFixed(0);
    case "decimal1":
      return n.toFixed(1);
    case "percent1":
      return `${n.toFixed(1)}%`;
    case "signedPercent1":
      return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
    case "pp1":
      return `${n.toFixed(1)}pp`;
    case "signedPp1":
      return `${n >= 0 ? "+" : ""}${n.toFixed(1)}pp`;
    case "money2":
      return `${n >= 0 ? "" : "-"}$${Math.abs(n).toFixed(2)}`;
    case "signedMoney0":
      return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(0)}`;
    case "signedMoney2":
      return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
  }
}
