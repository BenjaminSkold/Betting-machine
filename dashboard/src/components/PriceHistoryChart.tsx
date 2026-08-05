"use client";

import { useState } from "react";

export type PricePoint = { t: number; p: number }; // t = unix seconds, p = 0..1

type Series = { key: "home" | "draw" | "away"; label: string; color: string; points: PricePoint[] };

const WIDTH = 720;
const HEIGHT = 260;
const MARGIN = { top: 16, right: 64, bottom: 24, left: 36 };

export default function PriceHistoryChart({
  home,
  draw,
  away,
  homeLabel,
  awayLabel,
}: {
  home: PricePoint[];
  draw: PricePoint[];
  away: PricePoint[];
  homeLabel: string;
  awayLabel: string;
}) {
  const series: Series[] = [
    { key: "home", label: homeLabel, color: "var(--series-1)", points: home },
    { key: "away", label: awayLabel, color: "var(--series-2)", points: away },
    { key: "draw", label: "Draw", color: "var(--series-3)", points: draw },
  ];

  const allPoints = series.flatMap((s) => s.points);
  const [hoverX, setHoverX] = useState<number | null>(null);

  // Cheap at our data scale (at most a few thousand points) — not worth
  // memoizing, and doing so requires a stable `allPoints` reference, which
  // it isn't (freshly flatMap'd every render).
  let minT = 0;
  let maxT = 1;
  let x = (t: number) => t;
  let y = (p: number) => p;
  if (allPoints.length > 0) {
    minT = Math.min(...allPoints.map((p) => p.t));
    maxT = Math.max(...allPoints.map((p) => p.t));
    const innerW = WIDTH - MARGIN.left - MARGIN.right;
    const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
    x = (t: number) => MARGIN.left + (maxT === minT ? innerW / 2 : ((t - minT) / (maxT - minT)) * innerW);
    y = (p: number) => MARGIN.top + innerH * (1 - p);
  }

  if (allPoints.length === 0) {
    return (
      <div className="flex h-[260px] items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-1)] text-sm text-[var(--text-muted)]">
        No price history yet
      </div>
    );
  }

  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  // Direct end-labels collide when two series converge near the same value —
  // nudging them apart vertically detaches them from their lines and reads
  // as noise (see dataviz skill, marks-and-anatomy.md). The sanctioned
  // fallback: suppress the direct label for any series involved in a
  // collision and rely on the legend + hover tooltip instead, both already
  // present. Threshold in px, roughly one line-height.
  const COLLISION_PX = 14;
  const ends = series.map((s) => {
    if (s.points.length === 0) return null;
    const last = [...s.points].sort((a, b) => a.t - b.t).slice(-1)[0];
    return { key: s.key, ey: y(last.p) };
  });
  const suppressLabel = new Set<string>();
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const a = ends[i];
      const b = ends[j];
      if (a && b && Math.abs(a.ey - b.ey) < COLLISION_PX) {
        suppressLabel.add(a.key);
        suppressLabel.add(b.key);
      }
    }
  }

  // Nearest sample per series to the hovered x, for the tooltip.
  const nearestAt = (px: number | null) => {
    if (px === null) return null;
    const t = minT + ((px - MARGIN.left) / (WIDTH - MARGIN.left - MARGIN.right)) * (maxT - minT);
    return series.map((s) => {
      if (s.points.length === 0) return { ...s, point: null as PricePoint | null };
      let best = s.points[0];
      for (const pt of s.points) if (Math.abs(pt.t - t) < Math.abs(best.t - t)) best = pt;
      return { ...s, point: best };
    });
  };
  const hoverData = nearestAt(hoverX);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * WIDTH;
          setHoverX(px);
        }}
        onMouseLeave={() => setHoverX(null)}
      >
        {/* gridlines — hairline, recessive, solid */}
        {gridLines.map((g) => (
          <line
            key={g}
            x1={MARGIN.left}
            x2={WIDTH - MARGIN.right}
            y1={y(g)}
            y2={y(g)}
            stroke="var(--gridline)"
            strokeWidth={1}
          />
        ))}
        {gridLines.map((g) => (
          <text key={g} x={MARGIN.left - 8} y={y(g)} textAnchor="end" dominantBaseline="middle" className="fill-[var(--text-muted)] text-[10px]">
            {Math.round(g * 100)}%
          </text>
        ))}

        {/* lines */}
        {series.map((s) => {
          if (s.points.length === 0) return null;
          const sorted = [...s.points].sort((a, b) => a.t - b.t);
          const d = sorted.map((pt, i) => `${i === 0 ? "M" : "L"} ${x(pt.t)} ${y(pt.p)}`).join(" ");
          const last = sorted[sorted.length - 1];
          return (
            <g key={s.key}>
              <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {/* end marker with surface ring */}
              <circle cx={x(last.t)} cy={y(last.p)} r={4} fill={s.color} stroke="var(--surface-1)" strokeWidth={2} />
              {/* direct end-label — text token, never the series color. Suppressed on collision (see legend + tooltip instead). */}
              {!suppressLabel.has(s.key) && (
                <text x={x(last.t) + 8} y={y(last.p)} dominantBaseline="middle" className="fill-[var(--text-primary)] text-[11px] font-medium">
                  {s.label}
                </text>
              )}
            </g>
          );
        })}

        {/* hover crosshair */}
        {hoverX !== null && (
          <line x1={hoverX} x2={hoverX} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} stroke="var(--baseline)" strokeWidth={1} />
        )}
      </svg>

      {/* legend — always present for >=2 series */}
      <div className="mt-2 flex gap-4 text-xs text-[var(--text-secondary)]">
        {series.map((s) => (
          <div key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.label}
          </div>
        ))}
      </div>

      {/* tooltip (table-equivalent values, always visible on hover) */}
      {hoverData && (
        <div className="mt-2 flex gap-4 rounded-md bg-[var(--page-plane)] px-3 py-2 text-xs">
          {hoverData.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5 text-[var(--text-secondary)]">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.label}: <span className="tabular font-medium text-[var(--text-primary)]">{s.point ? `${(s.point.p * 100).toFixed(1)}%` : "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
