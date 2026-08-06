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
 *
 * A camera that dies AFTER a successful start is the same kind of event, and it
 * is the common one on a real device: the laptop sleeps, another app grabs the
 * camera, a USB webcam is unplugged, the OS mutes the track. Left undetected
 * the loop simply returns early forever — no error, no status change — and the
 * surface goes on telling a child "Chiku sees you" while he is blind. So the
 * engine watches for it three ways, because no single one of them is reliable:
 *   - track `ended` / `mute` events, when the platform bothers to fire them;
 *   - `devicechange`, which catches an unplug that ends no track;
 *   - and a self-check: a video timestamp that has not advanced for
 *     `FROZEN_FRAME_LIMIT` eligible frames AND `FROZEN_MIN_MS` of wall clock,
 *     while we believe the camera is on, is a dead camera whatever the events
 *     say. That last one is the only defence against the freeze where nothing
 *     is dispatched at all.
 * All of them land on `unavailable` with a detail that says which one it was.
 *
 * PAGE LIFECYCLE
 * --------------
 * The engine owns the stream, so the engine — not the surface — is what listens
 * to `visibilitychange`. A hidden tab stops rAF but does NOT stop the camera:
 * the light stays on with nobody watching, which is precisely the promise this
 * product makes to a parent, broken. On hide we stop inference and RELEASE the
 * stream (light off); on show we re-acquire, which needs no new permission
 * prompt because the grant is still live. `suspend()`/`resume()` are the same
 * path, exposed so a surface can drive it deliberately.
 */

import type { Category, NormalizedLandmark } from "@mediapipe/tasks-vision";

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

/**
 * Eligible frames (past the fps throttle) that may pass with a frozen video
 * timestamp before we stop believing in the camera.
 *
 * A stale frame on its own is ordinary — a 15fps camera under a 24fps loop
 * produces one constantly. What is not ordinary is a run of them: even a 6fps
 * camera advances within a handful of eligible frames.
 */
export const FROZEN_FRAME_LIMIT = 48;

/**
 * …and the same freeze must also have lasted this long in wall clock. Both
 * conditions, because on a slow device the frame count alone arrives too
 * eagerly, and on a fast one the clock alone arrives too late.
 */
export const FROZEN_MIN_MS = 2000;

/**
 * A track the platform muted (another app took the camera, the OS pulled it,
 * the lid closed) that has not unmuted within this long is a lost camera. Short
 * enough that a child is not left talking to a blind Chiku; long enough that
 * the ordinary transient mute on app-switch does not tear the session down.
 */
export const MUTE_GRACE_MS = 1500;

/** Details reported with `unavailable`. Developer-facing; kid copy is the surface's. */
export const CAMERA_ENDED_DETAIL = "the camera stopped (unplugged, or taken by another app)";
export const CAMERA_MUTED_DETAIL = "the camera was muted by the system or another app";
export const CAMERA_FROZEN_DETAIL = "the camera stopped sending pictures";
export const CAMERA_GONE_DETAIL = "the camera was disconnected";

/* -------------------------------------------------------------------------- */
/* Platform seams                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The two model tasks, narrowed to the four calls the loop makes.
 *
 * Structural on purpose: the real `FaceLandmarker`/`GestureRecognizer` satisfy
 * these without a cast, and a test can satisfy them with an object literal —
 * which is the only way any of the lifecycle below is testable at all, since
 * MediaPipe cannot run in a unit test.
 */
export interface FaceTaskResult {
  readonly faceLandmarks: readonly (readonly NormalizedLandmark[])[];
  readonly faceBlendshapes: readonly { readonly categories: readonly Category[] }[];
}

export interface FaceTask {
  detectForVideo(video: HTMLVideoElement, timestamp: number): FaceTaskResult;
  close(): void;
}

export interface HandTaskResult {
  readonly landmarks: readonly (readonly NormalizedLandmark[])[];
  readonly handedness: readonly (readonly { readonly categoryName: string }[])[];
  readonly gestures: readonly (readonly { readonly categoryName: string; readonly score: number }[])[];
}

export interface HandTask {
  recognizeForVideo(video: HTMLVideoElement, timestamp: number): HandTaskResult;
  close(): void;
}

export interface VisionTasks {
  readonly face: FaceTask;
  readonly hands: HandTask;
}

