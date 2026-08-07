// @vitest-environment happy-dom
//
// TODDLER MODE, as a two-year-old would meet it.
//
// The thing being protected here is not a feature, it is a promise: that
// nothing in this surface can tell a child who moved their whole body that it
// did not count. A test suite for a game usually pins down what makes you WIN.
// There is no winning here and no losing either, so what is pinned is the
// absence of the second one — and the absence of a thing is exactly what
// nobody notices regressing.
//
// What each section is for:
//
//   1. THE LOOP. Chiku performs, the child moves, the delight lands. Driven
//      through the real surface with the real timers, not by calling the
//      reducer directly, because "the celebration fires from inside the vision
//      callback" is the property that buys the contingency window and it only
//      exists end to end.
//   2. REPETITION. The same movement four times before a new one. At this age
//      that is the content, not a fallback, so a well-meaning refactor that
//      "fixes" the repetition would break the product.
//   3. NO FAILURE STATE. Ten frames of a child doing absolutely nothing, and
//      the surface still ends in delight, still says nothing discouraging, and
//      never once renders anything from the 3-8 surface's retry vocabulary.
//   4. NO CAMERA. The whole loop again with no camera at all, because that is
//      the default and it must not feel like the lesser version.
//   5. THE CAP. Five minutes, and it ends warmly.
//   6. THE COPY. Both dictionaries, real Telugu, and reachable from the
//      welcome screen — the "built, tested, and no child can get to it" bug
//      this repo has shipped every phase so far.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Emote, LiveRig, Viseme } from "@chiku/rig";
import type { RigFactory } from "../src/components/CameraStage";
import type {
  MovementSignal,
  VisionEngine,
  VisionFrame,
  VisionStatus,
} from "../src/vision/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */
/* A fake camera                                                              */
/* -------------------------------------------------------------------------- */

