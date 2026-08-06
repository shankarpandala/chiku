/**
 * Voice layer — speaker and listener.
 *
 * Node environment on purpose. happy-dom has neither `speechSynthesis` nor
 * `SpeechRecognition`, so a DOM here would buy nothing; instead both modules
 * take their platform through an options seam and these tests inject small
 * fakes that can be driven event by event. That is also the only way to
 * reproduce the three real-world bugs the speaker exists to survive — an empty
 * first `getVoices()`, a mid-line stall with no `end`, and a cancel whose
 * `end` arrives after the replacement line started.
 *
 * Timers are faked (including Date, which the mouth ticker reads) so the 60fps
 * ticker and the 5s watchdog run in microseconds and deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSpeaker,
  DEFAULT_STALL_MS,
  MOUTH_TICK_MS,
  pickVoice,
  SPEAK_LANG_TAG,
  type SynthLine,
  type SynthPort,
  type SynthVoiceLike,
} from "../src/voice/speaker";
import {
  createListener,
  isMicUnusable,
  LISTEN_LANG_TAG,
  type RecognitionErrorLike,
  type RecognitionEventLike,
  type RecognitionLike,
} from "../src/voice/listener";
import { BOUNDARY_DIP_MS, JAW_MAX, JAW_MIN, jawAt } from "../src/voice/mouth";
import type { HeardResult } from "../src/voice/types";

/* -------------------------------------------------------------------------- */
/* Fake speech synthesis                                                      */
/* -------------------------------------------------------------------------- */

const GEETA: SynthVoiceLike = { name: "Geeta", lang: "te-IN" };
const RISHI: SynthVoiceLike = { name: "Rishi", lang: "en-IN" };
const DANIEL: SynthVoiceLike = { name: "Daniel", lang: "en-GB" };
const TELUGU_GENERIC: SynthVoiceLike = { name: "Telugu", lang: "te" };

class FakeSynth implements SynthPort {
  voices: SynthVoiceLike[] = [];
  readonly spoken: SynthLine[] = [];
  cancels = 0;
  getVoicesCalls = 0;

  #live: SynthLine | null = null;
  #voicesListeners = new Set<() => void>();

  getVoices(): readonly SynthVoiceLike[] {
    this.getVoicesCalls += 1;
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
    // The real API reports the kill on the utterance it killed, which is the
    // late event a barge-in has to tolerate.
    live?.onError("interrupted");
  }

  /* Driving the fake ---------------------------------------------------- */

  get live(): SynthLine {
    const line = this.#live;
    if (!line) throw new Error("no utterance in flight");
    return line;
  }

  /** The voice list arriving late, exactly as the platform does it. */
  loadVoices(voices: SynthVoiceLike[]): void {
    this.voices = voices;
    for (const cb of [...this.#voicesListeners]) cb();
  }

  fireStart(): void {
    this.live.onStart();
  }

  fireBoundary(): void {
    this.live.onBoundary();
  }

  fireEnd(): void {
    const line = this.live;
    this.#live = null;
    line.onEnd();
  }

  fireError(message: string): void {
    const line = this.live;
    this.#live = null;
    line.onError(message);
  }
}

/** Resolve pending microtasks without letting the fake clock move. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** True once `done` has resolved, without ever awaiting it unguarded. */
function watch(done: Promise<void>): () => boolean {
  let settled = false;
  void done.then(() => {
    settled = true;
  });
  return () => settled;
}

/* -------------------------------------------------------------------------- */
/* Fake speech recognition                                                    */
/* -------------------------------------------------------------------------- */

class FakeRecognition implements RecognitionLike {
  lang = "";
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  /** Chrome 139+ only; left undefined until the listener demands local speech. */
  processLocally?: boolean;

  onstart: (() => void) | null = null;
  onresult: ((event: RecognitionEventLike) => void) | null = null;
  onerror: ((event: RecognitionErrorLike) => void) | null = null;
  onend: (() => void) | null = null;

  starts = 0;
  stops = 0;
  aborts = 0;
  /** Set to make start() throw, as Chrome does on a double start. */
  throwOnStart: Error | null = null;

  start(): void {
    this.starts += 1;
    if (this.throwOnStart) throw this.throwOnStart;
  }

  stop(): void {
    this.stops += 1;
  }

  abort(): void {
    this.aborts += 1;
  }

  /* Driving the fake ---------------------------------------------------- */

  emitResult(transcript: string, isFinal: boolean, confidence = 0.8): void {
    this.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        0: { isFinal, length: 1, 0: { transcript, confidence } },
      },
    });
  }

  emitError(error: string): void {
    this.onerror?.({ error });
  }

  emitEnd(): void {
    this.onend?.();
  }
}

