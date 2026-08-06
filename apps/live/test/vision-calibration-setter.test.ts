/**
 * `VisionEngine.setCalibration` — the third of the assist ladder's relaxation,
 * and the one that used to be a no-op.
 *
 * The "easier" and "together" rungs are supposed to loosen the hold AND the
 * finger angles. The hold half always worked. The angle half was a
 * feature-detected call to a method the engine did not have, so a small hand
 * that cannot straighten a finger past 143deg went on being told "I couldn't
 * quite see it" at every rung on the ladder — which is the exact child the
 * ladder exists for.
 *
 * Everything here is driven through the engine's own seams: a fake camera, a
 * fake decoder, and fake models that return one hand-built hand. No MediaPipe,
 * no getUserMedia, no DOM — node environment, like lifecycle.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createVisionEngine,
  type CameraDevices,
  type PageLifecycle,
  type VisionTasks,
} from "../src/vision/engine";
import type { VisionFrame } from "../src/vision/types";
import {
  ADULT_THRESHOLDS,
  relaxThresholds,
  type Landmark,
} from "../src/vision/fingers";
import { relaxFor } from "../src/activities/assist";

/* -------------------------------------------------------------------------- */
/* A hand whose index finger sits just below the adult threshold              */
/* -------------------------------------------------------------------------- */

/** Place `c` so the interior angle a → b → c is exactly `angleDeg`. */
function pointAtAngle(a: Landmark, b: Landmark, angleDeg: number, len: number, sign = 1): Landmark {
  const vx = a.x - b.x;
  const vy = a.y - b.y;
  const n = Math.hypot(vx, vy);
  const ux = vx / n;
  const uy = vy / n;
  const r = (sign * angleDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: b.x + len * (ux * cos - uy * sin), y: b.y + len * (ux * sin + uy * cos), z: 0 };
}

/**
 * 21 MediaPipe landmarks: index finger at exactly `angleDeg`, everything else
 * firmly curled. 143deg is a real five-year-old's "completely straight" index
 * finger — under the adult 150deg threshold and over the relaxed 142deg one, so
 * this single hand reads as 0 fingers or 1 depending only on the calibration.
 */
function handWithIndexAt(angleDeg: number): Landmark[] {
  const CURLED = 30;
  const pts: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  pts[0] = { x: 0.5, y: 0.9, z: 0 };

  const cmc: Landmark = { x: 0.42, y: 0.85, z: 0 };
  const thumbMcp: Landmark = { x: 0.37, y: 0.79, z: 0 };
  const ip = pointAtAngle(cmc, thumbMcp, CURLED, 0.05, -1);
  pts[1] = cmc;
  pts[2] = thumbMcp;
  pts[3] = ip;
  pts[4] = pointAtAngle(thumbMcp, ip, CURLED, 0.04, -1);

  const fingers: Array<[number, number, number]> = [
    [5, 0.45, angleDeg],
    [9, 0.5, CURLED],
    [13, 0.55, CURLED],
    [17, 0.6, CURLED],
  ];
  for (const [base, x, deg] of fingers) {
    const mcp: Landmark = { x, y: 0.8, z: 0 };
    const pip: Landmark = { x, y: 0.72, z: 0 };
    const tip = pointAtAngle(mcp, pip, deg, 0.07);
    pts[base] = mcp;
    pts[base + 1] = pip;
    pts[base + 2] = { x: (pip.x + tip.x) / 2, y: (pip.y + tip.y) / 2, z: 0 };
    pts[base + 3] = tip;
  }
  return pts;
}

/** The child's finger, as the ladder's own numbers describe it. */
const SMALL_HAND_INDEX_DEG = 143;
const EASIER = relaxThresholds(ADULT_THRESHOLDS, relaxFor("easier").angleRelaxDeg);

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

