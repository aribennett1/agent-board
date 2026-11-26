import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI is built into dist/ and served by the agent-board server (src/server.ts), which also owns every /__ab,
// /api and /replies route. `npm run dev` proxies those to a running server on AGENT_BOARD_PORT (default 8787).
const target = `http://127.0.0.1:${process.env.AGENT_BOARD_PORT || process.env.PORT || 8787}`;

export default defineConfig({
  plugins: [react()],
  envPrefix: ["VITE_", "ACTION_BOARD_ASSISTANT", "ACTION_BOARD_TIMEZONE", "ACTION_BOARD_WEBHOOK_CONFIGURED"],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    proxy: { "/__ab": target, "/api": target, "/replies": target },
  },
});
