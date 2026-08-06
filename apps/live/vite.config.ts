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

export default defineConfig(({ mode }) => ({
  plugins: [react(), csp(mode !== "production")],
  server: {
    port: 5175,
    // Bind every interface, not just IPv6 loopback. Without this, Vite listens
    // on [::1] alone: http://127.0.0.1:5175 is refused, and no phone on the LAN
    // can reach it at all — which matters here, because the camera is the point
    // and desktop browsers are not where a child would use this.
    // NOTE: phone testing still needs HTTPS. getUserMedia requires a secure
    // context, and plain http:// over a LAN address is not one (localhost is
    // the only exempt origin). Use a tunnel or a local cert for real devices.
    host: true,
  },
  // The .task bundles are float16 and barely compress; don't waste build time.
  build: { assetsInlineLimit: 0 },
}));
