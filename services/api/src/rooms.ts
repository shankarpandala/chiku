import { randomInt } from "node:crypto";
import {
  RoomClientMessageSchema,
  RoomHubMessageSchema,
  RoomStateSchema,
  type RoomClientMessage,
  type RoomHubMessage,
  type RoomRole,
  type RoomState,
} from "@chiku/schema";

/**
 * In-memory room registry — the local-first pairing transport (D6 amendment:
 * the §7 RTDB room contract carried over a WS hub in this process). This
 * module owns all room state and message rules; the WebSocket endpoint in
 * app.ts is a thin adapter, so the logic here is unit-testable without a
 * live socket.
 *
 * §9 note: lifecycle logging only, and NEVER the utterance text.
 */

/**
 * Exactly the characters `CreateRoomResponseSchema`'s regex
 * `^[2-9A-HJ-NP-Z]{4}$` accepts: digits 2–9 and A–Z minus I and O
 * (0/O/1/I are excluded as visually ambiguous on a TV pairing screen).
 * 32 characters, so `randomInt` draws are uniform.
 */
export const ROOM_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export const ROOM_CODE_LENGTH = 4;

/** §7: rooms auto-expire — TTL cleanup runs on create of new rooms. */
export const ROOM_TTL_MS = 30 * 60_000;

/**
 * One connected socket, as the registry sees it. The WS adapter wraps the
 * real socket; tests substitute an in-memory recorder.
 */
export interface RoomMember {
  send(data: string): void;
  close(): void;
}

interface RoomEntry {
  room: RoomState;
  /** Currently connected sockets by role — a role vacates on disconnect. */
  members: Map<RoomRole, RoomMember>;
}

/** Fresh §7 room snapshot. `episodeId` is a placeholder until the stage
 *  publishes real state (RoomStateSchema requires a non-empty id). */
export function freshRoomState(createdAt: number): RoomState {
  return RoomStateSchema.parse({
    createdAt,
    state: {
      mode: "player",
      episodeId: "pending",
      segIdx: 0,
      phase: "playing",
      lastUtterance: { text: "", conf: 0, ts: 0 },
      playAudio: { url: "", marks: "", nonce: 0 },
    },
    control: { pause: false, end: false, volume: 0.8 },
  });
}

/** Serialize a hub frame, zod-validated on the way out (§7 boundary). */
export function hubFrame(msg: RoomHubMessage): string {
  return JSON.stringify(RoomHubMessageSchema.parse(msg));
}

/** §7 write rules: the mic owns utterance + control; the stage owns state. */
function roleMaySend(role: RoomRole, type: RoomClientMessage["type"]): boolean {
  return role === "mic" ? type !== "state" : type === "state";
}

export interface RoomRegistryOptions {
  /** Clock override (TTL tests). Default Date.now. */
  now?: () => number;
  /** TTL override (tests). Default ROOM_TTL_MS. */
  ttlMs?: number;
}

