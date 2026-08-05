// createRig(host, opts): the rig runtime. Owns every timer (blink, viseme
// cycle, speak marks) so they can be suppressed, faked in tests, and cleared
// on dispose. Rendering itself is delegated to render.ts.

import { defaultCreateAmplitude, defaultCreateAudio } from "./audio";
import { buildStyle, renderInto, RIG_CLASS } from "./render";
import type { AmplitudeSource, Emote, Rig, RigAudio, RigOptions, RigState, Viseme, VisemeMark } from "./types";

/**
 * Injectable timer/clock shim (defaults to the globals, read at call time so
 * vitest fake timers work without injection). Functions must be pre-bound.
 */
export interface RigClock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
}

/** RigState → emote, per the character sheet / 2026-08-05 ruling. */
const STATE_EMOTE: Record<RigState, Emote> = {
  idle: "idle",
  listening: "listening",
  speaking: "encouraging",
  celebrate: "happy",
  goodbye: "goodbye",
};

/** States whose arc eyes suppress the blink scheduler. */
const ARC_EYE_STATES: readonly RigState[] = ["celebrate", "goodbye"];

/** Placeholder speaking mouth: cycles these in order, never "smile" (matches the prototype driver). */
const SPEAK_CYCLE: readonly Viseme[] = ["closed", "A", "E", "O", "U", "F", "L"];
const VISEME_INTERVAL_MS = 200;

const BLINK_MIN_MS = 3000;
const BLINK_MAX_MS = 6000;
const BLINK_CLOSED_MS = 150;

/** speak() with no audio and no marks resolves after this long (degraded hosts). */
const SPEAK_DEFAULT_MS = 2000;

/** Audio-clock poll for mark scheduling (§6: marks ride audio.currentTime). */
const MARK_POLL_MS = 50;

/** Amplitude-fallback poll. */
const AMP_POLL_MS = 60;

/**
 * RMS loudness → mouth openness, quantized to the design's discrete visemes
 * (the §6 "jaw-open interpolation" against a fixed mouth set). Descending.
 */
const AMP_LEVELS: readonly [number, Viseme][] = [
  [0.16, "O"],
  [0.09, "A"],
  [0.03, "E"],
];

function visemeForLevel(rms: number): Viseme {
  for (const [threshold, v] of AMP_LEVELS) {
    if (rms >= threshold) return v;
  }
  return "closed";
}

