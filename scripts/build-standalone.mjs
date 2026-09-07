import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, "..");
const outputHtml = join(projectDir, "财务工作台.html");

// Build independently: the web/Sites output keeps its normal lazy chunks.
// Library mode also avoids Vite's module-preload/import.meta.url wrappers.
const result = await build({
  root: projectDir,
  configFile: false,
  publicDir: false,
  base: "./",
  mode: "production",
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    write: false,
    emptyOutDir: false,
    copyPublicDir: false,
    modulePreload: false,
    cssCodeSplit: false,
    cssMinify: true,
    minify: "esbuild",
    sourcemap: false,
    reportCompressedSize: false,
    lib: {
      entry: join(projectDir, "src/main.jsx"),
      name: "FinanceDeskStandalone",
      formats: ["iife"],
      fileName: () => "financedesk-standalone.js",
      cssFileName: "financedesk-standalone",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

// Ordinary lazy pages, XLSX/ZIP and the existing PDF-merging dependency are
// included. Recognition's variable @vite-ignore import and worker URLs remain
// untouched: PDF.js/Tesseract/WASM/languages stay outside the HTML and retain
// localDocumentRecognition's existing file:// restriction and on-demand loading.
const output = (Array.isArray(result) ? result : [result]).flatMap((bundle) => bundle.output);
const scripts = output.filter((item) => item.type === "chunk");
const stylesheets = output.filter((item) => item.type === "asset" && item.fileName.endsWith(".css"));
const otherAssets = output.filter((item) => item.type === "asset" && !item.fileName.endsWith(".css"));
if (scripts.length !== 1 || scripts[0].imports.length || scripts[0].dynamicImports.length || otherAssets.length) {
  throw new Error("Standalone build must contain one self-contained script and inline styles, without additional files.");
}

let html = await readFile(join(projectDir, "index.html"), "utf8");
const entryPattern = /<script\b[^>]*\bsrc=["']\/?src\/main\.jsx["'][^>]*>\s*<\/script\s*>/gi;
if ([...html.matchAll(entryPattern)].length !== 1) {
  throw new Error("Standalone template must contain exactly one src/main.jsx entry.");
}
const css = stylesheets.map((asset) => typeof asset.source === "string" ? asset.source : Buffer.from(asset.source).toString("utf8")).join("\n");
const safeCss = css.replace(/<\/style/gi, "<\\/style");
const safeJavascript = scripts[0].code.replace(/<\/script/gi, "<\\/script");
html = html.replace(entryPattern, () => `<script data-inline-source="financedesk-standalone">${safeJavascript}</script>`);
html = html.replace("</head>", () => `<style data-inline-source="financedesk-standalone">${safeCss}</style>\n</head>`);
await writeFile(outputHtml, html, "utf8");

console.log(`Standalone HTML written to ${outputHtml}`);
