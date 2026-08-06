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
import { countExtendedFingers, isOpenPalm, type Landmark } from "./fingers";
import { faceBounds, faceCentre, faceToGaze, type BlendshapeCategory } from "./gaze";
import { WaveTracker } from "./wave";
import { getCalibration, type VisionCalibration } from "./calibration";
import {
  DEFAULT_LOST_FRAMES,
  Presence,
  StablePoint,
  SubjectLock,
  distance,
  type Point,
  type Subject,
} from "./stability";

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/** Vendored runtime + models. Local paths only — see scripts/vendor-vision.ts. */
export const VISION_WASM_PATH = "/vision/wasm";
export const FACE_MODEL_PATH = "/vision/face_landmarker.task";
export const HAND_MODEL_PATH = "/vision/gesture_recognizer.task";

export const DEFAULT_TARGET_FPS = 24;

/**
 * Faces the model is allowed to return.
 *
 * NOT 1. With one face the tracker silently hands us whoever it ranks first,
 * which flips between people between frames — the "whose body is this?" bug.
 * The lock below can only refuse a stranger if it can *see* the stranger, so it
 * needs candidates. Three covers the normal Indian living room: the child, a
 * parent, one sibling.
 *
 * COST: the mesh runs per detected face, so this is only paid when the extra
 * people are actually there — a child alone still costs one face. Published
 * figures put the mesh around 6ms/face on GPU; the loop's duty-cycle throttle
 * turns any overrun into lower fps rather than a stalled main thread. NOT
 * MEASURED on this branch (no camera in the test environment) — measure on the
 * mid-range Android before trusting the number.
 */
export const MAX_FACES = 3;

/**
 * Hands the model is allowed to return.
 *
 * NOT 2. Filtering other people's hands out of the count does not, by itself,
 * make "show me 3" reachable: with two slots, a parent's resting hand occupies
 * one and the child only ever gets one hand tracked. Four slots means the
 * child's two hands survive two other hands being in frame.
 */
export const MAX_HANDS = 4;

/** Below this score MediaPipe's gesture label is noise, so we report none. */
export const GESTURE_MIN_SCORE = 0.6;

/**
 * How far the locked face may move between processed frames and still be the
 * same person. Matches `SubjectLock`'s own default so the pre-filter here and
 * the lock's nearest-match agree exactly.
 */
export const FACE_LOCK_MAX_DRIFT = 0.25;
/** Each frame the locked person is unseen widens the search by this fraction. */
export const DRIFT_GROWTH_PER_LOST_FRAME = 0.25;
/** …up to this multiple of the base radius, so drift can never span the room. */
export const MAX_DRIFT_GROWTH = 2;

/** As above, for the no-face fallback hand. */
export const HAND_LOCK_MAX_DRIFT = 0.25;

/**
 * A person's arm reach, in multiples of their own face's bounding-box diagonal.
 * Scaling by face size is what makes one number work at both "nose on the lens"
 * and "sitting across the room".
 */
export const HAND_REACH_FACES = 2.5;
/** Floor and ceiling on that reach, in normalized image units. */
export const HAND_REACH_MIN = 0.35;
export const HAND_REACH_MAX = 0.9;

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
/* Whose body is this?                                                        */
/* -------------------------------------------------------------------------- */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The primary person's face and the hands we believe belong to them. */
export interface PrimaryPerson<F extends Subject, H extends Subject> {
  readonly face: F | null;
  readonly hands: readonly H[];
}

/**
 * One person, chosen once and kept.
 *
 * Two failures this exists to stop, both of them normal in a room with a
 * sibling or a parent in it:
 *
 *   - the tracked face flips between people, so Chiku's gaze snaps away and a
 *     sibling's smile completes the child's activity;
 *   - fingers are summed over every hand in frame, so a parent's resting hand
 *     makes "show me 3" unreachable and a sibling's 2 plus the child's 1 is a
 *     false success.
 *
 * The face is the identity: `SubjectLock` picks the biggest face on the first
 * frame (the person closest to the camera — the one playing) and thereafter the
 * one nearest to where that person was. Candidates further than `maxDrift` from
 * the lock are not offered to it at all, so a newcomer cannot be adopted just
 * because the locked face dropped out for a frame; they are adopted only once
 * the locked person has been missing for the whole dropout window.
 *
 * Hands then belong to whichever face they are nearest to, within that person's
 * arm reach. Nearest-face rather than a bare radius, because a parent sitting
 * shoulder-to-shoulder is inside any radius generous enough to hold the child's
 * own outstretched arm.
 */
export class PrimaryPersonLock<F extends Subject, H extends Subject> {
  readonly #faceLock: SubjectLock<F>;
  readonly #handLock: SubjectLock<H>;
  readonly #maxDrift: number;
  readonly #maxLostFrames: number;

