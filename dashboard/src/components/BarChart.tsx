"use client";

import { useState } from "react";
import { formatValue, type FormatMode } from "@/lib/format";

export interface BarDatum {
  label: string;
  value: number;
  n: number; // sample size backing this bar -- thin bars get a visibly different treatment
}

const WIDTH = 640;
const HEIGHT = 240;
const MARGIN = { top: 20, right: 16, bottom: 32, left: 48 };
const BAR_MAX_THICKNESS = 24; // dataviz skill: bars never fill their slot
const MIN_TRUST_N = 8; // matches rankWallets.js's own activity bar -- a bucket this thin is noise, not signal

// `formatMode` is a named mode (lib/format.ts), not a function -- this
// component is constructed from Server Component pages, and a function
// prop can't cross that boundary.
export default function BarChart({
  data,
  formatMode = "signedPercent1",
  baseline = 0,
  unit = "",
}: {
  data: BarDatum[];
  formatMode?: FormatMode;
  baseline?: number;
  unit?: string;
}) {
  const valueFormat = (v: number) => formatValue(formatMode, v);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <div className="flex h-[240px] items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-1)] text-sm text-[var(--text-muted)]">
        Not enough data yet
      </div>
    );
  }

  const innerW = WIDTH - MARGIN.left - MARGIN.right;
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const values = data.map((d) => d.value);
  const maxAbs = Math.max(Math.abs(Math.min(...values, baseline)), Math.abs(Math.max(...values, baseline)), 1e-9);
  const yScale = (v: number) => innerH / 2 - (v / maxAbs) * (innerH / 2 - 8);
  const zeroY = MARGIN.top + yScale(baseline);

  const slotWidth = innerW / data.length;
  const barWidth = Math.min(BAR_MAX_THICKNESS, slotWidth * 0.55);

  const hovered = hoverIdx !== null ? data[hoverIdx] : null;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label="Bar chart — see the table below for exact values">
        {/* baseline / zero line */}
        <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={zeroY} y2={zeroY} stroke="var(--gridline)" strokeWidth={1} />
        <text x={MARGIN.left - 8} y={zeroY} textAnchor="end" dominantBaseline="middle" className="fill-[var(--text-muted)] text-[10px]">
          {valueFormat(baseline)}
          {unit}
        </text>

        {data.map((d, i) => {
          const cx = MARGIN.left + slotWidth * i + slotWidth / 2;
          const barY = MARGIN.top + Math.min(yScale(d.value), yScale(baseline));
          const barH = Math.max(1, Math.abs(yScale(d.value) - yScale(baseline)));
          const thin = d.n < MIN_TRUST_N;
          const color = d.value >= baseline ? "var(--diverging-pos)" : "var(--diverging-neg)";
          const isHovered = hoverIdx === i;
          const labelY = d.value >= baseline ? barY - 6 : barY + barH + 12;
          const labelFits = slotWidth > 46; // rough measure — narrow slots fall back to tooltip/table only

          return (
            <g key={d.label}>
              {/* hit target: bigger than the bar, per interaction.md */}
              <rect
                x={cx - slotWidth / 2}
                y={MARGIN.top}
                width={slotWidth}
                height={innerH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
                onFocus={() => setHoverIdx(i)}
                onBlur={() => setHoverIdx(null)}
                tabIndex={0}
                role="button"
                aria-label={`${d.label}: ${valueFormat(d.value)}${unit}, n=${d.n}`}
              />
              <rect
                x={cx - barWidth / 2}
                y={barY}
                width={barWidth}
                height={barH}
                rx={4}
                fill={color}
                opacity={thin ? 0.35 : isHovered ? 1 : 0.85}
                style={{ transition: "opacity 150ms" }}
                pointerEvents="none"
              />
              {thin && (
                <rect x={cx - barWidth / 2} y={barY} width={barWidth} height={barH} rx={4} fill="none" stroke={color} strokeDasharray="2 2" strokeWidth={1} pointerEvents="none" />
              )}
              {labelFits && (
                <text x={cx} y={labelY} textAnchor="middle" className="fill-[var(--text-primary)] text-[10px] font-medium tabular" pointerEvents="none">
                  {valueFormat(d.value)}
                  {unit}
                </text>
              )}
              <text x={cx} y={HEIGHT - MARGIN.bottom + 16} textAnchor="middle" className="fill-[var(--text-muted)] text-[10px]" pointerEvents="none">
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>

      {hovered && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-[var(--page-plane)] px-3 py-2 text-xs">
          <span className="inline-block h-2 w-4 rounded-sm" style={{ background: hovered.value >= baseline ? "var(--diverging-pos)" : "var(--diverging-neg)" }} />
          <span className="font-medium text-[var(--text-primary)]">{hovered.label}</span>
          <span className="tabular font-semibold text-[var(--text-primary)]">
            {valueFormat(hovered.value)}
            {unit}
          </span>
          <span className="text-[var(--text-muted)]">n={hovered.n}{hovered.n < MIN_TRUST_N ? " — too thin to trust" : ""}</span>
        </div>
      )}

      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-[var(--text-secondary)]">View as table</summary>
        <div className="mt-2 overflow-x-auto rounded-md border border-[var(--border)]">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] text-left uppercase tracking-wide text-[var(--text-muted)]">
                <th scope="col" className="px-3 py-2">Segment</th>
                <th scope="col" className="tabular px-3 py-2 text-right">Value</th>
                <th scope="col" className="tabular px-3 py-2 text-right">N</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.label} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-3 py-1.5 text-[var(--text-primary)]">{d.label}</td>
                  <td className="tabular px-3 py-1.5 text-right text-[var(--text-primary)]">
                    {valueFormat(d.value)}
                    {unit}
                  </td>
                  <td className="tabular px-3 py-1.5 text-right text-[var(--text-secondary)]">{d.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
