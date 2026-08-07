"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { Sun, Moon, MonitorSmartphone } from "lucide-react";

type Theme = "light" | "dark" | "system";

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

// localStorage is external mutable state — useSyncExternalStore is React's
// sanctioned way to read it without the "setState inside an effect on
// mount" anti-pattern, and it handles the server/client snapshot mismatch
// (no theme known until hydration) correctly by design.
function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}
function getSnapshot(): Theme {
  return (localStorage.getItem("theme") as Theme) || "system";
}
function getServerSnapshot(): Theme {
  return "system";
}

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Dev-only fix (no-op in production): React Strict Mode remounts once and
  // resets <html> to only the attributes JSX manages, clearing the
  // data-theme the root layout's inline script set before hydration. Without
  // this, the toggle's own label still shows the right stored theme (it
  // reads localStorage directly) while the actually-applied CSS theme
  // silently desyncs back to the default. See Next's
  // preventing-flash-before-hydration.md — "Re-applying attributes in
  // development."
  useLayoutEffect(() => {
    apply(getSnapshot());
  }, []);

  function cycle() {
    const next: Theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    apply(next);
    localStorage.setItem("theme", next);
    // storage event only fires for OTHER tabs — dispatch locally too so
    // this tab's own snapshot updates immediately.
    window.dispatchEvent(new StorageEvent("storage"));
  }

  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : MonitorSmartphone;
  const label = theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System";

  return (
    <button
      onClick={cycle}
      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--page-plane)] hover:text-[var(--text-primary)]"
      title="Cycle theme"
    >
      <Icon size={16} strokeWidth={2} aria-hidden className="opacity-70" />
      {label}
    </button>
  );
}
