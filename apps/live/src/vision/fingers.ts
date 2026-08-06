/**
 * Finger counting — pure maths over MediaPipe hand landmarks.
 *
 * No MediaPipe import here on purpose: the counting logic is the part that has
 * to be right, so it must be unit-testable without a WASM runtime.
 *
 * WHY ANGLES AND NOT DISTANCES
 * ----------------------------
 * The heuristic every tutorial reaches for — "the tip is further from the wrist
 * than the PIP joint, therefore the finger is extended" — is wrong for a hand
 * held at any angle to the camera. A finger curled forward, toward the lens,
 * still projects a tip that sits further from the wrist in image space. It was
 * measured to overcount by one on 3 of 5 real hands. It is not used here.
 *
 * Instead each of index/middle/ring/pinky is scored by the interior angle at
 * its PIP joint, measured MCP -> PIP -> TIP. Straight finger ~180deg, curled
 * finger tends to 0deg. The angle is computed in 3D (MediaPipe supplies a z),
 * which makes it largely invariant to how the hand is rotated.
 *
 * The thumb gets its own test. A fixed abduction ratio (thumb-tip distance over
 * palm width) measured 0.40 on genuinely open palms and 0.85 on thumbs-up, so a
 * distance ratio conflates "thumb splayed sideways" with "thumb extended" and
 * cannot separate them. The thumb is therefore scored by its own joint angles:
 * CMC -> MCP -> IP and MCP -> IP -> TIP, taking the tighter of the two.
 *
 * CALIBRATION
 * -----------
 * The thresholds below are ADULT-DERIVED. There is no published child-hand
 * training data for this model, and a five-year-old's fingers are shorter,
 * fatter and rarely straighten fully — expect the defaults to under-count on
 * small hands. `calibration.ts` stores a per-child override; run a calibration
 * pass ("show me five!") before trusting a count on a new child.
 *
 * HYSTERESIS
 * ----------
 * A finger used to flip at exactly the threshold, so a held-up finger measuring
 * 149 / 151 / 150 / 149 flickered extended/curled/extended and the count with
 * it. Strict to acquire, loose to keep: a finger becomes extended above the
 * threshold and stays extended until it falls a further `hysteresisDeg` below
 * it (150 -> 142 by default). This also shrinks the second-order damage: the
 * ambiguity band is measured against whichever threshold is currently ACTIVE,
 * so a steady finger at 145 is no longer "within 8deg of the boundary", no
 * longer makes the hand unscoreable, and no longer feeds a null into the hold.
 *
 * Hysteresis needs the previous frame, which the pure function does not have;
 * callers pass it in (`previous`), or use `StableHandCount` which holds it.
 */

import { DEFAULT_LOST_FRAMES } from "./stability";

/** A landmark in normalized image space. `z` is optional so fixtures stay 2D. */
export interface Landmark {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
}

/* -------------------------------------------------------------------------- */
/* Landmark indices (MediaPipe hand topology, 21 points)                      */
/* -------------------------------------------------------------------------- */

export const WRIST = 0;

/** thumb: CMC, MCP, IP, TIP */
const THUMB = [1, 2, 3, 4] as const;
/** the four fingers: [MCP, PIP, DIP, TIP] */
const FINGERS = [
  [5, 6, 7, 8], // index
  [9, 10, 11, 12], // middle
  [13, 14, 15, 16], // ring
  [17, 18, 19, 20], // pinky
] as const;

export const HAND_LANDMARK_COUNT = 21;

/* -------------------------------------------------------------------------- */
/* Thresholds — ADULT-DERIVED. See the calibration note in the file header.    */
/* -------------------------------------------------------------------------- */

/**
 * PIP interior angle (MCP-PIP-TIP) above which index/middle/ring/pinky counts
 * as extended. ADULT-DERIVED — needs a per-child calibration pass.
 */
export const FINGER_EXTENDED_MIN_ANGLE_DEG = 150;

