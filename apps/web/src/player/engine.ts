// The episode interpreter (§8): a pure transition function over an Episode's
// segments — video interludes and checkpoints — so every timing-critical
// decision is synchronous and testable. The host component executes effects.
//
// Escalation (§8 step 4) is IN scope here: a local-matcher miss on an
// `escalate` checkpoint emits ESCALATE; the host POSTs /understand and feeds
// back UNDERSTOOD or UNDERSTAND_FAILED. Silence never escalates — there is
// nothing to understand — it goes straight to the §8 step-5 retry chain.

import type { CheckpointSegment, Episode, Lang, UnderstandResponse } from "@chiku/schema";
import { matchUtterance, normalize } from "../speech/matcher";

export type EnginePhase =
  | "idle"
  | "video"
  | "asking"
  | "listening"
  | "thinking" // brain round-trip in flight
  | "celebrating"
  | "retrying"
  | "together"
  | "complete";

export interface EngineState {
  phase: EnginePhase;
  segIdx: number;
  /** Misses on the current checkpoint (resets per checkpoint). */
  misses: number;
  /** The child matched the current checkpoint (gates celebration UI). */
  won: boolean;
}

export type EngineEvent =
  | { type: "START" }
  | { type: "VIDEO_DONE" }
  | { type: "SPEAK_ENDED" }
  | { type: "HEARD"; text: string; conf: number; tsMs: number }
  | { type: "LISTEN_TIMEOUT" }
  | { type: "UNDERSTOOD"; response: UnderstandResponse; utterance: string; heardAtMs: number }
  | { type: "UNDERSTAND_FAILED" }
  /** Hard session cap (§9.5) or a grown-up End — warm goodbye, never a nag. */
  | { type: "SESSION_END" };

export type TranscriptOutcome =
  | "matched-local"
  | "matched-brain"
  | "retry"
  | "redirect"
  | "silence"
  | "together";

export interface TranscriptEntry {
  checkpointId: string;
  outcome: TranscriptOutcome;
  /** What the recognizer heard — session-scoped only, dies with the room (§9/D9). */
  heard?: string;
  matchId?: string;
}

export type EngineEffect =
  | { type: "PLAY_VIDEO"; src: string }
  | {
      type: "PLAY_LINE";
      kind: "ask" | "praise" | "retry" | "together";
      /** Content-relative media file; host resolves to a URL. */
      audio: string;
      /** Content-relative marks file, when rendered. */
      marks?: string;
      celebrate?: boolean;
    }
  | { type: "LISTEN_START"; listenMs: number }
  | { type: "LISTEN_STOP" }
  | { type: "ESCALATE"; utterance: string; heardAtMs: number }
  | { type: "MATCHED"; matchId: string; via: "local" | "brain"; heardAtMs: number }
  | { type: "TRANSCRIPT"; entry: TranscriptEntry }
  | { type: "EPISODE_COMPLETE" };

export const initialEngineState: EngineState = { phase: "idle", segIdx: -1, misses: 0, won: false };

interface Step {
  next: EngineState;
  effects: EngineEffect[];
}

const same = (state: EngineState): Step => ({ next: state, effects: [] });

function checkpointAt(episode: Episode, segIdx: number): CheckpointSegment | null {
  const seg = episode.segments[segIdx];
  return seg !== undefined && seg.type === "checkpoint" ? seg : null;
}

/** Per-lang file for an onMiss line ref (§7: base name → <base>_<lang>.m4a). */
export function missLineFile(base: string, lang: Lang): string {
  return `${base}_${lang}.m4a`;
}

function advance(episode: Episode, lang: Lang, fromIdx: number): Step {
  const segIdx = fromIdx + 1;
  const seg = episode.segments[segIdx];
  if (seg === undefined) {
    return {
      next: { phase: "complete", segIdx, misses: 0, won: false },
      effects: [{ type: "EPISODE_COMPLETE" }],
    };
  }
  if (seg.type === "video") {
    return {
      next: { phase: "video", segIdx, misses: 0, won: false },
      effects: [{ type: "PLAY_VIDEO", src: seg.src }],
    };
  }
  const ask: EngineEffect = {
    type: "PLAY_LINE",
    kind: "ask",
    audio: seg.ask.audio[lang],
    ...(seg.ask.marks !== undefined ? { marks: seg.ask.marks[lang] } : {}),
  };
  return { next: { phase: "asking", segIdx, misses: 0, won: false }, effects: [ask] };
}