const vision = vi.hoisted(() => {
  const frameCbs = new Set<(f: VisionFrame) => void>();
  const statusCbs = new Set<(s: VisionStatus, detail?: string) => void>();
  const live = { status: "idle" as VisionStatus };
  const engine: VisionEngine = {
    get status(): VisionStatus {
      return live.status;
    },
    async start() {
      live.status = "ready";
      for (const cb of [...statusCbs]) cb("ready");
    },
    stop() {
      live.status = "idle";
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
    push(frame: VisionFrame): void {
      for (const cb of [...frameCbs]) cb(frame);
    },
    /** The camera dying under us — unplugged, grabbed, revoked. */
    fail(): void {
      live.status = "unavailable";
      for (const cb of [...statusCbs]) cb("unavailable", "test");
    },
    reset(): void {
      frameCbs.clear();
      statusCbs.clear();
      live.status = "idle";
    },
  };
});

vi.mock("../src/vision/engine", () => ({ createVisionEngine: () => vision.engine }));

import { Toddler } from "../src/surfaces/toddler/Toddler";
import { App } from "../src/app";
import { Live } from "../src/surfaces/live/Live";
import { LangProvider, translate, type I18nKey } from "../src/i18n";
import {
  cheerFor,
  exerciseAt,
  movedOnFrame,
  REPS_PER_EXERCISE,
  TODDLER_CHEERS,
  TODDLER_EXERCISES,
  TODDLER_LIMIT_MIN,
  TODDLER_TIMING,
} from "../src/activities/exercises";
import en from "../src/i18n/en.json";
import te from "../src/i18n/te.json";

const enDict = en as Record<string, string | undefined>;
const teDict = te as Record<string, string | undefined>;

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

let container: HTMLDivElement;
let root: Root;
/** Every movement `rig.perform` was asked for, in order. */
let performed: string[];

function rigFactory(): RigFactory {
  return (host) => {
    const node = host.ownerDocument.createElement("div");
    host.appendChild(node);
    const rig: LiveRig = {
      setEmote(_: Emote) {},
      setViseme(_: Viseme | null) {},
      setGaze() {},
      setMouthOpen() {},
      setAttention() {},
      blink() {},
      perform: (move) => {
        performed.push(move);
        return Promise.resolve();
      },
      debug: () => ({ gazeX: 0, gazeY: 0, mouthOpen: 0, emote: "idle" }),
      dispose() {
        node.remove();
      },
    };
    return rig;
  };
}

function text(): string {
  return container.textContent ?? "";
}

function surface(): HTMLElement | null {
  return container.querySelector<HTMLElement>(".toddler");
}

function beat(): string {
  return surface()?.dataset["beat"] ?? "";
}

function move(): string {
  return surface()?.dataset["move"] ?? "";
}

function rep(): number {
  return Number(surface()?.dataset["rep"] ?? "-1");
}

function mount(props: Record<string, unknown> = {}): void {
  act(() => {
    root.render(
      createElement(LangProvider, {
        initial: "en",
        children: createElement(Toddler, { rigFactory: rigFactory(), ...props }),
      }),
    );
  });
}

/** Advance the clock inside act(), so React commits everything the timers did. */
function tick(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** A frame with a body in it and, optionally, movement flags. */
function frame(t: number, moved: Partial<MovementSignal> | null = null): VisionFrame {
  const base: VisionFrame = {
    t,
    face: { x: 0, y: 0, attention: 0.9, smile: 0 },
    facePresence: 1,
    hands: [],
    totalFingers: null,
    waving: false,
    quad: null,
  };
  if (moved === null) return base;
  const signal: MovementSignal = {
    jump: false,
    crouch: false,
    sway: false,
    stomp: false,
    reach: false,
    clap: false,
    swing: false,
    any: false,
    ...moved,
  };
  return { ...base, movement: signal };
}

/** Everything false — a child sitting perfectly still, watched closely. */
const STILL: Partial<MovementSignal> = {};

function push(f: VisionFrame): void {
  act(() => {
    vision.push(f);
  });
}

/** Get past the demonstration of the current bout, into the child's turn. */
function intoCopyBeat(): void {
  const exercise = exerciseAt(Number(surface()?.dataset["bout"] ?? 0));
  tick(exercise.showMs + 20);
}

/**
 * Turn the camera on the way a grown-up does — through the real quiet button.
 * `warmVision` fetches the model bundles, so `fetch` is stubbed to succeed.
 */
async function switchCameraOn(): Promise<void> {
  vi.stubGlobal(
    "fetch",
    async () => ({ ok: true, status: 200, blob: async () => null }) as unknown as Response,
  );
  const button = container.querySelector<HTMLButtonElement>('[data-action="toddler.watch"]');
  expect(button, "no way for a grown-up to switch the camera on").not.toBeNull();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // Drain the warm-up and the engine start; both are microtask chains.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
  expect(surface()?.dataset["camera"]).toBe("on");
}

beforeEach(() => {
  vi.useFakeTimers();
  vision.reset();
  performed = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ========================================================================== */
/* 1. the loop                                                                */
/* ========================================================================== */

describe("the loop: Chiku moves, the child copies, the delight lands", () => {
  it("opens by performing a movement, not by asking a question", () => {
    mount();
    // The demonstration IS the instruction. There is nothing to read, nothing
    // to tap, and no question anywhere on the screen.
    expect(beat()).toBe("show");
    expect(performed).toEqual(["clap"]);
    expect(container.querySelector(".choices")).toBeNull();
    expect(container.querySelector("[data-choice]")).toBeNull();
  });

  it("says the invitation line for the grown-up to echo, in both scripts", () => {
    mount();
    const exercise = exerciseAt(0);
    expect(text()).toContain(translate("en", exercise.inviteKey));
    expect(text()).toContain(translate("te", exercise.inviteKey));
  });

  it("celebrates ANY movement, not the one it demonstrated", async () => {
    mount();
    await switchCameraOn();
    intoCopyBeat();
    expect(beat()).toBe("copy");

    // Chiku demonstrated a clap. The child jumped. That is a win: they moved
    // their whole body along with him, which is the entire point.
    push(frame(100, { jump: true, any: true }));
    expect(beat()).toBe("cheer");
    expect(text()).toContain(translate("en", cheerFor(0)));
  });

  it("celebrates on the very frame the movement arrives", async () => {
    // The contingency window, as a structural property rather than a
    // measurement: no timer, no effect and no second render sits between the
    // frame and the celebration, so there is nowhere for a delay to hide.
    mount();
    await switchCameraOn();
    intoCopyBeat();
    push(frame(100, { stomp: true, any: true }));
    // Zero milliseconds of fake clock have passed since the frame.
    expect(beat()).toBe("cheer");
  });

  it("ignores movement while Chiku is still demonstrating", async () => {
    mount();
    await switchCameraOn();
    expect(beat()).toBe("show");
    push(frame(50, { sway: true, any: true }));
    // Not a rejection — the child's turn simply has not opened. The flag
    // latches for over a second, so a child who copies him mid-demonstration
    // is celebrated the instant it does.
    expect(beat()).toBe("show");
    intoCopyBeat();
    push(frame(60, { sway: true, any: true }));
    expect(beat()).toBe("cheer");
  });

  it("treats a frame with no movement field as no evidence, never as a no", async () => {
    mount();
    await switchCameraOn();
    intoCopyBeat();
    for (let i = 0; i < 5; i += 1) push(frame(100 + i * 16));
    expect(beat()).toBe("copy");
    expect(movedOnFrame(frame(0))).toBe(false);
  });
});

/* ========================================================================== */
/* 2. repetition is the content                                               */
/* ========================================================================== */

describe("the same movement again, with the delight escalating", () => {
  /** One whole bout, camera off: demonstration, the child's turn, the cheer. */
  function wholeBout(): void {
    intoCopyBeat();
    tick(TODDLER_TIMING.waitSoloMs + 20);
    expect(beat()).toBe("cheer");
    tick(TODDLER_TIMING.cheerMs + 20);
  }

  it("repeats the SAME movement before moving on to a new one", () => {
    mount();
    const first = exerciseAt(0).id;
    for (let go = 0; go < REPS_PER_EXERCISE; go += 1) {
      expect(move(), `go ${go} changed the movement`).toBe(first);
      expect(rep()).toBe(go);
      wholeBout();
    }
    // …and only now something new.
    expect(move()).toBe(exerciseAt(1).id);
    expect(rep()).toBe(0);
    expect(performed.slice(0, REPS_PER_EXERCISE)).toEqual(Array(REPS_PER_EXERCISE).fill(first));
  });

  it("gets louder each go rather than saying the same thing four times", () => {
    mount();
    const heard: string[] = [];
    for (let go = 0; go < REPS_PER_EXERCISE; go += 1) {
      intoCopyBeat();
      tick(TODDLER_TIMING.waitSoloMs + 20);
      heard.push(container.querySelector(".toddler-cheer")?.getAttribute("data-cheer") ?? "");
      tick(TODDLER_TIMING.cheerMs + 20);
    }
    expect(heard).toEqual(["0", "1", "2", "3"]);
    // Four distinct lines, escalating — not one line four times.
    expect(new Set(TODDLER_CHEERS).size).toBe(TODDLER_CHEERS.length);
  });

  it("orders the exercises easiest-first and wraps rather than ending", () => {
    // The order is a developmental claim (see exercises.ts): clapping is a
    // twelve-month skill, jumping with both feet is a 24-30 month one and a
    // large share of two-year-olds cannot do it yet. Easiest first, hardest
    // last, and then round again — a second lap is the point, not filler.
    expect(TODDLER_EXERCISES.map((e) => e.id)).toEqual([
      "clap",
      "stomp",
      "swing",
      "reach",
      "sway",
      "crouch",
      "jump",
    ]);
    expect(exerciseAt(TODDLER_EXERCISES.length)).toEqual(exerciseAt(0));
    expect(exerciseAt(-1)).toEqual(exerciseAt(TODDLER_EXERCISES.length - 1));
  });
});

/* ========================================================================== */
/* 3. there is no failure state                                               */
/* ========================================================================== */

/**
 * The 3-8 surface's whole vocabulary of "not yet": its retry lines, its nudge,
 * and the class names it renders them in. None of it may appear here. A
 * two-year-old cannot be told they were close.
 */
const DISCOURAGING_KEYS = Object.keys(en).filter(
  (k) => k.includes(".retry") || k === "praise.nudge" || k.endsWith(".tap"),
);

const DISCOURAGING_MARKUP = [".live-retry", ".live-taphint", ".choices", "[data-choice]"];

describe("nothing here can go wrong", () => {
  it("celebrates a child who does absolutely nothing, and says nothing unkind", async () => {
    mount();
    await switchCameraOn();
    intoCopyBeat();

    // Ten frames of a child sitting perfectly still, watched the whole time.
    for (let i = 0; i < 10; i += 1) push(frame(200 + i * 16, STILL));
    expect(beat()).toBe("copy");
    for (const key of DISCOURAGING_KEYS) {
      expect(text(), `${key} is on screen`).not.toContain(translate("en", key as I18nKey));
    }

    // …and the beat still ends in delight, because there is no other exit.
    tick(TODDLER_TIMING.waitWatchedMs + 20);
    expect(beat()).toBe("cheer");
    expect(text()).toContain(translate("en", cheerFor(0)));
  });

  it("never renders a retry, a nudge, a tap answer or a score", () => {
    mount();
    for (let go = 0; go < REPS_PER_EXERCISE * 2; go += 1) {
      for (const selector of DISCOURAGING_MARKUP) {
        expect(container.querySelector(selector), `${selector} rendered`).toBeNull();
      }
      expect(container.querySelector(".streak-stars")).toBeNull();
      intoCopyBeat();
      tick(TODDLER_TIMING.waitSoloMs + 20);
      tick(TODDLER_TIMING.cheerMs + 20);
    }
  });

  it("has no failure branch to reach: every bout ends in a cheer", () => {
    // Twenty bouts of a completely silent camera. Every single one of them
    // lands on "cheer" — there is no other terminal state in the machine.
    mount();
    for (let go = 0; go < 20; go += 1) {
      intoCopyBeat();
      tick(TODDLER_TIMING.waitSoloMs + 20);
      expect(beat(), `bout ${go} did not end in delight`).toBe("cheer");
      tick(TODDLER_TIMING.cheerMs + 20);
    }
  });

  it("keeps dancing when the camera dies mid-session", async () => {
    mount();
    await switchCameraOn();
    intoCopyBeat();
    act(() => {
      vision.fail();
    });
    expect(surface()?.dataset["camera"]).toBe("off");
    // A lost camera is a downgrade to solo mode, not a dead end and not an
    // error screen. The loop does not even pause.
    tick(TODDLER_TIMING.waitWatchedMs + 20);
    expect(beat()).toBe("cheer");
    expect(text()).not.toContain(translate("en", "camera.blocked"));
  });
});

/* ========================================================================== */
/* 4. no camera is not the lesser version                                     */
/* ========================================================================== */

describe("with no camera at all", () => {
  it("starts with the camera off — nothing is asked of a grown-up first", () => {
    mount();
    expect(surface()?.dataset["camera"]).toBe("off");
    // Straight into the loop. No permission screen stands between a
    // two-year-old and a dancing elephant.
    expect(beat()).toBe("show");
    expect(performed.length).toBe(1);
  });

  it("performs every movement and celebrates every one of them", () => {
    mount();
    for (let go = 0; go < REPS_PER_EXERCISE * TODDLER_EXERCISES.length; go += 1) {
      intoCopyBeat();
      tick(TODDLER_TIMING.waitSoloMs + 20);
      tick(TODDLER_TIMING.cheerMs + 20);
    }
    // Every exercise in the set actually got performed by the rig — not
    // described, not skipped, performed.
    expect(new Set(performed)).toEqual(new Set(TODDLER_EXERCISES.map((e) => e.id)));
  });

  it("waits less without a camera, because nothing is being waited FOR", () => {
    expect(TODDLER_TIMING.waitSoloMs).toBeLessThan(TODDLER_TIMING.waitWatchedMs);
    mount();
    intoCopyBeat();
    tick(TODDLER_TIMING.waitSoloMs + 20);
    expect(beat()).toBe("cheer");
  });

  it("offers the camera as a grown-up's bonus, never as a gate", async () => {
    mount();
    // The offer is there…
    expect(container.querySelector('[data-action="toddler.watch"]')).not.toBeNull();
    // …and taking it changes the detection, not the game.
    await switchCameraOn();
    expect(beat()).toMatch(/show|copy|cheer/);
    expect(container.querySelector('[data-action="toddler.watch"]')).toBeNull();
  });
});

/* ========================================================================== */
/* 5. the session ends, warmly                                                */
/* ========================================================================== */

describe("five minutes, and then a warm ending", () => {
  it("uses a five-minute cap without touching the shared default", () => {
    expect(TODDLER_LIMIT_MIN).toBe(5);
  });

  it("says goodbye rather than stopping", () => {
    mount();
    // Run the clock past the cap. The loop keeps running throughout; the cap
    // is applied at the seam between bouts, never mid-celebration.
    tick(TODDLER_LIMIT_MIN * 60_000 + 10_000);
    expect(surface()?.dataset["phase"]).toBe("bye");
    expect(text()).toContain(translate("en", "toddler.bye.title"));
    expect(text()).toContain(translate("te", "toddler.bye.title"));
    expect(text()).toContain(translate("en", "toddler.bye.line"));
  });

  it("leaves no way for the child to argue with the ending", () => {
    mount({ onExit: () => {} });
    tick(TODDLER_LIMIT_MIN * 60_000 + 10_000);
    // §9.5: no "five more minutes", no restart, and the grown-up's way out is
    // gone too — an end that can be undone in one tap in front of the child is
    // a negotiation rather than an end.
    expect(container.querySelector(".big-btn")).toBeNull();
    expect(container.querySelector(".hold-button")).toBeNull();
    expect(container.querySelector('[data-action="toddler.watch"]')).toBeNull();
  });

  it("stops performing once it has said goodbye", () => {
    mount();
    tick(TODDLER_LIMIT_MIN * 60_000 + 10_000);
    const after = performed.length;
    tick(60_000);
    expect(performed.length).toBe(after);
  });
});

/* ========================================================================== */
/* 6. the copy, and a child being able to get here at all                     */
/* ========================================================================== */

const TELUGU = /[ఀ-౿]/;

describe("the words", () => {
  const KEYS = [
    "toddler.enter",
    "toddler.exit",
    "toddler.watch",
    "toddler.grownup",
    "toddler.bye.title",
    "toddler.bye.line",
    ...TODDLER_EXERCISES.map((e) => e.inviteKey),
    ...TODDLER_CHEERS,
  ];

  it("carries every toddler key in BOTH dictionaries, in real Telugu", () => {
    for (const key of KEYS) {
      expect(enDict[key], `${key} (en)`).toBeTypeOf("string");
      expect(teDict[key], `${key} (te)`).toBeTypeOf("string");
      expect(teDict[key] ?? "", `${key} is not Telugu script`).toMatch(TELUGU);
      expect(teDict[key], `${key} is the same string twice`).not.toBe(enDict[key]);
    }
  });

  it("has an invitation for every exercise and a cheer for every repetition", () => {
    expect(TODDLER_EXERCISES.length).toBeGreaterThanOrEqual(7);
    expect(TODDLER_CHEERS.length).toBeGreaterThanOrEqual(REPS_PER_EXERCISE);
    for (let go = 0; go < REPS_PER_EXERCISE + 3; go += 1) {
      // Past the end it stays at the loudest line. There is no rung down.
      expect(enDict[cheerFor(go)]).toBeTypeOf("string");
    }
  });

  it("shows the grown-up the one line that matters, and then stops", () => {
    mount();
    expect(text()).toContain(translate("en", "toddler.grownup"));
    intoCopyBeat();
    tick(TODDLER_TIMING.waitSoloMs + 20);
    // Read by now. Leaving it up is clutter in a two-year-old's field of view.
    expect(text()).not.toContain(translate("en", "toddler.grownup"));
  });
});

describe("a grown-up can actually find it", () => {
  it("is a second button on the welcome screen, and it opens toddler mode", () => {
    act(() => {
      root.render(createElement(App));
    });
    const door = container.querySelector<HTMLButtonElement>('[data-action="toddler.enter"]');
    expect(door, "toddler mode is unreachable from the welcome screen").not.toBeNull();
    expect(text()).toContain(translate("en", "toddler.enter"));

    act(() => {
      door?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector(".toddler")).not.toBeNull();
    expect(container.querySelector(".live")).toBeNull();
  });

  it("does not put the door on a Live surface that was not offered one", () => {
    // Every existing surface test mounts `Live` on its own, and four of them
    // assert on the exact text of the welcome screen. The door is opt-in so
    // that this change cannot rewrite screens it has no business touching.
    act(() => {
      root.render(
        createElement(LangProvider, {
          initial: "en",
          children: createElement(Live, { rigFactory: rigFactory() }),
        }),
      );
    });
    expect(container.querySelector('[data-action="welcome.begin"]')).not.toBeNull();
    expect(container.querySelector('[data-action="toddler.enter"]')).toBeNull();
  });
});
