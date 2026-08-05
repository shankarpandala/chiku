import { readdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createNodeWebSocket, type NodeWebSocket } from "@hono/node-ws";
import {
  CreateRoomResponseSchema,
  EpisodeIndexSchema,
  EpisodeSchema,
  RoomRoleSchema,
  SpeakRequestSchema,
  UnderstandRequestSchema,
  UnderstandResponseSchema,
  type EpisodeIndex,
  type RoomRole,
  type UnderstandResponse,
} from "@chiku/schema";
import { loadEpisode, mediaFilePath, MEDIA_CONTENT_TYPES } from "./episodes";
import { episodesDir, resolveMediaDir } from "./media";
import { rateLimit, type RateLimitOptions } from "./middleware/rate-limit";
import { selectBrain, type Brain } from "./providers/brain";
import { hubFrame, RoomRegistry, type RoomMember } from "./rooms";

/** §13 default — the local Vite dev server for apps/web. */
export const DEFAULT_ALLOWED_ORIGIN = "http://localhost:5173";

export interface AppOptions {
  /** Media root containing `episodes/`. Default: MEDIA_DIR env, else <repo>/content. */
  mediaDir?: string;
  /** Single origin CORS is locked to. Default: ALLOWED_ORIGIN env, else §13 default. */
  allowedOrigin?: string;
  /** Rate-limit tuning (tests). */
  rateLimit?: RateLimitOptions;
  /** Brain override (tests). Default: selectBrain() from the environment. */
  brain?: Brain;
  /** Room registry shared with the WS hub (attachRoomHub). Default: fresh. */
  rooms?: RoomRegistry;
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

  const brain = options.brain ?? selectBrain(mediaDir);
  const rooms = options.rooms ?? new RoomRegistry();

  app.get("/healthz", (c) => c.json({ ok: true }));

  // D6 amendment: the stage mints a pairing room on the local hub.
  // Validated before it leaves the process — zod on every boundary.
  app.post("/rooms", (c) =>
    c.json(CreateRoomResponseSchema.parse({ code: rooms.createRoom() }), 201),
  );

  app.get("/episodes", async (c) => {
    const index = await loadEpisodeIndex(episodesDir(mediaDir));
    return c.json(index);
  });

  app.get("/episodes/:id", async (c) => {
    const episode = await loadEpisode(mediaDir, c.req.param("id"));
    if (episode === null) return c.json({ error: "unknown episode" }, 404);
    return c.json(episode);
  });

  app.get("/media/episodes/:id/:file", async (c) => {
    const filePath = mediaFilePath(mediaDir, c.req.param("id"), c.req.param("file"));
    if (filePath === null) return c.json({ error: "not found" }, 404);
    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch {
      return c.json({ error: "not found" }, 404);
    }
    const type = MEDIA_CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    const stream = createReadStream(filePath);
    return new Response(stream as unknown as BodyInit, {
      headers: {
        "content-type": type,
        "content-length": String(size),
        "cache-control": "no-store",
      },
    });
  });

  // §8 step 4 — the miss path. The brain is behind the Brain interface (D3);
  // failures surface as 502 so the client can fall back to its local retry.
  app.post("/understand", async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const parsed = UnderstandRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid request body", issues: parsed.error.flatten() },
        400,
      );
    }
    const req = parsed.data;
    const t0 = performance.now();
    let response: UnderstandResponse;
    try {
      response = UnderstandResponseSchema.parse(await brain.understand(req));
    } catch (err) {
      // Never the utterance text in logs — transcripts stay client-side (§9).
      console.warn(
        `[chiku-api] understand ${req.episodeId}/${req.checkpointId} brain failed after ${(performance.now() - t0).toFixed(0)}ms:`,
        err instanceof Error ? err.message : err,
      );
      return c.json({ error: "brain-unavailable" }, 502);
    }
    // Contract enforcement: a praise must name one of the request's expectIds.
    if (response.action === "praise" && (response.matchId === null || !req.expectIds.includes(response.matchId))) {
      response = { matchId: null, action: "retry", reply: { text: "Good try! Say it one more time!" } };
    }
    console.log(
      `[chiku-api] understand ${req.episodeId}/${req.checkpointId} → ${response.action}${
        response.matchId !== null ? `(${response.matchId})` : ""
      } in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    return c.json(response);
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
 * Mount the room-hub WebSocket endpoint (§7 room contract over a local WS
 * hub — D6 amendment) and return @hono/node-ws's injectWebSocket for the
 * server in index.ts.
 *
 * Kept out of createApp so createApp stays a plain Hono factory for
 * app.request() tests: createNodeWebSocket must see the same app instance
 * it upgrades for, so the wiring happens here, after the routes exist.
 * The endpoint is a thin adapter — all room rules live in RoomRegistry,
 * which is unit-tested directly.
 */
export function attachRoomHub(
  app: Hono,
  rooms: RoomRegistry,
): { injectWebSocket: NodeWebSocket["injectWebSocket"] } {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get(
    "/rooms/:code/ws",
    upgradeWebSocket((c) => {
      // upgradeWebSocket's context is untyped for path params — default "".
      const code = (c.req.param("code") ?? "").toUpperCase();
      const parsedRole = RoomRoleSchema.safeParse(c.req.query("role"));
      const role: RoomRole | undefined = parsedRole.success ? parsedRole.data : undefined;
      let member: RoomMember | undefined;

      return {
        onOpen(_evt, ws) {
          const socket: RoomMember = {
            send: (data) => ws.send(data),
            close: () => ws.close(),
          };
          if (role === undefined) {
            socket.send(hubFrame({ type: "error", message: "role must be stage or mic" }));
            socket.close();
            return;
          }
          if (rooms.join(code, role, socket)) member = socket;
        },
        onMessage(evt) {
          if (member === undefined || role === undefined) return;
          // Text frames only — no audio, no binary, ever (§9.1).
          if (typeof evt.data !== "string") return;
          rooms.handleMessage(code, role, evt.data, member);
        },
        onClose() {
          if (member !== undefined && role !== undefined) {
            rooms.leave(code, role, member);
            member = undefined;
          }
        },
      };
    }),
  );

  return { injectWebSocket };
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
