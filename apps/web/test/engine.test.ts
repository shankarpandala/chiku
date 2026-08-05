import { describe, expect, it } from "vitest";
import type { Episode } from "@chiku/schema";
import { EpisodeSchema } from "@chiku/schema";
import {
  engineTransition,
  initialEngineState,
  type EngineEffect,
  type EngineEvent,
  type EngineState,
} from "../src/player/engine";

const EP: Episode = EpisodeSchema.parse({
  id: "epTest",
  title: { te: "పరీక్ష", en: "Test" },
  langs: ["te", "en"],
  segments: [
    { type: "video", src: "seg1.mp4" },
    {
      type: "checkpoint",
      id: "cp1",
      ask: {
        audio: { te: "cp1_ask_te.m4a", en: "cp1_ask_en.m4a" },
        marks: { te: "cp1_ask_te.marks.json", en: "cp1_ask_en.marks.json" },
      },
      listenMs: 6000,
      expect: [
        {
          id: "green",
          match: ["green", "paccha", "పచ్చ"],
          praise: { audio: { te: "cp1_praise_green_te.m4a", en: "cp1_praise_green_en.m4a" } },
        },
      ],
      onMiss: { retryAudio: "cp1_retry", maxRetries: 1, fallbackAudio: "lets_say_together" },
      escalate: true,
    },
    { type: "video", src: "seg2.mp4" },
    {
      type: "checkpoint",
      id: "cp2",
      ask: { audio: { te: "cp2_ask_te.m4a", en: "cp2_ask_en.m4a" } },
      listenMs: 5000,
      expect: [
        {
          id: "three",
          match: ["three", "moodu", "మూడు", "3"],
          praise: { audio: { te: "cp2_praise_three_te.m4a", en: "cp2_praise_three_en.m4a" } },
        },
      ],
      onMiss: { retryAudio: "cp2_retry", maxRetries: 1, fallbackAudio: "lets_count_together" },
      escalate: false,
    },
  ],
});

function run(events: EngineEvent[], lang: "te" | "en" = "en") {
  let state: EngineState = initialEngineState;
  const all: EngineEffect[][] = [];
  for (const e of events) {
    const r = engineTransition(state, e, EP, lang);
    state = r.next;
    all.push(r.effects);
  }
  return { state, all };
}

const heard = (text: string): EngineEvent => ({ type: "HEARD", text, conf: 0.9, tsMs: 500 });
const kinds = (effects: EngineEffect[]): string[] =>
  effects.map((e) => (e.type === "PLAY_LINE" ? `PLAY_LINE:${e.kind}` : e.type));

