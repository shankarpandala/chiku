import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CreateRoomResponseSchema,
  RoomHubMessageSchema,
  type RoomClientMessage,
  type RoomHubMessage,
  type RoomRole,
  type RoomState,
} from "@chiku/schema";
import { createApp } from "../src/app";
import { selectBrain } from "../src/providers/brain";
import { RuleBrain } from "../src/providers/brain/rule";
import {
  freshRoomState,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_TTL_MS,
  RoomRegistry,
  type RoomMember,
} from "../src/rooms";

const CODE_RE = /^[2-9A-HJ-NP-Z]{4}$/;

/** In-memory socket double: records every (schema-valid) frame it is sent. */
function testMember() {
  const frames: RoomHubMessage[] = [];
  let closed = false;
  const member: RoomMember = {
    send(data: string) {
      // Every frame the hub emits must cross RoomHubMessageSchema cleanly.
      frames.push(RoomHubMessageSchema.parse(JSON.parse(data)));
    },
    close() {
      closed = true;
    },
  };
  const rooms = () => frames.filter((f) => f.type === "room");
  return {
    member,
    frames,
    isClosed: () => closed,
    roomFrames: rooms,
    lastRoom(): RoomState {
      const last = rooms().at(-1);
      if (last === undefined || last.type !== "room") throw new Error("no room frame received");
      return last.room;
    },
  };
}

function send(
  reg: RoomRegistry,
  code: string,
  role: RoomRole,
  sender: RoomMember,
  msg: RoomClientMessage | Record<string, unknown>,
): void {
  reg.handleMessage(code, role, JSON.stringify(msg), sender);
}

const utterance = (text: string, conf = 0.9, ts = 1234): RoomClientMessage => ({
  type: "utterance",
  utterance: { text, conf, ts },
});

