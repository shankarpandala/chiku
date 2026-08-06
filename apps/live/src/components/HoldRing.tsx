// The hold cue — the 600 milliseconds in which nothing used to happen.
//
// `HoldTracker.progress()` has been documented "for the progress cue" since the
// day it was written and NOTHING HAS EVER CALLED IT. What that meant for a
// child: hold three fingers up, watch nothing change, and — on a slow device,
// where the hold quietly resets — eventually get nudged as though they had not
// tried at all. The child has no way to tell "Chiku is counting" from "Chiku is
// ignoring me", and a 3-year-old resolves that ambiguity by putting their hand
// down. This component is the missing second of feedback.
//
// Three rules shape it.
//
// 1. IT READS AS CHIKU COUNTING, NOT AS A LOADING SPINNER. The arc is anchored
//    at 12 o'clock and grows one way only. A spinner is a fixed-length arc
//    chasing its own tail; it means "wait, something else is happening". This
//    means "keep going, I am with you" — it is the child's own effort being
//    drawn back to them, so it may never run without them.
//
//    Marigold, because marigold is this app's ACTION colour. Teal is reserved
//    for "Chiku is attending to you" (§9) and already lives on this exact frame
//    as an outer glow. Two rings, two different facts, and they must not be
//    confusable: teal OUTSIDE the frame is "I can see you"; marigold INSIDE it
//    is "I am counting what you are doing right now".
//
// 2. IT HOLDS RATHER THAN SNAPS BACK. HoldTracker forgives dropouts in frames
//    (see hold.ts) precisely because trackers blink constantly on the devices we
//    target. If the cue did not forgive them too it would stutter to empty on
//    every blink and tell the child a discouraging lie that the tracker itself
//    never told. So: rises are instant — the child earned them, and a lagging
//    ring would feel unresponsive — while falls ease out over HOLD_RING_EASE_MS.
//    A blink dims the ring; it does not empty it.
//
// 3. REDUCED MOTION GETS THE FACT WITHOUT THE MOVEMENT. A static filled
//    proportion: no breath, no glow animation, and no easing loop at all. The
//    honest tradeoff is that a tracker blink then does snap the ring back — we
//    are not willing to run an rAF loop for someone who asked us not to animate,
//    and the proportion itself is still true every frame it is painted.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useReducedMotion } from "./useReducedMotion";

/**
 * How long a FULL ring takes to ease back down to nothing. Roughly the length
 * of the hold itself (600ms): slow enough to read as "held", fast enough that a
 * child who genuinely gave up is not looking at a stale ring.
 */
export const HOLD_RING_EASE_MS = 520;

export interface HoldRingProps {
  /**
   * 0..1, straight from `HoldTracker.progress(now, holdMs)`. Clamped here;
   * non-finite reads as 0, so a NaN clock can never paint a broken ring.
   */
  progress: number;
  /**
   * Accessible name, already translated — i18n key `hold.counting`. A static
   * name on a `role="img"`, deliberately NOT a `progressbar` with a live
   * valuenow: a number changing thirty times a second is noise in a screen
   * reader, and the ring is reassurance, not information a child must read.
   */
  label: string;
  /**
   * Override the media query. Pass the surface's own `reducedMotion` when it
   * has one so the rig and the cue can never disagree; omit to follow
   * `prefers-reduced-motion` directly.
   */
  reducedMotion?: boolean;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * A filling arc around the stage, driven by one 0..1 prop.
 *
 * Renders nothing at all while progress is 0 (and, in full motion, until the
 * ease-down finishes) — the live rig wears no chrome when nothing is happening.
 */
export function HoldRing({ progress, label, reducedMotion }: HoldRingProps) {
  const autoReduced = useReducedMotion();
  const reduced = reducedMotion ?? autoReduced;
  const target = clamp01(progress);

  // The eased value. It is only ever AHEAD of the target (mid-ease-down); a
  // rise is served straight from `target` at render time so the ring never lags
  // the child by a commit.
  const [eased, setEased] = useState(target);
  const easedRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const cancel = (): void => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    if (reduced) {
      cancel();
      easedRef.current = target;
      return cancel;
    }

    if (target >= easedRef.current) {
      // Rising (or level). Nothing to animate — `drawn` already reads `target`.
      cancel();
      easedRef.current = target;
      return cancel;
    }

    // Falling: walk the drawn value down instead of cutting it.
    cancel();
    let last = performance.now();
    const step = (now: number): void => {
      const dt = Math.max(0, now - last);
      last = now;
      const next = Math.max(target, easedRef.current - dt / HOLD_RING_EASE_MS);
      easedRef.current = next;
      setEased(next);
      rafRef.current = next > target ? requestAnimationFrame(step) : null;
    };
    rafRef.current = requestAnimationFrame(step);
    return cancel;
  }, [target, reduced]);

  const drawn = reduced ? target : Math.max(target, eased);
  if (drawn <= 0) return null;

  // The child's evidence stopped but the ring is still showing what they had.
  const holding = drawn > target + 0.001;
  const value = drawn.toFixed(3);
  // Custom property rather than a width/dasharray: the fill is a conic mask on
  // a border that inherits the stage's own corner radius, so the arc hugs the
  // frame exactly instead of approximating it.
  const style: CSSProperties & Record<string, string> = { "--hold-progress": value };

  return (
    <div
      className={`hold-ring${holding ? " is-holding" : ""}${reduced ? " is-static" : ""}`}
      style={style}
      data-hold-progress={value}
      role="img"
      aria-label={label}
    >
      <span className="hold-ring-track" />
      <span className="hold-ring-fill" />
    </div>
  );
}
