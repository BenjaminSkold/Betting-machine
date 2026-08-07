"use client";

import { useEffect, useRef } from "react";
import { animate, useMotionValue, useMotionValueEvent } from "motion/react";
import { useState } from "react";

// Counts up/down to `value` rather than snapping -- the Dexscreener/Stripe
// "numbers are alive" feeling. `format` renders the animating number (so
// callers can add "%", "$", commas, sign, etc.); the animation only ever
// runs from the previous rendered value to the new one, so a value that
// hasn't changed doesn't replay on unrelated re-renders.
export default function AnimatedNumber({
  value,
  format = (n) => n.toFixed(0),
  durationSec = 0.6,
}: {
  value: number;
  format?: (n: number) => string;
  durationSec?: number;
}) {
  const motionValue = useMotionValue(value);
  const [display, setDisplay] = useState(() => format(value));
  const prevValue = useRef(value);

  useMotionValueEvent(motionValue, "change", (latest) => setDisplay(format(latest)));

  useEffect(() => {
    // prefers-reduced-motion: jump straight to the value, no animation.
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      motionValue.set(value);
      prevValue.current = value;
      return;
    }
    const controls = animate(prevValue.current, value, {
      duration: durationSec,
      ease: [0.16, 1, 0.3, 1], // "ease-out-expo"-ish -- decelerates hard, matches TradingView/Stripe tickers
      onUpdate: (v) => motionValue.set(v),
    });
    prevValue.current = value;
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return <span className="tabular">{display}</span>;
}
