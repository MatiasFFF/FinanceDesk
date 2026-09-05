// Assets are copied from pinned npm packages by prepare-local-recognition.mjs.
// This module is loaded by the UI only when the user starts recognition.
const ASSET_DIRECTORY = "local-recognition/v1/";
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_PAGES = 30;
const MAX_CANVAS_PIXELS = 4_000_000;
const MAX_CANVAS_EDGE = 4096;
let running = false;

function abortError() {
  return new DOMException("已取消本地识别", "AbortError");
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function waitFor(promise, signal, releaseLateValue) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then((value) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) releaseLateValue?.(value);
      else resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

function localAssets() {
  if (globalThis.location?.protocol === "file:") {
    throw new Error("离线识别需要从本地网页入口打开；单文件 HTML 可继续使用其他功能。");
  }
  if (!globalThis.document || !/^https?:$/.test(globalThis.location?.protocol || "")) {
    throw new Error("请在本地网页中使用资料识别。");
  }
  const base = import.meta.env?.BASE_URL || "./";
  const url = new URL(`${base}${ASSET_DIRECTORY}`, document.baseURI);
  if (url.origin !== location.origin) throw new Error("识别资源必须与本地网页同源。");
  return url;
}

function fileKind(name, mimeType) {
  if (mimeType === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (/^image\/(png|jpeg|webp|bmp)$/.test(mimeType) || /\.(png|jpe?g|webp|bmp)$/i.test(name)) return "image";
  throw new Error("本地识别支持 PDF、PNG、JPEG、WebP 和 BMP 文件。");
}

function makeCanvas(width, height, scale = 1) {
  if (!(width > 0 && height > 0 && Number.isFinite(width * height))) throw new Error("无法读取资料页面尺寸。");
  const ratio = Math.min(scale, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)), MAX_CANVAS_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width * ratio));
  canvas.height = Math.max(1, Math.floor(height * ratio));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("当前浏览器无法创建识别画布。");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, context, ratio };
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error("无法读取识别画布，请重新选择资料。"));
  }, "image/png"));
}

// Minimal message adapter for tesseract.js 7.0.0's shipped browser worker.
// Owning the native worker makes cancellation possible before WASM/languages finish loading.
function createOcrWorker(assets, progress) {
  const worker = new Worker(new URL("tesseract-7.0.0/worker.min.js", assets));
  let pending = null;
  let nextId = 0;
  let closed = false;
  const terminate = (error = abortError()) => {
    if (closed) return;
    closed = true;
    worker.terminate();
    pending?.reject(error);
    pending = null;
  };
  worker.onmessage = ({ data }) => {
    if (!pending || data.jobId !== pending.id) return;
    if (data.status === "progress") {
      progress(data.action === "recognize" ? "recognizing" : "loading", data.data?.progress || 0);
      return;
    }
    const current = pending;
    pending = null;
    if (data.status === "resolve") current.resolve(data.data);
    else current.reject(new Error(`本地 OCR 失败：${String(data.data || "无法识别资料")}`));
  };
  worker.onerror = () => terminate(new Error("本地 OCR 资源加载失败，请确认本地服务包含完整识别资源。"));
  worker.onmessageerror = () => terminate(new Error("本地 OCR 结果读取失败。"));
  const request = (action, payload) => new Promise((resolve, reject) => {
    if (closed) return reject(abortError());
    const id = `local-${++nextId}`;
    pending = { id, resolve, reject };
    try {
      const packet = { workerId: "local-document", jobId: id, action, payload };
      worker.postMessage(packet, action === "recognize" ? [payload.image.buffer] : []);
    } catch (error) {
      pending = null;
      reject(error);
    }
  });
  return {
    terminate,
    async initialize() {
      await request("load", { options: { lstmOnly: true, corePath: new URL("tesseract-7.0.0/core/", assets).href, logging: false } });
      await request("loadLanguage", { langs: ["chi_sim", "eng"], options: {
        langPath: new URL("languages-1.0.0/", assets).href,
        cachePath: "financedesk-ocr-v1-best-int", cacheMethod: "write", gzip: true, lstmOnly: true,
      } });
      await request("initialize", { langs: ["chi_sim", "eng"], oem: 1, config: {} });
    },
    recognize(image) {
      return request("recognize", { image, options: { tessedit_pageseg_mode: "3", preserve_interword_spaces: "1" }, output: { text: true } });
    },
  };
}

