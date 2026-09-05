import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, degrees } from "pdf-lib";
import { mergeAttachmentPdfs } from "../src/features/intake/pdfAttachments.js";

async function pdfEntry(documentId, sizes) {
  const doc = await PDFDocument.create();
  for (const size of sizes) doc.addPage(size);
  doc.getPage(0).setRotation(degrees(90));
  return { documentId, name: "同名附件.pdf", mimeType: "application/pdf", bytes: await doc.save() };
}

test("PDF 按附件顺序合并，保留页数、尺寸、方向和来源页码", async () => {
  const first = await pdfEntry("first", [[200, 300], [400, 500]]);
  const second = await pdfEntry("second", [[600, 700]]);
  const before = new Uint8Array(first.bytes);
  const result = await mergeAttachmentPdfs([first, second, first]);
  const doc = await PDFDocument.load(result.bytes);
  assert.equal(doc.getPageCount(), 3);
  assert.deepEqual(doc.getPages().map((page) => [page.getWidth(), page.getHeight()]), [[200, 300], [400, 500], [600, 700]]);
  assert.equal(doc.getPage(0).getRotation().angle, 90);
  assert.deepEqual(result.included.map((entry) => [entry.documentId, entry.startPage, entry.endPage]), [["first", 1, 2], ["second", 3, 3]]);
  assert.deepEqual(first.bytes, before);
});

test("坏 PDF 和不支持的文件保留明确说明，其余附件继续合并", async () => {
  const valid = await pdfEntry("valid", [[300, 400]]);
  const result = await mergeAttachmentPdfs([
    { documentId: "broken", name: "损坏.pdf", bytes: new TextEncoder().encode("not a pdf") },
    { documentId: "sheet", name: "工资.xlsx", bytes: new Uint8Array([1, 2, 3]) },
    valid,
  ]);
  assert.equal((await PDFDocument.load(result.bytes)).getPageCount(), 1);
  assert.equal(result.skipped.length, 2);
  assert.equal(result.included[0].startPage, 1);
});

test("PNG 凭据加入合并文件，无可合并文件时不生成空白 PDF", async () => {
  const image = { documentId: "image", name: "票据.png", mimeType: "image/png", bytes: new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6XfQAAAAASUVORK5CYII=", "base64")) };
  const result = await mergeAttachmentPdfs([image]);
  assert.equal((await PDFDocument.load(result.bytes)).getPageCount(), 1);
  assert.equal(result.pageCount, 1);
  const empty = await mergeAttachmentPdfs([{ name: "记录.csv", bytes: new Uint8Array() }]);
  assert.equal(empty.bytes, null);
  assert.equal(empty.pageCount, 0);
});
