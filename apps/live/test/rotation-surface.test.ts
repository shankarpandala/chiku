// @vitest-environment happy-dom
//
// REACHABLE, IN THE RUNNING APP.
//
// `rotation.test.ts` proves the pool is complete and each activity keeps the
// contract. That is not the same as a child being able to play it, and the
// difference is the exact bug this codebase has shipped three phases running:
// a component with green tests that nothing mounts, an activity with green
// tests that no round draws. So this file mounts the real surface, drives each
// activity in the pool to praise through the real UI, and does it in a loop
// over POOL — the ninth activity is held to it the day it lands.
//
// Two things are pinned:
//
//   1. EVERY activity in the pool can be started and FINISHED with the camera
//      off, by tapping. Not "has choices" — actually rendered on screen, with
//      its prompt, and actually ends in praise when the right one is pressed.
//   2. THE BIG/SMALL ACTIVITY MOVES CHIKU. He grows when the child throws
//      their arms up and shrinks when they tuck in, at camera rate, and he
//      goes back to his own size the moment the activity is over.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Emote, LiveRig, Viseme } from "@chiku/rig";
import type { HandSignal, VisionEngine, VisionFrame, VisionStatus } from "../src/vision/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    stop() {},
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
    reset(): void {
      frameCbs.clear();
      statusCbs.clear();
      live.status = "idle";
    },
  };
});

vi.mock("../src/vision/engine", () => ({ createVisionEngine: () => vision.engine }));

import { Live } from "../src/surfaces/live/Live";
import { LangProvider } from "../src/i18n";
import { translate } from "../src/i18n";
import { buildRound, POOL } from "../src/activities";
import { CHIKU_MAX_SIZE, CHIKU_MIN_SIZE, type RigFactory } from "../src/components/CameraStage";

let container: HTMLDivElement;
let root: Root;

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
      perform: () => Promise.resolve(),
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

