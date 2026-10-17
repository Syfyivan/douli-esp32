import { defineConfig } from "vite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
export default defineConfig({
  plugins: [{ name: "local-pdf-resources", generateBundle() {
    const copy = (directory, destination) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name), name = destination + "/" + entry.name;
        if (entry.isDirectory()) copy(path, name);
        else if (entry.isFile()) this.emitFile({ type: "asset", fileName: name, source: readFileSync(path) });
      }
    };
    for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"])
      copy(resolve("node_modules/pdfjs-dist", directory), "pdfjs/" + directory);
  } }],
  server: {
    port: 8790,
    proxy: { "/api": { target: "http://127.0.0.1:8788", ws: true } },
  },
  build: {
    outDir: "dist",
    // AudioWorklet must load a same-origin file under the desktop script CSP.
    assetsInlineLimit: file => file.replaceAll("\\", "/").endsWith("/web/capture.js") ? false : undefined,
  },
});
