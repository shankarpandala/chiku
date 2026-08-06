// "Show Chiku your biggest smile!" — the only activity where Chiku's own face
// is the feedback: the rig mirrors the smile back while the child holds it.
//
// The threshold is deliberately generous. This is never scored (§9) — it is a
// reason to smile at each other, not a measurement.

import { HysteresisGate, type Hysteresis } from "../vision/stability";
import {
  matchesAnswer,
  type Activity,
  type ActivityChoice,
  type ActivityFactory,
  type SpokenAnswers,
} from "./types";

export const SMILE_HOLD_MS = 500;

/**
 * Smile strength that starts counting as a smile. Unchanged — the acquire side
 * was never the problem.
 */
export const SMILE_THRESHOLD = 0.45;

/**
 * Strict to acquire, loose to keep.
 *
 * A blendshape score is a continuous wobble, not a discrete state, so a child
 * holding a real smile sits at 0.44 / 0.46 / 0.43 / 0.47 and a single
 * threshold turns that into on/off/on/off — which reset the hold and, in the
 * mirroring path, made Chiku's own mouth snap. The exit is 0.38: below that a
 * face genuinely is not smiling any more.
 */
export const SMILE_BAND: Hysteresis = Object.freeze({ enter: SMILE_THRESHOLD, exit: 0.38 });

/**
 * A smile cannot be spoken, so the spoken answer is the word for it — a child
 * who cannot use the camera can still name the happy face out loud, the same
 * thing the tap answer asks them to point at.
 */
const SMILE_ANSWERS: SpokenAnswers = {
  te: ["నవ్వు", "నవ్వుతున్నాను", "సంతోషం", "navvu", "navvutunnanu", "santosham", "santhosham"],
  en: ["smile", "smiling", "happy", "happy face", "haha", "hehe"],
};

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
  // One gate per activity instance — a round builds a fresh activity, so the
  // gate cannot leak a smile from a previous round into this one.
  const gate = new HysteresisGate(SMILE_BAND);
  const activity: Activity = {
    kind: "smile",
    promptKey: "act.smile.prompt",
    retryKey: "act.smile.retry",
    tapHintKey: "act.smile.tap",
    holdMs: SMILE_HOLD_MS,
    // A frame with no face is not "not smiling" — it carries no evidence, and
    // hasEvidence keeps it away from the gate entirely.
    matches: (frame) => (frame.face === null ? false : gate.update(frame.face.smile)),
    hasEvidence: (frame) => frame.face !== null,
    choices: flip ? [SAD, HAPPY] : [HAPPY, SAD],
    answers: SMILE_ANSWERS,
    accepts: (utterance) => matchesAnswer(utterance, SMILE_ANSWERS),
  };
  return activity;
};
