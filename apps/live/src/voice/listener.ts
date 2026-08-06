/**
 * The child's half of the conversation, heard by this device.
 *
 * INVARIANT (§9): no raw audio is stored or transmitted *by this app*. We ask
 * the browser for a transcript and receive text; we never touch a MediaStream,
 * never buffer samples, and never write audio anywhere.
 *
 * BE HONEST ABOUT WHAT THIS API IS. `SpeechRecognition` is a browser feature,
 * not our code. On Chrome it defaults to SERVER-side recognition: the browser
 * ships the child's audio to Google, over a connection it opens outside our CSP
 * and outside our process. That silently breaks §9.1 ("no raw audio is ever
 * transmitted"), which is a promise this product makes to parents.
 *
 * So we do not accept the default. Chrome 139+ exposes on-device recognition —
 * `SpeechRecognition.available({langs, processLocally:true})` to query it and
 * `recognition.processLocally = true` to demand it — and this module REQUIRES
 * it: `ensureOnDevice()` must confirm local availability before the mic opens,
 * and `onDevice` reports what was actually obtained. When on-device recognition
 * is unavailable the listener reports itself unusable rather than quietly
 * streaming a child's voice to a third party. A parent can be offered that
 * trade deliberately, on a grown-up surface, with different words — it is not
 * something the show may decide on its own.
 *
 * Nothing in this module reaches the network itself.
 */

import type { HeardResult, Listener, VoiceLang } from "./types";

/* -------------------------------------------------------------------------- */
/* The platform seam                                                          */
/* -------------------------------------------------------------------------- */

export interface RecognitionAlternativeLike {
  readonly transcript: string;
  readonly confidence: number;
}

export interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternativeLike;
}

export interface RecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: RecognitionResultLike;
}

export interface RecognitionEventLike {
  /** First result index changed by this event; earlier ones were already sent. */
  readonly resultIndex: number;
  readonly results: RecognitionResultListLike;
}

export interface RecognitionErrorLike {
  readonly error?: string;
  readonly message?: string;
}

/** The shape of a `SpeechRecognition` instance, narrowed to what we use. */
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  /** Chrome 139+. Demands local recognition; absent on older/other engines. */
  processLocally?: boolean;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: RecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

/**
 * A fresh recogniser per listen.
 *
 * Reusing one instance across turns is the documented-looking thing to do and
 * is flaky in practice — a recogniser that has ended once will happily throw
 * `InvalidStateError` on restart, and a stale `lang` sometimes survives a
 * reassignment. Constructing per turn costs nothing and makes language
 * switching a non-event.
 */
export type RecognitionFactory = () => RecognitionLike;

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * en-IN is deliberate for both halves of the product: it also hears
 * transliterated Telugu ("thopu", "renDu") which is exactly how bilingual
 * children in this bracket actually answer.
 */
export const LISTEN_LANG_TAG: Readonly<Record<VoiceLang, string>> = {
  te: "te-IN",
  en: "en-IN",
};

/**
 * Errors that mean the microphone is not going to work, so the UI should stop
 * offering to listen rather than re-prompting a child who cannot succeed.
 */
export const MIC_UNUSABLE_ERRORS: ReadonlySet<string> = new Set([
  "not-allowed",
  "audio-capture",
  "service-not-allowed",
]);

/**
 * Developer-facing explanations, not kid copy. Anything the child reads is the
 * surface's job and lives in `src/i18n` in both te and en; this module has no
 * business inventing kid-facing strings.
 */
const ERROR_EXPLANATION: Readonly<Record<string, string>> = {
  "not-allowed": "microphone permission was declined",
  "service-not-allowed": "the speech service refused this request",
  "audio-capture": "no usable microphone on this device",
  "no-speech": "no speech was heard",
  aborted: "listening was stopped",
  network: "the speech service could not be reached",
  "language-not-supported": "this language is not supported for listening",
  "bad-grammar": "the recogniser rejected its grammar",
};

/** Messages are formatted `code: explanation`, so the code stays machine-readable. */
export function describeRecognitionError(event: RecognitionErrorLike): string {
  const code = (event.error ?? "").trim() || "unknown";
  const explanation = ERROR_EXPLANATION[code] ?? event.message?.trim() ?? "";
  return explanation ? `${code}: ${explanation}` : code;
}

/** True for the errors that mean "stop offering the microphone". */
export function isMicUnusable(message: string): boolean {
  const code = message.split(":")[0]?.trim() ?? "";
  return MIC_UNUSABLE_ERRORS.has(code);
}

