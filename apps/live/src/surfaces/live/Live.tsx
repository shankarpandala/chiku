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
import { ChoiceButton } from "../../components/ChoiceButton";
import { StreakStars } from "../../components/StreakStars";
import { TalkButton } from "../../components/TalkButton";
import { useReducedMotion } from "../../components/useReducedMotion";
import { translate, useI18n, type I18nKey, type Lang, type Values } from "../../i18n";
import { buildRound, HoldTracker, type Activity, type ActivityChoice } from "../../activities";
import { randInt, verdictFor } from "../../activities/types";
import { createVisionEngine } from "../../vision/engine";
import type { VisionEngine, VisionFrame, VisionStatus } from "../../vision/types";
import { createListener, createSpeaker, isMicUnusable } from "../../voice";
import { getCloudEars, setCloudEars } from "../../settings/cloudEars";
import { GROWNUP_OPEN_HOLD_MS, HoldButton } from "../../components/HoldButton";
import { GrownUpSheet } from "../../components/GrownUpSheet";
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

/** How long the praise stays up before the next prompt. */
const PRAISE_MS = 2200;
/** How long a child may work on a prompt before Chiku offers the tap answer. */
const ASSIST_AFTER_MS = 8000;

const PRAISES: readonly I18nKey[] = ["praise.one", "praise.two", "praise.three"];

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
  /** Tap answers are on screen (always, with no camera; after a while, with one). */
  const [assist, setAssist] = useState(false);
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

  // --- voice ---------------------------------------------------------------

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
   * straight back as a wrong answer, and prompt another line, and loop. Every
   * caller that legitimately speaks after a turn (praise, goodbye) closes the
   * mic first; anything left suppressed here is Chiku correctly waiting his
   * turn, and its text is on screen regardless.
   */
  const say = useCallback(
    (key: I18nKey, values: Values | undefined, speaking: Emote, rest: Emote): void => {
      const speaker: MaybeVoicedSpeaker | null = speakerRef.current;
      if (!speaker?.available || listeningRef.current) return;
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

  /** The one writer of "is the mic open" — ref first, so callbacks agree. */
  const markListening = useCallback((on: boolean): void => {
    listeningRef.current = on;
    setListening(on);
  }, []);

  /**
   * Close the mic. Idempotent, and called from more directions than there are
   * ways to release a button: release, cancel, blur, a correct answer, the end
   * of the round, unmount.
   */
  const closeMic = useCallback((): void => {
    listenerRef.current?.stop();
    markListening(false);
  }, [markListening]);

  // --- round flow ----------------------------------------------------------

  const beginPrompt = useCallback((): void => {
    holdRef.current.reset();
    roundStateRef.current = "prompt";
    setRoundState("prompt");
    setNudge(false);
    setNudgedId(null);
    // No camera → the tap answers ARE the game, so they are there immediately.
    setAssist(cameraModeRef.current !== "on");
    setEmote("listening");
    // Read the prompt out loud. A three-year-old cannot read "Show me 3
    // fingers!", so until now the text was decoration for them and the game
    // only worked if a grown-up was narrating.
    const opening = roundRef.current[indexRef.current];
    if (opening) say(opening.promptKey, opening.promptValues, "encouraging", "listening");
    later(() => {
      // Still working on it? Offer the other way in, warmly.
      if (roundStateRef.current !== "prompt") return;
      setAssist(true);
      setNudge(true);
      setEmote("encouraging");
      const current = roundRef.current[indexRef.current];
      if (current) say(current.retryKey, undefined, "encouraging", "listening");
    }, ASSIST_AFTER_MS);
  }, [later, say, setEmote]);

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
    setStreak((s) => s + 1);
    const praise = PRAISES[randInt(random, 0, PRAISES.length - 1)] ?? "praise.one";
    setPraiseKey(praise);
    setEmote("happy");
    stageRef.current?.blink();
    // Praise stays happy after the line ends — the celebration outlasts the
    // sentence, and this is also exactly what the silent surface does.
    say(praise, undefined, "happy", "happy");
    later(advance, PRAISE_MS);
  }, [advance, clearTimers, closeMic, later, random, say, setEmote]);

  const startPlaying = useCallback((): void => {
    clearTimers();
    // Idempotent: the first prompt of the visit starts the clock, every later
    // one resumes it if a hidden tab paused it.
    clockRef.current.start();
    setSessionProgress(clockRef.current.progress(limitRef.current));
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

      // 2. Then the game.
      if (phaseRef.current !== "playing" || roundStateRef.current !== "prompt") return;
      const activity = roundRef.current[indexRef.current];
      if (!activity) return;
      // Tri-state: a frame that could not answer the question is "unknown" and
      // costs the child nothing. See activities/hold.ts.
      if (holdRef.current.update(verdictFor(activity, frame), frame.t, activity.holdMs)) succeed();
    },
    [succeed],
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
      if (activity.accepts(result.text)) {
        succeed();
        return;
      }
      // Heard something, but not the answer. Same warm nudge a wrong tap gets,
      // plus the tap answers, because a child who is being misheard needs a
      // door that does not depend on being heard.
      setNudge(true);
      setAssist(true);
      setEmote("encouraging");
      // Spoken only if the child has already let go — `say` will not talk into
      // an open mic. The written nudge is there either way.
      say(activity.retryKey, undefined, "encouraging", "listening");
    },
    [say, setEmote, succeed],
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
    const offError = listener.onError((message) => {
      if (!mountedRef.current) return;
      listeningRef.current = false;
      setListening(false);
      // Only a real refusal removes the button; `no-speech` is just silence,
      // and deleting the control under a child who paused would be a lie.
      if (isMicUnusable(message)) setMicMode("off");
    });
    const offEnd = listener.onEnd(() => {
      if (!mountedRef.current) return;
      listeningRef.current = false;
      setListening(false);
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
      if (choice.correct) {
        succeed();
        return;
      }
      // Wrong tap: a wobble and the retry line. Nothing red, nothing lost.
      setNudgedId(choice.id);
      setNudge(true);
      setEmote("encouraging");
      const activity = roundRef.current[indexRef.current];
      if (activity) say(activity.retryKey, undefined, "encouraging", "listening");
      later(() => setNudgedId(null), 700);
    },
    [later, say, setEmote, succeed],
  );

  // --- render --------------------------------------------------------------

  const activity: Activity | undefined = round[index];
  const cameraOn = cameraMode === "on";
  const cameraRefused = status === "denied" || status === "unavailable" || status === "error";

  return (
    <main className="live" data-phase={phase} data-camera={cameraMode}>
      <CameraStage
        ref={stageRef}
        cameraOn={cameraOn}
        attending={attending}
        reducedMotion={reducedMotion}
        videoLabel={tIn(lang, "stage.videoLabel")}
        rigFactory={rigFactory}
      >
        {cameraOn && (
          // Teal, on the FRAME rather than on Chiku: the live rig wears no UI.
          <p className={`stage-cue${attending ? " is-live" : ""}`}>
            <Bilingual k={attending ? "stage.seesYou" : "stage.lookingForYou"} inline />
          </p>
        )}
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
              <p className="live-praise" role="status">
                <Bilingual k={praiseKey} />
              </p>
            ) : (
              <>
                <h1 className="live-prompt">
                  <Bilingual k={activity.promptKey} values={activity.promptValues} />
                </h1>
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
