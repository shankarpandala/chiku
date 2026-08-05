// Mic surface (M3): pairing header, tap-answer chips mirroring the room's
// checkpoint, hold-to-talk over an injected SpeechEngine, the two-step End
// control, and graceful rejoin after a dropped room.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Episode, RoomClientMessage, RoomState } from "@chiku/schema";
import en from "../src/i18n/en.json";
import { LangProvider } from "../src/i18n";
import type { SpeechEngine, SpeechResult } from "../src/speech/webspeech";

// Controllable room fake — vi.mock is hoisted, so shared state lives in
// vi.hoisted. Captures every message the mic sends; tests push snapshots
// and status changes through the captured subscribers.
const h = vi.hoisted(() => ({
  sent: [] as RoomClientMessage[],
  roomSubs: new Set<(room: unknown) => void>(),
  statusSubs: new Set<(s: string) => void>(),
  joins: [] as Array<{ code: string; role: string }>,
  episode: {
    id: "ep001",
    title: { te: "పరీక్ష", en: "Test" },
    langs: ["te", "en"],
    segments: [
      { type: "video", src: "seg1.mp4" },
      {
        type: "checkpoint",
        id: "cp1",
        ask: { audio: { te: "ask_te.mp3", en: "ask_en.mp3" } },
        listenMs: 6000,
        expect: [
          {
            id: "green",
            match: ["green", "paccha"],
            praise: { audio: { te: "p1_te.mp3", en: "p1_en.mp3" } },
          },
          {
            id: "three",
            match: ["three", "moodu"],
            praise: { audio: { te: "p2_te.mp3", en: "p2_en.mp3" } },
          },
        ],
        onMiss: { retryAudio: "cp1_retry", maxRetries: 1, fallbackAudio: "together" },
        escalate: false,
      },
    ],
  } as Episode,
}));

vi.mock("../src/session/room", () => ({
  joinRoom: (code: string, role: string) => {
    h.joins.push({ code, role });
    return {
      code,
      role,
      send: (msg: RoomClientMessage) => h.sent.push(msg),
      onRoom: (cb: (room: unknown) => void) => {
        h.roomSubs.add(cb);
        return () => h.roomSubs.delete(cb);
      },
      onStatus: (cb: (s: string) => void) => {
        h.statusSubs.add(cb);
        cb("open");
        return () => h.statusSubs.delete(cb);
      },
      close: () => undefined,
    };
  },
}));

vi.mock("../src/episodes/client", () => ({
  API_BASE: "http://localhost:8787",
  fetchEpisode: vi.fn(async () => h.episode),
}));

// Import AFTER the mocks so Mic binds to the fakes.
import { Mic } from "../src/surfaces/mic/Mic";

function roomSnapshot(overrides: {
  phase?: RoomState["state"]["phase"];
  stageConnected?: boolean;
  segIdx?: number;
  end?: boolean;
} = {}): RoomState {
  return {
    createdAt: 0,
    stage: { connected: overrides.stageConnected ?? true },
    mic: { connected: true },
    state: {
      mode: "player",
      episodeId: "ep001",
      segIdx: overrides.segIdx ?? 1,
      phase: overrides.phase ?? "playing",
      lastUtterance: { text: "", conf: 0, ts: 0 },
      playAudio: { url: "", marks: "", nonce: 0 },
    },
    control: { pause: false, end: overrides.end ?? false, volume: 0.8 },
  };
}

/** Async so the episode fetch a snapshot may trigger settles inside act. */
async function pushRoom(room: RoomState): Promise<void> {
  await act(async () => {
    for (const cb of [...h.roomSubs]) cb(room);
  });
}

function pushStatus(status: string): void {
  act(() => {
    for (const cb of [...h.statusSubs]) cb(status);
  });
}

