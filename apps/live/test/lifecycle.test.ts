/**
 * THE REALITY LAYER: what happens when the device stops cooperating.
 *
 * Every failure in here is one that a unit test is the only honest way to
 * reach. A camera cannot be unplugged from a test run, a laptop cannot be
 * slept, and no CI machine has a Telugu voice — so each of those is injected
 * through the seams the engine and the speaker already expose, and driven event
 * by event. No MediaPipe, no getUserMedia, no DOM: node environment on purpose.
 *
 * What is being defended, in one line each:
 *
 *   * A camera that dies must CHANGE THE STATUS. Before this, a slept device or
 *     a stolen camera froze the tick loop in perfect silence while the surface
 *     went on telling a child "Chiku sees you". The app lied.
 *   * A hidden tab must turn the camera light OFF. "It is only on while Chiku
 *     is looking" is a promise to a parent, and rAF stopping is not that.
 *   * Chiku must NEVER read Telugu with an English voice. On most non-Mac
 *     devices there is no te voice at all, and the result is letter-by-letter
 *     noise in the child's first language on every single prompt.
 *   * A long line must not be cut off after five seconds on Android, where the
 *     `boundary` event that watchdog assumed simply never fires.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAMERA_ENDED_DETAIL,
  CAMERA_FROZEN_DETAIL,
  CAMERA_GONE_DETAIL,
  CAMERA_MUTED_DETAIL,
  createVisionEngine,
  FROZEN_MIN_MS,
  MUTE_GRACE_MS,
  type CameraDevices,
  type PageLifecycle,
  type VisionEngineOptions,
  type VisionTasks,
} from "../src/vision/engine";
import type { VisionFrame, VisionStatus } from "../src/vision/types";
import {
  createSpeaker,
  DEFAULT_RATE,
  DEFAULT_STALL_MS,
  estimateSpeechMs,
  type SynthLine,
  type SynthPort,
  type SynthVoiceLike,
} from "../src/voice/speaker";
import { createListener, type RecognitionErrorLike, type RecognitionEventLike, type RecognitionLike } from "../src/voice/listener";

/* -------------------------------------------------------------------------- */
/* Fake camera plumbing                                                       */
/* -------------------------------------------------------------------------- */

type TrackEvent = "ended" | "mute" | "unmute";

/** A MediaStreamTrack that can be ended, muted and unmuted on command. */
class FakeTrack {
  readonly kind = "video";
  readyState: "live" | "ended" = "live";
  muted = false;
  stops = 0;

