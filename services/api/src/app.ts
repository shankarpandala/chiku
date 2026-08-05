import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  EpisodeIndexSchema,
  EpisodeSchema,
  SpeakRequestSchema,
  UnderstandRequestSchema,
  type EpisodeIndex,
} from "@chiku/schema";
import { episodesDir, resolveMediaDir } from "./media";
import { rateLimit, type RateLimitOptions } from "./middleware/rate-limit";

/** §13 default — the local Vite dev server for apps/web. */
export const DEFAULT_ALLOWED_ORIGIN = "http://localhost:5173";

export interface AppOptions {
  /** Media root containing `episodes/`. Default: MEDIA_DIR env, else <repo>/content. */
  mediaDir?: string;
  /** Single origin CORS is locked to. Default: ALLOWED_ORIGIN env, else §13 default. */
  allowedOrigin?: string;
  /** Rate-limit tuning (tests). */
  rateLimit?: RateLimitOptions;
}

/**
 * The Chiku API (§7): CORS locked to the app origin, per-IP rate limiting
 * (seed of the per-session limits), /healthz, /episodes, and the M2
 * /understand + /speak contracts (validated but not yet implemented).
 */
export function createApp(options: AppOptions = {}): Hono {
  const mediaDir = options.mediaDir ?? resolveMediaDir();
  const allowedOrigin =
    options.allowedOrigin ??
    process.env["ALLOWED_ORIGIN"] ??
    DEFAULT_ALLOWED_ORIGIN;

  const app = new Hono();

  // CORS first so even rate-limited responses carry the header for the
  // (single) allowed origin; every other origin gets no CORS header at all.
  app.use(
    "*",
    cors({
      origin: (origin) => (origin === allowedOrigin ? origin : null),
    }),
  );
  app.use("*", rateLimit(options.rateLimit));

  app.onError((err, c) => {
    console.error("[chiku-api]", err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/episodes", async (c) => {
    const index = await loadEpisodeIndex(episodesDir(mediaDir));
    return c.json(index);
  });

  // M2 contracts: request bodies are zod-validated now; the Brain/Voice
  // providers behind them are stubs until M2.
  app.post("/understand", async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const parsed = UnderstandRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid request body", issues: parsed.error.flatten() },
        400,
      );
    }
    return c.json({ error: "not implemented until M2" }, 501);
  });

  app.post("/speak", async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const parsed = SpeakRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid request body", issues: parsed.error.flatten() },
        400,
      );
    }
    return c.json({ error: "not implemented until M2" }, 501);
  });

  return app;
}

/**
 * Build the episode index by reading `episode.json` from every directory
 * directly under the episodes dir, e.g. content/episodes/ep001/episode.json.
 * Every file is validated against EpisodeSchema (fail loudly on drift) and
 * the assembled index is validated against EpisodeIndexSchema before it
 * leaves the process — zod on every boundary.
 */
async function loadEpisodeIndex(dir: string): Promise<EpisodeIndex> {
  const entries = await readdir(dir, { withFileTypes: true });
  const index: EpisodeIndex = [];
  for (const entry of entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name, "episode.json");
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      // Episode directory without an episode.json yet (media-only) — skip.
      continue;
    }
    const episode = EpisodeSchema.parse(JSON.parse(raw));
    index.push({
      id: episode.id,
      title: episode.title,
      langs: episode.langs,
    });
  }
  return EpisodeIndexSchema.parse(index);
}
