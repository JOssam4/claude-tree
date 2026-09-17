import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies API/WS calls to the backend (see packages/server/src/config.ts HTTP_PORT)
// so the frontend can always just call same-origin `/api/...` and `/ws` regardless of dev vs. build.
const BACKEND_PORT = Number(process.env.CLAUDE_TREE_PORT ?? 4317);

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${BACKEND_PORT}`,
      "/ws": {
        target: `ws://127.0.0.1:${BACKEND_PORT}`,
        ws: true,
      },
    },
  },
});
