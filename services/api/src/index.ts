import { serve } from "@hono/node-server";
import { attachRoomHub, createApp, DEFAULT_ALLOWED_ORIGIN } from "./app";
import { RoomRegistry } from "./rooms";

const port = Number(process.env["PORT"] ?? 8787);
const allowedOrigin = process.env["ALLOWED_ORIGIN"] ?? DEFAULT_ALLOWED_ORIGIN;

// One registry shared by POST /rooms and the WS hub (D6 amendment).
const rooms = new RoomRegistry();
const app = createApp({ rooms });
const { injectWebSocket } = attachRoomHub(app, rooms);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[chiku-api] listening on http://localhost:${info.port}`);
  console.log(`[chiku-api] CORS locked to origin: ${allowedOrigin}`);
  console.log(`[chiku-api] room hub: ws://localhost:${info.port}/rooms/:code/ws?role=stage|mic`);
});
injectWebSocket(server);
