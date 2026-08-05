// "Show me THREE fingers!" — counting with the body.
//
// The target is randomised per round so the same run is never the same twice.
// 600ms hold: a 3-year-old's hand passes through 2 and 4 on the way to 3, and
// MediaPipe will happily report every one of them.

import { randInt, type Activity, type ActivityChoice, type ActivityFactory } from "./types";

export const FINGERS_HOLD_MS = 600;

const ALL: readonly number[] = [1, 2, 3, 4, 5];

export const createFingersActivity: ActivityFactory = (random) => {
  const target = randInt(random, 1, 5);
  const choices: readonly ActivityChoice[] = ALL.map((n) => ({
    id: `fingers-${n}`,
    digit: n,
    labelKey: "choice.fingers",
    labelValues: { n },
    correct: n === target,
  }));

  const activity: Activity = {
    kind: "fingers",
    promptKey: "act.fingers.prompt",
    promptValues: { n: target },
    retryKey: "act.fingers.retry",
    tapHintKey: "act.fingers.tap",
    holdMs: FINGERS_HOLD_MS,
    matches: (frame) => frame.totalFingers === target,
    choices,
  };
  return activity;
};
