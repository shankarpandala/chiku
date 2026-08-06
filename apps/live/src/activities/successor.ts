// "ఇంకో వేలు!" — the successor function, played on one hand.
//
// Chiku asks for N fingers, the child shows N, and then Chiku asks for ONE
// MORE. That second beat is the whole activity: the idea that a number has a
// next one, and that you get to it by adding exactly one, is the thing actually
// underneath counting. A child who can recite "one two three four five" and
// cannot answer "what comes after three" has learned a song, not a number line;
// Gelman & Gallistel's successor principle is the bit that turns the song into
// arithmetic, and it is reachable years before anyone can write a digit.
//
// WHY THE BASE IS 1-3
// -------------------
// So that N+1 is at most 4 and stays on ONE hand. Crossing to a second hand
// turns "add one finger" into "start again over here", which is a different and
// much harder motor task, and the child's mistake would then be about hands
// rather than about numbers.
//
// WHY THIS DOES NOT COUNT FINGERS ITSELF
// -------------------------------------
// It reads `frame.totalFingers`, exactly as `fingers.ts` does. That number is
// subject-locked in the engine — it is the PRIMARY person's hands and nobody
// else's — so a sibling's two fingers cannot turn the child's 3 into 5. Any
// re-implementation here that summed `frame.hands` would quietly lose that
// property, which is why this file has no geometry in it at all.

import {
  matchesAnswer,
  NO_SPOKEN_ANSWERS,
  NUMBER_WORDS,
  optionalCopyKey,
  perFrame,
  randInt,
  type Activity,
  type ActivityChoice,
  type ActivityFactory,
  type DemoBeat,
} from "./types";

/** Same 600ms as the plain finger count: a hand passes THROUGH 3 to reach 4. */
export const SUCCESSOR_HOLD_MS = 600;

/**
 * Frames of N the child must show before "one more" is armed.
 *
 * Two, not one, for the reason every threshold in this app is frame-counted: a
 * hand opening from a fist flickers through every count on the way, and a
 * single frame of 3 in the middle of that flicker is not a child showing three.
 * Two is also the smallest number that is not one — the bar is anti-flicker,
 * not a test of stillness, and a 3-year-old cannot pass a test of stillness.
 */
export const SUCCESSOR_BASE_FRAMES = 2;

/**
 * The anti-stuck valve: frames of N+1, shown without ever having settled on N,
 * that count as having made the step anyway.
 *
 * A child who anticipates — who hears "three, and one more" and puts up four
 * straight away — has done something MORE impressive than the step, and a
 * literal reading of "must pass through N first" would leave them holding the
 * right answer at a Chiku who never reacts. Eight frames is 1.6s on the slow
 * device we target: long enough that it is a held answer rather than a hand
 * sweeping past, short enough that nobody is stranded.
 */
export const SUCCESSOR_DIRECT_FRAMES = 8;

/** One number per beat. A counting rhythm, not a recital. */
export const SUCCESSOR_BEAT_MS = 420;

/** "One!", "Two!"… reused from the counting demo rather than re-written. */
const COUNT_KEYS: readonly (ReturnType<typeof optionalCopyKey>)[] = [1, 2, 3, 4, 5].map((n) =>
  optionalCopyKey(`demo.count.${n}`),
);

/** "One more — now it's four!" Silent if the copy has not landed. */
const DEMO_MORE_KEY = optionalCopyKey("demo.successor.more");

/** The full hand, so the tap answer looks like the counting game's. */
const ALL: readonly number[] = [1, 2, 3, 4, 5];

/** Smallest and largest base. `max + 1` must still fit on one hand. */
export const SUCCESSOR_BASE_MIN = 1;
export const SUCCESSOR_BASE_MAX = 3;

export const createSuccessorActivity: ActivityFactory = (random) => {
  const base = randInt(random, SUCCESSOR_BASE_MIN, SUCCESSOR_BASE_MAX);
  const next = base + 1;

  const choices: readonly ActivityChoice[] = ALL.map((n) => ({
    id: `successor-${n}`,
    digit: n,
    labelKey: "choice.fingers",
    labelValues: { n },
    correct: n === next,
  }));

  // The answer out loud is the SUCCESSOR, not the base — "what comes after
  // three" is answered with "four".
  const answers = NUMBER_WORDS[next] ?? NO_SPOKEN_ANSWERS;

  /* The step, as a two-state machine over frames. */
  let baseFrames = 0;
  let directFrames = 0;
  let stepped = false;

  const advance = perFrame((frame) => {
    const count = frame.totalFingers;
    if (count === null) return { count, stepped };
    if (!stepped) {
      if (count === base) {
        baseFrames += 1;
        // Going back to the base undoes an anticipation run: the child is
        // building up to the step rather than having already made it.
        directFrames = 0;
        if (baseFrames >= SUCCESSOR_BASE_FRAMES) stepped = true;
      } else if (count === next) {
        directFrames += 1;
        if (directFrames >= SUCCESSOR_DIRECT_FRAMES) stepped = true;
      } else {
        baseFrames = 0;
        directFrames = 0;
      }
    }
    return { count, stepped };
  });

  const activity: Activity = {
    kind: "successor",
    promptKey: "act.successor.prompt",
    promptValues: { n: base, next },
    retryKey: "act.successor.retry",
    tapHintKey: "act.successor.tap",
    holdMs: SUCCESSOR_HOLD_MS,
    matches: (frame) => {
      const state = advance(frame);
      return state.stepped && state.count === next;
    },
    // Identical to the counting game's: null is "the hand was too ambiguous to
    // count", which is the single most common frame during the wobble between
    // two counts. It is not a wrong answer, it is no answer.
    hasEvidence: (frame) => {
      advance(frame);
      return frame.totalFingers !== null;
    },
    choices,
    answers,
    accepts: (utterance) => matchesAnswer(utterance, answers),
    // Chiku counts up to the base and then, visibly, adds one. The pause
    // between the last count and the "one more" is what makes the step
    // legible — without it this is just counting to four.
    demonstrate: (): readonly DemoBeat[] => {
      const beats: DemoBeat[] = [];
      for (let n = 1; n <= base; n += 1) {
        const key = COUNT_KEYS[n - 1];
        beats.push({
          ...(key ? { key, values: { n } } : {}),
          emote: n === base ? "happy" : "encouraging",
          ms: SUCCESSOR_BEAT_MS,
        });
      }
      beats.push({
        ...(DEMO_MORE_KEY ? { key: DEMO_MORE_KEY, values: { n: base, next } } : {}),
        emote: "happy",
        ms: SUCCESSOR_BEAT_MS + 220,
      });
      return beats;
    },
  };
  return activity;
};
