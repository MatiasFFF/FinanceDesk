import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractDocumentFieldSuggestions, recognizeLocalDocument } from "../src/features/intake/localDocumentRecognition.js";

test("合同候选保留页码和原文，歧义金额不代替人工选择", () => {
  const result = extractDocumentFieldSuggestions([
    { pageNumber: 1, text: "甲 方：上海示例有限公司\n乙方：杭州示例工作室\n合同金额：￥12,345.60元\n服务开始日期：2026年9月1日\n服务结束日期：2026年9月31日\n结算周期：按月\n退款条款：提前七日申请退款" },
    { pageNumber: 2, text: "合同金额：10000元" },
  ], "合同");
  assert.equal(result.suggestedFields.partyA.value, "上海示例有限公司");
  assert.equal(result.suggestedFields.partyA.sourceText, "甲 方：上海示例有限公司");
  assert.equal(result.suggestedFields.partyA.pageNumber, 1);
  assert.equal(result.suggestedFields.serviceStartDate.value, "2026-09-01");
  assert.equal(result.suggestedFields.serviceEndDate, undefined);
  assert.equal(result.suggestedFields.amount, undefined);
  assert.equal(result.suggestedFields.settlementCycle.value, "按月");
  assert.equal(result.suggestedFields.refundTerms.value, "提前七日申请退款");
  assert.equal(result.warnings.length, 1);

  const sourceText = "服务期限 : 2026-09-01 至 2026-09-30";
  const dates = extractDocumentFieldSuggestions([{ pageNumber: 2, text: sourceText }], "合同");
  assert.deepEqual(dates.suggestedFields.serviceStartDate, { value: "2026-09-01", sourceText, pageNumber: 2 });
  assert.deepEqual(dates.suggestedFields.serviceEndDate, { value: "2026-09-30", sourceText, pageNumber: 2 });
  const ambiguousDates = extractDocumentFieldSuggestions([
    { pageNumber: 1, text: sourceText }, { pageNumber: 2, text: "服务开始日期：2026-09-02" },
  ], "合同");
  assert.equal(ambiguousDates.suggestedFields.serviceStartDate, undefined);
  assert.equal(ambiguousDates.warnings.length, 1);
  for (const range of ["2026-09-30 至 2026-09-01", "2026-09-01 至 2026-09-31"]) {
    const invalid = extractDocumentFieldSuggestions([{ pageNumber: 1, text: `服务期限：${range}` }], "合同");
    assert.deepEqual(invalid.suggestedFields, {});
    assert.equal(invalid.warnings.length, 1);
  }
});

test("发票只建议明确字段，不推断销进项或查验完成", () => {
  const { suggestedFields } = extractDocumentFieldSuggestions([{ pageNumber: 3, text:
    "发票号码：12345678901234567890\n开票日期：2026-09-02\n价税合计（小写）：￥1,060.00\n税额：60.00\n税率：6%\n已查验通过\n销项发票",
  }], "发票");
  assert.equal(suggestedFields.invoiceNumber.value, "12345678901234567890");
  assert.equal(suggestedFields.invoiceDate.value, "2026-09-02");
  assert.equal(suggestedFields.amount.value, 1060);
  assert.equal(suggestedFields.taxAmount.value, 60);
  assert.equal(suggestedFields.taxRate.value, 6);
  assert.equal(suggestedFields.taxDirection, undefined);
  assert.equal(suggestedFields.verificationStatus, undefined);
  assert.equal(suggestedFields.amount.pageNumber, 3);
});

