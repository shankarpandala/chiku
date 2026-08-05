// Pinned public API for @chiku/rig — consumers are built against exactly
// these names. Do not rename (design-contract ruling, 2026-08-05).

export type RigState = "idle" | "listening" | "speaking" | "celebrate" | "goodbye";

export type Viseme = "closed" | "A" | "E" | "O" | "U" | "F" | "L" | "smile";

export type Emote = "idle" | "listening" | "happy" | "encouraging" | "goodbye" | "thinking";

export interface VisemeMark {
  t: number;
  viseme: Viseme;
}

/** Minimal audio handle speak() drives; wraps HTMLAudioElement by default. */
export interface RigAudio {
  play(): void | Promise<void>;
  pause(): void;
  /** Playback position in seconds — the audio clock marks are scheduled on. */
  readonly currentTime: number;
  addEventListener(type: "ended" | "error", listener: () => void): void;
  removeEventListener(type: "ended" | "error", listener: () => void): void;
  /** Underlying HTMLMediaElement when available (used by the amplitude driver). */
  element?: unknown;
}

/** Live loudness sampler (0..1 RMS) for the no-marks amplitude fallback. */
export interface AmplitudeSource {
  sample(): number;
  dispose(): void;
}

export interface RigOptions {
  crop?: "full" | "head";
  showBody?: boolean;
  reducedMotion?: boolean;
  /** Override audio creation (tests, prefetch pools). null → timer-driven fallback. */
  createAudio?: (url: string) => RigAudio | null;
  /** Override the amplitude driver. null → 200ms viseme cycle fallback. */
  createAmplitude?: (audio: RigAudio) => AmplitudeSource | null;
}

export interface Rig {
  setState(s: RigState): void;
  getState(): RigState;
  speak(audioUrl: string, marks?: VisemeMark[]): Promise<void>;
  dispose(): void;
}
