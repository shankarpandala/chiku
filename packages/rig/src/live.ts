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
  /** Current smoothed values — for tests and debug overlays. */
  debug(): { gazeX: number; gazeY: number; mouthOpen: number; emote: Emote };
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

  if (showBody) {
    const body = el(doc, "g", { "data-part": "body" });
    body.append(
      el(doc, "rect", { x: "82", y: "290", width: "30", height: "48", rx: "15", fill: PALETTE.bodyShade }),
      el(doc, "rect", { x: "128", y: "290", width: "30", height: "48", rx: "15", fill: PALETTE.bodyShade }),
      el(doc, "ellipse", { cx: "97", cy: "338", rx: "19", ry: "11", fill: PALETTE.bodyLight }),
      el(doc, "ellipse", { cx: "143", cy: "338", rx: "19", ry: "11", fill: PALETTE.bodyLight }),
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
    const pose3 = TRUNKS[p.trunk as TrunkPose];
    trunkPaths.forEach((node, i) => {
      const seg = segOrder[i] ?? 0;
      node.setAttribute("d", pose3[seg] ?? "");
    });
    root.setAttribute("data-emote", emote);
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
    const headDeg = cur.tilt + sway + cur.gazeX * GAZE_HEAD_DEG;
    const scale = 1 + breath * BREATH_SCALE;
    figure.setAttribute(
      "transform",
      `translate(120 170) rotate(${headDeg.toFixed(3)}) scale(${scale.toFixed(4)}) translate(-120 -170)`,
    );

    // Ears lag the head — cheap follow-through that reads as weight.
    earL.setAttribute("transform", `rotate(${(cur.earL - sway * 0.6).toFixed(2)}) scale(${cur.earLScale.toFixed(3)})`);
    earR.setAttribute("transform", `rotate(${(cur.earR + sway * 0.6).toFixed(2)})`);
    trunkG.setAttribute("transform", `rotate(${(sway * -1.4).toFixed(2)})`);
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
    debug() {
      return { gazeX: cur.gazeX, gazeY: cur.gazeY, mouthOpen: cur.mouthOpen, emote };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (handle !== null) cancelRaf(handle);
      handle = null;
      root.remove();
    },
  };
}
