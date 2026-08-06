// @vitest-environment happy-dom
//
// Surface tests for Chiku's VOICE: the half where he talks and the half where
// he listens.
//
// Both are mocked at the module seam (`src/voice`) rather than at the platform
// seam, for the same reason the vision engine is: Live imports the factories
// directly and nothing is injected past them. The fakes are controllable —
// a line can be finished or cancelled on command, and a result can be pushed
// as interim or final — because the interesting behaviour is all in the timing.
//
// The things worth defending, and why each one is a test rather than a comment:
//
//   * A prompt that is only written is not a prompt, for a three-year-old.
//   * An INTERIM result is a guess, not an answer. Recognisers flicker through
//     "free" and "tree" on the way to "three", and celebrating one of those is
//     worse than not listening at all.
//   * "moodu" is not an edge case. It is the single most likely thing this app
//     will ever hear, and it arrives in Latin letters.
//   * Chiku must stop talking the instant a child starts. A character that
//     talks over a child is a recording.
//   * No microphone must remove the control, not disable it — and must leave
//     the game entirely playable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Emote, LiveRig, Viseme } from "@chiku/rig";
import type { VisionEngine, VisionFrame, VisionStatus } from "../src/vision/types";
import type { HeardResult, Listener, SpeakHandle, Speaker } from "../src/voice/types";
import type { Lang } from "../src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */
/* the fake vision engine — camera off unless a test says otherwise           */
/* -------------------------------------------------------------------------- */

const vision = vi.hoisted(() => {
  const frameCbs = new Set<(f: VisionFrame) => void>();
  const statusCbs = new Set<(s: VisionStatus, detail?: string) => void>();
  const state = { grant: true };
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
    reset(): void {
      frameCbs.clear();
      statusCbs.clear();
      state.grant = true;
      live.status = "idle";
    },
  };
});

vi.mock("../src/vision/engine", () => ({
  createVisionEngine: () => vision.engine,
}));

/* -------------------------------------------------------------------------- */
/* the fake voice                                                             */
/* -------------------------------------------------------------------------- */

