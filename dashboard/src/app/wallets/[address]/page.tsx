import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { getMatchesForWallet, getMatchTrades, getWallet } from "@/lib/data";
import type { Wallet, WalletTrend } from "@/lib/types";
import { isValidWalletAddress } from "@/lib/validate";
import { mapWithConcurrency } from "@/lib/concurrency";
import StatTile from "@/components/StatTile";
import BarChart, { type BarDatum } from "@/components/BarChart";
import TimeBreakdownChart from "@/components/TimeBreakdownChart";
import FadeIn from "@/components/FadeIn";
import StopPropagationLink from "@/components/StopPropagationLink";
import { legFor, legLabel, tradeWon, positionLabel, outcomeLabel } from "@/lib/tradeOutcome";
import type { RawTrade } from "@/lib/types";

export const dynamic = "force-dynamic";

function pct(x: number | null | undefined): string {
  if (x === null || x === undefined) return "—";
  return `${(x * 100).toFixed(1)}%`;
}

function money(x: number | null | undefined): string {
  if (x === null || x === undefined) return "—";
  const sign = x < 0 ? "-" : "";
  return `${sign}$${Math.abs(x).toFixed(2)}`;
}

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!isValidWalletAddress(address)) return { title: "Wallet not found" };
  const wallet = await getWallet(address);
  return { title: wallet ? `${address.slice(0, 10)}… — Wallet` : "Wallet not found" };
}

