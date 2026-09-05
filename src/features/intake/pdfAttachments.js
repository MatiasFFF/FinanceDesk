function attachmentType(entry) {
  const name = String(entry.name || "").toLowerCase();
  if (entry.mimeType === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (entry.mimeType === "image/png" || name.endsWith(".png")) return "png";
  if (entry.mimeType === "image/jpeg" || /\.jpe?g$/.test(name)) return "jpeg";
  return null;
}

// The merged PDF is a reading copy. The ZIP keeps the unchanged originals.
export async function mergeAttachmentPdfs(entries) {
  const { PDFDocument } = await import("pdf-lib");
  const merged = await PDFDocument.create();
  const included = [];
  const skipped = [];
  const seen = new Set();
  for (const entry of entries) {
    const documentId = entry.documentId || entry.id || null;
    if (documentId && seen.has(documentId)) continue;
    if (documentId) seen.add(documentId);
    const type = attachmentType(entry);
    const identity = { documentId, name: entry.name || "未命名资料" };
    if (!type) {
      skipped.push({ ...identity, reason: "此格式保留原文件，不加入合并 PDF" });
      continue;
    }
    const startPage = merged.getPageCount() + 1;
    try {
      if (type === "pdf") {
        const source = await PDFDocument.load(entry.bytes);
        if (!source.getPageCount()) throw new Error("empty PDF");
        const pages = await merged.copyPages(source, source.getPageIndices());
        pages.forEach((page) => merged.addPage(page));
      } else {
        const picture = type === "png" ? await merged.embedPng(entry.bytes) : await merged.embedJpg(entry.bytes);
        const pageSize = picture.width > picture.height ? [842, 595] : [595, 842];
        const page = merged.addPage(pageSize);
        const scale = Math.min((pageSize[0] - 40) / picture.width, (pageSize[1] - 40) / picture.height);
        const width = picture.width * scale;
        const height = picture.height * scale;
        page.drawImage(picture, { x: (pageSize[0] - width) / 2, y: (pageSize[1] - height) / 2, width, height });
      }
      included.push({ ...identity, startPage, endPage: merged.getPageCount() });
    } catch (error) {
      while (merged.getPageCount() >= startPage) merged.removePage(merged.getPageCount() - 1);
      skipped.push({ ...identity, reason: /encrypt|password/i.test(error.message || "") ? "PDF 受密码保护，请查看包内原文件" : "无法读取为 PDF 或图片，请查看包内原文件" });
    }
  }
  return {
    bytes: included.length ? await merged.save() : null,
    pageCount: merged.getPageCount(),
    included,
    skipped,
    originalFilesPreserved: true,
  };
}
