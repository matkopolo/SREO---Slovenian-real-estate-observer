import type { Plugin, Rollup } from "vite";
import { defineConfig } from "vitest/config";

type OutputBundle = Rollup.OutputBundle;
type OutputChunk = Rollup.OutputChunk;

/**
 * main.tsx imports the app only after the language is known (the English dictionary must load first). So the app's
 * chunk, its imports and its CSS would only start downloading once main.js runs: this links them in index.html, so they
 * load in parallel with main.js as before (modulepreload fetches without running; the order stays main.tsx's).
 */
function preloadApp(): Plugin {
  return {
    name: "sreo-preload-app",
    apply: "build",
    transformIndexHtml(_html, context) {
      const bundle = context.bundle as OutputBundle | undefined;
      if (!bundle) return [];
      const chunks = Object.values(bundle).filter((item): item is OutputChunk => item.type === "chunk");
      const app = chunks.find((chunk) => chunk.facadeModuleId?.endsWith("/src/components/App.tsx"));
      const entry = chunks.find((chunk) => chunk.isEntry);
      if (!app || !entry) return [];
      const scripts = new Set<string>();
      const styles = new Set<string>();
      const visit = (chunk: OutputChunk) => {
        if (scripts.has(chunk.fileName) || chunk === entry || entry.imports.includes(chunk.fileName)) return;
        scripts.add(chunk.fileName);
        for (const css of chunk.viteMetadata?.importedCss ?? []) styles.add(css);
        for (const name of chunk.imports) { const next = bundle[name]; if (next?.type === "chunk") visit(next); }
      };
      visit(app);
      return [
        ...[...styles].map((href) => ({ tag: "link", attrs: { rel: "stylesheet", crossorigin: true, href: `/${href}` }, injectTo: "head" as const })),
        ...[...scripts].map((href) => ({ tag: "link", attrs: { rel: "modulepreload", crossorigin: true, href: `/${href}` }, injectTo: "head" as const })),
      ];
    },
  };
}

// API requests stay same-origin; in development Vite proxies them to the local API.
export default defineConfig({
  plugins: [preloadApp()],
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  server: { port: 5174, proxy: { "/api": { target: process.env.OBSERVER_API ?? "http://localhost:8080", changeOrigin: true } } },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 900 },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"], setupFiles: ["src/test-setup.ts"] },
});
