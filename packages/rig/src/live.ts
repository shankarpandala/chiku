// The LIVE rig — a second renderer for the realtime "Chiku is here with you"
// surface. It shares all art data with the episode rig (data.ts: MOUTHS,
// TRUNKS, the emote table, the palette) but differs in one decisive way:
//
//   render.ts REBUILDS the whole SVG per call — correct and simple for the
//   episode player, which repaints a few times a second. This module builds
//   the scene ONCE, caches every node it will ever touch, and per frame writes
//   only attributes. That makes 60fps procedural motion affordable and lets
//   CSS/inline animations survive across frames.
//
// What "alive" is made of here, in order of how much it sells presence:
//   1. gaze — the eyes (and, slightly, the head) track where the child is
//   2. reaction — emote/viseme changes arrive as smoothed targets, never snaps
//   3. secondary motion — breathing, idle sway, ear follow-through, saccades
//
// Every numeric constant that describes the character is derived from the
// canonical export values in data.ts (the discrete GAZE_FRONT/GAZE_UP anchors
// become a continuous range with the same extents). Nothing is eyeballed.

import {
  ARC_EYE_PATHS,
  EMOTES,
  HAIR_PATHS,
  HEAD_PATH,
  MOUTHS,
  PALETTE,
  TRUNKS,
  type TrunkPose,
} from "./data";
import type { Emote, Viseme } from "./types";

/** Pupil/glint travel at full gaze deflection — the export's own look offsets. */
const GAZE_PUPIL_X = 6;
const GAZE_PUPIL_Y = 7;
const GAZE_GLINT_X = 6;
const GAZE_GLINT_Y = 5;
/** How much the head itself turns toward the gaze target (degrees at full). */
const GAZE_HEAD_DEG = 3.2;

/** Idle life. Frequencies are deliberately non-harmonic to avoid a metronome. */
const BREATH_HZ = 0.23;
const BREATH_SCALE = 0.012;
const SWAY_HZ = 0.087;
const SWAY_DEG = 1.15;
const SWAY_HZ2 = 0.211;
const SWAY_DEG2 = 0.4;

const BLINK_MIN_MS = 3000;
const BLINK_MAX_MS = 6000;
const BLINK_CLOSED_MS = 120;

/** Saccade: tiny involuntary gaze flicks while attending. */
const SACCADE_MIN_MS = 900;
const SACCADE_MAX_MS = 2600;
const SACCADE_MAG = 0.14;

/** Exponential smoothing half-lives (ms) — lower is snappier. */
const HALFLIFE_GAZE = 90;
const HALFLIFE_POSE = 160;
const HALFLIFE_MOUTH = 45;

/* -------------------------------------------------------------------------- */
/* Demonstration beats — Chiku doing the exercise                             */
/* -------------------------------------------------------------------------- */

/**
 * A movement Chiku can DO, so a child can copy it.
 *
 * IMITATION IS THE INSTRUCTION. The youngest child this rig has to serve is
 * pre-verbal: nothing may depend on them hearing a word, reading one, or
 * understanding a request. The only instruction that works is Chiku performing
 * the movement himself, big enough and slow enough to be read and copied.
 *
 * The union deliberately matches the vision layer's `MovementKind` name for
 * name, so "what Chiku did" and "what the child did" are the same vocabulary.
 * It is restated rather than imported because this package is framework- and
 * app-agnostic and must not depend on apps/live.
 */
export type PerformMove = "jump" | "stomp" | "crouch" | "sway" | "reach" | "clap" | "swing";

/**
 * A keyframe track: `[progress 0..1, value]`, eased between adjacent keys.
 *
 * Keys, not formulas, because the shape of each beat is a choreography
 * decision — where the anticipation sits, how long the hold is — and it should
 * be legible as one line of numbers rather than buried in trigonometry.
 */
type Track = ReadonlyArray<readonly [at: number, value: number]>;

/** Smootherstep between keys: no corners, which is what reads as weight. */
function easeInOut(p: number): number {
  return p * p * (3 - 2 * p);
}

/** Value of a track at progress `p`. Tracks outside their range hold the end. */
function sampleTrack(track: Track, p: number): number {
  const first = track[0];
  if (first === undefined) return 0;
  if (p <= first[0]) return first[1];
  let prev = first;
  for (let i = 1; i < track.length; i += 1) {
    const key = track[i];
    if (key === undefined) break;
    if (p <= key[0]) {
      const span = key[0] - prev[0];
      const local = span <= 0 ? 1 : easeInOut((p - prev[0]) / span);
      return prev[1] + (key[1] - prev[1]) * local;
    }
    prev = key;
  }
  return prev[1];
}

