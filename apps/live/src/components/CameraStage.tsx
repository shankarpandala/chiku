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
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from "react";
import { createLiveRig, type Emote, type LiveRig, type Viseme } from "@chiku/rig";
import { HysteresisGate, Presence, type Hysteresis } from "../vision/stability";
import type { Quad } from "../vision/quad";
import type { FaceSignal, VisionFrame } from "../vision/types";
import {
  MagicWindow,
  type HuntColour,
  type MagicWindowHandle,
  type MagicWindowMode,
} from "./MagicWindow";
import { quadGaze, WINDOW_GAZE_PRESENCE } from "./magicWindowGeometry";

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

/**
 * The frame's window, normalised to "a quad or nothing".
 *
 * This used to widen `VisionFrame` with a structural `{ quad?: Quad | null }`
 * and assert its way onto it, because the field was still landing in the
 * vision layer. It has landed: `quad` is on VisionFrame now, so the cast is
 * gone and the only thing left here is the `undefined`→`null` fold that every
 * consumer wants. An enforced contract beats an asserted one — with the cast
 * in place, the vision layer could have renamed or retyped the field and this
 * file would have compiled all the way to a child's device.
 */
export function frameQuad(frame: VisionFrame): Quad | null {
  return frame.quad ?? null;
}

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
/**
 * How small and how big Chiku may get while mirroring the child.
 *
 * Not 0..2. Below about half he stops reading as a character and starts
 * reading as a bug, and above about 1.4 his head leaves the stage frame — and
 * a child copying an elephant whose face has gone off the top of the picture
 * has been given a worse game, not a bigger one.
 */
export const CHIKU_MIN_SIZE = 0.6;
export const CHIKU_MAX_SIZE = 1.4;

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
   * How BIG Chiku is, as a multiple of his normal size.
   *
   * The big/small activity asks the child to make themselves enormous and then
   * tiny, and a character who says "now make yourself big!" without changing
   * size himself is giving an instruction rather than playing a game. So the
   * surface mirrors the child's own size onto him at camera rate.
   *
   * Imperative and outside React for the same reason `applyFrame` is: this
   * moves every frame, and committing React thirty times a second to animate a
   * transform is the thing this handle exists to avoid. Clamped here rather
   * than at the call site so no caller can make him a dot or a wall.
   */
  setSize(scale: number): void;
  /**
   * Idle the rig when there is no camera at all, so he is never a statue.
   * An explicit override also resets the attention gate: whatever the camera
   * last believed is no longer the authority on where Chiku is looking.
   */
  setAttention(on: boolean): void;
  /** The local video sink the vision engine attaches the stream to. */
  video(): HTMLVideoElement | null;
  /**
   * The magic window, or null when no `windowMode` is set. An activity reads
   * `coverage()` off this to know whether the child found the red thing.
   */
  magicWindow(): MagicWindowHandle | null;
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
  /**
   * Turn the magic window on, and say what it shows. Omitted means no window is
   * mounted at all — the quad on the frame is simply ignored.
   */
  windowMode?: MagicWindowMode;
  /** Which colour the lens keeps. Only meaningful for `windowMode="lens"`. */
  huntColour?: HuntColour;
  /** Lens coverage, 0..1, whenever it moves meaningfully. */
  onWindowCoverage?: (coverage: number) => void;
  /** Status pill / overlay content rendered on top of the frame. */
  children?: ReactNode;
}

export const CameraStage = forwardRef<CameraStageHandle, CameraStageProps>(function CameraStage(
  {
    cameraOn,
    attending,
    reducedMotion,
    videoLabel,
    rigFactory,
    windowMode,
    huntColour,
    onWindowCoverage,
    children,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rigRef = useRef<LiveRig | null>(null);
  const windowRef = useRef<MagicWindowHandle | null>(null);
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

        // The window is painted straight from here, at camera rate, without a
        // React render — same reason the rig is (see the header).
        const quad = frameQuad(frame);
        windowRef.current?.setQuad(quad);

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

        // A window the child is really holding OUTRANKS their face: the whole
        // point of the thing is that Chiku is looking through it with them, and
        // a child watching him keep his eyes on their nose instead of on the
        // window they just made would learn that he is not really with them.
        if (quad !== null && quad.presence >= WINDOW_GAZE_PRESENCE) {
          const g = quadGaze(quad);
          rig.setGaze(g.x, g.y);
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
      setSize(scale) {
        const host = hostRef.current;
        if (!host) return;
        const safe = Number.isFinite(scale) ? Math.min(CHIKU_MAX_SIZE, Math.max(CHIKU_MIN_SIZE, scale)) : 1;
        // A custom property rather than `style.transform`: the no-camera rule
        // already owns the transform (it centres him), and overwriting it here
        // would slide him off the stage the moment the camera was refused.
        host.style.setProperty("--chiku-size", safe.toFixed(3));
      },
      setAttention(on) {
        attentionRef.current.reset();
        mirrorSmileRef.current.reset();
        rigRef.current?.setAttention(on);
      },
      video: () => videoRef.current,
      magicWindow: () => windowRef.current,
    }),
    [],
  );

  // Stable so MagicWindow's props do not churn; it reads the sink at paint time
  // rather than holding a reference to it.
  const source = useCallback((): HTMLVideoElement | null => videoRef.current, []);

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
      {/* Over the video, under Chiku: the window is something the child holds
          up in front of the room, not something painted over their friend. */}
      {windowMode !== undefined && (
        <MagicWindow
          ref={windowRef}
          mode={windowMode}
          target={huntColour}
          mirrored
          reducedMotion={reducedMotion}
          source={source}
          onCoverage={onWindowCoverage}
        />
      )}
      <div className="stage-chiku" ref={hostRef} data-testid="chiku-host" />
      {children}
    </div>
  );
});
