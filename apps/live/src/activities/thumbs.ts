// 👍 / 👎 — the mic-free comprehension path.
//
// WHY THIS ONE EXISTS AT ALL
// --------------------------
// Every other activity asks the child to DO a thing. None of them can ask
// "did you understand?". Speech could — and on most of the devices this will
// actually run on there is no on-device recogniser at all, so speech is either
// off or it is a network call a parent has to consent to. Without a gestural
// yes/no, a child who cannot talk to Chiku has no way, ever, to show that they
// followed something. A thumb is that way. It is the only channel in the app
// through which comprehension (rather than imitation) can travel.
//
// WHY THE QUESTIONS ARE ABOUT THIS SESSION'S OWN VOCABULARY
// ---------------------------------------------------------
// Size (పెద్ద/చిన్న), the successor step, and the colour words are exactly what
// the other four activities teach. Asking about anything else would make this a
// general-knowledge quiz, which is not what it is for: the point is to close
// the loop on something the child met five minutes ago.
//
// WHY THE CANNED GESTURE IS NOT TRUSTED ON ITS OWN
// ------------------------------------------------
// `Thumb_Up` and `Thumb_Down` are the strongest classes MediaPipe's gesture
// recogniser has — and they are not rotation-invariant. A child lying on the
// floor, or holding their hand sideways, gets a confidently WRONG label, and a
// confidently wrong label here is Chiku telling a child they answered "no" when
// they meant "yes". So the label has to AGREE with the hand's shape before it
// counts, and any disagreement produces no evidence instead of an answer:
//
//   label + thumb-only shape  →  that answer
//   label, but the shape says otherwise  →  unknown (probably rotated)
//   thumb-only shape, no label  →  unknown (the classifier bailed, as it does
//                                  on a rotated hand — so we bail too)
//   two hands that disagree  →  unknown (someone else is answering)
//
// DEVIATION, RECORDED: the brief asked for thumb LANDMARK geometry as the
// confirmation. `VisionFrame` does not carry landmarks — `HandSignal` is
// {handedness, fingers, extended[5], gesture, wrist} — and `vision/` is outside
// this change. The shape test below (`extended`, which IS derived from the
// landmarks, upstream) is the strongest rotation-independent confirmation
// available at this layer. A hand rotated far enough that the classifier flips
// its label while still reading as thumb-only would still be believed; closing
// that needs a thumb-tip-vs-wrist vector on `HandSignal`.

import type { HandSignal, VisionFrame } from "../vision/types";
import {
  copyKey,
  matchesAnswer,
  optionalCopyKey,
  randInt,
  type Activity,
  type ActivityChoice,
  type ActivityFactory,
  type DemoBeat,
  type SpokenAnswers,
} from "./types";

/**
 * Longer than the wave, shorter than the finger count. A thumb is a settled,
 * deliberate pose — but it is also the pose a child holds while looking at
 * Chiku for a reaction, so it must not need to be held like a plank.
 */
export const THUMBS_HOLD_MS = 500;

/** MediaPipe's own class names. Not ours to rename. */
export const THUMB_UP_GESTURE = "Thumb_Up";
export const THUMB_DOWN_GESTURE = "Thumb_Down";

/** How long Chiku holds each thumb on the "watch me" rung. */
export const THUMBS_BEAT_MS = 900;

const DEMO_YES_KEY = optionalCopyKey("demo.thumbs.yes");
const DEMO_NO_KEY = optionalCopyKey("demo.thumbs.no");

/** "Yes" and "no", as a Telugu-first child says them — script and Latin. */
const YES_ANSWERS: SpokenAnswers = {
  te: ["అవును", "ఔను", "అవునౌను", "సరే", "avunu", "avnu", "aunu", "ahaan", "sare"],
  en: ["yes", "yeah", "yep", "yup", "yes it is", "true", "correct", "right"],
};
const NO_ANSWERS: SpokenAnswers = {
  te: ["కాదు", "లేదు", "కాదండి", "kaadu", "kadu", "ledu", "leedu", "kaadhu"],
  en: ["no", "nope", "not", "no it is not", "false", "wrong"],
};

/** The two buttons. Which one is right depends on the question, not the shape. */
function yesChoice(correct: boolean): ActivityChoice {
  return { id: "thumbs-yes", glyph: "thumbUp", labelKey: "choice.thumbs.yes", correct };
}
function noChoice(correct: boolean): ActivityChoice {
  return { id: "thumbs-no", glyph: "thumbDown", labelKey: "choice.thumbs.no", correct };
}

/**
 * The question bank: three yes and three no, each one about something another
 * activity in this app teaches.
 *
 * Balanced on purpose. A bank that skewed towards "yes" would be answerable by
 * a child who has worked out that the thumb pointing up makes Chiku happy —
 * which is a real thing 4-year-olds do, and it would make this measure
 * agreeableness instead of comprehension.
 */
