// "Wave to Chiku!" — the first thing any child already knows how to do, which
// makes it the safest opener and the safest recovery.
//
// `frame.waving` is itself an oscillation detector, so it is already smoothed;
// a short hold is enough to keep a stray true from firing.

import {
  matchesAnswer,
  type Activity,
  type ActivityChoice,
  type ActivityFactory,
  type SpokenAnswers,
} from "./types";

export const WAVE_HOLD_MS = 300;

/**
 * Waving is a greeting, so the spoken answer is the greeting itself — a child
 * asked to wave says "hi!" or "టాటా!", not "I am waving". Accept the greeting.
 */
const WAVE_ANSWERS: SpokenAnswers = {
  te: ["టాటా", "టా టా", "హాయ్", "నమస్తే", "tata", "taata", "ta ta", "haay", "namaste", "namaskaram"],
  en: ["hi", "hii", "hey", "hello", "bye", "bye bye", "byebye", "wave", "waving", "i am waving"],
};

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
    // No hands in frame is no evidence about waving — the detector cannot tell
    // "stopped waving" from "lost the hand for a frame", and only one of those
    // is the child's fault.
    hasEvidence: (frame) => frame.hands.length > 0,
    choices: flip ? [STILL, WAVING] : [WAVING, STILL],
    answers: WAVE_ANSWERS,
    accepts: (utterance) => matchesAnswer(utterance, WAVE_ANSWERS),
  };
  return activity;
};
