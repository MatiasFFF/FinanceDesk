import test from "node:test";
import assert from "node:assert/strict";
import {
  createFinanceDeskStore, createLocalFoundationRepository, createMemoryStorage, createMemoryFileVault,
  saveLocalDocument, saveLocalDocumentRecognition, getLocalDocumentRecognition, updateLocalDocumentMetadata,
} from "../src/foundation.js";
import { workflowSourceFingerprint } from "../src/productWorkflow.js";

const now = () => new Date("2026-09-05T08:00:00.000Z");

async function fixture() {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const file = Object.assign(new Blob(["original invoice"], { type: "application/pdf" }), { name: "本地发票.pdf" });
  const document = await saveLocalDocument({ store, fileVault, workspaceId, file,
    metadata: { category: "发票", structuredData: { counterparty: "人工单位" } } });
  return { store, fileVault, workspaceId, document, storage, file };
}

function result(text = "发票号码：12345678901234567890\n价税合计：128.50") {
  return { version: 1, mode: "local", text, pages: [{ pageNumber: 1, method: "ocr", text, confidence: 92 }],
    suggestedFields: {
      invoiceNumber: { value: "12345678901234567890", sourceText: "发票号码：12345678901234567890", pageNumber: 1 },
      amount: { value: 128.5, sourceText: "价税合计：128.50", pageNumber: 1 },
    }, warnings: [], recognizedAt: now().toISOString() };
}

function saveInput(context, overrides = {}) {
  return { ...context, documentId: context.document.id, sourceHash: context.document.hash,
    category: context.document.category, result: result(), ...overrides };
}

function currentDocument(context) {
  return context.store.getActiveWorkspace().documents.find((document) => document.id === context.document.id);
}

test("识别正文保存在原件记录，候选不改人工字段及财务指纹，刷新直接恢复", async () => {
  const context = await fixture();
  const before = context.store.getActiveWorkspace();
  const fingerprint = workflowSourceFingerprint(before);
  const fullText = `仅在 IndexedDB 保存的正文${"甲方合同内容".repeat(10000)}`;
  const saved = await saveLocalDocumentRecognition(saveInput(context, { result: result(fullText) }));
  const after = context.store.getActiveWorkspace();
  const document = currentDocument(context);
  assert.deepEqual(document.structuredData, context.document.structuredData);
  assert.equal(workflowSourceFingerprint(after), fingerprint);
  assert.equal(document.contentRecognition.suggestedFields.amount.value, 128.5);
  assert.equal(document.contentRecognition.sourceHash, context.document.hash);
  assert.equal(JSON.stringify(document).includes(fullText), false);
  const records = await context.fileVault.listByWorkspace(context.workspaceId);
  assert.equal(records.length, 1);
  assert.equal(records[0].blob, context.file);
  assert.equal(records[0].recognition.result.text, fullText);
  const reloaded = createFinanceDeskStore({ repository: createLocalFoundationRepository({ storage: context.storage, now }) });
  const restoredDocument = reloaded.getActiveWorkspace().documents.find((item) => item.id === document.id);
  assert.deepEqual(await getLocalDocumentRecognition({ fileVault: context.fileVault, workspaceId: context.workspaceId, document: restoredDocument }), saved);
});

test("候选明确确认后保存字段和确认记录，普通资料编辑保留识别结果", async () => {
  const context = await fixture();
  const saved = await saveLocalDocumentRecognition(saveInput(context));
  updateLocalDocumentMetadata({ ...context, documentId: context.document.id, actor: "核对人", patch: {
    structuredData: { invoiceNumber: "12345678901234567890", amount: 129 },
    recognitionConfirmation: { resultId: saved.id, fields: ["invoiceNumber", "amount"] },
  } });
  let document = currentDocument(context);
  assert.equal(document.structuredData.counterparty, "人工单位");
  assert.equal(document.structuredData.amount, 129);
  assert.deepEqual(document.contentRecognition.confirmation.fields, { invoiceNumber: "12345678901234567890", amount: 129 });
  assert.equal(document.contentRecognition.confirmation.actor, "核对人");
  const confirmation = document.contentRecognition.confirmation;
  updateLocalDocumentMetadata({ ...context, documentId: context.document.id, patch: { name: "核对完成.pdf" } });
  document = currentDocument(context);
  assert.equal(document.contentRecognition.resultId, saved.id);
  assert.deepEqual(document.contentRecognition.confirmation, confirmation);
  const reloaded = createFinanceDeskStore({ repository: createLocalFoundationRepository({ storage: context.storage, now }) });
  assert.deepEqual(reloaded.getActiveWorkspace().documents.find((item) => item.id === document.id).contentRecognition.confirmation, confirmation);
});

