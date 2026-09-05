import { copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// No network access: installs happen explicitly in development, never at recognition time.
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(project, "public/local-recognition/v1");
const versions = { "tesseract.js": "7.0.0", "tesseract.js-core": "7.0.0", "pdfjs-dist": "6.3.289", "@tesseract.js-data/chi_sim": "1.0.0", "@tesseract.js-data/eng": "1.0.0" };
const sources = [];
for (const [name, version] of Object.entries(versions)) {
  const metadata = JSON.parse(await readFile(join(project, "node_modules", name, "package.json"), "utf8"));
  if (metadata.version !== version) throw new Error(`${name} must be ${version}; update the worker adapter and resource directory deliberately when upgrading.`);
  sources.push({ name, version, repository: metadata.repository?.url, declaredPackageLicense: metadata.license });
}
async function copy(packageName, source, destination) {
  const target = join(output, destination);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(project, "node_modules", packageName, source), target);
}
await copy("tesseract.js", "dist/worker.min.js", "tesseract-7.0.0/worker.min.js");
await copy("tesseract.js", "dist/worker.min.js.LICENSE.txt", "tesseract-7.0.0/worker.min.js.LICENSE.txt");
// tesseract.js npm package ships bundle notices, but no standalone LICENSE file.
await copy("tesseract.js-core", "LICENSE", "tesseract-7.0.0/LICENSE-APACHE-2.0");
await copy("tesseract.js-core", "LICENSE", "tesseract-7.0.0/core/LICENSE");
// .wasm.js embeds its WASM binary. Only the three LSTM builds can be selected by this adapter.
for (const name of ["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"]) {
  await copy("tesseract.js-core", name, `tesseract-7.0.0/core/${name}`);
}
for (const language of ["chi_sim", "eng"]) {
  await copy(`@tesseract.js-data/${language}`, `4.0.0_best_int/${language}.traineddata.gz`, `languages-1.0.0/${language}.traineddata.gz`);
  await copy(`@tesseract.js-data/${language}`, "package.json", `languages-1.0.0/${language}.package.json`);
}
await copy("pdfjs-dist", "build/pdf.min.mjs", "pdfjs-6.3.289/pdf.mjs");
await copy("pdfjs-dist", "build/pdf.worker.min.mjs", "pdfjs-6.3.289/pdf.worker.mjs");
await copy("pdfjs-dist", "LICENSE", "pdfjs-6.3.289/LICENSE");
for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  await cp(join(project, "node_modules/pdfjs-dist", directory), join(output, "pdfjs-6.3.289", directory), { recursive: true });
}
async function bytes(directory) {
  let total = 0;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    total += item.isDirectory() ? await bytes(path) : (await stat(path)).size;
  }
  return total;
}
const distributionBytes = {};
for (const directory of ["tesseract-7.0.0", "languages-1.0.0", "pdfjs-6.3.289"]) distributionBytes[directory] = await bytes(join(output, directory));
await writeFile(join(output, "SOURCES.json"), JSON.stringify({
  assetsVersion: 1, sources, distributionBytes,
  languageDataSource: "https://github.com/naptha/tessdata/tree/gh-pages/4.0.0_best_int",
  languageDataLicense: "Apache-2.0; see languages-1.0.0/LICENSE.tessdata (upstream repository license). Package metadata is retained separately.",
  loading: "No recognition assets are loaded on the homepage. PDF module and parser worker load only for PDF recognition; fonts/maps/decoders load as needed. One selected LSTM core and the two language files load only when an OCR page is reached. All URLs remain same-origin; no CDN fallback.",
}, null, 2) + "\n");
console.log(JSON.stringify({ copiedLocalRecognitionBytes: distributionBytes }));
