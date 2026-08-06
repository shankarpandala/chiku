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
 * 180 voices. Neither is guaranteed anywhere else, and MOST non-Mac devices
 * ship no Telugu voice at all.
 *
 * WHAT WE WILL NOT DO IS SPEAK ONE LANGUAGE IN ANOTHER LANGUAGE'S VOICE.
 * Handing "మూడు వేళ్ళు చూపించు" to an en-US voice does not produce accented
 * Telugu; it produces letter-by-letter noise, or silence, in the child's
 * primary language, on every single prompt. So resolution degrades like this:
 *
 *   exact tag (te-IN) -> same language, any region (te-*) -> DO NOT SPEAK
 *
 * with one exception, and it is the important one: while the platform has not
 * yet produced its voice list, "no match" means "not loaded", not "not there",
 * and we let the platform pick — some engines (older Android WebView) report an
 * empty list forever and still speak the OS locale correctly. `voicesReady`
 * says which of the two you are looking at, and `hasVoice(lang)` answers the
 * question a surface actually has: can Chiku say anything in this language?
 * A refusal is reported on the handle (`outcome: "no-voice"`) so the surface
 * can say so out loud instead of a child watching a silent elephant.
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

/**
 * Speech pace, in characters per second at rate 1.0, used ONLY to bound how
 * long a line that reports no progress at all may run before we give up on it.
 *
 * Deliberately slow (real speech is nearer 15-20 c/s, and Telugu script packs
 * more sound per character than Latin) and then doubled by the margin below,
 * because the cost of over-estimating is a late resolve on a device that has
 * already gone quiet, while the cost of under-estimating is cutting a child's
 * prompt off mid-sentence.
 */
export const SPEECH_CHARS_PER_SECOND = 12;
export const SPEECH_ESTIMATE_MARGIN = 2;
/** Nothing waits longer than this, whatever the arithmetic says. */
export const MAX_ESTIMATE_MS = 120_000;

/**
 * How long a line of this length could plausibly take at this rate.
 *
 * This exists because of Android: Chrome on Android fires `end` but never fires
 * `boundary`, so a flat 5s stall watchdog cut every line longer than about a
 * sentence — the platform was working perfectly and we hung up on it.
 */
export function estimateSpeechMs(text: string, rate: number): number {
  const chars = text.trim().length;
  if (chars === 0) return 0;
  const perSecond = SPEECH_CHARS_PER_SECOND * Math.max(0.1, rate);
  const ms = (chars / perSecond) * 1000 * SPEECH_ESTIMATE_MARGIN;
  return Math.min(MAX_ESTIMATE_MS, Math.round(ms));
}

