// Whole-body movement, read from signals we already have.
//
// The obvious way to detect a toddler jumping is PoseLandmarker. We are not
// doing that, and the reason is not laziness: pose is another 5-9MB model and
// another inference per frame on a device the engine already throttles to
// 4-6fps. Meanwhile the FACE we already track tells us almost everything —
// a jump is the face going sharply up and coming back; a crouch is it dropping
// and staying; a sway is it oscillating sideways. Wrists give the rest.
//
// So: no new model, no new bytes, no new frame cost. If some future exercise
// genuinely needs knees or feet, add pose then and only for that.
//
// EVERYTHING HERE IS TUNED FOR A 2-YEAR-OLD, which means it is tuned to say
// YES. A toddler's "jump" often leaves the ground by nothing at all; their
// "stomp" is a wobble. The thresholds below are deliberately low and the
// windows deliberately long. A false positive costs a moment of undeserved
// delight. A false negative costs a child who moved their whole body and was
// told, in effect, that it did not count — and at this age that is how you
// teach someone the screen is not really watching.

import type { Point } from "./stability";

/** A short history of where the body was, in normalized image space. */
export interface MovementSample {
  /** Milliseconds. */
  readonly t: number;
  /** Face centre, 0..1 image space. Null when the tracker lost them. */
  readonly face: Point | null;
  /** Wrist positions this frame, 0..1 image space. */
  readonly wrists: readonly Point[];
}

export type MovementKind =
  /** Both feet leave (or nearly leave) the floor — face rises then returns. */
  | "jump"
  /** Down small — face drops and stays down. */
  | "crouch"
  /** Side to side, at least two direction changes. */
  | "sway"
  /** Rhythmic vertical bounce — the elephant stomp. */
  | "stomp"
  /** Both hands up above the head. */
  | "reach"
  /** Hands come together. */
  | "clap"
  /** One arm swinging, trunk-style. */
  | "swing";

/**
 * Thresholds, in normalized image units (a face is roughly 0.2-0.3 tall at
 * arm's length). LOW ON PURPOSE — see the header.
 */
export const MOVEMENT = {
  /** Face rise that counts as a jump. ~4% of frame height: a toddler hop. */
  jumpRise: 0.035,
  /** …and it must come back down within this, or it was standing up. */
  jumpReturnMs: 1400,
  /** Face drop that counts as a crouch. */
  crouchDrop: 0.06,
  /** …held for this long, so bending to look at something does not count. */
  crouchHoldMs: 400,
  /** Horizontal travel per direction change for a sway. */
  swayTravel: 0.05,
  /** Direction changes needed, within swayWindowMs. */
  swayChanges: 2,
  swayWindowMs: 2500,
  /** Vertical oscillations for a stomp, and the window they must fall in. */
  stompBounces: 2,
  stompWindowMs: 2500,
  stompAmplitude: 0.02,
  /** Wrist above face centre by this much = reaching up. */
  reachAbove: 0.05,
  /** Wrists within this of each other = a clap. */
  clapDistance: 0.12,
  /** One wrist's horizontal travel for a trunk swing. */
  swingTravel: 0.08,
  swingChanges: 2,
  swingWindowMs: 2500,
} as const;

/** How much history to keep. Long enough for the slowest window above. */
export const MOVEMENT_WINDOW_MS = 3000;

/**
 * Rolling detector over the sample history. One instance per session; feed it
 * every frame and ask what it has seen recently.
 *
 * `saw(kind)` LATCHES: once a movement is detected it stays true for
 * `latchMs`, because a 2-year-old's celebration should not depend on them
 * still being mid-jump when the render happens.
 */
export class MovementDetector {
  #samples: MovementSample[] = [];
  #latched = new Map<MovementKind, number>();

  constructor(private readonly latchMs = 1200) {}

  push(sample: MovementSample): void {
    this.#samples.push(sample);
    const cutoff = sample.t - MOVEMENT_WINDOW_MS;
    while (this.#samples.length > 0 && (this.#samples[0]?.t ?? 0) < cutoff) {
      this.#samples.shift();
    }
    for (const kind of this.#detectAll(sample.t)) {
      this.#latched.set(kind, sample.t);
    }
  }