export default async function WalletDetailPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!isValidWalletAddress(address)) notFound();
  const wallet = await getWallet(address);
  if (!wallet) notFound();

  // Used to scan every match's R2 files to find one wallet's trades --
  // confirmed live at 300+ matches that didn't scale (60s+), so it was
  // capped to the 150 most recent matches LEAGUE-WIDE as a stopgap. That
  // cap was WRONG, not just slow: early in a new season, a wallet's entire
  // real history can predate the 150 most recent matches league-wide,
  // making it invisible regardless of how active that wallet actually was.
  // wallet_matches (written by rankWallets.js's own full scan, so no extra
  // R2 reads to build it) fixes the correctness problem -- this now finds
  // every match the wallet ever actually touched, full stop.
  //
  // The speed problem needed its own fix, separately: even knowing exactly
  // which matches to fetch, reading a match's full trade archive means
  // downloading and decompressing EVERY trade on it just to filter for one
  // wallet -- confirmed live, a wallet touching 270 real matches took 60s.
  // So the display itself is still capped, but now to the WALLET'S OWN 150
  // most recent matches (never wrong, since it's scoped to real activity
  // this specific wallet had) rather than the league's 150 most recent
  // (wrong, since it depended on what OTHER wallets/matches existed).
  const RECENT_MATCHES_SCANNED = 150;
  const allWalletMatches = await getMatchesForWallet(address);
  const matches = [...allWalletMatches].sort((a, b) => b.data.kickoffTime.localeCompare(a.data.kickoffTime)).slice(0, RECENT_MATCHES_SCANNED);
  const scannedAllMatches = allWalletMatches.length <= RECENT_MATCHES_SCANNED;

  const tradesByMatch = await mapWithConcurrency(matches, 40, async (m) => ({
    match: m,
    trades: (await getMatchTrades(m.id)).filter((t) => t.wallet === address),
  }));
  function pnlFor(t: RawTrade, won: boolean): number {
    const { side, price, size } = t;
    if (side === "BUY") return won ? size * (1 - price) : -size * price;
    return won ? size * price : -size * (1 - price);
  }

  // $ actually at risk on this fill -- mirrors rankWallets.js's pnlAndStake:
  // a BUY risks what it paid (price*size), a SELL risks its max liability
  // if the outcome it sold goes the other way ((1-price)*size).
  function stakeFor(t: RawTrade): number {
    return t.side === "BUY" ? t.price * t.size : (1 - t.price) * t.size;
  }

  // One row per (wallet, match), not per fill -- a wallet placing one bet
  // via many small order fills (common on Polymarket's CLOB) is one betting
  // decision, not N independent ones. Feeds the week/month/year breakdown
  // below; the raw per-fill list above is untouched since that's meant to
  // show every fill for manual inspection, not a statistic.
  const matchLevelBets = tradesByMatch
    .filter((x) => x.trades.length > 0 && x.match.data.resolved && x.match.data.result)
    .map((x) => {
      let pnl = 0;
      let earliestTs = Infinity;
      let any = false;
      for (const t of x.trades) {
        const won = tradeWon(t, legFor(t, x.match.data.marketConditionIds), x.match.data.resolved, x.match.data.result);
        if (won === null) continue;
        pnl += pnlFor(t, won);
        earliestTs = Math.min(earliestTs, t.timestamp);
        any = true;
      }
      return any ? { timestamp: earliestTs, win: pnl > 0 } : null;
    })
    .filter((x): x is { timestamp: number; win: boolean } => x !== null);

  function bucketBy(keyFn: (timestamp: number) => string): BarDatum[] {
    const groups = new Map<string, { win: number; total: number }>();
    for (const b of matchLevelBets) {
      const key = keyFn(b.timestamp);
      const g = groups.get(key) ?? { win: 0, total: 0 };
      g.total += 1;
      if (b.win) g.win += 1;
      groups.set(key, g);
    }
    return [...groups.entries()]
      .map(([label, g]) => ({ label, value: (g.win / g.total) * 100, n: g.total }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  const weekLabel = (ts: number) => {
    const d = new Date(ts * 1000);
    const utcDay = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - utcDay));
    return monday.toISOString().slice(0, 10);
  };
  const byWeek = bucketBy(weekLabel);
  const byMonth = bucketBy((ts) => new Date(ts * 1000).toISOString().slice(0, 7));
  const byYear = bucketBy((ts) => new Date(ts * 1000).toISOString().slice(0, 4));

  // One group per match this wallet has fills on -- a wallet placing one bet
  // via several small order fills (common on Polymarket's CLOB) shows up as
  // one grouped row with a fill count, expandable to the individual fills,
  // instead of N separate-looking rows for what was really one decision.
  const matchGroups = tradesByMatch
    .filter((x) => x.trades.length > 0)
    .map((x) => {
      const fills = [...x.trades]
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((t) => {
          const leg = legFor(t, x.match.data.marketConditionIds);
          const won = tradeWon(t, leg, x.match.data.resolved, x.match.data.result);
          return { trade: t, leg, won, pnl: won === null ? null : pnlFor(t, won), stake: stakeFor(t) };
        });
      const totalStake = fills.reduce((s, f) => s + f.stake, 0);
      const anyPending = fills.some((f) => f.won === null);
      const totalPnl = anyPending ? null : fills.reduce((s, f) => s + (f.pnl ?? 0), 0);
      const legs = [...new Set(fills.map((f) => f.leg).filter((l): l is "home" | "draw" | "away" => l !== null))];
      return {
        match: x.match,
        fills,
        totalStake,
        totalPnl,
        legs,
        latestTimestamp: fills[0].trade.timestamp,
      };
    })
    .sort((a, b) => b.latestTimestamp - a.latestTimestamp);

  const competitionBars: BarDatum[] = Object.entries(wallet.data.bySlice.byCompetition)
    .map(([label, s]) => ({ label, value: ((s.winRate ?? 0.5) - 0.5) * 100, n: s.trades }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className="max-w-4xl">
      <Link href="/wallets" className="inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        <ArrowLeft size={14} /> Wallets
      </Link>

      <div className="mt-3 mb-6">
        <h1 className="break-all font-mono text-xl font-semibold text-[var(--text-primary)]">{address}</h1>
        <div className="mt-1.5 flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <span
            className="rounded-full px-2.5 py-0.5 text-xs font-medium"
            style={{ background: wallet.data.tier === "watch" ? "var(--status-good)" : "var(--gridline)", color: wallet.data.tier === "watch" ? "white" : "var(--text-secondary)" }}
          >
            {wallet.data.tier}
          </span>
          Last updated {new Date(wallet.data.lastUpdated).toLocaleString()}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Resolved trades" animate={wallet.data.totalResolvedTrades} format="integer" />
        <StatTile label="Win rate (shrunk)" animate={wallet.data.aggregateWinRate * 100} format="percent1" />
        <StatTile label="ROI" animate={(wallet.data.aggregateROI ?? 0) * 100} format="percent1" deltaGood={(wallet.data.aggregateROI ?? 0) >= 0} />
        <StatTile
          label="Total profit"
          value={money(wallet.data.aggregatePnl)}
          delta={`${money(wallet.data.aggregateStake)} staked`}
          deltaGood={wallet.data.aggregatePnl >= 0}
        />
      </div>

      <FadeIn className="mt-6">
        <TrendCard trend={wallet.data.trend} />
      </FadeIn>

      {competitionBars.length > 0 && (
        <FadeIn className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Edge over average, by competition</h2>
          <BarChart data={competitionBars} baseline={0} formatMode="signedPp1" />
          <p className="mt-2 text-xs text-[var(--text-muted)]">*pp = percentage points above/below a 50% coin-flip baseline — a plain difference, not a percent change.</p>
        </FadeIn>
      )}

      <SliceTable title="By team" slices={wallet.data.bySlice.byTeam} />

      {matchLevelBets.length > 0 && (
        <FadeIn className="mt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Win rate over time</h2>
          <TimeBreakdownChart byWeek={byWeek} byMonth={byMonth} byYear={byYear} baseline={wallet.data.aggregateWinRate * 100} />
        </FadeIn>
      )}

      <h2 className="mt-8 mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Trade history</h2>
      {!scannedAllMatches && (
        <p className="mb-3 text-xs text-[var(--text-muted)]">
          Showing this wallet&apos;s {RECENT_MATCHES_SCANNED} most recent matches (of {allWalletMatches.length} total) — the stats above cover its
          full history regardless.
        </p>
      )}
      {matchGroups.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-6 text-sm text-[var(--text-muted)]">No trades found for this wallet yet.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {matchGroups.map((g) => {
            const dotColor = g.totalPnl === null ? "var(--gridline)" : g.totalPnl > 0 ? "var(--status-good)" : "var(--status-critical)";
            const pnlColor = g.totalPnl === null ? "var(--text-muted)" : g.totalPnl >= 0 ? "var(--status-good-text)" : "var(--status-critical)";
            return (
              <details key={g.match.id} className="group rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 [&::-webkit-details-marker]:hidden">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: dotColor }} title={g.totalPnl === null ? "pending" : g.totalPnl > 0 ? "win" : "loss"} />
                    <div className="min-w-0">
                      <div className="text-xs text-[var(--text-muted)]">
                        {new Date(g.latestTimestamp * 1000).toLocaleDateString()} · backing{" "}
                        {g.legs.map((l) => legLabel(l, g.match.data.homeTeam, g.match.data.awayTeam)).join(" / ") || "—"}
                      </div>
                      <StopPropagationLink
                        href={`/matches/${g.match.id}`}
                        className="font-medium text-[var(--text-primary)] hover:underline"
                      >
                        {g.match.data.homeTeam} vs. {g.match.data.awayTeam}
                      </StopPropagationLink>
                    </div>
                    {g.fills.length > 1 && (
                      <span className="shrink-0 rounded-full bg-[var(--page-plane)] px-2 py-0.5 text-xs text-[var(--text-muted)]">{g.fills.length} fills</span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-5">
                    <div className="text-right">
                      <div className="text-xs text-[var(--text-muted)]">Staked</div>
                      <div className="tabular text-sm text-[var(--text-primary)]">{money(g.totalStake)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-[var(--text-muted)]">Profit</div>
                      <div className="tabular text-sm font-medium" style={{ color: pnlColor }}>
                        {g.totalPnl === null ? "pending" : money(g.totalPnl)}
                      </div>
                    </div>
                    <ChevronDown size={16} className="shrink-0 text-[var(--text-muted)] transition-transform group-open:rotate-180" />
                  </div>
                </summary>
                <div className="overflow-x-auto border-t border-[var(--border)]">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                        <th scope="col" className="px-4 py-2"></th>
                        <th scope="col" className="px-4 py-2">When</th>
                        <th scope="col" className="px-4 py-2">Position</th>
                        <th scope="col" className="px-4 py-2">Result</th>
                        <th scope="col" className="tabular px-4 py-2 text-right">Price</th>
                        <th scope="col" className="tabular px-4 py-2 text-right">Size</th>
                        <th scope="col" className="tabular px-4 py-2 text-right">Staked</th>
                        <th scope="col" className="tabular px-4 py-2 text-right">Profit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.fills.map((f, i) => {
                        const fillDotColor = f.won === null ? "var(--gridline)" : f.won ? "var(--status-good)" : "var(--status-critical)";
                        const fillResultColor = f.won === null ? "var(--text-muted)" : f.won ? "var(--status-good-text)" : "var(--status-critical)";
                        const fillPnlColor = f.pnl === null ? "var(--text-muted)" : f.pnl >= 0 ? "var(--status-good-text)" : "var(--status-critical)";
                        return (
                          <tr key={i} className="border-b border-[var(--border)] last:border-0">
                            <td className="pl-4"><span className="inline-block h-2 w-2 rounded-full" style={{ background: fillDotColor }} /></td>
                            <td className="tabular px-4 py-2 text-[var(--text-secondary)]">{new Date(f.trade.timestamp * 1000).toLocaleString()}</td>
                            <td className="px-4 py-2 text-[var(--text-secondary)]">
                              {positionLabel(f.trade, f.leg, g.match.data.homeTeam, g.match.data.awayTeam)}
                            </td>
                            <td className="px-4 py-2 font-medium" style={{ color: fillResultColor }}>{outcomeLabel(f.won)}</td>
                            <td className="tabular px-4 py-2 text-right text-[var(--text-primary)]">{(f.trade.price * 100).toFixed(1)}%</td>
                            <td className="tabular px-4 py-2 text-right text-[var(--text-primary)]">${f.trade.size.toFixed(0)}</td>
                            <td className="tabular px-4 py-2 text-right text-[var(--text-primary)]">{money(f.stake)}</td>
                            <td className="tabular px-4 py-2 text-right font-medium" style={{ color: fillPnlColor }}>
                              {f.pnl === null ? "pending" : money(f.pnl)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SliceTable({ title, slices, chronological = false }: { title: string; slices: Wallet["bySlice"]["byCompetition"]; chronological?: boolean }) {
  const entries = Object.entries(slices).sort((a, b) => (chronological ? a[0].localeCompare(b[0]) : (b[1].winRate ?? 0) - (a[1].winRate ?? 0)));
  if (entries.length === 0) return null;
  return (
    <FadeIn className="mt-6">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">{title}</h2>
      <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
              <th scope="col" className="px-4 py-3">Slice</th>
              <th scope="col" className="tabular px-4 py-3 text-right">Trades</th>
              <th scope="col" className="tabular px-4 py-3 text-right">Win rate</th>
              <th scope="col" className="tabular px-4 py-3 text-right">ROI</th>
              <th scope="col" className="tabular px-4 py-3 text-right">Staked</th>
              <th scope="col" className="tabular px-4 py-3 text-right">Profit</th>
              <th scope="col" className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, s]) => {
              const pnlColor = s.pnl >= 0 ? "var(--status-good-text)" : "var(--status-critical)";
              return (
                <tr key={key} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2 text-[var(--text-primary)]">{key}</td>
                  <td className="tabular px-4 py-2 text-right text-[var(--text-primary)]">{s.trades}</td>
                  <td className="tabular px-4 py-2 text-right text-[var(--text-primary)]">{pct(s.winRate)}</td>
                  <td className="tabular px-4 py-2 text-right text-[var(--text-primary)]">{pct(s.roi)}</td>
                  <td className="tabular px-4 py-2 text-right text-[var(--text-primary)]">{money(s.stake)}</td>
                  <td className="tabular px-4 py-2 text-right font-medium" style={{ color: pnlColor }}>{money(s.pnl)}</td>
                  <td className="px-4 py-2 text-xs text-[var(--text-muted)]">{s.usedFallback ? "fallback (thin sample)" : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </FadeIn>
  );
}

function TrendCard({ trend }: { trend: WalletTrend }) {
  const dotColor = trend.label === "declining" ? "var(--status-critical)" : trend.label === "improving" ? "var(--status-good)" : "var(--text-muted)";
  const deltaColor = trend.delta === null ? "var(--text-muted)" : trend.delta >= 0 ? "var(--status-good-text)" : "var(--status-critical)";

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Trend</h2>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: dotColor }} />
          {trend.label}
        </span>
      </div>
      {trend.label === "insufficient data" ? (
        <p className="text-sm text-[var(--text-muted)]">
          Not enough trades in this wallet&apos;s early and recent halves yet to say anything about a trend — each half needs its own activity bar
          cleared independently.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          <div>
            <div className="text-xs text-[var(--text-secondary)]">Early half</div>
            <div className="tabular text-lg font-semibold text-[var(--text-primary)]">{pct(trend.early.winRate)}</div>
            <div className="text-xs text-[var(--text-muted)]">n={trend.early.trades}</div>
          </div>
          <div>
            <div className="text-xs text-[var(--text-secondary)]">Recent half</div>
            <div className="tabular text-lg font-semibold text-[var(--text-primary)]">{pct(trend.recent.winRate)}</div>
            <div className="text-xs text-[var(--text-muted)]">n={trend.recent.trades}</div>
          </div>
          <div>
            <div className="text-xs text-[var(--text-secondary)]">Change*</div>
            <div className="tabular text-lg font-semibold" style={{ color: deltaColor }}>
              {trend.delta !== null && trend.delta >= 0 ? "+" : ""}
              {trend.delta !== null ? `${(trend.delta * 100).toFixed(1)}pp` : "—"}
            </div>
          </div>
        </div>
      )}
      {trend.delta !== null && (
        <p className="mt-3 text-xs text-[var(--text-muted)]">*pp = percentage points (e.g. 60% → 65% is +5pp) — a plain difference, not a percent change.</p>
      )}
    </div>
  );
}