export interface SpeakerOptions {
  /**
   * Injected platform. Defaults to `window.speechSynthesis` when present.
   * Pass a fake in tests — happy-dom has no speech synthesis at all.
   */
  readonly synth?: SynthPort | null;
  readonly rate?: number;
  readonly pitch?: number;
  /**
   * Watchdog window, applied from the last sign of life.
   *
   * BOUNDARY-AWARE, because the old flat version was wrong on Android. It is
   * only a fair measure of "the platform has stopped" once the platform has
   * shown us it reports progress at all:
   *   - queued but never started -> `stallMs` (nothing is happening);
   *   - started, at least one `boundary` seen -> `stallMs` from the last one;
   *   - started, no `boundary` ever (Chrome on Android never fires it) ->
   *     `max(stallMs, estimateSpeechMs(text, rate))`, so a long line is allowed
   *     the time it would actually take to say.
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
 * null means NO VOICE OF THIS LANGUAGE, which is a different thing from "use
 * the default": an en-GB voice reading Indian English is a good outcome and
 * this function finds it (`en-` prefix), but an en-GB voice reading Telugu is
 * not speech at all. The caller decides what to do with null; see `#resolve`.
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

/**
 * What happened to a line, known synchronously.
 *
 * `no-voice` is the one that matters: the line was NOT spoken, on purpose,
 * because this device has no voice for that language. A surface that shows the
 * text anyway is fine; a surface that also says so (in the other language, or
 * with a "Chiku cannot say this out loud here" note) is better. Either way it
 * must not be left believing Chiku spoke.
 */
export type SpeakOutcome = "spoken" | "empty" | "unavailable" | "no-voice";

export interface SpeakResult extends SpeakHandle {
  readonly outcome: SpeakOutcome;
}

/** Used when there is nothing to say, or nothing to say it with. */
function settledHandle(outcome: SpeakOutcome): SpeakResult {
  return { done: Promise.resolve(), cancel: NOOP, outcome };
}

interface ActiveLine {
  settled: boolean;
  startedAt: number;
  lastBoundaryAt: number | null;
  /** The platform has told us the utterance began. */
  started: boolean;
  /** …and has fired at least one `boundary`, so its silence means something. */
  boundarySeen: boolean;
  /** How long this line could plausibly take, for the boundary-less case. */
  readonly estimateMs: number;
  ticker: ReturnType<typeof setInterval> | null;
  watchdog: ReturnType<typeof setTimeout> | null;
  readonly onMouth: ((open: number) => void) | undefined;
  readonly resolve: () => void;
}

/** What a language resolution knows: the voice, and whether that was final. */
interface VoiceResolution {
  readonly voice: SynthVoiceLike | null;
  /** False while the platform has not produced its voice list yet. */
  readonly ready: boolean;
}

/**
 * A `Speaker` that can be asked what it can and cannot say.
 *
 * The extra members exist so a surface can tell "this device has no Telugu
 * voice" (a fact worth telling a parent about, once) apart from "the voice list
 * has not loaded yet" (a fact worth telling nobody).
 */
export interface LanguageAwareSpeaker extends Speaker {
  /** True once the platform has actually produced a voice list. */
  readonly voicesReady: boolean;
  /** The voice Chiku would use for this language, or null if there is none. */
  voiceFor(lang: VoiceLang): SynthVoiceLike | null;
  /**
   * Can Chiku speak this language on this device?
   *
   * False while the voice list has not loaded — there is genuinely no voice
   * yet — so pair it with `voicesReady` before showing a parent anything
   * permanent, and re-check from `onVoicesChanged`.
   */
  hasVoice(lang: VoiceLang): boolean;
  /** Fires when the platform's voice list arrives or changes. */
  onVoicesChanged(cb: () => void): () => void;
  speak(text: string, lang: VoiceLang, onMouth?: (open: number) => void): SpeakResult;
}

/* -------------------------------------------------------------------------- */
/* Speaker                                                                    */
/* -------------------------------------------------------------------------- */

class OnDeviceSpeaker implements LanguageAwareSpeaker {
  readonly #port: SynthPort | null;
  readonly #rate: number;
  readonly #pitch: number;
  readonly #stallMs: number;
  readonly #tickMs: number;

