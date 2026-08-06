// "Show me THREE fingers!" — counting with the body.
//
// The target is randomised per round so the same run is never the same twice.
// 600ms hold: a 3-year-old's hand passes through 2 and 4 on the way to 3, and
// MediaPipe will happily report every one of them.

import {
  matchesAnswer,
  randInt,
  type Activity,
  type ActivityChoice,
  type ActivityFactory,
  type SpokenAnswers,
} from "./types";

export const FINGERS_HOLD_MS = 600;

const ALL: readonly number[] = [1, 2, 3, 4, 5];

/**
 * What "3" sounds like. The Telugu row is script AND the Latin spellings a
 * recogniser actually emits — a child says "moodu" whether the mic is set to
 * te-IN or en-IN, and only one of those two returns Telugu characters.
 * Bare digits are in the en row because that is what en-IN writes for "three".
 */
interface NumberWords {
  readonly n: number;
  readonly answers: SpokenAnswers;
}

const NUMBER_WORDS: readonly NumberWords[] = [
  { n: 1, answers: { te: ["ఒకటి", "ఒక్కటి", "okati", "okkati", "oka"], en: ["one", "1"] } },
  { n: 2, answers: { te: ["రెండు", "rendu", "rendo", "reddu"], en: ["two", "2"] } },
  { n: 3, answers: { te: ["మూడు", "moodu", "mudu", "muudu", "mudhu"], en: ["three", "3"] } },
  { n: 4, answers: { te: ["నాలుగు", "naalugu", "nalugu", "nalgu"], en: ["four", "4"] } },
  { n: 5, answers: { te: ["ఐదు", "aidu", "aydu", "ayidu"], en: ["five", "5"] } },
];

const NO_WORDS: SpokenAnswers = { te: [], en: [] };

export const createFingersActivity: ActivityFactory = (random) => {
  const target = randInt(random, 1, 5);
  const choices: readonly ActivityChoice[] = ALL.map((n) => ({
    id: `fingers-${n}`,
    digit: n,
    labelKey: "choice.fingers",
    labelValues: { n },
    correct: n === target,
  }));
  const answers = NUMBER_WORDS.find((w) => w.n === target)?.answers ?? NO_WORDS;

  const activity: Activity = {
    kind: "fingers",
    promptKey: "act.fingers.prompt",
    promptValues: { n: target },
    retryKey: "act.fingers.retry",
    tapHintKey: "act.fingers.tap",
    holdMs: FINGERS_HOLD_MS,
    matches: (frame) => frame.totalFingers === target,
    // null is "the hand was too ambiguous to count", which is the single most
    // common frame during the wobble between two counts — and it used to reset
    // the hold. It is not a wrong answer; it is no answer.
    hasEvidence: (frame) => frame.totalFingers !== null,
    choices,
    answers,
    accepts: (utterance) => matchesAnswer(utterance, answers),
  };
  return activity;
};
