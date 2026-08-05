// The Activity contract.
//
// An activity is a tiny, complete unit of "the child's BODY is the answer":
//   prompt → the child does a thing → Chiku reacts → praise.
//
// Three rules baked into the shape:
//   1. `matches` is a PURE predicate over one VisionFrame. All debouncing lives
//      in the runner (children's hands wobble; a single frame is never truth).
//   2. Every activity carries `choices` — a tap answer that works with no
//      camera at all. There is no vision-only activity.
//   3. There is retry copy, but no failure copy. Rounds end in praise.

import type { VisionFrame } from "../vision/types";
import type { I18nKey, Values } from "../i18n";

export type ActivityKind = "fingers" | "wave" | "smile";

/** Language-neutral pictures for the tap answers. */
export type GlyphName = "wave" | "still" | "smile" | "sad";

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
  readonly choices: readonly ActivityChoice[];
}

export type ActivityFactory = (random: () => number) => Activity;

/** Uniform integer in [min, max]; safe against random() returning exactly 1. */
export function randInt(random: () => number, min: number, max: number): number {
  const span = max - min + 1;
  return min + Math.min(span - 1, Math.floor(random() * span));
}
