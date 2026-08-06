/**
 * The forgiveness layer, end to end — minus MediaPipe.
 *
 * Everything under test here is pure arithmetic over hand-built fixtures: face
 * meshes are constructed so their bounding box and centre are known exactly,
 * and hands are supplied as candidates rather than 21-point landmark sets,
 * because the reducer never looks at hand landmarks. No model is loaded, so
 * these run in milliseconds and cannot be flaky.
 *
 * What is NOT covered: the MediaPipe adapter inside `#infer` (it needs a real
 * `FaceLandmarker`), and the actual per-frame cost of raising `numFaces`.
 */

import { describe, expect, it } from "vitest";

import {
  FrameReducer,
  HAND_REACH_FACES,
  MAX_FACES,
  MAX_HANDS,
  PrimaryPersonLock,
  type FaceCandidate,
  type HandCandidate,
} from "../src/vision/engine";
import {
  CHIN,
  EYE_OUTER_HIGH_X,
  EYE_OUTER_LOW_X,
  FOREHEAD,
  NEUTRAL_NOSE_V,
  NOSE_TIP,
  faceBounds,
  faceCentre,
  faceToGaze,
} from "../src/vision/gaze";
import { DEFAULT_LOST_FRAMES, PRESENCE_DECAY, PRESENCE_RISE, StablePoint } from "../src/vision/stability";
import { WaveDetector, WaveTracker } from "../src/vision/wave";
import type { Landmark } from "../src/vision/fingers";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const MESH_POINTS = 478;

/** Nominal face box for a child sitting at a laptop, in normalized units. */
const FACE_W = 0.16;
const FACE_H = 0.22;

/**
 * A mesh whose bounding box is exactly `scale * (FACE_W x FACE_H)` centred on
 * (cx, cy): every point sits at the centre except the four that define the box,
 * which are also the four `faceCentre` reads. So bbox centre === gaze centre,
 * and `size` === the box diagonal.
 */
function buildFace(cx: number, cy: number, scale = 1): Landmark[] {
  const w = FACE_W * scale;
  const h = FACE_H * scale;
  const mesh: Landmark[] = [];
  for (let i = 0; i < MESH_POINTS; i += 1) mesh.push({ x: cx, y: cy, z: 0 });
  mesh[EYE_OUTER_LOW_X] = { x: cx - w / 2, y: cy, z: 0 };
  mesh[EYE_OUTER_HIGH_X] = { x: cx + w / 2, y: cy, z: 0 };
  mesh[FOREHEAD] = { x: cx, y: cy - h / 2, z: 0 };
  mesh[CHIN] = { x: cx, y: cy + h / 2, z: 0 };
  // Nose dead centre horizontally and at the neutral height: a face looking
  // straight down the lens, so `attention` stays out of the way.
  mesh[NOSE_TIP] = { x: cx, y: cy - h / 2 + NEUTRAL_NOSE_V * h, z: 0 };
  return mesh;
}

function faceAt(cx: number, cy: number, scale = 1): FaceCandidate {
  const landmarks = buildFace(cx, cy, scale);
  const bounds = faceBounds(landmarks);
  if (bounds === null) throw new Error("fixture face has no bounds");
  return { centre: bounds.centre, size: bounds.size, landmarks, blendshapes: undefined };
}

interface HandOpts {
  readonly fingers?: number | null;
  readonly open?: boolean;
  readonly size?: number;
}

function handAt(x: number, y: number, opts: HandOpts = {}): HandCandidate {
  return {
    centre: { x, y },
    size: opts.size ?? 0.15,
    open: opts.open ?? false,
    signal: {
      handedness: "Right",
      fingers: opts.fingers ?? null,
      extended: [false, false, false, false, false],
      gesture: null,
      wrist: { x, y },
    },
  };
}

/** Where everyone sits in the scenarios below. */
const CHILD = { x: 0.35, y: 0.35 };
const OTHER = { x: 0.85, y: 0.35 };