export class RoomRegistry {
  private readonly entries = new Map<string, RoomEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: RoomRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? ROOM_TTL_MS;
  }

  /** Mint a room. Sweeps expired rooms first (§7 TTL cleanup on create). */
  createRoom(): string {
    this.sweep();
    let code: string;
    do {
      code = this.mintCode();
    } while (this.entries.has(code));
    this.entries.set(code, { room: freshRoomState(this.now()), members: new Map() });
    console.log(`[chiku-api] room ${code} created (${this.entries.size} active)`);
    return code;
  }

  /** Test/introspection accessor — the live room snapshot, if any. */
  room(code: string): RoomState | undefined {
    return this.entries.get(code)?.room;
  }

  /**
   * A socket joins as stage or mic. Unknown code or an already-connected
   * role → {type:"error"} then close (the §7 "duplicate role" rule). On
   * success: presence {connected:true} + broadcast (the onDisconnect
   * counterpart lives in leave()).
   */
  join(code: string, role: RoomRole, member: RoomMember): boolean {
    const entry = this.entries.get(code);
    if (entry === undefined) {
      this.refuse(member, `unknown room code ${code}`);
      return false;
    }
    if (entry.members.has(role)) {
      this.refuse(member, `role ${role} is already connected to room ${code}`);
      return false;
    }
    entry.members.set(role, member);
    entry.room[role] = { connected: true };
    console.log(`[chiku-api] room ${code}: ${role} joined`);
    this.broadcast(entry);
    return true;
  }

  /** Socket closed — presence {connected:false}, broadcast (≙ onDisconnect). */
  leave(code: string, role: RoomRole, member: RoomMember): void {
    const entry = this.entries.get(code);
    // Identity check: a refused duplicate's close must not evict the original.
    if (entry === undefined || entry.members.get(role) !== member) return;
    entry.members.delete(role);
    entry.room[role] = { connected: false };
    console.log(`[chiku-api] room ${code}: ${role} left`);
    this.broadcast(entry);
  }

  /**
   * One inbound frame. Every frame crosses RoomClientMessageSchema, then the
   * §7 role rules; accepted changes mutate the room and broadcast a full
   * snapshot. Rejections answer the sender only.
   */
  handleMessage(code: string, role: RoomRole, raw: string, sender: RoomMember): void {
    const entry = this.entries.get(code);
    if (entry === undefined) {
      this.refuse(sender, `unknown room code ${code}`);
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.reject(sender, code, role, "frame is not valid JSON");
      return;
    }
    const parsed = RoomClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.reject(sender, code, role, "off-contract message");
      return;
    }
    const msg = parsed.data;
    if (!roleMaySend(role, msg.type)) {
      this.reject(sender, code, role, `role ${role} may not send "${msg.type}"`);
      return;
    }
    switch (msg.type) {
      case "utterance":
        // The mic owns state.lastUtterance (§7).
        entry.room.state.lastUtterance = msg.utterance;
        break;
      case "control":
        // Shallow-merge: only the keys the mic actually sent.
        if (msg.control.pause !== undefined) entry.room.control.pause = msg.control.pause;
        if (msg.control.end !== undefined) entry.room.control.end = msg.control.end;
        if (msg.control.volume !== undefined) entry.room.control.volume = msg.control.volume;
        break;
      case "state":
        // The stage owns state — but the mic owns lastUtterance, and the
        // stage echoes zeros, so the room's copy is preserved (§7).
        entry.room.state = { ...msg.state, lastUtterance: entry.room.state.lastUtterance };
        break;
    }
    this.broadcast(entry);
  }

  /** Full-room snapshot to every connected member after each accepted change. */
  private broadcast(entry: RoomEntry): void {
    const data = hubFrame({ type: "room", room: entry.room });
    for (const member of entry.members.values()) {
      try {
        member.send(data);
      } catch {
        // A dying socket must not take the broadcast down; its own close
        // event will run the leave() path.
      }
    }
  }

  /** Terminal rejection: error frame, then close (unknown room, dup role). */
  private refuse(member: RoomMember, message: string): void {
    console.warn(`[chiku-api] room join refused: ${message}`);
    try {
      member.send(hubFrame({ type: "error", message }));
    } catch {
      /* socket already gone */
    }
    try {
      member.close();
    } catch {
      /* socket already gone */
    }
  }

  /** Non-terminal rejection: error frame to the sender, connection stays. */
  private reject(sender: RoomMember, code: string, role: RoomRole, message: string): void {
    // Message contents are never logged — only the rejection reason (§9).
    console.warn(`[chiku-api] room ${code}: rejected frame from ${role}: ${message}`);
    try {
      sender.send(hubFrame({ type: "error", message }));
    } catch {
      /* socket already gone */
    }
  }

  private mintCode(): string {
    let code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
      code += ROOM_CODE_ALPHABET.charAt(randomInt(ROOM_CODE_ALPHABET.length));
    }
    return code;
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, entry] of this.entries) {
      if (entry.members.size === 0 && now - entry.room.createdAt > this.ttlMs) {
        this.entries.delete(code);
        console.log(`[chiku-api] room ${code} expired`);
      }
    }
  }
}
