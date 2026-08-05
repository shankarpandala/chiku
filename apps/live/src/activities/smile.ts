// "Show Chiku your biggest smile!" — the only activity where Chiku's own face
// is the feedback: the rig mirrors the smile back while the child holds it.
//
// The threshold is deliberately generous. This is never scored (§9) — it is a
// reason to smile at each other, not a measurement.

import type { Activity, ActivityChoice, ActivityFactory } from "./types";

export const SMILE_HOLD_MS = 500;
export const SMILE_THRESHOLD = 0.45;

const HAPPY: ActivityChoice = {
  id: "smile-happy",
  glyph: "smile",
  labelKey: "choice.smile.happy",
  correct: true,
};
const SAD: ActivityChoice = {
  id: "smile-sad",
  glyph: "sad",
  labelKey: "choice.smile.sad",
  correct: false,
};

export const createSmileActivity: ActivityFactory = (random) => {
  const flip = random() < 0.5;
  const activity: Activity = {
    kind: "smile",
    promptKey: "act.smile.prompt",
    retryKey: "act.smile.retry",
    tapHintKey: "act.smile.tap",
    holdMs: SMILE_HOLD_MS,
    matches: (frame) => frame.face !== null && frame.face.smile >= SMILE_THRESHOLD,
    choices: flip ? [SAD, HAPPY] : [HAPPY, SAD],
  };
  return activity;
};
