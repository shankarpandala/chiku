import { serve } from "@hono/node-server";
import { createApp, DEFAULT_ALLOWED_ORIGIN } from "./app";

const port = Number(process.env["PORT"] ?? 8787);
const allowedOrigin = process.env["ALLOWED_ORIGIN"] ?? DEFAULT_ALLOWED_ORIGIN;

const app = createApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[chiku-api] listening on http://localhost:${info.port}`);
  console.log(`[chiku-api] CORS locked to origin: ${allowedOrigin}`);
});
