// @vitest-environment happy-dom
//
// THE COLOUR HUNT — the first activity whose answer is not on the child's body
// but somewhere in their own room.
//
// Phase 4 built the whole magic window and shipped it dark: the lens, the
// coverage maths and the copy all existed and passed their tests, and no child
// could reach any of it. These tests exist to make "reachable" a fact rather
// than a claim, so they mostly drive the REAL path — a real quad through the
// real CameraStage into the real MagicWindow, whose real Canvas2D lens pass
// produces the coverage number the activity then scores. The only fakes are
// the things a headless browser genuinely does not have: a 2D context, a video
// with pixels, and a box with a size.
//
// What is pinned here, in order of how badly it would hurt a child:
//
//   1. NO WINDOW IS NOT A WRONG ANSWER. The hunt is the one activity where the
//      child must build the input device before they can use it. Scoring "I
//      have not worked out the gesture yet" as a miss would spend their slack
//      on our own onboarding.
//   2. IT COMPLETES. Coverage past the (deliberately low) bar ends the round in
//      praise, and survives the tracker blinking the window out mid-hold.
//   3. IT IS NOT A DEAD END WITH NO CAMERA. Swatches, tapped, exactly like
//      every other activity.
//   4. CHIKU IS LOOKING THROUGH IT. His gaze goes to the window's centre, not
//      to the child's nose — a character who keeps his eyes on your face while
//      you hold something up to show him is not really with you.
//   5. THE LADDER STILL WORKS. A hunt is an activity like any other; the mercy
//      ladder must escalate on it, and its "watch me" rung must show a colour,
//      because no pose means "red".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Emote, LiveRig, Viseme } from "@chiku/rig";
import type { VisionEngine, VisionFrame, VisionStatus } from "../src/vision/types";
import type { Quad } from "../src/vision/quad";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */
/* the fake vision engine                                                      */
/* -------------------------------------------------------------------------- */

const vision = vi.hoisted(() => {
  const frameCbs = new Set<(f: VisionFrame) => void>();
  const statusCbs = new Set<(s: VisionStatus, detail?: string) => void>();
  const state = { grant: true, starts: 0, stops: 0 };
  const live = { status: "idle" as VisionStatus };

  const engine: VisionEngine = {
    get status(): VisionStatus {
      return live.status;
    },
    async start() {
      state.starts += 1;
      if (!state.grant) {
        live.status = "denied";
        for (const cb of [...statusCbs]) cb("denied");
        throw new Error("NotAllowedError");
      }
      live.status = "ready";
      for (const cb of [...statusCbs]) cb("ready");
    },
    stop() {
      state.stops += 1;
    },
    setCalibration() {},
    onFrame(cb) {
      frameCbs.add(cb);
      return () => {
        frameCbs.delete(cb);
      };
    },
    onStatus(cb) {
      statusCbs.add(cb);
      return () => {
        statusCbs.delete(cb);
      };
    },
    dispose() {
      frameCbs.clear();
      statusCbs.clear();
    },
  };

  return {
    engine,
    state,
    push(frame: VisionFrame): void {
      for (const cb of [...frameCbs]) cb(frame);
    },
    reset(): void {
      frameCbs.clear();
      statusCbs.clear();
      live.status = "idle";
      state.grant = true;
      state.starts = 0;
      state.stops = 0;
    },
  };
});

vi.mock("../src/vision/engine", () => ({
  createVisionEngine: () => vision.engine,
}));

import { Live } from "../src/surfaces/live/Live";
import { LangProvider } from "../src/i18n";
import type { RigFactory } from "../src/components/CameraStage";
import { buildRound, FACTORIES, ROUND_LENGTH } from "../src/activities";
import { createHuntActivity, HUNT_HOLD_MS, HUNT_PRESENCE } from "../src/activities/hunt";
import { verdictFor, type Activity } from "../src/activities/types";
import {
  COVERAGE_FOUND,
  HUNT_COLOURS,
  HUNT_ORDER,
  HUNT_SWATCH,
  matchesTarget,
  type HuntColour,
} from "../src/components/magicLens";
import { quadGaze } from "../src/components/magicWindowGeometry";
import en from "../src/i18n/en.json";
import te from "../src/i18n/te.json";

/* -------------------------------------------------------------------------- */
/* builders                                                                    */
/* -------------------------------------------------------------------------- */

