// @vitest-environment happy-dom
//
// THE MAGIC WINDOW.
//
// Four things are pinned here, in rough order of how badly they would hurt a
// child if they were wrong.
//
//   1. MIRRORING. The <video> is CSS-mirrored and the quad is not. If the
//      overlay does not flip with it, the window slides AWAY from the hand that
//      is making it — the child moves right, the window moves left, and the one
//      thing this feature promises (that they are holding it) is broken. The
//      test below does not just check a sign: it checks that the window lands
//      on the same element pixels the mirrored video puts that piece of the
//      room on.
//
//   2. THE FALLBACK. happy-dom has no canvas context at all and no WebGL, which
//      is a fair model of a browser that refuses one under memory pressure. The
//      window must degrade to "geometry only, nothing painted" and never throw
//      — a lens that throws takes the whole surface down mid-play.
//
//   3. PRESENCE. Opacity is presence, straight through, because stability.ts
//      already did the fading. A window that pops is a window the child did not
//      cause.
//
//   4. NOT TEAL. Teal means "Chiku is hearing you" (§9). A second teal object
//      on the same stage makes the first one mean nothing.
//
// Plus the copy: both languages, or it does not ship.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import type { Emote, LiveRig, Viseme } from "@chiku/rig";
import { CameraStage, frameQuad, type CameraStageHandle } from "../src/components/CameraStage";
import {
  MagicWindow,
  SPOTLIGHT_DIM,
  WINDOW_PALETTE,
  type MagicWindowHandle,
} from "../src/components/MagicWindow";
import {
  COVERAGE_FOUND,
  foundTarget,
  HUNT_COLOURS,
  hueDistance,
  insidePolygon,
  lensPass,
  matchesTarget,
  rgbToHsv,
  sampleSize,
} from "../src/components/magicLens";
import {
  coverRect,
  projectQuad,
  quadGaze,
  stickerScale,
  windowOpacity,
  WINDOW_GAZE_PRESENCE,
} from "../src/components/magicWindowGeometry";
import type { Quad, QuadKind } from "../src/vision/quad";
import type { VisionFrame } from "../src/vision/types";
import en from "../src/i18n/en.json";
import te from "../src/i18n/te.json";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */
/* harness                                                                     */
/* -------------------------------------------------------------------------- */

const BOX = { width: 640, height: 480 } as const;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(node: ReactNode): void {
  act(() => root.render(node));
}

function windowEl(): HTMLCanvasElement | null {
  return container.querySelector<HTMLCanvasElement>("canvas.magic-window");
}

function points(): readonly { x: number; y: number }[] {
  const attr = windowEl()?.dataset["points"];
  if (attr === undefined) throw new Error("no window drawn");
  return attr.split(" ").map((pair) => {
    const [x, y] = pair.split(",");
    return { x: Number(x), y: Number(y) };
  });
}

/** An axis-aligned quad in normalized IMAGE space, clockwise from top-left. */
function quadOf(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  presence = 1,
  kind: QuadKind = "frame",
): Quad {
  return {
    kind,
    corners: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
    centre: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
    presence,
  };
}

/**
 * Read a file from the app root. Same reasoning as cue.test.tsx: under happy-dom
 * `import.meta.url` is an http:// URL and cannot be resolved.
 */
function appFile(rel: string): string {
  for (const dir of [process.cwd(), resolve(process.cwd(), "apps/live")]) {
    try {
      return readFileSync(resolve(dir, rel), "utf8");
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`cannot read ${rel} from ${process.cwd()}`);
}

/* -------------------------------------------------------------------------- */
/* a fake 2D context                                                           */
/* -------------------------------------------------------------------------- */
//
// happy-dom's getContext returns null for BOTH "2d" and "webgl2" — which is
// exactly the no-context fallback we have to survive, so half the tests below
// simply do not install this. The other half need to see what would have been
// painted, so they install a recorder.

interface Op {
  readonly op: string;
  readonly args: readonly unknown[];
  /** True when this was drawn on the on-screen window, not the sample buffer. */
  readonly onScreen: boolean;
}

interface Recorder {
  ops: Op[];
  /** What getImageData hands back; default is a fully red buffer. */
  pixels: (w: number, h: number) => Uint8ClampedArray;
  screen: (op: string) => Op[];
  colours: () => string[];
}

function solid(r: number, g: number, b: number) {
  return (w: number, h: number): Uint8ClampedArray => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
    return data;
  };
}

