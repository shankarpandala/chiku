// Chiku Live — the whole surface, as one small state machine.
//
//   welcome → camera-ask → playing → goodbye → (play again) → playing
//
// Design priorities, in order, and where each one lives:
//   1. Chiku LOOKS AT the child — every vision frame goes straight to the rig
//      via CameraStage.applyFrame, outside React, at camera rate.
//   2. Chiku REACTS within ~200ms — success fires on the frame the hold
//      completes; the emote change is a rig target, not a re-render.
//   3. The child's BODY is the answer — activities read VisionFrame, and the
//      tap answers exist so that a refused camera changes the input device,
//      not the game.
//   4. Chiku SPEAKS AND LISTENS — every prompt is said aloud, and a spoken
//      answer counts exactly as much as a shown or tapped one.
//
// NEVER A DEAD END is a hard rule here: every failure path (denied, no camera
// hardware, no speech synthesis, a refused mic, a tracker error, a child who
// just will not wave today) lands in the same playable place. Speech is added
// on top of the game and is never in front of it: if the speaker is missing
// the surface behaves exactly as it did before there was a voice.
//
// THE MICROPHONE IS NEVER OPEN ON ITS OWN. It opens while a hand is on the
// talk button and closes when that hand leaves — see TalkButton. This is a
// bedroom, and "we only listen at the checkpoint" is not a promise an
// always-live mic can make.
//
// INVARIANTS (§9 + camera rule): no frame, landmark, derived image datum or
// syllable leaves the device — the engine hands us a small struct, speech
// synthesis and recognition are platform features running locally, and the CSP
// forbids the network anyway. No analytics. No PII. No hosted model (which is
// also why the Gemini terms problem never reaches this path). Both scripts on
// every kid-facing string. Teal only ever means "Chiku is attending to you" —
// on the stage frame when he can see you, on the talk button when he can hear
// you, and nowhere else.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Emote } from "@chiku/rig";
import { Bilingual } from "../../components/Bilingual";
import { BigButton } from "../../components/BigButton";
import { CameraStage, type CameraStageHandle, type RigFactory } from "../../components/CameraStage";
import type { MagicWindowMode } from "../../components/MagicWindow";
import type { HuntColour } from "../../components/magicLens";
import { HUNT_PRESENCE } from "../../activities/hunt";
import { ChoiceButton } from "../../components/ChoiceButton";
import { StreakStars } from "../../components/StreakStars";
import { TalkButton } from "../../components/TalkButton";
import { useReducedMotion } from "../../components/useReducedMotion";
import { translate, useI18n, type I18nKey, type Lang, type Values } from "../../i18n";
import { buildRound, HoldTracker, type Activity, type ActivityChoice } from "../../activities";
import {
  alongsideBeatsFor,
  copyKey,
  demoBeatsFor,
  optionalCopyKey,
  randInt,
  verdictFor,
  type DemoBeat,
} from "../../activities/types";
import {
  assistAfterMiss,
  praiseToneFor,
  relaxFor,
  type AssistLevel,
  type PraiseTone,
  type Relaxation,
} from "../../activities/assist";
import { createVisionEngine } from "../../vision/engine";
import { getCalibration } from "../../vision/calibration";
import { relaxThresholds } from "../../vision/fingers";
import type { VisionEngine, VisionFrame, VisionStatus } from "../../vision/types";
import { createListener, createSpeaker, isMicUnusable } from "../../voice";
import { getCloudEars, setCloudEars } from "../../settings/cloudEars";
import { GROWNUP_OPEN_HOLD_MS, HoldButton } from "../../components/HoldButton";
import { GrownUpSheet } from "../../components/GrownUpSheet";
import { HoldRing } from "../../components/HoldRing";
import { SunArc } from "../../components/SunArc";
import { getLimitMinutes, SESSION_TICK_MS, SessionClock, setLimitMinutes } from "../../session/cap";
import { warmVision } from "../../session/warmup";
import type { HeardResult, Listener, SpeakHandle, Speaker, VoiceLang } from "../../voice/types";

export type Phase = "welcome" | "camera-ask" | "playing" | "goodbye";
export type CameraMode = "unknown" | "on" | "off";
/** "unknown" until the platform has been asked — never flash the honest line. */
export type MicMode = "unknown" | "ready" | "off";
/**
 * The camera-ask screen's own state machine. "warming" is the whole point of
 * it: the models come down while the camera is still DARK.
 */
export type WarmState = "idle" | "warming" | "ready" | "failed";
type RoundState = "prompt" | "praise";
/**
 * Where a miss came from. Only "child" is proof that anybody is in the room —
 * a timeout is equally consistent with a phone on a sofa.
 */
type MissSource = "timeout" | "child";

/** How long the praise stays up before the next prompt. */
const PRAISE_MS = 2200;
/** How long a child may work on a prompt before Chiku steps down a rung. */
const ASSIST_AFTER_MS = 8000;

/**
 * Room for the warm nudge to be heard before Chiku starts demonstrating over
 * the top of himself. Not the length of the sentence — a stuck three-year-old
 * will not wait out a full sentence, and the nudge is on screen regardless.
 */
const DEMO_LEAD_MS = 1500;

/** How long "let's do it together!" sits before the counting-along starts. */
const TOGETHER_LEAD_MS = 700;

/** After counting along, a beat of nothing, and then the round succeeds. */
const TOGETHER_SETTLE_MS = 400;

/**
 * How long Chiku waits before asking the child to make a window with their
 * hands.
 *
 * The colour hunt is the one activity whose input device the child has to BUILD
 * before they can use it, so it is the one prompt that needs a second sentence.
 * Late enough that "Find something red!" has landed on its own — a child who
 * already knows the gesture should get to just do it — and the invitation is
 * skipped entirely if a window is already open, because telling a child to do
 * the thing they are visibly doing is how a toy stops feeling like it is
 * watching them.
 *
 * The wording (`window.invite`) covers all three gestures on purpose: a palm, a
 * pinch and two hands are all "a little window with your hands", and naming one
 * of them would fail the age band that cannot do it (see vision/quad.ts).
 */
const WINDOW_INVITE_MS = 2000;

const PRAISES: readonly I18nKey[] = ["praise.one", "praise.two", "praise.three"];

/** Most lines one praise bucket may hold. Missing ones are simply not there. */
const PRAISE_BUCKET_MAX = 6;

/**
 * Praise, bucketed by how hard the win was.
 *
 * Key shape, agreed with the copy change landing beside this one:
 * `praise.light.1…n`, `praise.warm.1…n`, `praise.effort.1…n`, picked from at
 * random within the bucket. Any bucket the dictionary does not carry yet falls
 * back to the three original lines, so this file behaves exactly as it did
 * before the buckets exist and improves the moment they land.
 *
 * `effort` copy must name the EFFORT and not the child — "you kept trying!",
 * never "clever girl" (Gunderson/Dweck; see `assist.ts`).
 */
function praiseBucket(tone: PraiseTone): readonly I18nKey[] {
  const found: I18nKey[] = [];
  for (let i = 1; i <= PRAISE_BUCKET_MAX; i += 1) {
    const key = optionalCopyKey(`praise.${tone}.${i}`);
    if (key) found.push(key);
  }
  return found.length > 0 ? found : PRAISES;
}

const PRAISE_BUCKETS: Readonly<Record<PraiseTone, readonly I18nKey[]>> = {
  light: praiseBucket("light"),
  warm: praiseBucket("warm"),
  effort: praiseBucket("effort"),
};

