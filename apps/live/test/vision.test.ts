/**
 * Vision maths — fingers, waving, calibration.
 *
 * MediaPipe is never imported here. The landmark fixtures are constructed
 * mathematically so a hand with a known PIP angle can be asserted exactly; that
 * is the whole point of keeping the counting logic pure.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ADULT_THRESHOLDS,
  AMBIGUITY_BAND_DEG,
  FINGER_EXTENDED_MIN_ANGLE_DEG,
  THUMB_EXTENDED_MIN_ANGLE_DEG,
  countExtendedFingers,
  isOpenPalm,
  type FingerThresholds,
  type Landmark,
} from "../src/vision/fingers";
import { WaveDetector } from "../src/vision/wave";
import {
  ADULT_DEFAULT_CALIBRATION,
  CALIBRATION_STORAGE_KEY,
  clearCalibration,
  getCalibration,
  setCalibration,
} from "../src/vision/calibration";

/* -------------------------------------------------------------------------- */
/* Hand fixtures                                                              */
/* -------------------------------------------------------------------------- */

interface Pt {
  x: number;
  y: number;
  z: number;
}

/** A comfortably-straight finger and a clearly-curled one, in PIP degrees. */
const STRAIGHT = 175;
const CURLED = 30;

/**
 * Place `c` so that the interior angle a -> b -> c is exactly `angleDeg`,
 * at distance `len` from b. This is what lets a fixture say "index at 149.9"
 * and have the implementation measure 149.9.
 */
function pointAtAngle(a: Pt, b: Pt, angleDeg: number, len: number, sign = 1): Pt {
  const vx = a.x - b.x;
  const vy = a.y - b.y;
  const n = Math.hypot(vx, vy);
  const ux = vx / n;
  const uy = vy / n;
  const r = (sign * angleDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: b.x + len * (ux * cos - uy * sin), y: b.y + len * (ux * sin + uy * cos), z: 0 };
}

function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: 0 };
}

type FingerSpec = number | boolean;

interface HandSpec {
  thumb?: FingerSpec;
  index?: FingerSpec;
  middle?: FingerSpec;
  ring?: FingerSpec;
  pinky?: FingerSpec;
}

function deg(spec: FingerSpec | undefined): number {
  if (spec === undefined || spec === false) return CURLED;
  if (spec === true) return STRAIGHT;
  return spec;
}

/**
 * Build the 21 MediaPipe hand landmarks for a hand held palm-to-camera with
 * fingers pointing up, each finger bent to the requested PIP angle and the
 * thumb bent to the requested angle at BOTH of its joints.
 */
function buildHand(spec: HandSpec = {}): Pt[] {
  const pts: Pt[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));

  const wrist: Pt = { x: 0.5, y: 0.9, z: 0 };
  pts[0] = wrist;

  // Thumb: CMC(1) -> MCP(2) -> IP(3) -> TIP(4), splayed off to the low-x side.
  const cmc: Pt = { x: 0.42, y: 0.85, z: 0 };
  const thumbMcp: Pt = { x: 0.37, y: 0.79, z: 0 };
  const thumbAngle = deg(spec.thumb);
  const ip = pointAtAngle(cmc, thumbMcp, thumbAngle, 0.05, -1);
  const thumbTip = pointAtAngle(thumbMcp, ip, thumbAngle, 0.04, -1);
  pts[1] = cmc;
  pts[2] = thumbMcp;
  pts[3] = ip;
  pts[4] = thumbTip;

  // index / middle / ring / pinky, MCP row across the knuckles.
  const fingers: ReadonlyArray<{ base: number; x: number; angle: number }> = [
    { base: 5, x: 0.45, angle: deg(spec.index) },
    { base: 9, x: 0.5, angle: deg(spec.middle) },
    { base: 13, x: 0.55, angle: deg(spec.ring) },
    { base: 17, x: 0.6, angle: deg(spec.pinky) },
  ];

  for (const finger of fingers) {
    const mcp: Pt = { x: finger.x, y: 0.62, z: 0 };
    const pip: Pt = { x: finger.x, y: 0.55, z: 0 };
    const tip = pointAtAngle(mcp, pip, finger.angle, 0.08);
    pts[finger.base] = mcp;
    pts[finger.base + 1] = pip;
    pts[finger.base + 2] = mid(pip, tip);
    pts[finger.base + 3] = tip;
  }

  return pts;
}

