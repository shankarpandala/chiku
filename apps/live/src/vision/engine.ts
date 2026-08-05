/**
 * The on-device vision engine.
 *
 * INVARIANT (§9, plus the camera rule): every frame this touches stays on this
 * machine. There is no upload path in this file and there must never be one.
 * MediaPipe runs the models locally in WASM; its telemetry beacon is blocked at
 * the CSP layer (see vite.config.ts) rather than trusted to behave. The only
 * thing that leaves this module is the small structured `VisionFrame`.
 *
 * The runtime and both model bundles are served from /vision/ — vendored by
 * `scripts/vendor-vision.ts`. Never a CDN URL.
 *
 * PERFORMANCE
 * -----------
 * Face + hand inference measured 13.8ms per frame on an M5 Pro but 40-80ms on
 * mid-range Android. At 80ms a naive per-rAF loop saturates the main thread and
 * the whole surface — Chiku's animation, the audio, the taps — goes to treacle,
 * which is far worse than a coarse gaze update. So the loop:
 *   - never runs faster than `targetFps` (24 by default),
 *   - skips any frame that arrives while the previous one is still in flight,
 *   - and after a slow frame waits at least as long as that frame took before
 *     starting another, so inference can never exceed ~50% duty cycle. A device
 *     that needs 80ms/frame degrades to ~6fps instead of locking up.
 *
 * FAILURE
 * -------
 * `start()` never rejects and never throws. Every failure becomes a status:
 * `denied` (the parent said no), `unavailable` (no camera on this device),
 * `error` (anything else). The surface is required to have a working no-camera
 * path, so a failure here is a route change, not an exception.
 */

import type {
  Category,
  FaceLandmarker,
  GestureRecognizer,
  NormalizedLandmark,
} from "@mediapipe/tasks-vision";

import type { HandSignal, VisionEngine, VisionFrame, VisionStatus } from "./types";
import { countExtendedFingers, isOpenPalm } from "./fingers";
import { faceToGaze } from "./gaze";
import { WaveDetector } from "./wave";
import { getCalibration, type VisionCalibration } from "./calibration";

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/** Vendored runtime + models. Local paths only — see scripts/vendor-vision.ts. */
export const VISION_WASM_PATH = "/vision/wasm";
export const FACE_MODEL_PATH = "/vision/face_landmarker.task";
export const HAND_MODEL_PATH = "/vision/gesture_recognizer.task";

export const DEFAULT_TARGET_FPS = 24;

/** Below this score MediaPipe's gesture label is noise, so we report none. */
export const GESTURE_MIN_SCORE = 0.6;

/** Consecutive inference throws tolerated before the run is declared broken. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** How long to wait for the video element to produce a first decoded frame. */
const VIDEO_READY_TIMEOUT_MS = 8000;

export interface VisionEngineOptions {
  /** Inference ceiling. The loop may run slower on a slow device, never faster. */
  readonly targetFps?: number;
  /** Finger thresholds. Defaults to the stored per-child calibration. */
  readonly calibration?: VisionCalibration;
  /** Overridable for tests/self-host layouts; must stay same-origin. */
  readonly wasmPath?: string;
  readonly faceModelPath?: string;
  readonly handModelPath?: string;
  /** Monotonic clock, in ms. Injectable so the loop is testable. */
  readonly now?: () => number;
}

/* -------------------------------------------------------------------------- */
/* Scheduling helpers                                                         */
/* -------------------------------------------------------------------------- */

type FrameHandle = { readonly kind: "raf" | "timeout"; readonly id: number };

function scheduleFrame(cb: () => void): FrameHandle {
  if (typeof requestAnimationFrame === "function") {
    return { kind: "raf", id: requestAnimationFrame(() => cb()) };
  }
  return { kind: "timeout", id: setTimeout(cb, 16) as unknown as number };
}

function cancelFrame(handle: FrameHandle): void {
  if (handle.kind === "raf") {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle.id);
    return;
  }
  clearTimeout(handle.id);
}