/**
 * "Let's do it together!" — the bottom rung, spoken as an invitation.
 *
 * Falls back to `praise.nudge` ("Nearly! Let's try that one together."), which
 * already exists in both dictionaries and already says the right thing, so
 * this rung is never mute even before the new copy lands.
 */
const TOGETHER_KEY: I18nKey = copyKey("demo.together", "praise.nudge");

/**
 * Capabilities the vision engine and the speaker are expected to grow but may
 * not have yet (they belong to a change landing beside this one). Feature-
 * detected at every call site, never assumed: this surface has to compile and
 * behave identically with or without them.
 */
type MaybeWarmEngine = VisionEngine & {
  /** A real model warm-up, if the engine ever exposes one. */
  warm?: () => Promise<void>;
};
type MaybeVoicedSpeaker = Speaker & {
  /** False when synthesis exists but has no voice for this language. */
  hasVoice?: (lang: VoiceLang) => boolean;
};

/** A line held back while the microphone was open. See `say`. */
interface PendingLine {
  readonly key: I18nKey;
  readonly values: Values | undefined;
  readonly speaking: Emote;
  readonly rest: Emote;
}

export interface LiveProps {
  /** Test seam — defaults to the real live rig. */
  rigFactory?: RigFactory;
  /** Test seam — drives target and order randomisation. */
  random?: () => number;
}

