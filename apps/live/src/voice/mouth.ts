/**
 * The mouth estimate.
 *
 * THIS IS NOT LOUDNESS. SpeechSynthesis hands back no audio stream, no
 * amplitude, no spectrum — there is literally nothing to analyse, and there is
 * no supported way to route synthesised speech into a WebAudio analyser. So
 * every number in this file is invented: a rhythm chosen because it *reads* as
 * talking, paced by the only real signal the platform gives us (word-boundary
 * events, where they exist).
 *
 * Treat it as animation, not measurement. If a future path ever produces real
 * audio for Chiku's lines, this module should be deleted rather than tuned.
 */

/** A talking mouth is never fully shut between syllables. */
export const JAW_MIN = 0.15;
/** And never at full gape either — that reads as a yawn, not speech. */
export const JAW_MAX = 0.9;

/** How long the jaw takes to climb back out of a word-boundary dip. */
export const BOUNDARY_DIP_MS = 90;

/**
 * Two incommensurate frequencies, deliberately. A single sine is a metronome —
 * a glove puppet flapping on the beat — and that is the exact tell we are
 * avoiding. ~3.7Hz sits near a syllable rate; ~6.3Hz adds the smaller mouth
 * movement that happens inside a syllable. Their ratio is irrational enough
 * that the combined shape does not visibly repeat over the length of a line.
 */
const SLOW_HZ = 3.7;
const FAST_HZ = 6.3;
const SLOW_WEIGHT = 0.62;
const FAST_WEIGHT = 0.38;
/** Offset so the two components do not start aligned at t=0. */
const FAST_PHASE = 1.1;

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Jaw openness for a line that has been speaking for `elapsedMs`.
 *
 * `msSinceBoundary` is the time since the last word-boundary event, or null on
 * platforms (or lines) where no boundary has been reported. Within the dip
 * window the value is scaled toward 0 — that is the mouth closing between
 * words, and it is the one moment the output is allowed below `JAW_MIN`.
 *
 * The return value is always within [0, JAW_MAX], and within
 * [JAW_MIN, JAW_MAX] whenever no dip is active.
 */
export function jawAt(elapsedMs: number, msSinceBoundary: number | null): number {
  const t = Math.max(0, elapsedMs) / 1000;
  // The weights sum to 1, so `mix` is bounded by [-1, 1] whatever the phases do.
  const mix =
    SLOW_WEIGHT * Math.sin(2 * Math.PI * SLOW_HZ * t) +
    FAST_WEIGHT * Math.sin(2 * Math.PI * FAST_HZ * t + FAST_PHASE);
  const base = clamp(JAW_MIN + (JAW_MAX - JAW_MIN) * (mix * 0.5 + 0.5), JAW_MIN, JAW_MAX);

  if (msSinceBoundary === null || msSinceBoundary >= BOUNDARY_DIP_MS) return base;
  const gain = clamp(msSinceBoundary / BOUNDARY_DIP_MS, 0, 1);
  return clamp(base * gain, 0, JAW_MAX);
}
