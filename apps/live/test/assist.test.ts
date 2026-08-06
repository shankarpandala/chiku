// @vitest-environment happy-dom
//
// THE KID LAYER: what happens when a three-year-old cannot do the thing.
//
// Before this, the surface's answer to "I can't" was a row of numerals to tap,
// which is the SAME COGNITIVE TASK as holding up three fingers and for the
// youngest band often a harder one. So `activities/types.ts`'s own rule —
// "rounds end in praise" — was unreachable for exactly the children who most
// needed it to be true, and the only exits were a timeout loop or a grown-up.
//
// Everything below is a sentence about a child rather than about a state
// machine:
//
//   * Three tries and Chiku shows you, then quietly makes it easier, then does
//     it with you. Never a fourth try at the identical thing.
//   * A round he had to carry still ends in praise. There is no rung below
//     "together" and no exit from it that is not a celebration.
//   * The bar moving is invisible. Nothing on screen says "easy mode".
//   * The loudest cheer goes to the hardest win, not the cheapest one.
//   * A line Chiku swallowed because the mic was open is not lost. This
//     demographic holds the big teal button constantly — it lights up — and
//     used to hear no prompt, no nudge and no praise for as long as they did.
//
// No JSX here on purpose: `createElement` keeps this file a plain `.ts`, which
// is what the rest of the activities/vision tests are.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Emote, LiveRig, Viseme } from "@chiku/rig";
import type { VisionEngine, VisionFrame, VisionStatus } from "../src/vision/types";
import type { HeardResult, Listener, SpeakHandle, Speaker } from "../src/voice/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */
/* fakes — the same seams the other surface tests use                          */
/* -------------------------------------------------------------------------- */

const vision = vi.hoisted(() => {
  const frameCbs = new Set<(f: VisionFrame) => void>();
  const statusCbs = new Set<(s: VisionStatus, detail?: string) => void>();
  const state = {
    grant: true,
    /** Every threshold set the surface has pushed down, in order. */
    calibrations: [] as FingerThresholds[],
  };
  const live = { status: "idle" as VisionStatus };

  const engine: VisionEngine = {
    get status(): VisionStatus {
      return live.status;
    },
    async start() {
      if (!state.grant) {
        live.status = "denied";
        for (const cb of [...statusCbs]) cb("denied");
        throw new Error("NotAllowedError");
      }
      live.status = "ready";
      for (const cb of [...statusCbs]) cb("ready");
    },
    stop() {},
    setCalibration(next) {
      state.calibrations.push(next);
    },
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
    push(frames: readonly VisionFrame[]): void {
      for (const f of frames) for (const cb of [...frameCbs]) cb(f);
    },
    reset(): void {
      frameCbs.clear();
      statusCbs.clear();
      state.grant = true;
      state.calibrations = [];
      live.status = "idle";
    },
  };
});

vi.mock("../src/vision/engine", () => ({
  createVisionEngine: () => vision.engine,
}));

