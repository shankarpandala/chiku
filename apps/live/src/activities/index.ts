// The round: THREE activities, drawn from the pool, with random targets. Three
// short rounds is the whole session — a natural cap that means the surface
// always ends warmly instead of running until a grown-up intervenes (§9: hard
// session cap).
//
// WHY THE ROUND IS SHORTER THAN THE POOL. It used to be "every activity, once",
// which was the same thing while there were three of them. The colour hunt made
// a fourth, and lengthening the round to fit it would have made every session
// 33% longer — spending a child's capped play time on a decision nobody made.
// So the round length is a number in its own right and the pool is sampled: the
// session stays the length it was, and which three activities a child gets
// varies, which is a better show than the same three in a different order.
// Phase 5 doubled the pool to eight. ROUND_LENGTH did not move, and that is the
// whole point of it existing.
//
// WHY THE POOL IS DISCOVERED RATHER THAN LISTED. Three phases running, this app
// shipped code that was built, tested and unreachable. An activity file that
// nobody remembered to add to a hand-written array is exactly that bug, and it
// is invisible: the tests for the activity pass, and no child ever sees it. So
// the modules are found by glob and the hand-written part is only the METADATA
// (`ACTIVITY_SPEC`). A module with a factory and no spec entry is not silently
// dropped — `test/rotation.test.ts` fails the build for it.
//
// THE SHAPE OF A ROUND (see `pickRound`) is three rules, all about composition
// rather than about position:
//
//   1. Never two activities from the same SKILL. "Show me 3 fingers" and "what
//      comes after 3" are one skill wearing two hats; so are waving and
//      thumbs-up. Three of those in a row is one activity that outstayed its
//      welcome, not a round.
//   2. At most one ADVANCED activity. The colour hunt and the successor both
//      need a concept the youngest band does not have yet; two of them in a
//      three-activity session is a session that band cannot play.
//   3. At least one FOUNDATION activity — wave, smile, peekaboo, big/small.
//      Something every child in the age range can do without understanding an
//      instruction at all, so no round is a round where nothing worked.
//
// WHY NOT "ALWAYS OPEN WITH SOMETHING EASY AND BODILY". It was considered and
// deliberately not done. Forcing the opener would mean the colour hunt and the
// successor can never be the first thing a child meets — the magic window would
// only ever appear after two other activities had already spent the child's
// attention — and it would buy little, because rule 3 already guarantees the
// round contains something they can definitely do, and the prompt they open on
// is preceded by Chiku's greeting and the camera screen rather than landing
// cold. Composition is the thing that decides whether a session was playable;
// position mostly decides which activity gets the freshest attention, and
// spreading that around the pool is the better default.

import type { Activity, ActivityFactory } from "./types";

/**
 * What a child is actually practising. One per round, at most — this is the
 * rule that stops a round being three variations of the same trick.
 */
export type ActivitySkill = "count" | "gesture" | "face" | "hide" | "size" | "look";

/**
 * How much the activity assumes.
 *
 *   foundation  Nothing. Imitation is enough; the youngest band can play it.
 *   middle      A small instruction ("three fingers", "thumbs up for yes").
 *   advanced    A concept the child either has or does not: which of these is
 *               red, what comes after three.
 */
export type ActivityBand = "foundation" | "middle" | "advanced";

export interface ActivitySpec {
  /** Module basename under `src/activities/`. */
  readonly id: string;
  readonly skill: ActivitySkill;
  readonly band: ActivityBand;
}

/**
 * Every activity this app knows how to schedule.
 *
 * THE ORDER IS A TIE-BREAK, NOT A PRIORITY, and it is load-bearing for the
 * tests. `buildRound` draws one sort key per entry and sorts; a test random
 * that returns a constant makes every key equal, and a stable sort then hands
 * back this order. Four surface test files are written against the round a
 * constant 0.5 produces — [fingers, smile, wave] — so those three stay at the
 * head and anything new goes after them. Adding an activity therefore cannot
 * move the fixture, which is a property worth more than a prettier order.
 */
export const ACTIVITY_SPEC: readonly ActivitySpec[] = [
  { id: "fingers", skill: "count", band: "middle" },
  { id: "smile", skill: "face", band: "foundation" },
  { id: "wave", skill: "gesture", band: "foundation" },
  { id: "peekaboo", skill: "hide", band: "foundation" },
  { id: "bigsmall", skill: "size", band: "foundation" },
  { id: "thumbs", skill: "gesture", band: "middle" },
  { id: "successor", skill: "count", band: "advanced" },
  { id: "hunt", skill: "look", band: "advanced" },
];

/**
 * Eagerly loaded so the pool is a plain array rather than a promise: the round
 * is built inside a click handler, and a child does not wait for an import.
 * Every activity module is a few hundred bytes of logic — the models are the
 * only thing in this app worth code-splitting, and they already are.
 */
const MODULES: Record<string, unknown> = import.meta.glob(
  ["./*.ts", "!./index.ts", "!./types.ts", "!./hold.ts", "!./assist.ts"],
  { eager: true },
);

/** `create…Activity`, whatever the middle of the name happens to be. */
function factoryIn(mod: unknown): ActivityFactory | null {
  if (typeof mod !== "object" || mod === null) return null;
  for (const [name, value] of Object.entries(mod)) {
    if (/^create[A-Za-z0-9]*Activity$/.test(name) && typeof value === "function") {
      return value as ActivityFactory;
    }
  }
  return null;
}

