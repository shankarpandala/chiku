// The toddler stage: a WHOLE elephant, standing up, big in the middle of the
// screen.
//
// WHY NOT `CameraStage`. That component is built for the 3-8 game and is right
// for it: Chiku is cropped to the head (`crop: "head"`), tucked into the
// bottom-right corner, and shares the frame with a large self-view, because
// there the child's own hands are what is being looked at. Toddler mode inverts
// every one of those choices. The child is not being looked at — they are
// COPYING — so the thing on screen has to be a whole animal with legs and feet,
// as big as the screen allows, and the self-view has to be small enough that it
// does not compete with him. A two-year-old will watch themselves on a screen
// forever, and while they are doing that they are not stomping.
//
// So: `showBody: true`, `crop: "full"`, centre stage, and the camera preview
// demoted to a corner (and only present at all once a grown-up has switched it
// on). Everything else — the rig, the attention gate — is reused as-is.
//
// INVARIANT (§9 + the camera rule): the <video> is a local sink. Nothing here
// captures, records or transmits it; the CSP makes that structurally
// impossible rather than merely unintended.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from "react";
import { createLiveRig, type Emote, type LiveRig } from "@chiku/rig";
import { createAttentionGate, type RigFactory } from "../../components/CameraStage";
import type { MovementKind } from "../../vision/movement";
import type { VisionFrame } from "../../vision/types";

/**
 * The mirror flip, for the same reason `CameraStage` does it: the preview is
 * mirrored so a child raising their right hand sees it on their right, and
 * `FaceSignal.x` is raw camera-image space.
 */
const MIRROR_X = -1;

export interface ToddlerStageHandle {
  /** One vision frame → the rig's eyes. Returns the debounced "he sees you". */
  applyFrame(frame: VisionFrame): boolean;
  setEmote(emote: Emote): void;
  /**
   * Do the movement, so the child can copy it. Safe with no camera — the
   * demonstration is the game, and detection is only what makes the reaction
   * to it contingent.
   */
  perform(move: MovementKind): void;
  blink(): void;
  setAttention(on: boolean): void;
  /** Jaw, while Chiku is making his warm noise. Null hands it back. */
  setMouthOpen(open: number | null): void;
  /** The local video sink the vision engine attaches the stream to. */
  video(): HTMLVideoElement | null;
}

interface ToddlerStageProps {
  /** True once a grown-up has switched the camera on. */
  cameraOn: boolean;
  /** Teal: Chiku can see the child right now. */
  attending: boolean;
  reducedMotion: boolean;
  /** Accessible name for the self-view. */
  videoLabel: string;
  /**
   * The movement Chiku is performing right now, or null while he is watching.
   * Drives the CSS performance, which is the floor under `rig.perform`.
   */
  move: MovementKind | null;
  /** Test seam — defaults to the real live rig. */
  rigFactory?: RigFactory;
  children?: ReactNode;
}

export const ToddlerStage = forwardRef<ToddlerStageHandle, ToddlerStageProps>(
  function ToddlerStage(
    { cameraOn, attending, reducedMotion, videoLabel, move, rigFactory, children },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const rigRef = useRef<LiveRig | null>(null);
    const speechMouthRef = useRef<number | null>(null);
    /** One gate, shared by the eyes and the teal frame — never two opinions. */
    const attentionRef = useRef(createAttentionGate());
    const factory = rigFactory ?? createLiveRig;

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      // The whole animal: legs, feet, belly. He has to be able to stand up and
      // stomp, and an elephant with no feet cannot demonstrate elephant feet.
      const rig = factory(host, { crop: "full", showBody: true, reducedMotion });
      rigRef.current = rig;
      // Nobody is being tracked until a camera says otherwise, but he must not
      // be a statue either — the idle wander is what makes him a character.
      rig.setAttention(false);
      return () => {
        rig.dispose();
        rigRef.current = null;
      };
    }, [factory, reducedMotion]);

    // React's `muted` attribute is unreliable across renderers; the property is
    // what actually keeps autoplay legal.
    useEffect(() => {
      const video = videoRef.current;
      if (video) video.muted = true;
    }, []);

    useImperativeHandle(
      ref,
      (): ToddlerStageHandle => ({
        applyFrame(frame) {
          const face = frame.face;
          // Advanced unconditionally, rig or no rig, so its frame budget does
          // not depend on React's mounting order.
          const seen = attentionRef.current.update(face, frame.facePresence);
          const rig = rigRef.current;
          if (!rig) return seen;
          if (face) rig.setGaze(face.x * MIRROR_X, face.y);
          rig.setAttention(seen);
          return seen;
        },
        setEmote(emote) {
          rigRef.current?.setEmote(emote);
        },
        perform(m) {
          // Fire and forget. The promise resolves when the beat ends, but the
          // rig's own contract says a caller sequencing beats should pace
          // itself — under reduced motion `perform` holds a static pose and
          // resolves at once, so awaiting it would collapse every
          // demonstration to nothing on exactly the devices that need the
          // pose to stay put. The surface times the beat (`Exercise.showMs`).
          void rigRef.current?.perform(m);
        },
        blink() {
          rigRef.current?.blink();
        },
        setAttention(on) {
          attentionRef.current.reset();
          rigRef.current?.setAttention(on);
        },
        setMouthOpen(open) {
          speechMouthRef.current = open;
          rigRef.current?.setMouthOpen(open ?? 0);
        },
        video: () => videoRef.current,
      }),
      [],
    );

    const className = [
      "toddler-stage",
      attending ? "is-attending" : "",
      cameraOn ? "has-camera" : "no-camera",
      reducedMotion ? "is-still" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div className={className} data-attending={attending ? "true" : "false"}>
        {/* Always mounted, even before the camera is switched on: a <video>
            that is created at the moment the stream arrives is a <video> some
            browsers refuse to play. Faded out rather than removed, for the
            same reason CameraStage does it — a hidden sink is allowed to stop
            producing frames, which would silently starve the tracker. */}
        <div className="toddler-selfie">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- self-view, no audio track is ever used */}
          <video
            ref={videoRef}
            className="toddler-video"
            muted
            playsInline
            autoPlay
            aria-label={videoLabel}
            data-testid="toddler-self-view"
          />
        </div>
        <div
          className="toddler-chiku"
          ref={hostRef}
          data-testid="toddler-chiku-host"
          data-move={move ?? "watching"}
        />
        {children}
      </div>
    );
  },
);