const voice = vi.hoisted(() => {
  interface Line {
    readonly text: string;
    readonly lang: string;
    readonly mouth: ((open: number) => void) | undefined;
    status: "speaking" | "done" | "cancelled";
    settle: () => void;
  }

  const state = {
    speakerAvailable: true,
    micAvailable: true,
    onDevice: true as boolean | null,
    startThrows: false,
    lines: [] as Line[],
    /** One entry per mic open, holding the language it was opened in. */
    starts: [] as string[],
    stops: 0,
    listening: false,
    /** One entry per createListener call — the surface's permission model. */
    listenerOpts: [] as Array<{ allowCloudRecognition?: boolean }>,
  };

  const resultCbs = new Set<(r: HeardResult) => void>();
  const errorCbs = new Set<(m: string) => void>();
  const endCbs = new Set<() => void>();

  function settle(line: Line, status: "done" | "cancelled"): void {
    if (line.status !== "speaking") return;
    line.status = status;
    line.settle();
  }

  const speaker: Speaker = {
    get available(): boolean {
      return state.speakerAvailable;
    },
    get speaking(): boolean {
      return state.lines.some((l) => l.status === "speaking");
    },
    speak(text, lang, onMouth): SpeakHandle {
      let resolve: () => void = () => {};
      const done = new Promise<void>((r) => {
        resolve = r;
      });
      const line: Line = { text, lang, mouth: onMouth, status: "speaking", settle: resolve };
      state.lines.push(line);
      return {
        done,
        cancel: () => settle(line, "cancelled"),
      };
    },
    cancelAll(): void {
      for (const line of state.lines) settle(line, "cancelled");
    },
    dispose(): void {},
  };

  const listener: Listener = {
    get available(): boolean {
      return state.micAvailable;
    },
    get onDevice(): boolean | null {
      return state.onDevice;
    },
    async ensureOnDevice(): Promise<boolean> {
      const cloudAccepted = state.listenerOpts[state.listenerOpts.length - 1]?.allowCloudRecognition === true;
      return state.onDevice !== false || cloudAccepted;
    },
    get listening(): boolean {
      return state.listening;
    },
    start(lang): void {
      if (state.startThrows) throw new Error("start refused");
      state.starts.push(lang);
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
    /** The line Chiku is saying (or last said). */
    last(): Line | undefined {
      return state.lines.at(-1);
    },
    finish(line: Line | undefined): void {
      if (line) settle(line, "done");
    },
    hear(text: string, isFinal: boolean, conf = 0): void {
      for (const cb of [...resultCbs]) cb({ text, conf, isFinal });
    },
    fail(message: string): void {
      for (const cb of [...errorCbs]) cb(message);
    },
    end(): void {
      for (const cb of [...endCbs]) cb();
    },
    reset(): void {
      resultCbs.clear();
      errorCbs.clear();
      endCbs.clear();
      state.speakerAvailable = true;
      state.micAvailable = true;
      state.startThrows = false;
      state.lines = [];
      state.starts = [];
      state.stops = 0;
      state.listening = false;
      state.onDevice = true;
      state.listenerOpts = [];
    },
  };
});

// The factories are faked; everything else (notably `isMicUnusable`, which
// decides whether an error is fatal) stays real, so the surface is tested
// against the shipped error vocabulary rather than a convenient invention.
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

/* -------------------------------------------------------------------------- */
/* the fake rig                                                               */
/* -------------------------------------------------------------------------- */

interface RigSpy {
  factory: RigFactory;
  emotes: Emote[];
  visemes: Array<Viseme | null>;
  mouth: number[];
}

function makeRigSpy(): RigSpy {
  const spy: RigSpy = {
    factory: () => ({}) as LiveRig,
    emotes: [],
    visemes: [],
    mouth: [],
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
      setGaze() {},
      setMouthOpen(v) {
        spy.mouth.push(v);
      },
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
/* harness                                                                     */
/* -------------------------------------------------------------------------- */

let container: HTMLDivElement;
let root: Root;
let rig: RigSpy;

/** Constant 0.5 → fingers target 3, activity order [fingers, smile, wave]. */
const HALF = (): number => 0.5;

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

/** Hold gestures are pointer events, not clicks — press and release are separate. */
function fire(el: Element | null, type: string): void {
  if (!el) throw new Error(`nothing to ${type}`);
  act(() => {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    // Deep enough to settle the model warm-up chain that now sits between the
    // camera tap and getUserMedia (warmVision → Promise.all → openEyes).
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

/** A network that hands back every vision asset without complaint. */
function okFetch(): void {
  vi.stubGlobal(
    "fetch",
    async () =>
      ({ ok: true, status: 200, blob: async () => null }) as unknown as Response,
  );
}

/**
 * Walk the grown-up route to the settings sheet: hold the corner control.
 * HoldButton measures with `performance.now()`, so tests on fake timers must
 * advance that too — the `toFake: [... "performance"]` lists below do it.
 */
function openGrownUpSheet(): void {
  const corner = container.querySelector<HTMLButtonElement>(".grownup-corner .hold-button");
  if (!corner) throw new Error("no grown-up corner control");
  act(() => {
    corner.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  act(() => {
    vi.advanceTimersByTime(2200);
  });
}

/** The cloud-ears consent hold, inside the sheet. Five seconds, deliberately. */
function cloudHold(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    "[data-testid='grownup-sheet'] .cloud-ears .hold-button",
  );
}

function mount(lang: Lang = "en"): void {
  act(() => {
    root.render(
      <LangProvider initial={lang}>
        <Live random={HALF} rigFactory={rig.factory} />
      </LangProvider>,
    );
  });
}

/** welcome → camera-ask → playing. */
async function enterPlaying(grant: boolean, lang: Lang = "en"): Promise<void> {
  vision.state.grant = grant;
  mount(lang);
  click(action("welcome.begin"));
  const allow = action("camera.allow");
  await act(async () => {
    allow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  vision.reset();
  voice.reset();
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

describe("Chiku speaks", () => {
  it("greets out loud the moment he is on screen", async () => {
    mount();
    expect(voice.last()?.text).toBe("Hi! I am Chiku. I want to see you!");
    // Settle the on-device recognition probe, which now resolves at mount
    // rather than on the first phase change. Nothing above depends on it; this
    // only keeps its setState inside act().
    await flush();
  });

  it("says the activity prompt when a round starts", async () => {
    await enterPlaying(false);

    // The written prompt is unchanged — and now it is also audible.
    expect(text()).toContain("Show me 3 fingers!");
    expect(voice.last()?.text).toBe("Show me 3 fingers!");
    expect(voice.last()?.lang).toBe("en");
  });

  it("says it in Telugu when the surface is in Telugu", async () => {
    await enterPlaying(false, "te");

    expect(voice.last()?.text).toBe("3 వేళ్ళు చూపించు!");
    expect(voice.last()?.lang).toBe("te");
  });

  it("wears the encouraging face while talking and settles to listening after", async () => {
    await enterPlaying(false);
    expect(rig.emotes.at(-1)).toBe("encouraging");

    voice.finish(voice.last());
    await flush();

    expect(rig.emotes.at(-1)).toBe("listening");
  });

  it("drives the rig's jaw from the speaker's mouth callback", async () => {
    await enterPlaying(false);

    act(() => voice.last()?.mouth?.(0.62));
    expect(rig.mouth.at(-1)).toBe(0.62);

    // …and hands the mouth back when the line ends.
    voice.finish(voice.last());
    await flush();
    expect(rig.mouth.at(-1)).toBe(0);
  });

  it("praises and says goodbye out loud", async () => {
    vi.useFakeTimers();
    try {
      await enterPlaying(false);
      click(container.querySelector('[data-choice="fingers-3"]'));
      expect(voice.last()?.text).toBe("Wow! Look at you!");

      for (let i = 0; i < 3; i++) {
        const correct = container.querySelector<HTMLButtonElement>(
          '[data-choice="fingers-3"], [data-choice="wave-waving"], [data-choice="smile-happy"]',
        );
        if (correct) click(correct);
        await act(async () => {
          vi.advanceTimersByTime(2400);
        });
      }

      expect(text()).toContain("Bye bye! Come back soon!");
      expect(voice.last()?.text).toBe("Bye bye! Come back soon!");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never blocks the game when the platform has no voice at all", async () => {
    voice.state.speakerAvailable = false;
    await enterPlaying(false);

    expect(voice.state.lines).toHaveLength(0);
    expect(text()).toContain("Show me 3 fingers!");
    click(container.querySelector('[data-choice="fingers-3"]'));
    expect(text()).toContain("Wow! Look at you!");
  });
});

describe("Chiku listens — push to talk", () => {
  it("opens the mic on hold and closes it on release", async () => {
    await enterPlaying(true);

    const talk = action("talk.hold");
    expect(talk).not.toBeNull();
    expect(container.querySelector(".talk-btn.is-listening")).toBeNull();

    fire(talk, "pointerdown");
    expect(voice.state.starts).toEqual(["en"]);
    expect(voice.state.listening).toBe(true);
    // Teal — the reserved colour — only now, only while the mic is open.
    expect(container.querySelector(".talk-btn.is-listening")).not.toBeNull();

    fire(talk, "pointerup");
    expect(voice.state.stops).toBe(1);
    expect(voice.state.listening).toBe(false);
    expect(container.querySelector(".talk-btn.is-listening")).toBeNull();
  });

  it("opens the mic in the language on screen", async () => {
    await enterPlaying(true, "te");
    fire(action("talk.hold"), "pointerdown");
    expect(voice.state.starts).toEqual(["te"]);
  });

  // The hold is the whole privacy promise, so it has to survive every way a
  // hold can end that is not a tidy release: the OS stealing the gesture, and
  // focus leaving the button mid-press.
  it("closes the mic when the gesture is cancelled out from under it", async () => {
    await enterPlaying(true);
    const talk = action("talk.hold");
    fire(talk, "pointerdown");
    fire(talk, "pointercancel");
    expect(voice.state.listening).toBe(false);
    expect(container.querySelector(".talk-btn.is-listening")).toBeNull();
  });

  it("closes the mic when the button loses focus while held", async () => {
    await enterPlaying(true);
    const talk = action("talk.hold");
    fire(talk, "pointerdown");
    fire(talk, "focusout"); // React's onBlur
    expect(voice.state.listening).toBe(false);
  });
});

describe("a spoken answer is an answer", () => {
  it("completes the activity on a correct FINAL result", async () => {
    await enterPlaying(true);
    fire(action("talk.hold"), "pointerdown");

    act(() => voice.hear("three", true, 0.8));

    expect(text()).toContain("Wow! Look at you!");
    expect(container.querySelector('[data-streak="1"]')).not.toBeNull();
  });

  it("ignores an INTERIM result, even a correct one", async () => {
    await enterPlaying(true);
    fire(action("talk.hold"), "pointerdown");

    act(() => voice.hear("three", false, 0.9));

    expect(text()).toContain("Show me 3 fingers!");
    expect(text()).not.toContain("Wow! Look at you!");
    expect(container.querySelector('[data-streak="1"]')).toBeNull();

    // …and the same words, final, do count.
    act(() => voice.hear("three", true, 0.9));
    expect(text()).toContain("Wow! Look at you!");
  });

  // The normal path, not an exotic one: `stop()` delivers the final result on
  // the way out, so the answer usually lands after the child has let go.
  it("counts a final result that arrives after the button is released", async () => {
    await enterPlaying(true);
    const talk = action("talk.hold");
    fire(talk, "pointerdown");
    fire(talk, "pointerup");

    act(() => voice.hear("three", true));

    expect(text()).toContain("Wow! Look at you!");
  });

  it("speaks the retry once the child has let go and was misheard", async () => {
    await enterPlaying(true);
    const talk = action("talk.hold");
    fire(talk, "pointerdown");
    fire(talk, "pointerup");

    act(() => voice.hear("banana", true));

    expect(voice.last()?.text).toBe("So close! Hold your fingers up high for Chiku.");
  });

  it("accepts transliterated Telugu, which is what en-IN actually returns", async () => {
    await enterPlaying(true);
    fire(action("talk.hold"), "pointerdown");

    act(() => voice.hear("Moodu!", true));

    expect(text()).toContain("Wow! Look at you!");
  });

  it("accepts Telugu script too", async () => {
    await enterPlaying(true, "te");
    fire(action("talk.hold"), "pointerdown");

    act(() => voice.hear("మూడు", true));

    expect(text()).toContain("వావ్! ఎంత బాగా చేశావో!"); // praise.two, in Telugu
  });

  it("accepts the answer inside a whole sentence", async () => {
    await enterPlaying(true);
    fire(action("talk.hold"), "pointerdown");

    act(() => voice.hear("i think it is three", true));

    expect(text()).toContain("Wow! Look at you!");
  });

  it("answers a wrong utterance with the warm retry, never a failure", async () => {
    await enterPlaying(true);
    fire(action("talk.hold"), "pointerdown");

    act(() => voice.hear("five", true));

    expect(text()).toContain("So close! Hold your fingers up high for Chiku.");
    expect(text()).toContain("Show me 3 fingers!"); // still playable
    expect(container.querySelector('[data-streak="1"]')).toBeNull();
    // A child who is being misheard gets the tap answers without waiting.
    expect(container.querySelector(".choices")).not.toBeNull();
  });
});

describe("barge-in", () => {
  it("stops Chiku mid-sentence the moment the child holds to talk", async () => {
    await enterPlaying(true);

    const line = voice.last();
    expect(line?.text).toBe("Show me 3 fingers!");
    expect(line?.status).toBe("speaking");

    fire(action("talk.hold"), "pointerdown");

    expect(line?.status).toBe("cancelled");
    expect(voice.speaker.speaking).toBe(false);
    // And the mic did open — barge-in is not a substitute for listening.
    expect(voice.state.starts).toEqual(["en"]);
  });

  // The other half of the same manners, and a real feedback loop if it is
  // missing: Chiku's own voice would go into the open mic, come back as a
  // wrong answer, prompt another line, and never stop.
  it("stays quiet for as long as the mic is open", async () => {
    vi.useFakeTimers();
    try {
      await enterPlaying(true);
      fire(action("talk.hold"), "pointerdown");
      const before = voice.state.lines.length;

      // The 8s "still working on it?" nudge lands while the child is holding.
      await act(async () => {
        vi.advanceTimersByTime(8200);
      });

      expect(text()).toContain("So close! Hold your fingers up high for Chiku.");
      expect(voice.state.lines).toHaveLength(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still praises out loud after a spoken answer — the turn is over", async () => {
    await enterPlaying(true);
    fire(action("talk.hold"), "pointerdown");

    act(() => voice.hear("three", true));

    expect(voice.state.stops).toBe(1); // the mic closed first…
    expect(voice.last()?.text).toBe("Wow! Look at you!"); // …so this was heard
  });

  it("gives the jaw back so Chiku is not left mid-syllable", async () => {
    await enterPlaying(true);
    act(() => voice.last()?.mouth?.(0.7));

    fire(action("talk.hold"), "pointerdown");

    expect(rig.mouth.at(-1)).toBe(0);
  });
});

describe("no microphone is not a dead end", () => {
  it("hides the talk control and says so, leaving tap answers working", async () => {
    voice.state.micAvailable = false;
    await enterPlaying(false);

    expect(action("talk.hold")).toBeNull();
    expect(text()).toContain("Chiku's ears do not work on this device");
    expect(text()).toContain("ఈ పరికరంలో చికు చెవులు పనిచేయవు");

    // The game is untouched.
    expect(text()).toContain("Show me 3 fingers!");
    click(container.querySelector('[data-choice="fingers-3"]'));
    expect(text()).toContain("Wow! Look at you!");
    expect(container.querySelector('[data-streak="1"]')).not.toBeNull();
  });

  it("removes the control when permission is refused mid-session", async () => {
    await enterPlaying(false);
    expect(action("talk.hold")).not.toBeNull();

    fire(action("talk.hold"), "pointerdown");
    act(() => voice.fail("not-allowed: microphone permission was declined"));

    expect(action("talk.hold")).toBeNull();
    expect(text()).toContain("Chiku's ears do not work on this device");
    // Still playable, immediately.
    click(container.querySelector('[data-choice="fingers-3"]'));
    expect(text()).toContain("Wow! Look at you!");
  });

  it("keeps the control when the child simply said nothing", async () => {
    await enterPlaying(false);

    fire(action("talk.hold"), "pointerdown");
    act(() => voice.fail("no-speech: nothing was heard"));
    act(() => voice.end());

    expect(action("talk.hold")).not.toBeNull();
    expect(container.querySelector(".talk-btn.is-listening")).toBeNull();
  });

  it("never leaves a control that does nothing when pressed", async () => {
    voice.state.startThrows = true;
    await enterPlaying(false);

    fire(action("talk.hold"), "pointerdown");

    expect(action("talk.hold")).toBeNull();
    expect(text()).toContain("Chiku's ears do not work on this device");
  });
});

describe("cloud ears — the parent's deliberate choice (doc v0.3)", () => {
  // Verified on the real target machine: Chrome 151/macOS answers "unavailable"
  // for on-device speech in EVERY language, so without this path the mic is
  // simply dead. The show may never choose cloud on its own; a grown-up may.
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("with no local speech and no consent: no talk button, honest note instead", async () => {
    voice.state.onDevice = false;
    await enterPlaying(true);
    await flush();
    expect(container.querySelector(".talk-btn")).toBeNull();
    expect(text()).toContain("Chiku's ears do not work on this device");
    // And nothing asked the listener for cloud recognition.
    expect(voice.state.listenerOpts.every((o) => o.allowCloudRecognition !== true)).toBe(true);
  });

  // MOVED (phase 2, audit finding 11). The consent block used to live on the
  // camera-ask screen — the screen the child is on alone, every session —
  // behind a 2s hold. It is now behind the corner control and a 5s hold, on a
  // grown-up sheet. These tests follow it there; the WORDS are unchanged, and
  // that is checked, because the honesty of the wording was never the problem.
  it("is NOT on the camera-ask screen, even with local speech missing", async () => {
    voice.state.onDevice = false;
    mount();
    click(action("welcome.begin"));
    await flush();
    expect(container.querySelector(".cloud-ears")).toBeNull();
    expect(text()).not.toContain("internet ears");
  });

  it("holding the sheet toggle rebuilds the listener with cloud accepted and shows the talk button", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    try {
      voice.state.onDevice = false;
      mount();
      await act(async () => {
        await Promise.resolve();
      });

      openGrownUpSheet();
      const hold = cloudHold();
      expect(hold).not.toBeNull();
      expect(text()).toContain("internet ears");

      act(() => {
        hold!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      });
      // Two seconds — what used to be the whole gate — must NOT be enough.
      await act(async () => {
        vi.advanceTimersByTime(2100);
      });
      expect(window.localStorage.getItem("chiku.live.cloudEars.v1")).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(3100);
      });

      // Persisted for next launch, and the listener was rebuilt with the flag.
      expect(window.localStorage.getItem("chiku.live.cloudEars.v1")).toBe("true");
      expect(voice.state.listenerOpts.at(-1)?.allowCloudRecognition).toBe(true);

      click(action("grownup.close"));
      click(action("welcome.begin"));

      // The child surface now offers the mic — with the honesty tag.
      const allow = action("camera.allow");
      await act(async () => {
        allow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        vi.advanceTimersByTime(50);
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(container.querySelector(".talk-btn")).not.toBeNull();
      expect(text()).toContain("Chiku's ears use the internet");
    } finally {
      vi.useRealTimers();
    }
  });

  it("releasing the hold early does NOT flip the choice", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    try {
      voice.state.onDevice = false;
      mount();
      await act(async () => {
        await Promise.resolve();
      });
      openGrownUpSheet();
      const hold = cloudHold();
      expect(hold).not.toBeNull();
      act(() => {
        hold!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      });
      await act(async () => {
        vi.advanceTimersByTime(2400); // less than half the hold
      });
      act(() => {
        hold!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      });
      await act(async () => {
        vi.advanceTimersByTime(6000);
      });
      expect(window.localStorage.getItem("chiku.live.cloudEars.v1")).toBeNull();
      expect(voice.state.listenerOpts.at(-1)?.allowCloudRecognition).not.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
