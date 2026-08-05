// "Wave to Chiku!" — the first thing any child already knows how to do, which
// makes it the safest opener and the safest recovery.
//
// `frame.waving` is itself an oscillation detector, so it is already smoothed;
// a short hold is enough to keep a stray true from firing.

import type { Activity, ActivityChoice, ActivityFactory } from "./types";

export const WAVE_HOLD_MS = 300;

const WAVING: ActivityChoice = {
  id: "wave-waving",
  glyph: "wave",
  labelKey: "choice.wave.waving",
  correct: true,
};
const STILL: ActivityChoice = {
  id: "wave-still",
  glyph: "still",
  labelKey: "choice.wave.still",
  correct: false,
};

export const createWaveActivity: ActivityFactory = (random) => {
  // Only the presentation order is random here — the answer is always "wave".
  const flip = random() < 0.5;
  const activity: Activity = {
    kind: "wave",
    promptKey: "act.wave.prompt",
    retryKey: "act.wave.retry",
    tapHintKey: "act.wave.tap",
    holdMs: WAVE_HOLD_MS,
    matches: (frame) => frame.waving,
    choices: flip ? [STILL, WAVING] : [WAVING, STILL],
  };
  return activity;
};
