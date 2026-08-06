"use client";

import { useState } from "react";
import Link from "next/link";
import ThemeToggle from "./ThemeToggle";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/matches", label: "Matches" },
  { href: "/wallets", label: "Wallets" },
  { href: "/trades", label: "Trades" },
  { href: "/performance", label: "My Performance" },
];

export default function Sidebar() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile top bar — hidden at md and up, where the sidebar is always visible. */}
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 md:hidden">
        <div className="text-lg font-semibold text-[var(--text-primary)]">Confluence</div>
        <button
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          className="rounded-md p-2 text-[var(--text-primary)] hover:bg-[var(--page-plane)]"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 5h16M2 10h16M2 15h16" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Backdrop — mobile only, closes the drawer on tap-outside. */}
      {open && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setOpen(false)} />}

      <aside
        aria-label="Main navigation"
        className={`fixed inset-y-0 left-0 z-40 flex w-56 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface-1)] px-4 py-6 transition-transform duration-200 md:static md:z-auto md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="mb-8 flex items-center justify-between px-2">
          <div>
            <div className="text-lg font-semibold text-[var(--text-primary)]">Confluence</div>
            <div className="text-xs text-[var(--text-muted)]">edge over the market</div>
          </div>
          <button onClick={() => setOpen(false)} aria-label="Close navigation" className="rounded-md p-1 text-[var(--text-secondary)] md:hidden">
            ✕
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className="rounded-md px-3 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--page-plane)] hover:text-[var(--text-primary)]"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <ThemeToggle />
      </aside>
    </>
  );
}