function defaultNow(): number {
  return typeof performance === "object" ? performance.now() : Date.now();
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                     */
/* -------------------------------------------------------------------------- */

class OnDeviceVisionEngine implements VisionEngine {
  readonly #opts: Required<Omit<VisionEngineOptions, "calibration">> & {
    calibration: VisionCalibration | undefined;
  };
  readonly #minFrameMs: number;
  readonly #now: () => number;

  #status: VisionStatus = "idle";
  #frameListeners = new Set<(frame: VisionFrame) => void>();
  #statusListeners = new Set<(status: VisionStatus, detail?: string) => void>();

  #face: FaceLandmarker | null = null;
  #hands: GestureRecognizer | null = null;
  #calibration: VisionCalibration;

  #video: HTMLVideoElement | null = null;
  #stream: MediaStream | null = null;
  #frameHandle: FrameHandle | null = null;

  #busy = false;
  #running = false;
  #disposed = false;
  #starting: Promise<void> | null = null;

  #nextAt = 0;
  #lastVideoTime = -1;
  #lastTimestamp = 0;
  #failures = 0;

  /** One wave detector per hand, keyed by handedness. */
  #waves = new Map<string, WaveDetector>();

  constructor(opts: VisionEngineOptions = {}) {
    this.#now = opts.now ?? defaultNow;
    this.#opts = {
      targetFps: opts.targetFps ?? DEFAULT_TARGET_FPS,
      wasmPath: opts.wasmPath ?? VISION_WASM_PATH,
      faceModelPath: opts.faceModelPath ?? FACE_MODEL_PATH,
      handModelPath: opts.handModelPath ?? HAND_MODEL_PATH,
      now: this.#now,
      calibration: opts.calibration,
    };
    this.#minFrameMs = 1000 / Math.max(1, this.#opts.targetFps);
    this.#calibration = opts.calibration ?? getCalibration();
  }

  get status(): VisionStatus {
    return this.#status;
  }

  onFrame(cb: (frame: VisionFrame) => void): () => void {
    this.#frameListeners.add(cb);
    return () => {
      this.#frameListeners.delete(cb);
    };
  }

  onStatus(cb: (status: VisionStatus, detail?: string) => void): () => void {
    this.#statusListeners.add(cb);
    return () => {
      this.#statusListeners.delete(cb);
    };
  }

  /* ---------------------------------------------------------------------- */

  async start(video: HTMLVideoElement): Promise<void> {
    if (this.#disposed) {
      this.#setStatus("error", "engine disposed");
      return;
    }
    if (this.#running) return;
    if (this.#starting) return this.#starting;

    this.#starting = this.#startInner(video).finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #startInner(video: HTMLVideoElement): Promise<void> {
    this.#setStatus("loading");

    // Re-read calibration on each start: the parent may have just run a pass.
    if (this.#opts.calibration === undefined) this.#calibration = getCalibration();

    const devices = (navigator as Navigator | undefined)?.mediaDevices;
    if (!devices || typeof devices.getUserMedia !== "function") {
      this.#setStatus("unavailable", "this browser has no camera API");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await devices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user",
        },
        audio: false,
      });
    } catch (err: unknown) {
      this.#setStatus(...cameraFailure(err));
      return;
    }

    // Camera is open; if anything below fails we must still hand the light back.
    try {
      await this.#createTasks();
    } catch (err: unknown) {
      stopStream(stream);
      this.#setStatus("error", describe(err));
      return;
    }

    if (this.#disposed) {
      stopStream(stream);
      return;
    }

    this.#stream = stream;
    this.#video = video;

    try {
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play().catch(() => undefined);
      await waitForFirstFrame(video, this.#now);
    } catch (err: unknown) {
      this.#releaseCamera();
      this.#setStatus("error", describe(err));
      return;
    }

    this.#busy = false;
    this.#running = true;
    this.#failures = 0;
    this.#nextAt = 0;
    this.#lastVideoTime = -1;
    this.#waves.clear();
    this.#setStatus("ready");
    this.#frameHandle = scheduleFrame(this.#tick);
  }

  /** Both tasks on GPU, each falling back to CPU rather than failing the run. */
  async #createTasks(): Promise<void> {
    if (this.#face && this.#hands) return;

    // Lazy: keeps the 11MB runtime out of the initial bundle AND lets the pure
    // modules in this folder be imported by tests with no WASM available.
    const mp = await import("@mediapipe/tasks-vision");
    // `WasmFileset` is not exported from the package, so this stays inferred.
    const fileset = await mp.FilesetResolver.forVisionTasks(this.#opts.wasmPath);

    if (!this.#face) {
      this.#face = await withDelegateFallback((delegate) =>
        mp.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: this.#opts.faceModelPath, delegate },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
        }),
      );
    }
    if (!this.#hands) {
      this.#hands = await withDelegateFallback((delegate) =>
        mp.GestureRecognizer.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: this.#opts.handModelPath, delegate },
          runningMode: "VIDEO",
          numHands: 2,
        }),
      );
    }
  }

  /* ---------------------------------------------------------------------- */

  readonly #tick = (): void => {
    if (!this.#running) return;
    this.#frameHandle = scheduleFrame(this.#tick);

    const video = this.#video;
    const face = this.#face;
    const hands = this.#hands;
    if (!video || !face || !hands) return;
    // Previous frame still in flight: drop this one rather than queueing.
    if (this.#busy) return;

    const start = this.#now();
    if (start < this.#nextAt) return;
    if (video.readyState < 2 || video.videoWidth === 0) return;
    // The decoder has not produced a new frame; re-running would burn a whole
    // inference budget on a duplicate image.
    if (video.currentTime === this.#lastVideoTime) return;
    this.#lastVideoTime = video.currentTime;

    this.#busy = true;
    try {
      this.#infer(video, face, hands, start);
      this.#failures = 0;
    } catch (err: unknown) {
      this.#failures += 1;
      if (this.#failures >= MAX_CONSECUTIVE_FAILURES) {
        this.#stopLoop();
        this.#releaseCamera();
        this.#setStatus("error", describe(err));
        return;
      }
    } finally {
      this.#busy = false;
    }

    const end = this.#now();
    const spent = end - start;
    // Either the fps ceiling or a 50% duty cycle, whichever is more generous to
    // the rest of the app. This is the degradation path, not an error path.
    this.#nextAt = end + Math.max(this.#minFrameMs - spent, spent);
  };

  #infer(
    video: HTMLVideoElement,
    face: FaceLandmarker,
    hands: GestureRecognizer,
    t: number,
  ): void {
    // MediaPipe requires strictly increasing timestamps in VIDEO mode.
    const timestamp = Math.max(this.#lastTimestamp + 1, Math.round(t));
    this.#lastTimestamp = timestamp;

    const faceResult = face.detectForVideo(video, timestamp);
    const handResult = hands.recognizeForVideo(video, timestamp);

    const faceLandmarks: readonly NormalizedLandmark[] | undefined = faceResult.faceLandmarks[0];
    const blendshapes: readonly Category[] | undefined = faceResult.faceBlendshapes[0]?.categories;

    const handSignals: HandSignal[] = [];
    let totalFingers: number | null = null;
    let waving = false;
    const seen = new Set<string>();

    for (let i = 0; i < handResult.landmarks.length; i += 1) {
      const landmarks = handResult.landmarks[i];
      if (!landmarks) continue;

      // Handedness is anatomical and reported against the unmirrored frame,
      // which is why the preview's mirroring must not be applied to landmarks.
      const handedness = handResult.handedness[i]?.[0]?.categoryName ?? "Unknown";
      const count = countExtendedFingers(landmarks, this.#calibration);
      const wrist = landmarks[0] ?? { x: 0.5, y: 0.5 };

      const top = handResult.gestures[i]?.[0];
      const gesture =
        top && top.score >= GESTURE_MIN_SCORE && top.categoryName !== "None"
          ? top.categoryName
          : null;

      // Two hands of the same reported handedness would collide on the key;
      // suffix duplicates so each hand keeps its own oscillation history.
      let key = handedness;
      while (seen.has(key)) key = `${key}'`;
      seen.add(key);

      let detector = this.#waves.get(key);
      if (!detector) {
        detector = new WaveDetector();
        this.#waves.set(key, detector);
      }
      if (detector.push(t, wrist.x, isOpenPalm(landmarks, this.#calibration))) waving = true;

      if (count.total !== null) totalFingers = (totalFingers ?? 0) + count.total;

      handSignals.push({
        handedness,
        fingers: count.total,
        extended: count.extended,
        gesture,
        wrist: { x: wrist.x, y: wrist.y },
      });
    }

    for (const [key, detector] of this.#waves) {
      if (!seen.has(key)) {
        detector.reset();
        this.#waves.delete(key);
      }
    }

    this.#emit({
      t,
      face: faceToGaze(faceLandmarks, blendshapes),
      hands: handSignals,
      totalFingers,
      waving,
    });
  }

  /* ---------------------------------------------------------------------- */

  stop(): void {
    this.#stopLoop();
    this.#releaseCamera();
    this.#waves.clear();
    this.#busy = false;
    // denied/unavailable/error are sticky: the surface is showing a no-camera
    // path because of them, and stop() must not quietly erase the reason.
    if (this.#status === "ready" || this.#status === "loading") this.#setStatus("idle");
  }

  dispose(): void {
    if (this.#disposed) return;
    this.stop();
    this.#disposed = true;
    try {
      this.#face?.close();
    } catch {
      // A task that fails to close is already gone; nothing useful to do.
    }
    try {
      this.#hands?.close();
    } catch {
      // As above.
    }
    this.#face = null;
    this.#hands = null;
    this.#frameListeners.clear();
    this.#statusListeners.clear();
  }

  #stopLoop(): void {
    this.#running = false;
    if (this.#frameHandle) cancelFrame(this.#frameHandle);
    this.#frameHandle = null;
  }

  /** The camera light MUST go off here. Every track, then the element. */
  #releaseCamera(): void {
    if (this.#stream) stopStream(this.#stream);
    this.#stream = null;
    const video = this.#video;
    if (video) {
      try {
        video.pause();
        video.srcObject = null;
      } catch {
        // Detached element; the tracks are already stopped, which is what counts.
      }
    }
    this.#video = null;
    this.#lastVideoTime = -1;
  }

  #setStatus(status: VisionStatus, detail?: string): void {
    this.#status = status;
    for (const cb of this.#statusListeners) {
      try {
        cb(status, detail);
      } catch {
        // A broken listener must not take the engine down with it.
      }
    }
  }

  #emit(frame: VisionFrame): void {
    for (const cb of this.#frameListeners) {
      try {
        cb(frame);
      } catch {
        // As above: one bad consumer does not stop the camera loop.
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

async function withDelegateFallback<T>(create: (delegate: "GPU" | "CPU") => Promise<T>): Promise<T> {
  try {
    return await create("GPU");
  } catch {
    // No WebGL2, a blocked context, or a driver the browser distrusts. CPU is
    // slower but the duty-cycle throttle already handles slow.
    return await create("CPU");
  }
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Already ended.
    }
  }
}

function cameraFailure(err: unknown): [VisionStatus, string] {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return ["denied", "camera permission was declined"];
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return ["unavailable", "no usable camera on this device"];
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return ["unavailable", "the camera is in use by another app"];
  }
  return ["error", describe(err)];
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Resolve once the element has a decoded frame, or give up after a timeout.
 * Races the frame callback against a timer: rAF is paused in a hidden tab, and
 * without the timer the deadline below would never be reached there.
 */
async function waitForFirstFrame(video: HTMLVideoElement, now: () => number): Promise<void> {
  const deadline = now() + VIDEO_READY_TIMEOUT_MS;
  while (video.readyState < 2 || video.videoWidth === 0) {
    if (now() > deadline) throw new Error("camera stream produced no frames");
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      scheduleFrame(done);
      setTimeout(done, 100);
    });
  }
}

/* -------------------------------------------------------------------------- */

export function createVisionEngine(opts?: VisionEngineOptions): VisionEngine {
  return new OnDeviceVisionEngine(opts);
}
