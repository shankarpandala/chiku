// "పెద్ద… చిన్న!" — make yourself BIG, then make yourself small.
//
// Whole-arm gross motor, which is what a 3-to-8-year-old is genuinely good at:
// a child who cannot yet isolate three fingers can absolutely throw both arms
// over their head. It teaches the size antonym pair te-first — పెద్ద/చిన్న, the
// two words a Telugu-speaking child hears about size all day — and it does it
// as a PAIR, because an antonym only means anything against its opposite.
//
// WHY THE SIGNAL IS THE EASIEST ONE IN THE APP
// --------------------------------------------
// "Both wrists above the face" and "both wrists low and tucked in" are
// separated by most of the frame. Compare the finger count, where 3 and 4
// differ by one joint angle. There is no threshold here that a child can sit
// on top of, which is why this is the activity that keeps working in a dim
// room, at TV distance, on the slow device.
//
// COORDINATE SPACES ARE A REAL BUG HERE
// -------------------------------------
// `face.y` is -1 at the top of the image and +1 at the bottom; `wrist.y` is 0
// at the top and 1 at the bottom. Comparing them directly reads as working —
// both grow downwards — and is wrong by a factor of two and an offset. Every
// comparison below goes through `faceImagePoint`, which is the exact inverse of
// what `vision/gaze.ts` did on the way out.
//
// AND WHOSE HANDS THESE ARE MATTERS
// ---------------------------------
// `frame.hands` is EVERYONE's hands — only `totalFingers` is subject-locked. So
// the hands are filtered to arm's reach of the child's own face, and a frame
// left with anything other than exactly two candidates produces NO EVIDENCE
// rather than an answer: a sibling leaning in makes the frame unreadable, which
// is the truth, and unreadable costs the child nothing.

import type { HandSignal } from "../vision/types";
import {
  childHands,
  FaceAnchor,
  matchesAnswer,
  perFrame,
  optionalCopyKey,
  type Activity,
  type ActivityChoice,
  type ActivityFactory,
  type DemoBeat,
  type ImagePoint,
  type SpokenAnswers,
} from "./types";

/** Half a second. The pose is huge; the hold is only there to survive noise. */
export const BIGSMALL_HOLD_MS = 500;

/**
 * How far ABOVE the face centre a wrist must be to count as "big", in
 * normalized image units. Small on purpose: arms up puts a wrist near the top
 * of frame, but a child close to the camera, or one whose hands clip the top
 * edge, will land only a little above their own face — and the failure we care
 * about is a resting hand at chest height, which is nowhere near.
 */
export const BIG_MARGIN = 0.08;

/** How far BELOW the face centre both wrists must fall to count as "small". */
export const SMALL_DROP = 0.18;

/**
 * How far apart the two wrists may be and still read as "tucked in".
 *
 * Without this, arms held straight out sideways at hip height would score as
 * "small" — which is the opposite pose, and the one thing this activity must
 * not confuse, since the whole lesson is that the two are opposites.
 */
export const SMALL_SPREAD = 0.35;

/** Frames of BIG before the second half is armed. Anti-flicker, nothing more. */
export const BIGSMALL_STAGE_FRAMES = 2;

/** Long enough to read as a pose rather than a twitch. */
export const BIGSMALL_BEAT_MS = 900;

/** "Like this — BIG!" / "And now — small!". Silent if the copy has not landed. */
const DEMO_BIG_KEY = optionalCopyKey("demo.bigsmall.big");
const DEMO_SMALL_KEY = optionalCopyKey("demo.bigsmall.small");

/**
 * The spoken answer is the word the round ENDS on — చిన్న.
 *
 * Only the small half is listed, and that is not an oversight: a child who
 * names both ("pedda… chinna!") still matches, because `matchesAnswer` looks
 * for the word anywhere in the utterance. Listing పెద్ద as well would accept a
 * child who only ever said "big", which is half the lesson.
 */
const SMALL_ANSWERS: SpokenAnswers = {
  te: ["చిన్న", "చిన్నది", "చిన్నగా", "chinna", "chinnadi", "chinnaga", "china", "chinni"],
  en: ["small", "smaller", "little", "tiny", "small one", "little one"],
};

const BIG: ActivityChoice = {
  id: "bigsmall-big",
  glyph: "big",
  labelKey: "choice.bigsmall.big",
  correct: false,
};
const SMALL: ActivityChoice = {
  id: "bigsmall-small",
  glyph: "small",
  labelKey: "choice.bigsmall.small",
  correct: true,
};

/** Both wrists clear of the top of the child's head. */
export function isBigPose(hands: readonly HandSignal[], anchor: ImagePoint): boolean {
  if (hands.length !== 2) return false;
  return hands.every((h) => h.wrist.y <= anchor.y - BIG_MARGIN);
}

/** Both wrists well below the face AND close together — curled up, not spread. */
export function isSmallPose(hands: readonly HandSignal[], anchor: ImagePoint): boolean {
  const [a, b] = hands;
  if (hands.length !== 2 || a === undefined || b === undefined) return false;
  const low = a.wrist.y >= anchor.y + SMALL_DROP && b.wrist.y >= anchor.y + SMALL_DROP;
  return low && Math.abs(a.wrist.x - b.wrist.x) <= SMALL_SPREAD;
}

export const createBigSmallActivity: ActivityFactory = (random) => {
  // Only the presentation order of the tap answers is random — the pose
  // sequence is always big-then-small, because that is the sentence.
  const flip = random() < 0.5;

  const anchorOf = new FaceAnchor();
  let bigFrames = 0;
  let wentBig = false;

  const advance = perFrame((frame) => {
    const anchor = anchorOf.update(frame);
    if (anchor === null) return { readable: false, small: false, wentBig };
    const hands = childHands(frame, anchor);
    // Exactly two, or we cannot tell whose pose this is: one hand is a lost
    // hand, three is a sibling in the frame. Both are "unknown", never "wrong".
    if (hands.length !== 2) return { readable: false, small: false, wentBig };

    if (!wentBig) {
      if (isBigPose(hands, anchor)) {
        bigFrames += 1;
        if (bigFrames >= BIGSMALL_STAGE_FRAMES) wentBig = true;
      } else {
        bigFrames = 0;
      }
    }
    return { readable: true, small: isSmallPose(hands, anchor), wentBig };
  });

  const activity: Activity = {
    kind: "bigsmall",
    promptKey: "act.bigsmall.prompt",
    retryKey: "act.bigsmall.retry",
    tapHintKey: "act.bigsmall.tap",
    holdMs: BIGSMALL_HOLD_MS,
    matches: (frame) => {
      const state = advance(frame);
      return state.readable && state.wentBig && state.small;
    },
    hasEvidence: (frame) => advance(frame).readable,
    choices: flip ? [SMALL, BIG] : [BIG, SMALL],
    answers: SMALL_ANSWERS,
    accepts: (utterance) => matchesAnswer(utterance, SMALL_ANSWERS),
    // Two beats, and the contrast between them IS the demonstration. `happy`
    // for big and `thinking` for small: the rig has no size, so the change of
    // face is what carries "these are two different things" on a device where
    // Chiku cannot be heard.
    demonstrate: (): readonly DemoBeat[] => [
      {
        ...(DEMO_BIG_KEY ? { key: DEMO_BIG_KEY } : {}),
        emote: "happy",
        ms: BIGSMALL_BEAT_MS,
      },
      {
        ...(DEMO_SMALL_KEY ? { key: DEMO_SMALL_KEY } : {}),
        emote: "thinking",
        ms: BIGSMALL_BEAT_MS,
      },
    ],
  };
  return activity;
};
