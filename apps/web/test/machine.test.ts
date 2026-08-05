import { describe, expect, it } from "vitest";
import { CP1 } from "../src/loop/checkpoint";
import {
  initialLoopState,
  transition,
  type LoopEffect,
  type LoopEvent,
  type LoopState,
} from "../src/loop/machine";

function run(events: LoopEvent[], from: LoopState = initialLoopState): { state: LoopState; all: LoopEffect[][] } {
  let state = from;
  const all: LoopEffect[][] = [];
  for (const e of events) {
    const r = transition(state, e, CP1);
    state = r.next;
    all.push(r.effects);
  }
  return { state, all };
}

const heard = (text: string): LoopEvent => ({ type: "HEARD", text, conf: 0.9, tsMs: 1000 });

describe("checkpoint loop machine", () => {
  it("happy path: ask → listen → match → praise → done", () => {
    const { state, all } = run([
      { type: "START" },
      { type: "SPEAK_ENDED" }, // ask finished
      heard("green"),
      { type: "SPEAK_ENDED" }, // praise finished
    ]);
    expect(all[0]).toEqual([{ type: "PLAY", line: "ask" }]);
    expect(all[1]).toEqual([{ type: "LISTEN_START" }]);
    expect(all[2]).toEqual([
      { type: "LISTEN_STOP" },
      { type: "MATCHED", result: { id: "green", score: 1, matched: "green" }, heardAtMs: 1000 },
      { type: "PLAY", line: "praise", celebrate: true },
    ]);
    expect(state.phase).toBe("done");
    expect(state.won).toBe(true);
  });

  it("transliterated Telugu answers take the same fast path", () => {
    const { all } = run([{ type: "START" }, { type: "SPEAK_ENDED" }, heard("paccha")]);
    const effects = all[2] ?? [];
    expect(effects.some((e) => e.type === "MATCHED" && e.result.id === "green")).toBe(true);
    expect(effects.some((e) => e.type === "PLAY" && e.line === "praise")).toBe(true);
  });

  it("a wrong answer earns one gentle retry, then say-it-together — never a dead end", () => {
    const { state, all } = run([
      { type: "START" },
      { type: "SPEAK_ENDED" },
      heard("blue"), // miss 1 → retry
      { type: "SPEAK_ENDED" }, // retry line finished → listening again
      heard("the sky"), // miss 2 → together
      { type: "SPEAK_ENDED" }, // together finished
    ]);
    expect(all[2]).toEqual([{ type: "LISTEN_STOP" }, { type: "PLAY", line: "retry" }]);
    expect(all[3]).toEqual([{ type: "LISTEN_START" }]);
    expect(all[4]).toEqual([{ type: "LISTEN_STOP" }, { type: "PLAY", line: "together" }]);
    expect(state.phase).toBe("done");
    expect(state.won).toBe(false); // said-it-together is warm, but not a win to celebrate
  });

  it("ignores empty or noise-only utterances — silence belongs to the timeout, not the retry counter", () => {
    const listening: LoopState = { phase: "listening", misses: 0, won: false };
    for (const noise of ["", "   ", "..."]) {
      const r = transition(listening, heard(noise), CP1);
      expect(r.next).toEqual(listening);
      expect(r.effects).toEqual([]);
    }
  });

  it("silence times out into the same retry chain (§8 step 5)", () => {
    const { state, all } = run([
      { type: "START" },
      { type: "SPEAK_ENDED" },
      { type: "LISTEN_TIMEOUT" },
      { type: "SPEAK_ENDED" },
      { type: "LISTEN_TIMEOUT" },
    ]);
    expect(all[2]?.some((e) => e.type === "PLAY" && e.line === "retry")).toBe(true);
    expect(all[4]?.some((e) => e.type === "PLAY" && e.line === "together")).toBe(true);
    expect(state.phase).toBe("together");
  });

  it("recovers after a retry: correct answer still celebrates", () => {
    const { state, all } = run([
      { type: "START" },
      { type: "SPEAK_ENDED" },
      heard("blue"),
      { type: "SPEAK_ENDED" },
      heard("pachcha"),
    ]);
    expect(all[4]?.some((e) => e.type === "PLAY" && e.line === "praise")).toBe(true);
    expect(state.phase).toBe("celebrating");
  });

  it("done → START replays with a clean miss counter and win flag", () => {
    const end: LoopState = { phase: "done", misses: 2, won: true };
    const r = transition(end, { type: "START" }, CP1);
    expect(r.next).toEqual({ phase: "asking", misses: 0, won: false });
    expect(r.effects).toEqual([{ type: "PLAY", line: "ask" }]);
  });

  it("ignores stray events (HEARD while asking, SPEAK_ENDED while idle)", () => {
    expect(transition(initialLoopState, { type: "SPEAK_ENDED" }, CP1).next.phase).toBe("idle");
    const asking: LoopState = { phase: "asking", misses: 0, won: false };
    expect(transition(asking, heard("green"), CP1).next.phase).toBe("asking");
  });

  // §10 latency-harness seed: the HEARD → praise decision is synchronous work.
  it("decides HEARD → praise well inside the 400ms budget", () => {
    const listening: LoopState = { phase: "listening", misses: 0, won: false };
    const t0 = performance.now();
    const r = transition(listening, heard("it's green"), CP1);
    const elapsed = performance.now() - t0;
    expect(r.effects.some((e) => e.type === "PLAY" && e.line === "praise")).toBe(true);
    expect(elapsed).toBeLessThan(50); // decision cost; audio start is the rig's job
  });
});
