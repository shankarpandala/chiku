/**
 * The magic window, from hand-built hands.
 *
 * No MediaPipe, no camera, no clock: every fixture below is 21 landmarks in a
 * canonical local frame (wrist at the origin, fingers pointing up the -y axis)
 * scaled and translated into normalized image space, so `handScale` is exactly
 * the fixture's own `scale` and every threshold in `QUAD_THRESHOLDS` can be
 * reasoned about on paper. That is the point of `QuadDetector` being pure.
 *
 * What is NOT covered here: whether real 3-year-old hands trip the palm rung at
 * the distances a real living room puts them at. These fixtures are geometry,
 * not children — the angle thresholds they are scored against are the same
 * ADULT-DERIVED numbers `fingers.ts` warns about, and the ladder's real
 * calibration is a session with actual children in front of an actual camera.
 */

import { describe, expect, it } from "vitest";

import {
  FrameReducer,
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
} from "../src/vision/gaze";
import type { Landmark } from "../src/vision/fingers";
import {
  KIND_SWITCH_FRAMES,
  PALM_WINDOW_HALF_SCALES,
  QUAD_LADDER,
  QuadDetector,
  opennessOf,
  spreadOf,
  type HandLandmarks,
} from "../src/vision/quad-detect";
import {
  LM,
  QUAD_THRESHOLDS,
  handScale,
  polygonArea,
  type Quad,
} from "../src/vision/quad";
import { DEFAULT_LOST_FRAMES, PRESENCE_DECAY, type Point } from "../src/vision/stability";

/* -------------------------------------------------------------------------- */
/* Hand fixtures                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Poses, in local units where 1.0 == the wrist-to-middle-MCP distance that
 * `handScale` measures.
 *
 *   palm   every finger out, thumb splayed — the 3-4 rung
 *   pinch  index out, thumb raised alongside it — the 5-6 rung's aperture
 *   fist   everything curled, thumb tucked across the fingers
 *   droop  a palm that has sagged to two fingers with the thumb folded up: the
 *          pose an absorbed child's hand degrades into, and one that must not
 *          be able to START a window
 */
type Pose = "palm" | "pinch" | "fist" | "droop";

/** [MCP] for index, middle, ring, pinky. */
const MCP: readonly (readonly [number, number])[] = [
  [-0.3, -1.0],
  [0.0, -1.0],
  [0.28, -1.0],
  [0.54, -0.95],
];

/** CMC, MCP, IP, TIP. */
const THUMB: Record<Pose, readonly (readonly [number, number])[]> = {
  palm: [
    [0.25, -0.15],
    [0.45, -0.35],
    [0.6, -0.5],
    [0.75, -0.65],
  ],
  pinch: [
    [0.25, -0.15],
    [0.45, -0.45],
    [0.4, -0.85],
    [0.2, -1.15],
  ],
  fist: [
    [0.25, -0.15],
    [0.45, -0.35],
    [0.35, -0.6],
    [-0.05, -0.75],
  ],
  droop: [
    [0.25, -0.15],
    [0.4, -0.5],
    [0.1, -1.0],
    [-0.1, -1.7],
  ],
};

/** index, middle, ring, pinky. */
const OUT: Record<Pose, readonly [boolean, boolean, boolean, boolean]> = {
  palm: [true, true, true, true],
  pinch: [true, false, false, false],
  fist: [false, false, false, false],
  droop: [true, true, false, false],
};

interface HandSpec {
  readonly wrist: Point;
  readonly pose: Pose;
  readonly scale?: number;
  /** Absolute overrides, for placing a two-hand frame's corners exactly. */
  readonly indexTip?: Point;
  readonly thumbTip?: Point;
}

function buildHand(spec: HandSpec): Landmark[] {
  const s = spec.scale ?? 0.12;
  const at = (lx: number, ly: number): Landmark => ({
    x: spec.wrist.x + lx * s,
    y: spec.wrist.y + ly * s,
    z: 0,
  });

  const lm: Landmark[] = [at(0, 0)];
  for (const [x, y] of THUMB[spec.pose]) lm.push(at(x, y));

  for (let f = 0; f < 4; f += 1) {
    const mcp = MCP[f];
    const extended = OUT[spec.pose][f];
    if (mcp === undefined || extended === undefined) throw new Error("bad fixture");
    const [mx, my] = mcp;
    lm.push(at(mx, my));
    if (extended) {
      lm.push(at(mx, my - 0.35), at(mx, my - 0.68), at(mx, my - 1.0));
    } else {
      // Folded back toward the knuckle: the PIP interior angle collapses to
      // ~10deg, which is unambiguously curled at any threshold.
      lm.push(at(mx, my - 0.35), at(mx + 0.05, my - 0.2), at(mx + 0.06, my - 0.02));
    }
  }

  if (spec.thumbTip !== undefined) lm[LM.thumbTip] = { ...spec.thumbTip, z: 0 };
  if (spec.indexTip !== undefined) lm[LM.indexTip] = { ...spec.indexTip, z: 0 };
  return lm;
}

