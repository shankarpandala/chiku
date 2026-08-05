// D-pad focus navigation for the 10-foot stage (M3). TV browsers deliver
// remote presses as plain arrow keys — this hook is the entire nav story:
// arrows move DOM focus geometrically among visible [data-focusable]
// elements (nearest bounding-rect center in the pressed direction, with a
// penalty for drifting off-axis so rows/columns feel like a grid), and
// Enter activates the focused element. The focus affordance itself is the
// design's 6px marigold outline + scale, styled globally — never colour alone.

import { useEffect } from "react";

interface Dir {
  x: number;
  y: number;
}

const DIRS: Record<string, Dir> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

function center(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** display:none (and detached) elements have empty rects — skip them. */
function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Nearest candidate whose center actually lies in `dir` from `from`. */
function nearestInDirection(from: HTMLElement, all: readonly HTMLElement[], dir: Dir): HTMLElement | null {
  const origin = center(from);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === from) continue;
    const c = center(el);
    const dx = c.x - origin.x;
    const dy = c.y - origin.y;
    const forward = dx * dir.x + dy * dir.y; // progress along the pressed axis
    if (forward <= 0) continue; // must genuinely move that way
    const sideways = Math.abs(dx * dir.y) + Math.abs(dy * dir.x); // off-axis drift
    const score = forward + sideways * 2; // prefer staying in the row/column
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

export function useDpadNav(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Never steal arrows/Enter from text entry (the DEV type-to-answer strip).
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }

      const focusables = [...document.querySelectorAll<HTMLElement>("[data-focusable]")].filter(isVisible);
      if (focusables.length === 0) return;

      const activeEl = document.activeElement;
      const active = activeEl instanceof HTMLElement && focusables.includes(activeEl) ? activeEl : null;

      if (e.key === "Enter") {
        if (active !== null) {
          e.preventDefault(); // suppress default activation so this is one click, not two
          active.click();
        }
        return;
      }

      const dir = DIRS[e.key];
      if (dir === undefined) return;
      e.preventDefault();

      if (active === null) {
        // First press lands somewhere sensible instead of being swallowed.
        focusables[0]?.focus();
        return;
      }
      nearestInDirection(active, focusables, dir)?.focus();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
