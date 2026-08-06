// "Show me THREE fingers!" — counting with the body.
//
// The target is randomised per round so the same run is never the same twice.
// 600ms hold: a 3-year-old's hand passes through 2 and 4 on the way to 3, and
// MediaPipe will happily report every one of them.

import {
  matchesAnswer,
  optionalCopyKey,
  randInt,
  type Activity,
  type ActivityChoice,
  type ActivityFactory,
  type DemoBeat,
  type SpokenAnswers,
} from "./types";

export const FINGERS_HOLD_MS = 600;

/**
 * One number per beat, said out loud. 420ms is a counting rhythm rather than a
 * recital: five of them is 2.1s, which is the whole budget a stuck
 * three-year-old will give a demonstration before looking away.
 */
export const COUNT_BEAT_MS = 420;

/**
 * "One!", "Two!", … — the numbers Chiku says while he counts on his own trunk.
 *
 * Resolved once, and `undefined` when the copy has not landed: the beat then
 * plays as a silent counting pulse instead of taking the surface down on a
 * missing key. See `optionalCopyKey`.
 */
const COUNT_KEYS: readonly (ReturnType<typeof optionalCopyKey>)[] = [1, 2, 3, 4, 5].map((n) =>
  optionalCopyKey(`demo.count.${n}`),
);

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
    // Chiku counts to the target himself, one number per beat, ending on the
    // happy face he wants the child to be looking at when they try again. A
    // child who cannot follow "show me three" can very often copy "one, two,
    // three" — that is the entire reason this rung exists.
    demonstrate: (): readonly DemoBeat[] => {
      const beats: DemoBeat[] = [];
      for (let n = 1; n <= target; n += 1) {
        const key = COUNT_KEYS[n - 1];
        beats.push({
          ...(key ? { key, values: { n } } : {}),
          emote: n === target || n % 2 === 0 ? "happy" : "encouraging",
          ms: COUNT_BEAT_MS,
        });
      }
      return beats;
    },
  };
  return activity;
};
