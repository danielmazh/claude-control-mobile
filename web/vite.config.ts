import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

const target = "http://127.0.0.1:7810";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
  },
  server: {
    proxy: {
      "/api": { target, changeOrigin: false },
      "/login": { target, changeOrigin: false },
    },
  },
  preview: {
    proxy: {
      "/api": { target, changeOrigin: false },
      "/login": { target, changeOrigin: false },
    },
  },
});