/** Records every recogniser the listener constructs. */
function recognitionFactory(): { made: FakeRecognition[]; make: () => RecognitionLike } {
  const made: FakeRecognition[] = [];
  return {
    made,
    make: () => {
      const rec = new FakeRecognition();
      made.push(rec);
      return rec;
    },
  };
}

function last<T>(items: readonly T[]): T {
  const item = items[items.length - 1];
  if (item === undefined) throw new Error("expected at least one item");
  return item;
}

/* -------------------------------------------------------------------------- */

beforeEach(() => {
  // Date is faked too: the mouth ticker and the stall watchdog both read it.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* Voice resolution                                                           */
/* -------------------------------------------------------------------------- */

describe("voice resolution", () => {
  it("prefers the exact regional tag for each language", () => {
    const voices = [DANIEL, RISHI, GEETA];
    expect(pickVoice(voices, "te")).toBe(GEETA);
    expect(pickVoice(voices, "en")).toBe(RISHI);
  });

  it("falls back to a language prefix when the region is missing", () => {
    const voices = [DANIEL, TELUGU_GENERIC];
    expect(pickVoice(voices, "te")).toBe(TELUGU_GENERIC);
    expect(pickVoice(voices, "en")).toBe(DANIEL);
  });

  it("normalises underscored and upper-cased tags", () => {
    const odd: SynthVoiceLike = { name: "Odd", lang: "TE_in" };
    expect(pickVoice([odd], "te")).toBe(odd);
  });

  it("falls back to the platform default when nothing matches", () => {
    expect(pickVoice([DANIEL], "te")).toBeNull();
    expect(pickVoice([], "en")).toBeNull();
  });

  it("uses the exact tag as the utterance lang", () => {
    const synth = new FakeSynth();
    synth.voices = [GEETA, RISHI];
    const speaker = createSpeaker({ synth });

    speaker.speak("హాయ్", "te");
    expect(last(synth.spoken).lang).toBe(SPEAK_LANG_TAG.te);
    expect(last(synth.spoken).voice).toBe(GEETA);

    speaker.speak("hello", "en");
    expect(last(synth.spoken).lang).toBe(SPEAK_LANG_TAG.en);
    expect(last(synth.spoken).voice).toBe(RISHI);

    speaker.dispose();
  });

  it("survives getVoices() being empty first and populating on voiceschanged", () => {
    const synth = new FakeSynth();
    // Bug 1: the list is genuinely empty on the first call in every browser.
    const speaker = createSpeaker({ synth });

    speaker.speak("hello", "en");
    // No voice, but the line still goes out — the platform picks its default.
    expect(last(synth.spoken).voice).toBeNull();
    expect(synth.spoken).toHaveLength(1);

    synth.loadVoices([DANIEL, RISHI, GEETA]);

    speaker.speak("hello again", "en");
    expect(last(synth.spoken).voice).toBe(RISHI);
    speaker.speak("హాయ్", "te");
    expect(last(synth.spoken).voice).toBe(GEETA);

    speaker.dispose();
  });

  it("caches per language and re-resolves when the voice list changes", () => {
    const synth = new FakeSynth();
    synth.voices = [DANIEL, RISHI, GEETA];
    const speaker = createSpeaker({ synth });

    speaker.speak("one", "en");
    speaker.speak("two", "en");
    speaker.speak("three", "en");
    expect(synth.getVoicesCalls).toBe(1);

    // A language pack finishing installation must not be ignored.
    synth.loadVoices([DANIEL, GEETA]);
    speaker.speak("four", "en");
    expect(synth.getVoicesCalls).toBe(2);
    expect(last(synth.spoken).voice).toBe(DANIEL);

    speaker.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* Speaking lifecycle                                                         */
/* -------------------------------------------------------------------------- */

describe("speaker lifecycle", () => {
  it("resolves done on end", async () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });

    const handle = speaker.speak("hello", "en");
    const settled = watch(handle.done);
    synth.fireStart();
    expect(speaker.speaking).toBe(true);
    expect(settled()).toBe(false);

    synth.fireEnd();
    await flush();
    expect(settled()).toBe(true);
    expect(speaker.speaking).toBe(false);

    speaker.dispose();
  });

  it("resolves done on error rather than rejecting", async () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });

    const handle = speaker.speak("hello", "en");
    const rejected = vi.fn();
    handle.done.catch(rejected);
    synth.fireStart();
    synth.fireError("synthesis-failed");
    await flush();

    await expect(handle.done).resolves.toBeUndefined();
    expect(rejected).not.toHaveBeenCalled();
    expect(speaker.speaking).toBe(false);

    speaker.dispose();
  });

  it("resolves done on cancel, and cancelling twice is safe", async () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });

    const handle = speaker.speak("hello", "en");
    synth.fireStart();
    handle.cancel();
    handle.cancel();
    await flush();

    await expect(handle.done).resolves.toBeUndefined();
    expect(speaker.speaking).toBe(false);

    speaker.dispose();
  });

  it("cancels the previous line when a new one starts (barge-in)", async () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });

    const first = speaker.speak("a long authored line", "en");
    const firstSettled = watch(first.done);
    synth.fireStart();
    expect(firstSettled()).toBe(false);

    const second = speaker.speak("the child interrupted", "en");
    await flush();

    expect(firstSettled()).toBe(true);
    expect(synth.cancels).toBeGreaterThanOrEqual(1);
    expect(synth.spoken).toHaveLength(2);
    expect(speaker.speaking).toBe(true);

    // The killed line's late end must not settle the replacement.
    const secondSettled = watch(second.done);
    await flush();
    expect(secondSettled()).toBe(false);

    synth.fireEnd();
    await flush();
    expect(secondSettled()).toBe(true);

    speaker.dispose();
  });

  it("resolves immediately when there is no synthesis at all", async () => {
    const speaker = createSpeaker({ synth: null });
    expect(speaker.available).toBe(false);

    const mouth: number[] = [];
    const handle = speaker.speak("hello", "en", (v) => mouth.push(v));
    await expect(handle.done).resolves.toBeUndefined();
    expect(speaker.speaking).toBe(false);
    // The mouth must be shut, not left wherever it happened to be.
    expect(mouth).toEqual([0]);
    // And cancel on a dead handle must not throw.
    expect(() => handle.cancel()).not.toThrow();

    speaker.dispose();
  });

  it("resolves immediately for an empty line", async () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });
    await expect(speaker.speak("   ", "en").done).resolves.toBeUndefined();
    expect(synth.spoken).toHaveLength(0);
    speaker.dispose();
  });

  it("resolves when the platform throws out of speak()", async () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });
    const mouth: number[] = [];
    vi.spyOn(synth, "speak").mockImplementation(() => {
      throw new Error("synthesis unavailable");
    });

    const handle = speaker.speak("hello", "en", (v) => mouth.push(v));
    // Immediately, not after the watchdog: there is nothing to wait for.
    await expect(handle.done).resolves.toBeUndefined();
    expect(speaker.speaking).toBe(false);
    expect(last(mouth)).toBe(0);

    speaker.dispose();
  });

  it("cancelAll settles the line in flight", async () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });
    const handle = speaker.speak("hello", "en");
    synth.fireStart();

    speaker.cancelAll();
    await flush();
    await expect(handle.done).resolves.toBeUndefined();
    expect(speaker.speaking).toBe(false);

    speaker.dispose();
  });

  it("dispose settles the line in flight and silences later speaks", async () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });
    const handle = speaker.speak("hello", "en");
    synth.fireStart();

    speaker.dispose();
    await expect(handle.done).resolves.toBeUndefined();

    const after = speaker.speak("ignored", "en");
    await expect(after.done).resolves.toBeUndefined();
    expect(synth.spoken).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Mouth                                                                      */
