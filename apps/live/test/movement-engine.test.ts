/**
 * Movement, as it actually reaches an activity: through `FrameReducer`.
 *
 * The detector being correct is one thing (movement.test.ts); a child being
 * able to REACH it is another, and it is the one that has broken before. What
 * this file pins down:
 *
 *   - every processed frame feeds the detector, so nobody has to remember to;
 *   - the flags on the frame are the PRIMARY person's, so a sibling bouncing
 *     past cannot make Chiku celebrate a jump the child did not do;
 *   - the field is booleans, so an activity stays one pure predicate over one
 *     frame and can be tested from a literal;
 *   - and `reset()` really clears it, because a movement latched in the last
 *     round must not fire a celebration at the start of the next one.
 *
 * No MediaPipe, no camera: hand-built faces and wrists, exactly like the rest
 * of the vision tests.
 */

import { describe, expect, it } from "vitest";

import { FrameReducer, type FaceCandidate, type HandCandidate } from "../src/vision/engine";
import { MOVEMENT } from "../src/vision/movement";
import {
  CHIN,
  EYE_OUTER_HIGH_X,
  EYE_OUTER_LOW_X,
  FOREHEAD,
  NEUTRAL_NOSE_V,
  NOSE_TIP,
  faceBounds,
} from "../src/vision/gaze";
import type { Landmark } from "../src/vision/fingers";
import type { VisionFrame } from "../src/vision/types";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const MESH_POINTS = 478;
const FACE_W = 0.16;
const FACE_H = 0.22;

function buildFace(cx: number, cy: number, scale = 1): Landmark[] {
  const w = FACE_W * scale;
  const h = FACE_H * scale;
  const mesh: Landmark[] = [];
  for (let i = 0; i < MESH_POINTS; i += 1) mesh.push({ x: cx, y: cy, z: 0 });
  mesh[EYE_OUTER_LOW_X] = { x: cx - w / 2, y: cy, z: 0 };
  mesh[EYE_OUTER_HIGH_X] = { x: cx + w / 2, y: cy, z: 0 };
  mesh[FOREHEAD] = { x: cx, y: cy - h / 2, z: 0 };
  mesh[CHIN] = { x: cx, y: cy + h / 2, z: 0 };
  mesh[NOSE_TIP] = { x: cx, y: cy - h / 2 + NEUTRAL_NOSE_V * h, z: 0 };
  return mesh;
}

function faceAt(cx: number, cy: number, scale = 1): FaceCandidate {
  const landmarks = buildFace(cx, cy, scale);
  const bounds = faceBounds(landmarks);
  if (bounds === null) throw new Error("fixture face has no bounds");
  return { centre: bounds.centre, size: bounds.size, landmarks, blendshapes: undefined };
}

function handAt(x: number, y: number): HandCandidate {
  return {
    centre: { x, y },
    size: 0.15,
    open: false,
    signal: {
      handedness: "Right",
      fingers: null,
      extended: [false, false, false, false, false],
      gesture: null,
      wrist: { x, y },
    },
  };
}

const FRAME_MS = 100;
/** Where the child sits. Their face box is well inside the frame at this size. */
const CHILD_X = 0.4;
const CHILD_Y = 0.45;

interface Beat {
  readonly faces: readonly FaceCandidate[];
  readonly hands: readonly HandCandidate[];
}

function run(reducer: FrameReducer, beats: readonly Beat[], startAt = 0): VisionFrame {
  let last: VisionFrame | null = null;
  let t = startAt;
  for (const beat of beats) {
    last = reducer.reduce(t, beat.faces, beat.hands);
    t += FRAME_MS;
  }
  if (last === null) throw new Error("no frames were reduced");
  return last;
}

/** Standing still, `n` frames of it, optionally with hands in view. */
function standing(n: number, y = CHILD_Y, hands: readonly HandCandidate[] = []): Beat[] {
  return Array.from({ length: n }, () => ({ faces: [faceAt(CHILD_X, y)], hands }));
}

/** The hop height a 2-year-old actually manages. */
const HOP_Y = CHILD_Y - (MOVEMENT.jumpRise + 0.01);

/* -------------------------------------------------------------------------- */

describe("engine: movement reaches the frame", () => {
  it("says nothing at all until it has seen enough frames to judge", () => {
    const reducer = new FrameReducer();
    const first = reducer.reduce(0, [faceAt(CHILD_X, CHILD_Y)], []);
    // Undefined is "no evidence yet", not "they did not move". There is no
    // failure state here and a frame that pretended to know would be inventing
    // one.
    expect(first.movement).toBeUndefined();

    const later = run(reducer, standing(6), FRAME_MS);
    expect(later.movement).toBeDefined();
  });

  it("carries a toddler hop through to the frame as a boolean", () => {
    const reducer = new FrameReducer();
    const frame = run(reducer, [
      ...standing(4),
      ...standing(1, HOP_Y),
      ...standing(2),
    ]);

    expect(frame.movement?.jump).toBe(true);
    expect(frame.movement?.any).toBe(true);
    // Booleans, not a detector: an activity gets a value it can compare, and
    // cannot accidentally keep rolling state alive past the end of a round.
    expect(typeof frame.movement?.jump).toBe("boolean");
  });

  it("reports every kind, all false, when the child is simply standing there", () => {
    const reducer = new FrameReducer();
    const frame = run(reducer, standing(8));

    expect(frame.movement).toEqual({
      jump: false,
      crouch: false,
      sway: false,
      stomp: false,
      reach: false,
      clap: false,
      swing: false,
      any: false,
    });
  });

  it("reads the raw face position, not the smoothed gaze point", () => {
    // The gaze smoother's job is to REFUSE sudden jumps. A hop is a sudden
    // jump. If movement were fed the smoothed point the signal would be
    // filtered out by the very thing that makes the eyes look calm.
    const reducer = new FrameReducer();
    const frame = run(reducer, [...standing(4), ...standing(1, HOP_Y), ...standing(2)]);
    expect(frame.movement?.jump).toBe(true);
  });
});