/**
 * One beat of choreography.
 *
 * ELEPHANT RULES, which are also 2-year-old rules:
 *   - BIG. Amplitudes are a large fraction of the figure, not a nudge. A
 *     toddler copies a silhouette, not a detail.
 *   - SLOW. Every beat is over a second. Faster than that and they have not
 *     finished looking at it before it is gone.
 *   - ANTICIPATION. Every move begins with a small counter-movement — dip
 *     before rising, rise before dipping, lean away before leaning in. That
 *     counter-movement is what makes the move read as deliberate rather than a
 *     glitch, and it is also, conveniently, a warning that something is about
 *     to happen, which is how a small child gets time to look.
 *   - LAND HEAVY. Weight is sold on the way down: squash, then settle.
 */
interface MoveSpec {
  readonly durationMs: number;
  /** Whole-figure translation, viewBox units. Negative y is up. */
  readonly dx?: Track;
  readonly dy?: Track;
  /** Vertical scale about the feet; width compensates, so mass is conserved. */
  readonly squash?: Track;
  /** Whole-body lean, degrees, about the feet. */
  readonly lean?: Track;
  /** Extra trunk rotation, degrees, on top of the idle sway follow-through. */
  readonly trunk?: Track;
  /** Trunk path override for the whole beat (null → whatever the emote wants). */
  readonly trunkPose?: TrunkPose;
  /** Leg lift, viewBox units up from the hip. Only visible with `showBody`. */
  readonly legL?: Track;
  readonly legR?: Track;
  /** Ear flap, degrees, mirrored L/R. */
  readonly ears?: Track;
  /**
   * The progress a reduced-motion viewer is held at: the single frame that
   * most says what the movement is. Chiku holds this pose instead of moving.
   */
  readonly hold: number;
}

const MOVES: Record<PerformMove, MoveSpec> = {
  // Sink, spring, hang, land heavy, settle.
  jump: {
    durationMs: 1500,
    hold: 0.5,
    dy: [[0, 0], [0.3, 16], [0.42, -20], [0.52, -54], [0.62, -20], [0.74, 12], [0.88, -3], [1, 0]],
    squash: [[0, 1], [0.3, 0.88], [0.42, 1.1], [0.62, 1.06], [0.74, 0.86], [0.88, 1.03], [1, 1]],
    ears: [[0, 0], [0.3, -4], [0.52, 14], [0.74, -8], [1, 0]],
    trunk: [[0, 0], [0.3, 5], [0.52, -12], [0.78, 6], [1, 0]],
  },
  // Two of them, because one stomp is an event and two is a rhythm — and a
  // rhythm is the thing a 2-year-old joins in with.
  stomp: {
    durationMs: 2200,
    hold: 0.2,
    legR: [[0, 0], [0.16, 26], [0.3, 26], [0.38, 0], [1, 0]],
    legL: [[0, 0], [0.58, 0], [0.66, 26], [0.8, 26], [0.88, 0], [1, 0]],
    lean: [[0, 0], [0.16, -4], [0.38, 0], [0.66, 4], [0.88, 0], [1, 0]],
    dy: [[0, 0], [0.16, -6], [0.38, 10], [0.5, 0], [0.66, -6], [0.88, 10], [1, 0]],
    squash: [[0, 1], [0.38, 0.9], [0.5, 1], [0.88, 0.9], [1, 1]],
    ears: [[0, 0], [0.38, 12], [0.52, 0], [0.88, 12], [1, 0]],
  },
  // Rise a little first (anticipation), then sink low and STAY there — the hold
  // is the whole point, so a child has time to get down there too.
  crouch: {
    durationMs: 2400,
    hold: 0.5,
    dy: [[0, 0], [0.14, -8], [0.36, 34], [0.72, 34], [0.92, -4], [1, 0]],
    squash: [[0, 1], [0.14, 1.05], [0.36, 0.74], [0.72, 0.74], [0.92, 1.04], [1, 1]],
    trunk: [[0, 0], [0.36, 10], [0.72, 10], [1, 0]],
    ears: [[0, 0], [0.36, 8], [0.72, 8], [1, 0]],
  },
  // Lean away, then a long metronome the child can fall into step with.
  sway: {
    durationMs: 2800,
    hold: 0.3,
    lean: [[0, 0], [0.1, 3], [0.3, -11], [0.55, 11], [0.8, -11], [0.94, 3], [1, 0]],
    dx: [[0, 0], [0.1, 5], [0.3, -20], [0.55, 20], [0.8, -20], [0.94, 5], [1, 0]],
    ears: [[0, 0], [0.3, -12], [0.55, 12], [0.8, -12], [1, 0]],
    trunk: [[0, 0], [0.3, 14], [0.55, -14], [0.8, 14], [1, 0]],
  },
  // Dip, then stretch tall with the trunk lifted, and HOLD it up there.
  reach: {
    durationMs: 2000,
    hold: 0.55,
    trunkPose: "lift",
    dy: [[0, 0], [0.18, 14], [0.42, -26], [0.72, -26], [0.92, 4], [1, 0]],
    squash: [[0, 1], [0.18, 0.9], [0.42, 1.12], [0.72, 1.12], [0.92, 0.97], [1, 1]],
    trunk: [[0, 0], [0.18, 6], [0.42, -26], [0.72, -26], [1, 0]],
    ears: [[0, 0], [0.42, -10], [0.72, -10], [1, 0]],
  },
  // Chiku has no hands, so he claps with what he has: both ears swinging in
  // together, twice, with a bob on each beat. It is the RHYTHM that a toddler
  // copies with their hands, not the anatomy.
  clap: {
    durationMs: 1800,
    hold: 0.28,
    ears: [[0, 0], [0.12, -10], [0.28, 22], [0.44, -6], [0.62, 22], [0.8, -4], [1, 0]],
    dy: [[0, 0], [0.12, -6], [0.28, 8], [0.44, 0], [0.62, 8], [0.8, 0], [1, 0]],
    squash: [[0, 1], [0.28, 0.94], [0.44, 1], [0.62, 0.94], [1, 1]],
    trunk: [[0, 0], [0.28, -8], [0.62, -8], [1, 0]],
  },
  // The trunk itself, swinging. The body counter-rotates a little, which is
  // what stops it looking like a windscreen wiper bolted to a statue.
  swing: {
    durationMs: 2600,
    hold: 0.32,
    trunkPose: "wave",
    trunk: [[0, 0], [0.1, -8], [0.32, 30], [0.56, -30], [0.8, 30], [0.94, -6], [1, 0]],
    lean: [[0, 0], [0.32, -3], [0.56, 3], [0.8, -3], [1, 0]],
    dx: [[0, 0], [0.32, -6], [0.56, 6], [0.8, -6], [1, 0]],
    ears: [[0, 0], [0.32, 8], [0.56, -8], [0.8, 8], [1, 0]],
  },
};