function click(el: Element | null): void {
  if (!el) throw new Error("nothing to click");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function action(key: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-action="${key}"]`);
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

/**
 * A random that makes `id` the FIRST activity of the round.
 *
 * `buildRound` draws one sort key per pool entry, in pool order, lowest first;
 * everything after that is a constant 0.5, which is what every other surface
 * test uses. Derived rather than hand-counted so it survives the pool growing.
 */
function firstFixture(id: string): () => number {
  const keys = POOL.map((entry) => (entry.id === id ? 0 : 1));
  let i = 0;
  return () => (i < keys.length ? (keys[i++] ?? 0.5) : 0.5);
}

function mount(random: () => number): void {
  act(() => {
    root.render(
      createElement(LangProvider, {
        initial: "en",
        children: createElement(Live, { random, rigFactory: rigFactory() }),
      }),
    );
  });
}

/** Straight into tap play: welcome → "play without the camera". */
async function playTapOnly(random: () => number): Promise<void> {
  mount(random);
  click(action("welcome.begin"));
  click(container.querySelector(".live-quiet"));
  await flush();
}

/** welcome → allow → playing, with the fake camera granted. */
async function playWithCamera(random: () => number): Promise<void> {
  vi.stubGlobal(
    "fetch",
    async () => ({ ok: true, status: 200, blob: async () => null }) as unknown as Response,
  );
  mount(random);
  click(action("welcome.begin"));
  const allow = action("camera.allow");
  await act(async () => {
    allow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  vision.reset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/* ========================================================================== */
/* 1. a child can reach, and finish, every activity in the pool               */
/* ========================================================================== */

describe("every activity is reachable with the camera off", () => {
  for (const entry of POOL) {
    it(`${entry.id}: prompt on screen, right tap ends in praise`, async () => {
      // Same fixture, same round: this is the activity the surface will build.
      const activity = buildRound(firstFixture(entry.id))[0];
      expect(activity?.kind).toBe(entry.id);
      if (!activity) return;

      await playTapOnly(firstFixture(entry.id));

      // The prompt, in both scripts, exactly as the activity asked for it.
      expect(text()).toContain(translate("en", activity.promptKey, activity.promptValues));
      expect(text()).toContain(translate("te", activity.promptKey, activity.promptValues));
      // The tap hint, because with no camera the taps ARE the game.
      expect(text()).toContain(translate("en", activity.tapHintKey));

      const correct = activity.choices.find((c) => c.correct);
      expect(correct, `${entry.id} has no correct choice`).toBeDefined();
      const button = container.querySelector(`[data-choice="${correct?.id ?? ""}"]`);
      expect(button, `${entry.id}: the correct answer is not on screen`).not.toBeNull();

      // Every choice is a picture with a real accessible name — the child who
      // cannot read has to be able to tell them apart, and the child using a
      // screen reader has to hear which is which.
      for (const choice of activity.choices) {
        const el = container.querySelector(`[data-choice="${choice.id}"]`);
        expect(el, `${entry.id}: ${choice.id} missing`).not.toBeNull();
        expect((el?.getAttribute("aria-label") ?? "").length).toBeGreaterThan(0);
        expect(el?.querySelector("svg, .choice-swatch, .choice-digit")).not.toBeNull();
      }

      click(button);
      expect(container.querySelector(".live-praise"), `${entry.id} never praises`).not.toBeNull();
      expect(container.querySelector('[data-streak="1"]')).not.toBeNull();
    });
  }
});

/* ========================================================================== */
/* 2. the big/small activity moves Chiku                                      */
/* ========================================================================== */

const BIGSMALL = POOL.find((entry) => entry.id === "bigsmall");

function hand(x: number, y: number, handedness: string): HandSignal {
  return {
    handedness,
    fingers: 5,
    extended: [true, true, true, true, true],
    gesture: null,
    wrist: { x, y },
  };
}

/** A child with their face in the middle and both wrists at height `y`. */
function bodyFrame(t: number, y: number): VisionFrame {
  return {
    t,
    face: { x: 0, y: 0, attention: 0.9, smile: 0 },
    facePresence: 1,
    hands: [hand(0.38, y, "Left"), hand(0.62, y, "Right")],
    totalFingers: 10,
    waving: false,
    quad: null,
  };
}

function chikuSize(): number {
  const host = container.querySelector<HTMLElement>('[data-testid="chiku-host"]');
  return Number(host?.style.getPropertyValue("--chiku-size") || "1");
}

describe.runIf(BIGSMALL !== undefined)("Chiku is the size the child is", () => {
  it("grows when the child throws their arms up", async () => {
    await playWithCamera(firstFixture("bigsmall"));
    expect(text()).toContain(translate("en", "act.bigsmall.prompt"));

    // Wrists well above the face centre (0.5 in image space).
    act(() => vision.push(bodyFrame(0, 0.15)));
    expect(chikuSize()).toBeCloseTo(CHIKU_MAX_SIZE, 2);
  });

  it("shrinks when they tuck themselves in", async () => {
    await playWithCamera(firstFixture("bigsmall"));

    act(() => vision.push(bodyFrame(0, 0.15)));
    expect(chikuSize()).toBeGreaterThan(1);
    // Wrists dropped well below the face. Two frames 16ms apart cannot satisfy
    // the activity's own hold, so this is the mirror on its own.
    act(() => vision.push(bodyFrame(16, 0.85)));
    expect(chikuSize()).toBeCloseTo(CHIKU_MIN_SIZE, 2);
  });

  it("does not resize him in any other activity", async () => {
    await playWithCamera(firstFixture("wave"));
    act(() => vision.push(bodyFrame(0, 0.15)));
    expect(chikuSize()).toBe(1);
  });

  it("gives him his own size back when the activity ends", async () => {
    await playWithCamera(firstFixture("bigsmall"));
    act(() => vision.push(bodyFrame(0, 0.15)));
    expect(chikuSize()).toBeGreaterThan(1);

    // Big, then small, held long enough to win it: the round ends in praise
    // and the celebration is Chiku's own, at his own size, rather than a
    // continuation of whatever pose the child finished in.
    for (const t of [16, 32]) act(() => vision.push(bodyFrame(t, 0.15)));
    for (let t = 100; t <= 800; t += 100) act(() => vision.push(bodyFrame(t, 0.85)));

    expect(container.querySelector(".live-praise")).not.toBeNull();
    expect(chikuSize()).toBe(1);
  });
});
