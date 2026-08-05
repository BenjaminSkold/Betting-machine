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
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface-1)] px-4 py-6">
      <div className="mb-8 px-2">
        <div className="text-lg font-semibold text-[var(--text-primary)]">Confluence</div>
        <div className="text-xs text-[var(--text-muted)]">edge over the market</div>
      </div>
      <nav className="flex flex-1 flex-col gap-1">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-md px-3 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--page-plane)] hover:text-[var(--text-primary)]"
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <ThemeToggle />
    </aside>
  );
}