export function createRig(host: HTMLElement, opts: RigOptions = {}, clock: Partial<RigClock> = {}): Rig {
  const clk: RigClock = {
    setTimeout: clock.setTimeout ?? ((fn: () => void, ms: number): unknown => globalThis.setTimeout(fn, ms)),
    clearTimeout:
      clock.clearTimeout ??
      ((h: unknown): void => {
        globalThis.clearTimeout(h as number);
      }),
    setInterval: clock.setInterval ?? ((fn: () => void, ms: number): unknown => globalThis.setInterval(fn, ms)),
    clearInterval:
      clock.clearInterval ??
      ((h: unknown): void => {
        globalThis.clearInterval(h as number);
      }),
    now: clock.now ?? ((): number => Date.now()),
  };

  const crop = opts.crop ?? "full";
  const showBody = opts.showBody ?? false;
  const reducedMotion = opts.reducedMotion ?? false;

  const doc = host.ownerDocument;
  const root = doc.createElement("div");
  root.className = RIG_CLASS;
  root.appendChild(buildStyle(doc));
  host.appendChild(root);

  let state: RigState = "idle";
  let viseme: Viseme | null = null; // null → emote default
  let eyesClosed = false;
  let disposed = false;

  let blinkTimer: unknown = null; // pending blink-close OR blink-open timeout
  let visemeTimer: unknown = null; // the 200ms speaking interval
  let speakTimers: unknown[] = []; // mark timeouts + completion timeout
  let speakPoll: unknown = null; // audio-clock / amplitude interval
  let speakAudio: RigAudio | null = null;
  let speakAmp: AmplitudeSource | null = null;
  let speakDetach: (() => void) | null = null;
  let speakResolve: (() => void) | null = null;

  function render(): void {
    root.setAttribute("data-state", state);
    renderInto(root, { emote: STATE_EMOTE[state], viseme, eyesClosed, crop, showBody, reducedMotion });
  }

  // --- Blink scheduler (rig-owned; NOT the CSS chikuBlink animation) -------

  function cancelBlink(): void {
    if (blinkTimer !== null) {
      clk.clearTimeout(blinkTimer);
      blinkTimer = null;
    }
    eyesClosed = false;
  }

  function scheduleBlink(): void {
    const delay = BLINK_MIN_MS + Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS);
    blinkTimer = clk.setTimeout(() => {
      eyesClosed = true;
      render();
      blinkTimer = clk.setTimeout(() => {
        eyesClosed = false;
        render();
        scheduleBlink();
      }, BLINK_CLOSED_MS);
    }, delay);
  }

  function syncBlink(): void {
    if (reducedMotion || disposed) return;
    if (ARC_EYE_STATES.includes(state)) cancelBlink();
    else if (blinkTimer === null) scheduleBlink();
  }

  // --- Speaking viseme cycle ------------------------------------------------

  function stopCycle(): void {
    if (visemeTimer !== null) {
      clk.clearInterval(visemeTimer);
      visemeTimer = null;
    }
  }

  function startCycle(): void {
    let i = 0;
    viseme = SPEAK_CYCLE[0] ?? "closed";
    visemeTimer = clk.setInterval(() => {
      i = (i + 1) % SPEAK_CYCLE.length;
      viseme = SPEAK_CYCLE[i] ?? "closed";
      render();
    }, VISEME_INTERVAL_MS);
  }

  // --- State machine ----------------------------------------------------------

  function enterState(s: RigState, withCycle: boolean): void {
    state = s;
    stopCycle();
    viseme = null;
    if (withCycle && s === "speaking" && !reducedMotion) startCycle();
    syncBlink();
    render();
  }

  function cancelSpeak(): void {
    for (const t of speakTimers) clk.clearTimeout(t);
    speakTimers = [];
    if (speakPoll !== null) {
      clk.clearInterval(speakPoll);
      speakPoll = null;
    }
    if (speakDetach !== null) {
      speakDetach();
      speakDetach = null;
    }
    if (speakAmp !== null) {
      speakAmp.dispose();
      speakAmp = null;
    }
    if (speakAudio !== null) {
      speakAudio.pause();
      speakAudio = null;
    }
    if (speakResolve !== null) {
      const resolve = speakResolve;
      speakResolve = null;
      resolve();
    }
  }

  function setState(s: RigState): void {
    if (disposed) return;
    cancelSpeak(); // an external transition interrupts any in-flight speak()
    enterState(s, true);
  }

  function getState(): RigState {
    return state;
  }

  // --- speak(): audio playback with the §6 degradation chain ----------------
  //   marks on the audio clock  >  amplitude sampler  >  200ms viseme cycle
  //   audio missing/failed      >  timer-scheduled marks (never dead-air)

  function speak(audioUrl: string, marks?: VisemeMark[]): Promise<void> {
    if (disposed) return Promise.resolve();
    cancelSpeak();

    if (reducedMotion) {
      // Static pose only, zero timers: nothing to animate, so the speak is
      // instantaneous — pose applied and released synchronously.
      enterState("speaking", false);
      enterState("idle", false);
      return Promise.resolve();
    }

    const hasMarks = marks !== undefined && marks.length > 0;
    const sorted = hasMarks && marks !== undefined ? [...marks].sort((a, b) => a.t - b.t) : [];

    // Praise plays over the celebrate pose: keep the happy emote, let the
    // marks drive the mouth (character sheet: celebrate ≈1.2s, talking face
    // otherwise). Any other state hands over to "speaking".
    const underCelebrate = state === "celebrate";
    if (underCelebrate) {
      stopCycle();
      viseme = null;
      render();
    } else {
      enterState("speaking", false);
    }

    return new Promise<void>((resolve) => {
      speakResolve = resolve;

      const finish = (): void => {
        const r = speakResolve;
        speakResolve = null;
        cancelSpeak();
        enterState("idle", true);
        if (r !== null) r();
      };

      const scheduleTimerFallback = (): void => {
        if (hasMarks) {
          let end = 0;
          for (const m of sorted) {
            const at = Math.max(0, m.t);
            if (at > end) end = at;
            speakTimers.push(
              clk.setTimeout(() => {
                viseme = m.viseme;
                render();
              }, at),
            );
          }
          // Scheduled after the marks so an at-`end` mark applies before we finish.
          speakTimers.push(clk.setTimeout(finish, end));
        } else {
          if (!underCelebrate) startCycle();
          speakTimers.push(clk.setTimeout(finish, SPEAK_DEFAULT_MS));
        }
      };

      const audio = (opts.createAudio ?? defaultCreateAudio)(audioUrl);
      if (audio === null) {
        scheduleTimerFallback();
        return;
      }

      speakAudio = audio;
      const onEnded = (): void => {
        finish();
      };
      const onError = (): void => {
        // Audio died mid-flight: drop to the timer chain rather than dead-air.
        if (speakDetach !== null) {
          speakDetach();
          speakDetach = null;
        }
        if (speakPoll !== null) {
          clk.clearInterval(speakPoll);
          speakPoll = null;
        }
        speakAudio = null;
        scheduleTimerFallback();
      };
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      speakDetach = () => {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
      };

      if (hasMarks) {
        // Mouth rides the audio clock, so drift/buffering can't desync it.
        let idx = 0;
        speakPoll = clk.setInterval(() => {
          const tMs = audio.currentTime * 1000;
          let next: Viseme | null = null;
          while (idx < sorted.length) {
            const mark = sorted[idx];
            if (mark === undefined || mark.t > tMs) break;
            next = mark.viseme;
            idx += 1;
          }
          if (next !== null) {
            viseme = next;
            render();
          }
        }, MARK_POLL_MS);
      } else {
        speakAmp = (opts.createAmplitude ?? defaultCreateAmplitude)(audio);
        if (speakAmp !== null) {
          speakPoll = clk.setInterval(() => {
            if (speakAmp === null) return;
            const v = visemeForLevel(speakAmp.sample());
            if (v !== viseme) {
              viseme = v;
              render();
            }
          }, AMP_POLL_MS);
        } else if (!underCelebrate) {
          startCycle();
        }
      }

      const played = audio.play();
      if (played !== undefined && typeof (played as Promise<void>).then === "function") {
        void (played as Promise<void>).catch(() => {
          onError();
        });
      }
    });
  }

  function dispose(): void {
    if (disposed) return;
    cancelSpeak(); // resolves any pending speak() so callers never hang
    stopCycle();
    cancelBlink();
    disposed = true;
    root.remove();
  }

  enterState("idle", true);

  return { setState, getState, speak, dispose };
}
