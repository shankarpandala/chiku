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
  HAND_LANDMARK_COUNT,
  isOpenPalm,
  MAX_AMBIGUOUS_FINGERS,
  THUMB_EXTENDED_MIN_ANGLE_DEG,
  type FingerThresholds,
  type HandCount,
  type Landmark,
} from "./fingers";

export { faceToGaze, type BlendshapeCategory } from "./gaze";

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
