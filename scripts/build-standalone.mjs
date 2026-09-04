import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, "..");
const clientDir = join(projectDir, "dist", "client");
const sourceHtml = join(clientDir, "index.html");
const outputHtml = join(projectDir, "财务工作台.html");

let html = await readFile(sourceHtml, "utf8");

const stylesheetPattern = /<link[^>]*rel=["']stylesheet["'][^>]*href=["']\.\/([^"']+)["'][^>]*>/g;
const scriptPattern = /<script[^>]*src=["']\.\/([^"']+)["'][^>]*><\/script>/g;

for (const match of [...html.matchAll(stylesheetPattern)]) {
  const css = await readFile(join(clientDir, match[1]), "utf8");
  html = html.replace(match[0], () => `<style data-inline-source="${match[1]}">${css}</style>`);
}

let inlineScripts = "";

for (const match of [...html.matchAll(scriptPattern)]) {
  const javascript = await readFile(join(clientDir, match[1]), "utf8");
  const safeJavascript = javascript.replaceAll("</script", "<\\/script");
  inlineScripts += `<script data-inline-source="${match[1]}">${safeJavascript}</script>`;
  html = html.replace(match[0], () => "");
}

html = html.replaceAll("crossorigin", "");
html = html.replace("</body>", () => `${inlineScripts}</body>`);
await writeFile(outputHtml, html, "utf8");

console.log(`Standalone HTML written to ${outputHtml}`);
