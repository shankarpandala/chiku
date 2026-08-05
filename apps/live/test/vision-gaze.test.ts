/**
 * faceToGaze — pure, so the fixtures are a hand-built face mesh rather than a
 * captured frame. Only the five landmarks the mapping actually reads are
 * meaningful; the rest exist so the array is mesh-shaped.
 */

import { describe, expect, it } from "vitest";

import {
  CHIN,
  EYE_OUTER_HIGH_X,
  EYE_OUTER_LOW_X,
  FOREHEAD,
  NEUTRAL_NOSE_V,
  NOSE_TIP,
  faceToGaze,
  type BlendshapeCategory,
} from "../src/vision/gaze";

const MESH_POINTS = 478;

interface FaceSpec {
  /** Horizontal centre of the face, 0..1 in image space. */
  cx?: number;
  /** Vertical centre of the face, 0..1 in image space. */
  cy?: number;
  /** Distance between the outer eye corners. */
  eyeSpan?: number;
  /** Forehead-to-chin height. */
  height?: number;
  /** Nose tip across the eye span: 0 = hard left, 0.5 = frontal, 1 = hard right. */
  yaw?: number;
  /** Nose tip down the face: NEUTRAL_NOSE_V is frontal. */
  pitch?: number;
}

function buildFace(spec: FaceSpec = {}): { x: number; y: number; z: number }[] {
  const cx = spec.cx ?? 0.5;
  const cy = spec.cy ?? 0.5;
  const eyeSpan = spec.eyeSpan ?? 0.2;
  const height = spec.height ?? 0.4;
  const yaw = spec.yaw ?? 0.5;
  const pitch = spec.pitch ?? NEUTRAL_NOSE_V;

  const points = Array.from({ length: MESH_POINTS }, () => ({ x: cx, y: cy, z: 0 }));

  const lowX = cx - eyeSpan / 2;
  const top = cy - height / 2;

  points[EYE_OUTER_LOW_X] = { x: lowX, y: cy - height * 0.15, z: 0 };
  points[EYE_OUTER_HIGH_X] = { x: lowX + eyeSpan, y: cy - height * 0.15, z: 0 };
  points[FOREHEAD] = { x: cx, y: top, z: 0 };
  points[CHIN] = { x: cx, y: top + height, z: 0 };
  points[NOSE_TIP] = { x: lowX + eyeSpan * yaw, y: top + height * pitch, z: 0 };

  return points;
}

describe("faceToGaze — position", () => {
  it("centres a face in the middle of the frame at 0,0", () => {
    const signal = faceToGaze(buildFace());
    expect(signal).not.toBeNull();
    expect(signal?.x).toBeCloseTo(0, 6);
    expect(signal?.y).toBeCloseTo(0, 6);
  });

  it("maps image space onto -1..1", () => {
    expect(faceToGaze(buildFace({ cx: 0.25 }))?.x).toBeCloseTo(-0.5, 6);
    expect(faceToGaze(buildFace({ cx: 0.8 }))?.x).toBeCloseTo(0.6, 6);
    expect(faceToGaze(buildFace({ cy: 0.25 }))?.y).toBeCloseTo(-0.5, 6);
    expect(faceToGaze(buildFace({ cy: 0.75 }))?.y).toBeCloseTo(0.5, 6);
  });

  it("clamps a face that hangs off the edge of the frame", () => {
    const offRight = faceToGaze(buildFace({ cx: 1.4, cy: -0.3 }));
    expect(offRight?.x).toBe(1);
    expect(offRight?.y).toBe(-1);

    const offLeft = faceToGaze(buildFace({ cx: -0.6, cy: 1.9 }));
    expect(offLeft?.x).toBe(-1);
    expect(offLeft?.y).toBe(1);
  });
});

describe("faceToGaze — attention", () => {
  it("is 1 for a face looking straight down the lens", () => {
    expect(faceToGaze(buildFace())?.attention).toBeCloseTo(1, 6);
  });

  it("stays high for a face that is only slightly turned", () => {
    const attention = faceToGaze(buildFace({ yaw: 0.55 }))?.attention ?? 0;
    expect(attention).toBeGreaterThan(0.85);
    expect(attention).toBeLessThan(1);
  });

  it("falls to 0 in profile", () => {
    expect(faceToGaze(buildFace({ yaw: 0 }))?.attention).toBe(0);
    expect(faceToGaze(buildFace({ yaw: 1 }))?.attention).toBe(0);
  });

  it("drops when the child is looking down, but less than for turning away", () => {
    const lookingDown = faceToGaze(buildFace({ pitch: NEUTRAL_NOSE_V + 0.15 }))?.attention ?? 0;
    const turnedAway = faceToGaze(buildFace({ yaw: 0.75 }))?.attention ?? 0;
    expect(lookingDown).toBeLessThan(1);
    expect(lookingDown).toBeGreaterThan(turnedAway);
  });

  it("treats a collapsed eye span (full profile) as no attention", () => {
    expect(faceToGaze(buildFace({ eyeSpan: 0 }))?.attention).toBe(0);
  });

  it("never leaves 0..1", () => {
    for (const yaw of [-2, -0.5, 0, 0.5, 1, 1.5, 3]) {
      for (const pitch of [-1, 0, 0.5, 1, 2]) {
        const attention = faceToGaze(buildFace({ yaw, pitch }))?.attention ?? -1;
        expect(attention).toBeGreaterThanOrEqual(0);
        expect(attention).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("faceToGaze — smile", () => {
  const shapes = (entries: Record<string, number>): BlendshapeCategory[] =>
    Object.entries(entries).map(([categoryName, score]) => ({ categoryName, score }));

  it("averages the two smile blendshapes", () => {
    const signal = faceToGaze(
      buildFace(),
      shapes({ mouthSmileLeft: 0.8, mouthSmileRight: 0.6, browDownLeft: 0.9 }),
    );
    expect(signal?.smile).toBeCloseTo(0.7, 6);
  });

  it("is 0 when blendshapes are missing or carry no smile", () => {
    expect(faceToGaze(buildFace())?.smile).toBe(0);
    expect(faceToGaze(buildFace(), [])?.smile).toBe(0);
    expect(faceToGaze(buildFace(), shapes({ jawOpen: 0.5 }))?.smile).toBe(0);
  });

  it("clamps a nonsense score into 0..1", () => {
    const signal = faceToGaze(buildFace(), shapes({ mouthSmileLeft: 4, mouthSmileRight: 4 }));
    expect(signal?.smile).toBe(1);
  });
});

describe("faceToGaze — no face", () => {
  it("returns null rather than inventing a centred, attentive face", () => {
    expect(faceToGaze(null)).toBeNull();
    expect(faceToGaze(undefined)).toBeNull();
    expect(faceToGaze([])).toBeNull();
    expect(faceToGaze(buildFace().slice(0, 100))).toBeNull();
  });
});
