/**
 * Per-child finger-angle calibration.
 *
 * The hand model has no published child-hand training data. Everything in
 * `fingers.ts` is tuned on adult hands, and a four-year-old's fingers are
 * shorter, rounder and rarely straighten past about 160deg even when the child
 * is certain they are holding up five. Without a per-child pass the counter
 * under-reports, and a child who is told "I see four" when they meant five
 * stops playing.
 *
 * PRIVACY (§9): this store holds four numbers and nothing else. No name, no
 * age, no identifier, no timestamps, nothing derived from an image. It is
 * per-device settings data, not a profile — safe under the no-PII invariant.
 * If you are tempted to add a `childName` here, don't.
 */

import { ADULT_THRESHOLDS, type FingerThresholds } from "./fingers";

/** The calibrated values. Structurally the thresholds `countExtendedFingers` takes. */
export type VisionCalibration = FingerThresholds;

export const ADULT_DEFAULT_CALIBRATION: VisionCalibration = ADULT_THRESHOLDS;

export const CALIBRATION_STORAGE_KEY = "chiku.live.vision.calibration.v1";

/** Sane ranges. Anything outside is a bug or a tampered store; clamp, never trust. */
export const CALIBRATION_BOUNDS: Readonly<
  Record<keyof VisionCalibration, readonly [number, number]>
> = Object.freeze({
  fingerAngleDeg: [90, 179],
  thumbAngleDeg: [90, 179],
  ambiguityBandDeg: [0, 30],
  maxAmbiguousFingers: [0, 5],
});

function storage(): Storage | null {
  try {
    // Safari in private mode throws on access, not just on write.
    const store = (globalThis as { localStorage?: Storage }).localStorage;
    return store ?? null;
  } catch {
    return null;
  }
}

function clampField(key: keyof VisionCalibration, value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const bounds = CALIBRATION_BOUNDS[key];
  const rounded = key === "maxAmbiguousFingers" ? Math.round(value) : value;
  return Math.min(bounds[1], Math.max(bounds[0], rounded));
}

/**
 * Read the stored calibration, falling back to the adult defaults field by
 * field. Never throws: a corrupt entry degrades to defaults rather than
 * blanking the camera surface.
 */
export function getCalibration(): VisionCalibration {
  const store = storage();
  if (!store) return ADULT_DEFAULT_CALIBRATION;

  let raw: string | null = null;
  try {
    raw = store.getItem(CALIBRATION_STORAGE_KEY);
  } catch {
    return ADULT_DEFAULT_CALIBRATION;
  }
  if (raw === null) return ADULT_DEFAULT_CALIBRATION;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ADULT_DEFAULT_CALIBRATION;
  }
  if (typeof parsed !== "object" || parsed === null) return ADULT_DEFAULT_CALIBRATION;

  const record = parsed as Record<string, unknown>;
  return Object.freeze({
    fingerAngleDeg:
      clampField("fingerAngleDeg", record["fingerAngleDeg"]) ??
      ADULT_DEFAULT_CALIBRATION.fingerAngleDeg,
    thumbAngleDeg:
      clampField("thumbAngleDeg", record["thumbAngleDeg"]) ??
      ADULT_DEFAULT_CALIBRATION.thumbAngleDeg,
    ambiguityBandDeg:
      clampField("ambiguityBandDeg", record["ambiguityBandDeg"]) ??
      ADULT_DEFAULT_CALIBRATION.ambiguityBandDeg,
    maxAmbiguousFingers:
      clampField("maxAmbiguousFingers", record["maxAmbiguousFingers"]) ??
      ADULT_DEFAULT_CALIBRATION.maxAmbiguousFingers,
  });
}

/**
 * Merge a patch over the current calibration, clamp it, persist it, and return
 * the effective values. Returns the merged values even when storage is
 * unavailable, so a calibration pass still works for the current session.
 */
export function setCalibration(patch: Partial<VisionCalibration>): VisionCalibration {
  const current = getCalibration();
  const next: VisionCalibration = Object.freeze({
    fingerAngleDeg: clampField("fingerAngleDeg", patch.fingerAngleDeg) ?? current.fingerAngleDeg,
    thumbAngleDeg: clampField("thumbAngleDeg", patch.thumbAngleDeg) ?? current.thumbAngleDeg,
    ambiguityBandDeg:
      clampField("ambiguityBandDeg", patch.ambiguityBandDeg) ?? current.ambiguityBandDeg,
    maxAmbiguousFingers:
      clampField("maxAmbiguousFingers", patch.maxAmbiguousFingers) ?? current.maxAmbiguousFingers,
  });

  const store = storage();
  if (store) {
    try {
      store.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota or private mode. The session keeps the value; nothing else to do.
    }
  }
  return next;
}

/** Drop the stored calibration and go back to the adult defaults. */
export function clearCalibration(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(CALIBRATION_STORAGE_KEY);
  } catch {
    // Nothing to do — the defaults are what `getCalibration` will return anyway.
  }
}
