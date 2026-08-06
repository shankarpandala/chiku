/**
 * Chiku's voice, spoken by this device.
 *
 * INVARIANT (§9, and the same rule the camera lives under): nothing here leaves
 * the machine. `window.speechSynthesis` renders locally from voices the OS
 * already ships — no request is made, no text is uploaded, and there is no
 * vendor in the path. That is also why this survives the under-18 terms gate in
 * CLAUDE.md: there is no vendor whose terms could apply.
 *
 * Verified on this machine: te-IN "Geeta" and en-IN "Rishi" are present among
 * 180 voices. Neither is guaranteed anywhere else, so every step degrades:
 * exact tag -> language prefix -> whatever the platform picks -> silence with a
 * handle that still resolves.
 *
 * THE THREE BUGS THIS API IS FAMOUS FOR, AND WHAT WE DO ABOUT THEM
 * ----------------------------------------------------------------
 * 1. `getVoices()` is usually EMPTY on first call — the list loads async and
 *    arrives via `voiceschanged`. We never cache an empty answer, and we drop
 *    the cache whenever the event fires.
 * 2. Chrome stops synthesising silently after ~15s and fires neither `end` nor
 *    `error`, so an awaited line hangs forever. A watchdog resolves the handle
 *    if nothing at all is heard from the utterance for `stallMs`.
 * 3. `cancel()` fires `end`/`error` on the utterance it killed, arriving after
 *    the replacement line has already started. Every line carries its own
 *    settled flag, so a dead line's late events are ignored.
 *
 * The `done` promise NEVER rejects and never hangs. Callers await lines in
 * sequence; a deadlock here would freeze the whole show.
 */

import type { SpeakHandle, Speaker, VoiceLang } from "./types";
import { jawAt } from "./mouth";

/* -------------------------------------------------------------------------- */
/* The platform seam                                                          */
/* -------------------------------------------------------------------------- */

/** The only parts of a `SpeechSynthesisVoice` we need. Real ones satisfy this. */
export interface SynthVoiceLike {
  readonly name: string;
  readonly lang: string;
}

/** One line handed to the platform, with its callbacks already bound. */
export interface SynthLine {
  readonly text: string;
  /** BCP-47 tag, e.g. "te-IN". Set even when a voice is chosen. */
  readonly lang: string;
  /** null means "let the platform choose"; it is not a failure. */
  readonly voice: SynthVoiceLike | null;
  readonly rate: number;
  readonly pitch: number;
  onStart(): void;
  onBoundary(): void;
  onEnd(): void;
  onError(message: string): void;
}

/**
 * The speech-synthesis capability, narrowed to what a Speaker needs.
 *
 * A port rather than the raw `SpeechSynthesis` object because utterance
 * construction, event wiring and voice identity are all platform details the
 * Speaker should not know — and because a fake for this is four small methods
 * instead of a DOM emulation.
 */
export interface SynthPort {
  getVoices(): readonly SynthVoiceLike[];
  /** Subscribe to the async voice list arriving. Returns an unsubscribe. */
  onVoicesChanged(cb: () => void): () => void;
  speak(line: SynthLine): void;
  /** Kill everything speaking or queued. */
  cancel(): void;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/** Chiku speaks Indian English and Telugu; the region tag matters for both. */
export const SPEAK_LANG_TAG: Readonly<Record<VoiceLang, string>> = {
  te: "te-IN",
  en: "en-IN",
};

/** A shade under natural pace — 3-to-8-year-olds lose fast speech. */
export const DEFAULT_RATE = 0.95;
/** A shade up, because Chiku is a calf and not a newsreader. */
export const DEFAULT_PITCH = 1.1;

/** Mouth ticker period. ~60fps; the rig samples whatever it gets. */
export const MOUTH_TICK_MS = 16;

/** Silence from an utterance for this long means the platform has stalled. */
export const DEFAULT_STALL_MS = 5000;

export interface SpeakerOptions {
  /**
   * Injected platform. Defaults to `window.speechSynthesis` when present.
   * Pass a fake in tests — happy-dom has no speech synthesis at all.
   */
  readonly synth?: SynthPort | null;
  readonly rate?: number;
  readonly pitch?: number;
  /**
   * Watchdog window. A line that reports no boundary and no end for this long
   * is declared stalled, cleaned up, and its handle resolved.
   *
   * TRADE-OFF, deliberately taken: a platform that never emits `boundary` at
   * all would have a genuinely long line cut off here. Chiku's lines are one
   * short sentence, well under this, so the hang is the worse failure. Raise it
   * if that ever stops being true.
   */
  readonly stallMs?: number;
  /** Mouth ticker period in ms. Exposed for tests, not for tuning. */
  readonly tickMs?: number;
}

/* -------------------------------------------------------------------------- */
/* Voice resolution                                                           */
/* -------------------------------------------------------------------------- */

/** Some platforms report "en_IN" or "EN-in". Compare on one canonical form. */
function canonicalTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/_/g, "-");
}

