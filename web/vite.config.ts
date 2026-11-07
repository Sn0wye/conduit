import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { mockApi } from "./mock/api";

// CONDUIT_DEV_TARGET points at a conduitd over the tailnet during development,
// for example https://conduit.tailbcc11b.ts.net
const target = process.env.CONDUIT_DEV_TARGET ?? "http://127.0.0.1:8420";
// CONDUIT_MOCK=1 (bun run dev:mock) answers /v1 from mock/api.ts instead.
const mock = !!process.env.CONDUIT_MOCK;

export default defineConfig({
  plugins: [
    mock && mockApi(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Conduit",
        short_name: "Conduit",
        description: "Start, watch, back up and upgrade the Minecraft servers on this machine.",
        start_url: "/",
        display: "standalone",
        background_color: "#0b0a0b",
        theme_color: "#0b0a0b",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        // Fonts ship in the bundle; precache them so the app opens offline
        // looking the same. The API is never cached.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallbackDenylist: [/^\/v1\//],
      },
    }),
  ],
  server: {
    proxy: mock ? undefined : { "/v1": { target, changeOrigin: true, secure: true } },
  },
});