/** The reference's two-handed frame: a rectangle with those exact corners. */
function frameHands(box: {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly scale?: number;
}): readonly [Landmark[], Landmark[]] {
  const s = box.scale ?? 0.12;
  const below = box.bottom + 0.15;
  return [
    buildHand({
      wrist: { x: box.left, y: below },
      pose: "pinch",
      scale: s,
      indexTip: { x: box.left, y: box.top },
      thumbTip: { x: box.left, y: box.bottom },
    }),
    buildHand({
      wrist: { x: box.right, y: below },
      pose: "pinch",
      scale: s,
      indexTip: { x: box.right, y: box.top },
      thumbTip: { x: box.right, y: box.bottom },
    }),
  ];
}

/** Narrowing helper: a test that got null here has already failed. */
function must(quad: Quad | null): Quad {
  if (quad === null) throw new Error("expected a window");
  return quad;
}

/** Bounding-box diagonal of a window — "how big is it", kind-independently. */
function windowSize(quad: Quad): number {
  const xs = quad.corners.map((c) => c.x);
  const ys = quad.corners.map((c) => c.y);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

function feed(
  detector: QuadDetector,
  hands: readonly HandLandmarks[],
  frames: number,
): Quad | null {
  let last: Quad | null = null;
  for (let i = 0; i < frames; i += 1) last = detector.update(hands);
  return last;
}

/* -------------------------------------------------------------------------- */
/* The fixtures say what we think they say                                    */
/* -------------------------------------------------------------------------- */

describe("hand fixtures", () => {
  it("measure the way the thresholds assume", () => {
    const palm = buildHand({ wrist: { x: 0.5, y: 0.7 }, pose: "palm" });
    const pinch = buildHand({ wrist: { x: 0.5, y: 0.7 }, pose: "pinch" });
    const fist = buildHand({ wrist: { x: 0.5, y: 0.7 }, pose: "fist" });
    const droop = buildHand({ wrist: { x: 0.5, y: 0.7 }, pose: "droop" });

    // handScale is exactly the fixture scale, by construction.
    expect(handScale(palm)).toBeCloseTo(0.12, 6);

    // A palm is open; a fist is not; a droop is in between — above the exit
    // threshold but below the entry one, which is the whole hysteresis story.
    expect(opennessOf(palm)).toBeGreaterThanOrEqual(QUAD_THRESHOLDS.palmEnter);
    expect(opennessOf(fist)).toBe(0);
    const droopOpen = opennessOf(droop);
    expect(droopOpen).toBeGreaterThan(QUAD_THRESHOLDS.palmExit);
    expect(droopOpen).toBeLessThan(QUAD_THRESHOLDS.palmEnter);

    // Spread: wide for a pinch, narrow for a fist and for the droop.
    expect(spreadOf(pinch)).toBeGreaterThanOrEqual(QUAD_THRESHOLDS.spreadEnter);
    expect(spreadOf(fist)).toBeLessThan(QUAD_THRESHOLDS.spreadEnter);
    expect(spreadOf(droop)).toBeLessThan(QUAD_THRESHOLDS.spreadEnter);
  });
});

/* -------------------------------------------------------------------------- */
/* The ladder                                                                 */
/* -------------------------------------------------------------------------- */

describe("the graded ladder", () => {
  it("is ordered hardest-coordination first", () => {
    expect(QUAD_LADDER).toEqual(["frame", "pinch", "palm"]);
  });

  it("makes a palm window from one open palm", () => {
    const detector = new QuadDetector();
    const hand = buildHand({ wrist: { x: 0.5, y: 0.7 }, pose: "palm" });
    const quad = detector.update([hand]);

    expect(quad).not.toBeNull();
    expect(quad?.kind).toBe("palm");
    expect(quad?.presence).toBeGreaterThan(0);
    // Centred on the palm, not the wrist and not the fingertips.
    expect(quad?.centre.y).toBeLessThan(0.7);
    expect(quad?.centre.y).toBeGreaterThan(0.7 - 0.12);

    // Comfortably bigger than the hand: the child looks THROUGH the window, so
    // their own fingers must not be the first thing inside it.
    const half = PALM_WINDOW_HALF_SCALES * handScale(hand);
    expect(half).toBeGreaterThan(handScale(hand));
    expect(windowSize(must(quad))).toBeCloseTo(Math.hypot(2 * half, 2 * half), 6);
  });

  it("makes a smaller window from a pinch", () => {
    const palm = new QuadDetector().update([
      buildHand({ wrist: { x: 0.5, y: 0.7 }, pose: "palm" }),
    ]);
    const pinch = new QuadDetector().update([
      buildHand({ wrist: { x: 0.5, y: 0.7 }, pose: "pinch" }),
    ]);

    expect(pinch?.kind).toBe("pinch");
    expect(windowSize(must(pinch))).toBeLessThan(windowSize(must(palm)));
  });

  it("makes the reference's frame from two hands", () => {
    const detector = new QuadDetector();
    const [a, b] = frameHands({ left: 0.3, right: 0.7, top: 0.3, bottom: 0.62 });
    const quad = detector.update([a, b]);

    expect(quad?.kind).toBe("frame");
    // First detected frame: StablePoint has nothing to blend with, so the
    // corners are exactly where the fingertips are.
    expect(quad?.corners[0].x).toBeCloseTo(0.3, 6);
    expect(quad?.corners[0].y).toBeCloseTo(0.3, 6);
    expect(quad?.corners[1].x).toBeCloseTo(0.7, 6);
    expect(quad?.corners[2].y).toBeCloseTo(0.62, 6);
    expect(quad?.corners[3].x).toBeCloseTo(0.3, 6);
    expect(polygonArea(quad?.corners ?? [])).toBeGreaterThan(QUAD_THRESHOLDS.areaEnter);
  });

  it("prefers the two-handed frame when the child can manage one", () => {
    // Both hands are ALSO individually pinch-shaped, so this only passes
    // because the ladder tries the hardest gesture first.
    const detector = new QuadDetector();
    const [a, b] = frameHands({ left: 0.3, right: 0.7, top: 0.3, bottom: 0.62 });
    expect(spreadOf(a)).toBeGreaterThanOrEqual(QUAD_THRESHOLDS.spreadEnter);
    expect(detector.update([a, b])?.kind).toBe("frame");
  });

  it("makes nothing from a closed fist", () => {
    const detector = new QuadDetector();
    const fist = buildHand({ wrist: { x: 0.5, y: 0.7 }, pose: "fist" });
    expect(feed(detector, [fist], 10)).toBeNull();
    expect(detector.kind).toBeNull();
  });

  it("makes nothing from no hands at all", () => {
    expect(feed(new QuadDetector(), [], 10)).toBeNull();
  });

  it("refuses a two-hand frame that encloses nothing", () => {
    // Hands together: the spread is fine, the enclosed area is not.
    const detector = new QuadDetector();
    const [a, b] = frameHands({ left: 0.5, right: 0.503, top: 0.4, bottom: 0.72 });
    const quad = detector.update([a, b]);
    expect(quad?.kind).not.toBe("frame");
  });
});

/* -------------------------------------------------------------------------- */
/* Forgiveness                                                                */
/* -------------------------------------------------------------------------- */

describe("hysteresis", () => {
  it("keeps a window through a pose that could not have started one", () => {
    const palm = buildHand({ wrist: { x: 0.5, y: 0.7 }, pose: "palm" });
    const droop = buildHand({ wrist: { x: 0.5, y: 0.7 }, pose: "droop" });

    // Cold: the degraded pose is not enough to acquire anything.
    expect(feed(new QuadDetector(), [droop], 10)).toBeNull();

    // Warm: the same pose keeps the window the open palm earned. This is the
    // moment that matters — the child's hand sags precisely because something
    // appeared inside their window and they are staring at it.
    const detector = new QuadDetector();
    feed(detector, [palm], 5);
    const held = feed(detector, [droop], 10);
    expect(held).not.toBeNull();
    expect(held?.kind).toBe("palm");
  });
});

describe("teleport rejection", () => {
  it("ignores a one-frame jump across the screen", () => {
    const detector = new QuadDetector();
    const here = buildHand({ wrist: { x: 0.4, y: 0.6 }, pose: "palm" });
    const away = buildHand({ wrist: { x: 0.95, y: 0.6 }, pose: "palm" });

    const settled = feed(detector, [here], 10);
    expect(settled).not.toBeNull();
    const before = settled?.centre.x ?? 0;

    const jumped = detector.update([away]);
    expect(Math.abs((jumped?.centre.x ?? 0) - before)).toBeLessThan(0.05);

    // And the child coming back is not punished for the tracker's mistake.
    const back = detector.update([here]);
    expect(back?.centre.x).toBeCloseTo(before, 2);
  });

  it("follows a jump that insists", () => {
    const detector = new QuadDetector();
    const here = buildHand({ wrist: { x: 0.4, y: 0.6 }, pose: "palm" });
    const away = buildHand({ wrist: { x: 0.95, y: 0.6 }, pose: "palm" });

    const before = feed(detector, [here], 10)?.centre.x ?? 0;
    const moved = feed(detector, [away], 3)?.centre.x ?? 0;
    expect(moved).toBeGreaterThan(before + 0.4);
  });

  it("does not jitter when the hand is still", () => {
    const detector = new QuadDetector();
    const hand = buildHand({ wrist: { x: 0.4, y: 0.6 }, pose: "palm" });
    const a = feed(detector, [hand], 12)?.centre;
    const b = detector.update([hand])?.centre;
    expect(Math.abs((a?.x ?? 0) - (b?.x ?? 1))).toBeLessThan(1e-9);
  });
});

describe("presence", () => {
  it("fades in rather than popping", () => {
    const detector = new QuadDetector();
    const hand = buildHand({ wrist: { x: 0.5, y: 0.7 }, pose: "palm" });
    const first = detector.update([hand]);
    expect(first?.presence).toBeGreaterThan(0);
    expect(first?.presence).toBeLessThan(1);
    expect(feed(detector, [hand], 20)?.presence).toBeCloseTo(1, 6);
  });

  it("survives a tracker dropout without blinking", () => {
    const detector = new QuadDetector();
    const hand = buildHand({ wrist: { x: 0.5, y: 0.7 }, pose: "palm" });
    feed(detector, [hand], 20);

    // Inside the dropout window the window is simply still there, unchanged.
    for (let i = 0; i < DEFAULT_LOST_FRAMES; i += 1) {
      const quad = detector.update([]);
      expect(quad).not.toBeNull();
      expect(quad?.presence).toBeCloseTo(1, 6);
      expect(quad?.kind).toBe("palm");
    }
  });

  it("fades out rather than cutting when the child really leaves", () => {
    const detector = new QuadDetector();
    const hand = buildHand({ wrist: { x: 0.5, y: 0.7 }, pose: "palm" });
    feed(detector, [hand], 20);
    feed(detector, [], DEFAULT_LOST_FRAMES);

    let previous = 1;
    let steps = 0;
    for (;;) {
      const quad = detector.update([]);
      if (quad === null) break;
      // Monotone, and never more than one decay step at a time — the thing a
      // child perceives as "it went away", not "it vanished".
      expect(quad.presence).toBeLessThan(previous + 1e-9);
      expect(previous - quad.presence).toBeLessThanOrEqual(PRESENCE_DECAY + 1e-9);
      previous = quad.presence;
      steps += 1;
      expect(steps).toBeLessThan(200);
    }
    // It reached (nearly) zero before disappearing: no visible pop.
    expect(previous).toBeLessThanOrEqual(PRESENCE_DECAY + 1e-9);
    expect(steps).toBeGreaterThan(10);
  });

  it("forgets everything once it has faded, so the next window earns entry", () => {
    const detector = new QuadDetector();
    const hand = buildHand({ wrist: { x: 0.5, y: 0.7 }, pose: "palm" });
    feed(detector, [hand], 20);
    feed(detector, [], DEFAULT_LOST_FRAMES + 40);
    expect(detector.kind).toBeNull();

    // A degraded pose cannot inherit the faded window's warm gate.
    const droop = buildHand({ wrist: { x: 0.5, y: 0.7 }, pose: "droop" });
    expect(feed(detector, [droop], 5)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Stickiness                                                                 */
/* -------------------------------------------------------------------------- */

describe("kind stickiness", () => {
  it("does not flicker to another kind for a stray frame or two", () => {
    const detector = new QuadDetector();
    const [a, b] = frameHands({ left: 0.3, right: 0.7, top: 0.3, bottom: 0.62 });
    const palm = buildHand({ wrist: { x: 0.5, y: 0.75 }, pose: "palm" });

    expect(feed(detector, [a, b], 5)?.kind).toBe("frame");

    // One hand drops out for two frames — the palm rung would happily take
    // over, and must not.
    for (let i = 0; i < KIND_SWITCH_FRAMES - 1; i += 1) {
      expect(detector.update([palm])?.kind).toBe("frame");
    }
    expect(detector.update([a, b])?.kind).toBe("frame");
    expect(detector.update([palm])?.kind).toBe("frame");
  });

  it("switches once the new kind insists", () => {
    const detector = new QuadDetector();
    const [a, b] = frameHands({ left: 0.3, right: 0.7, top: 0.3, bottom: 0.62 });
    const palm = buildHand({ wrist: { x: 0.5, y: 0.75 }, pose: "palm" });

    feed(detector, [a, b], 5);
    for (let i = 0; i < KIND_SWITCH_FRAMES - 1; i += 1) detector.update([palm]);
    expect(detector.update([palm])?.kind).toBe("palm");
    expect(detector.kind).toBe("palm");
  });

  it("holds the last window steady while a challenger is proving itself", () => {
    const detector = new QuadDetector();
    const [a, b] = frameHands({ left: 0.3, right: 0.7, top: 0.3, bottom: 0.62 });
    const palm = buildHand({ wrist: { x: 0.5, y: 0.75 }, pose: "palm" });

    const framed = feed(detector, [a, b], 5);
    const during = detector.update([palm]);
    expect(during?.corners[0].x).toBeCloseTo(framed?.corners[0].x ?? -1, 6);
    expect(during?.presence).toBeCloseTo(framed?.presence ?? -1, 6);
  });
});

/* -------------------------------------------------------------------------- */
/* Whose window is it                                                         */
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

function candidate(landmarks: readonly Landmark[]): HandCandidate {
  const wrist = landmarks[0] ?? { x: 0.5, y: 0.5 };
  return {
    centre: { x: wrist.x, y: wrist.y },
    size: 0.15,
    open: false,
    landmarks,
    signal: {
      handedness: "Right",
      fingers: null,
      extended: [false, false, false, false, false],
      gesture: null,
      wrist: { x: wrist.x, y: wrist.y },
    },
  };
}

describe("the window belongs to the child", () => {
  const child = faceAt(0.35, 0.35, 1.1);
  const sibling = faceAt(0.85, 0.35);
  const childPalm = candidate(buildHand({ wrist: { x: 0.4, y: 0.55 }, pose: "palm" }));
  const siblingFrame = frameHands({
    left: 0.78,
    right: 0.95,
    top: 0.4,
    bottom: 0.66,
    scale: 0.1,
  }).map(candidate);

  it("hands the child's own palm through as a quad", () => {
    const reducer = new FrameReducer();
    let last = reducer.reduce(0, [child], [childPalm]);
    for (let i = 1; i < 5; i += 1) last = reducer.reduce(i * 40, [child], [childPalm]);
    expect(last.quad?.kind).toBe("palm");
  });

  it("refuses a sibling's frame outright", () => {
    // Non-vacuity: those same two hands DO make a frame when they belong to
    // whoever we are playing with. What follows is attribution, not a fixture
    // that could never have qualified.
    const proof = new QuadDetector();
    const bare = siblingFrame.map((h) => h.landmarks ?? []);
    expect(proof.update(bare)?.kind).toBe("frame");

    const reducer = new FrameReducer();
    let last = reducer.reduce(0, [child, sibling], siblingFrame);
    for (let i = 1; i < 8; i += 1) {
      last = reducer.reduce(i * 40, [child, sibling], siblingFrame);
    }
    expect(last.quad ?? null).toBeNull();
  });

  it("lets the child keep their palm while a sibling frames beside them", () => {
    const reducer = new FrameReducer();
    const all = [childPalm, ...siblingFrame];
    let last = reducer.reduce(0, [child, sibling], all);
    for (let i = 1; i < 8; i += 1) last = reducer.reduce(i * 40, [child, sibling], all);
    // Not "frame": the sibling's two hands never reach the detector at all, so
    // the hardest rung cannot be satisfied by someone else's coordination.
    expect(last.quad?.kind).toBe("palm");
  });

  it("cannot make a window from hands with no landmarks", () => {
    const reducer = new FrameReducer();
    const bare: HandCandidate = {
      centre: { x: 0.4, y: 0.55 },
      size: 0.15,
      open: true,
      signal: {
        handedness: "Right",
        fingers: 5,
        extended: [true, true, true, true, true],
        gesture: null,
        wrist: { x: 0.4, y: 0.55 },
      },
    };
    const frame = reducer.reduce(0, [child], [bare]);
    expect(frame.quad ?? null).toBeNull();
    // …and the rest of the contract is untouched.
    expect(frame.totalFingers).toBe(5);
  });
});
