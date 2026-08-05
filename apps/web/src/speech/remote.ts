// RemoteSpeechEngine — the stage's "microphone" when a phone is paired: it
// implements the same SpeechEngine interface the Player already consumes,
// but results arrive as room utterances written by the mic device (§7).
// Only text ever crosses the network — STT ran on the phone (§9.1/D1).

import type { RoomConnection } from "../session/room";
import type { SpeechEngine, SpeechResult } from "./webspeech";

export function createRemoteSpeech(room: RoomConnection): SpeechEngine {
  const subs = new Set<(r: SpeechResult) => void>();
  let listening = false;
  let lastTs = 0;

  room.onRoom((state) => {
    const u = state.state.lastUtterance;
    if (!listening) {
      // Track without firing: an utterance from before we started listening
      // must never replay into a later listening window.
      lastTs = Math.max(lastTs, u.ts);
      return;
    }
    if (u.text === "" || u.ts <= lastTs) return;
    lastTs = u.ts;
    for (const cb of [...subs]) {
      cb({ text: u.text, conf: u.conf, isFinal: true, tsMs: performance.now() });
    }
  });

  return {
    available: true, // the paired phone is the mic; readiness shows in room presence
    start(): void {
      listening = true;
    },
    stop(): void {
      listening = false;
    },
    onResult(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    onEnd: () => () => undefined, // the remote mic never self-terminates
    onError: () => () => undefined,
  };
}
