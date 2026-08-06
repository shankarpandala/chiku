// THE MAGIC WINDOW — what appears inside the frame the child makes with their
// hands.
//
// Ported from github.com/sophiamyang/finger-frame-effect-lucy, minus the part
// that cannot be here: there is no cloud video model, no image is generated,
// nothing leaves the device. Everything below is drawn locally with Canvas 2D
// against pixels that live for one frame. (See magicLens.ts for why the lens is
// CPU and not a shader, and for the §9 invariant it keeps.)
//
// THREE THINGS THIS COMPONENT REFUSES TO DO
//
// 1. It does not re-render React at camera rate. `setQuad` writes a ref and
//    paints; React only renders when the window appears or disappears. Same
//    reasoning as CameraStage's applyFrame — 30 renders a second to move a
//    polygon costs more than the drawing does.
// 2. It does not animate anything on its own timeline under reduced motion. The
//    window still follows the child's hands, because that is THEIR motion; only
//    the sticker's breath is ours, and that is switched off.
// 3. It is not teal. Teal is reserved for "Chiku is hearing you" (§9), and a
//    second teal object on the same stage would make the one that means
//    something mean nothing. The window is marigold, cream and ink.

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Quad, QuadKind } from "../vision/quad";
import {
  boundsOf,
  centreOf,
  coverRect,
  pointsAttr,
  projectQuad,
  scaleAbout,
  stickerScale,
  windowOpacity,
  type Box,
  type Corners,
} from "./magicWindowGeometry";
import {
  HUNT_COLOURS,
  LENS_SAMPLE_MAX,
  lensPass,
  sampleSize,
  type HuntColour,
} from "./magicLens";

export type { HuntColour } from "./magicLens";

/** What the window shows. Three effects, one geometry. */
export type MagicWindowMode = "sticker" | "lens" | "spotlight";

/** Which pixel path the lens actually used this frame. */
export type LensBackend = "canvas2d" | "none";

/**
 * Every colour the window can paint. Mirrors packages/tokens (kid-marigold,
 * kid-cream, kid-ink) — canvas cannot read a CSS custom property, so the values
 * are duplicated here and asserted teal-free in the tests.
 */
export const WINDOW_PALETTE = Object.freeze({
  rim: "#f0a33c", // --kid-marigold
  glow: "#fdf6ec", // --kid-cream
  ink: "#2c2a35", // --kid-ink
  star: "#f0a33c",
});

/** How dark the room goes in spotlight mode, at full presence. */
export const SPOTLIGHT_DIM = 0.72;

export interface MagicWindowHandle {
  /**
   * Camera-rate path: hand it the frame's quad (or null). Paints synchronously
   * and does not re-render React unless the window just appeared or vanished.
   */
  setQuad(quad: Quad | null): void;
  /** Latest lens coverage, 0..1. Always 0 outside lens mode. */
  coverage(): number;
  canvas(): HTMLCanvasElement | null;
}

export interface MagicWindowProps {
  mode: MagicWindowMode;
  /**
   * Declarative quad. Use this OR the handle's `setQuad`, never both — the
   * surface pushes at camera rate, tests pass props.
   */
  quad?: Quad | null;
  /**
   * The video under this canvas is CSS-mirrored and the quad is not, so the
   * default is to flip. Only pass false if the source is genuinely unmirrored.
   */
  mirrored?: boolean;
  reducedMotion?: boolean;
  /** Which colour the lens keeps. */
  target?: HuntColour;
  /**
   * The local video sink, read at paint time. Read only — one frame, one
   * transient buffer, never stored and never transmitted.
   */
  source?: () => HTMLVideoElement | null;
  /** Source aspect (w/h) when the video has not reported one yet. */
  sourceAspect?: number;
  /** Element box override, used when the element measures 0 (tests, headless). */
  size?: Box;
  /** Device pixel ratio override. */
  pixelRatio?: number;
  /** Clock for the sticker's breath. */
  now?: () => number;
  /** Called when lens coverage moves meaningfully. */
  onCoverage?: (coverage: number) => void;
}

/** Coverage changes smaller than this are noise and are not reported. */
const COVERAGE_EPSILON = 0.02;

