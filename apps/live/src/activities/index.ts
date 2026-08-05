// The round: every activity, once, in a random order, with random targets.
// Three short rounds is the whole session — a natural cap that means the
// surface always ends warmly instead of running until a grown-up intervenes
// (§9: hard session cap).

import { createFingersActivity } from "./fingers";
import { createSmileActivity } from "./smile";
import { createWaveActivity } from "./wave";
import type { Activity, ActivityFactory } from "./types";

export const FACTORIES: readonly ActivityFactory[] = [
  createFingersActivity,
  createWaveActivity,
  createSmileActivity,
];

/** Fisher–Yates over a copy, driven by the injected random for testability. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

export function buildRound(random: () => number = Math.random): Activity[] {
  return shuffled(FACTORIES, random).map((make) => make(random));
}

export { createFingersActivity, createSmileActivity, createWaveActivity };
export { HoldTracker, HOLD_SLACK_MS } from "./hold";
export type { Activity, ActivityChoice, ActivityFactory, ActivityKind, GlyphName } from "./types";