function frame(patch: Partial<VisionFrame> & { t: number }): VisionFrame {
  return { face: null, hands: [], totalFingers: null, waving: false, ...patch };
}

function face(x: number, y: number, attention = 0.9, smile = 0): VisionFrame["face"] {
  return { x, y, attention, smile };
}

/**
 * A window the child is holding. Corners span the middle of the image so the
 * lens has a real region to sample; `centre` is independent so the gaze test
 * can put the window somewhere Chiku's face-tracking would never point him.
 */
function quad(patch: Partial<Quad> = {}): Quad {
  return {
    kind: "pinch",
    corners: [
      { x: 0.3, y: 0.3 },
      { x: 0.7, y: 0.3 },
      { x: 0.7, y: 0.7 },
      { x: 0.3, y: 0.7 },
    ],
    centre: { x: 0.5, y: 0.5 },
    presence: 0.9,
    ...patch,
  };
}

/**
 * A random that hands back a fixed prefix and then a constant.
 *
 * The surface tests elsewhere all use a constant 0.5, which — with the hunt
 * inserted where it is in FACTORIES — draws [fingers, smile, wave]. This one
 * draws a round that STARTS with the hunt, on red, with the swatches in
 * HUNT_ORDER. Every number is doing a job: three for the shuffle, one for the
 * target colour, one for the swatch rotation.
 */
function seq(...values: readonly number[]): () => number {
  let i = 0;
  return () => values[i++] ?? 0.5;
}

/** [hunt(red), wave, smile], swatches unrotated. */
const HUNT_FIRST = (): (() => number) => seq(0, 0, 0.9, 0, 0);
/** The constant every other surface test uses: [fingers, smile, wave]. */
const HALF = (): number => 0.5;

/* -------------------------------------------------------------------------- */
/* the fake rig                                                                */
/* -------------------------------------------------------------------------- */

interface RigSpy {
  factory: RigFactory;
  gaze: Array<[number, number]>;
  emotes: Emote[];
}

function makeRigSpy(): RigSpy {
  const spy: RigSpy = { factory: () => ({}) as LiveRig, gaze: [], emotes: [] };
  spy.factory = (host) => {
    const node = host.ownerDocument.createElement("div");
    node.setAttribute("data-rig-stub", "");
    host.appendChild(node);
    const rig: LiveRig = {
      setEmote(emote: Emote) {
        spy.emotes.push(emote);
      },
      setViseme(_viseme: Viseme | null) {},
      setGaze(x, y) {
        spy.gaze.push([x, y]);
      },
      setMouthOpen() {},
      setAttention() {},
      blink() {},
      debug: () => ({ gazeX: 0, gazeY: 0, mouthOpen: 0, emote: "idle" }),
      dispose() {
        node.remove();
      },
    };
    return rig;
  };
  return spy;
}

/* -------------------------------------------------------------------------- */
/* a headless browser that can actually paint                                  */
/* -------------------------------------------------------------------------- */
//
// happy-dom has no 2D context, no video pixels and no layout, and the window
// degrades gracefully on all three (window.test.tsx pins that). But then the
// lens never runs, and "coverage completes the hunt" would be a test of a
// mocked number. So this installs the three missing pieces and lets the REAL
// lensPass run over a real buffer.

interface Ctx2dStub {
  pixels: (w: number, h: number) => Uint8ClampedArray;
}

/** A buffer of one flat colour, as a camera pointed at a red cushion would be. */
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

function installContext(): Ctx2dStub {
  const stub: Ctx2dStub = { pixels: solid(220, 30, 30) };
  const noop = (): void => {};

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    kind: string,
  ): CanvasRenderingContext2D | null {
    if (kind !== "2d") return null;
    const ctx: Record<string, unknown> = {
      save: noop,
      restore: noop,
      beginPath: noop,
      closePath: noop,
      moveTo: noop,
      lineTo: noop,
      ellipse: noop,
      clip: noop,
      fill: noop,
      stroke: noop,
      fillRect: noop,
      clearRect: noop,
      setTransform: noop,
      translate: noop,
      scale: noop,
      drawImage: noop,
      putImageData: noop,
      lineWidth: 1,
      lineJoin: "miter",
      fillStyle: "#000",
      strokeStyle: "#000",
      globalCompositeOperation: "source-over",
      createRadialGradient: () => ({ addColorStop: noop }),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: stub.pixels(w, h),
        width: w,
        height: h,
      }),
    };
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);

  // Layout. Without a box the window measures 0 and paints nothing at all.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    top: 0,
    left: 0,
    right: 640,
    bottom: 480,
    toJSON: () => ({}),
  } as DOMRect);

  return stub;
}

