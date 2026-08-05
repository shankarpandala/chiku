// The contract between the on-device vision layer and everything that consumes
// it. Pinned here so the vision implementation and the surfaces can be built
// against the same shape.
//
// INVARIANT: nothing in this module — or downstream of it — may transmit a
// frame, a landmark, or any derived image data. Inference is on-device; the
// only thing that ever leaves `vision/` is the small structured summary below.

/** Normalized gaze/attention derived from the face. */
export interface FaceSignal {
  /** Face centre in normalized screen space: -1 (left) … +1 (right). */
  x: number;
  /** -1 (up) … +1 (down). */
  y: number;
  /** Rough "is the child facing the screen" score, 0..1. */
  attention: number;
  /** 0..1 smile strength (blendshapes), for warm reactions — never scored. */
  smile: number;
}

/** Per-hand summary. Counting is angle-based; see the implementation notes. */
export interface HandSignal {
  /** "Left" | "Right" as MediaPipe reports it (anatomical, on unmirrored input). */
  handedness: string;
  /** Extended-finger count 0..5, or null when the hand is too ambiguous to score. */
  fingers: number | null;
  /** Per-finger extension, thumb first. */
  extended: readonly [boolean, boolean, boolean, boolean, boolean];
  /** Canned gesture label when confident (confirming signal only, never a gate). */
  gesture: string | null;
  /** Wrist position, normalized 0..1 in image space. */
  wrist: { x: number; y: number };
}

export interface VisionFrame {
  /** Milliseconds, from the vision clock. */
  t: number;
  face: FaceSignal | null;
  hands: readonly HandSignal[];
  /** Total extended fingers across all visible hands, or null if none scoreable. */
  totalFingers: number | null;
  /** True while a wave is in progress (wrist oscillation + open palm). */
  waving: boolean;
}

export type VisionStatus =
  | "idle"
  | "loading"
  | "ready"
  | "denied"
  | "unavailable"
  | "error";

export interface VisionEngine {
  readonly status: VisionStatus;
  /** Requests the camera and starts inference. Resolves once running. */
  start(video: HTMLVideoElement): Promise<void>;
  stop(): void;
  onFrame(cb: (frame: VisionFrame) => void): () => void;
  onStatus(cb: (status: VisionStatus, detail?: string) => void): () => void;
  dispose(): void;
}