export interface ThumbsQuestion {
  readonly id: string;
  /** The question, as an i18n key present in both dictionaries. */
  readonly key: string;
  readonly yes: boolean;
}

/** The question every impossible branch falls back to. Also the first one. */
export const THUMBS_FALLBACK: ThumbsQuestion = {
  id: "elephantBig",
  key: "act.thumbs.q.elephantBig",
  yes: true,
};

export const THUMBS_QUESTIONS: readonly ThumbsQuestion[] = [
  // Size — the bigsmall pair.
  THUMBS_FALLBACK,
  { id: "antBig", key: "act.thumbs.q.antBig", yes: false },
  // The successor step.
  { id: "afterThree", key: "act.thumbs.q.afterThree", yes: true },
  { id: "afterTwo", key: "act.thumbs.q.afterTwo", yes: false },
  // Colour words — the hunt.
  { id: "skyBlue", key: "act.thumbs.q.skyBlue", yes: true },
  { id: "grassRed", key: "act.thumbs.q.grassRed", yes: false },
];

/** "Up", "down", or "we could not tell" — the whole detection, in one place. */
export type ThumbVerdict = "up" | "down" | null;

/**
 * Thumb out, every other finger curled — the shape, independent of which way
 * the hand is pointing. `extended` is thumb-first (vision/types.ts).
 */
export function isThumbOnlyShape(hand: HandSignal): boolean {
  const [thumb, index, middle, ring, pinky] = hand.extended;
  return thumb && !index && !middle && !ring && !pinky;
}

/** The canned label, or null when it is not a thumb label at all. */
function labelOf(hand: HandSignal): ThumbVerdict {
  if (hand.gesture === THUMB_UP_GESTURE) return "up";
  if (hand.gesture === THUMB_DOWN_GESTURE) return "down";
  return null;
}

/**
 * One frame's thumb answer. Null means "no evidence" for every reason there
 * is: no thumb, a label the shape contradicts, a shape with no label, or two
 * hands saying different things.
 */
export function thumbVerdict(frame: VisionFrame): ThumbVerdict {
  let seen: ThumbVerdict = null;
  for (const hand of frame.hands) {
    const label = labelOf(hand);
    const shaped = isThumbOnlyShape(hand);
    // A hand that is doing neither is simply not part of this question — a
    // child rests one hand in their lap while answering with the other.
    if (label === null && !shaped) continue;
    // Label and shape must agree. Either one alone is the rotated-hand case.
    if (label === null || !shaped) return null;
    if (seen !== null && seen !== label) return null;
    seen = label;
  }
  return seen;
}

export const createThumbsActivity: ActivityFactory = (random) => {
  // The bank is a non-empty literal, so the fallback is a type narrowing under
  // `noUncheckedIndexedAccess` rather than a branch anything can reach.
  const question =
    THUMBS_QUESTIONS[randInt(random, 0, THUMBS_QUESTIONS.length - 1)] ?? THUMBS_FALLBACK;
  const yes = question.yes;
  const wanted: ThumbVerdict = yes ? "up" : "down";
  const answers = yes ? YES_ANSWERS : NO_ANSWERS;

  const flip = random() < 0.5;

  const activity: Activity = {
    kind: "thumbs",
    // The prompt IS the question. `copyKey` resolves it against en.json, so a
    // question whose copy has not landed degrades to the retry line instead of
    // taking the surface down on a missing key.
    promptKey: copyKey(question.key, "act.thumbs.retry"),
    retryKey: "act.thumbs.retry",
    tapHintKey: "act.thumbs.tap",
    holdMs: THUMBS_HOLD_MS,
    matches: (frame) => thumbVerdict(frame) === wanted,
    hasEvidence: (frame) => thumbVerdict(frame) !== null,
    // The tap answers are always yes-then-no or no-then-yes, never reordered by
    // correctness — a child must not be able to learn the position.
    choices: flip
      ? [noChoice(!yes), yesChoice(yes)]
      : [yesChoice(yes), noChoice(!yes)],
    answers,
    accepts: (utterance) => matchesAnswer(utterance, answers),
    // Chiku shows BOTH thumbs, in order, and never the answer to this
    // question. The help a stuck child needs here is "what is a thumbs-down",
    // not "the answer is no" — showing the answer would turn the one
    // comprehension check in the app into a copying exercise.
    demonstrate: (): readonly DemoBeat[] => [
      {
        ...(DEMO_YES_KEY ? { key: DEMO_YES_KEY } : {}),
        emote: "happy",
        ms: THUMBS_BEAT_MS,
      },
      {
        ...(DEMO_NO_KEY ? { key: DEMO_NO_KEY } : {}),
        emote: "thinking",
        ms: THUMBS_BEAT_MS,
      },
    ],
  };
  return activity;
};
