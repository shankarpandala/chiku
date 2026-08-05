import { describe, expect, it } from "vitest";

import { RoomStateSchema } from "../src/index";

const validRoom = () => ({
  createdAt: 1754350000000,
  stage: { connected: true },
  mic: { connected: true },
  state: {
    mode: "player" as const,
    episodeId: "ep001",
    segIdx: 2,
    phase: "listening" as const,
    lastUtterance: { text: "పచ్చ", conf: 0.87, ts: 1754350012345 },
    playAudio: {
      url: "/media/ep001/cp1_ask_te.mp3",
      marks: "/media/ep001/cp1_marks.json",
      nonce: 3,
    },
  },
  control: { pause: false, end: false, volume: 0.8 },
});

describe("RoomState schema", () => {
  it("round-trips a full room snapshot unchanged", () => {
    const room = validRoom();
    expect(RoomStateSchema.parse(room)).toEqual(room);
  });

  it("accepts a snapshot with mic presence removed (onDisconnect)", () => {
    const { mic: _mic, ...withoutMic } = validRoom();
    const parsed = RoomStateSchema.parse(withoutMic);
    expect(parsed.mic).toBeUndefined();
    expect(parsed.stage?.connected).toBe(true);
  });

  it("round-trips every phase and mode", () => {
    for (const phase of [
      "playing",
      "asking",
      "listening",
      "responding",
      "celebrating",
    ] as const) {
      for (const mode of ["player", "call"] as const) {
        const room = validRoom();
        const next = { ...room, state: { ...room.state, phase, mode } };
        expect(RoomStateSchema.parse(next)).toEqual(next);
      }
    }
  });

  it("rejects an unknown phase", () => {
    const room = validRoom();
    const bad = { ...room, state: { ...room.state, phase: "dancing" } };
    expect(RoomStateSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown mode", () => {
    const room = validRoom();
    const bad = { ...room, state: { ...room.state, mode: "movie" } };
    expect(RoomStateSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects out-of-range volume and confidence", () => {
    const room = validRoom();
    expect(
      RoomStateSchema.safeParse({
        ...room,
        control: { ...room.control, volume: 1.5 },
      }).success,
    ).toBe(false);
    expect(
      RoomStateSchema.safeParse({
        ...room,
        state: {
          ...room.state,
          lastUtterance: { ...room.state.lastUtterance, conf: -0.1 },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a negative segIdx and a non-integer nonce", () => {
    const room = validRoom();
    expect(
      RoomStateSchema.safeParse({
        ...room,
        state: { ...room.state, segIdx: -1 },
      }).success,
    ).toBe(false);
    expect(
      RoomStateSchema.safeParse({
        ...room,
        state: {
          ...room.state,
          playAudio: { ...room.state.playAudio, nonce: 1.5 },
        },
      }).success,
    ).toBe(false);
  });
});
