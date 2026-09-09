import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    // Everything is first-party and small; one request beats a waterfall.
    cssCodeSplit: false,
    reportCompressedSize: true,
  },
  server: {
    port: 5173,
    proxy: {
      // The dev server talks to a locally running agmeet-server.
      "/ws": { target: "ws://127.0.0.1:8080", ws: true },
      "/healthz": "http://127.0.0.1:8080",
    },
  },
});
