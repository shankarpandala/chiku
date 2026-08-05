// The checkpoint interaction loop (§8) as a pure transition function, so the
// timing-critical path — HEARD → match → PLAY praise — is synchronous and
// testable without DOM, audio, or a microphone. The host component executes
// the returned effects (play lines, start/stop listening, log latency).
//
// M1 scope: local matcher only. The §8 step-4 escalation (POST /understand on
// miss) lands in M2 behind the same MISS transition.

import type { VisemeMark } from "@chiku/schema";
import { matchUtterance, normalize, type MatchCandidate, type MatchResult } from "../speech/matcher";

export interface LoopLine {
  url: string;
  marks?: VisemeMark[];
}

export type LoopLineName = "ask" | "praise" | "retry" | "together";

export interface LoopCheckpoint {
  id: string;
  listenMs: number;
  /** §7 onMiss.maxRetries: retries granted before the say-it-together fallback. */
  maxRetries: number;
  expect: readonly MatchCandidate[];
  lines: Record<LoopLineName, LoopLine>;
}

export type LoopPhase = "idle" | "asking" | "listening" | "celebrating" | "retrying" | "together" | "done";

export interface LoopState {
  phase: LoopPhase;
  misses: number;
  /** True only when the child actually matched — gates the earned-word UI.
   *  A say-it-together ending is warm but is not a win to celebrate. */
  won: boolean;
}

export type LoopEvent =
  | { type: "START" }
  | { type: "SPEAK_ENDED" }
  | { type: "HEARD"; text: string; conf: number; tsMs: number }
  | { type: "LISTEN_TIMEOUT" };

export type LoopEffect =
  | { type: "PLAY"; line: LoopLineName; celebrate?: boolean }
  | { type: "LISTEN_START" }
  | { type: "LISTEN_STOP" }
  | { type: "MATCHED"; result: MatchResult; heardAtMs: number };

export const initialLoopState: LoopState = { phase: "idle", misses: 0, won: false };

export function transition(
  state: LoopState,
  event: LoopEvent,
  checkpoint: LoopCheckpoint,
): { next: LoopState; effects: LoopEffect[] } {
  const { phase, misses, won } = state;

  switch (event.type) {
    case "START":
      if (phase !== "idle" && phase !== "done") break;
      return { next: { phase: "asking", misses: 0, won: false }, effects: [{ type: "PLAY", line: "ask" }] };

    case "SPEAK_ENDED":
      if (phase === "asking" || phase === "retrying") {
        return { next: { phase: "listening", misses, won }, effects: [{ type: "LISTEN_START" }] };
      }
      if (phase === "celebrating" || phase === "together") {
        return { next: { phase: "done", misses, won }, effects: [] };
      }
      break;

    case "HEARD": {
      if (phase !== "listening") break;
      // Silence and recognizer noise are the timeout's business, not a miss:
      // an empty utterance must never burn the child's retry (§8 step 5).
      if (normalize(event.text).length === 0) break;
      const result = matchUtterance(event.text, checkpoint.expect);
      if (result !== null) {
        return {
          next: { phase: "celebrating", misses, won: true },
          effects: [
            { type: "LISTEN_STOP" },
            { type: "MATCHED", result, heardAtMs: event.tsMs },
            { type: "PLAY", line: "praise", celebrate: true },
          ],
        };
      }
      return miss(state, checkpoint);
    }

    case "LISTEN_TIMEOUT":
      if (phase !== "listening") break;
      return miss(state, checkpoint);
  }

  return { next: state, effects: [] };
}

/** §8 step 5: one retry, then "let's say it together" — never dead-air, never blame. */
function miss(state: LoopState, checkpoint: LoopCheckpoint): { next: LoopState; effects: LoopEffect[] } {
  const misses = state.misses + 1;
  if (misses <= checkpoint.maxRetries) {
    return {
      next: { phase: "retrying", misses, won: state.won },
      effects: [{ type: "LISTEN_STOP" }, { type: "PLAY", line: "retry" }],
    };
  }
  return {
    next: { phase: "together", misses, won: state.won },
    effects: [{ type: "LISTEN_STOP" }, { type: "PLAY", line: "together" }],
  };
}
