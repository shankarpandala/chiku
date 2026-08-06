import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The camera invariant, enforced by the browser rather than by good intentions.
 *
 * `connect-src 'self'` is what actually stops MediaPipe's built-in telemetry
 * beacon (POSTs to odml.pa.googleapis.com; there is no opt-out flag) and makes
 * it impossible for any code in this app to ship a video frame anywhere. The
 * library degrades cleanly when the beacon is blocked.
 *
 * Dev additionally needs the Vite HMR websocket and the local API origin; both
 * are localhost-only and neither is in the production policy.
 */
function csp(isDev: boolean): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'" + (isDev ? " 'unsafe-inline'" : ""),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    // 'self' also authorises the service worker in public/sw.js. It is
    // same-origin and hand-written; nothing here loosens that.
    "worker-src 'self' blob:",
    "font-src 'self'",
    "manifest-src 'self'",
    isDev
      ? "connect-src 'self' blob: data: ws://localhost:* http://localhost:*"
      : "connect-src 'self' blob: data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join("; ");

  return {
    name: "chiku-csp",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      );
    },
  };
}


/**
 * Self-signed dev cert — OPT-IN, via CHIKU_HTTPS=1.
 *
 * Not the default, deliberately. `http://localhost` is ALREADY a secure
 * context, so HTTPS buys the normal workflow nothing and costs a browser
 * warning on every start. It is only needed to reach the app from a phone or
 * tablet, where a plain-http LAN address is NOT a secure context and the
 * camera would silently never prompt.
 *
 *   pnpm dev:live       localhost, plain http, no warning   (unchanged)
 *   pnpm dev:live:lan   https on the LAN, camera works off-device
 */
function devHttps(): { https?: { key: Buffer; cert: Buffer } } {
  if (process.env["CHIKU_HTTPS"] !== "1") return {};
  const dir = fileURLToPath(new URL("./certs", import.meta.url));
  const key = join(dir, "dev-key.pem");
  const cert = join(dir, "dev-cert.pem");
  if (!existsSync(key) || !existsSync(cert)) {
    throw new Error(
      "CHIKU_HTTPS=1 but no dev cert. Generate one:\n" +
        "  mkdir -p apps/live/certs && cd apps/live/certs && openssl req -x509 \\\n" +
        "    -newkey rsa:2048 -nodes -keyout dev-key.pem -out dev-cert.pem -days 365 \\\n" +
        '    -subj "/CN=chiku-live-dev" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:<your-lan-ip>"',
    );
  }
  return { https: { key: readFileSync(key), cert: readFileSync(cert) } };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), csp(mode !== "production")],
  server: {
    port: 5175,
    // Bind every interface, not just IPv6 loopback. Without this, Vite listens
    // on [::1] alone: http://127.0.0.1:5175 is refused, and no phone on the LAN
    // can reach it at all — which matters here, because the camera is the point
    // and desktop browsers are not where a child would use this.
    host: true,
    // …and reaching it is not enough: getUserMedia needs a SECURE CONTEXT, and
    // a plain-http LAN address is not one (localhost is the only exempt
    // origin). Without this the app loads on a phone and the camera silently
    // never prompts — the exact confusion this project already hit once.
    // So: if a dev cert exists, serve HTTPS. Generated, gitignored, and
    // optional, so `pnpm dev:live` on localhost behaves exactly as before when
    // it is absent. See apps/live/README.md for the one-line openssl command.
    ...devHttps(),
  },
  // The .task bundles are float16 and barely compress; don't waste build time.
  build: { assetsInlineLimit: 0 },
}));
