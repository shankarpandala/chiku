// Pinned public API for @chiku/rig — consumers are built against exactly
// these names. Do not rename (design-contract ruling, 2026-08-05).

export type RigState = "idle" | "listening" | "speaking" | "celebrate" | "goodbye";

export type Viseme = "closed" | "A" | "E" | "O" | "U" | "F" | "L" | "smile";

export type Emote = "idle" | "listening" | "happy" | "encouraging" | "goodbye" | "thinking";

export interface VisemeMark {
  t: number;
  viseme: Viseme;
}

export interface RigOptions {
  crop?: "full" | "head";
  showBody?: boolean;
  reducedMotion?: boolean;
}

export interface Rig {
  setState(s: RigState): void;
  getState(): RigState;
  speak(audioUrl: string, marks?: VisemeMark[]): Promise<void>;
  dispose(): void;
}
