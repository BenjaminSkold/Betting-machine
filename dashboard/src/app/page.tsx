import Link from "next/link";
import StatTile from "@/components/StatTile";
import { getMatches, getPaperBets, getSystemStatus, getWallets } from "@/lib/data";
import { freshnessAge } from "@/lib/time";

export default async function OverviewPage() {
  const [matches, wallets, paperBets, status] = await Promise.all([getMatches(), getWallets(), getPaperBets(), getSystemStatus()]);

  const upcoming = matches.filter((m) => !m.data.resolved).length;
  const resolved = matches.filter((m) => m.data.resolved).length;
  const watchlisted = wallets.filter((w) => w.data.tier === "watch").length;
  const settledBets = paperBets.filter((b) => b.data.outcome !== "pending");
  const bankroll = settledBets.reduce((sum, b) => sum + (b.data.pnl ?? 0), 0);

  const isStale = status?.lastSuccessfulRun ? freshnessAge(status.lastSuccessfulRun) > 30 * 60 * 1000 : true;

  const recentScored = matches
    .filter((m) => m.data.resolved)
    .sort((a, b) => b.data.kickoffTime.localeCompare(a.data.kickoffTime))
    .slice(0, 5);

  return (
    <div className="max-w-5xl">
      <div className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Overview</h1>
          <p className="text-sm text-[var(--text-secondary)]">Where&apos;s the edge, right now.</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: status?.lastSuccessfulRun ? (isStale ? "var(--status-warning)" : "var(--status-good)") : "var(--status-critical)" }}
          />
          {status?.lastSuccessfulRun ? `Pipeline last ran ${new Date(status.lastSuccessfulRun).toLocaleString()}` : "Pipeline hasn't run yet"}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <StatTile label="Upcoming matches" value={String(upcoming)} />
        <StatTile label="Resolved matches" value={String(resolved)} />
        <StatTile label="Watchlisted wallets" value={`${watchlisted} / ${wallets.length}`} />
        <StatTile
          label="Fake bankroll"
          value={`$${bankroll.toFixed(2)}`}
          delta={settledBets.length > 0 ? `${settledBets.length} settled bet(s)` : "no bets settled yet"}
          deltaGood={bankroll >= 0}
        />
      </div>

      <div className="mt-8 grid grid-cols-3 gap-4">
        <QuickLink href="/matches" title="Matches" description="Upcoming and recent matches with confluence score + edge." />
        <QuickLink href="/wallets" title="Wallets" description="The tier-“watch” leaderboard, sliced by competition and team." />
        <QuickLink href="/trades" title="Trades" description="Every Tier 1 trade log, searchable by wallet." />
      </div>

      <h2 className="mt-8 mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Recently resolved</h2>
      {recentScored.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-6 text-sm text-[var(--text-muted)]">
          Nothing resolved yet.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {recentScored.map((m) => (
            <Link
              key={m.id}
              href={`/matches/${m.id}`}
              className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 hover:border-[var(--baseline)]"
            >
              <div>
                <div className="text-xs font-medium text-[var(--text-muted)]">{m.data.competition}</div>
                <div className="font-medium text-[var(--text-primary)]">
                  {m.data.homeTeam} vs. {m.data.awayTeam}
                </div>
              </div>
              <div className="text-sm text-[var(--text-secondary)]">{m.data.result ?? "—"}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}


function QuickLink({ href, title, description }: { href: string; title: string; description: string }) {
  return (
    <Link href={href} className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 hover:border-[var(--baseline)]">
      <div className="font-medium text-[var(--text-primary)]">{title}</div>
      <div className="mt-1 text-xs text-[var(--text-secondary)]">{description}</div>
    </Link>
  );
}