/** Everything a beat can move, resolved for one instant. */
interface PerformPose {
  readonly dx: number;
  readonly dy: number;
  readonly squash: number;
  readonly lean: number;
  readonly trunk: number;
  readonly legL: number;
  readonly legR: number;
  readonly ears: number;
}

const REST_POSE: PerformPose = { dx: 0, dy: 0, squash: 1, lean: 0, trunk: 0, legL: 0, legR: 0, ears: 0 };

function poseAt(spec: MoveSpec, p: number): PerformPose {
  return {
    dx: spec.dx === undefined ? 0 : sampleTrack(spec.dx, p),
    dy: spec.dy === undefined ? 0 : sampleTrack(spec.dy, p),
    squash: spec.squash === undefined ? 1 : sampleTrack(spec.squash, p),
    lean: spec.lean === undefined ? 0 : sampleTrack(spec.lean, p),
    trunk: spec.trunk === undefined ? 0 : sampleTrack(spec.trunk, p),
    legL: spec.legL === undefined ? 0 : sampleTrack(spec.legL, p),
    legR: spec.legR === undefined ? 0 : sampleTrack(spec.legR, p),
    ears: spec.ears === undefined ? 0 : sampleTrack(spec.ears, p),
  };
}

function isResting(pose: PerformPose): boolean {
  return (
    pose.dx === 0 &&
    pose.dy === 0 &&
    pose.squash === 1 &&
    pose.lean === 0 &&
    pose.trunk === 0 &&
    pose.legL === 0 &&
    pose.legR === 0 &&
    pose.ears === 0
  );
}

/** Where the body pivots when it squashes and leans: the floor under his feet. */
const FLOOR_Y_BODY = 340;
const FLOOR_Y_HEAD = 236;

/** Numeric restatement of the per-emote pose values in data.ts EMOTES. */
interface NumericPose {
  readonly tiltDeg: number;
  readonly earLDeg: number;
  readonly earLScale: number;
  readonly earRDeg: number;
}

const POSES: Record<Emote, NumericPose> = {
  idle: { tiltDeg: 0, earLDeg: 0, earLScale: 1, earRDeg: 0 },
  listening: { tiltDeg: -5, earLDeg: -14, earLScale: 1.08, earRDeg: 5 },
  happy: { tiltDeg: 0, earLDeg: 0, earLScale: 1, earRDeg: 9 },
  encouraging: { tiltDeg: 3, earLDeg: 0, earLScale: 1, earRDeg: 0 },
  goodbye: { tiltDeg: -4, earLDeg: -8, earLScale: 1, earRDeg: 0 },
  thinking: { tiltDeg: 0, earLDeg: 0, earLScale: 1, earRDeg: 0 },
};

/** Base (front-facing) eye geometry, from data.ts GAZE_FRONT. */
const EYE_BASE = {
  pupilY: 98,
  pupilLX: 90,
  pupilRX: 158,
  glintY: 90,
  glintLX: 82,
  glintRX: 150,
} as const;

export interface LiveRigOptions {
  /** "full" (default) or "head" — a tighter crop reads better on a phone. */
  crop?: "full" | "head";
  showBody?: boolean;
  /** Static pose, no timers, no rAF. */
  reducedMotion?: boolean;
  /** Test seam: rAF + clock. */
  raf?: (cb: (t: number) => void) => number;
  cancelRaf?: (h: number) => void;
  now?: () => number;
  /** Test seam: deterministic jitter. */
  random?: () => number;
}

