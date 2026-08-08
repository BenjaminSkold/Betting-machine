"use client";

import { useState, useTransition } from "react";
import { placeManualBet } from "@/lib/actions";
import type { Leg } from "@/lib/types";

// Headroom above scoreMatches.js's own MAX_SHIFT (15pp) -- the model can't
// produce an edge past roughly that, so the gauge's high end is a stable,
// principled number rather than one that needs retuning as data grows.
const MAX_EDGE_DISPLAY_PP = 20;

export default function ManualBetForm({
  scoreId,
  legLabel,
  legEdges,
  legPrices,
  defaultLeg,
}: {
  scoreId: string;
  legLabel: Record<Leg, string>;
  legEdges: Record<Leg, number | null>;
  legPrices: Record<Leg, number | null>;
  defaultLeg: Leg;
}) {
  const [leg, setLeg] = useState<Leg>(defaultLeg);
  const [stake, setStake] = useState("10");
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{ error?: string; placed?: boolean } | null>(null);

  const edge = legEdges[leg] ?? 0;
  const edgePp = edge * 100;
  const fillPct = Math.min(100, (Math.abs(edgePp) / MAX_EDGE_DISPLAY_PP) * 100);
  const positive = edgePp >= 0;

  // Polymarket shares always resolve to exactly $1 -- buying at `price`
  // buys 1/price shares per $1 staked, so that's the whole payout picture:
  // risk the stake, get back stake/price if it wins, nothing if it doesn't.
  const price = legPrices[leg];
  const stakeNum = Number(stake) || 0;
  const toReturn = price && price > 0 ? stakeNum / price : null;
  const profit = toReturn !== null ? toReturn - stakeNum : null;

  function submit() {
    setResult(null);
    startTransition(async () => {
      const stakeNum = Number(stake);
      const res = await placeManualBet(scoreId, leg, stakeNum);
      setResult(res.error ? { error: res.error } : { placed: true });
    });
  }

  return (
    <div className="mt-3 rounded-md border border-[var(--border)] p-3">
      <div className="mb-2 text-xs font-medium text-[var(--text-secondary)]">Place your own bet</div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {(["home", "draw", "away"] as Leg[]).map((l) => (
          <button
            key={l}
            onClick={() => {
              setLeg(l);
              setResult(null);
            }}
            className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
            style={{
              background: leg === l ? "color-mix(in srgb, var(--diverging-pos) 14%, transparent)" : "var(--page-plane)",
              color: leg === l ? "var(--diverging-pos)" : "var(--text-secondary)",
            }}
          >
            {legLabel[l]}
          </button>
        ))}
      </div>

      {/* The edge gauge: 0pp (empty) up to a fixed 20pp ceiling (full) --
          fills to wherever the currently-selected leg's actual edge falls,
          so the confluence score's signal strength is visible before
          deciding to back it, per the dataviz skill's "decision context
          before the input" pattern. */}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between text-xs text-[var(--text-muted)]">
          <span>0pp</span>
          <span className="tabular font-medium" style={{ color: positive ? "var(--diverging-pos)" : "var(--diverging-neg)" }}>
            {positive ? "+" : ""}
            {edgePp.toFixed(1)}pp edge
          </span>
          <span>{MAX_EDGE_DISPLAY_PP}pp+</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--gridline)" }}>
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${fillPct}%`, background: positive ? "var(--diverging-pos)" : "var(--diverging-neg)" }}
          />
        </div>
      </div>

      <div className="flex items-end gap-2">
        <label className="flex flex-col text-xs text-[var(--text-secondary)]">
          Stake ($)
          <input
            type="number"
            min="1"
            step="1"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            className="mt-1 w-24 rounded-md border border-[var(--border)] bg-[var(--page-plane)] px-2 py-1.5 text-sm text-[var(--text-primary)]"
          />
        </label>

        {/* Risk/reward, spelled out in dollars -- not left as a probability
            the user has to convert in their head. Polymarket shares always
            resolve to exactly $1, so this is the whole picture: win this
            much, or lose the stake. */}
        <div className="text-xs text-[var(--text-secondary)]">
          {toReturn !== null ? (
            <>
              <span className="text-[var(--text-muted)]">Risk </span>
              <span className="tabular font-medium text-[var(--text-primary)]">${stakeNum.toFixed(2)}</span>
              <span className="text-[var(--text-muted)]"> to win </span>
              <span className="tabular font-medium" style={{ color: "var(--status-good-text)" }}>
                ${toReturn.toFixed(2)}
              </span>
              <span className="text-[var(--text-muted)]"> (+${(profit ?? 0).toFixed(2)}), or lose the stake.</span>
            </>
          ) : (
            <span className="text-[var(--text-muted)]">No valid price for this leg right now.</span>
          )}
        </div>

        <button
          onClick={submit}
          disabled={isPending}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-white transition-opacity disabled:opacity-50"
          style={{ background: "var(--diverging-pos)" }}
        >
          {isPending ? "Placing…" : "Place bet"}
        </button>
      </div>

      {result?.error && <p className="mt-2 text-xs text-[var(--status-critical)]">{result.error}</p>}
      {result?.placed && <p className="mt-2 text-xs text-[var(--status-good-text)]">Bet placed — see it in My Performance.</p>}
    </div>
  );
}
