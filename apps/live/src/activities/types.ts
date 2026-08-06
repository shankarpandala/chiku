// The Activity contract.
//
// An activity is a tiny, complete unit of "the child's BODY is the answer":
//   prompt → the child does a thing → Chiku reacts → praise.
//
// Four rules baked into the shape:
//   1. `matches` is a predicate over one VisionFrame, and it is paired with
//      `hasEvidence`, which says whether the frame could answer the question at
//      all. All debouncing lives in the runner (children's hands wobble; a
//      single frame is never truth). `matches` is pure for fingers and wave;
//      smile carries its own enter/exit gate, because a threshold crossing —
//      unlike a finger count — has no natural quantum and would otherwise
//      chatter at the boundary. That gate is the only state in this file.
//   2. Every activity carries `choices` — a tap answer that works with no
//      camera at all. There is no vision-only activity.
//   3. Every activity carries `answers` — a SPOKEN answer, in both languages,
//      so a child who would rather say it than show it is not a special case.
//   4. There is retry copy, but no failure copy. Rounds end in praise.
//   5. Every activity can SHOW ITS OWN ANSWER (`demonstrate`). Imitation is the
//      first thing a three-year-old can do, long before instruction-following,
//      so the first rung of the assist ladder is Chiku doing the thing himself.
//      Optional, because the sane default — ask again, warmly — is already a
//      complete behaviour.

import type { Emote } from "@chiku/rig";
import type { FaceSignal, HandSignal, VisionFrame } from "../vision/types";
import { Presence, PRESENCE_DECAY, DEFAULT_LOST_FRAMES } from "../vision/stability";
// Type-only, so no runtime edge is added from the activities layer into the
// components layer: `HuntColour` is the vocabulary of the colour game, and it
// happens to live next to the lens that measures it.
import type { HuntColour } from "../components/magicLens";
import type { HoldVerdict } from "./hold";
import en from "../i18n/en.json";
import type { I18nKey, Values } from "../i18n";

/* -------------------------------------------------------------------------- */
/* Copy that may not have landed yet                                           */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a copy key that the dictionary may not carry yet.
 *
 * The assist ladder and the copy for it are being built in parallel, and
 * `translate()` cannot survive a missing key — it would hand `undefined` to a
 * `String.replace` and take the whole surface down. So every key this layer
 * introduces is looked up against the dictionary once, at module load, and
 * degrades to a key that certainly exists. A missing line is then a quieter
 * Chiku, never a blank screen.
 *
 * `en.json` is the authority on which keys exist: `I18nKey` is literally
 * `keyof typeof en`, and both dictionaries are required to be complete.
 */
export function optionalCopyKey(key: string): I18nKey | undefined {
  return Object.prototype.hasOwnProperty.call(en, key) ? (key as I18nKey) : undefined;
}

/** `optionalCopyKey` with a guaranteed answer. */
export function copyKey(key: string, fallback: I18nKey): I18nKey {
  return optionalCopyKey(key) ?? fallback;
}

export type ActivityKind =
  | "fingers"
  | "wave"
  | "smile"
  | "hunt"
  | "successor"
  | "bigsmall"
  | "thumbs"
  | "peekaboo";

/**
 * Language-neutral pictures for the tap answers.
 *
 * NOTE FOR WHOEVER OWNS `components/Glyph.tsx`: the six names below the
 * original four have no shape drawn for them yet. `Glyph` renders nothing for
 * a name it does not know, so a tap answer using one of them is a button with
 * an accessible name and an empty face. See the Phase 5 report — the shapes
 * are the last thing between these activities and a child.
 */
export type GlyphName =
  | "wave"
  | "still"
  | "smile"
  | "sad"
  | "big"
  | "small"
  | "thumbUp"
  | "thumbDown"
  | "hide"
  | "peek";

/**
 * What counts as the right answer OUT LOUD, per language.
 *
 * The Telugu list carries Telugu script AND Latin transliterations, because
 * that is what actually comes back: on-device recognition running as en-IN
 * hears "moodu" and writes it in Latin letters, and a bilingual child in
 * Hyderabad says "moodu" in the middle of an English sentence anyway. Treating
 * transliteration as an edge case would mean rejecting the most common real
 * answer this app will ever hear.
 */
