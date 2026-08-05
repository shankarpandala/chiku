// createRig(host, opts): the rig runtime. Owns every timer (blink, viseme
// cycle, speak marks) so they can be suppressed, faked in tests, and cleared
// on dispose. Rendering itself is delegated to render.ts.

import { buildStyle, renderInto, RIG_CLASS } from "./render";
import type { Emote, Rig, RigOptions, RigState, Viseme, VisemeMark } from "./types";

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

/** speak() without marks resolves after this long (M0 placeholder; audio lands in M1). */
const SPEAK_DEFAULT_MS = 2000;

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

  // --- speak(): M0 placeholder — no audio playback (M1), but real scheduling --

  function speak(_audioUrl: string, marks?: VisemeMark[]): Promise<void> {
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
    enterState("speaking", !hasMarks); // marks drive the mouth; otherwise the placeholder cycle does

    return new Promise<void>((resolve) => {
      speakResolve = resolve;
      const finish = (): void => {
        const r = speakResolve;
        speakResolve = null;
        for (const t of speakTimers) clk.clearTimeout(t);
        speakTimers = [];
        enterState("idle", true);
        if (r !== null) r();
      };

      if (hasMarks && marks !== undefined) {
        let end = 0;
        for (const m of marks) {
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
        speakTimers.push(clk.setTimeout(finish, SPEAK_DEFAULT_MS));
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