function idOf(path: string): string {
  return path.replace(/^\.\//, "").replace(/\.tsx?$/, "");
}

/**
 * Every module under `src/activities/` that exports an activity factory —
 * including any that `ACTIVITY_SPEC` has forgotten. Exported so the rotation
 * test can fail the build on a forgotten one instead of a child never seeing
 * it. Sorted, so the failure message is stable.
 */
export const ACTIVITY_MODULES: readonly string[] = Object.entries(MODULES)
  .filter(([, mod]) => factoryIn(mod) !== null)
  .map(([path]) => idOf(path))
  .sort();

export interface PoolEntry extends ActivitySpec {
  readonly make: ActivityFactory;
}

/**
 * The activities a round can actually draw, in `ACTIVITY_SPEC` order.
 *
 * A spec entry whose module has not landed is skipped rather than thrown for:
 * the pool grows as files arrive, and a half-merged tree should still be a
 * playable app.
 */
export const POOL: readonly PoolEntry[] = ACTIVITY_SPEC.flatMap((spec) => {
  const make = factoryIn(MODULES[`./${spec.id}.ts`]);
  return make === null ? [] : [{ ...spec, make }];
});

/** How many activities one visit is. Never longer than the pool. */
export const ROUND_LENGTH = 3;

/**
 * Activities whose answer is the child's whole body getting bigger and smaller,
 * and which the surface therefore mirrors onto Chiku's own size.
 *
 * A set of strings rather than a `kind` comparison so that the surface does not
 * have to be edited again the next time an activity wants the same treatment —
 * and so this file, which already owns what an activity IS, owns it.
 */
export const SIZE_MIRROR_KINDS: ReadonlySet<string> = new Set(["bigsmall"]);

interface Keyed {
  readonly entry: PoolEntry;
  readonly key: number;
}

/**
 * The lexicographically-first legal combination in key order.
 *
 * Depth-first, taking each candidate before skipping it, so the result is the
 * greedy pick wherever the greedy pick is legal and the nearest legal one
 * otherwise. The pool is eight and the round is three: this looks at a few
 * dozen combinations at worst, once per session.
 */
function search(sorted: readonly Keyed[], want: number): PoolEntry[] | null {
  const chosen: PoolEntry[] = [];

  const legal = (entry: PoolEntry): boolean =>
    !chosen.some((c) => c.skill === entry.skill) &&
    (entry.band !== "advanced" || !chosen.some((c) => c.band === "advanced"));

  const walk = (i: number): boolean => {
    if (chosen.length === want) return chosen.some((c) => c.band === "foundation");
    if (i >= sorted.length) return false;
    const candidate = sorted[i];
    if (candidate !== undefined && legal(candidate.entry)) {
      chosen.push(candidate.entry);
      if (walk(i + 1)) return true;
      chosen.pop();
    }
    return walk(i + 1);
  };

  return walk(0) ? chosen : null;
}

/**
 * Which activities this round is, in the order they will be played.
 *
 * One `random()` per pool entry, drawn in `ACTIVITY_SPEC` order, then a stable
 * sort. Sorting by keys rather than shuffling in place is what makes a constant
 * test random stay meaningful as the pool grows: equal keys keep spec order, so
 * adding a ninth activity cannot silently rewrite the fixture four surface test
 * files are built on. With a real `Math.random` the keys are distinct and this
 * is an ordinary uniform shuffle.
 *
 * NEVER RETURNS NOTHING. If the rules cannot be satisfied — a pool too small or
 * too lopsided, which is a state a half-merged tree can genuinely be in — the
 * round falls back to the first `ROUND_LENGTH` by key. A shapeless round is a
 * worse show; no round at all is a broken one.
 */
export function pickRound(random: () => number, want: number = ROUND_LENGTH): PoolEntry[] {
  const keyed: Keyed[] = POOL.map((entry) => ({ entry, key: random() }));
  const sorted = [...keyed].sort((a, b) => a.key - b.key);
  const size = Math.min(want, sorted.length);
  return search(sorted, size) ?? sorted.slice(0, size).map((k) => k.entry);
}

export function buildRound(random: () => number = Math.random): Activity[] {
  return pickRound(random).map((entry) => entry.make(random));
}

export { HUNT_HOLD_MS, HUNT_PRESENCE } from "./hunt";
export {
  HoldTracker,
  HOLD_SLACK_CEILING_MS,
  HOLD_SLACK_FRAMES,
  HOLD_UNKNOWN_FRAMES,
  type HoldVerdict,
} from "./hold";
export {
  alongsideBeatsFor,
  copyKey,
  demoBeatsFor,
  DEMO_ASK_MS,
  matchesAnswer,
  normalizeUtterance,
  optionalCopyKey,
  verdictFor,
} from "./types";
export type {
  Activity,
  ActivityChoice,
  ActivityFactory,
  ActivityKind,
  DemoBeat,
  GlyphName,
  SpokenAnswers,
} from "./types";
export {
  ASSIST_LADDER,
  nextAssist,
  praiseToneFor,
  relaxFor,
  type AssistLevel,
  type PraiseTone,
  type Relaxation,
} from "./assist";