function pdfText(content) {
  let text = "";
  let lastY;
  for (const item of content.items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform?.[5];
    if (lastY != null && y != null && Math.abs(lastY - y) > 3 && !text.endsWith("\n")) text += "\n";
    text += item.str + (item.hasEOL ? "\n" : " ");
    lastY = y;
  }
  return text.replace(/[ \t]+\n/g, "\n").trim();
}

function validDate(value) {
  const match = value.match(/^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?$/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

// Candidates only: explicit labels, no inferred tax direction or approval/verification status.
export function extractDocumentFieldSuggestions(pages, category) {
  const rules = category === "合同" ? [
    ["partyA", "合同甲方|甲方", "text"], ["partyB", "合同乙方|乙方", "text"],
    ["amount", "合同总金额|合同金额|合同总价", "money"],
    ["serviceStartDate", "服务开始日期|服务起始日期", "date"], ["serviceEndDate", "服务结束日期|服务截止日期", "date"],
    ["settlementCycle", "结算周期|结算方式", "text"],
    ["refundTerms", "退款条款|退款条件|退款规则|退款", "clause"], ["discountTerms", "折扣条款|折扣条件|折扣规则|优惠规则|折扣", "clause"],
    ["commissionTerms", "佣金条款|佣金规则|佣金条件|佣金", "clause"], ["performanceTerms", "履约条件|履约条款|履约要求", "clause"],
  ] : category === "发票" ? [
    ["invoiceNumber", "发票号码", "invoice"], ["invoiceDate", "开票日期|发票日期", "date"],
    ["amount", "价税合计(?:（小写）|\\(小写\\))?", "money"], ["taxAmount", "税额|合计税额", "money"], ["taxRate", "税率", "rate"],
  ] : [];
  const suggestedFields = {};
  const conflicts = new Set();
  const warnings = [];
  const reviewItems = [];
  const requestReview = (key, label, sources, reason) => {
    let review = reviewItems.find((item) => item.field === key);
    if (!review) {
      review = { field: key, label, reason, sources: [] };
      reviewItems.push(review);
      warnings.push(`${label}待人工核对，请查看各处原文。`);
    }
    for (const source of [...(suggestedFields[key] ? [suggestedFields[key]] : []), ...sources]) {
      if (!review.sources.some((item) => JSON.stringify(item) === JSON.stringify(source))) review.sources.push(source);
    }
    conflicts.add(key);
    delete suggestedFields[key];
  };
  const addCandidate = (key, value, sourceText, pageNumber, label, sourcePages) => {
    const source = { value, sourceText: sourceText.trim(), pageNumber, ...(sourcePages ? { sourcePages } : {}) };
    if (conflicts.has(key)) {
      requestReview(key, label, [source], "同一字段有多处表述，请核对适用条件。");
      return;
    }
    if (suggestedFields[key] && suggestedFields[key].value !== value) {
      requestReview(key, label, [suggestedFields[key], source], "同一字段有多处表述，请核对适用条件。");
    } else if (!suggestedFields[key]) {
      suggestedFields[key] = source;
    }
  };
  const otherLabels = rules.map(([, labels]) => labels).join("|");
  for (const page of pages) {
    for (const sourceText of page.text.split(/\r?\n/)) {
      const line = sourceText.normalize("NFKC").replace(/([\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])/g, "$1").trim();
      if (category === "合同") {
        const range = line.match(/(?:^|\s|[;；])服务期限\s*[:：]\s*(\d{4}-\d{1,2}-\d{1,2})\s*至\s*(\d{4}-\d{1,2}-\d{1,2})\s*$/);
        if (range) {
          const start = validDate(range[1]);
          const end = validDate(range[2]);
          if (start && end && start <= end) {
            addCandidate("serviceStartDate", start, sourceText, page.pageNumber, "服务开始日期");
            addCandidate("serviceEndDate", end, sourceText, page.pageNumber, "服务结束日期");
          } else {
            requestReview("serviceEndDate", "服务期限", [{ value: range[0], sourceText, pageNumber: page.pageNumber, sourcePages: [page.pageNumber] }], "日期或先后顺序需要人工核对。");
          }
        }
      }
      for (const [key, labels, type] of rules) {
        if (type === "clause") continue;
        const match = line.match(new RegExp(`(?:^|\\s|[;；])(?:${labels})\\s*[:：]\\s*(.*?)(?=\\s+(?:${otherLabels})\\s*[:：]|$)`));
        if (!match) continue;
        let value = match[1].trim();
        const originalValue = value;
        if (type === "date") value = validDate(value.replace(/\s/g, ""));
        if (type === "invoice") value = /^\d{8,20}$/.test(value.replace(/\s/g, "")) ? value.replace(/\s/g, "") : null;
        if (type === "money") {
          const money = value.match(/^(?:人民币\s*)?[¥￥]?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s*(?:元)?$/);
          value = money ? Number(money[1].replaceAll(",", "")) : null;
        }
        if (type === "rate") value = /^\d{1,2}(?:\.\d{1,2})?\s*%$|^100\s*%$/.test(value) ? Number(value.replace(/\s|%/g, "")) : null;
        if (value === null || value === "" || typeof value === "number" && !Number.isFinite(value)) {
          if (category === "合同" && originalValue && ["money", "date"].includes(type)) {
            requestReview(key, labels.split("|")[0], [{ value: originalValue, sourceText, pageNumber: page.pageNumber, sourcePages: [page.pageNumber] }], "原文无法唯一确定金额或日期，请按适用条件人工填写。");
          }
          continue;
        }
        addCandidate(key, value, sourceText, page.pageNumber, labels.split("|")[0]);
      }
    }
  }
  // Explicitly headed clauses stay as text. Never turn percentages/conditions into bill amounts.
  const clauseRules = rules.filter((rule) => rule[2] === "clause");
  const clauseLabels = clauseRules.map((rule) => rule[1]).join("|");
  const canonical = (text) => text.normalize("NFKC").replace(/([\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])/g, "$1").trim();
  const headingPrefix = "(?:(?:第[一二三四五六七八九十百\\d]+条|[一二三四五六七八九十\\d]+[、.])\\s*)?";
  const records = clauseRules.length ? pages.flatMap((page) => page.text.split(/\r?\n/)
    .flatMap((text) => text.split(new RegExp(`[;；](?=\\s*(?:${clauseLabels})\\s*[:：])`)))
    .map((text) => ({ text, pageNumber: page.pageNumber }))) : [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const rule = clauseRules.find(([, labels]) => new RegExp(`^${headingPrefix}(?:${labels})\\s*(?::|$)`).test(canonical(record.text)));
    if (!rule) continue;
    const [key, labels] = rule;
    // Normalize only for locating the heading; clause text keeps its original punctuation.
    const separator = record.text.search(/[:：]/);
    const values = [separator >= 0 ? record.text.slice(separator + 1).trim() : ""];
    const sources = [record];
    let end = index + 1;
    for (; end < records.length; end += 1) {
      const next = canonical(records[end].text);
      if (new RegExp(`^${headingPrefix}(?:${otherLabels}|服务期限)\\s*(?::|$)`).test(next)) break;
      if (/^第[一二三四五六七八九十百\d]+条/.test(next)) break;
      if (/^[^:]{1,20}:/.test(next) && !/^(?:说明|补充|补充约定|例外|例外情况|条件|其中)\s*:/.test(next)) break;
      values.push(records[end].text.trim());
      sources.push(records[end]);
    }
    const value = values.join("\n").trim();
    if (value) addCandidate(key, value, sources.map((source) => source.text).join("\n"), record.pageNumber, labels.split("|")[0], [...new Set(sources.map((source) => source.pageNumber))]);
    index = end - 1;
  }
  return { suggestedFields, warnings, reviewItems };
}

// Runtime import: Vite/standalone HTML never preload or inline this large module.
const loadPdfRuntime = (assets) => import(/* @vite-ignore */ new URL("pdfjs-6.3.289/pdf.mjs", assets).href);

/** Read a local Blob only. The caller owns review, persistence and duplicate recognition prevention.
 * The optional loader is a narrow test seam for PDF startup/teardown races. UI callers omit it.
 */
export async function recognizeLocalDocument({ blob, name = "", mimeType = blob?.type || "", category = "", onProgress, signal }, loadPdf = loadPdfRuntime) {
  assertNotAborted(signal);
  if (!blob || typeof blob.arrayBuffer !== "function" || !blob.size) throw new Error("请选择有内容的本地原文件。");
  if (blob.size > MAX_FILE_BYTES) throw new Error("单份资料超过 30 MB，请在本地拆分后分别识别。");
  const kind = fileKind(name, mimeType);
  const assets = localAssets();
  if (running) throw new Error("已有一份资料正在识别，请完成或取消后再试。");
  running = true;
  let ocr;
  let pdfWorker;
  let loadingTask;
  let pdfDestroyPromise;
  let renderTask;
  let canvas;
  let pageNumber = 1;
  let totalPages = 1;
  const pages = [];
  const warnings = [];
  const progress = (stage, value = 0) => {
    if (!signal?.aborted) onProgress?.({ stage, pageNumber, totalPages, progress: Math.min(1, Math.max(0, Number(value) || 0)) });
  };
  const destroyPdf = () => {
    if (!loadingTask) return Promise.resolve();
    // PDF.js destroy waits for setup and a worker Terminate acknowledgement.
    // Start it once; cancellation may force-terminate that worker before it replies.
    pdfDestroyPromise ||= loadingTask.destroy();
    return pdfDestroyPromise;
  };
  const cancel = () => {
    ocr?.terminate();
    renderTask?.cancel();
    destroyPdf().catch(() => {});
    pdfWorker?.destroy();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const recognizeCanvas = async () => {
    assertNotAborted(signal);
    if (!ocr) {
      progress("loading");
      ocr = createOcrWorker(assets, progress);
      await waitFor(ocr.initialize(), signal);
    }
    const imageBlob = await waitFor(canvasBlob(canvas), signal);
    const bytes = new Uint8Array(await waitFor(imageBlob.arrayBuffer(), signal));
    assertNotAborted(signal);
    progress("recognizing");
    const data = await waitFor(ocr.recognize(bytes), signal);
    const text = String(data.text || "").trim();
    const confidence = Number.isFinite(data.confidence) ? data.confidence : null;
    pages.push({ pageNumber, method: "ocr", text, confidence });
    if (!text) warnings.push(`第 ${pageNumber} 页未识别到文字，请对照原件手动补充。`);
    else if (confidence != null && confidence < 70) warnings.push(`第 ${pageNumber} 页文字识别把握较低，请逐项核对。`);
  };
  try {
    progress("loading");
    if (kind === "pdf") {
      const pdfjs = await waitFor(loadPdf(assets), signal);
      assertNotAborted(signal);
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-6.3.289/pdf.worker.mjs", assets).href;
      pdfWorker = new pdfjs.PDFWorker();
      const data = new Uint8Array(await waitFor(blob.arrayBuffer(), signal));
      assertNotAborted(signal);
      loadingTask = pdfjs.getDocument({ data, worker: pdfWorker,
        cMapUrl: new URL("pdfjs-6.3.289/cmaps/", assets).href, cMapPacked: true,
        standardFontDataUrl: new URL("pdfjs-6.3.289/standard_fonts/", assets).href,
        wasmUrl: new URL("pdfjs-6.3.289/wasm/", assets).href,
        iccUrl: new URL("pdfjs-6.3.289/iccs/", assets).href,
        useSystemFonts: false, isEvalSupported: false, stopAtErrors: true,
      });
      const pdf = await waitFor(loadingTask.promise, signal);
      totalPages = pdf.numPages;
      if (totalPages > MAX_PAGES) throw new Error(`这份 PDF 共 ${totalPages} 页，超过单次 30 页上限，请在本地拆分后识别。`);
      for (pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
        assertNotAborted(signal);
        progress("extracting");
        const page = await waitFor(pdf.getPage(pageNumber), signal);
        try {
          const text = pdfText(await waitFor(page.getTextContent(), signal));
          if (/[\p{L}\p{N}]/u.test(text)) {
            pages.push({ pageNumber, method: "pdf-text", text, confidence: null });
          } else {
            const base = page.getViewport({ scale: 1 });
            const drawing = makeCanvas(base.width, base.height, 2.5);
            canvas = drawing.canvas;
            renderTask = page.render({ canvasContext: drawing.context, viewport: page.getViewport({ scale: drawing.ratio }), background: "rgb(255,255,255)" });
            await waitFor(renderTask.promise, signal);
            renderTask = null;
            await recognizeCanvas();
          }
          progress(pages.at(-1).method === "ocr" ? "recognizing" : "extracting", 1);
        } finally {
          renderTask?.cancel();
          renderTask = null;
          if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; }
          page.cleanup();
        }
      }
    } else {
      if (typeof createImageBitmap !== "function") throw new Error("当前浏览器不支持本地图片解码，请使用较新版本的浏览器。");
      const bitmap = await waitFor(createImageBitmap(blob), signal, (lateBitmap) => lateBitmap.close());
      try {
        if (bitmap.width * bitmap.height > 40_000_000) throw new Error("图片超过 4000 万像素，请在本地缩小后识别。");
        const drawing = makeCanvas(bitmap.width, bitmap.height);
        canvas = drawing.canvas;
        drawing.context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        if (drawing.ratio < 1) warnings.push("大图已缩小用于文字识别，原文件保持不变；请核对小字。");
      } finally {
        bitmap.close();
      }
      await recognizeCanvas();
      progress("recognizing", 1);
    }
    assertNotAborted(signal);
    const candidates = extractDocumentFieldSuggestions(pages, category);
    return { version: 1, mode: "local", text: pages.map((page) => page.text).join("\n\n"), pages,
      suggestedFields: candidates.suggestedFields, reviewItems: candidates.reviewItems, warnings: [...warnings, ...candidates.warnings], recognizedAt: new Date().toISOString() };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (error?.name === "PasswordException") throw new Error("这份 PDF 有密码保护，请在本地解除保护后再识别。");
    if (error?.name === "InvalidPDFException") throw new Error("无法读取这份 PDF 的页面结构，请确认原文件可以正常打开。");
    if (error?.name === "InvalidStateError" || error?.name === "EncodingError") throw new Error("无法解码这张图片，请确认原文件可以正常打开。");
    if (/Failed to fetch|fetch dynamically imported module|Importing a module script failed/i.test(error?.message || "")) {
      throw new Error("本地识别资源加载失败，请确认本地服务包含完整识别资源。");
    }
    throw error instanceof Error ? error : new Error(`本地识别失败：${String(error)}`);
  } finally {
    try {
      ocr?.terminate();
      renderTask?.cancel();
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      // Never block cancellation on a handshake with an already terminated worker.
      // Keep the abort listener active during normal teardown, too.
      if (!signal?.aborted) {
        try { await waitFor(destroyPdf(), signal); } catch { /* Failed or cancelled teardown still releases our worker. */ }
      }
    } finally {
      try { pdfWorker?.destroy(); } finally {
        signal?.removeEventListener("abort", cancel);
        running = false;
      }
    }
    // Cancellation can arrive while normal PDF teardown is being awaited.
    assertNotAborted(signal);
  }
}