/** The self-view reports a size, so the lens knows how big a region to sample. */
function stubVideoSize(): void {
  const video = container.querySelector("video");
  if (!video) throw new Error("no self-view to stub");
  Object.defineProperty(video, "videoWidth", { configurable: true, get: () => 640 });
  Object.defineProperty(video, "videoHeight", { configurable: true, get: () => 480 });
}

/* -------------------------------------------------------------------------- */
/* harness                                                                     */
/* -------------------------------------------------------------------------- */

let container: HTMLDivElement;
let root: Root;
let rig: RigSpy;

function click(el: Element | null): void {
  if (!el) throw new Error("nothing to click");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function action(key: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-action="${key}"]`);
}

function text(): string {
  return container.textContent ?? "";
}

function windowEl(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-testid='magic-window']");
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function mount(random: () => number): void {
  act(() => {
    root.render(
      <LangProvider>
        <Live random={random} rigFactory={rig.factory} />
      </LangProvider>,
    );
  });
}

function okFetch(): void {
  vi.stubGlobal(
    "fetch",
    async () => ({ ok: true, status: 200, blob: async () => null }) as unknown as Response,
  );
}

async function enterPlaying(grant: boolean, random: () => number): Promise<void> {
  vision.state.grant = grant;
  mount(random);
  click(action("welcome.begin"));
  const allow = action("camera.allow");
  await act(async () => {
    allow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

/**
 * One frame per act, deliberately.
 *
 * The window appearing is a React commit, and the canvas it paints into does
 * not exist until that commit lands. Pushing a whole sequence inside one act
 * would batch every frame against a stage that has no canvas yet — which is a
 * fine model of nothing at all.
 */
function pushFrames(frames: readonly VisionFrame[]): void {
  for (const f of frames) {
    act(() => {
      vision.push(f);
    });
  }
}

beforeEach(() => {
  vision.reset();
  okFetch();
  rig = makeRigSpy();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ========================================================================== */
/* the activity, on its own                                                   */
/* ========================================================================== */

describe("hunt — scoring one frame", () => {
  const hunt = (): Activity => createHuntActivity(seq(0, 0));

  it("says yes once the window is past the (low) coverage bar", () => {
    const act1 = hunt();
    const f = frame({ t: 0, quad: quad(), windowCoverage: COVERAGE_FOUND });
    expect(act1.hasEvidence(f)).toBe(true);
    expect(act1.matches(f)).toBe(true);
    expect(verdictFor(act1, f)).toBe("match");
  });

  it("is lenient: a twelfth of the window is a find, not a near miss", () => {
    // The whole design of this activity is a tight hue band and a low bar. A
    // child pointing roughly at a red cup, with their own fingers eating the
    // edges of their window, must succeed.
    expect(COVERAGE_FOUND).toBeLessThanOrEqual(0.15);
    const act1 = hunt();
    expect(act1.matches(frame({ t: 0, quad: quad(), windowCoverage: 0.13 }))).toBe(true);
    expect(act1.matches(frame({ t: 0, quad: quad(), windowCoverage: 0.4 }))).toBe(true);
  });

  it("NO WINDOW IS UNKNOWN, NEVER A MISS", () => {
    const act1 = hunt();
    // Nothing at all…
    const empty = frame({ t: 0 });
    expect(act1.hasEvidence(empty)).toBe(false);
    expect(verdictFor(act1, empty)).toBe("unknown");
    // …an explicit null…
    const none = frame({ t: 0, quad: null });
    expect(verdictFor(act1, none)).toBe("unknown");
    // …and a window that is only a ghost of itself. Presence is a fade, and
    // the tail of one is not a child holding something up.
    const ghost = frame({ t: 0, quad: quad({ presence: HUNT_PRESENCE / 2 }), windowCoverage: 0.9 });
    expect(verdictFor(act1, ghost)).toBe("unknown");
  });

  it("a real window over the wrong colour IS a mismatch — that is evidence", () => {
    const act1 = hunt();
    const f = frame({ t: 0, quad: quad(), windowCoverage: 0.01 });
    expect(act1.hasEvidence(f)).toBe(true);
    expect(verdictFor(act1, f)).toBe("mismatch");
  });

  it("fails closed when nobody measured: no coverage field is not a win", () => {
    const act1 = hunt();
    expect(act1.matches(frame({ t: 0, quad: quad() }))).toBe(false);
  });

  it("holds for less time than the finger count, and for a reason", () => {
    // A hand passes through 2 and 4 on its way to 3; a window does not pass
    // through "12% red" on its way anywhere.
    expect(hunt().holdMs).toBe(HUNT_HOLD_MS);
    expect(HUNT_HOLD_MS).toBeLessThan(600);
  });
});

describe("hunt — the tap answer is the colour", () => {
  it("offers one swatch per colour, exactly one of them correct", () => {
    const act1 = createHuntActivity(seq(0, 0));
    expect(act1.choices.length).toBe(HUNT_ORDER.length);
    expect(act1.choices.map((c) => c.swatch)).toEqual([...HUNT_ORDER]);
    expect(act1.choices.filter((c) => c.correct).length).toBe(1);
    // No digits and no glyphs: nothing to read and no shape to decode.
    expect(act1.choices.every((c) => c.digit === undefined && c.glyph === undefined)).toBe(true);
  });

  it("the correct swatch IS the colour the lens is keeping", () => {
    for (let i = 0; i < HUNT_ORDER.length; i += 1) {
      const act1 = createHuntActivity(seq(i / HUNT_ORDER.length, 0));
      const correct = act1.choices.find((c) => c.correct);
      expect(correct?.swatch).toBe(act1.huntColour);
      expect(act1.huntColour).toBe(HUNT_ORDER[i]);
    }
  });

  it("moves the correct swatch around, so position is never the answer", () => {
    const first = createHuntActivity(seq(0, 0)).choices.findIndex((c) => c.correct);
    const later = createHuntActivity(seq(0, 0.6)).choices.findIndex((c) => c.correct);
    expect(first).not.toBe(later);
  });

  it("still names the colour for a child who is listening, not looking", () => {
    for (const choice of createHuntActivity(seq(0, 0)).choices) {
      expect(Object.prototype.hasOwnProperty.call(en, choice.labelKey)).toBe(true);
    }
  });
});

describe("hunt — saying it out loud counts", () => {
  const spoken: Readonly<Record<HuntColour, readonly string[]>> = {
    red: ["ఎరుపు", "erupu", "red", "it's erupu!", "ERRA"],
    green: ["ఆకుపచ్చ", "పచ్చ", "paccha", "green", "aakupaccha"],
    yellow: ["పసుపు", "pasupu", "yellow"],
    blue: ["నీలం", "neelam", "nilam", "blue"],
  };

  for (let i = 0; i < HUNT_ORDER.length; i += 1) {
    const colour = HUNT_ORDER[i] as HuntColour;
    it(`accepts ${colour} in Telugu script, transliteration and English`, () => {
      const act1 = createHuntActivity(seq(i / HUNT_ORDER.length, 0));
      expect(act1.huntColour).toBe(colour);
      for (const utterance of spoken[colour]) {
        expect(act1.accepts(utterance)).toBe(true);
      }
    });
  }

  it("does not accept a different colour", () => {
    const red = createHuntActivity(seq(0, 0));
    expect(red.accepts("blue")).toBe(false);
    expect(red.accepts("నీలం")).toBe(false);
    // …nor a word that merely contains one. `matchesAnswer` is whole-run.
    expect(red.accepts("bored")).toBe(false);
  });
});

describe("hunt — Chiku shows the colour himself", () => {
  it("the watch rung is a swatch beat, because no pose means red", () => {
    const act1 = createHuntActivity(seq(0, 0));
    const beats = act1.demonstrate?.() ?? [];
    expect(beats.length).toBeGreaterThan(0);
    expect(beats.some((b) => b.swatch === "red")).toBe(true);
    // And it says the word while it shows the colour.
    expect(beats.some((b) => b.key === "demo.hunt.red")).toBe(true);
  });
});

/* ========================================================================== */
/* the palette agrees with itself                                             */
/* ========================================================================== */

describe("hunt — the swatch and the lens are one claim", () => {
  it("every swatch is inside the hue band its own lens accepts", () => {
    for (const colour of HUNT_ORDER) {
      const hex = HUNT_SWATCH[colour];
      const n = Number.parseInt(hex.slice(1), 16);
      const r = (n >> 16) & 255;
      const g = (n >> 8) & 255;
      const b = n & 255;
      expect(matchesTarget(r, g, b, HUNT_COLOURS[colour])).toBe(true);
    }
  });

  it("no swatch is teal — teal means Chiku is hearing you (§9)", () => {
    const TEAL = { r: 0x2f, g: 0x8f, b: 0x86 };
    for (const colour of HUNT_ORDER) {
      expect(HUNT_SWATCH[colour].toLowerCase()).not.toBe("#2f8f86");
      expect(matchesTarget(TEAL.r, TEAL.g, TEAL.b, HUNT_COLOURS[colour])).toBe(false);
    }
  });

  it("the stylesheet paints the same hexes the lens would accept", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    for (const colour of HUNT_ORDER) {
      expect(css).toContain(`.choice-swatch[data-colour="${colour}"]`);
      expect(css).toContain(HUNT_SWATCH[colour]);
    }
  });
});

/* ========================================================================== */
/* the copy                                                                   */
/* ========================================================================== */

describe("hunt — copy, in both scripts", () => {
  const keys = [
    "act.hunt.retry",
    "act.hunt.tap",
    "window.invite",
    ...HUNT_ORDER.map((c) => `window.hunt.${c}`),
    ...HUNT_ORDER.map((c) => `choice.hunt.${c}`),
    ...HUNT_ORDER.map((c) => `demo.hunt.${c}`),
  ];

  it("every kid-facing hunt string exists in en AND te", () => {
    const enDict = en as Record<string, string>;
    const teDict = te as Record<string, string>;
    for (const key of keys) {
      expect(enDict[key], `en is missing ${key}`).toBeTruthy();
      expect(teDict[key], `te is missing ${key}`).toBeTruthy();
      // A copy-pasted English string in the Telugu column is a missing
      // translation wearing a costume.
      expect(teDict[key]).not.toBe(enDict[key]);
      expect(/[ఀ-౿]/u.test(teDict[key] ?? "")).toBe(true);
    }
  });

  it("the invitation names no single gesture, because three of them work", () => {
    // palm / pinch / two-handed. Naming one would fail the age band that
    // cannot do it (vision/quad.ts).
    const invite = (en as Record<string, string>)["window.invite"] ?? "";
    expect(invite.toLowerCase()).toContain("hands");
    expect(invite.toLowerCase()).not.toContain("pinch");
    expect(invite.toLowerCase()).not.toContain("both hands");
  });
});

/* ========================================================================== */
/* the rotation                                                               */
/* ========================================================================== */

describe("hunt — in the rotation", () => {
  it("is one of the factories a round can draw", () => {
    expect(FACTORIES.length).toBe(4);
    const kinds = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      for (const a of buildRound(Math.random)) kinds.add(a.kind);
    }
    expect(kinds).toEqual(new Set(["fingers", "wave", "smile", "hunt"]));
  });

  it("does not make the session longer — three activities, as before", () => {
    expect(ROUND_LENGTH).toBe(3);
    for (let i = 0; i < 50; i += 1) {
      expect(buildRound(Math.random).length).toBe(3);
    }
  });

  it("never repeats an activity inside one round", () => {
    for (let i = 0; i < 100; i += 1) {
      const kinds = buildRound(Math.random).map((a) => a.kind);
      expect(new Set(kinds).size).toBe(kinds.length);
    }
  });

  it("leaves the constant-0.5 round exactly as it was", () => {
    // Not a coincidence to lean on — the hunt's position in FACTORIES was
    // chosen so that the fixture every other surface test is written against
    // does not move. Pinned here so a future reorder fails loudly HERE rather
    // than as four unrelated files going red.
    expect(buildRound(HALF).map((a) => a.kind)).toEqual(["fingers", "smile", "wave"]);
  });
});

/* ========================================================================== */
/* the surface                                                                */
/* ========================================================================== */

describe("Live — the hunt is reachable", () => {
  it("puts the colour hunt on screen, in both scripts", async () => {
    await enterPlaying(true, HUNT_FIRST());
    expect(text()).toContain("Find something red!");
    expect(text()).toContain("ఎరుపు రంగు ఏదైనా చూపించు!");
  });

  it("asks the child to make a window, and stops asking once they have", async () => {
    installContext();
    await enterPlaying(true, HUNT_FIRST());
    stubVideoSize();

    expect(text()).toContain("Make a little window with your hands");
    expect(text()).toContain("నీ చేతులతో ఒక చిన్న కిటికీ చేయి");

    pushFrames([frame({ t: 0, quad: quad(), face: face(0, 0) })]);
    // Telling a child to do the thing they are visibly doing is how a toy
    // stops feeling like it is watching them.
    expect(text()).not.toContain("Make a little window with your hands");
  });

  it("never asks for hands when there is no camera to see them with", async () => {
    await enterPlaying(false, HUNT_FIRST());
    expect(text()).toContain("Find something red!");
    expect(text()).not.toContain("Make a little window with your hands");
  });
});

describe("Live — the window is really rendered", () => {
  it("is a LENS during the hunt", async () => {
    installContext();
    await enterPlaying(true, HUNT_FIRST());
    stubVideoSize();

    expect(windowEl()).toBeNull(); // nothing until the child makes one
    pushFrames([frame({ t: 0, quad: quad(), face: face(0, 0) })]);

    const el = windowEl();
    expect(el).not.toBeNull();
    expect(el?.dataset["mode"]).toBe("lens");
    // …and the lens really ran, over real pixels, on the real CPU path.
    expect(el?.dataset["lensBackend"]).toBe("canvas2d");
  });

  it("is a STICKER during a fingers prompt — the lens is the hunt's", async () => {
    installContext();
    await enterPlaying(true, HALF); // [fingers, smile, wave]
    stubVideoSize();
    expect(text()).toContain("Show me 3 fingers!");

    pushFrames([frame({ t: 0, quad: quad(), face: face(0, 0) })]);
    expect(windowEl()?.dataset["mode"]).toBe("sticker");
  });

  it("Chiku looks THROUGH it: his gaze goes to the window's centre", async () => {
    installContext();
    await enterPlaying(true, HUNT_FIRST());
    stubVideoSize();

    const off = quad({ centre: { x: 0.25, y: 0.75 } });
    rig.gaze.length = 0;
    // A face that would pull his eyes somewhere else entirely, so the
    // assertion cannot pass by accident.
    pushFrames([frame({ t: 0, quad: off, face: face(0.4, -0.2) })]);

    const want = quadGaze(off);
    expect(rig.gaze.at(-1)).toEqual([want.x, want.y]);
    expect(rig.gaze.at(-1)).not.toEqual([-0.4, -0.2]);
  });
});

describe("Live — finding the red thing ends the round in praise", () => {
  it("completes when the lens sees red through the child's own window", async () => {
    installContext(); // default pixels are a red cushion
    await enterPlaying(true, HUNT_FIRST());
    stubVideoSize();
    expect(text()).toContain("Find something red!");

    pushFrames([
      frame({ t: 0, quad: quad(), face: face(0, 0) }), // window appears
      frame({ t: 100, quad: quad(), face: face(0, 0) }),
      frame({ t: 250, quad: quad(), face: face(0, 0) }),
      frame({ t: 400, quad: quad(), face: face(0, 0) }),
      frame({ t: 560, quad: quad(), face: face(0, 0) }),
    ]);

    expect(container.querySelector('[data-streak="1"]')).not.toBeNull();
    expect(rig.emotes).toContain("happy");
  });

  it("does NOT complete on a grey wall", async () => {
    const ctx = installContext();
    ctx.pixels = solid(140, 140, 142); // no hue at all
    await enterPlaying(true, HUNT_FIRST());
    stubVideoSize();

    pushFrames(
      [0, 100, 250, 400, 560, 700, 900].map((t) => frame({ t, quad: quad(), face: face(0, 0) })),
    );

    expect(text()).toContain("Find something red!");
    expect(container.querySelector('[data-streak="1"]')).toBeNull();
  });

  it("survives the window blinking out mid-hold — that is unknown, not a miss", async () => {
    installContext();
    await enterPlaying(true, HUNT_FIRST());
    stubVideoSize();

    pushFrames([
      frame({ t: 0, quad: quad(), face: face(0, 0) }),
      frame({ t: 100, quad: quad(), face: face(0, 0) }),
      // The tracker loses the hands for two frames. The child did not move.
      frame({ t: 200, quad: null, face: face(0, 0) }),
      frame({ t: 300, quad: null, face: face(0, 0) }),
      frame({ t: 420, quad: quad(), face: face(0, 0) }),
      frame({ t: 560, quad: quad(), face: face(0, 0) }),
    ]);

    expect(container.querySelector('[data-streak="1"]')).not.toBeNull();
  });

  it("does not carry a finished hunt into the next prompt", async () => {
    vi.useFakeTimers();
    try {
      installContext();
      await enterPlaying(true, HUNT_FIRST());
      stubVideoSize();

      pushFrames(
        [0, 100, 250, 400, 560].map((t) => frame({ t, quad: quad(), face: face(0, 0) })),
      );
      expect(container.querySelector('[data-streak="1"]')).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(2400);
      });
      // Next activity is the wave. The stale coverage in the ref must not be
      // able to answer anything, and the hunt's window must be gone.
      expect(text()).toContain("Wave to Chiku!");
      expect(container.querySelector('[data-streak="2"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Live — the hunt with no camera is still a game", () => {
  it("falls back to swatches, and tapping the right one wins", async () => {
    await enterPlaying(false, HUNT_FIRST());

    expect(container.querySelector("[data-camera='off']")).not.toBeNull();
    expect(text()).toContain("Or tap the colour");
    const swatches = container.querySelectorAll<HTMLElement>(".choice-swatch");
    expect(swatches.length).toBe(4);
    expect([...swatches].map((s) => s.dataset["colour"])).toEqual([...HUNT_ORDER]);

    click(container.querySelector('[data-choice="hunt-red"]'));
    expect(container.querySelector('[data-streak="1"]')).not.toBeNull();
  });

  it("answers a wrong swatch with warm retry copy, never a failure", async () => {
    await enterPlaying(false, HUNT_FIRST());
    click(container.querySelector('[data-choice="hunt-blue"]'));

    expect(text()).toContain("Keep looking!");
    expect(text()).toContain("Find something red!"); // still playable
    expect(container.querySelector('[data-streak="1"]')).toBeNull();
  });
});

describe("Live — the mercy ladder on a hunt", () => {
  it("escalates like any other activity, and its watch rung shows a colour", async () => {
    vi.useFakeTimers();
    try {
      await enterPlaying(false, HUNT_FIRST());
      expect(container.querySelector("[data-assist='none']")).not.toBeNull();

      // First miss is the free retry: the nudge, same rung.
      await act(async () => {
        vi.advanceTimersByTime(8100);
      });
      expect(text()).toContain("Keep looking!");
      expect(container.querySelector("[data-assist='none']")).not.toBeNull();

      // Second miss: down to "watch me".
      await act(async () => {
        vi.advanceTimersByTime(8100);
      });
      expect(container.querySelector("[data-assist='watch']")).not.toBeNull();

      // …and watching means seeing the colour, because no pose means red.
      await act(async () => {
        vi.advanceTimersByTime(1600);
      });
      const swatch = container.querySelector<HTMLElement>("[data-testid='demo-swatch']");
      expect(swatch).not.toBeNull();
      expect(swatch?.dataset["colour"]).toBe("red");
      // The line that goes with it is SPOKEN, like every other demonstration
      // (this device has no synthesiser, and the beat still plays as a silent
      // performance — which is exactly why the swatch has to be visible).

      // The swatch is Chiku's, not a control: it goes when the beat does.
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(container.querySelector("[data-testid='demo-swatch']")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the child all the way to praise, with no failure exit", async () => {
    vi.useFakeTimers();
    try {
      await enterPlaying(false, HUNT_FIRST());
      // A tap — anything — is what tells Chiku somebody is actually here. The
      // bottom rung ends in praise on its own and must never congratulate a
      // phone left face-up on a sofa.
      click(container.querySelector('[data-choice="hunt-blue"]'));

      // watch: the free retry is already spent by the wrong tap.
      await act(async () => {
        vi.advanceTimersByTime(8100);
      });
      expect(container.querySelector("[data-assist='watch']")).not.toBeNull();

      // The demonstration plays out (1.5s lead + swatch + re-ask) and only
      // then is the miss timer armed again.
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      await act(async () => {
        vi.advanceTimersByTime(8100);
      });
      expect(container.querySelector("[data-assist='easier']")).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(8100);
      });
      expect(container.querySelector("[data-assist='together']")).not.toBeNull();

      // …and the bottom rung carries them to a real celebration.
      await act(async () => {
        vi.advanceTimersByTime(2500);
      });
      expect(container.querySelector('[data-streak="1"]')).not.toBeNull();
      expect(container.querySelector("[data-praise-tone='effort']")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