  /** Where the locked person's face was, or null when nobody is locked. */
  #anchor: Point | null = null;
  /** Consecutive frames the locked person has not been among the candidates. */
  #lost = 0;

  constructor(maxDrift = FACE_LOCK_MAX_DRIFT, maxLostFrames = DEFAULT_LOST_FRAMES) {
    this.#maxDrift = maxDrift;
    this.#maxLostFrames = maxLostFrames;
    this.#faceLock = new SubjectLock<F>(maxDrift, maxLostFrames);
    this.#handLock = new SubjectLock<H>(HAND_LOCK_MAX_DRIFT, maxLostFrames);
  }

  update(faces: readonly F[], hands: readonly H[]): PrimaryPerson<F, H> {
    const face = this.#pickFace(faces);
    return { face, hands: this.#attribute(face, faces, hands) };
  }

  reset(): void {
    this.#faceLock.reset();
    this.#handLock.reset();
    this.#anchor = null;
    this.#lost = 0;
  }

  #pickFace(faces: readonly F[]): F | null {
    const anchor = this.#anchor;
    // The search radius GROWS while we cannot see them. A fixed radius is wrong
    // on a slow device: at 4-6fps a child genuinely moves further between two
    // frames than between two frames at 30fps, so a real move looked like a
    // disappearance and cost seconds of blindness before re-acquiring.
    // Time-since-seen is the honest scale for "how far could they have got".
    // Bounded at 2x so someone standing across the room is still never adopted
    // by drift — a genuinely new person must go through the full lost-window
    // release path below.
    const radius = Math.min(
      this.#maxDrift * MAX_DRIFT_GROWTH,
      this.#maxDrift * (1 + this.#lost * DRIFT_GROWTH_PER_LOST_FRAME),
    );
    const eligible =
      anchor === null ? faces : faces.filter((f) => distance(anchor, f.centre) <= radius);

    if (eligible.length === 0) {
      // The person we are playing with is not in this frame. Hold — do not hand
      // whoever else is standing there the child's activity.
      this.#lost += 1;
      this.#faceLock.pick([]);
      if (this.#lost > this.#maxLostFrames) {
        // Gone for good. Release, and let the room offer a new subject from the
        // next frame on.
        //
        // (The growing radius above is what keeps a fast-moving child on a
        // slow device from ever reaching this branch.)
        this.#faceLock.reset();
        this.#anchor = null;
        this.#lost = 0;
      }
      return null;
    }

    this.#lost = 0;
    const chosen = this.#faceLock.pick(eligible);
    if (chosen !== null) this.#anchor = chosen.centre;
    return chosen;
  }

  #attribute(face: F | null, faces: readonly F[], hands: readonly H[]): readonly H[] {
    if (face === null) {
      // No face means no way to tell whose hand is whose, so we trust exactly
      // one: the hand we were already watching, else the largest. Counting two
      // unattributable hands is precisely how a sibling's 2 and the child's 1
      // became "three". The cost is that two-handed counts (6-10) need a face.
      const one = this.#handLock.pick(hands);
      return one === null ? [] : [one];
    }

    // Both of the primary person's hands count. A child asked for seven splits
    // it across two hands, and a one-hand rule would cap every count at five.
    const reach = clamp(HAND_REACH_FACES * face.size, HAND_REACH_MIN, HAND_REACH_MAX);
    const mine: H[] = [];
    for (const hand of hands) {
      const own = distance(face.centre, hand.centre);
      if (own > reach) continue;
      let nearest = own;
      for (const other of faces) {
        // `face` is an element of `faces`, so this compares it against itself
        // once — harmless, and keeps ties with the locked person.
        const d = distance(other.centre, hand.centre);
        if (d < nearest) nearest = d;
      }
      if (nearest >= own) mine.push(hand);
    }
    return mine;
  }
}

/* -------------------------------------------------------------------------- */
/* Frame reduction                                                            */
/* -------------------------------------------------------------------------- */

/** A detected face, as the reducer needs it. `centre`/`size` come from `faceBounds`. */
export interface FaceCandidate extends Subject {
  readonly landmarks: readonly Landmark[];
  readonly blendshapes: readonly BlendshapeCategory[] | undefined;
}

/** A detected hand. `centre` is the wrist; `size` the bounding-box diagonal. */
export interface HandCandidate extends Subject {
  readonly signal: HandSignal;
  /** Open palm on this frame — the wave detector's other input. */
  readonly open: boolean;
}

/**
 * Everything that happens after inference, with no MediaPipe in sight: pick the
 * person, attribute the hands, smooth the gaze, age the presence. Pure enough
 * to drive from hand-built fixtures, which is the only way this logic gets
 * tested at all — the models cannot run in a unit test.
 */