/**
 * Minimum of the thumb's two joint angles (CMC-MCP-IP and MCP-IP-TIP) above
 * which the thumb counts as extended. ADULT-DERIVED — needs a per-child
 * calibration pass; small thumbs sit lower even when fully out.
 */
export const THUMB_EXTENDED_MIN_ANGLE_DEG = 150;

/**
 * Half-width of the "I genuinely cannot tell" band around a threshold, in
 * degrees. A finger inside the band is neither confidently extended nor
 * confidently curled. ADULT-DERIVED.
 */
export const AMBIGUITY_BAND_DEG = 8;

/**
 * How many fingers may sit inside the ambiguity band before the whole hand is
 * reported as unscoreable. A wrong confident answer ("you showed four!" when
 * the child showed three) is worse for a 5-year-old than Chiku saying he
 * didn't quite see it, so this is deliberately strict.
 */
export const MAX_AMBIGUOUS_FINGERS = 1;

/**
 * How far below its threshold an ALREADY-EXTENDED finger may fall before it
 * counts as curled again. 8deg, matching the ambiguity band: the whole width of
 * "I cannot tell" is exactly the width we refuse to change our mind over.
 * ADULT-DERIVED like the rest, and applied relative to whatever threshold
 * calibration supplies, so a per-child pass keeps working unchanged.
 */
export const FINGER_HYSTERESIS_DEG = 8;

/** Where a finger already believed extended lets go. 150 - 8 = 142. */
export const FINGER_EXTENDED_RELEASE_ANGLE_DEG =
  FINGER_EXTENDED_MIN_ANGLE_DEG - FINGER_HYSTERESIS_DEG;
/** Same, for the thumb's tighter joint angle. */
export const THUMB_EXTENDED_RELEASE_ANGLE_DEG =
  THUMB_EXTENDED_MIN_ANGLE_DEG - FINGER_HYSTERESIS_DEG;

/**
 * Deliberately NOT a field on FingerThresholds: `calibration.ts` derives its
 * bounds table from `keyof FingerThresholds`, and it stores exactly the four
 * numbers a calibration pass measures. The hysteresis is a property of the
 * detector, not of the child's hand, so it is a constant here and the release
 * angle is always `calibrated threshold - FINGER_HYSTERESIS_DEG` — a per-child
 * override of `fingerAngleDeg` moves both ends of the band together, which is
 * what you want.
 */
export interface FingerThresholds {
  readonly fingerAngleDeg: number;
  readonly thumbAngleDeg: number;
  readonly ambiguityBandDeg: number;
  readonly maxAmbiguousFingers: number;
}

export const ADULT_THRESHOLDS: FingerThresholds = Object.freeze({
  fingerAngleDeg: FINGER_EXTENDED_MIN_ANGLE_DEG,
  thumbAngleDeg: THUMB_EXTENDED_MIN_ANGLE_DEG,
  ambiguityBandDeg: AMBIGUITY_BAND_DEG,
  maxAmbiguousFingers: MAX_AMBIGUOUS_FINGERS,
});

/**
 * Floor for a relaxed angle threshold. Matches `CALIBRATION_BOUNDS` in
 * `calibration.ts`: below about 90deg a "finger" is a right angle, and calling
 * that extended would make Chiku congratulate a fist.
 */
export const MIN_ANGLE_THRESHOLD_DEG = 90;

/**
 * Meet a wobbly hand halfway.
 *
 * The assist ladder hands down a number of degrees (see `relaxFor` in
 * `activities/assist.ts`) after a child has missed twice, and this is where
 * that number becomes a detector change: both angle thresholds come down, so a
 * finger a small hand cannot straighten past 140deg starts counting, and one
 * more finger is allowed to sit inside the ambiguity band before the whole
 * hand is written off as unscoreable — the "I couldn't tell" that a struggling
 * child hits most often and that costs them the most.
 *
 * It is a relaxation, not a surrender: the bands narrow toward each other, they
 * do not disappear, and the child is never told any of this happened. Being
 * visibly handed an easier version is a small humiliation, and they did not
 * ask for one.
 *
 * Pure, and the identity when `angleRelaxDeg` is zero or nonsense — so the
 * "none" and "watch" rungs are provably the shipped detector.
 */
