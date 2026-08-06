// The mercy ladder.
//
// The gap this closes: a child who cannot show three fingers was offered a tap
// fallback that is THE SAME COGNITIVE TASK — pick the numeral 3 out of five
// numerals. For the youngest band that is not an easier door, it is the same
// door painted differently, so `activities/types.ts`'s own rule ("rounds end in
// praise") was unreachable for exactly the children who needed it to be true.
//
// The pattern is Khan Academy Kids' and PBS Kids': never a red X, never a dead
// end — escalate *toward* the answer instead. Each rung makes succeeding more
// likely rather than making the child try harder at the same thing:
//
//   WATCH    Chiku does it himself, slowly, and asks again. Imitation is the
//            first thing a 3-year-old can do, long before instruction-following.
//   EASIER   The detector quietly loosens (see `relaxFor`). The child is never
//            told the bar moved — being visibly given an easier version is a
//            small humiliation, and they did not ask for one.
//   TOGETHER "Let's do it together!" — Chiku counts along and the answer is
//            accepted generously. Framed as success, because it is: doing a
//            thing with help is how children learn to do it alone.
//
// Nothing here ever ends in failure. There is no rung below TOGETHER.

/** How much help the child is getting right now. */
export type AssistLevel = "none" | "watch" | "easier" | "together";

export const ASSIST_LADDER: readonly AssistLevel[] = ["none", "watch", "easier", "together"];

/** One rung down, saturating at the bottom — there is no "gave up" state. */
export function nextAssist(level: AssistLevel): AssistLevel {
  const i = ASSIST_LADDER.indexOf(level);
  return ASSIST_LADDER[Math.min(i + 1, ASSIST_LADDER.length - 1)] ?? "together";
}

/**
 * The rung to move to after a miss — and the FIRST miss buys a free retry at
 * the same rung.
 *
 * Two reasons. Pedagogically, a child who was merely slow, or who looked away
 * for a second, should not be immediately shown how to do it; jumping straight
 * to "watch me" reads as "you can't". And mechanically, without this every miss
 * both increments `attempts` and descends a rung, so `attempts >= 1` always
 * implied `level !== "none"` and `praiseToneFor`'s "warm" branch — the
 * unhelped-but-hard-won win, the most worth celebrating — was unreachable.
 */
export function assistAfterMiss(level: AssistLevel, attempts: number): AssistLevel {
  if (level === "none" && attempts <= 1) return "none";
  return nextAssist(level);
}

/**
 * Detector relaxation per rung, as a multiplier on the hold duration and a
 * widening of the acceptance band. Deliberately gentle: the point is to meet a
 * wobbly hand halfway, not to accept anything at all, which would teach the
 * child that Chiku is not really looking.
 */
export interface Relaxation {
  /** Multiplies the activity's holdMs. Shorter hold = easier to satisfy. */
  readonly holdScale: number;
  /** Extra frames of dropout forgiven inside the hold. */
  readonly extraSlackFrames: number;
  /** Degrees of extra tolerance handed to the finger-angle thresholds. */
  readonly angleRelaxDeg: number;
}

export function relaxFor(level: AssistLevel): Relaxation {
  switch (level) {
    case "none":
      return { holdScale: 1, extraSlackFrames: 0, angleRelaxDeg: 0 };
    case "watch":
      // Watching does not change the bar — the help is the demonstration.
      return { holdScale: 1, extraSlackFrames: 0, angleRelaxDeg: 0 };
    case "easier":
      return { holdScale: 0.6, extraSlackFrames: 6, angleRelaxDeg: 8 };
    case "together":
      return { holdScale: 0.4, extraSlackFrames: 12, angleRelaxDeg: 14 };
  }
}

/**
 * Praise is chosen by EFFORT, not just by outcome.
 *
 * Gunderson/Dweck: praising effort at ages 4-5 predicts a growth mindset years
 * later, while praising the person ("clever girl") does the opposite. And more
 * recent work warns that praising trivial wins devalues the praise — so an
 * instant success gets a light, warm acknowledgement, and the child who needed
 * three goes gets the real celebration. That is the opposite of most software,
 * which cheers loudest for the easiest win.
 */
export type PraiseTone = "light" | "warm" | "effort";

/**
 * The "warm" boundary is one miss, not two, and that is a consequence of the
 * free retry above: `assistAfterMiss` holds the top rung for exactly one miss,
 * so `level === "none"` implies `attempts <= 1` and a `attempts >= 2` warm
 * branch would stay as unreachable as it was before. One miss, no help, then a
 * win IS the unhelped-but-hard-won case — the child got a second go and took
 * it, and Chiku can claim no part of that.
 */
export function praiseToneFor(level: AssistLevel, attempts: number): PraiseTone {
  if (level !== "none" || attempts >= 3) return "effort";
  if (attempts >= 1) return "warm";
  return "light";
}
