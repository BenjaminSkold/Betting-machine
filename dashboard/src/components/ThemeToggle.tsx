"use client";

import { useSyncExternalStore } from "react";

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

  function cycle() {
    const next: Theme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    apply(next);
    localStorage.setItem("theme", next);
    // storage event only fires for OTHER tabs — dispatch locally too so
    // this tab's own snapshot updates immediately.
    window.dispatchEvent(new StorageEvent("storage"));
  }

  const icon = theme === "light" ? "☀" : theme === "dark" ? "☾" : "◐";
  const label = theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System";

  return (
    <button
      onClick={cycle}
      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--page-plane)] hover:text-[var(--text-primary)]"
      title="Cycle theme"
    >
      <span aria-hidden>{icon}</span>
      {label}
    </button>
  );
}
