import { beforeEach, describe, expect, it } from "vitest";
import { clearSession, getSession, recordEntry, sessionStats, startSession } from "../src/session/transcript";

describe("session transcript (D9: session-scoped, in-memory only)", () => {
  beforeEach(() => clearSession());

  it("records entries under the running session", () => {
    startSession("ep001");
    recordEntry({ checkpointId: "cp1", outcome: "matched-local", heard: "green", matchId: "green" });
    recordEntry({ checkpointId: "cp2", outcome: "silence" });
    const s = getSession();
    expect(s?.episodeId).toBe("ep001");
    expect(s?.entries).toHaveLength(2);
    expect(s?.entries[0]?.at).toBeTypeOf("number");
  });

  it("computes stats: turns count only heard utterances, matched counts both paths", () => {
    startSession("ep001");
    recordEntry({ checkpointId: "cp1", outcome: "matched-local", heard: "it's green", matchId: "green" });
    recordEntry({ checkpointId: "cp2", outcome: "matched-brain", heard: "like a leaf", matchId: "green" });
    recordEntry({ checkpointId: "cp3", outcome: "silence" });
    recordEntry({ checkpointId: "cp3", outcome: "together" });
    const stats = sessionStats(getSession()!);
    expect(stats.turns).toBe(2);
    expect(stats.matched).toBe(2);
    expect(stats.wordsHeard).toBe(5);
  });

  it("a new session replaces the old one; recording without a session is a no-op", () => {
    recordEntry({ checkpointId: "cpX", outcome: "retry" }); // no session yet
    expect(getSession()).toBeNull();
    startSession("ep001");
    startSession("ep002");
    expect(getSession()?.episodeId).toBe("ep002");
    expect(getSession()?.entries).toHaveLength(0);
  });
});
