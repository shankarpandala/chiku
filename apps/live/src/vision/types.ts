// The contract between the on-device vision layer and everything that consumes
// it. Pinned here so the vision implementation and the surfaces can be built
// against the same shape.
//
// INVARIANT: nothing in this module — or downstream of it — may transmit a
// frame, a landmark, or any derived image data. Inference is on-device; the
// only thing that ever leaves `vision/` is the small structured summary below.

import type { VisionCalibration } from "./calibration";
import type { MovementKind } from "./movement";
import type { Quad } from "./quad";

/** Normalized gaze/attention derived from the face. */
export interface FaceSignal {
  /** Face centre in normalized screen space: -1 (left) … +1 (right). */
  x: number;
  /** -1 (up) … +1 (down). */
  y: number;
  /** Rough "is the child facing the screen" score, 0..1. */
  attention: number;
  /** 0..1 smile strength (blendshapes), for warm reactions — never scored. */
  smile: number;
}

/** Per-hand summary. Counting is angle-based; see the implementation notes. */
export interface HandSignal {
  /** "Left" | "Right" as MediaPipe reports it (anatomical, on unmirrored input). */
  handedness: string;
  /** Extended-finger count 0..5, or null when the hand is too ambiguous to score. */
  fingers: number | null;
  /** Per-finger extension, thumb first. */
  extended: readonly [boolean, boolean, boolean, boolean, boolean];
  /** Canned gesture label when confident (confirming signal only, never a gate). */
  gesture: string | null;
  /** Wrist position, normalized 0..1 in image space. */
  wrist: { x: number; y: number };
}

/**
 * Whole-body movement seen this frame, as plain booleans.
 *
 * Booleans and not the detector, deliberately: an activity stays a pure
 * predicate over one frame, so it can be tested from a hand-built literal and
 * can never accidentally hold on to rolling state that outlives a round.
 *
 * Each flag LATCHES for ~1.2s after the movement ends (see `MovementDetector`).
 * A 2-year-old's jump is over before the next inference lands; if the flag went
 * false the instant they touched down, the celebration would be cut off — or
 * never start — and the child would not connect the reaction to their own body.
 *
 * NONE OF THESE IS A SCORE. There is no threshold to pass and no failure state
 * anywhere downstream of them: they say "this happened", never "this was good
 * enough".
 */
export interface MovementSignal {
  /** Face rose sharply and came back down — a toddler hop counts. */
  readonly jump: boolean;
  /** Face dropped and stayed down long enough to be a deliberate crouch. */
  readonly crouch: boolean;
  /** Body oscillating side to side, real direction changes rather than wobble. */
  readonly sway: boolean;
  /** Rhythmic vertical bounce — the elephant stomp. */
  readonly stomp: boolean;
  /** A hand held above the head. */
  readonly reach: boolean;
  /** Wrists came together. */
  readonly clap: boolean;
  /** One arm swinging horizontally, trunk-style. */
  readonly swing: boolean;
  /**
   * Any of the above. The "they are doing SOMETHING" signal — which at this age
   * is the one that most deserves a reaction, because the child is not copying
   * an instruction they understood, they are moving because Chiku moved.
   */
  readonly any: boolean;
}

/**
 * Compile-time guard: every `MovementKind` has a field on `MovementSignal`.
 * Add a kind to the detector without adding it here and this alias stops
 * compiling, rather than the flag silently never reaching an activity.
 */
type Assert<T extends true> = T;
type MovementSignalIsComplete = Assert<
  [Exclude<MovementKind, keyof MovementSignal>] extends [never] ? true : false
>;
export type { MovementSignalIsComplete };