export interface LiveRig {
  /** Pose family. Transitions are smoothed, never snapped. */
  setEmote(emote: Emote): void;
  /** Explicit mouth shape; null hands the mouth back to the emote default. */
  setViseme(viseme: Viseme | null): void;
  /**
   * Where the child is, in normalized screen space: x -1 (left) … +1 (right),
   * y -1 (up) … +1 (down). This is the single strongest presence cue.
   */
  setGaze(x: number, y: number): void;
  /** 0..1 loudness → jaw opening, blended over the current viseme. */
  setMouthOpen(v: number): void;
  /** False → gaze drifts and wanders (nobody there); true → tracks + saccades. */
  setAttention(on: boolean): void;
  /** Force a blink now (auto-blink continues on its own schedule). */
  blink(): void;
  /**
   * Chiku DOES the movement, so the child can copy it. Resolves when the beat
   * finishes.
   *
   * This is the instruction channel for a pre-verbal child: there is no word to
   * say, no button to find, nothing to understand. He jumps; they jump. Call it
   * again for the same move and he does it again — at two years old repetition
   * is not a fallback, it is the thing they came for.
   *
   * A new call INTERRUPTS the one in flight and resolves its promise (never
   * rejects), exactly like `speak()` — so a caller awaiting the old beat is
   * released rather than left hanging.
   *
   * Under `reducedMotion` he holds the move's most legible frame instead of
   * animating, and the promise resolves immediately: there is no motion, so
   * there is no duration to wait out. A caller sequencing beats should pace
   * itself rather than assume this call takes time.
   *
   * Legs and feet only exist when the rig was built with `showBody`. Without a
   * body a stomp is still a stomp — the whole figure carries it — but it reads
   * better with legs, so prefer `showBody` on any surface that demonstrates.
   */
  perform(move: PerformMove): Promise<void>;
  /** Current smoothed values — for tests and debug overlays. */
  debug(): {
    gazeX: number;
    gazeY: number;
    mouthOpen: number;
    emote: Emote;
    /**
     * The beat in flight, or null when he is not demonstrating anything.
     *
     * Optional only so the stand-in rigs in existing tests keep compiling; the
     * real rig always reports it.
     */
    performing?: PerformMove | null;
    /** …and how far through it, 0..1. Optional for the same reason. */
    performProgress?: number;
  };
  dispose(): void;
}

const NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const node = doc.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Frame-rate-independent exponential approach toward a target. */
function approach(current: number, target: number, halfLifeMs: number, dtMs: number): number {
  if (halfLifeMs <= 0) return target;
  const k = Math.pow(0.5, dtMs / halfLifeMs);
  return target + (current - target) * k;
}