function celebrate(
  state: EngineState,
  cp: CheckpointSegment,
  lang: Lang,
  matchId: string,
  via: "local" | "brain",
  heard: string,
  heardAtMs: number,
): Step {
  const expect = cp.expect.find((e) => e.id === matchId);
  if (expect === undefined) return missPath(state, cp, lang, { checkpointId: cp.id, outcome: "retry", heard });
  return {
    next: { ...state, phase: "celebrating", won: true },
    effects: [
      { type: "LISTEN_STOP" },
      { type: "MATCHED", matchId, via, heardAtMs },
      {
        type: "TRANSCRIPT",
        entry: {
          checkpointId: cp.id,
          outcome: via === "local" ? "matched-local" : "matched-brain",
          heard,
          matchId,
        },
      },
      { type: "PLAY_LINE", kind: "praise", audio: expect.praise.audio[lang], celebrate: true },
    ],
  };
}

/** §8 step 5: one retry, then say-it-together. Records the transcript entry it was given. */
function missPath(state: EngineState, cp: CheckpointSegment, lang: Lang, entry: TranscriptEntry): Step {
  const misses = state.misses + 1;
  const transcript: EngineEffect = { type: "TRANSCRIPT", entry };
  if (misses <= cp.onMiss.maxRetries) {
    return {
      next: { ...state, phase: "retrying", misses },
      effects: [
        { type: "LISTEN_STOP" },
        transcript,
        { type: "PLAY_LINE", kind: "retry", audio: missLineFile(cp.onMiss.retryAudio, lang) },
      ],
    };
  }
  return {
    next: { ...state, phase: "together", misses },
    effects: [
      { type: "LISTEN_STOP" },
      { ...transcript, entry: { ...entry, outcome: entry.outcome === "silence" ? "silence" : "together" } },
      { type: "PLAY_LINE", kind: "together", audio: missLineFile(cp.onMiss.fallbackAudio, lang) },
    ],
  };
}

export function engineTransition(
  state: EngineState,
  event: EngineEvent,
  episode: Episode,
  lang: Lang,
): Step {
  const cp = checkpointAt(episode, state.segIdx);

  switch (event.type) {
    case "START":
      if (state.phase !== "idle" && state.phase !== "complete") break;
      return advance(episode, lang, -1);

    case "VIDEO_DONE":
      if (state.phase !== "video") break;
      return advance(episode, lang, state.segIdx);

    case "SPEAK_ENDED":
      if (state.phase === "asking" || state.phase === "retrying") {
        if (cp === null) break;
        return {
          next: { ...state, phase: "listening" },
          effects: [{ type: "LISTEN_START", listenMs: cp.listenMs }],
        };
      }
      if (state.phase === "celebrating" || state.phase === "together") {
        return advance(episode, lang, state.segIdx);
      }
      break;

    case "HEARD": {
      if (state.phase !== "listening" || cp === null) break;
      // Recognizer noise is the timeout's business — never burns a retry.
      if (normalize(event.text).length === 0) break;
      const result = matchUtterance(event.text, cp.expect);
      if (result !== null) return celebrate(state, cp, lang, result.id, "local", event.text, event.tsMs);
      if (cp.escalate) {
        return {
          next: { ...state, phase: "thinking" },
          effects: [
            { type: "LISTEN_STOP" },
            { type: "ESCALATE", utterance: event.text, heardAtMs: event.tsMs },
          ],
        };
      }
      return missPath(state, cp, lang, { checkpointId: cp.id, outcome: "retry", heard: event.text });
    }

    case "LISTEN_TIMEOUT":
      if (state.phase !== "listening" || cp === null) break;
      return missPath(state, cp, lang, { checkpointId: cp.id, outcome: "silence" });

    case "UNDERSTOOD": {
      if (state.phase !== "thinking" || cp === null) break;
      const r = event.response;
      if (r.action === "praise" && r.matchId !== null) {
        return celebrate(state, cp, lang, r.matchId, "brain", event.utterance, event.heardAtMs);
      }
      return missPath(state, cp, lang, {
        checkpointId: cp.id,
        outcome: r.action === "redirect" ? "redirect" : "retry",
        heard: event.utterance,
      });
    }

    case "UNDERSTAND_FAILED":
      if (state.phase !== "thinking" || cp === null) break;
      // Brain unreachable: degrade to the local retry chain (§8 — never dead-air).
      return missPath(state, cp, lang, { checkpointId: cp.id, outcome: "retry" });

    case "SESSION_END":
      if (state.phase === "complete" || state.phase === "idle") break;
      return {
        next: { phase: "complete", segIdx: episode.segments.length, misses: 0, won: false },
        effects: [{ type: "LISTEN_STOP" }, { type: "EPISODE_COMPLETE" }],
      };
  }

  return same(state);
}
