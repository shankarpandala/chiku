// The video-call frame: the child on the left, Chiku beside them, both inside
// one rounded stage so it reads as "we are in the same picture".
//
// Two decisions worth defending:
//
// 1. VISION FRAMES DO NOT GO THROUGH REACT. `applyFrame` is imperative and is
//    called straight from the vision callback at camera rate. Re-rendering a
//    tree 30 times a second to move two pupils would cost more than the whole
//    inference does, and it would add a frame of latency to the one thing that
//    has to feel instant (goal 2: react within ~200ms).
//
// 2. THE TEAL CUE IS ON THE STAGE, NOT ON CHIKU. The live rig has no listening
//    ring — and teal is reserved for "Chiku is attending to you" (§9). Here
//    that means the frame itself lights up when Chiku can see the child, so the
//    character never wears a UI chrome element.
//
// INVARIANT: the <video> is a local sink. Its stream is never captured to a
// canvas for upload, never recorded, and never sent anywhere (see the CSP in
// vite.config.ts, which makes that structurally impossible, not just intended).

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from "react";
import { createLiveRig, type Emote, type LiveRig, type Viseme } from "@chiku/rig";
import type { VisionFrame } from "../vision/types";

export type RigFactory = typeof createLiveRig;

/**
 * The preview is mirrored (`.stage-video { transform: scaleX(-1) }`) because a
 * child raising their right hand has to see it on their right. FaceSignal.x is
 * documented as RAW camera-image space, so the surface that mirrors is the
 * surface that must flip — see the note on faceToGaze in vision/gaze.ts. Get
 * this wrong and Chiku looks away from the child, which is worse than not
 * tracking at all.
 */
const MIRROR_X = -1;

/** Above this, Chiku believes someone is there and locks on. */
export const ATTENTION_THRESHOLD = 0.35;
/** Above this, Chiku smiles back. Mirroring is the cheapest warmth there is. */
export const MIRROR_SMILE_THRESHOLD = 0.4;

export interface CameraStageHandle {
  /** Drive the rig from one vision frame. Safe to call at camera rate. */
  applyFrame(frame: VisionFrame): void;
  setEmote(emote: Emote): void;
  setViseme(viseme: Viseme | null): void;
  /**
   * Jaw openness while CHIKU is talking, 0..1 — or null to hand the mouth back
   * to the vision frame.
   *
   * Two things drive this jaw and only one may win at a time: the mirrored
   * smile (applyFrame, at camera rate) and speech. Speech wins while it is
   * speaking, otherwise the next camera frame would slam the mouth shut
   * between two syllables and Chiku would look like he is chewing.
   */
  setMouthOpen(open: number | null): void;
  blink(): void;
  /** Idle the rig when there is no camera at all, so he is never a statue. */
  setAttention(on: boolean): void;
  /** The local video sink the vision engine attaches the stream to. */
  video(): HTMLVideoElement | null;
}

interface CameraStageProps {
  cameraOn: boolean;
  /** Teal ring: Chiku can see the child right now. */
  attending: boolean;
  reducedMotion: boolean;
  /** Accessible name for the self-view. */
  videoLabel: string;
  /** Test seam — defaults to the real live rig. */
  rigFactory?: RigFactory;
  /** Status pill / overlay content rendered on top of the frame. */
  children?: ReactNode;
}

export const CameraStage = forwardRef<CameraStageHandle, CameraStageProps>(function CameraStage(
  { cameraOn, attending, reducedMotion, videoLabel, rigFactory, children },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rigRef = useRef<LiveRig | null>(null);
  /** Non-null while speech owns the jaw; see setMouthOpen. */
  const speechMouthRef = useRef<number | null>(null);
  const factory = rigFactory ?? createLiveRig;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rig = factory(host, { crop: "head", reducedMotion });
    rigRef.current = rig;
    return () => {
      rig.dispose();
      rigRef.current = null;
    };
  }, [factory, reducedMotion]);

  // React's `muted` attribute is unreliable across renderers; the property is
  // what actually keeps autoplay legal, so set it directly.
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.muted = true;
  }, []);

  useImperativeHandle(
    ref,
    (): CameraStageHandle => ({
      applyFrame(frame) {
        const rig = rigRef.current;
        if (!rig) return;
        const talking = speechMouthRef.current !== null;
        const face = frame.face;
        if (face) {
          // The single strongest presence cue: the eyes go where the child is
          // — on the mirrored picture the child is actually looking at.
          rig.setGaze(face.x * MIRROR_X, face.y);
          rig.setAttention(face.attention >= ATTENTION_THRESHOLD);
          // Smile back, and let the jaw follow the smile so the face is not a
          // mask — unless Chiku is mid-sentence, in which case the jaw is his.
          rig.setViseme(face.smile >= MIRROR_SMILE_THRESHOLD && !talking ? "smile" : null);
          if (!talking) rig.setMouthOpen(Math.min(0.4, face.smile * 0.4));
        } else {
          // Nobody found: the rig wanders, which reads as "waiting", not "dead".
          rig.setAttention(false);
          if (!talking) {
            rig.setViseme(null);
            rig.setMouthOpen(0);
          }
        }
      },
      setEmote(emote) {
        rigRef.current?.setEmote(emote);
      },
      setViseme(viseme) {
        rigRef.current?.setViseme(viseme);
      },
      setMouthOpen(open) {
        speechMouthRef.current = open;
        rigRef.current?.setMouthOpen(open ?? 0);
      },
      blink() {
        rigRef.current?.blink();
      },
      setAttention(on) {
        rigRef.current?.setAttention(on);
      },
      video: () => videoRef.current,
    }),
    [],
  );

  const className = [
    "stage",
    attending ? "is-attending" : "",
    cameraOn ? "has-camera" : "no-camera",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className} data-attending={attending ? "true" : "false"}>
      <div className="stage-video-well">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- self-view, no audio track is ever used */}
        <video
          ref={videoRef}
          className="stage-video"
          muted
          playsInline
          autoPlay
          aria-label={videoLabel}
          data-testid="self-view"
        />
      </div>
      <div className="stage-chiku" ref={hostRef} data-testid="chiku-host" />
      {children}
    </div>
  );
});