describe("engine: movement belongs to the primary person", () => {
  it("ignores a sibling hopping past the camera", () => {
    const reducer = new FrameReducer();
    // The child is closest to the lens, so the lock takes them on frame one and
    // keeps them.
    const child = (y: number): FaceCandidate => faceAt(CHILD_X, y, 1.4);
    const sibling = (y: number): FaceCandidate => faceAt(0.85, y, 0.8);

    const frame = run(reducer, [
      { faces: [child(CHILD_Y), sibling(0.5)], hands: [] },
      { faces: [child(CHILD_Y), sibling(0.5)], hands: [] },
      { faces: [child(CHILD_Y), sibling(0.5)], hands: [] },
      { faces: [child(CHILD_Y), sibling(0.5)], hands: [] },
      // The sibling hops. The child does not move.
      { faces: [child(CHILD_Y), sibling(0.5 - 0.09)], hands: [] },
      { faces: [child(CHILD_Y), sibling(0.5)], hands: [] },
      { faces: [child(CHILD_Y), sibling(0.5)], hands: [] },
    ]);

    expect(frame.movement?.jump).toBe(false);
    expect(frame.movement?.any).toBe(false);
  });

  it("still sees the child's own hop with a sibling in frame", () => {
    const reducer = new FrameReducer();
    const child = (y: number): FaceCandidate => faceAt(CHILD_X, y, 1.4);
    const sibling = faceAt(0.85, 0.5, 0.8);

    const frame = run(reducer, [
      { faces: [child(CHILD_Y), sibling], hands: [] },
      { faces: [child(CHILD_Y), sibling], hands: [] },
      { faces: [child(CHILD_Y), sibling], hands: [] },
      { faces: [child(CHILD_Y), sibling], hands: [] },
      { faces: [child(HOP_Y), sibling], hands: [] },
      { faces: [child(CHILD_Y), sibling], hands: [] },
      { faces: [child(CHILD_Y), sibling], hands: [] },
    ]);

    expect(frame.movement?.jump).toBe(true);
  });

  it("does not let a parent's hands clap on the child's behalf", () => {
    const reducer = new FrameReducer();
    const child = faceAt(CHILD_X, CHILD_Y, 1.4);
    const parent = faceAt(0.9, 0.45, 1.2);
    // Two hands, touching, right next to the PARENT and far outside the
    // child's reach.
    const parentHands = [handAt(0.88, 0.5), handAt(0.92, 0.5)];

    const frame = run(reducer, [
      { faces: [child, parent], hands: parentHands },
      { faces: [child, parent], hands: parentHands },
      { faces: [child, parent], hands: parentHands },
      { faces: [child, parent], hands: parentHands },
      { faces: [child, parent], hands: parentHands },
    ]);

    expect(frame.movement?.clap).toBe(false);
  });

  it("counts the child's own two wrists coming together", () => {
    const reducer = new FrameReducer();
    const child = faceAt(CHILD_X, CHILD_Y, 1.4);
    const apart = MOVEMENT.clapDistance / 3;
    const own = [handAt(CHILD_X - apart / 2, 0.6), handAt(CHILD_X + apart / 2, 0.6)];

    const frame = run(reducer, [
      { faces: [child], hands: own },
      { faces: [child], hands: own },
      { faces: [child], hands: own },
      { faces: [child], hands: own },
      { faces: [child], hands: own },
    ]);

    expect(frame.movement?.clap).toBe(true);
    expect(frame.movement?.any).toBe(true);
  });
});

describe("engine: movement across rounds", () => {
  it("reset() clears the latch, so a new round starts with nothing owed", () => {
    const reducer = new FrameReducer();
    const before = run(reducer, [...standing(4), ...standing(1, HOP_Y), ...standing(2)]);
    expect(before.movement?.jump).toBe(true);

    reducer.reset();

    // Immediately after, with the hop still well inside the detector's window:
    // without the reset this would still read as a jump. A jump latched a
    // moment ago must not fire a celebration the instant the next activity
    // opens — the child would be congratulated for a different game.
    const after = run(reducer, standing(6), before.t + FRAME_MS);
    expect(after.movement?.jump).toBe(false);
    expect(after.movement?.any).toBe(false);
  });

  it("keeps the flag up long enough for a slow surface to react to it", () => {
    // At the 4-6fps this engine degrades to on a mid-range Android, the very
    // next frame can be 250ms after the landing. The latch is what stops the
    // celebration being cut off before it starts.
    const reducer = new FrameReducer();
    let frame = run(reducer, [...standing(4), ...standing(1, HOP_Y), ...standing(2)]);
    expect(frame.movement?.jump).toBe(true);

    frame = reducer.reduce(frame.t + 250, [faceAt(CHILD_X, CHILD_Y)], []);
    expect(frame.movement?.jump).toBe(true);
  });

  it("survives a frame where the tracker lost the child", () => {
    const reducer = new FrameReducer();
    const frame = run(reducer, [
      ...standing(4),
      { faces: [], hands: [] },
      ...standing(1, HOP_Y),
      ...standing(2),
    ]);

    expect(frame.movement?.jump).toBe(true);
  });
});
