"use client";

import { motion, type Transition } from "motion/react";
import type { ReactNode } from "react";

// Content animates in rather than popping into existence (cards, chart
// containers, table rows). `index` staggers a list's entrance without
// each item needing its own delay math. Respects prefers-reduced-motion
// automatically -- `motion` reduces to opacity-only when the OS setting
// is on (transform is skipped by the library itself).
const EASE: Transition["ease"] = [0.16, 1, 0.3, 1];

export default function FadeIn({
  children,
  index = 0,
  className,
  y = 8,
}: {
  children: ReactNode;
  index?: number;
  className?: string;
  y?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: Math.min(index * 0.04, 0.4), ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