export function createLiveRig(host: HTMLElement, opts: LiveRigOptions = {}): LiveRig {
  const doc = host.ownerDocument;
  const reducedMotion = opts.reducedMotion ?? false;
  const raf = opts.raf ?? ((cb) => globalThis.requestAnimationFrame(cb));
  const cancelRaf = opts.cancelRaf ?? ((h) => globalThis.cancelAnimationFrame(h));
  const now = opts.now ?? (() => performance.now());
  const random = opts.random ?? Math.random;
  const crop = opts.crop ?? "full";
  const showBody = opts.showBody ?? false;

  // ---- build once ---------------------------------------------------------

  const root = doc.createElement("div");
  root.className = "chiku-live";
  root.setAttribute("data-live", "");
  const viewBox = crop === "head" ? "8 6 224 212" : showBody ? "0 0 240 356" : "0 0 240 248";
  const svg = el(doc, "svg", {
    viewBox,
    "aria-hidden": "true",
    style: "width:100%;height:100%;overflow:visible;display:block",
  });
  root.appendChild(svg);
  host.appendChild(root);

  const figure = el(doc, "g", { "data-part": "figure" });
  svg.appendChild(figure);

  const earL = el(doc, "g", { "data-part": "earL", style: "transform-origin:76px 104px" });
  earL.append(
    el(doc, "ellipse", { cx: "34", cy: "98", rx: "46", ry: "53", fill: PALETTE.bodyShade }),
    el(doc, "ellipse", { cx: "24", cy: "99", rx: "25", ry: "31", fill: PALETTE.innerEar }),
  );
  const earR = el(doc, "g", { "data-part": "earR", style: "transform-origin:164px 104px" });
  earR.append(
    el(doc, "ellipse", { cx: "206", cy: "98", rx: "46", ry: "53", fill: PALETTE.bodyShade }),
    el(doc, "ellipse", { cx: "216", cy: "99", rx: "25", ry: "31", fill: PALETTE.innerEar }),
  );
  figure.append(earL, earR);

  // Legs live in their own groups so a stomp can lift ONE of them. Same nodes,
  // same paint order (legs under the torso ellipse) — only the nesting changed.
  let legL: SVGGElement | null = null;
  let legR: SVGGElement | null = null;
  if (showBody) {
    const body = el(doc, "g", { "data-part": "body" });
    legL = el(doc, "g", { "data-part": "legL", style: "transform-origin:97px 292px" });
    legL.append(
      el(doc, "rect", { x: "82", y: "290", width: "30", height: "48", rx: "15", fill: PALETTE.bodyShade }),
      el(doc, "ellipse", { cx: "97", cy: "338", rx: "19", ry: "11", fill: PALETTE.bodyLight }),
    );
    legR = el(doc, "g", { "data-part": "legR", style: "transform-origin:143px 292px" });
    legR.append(
      el(doc, "rect", { x: "128", y: "290", width: "30", height: "48", rx: "15", fill: PALETTE.bodyShade }),
      el(doc, "ellipse", { cx: "143", cy: "338", rx: "19", ry: "11", fill: PALETTE.bodyLight }),
    );
    body.append(
      legL,
      legR,
      el(doc, "ellipse", { cx: "120", cy: "252", rx: "68", ry: "64", fill: PALETTE.body }),
      el(doc, "ellipse", { cx: "120", cy: "268", rx: "41", ry: "40", fill: PALETTE.bodyLight }),
    );
    figure.appendChild(body);
  }

  figure.appendChild(el(doc, "path", { d: HEAD_PATH, fill: PALETTE.body }));
  for (const d of HAIR_PATHS) {
    figure.appendChild(
      el(doc, "path", {
        d,
        fill: "none",
        stroke: PALETTE.bodyShade,
        "stroke-width": "7",
        "stroke-linecap": "round",
      }),
    );
  }

  const blush = el(doc, "g", { "data-part": "blush", opacity: "0" });
  blush.append(
    el(doc, "ellipse", { cx: "66", cy: "142", rx: "17", ry: "9", fill: PALETTE.blush }),
    el(doc, "ellipse", { cx: "178", cy: "142", rx: "17", ry: "9", fill: PALETTE.blush }),
  );
  figure.appendChild(blush);

  // Open eyes: the group scales vertically to blink; pupils/glints translate for
  // gaze. Node identity lives in data-part (like every other group); `data-eyes`
  // is reserved for the state marker on the root, so selectors never collide.
  const eyesOpen = el(doc, "g", { "data-part": "eyesOpen", style: "transform-origin:120px 98px" });
  const eyeWhiteL = el(doc, "ellipse", { cx: "90", cy: "98", rx: "17", ry: "17", fill: PALETTE.cream });
  const eyeWhiteR = el(doc, "ellipse", { cx: "158", cy: "98", rx: "17", ry: "17", fill: PALETTE.cream });
  const pupilL = el(doc, "circle", { cx: String(EYE_BASE.pupilLX), cy: String(EYE_BASE.pupilY), r: "10", fill: PALETTE.ink });
  const pupilR = el(doc, "circle", { cx: String(EYE_BASE.pupilRX), cy: String(EYE_BASE.pupilY), r: "10", fill: PALETTE.ink });
  const glintL = el(doc, "circle", { cx: String(EYE_BASE.glintLX), cy: String(EYE_BASE.glintY), r: "3.6", fill: PALETTE.cream });
  const glintR = el(doc, "circle", { cx: String(EYE_BASE.glintRX), cy: String(EYE_BASE.glintY), r: "3.6", fill: PALETTE.cream });
  eyesOpen.append(eyeWhiteL, eyeWhiteR, pupilL, pupilR, glintL, glintR);

  const eyesArc = el(doc, "g", { "data-part": "eyesArc", fill: "none", stroke: PALETTE.ink, "stroke-width": "7", "stroke-linecap": "round", opacity: "0" });
  for (const d of ARC_EYE_PATHS) eyesArc.appendChild(el(doc, "path", { d }));
  figure.append(eyesOpen, eyesArc);

  const brows = el(doc, "g", { "data-part": "brows", fill: "none", stroke: PALETTE.ink, "stroke-width": "6", "stroke-linecap": "round", opacity: ".9" });
  const browL = el(doc, "path", { d: EMOTES.idle.browL });
  const browR = el(doc, "path", { d: EMOTES.idle.browR });
  brows.append(browL, browR);
  figure.appendChild(brows);

  // Mouth group scales vertically with loudness over the discrete viseme path.
  const mouthG = el(doc, "g", { "data-part": "mouth", style: "transform-origin:124px 172px" });
  const mouthPath = el(doc, "path", { d: MOUTHS.closed, fill: PALETTE.ink });
  const tongue = el(doc, "ellipse", { cx: "124", cy: "184", rx: "13", ry: "9", fill: PALETTE.blush, opacity: "0" });
  mouthG.append(mouthPath, tongue);
  figure.appendChild(mouthG);

  // Trunk: three stroked segments, twice (dark under, light over) + texture.
  const trunkG = el(doc, "g", { "data-part": "trunk", style: "transform-origin:110px 122px" });
  const trunkPaths: SVGPathElement[] = [];
  const trunkSpec: ReadonlyArray<[number, string]> = [
    [27, PALETTE.trunkOuter],
    [37, PALETTE.trunkOuter],
    [47, PALETTE.trunkOuter],
    [21, PALETTE.trunkInner],
    [31, PALETTE.trunkInner],
    [41, PALETTE.trunkInner],
  ];
  // Order matches the export: t3,t2,t1 outer then t3,t2,t1 inner.
  const segOrder = [2, 1, 0, 2, 1, 0];
  trunkSpec.forEach(([width, stroke], i) => {
    const seg = segOrder[i] ?? 0;
    const p = el(doc, "path", {
      d: TRUNKS.down[seg] ?? "",
      fill: "none",
      stroke,
      "stroke-width": String(width),
      "stroke-linecap": "round",
    });
    trunkPaths.push(p);
    trunkG.appendChild(p);
  });
  figure.appendChild(trunkG);

  // ---- live state ---------------------------------------------------------

  let emote: Emote = "idle";
  let visemeOverride: Viseme | null = null;
  let attention = true;
  let disposed = false;

  const target = { gazeX: 0, gazeY: 0, mouthOpen: 0, tilt: 0, earL: 0, earLScale: 1, earR: 0, blush: 0, arc: 0 };
  const cur = { ...target };

  let saccadeX = 0;
  let saccadeY = 0;
  let nextSaccadeAt = 0;
  let wanderPhase = random() * Math.PI * 2;

  let blinkClosedUntil = 0;
  let nextBlinkAt = 0;
  let lidScale = 1;

  let lastFrame = now();
  let handle: number | null = null;

  /* ---- demonstration beats ---- */

  interface Beat {
    readonly move: PerformMove;
    readonly spec: MoveSpec;
    /** Null until the first painted frame, so the beat starts when it is seen. */
    startedAt: number | null;
    resolve: () => void;
  }
  let beat: Beat | null = null;
  /** The reduced-motion held pose, which outlives any single frame. */
  let heldPose: PerformPose | null = null;
  /** Trunk path the current beat wants, overriding the emote's. */
  let trunkPoseOverride: TrunkPose | null = null;
  /** Base values from the last paint, so a held pose can be written outside it. */
  let baseHeadDeg = 0;
  let baseSway = 0;
  let baseBreath = 1;

  const floorY = showBody ? FLOOR_Y_BODY : FLOOR_Y_HEAD;

  function applyTrunkPaths(): void {
    const pose3 = TRUNKS[trunkPoseOverride ?? (EMOTES[emote].trunk as TrunkPose)];
    trunkPaths.forEach((node, i) => {
      const seg = segOrder[i] ?? 0;
      node.setAttribute("d", pose3[seg] ?? "");
    });
  }

  function applyEmoteTargets(): void {
    const pose = POSES[emote];
    const p = EMOTES[emote];
    target.tilt = pose.tiltDeg;
    target.earL = pose.earLDeg;
    target.earLScale = pose.earLScale;
    target.earR = pose.earRDeg;
    target.blush = p.blush ? 0.5 : 0;
    target.arc = p.eyes === "happy" ? 1 : 0;
    browL.setAttribute("d", p.browL);
    browR.setAttribute("d", p.browR);
    applyTrunkPaths();
    root.setAttribute("data-emote", emote);
  }

  /**
   * Resolve the beat in flight without rejecting. Interruption is normal — a
   * child who has moved on deserves Chiku to move on too — so the awaiting
   * caller is released, not failed.
   */
  function endBeat(): void {
    const done = beat;
    beat = null;
    if (done === null) return;
    if (trunkPoseOverride !== null) {
      trunkPoseOverride = null;
      applyTrunkPaths();
    }
    root.removeAttribute("data-perform");
    done.resolve();
  }

  /**
   * Write everything a beat touches. Split out of `paint` so a reduced-motion
   * hold can be applied without running a frame of breathing, blinking and
   * saccades — the static pose has to stay static.
   */
  function writePerformance(perf: PerformPose): void {
    const resting = isResting(perf);
    // Squash conserves apparent mass: shorter is wider. Anchored at the floor,
    // so he compresses onto his feet instead of shrinking toward his middle.
    const sy = perf.squash;
    const sx = sy === 0 ? 1 : 1 / Math.sqrt(sy);
    const headDeg = baseHeadDeg;
    const bodyTransform =
      `translate(120 170) rotate(${headDeg.toFixed(3)}) scale(${baseBreath.toFixed(4)}) translate(-120 -170)`;
    figure.setAttribute(
      "transform",
      resting
        ? bodyTransform
        : `translate(${perf.dx.toFixed(2)} ${perf.dy.toFixed(2)}) ` +
          `translate(120 ${floorY}) rotate(${perf.lean.toFixed(3)}) ` +
          `scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(-120 ${-floorY}) ` +
          bodyTransform,
    );

    // Ears mirror: +flap on the left, -flap on the right, so they swing IN
    // together rather than both drifting the same way across the face.
    earL.setAttribute(
      "transform",
      `rotate(${(cur.earL - baseSway * 0.6 + perf.ears).toFixed(2)}) scale(${cur.earLScale.toFixed(3)})`,
    );
    earR.setAttribute("transform", `rotate(${(cur.earR + baseSway * 0.6 - perf.ears).toFixed(2)})`);
    trunkG.setAttribute("transform", `rotate(${(baseSway * -1.4 + perf.trunk).toFixed(2)})`);

    if (legL !== null) legL.setAttribute("transform", `translate(0 ${(-perf.legL).toFixed(2)})`);
    if (legR !== null) legR.setAttribute("transform", `translate(0 ${(-perf.legR).toFixed(2)})`);
  }

  /** The pose to draw this instant: the live beat, else any hold, else rest. */
  function currentPerformPose(t: number): PerformPose {
    const b = beat;
    if (b === null) return heldPose ?? REST_POSE;
    if (b.startedAt === null) b.startedAt = t;
    const p = (t - b.startedAt) / b.spec.durationMs;
    if (p >= 1) {
      endBeat();
      return REST_POSE;
    }
    return poseAt(b.spec, p < 0 ? 0 : p);
  }

  function currentViseme(): Viseme {
    return visemeOverride ?? EMOTES[emote].defaultViseme;
  }

  function paint(dtMs: number, t: number): void {
    // --- gaze: target + involuntary saccades, or a slow wander when alone ---
    let gx = target.gazeX;
    let gy = target.gazeY;
    if (attention) {
      if (t >= nextSaccadeAt) {
        saccadeX = (random() * 2 - 1) * SACCADE_MAG;
        saccadeY = (random() * 2 - 1) * SACCADE_MAG * 0.6;
        nextSaccadeAt = t + SACCADE_MIN_MS + random() * (SACCADE_MAX_MS - SACCADE_MIN_MS);
      }
      gx += saccadeX;
      gy += saccadeY;
    } else {
      // Nobody watching: eyes drift, which reads as "waiting", not "frozen".
      wanderPhase += (dtMs / 1000) * 0.6;
      gx = Math.sin(wanderPhase) * 0.5;
      gy = Math.sin(wanderPhase * 0.42) * 0.25;
    }

    cur.gazeX = approach(cur.gazeX, Math.max(-1, Math.min(1, gx)), HALFLIFE_GAZE, dtMs);
    cur.gazeY = approach(cur.gazeY, Math.max(-1, Math.min(1, gy)), HALFLIFE_GAZE, dtMs);
    cur.mouthOpen = approach(cur.mouthOpen, target.mouthOpen, HALFLIFE_MOUTH, dtMs);
    cur.tilt = approach(cur.tilt, target.tilt, HALFLIFE_POSE, dtMs);
    cur.earL = approach(cur.earL, target.earL, HALFLIFE_POSE, dtMs);
    cur.earLScale = approach(cur.earLScale, target.earLScale, HALFLIFE_POSE, dtMs);
    cur.earR = approach(cur.earR, target.earR, HALFLIFE_POSE, dtMs);
    cur.blush = approach(cur.blush, target.blush, HALFLIFE_POSE, dtMs);
    cur.arc = approach(cur.arc, target.arc, HALFLIFE_POSE, dtMs);

    // --- eyes ---
    const pdx = cur.gazeX * GAZE_PUPIL_X;
    const pdy = cur.gazeY * GAZE_PUPIL_Y;
    pupilL.setAttribute("cx", String(EYE_BASE.pupilLX + pdx));
    pupilL.setAttribute("cy", String(EYE_BASE.pupilY + pdy));
    pupilR.setAttribute("cx", String(EYE_BASE.pupilRX + pdx));
    pupilR.setAttribute("cy", String(EYE_BASE.pupilY + pdy));
    const gdx = cur.gazeX * GAZE_GLINT_X;
    const gdy = cur.gazeY * GAZE_GLINT_Y;
    glintL.setAttribute("cx", String(EYE_BASE.glintLX + gdx));
    glintL.setAttribute("cy", String(EYE_BASE.glintY + gdy));
    glintR.setAttribute("cx", String(EYE_BASE.glintRX + gdx));
    glintR.setAttribute("cy", String(EYE_BASE.glintY + gdy));

    const eyeR = EMOTES[emote].eyeR;
    eyeWhiteL.setAttribute("rx", String(eyeR));
    eyeWhiteL.setAttribute("ry", String(eyeR));
    eyeWhiteR.setAttribute("rx", String(eyeR));
    eyeWhiteR.setAttribute("ry", String(eyeR));

    // --- blink ---
    if (t >= nextBlinkAt && blinkClosedUntil < t) {
      blinkClosedUntil = t + BLINK_CLOSED_MS;
      nextBlinkAt = blinkClosedUntil + BLINK_MIN_MS + random() * (BLINK_MAX_MS - BLINK_MIN_MS);
    }
    const closed = t < blinkClosedUntil;
    lidScale = approach(lidScale, closed ? 0.08 : 1, 26, dtMs);
    eyesOpen.setAttribute("opacity", String(1 - cur.arc));
    eyesOpen.setAttribute("transform", `scale(1 ${lidScale.toFixed(3)})`);
    eyesArc.setAttribute("opacity", String(cur.arc));
    root.setAttribute("data-eyes", cur.arc > 0.5 ? "happy" : closed ? "closed" : "open");

    // --- mouth: discrete viseme + continuous loudness ---
    const v = currentViseme();
    mouthPath.setAttribute("d", MOUTHS[v]);
    tongue.setAttribute("opacity", v === "L" ? "1" : "0");
    const openScale = 1 + cur.mouthOpen * 0.55;
    mouthG.setAttribute("transform", `scale(1 ${openScale.toFixed(3)})`);
    root.setAttribute("data-viseme", v);

    // --- body: breath, sway, head-follows-gaze ---
    const breath = Math.sin((t / 1000) * BREATH_HZ * Math.PI * 2);
    const sway =
      Math.sin((t / 1000) * SWAY_HZ * Math.PI * 2) * SWAY_DEG +
      Math.sin((t / 1000) * SWAY_HZ2 * Math.PI * 2) * SWAY_DEG2;
    baseHeadDeg = cur.tilt + sway + cur.gazeX * GAZE_HEAD_DEG;
    baseSway = sway;
    baseBreath = 1 + breath * BREATH_SCALE;

    // Ear follow-through, trunk sway and the figure transform all live in
    // writePerformance now, because a demonstration beat composes on top of
    // exactly those three and they must be written from one place.
    writePerformance(currentPerformPose(t));
    blush.setAttribute("opacity", String(cur.blush.toFixed(3)));
  }

  function tick(t: number): void {
    if (disposed) return;
    const dt = Math.min(64, Math.max(1, t - lastFrame)); // clamp tab-switch jumps
    lastFrame = t;
    paint(dt, t);
    handle = raf(tick);
  }

  applyEmoteTargets();
  if (reducedMotion) {
    // One static frame: pose applied, zero timers, zero motion.
    cur.gazeX = 0;
    cur.gazeY = 0;
    Object.assign(cur, {
      tilt: target.tilt,
      earL: target.earL,
      earLScale: target.earLScale,
      earR: target.earR,
      blush: target.blush,
      arc: target.arc,
    });
    nextBlinkAt = Number.POSITIVE_INFINITY;
    attention = false;
    const t0 = now();
    // Freeze the oscillators by painting at a phase where breath/sway are 0.
    wanderPhase = 0;
    paint(16, 0);
    void t0;
  } else {
    lastFrame = now();
    nextBlinkAt = lastFrame + BLINK_MIN_MS + random() * (BLINK_MAX_MS - BLINK_MIN_MS);
    nextSaccadeAt = lastFrame + SACCADE_MIN_MS;
    handle = raf(tick);
  }

  return {
    setEmote(next: Emote): void {
      if (disposed || next === emote) return;
      emote = next;
      applyEmoteTargets();
    },
    setViseme(v: Viseme | null): void {
      visemeOverride = v;
    },
    setGaze(x: number, y: number): void {
      target.gazeX = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
      target.gazeY = Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0;
    },
    setMouthOpen(v: number): void {
      target.mouthOpen = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    },
    setAttention(on: boolean): void {
      attention = on;
    },
    blink(): void {
      blinkClosedUntil = now() + BLINK_CLOSED_MS;
    },
    perform(move: PerformMove): Promise<void> {
      if (disposed) return Promise.resolve();
      const spec = MOVES[move];
      // Interrupt first, so the outgoing promise is settled before the new beat
      // can possibly finish and settle its own.
      endBeat();

      if (reducedMotion) {
        // No motion at all: hold the frame that best says what the move is, and
        // resolve now — there is nothing to wait for. Chiku stays in the pose
        // until the next perform(), which is a demonstration a child can look
        // at for as long as they need.
        trunkPoseOverride = spec.trunkPose ?? null;
        applyTrunkPaths();
        heldPose = poseAt(spec, spec.hold);
        root.setAttribute("data-perform", move);
        writePerformance(heldPose);
        return Promise.resolve();
      }

      heldPose = null;
      trunkPoseOverride = spec.trunkPose ?? null;
      applyTrunkPaths();
      root.setAttribute("data-perform", move);
      return new Promise<void>((resolve) => {
        beat = { move, spec, startedAt: null, resolve };
      });
    },
    debug() {
      const b = beat;
      const started = b?.startedAt;
      const progress =
        b === null || started === null || started === undefined
          ? 0
          : Math.max(0, Math.min(1, (lastFrame - started) / b.spec.durationMs));
      return {
        gazeX: cur.gazeX,
        gazeY: cur.gazeY,
        mouthOpen: cur.mouthOpen,
        emote,
        performing: b?.move ?? null,
        performProgress: progress,
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Release anyone awaiting a beat that will now never finish.
      endBeat();
      if (handle !== null) cancelRaf(handle);
      handle = null;
      root.remove();
    },
  };
}
