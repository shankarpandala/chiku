// "Find something ఎరుపు!" — the colour hunt, and the only activity whose
// answer is not on the child's body but somewhere in their own room.
//
// The child makes a window with their hands (palm, pinch or two-handed — see
// vision/quad.ts for why all three are accepted), points it at the red cushion,
// and the cushion is the only thing inside the window that keeps its colour.
// Chiku looks through the window with them.
//
// WHY THIS ONE IS DELIBERATELY EASY TO WIN
// ----------------------------------------
// The skill being practised is "which of these things is red", not "aim a
// viewfinder". A three-year-old holding a wobbling hand-frame at arm's length,
// with their own fingers eating the edges of it, will never fill it with the
// cushion — so the bar is 12% of the window (COVERAGE_FOUND), the hold is
// short, and the hue bands are tight rather than the bar being high. Tight band
// plus low bar means "some of this really is red" wins and "the window is full
// of my own hand" does not; the other way round would have Chiku congratulating
// children for pointing at their own skin, which teaches them the wrong word
// for it. See magicLens.ts.
//
// WHERE THE COVERAGE NUMBER COMES FROM
// ------------------------------------
// The render layer, not the vision layer — the lens already reads the window's
// pixels back in order to draw the drain effect, so measuring there is free and
// measuring twice would be two thresholds that can disagree while the child
// watches one of them glow. The surface merges the latest figure onto the frame
// as `windowCoverage` before this activity sees it (see vision/types.ts).
//
// NO WINDOW IS NOT A WRONG ANSWER. A child who has not worked out the gesture
// yet, or whose hands have left the frame, has produced no evidence — which the
// runner scores as "unknown", costing them nothing. That is Phase 1's whole
// point, and it matters more here than anywhere else: this is the one activity
// where the child has to build the input device before they can use it.

import { foundTarget, HUNT_ORDER, type HuntColour } from "../components/magicLens";
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

export type { HuntColour } from "../components/magicLens";
export { COVERAGE_FOUND } from "../components/magicLens";

/**
 * 400ms — the shortest hold of any activity, and shorter than the finger count
 * on purpose.
 *
 * A finger count needs 600ms because a hand passes THROUGH 2 and 4 on its way
 * to 3, so a short hold would fire on the wrong number. Coverage has no such
 * failure mode: a window sweeping across a room does not pass through "12% red"
 * on its way to something else, it either lands on the cushion or it does not.
 * The hold here is only there to survive one bright frame of a passing car
 * outside the window.
 */
export const HUNT_HOLD_MS = 400;

/**
 * How solid the window has to be before it counts as evidence at all.
 *
 * `presence` is a fade, not a boolean (vision/quad.ts). Deliberately BELOW
 * WINDOW_GAZE_PRESENCE (0.5, the point at which Chiku commits his eyes to the
 * window): a window that is still easing in is already a child trying, and
 * refusing to score it would mean the hunt only listens once Chiku has stopped
 * looking at the child. Above the noise floor, below the point of no return.
 */
export const HUNT_PRESENCE = 0.35;

/** How long Chiku holds the colour up on the "watch me" rung. */
export const HUNT_SWATCH_BEAT_MS = 1100;

/**
 * What each colour sounds like, in both languages.
 *
 * The Telugu rows carry script AND Latin spellings, for the same reason the
 * numbers do: on-device recognition running as en-IN hears "erupu" and writes
 * it in Latin letters, and a bilingual child in Hyderabad says "erupu" in the
 * middle of an English sentence anyway. `paccha` on its own is accepted for
 * green because that is what children actually say — the full "ఆకుపచ్చ" is a
 * grown-up's word.
 */
