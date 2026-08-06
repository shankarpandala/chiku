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
 *
 * "Per-hand" is the hard part, and `WaveTracker` at the bottom of this file is
 * what makes it true — see the comment there.
 */

import { DEFAULT_LOST_FRAMES, distance, type Point } from "./stability";

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

/* -------------------------------------------------------------------------- */
/* Hand identity                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How far a wrist may move between processed frames and still be the same hand.
 * Generous, because the loop drops to 4-6fps on a slow device and a child's
 * hand covers real ground in 200ms.
 */
export const WAVE_HAND_MAX_DRIFT = 0.25;

/** One hand's observation for a frame. */
export interface WaveHandSample {
  /** Wrist position, normalized 0..1 in image space. */
  readonly wrist: Point;
  /** Whether the palm was open on this frame. */
  readonly open: boolean;
}

/** Per-hand result, aligned index-for-index with the samples passed in. */
export interface WaveHandResult {
  /** Stable identity for this physical hand across frames. */
  readonly id: number;
  readonly waving: boolean;
}

interface Track {
  readonly id: number;
  readonly detector: WaveDetector;
  wrist: Point;
  lost: number;
}

/**
 * Wave detectors keyed by *tracked hand identity*.
 *
 * The obvious key — MediaPipe's handedness label, plus arrival order to break
 * ties — is not stable. Two right hands in frame (a child and a parent, or one
 * hand mis-labelled for a frame) swap positions in the result array whenever
 * the detector's internal ranking changes, and each detector then receives
 * alternating samples from two different hands. Two people each making half a
 * motion merge into one phantom oscillation, and Chiku greets nobody.
 *
 * So identity comes from continuity instead: each hand is matched to the
 * nearest previously-tracked wrist within `maxDrift`, closest pair first. A
 * track whose hand disappears is kept for `maxLostFrames` (the tracker blinks
 * constantly) and only then dropped.
 */
export class WaveTracker {
  #tracks: Track[] = [];
  #nextId = 1;

  constructor(
    private readonly maxDrift: number = WAVE_HAND_MAX_DRIFT,
    private readonly maxLostFrames: number = DEFAULT_LOST_FRAMES,
  ) {}

  /** How many hands are currently being tracked (including held dropouts). */
  get size(): number {
    return this.#tracks.length;
  }

  /**
   * One frame, all hands at once.
   *
   * @param t     milliseconds on the vision clock (monotonic)
   * @param hands every hand seen this frame, in whatever order they arrived
   * @returns one result per hand, in the same order
   */
  update(t: number, hands: readonly WaveHandSample[]): readonly WaveHandResult[] {
    const claimedTrack = new Set<number>();
    const assignment = new Map<number, Track>();

    // Greedy, closest pair first. With at most a handful of hands the cost is
    // nothing, and taking the closest pair globally (rather than per hand in
    // arrival order) is what stops two adjacent hands from stealing each
    // other's track when they cross.
    const pairs: { hand: number; track: Track; d: number }[] = [];
    for (let i = 0; i < hands.length; i += 1) {
      const hand = hands[i];
      if (!hand) continue;
      for (const track of this.#tracks) {
        const d = distance(track.wrist, hand.wrist);
        if (d <= this.maxDrift) pairs.push({ hand: i, track, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    for (const pair of pairs) {
      if (assignment.has(pair.hand) || claimedTrack.has(pair.track.id)) continue;
      assignment.set(pair.hand, pair.track);
      claimedTrack.add(pair.track.id);
    }

    const results: WaveHandResult[] = [];
    for (let i = 0; i < hands.length; i += 1) {
      const hand = hands[i];
      if (!hand) continue;
      let track = assignment.get(i);
      if (!track) {
        track = { id: this.#nextId, detector: new WaveDetector(), wrist: hand.wrist, lost: 0 };
        this.#nextId += 1;
        this.#tracks.push(track);
        claimedTrack.add(track.id);
      }
      track.wrist = hand.wrist;
      track.lost = 0;
      results.push({ id: track.id, waving: track.detector.push(t, hand.wrist.x, hand.open) });
    }

    // Age out tracks nobody claimed. A hand that comes back inside the window
    // keeps its history; the detector's own 1.2s sample window discards
    // anything stale, so a long dropout cannot stitch two motions together.
    this.#tracks = this.#tracks.filter((track) => {
      if (claimedTrack.has(track.id)) return true;
      track.lost += 1;
      if (track.lost <= this.maxLostFrames) return true;
      track.detector.reset();
      return false;
    });

    return results;
  }

  /** Forget every hand. Call when the camera stops. */
  reset(): void {
    for (const track of this.#tracks) track.detector.reset();
    this.#tracks = [];
  }
}