describe("room codes", () => {
  it("uses exactly the characters the schema regex accepts", () => {
    // 2-9 + A-Z minus I and O (ambiguous with 1/0) = 32 chars.
    expect(ROOM_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(32);
    for (const ch of ROOM_CODE_ALPHABET) {
      expect(ch).toMatch(/^[2-9A-HJ-NP-Z]$/);
    }
    for (const forbidden of ["0", "1", "I", "O"]) {
      expect(ROOM_CODE_ALPHABET.includes(forbidden)).toBe(false);
    }
  });

  it("mints schema-valid 4-char codes", () => {
    const reg = new RoomRegistry();
    for (let i = 0; i < 50; i += 1) {
      const code = reg.createRoom();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(code).toMatch(CODE_RE);
      expect(CreateRoomResponseSchema.parse({ code })).toEqual({ code });
    }
  });

  it("seeds a fresh schema-valid room per §7", () => {
    const room = freshRoomState(42);
    expect(room.createdAt).toBe(42);
    expect(room.state).toEqual({
      mode: "player",
      episodeId: "pending",
      segIdx: 0,
      phase: "playing",
      lastUtterance: { text: "", conf: 0, ts: 0 },
      playAudio: { url: "", marks: "", nonce: 0 },
    });
    expect(room.control).toEqual({ pause: false, end: false, volume: 0.8 });
    expect(room.stage).toBeUndefined();
    expect(room.mic).toBeUndefined();
  });
});

describe("TTL sweep on create (§7 auto-expiry)", () => {
  it("drops memberless rooms older than the TTL", () => {
    let now = 1_000_000;
    const reg = new RoomRegistry({ now: () => now });
    const stale = reg.createRoom();
    now += ROOM_TTL_MS + 1;
    const fresh = reg.createRoom(); // sweep runs here
    expect(reg.room(stale)).toBeUndefined();
    expect(reg.room(fresh)).toBeDefined();
  });

  it("keeps rooms younger than the TTL and rooms with a connected member", () => {
    let now = 1_000_000;
    const reg = new RoomRegistry({ now: () => now });
    const young = reg.createRoom();
    const occupied = reg.createRoom();
    expect(reg.join(occupied, "stage", testMember().member)).toBe(true);

    now += ROOM_TTL_MS - 1;
    reg.createRoom();
    expect(reg.room(young)).toBeDefined(); // not old enough

    now += 2; // past the TTL for both original rooms
    reg.createRoom();
    expect(reg.room(young)).toBeUndefined();
    expect(reg.room(occupied)).toBeDefined(); // stage still connected
  });
});

describe("join / presence", () => {
  it("rejects an unknown room code with an error frame and closes", () => {
    const reg = new RoomRegistry();
    const t = testMember();
    expect(reg.join("ZZZZ", "mic", t.member)).toBe(false);
    expect(t.frames).toHaveLength(1);
    expect(t.frames[0]).toEqual({
      type: "error",
      message: expect.stringContaining("unknown room code") as string,
    });
    expect(t.isClosed()).toBe(true);
  });

  it("rejects a duplicate role and leaves the original untouched", () => {
    const reg = new RoomRegistry();
    const code = reg.createRoom();
    const first = testMember();
    const dup = testMember();
    expect(reg.join(code, "stage", first.member)).toBe(true);
    expect(reg.join(code, "stage", dup.member)).toBe(false);
    expect(dup.frames[0]).toEqual({
      type: "error",
      message: expect.stringContaining("already connected") as string,
    });
    expect(dup.isClosed()).toBe(true);
    // The refused socket's close must not evict the original member.
    reg.leave(code, "stage", dup.member);
    expect(reg.room(code)?.stage).toEqual({ connected: true });
    expect(first.isClosed()).toBe(false);
  });

  it("broadcasts presence on join and leave, and allows rejoin (recovery)", () => {
    const reg = new RoomRegistry();
    const code = reg.createRoom();
    const stage = testMember();
    const mic = testMember();

    reg.join(code, "stage", stage.member);
    expect(stage.lastRoom().stage).toEqual({ connected: true });
    expect(stage.lastRoom().mic).toBeUndefined();

    reg.join(code, "mic", mic.member);
    // Both members got the new snapshot with both roles present.
    expect(stage.lastRoom().mic).toEqual({ connected: true });
    expect(mic.lastRoom().stage).toEqual({ connected: true });

    // Mic drops (onDisconnect equivalent): stage is told, presence flips.
    reg.leave(code, "mic", mic.member);
    expect(stage.lastRoom().mic).toEqual({ connected: false });

    // Pulling out of the room mid-episode recovers gracefully: rejoin works.
    const mic2 = testMember();
    expect(reg.join(code, "mic", mic2.member)).toBe(true);
    expect(stage.lastRoom().mic).toEqual({ connected: true });
  });
});

describe("message handling (§7 rules, server-enforced)", () => {
  function pairedRoom() {
    const reg = new RoomRegistry();
    const code = reg.createRoom();
    const stage = testMember();
    const mic = testMember();
    reg.join(code, "stage", stage.member);
    reg.join(code, "mic", mic.member);
    return { reg, code, stage, mic };
  }

  it("rejects malformed JSON and off-contract frames without broadcasting", () => {
    const { reg, code, stage, mic } = pairedRoom();
    const before = stage.roomFrames().length;
    reg.handleMessage(code, "mic", "not json{", mic.member);
    send(reg, code, "mic", mic.member, { type: "utterance", utterance: { text: 1 } });
    expect(stage.roomFrames()).toHaveLength(before); // nothing broadcast
    expect(mic.frames.filter((f) => f.type === "error")).toHaveLength(2);
    expect(mic.isClosed()).toBe(false); // rejection is not terminal
  });

  it("mic may not send state; stage may not send utterance or control", () => {
    const { reg, code, stage, mic } = pairedRoom();
    const before = stage.roomFrames().length;
    const stolenState = { ...stage.lastRoom().state, phase: "celebrating" as const };

    send(reg, code, "mic", mic.member, { type: "state", state: stolenState });
    send(reg, code, "stage", stage.member, utterance("green"));
    send(reg, code, "stage", stage.member, { type: "control", control: { pause: true } });

    expect(reg.room(code)?.state.phase).toBe("playing"); // unchanged
    expect(reg.room(code)?.control.pause).toBe(false);
    expect(stage.roomFrames()).toHaveLength(before);
    expect(mic.frames.at(-1)).toEqual({
      type: "error",
      message: expect.stringContaining('may not send "state"') as string,
    });
    expect(stage.frames.filter((f) => f.type === "error")).toHaveLength(2);
  });

  it("mic utterance lands in state.lastUtterance and broadcasts to both", () => {
    const { reg, code, stage, mic } = pairedRoom();
    send(reg, code, "mic", mic.member, utterance("paccha", 0.87, 111));
    const expected = { text: "paccha", conf: 0.87, ts: 111 };
    expect(reg.room(code)?.state.lastUtterance).toEqual(expected);
    expect(stage.lastRoom().state.lastUtterance).toEqual(expected);
    expect(mic.lastRoom().state.lastUtterance).toEqual(expected);
  });

  it("stage state merge preserves the mic-owned lastUtterance", () => {
    const { reg, code, stage, mic } = pairedRoom();
    send(reg, code, "mic", mic.member, utterance("paccha", 0.87, 111));

    // The stage echoes zeros for lastUtterance (§7: the mic owns that path).
    send(reg, code, "stage", stage.member, {
      type: "state",
      state: {
        mode: "player",
        episodeId: "ep001",
        segIdx: 2,
        phase: "listening",
        lastUtterance: { text: "", conf: 0, ts: 0 },
        playAudio: { url: "/media/x.m4a", marks: "", nonce: 1 },
      },
    });

    const room = reg.room(code);
    expect(room?.state.episodeId).toBe("ep001");
    expect(room?.state.segIdx).toBe(2);
    expect(room?.state.phase).toBe("listening");
    expect(room?.state.playAudio.nonce).toBe(1);
    // The mic's utterance survived the stage's zeroed echo.
    expect(room?.state.lastUtterance).toEqual({ text: "paccha", conf: 0.87, ts: 111 });
    expect(mic.lastRoom().state.lastUtterance.text).toBe("paccha");
  });

  it("control messages shallow-merge, keeping unmentioned keys", () => {
    const { reg, code, mic } = pairedRoom();
    send(reg, code, "mic", mic.member, { type: "control", control: { pause: true } });
    expect(reg.room(code)?.control).toEqual({ pause: true, end: false, volume: 0.8 });

    send(reg, code, "mic", mic.member, { type: "control", control: { volume: 0.4 } });
    expect(reg.room(code)?.control).toEqual({ pause: true, end: false, volume: 0.4 });

    send(reg, code, "mic", mic.member, { type: "control", control: { end: true, pause: false } });
    expect(reg.room(code)?.control).toEqual({ pause: false, end: true, volume: 0.4 });
  });
});

describe("POST /rooms", () => {
  const FIXTURE_MEDIA = fileURLToPath(new URL("fixtures/media", import.meta.url));

  it("mints a room and returns 201 with a schema-valid code", async () => {
    const rooms = new RoomRegistry();
    const app = createApp({
      mediaDir: FIXTURE_MEDIA,
      allowedOrigin: "http://localhost:5173",
      brain: new RuleBrain(FIXTURE_MEDIA),
      rooms,
    });
    const res = await app.request("/rooms", { method: "POST" });
    expect(res.status).toBe(201);
    const body = CreateRoomResponseSchema.parse(await res.json());
    expect(body.code).toMatch(CODE_RE);
    // The minted room is live in the shared registry the WS hub uses.
    expect(rooms.room(body.code)).toBeDefined();
  });
});

// --- vendor compliance gate (see providers/brain/index.ts) -------------------

describe("brain selection is compliance-gated", () => {
  it("never auto-selects Gemini just because a key is present", () => {
    const brain = selectBrain("/tmp", { GEMINI_API_KEY: "sk-test" } as NodeJS.ProcessEnv);
    expect(brain).toBeInstanceOf(RuleBrain);
  });

  it("refuses BRAIN=gemini without the explicit under-18 acknowledgement", () => {
    expect(() =>
      selectBrain("/tmp", { BRAIN: "gemini", GEMINI_API_KEY: "sk-test" } as NodeJS.ProcessEnv),
    ).toThrow(/under-18/i);
  });

  it("allows it only with the acknowledgement (adult QA path)", () => {
    const brain = selectBrain("/tmp", {
      BRAIN: "gemini",
      GEMINI_API_KEY: "sk-test",
      I_ACKNOWLEDGE_GEMINI_IS_NOT_FOR_UNDER_18_SURFACES: "true",
    } as NodeJS.ProcessEnv);
    expect(brain).not.toBeInstanceOf(RuleBrain);
  });
});
