/**
 * Whole-body movement detection, for a 2-YEAR-OLD.
 *
 * Every assertion below is really a claim about a child, not about arithmetic:
 *
 *   - a toddler's hop barely leaves the floor, and it still has to count;
 *   - standing up out of a crouch is not a jump, however far the head travels,
 *     because it never comes back down;
 *   - a crouch is a crouch when it is HELD — leaning over to look at the carpet
 *     is not one;
 *   - a small child never stands still, so a sway has to need real direction
 *     changes or it fires constantly and stops meaning anything;
 *   - and every flag LATCHES, because at 4-6fps the movement is over before the
 *     next frame lands and a celebration that arrives after it must still fire.
 *
 * There is no MediaPipe here and no camera: every sample is hand-built, which
 * is the whole reason `movement.ts` takes samples rather than frames.
 *
 * Note there is no "should NOT have moved" failure anywhere in this file. The
 * negative cases are all about not claiming a movement the child did not make —
 * never about a movement not being good enough.
 */

import { describe, expect, it } from "vitest";

import {
  MOVEMENT,
  MOVEMENT_WINDOW_MS,
  MovementDetector,
  countReversals,
  type MovementKind,
  type MovementSample,
} from "../src/vision/movement";
import type { Point } from "../src/vision/stability";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** The frame rate the engine actually degrades to on a mid-range Android. */
const FRAME_MS = 100;

interface Body {
  /** Face centre, or null for a frame the tracker lost them on. */
  readonly face?: Point | null;
  readonly wrists?: readonly Point[];
}

/**
 * Feed a detector a series of bodies, one per frame, `FRAME_MS` apart.
 * Returns the timestamp of the last frame — the "now" everything is asked at.
 */
function play(
  detector: MovementDetector,
  bodies: readonly Body[],
  startAt = 0,
  stepMs = FRAME_MS,
): number {
  let t = startAt;
  for (const body of bodies) {
    const sample: MovementSample = {
      t,
      face: body.face === undefined ? { x: 0.5, y: 0.5 } : body.face,
      wrists: body.wrists ?? [],
    };
    detector.push(sample);
    t += stepMs;
  }
  return t - stepMs;
}

/** Standing still at (0.5, y), `n` frames of it. */
function still(n: number, y = 0.5, x = 0.5): Body[] {
  return Array.from({ length: n }, () => ({ face: { x, y } }));
}

/** A vertical path: one frame per y. */
function heights(ys: readonly number[], x = 0.5): Body[] {
  return ys.map((y) => ({ face: { x, y } }));
}

/** A horizontal path: one frame per x. */
function positions(xs: readonly number[], y = 0.5): Body[] {
  return xs.map((x) => ({ face: { x, y } }));
}

const ALL_KINDS: readonly MovementKind[] = [
  "jump",
  "crouch",
  "sway",
  "stomp",
  "reach",
  "clap",
  "swing",
];

/* -------------------------------------------------------------------------- */
/* Jump                                                                       */
/* -------------------------------------------------------------------------- */

