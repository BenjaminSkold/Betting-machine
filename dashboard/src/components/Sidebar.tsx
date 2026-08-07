"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid, CalendarDays, Wallet, ArrowLeftRight, Target, GitCompareArrows, Timer, TrendingUp, Menu, X } from "lucide-react";
import ThemeToggle from "./ThemeToggle";

const PRIMARY = [
  { href: "/", label: "Overview", icon: LayoutGrid },
  { href: "/matches", label: "Matches", icon: CalendarDays },
  { href: "/wallets", label: "Wallets", icon: Wallet },
  { href: "/trades", label: "Trades", icon: ArrowLeftRight },
];

const ANALYSIS = [
  { href: "/calibration", label: "Calibration", icon: Target },
  { href: "/edge-segmentation", label: "Edge segmentation", icon: GitCompareArrows },
  { href: "/timing-checkpoints", label: "Timing checkpoints", icon: Timer },
];

// Kept in its own group, visually separated by a divider from the wallet
// leaderboard nav above -- this is the user's own simulated ledger, not
// another tracked wallet (PROJECT.md hard constraint).
const PERFORMANCE = [{ href: "/performance", label: "My Performance", icon: TrendingUp }];

function Logo() {
  // Three overlapping circles -- the "confluence" of independent signals
  // agreeing (or not) on one point, echoed at favicon size in icon.tsx.
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <circle cx="10" cy="9" r="7" fill="var(--series-1)" opacity="0.85" />
      <circle cx="16" cy="9" r="7" fill="var(--series-2)" opacity="0.85" />
      <circle cx="13" cy="15" r="7" fill="var(--series-3)" opacity="0.85" />
    </svg>
  );
}

function NavLink({ href, label, icon: Icon, active, onClick }: { href: string; label: string; icon: typeof LayoutGrid; active: boolean; onClick: () => void }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150 ${
        active ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      }`}
      style={{ background: active ? "color-mix(in srgb, var(--diverging-pos) 12%, transparent)" : undefined }}
    >
      {active && <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full" style={{ background: "var(--diverging-pos)" }} />}
      <Icon size={16} strokeWidth={2} className={active ? "" : "opacity-70 group-hover:opacity-100"} />
      {label}
    </Link>
  );
}

export default function Sidebar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const close = () => setOpen(false);
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <>
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 md:hidden">
        <div className="flex items-center gap-2">
          <Logo />
          <span className="text-base font-semibold tracking-tight text-[var(--text-primary)]">Confluence</span>
        </div>
        <button onClick={() => setOpen(true)} aria-label="Open navigation" className="rounded-md p-2 text-[var(--text-primary)] hover:bg-[var(--page-plane)]">
          <Menu size={20} strokeWidth={1.5} />
        </button>
      </div>

      {open && <div className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[2px] md:hidden" onClick={close} />}

      <aside
        aria-label="Main navigation"
        className={`fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface-1)] px-3 py-6 transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-7 flex items-center justify-between px-2.5">
          <div className="flex items-center gap-2.5">
            <Logo />
            <div>
              <div className="text-base font-semibold tracking-tight text-[var(--text-primary)]">Confluence</div>
              <div className="text-[11px] text-[var(--text-muted)]">where&apos;s the edge, right now</div>
            </div>
          </div>
          <button onClick={close} aria-label="Close navigation" className="rounded-md p-1 text-[var(--text-secondary)] md:hidden">
            <X size={16} />
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          {PRIMARY.map((item) => (
            <NavLink key={item.href} {...item} active={isActive(item.href)} onClick={close} />
          ))}

          <div className="mb-1 mt-5 px-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Analysis</div>
          {ANALYSIS.map((item) => (
            <NavLink key={item.href} {...item} active={isActive(item.href)} onClick={close} />
          ))}

          <div className="my-3 border-t border-[var(--border)]" />
          {PERFORMANCE.map((item) => (
            <NavLink key={item.href} {...item} active={isActive(item.href)} onClick={close} />
          ))}
        </nav>

        <ThemeToggle />
      </aside>
    </>
  );
}