class FakeTrack {
  readonly kind = "video";
  readyState: "live" | "ended" = "live";
  muted = false;
  stops = 0;
  addEventListener(): void {}
  removeEventListener(): void {}
  stop(): void {
    this.stops += 1;
    this.readyState = "ended";
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

class FakeCamera implements CameraDevices {
  readonly streams: FakeStream[] = [];
  calls = 0;

  async getUserMedia(): Promise<MediaStream> {
    this.calls += 1;
    const stream = new FakeStream();
    this.streams.push(stream);
    return stream as unknown as MediaStream;
  }

  async enumerateDevices(): Promise<readonly MediaDeviceInfo[]> {
    return [{ kind: "videoinput" }] as unknown as readonly MediaDeviceInfo[];
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

class FakeLifecycle implements PageLifecycle {
  hidden = false;
  addEventListener(): void {}
  removeEventListener(): void {}
}

class FakeVideo {
  readyState = 4;
  videoWidth = 640;
  videoHeight = 480;
  currentTime = 0;
  srcObject: MediaStream | null = null;
  muted = false;
  playsInline = false;
  async play(): Promise<void> {
    return undefined;
  }
  pause(): void {}
}

/** Models that see exactly one hand, and count how many times they were built. */
function handTasks(landmarks: readonly Landmark[], built: { count: number }): VisionTasks {
  built.count += 1;
  return {
    face: {
      detectForVideo: () => ({ faceLandmarks: [], faceBlendshapes: [] }),
      close: () => undefined,
    },
    hands: {
      recognizeForVideo: () => ({
        landmarks: [landmarks],
        handedness: [[{ categoryName: "Right", score: 0.99 }]],
        gestures: [],
      }),
      close: () => undefined,
    },
  } as unknown as VisionTasks;
}

interface Harness {
  readonly engine: ReturnType<typeof createVisionEngine>;
  readonly camera: FakeCamera;
  readonly video: FakeVideo;
  readonly frames: VisionFrame[];
  readonly built: { count: number };
  readonly run: (ms: number) => void;
  /** The finger count on the most recent frame, or undefined if none yet. */
  readonly lastCount: () => number | null | undefined;
}

function harness(): Harness {
  const camera = new FakeCamera();
  const video = new FakeVideo();
  const frames: VisionFrame[] = [];
  const built = { count: 0 };

  const engine = createVisionEngine({
    targetFps: 60,
    now: () => Date.now(),
    camera,
    lifecycle: new FakeLifecycle(),
    tasks: async () => handTasks(handWithIndexAt(SMALL_HAND_INDEX_DEG), built),
  });
  engine.onFrame((f) => frames.push(f));

  return {
    engine,
    camera,
    video,
    frames,
    built,
    run: (ms: number): void => {
      const step = 16;
      for (let elapsed = 0; elapsed < ms; elapsed += step) {
        video.currentTime += step / 1000;
        vi.advanceTimersByTime(step);
      }
    },
    lastCount: () => frames[frames.length - 1]?.totalFingers,
  };
}

async function startEngine(h: Harness): Promise<void> {
  await h.engine.start(h.video as unknown as HTMLVideoElement);
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */

describe("vision engine: setCalibration", () => {
  it("changes the thresholds the NEXT frame is scored against", async () => {
    const h = harness();
    await startEngine(h);

    // Strict: 143deg is not a finger a MediaPipe-and-adult-thresholds detector
    // will admit to seeing, so the child holding up one finger reads as none.
    h.run(200);
    expect(h.frames.length).toBeGreaterThan(0);
    expect(h.lastCount()).toBe(0);

    // The "easier" rung, exactly as the surface applies it.
    h.engine.setCalibration(EASIER);
    const before = h.frames.length;
    h.run(200);

    expect(h.frames.length).toBeGreaterThan(before);
    expect(h.lastCount()).toBe(1);

    h.engine.dispose();
  });

  it("does not restart the camera or reload the models", async () => {
    const h = harness();
    await startEngine(h);
    h.run(200);

    const acquisitions = h.camera.calls;
    const stream = h.camera.streams[0];
    const models = h.built.count;
    expect(acquisitions).toBe(1);
    expect(models).toBe(1);

    h.engine.setCalibration(EASIER);
    h.run(200);

    // Same grant, same stream, same models, same status. The child is told
    // nothing and sees nothing — no black frame, no camera light blinking.
    expect(h.camera.calls).toBe(acquisitions);
    expect(h.camera.streams).toHaveLength(1);
    expect(stream?.track.stops).toBe(0);
    expect(h.built.count).toBe(models);
    expect(h.engine.status).toBe("ready");
    expect(h.lastCount()).toBe(1);

    h.engine.dispose();
  });

  it("is honoured when it lands before start()", async () => {
    const h = harness();

    // The ladder changes rung on its own schedule; the camera may not be open
    // yet. Setting it early must not be silently thrown away by start()'s
    // re-read of the stored per-child calibration.
    h.engine.setCalibration(EASIER);
    await startEngine(h);
    h.run(200);

    expect(h.lastCount()).toBe(1);

    h.engine.dispose();
  });

  it("is safe before start() and after stop(), and survives a restart", async () => {
    const h = harness();

    expect(() => h.engine.setCalibration(EASIER)).not.toThrow();
    expect(() => h.engine.setCalibration(ADULT_THRESHOLDS)).not.toThrow();

    await startEngine(h);
    h.run(100);
    h.engine.stop();

    expect(() => h.engine.setCalibration(EASIER)).not.toThrow();

    // …and it is still in force when the camera comes back.
    await startEngine(h);
    const before = h.frames.length;
    h.run(200);
    expect(h.frames.length).toBeGreaterThan(before);
    expect(h.lastCount()).toBe(1);

    h.engine.dispose();
    expect(() => h.engine.setCalibration(ADULT_THRESHOLDS)).not.toThrow();
  });

  it("goes back to strict when the ladder resets to the top rung", async () => {
    const h = harness();
    await startEngine(h);

    h.engine.setCalibration(EASIER);
    h.run(200);
    expect(h.lastCount()).toBe(1);

    // A new prompt is a new thing to be stuck on: the detector goes back to
    // exactly what shipped. Relaxation is per prompt, never cumulative.
    h.engine.setCalibration(ADULT_THRESHOLDS);
    h.run(200);
    expect(h.lastCount()).toBe(0);

    h.engine.dispose();
  });
});
