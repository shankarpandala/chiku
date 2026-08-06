// @vitest-environment happy-dom
//
// THE REALITY LAYER: what the surface does on a real device, in a real room.
//
// Every test here is a finding from an audit of the shipped code, and each one
// describes a failure a family would actually hit rather than one a reviewer
// would spot:
//
//   * A minute of lit camera light while 23MB of models download, with nothing
//     on screen but a changed button label — the exact thing the camera promise
//     on that screen exists to prevent. And when the download failed, the only
//     way out was reloading the page.
//   * "Play again" looping forever: §9.5's hard session cap was not wired into
//     this app at all.
//   * A 740x360 phone held sideways, where the stage alone was taller than the
//     viewport and the answer buttons were off the bottom of a page that does
//     not scroll.
//   * The cloud-recognition consent sitting on the camera-ask screen — the one
//     the child is on ALONE every session — behind a hold a six-year-old beats.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Emote, LiveRig, Viseme } from "@chiku/rig";
import type { VisionEngine, VisionFrame, VisionStatus } from "../src/vision/types";
import type { HeardResult, Listener, SpeakHandle, Speaker } from "../src/voice/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */
/* the fake vision engine — it also records WHEN the camera was asked for      */
/* -------------------------------------------------------------------------- */

const vision = vi.hoisted(() => {
  const frameCbs = new Set<(f: VisionFrame) => void>();
  const statusCbs = new Set<(s: VisionStatus, detail?: string) => void>();
  const live = { status: "idle" as VisionStatus };
  const state = {
    grant: true,
    /** Ordered log of camera acquisitions, as timestamps in the shared clock. */
    startedAt: [] as number[],
    stops: 0,
  };

  const engine: VisionEngine = {
    get status(): VisionStatus {
      return live.status;
    },
    async start() {
      state.startedAt.push(clock.tick());
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

  /**
   * A monotonic counter shared by the engine fake and the fetch fake, so the
   * ORDER of "models fetched" against "camera acquired" is a fact rather than
   * an inference from how the promises happened to interleave.
   */
  const clock = {
    n: 0,
    tick(): number {
      this.n += 1;
      return this.n;
    },
  };

  return {
    engine,
    state,
    clock,
    reset(): void {
      frameCbs.clear();
      statusCbs.clear();
      live.status = "idle";
      state.grant = true;
      state.startedAt = [];
      state.stops = 0;
      clock.n = 0;
    },
  };
});

vi.mock("../src/vision/engine", () => ({
  createVisionEngine: () => vision.engine,
}));

/* -------------------------------------------------------------------------- */
/* the fake voice — mic present, but with NO on-device recognition, which is   */
/* the only configuration in which the cloud-ears offer is shown at all        */
/* -------------------------------------------------------------------------- */

const voice = vi.hoisted(() => {
  const state = {
    /** false → the browser would send audio away, so the offer is live. */
    onDevice: false as boolean | null,
    listenerOpts: [] as Array<{ allowCloudRecognition?: boolean }>,
  };
  const resultCbs = new Set<(r: HeardResult) => void>();
  const errorCbs = new Set<(m: string) => void>();
  const endCbs = new Set<() => void>();

  const speaker: Speaker = {
    available: true,
    speaking: false,
    speak(): SpeakHandle {
      return { done: Promise.resolve(), cancel() {} };
    },
    cancelAll() {},
    dispose() {},
  };

  const listener: Listener = {
    available: true,
    listening: false,
    get onDevice(): boolean | null {
      return state.onDevice;
    },
    async ensureOnDevice(): Promise<boolean> {
      const cloud =
        state.listenerOpts[state.listenerOpts.length - 1]?.allowCloudRecognition === true;
      return state.onDevice !== false || cloud;
    },
    start() {},
    stop() {},
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
    dispose() {
      resultCbs.clear();
      errorCbs.clear();
      endCbs.clear();
    },
  };

  return {
    speaker,
    listener,
    state,
    reset(): void {
      resultCbs.clear();
      errorCbs.clear();
      endCbs.clear();
      state.onDevice = false;
      state.listenerOpts = [];
    },
  };
});

vi.mock("../src/voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/voice")>();
  return {
    ...actual,
    createSpeaker: () => voice.speaker,
    createListener: (opts?: { allowCloudRecognition?: boolean }) => {
      voice.state.listenerOpts.push(opts ?? {});
      return voice.listener;
    },
  };
});