export function relaxThresholds(
  base: FingerThresholds,
  angleRelaxDeg: number,
): FingerThresholds {
  if (!Number.isFinite(angleRelaxDeg) || angleRelaxDeg <= 0) return base;
  return {
    fingerAngleDeg: Math.max(MIN_ANGLE_THRESHOLD_DEG, base.fingerAngleDeg - angleRelaxDeg),
    thumbAngleDeg: Math.max(MIN_ANGLE_THRESHOLD_DEG, base.thumbAngleDeg - angleRelaxDeg),
    ambiguityBandDeg: base.ambiguityBandDeg,
    maxAmbiguousFingers: Math.min(5, base.maxAmbiguousFingers + 1),
  };
}

/* -------------------------------------------------------------------------- */
/* Result                                                                     */
/* -------------------------------------------------------------------------- */

export type FiveBooleans = readonly [boolean, boolean, boolean, boolean, boolean];
export type FiveNumbers = readonly [number, number, number, number, number];

export interface HandCount {
  /** Per-finger extension, thumb first. Best guess even when `total` is null. */
  readonly extended: FiveBooleans;
  /** 0..5, or null when the hand is too ambiguous to answer honestly. */
  readonly total: number | null;
  /** The measured joint angles in degrees, thumb first — for calibration UI. */
  readonly anglesDeg: FiveNumbers;
  /** How many fingers landed inside the ambiguity band. */
  readonly ambiguousCount: number;
}

const UNSCOREABLE: HandCount = Object.freeze({
  extended: [false, false, false, false, false] as FiveBooleans,
  total: null,
  anglesDeg: [0, 0, 0, 0, 0] as FiveNumbers,
  ambiguousCount: HAND_LANDMARK_COUNT,
});

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Interior angle at `b` in the path a -> b -> c, in degrees (0..180).
 * 3D when the landmarks carry z, planar otherwise.
 */
