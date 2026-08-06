// Press-and-hold control for grown-up decisions. The hold is the child lock:
// out of a small child's patience, never their way in. Releasing early resets;
// there is no tap path.
//
// THE DEFAULT IS NOT ALWAYS ENOUGH. 2s matches the parent gate in the episode
// app and is fine for opening a settings sheet, where the worst case is that a
// child reads some small grey text. It is NOT enough for a decision that
// changes where a child's voice goes: a determined six-year-old holds a button
// for two seconds on the first try. Callers guarding a consent decision pass a
// longer `holdMs` — see GROWNUP_CONSENT_HOLD_MS.

import { useEffect, useRef, useState } from "react";

/** Opening a grown-up sheet: enough to be deliberate, not enough to be a chore. */
export const GROWNUP_OPEN_HOLD_MS = 2000;
/** Changing where a child's voice goes. Long enough that a child gives up. */
export const GROWNUP_CONSENT_HOLD_MS = 5000;

const TICK_MS = 50;

interface HoldButtonProps {
  label: string;
  onHeld: () => void;
  className?: string;
  /** Defaults to GROWNUP_OPEN_HOLD_MS. */
  holdMs?: number;
}

export function HoldButton({
  label,
  onHeld,
  className,
  holdMs = GROWNUP_OPEN_HOLD_MS,
}: HoldButtonProps) {
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
      const p = (performance.now() - t0) / holdMs;
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
      data-hold-ms={holdMs}
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
