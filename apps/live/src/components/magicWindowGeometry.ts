// Where the magic window actually lands on the glass.
//
// THE ONE BUG THAT MATTERS. The <video> is CSS-mirrored (`.stage-video {
// transform: scaleX(-1) }`) so a child raising their right hand sees it on
// their right. The quad from vision/quad.ts is in RAW image space, unmirrored,
// exactly like FaceSignal.x. So every x has to be flipped before it is drawn,
// or the window slides the wrong way under the child's own hands — which is
// not a cosmetic bug, it is the single most disorienting thing this feature
// could do. Hence: one function does the flip, it is pure, and it is tested.
//
// The second half is object-fit. The video fills the stage with `object-fit:
// cover`, so normalized 0..1 image space does NOT map to the element box
// unless the aspect ratios happen to match — on a 4:3 stage showing a 16:9
// camera the left and right of the image are cropped away, and an overlay that
// ignores that is wrong by ~12% of the width at the edges. `coverRect`
// reproduces the browser's own cover maths so the two agree.

import type { Point } from "../vision/stability";
import type { Quad } from "../vision/quad";

export interface Box {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type Corners = readonly [Point, Point, Point, Point];

/**
 * The rect, in element coordinates, that the FULL source image maps onto under
 * `object-fit: cover`. It deliberately overflows the box on one axis — that is
 * what cover means, and the overflow is what the browser crops.
 *
 * `sourceAspect` is width/height. When it is unknown (0, NaN, no video yet) we
 * fall back to the box itself, i.e. a plain stretch: wrong in principle, but it
 * degrades to "slightly off" rather than "nothing renders".
 */
export function coverRect(sourceAspect: number, box: Box): Rect {
  const { width, height } = box;
  if (!Number.isFinite(sourceAspect) || sourceAspect <= 0 || width <= 0 || height <= 0) {
    return { x: 0, y: 0, width, height };
  }
  const boxAspect = width / height;
  if (sourceAspect > boxAspect) {
    // Source is wider than the box: fill the height, spill left and right.
    const w = height * sourceAspect;
    return { x: (width - w) / 2, y: 0, width: w, height };
  }
  const h = width / sourceAspect;
  return { x: 0, y: (height - h) / 2, width, height: h };
}

/** One normalized image-space point to element pixels, mirroring if asked. */
export function projectPoint(p: Point, rect: Rect, mirrored: boolean): Point {
  const u = mirrored ? 1 - p.x : p.x;
  return { x: rect.x + u * rect.width, y: rect.y + p.y * rect.height };
}

/**
 * All four corners. Mirroring reverses the winding order, which no consumer
 * here cares about (fill and clip are winding-agnostic for a simple quad).
 */
export function projectQuad(corners: Corners, rect: Rect, mirrored: boolean): Corners {
  return [
    projectPoint(corners[0], rect, mirrored),
    projectPoint(corners[1], rect, mirrored),
    projectPoint(corners[2], rect, mirrored),
    projectPoint(corners[3], rect, mirrored),
  ];
}

export function boundsOf(pts: Corners): Rect {
  const xs = [pts[0].x, pts[1].x, pts[2].x, pts[3].x];
  const ys = [pts[0].y, pts[1].y, pts[2].y, pts[3].y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function centreOf(pts: Corners): Point {
  return {
    x: (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4,
    y: (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4,
  };
}

/** Scale a quad about its own centre (the sticker's breath). */
export function scaleAbout(pts: Corners, centre: Point, k: number): Corners {
  const s = (p: Point): Point => ({
    x: centre.x + (p.x - centre.x) * k,
    y: centre.y + (p.y - centre.y) * k,
  });
  return [s(pts[0]), s(pts[1]), s(pts[2]), s(pts[3])];
}

/** `"12.0,34.5 …"` — the drawn geometry, exposed for tests and for debugging. */
export function pointsAttr(pts: Corners): string {
  return pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

/**
 * Where Chiku should look so he is looking THROUGH the window with the child.
 *
 * Returns rig gaze space (-1..+1, x positive right on the MIRRORED picture),
 * i.e. already flipped the same way CameraStage flips FaceSignal.x. A window at
 * raw x=0.1 is on the child's right on screen, so gaze x is +0.8.
 */
export function quadGaze(quad: Quad): { x: number; y: number } {
  return { x: 1 - 2 * quad.centre.x, y: 2 * quad.centre.y - 1 };
}

/** Presence straight through: the fade already happened in stability.ts. */
export function windowOpacity(presence: number): number {
  if (!Number.isFinite(presence)) return 0;
  return Math.min(1, Math.max(0, presence));
}

/** Below this the window is a hint of itself; Chiku does not look through it yet. */
export const WINDOW_GAZE_PRESENCE = 0.5;

export const STICKER_BREATH_MS = 2600;
export const STICKER_BREATH = 0.03;

/**
 * The sticker breathes, by 3%, once every 2.6s — enough to read as alive, small
 * enough not to fight the hand holding it. Under reduced motion it is exactly 1
 * forever: the window still FOLLOWS the child's hands (that is their motion,
 * not ours) but nothing moves on its own.
 */
export function stickerScale(nowMs: number, reducedMotion: boolean): number {
  if (reducedMotion || !Number.isFinite(nowMs)) return 1;
  return 1 + STICKER_BREATH * Math.sin((nowMs / STICKER_BREATH_MS) * Math.PI * 2);
}