/**
 * Exact tag, then language prefix, then null.
 *
 * null is the platform default, which is a legitimate outcome: an en-GB voice
 * reading Indian English is far better than no voice, and a device with no
 * Telugu voice at all still has to be able to run the show.
 */
export function pickVoice(
  voices: readonly SynthVoiceLike[],
  lang: VoiceLang,
): SynthVoiceLike | null {
  const wanted = canonicalTag(SPEAK_LANG_TAG[lang]);
  for (const v of voices) {
    if (canonicalTag(v.lang) === wanted) return v;
  }
  const prefix = `${lang}-`;
  for (const v of voices) {
    const tag = canonicalTag(v.lang);
    if (tag === lang || tag.startsWith(prefix)) return v;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Handles                                                                    */
/* -------------------------------------------------------------------------- */

const NOOP = (): void => {};

/** Used when there is nothing to say, or nothing to say it with. */
function settledHandle(): SpeakHandle {
  return { done: Promise.resolve(), cancel: NOOP };
}

interface ActiveLine {
  settled: boolean;
  startedAt: number;
  lastBoundaryAt: number | null;
  ticker: ReturnType<typeof setInterval> | null;
  watchdog: ReturnType<typeof setTimeout> | null;
  readonly onMouth: ((open: number) => void) | undefined;
  readonly resolve: () => void;
}

/* -------------------------------------------------------------------------- */
/* Speaker                                                                    */
/* -------------------------------------------------------------------------- */

class OnDeviceSpeaker implements Speaker {
  readonly #port: SynthPort | null;
  readonly #rate: number;
  readonly #pitch: number;
  readonly #stallMs: number;
  readonly #tickMs: number;

  /** Per-language, because resolution is the expensive-ish part, not speaking. */
  readonly #voiceCache = new Map<VoiceLang, SynthVoiceLike | null>();
  #unsubscribeVoices: (() => void) | null = null;

  #current: ActiveLine | null = null;
  #disposed = false;

  constructor(opts: SpeakerOptions = {}) {
    this.#port = opts.synth === undefined ? browserSynthPort() : opts.synth;
    this.#rate = opts.rate ?? DEFAULT_RATE;
    this.#pitch = opts.pitch ?? DEFAULT_PITCH;
    this.#stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
    this.#tickMs = opts.tickMs ?? MOUTH_TICK_MS;

    if (this.#port) {
      // Bug 1. The list we resolved against may have been a placeholder, or
      // empty, or may change when a language pack finishes installing.
      this.#unsubscribeVoices = this.#port.onVoicesChanged(() => {
        this.#voiceCache.clear();
      });
    }
  }

  get available(): boolean {
    return this.#port !== null;
  }

  get speaking(): boolean {
    return this.#current !== null && !this.#current.settled;
  }

  /* ---------------------------------------------------------------------- */

  speak(text: string, lang: VoiceLang, onMouth?: (open: number) => void): SpeakHandle {
    const port = this.#port;

    // No synthesis, disposed, or nothing to say. The caller is awaiting this;
    // it must resolve, and the mouth must be shut.
    if (!port || this.#disposed || text.trim() === "") {
      onMouth?.(0);
      return settledHandle();
    }

    // Barge-in: one line at a time, always. The previous line's late end/error
    // events are ignored by its own settled flag.
    this.#stopCurrent();
    port.cancel();

    let resolve: () => void = NOOP;
    const done = new Promise<void>((r) => {
      resolve = r;
    });

    const line: ActiveLine = {
      settled: false,
      startedAt: now(),
      lastBoundaryAt: null,
      ticker: null,
      watchdog: null,
      onMouth,
      resolve,
    };
    this.#current = line;

    // Bug 2, armed from here rather than from `start` so that an utterance the
    // platform never begins at all is also caught.
    this.#armWatchdog(line);

    // A platform that throws out of speak() would otherwise leave the caller
    // waiting on the watchdog for a line that was never going to happen.
    try {
      port.speak({
        text,
        lang: SPEAK_LANG_TAG[lang],
        voice: this.#resolveVoice(lang),
        rate: this.#rate,
        pitch: this.#pitch,
        onStart: () => {
          if (line.settled) return;
          line.startedAt = now();
          this.#armWatchdog(line);
          this.#startMouth(line);
        },
        onBoundary: () => {
          if (line.settled) return;
          const t = now();
          line.lastBoundaryAt = t;
          this.#armWatchdog(line);
          // Land the closure on the word edge instead of at the next tick, up
          // to 16ms late. A mouth that shuts a frame after the word has already
          // started is the thing that reads as bad dubbing.
          if (line.ticker !== null) this.#emitMouth(line, jawAt(t - line.startedAt, 0));
        },
        onEnd: () => this.#finish(line),
        onError: () => {
          // An error is not exceptional here: "interrupted" and "canceled" are
          // how a normal barge-in reports itself. The line is simply over.
          this.#finish(line);
        },
      });
    } catch {
      this.#finish(line);
    }

    return {
      done,
      cancel: () => {
        if (line.settled) return;
        this.#finish(line);
        port.cancel();
      },
    };
  }

  cancelAll(): void {
    this.#stopCurrent();
    this.#port?.cancel();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancelAll();
    this.#unsubscribeVoices?.();
    this.#unsubscribeVoices = null;
    this.#voiceCache.clear();
  }

  /* ---------------------------------------------------------------------- */

  #resolveVoice(lang: VoiceLang): SynthVoiceLike | null {
    const cached = this.#voiceCache.get(lang);
    if (cached !== undefined) return cached;

    let voices: readonly SynthVoiceLike[] = [];
    try {
      voices = this.#port?.getVoices() ?? [];
    } catch {
      // A platform that throws from getVoices still gets to speak in its
      // default voice; this is not worth failing a line over.
      voices = [];
    }

    // Bug 1 again: an empty list means "not loaded yet", never "no voices".
    // Caching that would pin the default voice for the whole session.
    if (voices.length === 0) return null;

    const picked = pickVoice(voices, lang);
    this.#voiceCache.set(lang, picked);
    return picked;
  }

  #startMouth(line: ActiveLine): void {
    if (line.ticker !== null) return;
    const emit = (): void => {
      if (line.settled) return;
      const t = now();
      const sinceBoundary = line.lastBoundaryAt === null ? null : t - line.lastBoundaryAt;
      this.#emitMouth(line, jawAt(t - line.startedAt, sinceBoundary));
    };
    line.ticker = setInterval(emit, this.#tickMs);
    emit();
  }

  #emitMouth(line: ActiveLine, open: number): void {
    if (!line.onMouth) return;
    try {
      line.onMouth(open);
    } catch {
      // A broken rig consumer must not strand the line or leave the mouth open.
    }
  }

  #armWatchdog(line: ActiveLine): void {
    if (line.watchdog !== null) clearTimeout(line.watchdog);
    line.watchdog = setTimeout(() => {
      if (line.settled) return;
      // Nothing from this utterance for the whole window. Whether the platform
      // died mid-word or never started, the caller must not wait any longer.
      this.#finish(line);
      this.#port?.cancel();
    }, this.#stallMs);
  }

  /** Idempotent. Every exit path — end, error, cancel, stall — comes through here. */
  #finish(line: ActiveLine): void {
    if (line.settled) return;
    line.settled = true;

    if (line.ticker !== null) clearInterval(line.ticker);
    line.ticker = null;
    if (line.watchdog !== null) clearTimeout(line.watchdog);
    line.watchdog = null;

    // Unconditional, even if the ticker never ran: the mouth must never stick.
    this.#emitMouth(line, 0);

    if (this.#current === line) this.#current = null;
    line.resolve();
  }

  #stopCurrent(): void {
    const line = this.#current;
    if (line) this.#finish(line);
    this.#current = null;
  }
}