export const MagicWindow = forwardRef<MagicWindowHandle, MagicWindowProps>(function MagicWindow(
  props,
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sampleRef = useRef<HTMLCanvasElement | null>(null);
  const quadRef = useRef<Quad | null>(props.quad ?? null);
  const coverageRef = useRef(0);
  // Starts at the honest initial state — no window, nothing found — so a lens
  // that finds nothing reports nothing rather than opening with "0".
  const reportedRef = useRef(0);
  const cfgRef = useRef<MagicWindowProps>(props);
  const [present, setPresent] = useState<boolean>((props.quad ?? null) !== null);
  const presentRef = useRef(present);

  const draw = useCallback((): void => {
    const canvas = canvasRef.current;
    const quad = quadRef.current;
    if (!canvas || !quad) return;
    paint(canvas, sampleRef, quad, cfgRef.current, coverageRef);

    const cfg = cfgRef.current;
    const next = coverageRef.current;
    if (cfg.onCoverage && Math.abs(next - reportedRef.current) >= COVERAGE_EPSILON) {
      reportedRef.current = next;
      cfg.onCoverage(next);
    }
  }, []);

  const apply = useCallback(
    (next: Quad | null): void => {
      quadRef.current = next;
      const want = next !== null;
      if (want !== presentRef.current) {
        presentRef.current = want;
        if (!want) {
          coverageRef.current = 0;
          reportedRef.current = 0;
        }
        // The canvas is about to mount or unmount; the layout effect below
        // paints once React has committed it.
        setPresent(want);
        return;
      }
      draw();
    },
    [draw],
  );

  useImperativeHandle(
    ref,
    (): MagicWindowHandle => ({
      setQuad: apply,
      coverage: () => coverageRef.current,
      canvas: () => canvasRef.current,
    }),
    [apply],
  );

  // Props the imperative path reads are refreshed before anything paints.
  useLayoutEffect(() => {
    cfgRef.current = props;
  });

  // The declarative path. Deps are the quad object identity, so a surface that
  // never passes `quad` runs this exactly once and keeps its imperative pushes.
  // It deliberately does NOT paint: the effect below paints once per commit,
  // and painting here as well would double every frame's work.
  const quadProp = props.quad ?? null;
  useLayoutEffect(() => {
    quadRef.current = quadProp;
    const want = quadProp !== null;
    if (want !== presentRef.current) {
      presentRef.current = want;
      if (!want) {
        coverageRef.current = 0;
        reportedRef.current = 0;
      }
      setPresent(want);
    }
  }, [quadProp]);

  // Every commit repaints: mount, mode change, size change, reduced-motion flip.
  useLayoutEffect(() => {
    draw();
  });

  if (!present) return null;

  return (
    <canvas
      ref={canvasRef}
      className="magic-window"
      data-testid="magic-window"
      data-mode={props.mode}
      aria-hidden="true"
    />
  );
});

/* -------------------------------------------------------------------------- */
/* painting                                                                    */
/* -------------------------------------------------------------------------- */

function measure(canvas: HTMLCanvasElement, override: Box | undefined): Box {
  const rect = canvas.getBoundingClientRect?.();
  if (rect && rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height };
  }
  return override ?? { width: 0, height: 0 };
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext("2d");
  } catch {
    // A browser may refuse a context under memory pressure or a privacy mode.
    // The window then draws nothing rather than taking the surface down.
    return null;
  }
}

