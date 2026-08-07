// TODDLER MODE — the exercise set, for a two-year-old.
//
// THIS IS NOT AN `Activity` AND MUST NOT BECOME ONE. Everything in this folder
// besides this file is built for the 3-8 band: a prompt, a right answer, a hold,
// a mercy ladder that ends in praise. All of that presumes a child who can be
// ASKED something. A 24-month-old cannot be asked. They can be SHOWN.
//
// So the shape here is deliberately smaller and has no verdict in it at all:
//
//     Chiku does a big slow movement  →  a warm noise, not an instruction  →
//     the child moves (anything)      →  instant delight                   →
//     THE SAME MOVEMENT AGAIN, louder →  ×3-4, then a new movement
//
// There is no `matches`, no `correct`, no retry copy and no failure state,
// because at this age a "no" is not a smaller reward — it is a lesson that the
// screen is not really watching. `frame.movement.any` is the whole predicate:
// if the child jumped when Chiku stomped, that is a win, because they moved
// their body along with him. That is the entire developmental point.
//
// It lives in `activities/` next to its cousins rather than inside the surface
// because it is the same KIND of thing — the unit of play — and because a
// future toddler activity should land beside this one and not in a component.
// `activities/index.ts` discovers modules by looking for a `create…Activity`
// export; this file deliberately exports no such name, so the rotation contract
// (which is a contract about the 3-8 round) does not apply to it and cannot be
// accidentally satisfied by it.

import type { I18nKey } from "../i18n";
import type { MovementKind } from "../vision/movement";
import type { VisionFrame } from "../vision/types";

/* -------------------------------------------------------------------------- */
/* The session                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Five minutes, not twenty.
 *
 * `session/cap.ts` defaults to 20 and its floor is 5; this passes the floor
 * rather than moving the shared default, because the 3-8 surface's twenty
 * minutes is correct for the 3-8 surface. A two-year-old's sustained attention
 * is measured in seconds, and a five-minute ceiling is already generous — most
 * sessions will end when the child wanders off, which is the healthy ending.
 * The cap only exists to bound the case where nobody does.
 */
export const TODDLER_LIMIT_MIN = 5;

/* -------------------------------------------------------------------------- */
/* Movement, read off the frame                                                */
/* -------------------------------------------------------------------------- */

/**
 * Did the child's body do ANYTHING this frame?
 *
 * `frame.movement.any`, and nothing else. Three things follow from reading the
 * engine's own signal rather than running a second `MovementDetector` here:
 *
 *   * ONE OPINION. Two detectors over the same body would eventually disagree
 *     about whether the child stomped, while the child watches one of them
 *     react and the other one not.
 *   * IT IS THE RIGHT BODY. `frame.movement` is locked to the PRIMARY person,
 *     the same way `totalFingers` and `quad` are. A detector rebuilt out here
 *     from `frame.hands` would happily celebrate a sibling bouncing past —
 *     and at this age that is worse than a scoring error, because it breaks
 *     the contingency the whole loop is teaching.
 *   * `undefined` MEANS NO EVIDENCE, NEVER "THEY DID NOT MOVE". There is no
 *     branch anywhere below that treats a quiet frame as a failure; the worst
 *     a silent camera can do is let the timer celebrate instead.
 *
 * `any` and not the specific kind, deliberately. If the child jumps when Chiku
 * stomped, they moved their whole body along with him, which IS the thing we
 * were hoping for. Chiku never finds out which one it was.
 */
export function movedOnFrame(frame: VisionFrame): boolean {
  return frame.movement?.any === true;
}

/* -------------------------------------------------------------------------- */
/* The exercises                                                               */
/* -------------------------------------------------------------------------- */

export interface Exercise {
  /** Stable id — also the `data-move` hook the stage animates from. */
  readonly id: MovementKind;
  /**
   * The warm noise Chiku makes while he does it. WRITTEN FOR THE PARENT TO
   * ECHO: the child cannot read it and mostly cannot parse it either, so it is
   * short, rhythmic and repetitive on purpose — the kind of line an adult in
   * the room will say out loud without being asked to.
   */
  readonly inviteKey: I18nKey;
  /**
   * How long Chiku's demonstration lasts.
   *
   * THESE PACE THE RIG, they do not drive it: each one is the rig's own
   * `MOVES[id].durationMs` plus a short tail so the beat can settle before the
   * child's turn opens. `rig.perform()` returns a promise, but its own contract
   * says to pace yourself rather than await it — under reduced motion it holds
   * a static pose and resolves immediately, and awaiting it would then rush
   * every demonstration to nothing. If a beat's length changes in
   * packages/rig/src/live.ts, change it here too; a demonstration that is cut
   * off mid-stomp is a movement a child cannot copy.
   *
   * Big animals are slow, and these are longer than they feel like they should
   * be on purpose: a movement performed at adult speed is a movement a
   * two-year-old watches instead of copying.
   */
  readonly showMs: number;
}