function installContext(): Recorder {
  const rec: Recorder = {
    ops: [],
    pixels: solid(220, 30, 30),
    screen: (op) => rec.ops.filter((o) => o.op === op && o.onScreen),
    colours: () =>
      rec.ops
        .filter((o) => o.op === "fillStyle" || o.op === "strokeStyle")
        .map((o) => String(o.args[0])),
  };

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string,
  ): CanvasRenderingContext2D | null {
    // WebGL is genuinely absent here, as it is on the devices we care least
    // about; the lens must never need it.
    if (kind !== "2d") return null;
    const onScreen = this.classList.contains("magic-window");
    const push = (op: string, args: readonly unknown[]): void => {
      rec.ops.push({ op, args, onScreen });
    };
    const method =
      (op: string) =>
      (...args: unknown[]): void =>
        push(op, args);

    const ctx: Record<string, unknown> = {
      canvas: this,
      save: method("save"),
      restore: method("restore"),
      beginPath: method("beginPath"),
      closePath: method("closePath"),
      moveTo: method("moveTo"),
      lineTo: method("lineTo"),
      ellipse: method("ellipse"),
      clip: method("clip"),
      fill: method("fill"),
      stroke: method("stroke"),
      fillRect: method("fillRect"),
      clearRect: method("clearRect"),
      setTransform: method("setTransform"),
      translate: method("translate"),
      scale: method("scale"),
      drawImage: method("drawImage"),
      putImageData: method("putImageData"),
      lineWidth: 1,
      lineJoin: "miter",
      globalAlpha: 1,
      createRadialGradient: (...args: unknown[]) => {
        push("createRadialGradient", args);
        return { addColorStop: (): void => {} };
      },
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        push("getImageData", [w, h]);
        return { data: rec.pixels(w, h), width: w, height: h };
      },
    };
    // Assignments matter as much as calls: the composite trick and every colour
    // the window paints are properties, not methods.
    for (const prop of ["fillStyle", "strokeStyle", "globalCompositeOperation"]) {
      let value: unknown = prop === "globalCompositeOperation" ? "source-over" : "#000";
      Object.defineProperty(ctx, prop, {
        get: () => value,
        set: (next: unknown) => {
          value = next;
          push(prop, [next]);
        },
      });
    }
    return ctx as unknown as CanvasRenderingContext2D;
  });

  return rec;
}

/** A video that reports a size but hands out no pixels of its own. */
function fakeVideo(width = 640, height = 480): HTMLVideoElement {
  return { videoWidth: width, videoHeight: height } as unknown as HTMLVideoElement;
}

/* -------------------------------------------------------------------------- */
/* geometry — the pure half                                                    */
/* -------------------------------------------------------------------------- */

describe("cover mapping", () => {
  it("crops the sides when the camera is wider than the stage", () => {
    // 16:9 into a 4:3 box: full height, overflowing left and right equally.
    const rect = coverRect(16 / 9, { width: 640, height: 480 });
    expect(rect.height).toBe(480);
    expect(rect.width).toBeCloseTo(853.33, 1);
    expect(rect.x).toBeCloseTo(-106.67, 1);
    expect(rect.y).toBe(0);
  });

  it("crops top and bottom when the camera is taller than the stage", () => {
    const rect = coverRect(3 / 4, { width: 480, height: 480 });
    expect(rect.width).toBe(480);
    expect(rect.height).toBe(640);
    expect(rect.y).toBe(-80);
  });

  it("degrades to a stretch when the source size is not known yet", () => {
    expect(coverRect(0, BOX)).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    expect(coverRect(Number.NaN, BOX)).toEqual({ x: 0, y: 0, width: 640, height: 480 });
  });
});

describe("presence and breath", () => {
  it("opacity is presence, clamped", () => {
    expect(windowOpacity(0)).toBe(0);
    expect(windowOpacity(0.42)).toBeCloseTo(0.42);
    expect(windowOpacity(3)).toBe(1);
    expect(windowOpacity(Number.NaN)).toBe(0);
  });

  it("the breath is exactly 1 under reduced motion, at every instant", () => {
    for (const t of [0, 137, 650, 1300, 99_999]) {
      expect(stickerScale(t, true)).toBe(1);
    }
    expect(stickerScale(650, false)).toBeGreaterThan(1);
  });
});