function at(pts: readonly Pt[], i: number): Pt {
  const p = pts[i];
  if (!p) throw new Error(`fixture is missing landmark ${i}`);
  return p;
}

/* -------------------------------------------------------------------------- */
/* Fixture sanity — if these drift, every assertion below is meaningless.      */
/* -------------------------------------------------------------------------- */

describe("hand fixtures", () => {
  it("produces the PIP angle it was asked for", () => {
    const hand = buildHand({ index: 149.9, middle: 92, ring: 175, pinky: 30 });
    const angles = countExtendedFingers(hand).anglesDeg;
    expect(angles[1]).toBeCloseTo(149.9, 4);
    expect(angles[2]).toBeCloseTo(92, 4);
    expect(angles[3]).toBeCloseTo(175, 4);
    expect(angles[4]).toBeCloseTo(30, 4);
  });

  it("produces the thumb joint angle it was asked for", () => {
    expect(countExtendedFingers(buildHand({ thumb: 168 })).anglesDeg[0]).toBeCloseTo(168, 4);
  });
});

/* -------------------------------------------------------------------------- */
/* Counting                                                                   */
/* -------------------------------------------------------------------------- */

describe("countExtendedFingers", () => {
  it("counts a fist as zero", () => {
    const count = countExtendedFingers(buildHand());
    expect(count.total).toBe(0);
    expect(count.extended).toEqual([false, false, false, false, false]);
  });

  it("counts a point as one, on the index finger", () => {
    const count = countExtendedFingers(buildHand({ index: true }));
    expect(count.total).toBe(1);
    expect(count.extended).toEqual([false, true, false, false, false]);
  });

  it("counts a victory sign as two", () => {
    const count = countExtendedFingers(buildHand({ index: true, middle: true }));
    expect(count.total).toBe(2);
    expect(count.extended).toEqual([false, true, true, false, false]);
  });

  it("counts an open hand as five", () => {
    const count = countExtendedFingers(
      buildHand({ thumb: true, index: true, middle: true, ring: true, pinky: true }),
    );
    expect(count.total).toBe(5);
    expect(count.extended).toEqual([true, true, true, true, true]);
  });

  it("counts a thumbs-up as one, on the thumb", () => {
    const count = countExtendedFingers(buildHand({ thumb: true }));
    expect(count.total).toBe(1);
    expect(count.extended).toEqual([true, false, false, false, false]);
  });

  it("counts four when only the thumb is folded in", () => {
    const count = countExtendedFingers(
      buildHand({ index: true, middle: true, ring: true, pinky: true }),
    );
    expect(count.total).toBe(4);
  });

  it("returns null for a landmark array that is not a whole hand", () => {
    expect(countExtendedFingers([]).total).toBeNull();
    expect(countExtendedFingers(buildHand().slice(0, 12)).total).toBeNull();
    expect(countExtendedFingers(undefined).total).toBeNull();
    expect(countExtendedFingers(null).total).toBeNull();
  });
});

describe("ambiguity", () => {
  it("returns null when several fingers sit on the threshold", () => {
    const onEdge = FINGER_EXTENDED_MIN_ANGLE_DEG;
    const count = countExtendedFingers(buildHand({ index: onEdge, middle: onEdge }));
    expect(count.ambiguousCount).toBe(2);
    expect(count.total).toBeNull();
  });

  it("still answers when only one finger is borderline", () => {
    const count = countExtendedFingers(
      buildHand({ index: FINGER_EXTENDED_MIN_ANGLE_DEG + 1, middle: true }),
    );
    expect(count.ambiguousCount).toBe(1);
    expect(count.total).toBe(2);
  });

  it("answers confidently when every finger is well clear of the band", () => {
    const clear = FINGER_EXTENDED_MIN_ANGLE_DEG + AMBIGUITY_BAND_DEG + 5;
    const count = countExtendedFingers(buildHand({ index: clear, middle: clear }));
    expect(count.ambiguousCount).toBe(0);
    expect(count.total).toBe(2);
  });

  it("keeps a best-guess `extended` even when the total is withheld", () => {
    const onEdge = FINGER_EXTENDED_MIN_ANGLE_DEG;
    const count = countExtendedFingers(buildHand({ index: onEdge, middle: onEdge, ring: true }));
    expect(count.total).toBeNull();
    expect(count.extended[3]).toBe(true);
  });
});

