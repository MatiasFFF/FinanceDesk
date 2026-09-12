import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { financeAssistantPlugin } from "./server/financeAssistant.js";

export default defineConfig({
  plugins: [react(), financeAssistantPlugin()],
  base: "./",
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