export class FrameReducer {
  readonly #person = new PrimaryPersonLock<FaceCandidate, HandCandidate>();
  readonly #waves = new WaveTracker();
  /**
   * Gaze outlier rejection. The rig's own 90ms EMA is smoothing, not rejection:
   * it would happily ease Chiku's eyes onto the wrong person. This refuses the
   * jump instead, and its alpha is adaptive so refusing costs no lag.
   */
  readonly #gaze = new StablePoint();
  readonly #presence = new Presence();

  reduce(
    t: number,
    faces: readonly FaceCandidate[],
    hands: readonly HandCandidate[],
  ): VisionFrame {
    // Every hand feeds the tracker, including other people's: identity is
    // cheaper to keep than to re-establish, and a hand that wanders in and out
    // of "primary" must not restart its oscillation history each time.
    const waves = this.#waves.update(
      t,
      hands.map((h) => ({ wrist: h.centre, open: h.open })),
    );
    const primary = this.#person.update(faces, hands);

    let totalFingers: number | null = null;
    let waving = false;
    for (const hand of primary.hands) {
      const fingers = hand.signal.fingers;
      if (fingers !== null) totalFingers = (totalFingers ?? 0) + fingers;
      const i = hands.indexOf(hand);
      if (i >= 0 && waves[i]?.waving === true) waving = true;
    }

    const face = primary.face;
    const facePresence = this.#presence.update(face !== null);
    // StablePoint holds its last value through nulls, so a dropped frame does
    // not restart the smoother when the child comes back.
    const centre = this.#gaze.update(face === null ? null : faceCentre(face.landmarks));

    return {
      t,
      face: face === null ? null : faceToGaze(face.landmarks, face.blendshapes, centre),
      hands: hands.map((h) => h.signal),
      totalFingers,
      waving,
      facePresence,
    };
  }

  reset(): void {
    this.#person.reset();
    this.#waves.reset();
    this.#gaze.reset();
    this.#presence.reset();
  }
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

  /** Person lock, hand identity, gaze smoothing, presence — all of the above. */
  readonly #reducer = new FrameReducer();

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
    this.#reducer.reset();
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
          numFaces: MAX_FACES,
          outputFaceBlendshapes: true,
        }),
      );
    }
    if (!this.#hands) {
      this.#hands = await withDelegateFallback((delegate) =>
        mp.GestureRecognizer.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: this.#opts.handModelPath, delegate },
          runningMode: "VIDEO",
          numHands: MAX_HANDS,
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

    // Every face the model returned is a candidate for "who are we playing
    // with"; the reducer decides, and it is the only thing that may decide.
    const faces: FaceCandidate[] = [];
    for (let i = 0; i < faceResult.faceLandmarks.length; i += 1) {
      const landmarks: readonly NormalizedLandmark[] | undefined = faceResult.faceLandmarks[i];
      const bounds = faceBounds(landmarks);
      if (!landmarks || bounds === null) continue;
      const blendshapes: readonly Category[] | undefined =
        faceResult.faceBlendshapes[i]?.categories;
      faces.push({ centre: bounds.centre, size: bounds.size, landmarks, blendshapes });
    }

    const handCandidates: HandCandidate[] = [];
    for (let i = 0; i < handResult.landmarks.length; i += 1) {
      const landmarks = handResult.landmarks[i];
      if (!landmarks) continue;

      // Handedness is anatomical and reported against the unmirrored frame,
      // which is why the preview's mirroring must not be applied to landmarks.
      // It is a label, never an identity — see WaveTracker.
      const handedness = handResult.handedness[i]?.[0]?.categoryName ?? "Unknown";
      const count = countExtendedFingers(landmarks, this.#calibration);
      const wrist = landmarks[0] ?? { x: 0.5, y: 0.5 };

      const top = handResult.gestures[i]?.[0];
      const gesture =
        top && top.score >= GESTURE_MIN_SCORE && top.categoryName !== "None"
          ? top.categoryName
          : null;

      handCandidates.push({
        centre: { x: wrist.x, y: wrist.y },
        size: spanOf(landmarks),
        open: isOpenPalm(landmarks, this.#calibration),
        signal: {
          handedness,
          fingers: count.total,
          extended: count.extended,
          gesture,
          wrist: { x: wrist.x, y: wrist.y },
        },
      });
    }

    this.#emit(this.#reducer.reduce(t, faces, handCandidates));
  }

  /* ---------------------------------------------------------------------- */

  stop(): void {
    this.#stopLoop();
    this.#releaseCamera();
    this.#reducer.reset();
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

/**
 * Bounding-box diagonal of a landmark set, normalized. Stands in for "how close
 * to the camera" when the fallback has to choose between unattributable hands.
 */
function spanOf(landmarks: readonly Landmark[]): number {
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
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return 0;
  return Math.hypot(maxX - minX, maxY - minY);
}

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