describe("angle-based counting, not distance-based", () => {
  /**
   * Regression against the heuristic this module exists to avoid: a finger
   * curled *towards the camera* projects a tip that is further from the wrist
   * than its own PIP joint, so "tip further than PIP" calls it extended. The
   * angle says 100deg, which is nowhere near straight.
   */
  it("does not count a forward-curled finger that the naive test would", () => {
    const hand = buildHand({ index: 100 });
    const wrist = at(hand, 0);
    const pip = at(hand, 6);
    const tip = at(hand, 8);

    const naiveSaysExtended =
      Math.hypot(tip.x - wrist.x, tip.y - wrist.y) > Math.hypot(pip.x - wrist.x, pip.y - wrist.y);
    expect(naiveSaysExtended).toBe(true);

    const count = countExtendedFingers(hand);
    expect(count.extended[1]).toBe(false);
    expect(count.total).toBe(0);
  });

  it("scores the thumb by its joints, so a splayed-but-bent thumb is not extended", () => {
    // Bent hard at both joints but flung well away from the palm — exactly the
    // case a thumb-tip distance ratio gets wrong.
    const count = countExtendedFingers(buildHand({ thumb: 95 }));
    expect(count.extended[0]).toBe(false);
  });
});

describe("thresholds and calibration overrides", () => {
  it("exports adult-derived defaults", () => {
    expect(ADULT_THRESHOLDS.fingerAngleDeg).toBe(FINGER_EXTENDED_MIN_ANGLE_DEG);
    expect(ADULT_THRESHOLDS.thumbAngleDeg).toBe(THUMB_EXTENDED_MIN_ANGLE_DEG);
    expect(ADULT_THRESHOLDS.ambiguityBandDeg).toBe(AMBIGUITY_BAND_DEG);
  });

  it("counts a small hand's half-straight fingers once the threshold is lowered", () => {
    const smallHand = buildHand({ index: 138, middle: 141, ring: 136 });
    expect(countExtendedFingers(smallHand).total).toBe(0);

    const childish: FingerThresholds = { ...ADULT_THRESHOLDS, fingerAngleDeg: 125 };
    expect(countExtendedFingers(smallHand, childish).total).toBe(3);
  });
});

