// Debounce, extracted because it is the single most important piece of "feels
// right" in the whole surface and deserves to be readable and testable.
//
// Two knobs, both tuned for a 3-year-old rather than for a demo:
//   holdMs  — the condition must be true for this long before it counts, so a
//             hand passing through "3" on its way to "5" never fires.
//   SLACK   — but the condition is allowed to blink out without restarting the
//             clock, because trackers fail constantly and restarting would make
//             a steady hand feel unrewarded.
//
// WHY THE SLACK IS COUNTED IN FRAMES, NOT MILLISECONDS
// ----------------------------------------------------
// It used to be 200ms of wall clock. That reads as generous and is not: the
// vision engine deliberately throttles slow devices to a ~50% duty cycle, so a
// mid-range Android at 40-80ms inference lands at 160-240ms BETWEEN FRAMES. One
// failed detection therefore blew the entire budget and reset a 600ms hold — on
// exactly the device we target. A wall-clock tolerance silently becomes zero
// tolerance the moment the device gets slow, which is precisely when
// forgiveness is needed. The tracker fails in frames, so we forgive in frames.
// (Same reasoning as vision/stability.ts, ported from the reference's
// refuse-to-believe-the-tracker discipline.)
//
// THREE VERDICTS, NOT TWO
// -----------------------
// `countExtendedFingers` answers null when the hand is genuinely ambiguous, and
// `frame.face` is null when the face detector found nobody. Counting either as
// a mismatch means our own honesty about not knowing gets spent punishing the
// child. So a frame is one of:
//
//   match     the child is doing the thing
//   mismatch  the child is confidently doing something ELSE
//   unknown   we could not tell — no evidence either way
//
// and the two failing verdicts are forgiven differently, because they are
// different facts:
//
//   unknown  is a TRACKER failure. Forgiven in frames only (12 of them), with
//            no wall-clock limit at all — a slow device produces more of these
//            AND spaces them further apart, and a clock would punish both.
//   mismatch is EVIDENCE ABOUT THE CHILD. Forgiven for 6 frames, and never for
//            longer than the hold itself: you may lose the pose for less time
//            than you are being asked to hold it. On a fast device the frame
//            budget binds; on a slow one the ceiling does, which is right,
//            because a full second of confidently showing one finger is not a
//            dropped frame, it is a different answer.

/** One frame's answer to "is the child doing the thing?". */
export type HoldVerdict = "match" | "mismatch" | "unknown";

/** Consecutive MISMATCHING frames tolerated mid-hold. The primary unit. */
export const HOLD_SLACK_FRAMES = 6;

/**
 * Consecutive NO-EVIDENCE frames tolerated mid-hold. Double the mismatch
 * budget: the child did nothing wrong, and this is the failure mode that made
 * "show me three" feel like Chiku was ignoring them. Bounded rather than
 * infinite only so a hold cannot survive a child wandering off and coming back.
 */
export const HOLD_UNKNOWN_FRAMES = 12;

/**
 * Floor for the wall-clock ceiling on a MISMATCH stretch; the ceiling itself is
 * `max(holdMs, this)`. It never applies to `unknown` frames — see above.
 */
export const HOLD_SLACK_CEILING_MS = 500;

function normalize(verdict: HoldVerdict | boolean): HoldVerdict {
  if (verdict === true) return "match";
  if (verdict === false) return "mismatch";
  return verdict;
}

export class HoldTracker {
  private startedAt: number | null = null;
  private lastMatchAt = 0;
  /** Consecutive mismatching frames since the last match. */
  private misses = 0;
  /** Consecutive no-evidence frames since the last match. */
  private blanks = 0;
  /**
   * Extra frames of dropout forgiven on top of both budgets, handed down by
   * the assist ladder (see `activities/assist.ts`). Zero is the shipped
   * behaviour; a child who has needed help twice gets a wider net without ever
   * being told the net moved.
   *
   * Deliberately NOT cleared by `reset()`: reset happens between attempts
   * inside one prompt, and forgiveness the child has earned must survive that.
   * The runner clears it explicitly when a new prompt begins.
   */
  private extraSlack = 0;

  /** Widen both dropout budgets. Idempotent; call with 0 to go back to strict. */
  relax(extraFrames: number): void {
    this.extraSlack = Number.isFinite(extraFrames) ? Math.max(0, Math.floor(extraFrames)) : 0;
  }

  /**
   * Feed one frame's verdict; returns true exactly once, when the hold
   * completes. `true`/`false` are accepted as "match"/"mismatch" so a caller
   * holding a plain predicate does not have to translate.
   */
  update(verdict: HoldVerdict | boolean, t: number, holdMs: number): boolean {
    switch (normalize(verdict)) {
      case "match": {
        this.misses = 0;
        this.blanks = 0;
        if (this.startedAt === null) this.startedAt = t;
        this.lastMatchAt = t;
        if (t - this.startedAt >= holdMs) {
          this.reset();
          return true;
        }
        return false;
      }

      case "unknown": {
        // Neither advances nor resets: a hold cannot complete on a frame that
        // proves nothing, and it cannot die on one either.
        if (this.startedAt === null) return false;
        this.blanks += 1;
        if (this.blanks > HOLD_UNKNOWN_FRAMES + this.extraSlack) this.reset();
        return false;
      }

      case "mismatch": {
        if (this.startedAt === null) return false;
        this.misses += 1;
        const ceilingMs = Math.max(holdMs, HOLD_SLACK_CEILING_MS);
        if (this.misses > HOLD_SLACK_FRAMES + this.extraSlack || t - this.lastMatchAt > ceilingMs) {
          this.reset();
        }
        return false;
      }
    }
  }

  reset(): void {
    this.startedAt = null;
    this.lastMatchAt = 0;
    this.misses = 0;
    this.blanks = 0;
  }

  /** 0..1 — how far into the hold we are, for the progress cue. */
  progress(t: number, holdMs: number): number {
    if (this.startedAt === null || holdMs <= 0) return 0;
    return Math.max(0, Math.min(1, (t - this.startedAt) / holdMs));
  }
}