const COLOUR_ANSWERS: Readonly<Record<HuntColour, SpokenAnswers>> = {
  red: {
    te: ["ఎరుపు", "ఎర్ర", "ఎర్రటి", "erupu", "errupu", "erra", "erra rangu", "erupu rangu"],
    en: ["red"],
  },
  green: {
    te: [
      "ఆకుపచ్చ",
      "పచ్చ",
      "పచ్చని",
      "aakupaccha",
      "akupaccha",
      "aku paccha",
      "paccha",
      "pacha",
      "pachcha",
    ],
    en: ["green"],
  },
  yellow: {
    te: ["పసుపు", "పసుపు పచ్చ", "pasupu", "pasapu", "pasupu rangu"],
    en: ["yellow"],
  },
  blue: {
    te: ["నీలం", "నీలి", "neelam", "nilam", "neela", "neeli", "neelam rangu"],
    en: ["blue"],
  },
};

/** "This one is red!" — silent if the copy has not landed. See optionalCopyKey. */
const DEMO_KEYS: Readonly<Record<HuntColour, ReturnType<typeof optionalCopyKey>>> = {
  red: optionalCopyKey("demo.hunt.red"),
  green: optionalCopyKey("demo.hunt.green"),
  yellow: optionalCopyKey("demo.hunt.yellow"),
  blue: optionalCopyKey("demo.hunt.blue"),
};

/**
 * Rotate rather than shuffle: the correct swatch must not sit in the same slot
 * every round (a child learns the position, not the colour), but the four
 * colours must stay in a stable order relative to each other so the row does
 * not reshuffle under a child who is still deciding.
 */
function rotated(colours: readonly HuntColour[], by: number): readonly HuntColour[] {
  const n = colours.length;
  if (n === 0) return colours;
  const k = ((by % n) + n) % n;
  return [...colours.slice(k), ...colours.slice(0, k)];
}

export const createHuntActivity: ActivityFactory = (random) => {
  const target = HUNT_ORDER[randInt(random, 0, HUNT_ORDER.length - 1)] ?? "red";
  const order = rotated(HUNT_ORDER, randInt(random, 0, HUNT_ORDER.length - 1));
  const choices: readonly ActivityChoice[] = order.map((colour) => ({
    id: `hunt-${colour}`,
    swatch: colour,
    // The picture is the answer; the word is for the child who is listening.
    labelKey: copyKey(`choice.hunt.${colour}`, "act.hunt.tap"),
    correct: colour === target,
  }));
  const answers = COLOUR_ANSWERS[target];
  const demoKey = DEMO_KEYS[target];

  const activity: Activity = {
    kind: "hunt",
    // The four prompts already exist in both dictionaries (window.hunt.*), so
    // this is a lookup rather than a new key per colour.
    promptKey: copyKey(`window.hunt.${target}`, "window.hunt.red"),
    retryKey: "act.hunt.retry",
    tapHintKey: "act.hunt.tap",
    holdMs: HUNT_HOLD_MS,
    huntColour: target,
    // `windowCoverage` is undefined on any frame nobody measured — treated as
    // zero rather than as a match, so a surface that forgets to plumb it fails
    // closed (the child keeps hunting) instead of open (Chiku cheers at a wall).
    matches: (frame) => foundTarget(frame.windowCoverage ?? 0),
    // The window itself is the evidence. Without one there is nothing to have
    // an opinion about — not a wrong answer, no answer.
    hasEvidence: (frame) => {
      const quad = frame.quad ?? null;
      return quad !== null && quad.presence >= HUNT_PRESENCE;
    },
    choices,
    answers,
    accepts: (utterance) => matchesAnswer(utterance, answers),
    // Chiku holds the colour up himself. There is no pose that means "red", so
    // this beat is the one place a DemoBeat carries a swatch — and it is the
    // whole reason the field exists.
    demonstrate: (): readonly DemoBeat[] => [
      {
        ...(demoKey ? { key: demoKey } : {}),
        emote: "happy",
        swatch: target,
        ms: HUNT_SWATCH_BEAT_MS,
      },
    ],
  };
  return activity;
};
