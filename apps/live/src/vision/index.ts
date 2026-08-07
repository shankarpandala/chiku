/**
 * The vision layer's public surface.
 *
 * Importing this module does NOT pull in MediaPipe: `engine.ts` imports the
 * runtime lazily inside `start()`, so the pure maths stays importable (and
 * testable) without an 11MB WASM bundle.
 */

export type {
  FaceSignal,
  HandSignal,
  MovementSignal,
  VisionEngine,
  VisionFrame,
  VisionStatus,
} from "./types";

export {
  createVisionEngine,
  DEFAULT_TARGET_FPS,
  FACE_MODEL_PATH,
  GESTURE_MIN_SCORE,
  HAND_MODEL_PATH,
  VISION_WASM_PATH,
  type VisionEngineOptions,
} from "./engine";

export {
  ADULT_THRESHOLDS,
  AMBIGUITY_BAND_DEG,
  angleAtDeg,
  countExtendedFingers,
  FINGER_EXTENDED_MIN_ANGLE_DEG,
  FINGER_EXTENDED_RELEASE_ANGLE_DEG,
  FINGER_HYSTERESIS_DEG,
  HAND_LANDMARK_COUNT,
  isOpenPalm,
  MAX_AMBIGUOUS_FINGERS,
  StableHandCount,
  THUMB_EXTENDED_MIN_ANGLE_DEG,
  THUMB_EXTENDED_RELEASE_ANGLE_DEG,
  type FingerThresholds,
  type HandCount,
  type Landmark,
} from "./fingers";

export { faceToGaze, type BlendshapeCategory } from "./gaze";

export {
  LM,
  QUAD_THRESHOLDS,
  frameCorners,
  handScale,
  pinchCorners,
  polygonArea,
  quadCentre,
  squareAround,
  type Quad,
  type QuadKind,
} from "./quad";

export {
  KIND_SWITCH_FRAMES,
  MIN_HAND_SCALE,
  PALM_WINDOW_HALF_SCALES,
  PALM_WINDOW_MAX_HALF,
  QUAD_JUMP_THRESHOLD,
  QUAD_LADDER,
  QuadDetector,
  StableQuad,
  isPinchShape,
  opennessOf,
  palmCentre,
  spreadOf,
  type Corners,
  type HandLandmarks,
} from "./quad-detect";

export {
  MOVEMENT,
  MOVEMENT_WINDOW_MS,
  MovementDetector,
  countReversals,
  type MovementKind,
  type MovementSample,
} from "./movement";

export {
  WAVE_MIN_DIRECTION_CHANGES,
  WAVE_WINDOW_MS,
  WaveDetector,
} from "./wave";

export {
  ADULT_DEFAULT_CALIBRATION,
  CALIBRATION_BOUNDS,
  CALIBRATION_STORAGE_KEY,
  clearCalibration,
  getCalibration,
  setCalibration,
  type VisionCalibration,
} from "./calibration";
