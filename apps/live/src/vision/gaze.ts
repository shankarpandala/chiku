/**
 * Face -> FaceSignal. Pure maths over MediaPipe face-mesh landmarks; no
 * MediaPipe import, so it is unit-testable without a WASM runtime.
 *
 * Deliberately raw-but-clamped: no smoothing, no easing, no hysteresis. The rig
 * already smooths, and smoothing twice makes Chiku's head lag far enough behind
 * the child that the illusion of being looked at breaks.
 *
 * `smile` exists so Chiku can warm up when the child is delighted. It is never
 * scored, never stored, never compared between children.
 */

import type { FaceSignal } from "./types";
import type { Landmark } from "./fingers";

/* -------------------------------------------------------------------------- */
/* Landmark indices (MediaPipe canonical face mesh, 468/478 points)           */
/* -------------------------------------------------------------------------- */

/** Nose tip — the yaw/pitch pointer. */
export const NOSE_TIP = 1;
/** Outer corner of the subject's right eye: the LOW-x side of an unmirrored image. */
export const EYE_OUTER_LOW_X = 33;
/** Outer corner of the subject's left eye: the HIGH-x side of an unmirrored image. */
export const EYE_OUTER_HIGH_X = 263;
/** Top of the forehead. */
export const FOREHEAD = 10;
/** Bottom of the chin. */
export const CHIN = 152;

/** Highest index this module reads; anything shorter is not a usable mesh. */
const REQUIRED_LANDMARKS = EYE_OUTER_HIGH_X + 1;

/* -------------------------------------------------------------------------- */
/* Attention tuning                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Where the nose tip sits vertically between forehead and chin on a face that
 * is looking straight down the lens. Slightly below the midpoint.
 */
export const NEUTRAL_NOSE_V = 0.52;

/** Vertical nose offset (as a fraction of face height) that reads as fully away. */
export const MAX_PITCH_OFFSET = 0.3;

/** How much yaw and pitch each cost attention. Yaw dominates: turning away is
 *  a much stronger "I'm not with you" signal than glancing down. */
export const YAW_WEIGHT = 1;
export const PITCH_WEIGHT = 0.6;

/* -------------------------------------------------------------------------- */

/** A blendshape score as MediaPipe reports it. */
export interface BlendshapeCategory {
  readonly categoryName: string;
  readonly score: number;
}

const SMILE_SHAPES = ["mouthSmileLeft", "mouthSmileRight"] as const;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Build a FaceSignal from one face's landmarks and (optionally) its blendshapes.
 *
 * Returns null when there is no usable face — the caller maps that to
 * `VisionFrame.face = null` rather than inventing a centred, attentive face.
 *
 * NOTE ON MIRRORING: `x` is in raw image space, where +1 is the right-hand side
 * of the *camera's* view. Camera previews are normally mirrored for the child,
 * so a surface that wants "Chiku turns towards the child" should negate x when
 * its preview is mirrored. Doing the flip here would hide it from the surface
 * that needs to know.
 */
export function faceToGaze(
  landmarks: readonly Landmark[] | undefined | null,
  blendshapes?: readonly BlendshapeCategory[] | undefined,
): FaceSignal | null {
  if (!landmarks || landmarks.length < REQUIRED_LANDMARKS) return null;

  const nose = landmarks[NOSE_TIP];
  const eyeLow = landmarks[EYE_OUTER_LOW_X];
  const eyeHigh = landmarks[EYE_OUTER_HIGH_X];
  const forehead = landmarks[FOREHEAD];
  const chin = landmarks[CHIN];
  if (!nose || !eyeLow || !eyeHigh || !forehead || !chin) return null;

  // Centre: eye midpoint horizontally, forehead/chin midpoint vertically. More
  // stable than the nose tip (which swings with yaw) and cheaper than a
  // centroid over 478 points.
  const cx = (eyeLow.x + eyeHigh.x) / 2;
  const cy = (forehead.y + chin.y) / 2;

  const x = clamp(cx * 2 - 1, -1, 1);
  const y = clamp(cy * 2 - 1, -1, 1);

  return {
    x,
    y,
    attention: attentionFrom(nose, eyeLow, eyeHigh, forehead, chin),
    smile: smileFrom(blendshapes),
  };
}

/**
 * "How frontal is this face", 0..1. Yaw is read as the nose tip's position
 * between the two eye corners; pitch as its position between forehead and chin.
 * A face in full profile collapses the eye span, which lands at 0 by itself.
 */
function attentionFrom(
  nose: Landmark,
  eyeLow: Landmark,
  eyeHigh: Landmark,
  forehead: Landmark,
  chin: Landmark,
): number {
  const span = eyeHigh.x - eyeLow.x;
  const yawErr =
    Math.abs(span) < 1e-6 ? 1 : clamp(Math.abs((nose.x - eyeLow.x) / span - 0.5) * 2, 0, 1);

  const height = chin.y - forehead.y;
  const pitchErr =
    Math.abs(height) < 1e-6
      ? 1
      : clamp(
          Math.abs((nose.y - forehead.y) / height - NEUTRAL_NOSE_V) / MAX_PITCH_OFFSET,
          0,
          1,
        );

  return clamp(1 - (yawErr * YAW_WEIGHT + pitchErr * PITCH_WEIGHT), 0, 1);
}

/** Mean of the two smile blendshapes; 0 when blendshapes are unavailable. */
function smileFrom(blendshapes: readonly BlendshapeCategory[] | undefined): number {
  if (!blendshapes || blendshapes.length === 0) return 0;
  let sum = 0;
  let seen = 0;
  for (const shape of blendshapes) {
    if ((SMILE_SHAPES as readonly string[]).includes(shape.categoryName)) {
      sum += shape.score;
      seen += 1;
    }
  }
  return seen === 0 ? 0 : clamp(sum / seen, 0, 1);
}
