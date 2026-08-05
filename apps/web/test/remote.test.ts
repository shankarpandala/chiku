import { describe, expect, it } from "vitest";
import type { RoomClientMessage, RoomState } from "@chiku/schema";
import type { RoomConnection } from "../src/session/room";
import { createRemoteSpeech } from "../src/speech/remote";
import type { SpeechResult } from "../src/speech/webspeech";

function fakeRoom(): { conn: RoomConnection; push: (utterance: { text: string; conf: number; ts: number }) => void } {
  const subs = new Set<(room: RoomState) => void>();
  const snapshot = (utterance: { text: string; conf: number; ts: number }): RoomState => ({
    createdAt: 0,
    stage: { connected: true },
    mic: { connected: true },
    state: {
      mode: "player",
      episodeId: "ep001",
      segIdx: 1,
      phase: "listening",
      lastUtterance: utterance,
      playAudio: { url: "", marks: "", nonce: 0 },
    },
    control: { pause: false, end: false, volume: 0.8 },
  });
  return {
    conn: {
      code: "AB7K",
      role: "stage",
      send: (_msg: RoomClientMessage) => undefined,
      onRoom: (cb) => {
        subs.add(cb);
        return () => subs.delete(cb);
      },
      onStatus: () => () => undefined,
      close: () => undefined,
    },
    push: (utterance) => {
      for (const cb of [...subs]) cb(snapshot(utterance));
    },
  };
}

describe("createRemoteSpeech (the stage's paired-phone mic)", () => {
  it("fires final results only while listening", () => {
    const { conn, push } = fakeRoom();
    const engine = createRemoteSpeech(conn);
    const heard: SpeechResult[] = [];
    engine.onResult((r) => heard.push(r));

    push({ text: "too early", conf: 0.9, ts: 100 });
    expect(heard).toHaveLength(0);

    engine.start("en-IN");
    push({ text: "green", conf: 0.9, ts: 200 });
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ text: "green", conf: 0.9, isFinal: true });

    engine.stop();
    push({ text: "after stop", conf: 0.9, ts: 300 });
    expect(heard).toHaveLength(1);
  });

  it("never replays a stale utterance into a new listening window", () => {
    const { conn, push } = fakeRoom();
    const engine = createRemoteSpeech(conn);
    const heard: SpeechResult[] = [];
    engine.onResult((r) => heard.push(r));

    // Utterance arrives while NOT listening (e.g. during Chiku's praise)…
    push({ text: "old answer", conf: 0.9, ts: 500 });
    engine.start("en-IN");
    // …a snapshot with the SAME utterance must not fire now.
    push({ text: "old answer", conf: 0.9, ts: 500 });
    expect(heard).toHaveLength(0);

    push({ text: "fresh answer", conf: 0.8, ts: 600 });
    expect(heard).toHaveLength(1);
    expect(heard[0]?.text).toBe("fresh answer");
  });

  it("dedupes repeated snapshots of the same utterance", () => {
    const { conn, push } = fakeRoom();
    const engine = createRemoteSpeech(conn);
    const heard: SpeechResult[] = [];
    engine.onResult((r) => heard.push(r));
    engine.start("en-IN");
    push({ text: "moodu", conf: 1, ts: 700 });
    push({ text: "moodu", conf: 1, ts: 700 }); // broadcast echo
    expect(heard).toHaveLength(1);
  });
});
