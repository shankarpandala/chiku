// @vitest-environment happy-dom
//
// Surface tests for Chiku Live.
//
// The vision engine module is mocked with a fake we can push VisionFrames
// through, so the whole surface is exercised at the real seam (Live imports
// createVisionEngine directly — nothing is injected past it). The rig is
// injected through the documented `rigFactory` test seam so we can watch the
// gaze calls instead of reverse-engineering smoothed SVG attributes.
//
// The four things worth defending are all here: the welcome path works, a
// refused camera is not a dead end, a held gesture counts, and a single-frame
// blip does not.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Emote, LiveRig, Viseme } from "@chiku/rig";
import type { VisionEngine, VisionFrame, VisionStatus } from "../src/vision/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */
/* the fake vision engine                                                     */
/* -------------------------------------------------------------------------- */

const vision = vi.hoisted(() => {
  const frameCbs = new Set<(f: VisionFrame) => void>();
  const statusCbs = new Set<(s: VisionStatus, detail?: string) => void>();
  const state = { grant: true, starts: 0, stops: 0 };

  // `status` is a LIVE value on the real engine, and the surface reads it after
  // start() to decide whether the camera actually came up (start() resolves even
  // on failure). The fake has to model that or it tests a contract nobody ships.
  // `status` is a LIVE value on the real engine, and the surface reads it after
  // start() to decide whether the camera actually came up (start() resolves even
  // on failure). The fake has to model that or it tests a contract nobody ships.
  // It is readonly on the interface, so the fake keeps its own mutable cell.
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
      state.grant = true;
      state.starts = 0;
      state.stops = 0;
    },
  };
});

vi.mock("../src/vision/engine", () => ({
  createVisionEngine: () => vision.engine,
}));

// Imported after the mock is registered (vi.mock is hoisted above this anyway).
import { Live } from "../src/surfaces/live/Live";
import { LangProvider } from "../src/i18n";
import type { RigFactory } from "../src/components/CameraStage";

/* -------------------------------------------------------------------------- */
/* the fake rig                                                               */
/* -------------------------------------------------------------------------- */

interface RigSpy {
  factory: RigFactory;
  gaze: Array<[number, number]>;
  attention: boolean[];
  emotes: Emote[];
  visemes: Array<Viseme | null>;
}

