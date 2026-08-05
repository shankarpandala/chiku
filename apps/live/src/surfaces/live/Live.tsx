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
//
// NEVER A DEAD END is a hard rule here: every failure path (denied, no camera
// hardware, tracker error, a child who just will not wave today) lands in the
// same playable place.
//
// INVARIANTS (§9 + camera rule): no frame, landmark or derived image datum
// leaves the device — the engine hands us a small struct and nothing else, and
// the CSP forbids the network anyway. No analytics. No PII. No hosted model.
// Both scripts on every kid-facing string. Teal only ever means "Chiku is
// attending to you".

import { useCallback, useEffect, useRef, useState } from "react";
import type { Emote } from "@chiku/rig";
import { Bilingual } from "../../components/Bilingual";
import { BigButton } from "../../components/BigButton";
import { CameraStage, ATTENTION_THRESHOLD, type CameraStageHandle, type RigFactory } from "../../components/CameraStage";
import { ChoiceButton } from "../../components/ChoiceButton";
import { StreakStars } from "../../components/StreakStars";
import { useReducedMotion } from "../../components/useReducedMotion";
import { useI18n, type I18nKey } from "../../i18n";
import { buildRound, HoldTracker, type Activity, type ActivityChoice } from "../../activities";
import { randInt } from "../../activities/types";
import { createVisionEngine } from "../../vision/engine";
import type { VisionEngine, VisionFrame, VisionStatus } from "../../vision/types";

export type Phase = "welcome" | "camera-ask" | "playing" | "goodbye";
export type CameraMode = "unknown" | "on" | "off";
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

  // Mirrors: the vision callback runs between renders and must never read a
  // stale closure, so anything it touches also lives in a ref.
  const phaseRef = useRef<Phase>("welcome");
  const cameraModeRef = useRef<CameraMode>("unknown");
  const roundStateRef = useRef<RoundState>("prompt");
  const roundRef = useRef<readonly Activity[]>([]);
  const indexRef = useRef(0);
  const attendingRef = useRef(false);

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
    later(() => {
      // Still working on it? Offer the other way in, warmly.
      if (roundStateRef.current !== "prompt") return;
      setAssist(true);
      setNudge(true);
      setEmote("encouraging");
    }, ASSIST_AFTER_MS);
  }, [later, setEmote]);

  const goGoodbye = useCallback((): void => {
    clearTimers();
    phaseRef.current = "goodbye";
    setPhase("goodbye");
    setAttending(false);
    attendingRef.current = false;
    setEmote("goodbye");
    // The camera light goes out the moment the game ends — visible privacy.
    engineRef.current?.stop();
    stageRef.current?.setAttention(true);
  }, [clearTimers, setEmote]);

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
    holdRef.current.reset();
    roundStateRef.current = "praise";
    setRoundState("praise");
    setNudge(false);
    setNudgedId(null);
    setStreak((s) => s + 1);
    setPraiseKey(PRAISES[randInt(random, 0, PRAISES.length - 1)] ?? "praise.one");
    setEmote("happy");
    stageRef.current?.blink();
    later(advance, PRAISE_MS);
  }, [advance, clearTimers, later, random, setEmote]);

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

  // --- entry points --------------------------------------------------------

  const begin = useCallback((): void => {
    phaseRef.current = "camera-ask";
    setPhase("camera-ask");
    setEmote("encouraging");
  }, [setEmote]);

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
      later(() => setNudgedId(null), 700);
    },
    [later, setEmote, succeed],
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