describe("where Chiku looks", () => {
  it("points his eyes through the window, on the side the child sees it", () => {
    // Raw image x=0.1 is the child's RIGHT on the mirrored picture, and the rig
    // takes +x as right — same flip CameraStage applies to FaceSignal.x.
    expect(quadGaze(quadOf(0.05, 0.4, 0.15, 0.6))).toEqual({ x: 0.8, y: 0 });
    expect(quadGaze(quadOf(0.85, 0.4, 0.95, 0.6)).x).toBeCloseTo(-0.8);
    expect(quadGaze(quadOf(0.4, 0.0, 0.6, 0.2)).y).toBeCloseTo(-0.8);
  });
});

/* -------------------------------------------------------------------------- */
/* the component                                                               */
/* -------------------------------------------------------------------------- */

describe("MagicWindow", () => {
  it("draws nothing at all when there is no quad", () => {
    render(<MagicWindow mode="sticker" quad={null} size={BOX} />);
    expect(windowEl()).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("renders at the quad's position", () => {
    render(
      <MagicWindow
        mode="sticker"
        quad={quadOf(0.1, 0.2, 0.3, 0.5)}
        mirrored={false}
        sourceAspect={4 / 3}
        size={BOX}
        pixelRatio={1}
      />,
    );
    expect(points()).toEqual([
      { x: 64, y: 96 },
      { x: 192, y: 96 },
      { x: 192, y: 240 },
      { x: 64, y: 240 },
    ]);
    expect(windowEl()?.dataset["centre"]).toBe("128.0,168.0");
    // Decorative: it is the child's own hands made visible, not information.
    expect(windowEl()?.getAttribute("aria-hidden")).toBe("true");
  });

  it("opacity follows presence", () => {
    const at = (presence: number): string | undefined => {
      render(
        <MagicWindow mode="sticker" quad={quadOf(0.4, 0.4, 0.6, 0.6, presence)} size={BOX} />,
      );
      return windowEl()?.style.opacity;
    };
    expect(at(0.25)).toBe("0.25");
    expect(at(0.6)).toBe("0.6");
    expect(at(1)).toBe("1");
  });

  /* ---------------------------------------------------------------------- */
  /* the mirroring bug                                                      */
  /* ---------------------------------------------------------------------- */

  describe("mirroring", () => {
    /** Where the CSS-mirrored <video> puts a normalized image x, in element px. */
    const videoShowsAt = (u: number): number => (1 - u) * BOX.width;

    it("lands on the same pixels the mirrored video puts that hand on", () => {
      const quad = quadOf(0.1, 0.2, 0.3, 0.5);
      render(
        <MagicWindow mode="sticker" quad={quad} sourceAspect={4 / 3} size={BOX} pixelRatio={1} />,
      );
      const drawn = points();
      // Corner 0 is the quad's top-left IN THE IMAGE; mirrored, it is drawn on
      // the right. Compare against the video's own mapping, not against a sign.
      expect(drawn[0]?.x).toBeCloseTo(videoShowsAt(0.1), 5);
      expect(drawn[1]?.x).toBeCloseTo(videoShowsAt(0.3), 5);
      // y is never mirrored.
      expect(drawn[0]?.y).toBeCloseTo(0.2 * BOX.height, 5);
    });

    it("puts the window where the CHILD sees their hand, on both sides", () => {
      // A hand at the left of the MIRRORED view (what the child perceives as
      // their left) is at raw x ~0.8 in the unmirrored camera image.
      render(
        <MagicWindow
          mode="sticker"
          quad={quadOf(0.75, 0.4, 0.95, 0.6)}
          sourceAspect={4 / 3}
          size={BOX}
          pixelRatio={1}
        />,
      );
      const leftOfView = points();
      expect(Math.max(...leftOfView.map((p) => p.x))).toBeLessThan(BOX.width / 2);

      // ...and the mirror image of that case ends up on the other half.
      render(
        <MagicWindow
          mode="sticker"
          quad={quadOf(0.05, 0.4, 0.25, 0.6)}
          sourceAspect={4 / 3}
          size={BOX}
          pixelRatio={1}
        />,
      );
      const rightOfView = points();
      expect(Math.min(...rightOfView.map((p) => p.x))).toBeGreaterThan(BOX.width / 2);
    });

    it("records which convention it used, so a regression is legible", () => {
      render(<MagicWindow mode="sticker" quad={quadOf(0.1, 0.1, 0.2, 0.2)} size={BOX} />);
      expect(windowEl()?.dataset["mirrored"]).toBe("true");
    });

    it("keeps the cover crop and the mirror consistent", () => {
      // 16:9 camera in a 4:3 stage: the image overflows to x=-106.67..746.67,
      // and a mirrored point must be measured against THAT rect, not the box.
      render(
        <MagicWindow
          mode="sticker"
          quad={quadOf(0.25, 0.4, 0.35, 0.6)}
          sourceAspect={16 / 9}
          size={BOX}
          pixelRatio={1}
        />,
      );
      const rect = coverRect(16 / 9, BOX);
      expect(points()[0]?.x).toBeCloseTo(rect.x + (1 - 0.25) * rect.width, 1);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* reduced motion                                                          */
  /* ---------------------------------------------------------------------- */

  describe("reduced motion", () => {
    const quad = quadOf(0.4, 0.4, 0.6, 0.6);

    it("is static: the same geometry at any two moments", () => {
      let clock = 0;
      const view = (t: number): void => {
        clock = t;
        render(
          <MagicWindow
            mode="sticker"
            quad={quad}
            reducedMotion
            now={() => clock}
            size={BOX}
            pixelRatio={1}
          />,
        );
      };
      view(0);
      const first = { scale: windowEl()?.dataset["scale"], pts: windowEl()?.dataset["points"] };
      view(650);
      expect(windowEl()?.dataset["motion"]).toBe("static");
      expect(windowEl()?.dataset["scale"]).toBe(first.scale);
      expect(windowEl()?.dataset["scale"]).toBe("1.0000");
      expect(windowEl()?.dataset["points"]).toBe(first.pts);
    });

    it("breathes otherwise", () => {
      let clock = 0;
      const view = (t: number): void => {
        clock = t;
        render(
          <MagicWindow mode="sticker" quad={quad} now={() => clock} size={BOX} pixelRatio={1} />,
        );
      };
      view(0);
      const at0 = windowEl()?.dataset["scale"];
      view(650);
      expect(windowEl()?.dataset["motion"]).toBe("breathing");
      expect(windowEl()?.dataset["scale"]).not.toBe(at0);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* the camera-rate path                                                    */
  /* ---------------------------------------------------------------------- */

  it("mounts and unmounts from the imperative handle, without prop churn", () => {
    const handle = { current: null as MagicWindowHandle | null };
    render(<MagicWindow ref={handle} mode="sticker" size={BOX} pixelRatio={1} />);
    expect(windowEl()).toBeNull();

    act(() => handle.current?.setQuad(quadOf(0.4, 0.4, 0.6, 0.6, 0.5)));
    expect(windowEl()).not.toBeNull();
    expect(windowEl()?.style.opacity).toBe("0.5");

    // A second push at the same presence must not need a React render to move.
    act(() => handle.current?.setQuad(quadOf(0.1, 0.1, 0.2, 0.2, 0.5)));
    expect(windowEl()?.dataset["centre"]).toBe(`${(1 - 0.15) * 640}.0,${0.15 * 480}.0`);

    act(() => handle.current?.setQuad(null));
    expect(windowEl()).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* the three modes                                                             */
/* -------------------------------------------------------------------------- */

describe("modes", () => {
  it("sticker fades a scene in behind a clip on the quad", () => {
    const rec = installContext();
    render(
      <MagicWindow
        mode="sticker"
        quad={quadOf(0.3, 0.3, 0.7, 0.7, 0.4)}
        size={BOX}
        pixelRatio={1}
      />,
    );
    expect(rec.screen("clip").length).toBeGreaterThan(0);
    expect(rec.screen("createRadialGradient").length).toBe(1);
    // The fade is the element's opacity, not a per-op alpha, so the whole scene
    // fades as one object.
    expect(windowEl()?.style.opacity).toBe("0.4");
  });

  it("a palm window is a circle, not a square", () => {
    const rec = installContext();
    render(
      <MagicWindow
        mode="sticker"
        quad={quadOf(0.3, 0.3, 0.7, 0.7, 1, "palm")}
        size={BOX}
        pixelRatio={1}
      />,
    );
    // The OUTLINE is an ellipse. (There are lineTo calls afterwards — the star
    // inside the window is drawn with them — so the check is about order.)
    const outline = rec.ops.findIndex((o) => o.op === "ellipse");
    const firstLine = rec.ops.findIndex((o) => o.op === "lineTo");
    expect(outline).toBeGreaterThanOrEqual(0);
    expect(outline).toBeLessThan(firstLine);
  });

  it("spotlight dims the room and punches the window out of the darkness", () => {
    const rec = installContext();
    render(
      <MagicWindow mode="spotlight" quad={quadOf(0.4, 0.4, 0.6, 0.6)} size={BOX} pixelRatio={1} />,
    );
    const dim = rec.screen("fillRect")[0];
    expect(dim?.args).toEqual([0, 0, BOX.width, BOX.height]);
    const composite = rec.ops.find((o) => o.op === "globalCompositeOperation");
    expect(composite?.args[0]).toBe("destination-out");
    // ...and the hole is punched AFTER the darkness is laid down.
    const order = rec.ops.filter(
      (o) => o.op === "fillRect" || o.op === "globalCompositeOperation" || o.op === "fill",
    );
    expect(order.map((o) => o.op).slice(0, 3)).toEqual([
      "fillRect",
      "globalCompositeOperation",
      "fill",
    ]);
    expect(SPOTLIGHT_DIM).toBeLessThan(1);
  });
});

/* -------------------------------------------------------------------------- */
/* the lens                                                                    */
/* -------------------------------------------------------------------------- */

describe("lens pixels", () => {
  it("keeps the target colour and drains the rest", () => {
    const width = 4;
    const height = 1;
    const data = new Uint8Array([
      220, 30, 30, 255, // red   — kept
      40, 90, 200, 255, // blue  — drained
      210, 205, 200, 255, // near-white, no hue — drained
      190, 20, 25, 255, // red   — kept
    ]);
    const sample = { data: new Uint8ClampedArray(data), width, height };
    const poly = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 1 },
      { x: 0, y: 1 },
    ];
    const result = lensPass(sample, poly, HUNT_COLOURS.red);
    expect(result).toMatchObject({ matched: 2, inside: 4 });
    expect(result.coverage).toBe(0.5);
    // The kept pixels are untouched; the drained ones are grey.
    expect([...sample.data.slice(0, 3)]).toEqual([220, 30, 30]);
    const grey = [...sample.data.slice(4, 7)];
    expect(new Set(grey).size).toBe(1);
  });

  it("erases everything outside the window, so the room is only lensed inside it", () => {
    const sample = { data: solid(220, 30, 30)(4, 4), width: 4, height: 4 };
    // A polygon covering only the left half.
    const poly = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 4 },
      { x: 0, y: 4 },
    ];
    const result = lensPass(sample, poly, HUNT_COLOURS.red);
    expect(result.inside).toBe(8);
    expect(result.coverage).toBe(1);
    expect(sample.data[3]).toBe(255); // inside, opaque
    expect(sample.data[(0 * 4 + 3) * 4 + 3]).toBe(0); // outside, erased
  });

  it("is lenient: a child pointing roughly at something red still succeeds", () => {
    // One eighth of the window is red, the rest is a beige wall.
    const w = 8;
    const h = 8;
    const data = solid(210, 190, 170)(w, h);
    for (let i = 0; i < w * h * 4; i += 4) {
      if ((i / 4) % 8 === 0) {
        data[i] = 200;
        data[i + 1] = 25;
        data[i + 2] = 30;
      }
    }
    const poly = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];
    const { coverage } = lensPass({ data, width: w, height: h }, poly, HUNT_COLOURS.red);
    expect(coverage).toBeCloseTo(0.125, 5);
    expect(foundTarget(coverage)).toBe(true);
    expect(COVERAGE_FOUND).toBeLessThanOrEqual(0.15);
  });

  it("does not call a hand red", () => {
    // Warm skin under indoor light: hue ~20-25°, saturation ~0.4.
    expect(matchesTarget(214, 150, 120, HUNT_COLOURS.red)).toBe(false);
    expect(matchesTarget(190, 130, 110, HUNT_COLOURS.red)).toBe(false);
    // ...but a genuinely red thing is red.
    expect(matchesTarget(198, 32, 40, HUNT_COLOURS.red)).toBe(true);
  });

  it("knows its colour maths", () => {
    expect(rgbToHsv(255, 0, 0)).toMatchObject({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv(0, 255, 0).h).toBe(120);
    expect(rgbToHsv(0, 0, 255).h).toBe(240);
    expect(rgbToHsv(10, 10, 10).s).toBe(0);
    expect(hueDistance(350, 10)).toBe(20);
    expect(hueDistance(10, 350)).toBe(20);
    expect(insidePolygon(
      [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
        { x: 0, y: 2 },
      ],
      1,
      1,
    )).toBe(true);
  });

  it("never samples more than a small buffer, whatever the window's size", () => {
    expect(sampleSize(1280, 720)).toEqual({ width: 96, height: 54 });
    expect(sampleSize(40, 30)).toEqual({ width: 40, height: 30 });
    expect(sampleSize(0, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe("lens rendering", () => {
  const quad = quadOf(0.2, 0.25, 0.5, 0.75);

  it("falls back with no canvas context at all, and does not throw", () => {
    // No installContext(): happy-dom refuses both "2d" and "webgl2", which is
    // the same shape as a browser that refuses a context under pressure.
    const coverage: number[] = [];
    expect(() =>
      render(
        <MagicWindow
          mode="lens"
          quad={quad}
          target="red"
          source={() => fakeVideo()}
          size={BOX}
          pixelRatio={1}
          onCoverage={(c) => coverage.push(c)}
        />,
      ),
    ).not.toThrow();
    const el = windowEl();
    expect(el).not.toBeNull();
    expect(el?.dataset["lensBackend"]).toBe("none");
    // Geometry is still published — the surface can still point Chiku's gaze.
    expect(el?.dataset["points"]).toBeDefined();
    expect(coverage).toEqual([]);
  });

  it("falls back to a plain window when there is no video to sample", () => {
    const rec = installContext();
    render(<MagicWindow mode="lens" quad={quad} target="red" size={BOX} pixelRatio={1} />);
    expect(windowEl()?.dataset["lensBackend"]).toBe("none");
    // Still a window: clipped, tinted, rimmed. The child's hands did something.
    expect(rec.screen("clip").length).toBeGreaterThan(0);
    expect(rec.screen("stroke").length).toBeGreaterThan(0);
    expect(rec.screen("getImageData").length).toBe(0);
  });

  it("runs the CPU pass and reports coverage when it can sample", () => {
    const rec = installContext();
    const seen: number[] = [];
    render(
      <MagicWindow
        mode="lens"
        quad={quad}
        target="red"
        source={() => fakeVideo()}
        size={BOX}
        pixelRatio={1}
        onCoverage={(c) => seen.push(c)}
      />,
    );
    expect(windowEl()?.dataset["lensBackend"]).toBe("canvas2d");
    expect(windowEl()?.dataset["coverage"]).toBe("1.000");
    expect(seen).toEqual([1]);
    // Sampled small, off-screen, then blitted once into the clipped window.
    const sampled = rec.ops.filter((o) => o.op === "getImageData" && !o.onScreen)[0];
    // 0.3 x 0.5 of a 640x480 image is 192x240 source pixels, capped to 96 on
    // the long side: 9 kilopixels of CPU work, not two million.
    expect(sampled?.args).toEqual([77, 96]);
    expect(rec.screen("drawImage").length).toBe(1);
  });

  it("reports nothing found when the room has none of the colour", () => {
    const rec = installContext();
    rec.pixels = solid(40, 90, 200);
    const seen: number[] = [];
    render(
      <MagicWindow
        mode="lens"
        quad={quad}
        target="red"
        source={() => fakeVideo()}
        size={BOX}
        pixelRatio={1}
        onCoverage={(c) => seen.push(c)}
      />,
    );
    expect(windowEl()?.dataset["coverage"]).toBe("0.000");
    expect(foundTarget(0)).toBe(false);
    // Nothing found is the state the activity already assumes, so it is not
    // announced — the callback fires on news, not on every frame.
    expect(seen).toEqual([]);
  });

  it("blits the drained room back mirrored, over the pixels it came from", () => {
    const rec = installContext();
    render(
      <MagicWindow
        mode="lens"
        quad={quad}
        target="red"
        source={() => fakeVideo()}
        sourceAspect={4 / 3}
        size={BOX}
        pixelRatio={1}
      />,
    );
    // The source rect is x 0.2..0.5 of the image; mirrored, that is x 0.5..0.8
    // of the element — so the blit is anchored at the far edge and flipped.
    const translate = rec.screen("translate")[0];
    expect(translate?.args[0]).toBeCloseTo((1 - 0.2) * BOX.width, 5);
    expect(translate?.args[1]).toBeCloseTo(0.25 * BOX.height, 5);
    const flip = rec.screen("scale").find((o) => o.args[0] === -1);
    expect(flip?.args).toEqual([-1, 1]);
    const blit = rec.screen("drawImage")[0];
    expect(blit?.args[3]).toBeCloseTo(0.3 * BOX.width, 5);
    expect(blit?.args[4]).toBeCloseTo(0.5 * BOX.height, 5);
  });

  it("blits unflipped when the stage is not mirrored", () => {
    const rec = installContext();
    render(
      <MagicWindow
        mode="lens"
        quad={quad}
        target="red"
        mirrored={false}
        source={() => fakeVideo()}
        size={BOX}
        pixelRatio={1}
      />,
    );
    expect(rec.screen("scale").find((o) => o.args[0] === -1)).toBeUndefined();
    expect(rec.screen("drawImage")[0]?.args[1]).toBeCloseTo(0.2 * BOX.width, 5);
  });
});

/* -------------------------------------------------------------------------- */
/* the reserved colour                                                         */
/* -------------------------------------------------------------------------- */

describe("teal is not ours", () => {
  const TEAL = "2f8f86";

  it("no colour the window paints is teal", () => {
    const rec = installContext();
    for (const mode of ["sticker", "spotlight", "lens"] as const) {
      render(
        <MagicWindow
          mode={mode}
          quad={quadOf(0.3, 0.3, 0.7, 0.7)}
          source={() => fakeVideo()}
          size={BOX}
          pixelRatio={1}
        />,
      );
    }
    const painted = rec.colours();
    expect(painted.length).toBeGreaterThan(0);
    for (const colour of painted) {
      expect(colour.toLowerCase()).not.toContain(TEAL);
      expect(colour).not.toContain("47, 143, 134");
    }
    for (const value of Object.values(WINDOW_PALETTE)) {
      expect(value.toLowerCase()).not.toBe(`#${TEAL}`);
    }
  });

  it("the stylesheet does not reach for the reserved token either", () => {
    const css = appFile("src/styles.css");
    const block = css.slice(css.indexOf(".magic-window {"));
    const rule = block.slice(0, block.indexOf("}"));
    expect(rule.length).toBeGreaterThan(10);
    expect(rule).not.toContain("--kid-teal");
    // ...and it must not mirror the canvas: the flip is done once, in JS.
    expect(rule).not.toContain("scaleX");
  });
});

/* -------------------------------------------------------------------------- */
/* the copy                                                                    */
/* -------------------------------------------------------------------------- */

describe("copy", () => {
  const NEW_KEYS = [
    "window.invite",
    "window.hunt.red",
    "window.hunt.green",
    "window.hunt.yellow",
    "window.hunt.blue",
  ] as const;

  const dicts: Record<string, Record<string, string>> = { en, te };

  it("exists in both languages", () => {
    for (const key of NEW_KEYS) {
      for (const lang of ["en", "te"] as const) {
        const line = dicts[lang]?.[key];
        expect(line, `${lang} is missing ${key}`).toBeDefined();
        expect(line?.trim().length ?? 0, `${lang} ${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("the Telugu is Telugu, not English wearing a te tag", () => {
    const telugu = /[ఀ-౿]/;
    for (const key of NEW_KEYS) {
      const line = dicts["te"]?.[key] ?? "";
      expect(telugu.test(line), `${key} has no Telugu script`).toBe(true);
      expect(line).not.toBe(dicts["en"]?.[key]);
    }
  });

  it("has one hunt line per colour the lens can actually find", () => {
    for (const colour of Object.keys(HUNT_COLOURS)) {
      expect(NEW_KEYS).toContain(`window.hunt.${colour}`);
    }
  });

  it("invites a window without naming a gesture the youngest cannot make", () => {
    // The ladder is palm / pinch / frame; the copy must fit all three, so it may
    // not say "both hands" or "fingers".
    for (const lang of ["en", "te"] as const) {
      const line = (dicts[lang]?.["window.invite"] ?? "").toLowerCase();
      expect(line).not.toContain("both hands");
      expect(line).not.toContain("fingers");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* wired into the stage                                                        */
/* -------------------------------------------------------------------------- */

interface RigSpy {
  factory: (host: HTMLElement) => LiveRig;
  gaze: Array<[number, number]>;
}

function makeRigSpy(): RigSpy {
  const spy: RigSpy = { factory: () => ({}) as LiveRig, gaze: [] };
  spy.factory = (host) => {
    const node = host.ownerDocument.createElement("div");
    host.appendChild(node);
    return {
      setEmote(_e: Emote) {},
      setViseme(_v: Viseme | null) {},
      setGaze(x, y) {
        spy.gaze.push([x, y]);
      },
      setMouthOpen() {},
      setAttention() {},
      blink() {},
      debug: () => ({ gazeX: 0, gazeY: 0, mouthOpen: 0, emote: "idle" as Emote }),
      dispose() {
        node.remove();
      },
    };
  };
  return spy;
}

function visionFrame(patch: Partial<VisionFrame> & { t: number }): VisionFrame {
  return { face: null, hands: [], totalFingers: null, waving: false, ...patch };
}

/**
 * `quad` is a real field on VisionFrame now, so this is an ordinary spread and
 * NOT a cast. It used to be `{ ...frame, quad } as VisionFrame`, mirroring the
 * widening cast that `frameQuad` itself carried while the vision layer caught
 * up. Both are gone: the compiler enforces the shape at each end, which is the
 * only version of this that can fail before a child's device does.
 */
function withQuad(frame: VisionFrame, quad: Quad | null): VisionFrame {
  return { ...frame, quad };
}

describe("CameraStage wiring", () => {
  it("reads a quad off the frame, and tolerates frames that carry none", () => {
    const base = visionFrame({ t: 0 });
    expect(frameQuad(base)).toBeNull();
    const quad = quadOf(0.4, 0.4, 0.6, 0.6);
    expect(frameQuad(withQuad(base, quad))).toBe(quad);
    // An explicit null is a frame that looked and found nothing, and folds to
    // the same answer as a frame that never carried the field.
    expect(frameQuad(withQuad(base, null))).toBeNull();
  });

  it("mounts no window unless a mode is asked for", () => {
    const rig = makeRigSpy();
    const handle = { current: null as CameraStageHandle | null };
    render(
      <CameraStage
        ref={handle}
        cameraOn
        attending
        reducedMotion={false}
        videoLabel="you"
        rigFactory={rig.factory}
      />,
    );
    act(() => {
      handle.current?.applyFrame(withQuad(visionFrame({ t: 0 }), quadOf(0.4, 0.4, 0.6, 0.6)));
    });
    expect(windowEl()).toBeNull();
    expect(handle.current?.magicWindow()).toBeNull();
  });

  it("paints the window from applyFrame and looks through it with the child", () => {
    const rig = makeRigSpy();
    const handle = { current: null as CameraStageHandle | null };
    render(
      <CameraStage
        ref={handle}
        cameraOn
        attending
        reducedMotion={false}
        videoLabel="you"
        rigFactory={rig.factory}
        windowMode="sticker"
      />,
    );
    expect(windowEl()).toBeNull();

    const quad = quadOf(0.05, 0.4, 0.15, 0.6, 1);
    act(() => {
      handle.current?.applyFrame(
        withQuad(visionFrame({ t: 0, face: { x: -0.9, y: 0, attention: 0.9, smile: 0 } }), quad),
      );
    });
    expect(windowEl()).not.toBeNull();
    expect(handle.current?.magicWindow()).not.toBeNull();
    // The window outranks the face: the last gaze of the frame is the window's.
    expect(rig.gaze.at(-1)).toEqual([0.8, 0]);

    // A window the child is barely holding does not steal his eyes.
    rig.gaze.length = 0;
    act(() => {
      handle.current?.applyFrame(
        withQuad(
          visionFrame({ t: 33, face: { x: -0.9, y: 0, attention: 0.9, smile: 0 } }),
          quadOf(0.05, 0.4, 0.15, 0.6, WINDOW_GAZE_PRESENCE / 2),
        ),
      );
    });
    expect(rig.gaze.at(-1)).toEqual([0.9, 0]);

    // ...and when the hands come down, the window goes with them.
    act(() => {
      handle.current?.applyFrame(withQuad(visionFrame({ t: 66 }), null));
    });
    expect(windowEl()).toBeNull();
  });
});