function now(): number {
  return Date.now();
}

/* -------------------------------------------------------------------------- */
/* The real platform                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Wrap `window.speechSynthesis`, or null where it does not exist.
 *
 * Everything platform-shaped is confined to this function: utterance
 * construction, the event names, and mapping a chosen voice back onto the live
 * `SpeechSynthesisVoice` object (by name+tag — the objects we hand out are
 * read-only views, and re-reading the list here also survives a voice list that
 * was replaced between resolution and speaking).
 */
export function browserSynthPort(): SynthPort | null {
  if (typeof speechSynthesis === "undefined") return null;
  if (typeof SpeechSynthesisUtterance === "undefined") return null;
  const synth = speechSynthesis;

  return {
    getVoices(): readonly SynthVoiceLike[] {
      return synth.getVoices();
    },
    onVoicesChanged(cb: () => void): () => void {
      synth.addEventListener("voiceschanged", cb);
      return () => synth.removeEventListener("voiceschanged", cb);
    },
    speak(line: SynthLine): void {
      const utterance = new SpeechSynthesisUtterance(line.text);
      utterance.lang = line.lang;
      utterance.rate = line.rate;
      utterance.pitch = line.pitch;

      const wanted = line.voice;
      if (wanted) {
        const real = synth
          .getVoices()
          .find((v) => v.name === wanted.name && v.lang === wanted.lang);
        if (real) utterance.voice = real;
      }

      utterance.onstart = () => line.onStart();
      utterance.onboundary = () => line.onBoundary();
      utterance.onend = () => line.onEnd();
      utterance.onerror = (event) => line.onError(String(event.error ?? "synthesis failed"));

      synth.speak(utterance);
    },
    cancel(): void {
      synth.cancel();
    },
  };
}

/* -------------------------------------------------------------------------- */

export function createSpeaker(opts?: SpeakerOptions): Speaker {
  return new OnDeviceSpeaker(opts);
}
