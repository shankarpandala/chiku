// The magic window: a stabilized screen-space quad the child makes with their
// hands, and the thing this whole app borrowed from
// github.com/sophiamyang/finger-frame-effect-lucy.
//
// What that project actually contributes is not its AI video — it is the
// stabilization stack that makes a hand-made frame feel SOLID instead of
// twitching. We already ported those primitives in Phase 1 (stability.ts);
// this applies them to a quad.
//
// THE GRADED LADDER, which the reference does not have and a kids' app needs.
// The two-handed "director's frame" demands bilateral coordination that a
// 3-year-old simply does not have yet — asking for it would make the youngest
// band fail at the input before they ever reach the learning. So there are
// three ways to make a window, and the app should accept whichever the child
// can do:
//
//   PALM   (3-4)  one open palm — a round window centred on the palm
//   PINCH  (5-6)  one hand's thumb+index — a small frame, one-handed
//   FRAME  (7-8)  both hands, the reference's own gesture
//
// Detection is deliberately lenient on EXIT and strict on ENTRY (the
// reference's 0.75-in / 0.2-out asymmetry), and looser still than the
// reference on exit, because an excited child's pose degrades the instant
// something interesting happens inside their window.

import { distance, type Point } from "./stability";

/** Which gesture made this window. Also tells the UI how to draw it. */
export type QuadKind = "palm" | "pinch" | "frame";

/**
 * Four corners in normalized image space (0..1), clockwise from top-left as
 * the CHILD sees it. For "palm" the quad is the square bounding the circle,
 * so consumers can treat all three kinds uniformly.
 */
export interface Quad {
  readonly kind: QuadKind;
  readonly corners: readonly [Point, Point, Point, Point];
  /** Centre, precomputed — every consumer wants it. */
  readonly centre: Point;
  /** 0..1 confidence/fade. Drives opacity so the window never pops. */
  readonly presence: number;
}

/** MediaPipe hand-landmark indices this module cares about. */
export const LM = {
  wrist: 0,
  thumbTip: 4,
  indexMcp: 5,
  indexTip: 8,
  middleMcp: 9,
  middleTip: 12,
  ringTip: 16,
  pinkyMcp: 17,
  pinkyTip: 20,
} as const;

/**
 * Acquire/keep thresholds, mirroring the reference's asymmetry.
 *
 * `enter` values are what it takes to START a window; `exit` values are the
 * (much looser) bar to KEEP one. The reference uses 0.75 -> 0.2 on spread and
 * 0.005 -> 0.0005 on area; ours are in the same spirit, scaled to hand size
 * rather than canvas size so they work at any distance from the camera.
 */
export const QUAD_THRESHOLDS = {
  /** thumb-index spread as a multiple of hand scale, for pinch/frame. */
  spreadEnter: 0.75,
  spreadExit: 0.2,
  /** quad area as a fraction of the frame. */
  areaEnter: 0.005,
  areaExit: 0.0005,
  /** how open a palm must be to count as a palm window. */
  palmEnter: 0.8,
  palmExit: 0.35,
} as const;

/** Hand scale: wrist→middle-MCP, the reference's own yardstick. */
export function handScale(lm: readonly Point[]): number {
  const wrist = lm[LM.wrist];
  const mid = lm[LM.middleMcp];
  if (wrist === undefined || mid === undefined) return 0;
  return distance(wrist, mid);
}

/** Shoelace area of a polygon in normalized units. */
export function polygonArea(pts: readonly Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    if (p === undefined || q === undefined) continue;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function quadCentre(corners: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const c of corners) {
    x += c.x;
    y += c.y;
  }
  const n = Math.max(1, corners.length);
  return { x: x / n, y: y / n };
}

/** Axis-aligned square around a centre, used for the palm window. */
export function squareAround(centre: Point, half: number): [Point, Point, Point, Point] {
  return [
    { x: centre.x - half, y: centre.y - half },
    { x: centre.x + half, y: centre.y - half },
    { x: centre.x + half, y: centre.y + half },
    { x: centre.x - half, y: centre.y + half },
  ];
}

/**
 * Two-hand frame corners, in the reference's anatomical cycle:
 * [A.index, B.index, B.thumb, A.thumb] traces a rectangle when both hands
 * hold the standard pose (index up, thumb across). A and B are ordered by
 * wrist x so the cycle is stable as the child moves.
 */
export function frameCorners(
  a: readonly Point[],
  b: readonly Point[],
): [Point, Point, Point, Point] | null {
  const ai = a[LM.indexTip];
  const at = a[LM.thumbTip];
  const bi = b[LM.indexTip];
  const bt = b[LM.thumbTip];
  if (ai === undefined || at === undefined || bi === undefined || bt === undefined) return null;
  return [ai, bi, bt, at];
}

/** One hand's thumb/index pinch box. */
export function pinchCorners(lm: readonly Point[]): [Point, Point, Point, Point] | null {
  const tip = lm[LM.indexTip];
  const thumb = lm[LM.thumbTip];
  if (tip === undefined || thumb === undefined) return null;
  const centre = { x: (tip.x + thumb.x) / 2, y: (tip.y + thumb.y) / 2 };
  const half = distance(tip, thumb) / 2;
  return squareAround(centre, Math.max(half, 0.02));
}