describe("episode engine", () => {
  it("plays a full episode: video → cp (hit) → video → cp (hit) → complete", () => {
    const { state, all } = run([
      { type: "START" },
      { type: "VIDEO_DONE" },
      { type: "SPEAK_ENDED" }, // ask done
      heard("green"),
      { type: "SPEAK_ENDED" }, // praise done → seg2 video
      { type: "VIDEO_DONE" },
      { type: "SPEAK_ENDED" }, // cp2 ask done
      heard("three"),
      { type: "SPEAK_ENDED" }, // praise done → past last segment
    ]);
    expect(all.map(kinds)).toEqual([
      ["PLAY_VIDEO"],
      ["PLAY_LINE:ask"],
      ["LISTEN_START"],
      ["LISTEN_STOP", "MATCHED", "TRANSCRIPT", "PLAY_LINE:praise"],
      ["PLAY_VIDEO"],
      ["PLAY_LINE:ask"],
      ["LISTEN_START"],
      ["LISTEN_STOP", "MATCHED", "TRANSCRIPT", "PLAY_LINE:praise"],
      ["EPISODE_COMPLETE"],
    ]);
    expect(state.phase).toBe("complete");
  });

  it("resolves per-language audio and marks (te)", () => {
    const { all } = run([{ type: "START" }, { type: "VIDEO_DONE" }], "te");
    const ask = all[1]?.[0];
    expect(ask).toEqual({
      type: "PLAY_LINE",
      kind: "ask",
      audio: "cp1_ask_te.m4a",
      marks: "cp1_ask_te.marks.json",
    });
  });

  it("escalates a local miss on an escalate checkpoint, praises on brain match (§8 step 4)", () => {
    const { state, all } = run([
      { type: "START" },
      { type: "VIDEO_DONE" },
      { type: "SPEAK_ENDED" },
      heard("the colour of a leaf"), // local miss → brain
      {
        type: "UNDERSTOOD",
        response: { matchId: "green", action: "praise" },
        utterance: "the colour of a leaf",
        heardAtMs: 500,
      },
    ]);
    expect(kinds(all[3] ?? [])).toEqual(["LISTEN_STOP", "ESCALATE"]);
    expect(state.phase).toBe("celebrating");
    const effects = all[4] ?? [];
    expect(effects.some((e) => e.type === "MATCHED" && e.via === "brain")).toBe(true);
    expect(
      effects.some((e) => e.type === "TRANSCRIPT" && e.entry.outcome === "matched-brain"),
    ).toBe(true);
  });

  it("brain retry and brain redirect both fall into the gentle retry chain", () => {
    const toThinking: EngineEvent[] = [
      { type: "START" },
      { type: "VIDEO_DONE" },
      { type: "SPEAK_ENDED" },
      heard("what is your name"),
    ];
    const retry = run([
      ...toThinking,
      { type: "UNDERSTOOD", response: { matchId: null, action: "retry", reply: { text: "Try paccha!" } }, utterance: "x", heardAtMs: 500 },
    ]);
    expect(retry.state.phase).toBe("retrying");
    expect(kinds(retry.all[4] ?? [])).toEqual(["LISTEN_STOP", "TRANSCRIPT", "PLAY_LINE:retry"]);

    const redirect = run([
      ...toThinking,
      { type: "UNDERSTOOD", response: { matchId: null, action: "redirect", reply: { text: "Back to colours!" } }, utterance: "x", heardAtMs: 500 },
    ]);
    expect(redirect.state.phase).toBe("retrying");
    expect(
      (redirect.all[4] ?? []).some((e) => e.type === "TRANSCRIPT" && e.entry.outcome === "redirect"),
    ).toBe(true);
  });

  it("a dead brain degrades to the local retry chain — never dead-air", () => {
    const { state, all } = run([
      { type: "START" },
      { type: "VIDEO_DONE" },
      { type: "SPEAK_ENDED" },
      heard("ummm banana"),
      { type: "UNDERSTAND_FAILED" },
    ]);
    expect(state.phase).toBe("retrying");
    expect(kinds(all[4] ?? [])).toEqual(["LISTEN_STOP", "TRANSCRIPT", "PLAY_LINE:retry"]);
  });

  it("silence never escalates — nothing to understand (§8 step 5)", () => {
    const { state, all } = run([
      { type: "START" },
      { type: "VIDEO_DONE" },
      { type: "SPEAK_ENDED" },
      { type: "LISTEN_TIMEOUT" },
    ]);
    expect(state.phase).toBe("retrying");
    expect((all[3] ?? []).some((e) => e.type === "ESCALATE")).toBe(false);
    expect((all[3] ?? []).some((e) => e.type === "TRANSCRIPT" && e.entry.outcome === "silence")).toBe(true);
  });

  it("second miss says it together, then the episode moves on", () => {
    const { state, all } = run([
      { type: "START" },
      { type: "VIDEO_DONE" },
      { type: "SPEAK_ENDED" },
      { type: "LISTEN_TIMEOUT" }, // miss 1 → retry
      { type: "SPEAK_ENDED" }, // retry spoken → listening
      { type: "LISTEN_TIMEOUT" }, // miss 2 → together
      { type: "SPEAK_ENDED" }, // together spoken → advance to seg2 video
    ]);
    expect(kinds(all[5] ?? [])).toEqual(["LISTEN_STOP", "TRANSCRIPT", "PLAY_LINE:together"]);
    expect(state.phase).toBe("video");
    expect(state.misses).toBe(0); // fresh for the next checkpoint
  });

  it("a non-escalate checkpoint misses locally without calling the brain", () => {
    const { state, all } = run([
      { type: "START" },
      { type: "VIDEO_DONE" },
      { type: "SPEAK_ENDED" },
      heard("green"), // cp1 hit
      { type: "SPEAK_ENDED" },
      { type: "VIDEO_DONE" },
      { type: "SPEAK_ENDED" }, // cp2 (escalate: false) listening
      heard("seventeen"),
    ]);
    expect(state.phase).toBe("retrying");
    expect((all[7] ?? []).some((e) => e.type === "ESCALATE")).toBe(false);
  });

  it("SESSION_END from any active phase completes warmly (§9.5 hard cap)", () => {
    const midListening = run([
      { type: "START" },
      { type: "VIDEO_DONE" },
      { type: "SPEAK_ENDED" },
      { type: "SESSION_END" },
    ]);
    expect(midListening.state.phase).toBe("complete");
    expect(kinds(midListening.all[3] ?? [])).toEqual(["LISTEN_STOP", "EPISODE_COMPLETE"]);

    const midVideo = run([{ type: "START" }, { type: "SESSION_END" }]);
    expect(midVideo.state.phase).toBe("complete");

    // Idle and complete are no-ops — no goodbye before hello, no double end.
    expect(engineTransition(initialEngineState, { type: "SESSION_END" }, EP, "en").next.phase).toBe("idle");
  });

  it("onMiss lines resolve per language via the <base>_<lang> convention", () => {
    const { all } = run(
      [{ type: "START" }, { type: "VIDEO_DONE" }, { type: "SPEAK_ENDED" }, { type: "LISTEN_TIMEOUT" }],
      "te",
    );
    const retry = (all[3] ?? []).find((e) => e.type === "PLAY_LINE");
    expect(retry).toMatchObject({ audio: "cp1_retry_te.m4a" });
  });
});
