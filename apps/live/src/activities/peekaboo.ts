// దాగుడుమూతలు — the child hides their face, Chiku loses them, they pop back,
// Chiku is delighted.
//
// The oldest game there is, and the one with the most going on inside it:
// object permanence (Chiku still exists behind your hands), turn-taking (hide,
// then reveal, then Chiku reacts, then again), and shared attention. For the
// youngest end of the band it is the only activity here that needs no counting,
// no colour word and no instruction-following — a two-year-old plays it.
//
// THE FAILURE THIS FILE IS MOSTLY ABOUT
// -------------------------------------
// "The face went away" is not "the child hid". A child who walks out of the
// room, a child who turns to talk to a parent, a tracker that drops three
// frames on a slow phone — all of those look identical to hiding if you only
// watch `face`. Chiku congratulating a child for LEAVING is worse than not
// noticing they hid: it is Chiku plainly not looking.
//
// So the game is armed by the hands, not by the absence:
//
//   1. ARM      the child's own hands come up to their own face, and stay
//               there for two frames, while the face is still visible.
//   2. HIDDEN   only then does the face going away mean anything — and it has
//               to stay away for three frames, so one dropped detection is a
//               dropped detection.
//   3. FOUND    the face comes back. That, and only that, is the answer.
//
// A child walking out of frame never reaches step 1, so they never reach step
// 3. And a hide that lasts longer than `HIDE_MAX_MS` is disarmed: at some point
// the child has genuinely gone, and Chiku should not be waiting to cheer at
// whoever walks past next.
//
// `facePresence`, not `face === null`, decides whether the child is still
// BELIEVED to be there, for the Phase 1 reason: the raw signal blinks and the
// belief does not. The raw signal still decides when the face is visible right
// now, because that is what it is for — the two are different questions and
// this file asks both.

import {
  childHands,
  FACE_BELIEVED,
  FaceAnchor,
  matchesAnswer,
  optionalCopyKey,
  perFrame,
  type Activity,
  type ActivityChoice,
  type ActivityFactory,
  type DemoBeat,
  type SpokenAnswers,
} from "./types";

/**
 * Short. The reveal is an instant, not a pose — asking a child to hold "here I
 * am" would be asking them to stop playing peekaboo and start posing, and the
 * three-frame disappearance above has already done the debouncing.
 */
export const PEEKABOO_HOLD_MS = 300;

/**
 * How close a wrist must be to the face centre to count as covering it, in
 * normalized image units. Generous: small hands do not cover a face neatly,
 * and children hide behind one hand, a sleeve, or the edge of a cushion held
 * near their cheek. The thing being excluded is a hand resting in a lap.
 */
export const HIDE_RADIUS = 0.28;

/** Frames of hands-on-face, while the face is still visible, that arm the game. */
export const PEEKABOO_ARM_FRAMES = 2;

/**
 * Frames the face must be gone before it counts as hidden.
 *
 * Three, not one. One is a tracker blink, which happens constantly and would
 * otherwise let a child "win" peekaboo without ever moving.
 */
export const PEEKABOO_HIDE_FRAMES = 3;

/**
 * After this long behind the hands it is not a game any more.
 *
 * Six seconds is far past any real peekaboo and comfortably inside "the child
 * put their hands down and wandered off". Past it the game disarms, so the
 * next face to appear — a sibling, a parent, the child returning ten minutes
 * later — is not greeted as a reveal.
 */
export const PEEKABOO_HIDE_MAX_MS = 6000;

/** How long each half of the demonstration lasts. */
export const PEEKABOO_BEAT_MS = 800;

const DEMO_HIDE_KEY = optionalCopyKey("demo.peekaboo.hide");
const DEMO_PEEK_KEY = optionalCopyKey("demo.peekaboo.peek");

/**
 * What a child shouts when they reappear. This is the one activity whose
 * spoken answer is not a description of the answer — it IS the answer, because
 * peekaboo is a call-and-response and the call is a word.
 */
const PEEK_ANSWERS: SpokenAnswers = {
  te: [
    "ఇదుగో",
    "ఇక్కడ",
    "ఇక్కడ ఉన్నాను",
    "దాగుడుమూతలు",
    "idugo",
    "ikkada",
    "ikkada unnanu",
    "daagudu moothalu",
    "dagudumutalu",
  ],
  en: ["peekaboo", "peek a boo", "boo", "here i am", "here", "i am here", "found me"],
};