import { Live } from "../src/surfaces/live/Live";
import { LangProvider } from "../src/i18n";
import type { RigFactory } from "../src/components/CameraStage";
import { DEFAULT_LIMIT_MIN, SessionClock, SESSION_TICK_MS } from "../src/session/cap";
import { MODEL_BUNDLES, visionAssets, warmVision } from "../src/session/warmup";

/* -------------------------------------------------------------------------- */
/* harness                                                                     */
/* -------------------------------------------------------------------------- */

let container: HTMLDivElement;
let root: Root;

/** Constant 0.5 → fingers target 3, activity order [fingers, smile, wave]. */
const HALF = (): number => 0.5;

const rigFactory: RigFactory = (host) => {
  const node = host.ownerDocument.createElement("div");
  node.setAttribute("data-rig-stub", "");
  host.appendChild(node);
  const rig: LiveRig = {
    setEmote(emote: Emote) {
      node.setAttribute("data-emote", emote);
    },
    setViseme(_v: Viseme | null) {},
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

/**
 * Read a file from the app root. Not `import.meta.url`: under happy-dom that
 * is an http:// URL and fileURLToPath refuses it. Vitest runs with the package
 * as its cwd; the second candidate covers a run launched from the repo root.
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

function text(): string {
  return container.textContent ?? "";
}

/**
 * Hold the corner control open. HoldButton measures with `performance.now()`,
 * which the fake timers do not advance, so the clock it reads is driven here
 * explicitly — otherwise the interval ticks forever at zero progress.
 * Requires vi.useFakeTimers().
 */
function openGrownUpSheet(): void {
  let perf = 0;
  const spy = vi.spyOn(performance, "now").mockImplementation(() => perf);
  const corner = container.querySelector<HTMLButtonElement>(".grownup-corner .hold-button");
  if (!corner) throw new Error("no grown-up corner control");
  act(() => {
    corner.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  });
  perf = 2500;
  act(() => {
    vi.advanceTimersByTime(2500);
  });
  spy.mockRestore();
}

function action(key: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-action="${key}"]`);
}

function click(el: Element | null): void {
  if (!el) throw new Error("nothing to click");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

function mount(): void {
  act(() => {
    root.render(
      <LangProvider>
        <Live random={HALF} rigFactory={rigFactory} />
      </LangProvider>,
    );
  });
}

/**
 * The warm-up's fetch. Every call is stamped with the same counter the engine
 * fake uses, so "models before camera" is an assertion about order, not hope.
 */
interface FetchLog {
  readonly urls: string[];
  fail: boolean;
}
let fetchLog: FetchLog;

function installFetch(): void {
  fetchLog = { urls: [], fail: false };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchLog.urls.push(url);
    vision.clock.tick();
    if (fetchLog.fail) throw new Error("network down");
    return {
      ok: true,
      status: 200,
      async blob() {
        return null;
      },
    } as unknown as Response;
  });
}

beforeEach(() => {
  vision.reset();
  voice.reset();
  installFetch();
  window.localStorage.clear();
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
/* 1. models before camera                                                     */
/* -------------------------------------------------------------------------- */

describe("Live — the models load before the camera light comes on", () => {
  it("warms every vision asset BEFORE getUserMedia is ever called", async () => {
    mount();
    click(action("welcome.begin"));
    click(action("camera.allow"));

    // One synchronous beat after the tap: the warm-up is in flight and the
    // camera has NOT been touched. This is the whole fix.
    expect(vision.state.startedAt).toEqual([]);
    expect(fetchLog.urls.length).toBeGreaterThan(0);
    expect(text()).toContain("Chiku is getting his eyes ready…");
    expect(text()).toContain("the camera is still off");

    await flush();

    // Now the camera, and only now.
    expect(vision.state.startedAt.length).toBe(1);
    const cameraAt = vision.state.startedAt[0] ?? 0;
    expect(cameraAt).toBeGreaterThan(fetchLog.urls.length);
    for (const asset of visionAssets()) expect(fetchLog.urls).toContain(asset);
    expect(container.querySelector("[data-phase='playing']")).not.toBeNull();
  });

  it("keeps 'play without the camera' reachable while the models are downloading", async () => {
    mount();
    click(action("welcome.begin"));
    click(action("camera.allow"));

    const skip = container.querySelector<HTMLButtonElement>(".live-quiet");
    expect(skip).not.toBeNull();
    // Not merely present: ENABLED. A bored child mid-download is exactly who
    // this door is for, and it used to be disabled behind `busy`.
    expect(skip?.disabled).toBe(false);
    click(skip);
    await flush();

    expect(container.querySelector("[data-phase='playing']")).not.toBeNull();
    expect(container.querySelector("[data-camera='off']")).not.toBeNull();
    // Left before the camera was ever asked for.
    expect(vision.state.startedAt).toEqual([]);
  });

  it("offers a retry when the download fails, and the retry works", async () => {
    fetchLog.fail = true;
    mount();
    click(action("welcome.begin"));
    click(action("camera.allow"));
    await flush();

    // Previously this state had no exit at all except reloading the page.
    expect(text()).toContain("Chiku could not find his eyes");
    expect(action("warm.retry")).not.toBeNull();
    expect(container.querySelector(".live-quiet")).not.toBeNull();
    expect(vision.state.startedAt).toEqual([]);

    // The network comes back; the same button now gets all the way through.
    fetchLog.fail = false;
    click(action("warm.retry"));
    await flush();

    expect(vision.state.startedAt.length).toBe(1);
    expect(container.querySelector("[data-phase='playing']")).not.toBeNull();
  });

  it("still reaches the game by tapping when the download keeps failing", async () => {
    fetchLog.fail = true;
    mount();
    click(action("welcome.begin"));
    click(action("camera.allow"));
    await flush();

    click(container.querySelector(".live-quiet"));
    await flush();

    expect(container.querySelector("[data-phase='playing']")).not.toBeNull();
    expect(container.querySelectorAll(".choice").length).toBeGreaterThan(0);
  });
});

describe("warmVision", () => {
  it("rejects when any single asset fails — a half-warm cache is not warm", async () => {
    let n = 0;
    await expect(
      warmVision({
        assets: ["/a", "/b"],
        fetchImpl: (async () => {
          n += 1;
          return { ok: n === 1, status: n === 1 ? 200 : 503 } as Response;
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
  });

  it("warms exactly one WASM runtime — never both builds", () => {
    expect(visionAssets(true)).toHaveLength(4);
    expect(visionAssets(false)).toHaveLength(4);
    expect(visionAssets(true).some((u) => u.includes("nosimd"))).toBe(false);
    expect(visionAssets(false).every((u) => !u.includes("wasm_internal"))).toBe(true);
  });

  it("warms the paths the real engine actually loads", async () => {
    // The constants are duplicated so the surface tests can mock the engine
    // module wholesale; this is the guard that keeps the copies honest.
    const real = await vi.importActual<typeof import("../src/vision/engine")>(
      "../src/vision/engine",
    );
    expect(MODEL_BUNDLES).toContain(real.FACE_MODEL_PATH);
    expect(MODEL_BUNDLES).toContain(real.HAND_MODEL_PATH);
    for (const url of visionAssets(true)) {
      if (url.endsWith(".task")) continue;
      expect(url.startsWith(`${real.VISION_WASM_PATH}/`)).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. the session cap                                                          */
/* -------------------------------------------------------------------------- */

describe("SessionClock", () => {
  it("counts play time, not wall-clock time", () => {
    let t = 0;
    const clock = new SessionClock(() => t);
    clock.start();
    t += 60_000;
    clock.pause();
    // Ten minutes of a phone call: the child was not playing.
    t += 600_000;
    clock.start();
    t += 60_000;
    expect(clock.elapsedMs()).toBe(120_000);
    expect(clock.expired(DEFAULT_LIMIT_MIN)).toBe(false);
  });

  it("expires exactly at the limit and clamps a nonsense one", () => {
    let t = 0;
    const clock = new SessionClock(() => t);
    clock.start();
    t = 20 * 60_000 - 1;
    expect(clock.expired(20)).toBe(false);
    t = 20 * 60_000;
    expect(clock.expired(20)).toBe(true);
    expect(clock.progress(20)).toBe(1);
  });
});

describe("Live — the hard session cap (§9.5)", () => {
  it("ends warmly at the cap and does not offer another round", async () => {
    vi.useFakeTimers();
    try {
      mount();
      click(action("welcome.begin"));
      click(container.querySelector(".live-quiet")); // straight to tap play
      await flush();
      expect(container.querySelector("[data-phase='playing']")).not.toBeNull();

      // The default cap, elapsed. The tick is what notices.
      await act(async () => {
        vi.advanceTimersByTime(DEFAULT_LIMIT_MIN * 60_000 + SESSION_TICK_MS);
      });

      expect(container.querySelector("[data-phase='goodbye']")).not.toBeNull();
      // Warm, in both scripts, and with nothing that reads as a telling-off.
      expect(text()).toContain("That is all our play time for today!");
      expect(text()).toContain("ఈ రోజుకి మన ఆట సమయం అయిపోయింది!");
      expect(text()).not.toContain("Play again");
      expect(action("goodbye.again")).toBeNull();
      // The camera light goes out with the session.
      expect(vision.state.stops).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to restart past the cap even if 'play again' is reached", async () => {
    vi.useFakeTimers();
    try {
      mount();
      click(action("welcome.begin"));
      click(container.querySelector(".live-quiet"));
      await flush();

      // Finish the round normally BEFORE the cap: the ordinary goodbye, with
      // the button, is what a child sees.
      for (let i = 0; i < 3; i += 1) {
        click(
          container.querySelector(
            '[data-choice="fingers-3"], [data-choice="wave-waving"], [data-choice="smile-happy"]',
          ),
        );
        await act(async () => {
          vi.advanceTimersByTime(2400);
        });
      }
      expect(container.querySelector("[data-phase='goodbye']")).not.toBeNull();
      const again = action("goodbye.again");
      expect(again).not.toBeNull();

      // …and now the clock runs out while they sit on that screen. The button
      // is still on the page (nothing re-rendered it away), so pressing it is
      // the exact regression: it must end the day, not start a fourth round.
      await act(async () => {
        vi.advanceTimersByTime(DEFAULT_LIMIT_MIN * 60_000);
      });
      click(again);
      await flush();

      expect(container.querySelector("[data-phase='playing']")).toBeNull();
      expect(text()).toContain("That is all our play time for today!");
      expect(action("goodbye.again")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does allow another round while there is time left", async () => {
    vi.useFakeTimers();
    try {
      mount();
      click(action("welcome.begin"));
      click(container.querySelector(".live-quiet"));
      await flush();

      for (let i = 0; i < 3; i += 1) {
        click(
          container.querySelector(
            '[data-choice="fingers-3"], [data-choice="wave-waving"], [data-choice="smile-happy"]',
          ),
        );
        await act(async () => {
          vi.advanceTimersByTime(2400);
        });
      }
      click(action("goodbye.again"));
      await flush();

      expect(container.querySelector("[data-phase='playing']")).not.toBeNull();
      expect(text()).toContain("Show me 3 fingers!");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cut a celebration in half when the cap falls due mid-praise", async () => {
    vi.useFakeTimers();
    try {
      window.localStorage.setItem("chiku.live.limitMin", "5");
      mount();
      click(action("welcome.begin"));
      click(container.querySelector(".live-quiet"));
      await flush();

      // 4:59 of play, then a correct answer: praise is on screen.
      await act(async () => {
        vi.advanceTimersByTime(4 * 60_000 + 59_000);
      });
      click(container.querySelector('[data-choice="fingers-3"]'));
      expect(text()).toContain("You tried and tried. Chiku is so happy!");

      // The 5s tick now crosses the cap while the child is being congratulated.
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      // Still celebrating. Ending here would replace "you did it" with "time's
      // up" on the same beat, which is the meanest possible reading of a cap.
      expect(text()).toContain("You tried and tried. Chiku is so happy!");
      expect(container.querySelector("[data-phase='playing']")).not.toBeNull();

      // The praise runs out; THEN the day ends.
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      expect(container.querySelector("[data-phase='goodbye']")).not.toBeNull();
      expect(text()).toContain("That is all our play time for today!");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not spend play time while the tab is hidden", async () => {
    vi.useFakeTimers();
    try {
      window.localStorage.setItem("chiku.live.limitMin", "5");
      mount();
      click(action("welcome.begin"));
      click(container.querySelector(".live-quiet"));
      await flush();

      const hide = (state: string): void => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => state,
        });
        act(() => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
      };

      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      hide("hidden");
      // A parent's ten-minute phone call, twice the whole cap.
      await act(async () => {
        vi.advanceTimersByTime(10 * 60_000);
      });
      hide("visible");
      await act(async () => {
        vi.advanceTimersByTime(SESSION_TICK_MS);
      });

      // Still playing: one minute of play was spent, not eleven.
      expect(container.querySelector("[data-phase='playing']")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the sun-to-moon arc while playing, and moves it", async () => {
    vi.useFakeTimers();
    try {
      mount();
      click(action("welcome.begin"));
      click(container.querySelector(".live-quiet"));
      await flush();

      const arc = (): string | null =>
        container.querySelector(".session-arc")?.getAttribute("data-session-progress") ?? null;
      expect(arc()).toBe("0.00");

      await act(async () => {
        vi.advanceTimersByTime(10 * 60_000);
      });
      expect(arc()).toBe("0.50");
    } finally {
      vi.useRealTimers();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 3. landscape                                                                */
/* -------------------------------------------------------------------------- */

describe("Live — a phone held sideways", () => {
  const css = appFile("src/styles.css");

  it("caps the stage by HEIGHT, so it cannot outgrow a short viewport", () => {
    // The bug: `width: min(92vw, 620px)` + `aspect-ratio: 4/3` makes a 465px
    // tall stage on a 360px tall viewport, pushing the answers off the page.
    expect(css).toMatch(/\.stage\s*\{[^}]*width:\s*min\([^)]*vh[^)]*\)/);
  });

  it("switches to a row layout in a short landscape viewport", () => {
    const query = css.match(
      /@media\s*\(orientation:\s*landscape\)\s*and\s*\(max-height:\s*\d+px\)\s*\{[\s\S]*?\n\}/,
    );
    expect(query).not.toBeNull();
    const block = query?.[0] ?? "";
    expect(block).toContain("flex-direction: row");
    // The panel — which holds the prompt AND the choices — must be able to
    // scroll on its own rather than overflow a page that cannot.
    expect(block).toMatch(/\.panel\s*\{[^}]*overflow-y:\s*auto/);
    expect(block).toMatch(/\.choice\s*\{/);
  });

  it("keeps the prompt and every choice in the document at 740x360", async () => {
    vi.stubGlobal("innerWidth", 740);
    vi.stubGlobal("innerHeight", 360);
    mount();
    click(action("welcome.begin"));
    click(container.querySelector(".live-quiet"));
    await flush();

    expect(container.querySelector(".live-prompt")).not.toBeNull();
    expect(container.querySelectorAll(".choice").length).toBe(5);
    expect(container.querySelector(".choices")).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 4. the cloud-ears gate                                                      */
/* -------------------------------------------------------------------------- */

describe("Live — cloud recognition is a grown-up decision", () => {
  it("is NOT on the camera-ask screen, which the child is on alone", async () => {
    mount();
    click(action("welcome.begin"));
    await flush();

    expect(container.querySelector("[data-phase='camera-ask']")).not.toBeNull();
    // The offer is live on this fake platform (no on-device recognition), so
    // its absence here is the move, not a config accident.
    expect(container.querySelector(".cloud-ears")).toBeNull();
    expect(text()).not.toContain("internet ears");
    // The camera promise stays where it belongs: with the camera ask.
    expect(text()).toContain("nothing leaves this device");
  });

  it("lives behind the corner control, and its hold is a long one", async () => {
    mount();
    await flush();

    const corner = container.querySelector<HTMLButtonElement>(".grownup-corner .hold-button");
    expect(corner).not.toBeNull();
    // Opening the sheet changes nothing, so it keeps the ordinary child-lock.
    expect(corner?.getAttribute("data-hold-ms")).toBe("2000");

    act(() => {
      corner?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    // No tap path: a press that is not held opens nothing.
    act(() => {
      corner?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    expect(container.querySelector("[data-testid='grownup-sheet']")).toBeNull();
  });

  it("puts the consent behind a hold a small child gives up on", async () => {
    vi.useFakeTimers();
    try {
      mount();
      await flush();
      openGrownUpSheet();

      const sheet = container.querySelector("[data-testid='grownup-sheet']");
      expect(sheet).not.toBeNull();
      // The honest wording is unchanged — only the door moved.
      expect(text()).toContain("sent to the browser's speech service (Google)");

      const consent = container.querySelector<HTMLButtonElement>(
        "[data-testid='grownup-sheet'] .cloud-ears .hold-button",
      );
      expect(consent).not.toBeNull();
      expect(Number(consent?.getAttribute("data-hold-ms"))).toBeGreaterThanOrEqual(5000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a grown-up shorten the session cap from the same sheet", async () => {
    vi.useFakeTimers();
    try {
      mount();
      await flush();
      openGrownUpSheet();

      expect(container.querySelector("[data-limit]")?.getAttribute("data-limit")).toBe("20");
      click(action("grownup.limitLess"));
      expect(container.querySelector("[data-limit]")?.getAttribute("data-limit")).toBe("15");
      // Persisted for the next visit; a single integer, no PII.
      expect(window.localStorage.getItem("chiku.live.limitMin")).toBe("15");

      click(action("grownup.close"));
      expect(container.querySelector("[data-testid='grownup-sheet']")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 5. the PWA shell                                                            */
/* -------------------------------------------------------------------------- */

describe("the offline shell", () => {
  const read = appFile;

  it("ships a manifest that is linked from the document", () => {
    const manifest: unknown = JSON.parse(read("public/manifest.webmanifest"));
    const m = manifest as { name: string; display: string; background_color: string; icons: unknown[] };
    expect(m.name).toBe("Chiku Live");
    expect(m.display).toBe("standalone");
    expect(m.background_color).toBe("#fdf6ec");
    expect(m.icons).toHaveLength(3);
    expect(read("index.html")).toContain('rel="manifest"');
  });

  it("caches the 23MB vision bundle under its OWN cache name", () => {
    const sw = read("public/sw.js");
    // Separate from the shell cache, so shipping a new build never makes a
    // family download the models again.
    expect(sw).toMatch(/const SHELL_CACHE = "[^"]+"/);
    expect(sw).toMatch(/const MODEL_CACHE = "[^"]+"/);
    expect(sw).toContain('url.pathname.startsWith("/vision/")');
    expect(sw).toContain("modelFirst");
    // Navigations must NOT be cache-first, or a device gets stuck on an old build.
    expect(sw).toContain("networkFirstDocument");
  });

  it("registers the worker after load, in production only, and never fatally", () => {
    const main = read("src/main.tsx");
    expect(main).toContain("import.meta.env.PROD");
    expect(main).toContain('window.addEventListener("load"');
    expect(main).toMatch(/register\("\/sw\.js"\)\s*\.catch/);
  });
});
