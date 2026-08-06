// Press-and-hold control for grown-up decisions. The hold (2s, matching the
// parent gate in the episode app) is the child lock: out of a small child's
// patience, never their way in. Releasing early resets; there is no tap path.

import { useEffect, useRef, useState } from "react";

const HOLD_MS = 2000;
const TICK_MS = 50;

interface HoldButtonProps {
  label: string;
  onHeld: () => void;
  className?: string;
}

export function HoldButton({ label, onHeld, className }: HoldButtonProps) {
  const [progress, setProgress] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = (): void => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
    setProgress(0);
  };

  const start = (): void => {
    if (timer.current !== null) return;
    const t0 = performance.now();
    timer.current = setInterval(() => {
      const p = (performance.now() - t0) / HOLD_MS;
      if (p >= 1) {
        stop();
        onHeld();
      } else {
        setProgress(p);
      }
    }, TICK_MS);
  };

  useEffect(() => stop, []);

  return (
    <button
      type="button"
      className={`hold-button${className !== undefined ? ` ${className}` : ""}`}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
    >
      <span className="hold-button-fill" style={{ width: `${Math.round(progress * 100)}%` }} aria-hidden="true" />
      <span className="hold-button-label">{label}</span>
    </button>
  );
}