function installBrowser(t, { stall = false } = {}) {
  const original = new Map(["location", "document", "Worker", "createImageBitmap"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const workers = [];
  const canvases = [];
  let bitmapCloses = 0;
  let started;
  const workerStarted = new Promise((resolve) => { started = resolve; });
  class LocalWorker {
    constructor(url) {
      this.url = String(url);
      this.messages = [];
      this.terminated = false;
      workers.push(this);
      started();
    }
    postMessage(packet) {
      this.messages.push(packet);
      if (stall) return;
      queueMicrotask(() => {
        if (!this.terminated) this.onmessage?.({ data: {
          jobId: packet.jobId, action: packet.action, status: "resolve",
          data: packet.action === "recognize" ? { text: "甲方：示例公司\n合同金额：100.00元", confidence: 93 } : {},
        } });
      });
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperties(globalThis, {
    location: { configurable: true, value: { protocol: "http:", origin: "http://localhost:4174" } },
    document: { configurable: true, value: {
      baseURI: "http://localhost:4174/",
      createElement(tag) {
        assert.equal(tag, "canvas");
        const canvas = { width: 0, height: 0, getContext() { return { fillRect() {}, drawImage() {} }; }, toBlob(callback) { callback(new Blob(["local-image-bytes"], { type: "image/png" })); } };
        canvases.push(canvas);
        return canvas;
      },
    } },
    Worker: { configurable: true, value: LocalWorker },
    createImageBitmap: { configurable: true, value: async () => ({ width: 100, height: 200, close() { bitmapCloses += 1; } }) },
  });
  t.after(() => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { workers, canvases, workerStarted, get bitmapCloses() { return bitmapCloses; } };
}

// Worker output is simulated here to verify lifecycle/routing, not OCR accuracy.
// Actual Chinese OCR/PDF acceptance belongs to the control task's browser pass.
test("图片识别只用本地资源，复用一只 worker，返回候选并释放图像", async (t) => {
  const browser = installBrowser(t);
  const input = new Blob(["untouched original"], { type: "image/png" });
  const result = await recognizeLocalDocument({ blob: input, name: "合同.png", category: "合同" });
  assert.equal(browser.workers.length, 1);
  const worker = browser.workers[0];
  assert.equal(new URL(worker.url).origin, "http://localhost:4174");
  assert.deepEqual(worker.messages.map((message) => message.action), ["load", "loadLanguage", "initialize", "recognize"]);
  for (const field of [worker.messages[0].payload.options.corePath, worker.messages[1].payload.options.langPath]) {
    assert.equal(new URL(field).origin, "http://localhost:4174");
  }
  assert.deepEqual(worker.messages[1].payload.langs, ["chi_sim", "eng"]);
  assert.equal(result.mode, "local");
  assert.equal(result.pages[0].method, "ocr");
  assert.equal(result.suggestedFields.amount.value, 100);
  assert.equal(await input.text(), "untouched original");
  assert.equal(worker.terminated, true);
  assert.equal(browser.bitmapCloses, 1);
  assert.ok(browser.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
});

test("加载中的取消立即终止 worker，并允许下一次识别", async (t) => {
  const browser = installBrowser(t, { stall: true });
  const controller = new AbortController();
  const input = { blob: new Blob(["image"], { type: "image/png" }), name: "合同.png", signal: controller.signal };
  const operation = recognizeLocalDocument(input);
  await browser.workerStarted;
  await assert.rejects(recognizeLocalDocument({ ...input, signal: undefined }), /已有一份资料/);
  controller.abort();
  await assert.rejects(operation, { name: "AbortError" });
  assert.equal(browser.workers[0].terminated, true);
  assert.ok(browser.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
  const again = new AbortController();
  const next = recognizeLocalDocument({ ...input, signal: again.signal, onProgress() { again.abort(); } });
  await assert.rejects(next, { name: "AbortError" });
  assert.equal(browser.workers.length, 1);
});

test("PDF 加载或清理中取消，即使销毁应答不返回也能开始下一份 PDF", { timeout: 2000 }, async (t) => {
  for (const phase of ["loading", "extracting", "destroying"]) {
    await t.test(phase, async (t) => {
      const browser = installBrowser(t);
      const workers = [];
      const tasks = [];
      let reachedPhase;
      const phaseReached = new Promise((resolve) => { reachedPhase = resolve; });
      const pending = new Promise(() => {});
      let pageCleanups = 0;
      class PDFWorker {
        constructor() { this.destroyed = false; workers.push(this); }
        destroy() { this.destroyed = true; }
      }
      const runtime = {
        GlobalWorkerOptions: {}, PDFWorker,
        getDocument({ worker }) {
          const first = tasks.length === 0;
          const page = {
            getTextContent() {
              if (first && phase === "extracting") { reachedPhase(); return pending; }
              return Promise.resolve({ items: [{ str: "合同金额：1200元", hasEOL: true }] });
            },
            cleanup() { pageCleanups += 1; },
          };
          const pdf = { numPages: 1, getPage: async () => page };
          const task = {
            destroyCalls: 0,
            promise: first && phase === "loading" ? pending : Promise.resolve(pdf),
            destroy() {
              this.destroyCalls += 1;
              if (!first) return Promise.resolve();
              if (phase === "destroying") reachedPhase();
              // Match PDF.js: cleanup waits for the worker's acknowledgement.
              // An abort that terminates the worker leaves this promise unresolved.
              return new Promise((resolve) => queueMicrotask(() => {
                if (!worker.destroyed && phase !== "destroying") resolve();
              }));
            },
          };
          tasks.push(task);
          if (first && phase === "loading") reachedPhase();
          return task;
        },
      };
      const controller = new AbortController();
      const input = { blob: new Blob(["local PDF bytes"], { type: "application/pdf" }), name: "合同.pdf", category: "合同" };
      const first = recognizeLocalDocument({ ...input, signal: controller.signal }, async () => runtime);
      await phaseReached;
      controller.abort();
      await assert.rejects(first, { name: "AbortError" });
      assert.equal(workers[0].destroyed, true);
      assert.equal(tasks[0].destroyCalls, 1);
      const next = await recognizeLocalDocument(input, async () => runtime);
      assert.equal(next.pages[0].method, "pdf-text");
      assert.equal(next.suggestedFields.amount.value, 1200);
      assert.equal(workers.length, 2);
      assert.ok(workers.every((worker) => worker.destroyed));
      assert.equal(tasks[1].destroyCalls, 1);
      assert.equal(browser.workers.length, 0, "文字 PDF 不启动 OCR worker");
      assert.ok(pageCleanups >= 1);
    });
  }
});

test("超限与单文件 HTML 明确报错，不开始下载或返回残缺成功", async (t) => {
  const browser = installBrowser(t);
  await assert.rejects(recognizeLocalDocument({ blob: { size: 30 * 1024 * 1024 + 1, arrayBuffer() { throw new Error("不得读原件"); } }, name: "大文件.pdf" }), /超过 30 MB/);
  location.protocol = "file:";
  await assert.rejects(recognizeLocalDocument({ blob: new Blob(["pdf"]), name: "资料.pdf" }), /本地网页入口/);
  assert.equal(browser.workers.length, 0);
});

test("离线分发包含当前适配器实际选用的引擎及语言资源", async () => {
  const root = new URL("../public/local-recognition/v1/", import.meta.url);
  for (const path of [
    "tesseract-7.0.0/worker.min.js", "tesseract-7.0.0/core/tesseract-core-lstm.wasm.js",
    "tesseract-7.0.0/core/tesseract-core-simd-lstm.wasm.js", "tesseract-7.0.0/core/tesseract-core-relaxedsimd-lstm.wasm.js",
    "languages-1.0.0/chi_sim.traineddata.gz", "languages-1.0.0/eng.traineddata.gz",
    "pdfjs-6.3.289/pdf.mjs", "pdfjs-6.3.289/pdf.worker.mjs", "languages-1.0.0/LICENSE.tessdata",
  ]) assert.ok((await readFile(new URL(path, root))).length > 0, path);
});
