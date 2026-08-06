// The colour lens: keep one colour, drain the rest.
//
// This is the flagship of the magic window, because it turns "find something
// ఎరుపు" from a picture on a screen into a hunt around the child's own room.
// The child sweeps their hand-window across the sofa and the one red cushion
// lights up inside it.
//
// WHY CANVAS 2D AND NOT A WEBGL SHADER
// A one-pass fragment shader is the textbook answer and it is genuinely nicer
// for full-screen work. It loses here for two reasons:
//   1. The activity needs a COVERAGE number ("did the child find it?"), and
//      that means reading pixels back. On the GPU that is a `readPixels` stall
//      on the very frame we are trying to keep under budget; on the CPU the
//      pixels are already in hand. So the CPU pass has to exist either way, and
//      a shader would be a second, unverifiable copy of the same maths.
//   2. The window is SMALL — a 5-year-old's pinch is a few percent of the
//      stage. We only ever touch the quad's bounding box, downsampled to
//      LENS_SAMPLE_MAX on its long side. That is ~9k pixels, not 2M.
// Measured cost of `lensPass` at 96x96 is in the PR notes.
//
// INVARIANT (architecture §9): these pixels come from the local <video> sink,
// live in one transient buffer for one frame, and are never stored, never
// re-read, and never transmitted. The app's CSP (`connect-src 'self'`) makes
// the last part structurally impossible, not merely intended.

import type { Point } from "../vision/stability";

/** The colours a hunt can ask for. Kid-facing names live in i18n, not here. */
export type HuntColour = "red" | "green" | "yellow" | "blue";

export interface ColourTarget {
  /** Hue centre in degrees. */
  readonly hue: number;
  /** Half-width of the accepted hue band, in degrees. */
  readonly tolerance: number;
  /** Below this saturation everything is grey-ish and hue is meaningless. */
  readonly minSaturation: number;
  /** Below this value it is a shadow, and shadows have every hue. */
  readonly minValue: number;
}

/**
 * Deliberately NOT wide bands. Leniency is bought at the other end — with a low
 * COVERAGE_FOUND — because widening the hue band is how "red" starts matching
 * skin (hue ~20-30°, saturation 0.3-0.6 under warm light) and the child gets
 * told they found a red thing by pointing the window at their own hand. A tight
 * band plus a low bar means "some of the window is genuinely red" wins, and
 * "the window is full of hand" does not.
 *
 * These numbers are reasoned, not measured against real rooms — nobody has run
 * this against a camera yet. That is the first thing to tune on real footage.
 */
export const HUNT_COLOURS: Readonly<Record<HuntColour, ColourTarget>> = Object.freeze({
  // Red's saturation floor is the highest of the four on purpose: warm skin
  // sits at hue 15-25° with saturation 0.42-0.44, close enough that a looser
  // red would congratulate a child for pointing the window at their own hand.
  red: { hue: 0, tolerance: 16, minSaturation: 0.5, minValue: 0.15 },
  green: { hue: 120, tolerance: 45, minSaturation: 0.25, minValue: 0.12 },
  yellow: { hue: 52, tolerance: 16, minSaturation: 0.4, minValue: 0.25 },
  blue: { hue: 215, tolerance: 40, minSaturation: 0.25, minValue: 0.12 },
});

/**
 * The colour a hunt's TAP ANSWER is painted with, one per target.
 *
 * These are not decoration and they are not from the kid palette — the kid
 * palette is warm and muted by design (rose, leaf, marigold), and a muted pink
 * standing in for "red" would make the tap answer teach the wrong word. A
 * colour game's swatch has to be the colour.
 *
 * Every one of these sits INSIDE its own band above, which is the invariant
 * that matters and is asserted in the tests: the swatch a child taps and the
 * pixels the lens will accept are the same claim about what "ఎరుపు" means. If
 * the bands are ever retuned against real footage, these move with them.
 *
 * None of them is teal (#2f8f86, hue ~174). Teal means "Chiku is hearing you"
 * (§9) and may not become a thing a child hunts for.
 */
