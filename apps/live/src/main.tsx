import "@chiku/tokens/fonts.css";
import "@chiku/tokens/tokens.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * Service worker (public/sw.js — hand-written; vite-plugin-pwa is not a
 * dependency of this app and is not being made one).
 *
 * Three rules, all of them about not making things worse:
 *
 *   * NOT IN DEV. A worker caching a dev server produces the exact class of
 *     "why is my change not showing up" bug that costs an afternoon.
 *   * NOT BEFORE FIRST PAINT. Registration is deferred to `load`, so it can
 *     never compete with the first render — the child sees Chiku first.
 *   * NEVER FATAL. Unsupported, blocked by policy, insecure context, quota
 *     refused: all of it is a caught promise. The app is fully functional
 *     without a worker; it just re-downloads on a cache miss.
 */
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // No offline and no model cache on this device. Nothing else changes.
    });
  });
}
