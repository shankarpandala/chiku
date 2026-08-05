import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // SW in build only — dev stays plain so HMR and API calls are untouched.
      devOptions: { enabled: false },
      manifest: {
        name: "Chiku",
        short_name: "Chiku",
        description: "The show that hears you",
        start_url: "/",
        display: "standalone",
        background_color: "#fdf6ec",
        theme_color: "#fdf6ec",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // App shell precache (js/css/html + self-hosted fonts).
        globPatterns: ["**/*.{js,css,html,woff2}"],
        runtimeCaching: [
          {
            // Episode index/data + media (audio, video, marks) come from the
            // API origin (§ D7). NetworkFirst so a mid-session blip replays
            // from cache instead of killing playback. Anchored regex: matches
            // cross-origin URLs from the start of the href.
            urlPattern: /^https?:\/\/[^/]+\/(media\/.*|episodes(\/.*)?)$/,
            handler: "NetworkFirst",
            options: {
              cacheName: "chiku-media",
            },
          },
        ],
      },
    }),
  ],
  server: { port: 5173 },
});