  /** Per-language, because resolution is the expensive-ish part, not speaking. */
  readonly #voiceCache = new Map<VoiceLang, SynthVoiceLike | null>();
  #unsubscribeVoices: (() => void) | null = null;
  readonly #voiceListeners = new Set<() => void>();
  /** True once `getVoices()` has returned a non-empty list at least once. */
  #voicesResolved = false;

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
        for (const cb of [...this.#voiceListeners]) {
          try {
            cb();
          } catch {
            // A broken consumer must not stop the others from re-checking.
          }
        }
      });
    }
  }

  get available(): boolean {
    return this.#port !== null;
  }

  get speaking(): boolean {
    return this.#current !== null && !this.#current.settled;
  }

  get voicesReady(): boolean {
    if (this.#voicesResolved) return true;
    // Ask again rather than answering from a stale "not yet": the list arrives
    // asynchronously and the event that announces it is not fired everywhere.
    return this.#readVoices().length > 0;
  }

  voiceFor(lang: VoiceLang): SynthVoiceLike | null {
    return this.#resolve(lang).voice;
  }

  hasVoice(lang: VoiceLang): boolean {
    const { voice, ready } = this.#resolve(lang);
    return ready && voice !== null;
  }

  onVoicesChanged(cb: () => void): () => void {
    this.#voiceListeners.add(cb);
    return () => {
      this.#voiceListeners.delete(cb);
    };
  }

  /* ---------------------------------------------------------------------- */

  speak(text: string, lang: VoiceLang, onMouth?: (open: number) => void): SpeakResult {
    const port = this.#port;

    // No synthesis, disposed, or nothing to say. The caller is awaiting this;
    // it must resolve, and the mouth must be shut.
    if (!port || this.#disposed) {
      onMouth?.(0);
      return settledHandle("unavailable");
    }
    if (text.trim() === "") {
      onMouth?.(0);
      return settledHandle("empty");
    }

    // THE LANGUAGE GATE. A resolved voice list with nothing for this language
    // means this device cannot say this. Handing it to whatever voice the
    // platform likes produces noise in the child's own language, which is worse
    // than silence — silence at least leaves the written line standing.
    const resolution = this.#resolve(lang);
    if (resolution.ready && resolution.voice === null) {
      onMouth?.(0);
      return settledHandle("no-voice");
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
      started: false,
      boundarySeen: false,
      estimateMs: estimateSpeechMs(text, this.#rate),
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
        voice: resolution.voice,
        rate: this.#rate,
        pitch: this.#pitch,
        onStart: () => {
          if (line.settled) return;
          line.startedAt = now();
          line.started = true;
          this.#armWatchdog(line);
          this.#startMouth(line);
        },
        onBoundary: () => {
          if (line.settled) return;
          const t = now();
          line.lastBoundaryAt = t;
          line.boundarySeen = true;
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
      outcome: "spoken",
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
    this.#voiceListeners.clear();
  }

  /* ---------------------------------------------------------------------- */

  /** One getVoices() call, and the "has the list arrived" flag it sets. */
  #readVoices(): readonly SynthVoiceLike[] {
    let voices: readonly SynthVoiceLike[] = [];
    try {
      voices = this.#port?.getVoices() ?? [];
    } catch {
      // A platform that throws from getVoices is a platform we know nothing
      // about; treat it as "not loaded" rather than "no voices anywhere".
      voices = [];
    }
    if (voices.length > 0) this.#voicesResolved = true;
    return voices;
  }

  #resolve(lang: VoiceLang): VoiceResolution {
    const cached = this.#voiceCache.get(lang);
    if (cached !== undefined) return { voice: cached, ready: true };

    const voices = this.#readVoices();
    // Bug 1 again: an empty list means "not loaded yet", never "no voices".
    // Caching that would pin the default voice for the whole session — and,
    // now, would permanently mute a language the device can in fact speak.
    if (voices.length === 0) return { voice: null, ready: false };

    const picked = pickVoice(voices, lang);
    this.#voiceCache.set(lang, picked);
    return { voice: picked, ready: true };
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

  /**
   * How long this line may stay silent before we declare it dead.
   *
   * The 5s flat window was only ever right for a platform that reports word
   * boundaries. Chrome on Android reports none at all, so every line longer
   * than about five seconds of speech was cut off mid-sentence — on the exact
   * devices this show is most likely to run on.
   */
  #watchdogMs(line: ActiveLine): number {
    // Never started: nothing is in flight to be long. The platform queued the
    // utterance and forgot it, which is the fast failure.
    if (!line.started) return this.#stallMs;
    // Boundaries are arriving, so silence for a whole window really is a stall.
    if (line.boundarySeen) return this.#stallMs;
    // Started, no boundaries ever: we cannot measure progress, so we wait out
    // the length of the line instead of guessing that it has died.
    return Math.max(this.#stallMs, line.estimateMs);
  }

  #armWatchdog(line: ActiveLine): void {
    if (line.watchdog !== null) clearTimeout(line.watchdog);
    line.watchdog = setTimeout(() => {
      if (line.settled) return;
      // Nothing from this utterance for the whole window. Whether the platform
      // died mid-word or never started, the caller must not wait any longer.
      this.#finish(line);
      this.#port?.cancel();
    }, this.#watchdogMs(line));
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

export function createSpeaker(opts?: SpeakerOptions): LanguageAwareSpeaker {
  return new OnDeviceSpeaker(opts);
}