  /** Has this movement happened recently enough to still be celebrating it? */
  saw(kind: MovementKind, now: number): boolean {
    const at = this.#latched.get(kind);
    return at !== undefined && now - at <= this.latchMs;
  }

  /** Any movement at all — the "he is doing SOMETHING" signal. */
  sawAnything(now: number): boolean {
    for (const [, at] of this.#latched) {
      if (now - at <= this.latchMs) return true;
    }
    return false;
  }

  /** True when we have enough history to judge; before that, no evidence. */
  get ready(): boolean {
    return this.#samples.length >= 4;
  }

  reset(): void {
    this.#samples = [];
    this.#latched.clear();
  }

  #faces(): Array<{ t: number; p: Point }> {
    const out: Array<{ t: number; p: Point }> = [];
    for (const s of this.#samples) {
      if (s.face !== null) out.push({ t: s.t, p: s.face });
    }
    return out;
  }

  #detectAll(now: number): MovementKind[] {
    const found: MovementKind[] = [];
    const faces = this.#faces();

    if (faces.length >= 3) {
      const ys = faces.map((f) => f.p.y);
      const baseline = median(ys);
      const highest = Math.min(...ys);
      const lowest = Math.max(...ys);

      // JUMP: y is smaller higher up in image space, so a rise is a decrease.
      if (baseline - highest >= MOVEMENT.jumpRise) {
        const peak = faces.find((f) => f.p.y === highest);
        const returned = faces.some(
          (f) => peak !== undefined && f.t > peak.t && f.p.y >= baseline - MOVEMENT.jumpRise * 0.4,
        );
        const inTime = peak !== undefined && now - peak.t <= MOVEMENT.jumpReturnMs;
        if (returned && inTime) found.push("jump");
      }

      // CROUCH: dropped and stayed dropped.
      if (lowest - baseline >= MOVEMENT.crouchDrop) {
        const low = faces.filter((f) => f.p.y >= baseline + MOVEMENT.crouchDrop * 0.7);
        const first = low[0];
        const last = low[low.length - 1];
        if (first !== undefined && last !== undefined && last.t - first.t >= MOVEMENT.crouchHoldMs) {
          found.push("crouch");
        }
      }

      const recent = faces.filter((f) => now - f.t <= MOVEMENT.swayWindowMs);
      if (countReversals(recent.map((f) => f.p.x), MOVEMENT.swayTravel) >= MOVEMENT.swayChanges) {
        found.push("sway");
      }
      const bouncing = faces.filter((f) => now - f.t <= MOVEMENT.stompWindowMs);
      if (countReversals(bouncing.map((f) => f.p.y), MOVEMENT.stompAmplitude) >= MOVEMENT.stompBounces * 2) {
        found.push("stomp");
      }
    }

    const last = this.#samples[this.#samples.length - 1];
    const face = last?.face ?? null;
    const wrists = last?.wrists ?? [];

    if (face !== null && wrists.length > 0) {
      const up = wrists.filter((w) => face.y - w.y >= MOVEMENT.reachAbove);
      if (up.length >= 1) found.push("reach");
    }
    const [a, b] = wrists;
    if (a !== undefined && b !== undefined) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d <= MOVEMENT.clapDistance) found.push("clap");
    }

    // SWING: one wrist oscillating horizontally, trunk-style.
    const wristXs: number[] = [];
    for (const s of this.#samples) {
      if (now - s.t > MOVEMENT.swingWindowMs) continue;
      const w = s.wrists[0];
      if (w !== undefined) wristXs.push(w.x);
    }
    if (countReversals(wristXs, MOVEMENT.swingTravel) >= MOVEMENT.swingChanges) found.push("swing");

    return found;
  }
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
}

/** Direction changes in a series, ignoring wobble smaller than `travel`. */
export function countReversals(xs: readonly number[], travel: number): number {
  let reversals = 0;
  let dir = 0;
  let anchor = xs[0];
  if (anchor === undefined) return 0;
  for (const x of xs) {
    const delta = x - anchor;
    if (Math.abs(delta) < travel) continue;
    const next = delta > 0 ? 1 : -1;
    if (dir !== 0 && next !== dir) reversals += 1;
    dir = next;
    anchor = x;
  }
  return reversals;
}
