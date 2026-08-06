// The round: THREE activities, drawn at random from the pool, with random
// targets. Three short rounds is the whole session — a natural cap that means
// the surface always ends warmly instead of running until a grown-up
// intervenes (§9: hard session cap).
//
// WHY THE ROUND IS SHORTER THAN THE POOL. It used to be "every activity, once",
// which was the same thing while there were three of them. The colour hunt made
// a fourth, and lengthening the round to fit it would have made every session
// 33% longer — spending a child's capped play time on a decision nobody made.
// So the round length is now a number in its own right and the pool is sampled:
// the session stays the length it was, and which three activities a child gets
// varies, which is a better show than the same three in a different order.

import { createFingersActivity } from "./fingers";
import { createHuntActivity } from "./hunt";
import { createSmileActivity } from "./smile";
import { createWaveActivity } from "./wave";
import type { Activity, ActivityFactory } from "./types";

export const FACTORIES: readonly ActivityFactory[] = [
  createFingersActivity,
  createWaveActivity,
  createHuntActivity,
  createSmileActivity,
];

/** How many activities one visit is. Never longer than the pool. */
export const ROUND_LENGTH = 3;

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
  return shuffled(FACTORIES, random)
    .slice(0, Math.min(ROUND_LENGTH, FACTORIES.length))
    .map((make) => make(random));
}

export { createFingersActivity, createHuntActivity, createSmileActivity, createWaveActivity };
export { HUNT_HOLD_MS, HUNT_PRESENCE } from "./hunt";
export {
  HoldTracker,
  HOLD_SLACK_CEILING_MS,
  HOLD_SLACK_FRAMES,
  HOLD_UNKNOWN_FRAMES,
  type HoldVerdict,
} from "./hold";
export {
  alongsideBeatsFor,
  copyKey,
  demoBeatsFor,
  DEMO_ASK_MS,
  matchesAnswer,
  normalizeUtterance,
  optionalCopyKey,
  verdictFor,
} from "./types";
export type {
  Activity,
  ActivityChoice,
  ActivityFactory,
  ActivityKind,
  DemoBeat,
  GlyphName,
  SpokenAnswers,
} from "./types";
export {
  ASSIST_LADDER,
  nextAssist,
  praiseToneFor,
  relaxFor,
  type AssistLevel,
  type PraiseTone,
  type Relaxation,
} from "./assist";