/* -------------------------------------------------------------------------- */

describe("mouth estimate", () => {
  it("oscillates inside the jaw band and is not a metronome", () => {
    const samples: number[] = [];
    for (let ms = 0; ms < 2000; ms += MOUTH_TICK_MS) samples.push(jawAt(ms, null));

    for (const v of samples) {
      expect(v).toBeGreaterThanOrEqual(JAW_MIN);
      expect(v).toBeLessThanOrEqual(JAW_MAX);
    }
    // A single sine repeats exactly one period later; a two-frequency mix does
    // not. Compare one slow period apart (3.7Hz -> 270.27ms) and demand drift.
    const periodTicks = Math.round(270.27 / MOUTH_TICK_MS);
    let maxDrift = 0;
    for (let i = 0; i + periodTicks < samples.length; i += 1) {
      const a = samples[i];
      const b = samples[i + periodTicks];
      if (a === undefined || b === undefined) continue;
      maxDrift = Math.max(maxDrift, Math.abs(a - b));
    }
    expect(maxDrift).toBeGreaterThan(0.1);
  });

  it("dips to zero at a word boundary and recovers into the band", () => {
    const open = jawAt(500, null);
    // Shut at the boundary instant, then climbing back, then out of the dip
    // entirely and identical to the undipped signal.
    expect(jawAt(500, 0)).toBe(0);
    expect(jawAt(500, BOUNDARY_DIP_MS / 3)).toBeLessThan(jawAt(500, (BOUNDARY_DIP_MS * 2) / 3));
    expect(jawAt(500, (BOUNDARY_DIP_MS * 2) / 3)).toBeLessThan(open);
    expect(jawAt(500, BOUNDARY_DIP_MS)).toBe(open);
    expect(open).toBeGreaterThanOrEqual(JAW_MIN);
    // The dip is the only time the signal is allowed under the band, and it
    // never goes negative.
    for (let d = 0; d <= BOUNDARY_DIP_MS; d += 3) expect(jawAt(500, d)).toBeGreaterThanOrEqual(0);
  });

  it("emits values in range while speaking and exactly 0 after the line ends", () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });
    const mouth: number[] = [];

    speaker.speak("a whole authored sentence", "en", (v) => mouth.push(v));
    synth.fireStart();
    vi.advanceTimersByTime(500);

    expect(mouth.length).toBeGreaterThan(20);
    for (const v of mouth) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(JAW_MAX);
    }
    // Without a boundary the jaw never drops below the band.
    expect(Math.min(...mouth)).toBeGreaterThanOrEqual(JAW_MIN);
    // And it is actually moving, not pinned.
    expect(Math.max(...mouth) - Math.min(...mouth)).toBeGreaterThan(0.2);

    synth.fireEnd();
    expect(mouth[mouth.length - 1]).toBe(0);

    // The ticker must be dead: no further samples after the line ends.
    const settledCount = mouth.length;
    vi.advanceTimersByTime(500);
    expect(mouth).toHaveLength(settledCount);

    speaker.dispose();
  });

  it("closes the mouth at a word boundary", () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });
    const mouth: number[] = [];

    speaker.speak("two words", "en", (v) => mouth.push(v));
    synth.fireStart();
    vi.advanceTimersByTime(300);
    const beforeBoundary = mouth.length;

    synth.fireBoundary();
    vi.advanceTimersByTime(BOUNDARY_DIP_MS);

    const duringDip = mouth.slice(beforeBoundary);
    // The first sample after the boundary is emitted by the boundary itself,
    // on the word edge, fully shut.
    expect(duringDip[0]).toBe(0);
    expect(Math.min(...duringDip)).toBe(0);
    expect(Math.max(...duringDip)).toBeLessThanOrEqual(JAW_MAX);
    for (const v of duringDip) expect(v).toBeGreaterThanOrEqual(0);
    // ...and it climbs back out of the dip rather than staying shut.
    expect(last(duringDip)).toBeGreaterThanOrEqual(JAW_MIN);

    speaker.cancelAll();
    expect(mouth[mouth.length - 1]).toBe(0);
    speaker.dispose();
  });

  it("emits a final 0 even when the line is cancelled mid-word", () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });
    const mouth: number[] = [];

    const handle = speaker.speak("interrupt me", "en", (v) => mouth.push(v));
    synth.fireStart();
    vi.advanceTimersByTime(120);
    expect(last(mouth)).toBeGreaterThan(0);

    handle.cancel();
    expect(last(mouth)).toBe(0);

    speaker.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* The Chrome stall                                                           */
