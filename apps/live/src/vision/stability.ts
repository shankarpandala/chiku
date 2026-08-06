// The forgiveness layer.
//
// Ported from what makes github.com/sophiamyang/finger-frame-effect-lucy feel
// good — which turns out to have nothing to do with its AI video and everything
// to do with refusing to believe the tracker too quickly. Five ideas, all pure
// arithmetic, all free:
//
//   1. HYSTERESIS      strict to acquire, loose to keep (0.75 in, 0.2 out)
//   2. TELEPORT REJECT  a jump > 30% of frame needs 2 consecutive frames
//   3. ADAPTIVE EMA     alpha 0.35 when still, 0.85 when moving fast
//   4. LOST-FRAME HOLD  keep the last good value through ~25 dropped frames
//   5. PRESENCE FADE    rise +0.12 / decay -0.05 per frame, never pop
//
// Why this matters more for us than for the reference: a 3-year-old's hand
// wobbles, their attention flicks away constantly, and our own engine throttles
// slow devices to 4-6fps. Everything here is therefore counted in FRAMES, not
// milliseconds — a wall-clock tolerance silently becomes zero tolerance the
// moment the device gets slow, which is exactly when forgiveness is needed.

/** Enter/exit threshold pair. Cross `enter` to acquire, fall below `exit` to release. */
export interface Hysteresis {
  readonly enter: number;
  readonly exit: number;
}

/**
 * A boolean signal that is hard to start and easy to keep — the shape of every
 * "is the child doing the thing" question in this app.
 */
export class HysteresisGate {
  #on = false;

  constructor(private readonly band: Hysteresis) {}

  /** Feed a raw score; returns the debounced state. */
  update(value: number): boolean {
    this.#on = this.#on ? value > this.band.exit : value >= this.band.enter;
    return this.#on;
  }

  get on(): boolean {
    return this.#on;
  }

  reset(): void {
    this.#on = false;
  }
}

/**
 * Presence: how confident we are that the thing is there, as a 0..1 value that
 * rises fast and decays slowly. UI bound to this fades instead of strobing —
 * a state change a child cannot perceive as caused by them reads as random.
 */
export const PRESENCE_RISE = 0.12;
export const PRESENCE_DECAY = 0.05;
/** Frames of tracker dropout tolerated before presence starts falling at all. */
export const DEFAULT_LOST_FRAMES = 25;

export class Presence {
  #value = 0;
  #lost = 0;

  constructor(
    private readonly maxLostFrames: number = DEFAULT_LOST_FRAMES,
    private readonly rise: number = PRESENCE_RISE,
    private readonly decay: number = PRESENCE_DECAY,
  ) {}

  /** One frame. `seen` = the tracker found it this frame. */
  update(seen: boolean): number {
    if (seen) {
      this.#lost = 0;
      this.#value = Math.min(1, this.#value + this.rise);
    } else {
      this.#lost += 1;
      // Inside the dropout window we hold — the child did not go anywhere, the
      // tracker just blinked. Past it, fade rather than cut.
      if (this.#lost > this.maxLostFrames) {
        this.#value = Math.max(0, this.#value - this.decay);
      }
    }
    return this.#value;
  }

  /** True while we still believe in it (held or fully present). */
  get believed(): boolean {
    return this.#value > 0;
  }

  get value(): number {
    return this.#value;
  }

  get lostFrames(): number {
    return this.#lost;
  }

  reset(): void {
    this.#value = 0;
    this.#lost = 0;
  }
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Frames a suspiciously large jump must persist before we believe it. */
export const JUMP_CONFIRM_FRAMES = 2;

/**
 * A smoothed 2D point that rejects teleports and adapts its own smoothing to
 * speed: heavy damping when nearly still (so a resting hand does not jitter),
 * light damping when moving fast (so tracking does not lag behind a wave).
 *
 * Coordinates are normalized 0..1 (or -1..1); `jumpThreshold` is in the same
 * units, so callers never deal in pixels.
 */
export class StablePoint {
  #current: Point | null = null;
  #pendingJump = 0;

  constructor(
    private readonly jumpThreshold = 0.3,
    private readonly minAlpha = 0.35,
    private readonly maxAlpha = 0.85,
    /** Movement (in normalized units) that saturates alpha at maxAlpha. */
    private readonly fastMove = 0.05,
  ) {}

  /** Feed the raw observation; returns the value to actually use, or null. */
  update(next: Point | null): Point | null {
    if (next === null) return this.#current;
    if (this.#current === null) {
      this.#current = next;
      return this.#current;
    }

    const moved = distance(this.#current, next);
    if (moved > this.jumpThreshold) {
      // Probably a different person, or a mis-detection. Disbelieve it until it
      // insists — a sibling walking through frame does not get to move Chiku's
      // eyes, but the child genuinely lunging sideways still does.
      this.#pendingJump += 1;
      if (this.#pendingJump < JUMP_CONFIRM_FRAMES) return this.#current;
      this.#current = next;
      this.#pendingJump = 0;
      return this.#current;
    }
    this.#pendingJump = 0;

    const alpha = Math.min(this.maxAlpha, Math.max(this.minAlpha, moved / this.fastMove));
    this.#current = {
      x: this.#current.x + (next.x - this.#current.x) * alpha,
      y: this.#current.y + (next.y - this.#current.y) * alpha,
    };
    return this.#current;
  }

  get value(): Point | null {
    return this.#current;
  }

  reset(): void {
    this.#current = null;
    this.#pendingJump = 0;
  }
}

/**
 * Which person are we playing with?
 *
 * MediaPipe hands us whatever it ranks first each frame, so a sibling walking
 * past can silently become "the child": Chiku's gaze snaps to them, their smile
 * completes the activity, their fingers add to the count. This picks one
 * subject and sticks with them — nearest to the previously tracked position,
 * else the largest/most central candidate — and tolerates dropouts.
 */
export interface Subject {
  /** Normalized centre, 0..1 image space. */
  readonly centre: Point;
  /** Rough size (e.g. bounding-box diagonal), used to break ties on first pick. */
  readonly size: number;
}

export class SubjectLock<T extends Subject> {
  #last: Point | null = null;
  #lost = 0;

  constructor(
    /** How far the subject may move between frames and still be "the same one". */
    private readonly maxDrift = 0.25,
    private readonly maxLostFrames = DEFAULT_LOST_FRAMES,
  ) {}

  /** Pick this frame's subject from all candidates, or null if none qualify. */
  pick(candidates: readonly T[]): T | null {
    if (candidates.length === 0) {
      this.#lost += 1;
      if (this.#lost > this.maxLostFrames) this.#last = null;
      return null;
    }
    this.#lost = 0;

    const last = this.#last;
    let chosen: T | undefined;
    if (last !== null) {
      let best = Number.POSITIVE_INFINITY;
      for (const c of candidates) {
        const d = distance(last, c.centre);
        if (d < best && d <= this.maxDrift) {
          best = d;
          chosen = c;
        }
      }
    }
    if (chosen === undefined) {
      // No continuity: take the most prominent candidate. Biggest wins, which
      // in practice is the person closest to the camera — the child playing.
      chosen = candidates.reduce((a, b) => (b.size > a.size ? b : a));
    }
    this.#last = chosen.centre;
    return chosen;
  }

  reset(): void {
    this.#last = null;
    this.#lost = 0;
  }
}