/* -------------------------------------------------------------------------- */
/* Face geometry                                                              */
/* -------------------------------------------------------------------------- */

describe("face geometry", () => {
  it("reports the box centre and diagonal", () => {
    const bounds = faceBounds(buildFace(0.4, 0.6));
    expect(bounds?.centre.x).toBeCloseTo(0.4, 6);
    expect(bounds?.centre.y).toBeCloseTo(0.6, 6);
    expect(bounds?.size).toBeCloseTo(Math.hypot(FACE_W, FACE_H), 6);
  });

  it("refuses a mesh too short to gaze from", () => {
    expect(faceBounds([{ x: 0.1, y: 0.1 }])).toBeNull();
    expect(faceCentre([{ x: 0.1, y: 0.1 }])).toBeNull();
  });

  it("scales with distance from the camera", () => {
    const near = faceBounds(buildFace(0.5, 0.5, 2));
    const far = faceBounds(buildFace(0.5, 0.5, 0.5));
    expect((near?.size ?? 0) > (far?.size ?? 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Primary-person lock                                                        */
/* -------------------------------------------------------------------------- */

describe("primary-person lock", () => {
  it("has more than one face to choose between", () => {
    // The lock cannot refuse a stranger it was never shown.
    expect(MAX_FACES).toBeGreaterThan(1);
    // And the child's two hands must survive someone else's hand being in frame.
    expect(MAX_HANDS).toBeGreaterThan(2);
  });

  it("takes the biggest face when nothing is locked yet", () => {
    const lock = new PrimaryPersonLock<FaceCandidate, HandCandidate>();
    const small = faceAt(CHILD.x, CHILD.y, 0.6);
    const big = faceAt(OTHER.x, OTHER.y, 1.4);
    expect(lock.update([small, big], []).face).toBe(big);
  });

  it("does not change subject when a sibling walks in", () => {
    const lock = new PrimaryPersonLock<FaceCandidate, HandCandidate>();
    const child = faceAt(CHILD.x, CHILD.y);
    expect(lock.update([child], []).face).toBe(child);

    // The sibling is bigger (closer to the camera) and, half the time, first in
    // the result array. Neither may matter.
    for (let frame = 0; frame < 20; frame += 1) {
      const stillChild = faceAt(CHILD.x, CHILD.y);
      const sibling = faceAt(OTHER.x, OTHER.y, 1.5);
      const faces = frame % 2 === 0 ? [stillChild, sibling] : [sibling, stillChild];
      expect(lock.update(faces, []).face).toBe(stillChild);
    }
  });

  it("follows the child as they move, one small step at a time", () => {
    const lock = new PrimaryPersonLock<FaceCandidate, HandCandidate>();
    let x = CHILD.x;
    lock.update([faceAt(x, CHILD.y)], []);
    for (let frame = 0; frame < 15; frame += 1) {
      x += 0.03;
      const child = faceAt(x, CHILD.y);
      const sibling = faceAt(OTHER.x, 0.8, 1.5);
      expect(lock.update([child, sibling], []).face).toBe(child);
    }
    // Having walked most of the way across the frame, the child is still the
    // subject even though they are now near where the sibling was.
    expect(x).toBeGreaterThan(0.7);
  });

  it("adopts a newcomer only after the whole dropout window", () => {
    const lock = new PrimaryPersonLock<FaceCandidate, HandCandidate>();
    const child = faceAt(CHILD.x, CHILD.y);
    expect(lock.update([child], []).face).toBe(child);

    // The child leaves; a sibling is sitting well outside the drift radius.
    for (let frame = 1; frame <= DEFAULT_LOST_FRAMES + 1; frame += 1) {
      const sibling = faceAt(OTHER.x, 0.5, 1.5);
      expect(lock.update([sibling], []).face).toBeNull();
    }
    const sibling = faceAt(OTHER.x, 0.5, 1.5);
    expect(lock.update([sibling], []).face).toBe(sibling);
  });

  it("holds the subject through a short dropout rather than swapping", () => {
    const lock = new PrimaryPersonLock<FaceCandidate, HandCandidate>();
    const child = faceAt(CHILD.x, CHILD.y);
    lock.update([child], []);

    // Tracker blinks for three frames, with a sibling in view the whole time.
    for (let frame = 0; frame < 3; frame += 1) {
      expect(lock.update([faceAt(OTHER.x, 0.5, 1.5)], []).face).toBeNull();
    }
    const backAgain = faceAt(CHILD.x + 0.02, CHILD.y);
    expect(lock.update([backAgain, faceAt(OTHER.x, 0.5, 1.5)], []).face).toBe(backAgain);
  });
});

/* -------------------------------------------------------------------------- */
/* Hand attribution                                                           */
/* -------------------------------------------------------------------------- */

describe("hand attribution", () => {
  it("counts both of the primary person's hands", () => {
    const reducer = new FrameReducer();
    const frame = reducer.reduce(
      0,
      [faceAt(CHILD.x, CHILD.y)],
      [handAt(0.3, 0.65, { fingers: 1 }), handAt(0.45, 0.65, { fingers: 2 })],
    );
    expect(frame.totalFingers).toBe(3);
  });

  it("ignores a second person's hands even when they are inside the child's reach", () => {
    const reducer = new FrameReducer();
    const child = faceAt(CHILD.x, CHILD.y);
    const alone = reducer.reduce(0, [child], [
      handAt(0.3, 0.65, { fingers: 1 }),
      handAt(0.45, 0.65, { fingers: 2 }),
    ]);
    expect(alone.totalFingers).toBe(3);

    const parentHands = [handAt(0.8, 0.6, { fingers: 2 }), handAt(0.92, 0.6, { fingers: 3 })];
    // Both of the parent's hands sit within the child's own reach radius, so a
    // bare radius test would have counted them. Nearest-face is what saves it.
    const reach = HAND_REACH_FACES * child.size;
    for (const hand of parentHands) {
      expect(Math.hypot(hand.centre.x - CHILD.x, hand.centre.y - CHILD.y)).toBeLessThan(reach);
    }

    const crowded = reducer.reduce(
      40,
      [faceAt(CHILD.x, CHILD.y), faceAt(OTHER.x, 0.3)],
      [handAt(0.3, 0.65, { fingers: 1 }), handAt(0.45, 0.65, { fingers: 2 }), ...parentHands],
    );
    expect(crowded.totalFingers).toBe(3);
    // The contract is unchanged: every visible hand is still reported.
    expect(crowded.hands).toHaveLength(4);
  });

  it("drops a hand that is out of the primary person's reach entirely", () => {
    const reducer = new FrameReducer();
    const frame = reducer.reduce(
      0,
      [faceAt(CHILD.x, CHILD.y)],
      [handAt(0.35, 0.6, { fingers: 2 }), handAt(0.98, 0.98, { fingers: 5 })],
    );
    expect(frame.totalFingers).toBe(2);
  });

  it("trusts exactly one hand when there is no face to attribute to", () => {
    const reducer = new FrameReducer();
    const frame = reducer.reduce(
      0,
      [],
      [handAt(0.3, 0.6, { fingers: 1, size: 0.2 }), handAt(0.7, 0.6, { fingers: 2, size: 0.1 })],
    );
    // Not 3. Two hands we cannot attribute is how a sibling's 2 and the child's
    // 1 became "three".
    expect(frame.totalFingers).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Wave identity                                                              */
/* -------------------------------------------------------------------------- */

/** Two hands, far enough apart in y that neither can be mistaken for the other. */
const WAVE_STEPS = 20;
function sweepingHands(k: number): { a: { x: number; y: number }; b: { x: number; y: number } } {
  return { a: { x: 0.2 + 0.02 * k, y: 0.55 }, b: { x: 0.8 - 0.02 * k, y: 0.95 } };
}

describe("wave identity", () => {
  it("merges two sweeps into a phantom wave when histories are shared", () => {
    // The bug, reproduced: one detector fed alternating samples from two hands.
    // This is what handedness-plus-arrival-order keying does when two right
    // hands swap places in the result array.
    const merged = new WaveDetector();
    for (let k = 0; k < WAVE_STEPS; k += 1) {
      const { a, b } = sweepingHands(k);
      merged.push(k * 60, a.x, true);
      merged.push(k * 60, b.x, true);
    }
    expect(merged.waving).toBe(true);
  });

  it("keeps those two sweeps apart when keyed by tracked identity", () => {
    const tracker = new WaveTracker();
    let sawWave = false;
    for (let k = 0; k < WAVE_STEPS; k += 1) {
      const { a, b } = sweepingHands(k);
      // Arrival order flips every frame, as MediaPipe's ranking does.
      const hands =
        k % 2 === 0
          ? [{ wrist: a, open: true }, { wrist: b, open: true }]
          : [{ wrist: b, open: true }, { wrist: a, open: true }];
      for (const result of tracker.update(k * 60, hands)) {
        if (result.waving) sawWave = true;
      }
    }
    expect(sawWave).toBe(false);
    expect(tracker.size).toBe(2);
  });

  it("gives a hand the same identity across arrival-order flips", () => {
    const tracker = new WaveTracker();
    const idsForA: number[] = [];
    for (let k = 0; k < WAVE_STEPS; k += 1) {
      const { a, b } = sweepingHands(k);
      const flipped = k % 2 !== 0;
      const hands = flipped
        ? [{ wrist: b, open: true }, { wrist: a, open: true }]
        : [{ wrist: a, open: true }, { wrist: b, open: true }];
      const results = tracker.update(k * 60, hands);
      const forA = results[flipped ? 1 : 0];
      if (forA) idsForA.push(forA.id);
    }
    expect(idsForA).toHaveLength(WAVE_STEPS);
    expect(new Set(idsForA).size).toBe(1);
  });

  it("still sees a real one-handed wave", () => {
    const tracker = new WaveTracker();
    const xs = [0.4, 0.5, 0.4, 0.5, 0.4, 0.5];
    let waving = false;
    xs.forEach((x, k) => {
      const results = tracker.update(k * 100, [{ wrist: { x, y: 0.6 }, open: true }]);
      if (results[0]?.waving === true) waving = true;
    });
    expect(waving).toBe(true);
  });

  it("forgets a hand only after the dropout window", () => {
    const tracker = new WaveTracker();
    tracker.update(0, [{ wrist: { x: 0.4, y: 0.6 }, open: true }]);
    expect(tracker.size).toBe(1);
    for (let frame = 1; frame <= DEFAULT_LOST_FRAMES; frame += 1) {
      tracker.update(frame * 60, []);
      expect(tracker.size).toBe(1);
    }
    tracker.update((DEFAULT_LOST_FRAMES + 1) * 60, []);
    expect(tracker.size).toBe(0);
  });

  it("does not let a sibling's wave answer for the child", () => {
    const reducer = new FrameReducer();
    const xs = [0.85, 0.95, 0.85, 0.95, 0.85, 0.95];
    let waving = false;
    xs.forEach((x, k) => {
      const frame = reducer.reduce(
        k * 100,
        [faceAt(CHILD.x, CHILD.y), faceAt(OTHER.x, 0.3)],
        [
          handAt(0.35, 0.6, { fingers: 2 }),
          handAt(x, 0.6, { open: true, fingers: 5 }),
        ],
      );
      if (frame.waving) waving = true;
    });
    expect(waving).toBe(false);
  });

  it("does answer when the child is the one waving", () => {
    const reducer = new FrameReducer();
    const xs = [0.3, 0.4, 0.3, 0.4, 0.3, 0.4];
    let waving = false;
    xs.forEach((x, k) => {
      const frame = reducer.reduce(
        k * 100,
        [faceAt(CHILD.x, CHILD.y), faceAt(OTHER.x, 0.3)],
        [handAt(x, 0.6, { open: true, fingers: 5 })],
      );
      if (frame.waving) waving = true;
    });
    expect(waving).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Gaze stability                                                             */
/* -------------------------------------------------------------------------- */

describe("gaze stability", () => {
  /** The composition the reducer uses: raw centre -> StablePoint -> FaceSignal. */
  function gazeThrough(stable: StablePoint, cx: number): number {
    const mesh = buildFace(cx, 0.5);
    const signal = faceToGaze(mesh, undefined, stable.update(faceCentre(mesh)));
    if (signal === null) throw new Error("fixture face produced no signal");
    return signal.x;
  }

  it("rejects a one-frame flip to somewhere else in the room", () => {
    const stable = new StablePoint();
    for (let i = 0; i < 5; i += 1) gazeThrough(stable, 0.3);
    const settled = gazeThrough(stable, 0.3);
    expect(settled).toBeCloseTo(-0.4, 2);

    // One frame at the far side of the frame: Chiku's eyes must not move.
    expect(gazeThrough(stable, 0.8)).toBeCloseTo(settled, 6);
    // And the child is still where they were.
    expect(gazeThrough(stable, 0.3)).toBeCloseTo(settled, 2);
  });

  it("believes the jump when it persists", () => {
    const stable = new StablePoint();
    for (let i = 0; i < 5; i += 1) gazeThrough(stable, 0.3);
    gazeThrough(stable, 0.8);
    expect(gazeThrough(stable, 0.8)).toBeCloseTo(0.6, 6);
  });

  it("does not lag a normal small movement", () => {
    const stable = new StablePoint();
    gazeThrough(stable, 0.3);
    // A 0.04 step per frame is ordinary fidgeting; the adaptive alpha should
    // cover most of it immediately rather than easing over many frames.
    const moved = gazeThrough(stable, 0.34);
    expect(moved).toBeGreaterThan(-0.4 + 0.04 * 2 * 0.5);
  });

  it("holds its last value through a dropped frame", () => {
    const stable = new StablePoint();
    const settled = gazeThrough(stable, 0.3);
    expect(stable.update(null)?.x).toBeCloseTo(0.3, 6);
    expect(gazeThrough(stable, 0.3)).toBeCloseTo(settled, 6);
  });

  it("does not snap when the lock finally adopts a newcomer", () => {
    const reducer = new FrameReducer();
    reducer.reduce(0, [faceAt(0.3, 0.5)], []);
    const settled = reducer.reduce(40, [faceAt(0.3, 0.5)], []).face?.x ?? 0;

    for (let frame = 1; frame <= DEFAULT_LOST_FRAMES + 1; frame += 1) {
      expect(reducer.reduce(40 + frame * 40, [faceAt(0.9, 0.5, 1.5)], []).face).toBeNull();
    }
    // Adopted — but the gaze still refuses the teleport for one more frame.
    const adopted = reducer.reduce(2000, [faceAt(0.9, 0.5, 1.5)], []);
    expect(adopted.face?.x).toBeCloseTo(settled, 6);
    expect(reducer.reduce(2040, [faceAt(0.9, 0.5, 1.5)], []).face?.x).toBeCloseTo(0.8, 6);
  });
});

/* -------------------------------------------------------------------------- */
/* Presence                                                                   */
/* -------------------------------------------------------------------------- */

describe("face presence", () => {
  it("rises with each frame the child is seen", () => {
    const reducer = new FrameReducer();
    let last = 0;
    for (let frame = 0; frame < 5; frame += 1) {
      const value = reducer.reduce(frame * 40, [faceAt(CHILD.x, CHILD.y)], []).facePresence ?? 0;
      expect(value).toBeGreaterThan(last);
      last = value;
    }
    expect(last).toBeCloseTo(PRESENCE_RISE * 5, 6);
  });

  it("holds flat through the dropout window, then fades", () => {
    const reducer = new FrameReducer();
    for (let frame = 0; frame < 5; frame += 1) reducer.reduce(frame * 40, [faceAt(CHILD.x, CHILD.y)], []);
    const held = PRESENCE_RISE * 5;

    for (let frame = 1; frame <= DEFAULT_LOST_FRAMES; frame += 1) {
      const out = reducer.reduce(200 + frame * 40, [], []);
      // The forgiving signal holds while the strict one is already null — this
      // is the whole point of shipping both.
      expect(out.face).toBeNull();
      expect(out.facePresence).toBeCloseTo(held, 6);
    }
    const fading = reducer.reduce(3000, [], []);
    expect(fading.facePresence).toBeCloseTo(held - PRESENCE_DECAY, 6);
  });

  it("does not credit a stranger with the child's presence", () => {
    const reducer = new FrameReducer();
    for (let frame = 0; frame < 5; frame += 1) reducer.reduce(frame * 40, [faceAt(CHILD.x, CHILD.y)], []);
    const held = PRESENCE_RISE * 5;

    // The child leaves and someone else is in view. Presence must not keep
    // climbing on the strength of a face that is not theirs.
    for (let frame = 1; frame <= DEFAULT_LOST_FRAMES; frame += 1) {
      const out = reducer.reduce(200 + frame * 40, [faceAt(0.9, 0.9, 1.4)], []);
      expect(out.facePresence).toBeCloseTo(held, 6);
    }
  });
});

describe("primary lock: re-acquiring a fast child on a slow device", () => {
  // Regression: a fixed 0.25 radius meant a child who moved further than that
  // between two frames looked "gone". At the 4-6fps this app throttles slow
  // devices to, that is an ordinary move — and it cost seconds of blindness.
  const faceAt = (x: number, y = 0.5) => ({ centre: { x, y }, size: 0.3 });

  it("re-acquires a child who moved far, in a few frames rather than a whole window", () => {
    const lock = new PrimaryPersonLock();
    lock.update([faceAt(0.3)], []);

    // They moved 0.35 — beyond the 0.25 base radius, so not matched at first.
    // The radius then grows 0.25 -> 0.3125 -> 0.375 and picks them up on the
    // third look. Before this fix it took the full ~26-frame lost window, which
    // at the 4-6fps a slow device runs at was seconds of Chiku being blind.
    // Three frames is ~125ms at 24fps and ~600ms at 5fps — and `facePresence`
    // holds attention across it, so the child sees no glitch at all.
    expect(lock.update([faceAt(0.65)], []).face).toBeNull();
    expect(lock.update([faceAt(0.65)], []).face).toBeNull();
    expect(lock.update([faceAt(0.65)], []).face).not.toBeNull();
  });

  it("still never adopts someone across the room by drift alone", () => {
    const lock = new PrimaryPersonLock();
    lock.update([faceAt(0.1)], []);
    // A stranger at the far edge: 0.85 away, past even the grown radius (0.5).
    for (let i = 0; i < 10; i++) {
      expect(lock.update([faceAt(0.95)], []).face).toBeNull();
    }
  });

  it("adopts a genuinely new person only after the full lost window", () => {
    const lock = new PrimaryPersonLock();
    lock.update([faceAt(0.1)], []);
    let adopted = false;
    for (let i = 0; i < 40; i++) {
      if (lock.update([faceAt(0.95)], []).face !== null) {
        adopted = true;
        expect(i).toBeGreaterThan(20); // released, not drifted, into the newcomer
        break;
      }
    }
    expect(adopted).toBe(true);
  });
});