function paint(
  canvas: HTMLCanvasElement,
  sampleRef: { current: HTMLCanvasElement | null },
  quad: Quad,
  cfg: MagicWindowProps,
  coverageRef: { current: number },
): void {
  const box = measure(canvas, cfg.size);
  const mirrored = cfg.mirrored ?? true;
  const video = cfg.source?.() ?? null;
  const aspect =
    video && video.videoWidth > 0 && video.videoHeight > 0
      ? video.videoWidth / video.videoHeight
      : (cfg.sourceAspect ?? (box.height > 0 ? box.width / box.height : 0));

  const rect = coverRect(aspect, box);
  const pts = projectQuad(quad.corners, rect, mirrored);
  const opacity = windowOpacity(quad.presence);
  const nowMs = cfg.now ? cfg.now() : performanceNow();
  const scale = stickerScale(nowMs, cfg.reducedMotion ?? false);

  // The drawn geometry, always published — tests assert against it and it is
  // the only way to debug a mirroring bug without a camera in your hand.
  canvas.style.opacity = String(opacity);
  canvas.dataset["quadKind"] = quad.kind;
  canvas.dataset["mirrored"] = mirrored ? "true" : "false";
  canvas.dataset["presence"] = quad.presence.toFixed(3);
  canvas.dataset["points"] = pointsAttr(pts);
  const centre = centreOf(pts);
  canvas.dataset["centre"] = `${centre.x.toFixed(1)},${centre.y.toFixed(1)}`;
  canvas.dataset["motion"] = (cfg.reducedMotion ?? false) ? "static" : "breathing";
  canvas.dataset["scale"] = scale.toFixed(4);

  const ctx = context2d(canvas);
  if (!ctx || box.width <= 0 || box.height <= 0) {
    if (cfg.mode === "lens") canvas.dataset["lensBackend"] = "none";
    return;
  }

  const dpr = Math.min(3, Math.max(1, cfg.pixelRatio ?? globalThis.devicePixelRatio ?? 1));
  const w = Math.max(1, Math.round(box.width * dpr));
  const h = Math.max(1, Math.round(box.height * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, box.width, box.height);

  switch (cfg.mode) {
    case "sticker":
      drawSticker(ctx, pts, quad.kind, scale);
      break;
    case "spotlight":
      drawSpotlight(ctx, box, pts, quad.kind);
      break;
    case "lens": {
      const result = drawLens(ctx, sampleRef, quad, pts, rect, mirrored, video, cfg);
      canvas.dataset["lensBackend"] = result.backend;
      coverageRef.current = result.coverage;
      canvas.dataset["coverage"] = result.coverage.toFixed(3);
      break;
    }
  }
}

function performanceNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

/* --- the shared outline --------------------------------------------------- */

/**
 * A palm window is a circle (the quad is only its bounding square — see
 * quad.ts), a pinch or two-handed frame is the polygon itself. Tracing them
 * through one function is what lets every mode treat the three rungs of the
 * ladder identically.
 */
function traceWindow(
  ctx: CanvasRenderingContext2D,
  pts: Corners,
  kind: QuadKind,
  scale: number,
): void {
  const centre = centreOf(pts);
  const shape = scale === 1 ? pts : scaleAbout(pts, centre, scale);
  ctx.beginPath();
  if (kind === "palm") {
    const b = boundsOf(shape);
    ctx.ellipse(centre.x, centre.y, b.width / 2, b.height / 2, 0, 0, Math.PI * 2);
    ctx.closePath();
    return;
  }
  ctx.moveTo(shape[0].x, shape[0].y);
  ctx.lineTo(shape[1].x, shape[1].y);
  ctx.lineTo(shape[2].x, shape[2].y);
  ctx.lineTo(shape[3].x, shape[3].y);
  ctx.closePath();
}

/** The marigold edge that makes the window an object rather than a hole. */
function strokeRim(ctx: CanvasRenderingContext2D, pts: Corners, kind: QuadKind, scale: number): void {
  ctx.save();
  traceWindow(ctx, pts, kind, scale);
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  ctx.strokeStyle = WINDOW_PALETTE.rim;
  ctx.stroke();
  ctx.restore();
}

/* --- sticker -------------------------------------------------------------- */

function drawSticker(
  ctx: CanvasRenderingContext2D,
  pts: Corners,
  kind: QuadKind,
  scale: number,
): void {
  const centre = centreOf(pts);
  const bounds = boundsOf(pts);
  const radius = Math.max(4, Math.min(bounds.width, bounds.height) / 2);

  ctx.save();
  traceWindow(ctx, pts, kind, scale);
  ctx.clip();

  const wash = ctx.createRadialGradient(centre.x, centre.y, 0, centre.x, centre.y, radius * 1.4);
  wash.addColorStop(0, withAlpha(WINDOW_PALETTE.glow, 0.92));
  wash.addColorStop(1, withAlpha(WINDOW_PALETTE.rim, 0.45));
  ctx.fillStyle = wash;
  ctx.fillRect(bounds.x - radius, bounds.y - radius, bounds.width + radius * 2, bounds.height + radius * 2);

  drawStar(ctx, centre.x, centre.y, radius * 0.62 * scale, radius * 0.26 * scale);
  ctx.restore();

  strokeRim(ctx, pts, kind, scale);
}

/** Five points, because a star is the one shape every 3-year-old can name. */
function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outer: number,
  inner: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = WINDOW_PALETTE.star;
  ctx.fill();
}

/* --- spotlight ------------------------------------------------------------ */

function drawSpotlight(
  ctx: CanvasRenderingContext2D,
  box: Box,
  pts: Corners,
  kind: QuadKind,
): void {
  ctx.save();
  ctx.fillStyle = withAlpha(WINDOW_PALETTE.ink, SPOTLIGHT_DIM);
  ctx.fillRect(0, 0, box.width, box.height);
  // Punch the window out of the darkness rather than drawing light into it:
  // one composite op instead of a second gradient that never quite matches.
  ctx.globalCompositeOperation = "destination-out";
  traceWindow(ctx, pts, kind, 1);
  ctx.fill();
  ctx.restore();

  strokeRim(ctx, pts, kind, 1);
}

