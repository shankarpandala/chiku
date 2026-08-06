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
import { CameraStage, ATTENTION_THRESHOLD, type CameraStageHandle, type RigFactory } from "../../components/CameraStage";
import { ChoiceButton } from "../../components/ChoiceButton";
import { StreakStars } from "../../components/StreakStars";
import { TalkButton } from "../../components/TalkButton";
import { useReducedMotion } from "../../components/useReducedMotion";
import { translate, useI18n, type I18nKey, type Lang, type Values } from "../../i18n";
import { buildRound, HoldTracker, type Activity, type ActivityChoice } from "../../activities";
import { randInt } from "../../activities/types";
import { createVisionEngine } from "../../vision/engine";
import type { VisionEngine, VisionFrame, VisionStatus } from "../../vision/types";
import { createListener, createSpeaker, isMicUnusable } from "../../voice";
import type { HeardResult, Listener, SpeakHandle, Speaker } from "../../voice/types";

export type Phase = "welcome" | "camera-ask" | "playing" | "goodbye";
export type CameraMode = "unknown" | "on" | "off";
/** "unknown" until the platform has been asked — never flash the honest line. */
export type MicMode = "unknown" | "ready" | "off";
type RoundState = "prompt" | "praise";

/** How long the praise stays up before the next prompt. */
const PRAISE_MS = 2200;
/** How long a child may work on a prompt before Chiku offers the tap answer. */
const ASSIST_AFTER_MS = 8000;

const PRAISES: readonly I18nKey[] = ["praise.one", "praise.two", "praise.three"];

export interface LiveProps {
  /** Test seam — defaults to the real live rig. */
  rigFactory?: RigFactory;
  /** Test seam — drives target and order randomisation. */
  random?: () => number;
}

export function Live({ rigFactory, random = Math.random }: LiveProps) {
  const { lang, tIn } = useI18n();
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

  const [phase, setPhase] = useState<Phase>("welcome");
  const [cameraMode, setCameraMode] = useState<CameraMode>("unknown");
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
      const speaker = speakerRef.current;
      if (!speaker?.available || listeningRef.current) return;
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
    phaseRef.current = "goodbye";
    setPhase("goodbye");
    setAttending(false);
    attendingRef.current = false;
    setEmote("goodbye");
    say("goodbye.title", undefined, "goodbye", "goodbye");
    // The camera light goes out the moment the game ends — visible privacy.
    engineRef.current?.stop();
    stageRef.current?.setAttention(true);
  }, [clearTimers, closeMic, say, setEmote]);

  const advance = useCallback((): void => {
    const next = indexRef.current + 1;
    if (next >= roundRef.current.length) {
      goGoodbye();
      return;
    }
    indexRef.current = next;
    setIndex(next);
    beginPrompt();
  }, [beginPrompt, goGoodbye]);

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
      stageRef.current?.applyFrame(frame);

      const seen = frame.face !== null && frame.face.attention >= ATTENTION_THRESHOLD;
      if (seen !== attendingRef.current) {
        attendingRef.current = seen;
        setAttending(seen);
      }

      // 2. Then the game.
      if (phaseRef.current !== "playing" || roundStateRef.current !== "prompt") return;
      const activity = roundRef.current[indexRef.current];
      if (!activity) return;
      if (holdRef.current.update(activity.matches(frame), frame.t, activity.holdMs)) succeed();
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

  /** Hold began: Chiku stops talking and opens the mic, in that order. */
  /**
   * Probe once, at mount, whether speech can be recognised WITHOUT leaving the
   * device. Chrome defaults to server-side recognition, which would break §9.1
   * silently, so a mic we cannot keep local is a mic we do not offer.
   */
  useEffect(() => {
    const listener = listenerRef.current;
    if (!listener?.available) return;
    let alive = true;
    void listener.ensureOnDevice(langRef.current).then((local) => {
      if (!alive) return;
      if (!local) setMicMode("off");
    });
    return () => {
      alive = false;
    };
  }, [phase]);

  const openMic = useCallback((): void => {
    const listener = listenerRef.current;
    if (!listener?.available) return;
    // Never open a mic we could not confirm is local (see the effect above).
    if (listener.onDevice === false) {
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
  useEffect(() => {
    const speaker = createSpeaker();
    const listener = createListener();
    speakerRef.current = speaker;
    listenerRef.current = listener;
    setMicMode(listener.available ? "ready" : "off");

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
    sayRef.current("welcome.greeting", undefined, "encouraging", "idle");

    return () => {
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
  }, []);

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

  const playAgain = useCallback(async (): Promise<void> => {
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
  }, [startPlaying]);

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

        {phase === "camera-ask" && (
          <>
            <h1 className="live-greeting">
              <Bilingual k="camera.title" />
            </h1>
            <p className="live-kidline">
              <Bilingual k="camera.kidLine" />
            </p>
            <BigButton k={busy ? "camera.loading" : "camera.allow"} onClick={() => void openEyes()} disabled={busy} />
            <button type="button" className="live-quiet" onClick={playWithoutCamera} disabled={busy}>
              <Bilingual k="camera.skip" inline />
            </button>
            {/* The grown-up promise. Plain, checkable, and true by construction. */}
            <p className="live-promise">
              <Bilingual k="camera.promise" />
            </p>
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
                  <TalkButton listening={listening} onPress={openMic} onRelease={closeMic} />
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
            <StreakStars count={streak} total={round.length} />
          </>
        )}

        {phase === "goodbye" && (
          <>
            <h1 className="live-greeting">
              <Bilingual k="goodbye.title" />
            </h1>
            <p className="live-kidline">
              <Bilingual k="goodbye.wave" inline />
            </p>
            <StreakStars count={streak} total={round.length} />
            <BigButton k="goodbye.again" onClick={() => void playAgain()} />
          </>
        )}
      </section>
    </main>
  );
}
