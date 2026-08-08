"use client";

import Link from "next/link";
import type { ComponentProps } from "react";

// A plain next/link can't take an onClick from a Server Component parent --
// event handlers can't cross the Server->Client Component prop boundary
// (confirmed live: "Event handlers cannot be passed to Client Component
// props"). This one-line Client Component is the boundary, so a Server
// Component page (e.g. the wallet detail page's per-match <summary>) can
// still stop a nested link's click from also toggling the parent <details>.
export default function StopPropagationLink(props: ComponentProps<typeof Link>) {
  return <Link {...props} onClick={(e) => e.stopPropagation()} />;
}
