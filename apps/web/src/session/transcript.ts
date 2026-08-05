// Session transcript — D9/§9: session-scoped, in-memory only. It exists so a
// parent can see what was said THIS session; nothing is persisted anywhere,
// and it dies with the tab. No analytics, no upload.

import type { TranscriptEntry } from "../player/engine";

export interface SessionRecord {
  episodeId: string;
  startedAt: number;
  entries: Array<TranscriptEntry & { at: number }>;
}

let current: SessionRecord | null = null;

export function startSession(episodeId: string): void {
  current = { episodeId, startedAt: Date.now(), entries: [] };
}

export function recordEntry(entry: TranscriptEntry): void {
  current?.entries.push({ ...entry, at: Date.now() });
}

export function getSession(): SessionRecord | null {
  return current;
}

export function clearSession(): void {
  current = null;
}

export interface SessionStats {
  turns: number;
  matched: number;
  /** Very rough talk proxy: words across heard utterances. */
  wordsHeard: number;
}

export function sessionStats(record: SessionRecord): SessionStats {
  const heardEntries = record.entries.filter((e) => e.heard !== undefined && e.heard !== "");
  return {
    turns: heardEntries.length,
    matched: record.entries.filter((e) => e.outcome === "matched-local" || e.outcome === "matched-brain").length,
    wordsHeard: heardEntries.reduce((n, e) => n + (e.heard as string).trim().split(/\s+/).length, 0),
  };
}
