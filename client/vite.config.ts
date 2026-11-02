import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [solid()],
  root,
  base: "/play/",
  build: {
    outDir: resolve(root, "../public/play"),
    emptyOutDir: true,
  },
});