export function Live({ rigFactory, random = Math.random }: LiveProps) {
  const { lang, other, tIn } = useI18n();
  const reducedMotion = useReducedMotion();

  const stageRef = useRef<CameraStageHandle | null>(null);
  const engineRef = useRef<VisionEngine | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const listenerRef = useRef<Listener | null>(null);
  const speakHandleRef = useRef<SpeakHandle | null>(null);
  const mountedRef = useRef(true);
  // `ReturnType<typeof setTimeout>` rather than `number`: @types/node is on the
  // program's path and would otherwise make this a Node Timeout.
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const holdRef = useRef(new HoldTracker());

  /** Cumulative PLAY time (§9.5). Paused while the tab is hidden. */
  const clockRef = useRef(new SessionClock());
  /** Aborts an in-flight model warm-up on unmount or on a second attempt. */
  const warmAbortRef = useRef<AbortController | null>(null);

  const [phase, setPhase] = useState<Phase>("welcome");
  const [cameraMode, setCameraMode] = useState<CameraMode>("unknown");
  const [warmState, setWarmState] = useState<WarmState>("idle");
  /** The session ended because the cap was reached, not because it finished. */
  const [capped, setCapped] = useState(false);
  const [sessionProgress, setSessionProgress] = useState(0);
  const [limitMin, setLimitMin] = useState<number>(() => getLimitMinutes());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [status, setStatus] = useState<VisionStatus>("idle");
  const [busy, setBusy] = useState(false);
  const [attending, setAttending] = useState(false);
  const [round, setRound] = useState<readonly Activity[]>([]);
  const [index, setIndex] = useState(0);
  const [roundState, setRoundState] = useState<RoundState>("prompt");
  const [praiseKey, setPraiseKey] = useState<I18nKey>("praise.one");
  /**
   * How hard the win was. On the element so the celebration can be dressed
   * differently for a win that cost the child something — and so the choice is
   * checkable from outside, which a random pick from a bucket otherwise is not.
   */
  const [praiseTone, setPraiseTone] = useState<PraiseTone>("light");
  /** Tap answers are on screen (always, with no camera; after a miss, with one). */
  const [assist, setAssist] = useState(false);
  /**
   * How much help this PROMPT is getting. Reset in `beginPrompt`, not per
   * round: a child who needed carrying through "show me three" starts the next
   * activity fresh, because the next activity is a different thing to be
   * stuck on and starting it pre-helped would be its own small verdict.
   */
  const [assistLevel, setAssistLevel] = useState<AssistLevel>("none");
  const assistLevelRef = useRef<AssistLevel>("none");
  /** Misses on this prompt: timeouts, wrong taps and misheard answers alike. */
  const attemptsRef = useRef(0);
  /**
   * How far into the hold the child is, 0..1, for the counting ring.
   * Quantised to 1/50 before it reaches state: the raw value changes every
   * camera frame and committing React ~30x/s is exactly what `applyFrame`
   * stays imperative to avoid.
   */
  const [holdProgress, setHoldProgress] = useState(0);
  /**
   * Has anybody actually done anything this visit — a tap, a word?
   *
   * The bottom rung carries the child to success on timeouts alone, which is
   * right for a three-year-old sitting there stuck and wrong for a phone left
   * face-up on a sofa. With a camera, `attending` answers this. Without one
   * there is no presence signal at all, so a single tap or word anywhere in
   * the visit stands in for it. Chiku does not celebrate an empty room, and he
   * does not nag one every eight seconds either.
   */
  const interactedRef = useRef(false);
  /** The detector relaxation currently in force. See activities/assist.ts. */
  const relaxRef = useRef<Relaxation>(relaxFor("none"));
  /**
   * The magic window's latest lens coverage, 0..1, straight off the render
   * layer (CameraStage → MagicWindow → onWindowCoverage).
   *
   * A ref rather than state because it moves at camera rate and nothing draws
   * from it — it is merged onto the vision frame in `handleFrame` so the hunt
   * activity can read it as an ordinary field. See vision/types.ts for why the
   * number is measured in the renderer rather than in the vision layer.
   */
  const windowCoverageRef = useRef(0);
  /** A window the child is really holding, right now. Drives the invitation. */
  const windowOpenRef = useRef(false);
  const [windowOpen, setWindowOpen] = useState(false);
  /** The colour Chiku is holding up on the "watch me" rung, or null. */
  const [demoSwatch, setDemoSwatch] = useState<HuntColour | null>(null);
  /** The warm retry line is showing. Never a failure, just a nudge. */
  const [nudge, setNudge] = useState(false);
  const [nudgedId, setNudgedId] = useState<string | null>(null);
  const [streak, setStreak] = useState(0);
  const [micMode, setMicMode] = useState<MicMode>("unknown");
  /**
   * The parent's cloud-ears choice (see settings/cloudEars.ts). On-device
   * recognition stays the preferred path; this only matters on platforms —
   * like this one — where the browser has no local speech at all.
   */
  const [cloudEars, setCloudEarsState] = useState<boolean>(() => getCloudEars());
  /** Outcome of the ensureOnDevice probe: may the mic open at all? */
  const micAllowedRef = useRef<boolean | null>(null);
  /** The mic is genuinely open right now — the only thing that turns it teal. */
  const [listening, setListening] = useState(false);
  /**
   * Same fact, readable synchronously. Timers and recognition callbacks both
   * need it before React has committed, and both would otherwise start Chiku
   * talking into his own open microphone.
   */
  const listeningRef = useRef(false);

  // Mirrors: the vision callback runs between renders and must never read a
  // stale closure, so anything it touches also lives in a ref.
  const phaseRef = useRef<Phase>("welcome");
  const cameraModeRef = useRef<CameraMode>("unknown");
  const roundStateRef = useRef<RoundState>("prompt");
  const roundRef = useRef<readonly Activity[]>([]);
  const indexRef = useRef(0);
  const attendingRef = useRef(false);
  // Speech callbacks resolve on a later tick and must say the line in the
  // language on screen now, not the one that was on screen when it started.
  const langRef = useRef<Lang>(lang);
  langRef.current = lang;
  const cappedRef = useRef(false);
  const limitRef = useRef(limitMin);
  limitRef.current = limitMin;
  const warmStateRef = useRef<WarmState>("idle");

  const later = useCallback((fn: () => void, ms: number): void => {
    const id = globalThis.setTimeout(() => {
      if (mountedRef.current) fn();
    }, ms);
    timersRef.current.push(id);
  }, []);

  const clearTimers = useCallback((): void => {
    for (const id of timersRef.current) globalThis.clearTimeout(id);
    timersRef.current = [];
  }, []);

  const setEmote = useCallback((emote: Emote): void => {
    stageRef.current?.setEmote(emote);
  }, []);

  /**
   * The lens's latest reading, parked where the frame handler can find it.
   *
   * Stable identity on purpose: this crosses into MagicWindow, which paints
   * from a ref of its own props, and a new function every render is a prop
   * churn the camera-rate path should not have to notice.
   */
  const takeWindowCoverage = useCallback((coverage: number): void => {
    windowCoverageRef.current = coverage;
  }, []);

  // --- voice ---------------------------------------------------------------

  /** A line Chiku wanted to say while the mic was open. At most one — the newest. */
  const pendingSayRef = useRef<PendingLine | null>(null);

  /** Shut Chiku up right now and give the jaw back to the camera. */
  const hush = useCallback((): void => {
    speakHandleRef.current = null;
    speakerRef.current?.cancelAll();
    stageRef.current?.setMouthOpen(null);
  }, []);

  /**
   * Say one line, in the language on screen, and move the face while it plays.
   *
   * SPEECH IS NEVER LOAD-BEARING. It touches no game state, it is fired and
   * forgotten, and when the platform has no synthesiser this function does
   * nothing at all — including nothing to the emote, so a device without a
   * voice renders precisely the surface that shipped before this existed.
   *
   * CHIKU DOES NOT TALK WHILE THE MIC IS OPEN. Barge-in stops him when the
   * child starts; this is the other half of the same manners, and it also
   * keeps his own voice out of the recogniser — which would otherwise come
   * straight back as a wrong answer, and prompt another line, and loop.
   *
   * BUT WAITING HIS TURN IS NOT THE SAME AS SWALLOWING THE LINE. This
   * demographic holds the big teal button constantly — it lights up, so it is
   * a toy — and a suppressed line used to be gone: the child heard no prompt,
   * no nudge and, worst of all, no praise. So the newest suppressed line is
   * kept and spoken when the mic closes. Only the newest: an older line that
   * has been overtaken by a newer one is stale by definition, and Chiku
   * catching up on three sentences at once is a monologue, not a turn.
   */
  const say = useCallback(
    (key: I18nKey, values: Values | undefined, speaking: Emote, rest: Emote): void => {
      const speaker: MaybeVoicedSpeaker | null = speakerRef.current;
      if (!speaker?.available) return;
      if (listeningRef.current) {
        pendingSayRef.current = { key, values, speaking, rest };
        return;
      }
      // Actually saying something supersedes anything queued behind it.
      pendingSayRef.current = null;
      // A synthesiser with no voice INSTALLED for this language does not stay
      // silent — it substitutes another one, and Chiku reads Telugu in an
      // American accent. Skipping the line leaves the written text, which is
      // the same graceful degradation a device with no synthesiser gets.
      // Feature-detected: older speakers do not report this, and "unknown" has
      // to mean "go ahead" or every device loses its voice.
      if (speaker.hasVoice?.(langRef.current) === false) return;
      // One line at a time: a queue would let the praise land on top of the
      // next prompt and Chiku would be talking to himself.
      speaker.cancelAll();
      setEmote(speaking);
      const handle = speaker.speak(
        translate(langRef.current, key, values),
        langRef.current,
        (open) => {
          if (speakHandleRef.current === handle) stageRef.current?.setMouthOpen(open);
        },
      );
      speakHandleRef.current = handle;
      void handle.done.then(() => {
        // Superseded or barged in on — whoever replaced us owns the face now.
        if (speakHandleRef.current !== handle) return;
        speakHandleRef.current = null;
        stageRef.current?.setMouthOpen(null);
        if (mountedRef.current) setEmote(rest);
      });
    },
    [setEmote],
  );

  // The mount effect needs `say` without listing it as a dependency (that would
  // tear down the vision engine every time it changed identity).
  const sayRef = useRef(say);
  sayRef.current = say;

  /**
   * Speak whatever Chiku swallowed while the mic was open, if it is still the
   * newest thing he had to say. A no-op when nothing was held back, which is
   * the overwhelmingly common case.
   */
  const flushSay = useCallback((): void => {
    const pending = pendingSayRef.current;
    if (!pending || listeningRef.current) return;
    pendingSayRef.current = null;
    say(pending.key, pending.values, pending.speaking, pending.rest);
  }, [say]);

  /** The one writer of "is the mic open" — ref first, so callbacks agree. */
  const markListening = useCallback(
    (on: boolean): void => {
      listeningRef.current = on;
      setListening(on);
      // The mic just closed, so Chiku's turn has come round. On a tick rather
      // than inline: a caller that closes the mic and then says its own line in
      // the same breath — praise, goodbye — must supersede the queued one
      // rather than race it, and `say` clears the queue when it speaks.
      if (!on) later(flushSay, 0);
    },
    [flushSay, later],
  );
  const markListeningRef = useRef(markListening);
  markListeningRef.current = markListening;

  /**
   * Close the mic. Idempotent, and called from more directions than there are
   * ways to release a button: release, cancel, blur, a correct answer, the end
   * of the round, unmount.
   */
  const closeMic = useCallback((): void => {
    listenerRef.current?.stop();
    markListening(false);
  }, [markListening]);

  // --- the assist ladder ----------------------------------------------------
  //
  // THE PROBLEM THIS REPLACES. A child who could not show three fingers was
  // offered, after eight seconds, a row of numerals to tap — which is the SAME
  // COGNITIVE TASK. "Pick the 3" is not an easier door than "show me 3"; for a
  // three-year-old it is often a harder one. So the surface's own rule —
  // rounds end in praise — was unreachable for exactly the children who most
  // needed it to be true, and the only exits left were a timeout loop or a
  // grown-up. The ladder escalates TOWARD the answer instead:
  //
  //   watch     Chiku does it himself and asks again.
  //   easier    The detector quietly loosens. Nobody says so.
  //   together  Chiku does it alongside the child, and the round succeeds.
  //
  // There is no rung below "together" and no failure exit from it.

  // Forward references, so the ladder can call the things defined below it
  // without a dependency cycle between the callbacks.
  const succeedRef = useRef<() => void>(() => {});
  const registerMissRef = useRef<(source: MissSource) => void>(() => {});

  /** Put the relaxation for `level` into force. */
  const applyAssist = useCallback((level: AssistLevel): void => {
    const relax = relaxFor(level);
    relaxRef.current = relax;
    holdRef.current.relax(relax.extraSlackFrames);
    // The angle half. Always computed from the STORED per-child calibration
    // rather than from whatever is currently in force, so the rungs never
    // compound: "easier" then "together" is 14deg off the child's own baseline,
    // not 8 + 14, and going back up to "none" restores that baseline exactly.
    // Landing before the camera opens is fine — the engine keeps it.
    engineRef.current?.setCalibration(relaxThresholds(getCalibration(), relax.angleRelaxDeg));
  }, []);

  /**
   * How long the hold must last right now: the activity's own figure, scaled
   * by the rung. Anything that draws a hold progress cue must use this and not
   * `activity.holdMs`, or the ring will finish somewhere other than the hold.
   */
  const holdMsFor = useCallback(
    (current: Activity): number =>
      Math.max(1, Math.round(current.holdMs * relaxRef.current.holdScale)),
    [],
  );

  /** Start the clock on "still working on it?". Re-armed after every rung. */
  const armMissTimer = useCallback((): void => {
    later(() => {
      if (roundStateRef.current !== "prompt") return;
      registerMissRef.current("timeout");
    }, ASSIST_AFTER_MS);
  }, [later]);

  /**
   * Play a short performance: a pose per beat, a line on the beats that have
   * one, and `done` at the end. Every beat re-checks that the round is still
   * running, so a child who answers halfway through is never talked over by a
   * demonstration of the thing they just did.
   */
  const runDemo = useCallback(
    (beats: readonly DemoBeat[], startAfterMs: number, done: () => void): void => {
      let at = startAfterMs;
      for (const beat of beats) {
        const when = at;
        later(() => {
          if (phaseRef.current !== "playing" || roundStateRef.current !== "prompt") return;
          setEmote(beat.emote);
          // A pose cannot mean "red", so the colour game's demonstration is a
          // block of colour Chiku holds up. Set on every beat, not just the
          // ones that carry it, so the swatch cannot outlive its own beat.
          setDemoSwatch(beat.swatch ?? null);
          if (beat.key) say(beat.key, beat.values, beat.emote, beat.emote);
        }, when);
        at += beat.ms;
      }
      later(() => {
        setDemoSwatch(null);
        if (phaseRef.current !== "playing" || roundStateRef.current !== "prompt") return;
        done();
      }, at);
    },
    [later, say, setEmote],
  );

  /**
   * One miss — a timeout, a wrong tap, or a heard-but-wrong answer. They are
   * the same event on purpose: from the child's side all three are "I tried
   * and Chiku did not say yes", and treating a wrong tap as cheaper than a
   * timeout would leave the child who taps wrong three times exactly where
   * this whole change exists to rescue them from.
   */
  const registerMiss = useCallback((source: MissSource): void => {
    if (phaseRef.current !== "playing" || roundStateRef.current !== "prompt") return;
    const current = roundRef.current[indexRef.current];
    if (!current) return;

    // Cancels the miss timer and any demonstration still playing, so two rungs
    // can never run over the top of each other.
    clearTimers();

    // The first miss buys a free retry at the same rung (see assistAfterMiss):
    // a child who was merely slow should not be shown how before they have had
    // a second go, and it is what makes an unhelped-but-hard-won win possible.
    const level = assistAfterMiss(assistLevelRef.current, attemptsRef.current + 1);
    // THE ONE THING THE LADDER WILL NOT DO IS CARRY AN EMPTY ROOM. The bottom
    // rung ends in praise on its own, and a device left face-up on a sofa must
    // not be congratulated — nor nagged every eight seconds until the session
    // cap. A tap, a word, or a face in the camera is enough to believe someone
    // is there; with none of the three, Chiku holds this rung, asks once more
    // and then waits quietly. A child who comes back and touches anything is
    // straight back on the ladder, one rung further down.
    const present = source === "child" || attendingRef.current || interactedRef.current;
    if (level === "together" && !present) {
      setAssist(true);
      setNudge(true);
      setEmote("encouraging");
      say(current.retryKey, undefined, "encouraging", "listening");
      return;
    }

    attemptsRef.current += 1;
    assistLevelRef.current = level;
    setAssistLevel(level);
    applyAssist(level);
    // A fresh attempt starts from a clean hold; the relaxation above survives.
    holdRef.current.reset();

    // The tap answers appear on the first miss and stay. They are no longer
    // the escalation — they are not an easier question — but they are a real
    // door for a child who would rather point, and taking it away would be a
    // loss with nothing bought.
    setAssist(true);
    setNudge(true);
    setEmote("encouraging");

    if (level === "together") {
      // The bottom rung. Chiku invites, counts along, and the round SUCCEEDS —
      // doing a thing with help is how children learn to do it alone, and the
      // celebration for it is real, not a consolation.
      say(TOGETHER_KEY, undefined, "encouraging", "listening");
      const beats: readonly DemoBeat[] = [
        ...alongsideBeatsFor(current),
        { emote: "happy", ms: TOGETHER_SETTLE_MS },
      ];
      runDemo(beats, TOGETHER_LEAD_MS, () => succeedRef.current());
      return;
    }

    // "watch" and "easier" both open with the warm nudge, spoken now so it is
    // the first thing heard rather than queued behind a performance.
    say(current.retryKey, undefined, "encouraging", "listening");
    if (level === "watch") {
      // Show, then ask again — `demoBeatsFor` supplies the re-ask, and is just
      // the re-ask for an activity with no demonstration of its own.
      runDemo(demoBeatsFor(current), DEMO_LEAD_MS, armMissTimer);
      return;
    }
    // "easier": nothing to see. The bar moved and the child is not told.
    armMissTimer();
  }, [applyAssist, armMissTimer, clearTimers, runDemo, say, setEmote]);
  registerMissRef.current = registerMiss;

  // --- round flow ----------------------------------------------------------

  const beginPrompt = useCallback((): void => {
    holdRef.current.reset();
    roundStateRef.current = "prompt";
    setRoundState("prompt");
    setNudge(false);
    setNudgedId(null);
    // A new prompt is a new thing to be stuck on: the ladder starts at the top
    // and the detector goes back to strict.
    assistLevelRef.current = "none";
    setAssistLevel("none");
    attemptsRef.current = 0;
    setHoldProgress(0);
    setDemoSwatch(null);
    // Whatever the last window found belongs to the last prompt. Carrying it
    // over would hand the next hunt a finished answer before it was asked.
    windowCoverageRef.current = 0;
    applyAssist("none");
    // No camera → the tap answers ARE the game, so they are there immediately.
    setAssist(cameraModeRef.current !== "on");
    setEmote("listening");
    // Read the prompt out loud. A three-year-old cannot read "Show me 3
    // fingers!", so until now the text was decoration for them and the game
    // only worked if a grown-up was narrating.
    const opening = roundRef.current[indexRef.current];
    if (opening) say(opening.promptKey, opening.promptValues, "encouraging", "listening");
    // The hunt is the one prompt whose input device the child has to build
    // first, so it gets a second sentence — unless they have already built it.
    if (opening?.kind === "hunt" && cameraModeRef.current === "on") {
      later(() => {
        if (roundStateRef.current !== "prompt" || windowOpenRef.current) return;
        say("window.invite", undefined, "encouraging", "listening");
      }, WINDOW_INVITE_MS);
    }
    armMissTimer();
  }, [applyAssist, armMissTimer, later, say, setEmote]);

  const goGoodbye = useCallback((): void => {
    clearTimers();
    closeMic();
    // NOTE: the clock keeps running here. The goodbye screen is still the show
    // — "wave goodbye to Chiku" is an activity — and, more to the point, if it
    // paused then a child who lingered on it for half an hour would earn a
    // whole fresh twenty minutes by pressing "play again", which is the
    // unbounded loop this cap exists to close. Only a HIDDEN tab pauses it.
    phaseRef.current = "goodbye";
    setPhase("goodbye");
    setAttending(false);
    attendingRef.current = false;
    setEmote("goodbye");
    say(cappedRef.current ? "goodbye.capTitle" : "goodbye.title", undefined, "goodbye", "goodbye");
    // The camera light goes out the moment the game ends — visible privacy.
    engineRef.current?.stop();
    stageRef.current?.setAttention(true);
  }, [clearTimers, closeMic, say, setEmote]);

  /**
   * The cap (§9.5), reached. This ends the show — warmly, through the ordinary
   * goodbye, with the day's-play-is-over words instead of the see-you-soon
   * ones. Deliberately NOT a dialog, NOT a countdown, and NOT a "five more
   * minutes?" button: an end a child can negotiate with is not an end, and the
   * negotiating is the part that makes stopping hard.
   */
  const endForToday = useCallback((): void => {
    if (phaseRef.current === "goodbye" && cappedRef.current) return;
    cappedRef.current = true;
    setCapped(true);
    goGoodbye();
  }, [goGoodbye]);

  const advance = useCallback((): void => {
    // Checked between activities as well as on the tick, so a cap that fell due
    // mid-celebration lands at the natural seam rather than cutting the
    // celebration off.
    if (cappedRef.current || clockRef.current.expired(limitRef.current)) {
      endForToday();
      return;
    }
    const next = indexRef.current + 1;
    if (next >= roundRef.current.length) {
      goGoodbye();
      return;
    }
    indexRef.current = next;
    setIndex(next);
    beginPrompt();
  }, [beginPrompt, endForToday, goGoodbye]);

  const succeed = useCallback((): void => {
    if (roundStateRef.current !== "prompt" || phaseRef.current !== "playing") return;
    clearTimers();
    closeMic();
    holdRef.current.reset();
    roundStateRef.current = "praise";
    setRoundState("praise");
    setNudge(false);
    setNudgedId(null);
    setDemoSwatch(null);
    setStreak((s) => s + 1);
    // PRAISE IS CHOSEN BY EFFORT, NOT BY OUTCOME. It used to be a coin toss
    // between three interchangeable cheers, which meant the easiest win got
    // the loudest one — backwards, and the way software usually gets it wrong.
    // An instant win gets a light acknowledgement; the child who needed three
    // goes and Chiku's help gets the real celebration, and that celebration
    // names the effort rather than the child.
    const tone = praiseToneFor(assistLevelRef.current, attemptsRef.current);
    const bucket = PRAISE_BUCKETS[tone];
    const praise = bucket[randInt(random, 0, bucket.length - 1)] ?? "praise.one";
    setPraiseTone(tone);
    setPraiseKey(praise);
    setEmote("happy");
    stageRef.current?.blink();
    // Praise stays happy after the line ends — the celebration outlasts the
    // sentence, and this is also exactly what the silent surface does.
    say(praise, undefined, "happy", "happy");
    later(advance, PRAISE_MS);
  }, [advance, clearTimers, closeMic, later, random, say, setEmote]);
  succeedRef.current = succeed;

  const startPlaying = useCallback((): void => {
    clearTimers();
    // Idempotent: the first prompt of the visit starts the clock, every later
    // one resumes it if a hidden tab paused it.
    clockRef.current.start();
    setSessionProgress(clockRef.current.progress(limitRef.current));
    interactedRef.current = false;
    const next = buildRound(random);
    roundRef.current = next;
    setRound(next);
    indexRef.current = 0;
    setIndex(0);
    phaseRef.current = "playing";
    setPhase("playing");
    beginPrompt();
  }, [beginPrompt, clearTimers, random]);

  // --- vision --------------------------------------------------------------

  const handleFrame = useCallback(
    (frame: VisionFrame): void => {
      // 1. Presence first, unconditionally — Chiku looks at the child in every
      //    phase, including while a grown-up is reading the camera promise.
      //    The stage owns the attention gate and hands back its debounced
      //    answer; the teal caption and the ring below are bound to that same
      //    value, so they cannot disagree with where Chiku's eyes are.
      const seen = stageRef.current?.applyFrame(frame) ?? false;
      if (seen !== attendingRef.current) {
        attendingRef.current = seen;
        setAttending(seen);
      }

      // 1b. The window, AFTER applyFrame — which is the call that painted it,
      //     and therefore the call that produced this frame's coverage number.
      //     Chiku's eyes are already on it: CameraStage points the gaze at the
      //     quad's centre whenever one is solid enough, so he is visibly
      //     looking through it with the child rather than at their nose.
      const quad = frame.quad ?? null;
      const open = quad !== null && quad.presence >= HUNT_PRESENCE;
      if (open !== windowOpenRef.current) {
        windowOpenRef.current = open;
        setWindowOpen(open);
      }
      // No window, nothing measured. The lens stops REPORTING when the window
      // vanishes rather than reporting a zero, so without this the last figure
      // would sit in the ref and greet the next window as an instant find.
      if (quad === null) windowCoverageRef.current = 0;

      // 2. Then the game.
      if (phaseRef.current !== "playing" || roundStateRef.current !== "prompt") return;
      const activity = roundRef.current[indexRef.current];
      if (!activity) return;
      // The render layer's answer, merged in before any activity sees the
      // frame, so the Activity contract stays "one predicate over one frame".
      const scored: VisionFrame = { ...frame, windowCoverage: windowCoverageRef.current };
      // Tri-state: a frame that could not answer the question is "unknown" and
      // costs the child nothing. See activities/hold.ts. The hold length is the
      // activity's, scaled by whatever rung of the ladder we are on.
      const holdMs = holdMsFor(activity);
      if (holdRef.current.update(verdictFor(activity, scored), scored.t, holdMs)) {
        setHoldProgress(0);
        succeed();
        return;
      }
      // Chiku visibly counting. Without this the child holds three fingers up,
      // sees nothing happen, and gets nudged as though they had done nothing —
      // `progress()` existed for this cue and nothing had ever called it.
      // holdMsFor, not activity.holdMs: on a relaxed rung the ring must finish
      // when the hold actually completes, not later.
      const p = holdRef.current.progress(frame.t, holdMs);
      setHoldProgress(Math.round(p * 50) / 50);
    },
    [holdMsFor, succeed],
  );

  // Latest-handler refs: the engine subscription is set up exactly once, but
  // must always call the current handler.
  const frameHandlerRef = useRef(handleFrame);
  frameHandlerRef.current = handleFrame;

  // --- the spoken answer ---------------------------------------------------

  /**
   * A third way to answer, equal to the other two.
   *
   * INTERIM RESULTS ARE NOT ANSWERS. Recognisers emit a running guess that
   * flickers through wrong words on its way to the right one — "free", "tree",
   * "three" — and acting on those would mean Chiku congratulating a child
   * mid-syllable, or worse, celebrating a word they never said. Only `isFinal`
   * counts. Confidence is deliberately not gated on: several platforms report
   * a flat 0 for it, and a child's voice scores badly on all of them.
   */
  const handleHeard = useCallback(
    (result: HeardResult): void => {
      if (!result.isFinal) return;
      if (phaseRef.current !== "playing" || roundStateRef.current !== "prompt") return;
      const activity = roundRef.current[indexRef.current];
      if (!activity) return;
      // Somebody said something. Whatever it was, there is a child here.
      interactedRef.current = true;
      if (activity.accepts(result.text)) {
        succeed();
        return;
      }
      // Heard something, but not the answer — one rung down, same as a timeout
      // or a wrong tap. A child who is being misheard is a child who is
      // trying, and the ladder is what turns trying into succeeding.
      //
      // Spoken lines are held while the button is still down; `say` queues the
      // newest and speaks it the moment the mic closes. The written nudge is
      // on screen either way.
      registerMiss("child");
    },
    [registerMiss, succeed],
  );

  const heardHandlerRef = useRef(handleHeard);
  heardHandlerRef.current = handleHeard;

  const openMic = useCallback((): void => {
    const listener = listenerRef.current;
    if (!listener?.available) return;
    // Never open a mic the probe did not clear (local, or parent-accepted cloud).
    if (micAllowedRef.current === false) {
      setMicMode("off");
      return;
    }
    // BARGE-IN. A person stops mid-sentence when the child they are talking to
    // starts; a character that keeps going is a recording. This also stops the
    // synthesiser feeding its own voice into the microphone.
    hush();
    setEmote("listening");
    try {
      listener.start(langRef.current);
    } catch {
      // start() can throw on a second call or a revoked permission. A control
      // that does nothing when pressed is worse than no control at all, so the
      // button goes away and the honest line takes its place.
      setMicMode("off");
      markListening(false);
      return;
    }
    markListening(true);
  }, [hush, markListening, setEmote]);

  /**
   * Frame watchdog. A camera can report "ready" and then deliver nothing —
   * permission blocked at a layer above the page, a device grabbed by another
   * app, a stream that dies mid-session. Without this the child just waits
   * while Chiku claims to be looking for them. If no frame lands within
   * WATCHDOG_MS of the camera going on, we stop pretending and offer tapping.
   */
  const sawFrameRef = useRef(false);
  useEffect(() => {
    if (cameraMode !== "on") return;
    sawFrameRef.current = false;
    const WATCHDOG_MS = 5000;
    const timer = window.setTimeout(() => {
      if (!mountedRef.current || sawFrameRef.current) return;
      cameraModeRef.current = "off";
      setCameraMode("off");
      attendingRef.current = false;
      setAttending(false);
      if (phaseRef.current === "playing") setAssist(true);
    }, WATCHDOG_MS);
    return () => window.clearTimeout(timer);
  }, [cameraMode]);

  useEffect(() => {
    mountedRef.current = true;
    const engine = createVisionEngine();
    engineRef.current = engine;
    const offFrame = engine.onFrame((frame) => {
      sawFrameRef.current = true;
      frameHandlerRef.current(frame);
    });
    const offStatus = engine.onStatus((next) => {
      if (!mountedRef.current) return;
      setStatus(next);
      if (next === "denied" || next === "unavailable" || next === "error") {
        cameraModeRef.current = "off";
        setCameraMode("off");
        attendingRef.current = false;
        setAttending(false);
        // Losing the camera mid-round must not strand the child.
        if (phaseRef.current === "playing") setAssist(true);
      }
    });
    return () => {
      mountedRef.current = false;
      offFrame();
      offStatus();
      engine.dispose();
      engineRef.current = null;
      for (const id of timersRef.current) globalThis.clearTimeout(id);
      timersRef.current = [];
    };
  }, []);

  /**
   * Voice, set up once and torn down hard.
   *
   * Both halves are optional platform features, so this effect's real job is
   * deciding what the surface admits to: `micMode` goes "ready" or "off" here
   * and never sits at "unknown" past the first commit, which is what keeps the
   * honest line from flashing on a device that does have ears.
   */
  // Re-runs when the parent flips cloud ears: the listener is rebuilt with the
  // new permission model. The greeting below is guarded so it plays once.
  const greetedRef = useRef(false);
  useEffect(() => {
    const speaker = createSpeaker();
    const listener = createListener({ allowCloudRecognition: cloudEars });
    speakerRef.current = speaker;
    listenerRef.current = listener;
    micAllowedRef.current = null; // unknown again until the probe answers
    setMicMode(listener.available ? "ready" : "off");

    /**
     * Probe whether speech can be recognised WITHOUT leaving the device.
     * Chrome defaults to server-side recognition, which would break §9.1
     * silently, so a mic we cannot keep local is a mic we do not offer.
     *
     * This used to be its own effect keyed on `phase`, which meant it did not
     * run until the child left the welcome screen — the listener does not
     * exist yet on the pass where that effect first fires. The consequence was
     * that a grown-up opening the settings sheet before play started saw no
     * cloud-ears offer at all on a platform that has no local speech. It
     * belongs here, where the listener it probes is created.
     */
    let probeAlive = true;
    if (listener.available) {
      void listener.ensureOnDevice(langRef.current).then((allowed) => {
        if (!probeAlive || !mountedRef.current) return;
        micAllowedRef.current = allowed;
        // True when recognition is local, OR when a grown-up deliberately
        // accepted cloud ears (the listener was built with that flag). False
        // means neither — the mic stays shut and the surface says so.
        setMicMode(allowed ? "ready" : "off");
      });
    }

    const offResult = listener.onResult((result) => {
      if (!mountedRef.current) return;
      heardHandlerRef.current(result);
    });
    // Both of these go through `markListening`, not through the two setters,
    // so a mic that closes on its own — a recogniser timing out, a permission
    // withdrawn — releases the line Chiku was holding back exactly as a
    // released button does. This is the common case, not the exotic one: the
    // platform ends the session by itself all the time.
    const offError = listener.onError((message) => {
      if (!mountedRef.current) return;
      markListeningRef.current(false);
      // Only a real refusal removes the button; `no-speech` is just silence,
      // and deleting the control under a child who paused would be a lie.
      if (isMicUnusable(message)) setMicMode("off");
    });
    const offEnd = listener.onEnd(() => {
      if (!mountedRef.current) return;
      markListeningRef.current(false);
    });

    // Chiku says hello the moment he is on screen, so the very first thing a
    // child who cannot read gets is a voice rather than a wall of letters.
    // Once only — a parent flipping cloud ears must not restart the hello.
    if (!greetedRef.current) {
      greetedRef.current = true;
      sayRef.current("welcome.greeting", undefined, "encouraging", "idle");
    }

    return () => {
      probeAlive = false;
      offResult();
      offError();
      offEnd();
      listener.stop();
      listener.dispose();
      listeningRef.current = false;
      speaker.cancelAll();
      speaker.dispose();
      listenerRef.current = null;
      speakerRef.current = null;
      speakHandleRef.current = null;
    };
  }, [cloudEars]);

  // --- entry points --------------------------------------------------------

  const begin = useCallback((): void => {
    phaseRef.current = "camera-ask";
    setPhase("camera-ask");
    setEmote("encouraging");
    // Asked out loud as well as written. This is also the first line that is
    // guaranteed to follow a tap, which is what unlocks speech synthesis on
    // the mobile browsers that gate it behind a user gesture — the greeting on
    // mount may or may not have been allowed to play.
    say("camera.title", undefined, "encouraging", "encouraging");
  }, [say, setEmote]);

  const playWithoutCamera = useCallback((): void => {
    // Abandon any warm-up in flight: this child is not using the camera today
    // and does not owe the network 20MB for it.
    warmAbortRef.current?.abort();
    warmAbortRef.current = null;
    cameraModeRef.current = "off";
    setCameraMode("off");
    startPlaying();
  }, [startPlaying]);

  const openEyes = useCallback(async (): Promise<void> => {
    const engine = engineRef.current;
    const video = stageRef.current?.video() ?? null;
    if (!engine || !video) {
      playWithoutCamera();
      return;
    }
    setBusy(true);
    try {
      await engine.start(video);
      if (!mountedRef.current) return;
      // start() reports failure as a status rather than throwing, so a resolved
      // promise is NOT proof of a camera. Trusting it left a child staring at
      // "Chiku is looking for you…" forever when permission was blocked.
      const live = engine.status === "ready";
      cameraModeRef.current = live ? "on" : "off";
      setCameraMode(live ? "on" : "off");
    } catch {
      if (!mountedRef.current) return;
      cameraModeRef.current = "off";
      setCameraMode("off");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
    if (mountedRef.current) startPlaying();
  }, [playWithoutCamera, startPlaying]);

  /**
   * MODELS FIRST, CAMERA SECOND.
   *
   * The engine used to take the camera and *then* pull ~20MB of WASM and model
   * bundles. On a mid-range Indian 4G connection that is a minute or more of a
   * lit camera light above an empty preview, with only a button label to say
   * anything is happening — which is precisely the trust the camera promise on
   * this screen is trying to buy, spent. And when the fetch failed there was no
   * way back at all except reloading the page.
   *
   * So this warms the bytes with the camera DARK, shows Chiku thinking while it
   * happens, and only then calls openEyes(). A failure lands on a retry, and
   * "play without the camera" stays live throughout — including during the
   * warm-up, which is the moment a bored child most needs it.
   */
  const warmThenOpenEyes = useCallback(async (): Promise<void> => {
    if (warmStateRef.current === "warming") return;
    warmAbortRef.current?.abort();
    const controller = new AbortController();
    warmAbortRef.current = controller;

    warmStateRef.current = "warming";
    setWarmState("warming");
    setEmote("thinking");
    say("warm.title", undefined, "thinking", "thinking");

    const engine: MaybeWarmEngine | null = engineRef.current;
    try {
      // Prefer a real engine warm-up if one has landed; otherwise pull the same
      // URLs through fetch so the engine's own load resolves from cache.
      if (typeof engine?.warm === "function") await engine.warm();
      else await warmVision({ signal: controller.signal });
    } catch {
      if (!mountedRef.current || controller.signal.aborted) return;
      warmStateRef.current = "failed";
      setWarmState("failed");
      setEmote("encouraging");
      say("warm.failed", undefined, "encouraging", "encouraging");
      return;
    }
    if (!mountedRef.current || controller.signal.aborted) return;
    warmAbortRef.current = null;
    warmStateRef.current = "ready";
    setWarmState("ready");
    await openEyes();
  }, [openEyes, say, setEmote]);

  const playAgain = useCallback(async (): Promise<void> => {
    // The cap outranks the button. Reaching this with an expired clock means
    // the clock ran out while the child sat on the goodbye screen; ending for
    // today is the honest answer, and the button disappears with it.
    if (cappedRef.current || clockRef.current.expired(limitRef.current)) {
      endForToday();
      return;
    }
    setStreak(0);
    if (cameraModeRef.current === "on") {
      const engine = engineRef.current;
      const video = stageRef.current?.video() ?? null;
      if (engine && video) {
        try {
          await engine.start(video);
        } catch {
          cameraModeRef.current = "off";
          if (mountedRef.current) setCameraMode("off");
        }
      } else {
        cameraModeRef.current = "off";
        if (mountedRef.current) setCameraMode("off");
      }
    }
    if (mountedRef.current) startPlaying();
  }, [endForToday, startPlaying]);

  // --- the session cap, on a clock -----------------------------------------

  /**
   * One coarse tick while playing: it advances the sun-to-moon arc and it is
   * what actually enforces §9.5. Five seconds is deliberate — the arc moves
   * about half a degree per tick at a 20-minute cap, so it reads as information
   * rather than as a countdown ticking down at a child.
   *
   * The cap is not applied mid-celebration: if it falls due during praise the
   * flag is set and `advance()` carries us out a moment later, so the last
   * thing that happens is still "Yes! You did it!" and not a screen change.
   */
  useEffect(() => {
    if (phase !== "playing") return;
    const clock = clockRef.current;
    const tick = (): void => {
      if (!mountedRef.current) return;
      setSessionProgress(clock.progress(limitRef.current));
      if (!clock.expired(limitRef.current)) return;
      cappedRef.current = true;
      if (roundStateRef.current !== "praise") endForToday();
    };
    tick();
    const id = globalThis.setInterval(tick, SESSION_TICK_MS);
    return () => globalThis.clearInterval(id);
  }, [endForToday, limitMin, phase]);

  /**
   * A backgrounded tab is not play time. Ten minutes of a parent's phone call
   * must not spend the child's twenty.
   *
   * THE CAMERA AND THE MICROPHONE ARE NOT THIS EFFECT'S BUSINESS. The engine
   * wires its own `visibilitychange` (it owns the stream, so it is the only
   * thing that can honestly release it) and so does the listener. Duplicating
   * that here would mean two owners for one piece of hardware. `suspend()` and
   * `resume()` are still feature-detected and called for the paused-by-us
   * case only — Chiku's VOICE, which nothing else watches, is silenced here.
   */
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        clockRef.current.pause();
        // Speech synthesis keeps talking to an empty room otherwise.
        hush();
        closeMic();
        return;
      }
      if (phaseRef.current === "playing") clockRef.current.start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [closeMic, hush]);

  /** Abort a warm-up that outlives the surface. */
  useEffect(
    () => () => {
      warmAbortRef.current?.abort();
      warmAbortRef.current = null;
    },
    [],
  );

  const pickChoice = useCallback(
    (choice: ActivityChoice): void => {
      if (roundStateRef.current !== "prompt") return;
      // A finger on the glass is a child in the room.
      interactedRef.current = true;
      if (choice.correct) {
        succeed();
        return;
      }
      // Wrong tap: a wobble, and one rung down the ladder. Nothing red,
      // nothing lost, and — unlike before — something that actually changes,
      // so the fourth wrong tap is not the same experience as the first.
      registerMiss("child");
      setNudgedId(choice.id);
      later(() => setNudgedId(null), 700);
    },
    [later, registerMiss, succeed],
  );

  // --- render --------------------------------------------------------------

  const activity: Activity | undefined = round[index];
  const cameraOn = cameraMode === "on";
  const cameraRefused = status === "denied" || status === "unavailable" || status === "error";

  /**
   * What the magic window shows.
   *
   * During the colour hunt it is the LENS: the window drains everything that is
   * not the target colour, which is both the effect and the measurement.
   *
   * The rest of the time it is a STICKER, and that is a deliberate choice
   * rather than a leftover. Three reasons. It makes Chiku's eyes honest — the
   * gaze override in CameraStage fires on any quad, so with no window drawn he
   * would be visibly staring at nothing. It teaches the gesture before the game
   * needs it: a child who discovers the star while waving already knows how to
   * make a window when "find something red!" arrives, which is the difference
   * between a hunt that starts and one that stalls on the invitation. And it
   * costs nothing — sticker mode reads no pixels at all (no getImageData, no
   * lens pass), so it is a clip and a star per frame.
   *
   * It is marigold, never teal (§9).
   */
  const windowMode: MagicWindowMode = activity?.kind === "hunt" ? "lens" : "sticker";
  /** Only the hunt names a colour; the lens ignores it in any other mode. */
  const huntColour: HuntColour | undefined = activity?.huntColour;
  /** The hunt is up, the camera is on, and no window has been made yet. */
  const inviteWindow = activity?.kind === "hunt" && cameraOn && !windowOpen;

  return (
    <main className="live" data-phase={phase} data-camera={cameraMode} data-assist={assistLevel}>
      <CameraStage
        ref={stageRef}
        cameraOn={cameraOn}
        attending={attending}
        reducedMotion={reducedMotion}
        videoLabel={tIn(lang, "stage.videoLabel")}
        rigFactory={rigFactory}
        windowMode={windowMode}
        huntColour={huntColour}
        onWindowCoverage={takeWindowCoverage}
      >
        {cameraOn && (
          // Teal, on the FRAME rather than on Chiku: the live rig wears no UI.
          <p className={`stage-cue${attending ? " is-live" : ""}`}>
            <Bilingual k={attending ? "stage.seesYou" : "stage.lookingForYou"} inline />
          </p>
        )}
        {/* Marigold, never teal — teal means "Chiku is hearing you" and this is
            him counting. Renders null at zero, so no guard is needed here. */}
        <HoldRing progress={holdProgress} label={tIn(lang, "hold.counting")} />
      </CameraStage>

      {/* One prompt at a time, announced: a child with a screen reader gets the
          same turn-taking a sighted child gets from the big text changing. */}
      <section className="panel" aria-live="polite">
        {phase === "welcome" && (
          <>
            <h1 className="live-greeting">
              <Bilingual k="welcome.greeting" />
            </h1>
            <BigButton k="welcome.begin" onClick={begin} />
          </>
        )}

        {phase === "camera-ask" && warmState === "warming" && (
          /* The camera is DARK for the whole of this screen. That is the entire
             point of it, and the kid line says so out loud so a grown-up
             walking past can check the promise against the hardware. No
             percentage and no spinner: a number a child cannot read is stress,
             and on a stalled connection a stuck number is worse than none. */
          <>
            <h1 className="live-greeting">
              <Bilingual k="warm.title" />
            </h1>
            <p className="live-kidline">
              <Bilingual k="warm.kidLine" />
            </p>
            <p className="warm-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </p>
            {/* Never disabled. A child who has waited long enough must always
                be able to leave for the game that needs no download. */}
            <button type="button" className="live-quiet" onClick={playWithoutCamera}>
              <Bilingual k="camera.skip" inline />
            </button>
            <p className="live-promise">
              <Bilingual k="warm.grownup" />
            </p>
          </>
        )}

        {phase === "camera-ask" && warmState === "failed" && (
          /* A failed download used to be a dead end whose only exit was
             reloading the page. Now it is two doors, and both of them work. */
          <>
            <h1 className="live-greeting">
              <Bilingual k="warm.failedTitle" />
            </h1>
            <p className="live-kidline">
              <Bilingual k="warm.failed" />
            </p>
            <BigButton k="warm.retry" onClick={() => void warmThenOpenEyes()} />
            <button type="button" className="live-quiet" onClick={playWithoutCamera}>
              <Bilingual k="camera.skip" inline />
            </button>
            <p className="live-promise">
              <Bilingual k="warm.failedGrownup" />
            </p>
          </>
        )}

        {phase === "camera-ask" && warmState !== "warming" && warmState !== "failed" && (
          <>
            <h1 className="live-greeting">
              <Bilingual k="camera.title" />
            </h1>
            <p className="live-kidline">
              <Bilingual k="camera.kidLine" />
            </p>
            <BigButton
              k={busy ? "camera.loading" : "camera.allow"}
              onClick={() => void warmThenOpenEyes()}
              disabled={busy}
            />
            <button type="button" className="live-quiet" onClick={playWithoutCamera} disabled={busy}>
              <Bilingual k="camera.skip" inline />
            </button>
            {/* The grown-up promise. Plain, checkable, and true by construction. */}
            <p className="live-promise">
              <Bilingual k="camera.promise" />
            </p>
            {/* The cloud-ears consent is NOT here any more. It used to be — on
                the one screen the child is alone on every session, behind a 2s
                hold a six-year-old beats. It now lives in the grown-up sheet
                behind the corner control and a 5s hold. */}
          </>
        )}

        {phase === "playing" && activity && (
          <>
            {roundState === "praise" ? (
              <p className="live-praise" role="status" data-praise-tone={praiseTone}>
                <Bilingual k={praiseKey} />
              </p>
            ) : (
              <>
                <h1 className="live-prompt">
                  <Bilingual k={activity.promptKey} values={activity.promptValues} />
                </h1>
                {/* Chiku holding the colour up on the "watch me" rung. Not a
                    control — it is the thing being imitated. */}
                {demoSwatch !== null && (
                  <div
                    className="demo-swatch"
                    data-colour={demoSwatch}
                    data-testid="demo-swatch"
                    aria-hidden="true"
                  />
                )}
                {/* Make the input device first. Only while there is a camera
                    and no window: with the camera off the hunt is a tap game
                    like every other activity, and asking for hands there would
                    be an instruction the child cannot follow. */}
                {inviteWindow && (
                  <p className="live-note">
                    <Bilingual k="window.invite" inline />
                  </p>
                )}
                {nudge && (
                  <p className="live-retry">
                    <Bilingual k={activity.retryKey} inline />
                  </p>
                )}
                {!cameraOn && (
                  <p className="live-note">
                    <Bilingual k={cameraRefused ? "camera.blocked" : "camera.offNote"} inline />
                  </p>
                )}
                {/* The third answer path. Rendered only when there is a real
                    microphone behind it — an inert talk button teaches a child
                    that Chiku ignores them, which is the exact opposite of the
                    thing this surface is for. */}
                {micMode === "ready" && (
                  <>
                    <TalkButton listening={listening} onPress={openMic} onRelease={closeMic} />
                    {/* Honesty tag: these ears are only possible via the
                        internet on this platform, and the UI says so wherever
                        they appear — not just on the consent screen. */}
                    {cloudEars && (
                      <p className="live-note cloud-note">
                        <Bilingual k="cloud.note" inline />
                      </p>
                    )}
                  </>
                )}
                {micMode === "off" && (
                  <p className="live-note">
                    <Bilingual k="talk.noEars" inline />
                  </p>
                )}
                {assist && (
                  <>
                    <p className="live-taphint">
                      <Bilingual k={activity.tapHintKey} inline />
                    </p>
                    <div className="choices" data-activity={activity.kind}>
                      {activity.choices.map((choice) => (
                        <ChoiceButton
                          key={choice.id}
                          choice={choice}
                          onPick={pickChoice}
                          nudged={nudgedId === choice.id}
                          disabled={false}
                        />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            <div className="live-footer">
              <StreakStars count={streak} total={round.length} />
              {/* Sun to moon: where we are in today's play time, readable at a
                  glance by someone who cannot read a clock. */}
              <SunArc progress={sessionProgress} label={tIn(lang, "session.arcLabel")} />
            </div>
          </>
        )}

        {phase === "goodbye" && (
          <>
            <h1 className="live-greeting">
              <Bilingual k={capped ? "goodbye.capTitle" : "goodbye.title"} />
            </h1>
            <p className="live-kidline">
              <Bilingual k={capped ? "goodbye.capLine" : "goodbye.wave"} inline />
            </p>
            <StreakStars count={streak} total={round.length} />
            {/* Past the cap the button is GONE, not disabled and not replaced
                with a "just five more minutes?" prompt (§9.5). A control that
                refuses is something to push against; an absent one is just the
                end of the show. */}
            {!capped && <BigButton k="goodbye.again" onClick={() => void playAgain()} />}
          </>
        )}
      </section>

      {/* --- the grown-up door ---------------------------------------------
          Small, cornered, and gated by patience rather than by a secret. It is
          the only route to the cloud-recognition consent and the session cap,
          both of which are decisions a child must not be able to make while
          alone with the device — which is every session. */}
      <div className="grownup-corner">
        <HoldButton
          className="hold-corner"
          holdMs={GROWNUP_OPEN_HOLD_MS}
          label={`${tIn(lang, "grownup.open")} · ${tIn(other, "grownup.open")}`}
          onHeld={() => setSheetOpen(true)}
        />
      </div>

      {sheetOpen && (
        <GrownUpSheet
          onClose={() => setSheetOpen(false)}
          cloudEars={cloudEars}
          /* Only offered where it buys something: a browser with local speech
             already has ears, and nobody should be talked into sending a
             child's voice away for a capability they already have. */
          showCloudEars={micMode === "off" || cloudEars}
          onToggleCloudEars={() => {
            const next = !cloudEars;
            setCloudEars(next);
            setCloudEarsState(next);
          }}
          limitMin={limitMin}
          onLimitChange={(next) => {
            setLimitMinutes(next);
            setLimitMin(getLimitMinutes());
          }}
        />
      )}
    </main>
  );
}
