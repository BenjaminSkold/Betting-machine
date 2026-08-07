"use client";

import { useState } from "react";
import type { CalibrationBucket } from "@/lib/calibration";

const WIDTH = 480;
const HEIGHT = 340;
const MARGIN = { top: 16, right: 16, bottom: 32, left: 44 };
const MIN_TRUST_N = 8;

// PROJECT.md's "does this even work" chart: predicted probability vs. the
// realized win rate at that confidence level. A point sitting exactly on
// the diagonal means "when we said 70%, it happened ~70% of the time" --
// above the line is underconfident, below is overconfident.
export default function CalibrationChart({ buckets }: { buckets: CalibrationBucket[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (buckets.length === 0) {
    return (
      <div className="flex h-[340px] items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-1)] text-sm text-[var(--text-muted)]">
        Not enough resolved, scored matches yet
      </div>
    );
  }

  const innerW = WIDTH - MARGIN.left - MARGIN.right;
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const x = (p: number) => MARGIN.left + p * innerW;
  const y = (p: number) => MARGIN.top + innerH * (1 - p);
  const maxN = Math.max(...buckets.map((b) => b.n));
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  const hovered = hoverIdx !== null ? buckets[hoverIdx] : null;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label="Calibration chart: predicted probability vs realized win rate — see the table below for exact values">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} stroke="var(--gridline)" strokeWidth={1} />
            <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y(t)} y2={y(t)} stroke="var(--gridline)" strokeWidth={1} />
            <text x={x(t)} y={HEIGHT - MARGIN.bottom + 16} textAnchor="middle" className="fill-[var(--text-muted)] text-[10px]">
              {Math.round(t * 100)}%
            </text>
            <text x={MARGIN.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" className="fill-[var(--text-muted)] text-[10px]">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}

        {/* perfect-calibration reference — a reference, not data, so it's recessive and dashed */}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--baseline)" strokeWidth={1.5} strokeDasharray="4 3" />
        <text x={x(0.98)} y={y(0.98) - 6} textAnchor="end" className="fill-[var(--text-muted)] text-[10px]">
          perfectly calibrated
        </text>

        <text x={(MARGIN.left + WIDTH - MARGIN.right) / 2} y={HEIGHT - 2} textAnchor="middle" className="fill-[var(--text-muted)] text-[10px]">
          Predicted probability
        </text>
        <text x={12} y={(MARGIN.top + HEIGHT - MARGIN.bottom) / 2} textAnchor="middle" transform={`rotate(-90 12 ${(MARGIN.top + HEIGHT - MARGIN.bottom) / 2})`} className="fill-[var(--text-muted)] text-[10px]">
          Realized win rate
        </text>

        {buckets.map((b, i) => {
          const thin = b.n < MIN_TRUST_N;
          const r = 4 + (b.n / maxN) * 8; // marker size carries sample size -- a thin bucket LOOKS small, not just labeled small
          return (
            <g key={b.label}>
              <circle
                cx={x(b.predictedMean)}
                cy={y(b.realizedRate)}
                r={Math.max(r, 12)}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
                onFocus={() => setHoverIdx(i)}
                onBlur={() => setHoverIdx(null)}
                tabIndex={0}
                role="button"
                aria-label={`Predicted ${(b.predictedMean * 100).toFixed(0)}%, realized ${(b.realizedRate * 100).toFixed(0)}%, n=${b.n}`}
              />
              <circle
                cx={x(b.predictedMean)}
                cy={y(b.realizedRate)}
                r={r}
                fill="var(--series-1)"
                opacity={thin ? 0.35 : hoverIdx === i ? 1 : 0.8}
                stroke="var(--surface-1)"
                strokeWidth={2}
                strokeDasharray={thin ? "2 2" : undefined}
                style={{ transition: "opacity 150ms" }}
                pointerEvents="none"
              />
            </g>
          );
        })}
      </svg>

      {hovered && (
        <div className="mt-2 flex items-center gap-3 rounded-md bg-[var(--page-plane)] px-3 py-2 text-xs">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--series-1)" }} />
          <span className="font-medium text-[var(--text-primary)]">{hovered.label} bucket</span>
          <span className="text-[var(--text-secondary)]">
            predicted <span className="tabular font-semibold text-[var(--text-primary)]">{(hovered.predictedMean * 100).toFixed(1)}%</span>
          </span>
          <span className="text-[var(--text-secondary)]">
            realized <span className="tabular font-semibold text-[var(--text-primary)]">{(hovered.realizedRate * 100).toFixed(1)}%</span>
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
                <th scope="col" className="px-3 py-2">Predicted bucket</th>
                <th scope="col" className="tabular px-3 py-2 text-right">Predicted mean</th>
                <th scope="col" className="tabular px-3 py-2 text-right">Realized</th>
                <th scope="col" className="tabular px-3 py-2 text-right">N</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.label} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-3 py-1.5 text-[var(--text-primary)]">{b.label}</td>
                  <td className="tabular px-3 py-1.5 text-right text-[var(--text-primary)]">{(b.predictedMean * 100).toFixed(1)}%</td>
                  <td className="tabular px-3 py-1.5 text-right text-[var(--text-primary)]">{(b.realizedRate * 100).toFixed(1)}%</td>
                  <td className="tabular px-3 py-1.5 text-right text-[var(--text-secondary)]">{b.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