/**
 * THE ORDER, AND WHY.
 *
 * Sorted by how much of the body has to be under control at once, easiest
 * first, using the ordinary 24-month motor milestones rather than by theme:
 *
 *   1. CLAP    Two hands together. Mastered around twelve months — a full year
 *              of practice before they get here. The first movement must be one
 *              the child cannot help but succeed at, because the first one is
 *              where they learn what this game is.
 *   2. STOMP   Feet, standing, no weight shift held. They have been walking for
 *              nearly a year. It is also the signature elephant move, so it is
 *              placed as early as it can honestly go.
 *   3. SWING   One arm, the trunk. Arms are easier than legs and there is no
 *              balance cost at all; it sits above stomp only because a
 *              one-limbed movement is a slightly odder thing to copy than a
 *              symmetric one.
 *   4. REACH   Both arms overhead. Easy in itself, but arms overhead raises the
 *              centre of mass and a 24-month-old wobbles.
 *   5. SWAY    Lateral weight shift, repeatedly, while upright. Music makes
 *              toddlers do this spontaneously, but doing it ON PURPOSE is a
 *              step up from doing it because a song is on.
 *   6. CROUCH  Squat and return. Needs leg strength plus the confidence to lose
 *              sight of the room on the way down. Around 22-24 months.
 *   7. JUMP    Both feet off the floor at once. This is the classic 24-30 month
 *              milestone and a large share of two-year-olds CANNOT DO IT YET.
 *              It is last precisely because it is the one they will fail at —
 *              and since nothing here can be failed, "jumping" that is really a
 *              deep knee bend gets exactly the same celebration. Chiku never
 *              finds out.
 *
 * The list is walked in order and then WRAPS. A second lap is not a bug and not
 * filler: at this age repetition is the content, and the child who gets to
 * clapping again after four minutes is meeting an old friend.
 */
export const TODDLER_EXERCISES: readonly Exercise[] = Object.freeze([
  { id: "clap", inviteKey: "toddler.move.clap", showMs: 2000 },
  { id: "stomp", inviteKey: "toddler.move.stomp", showMs: 2400 },
  { id: "swing", inviteKey: "toddler.move.swing", showMs: 2800 },
  { id: "reach", inviteKey: "toddler.move.reach", showMs: 2200 },
  { id: "sway", inviteKey: "toddler.move.sway", showMs: 3000 },
  { id: "crouch", inviteKey: "toddler.move.crouch", showMs: 2600 },
  { id: "jump", inviteKey: "toddler.move.jump", showMs: 1700 },
]);

/**
 * How many goes at the SAME movement before a new one.
 *
 * Four, and it is the single most counter-intuitive number in this file. Adult
 * intuition says variety holds attention; toddler research says the opposite —
 * repetition with escalating affect is what they are actually asking for when
 * they say "again". Three feels short to a grown-up watching. Five starts to
 * bore the grown-up, and the grown-up is in the room.
 */
export const REPS_PER_EXERCISE = 4;

/** The exercise for a given bout, wrapping forever. */
export function exerciseAt(index: number): Exercise {
  const list = TODDLER_EXERCISES;
  const at = ((index % list.length) + list.length) % list.length;
  // noUncheckedIndexedAccess: the modulo above makes this total, but the
  // compiler cannot know that and a `!` here would be a lie waiting to happen.
  return list[at] ?? { id: "clap", inviteKey: "toddler.move.clap", showMs: 2000 };
}

/* -------------------------------------------------------------------------- */
/* Delight                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The celebration, ESCALATING with each repetition of the same movement.
 *
 * This is the whole reason repetition works. The fourth stomp is not the first
 * stomp again — it is the first stomp with a bigger reaction, and the child is
 * running the experiment "does he do it MORE if I do it again?". The answer has
 * to be yes.
 *
 * Written as a literal list rather than built from a template so the
 * key-coverage sweep can see every one of them. Repetitions past the end stay
 * at the loudest line; there is no rung down.
 */
export const TODDLER_CHEERS: readonly I18nKey[] = Object.freeze([
  "toddler.cheer.one",
  "toddler.cheer.two",
  "toddler.cheer.three",
  "toddler.cheer.four",
]);

export function cheerFor(rep: number): I18nKey {
  const at = Math.min(Math.max(rep, 0), TODDLER_CHEERS.length - 1);
  return TODDLER_CHEERS[at] ?? "toddler.cheer.one";
}

/* -------------------------------------------------------------------------- */
/* Timing — the contingency window is the constraint                           */
/* -------------------------------------------------------------------------- */

/**
 * A reaction that lands more than about a second after the movement is not
 * perceived as caused by the movement — the child does not connect the two and
 * the loop never closes. So the detection path is synchronous inside the vision
 * callback and the celebration is fired from there, not from a poll.
 *
 * These are the timings AROUND that instant reaction.
 */
export const TODDLER_TIMING = {
  /** With a camera: how long the child gets before Chiku celebrates anyway. */
  waitWatchedMs: 2600,
  /**
   * With no camera: shorter, because nothing is being waited FOR. Chiku
   * performs, pauses just long enough for a copy to happen, and delights. A
   * two-year-old copying a dancing elephant does not need to be measured.
   */
  waitSoloMs: 1400,
  /**
   * How long the delight lasts before the next go.
   *
   * LOAD-BEARING, and longer than `MovementDetector`'s 1200ms latch on purpose.
   * The watcher is reset at the top of every demonstration, but the engine's
   * own `frame.movement` (when it lands) cannot be reset from here — so the
   * celebration alone has to outlast a latch, or the movement we just cheered
   * would still be latched when the next wait opens and would cheer itself. A
   * cheer plus a demonstration is over three seconds; the latch is long cold.
   */
  cheerMs: 1700,
} as const;
