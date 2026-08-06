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

import type { VisionFrame } from "../vision/types";
import type { HoldVerdict } from "./hold";
import type { I18nKey, Values } from "../i18n";

export type ActivityKind = "fingers" | "wave" | "smile";

/** Language-neutral pictures for the tap answers. */
export type GlyphName = "wave" | "still" | "smile" | "sad";

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
  readonly choices: readonly ActivityChoice[];
  /** What the right answer sounds like, in te and en. */
  readonly answers: SpokenAnswers;
  /**
   * True when a heard utterance is the right answer. Case- and
   * punctuation-insensitive, both languages always, whichever one the
   * recogniser was told to use — a child answers in the language they think in.
   */
  accepts(utterance: string): boolean;
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
