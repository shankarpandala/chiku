// TODDLER MODE — for a two-year-old, which is below the band the rest of this
// app was designed for, and that changes everything.
//
// WHAT IS DIFFERENT, AND WHY THIS IS A SEPARATE SURFACE RATHER THAN A MODE OF
// `Live`. The 3-8 surface is a round machine: prompt, hold, verdict, mercy
// ladder, praise. Every one of those pieces presumes a child who can be ASKED
// something and who can be told they have not managed it yet. A 24-month-old is
// pre-verbal. They cannot read the prompt, cannot follow the instruction, and
// have no idea what a tap answer is for. Bolting a "toddler difficulty" onto
// the round machinery would have produced the same game with bigger buttons,
// which is the wrong game.
//
//   IMITATION IS THE INSTRUCTION. Chiku stands up and does a big slow movement;
//   the child copies. That is the whole loop and there is nothing else in it.
//
// The five rules this file exists to keep:
//
//   1. NOTHING IS EVER WRONG. There is no verdict anywhere in this surface — no
//      target, no score, no retry copy, no failure exit. `movement.any` is the
//      whole predicate. A child who jumps when Chiku stomped has moved their
//      whole body along with him, which IS the thing we wanted.
//   2. UNDER 200ms. A reaction that lands late is not perceived as caused by
//      the child, and the loop never closes in their head. So the celebration
//      is fired synchronously from inside the vision callback — not from a
//      poll, not from an effect, not after a state round-trip.
//   3. REPETITION IS THE CONTENT. The same movement four times, with the
//      celebration escalating each go (`cheerFor`). "Again, but MORE" is what a
//      two-year-old is asking for; variety is what a grown-up wants.
//   4. THE GROWN-UP IS PART OF THE TOY. One quiet line, once, at the start. At
//      this age a parent copying Chiku in the room is worth more than any
//      detector, and saying so is cheaper than building anything.
//   5. NO CAMERA IS NOT A DEGRADED MODE. With no camera Chiku performs and
//      delights on a timer, and the child copying a dancing elephant is the
//      entire experience. Detection is a bonus that makes the delight
//      CONTINGENT — better, but not the point. The camera is therefore off by
//      default and switched on, if at all, by a grown-up.
//
// INVARIANTS (§9): nothing is recorded or transmitted, no analytics, no PII, a
// hard session cap (five minutes here, not the shared twenty), and every
// kid-facing string in both scripts.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Emote } from "@chiku/rig";
import { Bilingual } from "../../components/Bilingual";
import { GROWNUP_OPEN_HOLD_MS, HoldButton } from "../../components/HoldButton";
import { SunArc } from "../../components/SunArc";
import { useReducedMotion } from "../../components/useReducedMotion";
import type { RigFactory } from "../../components/CameraStage";
import { translate, useI18n, type I18nKey, type Lang } from "../../i18n";
import {
  cheerFor,
  exerciseAt,
  movedOnFrame,
  REPS_PER_EXERCISE,
  TODDLER_LIMIT_MIN,
  TODDLER_TIMING,
  type Exercise,
} from "../../activities/exercises";
import { SESSION_TICK_MS, SessionClock } from "../../session/cap";
import { warmVision } from "../../session/warmup";
import { createVisionEngine } from "../../vision/engine";
import type { MovementKind } from "../../vision/movement";
import type { VisionEngine, VisionFrame } from "../../vision/types";
import { createSpeaker } from "../../voice";
import type { Speaker } from "../../voice/types";
import { ToddlerStage, type ToddlerStageHandle } from "./ToddlerStage";

/**
 * Where we are in one bout of the loop.
 *
 *   show   Chiku is doing the movement. Nothing is being watched for yet.
 *   copy   The child's turn. Any movement at all ends it, instantly; if none
 *          comes, a timer ends it anyway and it still ends in delight.
 *   cheer  The delight. Always reached. There is no fourth state.
 */
export type ToddlerBeat = "show" | "copy" | "cheer";
export type ToddlerPhase = "play" | "bye";

/** Capability the vision engine may have grown. Feature-detected, never assumed. */
type MaybeWarmEngine = VisionEngine & { warm?: () => Promise<void> };

export interface ToddlerProps {
  /** Back to the main surface. Behind a grown-up hold — never a tap. */
  onExit?: () => void;
  /** Test seam — defaults to the real live rig. */
  rigFactory?: RigFactory;
  /** Test seam — the session cap, in minutes. Defaults to five. */
  limitMin?: number;
}

