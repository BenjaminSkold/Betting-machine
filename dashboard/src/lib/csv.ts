// Minimal RFC 4180-ish CSV encoder — quotes a field only when it contains a
// comma, quote, or newline, doubling any embedded quotes. No library needed
// for this small a job, and it keeps the export routes dependency-free.
function csvField(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvField).join(",")];
  for (const row of rows) lines.push(row.map(csvField).join(","));
  return lines.join("\r\n");
}
