// Room pairing client — the web side of the §7 room contract over the local
// WS hub (D6 amendment: local-first swaps RTDB for a WS hub in services/api;
// this module is the ONLY place that knows the transport, so RTDB can slot
// back in behind the same interface).
//
// §7 rules live in the types: a mic can only send utterances + control; the
// stage alone publishes `state`. Every inbound message crosses zod.

import {
  CreateRoomResponseSchema,
  RoomHubMessageSchema,
  type RoomClientMessage,
  type RoomRole,
  type RoomState,
} from "@chiku/schema";
import { API_BASE } from "../episodes/client";

export type RoomStatus = "connecting" | "open" | "closed";

export interface RoomConnection {
  readonly code: string;
  readonly role: RoomRole;
  send(msg: RoomClientMessage): void;
  onRoom(cb: (room: RoomState) => void): () => void;
  onStatus(cb: (status: RoomStatus) => void): () => void;
  close(): void;
}

export async function createRoom(): Promise<string> {
  const res = await fetch(`${API_BASE}/rooms`, { method: "POST" });
  if (!res.ok) throw new Error(`POST /rooms → ${res.status}`);
  return CreateRoomResponseSchema.parse(await res.json()).code;
}

function wsUrl(code: string, role: RoomRole): string {
  const http = new URL(API_BASE);
  const proto = http.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${http.host}/rooms/${encodeURIComponent(code)}/ws?role=${role}`;
}

export function joinRoom(code: string, role: RoomRole): RoomConnection {
  const roomSubs = new Set<(room: RoomState) => void>();
  const statusSubs = new Set<(s: RoomStatus) => void>();
  let status: RoomStatus = "connecting";
  let closedByUser = false;

  const setStatus = (s: RoomStatus): void => {
    status = s;
    for (const cb of [...statusSubs]) cb(s);
  };

  const ws = new WebSocket(wsUrl(code, role));
  ws.onopen = () => setStatus("open");
  ws.onclose = () => setStatus("closed");
  ws.onerror = () => {
    if (status !== "closed") setStatus("closed");
  };
  ws.onmessage = (ev: MessageEvent) => {
    let parsed;
    try {
      parsed = RoomHubMessageSchema.parse(JSON.parse(String(ev.data)));
    } catch {
      return; // never act on off-contract data
    }
    if (parsed.type === "room") {
      for (const cb of [...roomSubs]) cb(parsed.room);
    } else {
      console.warn(`[chiku] room ${code}: ${parsed.message}`);
      ws.close();
    }
  };

  return {
    code,
    role,
    send(msg: RoomClientMessage): void {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    onRoom(cb) {
      roomSubs.add(cb);
      return () => roomSubs.delete(cb);
    },
    onStatus(cb) {
      statusSubs.add(cb);
      cb(status);
      return () => statusSubs.delete(cb);
    },
    close(): void {
      if (closedByUser) return;
      closedByUser = true;
      ws.close();
    },
  };
}
