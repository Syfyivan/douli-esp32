import { defineConfig } from "vite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, sep } from "node:path";

const pdfjsRoot = resolve(import.meta.dirname, "node_modules/pdfjs-dist");
const pdfDirs = ["cmaps", "standard_fonts", "wasm", "iccs"];

export default defineConfig({
  root: import.meta.dirname,
  plugins: [{
    name: "local-pdf-resources",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!["GET", "HEAD"].includes(req.method || "")) return next();
        const url = (req.url || "").split("?")[0];
        const match = /^\/pdfjs\/(cmaps|standard_fonts|wasm|iccs)\/(.+)$/.exec(url);
        if (!match) return next();
        const base = resolve(pdfjsRoot, match[1]);
        let file;
        try { file = resolve(base, decodeURIComponent(match[2])); } catch { return next(); }
        if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".js") || file.endsWith(".mjs") ? "text/javascript" : "application/octet-stream");
        if (req.method === "HEAD") { res.end(); return; }
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      const copy = (directory, destination) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name), name = destination + "/" + entry.name;
          if (entry.isDirectory()) copy(path, name);
          else if (entry.isFile()) this.emitFile({ type: "asset", fileName: name, source: readFileSync(path) });
        }
      };
      for (const directory of pdfDirs)
        copy(resolve(pdfjsRoot, directory), "pdfjs/" + directory);
    },
  }],
  server: {
    port: 8790,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:" + (process.env.DOULI_PORT || 8788), ws: true } },
  },
  build: {
    outDir: "dist",
    // AudioWorklet must load a same-origin file under the desktop script CSP.
    assetsInlineLimit: file => /\/web\/(?:capture|avatar-meter)\.js$/.test(file.replaceAll("\\", "/")) ? false : undefined,
  },
});
