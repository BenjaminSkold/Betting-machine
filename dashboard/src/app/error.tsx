"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";

export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="max-w-lg rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6">
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">Something went wrong</h2>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">
        {error.message || "An unexpected error occurred loading this page."}
      </p>
      <button
        onClick={() => retry()}
        className="mt-4 rounded-md px-4 py-1.5 text-sm font-medium"
        style={{ background: "var(--diverging-pos)", color: "white" }}
      >
        Try again
      </button>
    </div>
  );
}
