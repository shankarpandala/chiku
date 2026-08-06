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
import { HysteresisGate, Presence, type Hysteresis } from "../vision/stability";
import type { FaceSignal, VisionFrame } from "../vision/types";

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

/* -------------------------------------------------------------------------- */
/* Attention — one debounced answer, shared by the rig and the teal cue        */
/* -------------------------------------------------------------------------- */

/**
 * Strict to lock on, loose to hold on. The old single 0.35, compared per frame
 * in two different files, made Chiku glance away and the teal caption strobe
 * whenever a child hovered at the boundary — which the fingers activity
 * REQUIRES them to do, because counting on your hands means looking down at
 * them. A child cannot perceive that flicker as caused by anything they did, so
 * it reads as Chiku losing interest at random.
 */
export const ATTENTION_BAND: Hysteresis = Object.freeze({ enter: 0.4, exit: 0.25 });

/**
 * Frames of face-detector dropout that change nothing at all, when the frame
 * does NOT carry the engine's own `facePresence`. `face === null` for one frame
 * is a tracker blink, not a child leaving the room; the old code called
 * `setAttention(false)` on it instantly.
 *
 * Deliberately shorter than the engine's 25-frame window: this fallback only
 * runs for frames synthesised outside the engine, where there is no reason to
 * believe a face was ever there for 25 frames in the first place.
 */
export const ATTENTION_HOLD_FRAMES = 6;

/**
 * Once past that window, belief falls by this much per frame, so the score we
 * are still crediting the child with fades out instead of being cut.
 */
export const ATTENTION_FADE_PER_FRAME = 0.5;

/** Above this, Chiku smiles back. Mirroring is the cheapest warmth there is. */
export const MIRROR_SMILE_THRESHOLD = 0.4;

/**
 * ...and he keeps smiling back until the child's smile really drops. Same
 * reason as SMILE_BAND in activities/smile.ts: a blendshape score wobbles, and
 * a mouth that snaps open and shut across the boundary looks like a fault.
 */
export const MIRROR_SMILE_BAND: Hysteresis = Object.freeze({
  enter: MIRROR_SMILE_THRESHOLD,
  exit: 0.32,
});

export interface AttentionGate {
  /**
   * One frame in, the debounced "Chiku can see the child" out.
   *
   * `facePresence` is the engine's own dropout-tolerant belief (VisionFrame);
   * pass it when the frame carries one. Without it a local Presence stands in,
   * so a hand-built frame still gets forgiven.
   */
  update(face: FaceSignal | null, facePresence?: number): boolean;
  readonly on: boolean;
  reset(): void;
}

/**
 * Presence answers "is a face still there" across dropouts; the gate answers
 * "is that face attending" without chattering. Composed rather than merged
 * because they fail differently: the tracker drops frames, the child glances.
 *
 * The two are joined by a RATIO rather than a product. A presence value is
 * only meaningful against itself — the engine's rises at 0.12/frame, so
 * multiplying by it would mean Chiku ignoring a child for the first four
 * frames of every session. What matters is how much of the belief we had when
 * we last actually saw them still survives; while that is 1, the child keeps
 * the score they earned.
 */
export function createAttentionGate(): AttentionGate {
  // rise 1: for the fallback, a detected face is believed immediately — the
  // attention SCORE already carries all the nuance, so there is nothing to ramp.
  const fallback = new Presence(ATTENTION_HOLD_FRAMES, 1, ATTENTION_FADE_PER_FRAME);
  const gate = new HysteresisGate(ATTENTION_BAND);
  let lastScore = 0;
  let beliefWhenSeen = 0;

  return {
    update(face, facePresence) {
      // Stepped every frame, used only when the engine offers nothing better.
      const local = fallback.update(face !== null);
      const belief = facePresence ?? local;

      if (face !== null) {
        lastScore = face.attention;
        beliefWhenSeen = belief;
        return gate.update(face.attention);
      }
      const survived = beliefWhenSeen > 0 ? Math.min(1, belief / beliefWhenSeen) : 0;
      return gate.update(lastScore * survived);
    },
    get on() {
      return gate.on;
    },
    reset() {
      fallback.reset();
      gate.reset();
      lastScore = 0;
      beliefWhenSeen = 0;
    },
  };
}

export interface CameraStageHandle {
  /**
   * Drive the rig from one vision frame. Safe to call at camera rate.
   *
   * Returns the DEBOUNCED "Chiku can see the child" state. It is returned
   * rather than recomputed by the caller because there must be exactly one
   * attention gate: the rig's eyes and the teal caption disagreeing by a frame
   * is the strobe this whole change exists to remove.
   */
  applyFrame(frame: VisionFrame): boolean;
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
  /**
   * Idle the rig when there is no camera at all, so he is never a statue.
   * An explicit override also resets the attention gate: whatever the camera
   * last believed is no longer the authority on where Chiku is looking.
   */
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
  /** The one attention gate. Survives rig re-creation; the child has not moved. */
  const attentionRef = useRef(createAttentionGate());
  const mirrorSmileRef = useRef(new HysteresisGate(MIRROR_SMILE_BAND));
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
        const face = frame.face;
        // Gate first and unconditionally: it must advance one step per frame
        // whether or not a rig is mounted, or its frame budget would depend on
        // React's mounting order.
        const attending = attentionRef.current.update(face, frame.facePresence);

        const rig = rigRef.current;
        if (!rig) return attending;
        const talking = speechMouthRef.current !== null;

        if (face) {
          // The single strongest presence cue: the eyes go where the child is
          // — on the mirrored picture the child is actually looking at.
          rig.setGaze(face.x * MIRROR_X, face.y);
          // Smile back, and let the jaw follow the smile so the face is not a
          // mask — unless Chiku is mid-sentence, in which case the jaw is his.
          const smiling = mirrorSmileRef.current.update(face.smile);
          rig.setViseme(smiling && !talking ? "smile" : null);
          if (!talking) rig.setMouthOpen(Math.min(0.4, face.smile * 0.4));
        } else if (!attending) {
          // Nobody found, and the gate has stopped believing in them: only now
          // does the face relax. A dropped frame while still attending leaves
          // the mouth exactly where it was, because that is what a dropped
          // frame means — no news, not bad news.
          mirrorSmileRef.current.reset();
          if (!talking) {
            rig.setViseme(null);
            rig.setMouthOpen(0);
          }
        }
        rig.setAttention(attending);
        return attending;
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
        attentionRef.current.reset();
        mirrorSmileRef.current.reset();
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
