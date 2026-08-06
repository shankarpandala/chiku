// The voice contract for Chiku Live. Both halves run ENTIRELY on this device:
// SpeechSynthesis for Chiku's mouth, SpeechRecognition for the child's answer.
// Nothing is uploaded, no vendor is involved, and there is no hosted LLM on this
// path — which is also why it survives the Gemini terms problem (see the v0.2
// amendment in docs/chiku-architecture.md).
//
// Verified available on this machine: te-IN "Geeta" and en-IN "Rishi" voices,
// plus SpeechRecognition. Both are platform features; neither is guaranteed
// everywhere, so `available` is part of the contract and every caller must have
// a path for false.

export type VoiceLang = "te" | "en";

export interface SpeakHandle {
  /** Resolves when the line finishes, is cancelled, or fails. Never rejects. */
  readonly done: Promise<void>;
  /** Stop this line immediately (barge-in). Safe to call twice. */
  cancel(): void;
}

export interface Speaker {
  /** False when the platform has no speech synthesis at all. */
  readonly available: boolean;
  /** True while a line is in flight. */
  readonly speaking: boolean;
  /**
   * Say one line. `onMouth` is called with 0..1 jaw openness so the caller can
   * drive the rig — SpeechSynthesis gives no audio stream to analyse, so this
   * is a procedural estimate paced by word-boundary events, not real loudness.
   */
  speak(text: string, lang: VoiceLang, onMouth?: (open: number) => void): SpeakHandle;
  /** Cancel everything queued or speaking. */
  cancelAll(): void;
  dispose(): void;
}

export interface HeardResult {
  text: string;
  /** 0..1; some platforms always report 0 — never gate on this alone. */
  conf: number;
  isFinal: boolean;
}

export interface Listener {
  /** False when the platform has no SpeechRecognition. */
  readonly available: boolean;
  readonly listening: boolean;
  /**
   * What recognition we actually obtained: true = on this device, false = the
   * browser would send audio away, null = not probed yet. The surface's words
   * to the parent must match this — see the header of listener.ts.
   */
  readonly onDevice: boolean | null;
  /**
   * Gate the mic on local recognition. Chrome defaults to SERVER-side speech,
   * which breaks §9.1, so callers MUST await this and keep the mic shut when it
   * answers false.
   */
  ensureOnDevice(lang: VoiceLang): Promise<boolean>;
  /** Open the mic. en-IN also hears transliterated Telugu, which is normal input. */
  start(lang: VoiceLang): void;
  stop(): void;
  onResult(cb: (r: HeardResult) => void): () => void;
  onError(cb: (message: string) => void): () => void;
  onEnd(cb: () => void): () => void;
  dispose(): void;
}
