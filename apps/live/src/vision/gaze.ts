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
import type { Point, Subject } from "./stability";

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
 * The face's position in the image, normalized 0..1, or null if the mesh is
 * unusable. Eye midpoint horizontally, forehead/chin midpoint vertically — more
 * stable than the nose tip (which swings with yaw) and cheaper than a centroid
 * over 478 points.
 *
 * Exposed separately from `faceToGaze` so the engine can push this through a
 * `StablePoint` (teleport rejection) and hand the smoothed value back in.
 */
export function faceCentre(landmarks: readonly Landmark[] | undefined | null): Point | null {
  if (!landmarks || landmarks.length < REQUIRED_LANDMARKS) return null;
  const eyeLow = landmarks[EYE_OUTER_LOW_X];
  const eyeHigh = landmarks[EYE_OUTER_HIGH_X];
  const forehead = landmarks[FOREHEAD];
  const chin = landmarks[CHIN];
  if (!eyeLow || !eyeHigh || !forehead || !chin) return null;
  return { x: (eyeLow.x + eyeHigh.x) / 2, y: (forehead.y + chin.y) / 2 };
}

/**
 * Bounding box of a whole face mesh as a `SubjectLock` candidate: centre plus
 * the box diagonal as `size`. The diagonal stands in for "how close to the
 * camera" — the child playing is normally the biggest face in the room.
 *
 * Deliberately the box centre rather than `faceCentre`: it is defined by every
 * landmark rather than four, so a single mis-placed eye corner cannot move the
 * identity anchor even though it would move the gaze.
 */
export function faceBounds(landmarks: readonly Landmark[] | undefined | null): Subject | null {
  if (!landmarks || landmarks.length < REQUIRED_LANDMARKS) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return {
    centre: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    size: Math.hypot(maxX - minX, maxY - minY),
  };
}

/**
 * Build a FaceSignal from one face's landmarks and (optionally) its blendshapes.
 *
 * Returns null when there is no usable face — the caller maps that to
 * `VisionFrame.face = null` rather than inventing a centred, attentive face.
 *
 * `centre` overrides the position this reads off the mesh, and exists for
 * exactly one caller: the engine, which routes the raw centre through a
 * `StablePoint` so a one-frame flip to another person cannot yank Chiku's eyes.
 * Orientation (`attention`) is left raw — it is a property of the face we
 * decided to trust, not a position that can teleport.
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
  centre?: Point | null,
): FaceSignal | null {
  if (!landmarks || landmarks.length < REQUIRED_LANDMARKS) return null;

  const nose = landmarks[NOSE_TIP];
  const eyeLow = landmarks[EYE_OUTER_LOW_X];
  const eyeHigh = landmarks[EYE_OUTER_HIGH_X];
  const forehead = landmarks[FOREHEAD];
  const chin = landmarks[CHIN];
  if (!nose || !eyeLow || !eyeHigh || !forehead || !chin) return null;

  const cx = centre ? centre.x : (eyeLow.x + eyeHigh.x) / 2;
  const cy = centre ? centre.y : (forehead.y + chin.y) / 2;

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