  readonly #listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, cb: () => void): void {
    const set = this.#listeners.get(type) ?? new Set<() => void>();
    set.add(cb);
    this.#listeners.set(type, set);
  }

  removeEventListener(type: string, cb: () => void): void {
    this.#listeners.get(type)?.delete(cb);
  }

  stop(): void {
    this.stops += 1;
    this.readyState = "ended";
  }

  /** Drive the fake. The platform fires these; nothing in our code does. */
  emit(type: TrackEvent): void {
    if (type === "ended") this.readyState = "ended";
    if (type === "mute") this.muted = true;
    if (type === "unmute") this.muted = false;
    for (const cb of [...(this.#listeners.get(type) ?? [])]) cb();
  }

  /** True once every handler the engine attached has been taken off again. */
  get listenerCount(): number {
    let n = 0;
    for (const set of this.#listeners.values()) n += set.size;
    return n;
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

class FakeCamera implements CameraDevices {
  readonly streams: FakeStream[] = [];
  calls = 0;
  /** When set, getUserMedia hangs until `settle()` — the slow-permission case. */
  deferred = false;
  videoInputs = 1;

  #pending: (() => void) | null = null;
  readonly #listeners = new Set<() => void>();

  async getUserMedia(): Promise<MediaStream> {
    this.calls += 1;
    if (this.deferred) {
      await new Promise<void>((resolve) => {
        this.#pending = resolve;
      });
    }
    const stream = new FakeStream();
    this.streams.push(stream);
    return stream as unknown as MediaStream;
  }

  async enumerateDevices(): Promise<readonly MediaDeviceInfo[]> {
    const list: Array<{ kind: string }> = [{ kind: "audioinput" }];
    for (let i = 0; i < this.videoInputs; i += 1) list.push({ kind: "videoinput" });
    return list as unknown as readonly MediaDeviceInfo[];
  }

  addEventListener(_type: "devicechange", cb: () => void): void {
    this.#listeners.add(cb);
  }

  removeEventListener(_type: "devicechange", cb: () => void): void {
    this.#listeners.delete(cb);
  }

  /** Drive the fake. */
  settle(): void {
    const pending = this.#pending;
    this.#pending = null;
    pending?.();
  }

  fireDeviceChange(): void {
    for (const cb of [...this.#listeners]) cb();
  }

  get lastStream(): FakeStream {
    const stream = this.streams[this.streams.length - 1];
    if (!stream) throw new Error("no stream was ever opened");
    return stream;
  }
}

class FakeLifecycle implements PageLifecycle {
  hidden = false;
  readonly #listeners = new Set<() => void>();

  addEventListener(_type: "visibilitychange", cb: () => void): void {
    this.#listeners.add(cb);
  }

  removeEventListener(_type: "visibilitychange", cb: () => void): void {
    this.#listeners.delete(cb);
  }

  /** Drive the fake: hide or show the page, as the browser would. */
  set(hidden: boolean): void {
    this.hidden = hidden;
    for (const cb of [...this.#listeners]) cb();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

/** A video element with a decoder we control, which is the whole point. */
class FakeVideo {
  readyState = 4;
  videoWidth = 640;
  videoHeight = 480;
  currentTime = 0;
  srcObject: MediaStream | null = null;
  muted = false;
  playsInline = false;
  pauses = 0;

  async play(): Promise<void> {
    return undefined;
  }

  pause(): void {
    this.pauses += 1;
  }
}

/** Models that see nothing. The frame CONTENT is another test file's business. */
function emptyTasks(): VisionTasks {
  return {
    face: {
      detectForVideo: () => ({ faceLandmarks: [], faceBlendshapes: [] }),
      close: () => undefined,
    },
    hands: {
      recognizeForVideo: () => ({ landmarks: [], handedness: [], gestures: [] }),
      close: () => undefined,
    },
  };
}

interface Harness {
  readonly engine: ReturnType<typeof createVisionEngine>;
  readonly camera: FakeCamera;
  readonly lifecycle: FakeLifecycle;
  readonly video: FakeVideo;
  readonly frames: VisionFrame[];
  readonly statuses: Array<{ status: VisionStatus; detail: string | undefined }>;
  readonly lastDetail: () => string | undefined;
  /** Run the loop for `ms` with a decoder that is actually producing frames. */
  readonly run: (ms: number) => void;
}

function harness(opts: Partial<VisionEngineOptions> = {}): Harness {
  const camera = new FakeCamera();
  const lifecycle = new FakeLifecycle();
  const video = new FakeVideo();
  const frames: VisionFrame[] = [];
  const statuses: Array<{ status: VisionStatus; detail: string | undefined }> = [];

  const engine = createVisionEngine({
    targetFps: 60,
    now: () => Date.now(),
    camera,
    lifecycle,
    tasks: async () => emptyTasks(),
    ...opts,
  });
  engine.onFrame((f) => frames.push(f));
  engine.onStatus((status, detail) => statuses.push({ status, detail }));

  return {
    engine,
    camera,
    lifecycle,
    video,
    frames,
    statuses,
    lastDetail: () => statuses[statuses.length - 1]?.detail,
    run: (ms: number): void => {
      const step = 16;
      for (let elapsed = 0; elapsed < ms; elapsed += step) {
        // A real decoder moves `currentTime`; the freeze detector below is
        // entirely about what happens when it stops.
        video.currentTime += step / 1000;
        vi.advanceTimersByTime(step);
      }
    },
  };
}

/** Advance the loop WITHOUT advancing the decoder: the freeze. */
function freeze(ms: number): void {
  const step = 16;
  for (let elapsed = 0; elapsed < ms; elapsed += step) vi.advanceTimersByTime(step);
}

async function startEngine(h: Harness): Promise<void> {
  await h.engine.start(h.video as unknown as HTMLVideoElement);
}

/* -------------------------------------------------------------------------- */

beforeEach(() => {
  // The engine schedules on requestAnimationFrame when it exists and on
  // setTimeout(16) otherwise. There is no rAF in this environment, so every
  // tick is a fake timer and the loop is exactly reproducible — but assert it
  // rather than hope, because a polyfilled rAF would silently stop the clock.
  const scope = globalThis as { requestAnimationFrame?: unknown };
  if (typeof scope.requestAnimationFrame === "function") {
    throw new Error("this suite needs the setTimeout scheduling path");
  }
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* The camera dies                                                            */
/* -------------------------------------------------------------------------- */

describe("vision engine: a camera that dies mid-session", () => {
  it("starts, sees frames, and says ready", async () => {
    const h = harness();
    await startEngine(h);

    expect(h.engine.status).toBe("ready");
    h.run(200);
    expect(h.frames.length).toBeGreaterThan(0);

    h.engine.dispose();
  });

  it("reports unavailable when the track ends", async () => {
    const h = harness();
    await startEngine(h);
    h.run(100);
    const before = h.frames.length;

    // The device slept, or another app took the camera, and the platform was
    // decent enough to say so.
    h.camera.lastStream.track.emit("ended");

    expect(h.engine.status).toBe("unavailable");
    expect(h.lastDetail()).toBe(CAMERA_ENDED_DETAIL);
    // …and the loop is actually stopped, not merely relabelled.
    h.run(300);
    expect(h.frames).toHaveLength(before);
    // The element is handed back too, so nothing holds a dead stream.
    expect(h.video.srcObject).toBeNull();

    h.engine.dispose();
  });

  it("gives a muted track a grace period, then calls it lost", async () => {
    const h = harness();
    await startEngine(h);
    h.run(100);

    h.camera.lastStream.track.emit("mute");
    // Not immediately: switching apps mutes and unmutes within a frame or two,
    // and tearing the session down for that would be its own bug.
    vi.advanceTimersByTime(MUTE_GRACE_MS - 1);
    expect(h.engine.status).toBe("ready");

    vi.advanceTimersByTime(2);
    expect(h.engine.status).toBe("unavailable");
    // A distinct detail, because "muted" and "ended" are different accidents
    // and a grown-up reading the note deserves the true one.
    expect(h.lastDetail()).toBe(CAMERA_MUTED_DETAIL);
    expect(h.lastDetail()).not.toBe(CAMERA_ENDED_DETAIL);

    h.engine.dispose();
  });

  it("survives a transient mute that unmutes in time", async () => {
    const h = harness();
    await startEngine(h);
    h.run(100);

    // A muted track delivers no pictures, so the freeze counter is running too
    // — this is the case where the two detectors have to agree not to fire.
    h.camera.lastStream.track.emit("mute");
    freeze(MUTE_GRACE_MS - 500);
    h.camera.lastStream.track.emit("unmute");
    h.run(MUTE_GRACE_MS * 2);

    expect(h.engine.status).toBe("ready");
    const before = h.frames.length;
    h.run(200);
    expect(h.frames.length).toBeGreaterThan(before);

    h.engine.dispose();
  });

  it("declares the camera lost when the video timestamp freezes and no event fires", async () => {
    // THE ONE WITH NO EVENT AT ALL. This is the observed failure: the device
    // sleeps and wakes, currentTime never moves again, the tick loop returns
    // early forever, and nothing anywhere notices.
    const h = harness();
    await startEngine(h);
    h.run(200);
    const before = h.frames.length;
    expect(before).toBeGreaterThan(0);

    // A short freeze is ordinary — a slow camera under a fast loop does it all
    // the time — and must not cost the child their camera.
    freeze(FROZEN_MIN_MS / 2);
    expect(h.engine.status).toBe("ready");

    freeze(FROZEN_MIN_MS);
    expect(h.engine.status).toBe("unavailable");
    expect(h.lastDetail()).toBe(CAMERA_FROZEN_DETAIL);
    expect(h.frames).toHaveLength(before);
    expect(h.camera.lastStream.track.stops).toBe(1);

    h.engine.dispose();
  });

  it("notices an unplugged camera on devicechange", async () => {
    const h = harness();
    await startEngine(h);
    h.run(100);

    // A USB webcam pulled out of the socket: on several platforms the track is
    // ended without ever dispatching `ended` on it.
    h.camera.lastStream.track.readyState = "ended";
    h.camera.fireDeviceChange();

    expect(h.engine.status).toBe("unavailable");
    expect(h.lastDetail()).toBe(CAMERA_GONE_DETAIL);

    h.engine.dispose();
  });

  it("notices a camera that vanished from the device list", async () => {
    const h = harness();
    await startEngine(h);
    h.run(100);

    h.camera.videoInputs = 0;
    h.camera.fireDeviceChange();
    await vi.advanceTimersByTimeAsync(1);

    expect(h.engine.status).toBe("unavailable");
    expect(h.lastDetail()).toBe(CAMERA_GONE_DETAIL);

    h.engine.dispose();
  });

  it("ignores devicechange while the camera is still working", async () => {
    const h = harness();
    await startEngine(h);
    h.run(100);

    h.camera.fireDeviceChange();
    await vi.advanceTimersByTimeAsync(1);

    expect(h.engine.status).toBe("ready");
    const before = h.frames.length;
    h.run(200);
    expect(h.frames.length).toBeGreaterThan(before);

    h.engine.dispose();
  });

  it("does not re-open a camera that died, even on resume", async () => {
    const h = harness();
    await startEngine(h);
    h.camera.lastStream.track.emit("ended");
    expect(h.camera.calls).toBe(1);

    h.lifecycle.set(true);
    h.lifecycle.set(false);
    await vi.advanceTimersByTimeAsync(1);

    // The surface has already been told the camera is unavailable and is
    // showing the tap path; silently reopening behind it would be a lie.
    expect(h.camera.calls).toBe(1);
    expect(h.engine.status).toBe("unavailable");

    h.engine.dispose();
  });

  it("reports unavailable when the browser has no camera API", async () => {
    const h = harness({ camera: null });
    await startEngine(h);
    expect(h.engine.status).toBe("unavailable");
    expect(h.lastDetail()).toBe("this browser has no camera API");
    h.engine.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* The page is hidden                                                         */
/* -------------------------------------------------------------------------- */

describe("vision engine: the page goes away", () => {
  it("stops inference AND the camera when the tab is hidden", async () => {
    const h = harness();
    await startEngine(h);
    h.run(200);
    const before = h.frames.length;
    expect(before).toBeGreaterThan(0);

    h.lifecycle.set(true);

    expect(h.engine.suspended).toBe(true);
    // The light is off. This is the point: rAF stopping on its own leaves the
    // camera running, which breaks the promise the camera screen makes.
    expect(h.camera.lastStream.track.stops).toBe(1);
    expect(h.video.srcObject).toBeNull();
    expect(h.engine.status).toBe("idle");
    // Not one of the sticky failure statuses — nothing has gone wrong.
    expect(h.engine.status).not.toBe("unavailable");

    h.run(400);
    expect(h.frames).toHaveLength(before);

    h.engine.dispose();
  });

  it("re-acquires and runs again when the tab comes back", async () => {
    const h = harness();
    await startEngine(h);
    h.run(100);

    h.lifecycle.set(true);
    const paused = h.frames.length;

    h.lifecycle.set(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(h.engine.suspended).toBe(false);
    expect(h.engine.status).toBe("ready");
    expect(h.camera.calls).toBe(2);
    expect(h.camera.streams).toHaveLength(2);
    h.run(200);
    expect(h.frames.length).toBeGreaterThan(paused);

    h.engine.dispose();
  });

  it("is idempotent: repeated hide/show never doubles the camera", async () => {
    const h = harness();
    await startEngine(h);

    h.lifecycle.set(true);
    h.engine.suspend();
    h.engine.suspend();
    expect(h.camera.lastStream.track.stops).toBe(1);

    h.lifecycle.set(false);
    h.engine.resume();
    await vi.advanceTimersByTimeAsync(1);
    h.engine.resume();
    await vi.advanceTimersByTimeAsync(1);

    expect(h.camera.calls).toBe(2);
    expect(h.engine.status).toBe("ready");
    // One live stream, one stopped: no orphan holding the camera open.
    expect(h.camera.streams.filter((s) => s.track.readyState === "live")).toHaveLength(1);

    h.engine.dispose();
  });

  it("leaks nothing when the page hides mid-start", async () => {
    const h = harness();
    h.camera.deferred = true;

    const started = startEngine(h);
    h.lifecycle.set(true); // hidden while the permission dialog is still up
    h.camera.settle();
    await started;
    await vi.advanceTimersByTimeAsync(1);

    // The stream arrived after we had already decided to stand down. It must
    // be stopped, not left running with nobody holding it.
    expect(h.camera.streams).toHaveLength(1);
    expect(h.camera.lastStream.track.stops).toBe(1);
    expect(h.engine.status).not.toBe("ready");
    h.run(200);
    expect(h.frames).toHaveLength(0);

    // …and coming back still works (the second grant is instant — the first
    // one is still live, so there is no second permission prompt).
    h.camera.deferred = false;
    h.lifecycle.set(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.engine.status).toBe("ready");
    h.run(200);
    expect(h.frames.length).toBeGreaterThan(0);

    h.engine.dispose();
  });

  it("does not resume a camera the surface stopped on purpose", async () => {
    const h = harness();
    await startEngine(h);
    h.engine.stop();
    expect(h.camera.calls).toBe(1);

    h.lifecycle.set(true);
    h.lifecycle.set(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(h.camera.calls).toBe(1);
    expect(h.engine.status).toBe("idle");

    h.engine.dispose();
  });

  it("unsubscribes from the page and the tracks on dispose", async () => {
    const h = harness();
    await startEngine(h);
    const track = h.camera.lastStream.track;
    expect(track.listenerCount).toBeGreaterThan(0);

    h.engine.dispose();

    expect(track.listenerCount).toBe(0);
    expect(track.stops).toBe(1);
    expect(h.lifecycle.listenerCount).toBe(0);
    // A hide after disposal must not resurrect anything.
    h.lifecycle.set(true);
    h.lifecycle.set(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.camera.calls).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Speaker: no voice is not "some other voice"                                */
/* -------------------------------------------------------------------------- */

const GEETA: SynthVoiceLike = { name: "Geeta", lang: "te-IN" };
const RISHI: SynthVoiceLike = { name: "Rishi", lang: "en-IN" };
const SAMANTHA: SynthVoiceLike = { name: "Samantha", lang: "en-US" };

class FakeSynth implements SynthPort {
  voices: SynthVoiceLike[] = [];
  readonly spoken: SynthLine[] = [];
  cancels = 0;

  #live: SynthLine | null = null;
  readonly #voicesListeners = new Set<() => void>();

  getVoices(): readonly SynthVoiceLike[] {
    return this.voices;
  }

  onVoicesChanged(cb: () => void): () => void {
    this.#voicesListeners.add(cb);
    return () => {
      this.#voicesListeners.delete(cb);
    };
  }

  speak(line: SynthLine): void {
    this.spoken.push(line);
    this.#live = line;
  }

  cancel(): void {
    this.cancels += 1;
    const live = this.#live;
    this.#live = null;
    live?.onError("interrupted");
  }

  /* Driving the fake ---------------------------------------------------- */

  loadVoices(voices: SynthVoiceLike[]): void {
    this.voices = voices;
    for (const cb of [...this.#voicesListeners]) cb();
  }

  fireStart(): void {
    this.#liveLine().onStart();
  }

  fireBoundary(): void {
    this.#liveLine().onBoundary();
  }

  fireEnd(): void {
    const line = this.#liveLine();
    this.#live = null;
    line.onEnd();
  }

  #liveLine(): SynthLine {
    const line = this.#live;
    if (!line) throw new Error("no utterance in flight");
    return line;
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function watch(done: Promise<void>): () => boolean {
  let settled = false;
  void done.then(() => {
    settled = true;
  });
  return () => settled;
}

describe("speaker: knowing what this device can and cannot say", () => {
  it("does not claim a voice before the platform has produced its list", () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });

    // Empty list = "not loaded yet", which is not the same as "no voice" — but
    // there is genuinely nothing to speak with yet either, so: no.
    expect(speaker.voicesReady).toBe(false);
    expect(speaker.hasVoice("te")).toBe(false);
    expect(speaker.hasVoice("en")).toBe(false);
    expect(speaker.voiceFor("te")).toBeNull();

    speaker.dispose();
  });

  it("answers correctly once voiceschanged has fired", () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });
    const changes: number[] = [];
    speaker.onVoicesChanged(() => changes.push(1));

    synth.loadVoices([SAMANTHA, RISHI, GEETA]);

    expect(changes).toHaveLength(1);
    expect(speaker.voicesReady).toBe(true);
    expect(speaker.hasVoice("te")).toBe(true);
    expect(speaker.hasVoice("en")).toBe(true);
    expect(speaker.voiceFor("te")).toBe(GEETA);
    expect(speaker.voiceFor("en")).toBe(RISHI);

    // …and a device with no Telugu at all — which is most of them — says so.
    synth.loadVoices([SAMANTHA]);
    expect(speaker.voicesReady).toBe(true);
    expect(speaker.hasVoice("te")).toBe(false);
    expect(speaker.hasVoice("en")).toBe(true);
    expect(speaker.voiceFor("te")).toBeNull();

    speaker.dispose();
  });

  it("REFUSES to read Telugu with an English voice", async () => {
    const synth = new FakeSynth();
    synth.voices = [SAMANTHA, RISHI];
    const speaker = createSpeaker({ synth });
    const mouth: number[] = [];

    const handle = speaker.speak("మూడు వేళ్ళు చూపించు", "te", (v) => mouth.push(v));

    // Nothing was handed to the platform. An en-US voice reading Telugu is not
    // accented Telugu, it is noise — and it is the child's first language.
    expect(synth.spoken).toHaveLength(0);
    expect(handle.outcome).toBe("no-voice");
    // The caller still gets a handle that resolves and a shut mouth, so a
    // surface awaiting lines in sequence does not deadlock.
    await expect(handle.done).resolves.toBeUndefined();
    expect(mouth).toEqual([0]);
    expect(speaker.speaking).toBe(false);

    // The same device speaks English perfectly well, and must go on doing so.
    const english = speaker.speak("Show me three fingers", "en");
    expect(english.outcome).toBe("spoken");
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0]?.voice).toBe(RISHI);

    speaker.dispose();
  });

  it("still speaks when the voice list has not loaded, and stops once it has", async () => {
    // The regression this guards: some engines (older Android WebView) report
    // an empty voice list forever and speak the OS locale correctly anyway.
    // Refusing on an unresolved list would mute those devices completely.
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });

    const blind = speaker.speak("హాయ్", "te");
    expect(blind.outcome).toBe("spoken");
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0]?.voice).toBeNull();

    synth.loadVoices([SAMANTHA]);
    const informed = speaker.speak("హాయ్", "te");
    expect(informed.outcome).toBe("no-voice");
    expect(synth.spoken).toHaveLength(1);
    await expect(informed.done).resolves.toBeUndefined();

    speaker.dispose();
  });

  it("speaks a regional variant rather than refusing", () => {
    const synth = new FakeSynth();
    synth.voices = [{ name: "Telugu", lang: "te" }, SAMANTHA];
    const speaker = createSpeaker({ synth });

    // te (no region) is the same language; en-US for Indian English likewise.
    expect(speaker.hasVoice("te")).toBe(true);
    expect(speaker.speak("హాయ్", "te").outcome).toBe("spoken");
    expect(speaker.speak("hello", "en").outcome).toBe("spoken");

    speaker.dispose();
  });

  it("reports 'unavailable' rather than 'no-voice' when there is no synthesis", async () => {
    const speaker = createSpeaker({ synth: null });
    const handle = speaker.speak("hello", "en");
    expect(handle.outcome).toBe("unavailable");
    expect(speaker.hasVoice("en")).toBe(false);
    expect(speaker.voicesReady).toBe(false);
    await expect(handle.done).resolves.toBeUndefined();
    speaker.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* Speaker: the watchdog that cut Android off mid-sentence                    */
/* -------------------------------------------------------------------------- */

describe("speaker: the stall watchdog is boundary-aware", () => {
  const LONG = "Chiku wants to see three fingers, and then a wave, and then a big smile. ".repeat(9);

  it("estimates from length and rate", () => {
    expect(estimateSpeechMs("", DEFAULT_RATE)).toBe(0);
    const short = estimateSpeechMs("hello", DEFAULT_RATE);
    const long = estimateSpeechMs(LONG, DEFAULT_RATE);
    expect(long).toBeGreaterThan(short);
    // Slower speech takes longer; faster takes less. Both monotonic.
    expect(estimateSpeechMs(LONG, 0.5)).toBeGreaterThan(long);
    expect(estimateSpeechMs(LONG, 2)).toBeLessThan(long);
    // And nothing waits forever, whatever the arithmetic says.
    expect(estimateSpeechMs("x".repeat(1_000_000), DEFAULT_RATE)).toBeLessThanOrEqual(120_000);
  });

  it("gives a boundary-less platform the length of its line, not five seconds", async () => {
    // Chrome on Android fires `end` but never `boundary`. The flat 5s watchdog
    // therefore cut EVERY long line off mid-sentence on the exact devices this
    // show is most likely to run on.
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });
    const estimate = estimateSpeechMs(LONG, DEFAULT_RATE);
    expect(estimate).toBeGreaterThan(DEFAULT_STALL_MS * 4);

    const handle = speaker.speak(LONG, "en");
    const settled = watch(handle.done);
    synth.fireStart();

    vi.advanceTimersByTime(DEFAULT_STALL_MS + 1);
    await flush();
    expect(settled()).toBe(false); // the old code hung up here

    vi.advanceTimersByTime(estimate);
    await flush();
    expect(settled()).toBe(true);

    speaker.dispose();
  });

  it("falls back to the short window as soon as one boundary is seen", async () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });

    const handle = speaker.speak(LONG, "en");
    const settled = watch(handle.done);
    synth.fireStart();
    // One boundary is all it takes: this platform reports progress, so silence
    // from it really does mean the synthesiser has died.
    vi.advanceTimersByTime(100);
    synth.fireBoundary();

    vi.advanceTimersByTime(DEFAULT_STALL_MS - 1);
    await flush();
    expect(settled()).toBe(false);

    vi.advanceTimersByTime(2);
    await flush();
    expect(settled()).toBe(true);
    expect(synth.cancels).toBeGreaterThanOrEqual(1);

    speaker.dispose();
  });

  it("still hangs up fast on a line the platform never starts", async () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth, stallMs: 1000 });

    const handle = speaker.speak(LONG, "en");
    const settled = watch(handle.done);
    // No `start`: the utterance was queued and forgotten. Nothing is in flight
    // to be long, so the estimate must not delay the caller.
    vi.advanceTimersByTime(1001);
    await flush();
    expect(settled()).toBe(true);

    speaker.dispose();
  });

  it("lets a healthy boundary-less line finish normally", async () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });

    const handle = speaker.speak(LONG, "en");
    const settled = watch(handle.done);
    synth.fireStart();
    vi.advanceTimersByTime(6000);
    synth.fireEnd();
    await flush();

    expect(settled()).toBe(true);
    expect(speaker.speaking).toBe(false);

    speaker.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* Listener: the microphone does not survive the page being hidden            */
/* -------------------------------------------------------------------------- */

class FakeRecognition implements RecognitionLike {
  lang = "";
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  processLocally?: boolean;

  onstart: (() => void) | null = null;
  onresult: ((event: RecognitionEventLike) => void) | null = null;
  onerror: ((event: RecognitionErrorLike) => void) | null = null;
  onend: (() => void) | null = null;

  starts = 0;
  stops = 0;
  aborts = 0;

  start(): void {
    this.starts += 1;
  }

  stop(): void {
    this.stops += 1;
  }

  abort(): void {
    this.aborts += 1;
  }
}

describe("listener: a hidden page closes the microphone", () => {
  it("aborts an open mic and reports the turn ended", () => {
    const lifecycle = new FakeLifecycle();
    const made: FakeRecognition[] = [];
    const listener = createListener({
      recognition: () => {
        const rec = new FakeRecognition();
        made.push(rec);
        return rec;
      },
      lifecycle,
    });
    const ends: number[] = [];
    listener.onEnd(() => ends.push(1));

    listener.start("en");
    expect(listener.listening).toBe(true);

    // The child's hand is still on the button; the tab is not. A pointerup may
    // never arrive, and an open mic in a bedroom is not something to leave to
    // an event that may not fire.
    lifecycle.set(true);

    expect(made[0]?.aborts).toBe(1);
    expect(listener.listening).toBe(false);
    expect(ends).toHaveLength(1);

    // Coming back is a fresh turn, not a resumed one.
    lifecycle.set(false);
    expect(listener.listening).toBe(false);
    listener.start("en");
    expect(made).toHaveLength(2);
    expect(listener.listening).toBe(true);

    listener.dispose();
  });

  it("does nothing when the page hides with the mic already shut", () => {
    const lifecycle = new FakeLifecycle();
    const listener = createListener({ recognition: null, lifecycle });
    const ends: number[] = [];
    listener.onEnd(() => ends.push(1));

    expect(() => lifecycle.set(true)).not.toThrow();
    expect(ends).toHaveLength(0);

    listener.dispose();
    expect(lifecycle.listenerCount).toBe(0);
  });
});