export const HUNT_SWATCH: Readonly<Record<HuntColour, string>> = Object.freeze({
  red: "#d92d20", // hue 4
  green: "#2f9e44", // hue 131
  yellow: "#f2c200", // hue 48
  blue: "#1f6fd0", // hue 213
});

/** Every hunt target, in the order a round rotates through them. */
export const HUNT_ORDER: readonly HuntColour[] = Object.freeze([
  "red",
  "green",
  "yellow",
  "blue",
]) as readonly HuntColour[];

/**
 * How much of the window has to be the colour before the activity may say yes.
 *
 * 12%. A child holding a wobbling hand-frame roughly over a red cup, at arm's
 * length, with their own fingers eating the edges of the window, will not get
 * half the pixels. They should still succeed — the skill being practised is
 * "which one is red", not "aim".
 */
export const COVERAGE_FOUND = 0.12;

export function foundTarget(coverage: number): boolean {
  return coverage >= COVERAGE_FOUND;
}

/** The longest side, in pixels, the lens ever samples. See the header. */
export const LENS_SAMPLE_MAX = 96;

/** Circular distance between two hues, 0..180. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

export interface Hsv {
  /** 0..360; 0 when the pixel has no meaningful hue. */
  readonly h: number;
  readonly s: number;
  readonly v: number;
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max / 255;
  const chroma = max - min;
  if (chroma === 0 || max === 0) return { h: 0, s: 0, v };
  let h: number;
  if (max === r) h = 60 * (((g - b) / chroma) % 6);
  else if (max === g) h = 60 * ((b - r) / chroma + 2);
  else h = 60 * ((r - g) / chroma + 4);
  if (h < 0) h += 360;
  return { h, s: chroma / max, v };
}

export function matchesTarget(r: number, g: number, b: number, target: ColourTarget): boolean {
  const { h, s, v } = rgbToHsv(r, g, b);
  if (s < target.minSaturation || v < target.minValue) return false;
  return hueDistance(h, target.hue) <= target.tolerance;
}

/** A mutable RGBA buffer, shaped like ImageData but not requiring the class. */
export interface LensSample {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** Even-odd ray cast. Four vertices, so cost is irrelevant. */
export function insidePolygon(poly: readonly Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a === undefined || b === undefined) continue;
    const straddles = a.y > y !== b.y > y;
    if (!straddles) continue;
    const cut = ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (x < cut) inside = !inside;
  }
  return inside;
}

export interface LensResult {
  /** Matched / inside, 0..1. Zero when the window covers nothing. */
  readonly coverage: number;
  readonly matched: number;
  readonly inside: number;
}

/**
 * Drain everything that is not the target colour, in place.
 *
 * `poly` is in the sample buffer's own pixel coordinates. Pixels outside it get
 * alpha 0 so the caller can blit the whole rect without relying on the clip
 * having worked; pixels inside that miss go to luma grey; pixels that match are
 * left exactly as the camera saw them, which is what makes the red cushion look
 * like it is glowing.
 */
export function lensPass(sample: LensSample, poly: readonly Point[], target: ColourTarget): LensResult {
  const { data, width, height } = sample;
  let matched = 0;
  let inside = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      if (!insidePolygon(poly, x + 0.5, y + 0.5)) {
        data[i + 3] = 0;
        continue;
      }
      inside += 1;
      if (matchesTarget(r, g, b, target)) {
        matched += 1;
        continue;
      }
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      data[i] = luma;
      data[i + 1] = luma;
      data[i + 2] = luma;
    }
  }
  return { coverage: inside === 0 ? 0 : matched / inside, matched, inside };
}

/** Sample dimensions for a region of `w x h` source pixels, long side capped. */
export function sampleSize(w: number, h: number, max = LENS_SAMPLE_MAX): Box2 {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

interface Box2 {
  readonly width: number;
  readonly height: number;
}