/** `navigator.mediaDevices`, narrowed. Satisfied by the real object as-is. */
export interface CameraDevices {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** Present on every real implementation; optional so a fake may omit it. */
  enumerateDevices?(): Promise<readonly MediaDeviceInfo[]>;
  addEventListener?(type: "devicechange", cb: () => void): void;
  removeEventListener?(type: "devicechange", cb: () => void): void;
}

/** `document`, narrowed to the one fact and the one event we need. */
export interface PageLifecycle {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", cb: () => void): void;
  removeEventListener(type: "visibilitychange", cb: () => void): void;
}

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
  /**
   * Camera source. Defaults to `navigator.mediaDevices`; `null` means this
   * browser has no camera API at all.
   */
  readonly camera?: CameraDevices | null;
  /**
   * Visibility source. Defaults to `document`; `null` disables the automatic
   * suspend/resume (`suspend()` and `resume()` still work).
   */
  readonly lifecycle?: PageLifecycle | null;
  /** Model construction. Defaults to the vendored MediaPipe bundles. */
  readonly tasks?: (() => Promise<VisionTasks>) | undefined;
}

/**
 * A `VisionEngine` that also knows about the page being hidden.
 *
 * The engine wires `visibilitychange` itself — it owns the stream, so it is the
 * only thing that can honestly release it — and these are the same path exposed
 * for a caller that wants to drive it (a parent surface, a settings sheet).
 */
export interface LifecycleVisionEngine extends VisionEngine {
  /** True while capture is released because the page is hidden or paused. */
  readonly suspended: boolean;
  /** Stop inference and release the camera. Idempotent. */
  suspend(): void;
  /** Re-acquire and restart, if the surface still wants a camera. Idempotent. */
  resume(): void;
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

class OnDeviceVisionEngine implements LifecycleVisionEngine {
  readonly #paths: {
    readonly wasmPath: string;
    readonly faceModelPath: string;
    readonly handModelPath: string;
  };
  readonly #fixedCalibration: VisionCalibration | undefined;
  readonly #minFrameMs: number;
  readonly #now: () => number;
  readonly #camera: CameraDevices | null;
  readonly #lifecycle: PageLifecycle | null;
  readonly #loadTasks: () => Promise<VisionTasks>;

  #status: VisionStatus = "idle";
  #frameListeners = new Set<(frame: VisionFrame) => void>();
  #statusListeners = new Set<(status: VisionStatus, detail?: string) => void>();

  #face: FaceTask | null = null;
  #hands: HandTask | null = null;
  #calibration: VisionCalibration;

  #video: HTMLVideoElement | null = null;
  #stream: MediaStream | null = null;
  #frameHandle: FrameHandle | null = null;

  #busy = false;
  #running = false;
  #disposed = false;
  #starting: Promise<void> | null = null;

  /**
   * The element the surface asked us to run on, held for as long as it still
   * wants a camera. Null after stop(), a failed start, or a lost camera — which
   * is what stops `resume()` from re-opening a camera nobody asked for.
   */
  #wanted: HTMLVideoElement | null = null;
  #suspended = false;

  #nextAt = 0;
  #lastVideoTime = -1;
  #lastTimestamp = 0;
  #failures = 0;

  /** Consecutive eligible frames whose video timestamp did not move. */
  #staleFrames = 0;
  /** When the video timestamp last moved. Half of the freeze verdict. */
  #lastAdvanceAt = 0;

  #muteTimer: ReturnType<typeof setTimeout> | null = null;
  #trackCleanups: Array<() => void> = [];
  #offVisibility: (() => void) | null = null;
  #offDeviceChange: (() => void) | null = null;

  /** Person lock, hand identity, gaze smoothing, presence — all of the above. */
  readonly #reducer = new FrameReducer();

  constructor(opts: VisionEngineOptions = {}) {
    this.#now = opts.now ?? defaultNow;
    this.#paths = {
      wasmPath: opts.wasmPath ?? VISION_WASM_PATH,
      faceModelPath: opts.faceModelPath ?? FACE_MODEL_PATH,
      handModelPath: opts.handModelPath ?? HAND_MODEL_PATH,
    };
    this.#fixedCalibration = opts.calibration;
    this.#minFrameMs = 1000 / Math.max(1, opts.targetFps ?? DEFAULT_TARGET_FPS);
    this.#calibration = opts.calibration ?? getCalibration();
    this.#camera = opts.camera === undefined ? browserCamera() : opts.camera;
    this.#lifecycle = opts.lifecycle === undefined ? browserLifecycle() : opts.lifecycle;
    this.#loadTasks = opts.tasks ?? (() => this.#loadMediaPipeTasks());