describe("isOpenPalm", () => {
  it("is true when the four fingers are out, thumb or no thumb", () => {
    const spread: HandSpec = { index: true, middle: true, ring: true, pinky: true };
    expect(isOpenPalm(buildHand({ ...spread, thumb: true }))).toBe(true);
    expect(isOpenPalm(buildHand(spread))).toBe(true);
  });

  it("is false for a fist and for a point", () => {
    expect(isOpenPalm(buildHand())).toBe(false);
    expect(isOpenPalm(buildHand({ index: true }))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Waving                                                                     */
/* -------------------------------------------------------------------------- */

describe("WaveDetector", () => {
  /** Feed a path of wrist-x values at a fixed cadence. */
  function play(
    detector: WaveDetector,
    xs: readonly number[],
    { stepMs = 40, open = true, t0 = 1000 } = {},
  ): boolean {
    let fired = false;
    for (let i = 0; i < xs.length; i += 1) {
      const x = xs[i];
      if (x === undefined) continue;
      if (detector.push(t0 + i * stepMs, x, open)) fired = true;
    }
    return fired;
  }

  /** left, right, left — two direction reversals inside the window. */
  const OSCILLATION = [0.5, 0.56, 0.62, 0.68, 0.6, 0.52, 0.44, 0.52, 0.6, 0.66];
  /** one continuous sweep across the frame */
  const SWEEP = [0.2, 0.27, 0.34, 0.41, 0.48, 0.55, 0.62, 0.69, 0.76, 0.83];

  it("fires on a wrist oscillation with an open palm", () => {
    const detector = new WaveDetector();
    expect(play(detector, OSCILLATION)).toBe(true);
    expect(detector.waving).toBe(true);
  });

  it("does not fire on a single sweep", () => {
    const detector = new WaveDetector();
    expect(play(detector, SWEEP)).toBe(false);
    expect(detector.waving).toBe(false);
  });

  it("does not fire when the palm is closed", () => {
    const detector = new WaveDetector();
    expect(play(detector, OSCILLATION, { open: false })).toBe(false);
  });

  it("does not fire on jitter that never really travels", () => {
    const detector = new WaveDetector();
    const jitter = [0.5, 0.503, 0.497, 0.502, 0.498, 0.501, 0.499, 0.5];
    expect(play(detector, jitter)).toBe(false);
  });

  it("does not fire when the reversals are spread far outside the window", () => {
    const detector = new WaveDetector();
    // Same path, but each sample 500ms apart: only the tail is ever in window.
    expect(play(detector, OSCILLATION, { stepMs: 500 })).toBe(false);
  });

  it("reset() forgets the oscillation", () => {
    const detector = new WaveDetector();
    play(detector, OSCILLATION);
    expect(detector.waving).toBe(true);
    detector.reset();
    expect(detector.waving).toBe(false);
    // A single sample after a reset cannot possibly be a wave.
    expect(detector.push(9000, 0.5, true)).toBe(false);
  });

  it("stops waving as soon as the palm closes", () => {
    const detector = new WaveDetector();
    play(detector, OSCILLATION);
    expect(detector.push(1400, 0.58, false)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Calibration store                                                          */
/* -------------------------------------------------------------------------- */

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length(): number {
      return map.size;
    },
    clear(): void {
      map.clear();
    },
    getItem: (k: string): string | null => map.get(k) ?? null,
    key: (i: number): string | null => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string): void => {
      map.delete(k);
    },
    setItem: (k: string, v: string): void => {
      map.set(k, String(v));
    },
  };
}

describe("calibration store", () => {
  beforeEach(() => {
    globalThis.localStorage = memoryStorage();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("starts at the adult defaults", () => {
    expect(getCalibration()).toEqual(ADULT_DEFAULT_CALIBRATION);
  });

  it("round-trips a per-child calibration", () => {
    const saved = setCalibration({ fingerAngleDeg: 132, thumbAngleDeg: 128 });
    expect(saved.fingerAngleDeg).toBe(132);
    expect(getCalibration()).toEqual({
      ...ADULT_DEFAULT_CALIBRATION,
      fingerAngleDeg: 132,
      thumbAngleDeg: 128,
    });
  });

  it("merges partial updates over what is already stored", () => {
    setCalibration({ fingerAngleDeg: 132 });
    setCalibration({ ambiguityBandDeg: 12 });
    const out = getCalibration();
    expect(out.fingerAngleDeg).toBe(132);
    expect(out.ambiguityBandDeg).toBe(12);
  });

  it("stores nothing but numbers (no PII may ever land here)", () => {
    setCalibration({ fingerAngleDeg: 132 });
    const raw = globalThis.localStorage.getItem(CALIBRATION_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed: unknown = JSON.parse(raw ?? "{}");
    expect(parsed).toBeTypeOf("object");
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      expect(typeof value).toBe("number");
    }
  });

  it("clamps values that are out of range", () => {
    const out = setCalibration({ fingerAngleDeg: 400, ambiguityBandDeg: -9 });
    expect(out.fingerAngleDeg).toBe(179);
    expect(out.ambiguityBandDeg).toBe(0);
  });

  it("ignores non-numeric junk and keeps the previous value", () => {
    setCalibration({ fingerAngleDeg: 132 });
    const out = setCalibration({ fingerAngleDeg: Number.NaN });
    expect(out.fingerAngleDeg).toBe(132);
  });

  it("falls back to defaults on a corrupt entry", () => {
    globalThis.localStorage.setItem(CALIBRATION_STORAGE_KEY, "{not json");
    expect(getCalibration()).toEqual(ADULT_DEFAULT_CALIBRATION);
  });

  it("clears back to the defaults", () => {
    setCalibration({ fingerAngleDeg: 132 });
    clearCalibration();
    expect(getCalibration()).toEqual(ADULT_DEFAULT_CALIBRATION);
  });

  it("survives having no storage at all", () => {
    Reflect.deleteProperty(globalThis, "localStorage");
    expect(getCalibration()).toEqual(ADULT_DEFAULT_CALIBRATION);
    expect(setCalibration({ fingerAngleDeg: 140 }).fingerAngleDeg).toBe(140);
    expect(() => {
      clearCalibration();
    }).not.toThrow();
  });

  it("feeds straight into the counter", () => {
    setCalibration({ fingerAngleDeg: 125 });
    const hand = buildHand({ index: 138, middle: 141 });
    const landmarks: readonly Landmark[] = hand;
    expect(countExtendedFingers(landmarks, getCalibration()).total).toBe(2);
  });
});
