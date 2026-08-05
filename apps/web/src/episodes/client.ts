// API client — every response crosses a zod boundary (CLAUDE.md rule).
// The web app carries zero secrets: VITE_API_BASE is just an origin.

import { EpisodeIndexSchema, EpisodeSchema, UnderstandResponseSchema } from "@chiku/schema";
import type { Episode, EpisodeIndex, UnderstandRequest, UnderstandResponse } from "@chiku/schema";

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://localhost:8787";

export async function fetchEpisodeIndex(): Promise<EpisodeIndex> {
  const res = await fetch(`${API_BASE}/episodes`);
  if (!res.ok) throw new Error(`GET /episodes → ${res.status}`);
  return EpisodeIndexSchema.parse(await res.json());
}

export async function fetchEpisode(id: string): Promise<Episode> {
  const res = await fetch(`${API_BASE}/episodes/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`GET /episodes/${id} → ${res.status}`);
  return EpisodeSchema.parse(await res.json());
}

/** URL for a content-relative media file of an episode. */
export function mediaUrl(episodeId: string, file: string): string {
  return `${API_BASE}/media/episodes/${encodeURIComponent(episodeId)}/${encodeURIComponent(file)}`;
}

/** §8 step 4 — total miss-path budget is ≤2s, so the round-trip gets a hard cap. */
export async function understand(
  req: UnderstandRequest,
  timeoutMs = 1500,
): Promise<UnderstandResponse> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/understand`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`POST /understand → ${res.status}`);
    return UnderstandResponseSchema.parse(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch + validate a viseme-marks file. */
export async function fetchMarks(episodeId: string, file: string): Promise<unknown> {
  const res = await fetch(mediaUrl(episodeId, file));
  if (!res.ok) throw new Error(`marks ${file} → ${res.status}`);
  return res.json();
}
