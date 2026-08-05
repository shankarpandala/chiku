import { readFile } from "node:fs/promises";
import path from "node:path";
import { EpisodeSchema, type Episode } from "@chiku/schema";
import { episodesDir } from "./media";

/** Single path segment, no traversal — episode ids and media filenames. */
export function safeSegment(s: string): boolean {
  return s.length > 0 && !s.includes("/") && !s.includes("\\") && !s.includes("..") && !s.includes("\0");
}

/** Load + zod-validate one episode; null when it doesn't exist. */
export async function loadEpisode(mediaDir: string, id: string): Promise<Episode | null> {
  if (!safeSegment(id)) return null;
  const file = path.join(episodesDir(mediaDir), id, "episode.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  return EpisodeSchema.parse(JSON.parse(raw));
}

/** Absolute path of a media file inside an episode's media/ dir, or null. */
export function mediaFilePath(mediaDir: string, episodeId: string, file: string): string | null {
  if (!safeSegment(episodeId) || !safeSegment(file)) return null;
  const root = path.resolve(episodesDir(mediaDir), episodeId, "media");
  const resolved = path.resolve(root, file);
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

export const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".json": "application/json",
  ".mp4": "video/mp4",
};
