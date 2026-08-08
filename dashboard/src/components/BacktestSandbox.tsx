"use client";

import { useMemo, useState } from "react";
import type { BacktestInput } from "@/lib/data";
import { TIMING_BUCKETS, timingBucketLabel } from "@/lib/breakdown";
import { MIN_SETTLED_BETS_TO_TRUST } from "@/lib/types";
import StatTile from "./StatTile";
import BankrollChart, { type BankrollPoint } from "./BankrollChart";
import TrustGate from "./TrustGate";

type Mode = "back" | "fade";

const MAX_THRESHOLD_PP = 20;
const DEFAULT_STAKE = 10;

// Every slider/toggle here recomputes entirely in the browser off one
// dataset fetched once (getBacktestInputs) -- no server round trip per
// drag, so it can afford to feel instant. The whole point is answering
// "what if I'd used a different threshold, entry timing, or bet direction"
// against the SAME history the live system already has, not a live query.
export default function BacktestSandbox({ data }: { data: BacktestInput[] }) {
  const [threshold, setThreshold] = useState(5);
  const [mode, setMode] = useState<Mode>("back");
  const [checkpoint, setCheckpoint] = useState<string>("all");
  const [stake, setStake] = useState(String(DEFAULT_STAKE));

  const stakeNum = Number(stake) || DEFAULT_STAKE;

  const result = useMemo(() => {
    const thresholdFrac = threshold / 100;
    const scoped = checkpoint === "all" ? data : data.filter((d) => timingBucketLabel(d.minutesBeforeKickoff) === checkpoint);

    const decided = scoped
      .filter((d) => (mode === "back" ? d.edge > thresholdFrac : d.edge < -thresholdFrac))
      .map((d) => {
        // Fading means buying the tracked leg's "No" side instead of
        // backing it -- price and win condition both flip accordingly.
        const price = mode === "back" ? d.priceAtBet : 1 - d.priceAtBet;
        const win = mode === "back" ? d.trackedLegWon : !d.trackedLegWon;
        const pnl = win ? stakeNum / price - stakeNum : -stakeNum;
        return { kickoffTime: d.kickoffTime, win, pnl };
      })
      .sort((a, b) => a.kickoffTime.localeCompare(b.kickoffTime));

    const wins = decided.filter((d) => d.win).length;
    const totalPnl = decided.reduce((s, d) => s + d.pnl, 0);
    const totalStaked = decided.length * stakeNum;
    const winRate = decided.length > 0 ? wins / decided.length : null;
    const roi = totalStaked > 0 ? totalPnl / totalStaked : null;

    let running = 0;
    const bankrollPoints: BankrollPoint[] = decided.map((d) => {
      running += d.pnl;
      return { t: new Date(d.kickoffTime).getTime() / 1000, cumulativePnl: running };
    });

    return { decidedCount: decided.length, winRate, roi, totalPnl, bankrollPoints };
  }, [data, threshold, mode, checkpoint, stakeNum]);

  return (
    <div>
      <div className="mb-6 grid grid-cols-1 gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 sm:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span>Edge threshold</span>
            <span className="tabular font-medium text-[var(--text-primary)]">{threshold.toFixed(1)}pp</span>
          </div>
          <input
            type="range"
            min={0}
            max={MAX_THRESHOLD_PP}
            step={0.5}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="w-full accent-[var(--diverging-pos)]"
          />
          <div className="mt-1 flex justify-between text-[10px] text-[var(--text-muted)]">
            <span>0pp</span>
            <span>{MAX_THRESHOLD_PP}pp</span>
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs text-[var(--text-secondary)]">Direction</div>
          <div className="flex gap-1.5">
            {(["back", "fade"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className="flex-1 rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors"
                style={{
                  background: mode === m ? "color-mix(in srgb, var(--diverging-pos) 14%, transparent)" : "var(--page-plane)",
                  color: mode === m ? "var(--diverging-pos)" : "var(--text-secondary)",
                }}
              >
                {m === "back" ? "Back the edge" : "Fade the overpriced leg"}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
            {mode === "back"
              ? `Bet the tracked leg whenever its edge clears +${threshold.toFixed(1)}pp — matches how the live automatic bets work today.`
              : `Bet AGAINST the tracked leg whenever its edge is below -${threshold.toFixed(1)}pp — the live system never does this yet.`}
          </p>
        </div>

        <div>
          <div className="mb-2 text-xs text-[var(--text-secondary)]">Entry timing</div>
          <select
            value={checkpoint}
            onChange={(e) => setCheckpoint(e.target.value)}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--page-plane)] px-2.5 py-1.5 text-sm text-[var(--text-primary)]"
          >
            <option value="all">Any timing</option>
            {TIMING_BUCKETS.map((b) => (
              <option key={b.label} value={b.label}>{b.label}</option>
            ))}
          </select>
          <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
            Limited to the checkpoints we actually captured — not a free timestamp, since backtesting a moment we never polled would just be a guess.
          </p>
        </div>

        <div>
          <div className="mb-2 text-xs text-[var(--text-secondary)]">Flat stake ($)</div>
          <input
            type="number"
            min="1"
            step="1"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            className="w-24 rounded-md border border-[var(--border)] bg-[var(--page-plane)] px-2.5 py-1.5 text-sm text-[var(--text-primary)]"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Decided bets" animate={result.decidedCount} format="integer" />
        {result.winRate !== null ? <StatTile label="Win rate" animate={result.winRate * 100} format="percent1" /> : <StatTile label="Win rate" value="—" />}
        {result.roi !== null ? (
          <StatTile label="ROI" animate={result.roi * 100} format="percent1" deltaGood={result.roi >= 0} />
        ) : (
          <StatTile label="ROI" value="—" />
        )}
        <StatTile label="Total PnL" animate={result.totalPnl} format="signedMoney2" deltaGood={result.totalPnl >= 0} />
      </div>

      <div className="mt-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Simulated bankroll</h2>
        <TrustGate n={result.decidedCount} threshold={MIN_SETTLED_BETS_TO_TRUST}>
          <BankrollChart points={result.bankrollPoints} />
        </TrustGate>
      </div>
    </div>
  );
}
