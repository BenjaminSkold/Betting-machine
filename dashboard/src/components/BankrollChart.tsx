"use client";

import { useState } from "react";

export interface BankrollPoint {
  t: number; // unix seconds (settledAt)
  cumulativePnl: number;
}

const WIDTH = 720;
const HEIGHT = 220;
const MARGIN = { top: 16, right: 16, bottom: 24, left: 56 };

// Single-series line -- per the dataviz skill, a single series needs no
// legend box (the title already names it). Area wash at ~10% opacity
// under the line, colored by whether the running total is currently
// above or below zero.
export default function BankrollChart({ points }: { points: BankrollPoint[] }) {
  const [hoverX, setHoverX] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-1)] text-sm text-[var(--text-muted)]">
        No settled bets yet
      </div>
    );
  }

  const sorted = [...points].sort((a, b) => a.t - b.t);
  const minT = sorted[0].t;
  const maxT = sorted[sorted.length - 1].t;
  const values = sorted.map((p) => p.cumulativePnl);
  const maxAbs = Math.max(Math.abs(Math.min(...values, 0)), Math.abs(Math.max(...values, 0)), 1);

  const innerW = WIDTH - MARGIN.left - MARGIN.right;
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const x = (t: number) => MARGIN.left + (maxT === minT ? innerW / 2 : ((t - minT) / (maxT - minT)) * innerW);
  const y = (v: number) => MARGIN.top + innerH / 2 - (v / maxAbs) * (innerH / 2 - 8);
  const zeroY = y(0);

  const last = sorted[sorted.length - 1];
  const color = last.cumulativePnl >= 0 ? "var(--diverging-pos)" : "var(--diverging-neg)";

  const linePath = sorted.map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.t)} ${y(p.cumulativePnl)}`).join(" ");
  const areaPath = `${linePath} L ${x(last.t)} ${zeroY} L ${x(sorted[0].t)} ${zeroY} Z`;

  const nearestAt = (px: number | null) => {
    if (px === null) return null;
    const t = minT + ((px - MARGIN.left) / innerW) * (maxT - minT);
    let best = sorted[0];
    for (const p of sorted) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best;
  };
  const hovered = nearestAt(hoverX);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        aria-label="Bankroll over time — see the table below for exact values"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHoverX(((e.clientX - rect.left) / rect.width) * WIDTH);
        }}
        onMouseLeave={() => setHoverX(null)}
      >
        <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={zeroY} y2={zeroY} stroke="var(--gridline)" strokeWidth={1} />
        <text x={MARGIN.left - 8} y={zeroY} textAnchor="end" dominantBaseline="middle" className="fill-[var(--text-muted)] text-[10px]">$0</text>
        <text x={MARGIN.left - 8} y={y(maxAbs)} textAnchor="end" dominantBaseline="middle" className="fill-[var(--text-muted)] text-[10px]">${maxAbs.toFixed(0)}</text>
        <text x={MARGIN.left - 8} y={y(-maxAbs)} textAnchor="end" dominantBaseline="middle" className="fill-[var(--text-muted)] text-[10px]">-${maxAbs.toFixed(0)}</text>

        <path d={areaPath} fill={color} opacity={0.1} />
        <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(last.t)} cy={y(last.cumulativePnl)} r={4} fill={color} stroke="var(--surface-1)" strokeWidth={2} />

        {hoverX !== null && hovered && (
          <>
            <line x1={x(hovered.t)} x2={x(hovered.t)} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} stroke="var(--baseline)" strokeWidth={1} />
            <circle cx={x(hovered.t)} cy={y(hovered.cumulativePnl)} r={4} fill={color} stroke="var(--surface-1)" strokeWidth={2} />
          </>
        )}
      </svg>

      {hovered && (
        <div className="mt-2 flex items-center gap-3 rounded-md bg-[var(--page-plane)] px-3 py-2 text-xs">
          <span className="text-[var(--text-secondary)]">{new Date(hovered.t * 1000).toLocaleDateString()}</span>
          <span className="tabular font-semibold" style={{ color: hovered.cumulativePnl >= 0 ? "var(--status-good-text)" : "var(--status-critical)" }}>
            {hovered.cumulativePnl >= 0 ? "+" : ""}${hovered.cumulativePnl.toFixed(2)}
          </span>
        </div>
      )}
    </div>
  );
}