export interface VisionFrame {
  /** Milliseconds, from the vision clock. */
  t: number;
  /**
   * The PRIMARY person's face, or null when the tracker did not find them this
   * frame. Which person that is stays locked across frames — a sibling walking
   * through does not become "the child". Still nulls out on a single dropped
   * frame: `facePresence` is the forgiving version of this signal.
   */
  face: FaceSignal | null;
  /** Every hand seen this frame, primary person's or not. */
  hands: readonly HandSignal[];
  /**
   * Total extended fingers across the PRIMARY person's hands — both of theirs,
   * and nobody else's — or null if none scoreable. A parent's resting hand in
   * frame must not add to the count, and a sibling's 2 plus the child's 1 must
   * not read as "three".
   */
  totalFingers: number | null;
  /** True while the PRIMARY person is waving (wrist oscillation + open palm). */
  waving: boolean;
  /**
   * How strongly we believe the primary person's face is there, 0..1. Rises
   * fast, decays slowly, and holds flat through a ~25-frame tracker dropout, so
   * unlike `face` it does not read as "gone" the moment the tracker blinks.
   *
   * Optional only so existing frame literals keep compiling; the engine always
   * sets it. Prefer this over `face !== null` for anything a child can see
   * change — a state flip they cannot perceive as caused by them reads as
   * random.
   */
  facePresence?: number;
  /**
   * The magic window the PRIMARY person is making with their hands, or null
   * when there is none. Nobody else's hands can make one — a sibling reaching
   * into frame must not take the child's window away from them.
   *
   * `quad.presence` is a 0..1 fade, not a boolean: bind opacity to it and the
   * window eases in and out and survives a tracker blink. Treating
   * `quad !== null` as "showing" and jumping straight to full opacity throws
   * away the whole point of the smoothing behind it.
   *
   * Optional only so existing frame literals keep compiling; the engine always
   * sets it, to a value or to null.
   */
  quad?: Quad | null;
  /**
   * How much of the magic window is the colour the current hunt is asking for,
   * 0..1 — `undefined` when nothing is measuring.
   *
   * THIS ONE DOES NOT COME FROM THE VISION LAYER, and that is deliberate. The
   * lens already has to read the window's pixels back to *draw* the effect
   * (see magicLens.ts on why the pass is CPU), so the coverage number falls
   * out of the render pass for free. Computing it a second time inside the
   * engine would mean two samplers, two thresholds, and two chances to
   * disagree about whether the child found the red thing — while the child
   * watches one of them glow.
   *
   * So the surface merges the render layer's latest figure onto the frame
   * before an activity sees it, and the activity contract stays "one
   * predicate over one frame". Nothing here is stored or transmitted: the
   * pixels it was derived from lived for one paint (§9).
   */
  windowCoverage?: number;
  /**
   * Whole-body movement by the PRIMARY person — jumping, crouching, swaying,
   * stomping, reaching, clapping, swinging an arm. See `MovementSignal`.
   *
   * Derived from the face and wrists we already track, not from a pose model:
   * see the header of `vision/movement.ts` for why that trade is the right one
   * on a device the loop already throttles to 4-6fps.
   *
   * PRIMARY PERSON ONLY, like `totalFingers` and `quad` — a sibling bouncing
   * past the camera must not make the child's Chiku celebrate a jump the child
   * did not do. At this age that is not a scoring error, it is worse: the
   * reaction stops being contingent on their own body, which is the entire
   * thing the loop is teaching.
   *
   * Undefined until the detector has a few frames of history (and on any frame
   * literal that predates this field). Read it as "no evidence", never as
   * "they did not move" — there is no failure state here.
   */
  movement?: MovementSignal;
}

export type VisionStatus =
  | "idle"
  | "loading"
  | "ready"
  | "denied"
  | "unavailable"
  | "error";

export interface VisionEngine {
  readonly status: VisionStatus;
  /** Requests the camera and starts inference. Resolves once running. */
  start(video: HTMLVideoElement): Promise<void>;
  stop(): void;
  /**
   * Swap the finger thresholds the next frame is scored against.
   *
   * This is how the assist ladder's "easier" and "together" rungs relax the
   * ANGLES (the hold half lives in the surface). It takes effect on the next
   * frame — no camera restart, no model reload, nothing the child can see or
   * hear happening — because being visibly handed an easier version is a small
   * humiliation and they did not ask for one.
   *
   * Callable in any state, including before `start()` and after `stop()`: the
   * surface sets a rung whenever the rung changes and cannot be expected to
   * know whether the camera happens to be open. An explicit call also OUTRANKS
   * the stored per-child calibration that `start()` would otherwise re-read,
   * so a rung set before the camera opens is still in force once it does.
   */
  setCalibration(next: VisionCalibration): void;
  onFrame(cb: (frame: VisionFrame) => void): () => void;
  onStatus(cb: (status: VisionStatus, detail?: string) => void): () => void;
  dispose(): void;
}