const voice = vi.hoisted(() => {
  interface Line {
    readonly text: string;
    status: "speaking" | "done" | "cancelled";
    settle: () => void;
  }

  const state = {
    micAvailable: true,
    lines: [] as Line[],
    stops: 0,
    listening: false,
  };
  const resultCbs = new Set<(r: HeardResult) => void>();
  const errorCbs = new Set<(m: string) => void>();
  const endCbs = new Set<() => void>();

  const speaker: Speaker = {
    get available(): boolean {
      return true;
    },
    get speaking(): boolean {
      return state.lines.some((l) => l.status === "speaking");
    },
    speak(text): SpeakHandle {
      let resolve: () => void = () => {};
      const done = new Promise<void>((r) => {
        resolve = r;
      });
      const line: Line = { text, status: "speaking", settle: resolve };
      state.lines.push(line);
      return {
        done,
        cancel: () => {
          if (line.status === "speaking") {
            line.status = "cancelled";
            line.settle();
          }
        },
      };
    },
    cancelAll(): void {
      for (const line of state.lines) {
        if (line.status === "speaking") {
          line.status = "cancelled";
          line.settle();
        }
      }
    },
    dispose(): void {},
  };

  const listener: Listener = {
    get available(): boolean {
      return state.micAvailable;
    },
    get onDevice(): boolean | null {
      return true;
    },
    async ensureOnDevice(): Promise<boolean> {
      return true;
    },
    get listening(): boolean {
      return state.listening;
    },
    start(): void {
      state.listening = true;
    },
    stop(): void {
      state.stops += 1;
      state.listening = false;
    },
    onResult(cb) {
      resultCbs.add(cb);
      return () => {
        resultCbs.delete(cb);
      };
    },
    onError(cb) {
      errorCbs.add(cb);
      return () => {
        errorCbs.delete(cb);
      };
    },
    onEnd(cb) {
      endCbs.add(cb);
      return () => {
        endCbs.delete(cb);
      };
    },
    dispose(): void {
      resultCbs.clear();
      errorCbs.clear();
      endCbs.clear();
    },
  };

  return {
    speaker,
    listener,
    state,
    /** Every line Chiku has actually started saying, in order. */
    said(): string[] {
      return state.lines.map((l) => l.text);
    },
    hear(text: string): void {
      for (const cb of [...resultCbs]) cb({ text, conf: 0.9, isFinal: true });
    },
    /** The recogniser ending the session by itself, which it does constantly. */
    end(): void {
      state.listening = false;
      for (const cb of [...endCbs]) cb();
    },
    reset(): void {
      resultCbs.clear();
      errorCbs.clear();
      endCbs.clear();
      state.micAvailable = true;
      state.lines = [];
      state.stops = 0;
      state.listening = false;
    },
  };
});

vi.mock("../src/voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/voice")>();
  return {
    ...actual,
    createSpeaker: () => voice.speaker,
    createListener: () => voice.listener,
  };
});

import { Live } from "../src/surfaces/live/Live";
import { LangProvider } from "../src/i18n";
import type { RigFactory } from "../src/components/CameraStage";
import { HoldTracker, HOLD_SLACK_FRAMES } from "../src/activities/hold";
import { nextAssist, praiseToneFor, relaxFor } from "../src/activities/assist";
import { createFingersActivity } from "../src/activities/fingers";
import { createWaveActivity } from "../src/activities/wave";
import { createSmileActivity } from "../src/activities/smile";
import { alongsideBeatsFor, demoBeatsFor } from "../src/activities/types";
import {
  ADULT_THRESHOLDS,
  countExtendedFingers,
  MIN_ANGLE_THRESHOLD_DEG,
  relaxThresholds,
  type FingerThresholds,
  type Landmark,
} from "../src/vision/fingers";
import { clearCalibration } from "../src/vision/calibration";

/* -------------------------------------------------------------------------- */
/* harness                                                                     */
/* -------------------------------------------------------------------------- */

let container: HTMLDivElement;
let root: Root;
let emotes: Emote[];

/** Constant 0.5 → fingers target 3, and fingers is the first activity. */
const HALF = (): number => 0.5;