export function Toddler({ onExit, rigFactory, limitMin = TODDLER_LIMIT_MIN }: ToddlerProps) {
  const { lang, other, tIn } = useI18n();
  const reducedMotion = useReducedMotion();

  const stageRef = useRef<ToddlerStageHandle | null>(null);
  const engineRef = useRef<VisionEngine | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const clockRef = useRef(new SessionClock());
  const mountedRef = useRef(true);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const warmAbortRef = useRef<AbortController | null>(null);

  const [phase, setPhase] = useState<ToddlerPhase>("play");
  const [beat, setBeat] = useState<ToddlerBeat>("show");
  /** Which exercise, counted from the start of the session and wrapping. */
  const [bout, setBout] = useState(0);
  /** Which go at THIS exercise, 0-based. Drives the escalating delight. */
  const [rep, setRep] = useState(0);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [attending, setAttending] = useState(false);
  const [sessionProgress, setSessionProgress] = useState(0);
  /**
   * The grown-up line is shown until the first celebration and then never
   * again. It is for the adult, it has been read by then, and leaving copy on
   * screen that nobody is reading is clutter in a two-year-old's field of view.
   */
  const [showGrownUpLine, setShowGrownUpLine] = useState(true);

  // Mirrors, for the vision callback: it runs between renders and must never
  // read a stale closure.
  const phaseRef = useRef<ToddlerPhase>("play");
  const beatRef = useRef<ToddlerBeat>("show");
  const boutRef = useRef(0);
  const repRef = useRef(0);
  const cameraOnRef = useRef(false);
  const attendingRef = useRef(false);
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

  /**
   * Chiku's warm noise.
   *
   * SPEECH IS NEVER LOAD-BEARING — the loop runs identically on a device with
   * no synthesiser, which is the same rule the 3-8 surface keeps. The lines
   * here are not instructions in any case: they are for the grown-up in the
   * room to echo, and for the child they are a friendly sound with a rhythm.
   */
  const say = useCallback((key: I18nKey): void => {
    const speaker = speakerRef.current;
    if (!speaker?.available) return;
    speaker.cancelAll();
    const handle = speaker.speak(translate(langRef.current, key), langRef.current, (open) => {
      stageRef.current?.setMouthOpen(open);
    });
    void handle.done.then(() => {
      if (mountedRef.current) stageRef.current?.setMouthOpen(null);
    });
  }, []);

  const setEmote = useCallback((emote: Emote): void => {
    stageRef.current?.setEmote(emote);
  }, []);

  // Forward reference so `show` can schedule `copy` can schedule `cheer` can
  // schedule `show` without a dependency cycle between the callbacks.
  const startBoutRef = useRef<(index: number, at: number) => void>(() => {});

  const goodbye = useCallback((): void => {
    if (phaseRef.current === "bye") return;
    clearTimers();
    phaseRef.current = "bye";
    setPhase("bye");
    setEmote("goodbye");
    say("toddler.bye.title");
    // The camera light goes out the moment the play does — visible privacy.
    engineRef.current?.stop();
    setCameraOn(false);
    cameraOnRef.current = false;
    stageRef.current?.setAttention(true);
  }, [clearTimers, say, setEmote]);

  /**
   * The next go: the same movement again until `REPS_PER_EXERCISE` of them, and
   * only then a new one. Ends the session at the cap, warmly, at this seam —
   * never mid-celebration.
   */
  const nextBout = useCallback((): void => {
    if (clockRef.current.expired(limitMin)) {
      goodbye();
      return;
    }
    const nextRep = repRef.current + 1;
    if (nextRep < REPS_PER_EXERCISE) {
      startBoutRef.current(boutRef.current, nextRep);
      return;
    }
    startBoutRef.current(boutRef.current + 1, 0);
  }, [goodbye, limitMin]);

  /**
   * The delight. Disproportionate on purpose, and reachable from exactly two
   * places: the child moved, or the timer ran out. Both are wins. There is no
   * third caller and no path that skips it.
   */
  const celebrate = useCallback((): void => {
    if (phaseRef.current !== "play" || beatRef.current !== "copy") return;
    clearTimers();
    beatRef.current = "cheer";
    setBeat("cheer");
    setShowGrownUpLine(false);
    setEmote("happy");
    stageRef.current?.blink();
    say(cheerFor(repRef.current));
    later(nextBout, TODDLER_TIMING.cheerMs);
  }, [clearTimers, later, nextBout, say, setEmote]);

  /** The child's turn. Nothing here can fail; the timer is a floor, not a limit. */
  const beginCopy = useCallback((): void => {
    if (phaseRef.current !== "play") return;
    beatRef.current = "copy";
    setBeat("copy");
    setEmote("listening");
    later(
      celebrate,
      cameraOnRef.current ? TODDLER_TIMING.waitWatchedMs : TODDLER_TIMING.waitSoloMs,
    );
  }, [celebrate, later, setEmote]);

  const startBout = useCallback(
    (index: number, at: number): void => {
      if (phaseRef.current !== "play") return;
      clearTimers();
      boutRef.current = index;
      repRef.current = at;
      setBout(index);
      setRep(at);
      beatRef.current = "show";
      setBeat("show");

      const exercise: Exercise = exerciseAt(index);
      setEmote("encouraging");
      // The instruction, and the only one there is. `data-move` on the stage
      // carries the same movement into CSS, so a device where the rig's beat
      // cannot run still shows a body doing something copyable.
      stageRef.current?.perform(exercise.id);
      say(exercise.inviteKey);
      later(beginCopy, exercise.showMs);
    },
    [beginCopy, clearTimers, later, say, setEmote],
  );
  startBoutRef.current = startBout;

  /* --- vision ------------------------------------------------------------ */

  /**
   * Every frame, straight from the engine. THE CELEBRATION IS FIRED FROM HERE,
   * inside the callback, on the frame the movement is seen — that is what buys
   * the contingency window. Anything that went through an effect or a poll
   * would add a tick the child can feel.
   */
  const handleFrame = useCallback(
    (frame: VisionFrame): void => {
      const seen = stageRef.current?.applyFrame(frame) ?? false;
      if (seen !== attendingRef.current) {
        attendingRef.current = seen;
        setAttending(seen);
      }
      if (phaseRef.current !== "play" || beatRef.current !== "copy") return;
      // `any`, deliberately. Not the movement we asked for — ANY movement. A
      // child who jumps when Chiku stomped moved their whole body with him,
      // and telling them that did not count is how you teach a two-year-old
      // that the screen is not really watching.
      //
      // A movement that happened during the DEMONSTRATION is still latched
      // when this beat opens, and that is correct rather than a leak: the
      // child who could not wait and copied him mid-stomp is the child this
      // whole surface is for, and they get their celebration on the first
      // frame of their turn. Anything older than that has long since decayed
      // — a cheer plus a demonstration is over three seconds, and the latch is
      // 1.2 (see TODDLER_TIMING.cheerMs).
      if (movedOnFrame(frame)) celebrate();
    },
    [celebrate],
  );

  const frameHandlerRef = useRef(handleFrame);
  frameHandlerRef.current = handleFrame;

  /**
   * The camera, if a grown-up wants one. Off by default and never asked for on
   * a child-facing screen — the loop is complete without it.
   *
   * Models first, camera second, exactly as the 3-8 surface does it: pulling
   * ~20MB with the camera light already on is the thing that makes the privacy
   * promise look like a lie. A failure at any point is not an error state; it
   * just leaves the loop where it already was, which is playable.
   */
  const enableCamera = useCallback(async (): Promise<void> => {
    const engine: MaybeWarmEngine | null = engineRef.current;
    const video = stageRef.current?.video() ?? null;
    if (!engine || !video || cameraBusy) return;
    setCameraBusy(true);
    const controller = new AbortController();
    warmAbortRef.current = controller;
    try {
      if (typeof engine.warm === "function") await engine.warm();
      else await warmVision({ signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      await engine.start(video);
      if (!mountedRef.current) return;
      // start() reports failure as a status rather than throwing, so a resolved
      // promise is not proof of a camera.
      const live = engine.status === "ready";
      cameraOnRef.current = live;
      setCameraOn(live);
    } catch {
      // No camera today. Chiku keeps dancing; nothing on screen changes.
      if (!mountedRef.current) return;
      cameraOnRef.current = false;
      setCameraOn(false);
    } finally {
      warmAbortRef.current = null;
      if (mountedRef.current) setCameraBusy(false);
    }
  }, [cameraBusy]);

  /* --- lifecycle --------------------------------------------------------- */

  useEffect(() => {
    mountedRef.current = true;
    const engine = createVisionEngine();
    engineRef.current = engine;
    const offFrame = engine.onFrame((frame) => frameHandlerRef.current(frame));
    const offStatus = engine.onStatus((status) => {
      if (!mountedRef.current) return;
      if (status === "denied" || status === "unavailable" || status === "error") {
        // Losing the camera is a downgrade to solo mode, not a dead end. The
        // loop does not even pause.
        cameraOnRef.current = false;
        setCameraOn(false);
        attendingRef.current = false;
        setAttending(false);
      }
    });
    const speaker = createSpeaker();
    speakerRef.current = speaker;

    clockRef.current.start();
    startBoutRef.current(0, 0);

    return () => {
      mountedRef.current = false;
      offFrame();
      offStatus();
      engine.dispose();
      engineRef.current = null;
      speaker.cancelAll();
      speaker.dispose();
      speakerRef.current = null;
      warmAbortRef.current?.abort();
      warmAbortRef.current = null;
      for (const id of timersRef.current) globalThis.clearTimeout(id);
      timersRef.current = [];
    };
    // Once, on mount. The loop is started here rather than in a render effect
    // so that a re-render can never restart it under the child.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The cap (§9.5) — five minutes, on the same coarse tick the 3-8 surface
   * uses. Applied at the seam between bouts rather than the instant it falls
   * due, so the last thing that happens is a celebration and not a screen
   * change mid-cheer.
   */
  useEffect(() => {
    if (phase !== "play") return;
    const clock = clockRef.current;
    const tick = (): void => {
      if (!mountedRef.current) return;
      setSessionProgress(clock.progress(limitMin));
      if (clock.expired(limitMin) && beatRef.current !== "cheer") goodbye();
    };
    tick();
    const id = globalThis.setInterval(tick, SESSION_TICK_MS);
    return () => globalThis.clearInterval(id);
  }, [goodbye, limitMin, phase]);

  /** A backgrounded tab is not play time, and is not a room to talk to. */
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") {
        clockRef.current.pause();
        speakerRef.current?.cancelAll();
        return;
      }
      if (phaseRef.current === "play") clockRef.current.start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  /* --- render ------------------------------------------------------------ */

  const exercise = exerciseAt(bout);
  /** Null while it is the child's turn: Chiku waits, he does not keep dancing. */
  const move: MovementKind | null = beat === "show" ? exercise.id : null;

  return (
    <main
      className="toddler"
      data-phase={phase}
      data-beat={beat}
      data-bout={bout}
      data-move={exercise.id}
      data-rep={rep}
      data-camera={cameraOn ? "on" : "off"}
    >
      <ToddlerStage
        ref={stageRef}
        cameraOn={cameraOn}
        attending={attending}
        reducedMotion={reducedMotion}
        videoLabel={tIn(lang, "stage.videoLabel")}
        move={move}
        rigFactory={rigFactory}
      >
        {cameraOn && (
          <p className={`stage-cue${attending ? " is-live" : ""}`}>
            <Bilingual k={attending ? "stage.seesYou" : "stage.lookingForYou"} inline />
          </p>
        )}
      </ToddlerStage>

      {/* One line at a time, announced. There is no prompt here in the 3-8
          sense — this is the noise Chiku is making while he moves, and the
          celebration when the child moves too. */}
      <section className="toddler-panel" aria-live="polite">
        {phase === "play" ? (
          <>
            {beat === "cheer" ? (
              <p className="toddler-cheer" role="status" data-cheer={rep}>
                <Bilingual k={cheerFor(rep)} />
              </p>
            ) : (
              <p className="toddler-invite">
                <Bilingual k={exercise.inviteKey} />
              </p>
            )}
          </>
        ) : (
          <>
            <h1 className="toddler-bye">
              <Bilingual k="toddler.bye.title" />
            </h1>
            <p className="toddler-invite">
              <Bilingual k="toddler.bye.line" inline />
            </p>
          </>
        )}
      </section>

      {/* --- the grown-ups' strip -------------------------------------------
          Small, low-contrast, at the bottom, out of the child's line to Chiku.
          Nothing here is for the child and nothing here is a tap: the camera
          offer is a plain quiet button because switching a camera ON is a
          decision a grown-up is making on purpose, and leaving is behind a
          hold because a two-year-old's palm lands on everything. */}
      <div className="toddler-grownups">
        {showGrownUpLine && phase === "play" && (
          <p className="toddler-grownup-line">
            <Bilingual k="toddler.grownup" />
          </p>
        )}
        {phase === "play" && (
          <div className="toddler-grownup-row">
            <SunArc progress={sessionProgress} label={tIn(lang, "session.arcLabel")} />
            {!cameraOn && (
              <button
                type="button"
                className="live-quiet"
                onClick={() => void enableCamera()}
                disabled={cameraBusy}
                data-action="toddler.watch"
              >
                <Bilingual k={cameraBusy ? "camera.loading" : "toddler.watch"} inline />
              </button>
            )}
          </div>
        )}
        {/* The way out, and it is GONE once the cap has been reached (§9.5).
            While playing it is a grown-up's escape hatch from a mode they may
            have chosen by mistake — behind a hold, because a toddler's palm
            lands on everything. After the goodbye there is no button at all:
            an end a grown-up can undo in one tap in front of the child is not
            an end, it is a negotiation, and this is the same rule that removes
            "play again" from the 3-8 surface at its cap. */}
        {onExit && phase === "play" && (
          <HoldButton
            className="hold-corner"
            holdMs={GROWNUP_OPEN_HOLD_MS}
            label={`${tIn(lang, "toddler.exit")} · ${tIn(other, "toddler.exit")}`}
            onHeld={onExit}
          />
        )}
      </div>
    </main>
  );
}