export interface ListenerOptions {
  /**
   * Injected recogniser constructor. Defaults to the platform's
   * `SpeechRecognition` / `webkitSpeechRecognition`. Pass a fake in tests —
   * happy-dom has neither.
   */
  readonly recognition?: RecognitionFactory | null;
  /**
   * Queries whether the engine can recognise `lang` WITHOUT sending audio away.
   * Defaults to Chrome 139+'s `SpeechRecognition.available({processLocally})`.
   * Returning false keeps the mic shut — see the module header.
   */
  readonly checkOnDevice?: ((lang: VoiceLang) => Promise<boolean>) | null;
  /**
   * Escape hatch for a deliberate, parent-facing decision to accept cloud
   * recognition. Defaults false. Nothing on a kid surface may set this without
   * changing the words shown to the parent.
   */
  readonly allowCloudRecognition?: boolean;
}

/** Chrome 139+ on-device availability probe. Unknown engines answer "no". */
function browserOnDeviceCheck(): (lang: VoiceLang) => Promise<boolean> {
  return async (lang: VoiceLang): Promise<boolean> => {
    const g = globalThis as {
      SpeechRecognition?: {
        available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string>;
      };
    };
    const probe = g.SpeechRecognition?.available;
    if (typeof probe !== "function") return false;
    try {
      const state = await probe({ langs: [LISTEN_LANG_TAG[lang]], processLocally: true });
      // "available" — ready now. "downloadable"/"downloading" — the model is not
      // on the device yet, so opening the mic now would fall back to the cloud.
      return state === "available";
    } catch {
      return false;
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Listener                                                                   */
/* -------------------------------------------------------------------------- */

class OnDeviceListener implements Listener {
  readonly #factory: RecognitionFactory | null;
  readonly #resultListeners = new Set<(r: HeardResult) => void>();
  readonly #errorListeners = new Set<(message: string) => void>();
  readonly #endListeners = new Set<() => void>();

  #rec: RecognitionLike | null = null;
  /** stop() has been asked for but `end` has not arrived; the mic is still open. */
  #stopping = false;
  #disposed = false;

  readonly #checkOnDevice: ((lang: VoiceLang) => Promise<boolean>) | null;
  readonly #allowCloud: boolean;
  /** null = not yet probed. Reported to the surface so the copy can be true. */
  #onDevice: boolean | null = null;

  constructor(opts: ListenerOptions = {}) {
    this.#factory = opts.recognition === undefined ? browserRecognitionFactory() : opts.recognition;
    this.#checkOnDevice =
      opts.checkOnDevice === undefined ? browserOnDeviceCheck() : opts.checkOnDevice;
    this.#allowCloud = opts.allowCloudRecognition ?? false;
  }

  /** What we actually got: true = local, false = would be cloud, null = unprobed. */
  get onDevice(): boolean | null {
    return this.#onDevice;
  }

  /**
   * Must resolve true before the mic may open. Answers false when the engine
   * cannot recognise this language locally — the caller then keeps the mic shut
   * and says so, rather than streaming a child's voice to a third party.
   */
  async ensureOnDevice(lang: VoiceLang): Promise<boolean> {
    if (this.#allowCloud) {
      this.#onDevice = false;
      return true; // deliberately accepted upstream; the copy must reflect it
    }
    if (!this.#checkOnDevice) {
      this.#onDevice = false;
      return false;
    }
    const ok = await this.#checkOnDevice(lang).catch(() => false);
    this.#onDevice = ok;
    return ok;
  }

  get available(): boolean {
    return this.#factory !== null;
  }

  get listening(): boolean {
    return this.#rec !== null;
  }

  /* ---------------------------------------------------------------------- */

  start(lang: VoiceLang): void {
    const factory = this.#factory;
    // Every one of these is a no-op by contract, not an error: the surface
    // calls start() from a checkpoint that may already be listening.
    if (!factory || this.#disposed || this.#rec) return;

    let rec: RecognitionLike;
    try {
      rec = factory();
    } catch (err: unknown) {
      this.#emitError(`unknown: ${describe(err)}`);
      return;
    }

    rec.lang = LISTEN_LANG_TAG[lang];
    // Demand local recognition. On Chrome 139+ this is what keeps the child's
    // audio on the device; on engines without the property it is inert, which
    // is why ensureOnDevice() gates the mic separately rather than trusting it.
    if (!this.#allowCloud) rec.processLocally = true;
    // One answer per checkpoint. `continuous` would keep the mic open across
    // the whole activity, which is both a privacy smell and a battery cost.
    rec.continuous = false;
    // Interims are what let Chiku's ear light up while the child is still
    // talking; the matcher only ever commits on a final.
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    // Per-instance latch. `error` is often followed by `end`, and on some
    // platforms a fatal `error` arrives with no `end` at all — either way the
    // teardown must run exactly once.
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      detach(rec);
      if (this.#rec === rec) {
        this.#rec = null;
        this.#stopping = false;
      }
      this.#emitEnd();
    };

    rec.onstart = null;
    rec.onresult = (event) => {
      if (finished) return;
      this.#emitResults(event);
    };
    rec.onerror = (event) => {
      if (finished) return;
      const message = describeRecognitionError(event);
      this.#emitError(message);
      if (isMicUnusable(message)) finish();
    };
    rec.onend = () => finish();

    this.#rec = rec;
    this.#stopping = false;

    try {
      rec.start();
    } catch (err: unknown) {
      // Chrome throws InvalidStateError if a recogniser is started twice, and
      // some builds throw when the mic is held elsewhere. Never propagate.
      this.#emitError(`unknown: ${describe(err)}`);
      finish();
    }
  }

  stop(): void {
    const rec = this.#rec;
    if (!rec || this.#stopping) return;
    this.#stopping = true;
    try {
      // stop(), not abort(): the child may be mid-word, and stop() still
      // delivers the final result before ending.
      rec.stop();
    } catch {
      // Already dead. `end` will not arrive, so tear down here instead.
      const handler = rec.onend;
      detach(rec);
      if (this.#rec === rec) {
        this.#rec = null;
        this.#stopping = false;
      }
      if (handler) handler();
      else this.#emitEnd();
    }
  }

  onResult(cb: (r: HeardResult) => void): () => void {
    this.#resultListeners.add(cb);
    return () => {
      this.#resultListeners.delete(cb);
    };
  }

  onError(cb: (message: string) => void): () => void {
    this.#errorListeners.add(cb);
    return () => {
      this.#errorListeners.delete(cb);
    };
  }

  onEnd(cb: () => void): () => void {
    this.#endListeners.add(cb);
    return () => {
      this.#endListeners.delete(cb);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const rec = this.#rec;
    this.#rec = null;
    this.#stopping = false;
    if (rec) {
      detach(rec);
      try {
        // abort(), not stop(): disposal means the surface is gone, so a final
        // transcript has nowhere to land. Close the mic now.
        rec.abort();
      } catch {
        // Nothing left to abort.
      }
    }
    this.#resultListeners.clear();
    this.#errorListeners.clear();
    this.#endListeners.clear();
  }

  /* ---------------------------------------------------------------------- */

  #emitResults(event: RecognitionEventLike): void {
    const results = event.results;
    const from = Number.isFinite(event.resultIndex) ? Math.max(0, event.resultIndex) : 0;
    for (let i = from; i < results.length; i += 1) {
      const result = results[i];
      if (!result) continue;
      const alternative = result[0];
      if (!alternative) continue;

      const text = (alternative.transcript ?? "").trim();
      // An empty interim is the recogniser clearing its throat, not an answer.
      if (text === "") continue;

      const raw = alternative.confidence;
      this.#emit(this.#resultListeners, {
        text,
        // Several platforms report 0 for interims and sometimes for finals too;
        // the contract already warns callers never to gate on this alone.
        conf: typeof raw === "number" && Number.isFinite(raw) ? clamp01(raw) : 0,
        isFinal: result.isFinal === true,
      });
    }
  }

  #emitError(message: string): void {
    this.#emit(this.#errorListeners, message);
  }

  #emitEnd(): void {
    this.#emit(this.#endListeners, undefined);
  }

  #emit<T>(listeners: ReadonlySet<(arg: T) => void>, arg: T): void {
    // Copy: a listener is allowed to unsubscribe itself from inside the call.
    for (const cb of [...listeners]) {
      try {
        cb(arg);
      } catch {
        // One broken consumer must not close the microphone on the others.
      }
    }
  }
}

function detach(rec: RecognitionLike): void {
  rec.onstart = null;
  rec.onresult = null;
  rec.onerror = null;
  rec.onend = null;
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/* -------------------------------------------------------------------------- */
/* The real platform                                                          */
/* -------------------------------------------------------------------------- */

interface RecognitionConstructor {
  new (): RecognitionLike;
}

/**
 * The platform recogniser, or null.
 *
 * Standard name first, `webkit`-prefixed second — Safari and older Chrome only
 * expose the prefixed one, and it is the same object.
 */
export function browserRecognitionFactory(): RecognitionFactory | null {
  const scope = globalThis as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  const Recognition = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  if (typeof Recognition !== "function") return null;
  return () => new Recognition();
}

/* -------------------------------------------------------------------------- */

export function createListener(opts?: ListenerOptions): Listener {
  return new OnDeviceListener(opts);
}
