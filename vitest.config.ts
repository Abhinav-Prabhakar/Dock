import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // @vitejs/plugin-react is typed against the repo's rolldown-vite fork while
  // vitest bundles its own vite — the Plugin types diverge structurally
  // (rollup vs rolldown hooks) though the plugin is runtime-compatible.
  plugins: [react() as unknown as Plugin],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules"],
    css: false,
  },
  resolve: {
    alias: {
      "@": "/Users/abhinav/Projects/Dock/src",
    },
  },
});