test("已取消、已切资料、错误哈希或类别的结果不写回", async () => {
  const context = await fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(saveLocalDocumentRecognition(saveInput(context, { signal: controller.signal })), { name: "AbortError" });
  await assert.rejects(saveLocalDocumentRecognition(saveInput(context, { isCurrent: () => false })), { name: "AbortError" });
  await assert.rejects(saveLocalDocumentRecognition(saveInput(context, { sourceHash: "wrong-hash" })), /已变化/);
  await assert.rejects(saveLocalDocumentRecognition(saveInput(context, { category: "合同" })), /已变化/);
  await assert.rejects(saveLocalDocumentRecognition(saveInput(context, { workspaceId: "other-workspace" })), { name: "AbortError" });
  assert.equal(currentDocument(context).contentRecognition.resultId, undefined);
  assert.equal((await context.fileVault.get(context.document.id)).recognition, undefined);
});

test("结果写入期间取消会恢复已有正文，不修改原件或人工数据", async () => {
  const context = await fixture();
  const saved = await saveLocalDocumentRecognition(saveInput(context));
  const controller = new AbortController();
  const originalSetRecognition = context.fileVault.setRecognition;
  context.fileVault.setRecognition = async (...args) => {
    await originalSetRecognition(...args);
    if (args[4]?.signal) controller.abort();
  };
  await assert.rejects(saveLocalDocumentRecognition(saveInput(context, { result: result("新正文"), signal: controller.signal })), { name: "AbortError" });
  assert.equal(currentDocument(context).contentRecognition.resultId, saved.id);
  assert.deepEqual(await getLocalDocumentRecognition({ ...context, document: currentDocument(context) }), saved);
  assert.equal((await context.fileVault.get(context.document.id)).blob, context.file);
});

test("工作台保存失败时回退派生正文，保留上次已保存结果", async () => {
  const context = await fixture();
  const saved = await saveLocalDocumentRecognition(saveInput(context));
  context.store.actions.replaceWorkspace = () => { throw new Error("存储空间不足"); };
  await assert.rejects(saveLocalDocumentRecognition(saveInput(context, { result: result("未保存正文") })), /存储空间不足/);
  assert.deepEqual(await getLocalDocumentRecognition({ ...context, document: currentDocument(context) }), saved);
});

test("备份恢复后缺少派生正文仍保留候选和人工字段，不伪造识别全文", async () => {
  const context = await fixture();
  await saveLocalDocumentRecognition(saveInput(context));
  const document = currentDocument(context);
  const newVault = createMemoryFileVault();
  await newVault.put({ id: document.id, workspaceId: context.workspaceId, hash: document.hash, blob: context.file });
  assert.equal(await getLocalDocumentRecognition({ fileVault: newVault, workspaceId: context.workspaceId, document }), null);
  assert.equal(document.contentRecognition.suggestedFields.amount.value, 128.5);
  assert.equal(document.structuredData.counterparty, "人工单位");
});

test("更换原件或跨工作台不会读到旧正文，旧候选不能冒充本次确认", async () => {
  const context = await fixture();
  const saved = await saveLocalDocumentRecognition(saveInput(context));
  const document = currentDocument(context);
  assert.equal(await getLocalDocumentRecognition({ ...context, document: { ...document, hash: "changed" } }), null);
  await assert.rejects(getLocalDocumentRecognition({ fileVault: context.fileVault, workspaceId: "other-workspace", document }), /原件|本地文件|当前工作台/);
  assert.throws(() => updateLocalDocumentMetadata({ ...context, documentId: document.id, patch: {
    structuredData: { amount: 200 }, recognitionConfirmation: { resultId: `${saved.id}-stale`, fields: ["amount"] },
  } }), /候选已变化/);
  assert.equal(currentDocument(context).structuredData.amount, null);
});
