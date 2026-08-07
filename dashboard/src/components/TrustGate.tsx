import type { ReactNode } from "react";

// PROJECT.md's "When you're allowed to trust the results": anything below
// the minimum sample size must look visibly different, not just carry a
// caveat nobody reads. Used across Performance, Calibration,
// Edge-segmentation, and Timing-checkpoint -- one shared treatment so
// "too early to tell" always looks and reads the same way everywhere.
export default function TrustGate({ n, threshold, unit = "settled bets", children }: { n: number; threshold: number; unit?: string; children: ReactNode }) {
  const trustworthy = n >= threshold;
  return (
    <div className="relative">
      <div
        className={trustworthy ? "" : "pointer-events-none select-none opacity-40 grayscale-[0.6]"}
        style={!trustworthy ? { filter: "blur(0.3px)" } : undefined}
        aria-hidden={!trustworthy}
      >
        {children}
      </div>
      {!trustworthy && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="mx-4 rounded-lg px-4 py-3 text-center text-sm shadow-lg backdrop-blur-sm"
            style={{ background: "color-mix(in srgb, var(--status-warning) 15%, var(--surface-1) 85%)", border: "1px dashed var(--status-warning)" }}
          >
            <div className="font-semibold text-[var(--text-primary)]">N={n}, too early to tell</div>
            <div className="mt-0.5 text-xs text-[var(--text-secondary)]">
              Needs {threshold}+ {unit} before this is signal, not noise.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
