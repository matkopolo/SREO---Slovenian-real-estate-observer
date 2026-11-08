import { defineConfig } from "vitest/config";

// API requests stay same-origin; in development Vite proxies them to the local API.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  server: { port: 5174, proxy: { "/api": { target: process.env.ATLAS_API ?? "http://localhost:8080", changeOrigin: true } } },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 900 },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"], setupFiles: ["src/test-setup.ts"] },
});
