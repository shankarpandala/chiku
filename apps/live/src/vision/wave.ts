/**
 * Wave detection — a tiny stateful detector over wrist x, kept pure of
 * MediaPipe so it can be driven from fixtures in tests.
 *
 * A wave is not "the hand moved". A child reaching for a biscuit sweeps their
 * wrist right across the frame and that must not read as hello. What separates
 * a wave is *oscillation*: the wrist reverses direction at least twice inside
 * about a second, with the palm open the whole time.
 *
 * Feed it one sample per processed vision frame. It is per-hand: give each hand
 * its own detector, and `reset()` when that hand leaves the frame.
 */

/** Rolling window a wave has to happen inside. */
export const WAVE_WINDOW_MS = 1200;

/** Reversals of travel direction required inside the window. */
export const WAVE_MIN_DIRECTION_CHANGES = 2;

/**
 * Movement (in normalized image x) that counts as real travel rather than
 * landmark jitter. Below this the sample does not update the direction.
 */
export const WAVE_MIN_DELTA = 0.015;

/** Total significant travel required, so a tiny tremor cannot qualify. */
export const WAVE_MIN_TRAVEL = 0.08;

/**
 * Fraction of the window that must have had an open palm. Not 1.0: the finger
 * count legitimately drops out for a frame or two mid-wave as the hand blurs.
 */
export const WAVE_MIN_OPEN_RATIO = 0.6;

/** Hard cap on retained samples, so a stalled clock cannot grow the buffer. */
const MAX_SAMPLES = 240;

interface Sample {
  readonly t: number;
  readonly x: number;
  readonly open: boolean;
}

export class WaveDetector {
  #samples: Sample[] = [];
  #waving = false;

  /** True while the detector considers a wave to be in progress. */
  get waving(): boolean {
    return this.#waving;
  }

  /**
   * Record one frame.
   *
   * @param t        milliseconds on the vision clock (monotonic)
   * @param wristX   wrist x, normalized 0..1 in image space
   * @param openPalm whether the palm was open on this frame
   * @returns the current waving state
   */
  push(t: number, wristX: number, openPalm: boolean): boolean {
    const last = this.#samples[this.#samples.length - 1];
    // A clock that went backwards means the stream restarted; start clean.
    if (last && t < last.t) this.reset();

    this.#samples.push({ t, x: wristX, open: openPalm });

    const cutoff = t - WAVE_WINDOW_MS;
    while (this.#samples.length > 0) {
      const head = this.#samples[0];
      if (head && head.t >= cutoff) break;
      this.#samples.shift();
    }
    while (this.#samples.length > MAX_SAMPLES) this.#samples.shift();

    this.#waving = openPalm && this.#openRatio() >= WAVE_MIN_OPEN_RATIO && this.#oscillates();
    return this.#waving;
  }

  /** Forget everything. Call when the hand leaves the frame or the run stops. */
  reset(): void {
    this.#samples = [];
    this.#waving = false;
  }

  #openRatio(): number {
    if (this.#samples.length === 0) return 0;
    let open = 0;
    for (const s of this.#samples) if (s.open) open += 1;
    return open / this.#samples.length;
  }

  /**
   * Count direction reversals over the window, ignoring sub-jitter movement.
   * A single sweep produces one direction and zero reversals; a wave produces
   * one reversal per change of hand direction.
   */
  #oscillates(): boolean {
    const first = this.#samples[0];
    if (!first) return false;

    let anchor = first.x;
    let direction = 0;
    let changes = 0;
    let travel = 0;

    for (let i = 1; i < this.#samples.length; i += 1) {
      const sample = this.#samples[i];
      if (!sample) continue;
      const delta = sample.x - anchor;
      if (Math.abs(delta) < WAVE_MIN_DELTA) continue;

      const next = delta > 0 ? 1 : -1;
      if (direction !== 0 && next !== direction) changes += 1;
      direction = next;
      travel += Math.abs(delta);
      anchor = sample.x;
    }

    return changes >= WAVE_MIN_DIRECTION_CHANGES && travel >= WAVE_MIN_TRAVEL;
  }
}