describe("movement: jump", () => {
  it("counts a toddler-sized hop — barely off the floor, and up again", () => {
    const detector = new MovementDetector();
    // A hop of 4.5% of frame height. That is a two-year-old's whole jump: both
    // feet leave the ground by almost nothing. If this does not register, the
    // child moved their entire body and the screen said nothing.
    const hop = 0.5 - (MOVEMENT.jumpRise + 0.01);
    const now = play(detector, [...still(3), ...heights([hop]), ...still(2)]);

    expect(detector.saw("jump", now)).toBe(true);
  });

  it("does not call standing up slowly a jump — it never comes back down", () => {
    const detector = new MovementDetector();
    // Head travels FURTHER than the hop above, over a second and a half, and
    // then stays up there. A rise with no return is a child getting to their
    // feet, and telling them that was a jump teaches them the word wrong.
    const rise: number[] = [];
    for (let y = 0.5; y >= 0.38; y -= 0.01) rise.push(y);
    const now = play(detector, [...still(2), ...heights(rise), ...still(8, 0.38)]);

    expect(detector.saw("jump", now)).toBe(false);
  });

  it("forgets a hop that happened too long ago to still be one", () => {
    const detector = new MovementDetector();
    const hop = 0.5 - (MOVEMENT.jumpRise + 0.01);
    const now = play(detector, [...still(3), ...heights([hop]), ...still(2)]);
    expect(detector.saw("jump", now)).toBe(true);

    // Keep standing there for four seconds. The hop stops satisfying
    // jumpReturnMs, so it stops re-latching, and then the latch itself expires.
    const later = play(detector, still(40), now + FRAME_MS);
    expect(detector.saw("jump", later)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Crouch                                                                     */
/* -------------------------------------------------------------------------- */

describe("movement: crouch", () => {
  const low = 0.5 + MOVEMENT.crouchDrop + 0.02;
  /** Frames that add up to longer than crouchHoldMs. */
  const heldFrames = Math.ceil(MOVEMENT.crouchHoldMs / FRAME_MS) + 2;

  it("counts a crouch that is held down there", () => {
    const detector = new MovementDetector();
    const now = play(detector, [...still(8), ...still(heldFrames, low)]);

    expect(detector.saw("crouch", now)).toBe(true);
  });

  it("does not call a quick bend a crouch", () => {
    const detector = new MovementDetector();
    // Same depth, down and back up inside the hold window: a child ducking to
    // look at something on the floor, which is not them copying Chiku.
    const now = play(detector, [...still(8), ...still(2, low), ...still(2)]);

    expect(detector.saw("crouch", now)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Sway                                                                       */
/* -------------------------------------------------------------------------- */

describe("movement: sway", () => {
  it("needs real direction changes", () => {
    const detector = new MovementDetector();
    const travel = MOVEMENT.swayTravel + 0.03;
    const now = play(
      detector,
      positions([0.5, 0.5 - travel, 0.5 + travel, 0.5 - travel]),
    );

    expect(detector.saw("sway", now)).toBe(true);
  });

  it("ignores the wobble a small child never stops doing", () => {
    const detector = new MovementDetector();
    // Amplitude an order below swayTravel, reversing every single frame. A
    // 2-year-old standing "still" looks exactly like this, and if it read as a
    // sway then every reaction would be uncaused — which is the same, to them,
    // as no reaction at all.
    const jitter: number[] = [];
    for (let i = 0; i < 20; i += 1) jitter.push(0.5 + (i % 2 === 0 ? 0.005 : -0.005));
    const now = play(detector, positions(jitter));

    expect(detector.saw("sway", now)).toBe(false);
  });

  it("ignores one big step sideways — going somewhere is not swaying", () => {
    const detector = new MovementDetector();
    const now = play(detector, positions([0.5, 0.5, 0.75, 0.75, 0.75]));

    expect(detector.saw("sway", now)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Hands                                                                      */
/* -------------------------------------------------------------------------- */

describe("movement: hands", () => {
  it("counts a clap when the wrists come together", () => {
    const detector = new MovementDetector();
    const apart = MOVEMENT.clapDistance / 3;
    const now = play(detector, [
      ...still(3),
      { face: { x: 0.5, y: 0.5 }, wrists: [{ x: 0.5 - apart / 2, y: 0.7 }, { x: 0.5 + apart / 2, y: 0.7 }] },
    ]);

    expect(detector.saw("clap", now)).toBe(true);
  });

  it("does not call hands at their sides a clap", () => {
    const detector = new MovementDetector();
    const now = play(detector, [
      ...still(3),
      { face: { x: 0.5, y: 0.5 }, wrists: [{ x: 0.2, y: 0.8 }, { x: 0.8, y: 0.8 }] },
    ]);

    expect(detector.saw("clap", now)).toBe(false);
  });

  it("counts a hand held above the head as a reach", () => {
    const detector = new MovementDetector();
    const now = play(detector, [
      ...still(3),
      { face: { x: 0.5, y: 0.5 }, wrists: [{ x: 0.45, y: 0.5 - MOVEMENT.reachAbove - 0.05 }] },
    ]);

    expect(detector.saw("reach", now)).toBe(true);
  });

  it("counts an arm swinging back and forth as a trunk swing", () => {
    const detector = new MovementDetector();
    const travel = MOVEMENT.swingTravel + 0.04;
    const xs = [0.5, 0.5 - travel, 0.5 + travel, 0.5 - travel];
    const now = play(
      detector,
      xs.map((x) => ({ face: { x: 0.5, y: 0.5 }, wrists: [{ x, y: 0.6 }] })),
    );

    expect(detector.saw("swing", now)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The latch                                                                  */
/* -------------------------------------------------------------------------- */

describe("movement: the latch", () => {
  it("holds a movement true for ~1.2s after it ends", () => {
    const detector = new MovementDetector();
    const hop = 0.5 - (MOVEMENT.jumpRise + 0.01);
    const now = play(detector, [...still(3), ...heights([hop]), ...still(2)]);
    expect(detector.saw("jump", now)).toBe(true);

    // The child has landed and is standing there waiting. A celebration that
    // took half a second to start must still find the flag true, or Chiku
    // reacts to nothing and the child never links the two.
    expect(detector.saw("jump", now + 500)).toBe(true);
    expect(detector.saw("jump", now + 1100)).toBe(true);
    // …and eventually it lets go, so the next round starts clean.
    expect(detector.saw("jump", now + 1400)).toBe(false);
  });

  it("respects a shorter latch when one is asked for", () => {
    const detector = new MovementDetector(300);
    const hop = 0.5 - (MOVEMENT.jumpRise + 0.01);
    const now = play(detector, [...still(3), ...heights([hop]), ...still(2)]);

    expect(detector.saw("jump", now + 200)).toBe(true);
    expect(detector.saw("jump", now + 400)).toBe(false);
  });

  it("sawAnything is true whenever any single movement is", () => {
    const detector = new MovementDetector();
    const before = new MovementDetector();
    expect(before.sawAnything(0)).toBe(false);

    const hop = 0.5 - (MOVEMENT.jumpRise + 0.01);
    const now = play(detector, [...still(3), ...heights([hop]), ...still(2)]);
    expect(detector.sawAnything(now)).toBe(true);
    expect(detector.sawAnything(now + 1400)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Housekeeping                                                               */
/* -------------------------------------------------------------------------- */

describe("movement: history and reset", () => {
  it("is not ready to judge before it has seen a few frames", () => {
    const detector = new MovementDetector();
    expect(detector.ready).toBe(false);
    play(detector, still(2));
    expect(detector.ready).toBe(false);
    play(detector, still(2), 300);
    expect(detector.ready).toBe(true);
  });

  it("reset() clears every latch and all the history", () => {
    const detector = new MovementDetector();
    const hop = 0.5 - (MOVEMENT.jumpRise + 0.01);
    const now = play(detector, [...still(3), ...heights([hop]), ...still(2)]);
    expect(detector.saw("jump", now)).toBe(true);
    expect(detector.ready).toBe(true);

    detector.reset();

    expect(detector.ready).toBe(false);
    expect(detector.sawAnything(now)).toBe(false);
    for (const kind of ALL_KINDS) expect(detector.saw(kind, now)).toBe(false);
  });

  it("drops samples older than the window instead of growing forever", () => {
    const detector = new MovementDetector();
    // Twelve seconds at 10fps. Nothing here should retain 120 samples.
    const now = play(detector, still(120));
    expect(detector.ready).toBe(true);

    // A crouch judged now must be judged against a baseline drawn from the
    // recent past, not from two minutes ago.
    const low = 0.5 + MOVEMENT.crouchDrop + 0.02;
    const after = play(detector, still(8, low), now + FRAME_MS);
    // Still standing history dominates the window, so this reads as a crouch…
    expect(detector.saw("crouch", after)).toBe(true);

    // …but stay down there past MOVEMENT_WINDOW_MS and the low position simply
    // becomes the new baseline. He is not "still crouching", he is standing.
    const settled = play(
      detector,
      still(Math.ceil(MOVEMENT_WINDOW_MS / FRAME_MS) + 4, low),
      after + FRAME_MS,
    );
    expect(detector.saw("crouch", settled)).toBe(false);
  });

  it("survives frames where the tracker lost the child entirely", () => {
    const detector = new MovementDetector();
    const hop = 0.5 - (MOVEMENT.jumpRise + 0.01);
    const now = play(detector, [
      ...still(3),
      { face: null },
      ...heights([hop]),
      { face: null },
      ...still(2),
    ]);

    expect(detector.saw("jump", now)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* countReversals                                                             */
/* -------------------------------------------------------------------------- */

describe("countReversals", () => {
  it("counts direction changes and ignores travel below the threshold", () => {
    expect(countReversals([], 0.05)).toBe(0);
    expect(countReversals([0.5], 0.05)).toBe(0);
    expect(countReversals([0.5, 0.51, 0.49, 0.5], 0.05)).toBe(0);
    expect(countReversals([0.5, 0.3, 0.7], 0.05)).toBe(1);
    expect(countReversals([0.5, 0.3, 0.7, 0.3], 0.05)).toBe(2);
    // Monotonic travel is not a reversal however far it goes.
    expect(countReversals([0.1, 0.3, 0.5, 0.7, 0.9], 0.05)).toBe(0);
  });
});
