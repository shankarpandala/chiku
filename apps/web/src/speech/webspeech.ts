// Web Speech wrapper (D1): STT happens on this device; only text ever leaves
// it (§9.1). The engine interface is deliberately tiny so tests and the M3
// mic surface can substitute fakes, and a future child-tuned ASR can slot in
// behind the same shape (§14).

export interface SpeechResult {
  text: string;
  conf: number;
  isFinal: boolean;
  /** performance.now() when this result arrived — latency measurements start here. */
  tsMs: number;
}

export interface SpeechEngine {
  /** False when the platform has no SpeechRecognition — callers must offer a tap path. */
  readonly available: boolean;
  start(lang: string): void;
  stop(): void;
  onResult(cb: (r: SpeechResult) => void): () => void;
  onEnd(cb: () => void): () => void;
  onError(cb: (message: string) => void): () => void;
}

interface RecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
interface RecognitionResultLike {
  isFinal: boolean;
  0: RecognitionAlternativeLike;
  length: number;
}
interface RecognitionEventLike {
  resultIndex: number;
  results: { length: number; [i: number]: RecognitionResultLike };
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  const g = globalThis as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

class Emitter<T> {
  private subs: Array<(v: T) => void> = [];
  emit(v: T): void {
    for (const s of [...this.subs]) s(v);
  }
  on(cb: (v: T) => void): () => void {
    this.subs.push(cb);
    return () => {
      this.subs = this.subs.filter((s) => s !== cb);
    };
  }
}

export function createWebSpeech(): SpeechEngine {
  const Ctor = recognitionCtor();
  const results = new Emitter<SpeechResult>();
  const ends = new Emitter<void>();
  const errors = new Emitter<string>();
  let active: RecognitionLike | null = null;

  return {
    available: Ctor !== null,
    start(lang: string): void {
      if (Ctor === null || active !== null) return;
      const rec = new Ctor();
      rec.lang = lang;
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r === undefined || r.length === 0) continue;
          const alt = r[0];
          results.emit({
            text: alt.transcript,
            conf: alt.confidence,
            isFinal: r.isFinal,
            tsMs: performance.now(),
          });
        }
      };
      rec.onend = () => {
        active = null;
        ends.emit();
      };
      rec.onerror = (e) => {
        errors.emit(e.error ?? "speech-error");
      };
      active = rec;
      rec.start();
    },
    stop(): void {
      active?.stop();
    },
    onResult: (cb) => results.on(cb),
    onEnd: (cb) => ends.on(() => cb()),
    onError: (cb) => errors.on(cb),
  };
}

/** Deterministic engine for tests and the DEV type-to-answer affordance. */
export function createManualSpeech(): SpeechEngine & { say(text: string, conf?: number): void } {
  const results = new Emitter<SpeechResult>();
  const ends = new Emitter<void>();
  const errors = new Emitter<string>();
  let listening = false;
  return {
    available: true,
    start(): void {
      listening = true;
    },
    stop(): void {
      if (!listening) return;
      listening = false;
      ends.emit();
    },
    onResult: (cb) => results.on(cb),
    onEnd: (cb) => ends.on(() => cb()),
    onError: (cb) => errors.on(cb),
    say(text: string, conf = 0.95): void {
      if (!listening) return;
      results.emit({ text, conf, isFinal: true, tsMs: performance.now() });
    },
  };
}