/** Deterministic SpeechEngine: records start/stop, lets tests emit results. */
function fakeEngine() {
  const calls: string[] = [];
  const resultSubs = new Set<(r: SpeechResult) => void>();
  const engine: SpeechEngine & {
    calls: string[];
    emit: (text: string, conf: number) => void;
  } = {
    available: true,
    start: (lang: string) => calls.push(`start:${lang}`),
    stop: () => calls.push("stop"),
    onResult: (cb) => {
      resultSubs.add(cb);
      return () => resultSubs.delete(cb);
    },
    onEnd: () => () => undefined,
    onError: () => () => undefined,
    calls,
    emit: (text, conf) => {
      for (const cb of [...resultSubs]) cb({ text, conf, isFinal: true, tsMs: 0 });
    },
  };
  return engine;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.sent.length = 0;
  h.roomSubs.clear();
  h.statusSubs.clear();
  h.joins.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderMic(engine?: SpeechEngine): void {
  act(() => {
    root.render(
      <LangProvider>
        <Mic code="AB2C" onExit={() => undefined} engine={engine} />
      </LangProvider>,
    );
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("Mic", () => {
  it("joins the room as mic and shows waiting → paired", async () => {
    renderMic();
    expect(h.joins).toEqual([{ code: "AB2C", role: "mic" }]);
    expect(container.textContent).toContain(en["mic.waiting"]);
    expect(container.textContent).not.toContain(en["mic.pairedWith"]);

    await pushRoom(roomSnapshot({ stageConnected: false }));
    expect(container.textContent).toContain(en["mic.waiting"]);

    await pushRoom(roomSnapshot({ stageConnected: true }));
    expect(container.textContent).toContain(en["mic.pairedWith"]);
  });

  it("renders tap-answer chips for the current checkpoint while listening", async () => {
    renderMic();
    await pushRoom(roomSnapshot({ phase: "listening", segIdx: 1 }));

    expect(container.textContent).toContain(en["mic.tapAnswer"]);
    const chips = [...container.querySelectorAll("button.mic-chip")];
    expect(chips.map((c) => c.textContent)).toEqual([
      expect.stringContaining("green"),
      expect.stringContaining("three"),
    ]);
    // Counting chips mirror the Player's ● ● ● anchor.
    expect(chips[1]?.textContent).toContain("● ● ●");

    // Outside listening the chips hide and the pill mirrors the phase.
    await pushRoom(roomSnapshot({ phase: "asking", segIdx: 1 }));
    expect(container.querySelector("button.mic-chip")).toBeNull();
    expect(container.textContent).toContain(en["loop.chikuTalking"]);
    await pushRoom(roomSnapshot({ phase: "celebrating", segIdx: 1 }));
    expect(container.textContent).toContain(en["loop.done"]);
  });

  it("chip tap sends the first match spelling as a conf-1 utterance", async () => {
    renderMic();
    await pushRoom(roomSnapshot({ phase: "listening", segIdx: 1 }));

    const green = [...container.querySelectorAll("button.mic-chip")].find((c) =>
      c.textContent?.includes("green"),
    );
    expect(green).toBeDefined();
    click(green as Element);

    const last = h.sent.at(-1);
    expect(last?.type).toBe("utterance");
    if (last?.type !== "utterance") throw new Error("expected an utterance");
    expect(last.utterance.text).toBe("green");
    expect(last.utterance.conf).toBe(1);
    expect(last.utterance.ts).toBeGreaterThan(0);
  });

  it("push-to-talk holds the engine open and relays final results", () => {
    const engine = fakeEngine();
    renderMic(engine);
    const ptt = container.querySelector("button.mic-ptt");
    expect(ptt).not.toBeNull();
    expect(container.textContent).toContain(en["remote.holdToTalk"]);

    act(() => {
      ptt?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(engine.calls).toEqual(["start:en-IN"]);
    expect(container.textContent).toContain(en["mic.release"]);

    act(() => {
      engine.emit("paccha", 0.87);
    });
    const utterances = h.sent.filter((m) => m.type === "utterance");
    expect(utterances).toHaveLength(1);
    const only = utterances[0];
    if (only?.type !== "utterance") throw new Error("expected an utterance");
    expect(only.utterance.text).toBe("paccha");
    expect(only.utterance.conf).toBeCloseTo(0.87);

    act(() => {
      ptt?.dispatchEvent(new Event("pointerup", { bubbles: true }));
    });
    expect(engine.calls).toEqual(["start:en-IN", "stop"]);
    expect(container.textContent).toContain(en["remote.holdToTalk"]);
  });

  it("End is two-step, sends control.end, then shows the ended screen", async () => {
    renderMic();
    await pushRoom(roomSnapshot({}));

    const end = container.querySelector("button.mic-end");
    expect(end?.textContent).toBe("End");
    click(end as Element);
    // First tap only arms the confirm — nothing sent yet.
    expect(h.sent.filter((m) => m.type === "control")).toHaveLength(0);
    expect(container.querySelector("button.mic-end")?.textContent).toContain("End?");

    click(container.querySelector("button.mic-end") as Element);
    const control = h.sent.find((m) => m.type === "control");
    if (control?.type !== "control") throw new Error("expected a control message");
    expect(control.control.end).toBe(true);
    expect(container.textContent).toContain(en["mic.ended"]);
  });

  it("volume slider sends control.volume", () => {
    renderMic();
    const slider = container.querySelector("input[type=range]");
    if (slider === null) throw new Error("no volume slider");
    // Set via the prototype's setter so React's value tracker still sees a
    // change (a direct .value assignment is swallowed by the tracker).
    const setValue = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(slider) as object,
      "value",
    )?.set;
    act(() => {
      if (setValue !== undefined) setValue.call(slider, "0.5");
      else (slider as HTMLInputElement).value = "0.5";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const control = h.sent.at(-1);
    if (control?.type !== "control") throw new Error("expected a control message");
    expect(control.control.volume).toBe(0.5);
  });

  it("recovers gracefully from a dropped room: rejoin joins again", () => {
    renderMic();
    expect(h.joins).toHaveLength(1);

    pushStatus("closed");
    const rejoin = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === en["loop.again"],
    );
    expect(rejoin).toBeDefined();

    click(rejoin as Element);
    expect(h.joins).toHaveLength(2);
    expect(h.joins[1]).toEqual({ code: "AB2C", role: "mic" });
    // Back on the live surface after the rejoin.
    expect(container.querySelector("button.mic-ptt")).not.toBeNull();
  });

  it("ended snapshot from the room shows the ended screen", async () => {
    renderMic();
    await pushRoom(roomSnapshot({ end: true }));
    expect(container.textContent).toContain(en["mic.ended"]);
  });
});
