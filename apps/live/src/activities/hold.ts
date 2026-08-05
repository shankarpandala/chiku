// Debounce, extracted because it is the single most important piece of "feels
// right" in the whole surface and deserves to be readable and testable.
//
// Two knobs, both tuned for a 3-year-old rather than for a demo:
//   holdMs  — the condition must be true for this long before it counts, so a
//             hand passing through "3" on its way to "5" never fires.
//   SLACK   — but the condition is allowed to blink out for this long without
//             restarting the clock, because trackers drop a frame constantly
//             and restarting would make a steady hand feel unrewarded.

/** How long `matches` may go false mid-hold before the hold resets. */
export const HOLD_SLACK_MS = 200;

export class HoldTracker {
  private startedAt: number | null = null;
  private lastMatchAt = 0;

  /** Feed one frame's verdict; returns true exactly once, when the hold completes. */
  update(matched: boolean, t: number, holdMs: number): boolean {
    if (matched) {
      if (this.startedAt === null) this.startedAt = t;
      this.lastMatchAt = t;
      if (t - this.startedAt >= holdMs) {
        this.reset();
        return true;
      }
      return false;
    }
    if (this.startedAt !== null && t - this.lastMatchAt > HOLD_SLACK_MS) this.reset();
    return false;
  }

  reset(): void {
    this.startedAt = null;
    this.lastMatchAt = 0;
  }

  /** 0..1 — how far into the hold we are, for the progress cue. */
  progress(t: number, holdMs: number): number {
    if (this.startedAt === null || holdMs <= 0) return 0;
    return Math.max(0, Math.min(1, (t - this.startedAt) / holdMs));
  }
}