const HIDING: ActivityChoice = {
  id: "peekaboo-hiding",
  glyph: "hide",
  labelKey: "choice.peekaboo.hiding",
  correct: false,
};
const PEEKING: ActivityChoice = {
  id: "peekaboo-peeking",
  glyph: "peek",
  labelKey: "choice.peekaboo.peek",
  correct: true,
};

/** Where the game is right now. There is no "failed" — only "not yet". */
type Phase = "seeking" | "hidden" | "found";

export const createPeekabooActivity: ActivityFactory = (random) => {
  const flip = random() < 0.5;

  const anchorOf = new FaceAnchor();
  let phase: Phase = "seeking";
  let armFrames = 0;
  let goneFrames = 0;
  let hiddenSince = 0;
  /** Have we ever actually seen this child? Until then there is no game. */
  let everSeen = false;

  const advance = perFrame((frame) => {
    // Stepped every frame, including the blank ones — this is what keeps the
    // belief decaying at the right rate.
    const anchor = anchorOf.update(frame);

    if (frame.face !== null) {
      everSeen = true;
      goneFrames = 0;
      if (phase === "hidden") {
        // The whole point of the activity, in one line.
        phase = "found";
      } else if (phase === "seeking") {
        const near =
          anchor === null
            ? false
            : childHands(frame, anchor).some(
                (h) =>
                  Math.hypot(h.wrist.x - anchor.x, h.wrist.y - anchor.y) <= HIDE_RADIUS,
              );
        // Armed by the LAST thing we saw them do, so hands that came up and
        // went down again do not leave the game cocked for the rest of the
        // round. Saturating rather than unbounded: the count is a debounce.
        armFrames = near ? Math.min(armFrames + 1, PEEKABOO_ARM_FRAMES) : 0;
      }
    } else {
      goneFrames += 1;
      if (
        phase === "seeking" &&
        armFrames >= PEEKABOO_ARM_FRAMES &&
        goneFrames >= PEEKABOO_HIDE_FRAMES
      ) {
        phase = "hidden";
        hiddenSince = frame.t;
      }
      if (
        phase === "hidden" &&
        (frame.t - hiddenSince > PEEKABOO_HIDE_MAX_MS || anchorOf.belief < FACE_BELIEVED)
      ) {
        // Not a game any more. Back to the start, disarmed, so the next face
        // through the door is not greeted as this child reappearing.
        phase = "seeking";
        armFrames = 0;
      }
    }

    // Evidence, spelled out because every clause is a different real child:
    //   never seen anyone       — nothing to have an opinion about.
    //   visible, or hiding, or
    //   already found           — the game is running; this frame speaks.
    //   gone, unarmed, and past
    //   the blink budget        — they walked out of the room. Unknown, and
    //                             that costs them nothing.
    const gone = frame.face === null;
    const walkedOut = gone && phase === "seeking" && goneFrames > PEEKABOO_HIDE_FRAMES;
    return { readable: everSeen && !walkedOut, found: phase === "found" };
  });

  const activity: Activity = {
    kind: "peekaboo",
    promptKey: "act.peekaboo.prompt",
    retryKey: "act.peekaboo.retry",
    tapHintKey: "act.peekaboo.tap",
    holdMs: PEEKABOO_HOLD_MS,
    // Latched: once the child has popped back out they have played peekaboo,
    // and nothing they do afterwards un-plays it. The latch is also what lets
    // the 300ms hold complete on a child who immediately hides again.
    matches: (frame) => advance(frame).found,
    hasEvidence: (frame) => advance(frame).readable,
    choices: flip ? [PEEKING, HIDING] : [HIDING, PEEKING],
    answers: PEEK_ANSWERS,
    accepts: (utterance) => matchesAnswer(utterance, PEEK_ANSWERS),
    // Chiku takes the first turn. That is not decoration — peekaboo is a
    // turn-taking game, and a child who watches Chiku hide and come back knows
    // what is being asked without a single word of instruction, which is the
    // point of the "watch" rung.
    demonstrate: (): readonly DemoBeat[] => [
      {
        ...(DEMO_HIDE_KEY ? { key: DEMO_HIDE_KEY } : {}),
        emote: "thinking",
        ms: PEEKABOO_BEAT_MS,
      },
      {
        ...(DEMO_PEEK_KEY ? { key: DEMO_PEEK_KEY } : {}),
        emote: "happy",
        ms: PEEKABOO_BEAT_MS,
      },
    ],
  };
  return activity;
};
