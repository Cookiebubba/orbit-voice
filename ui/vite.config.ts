import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Built into ../public so the bridge server serves it (same origin as the /voice socket).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  build: {
    outDir: "../public",
    emptyOutDir: true,
    // wake.html: hidden wake-word helper page (see src/wake.ts); agents.html: the Agents window
    rollupOptions: { input: { main: path.resolve(__dirname, "index.html"), wake: path.resolve(__dirname, "wake.html"), agents: path.resolve(__dirname, "agents.html") } },
    chunkSizeWarningLimit: 6500,
  },
  server: { proxy: { "/voice": { target: "ws://127.0.0.1:4317", ws: true }, "/api": "http://127.0.0.1:4317" } },
});