function rigFactory(): RigFactory {
  return (host) => {
    const node = host.ownerDocument.createElement("div");
    host.appendChild(node);
    const rig: LiveRig = {
      setEmote(emote: Emote) {
        emotes.push(emote);
      },
      setViseme(_: Viseme | null) {},
      setGaze() {},
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
}

function q(selector: string): Element | null {
  return container.querySelector(selector);
}

function action(key: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-action="${key}"]`);
}

function text(): string {
  return container.textContent ?? "";
}

function click(el: Element | null): void {
  if (!el) throw new Error("nothing to click");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function fire(el: Element | null, type: string): void {
  if (!el) throw new Error(`nothing to ${type}`);
  act(() => {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

/** The rung the surface believes it is on. */
function rung(): string | null {
  return q(".live")?.getAttribute("data-assist") ?? null;
}

/** Straight to tap play — no camera, so every miss below is a deliberate one. */
async function playTapOnly(): Promise<void> {
  act(() => {
    root.render(
      createElement(LangProvider, {
        initial: "en",
        children: createElement(Live, { random: HALF, rigFactory: rigFactory() }),
      }),
    );
  });
  click(action("welcome.begin"));
  click(q(".live-quiet"));
  await flush();
}

/** welcome → camera-ask → allow → playing, with a working camera. */
async function playWithCamera(): Promise<void> {
  act(() => {
    root.render(
      createElement(LangProvider, {
        initial: "en",
        children: createElement(Live, { random: HALF, rigFactory: rigFactory() }),
      }),
    );
  });
  click(action("welcome.begin"));
  const allow = action("camera.allow");
  await act(async () => {
    allow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

/** A frame with a child clearly looking at the screen and no hands up. */
function faceFrame(t: number): VisionFrame {
  return {
    t,
    face: { x: 0, y: 0, attention: 0.9, smile: 0 },
    hands: [],
    totalFingers: null,
    waving: false,
  };
}

/** Tap an answer that is not the answer. */
function tapWrong(): void {
  click(container.querySelector('[data-choice="fingers-1"]'));
}

beforeEach(() => {
  vision.reset();
  voice.reset();
  // The relaxation is computed off the STORED per-child pass, so the baseline
  // has to be the adult defaults for any of it to be assertable.
  clearCalibration();
  vi.stubGlobal(
    "fetch",
    async () => ({ ok: true, status: 200, blob: async () => null }) as unknown as Response,
  );
  emotes = [];
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

/* -------------------------------------------------------------------------- */
/* 1. the ladder                                                               */
/* -------------------------------------------------------------------------- */

describe("the assist ladder", () => {
  it("gives a free retry, then walks none → watch → easier → together", async () => {
    await playTapOnly();
    expect(rung()).toBe("none");

    // The FIRST miss buys another go at the same rung. A child who was merely
    // slow, or looked away, should not be shown how before they have tried
    // twice — jumping straight to "watch me" reads as "you can't".
    tapWrong();
    expect(rung()).toBe("none");

    tapWrong();
    expect(rung()).toBe("watch");

    tapWrong();
    expect(rung()).toBe("easier");

    tapWrong();
    expect(rung()).toBe("together");
  });

  it("never goes below together, however many times the child misses", async () => {
    vi.useFakeTimers();
    await playTapOnly();
    tapWrong(); // free retry
    tapWrong();
    tapWrong();
    tapWrong();
    expect(rung()).toBe("together");

    // Two more before the together beat lands. Saturating, not "gave up".
    tapWrong();
    tapWrong();
    expect(rung()).toBe("together");
    expect(nextAssist("together")).toBe("together");
  });

  it("steps down on a timeout too, not only on a tap", async () => {
    vi.useFakeTimers();
    await playTapOnly();

    // The first timeout is the free retry: a child who was merely slow, or who
    // looked away for a second, gets another go at the same rung first.
    await tick(8200);
    expect(rung()).toBe("none");

    await tick(8000);

    expect(rung()).toBe("watch");
    // …and the warm nudge is on screen, as it always was. Never a failure line.
    expect(text()).toContain("So close!");
  });

  it("steps down on a heard-but-wrong answer", async () => {
    await playTapOnly();

    const sayWrong = (): void => {
      fire(action("talk.hold"), "pointerdown");
      fire(action("talk.hold"), "pointerup");
      act(() => voice.hear("banana"));
    };

    // A misheard word is a miss like any other — and the first one buys the
    // same free retry a wrong tap or a timeout does.
    sayWrong();
    expect(rung()).toBe("none");

    sayWrong();

    expect(rung()).toBe("watch");
  });

  it("starts every prompt at the top of the ladder again", async () => {
    vi.useFakeTimers();
    await playTapOnly();
    tapWrong(); // free retry
    tapWrong();
    tapWrong();
    expect(rung()).toBe("easier");

    // Answer correctly, sit through the praise, land on the next prompt.
    click(container.querySelector('[data-choice="fingers-3"]'));
    await tick(2400);

    expect(q("[data-phase='playing']")).not.toBeNull();
    expect(rung()).toBe("none");
  });
});

/* -------------------------------------------------------------------------- */
/* 2. "watch" actually demonstrates                                            */
/* -------------------------------------------------------------------------- */

describe("watch — Chiku does it himself", () => {
  it("counts to the target, one beat per number, then asks again", () => {
    const fingers = createFingersActivity(HALF); // target 3
    const shown = fingers.demonstrate?.() ?? [];
    expect(shown).toHaveLength(3);
    // Ends on the happy face he wants the child looking at when they try.
    expect(shown.at(-1)?.emote).toBe("happy");

    // The re-ask is appended by the runner, and is the whole default.
    const beats = demoBeatsFor(fingers);
    expect(beats.at(-1)?.key).toBe("act.fingers.prompt");
    expect(beats.at(-1)?.values).toEqual({ n: 3 });
  });

  it("waves with the rig's own wave pose, out and back", () => {
    const shown = createWaveActivity(HALF).demonstrate?.() ?? [];
    expect(shown.map((b) => b.emote)).toEqual(["goodbye", "encouraging", "goodbye"]);
  });

  it("smiles first, because a smile back is nearly involuntary", () => {
    const shown = createSmileActivity(HALF).demonstrate?.() ?? [];
    expect(shown.map((b) => b.emote)).toEqual(["happy"]);
  });

  it("degrades to just asking again when an activity has no demonstration", () => {
    const bare = { ...createWaveActivity(HALF), demonstrate: undefined };
    expect(alongsideBeatsFor(bare)).toEqual([]);
    const beats = demoBeatsFor(bare);
    expect(beats).toHaveLength(1);
    expect(beats[0]?.key).toBe("act.wave.prompt");
  });

  it("performs the demonstration on the surface, and re-asks after it", async () => {
    vi.useFakeTimers();
    await playTapOnly();
    const before = voice.said().length;

    tapWrong(); // free retry — Chiku does not show them how on the first miss
    tapWrong();
    // The warm nudge is heard first — it is not queued behind a performance.
    expect(voice.said().at(-1)).toBe("So close! Hold your fingers up high for Chiku.");

    // Lead-in, three counting beats, then the re-ask.
    await tick(1500 + 3 * 420 + 50);

    expect(voice.said().at(-1)).toBe("Show me 3 fingers!");
    expect(voice.said().length).toBeGreaterThan(before + 1);
    // Still the same question. Nothing on screen has called this a failure.
    expect(text()).toContain("Show me 3 fingers!");
    expect(q(".live-praise")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 3. "easier" — the bar moves and nobody is told                              */
/* -------------------------------------------------------------------------- */

describe("easier — a quieter detector", () => {
  // The hold is the part a child feels: 600ms of a wobbling hand is a long
  // time when you are four. Asserted through the tracker rather than through a
  // constant, because the tracker is what actually decides.
  it("relaxation completes the hold in fewer frames", () => {
    const HOLD = 600;
    const FRAME = 60;

    const framesToComplete = (holdMs: number): number => {
      const tracker = new HoldTracker();
      for (let i = 0; i < 40; i += 1) {
        if (tracker.update("match", i * FRAME, holdMs)) return i + 1;
      }
      return -1;
    };

    const strict = framesToComplete(HOLD);
    const easier = framesToComplete(Math.round(HOLD * relaxFor("easier").holdScale));
    const together = framesToComplete(Math.round(HOLD * relaxFor("together").holdScale));

    expect(strict).toBe(11); // 0 … 600, at 60ms a frame
    expect(easier).toBeLessThan(strict);
    expect(together).toBeLessThan(easier);
  });

  it("watch does not move the bar — the help there is the demonstration", () => {
    expect(relaxFor("watch")).toEqual(relaxFor("none"));
  });

  it("forgives more dropout mid-hold once relaxed", () => {
    const HOLD = 600;
    const STEP = 30;

    /** Does the hold survive `misses` lost frames in the middle of it? */
    const survives = (extra: number, misses: number): boolean => {
      const tracker = new HoldTracker();
      tracker.relax(extra);
      let t = 0;
      const feed = (verdict: "match" | "mismatch"): boolean => {
        const done = tracker.update(verdict, t, HOLD);
        t += STEP;
        return done;
      };
      feed("match"); // the hold starts at t = 0
      for (let i = 0; i < misses; i += 1) feed("mismatch");
      // Survived means the clock still started at zero, so a match at 600ms
      // completes it. Reset means the clock restarted and it does not.
      while (t <= HOLD) if (feed("match")) return true;
      return false;
    };

    const overStrictBudget = HOLD_SLACK_FRAMES + 1;
    expect(survives(0, overStrictBudget)).toBe(false);
    expect(survives(relaxFor("easier").extraSlackFrames, overStrictBudget)).toBe(true);
  });

  it("loosens the finger angles without ever accepting a fist", () => {
    const relaxed = relaxThresholds(ADULT_THRESHOLDS, relaxFor("easier").angleRelaxDeg);
    expect(relaxed.fingerAngleDeg).toBe(ADULT_THRESHOLDS.fingerAngleDeg - 8);
    expect(relaxed.thumbAngleDeg).toBe(ADULT_THRESHOLDS.thumbAngleDeg - 8);
    // One more finger may be uncertain before the whole hand is unscoreable —
    // "I couldn't tell" is the verdict a struggling child hits most.
    expect(relaxed.maxAmbiguousFingers).toBe(ADULT_THRESHOLDS.maxAmbiguousFingers + 1);

    // Identity at the top of the ladder, so "none" and "watch" are provably
    // the shipped detector.
    expect(relaxThresholds(ADULT_THRESHOLDS, 0)).toBe(ADULT_THRESHOLDS);

    // And it is a relaxation, not a surrender.
    const absurd = relaxThresholds(ADULT_THRESHOLDS, 500);
    expect(absurd.fingerAngleDeg).toBe(MIN_ANGLE_THRESHOLD_DEG);
  });

  it("counts a finger a small hand cannot straighten, once relaxed", () => {
    // 143deg: a real five-year-old's "straight" index finger, and below the
    // adult 150deg threshold.
    const hand = handWithIndexAt(143);
    expect(countExtendedFingers(hand, ADULT_THRESHOLDS).extended[1]).toBe(false);
    const relaxed = relaxThresholds(ADULT_THRESHOLDS, relaxFor("easier").angleRelaxDeg);
    expect(countExtendedFingers(hand, relaxed).extended[1]).toBe(true);
  });

  // The unit above proves `relaxThresholds` is right. This proves the surface
  // actually calls it: the angle half used to be a feature-detected call to a
  // method the engine did not have, so every rung relaxed the HOLD and nothing
  // ever relaxed the ANGLES.
  it("pushes the relaxed thresholds down into the engine", async () => {
    await playTapOnly();

    // The prompt itself sets the baseline — a new prompt is strict again.
    expect(vision.state.calibrations.at(-1)).toEqual(ADULT_THRESHOLDS);

    tapWrong(); // free retry: same rung, so still the shipped detector
    tapWrong(); // "watch": the help is the demonstration, not a looser bar
    expect(rung()).toBe("watch");
    expect(vision.state.calibrations.at(-1)).toEqual(ADULT_THRESHOLDS);

    tapWrong();
    expect(rung()).toBe("easier");
    expect(vision.state.calibrations.at(-1)).toEqual(
      relaxThresholds(ADULT_THRESHOLDS, relaxFor("easier").angleRelaxDeg),
    );

    tapWrong();
    expect(rung()).toBe("together");
    // Measured off the child's own baseline, not off the previous rung: the
    // rungs must not compound into a detector that congratulates a fist.
    expect(vision.state.calibrations.at(-1)).toEqual(
      relaxThresholds(ADULT_THRESHOLDS, relaxFor("together").angleRelaxDeg),
    );
  });

  it("says nothing about it — no easy-mode label anywhere on screen", async () => {
    await playTapOnly();
    tapWrong(); // free retry
    tapWrong();
    tapWrong();
    expect(rung()).toBe("easier");

    const shown = text().toLowerCase();
    for (const word of ["easier", "easy", "help", "hint", "mode", "level"]) {
      expect(shown).not.toContain(word);
    }
    // The prompt is untouched. It is the same question it always was.
    expect(text()).toContain("Show me 3 fingers!");
  });
});

/* -------------------------------------------------------------------------- */
/* 4. "together" — no rung below, no exit that is not praise                   */
/* -------------------------------------------------------------------------- */

describe("together — the round ends in praise regardless", () => {
  it("succeeds on its own after Chiku counts along", async () => {
    vi.useFakeTimers();
    await playTapOnly();
    tapWrong(); // free retry
    tapWrong();
    tapWrong();
    tapWrong();
    expect(rung()).toBe("together");
    expect(q(".live-praise")).toBeNull();

    // Invitation, three counting beats alongside the child, a settle, success.
    await tick(700 + 3 * 420 + 400 + 50);

    expect(q(".live-praise")).not.toBeNull();
    expect(q('[data-streak="1"]')).not.toBeNull();
    expect(q("[data-phase='playing']")).not.toBeNull();
  });

  it("invites out loud rather than announcing a failure", async () => {
    vi.useFakeTimers();
    await playTapOnly();
    tapWrong(); // free retry
    tapWrong();
    tapWrong();
    tapWrong();

    // Whatever the copy layer supplies, this rung is never mute and never a
    // telling-off. `praise.nudge` is the guaranteed floor.
    expect(voice.said().at(-1)).toBe("Nearly! Let's try that one together.");
  });

  it("carries the child through a whole round without one correct answer", async () => {
    vi.useFakeTimers();
    await playTapOnly();

    const TOGETHER_MS = 700 + 5 * 420 + 400 + 50;
    for (let activity = 0; activity < 3; activity += 1) {
      // A free retry and then three misses gets any activity to the bottom rung…
      tapWrongAnything(); // free retry
      tapWrongAnything();
      tapWrongAnything();
      tapWrongAnything();
      expect(rung()).toBe("together");
      // …and the bottom rung ends in praise, every time.
      await tick(TOGETHER_MS);
      expect(q(".live-praise")).not.toBeNull();
      await tick(2400);
    }

    // Three stars, a warm goodbye, and nothing anywhere that reads as a loss.
    expect(q("[data-phase='goodbye']")).not.toBeNull();
    expect(text()).toContain("Bye bye! Come back soon!");
    expect(text()).not.toMatch(/wrong|sorry|failed|try harder/i);
  });

  // The main path, and the child this whole phase exists for: present, trying,
  // and unable to do it. They tap nothing and say nothing, because they do not
  // know what to do — and the camera is what tells Chiku they are still there.
  it("carries a child the camera can see, on timeouts alone", async () => {
    vi.useFakeTimers();
    await playWithCamera();
    act(() => vision.push([faceFrame(16)]));
    expect(q(".stage.is-attending")).not.toBeNull();
    // With a camera the tap answers are not on screen at all yet.
    expect(q(".choices")).toBeNull();

    // The first eight seconds buy the free retry, not a demonstration.
    await tick(8200);
    expect(rung()).toBe("none");

    await tick(8000);
    expect(rung()).toBe("watch");

    await tick(11_600);
    expect(rung()).toBe("easier");

    await tick(8000);
    expect(rung()).toBe("together");

    await tick(2400);
    expect(q(".live-praise")).not.toBeNull();
    expect(q(".live-praise")?.getAttribute("data-praise-tone")).toBe("effort");
  });

  it("does not carry an empty room — timeouts alone stop at easier", async () => {
    vi.useFakeTimers();
    await playTapOnly();

    // Two minutes of a phone on a sofa: nothing tapped, nothing said, no face.
    await tick(120_000);

    expect(rung()).toBe("easier");
    expect(q(".live-praise")).toBeNull();
    expect(q("[data-phase='playing']")).not.toBeNull();

    // A child who comes back and touches anything is straight back on it.
    tapWrong();
    expect(rung()).toBe("together");
  });
});

/* -------------------------------------------------------------------------- */
/* 5. praise by effort                                                         */
/* -------------------------------------------------------------------------- */

describe("praise is chosen by how hard the win was", () => {
  it("is light for an instant win", async () => {
    await playTapOnly();
    click(container.querySelector('[data-choice="fingers-3"]'));

    expect(q(".live-praise")?.getAttribute("data-praise-tone")).toBe("light");
  });

  // The win the free retry exists to make possible, and the one that used to be
  // unreachable: the child missed, nobody showed them anything, nothing was
  // loosened — and then they did it themselves. Not the cheapest win in the
  // game, and not one Chiku can take any credit for.
  it("is warm praise for a second go the child won unaided", async () => {
    await playTapOnly();

    // One miss. The free retry keeps the ladder at the top, so the win that
    // follows is genuinely unhelped.
    tapWrong();
    expect(rung()).toBe("none");

    click(container.querySelector('[data-choice="fingers-3"]'));

    const tone = q(".live-praise")?.getAttribute("data-praise-tone");
    expect(tone).toBe("warm");
    // Explicitly neither of its neighbours: "light" is the instant win, and
    // "effort" is the win Chiku had to help with.
    expect(tone).not.toBe("light");
    expect(tone).not.toBe("effort");
  });

  it("is effort praise once Chiku has had to help", async () => {
    await playTapOnly();
    tapWrong(); // free retry — still unhelped
    tapWrong(); // this one drops to "watch", so Chiku has now helped
    click(container.querySelector('[data-choice="fingers-3"]'));

    expect(q(".live-praise")?.getAttribute("data-praise-tone")).toBe("effort");
  });

  it("is effort praise for a round Chiku had to carry outright", async () => {
    vi.useFakeTimers();
    await playTapOnly();
    tapWrong(); // free retry
    tapWrong();
    tapWrong();
    tapWrong();
    await tick(700 + 3 * 420 + 400 + 50);

    expect(q(".live-praise")?.getAttribute("data-praise-tone")).toBe("effort");
  });

  it("agrees with the ladder's own table", () => {
    expect(praiseToneFor("none", 0)).toBe("light");
    expect(praiseToneFor("watch", 1)).toBe("effort");
    expect(praiseToneFor("together", 3)).toBe("effort");
  });
});

/* -------------------------------------------------------------------------- */
/* 6. deferred speech — the child who holds the teal button                    */
/* -------------------------------------------------------------------------- */

describe("a line swallowed by an open mic is not lost", () => {
  it("speaks it once the mic closes", async () => {
    vi.useFakeTimers();
    await playTapOnly();
    const talk = action("talk.hold");
    fire(talk, "pointerdown");
    const before = voice.said().length;

    // Wrong taps with the button still down: Chiku correctly says nothing…
    tapWrong(); // free retry
    tapWrong();
    expect(voice.said()).toHaveLength(before);
    // …but the child can read it, and the ladder still moved.
    expect(text()).toContain("So close!");
    expect(rung()).toBe("watch");

    fire(talk, "pointerup");
    await tick(1);

    expect(voice.said().at(-1)).toBe("So close! Hold your fingers up high for Chiku.");
  });

  it("drops a swallowed line that a newer one has superseded", async () => {
    vi.useFakeTimers();
    await playTapOnly();
    const talk = action("talk.hold");
    fire(talk, "pointerdown");

    // The nudge is swallowed…
    tapWrong(); // free retry
    tapWrong();
    // …and then the "watch" demonstration's re-ask is swallowed on top of it.
    await tick(1500 + 3 * 420 + 50);
    const before = voice.said().length;

    fire(talk, "pointerup");
    await tick(1);

    // Exactly one line comes out, and it is the newest — Chiku catching up on
    // a backlog would be a monologue, not a turn.
    expect(voice.said()).toHaveLength(before + 1);
    expect(voice.said().at(-1)).toBe("Show me 3 fingers!");
    expect(voice.said()).not.toContain("So close! Hold your fingers up high for Chiku.");
  });

  it("releases it when the platform ends the mic session by itself", async () => {
    vi.useFakeTimers();
    await playTapOnly();
    fire(action("talk.hold"), "pointerdown");
    tapWrong();
    const before = voice.said().length;

    expect(voice.said()).toHaveLength(before);

    // No button release: the recogniser just stopped on its own.
    act(() => voice.end());
    await tick(1);

    expect(voice.said().at(-1)).toBe("So close! Hold your fingers up high for Chiku.");
  });

  it("does not queue behind praise — the celebration wins the turn", async () => {
    vi.useFakeTimers();
    await playTapOnly();
    fire(action("talk.hold"), "pointerdown");
    tapWrong();

    // Correct answer while the button is still down. `succeed` closes the mic
    // and praises; the swallowed nudge must not land on top of the cheer.
    click(container.querySelector('[data-choice="fingers-3"]'));
    await tick(10);

    expect(voice.said().at(-1)).toBe("Wow! Look at you!");
  });
});

/* -------------------------------------------------------------------------- */
/* helpers that need the module under test                                     */
/* -------------------------------------------------------------------------- */

/** Tap whichever wrong answer the activity on screen offers. */
function tapWrongAnything(): void {
  const buttons = [...container.querySelectorAll<HTMLButtonElement>(".choice")];
  const wrong = buttons.find((b) => {
    const id = b.getAttribute("data-choice") ?? "";
    return id !== "fingers-3" && id !== "wave-waving" && id !== "smile-happy";
  });
  if (!wrong) throw new Error("no wrong choice on screen");
  click(wrong);
}

/** Place `c` so the interior angle a → b → c is exactly `angleDeg`. */
function pointAtAngle(a: Landmark, b: Landmark, angleDeg: number, len: number, sign = 1): Landmark {
  const vx = a.x - b.x;
  const vy = a.y - b.y;
  const n = Math.hypot(vx, vy);
  const ux = vx / n;
  const uy = vy / n;
  const r = (sign * angleDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: b.x + len * (ux * cos - uy * sin), y: b.y + len * (ux * sin + uy * cos), z: 0 };
}

/**
 * A 21-landmark hand whose index finger sits at exactly `angleDeg` and whose
 * other fingers and thumb are firmly curled. Enough for a threshold assertion;
 * the full fixture lives in activities-forgiveness.test.ts.
 */
function handWithIndexAt(angleDeg: number): Landmark[] {
  const CURLED = 30;
  const pts: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  pts[0] = { x: 0.5, y: 0.9, z: 0 };

  const cmc: Landmark = { x: 0.42, y: 0.85, z: 0 };
  const thumbMcp: Landmark = { x: 0.37, y: 0.79, z: 0 };
  const ip = pointAtAngle(cmc, thumbMcp, CURLED, 0.05, -1);
  pts[1] = cmc;
  pts[2] = thumbMcp;
  pts[3] = ip;
  pts[4] = pointAtAngle(thumbMcp, ip, CURLED, 0.04, -1);

  const fingers: Array<[number, number, number]> = [
    [5, 0.45, angleDeg],
    [9, 0.5, CURLED],
    [13, 0.55, CURLED],
    [17, 0.6, CURLED],
  ];
  for (const [base, x, deg] of fingers) {
    const mcp: Landmark = { x, y: 0.8, z: 0 };
    const pip: Landmark = { x, y: 0.72, z: 0 };
    const tip = pointAtAngle(mcp, pip, deg, 0.07);
    pts[base] = mcp;
    pts[base + 1] = pip;
    pts[base + 2] = { x: (pip.x + tip.x) / 2, y: (pip.y + tip.y) / 2, z: 0 };
    pts[base + 3] = tip;
  }
  return pts;
}
