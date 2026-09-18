import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// CONDUIT_DEV_TARGET points at a conduitd over the tailnet during development,
// for example https://conduit.tailbcc11b.ts.net
const target = process.env.CONDUIT_DEV_TARGET ?? "http://127.0.0.1:8420";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Conduit",
        short_name: "Conduit",
        start_url: "/",
        display: "standalone",
        background_color: "#0b0f14",
        theme_color: "#0b0f14",
        icons: [],
      },
    }),
  ],
  server: {
    proxy: { "/v1": { target, changeOrigin: true, secure: true } },
  },
});
