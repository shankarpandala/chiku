import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the media root directory (the directory that contains `episodes/`).
 *
 * Precedence: explicit override (tests) > MEDIA_DIR env (§13) > the repo's
 * checked-in `content/` directory. Keeping this in one helper means nothing
 * else in the service hardcodes where media lives.
 */
export function resolveMediaDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env["MEDIA_DIR"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return path.resolve(fromEnv);
  }
  // services/api/src/media.ts -> ../../../content == <repo>/content
  return fileURLToPath(new URL("../../../content", import.meta.url));
}

/** Directory holding one subdirectory per episode, each with episode.json. */
export function episodesDir(mediaDir: string): string {
  return path.join(mediaDir, "episodes");
}