/* --- lens ----------------------------------------------------------------- */

interface LensDraw {
  readonly backend: LensBackend;
  readonly coverage: number;
}

function drawLens(
  ctx: CanvasRenderingContext2D,
  sampleRef: { current: HTMLCanvasElement | null },
  quad: Quad,
  pts: Corners,
  rect: { x: number; y: number; width: number; height: number },
  mirrored: boolean,
  video: HTMLVideoElement | null,
  cfg: MagicWindowProps,
): LensDraw {
  const target = HUNT_COLOURS[cfg.target ?? "red"];

  // Bounding box of the quad in NORMALIZED IMAGE space — unmirrored, because
  // that is the space the video's own pixels are in.
  const xs = quad.corners.map((c) => c.x);
  const ys = quad.corners.map((c) => c.y);
  const u0 = clamp01(Math.min(...xs));
  const u1 = clamp01(Math.max(...xs));
  const v0 = clamp01(Math.min(...ys));
  const v1 = clamp01(Math.max(...ys));

  const vw = video?.videoWidth ?? 0;
  const vh = video?.videoHeight ?? 0;
  const sw = Math.floor((u1 - u0) * vw);
  const sh = Math.floor((v1 - v0) * vh);
  if (!video || sw < 2 || sh < 2) return { ...drawLensPlain(ctx, pts, quad.kind), coverage: 0 };

  const sample = sampleRef.current ?? createSample();
  sampleRef.current = sample;
  if (!sample) return { ...drawLensPlain(ctx, pts, quad.kind), coverage: 0 };

  const size = sampleSize(sw, sh, LENS_SAMPLE_MAX);
  if (sample.width !== size.width) sample.width = size.width;
  if (sample.height !== size.height) sample.height = size.height;
  const sctx = context2d(sample);
  if (!sctx || typeof sctx.getImageData !== "function") {
    return { ...drawLensPlain(ctx, pts, quad.kind), coverage: 0 };
  }

  let coverage = 0;
  try {
    sctx.drawImage(video, u0 * vw, v0 * vh, sw, sh, 0, 0, size.width, size.height);
    const image = sctx.getImageData(0, 0, size.width, size.height);
    // The quad, expressed in the sample buffer's own pixels.
    const poly = quad.corners.map((c) => ({
      x: ((c.x - u0) / Math.max(1e-6, u1 - u0)) * size.width,
      y: ((c.y - v0) / Math.max(1e-6, v1 - v0)) * size.height,
    }));
    coverage = lensPass(image, poly, target).coverage;
    sctx.putImageData(image, 0, 0);
  } catch {
    // getImageData can throw (tainted canvas, zero-size buffer). Never on our
    // own same-origin stream — but a lens that throws would take the surface
    // down mid-play, and a plain window is a fine thing to fall back to.
    return { ...drawLensPlain(ctx, pts, quad.kind), coverage: 0 };
  }

  // Where that source rect lands on the glass. Mirroring flips the rect's x
  // extents AND the image inside it, so the drained room lines up pixel for
  // pixel with the mirrored video underneath.
  const xa = rect.x + (mirrored ? 1 - u1 : u0) * rect.width;
  const xb = rect.x + (mirrored ? 1 - u0 : u1) * rect.width;
  const dy = rect.y + v0 * rect.height;
  const dh = (v1 - v0) * rect.height;

  ctx.save();
  traceWindow(ctx, pts, quad.kind, 1);
  ctx.clip();
  if (mirrored) {
    ctx.translate(xb, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(sample, 0, 0, xb - xa, dh);
  } else {
    ctx.drawImage(sample, xa, dy, xb - xa, dh);
  }
  ctx.restore();

  strokeRim(ctx, pts, quad.kind, 1);
  return { backend: "canvas2d", coverage };
}

/** No pixels available: still show a window, so the child's hands did something. */
function drawLensPlain(
  ctx: CanvasRenderingContext2D,
  pts: Corners,
  kind: QuadKind,
): { backend: LensBackend } {
  ctx.save();
  traceWindow(ctx, pts, kind, 1);
  ctx.clip();
  ctx.fillStyle = withAlpha(WINDOW_PALETTE.glow, 0.18);
  const b = boundsOf(pts);
  ctx.fillRect(b.x, b.y, b.width, b.height);
  ctx.restore();
  strokeRim(ctx, pts, kind, 1);
  return { backend: "none" };
}

function createSample(): HTMLCanvasElement | null {
  try {
    return globalThis.document?.createElement("canvas") ?? null;
  } catch {
    return null;
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** `#rrggbb` + alpha, without pulling in a colour library. */
export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