function makeRigSpy(): RigSpy {
  const spy: RigSpy = {
    factory: () => ({}) as LiveRig,
    gaze: [],
    attention: [],
    emotes: [],
    visemes: [],
  };
  spy.factory = (host) => {
    const node = host.ownerDocument.createElement("div");
    node.setAttribute("data-rig-stub", "");
    host.appendChild(node);
    const rig: LiveRig = {
      setEmote(emote) {
        spy.emotes.push(emote);
        node.setAttribute("data-emote", emote);
      },
      setViseme(viseme) {
        spy.visemes.push(viseme);
      },
      setGaze(x, y) {
        spy.gaze.push([x, y]);
        node.setAttribute("data-gaze", `${x},${y}`);
      },
      setMouthOpen() {},
      setAttention(on) {
        spy.attention.push(on);
        node.setAttribute("data-attention", String(on));
      },
      blink() {},
      perform: () => Promise.resolve(),
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
/* harness                                                                     */
/* -------------------------------------------------------------------------- */

let container: HTMLDivElement;
let root: Root;
let rig: RigSpy;

/** Constant 0.5 → fingers target 3, activity order [fingers, smile, wave]. */
const HALF = (): number => 0.5;

function frame(patch: Partial<VisionFrame> & { t: number }): VisionFrame {
  return { face: null, hands: [], totalFingers: null, waving: false, ...patch };
}

function face(x: number, y: number, attention = 0.9, smile = 0): VisionFrame["face"] {
  return { x, y, attention, smile };
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

function text(): string {
  return container.textContent ?? "";
}

async function flush(): Promise<void> {
  await act(async () => {
    // Deep enough to settle the model warm-up chain that now sits between the
    // camera tap and getUserMedia (warmVision → Promise.all → openEyes).
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function mount(): void {
  act(() => {
    root.render(
      <LangProvider>
        <Live random={HALF} rigFactory={rig.factory} />
      </LangProvider>,
    );
  });
}

/**
 * welcome → camera-ask → (models warm) → playing. `grant` decides which
 * playing mode.
 *
 * The warm-up step is new: the surface now downloads the vision models with
 * the camera still dark and only then calls getUserMedia (see
 * surface-reality.test.tsx). `okFetch` below is what makes that step succeed.
 */
async function enterPlaying(grant: boolean): Promise<void> {
  vision.state.grant = grant;
  mount();
  click(action("welcome.begin"));
  const allow = action("camera.allow");
  await act(async () => {
    allow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

/** A network that hands back every vision asset without complaint. */
function okFetch(): void {
  vi.stubGlobal(
    "fetch",
    async () =>
      ({ ok: true, status: 200, blob: async () => null }) as unknown as Response,
  );
}

function pushFrames(frames: readonly VisionFrame[]): void {
  act(() => {
    for (const f of frames) vision.push(f);
  });
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
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */

describe("Live — welcome", () => {
  it("greets in both scripts and the begin button moves to the camera ask", () => {
    mount();

    expect(text()).toContain("Hi! I am Chiku. I want to see you!");
    expect(text()).toContain("హాయ్! నేను చికు. నిన్ను చూడాలని ఉంది!");
    expect(container.querySelector("[data-phase='welcome']")).not.toBeNull();

    click(action("welcome.begin"));

    expect(container.querySelector("[data-phase='camera-ask']")).not.toBeNull();
    expect(action("camera.allow")).not.toBeNull();
    // The grown-up promise is on the same screen as the ask, not buried.
    expect(text()).toContain("nothing leaves this device");
  });

  it("offers a no-camera path from the ask, so the ask is never a wall", () => {
    mount();
    click(action("welcome.begin"));

    const skip = container.querySelector(".live-quiet");
    expect(skip).not.toBeNull();
    click(skip);

    expect(container.querySelector("[data-phase='playing']")).not.toBeNull();
    expect(container.querySelectorAll(".choice").length).toBeGreaterThan(0);
  });
});

describe("Live — denied camera", () => {
  it("falls back to tap answers instead of dead-ending", async () => {
    await enterPlaying(false);

    expect(container.querySelector("[data-phase='playing']")).not.toBeNull();
    expect(container.querySelector("[data-camera='off']")).not.toBeNull();
    // The prompt is still the real prompt…
    expect(text()).toContain("Show me 3 fingers!");
    // …and the answer is now a tap, explained in kid language.
    expect(text()).toContain("Or tap the number");
    const choices = container.querySelectorAll<HTMLButtonElement>(".choice");
    expect(choices.length).toBe(5);
    expect(vision.state.starts).toBe(1);
    expect(text()).toContain("Chiku's eyes stayed closed");
  });

  it("advances on a correct tap answer and keeps a streak", async () => {
    await enterPlaying(false);

    const three = container.querySelector<HTMLButtonElement>('[data-choice="fingers-3"]');
    expect(three).not.toBeNull();
    click(three);

    expect(text()).toContain("Got it!");
    expect(container.querySelector('[data-streak="1"]')).not.toBeNull();
  });

  it("answers a wrong tap with warm retry copy, never a failure", async () => {
    await enterPlaying(false);

    click(container.querySelector('[data-choice="fingers-5"]'));

    expect(text()).toContain("So close! Hold your fingers up high for Chiku.");
    expect(text()).toContain("Show me 3 fingers!"); // still playable
    expect(container.querySelector('[data-streak="1"]')).toBeNull();
  });
});

describe("Live — the body is the answer", () => {
  it("advances when the target finger count is held past the debounce", async () => {
    await enterPlaying(true);
    expect(text()).toContain("Show me 3 fingers!");

    pushFrames([
      frame({ t: 0, totalFingers: 3, face: face(0, 0) }),
      frame({ t: 200, totalFingers: 3, face: face(0, 0) }),
      frame({ t: 450, totalFingers: 3, face: face(0, 0) }),
      frame({ t: 700, totalFingers: 3, face: face(0, 0) }),
    ]);

    expect(text()).toContain("Got it!");
    expect(container.querySelector('[data-streak="1"]')).not.toBeNull();
    expect(rig.emotes).toContain("happy");
  });

  it("does NOT advance on a single-frame blip", async () => {
    await enterPlaying(true);

    pushFrames([
      frame({ t: 0, totalFingers: 3, face: face(0, 0) }), // the blip
      frame({ t: 100, totalFingers: 1, face: face(0, 0) }),
      frame({ t: 400, totalFingers: null, face: face(0, 0) }),
      frame({ t: 800, totalFingers: 2, face: face(0, 0) }),
      frame({ t: 1200, totalFingers: 1, face: face(0, 0) }),
      frame({ t: 1600, totalFingers: 3, face: face(0, 0) }), // one frame again
    ]);

    expect(text()).toContain("Show me 3 fingers!");
    expect(text()).not.toContain("Got it!");
    expect(container.querySelector('[data-streak="1"]')).toBeNull();
  });

  it("counts fingers held across a dropped frame (trackers blink; children do not)", async () => {
    await enterPlaying(true);

    pushFrames([
      frame({ t: 0, totalFingers: 3 }),
      frame({ t: 150, totalFingers: null }), // dropped frame, inside the slack
      frame({ t: 300, totalFingers: 3 }),
      frame({ t: 650, totalFingers: 3 }),
    ]);

    expect(text()).toContain("Got it!");
  });
});

describe("Live — Chiku looks at the child", () => {
  it("drives the rig's gaze and attention from the face signal", async () => {
    await enterPlaying(true);
    rig.gaze.length = 0;
    rig.attention.length = 0;

    pushFrames([frame({ t: 16, face: face(0.4, -0.2, 0.92) })]);

    // x is negated: FaceSignal.x is raw camera space and the preview is
    // mirrored, so Chiku must look where the child SEES themselves.
    expect(rig.gaze).toContainEqual([-0.4, -0.2]);
    expect(rig.attention.at(-1)).toBe(true);
    expect(container.querySelector("[data-rig-stub][data-gaze='-0.4,-0.2']")).not.toBeNull();
  });

  it("lights the teal cue on the STAGE (not on Chiku) while he can see the child", async () => {
    await enterPlaying(true);

    pushFrames([frame({ t: 16, face: face(0, 0, 0.9) })]);
    expect(container.querySelector(".stage.is-attending")).not.toBeNull();
    expect(text()).toContain("Chiku sees you!");
    // The cue is a property of the frame, never of the character node.
    expect(container.querySelector(".stage-chiku.is-attending")).toBeNull();

    // ONE dropped frame is a tracker blink, not a child leaving. This used to
    // put the caption back to "looking for you" and pull Chiku's eyes away
    // mid-sentence — the strobe was worst during the fingers activity, where a
    // child MUST look down at their own hands. The cue and the rig are now
    // bound to the same debounced state (see createAttentionGate).
    pushFrames([frame({ t: 500, face: null })]);
    expect(container.querySelector(".stage.is-attending")).not.toBeNull();
    expect(text()).toContain("Chiku sees you!");
    expect(rig.attention.at(-1)).toBe(true);

    // Sustained absence is a different fact, and he does let go of it.
    pushFrames(
      Array.from({ length: 12 }, (_, i) => frame({ t: 700 + i * 200, face: null })),
    );
    expect(container.querySelector(".stage.is-attending")).toBeNull();
    expect(text()).toContain("Chiku is looking for you…");
    expect(rig.attention.at(-1)).toBe(false);
  });
});

describe("Live — the ending", () => {
  it("ends in a warm goodbye after the round and releases the camera", async () => {
    vi.useFakeTimers();
    try {
      // No-camera mode so the tap answers are on screen from the first prompt.
      await enterPlaying(false);

      // Three activities, each answered by tapping the correct choice.
      for (let i = 0; i < 3; i++) {
        const correct = container.querySelector<HTMLButtonElement>(
          '[data-choice="fingers-3"], [data-choice="wave-waving"], [data-choice="smile-happy"]',
        );
        expect(correct).not.toBeNull();
        click(correct);
        await act(async () => {
          vi.advanceTimersByTime(2400);
        });
      }

      expect(container.querySelector("[data-phase='goodbye']")).not.toBeNull();
      expect(text()).toContain("Bye bye! Come back soon!");
      expect(text()).toContain("టాటా! మళ్ళీ త్వరగా రా!");
      expect(vision.state.stops).toBeGreaterThan(0);
      expect(rig.emotes).toContain("goodbye");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Live — a camera that says yes but sends nothing", () => {
  // Regression: engine.start() resolves even when it failed, and a camera can
  // report ready then deliver no frames (permission blocked above the page,
  // device held by another app, stream dies). The surface used to believe it
  // and leave the child watching "Chiku is looking for you…" forever.
  it("falls back to tapping when no frame arrives, instead of waiting forever", async () => {
    vi.useFakeTimers();
    try {
      await enterPlaying(true);
      expect(container.querySelector(".stage.is-attending")).toBeNull();

      // No frames pushed at all — just time passing.
      await act(async () => {
        vi.advanceTimersByTime(5200);
      });

      expect(text()).toContain("Tap your answer");
      expect(container.querySelector(".choices")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays in camera mode when frames do arrive", async () => {
    vi.useFakeTimers();
    try {
      await enterPlaying(true);
      pushFrames([frame({ t: 16, face: face(0, 0, 0.9) })]);
      await act(async () => {
        vi.advanceTimersByTime(5200);
      });
      expect(container.querySelector(".stage.is-attending")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