export interface SpokenAnswers {
  readonly te: readonly string[];
  readonly en: readonly string[];
}

/**
 * Fold an utterance down to comparable shape: NFC, lower case, punctuation
 * (and the trailing "!" every recogniser loves) replaced by spaces, runs of
 * whitespace collapsed. Deliberately NOT a fuzzy matcher — no edit distance,
 * no phonetic keys. If a spelling matters, it belongs in the list.
 */
export function normalizeUtterance(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * True when `text` contains any accepted answer as a whole token run. Whole-run
 * rather than raw substring so "one" does not fire inside "gone", but "it's
 * three!" and "moodu vellu" — how children actually answer — both do.
 */
export function matchesAnswer(text: string, answers: SpokenAnswers): boolean {
  const heard = ` ${normalizeUtterance(text)} `;
  if (heard.trim() === "") return false;
  for (const answer of [...answers.te, ...answers.en]) {
    const want = normalizeUtterance(answer);
    if (want !== "" && heard.includes(` ${want} `)) return true;
  }
  return false;
}

export interface ActivityChoice {
  readonly id: string;
  /** Big numeral face (counting). Mutually exclusive with `glyph`. */
  readonly digit?: number;
  readonly glyph?: GlyphName;
  /**
   * A plain block of colour. The colour game's tap answer has no picture and
   * no word in it on purpose: the swatch IS the answer, so a child who cannot
   * read a numeral and cannot name a shape can still play. The accessible name
   * still carries the word, for the child who is listening rather than looking.
   */
  readonly swatch?: HuntColour;
  /** Accessible name — kid screens are pictures, screen readers get words. */
  readonly labelKey: I18nKey;
  readonly labelValues?: Values;
  readonly correct: boolean;
}

export interface Activity {
  readonly kind: ActivityKind;
  readonly promptKey: I18nKey;
  readonly promptValues?: Values;
  /** Warm nudge, shown after a while or a wrong tap. Never a failure. */
  readonly retryKey: I18nKey;
  readonly tapHintKey: I18nKey;
  /** How long `matches` must hold before it counts. Anti-wobble, not a gate. */
  readonly holdMs: number;
  matches(frame: VisionFrame): boolean;
  /**
   * Could this frame answer the question at all?
   *
   * False means "no evidence", not "wrong": the hand was too ambiguous to
   * count, or the face detector found nobody. The runner turns that into a
   * `HoldVerdict` of "unknown", which neither advances the hold nor resets it.
   * Without this every honest "I couldn't tell" was scored as a wrong answer
   * and spent the child's slack — the tracker's uncertainty punishing them.
   */
  hasEvidence(frame: VisionFrame): boolean;
  /**
   * The colour this round is hunting for, when the activity is a hunt.
   *
   * The surface reads it to tell the lens which colour to keep, so that the
   * thing being asked for, the thing glowing inside the window and the thing
   * `matches` will accept are one value rather than three that agree by
   * convention. Undefined for every other kind.
   */
  readonly huntColour?: HuntColour;
  readonly choices: readonly ActivityChoice[];
  /** What the right answer sounds like, in te and en. */
  readonly answers: SpokenAnswers;
  /**
   * True when a heard utterance is the right answer. Case- and
   * punctuation-insensitive, both languages always, whichever one the
   * recogniser was told to use — a child answers in the language they think in.
   */
  accepts(utterance: string): boolean;
  /**
   * How Chiku SHOWS this answer himself, as a short list of beats.
   *
   * Optional. An activity that does not implement it degrades to the default
   * in `demoBeatsFor` — asking again, warmly — which is what the surface did
   * before the ladder existed.
   *
   * Called fresh each time, so a demonstration may depend on this round's
   * target ("one… two… three!"). Keep it under about three seconds: a
   * three-year-old who is already stuck will not watch a lecture.
   */
  demonstrate?(): readonly DemoBeat[];
}

/**
 * One beat of Chiku doing the thing himself: a pose, optionally a line, and
 * how long to stay there before the next beat.
 *
 * Time rather than promise-chaining, because speech is never load-bearing here
 * (§ the `say` contract in Live) — on a device with no synthesiser the beats
 * still play as a silent performance, at the same pace.
 */
export interface DemoBeat {
  /** Line to say on this beat. Omitted = a silent pose. */
  readonly key?: I18nKey;
  readonly values?: Values;
  /** The face and trunk Chiku wears for this beat. */
  readonly emote: Emote;
  /**
   * Hold a block of this colour up beside Chiku for the length of the beat.
   *
   * The rig has no way to BE red, and "watch me" is the first rung of the
   * ladder precisely because imitation beats instruction at three years old —
   * so for the colour game the thing to imitate has to be visible. Chiku shows
   * the colour himself, the child looks for one like it.
   */
  readonly swatch?: HuntColour;
  /** How long this beat lasts before the next one starts. */
  readonly ms: number;
}

/** Room for one re-ask to land before the miss timer is armed again. */
export const DEMO_ASK_MS = 900;

/**
 * The "watch" rung: Chiku shows the answer, then asks again.
 *
 * The re-ask is the whole default. An activity with no `demonstrate` of its
 * own therefore behaves exactly as the surface always did, which is what makes
 * the hook safe to leave unimplemented.
 */
export function demoBeatsFor(activity: Activity): readonly DemoBeat[] {
  const shown = activity.demonstrate?.() ?? [];
  const ask: DemoBeat = {
    key: activity.promptKey,
    values: activity.promptValues,
    emote: "encouraging",
    ms: DEMO_ASK_MS,
  };
  return [...shown, ask];
}

/**
 * The "together" rung: the same demonstration with NO re-ask, because nothing
 * is being asked any more — Chiku is doing it alongside the child and the
 * round is about to end in praise either way.
 */
export function alongsideBeatsFor(activity: Activity): readonly DemoBeat[] {
  return activity.demonstrate?.() ?? [];
}

export type ActivityFactory = (random: () => number) => Activity;

/**
 * One frame, one verdict — the only place `matches` and `hasEvidence` are
 * combined, so no caller can accidentally score "I couldn't tell" as "wrong".
 */
export function verdictFor(activity: Activity, frame: VisionFrame): HoldVerdict {
  if (!activity.hasEvidence(frame)) return "unknown";
  return activity.matches(frame) ? "match" : "mismatch";
}

/** Uniform integer in [min, max]; safe against random() returning exactly 1. */
export function randInt(random: () => number, min: number, max: number): number {
  const span = max - min + 1;
  return min + Math.min(span - 1, Math.floor(random() * span));
}

/* -------------------------------------------------------------------------- */
/* Number words                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What each number sounds like, in both languages.
 *
 * The Telugu rows carry script AND the Latin spellings a recogniser actually
 * emits: on-device recognition running as en-IN hears "moodu" and writes it in
 * Latin letters, and a bilingual child in Hyderabad says "moodu" in the middle
 * of an English sentence anyway. Bare digits sit in the en row because that is
 * what en-IN writes for "three".
 *
 * Lives here rather than in `fingers.ts` because two activities now count —
 * `fingers` asks for N and `successor` asks for the one after it — and two
 * copies of this table would drift the first time a spelling is added to one.
 * (`fingers.ts` still has its own private copy; folding it into this one is a
 * one-line change for whoever owns that file next.)
 */
export const NUMBER_WORDS: Readonly<Record<number, SpokenAnswers>> = Object.freeze({
  1: { te: ["ఒకటి", "ఒక్కటి", "okati", "okkati", "oka"], en: ["one", "1"] },
  2: { te: ["రెండు", "rendu", "rendo", "reddu"], en: ["two", "2"] },
  3: { te: ["మూడు", "moodu", "mudu", "muudu", "mudhu"], en: ["three", "3"] },
  4: { te: ["నాలుగు", "naalugu", "nalugu", "nalgu"], en: ["four", "4"] },
  5: { te: ["ఐదు", "aidu", "aydu", "ayidu"], en: ["five", "5"] },
});

/** The empty answer set — spoken answers a language has no word for. */
export const NO_SPOKEN_ANSWERS: SpokenAnswers = Object.freeze({ te: [], en: [] });

/* -------------------------------------------------------------------------- */
/* Body geometry — shared by the whole-body activities                         */
/* -------------------------------------------------------------------------- */

export interface ImagePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The face centre in the SAME 0..1 image space the wrists live in.
 *
 * Not an approximation: `vision/gaze.ts` builds `FaceSignal.x/y` as
 * `centre * 2 - 1`, and this is exactly that inverted. Without it every
 * comparison between a face and a wrist is a silent coordinate-space bug —
 * `face.y` counts from -1 at the top, `wrist.y` from 0 at the top.
 */
export function faceImagePoint(face: FaceSignal): ImagePoint {
  return { x: (face.x + 1) / 2, y: (face.y + 1) / 2 };
}

/** Above this belief the primary person is still "here", face or no face. */
export const FACE_BELIEVED = 0.5;

/**
 * Where the child's face was, surviving a tracker blink.
 *
 * The whole-body activities measure wrists AGAINST the face, so a single
 * dropped face detection would otherwise delete the ruler and score the frame
 * as "not big" — the exact Phase 1 failure, one layer up. So the last seen
 * position is remembered and stays valid for as long as `facePresence` still
 * believes the child is there.
 *
 * The local `Presence` is a stand-in for frames that carry no `facePresence`
 * (hand-built fixtures, and any surface that forgets to plumb it). Rise is 1,
 * as in `CameraStage`'s attention gate: a detected face is believed at once,
 * because there is nothing about a position to ramp.
 */
export class FaceAnchor {
  #point: ImagePoint | null = null;
  #local = new Presence(DEFAULT_LOST_FRAMES, 1, PRESENCE_DECAY);
  #belief = 0;

  /** One frame in; where the face is, or null if we no longer believe in it. */
  update(frame: VisionFrame): ImagePoint | null {
    const local = this.#local.update(frame.face !== null);
    this.#belief = frame.facePresence ?? local;
    if (frame.face !== null) {
      this.#point = faceImagePoint(frame.face);
      return this.#point;
    }
    return this.#belief >= FACE_BELIEVED ? this.#point : null;
  }

  /** How strongly the primary person is believed present, 0..1. */
  get belief(): number {
    return this.#belief;
  }
}

/**
 * How far from the face a wrist may be and still plausibly belong to that
 * child. Generous on purpose — arms straight up put a wrist a long way from a
 * face centre, and the cost of being generous is only that a sibling standing
 * shoulder-to-shoulder makes the frame AMBIGUOUS (see `childHands`), which
 * scores as "unknown" and costs the child nothing.
 */
export const ARM_REACH = 0.5;

/**
 * The hands that could be this child's: everything within arm's reach of their
 * face. `VisionFrame.hands` is explicitly everyone's hands — only
 * `totalFingers` is subject-locked — so an activity that reads hands directly
 * has to do this itself or it will let a sibling answer.
 */
export function childHands(
  frame: VisionFrame,
  anchor: ImagePoint,
): readonly HandSignal[] {
  return frame.hands.filter(
    (h) => Math.hypot(h.wrist.x - anchor.x, h.wrist.y - anchor.y) <= ARM_REACH,
  );
}

/**
 * Run `advance` at most once per vision frame.
 *
 * Every stateful activity below counts FRAMES, and both `matches` and
 * `hasEvidence` are handed the same frame — so an unguarded counter advances
 * twice per frame through `verdictFor` and not at all through a caller that
 * only asks one of the two. Keying on `frame.t` (monotonic, from the vision
 * clock) makes the two entry points idempotent and the frame counts mean what
 * they say.
 */
export function perFrame<S>(advance: (frame: VisionFrame) => S): (frame: VisionFrame) => S {
  let seenT = Number.NaN;
  let last: S | undefined;
  return (frame) => {
    if (frame.t !== seenT || last === undefined) {
      seenT = frame.t;
      last = advance(frame);
    }
    return last;
  };
}