export function angleAtDeg(a: Landmark, b: Landmark, c: Landmark): number {
  const ax = a.x - b.x;
  const ay = a.y - b.y;
  const az = (a.z ?? 0) - (b.z ?? 0);
  const cx = c.x - b.x;
  const cy = c.y - b.y;
  const cz = (c.z ?? 0) - (b.z ?? 0);

  const na = Math.sqrt(ax * ax + ay * ay + az * az);
  const nc = Math.sqrt(cx * cx + cy * cy + cz * cz);
  if (na === 0 || nc === 0) return 0;

  const cos = (ax * cx + ay * cy + az * cz) / (na * nc);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/* -------------------------------------------------------------------------- */
/* Counting                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Score one hand. Pure: same landmarks (and same `previous`) in, same answer
 * out — the hysteresis state is a parameter, never a hidden field.
 *
 * Returns `total: null` when more than `maxAmbiguousFingers` joints sit within
 * `ambiguityBandDeg` of their ACTIVE threshold, or when the landmark array is
 * not a complete hand. `extended` still carries the best guess so a debug
 * overlay can show what the engine nearly decided.
 *
 * `previous` is last frame's `extended`. Omit it and the function behaves
 * exactly as it did before hysteresis existed (every finger judged against the
 * strict threshold), which is what makes it safe to call from a cold start.
 */
export function countExtendedFingers(
  landmarks: readonly Landmark[] | undefined | null,
  thresholds: FingerThresholds = ADULT_THRESHOLDS,
  previous?: FiveBooleans | null,
): HandCount {
  if (!landmarks || landmarks.length < HAND_LANDMARK_COUNT) return UNSCOREABLE;

  const thumb = measureThumb(landmarks);
  if (thumb === null) return UNSCOREABLE;

  const angles: number[] = [thumb];
  for (const finger of FINGERS) {
    const a = measureFinger(landmarks, finger);
    if (a === null) return UNSCOREABLE;
    angles.push(a);
  }

  const extended: boolean[] = [];
  let ambiguousCount = 0;
  let total = 0;

  for (let i = 0; i < 5; i += 1) {
    const angle = angles[i] ?? 0;
    const enter = i === 0 ? thresholds.thumbAngleDeg : thresholds.fingerAngleDeg;
    // Already extended? Judge against the release angle instead — and measure
    // ambiguity against that same active boundary, so the band travels with the
    // decision rather than parking on top of a finger we already believe in.
    const wasExtended = previous?.[i] ?? false;
    const active = wasExtended ? enter - FINGER_HYSTERESIS_DEG : enter;
    const isExtended = angle > active;
    if (Math.abs(angle - active) < thresholds.ambiguityBandDeg) ambiguousCount += 1;
    extended.push(isExtended);
    if (isExtended) total += 1;
  }

  return {
    extended: extended as unknown as FiveBooleans,
    total: ambiguousCount > thresholds.maxAmbiguousFingers ? null : total,
    anglesDeg: angles as unknown as FiveNumbers,
    ambiguousCount,
  };
}

/** MCP -> PIP -> TIP. Deliberately skips the DIP: it adds noise, not signal. */
function measureFinger(
  landmarks: readonly Landmark[],
  finger: readonly [number, number, number, number],
): number | null {
  const mcp = landmarks[finger[0]];
  const pip = landmarks[finger[1]];
  const tip = landmarks[finger[3]];
  if (!mcp || !pip || !tip) return null;
  return angleAtDeg(mcp, pip, tip);
}

/**
 * The thumb's own test: the tighter of its two joint angles. A thumb folded
 * across the palm bends at the IP even when the MCP looks open, so taking the
 * minimum is what separates a fist from a thumbs-up.
 */
function measureThumb(landmarks: readonly Landmark[]): number | null {
  const cmc = landmarks[THUMB[0]];
  const mcp = landmarks[THUMB[1]];
  const ip = landmarks[THUMB[2]];
  const tip = landmarks[THUMB[3]];
  if (!cmc || !mcp || !ip || !tip) return null;
  return Math.min(angleAtDeg(cmc, mcp, ip), angleAtDeg(mcp, ip, tip));
}

/**
 * Open palm for the purposes of wave detection: the four fingers are out. The
 * thumb is ignored on purpose — children wave with a floppy thumb and requiring
 * it made waves go unnoticed.
 */
export function isOpenPalm(
  landmarks: readonly Landmark[] | undefined | null,
  thresholds: FingerThresholds = ADULT_THRESHOLDS,
  previous?: FiveBooleans | null,
): boolean {
  const count = countExtendedFingers(landmarks, thresholds, previous);
  return count.extended[1] && count.extended[2] && count.extended[3] && count.extended[4];
}

/**
 * `countExtendedFingers` with the one frame of memory hysteresis needs, kept
 * per hand by the caller. One instance per tracked hand — sharing one across
 * two hands would let the left hand's fingers hold the right hand's open.
 *
 * A hand that cannot be measured at all (missing or incomplete landmarks) does
 * not overwrite the memory: that is a tracker dropout, not the child curling
 * their fingers, and the same lost-frame budget the rest of the forgiveness
 * layer uses applies before we forget what we saw.
 */
export class StableHandCount {
  #previous: FiveBooleans | null = null;
  #lost = 0;

  constructor(private readonly maxLostFrames: number = DEFAULT_LOST_FRAMES) {}

  count(
    landmarks: readonly Landmark[] | undefined | null,
    thresholds: FingerThresholds = ADULT_THRESHOLDS,
  ): HandCount {
    const result = countExtendedFingers(landmarks, thresholds, this.#previous);
    if (result === UNSCOREABLE) {
      this.#lost += 1;
      if (this.#lost > this.maxLostFrames) this.#previous = null;
      return result;
    }
    this.#lost = 0;
    this.#previous = result.extended;
    return result;
  }

  reset(): void {
    this.#previous = null;
    this.#lost = 0;
  }
}