/* -------------------------------------------------------------------------- */

describe("stall guard", () => {
  it("resolves the handle when the platform goes silent mid-line", async () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth });
    const mouth: number[] = [];

    const handle = speaker.speak("a line Chrome will abandon", "en", (v) => mouth.push(v));
    const settled = watch(handle.done);
    synth.fireStart();

    vi.advanceTimersByTime(DEFAULT_STALL_MS - 1);
    await flush();
    expect(settled()).toBe(false);

    // No end, no error, no boundary — the documented Chrome ~15s failure.
    vi.advanceTimersByTime(2);
    await flush();

    expect(settled()).toBe(true);
    await expect(handle.done).resolves.toBeUndefined();
    expect(speaker.speaking).toBe(false);
    expect(last(mouth)).toBe(0);
    expect(synth.cancels).toBeGreaterThanOrEqual(1);

    speaker.dispose();
  });

  it("keeps a healthy line alive as long as boundaries keep arriving", async () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth, stallMs: 1000 });

    const handle = speaker.speak("a long but healthy line", "en");
    const settled = watch(handle.done);
    synth.fireStart();

    for (let i = 0; i < 6; i += 1) {
      vi.advanceTimersByTime(800);
      synth.fireBoundary();
    }
    await flush();
    expect(settled()).toBe(false);

    synth.fireEnd();
    await flush();
    expect(settled()).toBe(true);

    speaker.dispose();
  });

  it("resolves a line the platform never even starts", async () => {
    const synth = new FakeSynth();
    const speaker = createSpeaker({ synth, stallMs: 1000 });

    const handle = speaker.speak("never spoken", "en");
    const settled = watch(handle.done);
    // No start event at all — the utterance is queued and forgotten.
    vi.advanceTimersByTime(1001);
    await flush();

    expect(settled()).toBe(true);
    speaker.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* Listener                                                                   */
/* -------------------------------------------------------------------------- */

describe("listener", () => {
  it("maps languages to Indian tags and configures a single-shot recogniser", () => {
    const factory = recognitionFactory();
    const listener = createListener({ recognition: factory.make });
    expect(listener.available).toBe(true);

    listener.start("te");
    const teRec = last(factory.made);
    expect(teRec.lang).toBe(LISTEN_LANG_TAG.te);
    expect(teRec.lang).toBe("te-IN");
    expect(teRec.continuous).toBe(false);
    expect(teRec.interimResults).toBe(true);
    expect(teRec.maxAlternatives).toBe(1);
    expect(teRec.starts).toBe(1);

    listener.stop();
    teRec.emitEnd();

    listener.start("en");
    expect(last(factory.made).lang).toBe("en-IN");

    listener.dispose();
  });

  it("forwards interim then final results", () => {
    const factory = recognitionFactory();
    const listener = createListener({ recognition: factory.make });
    const heard: HeardResult[] = [];
    listener.onResult((r) => heard.push(r));

    listener.start("en");
    const rec = last(factory.made);
    rec.emitResult("re", false, 0);
    rec.emitResult("rendu", true, 0.91);

    expect(heard).toEqual([
      { text: "re", conf: 0, isFinal: false },
      { text: "rendu", conf: 0.91, isFinal: true },
    ]);

    listener.dispose();
  });

  it("ignores an empty transcript", () => {
    const factory = recognitionFactory();
    const listener = createListener({ recognition: factory.make });
    const heard: HeardResult[] = [];
    listener.onResult((r) => heard.push(r));

    listener.start("en");
    last(factory.made).emitResult("   ", false);
    expect(heard).toHaveLength(0);

    listener.dispose();
  });

  it("reports a denied microphone and marks it unusable", () => {
    const factory = recognitionFactory();
    const listener = createListener({ recognition: factory.make });
    const errors: string[] = [];
    const ends: number[] = [];
    listener.onError((m) => errors.push(m));
    listener.onEnd(() => ends.push(1));

    listener.start("en");
    last(factory.made).emitError("not-allowed");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not-allowed");
    expect(isMicUnusable(errors[0] ?? "")).toBe(true);
    // A fatal error must close the session even if `end` never arrives.
    expect(listener.listening).toBe(false);
    expect(ends).toHaveLength(1);

    // The late `end` some platforms still send must not double-report.
    last(factory.made).emitEnd();
    expect(ends).toHaveLength(1);

    listener.dispose();
  });

  it("distinguishes recoverable errors from an unusable microphone", () => {
    const factory = recognitionFactory();
    const listener = createListener({ recognition: factory.make });
    const errors: string[] = [];
    listener.onError((m) => errors.push(m));

    listener.start("en");
    last(factory.made).emitError("no-speech");

    expect(isMicUnusable(errors[0] ?? "")).toBe(false);
    // Recoverable: still listening until the platform ends the turn.
    expect(listener.listening).toBe(true);
    last(factory.made).emitEnd();
    expect(listener.listening).toBe(false);

    expect(isMicUnusable("audio-capture: no usable microphone on this device")).toBe(true);
    expect(isMicUnusable("service-not-allowed: the speech service refused this request")).toBe(true);
    expect(isMicUnusable("network: the speech service could not be reached")).toBe(false);

    listener.dispose();
  });

  it("is idempotent on double start and double stop, and never throws", () => {
    const factory = recognitionFactory();
    const listener = createListener({ recognition: factory.make });

    expect(() => listener.stop()).not.toThrow();
    expect(factory.made).toHaveLength(0);

    listener.start("en");
    listener.start("en");
    listener.start("te");
    // One recogniser, started once: the extra calls are no-ops by contract.
    expect(factory.made).toHaveLength(1);
    expect(last(factory.made).starts).toBe(1);
    expect(last(factory.made).lang).toBe("en-IN");

    listener.stop();
    listener.stop();
    expect(last(factory.made).stops).toBe(1);

    last(factory.made).emitEnd();
    expect(listener.listening).toBe(false);
    expect(() => listener.stop()).not.toThrow();

    listener.dispose();
  });

  it("swallows a recogniser that throws on start", () => {
    const factory = recognitionFactory();
    const listener = createListener({ recognition: factory.make });
    const errors: string[] = [];
    const ends: number[] = [];
    listener.onError((m) => errors.push(m));
    listener.onEnd(() => ends.push(1));

    const made = factory.made;
    // Poison the next instance the moment it is constructed.
    const listenerWithBadStart = createListener({
      recognition: () => {
        const rec = new FakeRecognition();
        rec.throwOnStart = new Error("InvalidStateError");
        made.push(rec);
        return rec;
      },
    });
    const badErrors: string[] = [];
    listenerWithBadStart.onError((m) => badErrors.push(m));

    expect(() => listenerWithBadStart.start("en")).not.toThrow();
    expect(badErrors).toHaveLength(1);
    expect(listenerWithBadStart.listening).toBe(false);

    listener.dispose();
    listenerWithBadStart.dispose();
    expect(errors).toHaveLength(0);
    expect(ends).toHaveLength(0);
  });

  it("aborts the live recogniser and detaches handlers on dispose", () => {
    const factory = recognitionFactory();
    const listener = createListener({ recognition: factory.make });
    const heard: HeardResult[] = [];
    listener.onResult((r) => heard.push(r));

    listener.start("en");
    const rec = last(factory.made);
    listener.dispose();

    expect(rec.aborts).toBe(1);
    expect(rec.onresult).toBeNull();
    expect(rec.onerror).toBeNull();
    expect(rec.onend).toBeNull();
    expect(listener.listening).toBe(false);

    // Nothing arrives after disposal, and a second dispose is harmless.
    rec.emitResult("too late", true);
    expect(heard).toHaveLength(0);
    expect(() => listener.dispose()).not.toThrow();
  });

  it("is inert with no platform recogniser", () => {
    const listener = createListener({ recognition: null });
    expect(listener.available).toBe(false);
    expect(() => listener.start("en")).not.toThrow();
    expect(listener.listening).toBe(false);
    expect(() => listener.stop()).not.toThrow();
    listener.dispose();
  });

  it("lets a listener unsubscribe from inside its own callback", () => {
    const factory = recognitionFactory();
    const listener = createListener({ recognition: factory.make });
    const heard: string[] = [];
    const off = listener.onResult((r) => {
      heard.push(r.text);
      off();
    });

    listener.start("en");
    const rec = last(factory.made);
    rec.emitResult("one", false);
    rec.emitResult("two", true);

    expect(heard).toEqual(["one"]);
    listener.dispose();
  });
});

describe("listener: on-device is a gate, not a footnote", () => {
  // Chrome defaults to SERVER-side speech recognition. Shipping that on a kid
  // surface would break §9.1 ("no raw audio is ever transmitted") silently,
  // while the UI went on promising nothing leaves the device.
  it("refuses to confirm when the engine cannot recognise locally", async () => {
    const factory = recognitionFactory();
    const listener = createListener({ recognition: factory.make, checkOnDevice: async () => false });
    expect(await listener.ensureOnDevice("en")).toBe(false);
    expect(listener.onDevice).toBe(false);
  });

  it("confirms and reports local when the engine can", async () => {
    const factory = recognitionFactory();
    const listener = createListener({ recognition: factory.make, checkOnDevice: async () => true });
    expect(await listener.ensureOnDevice("te")).toBe(true);
    expect(listener.onDevice).toBe(true);
  });

  it("sets processLocally on the recogniser it starts", () => {
    const factory = recognitionFactory();
    const listener = createListener({ recognition: factory.make, checkOnDevice: async () => true });
    listener.start("en");
    expect(factory.made[0]?.processLocally).toBe(true);
  });

  it("does not demand local when cloud was deliberately accepted upstream", async () => {
    const factory = recognitionFactory();
    const listener = createListener({
      recognition: factory.make,
      checkOnDevice: async () => false,
      allowCloudRecognition: true,
    });
    expect(await listener.ensureOnDevice("en")).toBe(true);
    expect(listener.onDevice).toBe(false); // honest: it is not local
    listener.start("en");
    expect(factory.made[0]?.processLocally).toBeUndefined();
  });

  it("treats a probe that throws as not-local", async () => {
    const factory = recognitionFactory();
    const listener = createListener({
      recognition: factory.make,
      checkOnDevice: async () => {
        throw new Error("boom");
      },
    });
    expect(await listener.ensureOnDevice("en")).toBe(false);
  });
});