    this.#watchVisibility();
    this.#watchDevices();
  }

  get status(): VisionStatus {
    return this.#status;
  }

  get suspended(): boolean {
    return this.#suspended;
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
    // An explicit start while suspended means the surface wants the camera now.
    // Honour it unless the page really is hidden, in which case the intent is
    // recorded (below) and resume() picks it up when the child comes back.
    if (this.#suspended && this.#lifecycle?.hidden !== true) this.#suspended = false;
    if (this.#running) return;
    if (this.#starting) return this.#starting;

    this.#starting = this.#startInner(video).finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #startInner(video: HTMLVideoElement): Promise<void> {
    // Recorded before anything can fail: if a suspend lands mid-acquisition we
    // must still know which element to come back to.
    this.#wanted = video;
    this.#setStatus("loading");

    // Re-read calibration on each start: the parent may have just run a pass.
    if (this.#fixedCalibration === undefined) this.#calibration = getCalibration();

    const devices = this.#camera;
    if (!devices || typeof devices.getUserMedia !== "function") {
      this.#wanted = null;
      this.#setStatus("unavailable", "this browser has no camera API");
      return;
    }
    if (this.#suspended) {
      // Hidden before we even opened the camera. Keep `#wanted` and wait.
      this.#setStatus("idle", "paused while the page is hidden");
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
      this.#wanted = null;
      this.#setStatus(...cameraFailure(err));
      return;
    }

    // Camera is open; if anything below fails we must still hand the light back.
    try {
      await this.#createTasks();
    } catch (err: unknown) {
      stopStream(stream);
      this.#wanted = null;
      this.#setStatus("error", describe(err));
      return;
    }

    if (this.#disposed || this.#suspended) {
      // Disposed or hidden while the models loaded. The stream is ours and
      // nobody else will ever see it again — stop it here or the light stays on.
      stopStream(stream);
      if (this.#disposed) this.#wanted = null;
      else this.#setStatus("idle", "paused while the page is hidden");
      return;
    }

    this.#stream = stream;
    this.#video = video;
    this.#watchTracks(stream);

    try {
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play().catch(() => undefined);
      await waitForFirstFrame(video, this.#now);
    } catch (err: unknown) {
      this.#releaseCamera();
      this.#wanted = null;
      this.#setStatus("error", describe(err));
      return;
    }

    // Waiting for the first decoded frame is the longest await in this method,
    // so it is the likeliest place for a suspend to land.
    if (this.#disposed || this.#suspended) {
      this.#releaseCamera();
      if (this.#disposed) this.#wanted = null;
      else this.#setStatus("idle", "paused while the page is hidden");
      return;
    }

    this.#busy = false;
    this.#running = true;
    this.#failures = 0;
    this.#nextAt = 0;
    this.#lastVideoTime = -1;
    this.#staleFrames = 0;
    this.#lastAdvanceAt = this.#now();
    this.#reducer.reset();
    this.#setStatus("ready");
    this.#frameHandle = scheduleFrame(this.#tick);
  }

  async #createTasks(): Promise<void> {
    if (this.#face && this.#hands) return;
    const tasks = await this.#loadTasks();
    this.#face = tasks.face;
    this.#hands = tasks.hands;
  }

  /** Both tasks on GPU, each falling back to CPU rather than failing the run. */
  async #loadMediaPipeTasks(): Promise<VisionTasks> {
    // Lazy: keeps the 11MB runtime out of the initial bundle AND lets the pure
    // modules in this folder be imported by tests with no WASM available.
    const mp = await import("@mediapipe/tasks-vision");
    // `WasmFileset` is not exported from the package, so this stays inferred.
    const fileset = await mp.FilesetResolver.forVisionTasks(this.#paths.wasmPath);

    const face = await withDelegateFallback((delegate) =>
      mp.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: this.#paths.faceModelPath, delegate },
        runningMode: "VIDEO",
        numFaces: MAX_FACES,
        outputFaceBlendshapes: true,
      }),
    );
    const hands = await withDelegateFallback((delegate) =>
      mp.GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: this.#paths.handModelPath, delegate },
        runningMode: "VIDEO",
        numHands: MAX_HANDS,
      }),
    );
    return { face, hands };
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
    // From here the frame is ELIGIBLE: the throttle would have let us infer, so
    // anything that stops us is the camera, not the schedule. That is the only
    // honest place to count a freeze from.
    if (video.readyState < 2 || video.videoWidth === 0) {
      this.#noteFrozenFrame(start);
      return;
    }
    // The decoder has not produced a new frame; re-running would burn a whole
    // inference budget on a duplicate image.
    if (video.currentTime === this.#lastVideoTime) {
      this.#noteFrozenFrame(start);
      return;
    }
    this.#lastVideoTime = video.currentTime;
    this.#staleFrames = 0;
    this.#lastAdvanceAt = start;

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

  /**
   * The freeze self-check.
   *
   * This is the case no event covers: the device slept, or another app took the
   * camera without the platform ending or muting the track, and `currentTime`
   * simply stops. The tick loop returns early forever and — before this — did
   * so in perfect silence, while the surface went on saying "Chiku sees you".
   */
  #noteFrozenFrame(t: number): void {
    this.#staleFrames += 1;
    if (this.#staleFrames < FROZEN_FRAME_LIMIT) return;
    if (t - this.#lastAdvanceAt < FROZEN_MIN_MS) return;
    this.#cameraLost(CAMERA_FROZEN_DETAIL);
  }

  #infer(video: HTMLVideoElement, face: FaceTask, hands: HandTask, t: number): void {
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
    // An explicit stop is the surface saying it no longer wants a camera, so a
    // later resume() must not bring one back behind its back.
    this.#wanted = null;
    this.#stopLoop();
    this.#releaseCamera();
    this.#reducer.reset();
    this.#busy = false;
    // denied/unavailable/error are sticky: the surface is showing a no-camera
    // path because of them, and stop() must not quietly erase the reason.
    if (this.#status === "ready" || this.#status === "loading") this.#setStatus("idle");
  }

  /* ---------------------------------------------------------------------- */
  /* Page lifecycle                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Stop inference and give the camera back.
   *
   * We RELEASE rather than pause: a paused element with a live track still
   * lights the camera, and "the light is on only while Chiku is looking" is the
   * promise the camera screen makes to a parent. Re-acquiring costs one
   * getUserMedia call against a grant that is still live — no second prompt.
   */
  suspend(): void {
    if (this.#suspended) return;
    this.#suspended = true;
    if (this.#disposed) return;

    this.#stopLoop();
    this.#releaseCamera();
    this.#reducer.reset();
    this.#busy = false;
    if (this.#status === "ready" || this.#status === "loading") {
      this.#setStatus("idle", "paused while the page is hidden");
    }
  }

  /** The other half. Safe to call when nothing was suspended, or twice. */
  resume(): void {
    if (!this.#suspended) return;
    this.#suspended = false;
    if (this.#disposed) return;

    const video = this.#wanted;
    if (video === null) return;
    // start() is itself guarded, but being explicit here is what makes a double
    // resume() (visibilitychange fires more than once on some platforms) free.
    if (this.#running || this.#starting !== null) return;
    void this.start(video);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.stop();
    this.#disposed = true;
    this.#offVisibility?.();
    this.#offVisibility = null;
    this.#offDeviceChange?.();
    this.#offDeviceChange = null;
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
    this.#clearMuteTimer();
    this.#unwatchTracks();
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
    this.#staleFrames = 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Is the camera still there?                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * The camera we had is gone. Not an "error": from the child's side this is
   * exactly the same situation as a device that never had a camera, and the
   * surface already has a good path for that one.
   */
  #cameraLost(detail: string): void {
    // Already torn down — a freeze and an `ended` event routinely both fire.
    if (!this.#running && this.#stream === null) return;
    this.#stopLoop();
    this.#releaseCamera();
    this.#reducer.reset();
    this.#busy = false;
    // A camera that died must not be silently re-opened by resume().
    this.#wanted = null;
    this.#setStatus("unavailable", detail);
  }

  #watchTracks(stream: MediaStream): void {
    let tracks: readonly MediaStreamTrack[] = [];
    try {
      tracks = stream.getTracks();
    } catch {
      return;
    }
    for (const track of tracks) {
      if (typeof track.addEventListener !== "function") continue;
      const onEnded = (): void => this.#cameraLost(CAMERA_ENDED_DETAIL);
      const onMute = (): void => this.#onTrackMuted();
      const onUnmute = (): void => this.#clearMuteTimer();
      try {
        track.addEventListener("ended", onEnded);
        track.addEventListener("mute", onMute);
        track.addEventListener("unmute", onUnmute);
      } catch {
        continue;
      }
      this.#trackCleanups.push(() => {
        try {
          track.removeEventListener("ended", onEnded);
          track.removeEventListener("mute", onMute);
          track.removeEventListener("unmute", onUnmute);
        } catch {
          // The track is gone, which is the only thing those handlers were for.
        }
      });
    }
  }

  #unwatchTracks(): void {
    const cleanups = this.#trackCleanups;
    this.#trackCleanups = [];
    for (const off of cleanups) off();
  }

  /**
   * A muted track is not yet a dead one — switching apps mutes and unmutes
   * within a frame or two on several platforms — so this is the one signal we
   * give a grace period rather than acting on immediately.
   */
  #onTrackMuted(): void {
    if (this.#muteTimer !== null) return;
    this.#muteTimer = setTimeout(() => {
      this.#muteTimer = null;
      this.#cameraLost(CAMERA_MUTED_DETAIL);
    }, MUTE_GRACE_MS);
  }

  #clearMuteTimer(): void {
    if (this.#muteTimer === null) return;
    clearTimeout(this.#muteTimer);
    this.#muteTimer = null;
  }

  #watchVisibility(): void {
    const host = this.#lifecycle;
    if (!host || typeof host.addEventListener !== "function") return;
    const onChange = (): void => {
      if (host.hidden) this.suspend();
      else this.resume();
    };
    try {
      host.addEventListener("visibilitychange", onChange);
    } catch {
      return;
    }
    this.#offVisibility = () => {
      try {
        host.removeEventListener("visibilitychange", onChange);
      } catch {
        // Nothing left to unsubscribe from.
      }
    };
  }

  /**
   * A webcam being unplugged does not always end its track, and never fires
   * `mute`. `devicechange` is the only event that notices.
   */
  #watchDevices(): void {
    const devices = this.#camera;
    if (!devices || typeof devices.addEventListener !== "function") return;
    const onChange = (): void => this.#checkDevicesStillThere();
    try {
      devices.addEventListener("devicechange", onChange);
    } catch {
      return;
    }
    this.#offDeviceChange = () => {
      try {
        devices.removeEventListener?.("devicechange", onChange);
      } catch {
        // As above.
      }
    };
  }

  #checkDevicesStillThere(): void {
    if (!this.#running) return;
    const stream = this.#stream;
    if (!stream) return;

    let tracks: readonly MediaStreamTrack[] = [];
    try {
      tracks = stream.getTracks();
    } catch {
      return;
    }
    if (tracks.every((t) => t.readyState === "ended")) {
      this.#cameraLost(CAMERA_GONE_DETAIL);
      return;
    }

    const devices = this.#camera;
    const enumerate = devices?.enumerateDevices;
    if (!devices || typeof enumerate !== "function") return;
    void Promise.resolve(enumerate.call(devices))
      .then((list) => {
        // The check is worth nothing once we have already stopped.
        if (!this.#running) return;
        if (!list.some((d) => d.kind === "videoinput")) this.#cameraLost(CAMERA_GONE_DETAIL);
      })
      .catch(() => undefined);
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

/** `navigator.mediaDevices`, or null where there is no camera API at all. */
function browserCamera(): CameraDevices | null {
  const devices = (globalThis as { navigator?: Navigator }).navigator?.mediaDevices;
  if (!devices || typeof devices.getUserMedia !== "function") return null;
  return devices;
}

/** `document`, or null outside a DOM (tests, workers). */
function browserLifecycle(): PageLifecycle | null {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc || typeof doc.addEventListener !== "function") return null;
  return doc;
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

export function createVisionEngine(opts?: VisionEngineOptions): LifecycleVisionEngine {
  return new OnDeviceVisionEngine(opts);
}
