import test from "node:test";
import assert from "node:assert/strict";
import {
  createFinanceDeskStore, createLocalFoundationRepository, createMemoryStorage, createMemoryFileVault,
  saveLocalDocument, saveLocalDocumentRecognition, getLocalDocumentRecognition, updateLocalDocumentMetadata,
} from "../src/foundation.js";
import { workflowSourceFingerprint } from "../src/productWorkflow.js";
import { applyContractBillingPlan, buildContractBillingPlan } from "../src/features/intake/documentIntake.js";
import { extractDocumentFieldSuggestions } from "../src/features/intake/localDocumentRecognition.js";

const now = () => new Date("2026-09-05T08:00:00.000Z");

async function fixture(category = "发票") {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const file = Object.assign(new Blob(["original invoice"], { type: "application/pdf" }), { name: "本地发票.pdf" });
  const document = await saveLocalDocument({ store, fileVault, workspaceId, file,
    metadata: { category, structuredData: category === "合同" ? { partyA: "人工甲方" } : { counterparty: "人工单位" } } });
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
  assert.equal(document.period, context.document.period, "未分配账期的资料仍保持未分配");
  assert.equal(saved.source.period, before.currentPeriod, "保存开始时捕获原工作台的账期");
  assert.equal(JSON.stringify(document).includes(fullText), false);
  const records = await context.fileVault.listByWorkspace(context.workspaceId);
  assert.equal(records.length, 1);
  assert.equal(records[0].blob, context.file);
  assert.equal(records[0].recognition.result.text, fullText);
  const reloaded = createFinanceDeskStore({ repository: createLocalFoundationRepository({ storage: context.storage, now }) });
  const restoredDocument = reloaded.getActiveWorkspace().documents.find((item) => item.id === document.id);
  assert.deepEqual(await getLocalDocumentRecognition({ fileVault: context.fileVault, workspaceId: context.workspaceId, document: restoredDocument }), saved);
});

test("provider results persist to an explicit background workspace without confirming fields", async () => {
  const context = await fixture();
  const before = context.store.getActiveWorkspace();
  const targetUserId = context.store.getState().activeUserId;
  const other = context.store.actions.createWorkspace({ name: "另一个工作台", currentPeriod: "2026-09" });
  const store = createFinanceDeskStore({ repository: createLocalFoundationRepository({ storage: context.storage, now }),
    resolveWorkspaceUserId: (id, state) => id === context.workspaceId ? targetUserId : state.activeUserId });
  const providerResult = { ...result(), mode: "provider", provider: "fixture-provider" };
  const saved = await saveLocalDocumentRecognition(saveInput({ ...context, store }, { period: context.document.period, sourceVersion: context.document.version, result: providerResult }));
  assert.equal(store.getState().activeWorkspaceId, other.id);
  const workspace = store.getState().workspaces.find((item) => item.id === context.workspaceId);
  const document = workspace.documents.find((item) => item.id === context.document.id);
  assert.equal(document.contentRecognition.provider, "fixture-provider");
  assert.equal(document.contentRecognition.mode, "provider");
  assert.equal(saved.source.workspaceId, context.workspaceId);
  assert.deepEqual(document.structuredData, context.document.structuredData);
  assert.equal(workflowSourceFingerprint(workspace), workflowSourceFingerprint(before));
  assert.equal((await context.fileVault.get(context.document.id)).recognition.result.text, providerResult.text);
});

test("recognition rejects a late original version and rolls back provider text after a version race", async () => {
  const context = await fixture();
  const saved = await saveLocalDocumentRecognition(saveInput(context));
  await assert.rejects(saveLocalDocumentRecognition(saveInput(context, { sourceVersion: context.document.version + 1 })), /已变化/);
  const write = context.fileVault.setRecognition.bind(context.fileVault);
  context.fileVault.setRecognition = async (...args) => {
    await write(...args);
    if (!args[4]?.expectedResultId) {
      const workspace = structuredClone(context.store.getActiveWorkspace());
      workspace.documents.find((item) => item.id === context.document.id).version += 1;
      context.store.actions.replaceWorkspace(context.workspaceId, workspace);
    }
  };
  await assert.rejects(saveLocalDocumentRecognition(saveInput(context, { result: { ...result("late provider text"), mode: "provider", provider: "fixture-provider" } })), /已变化/);
  assert.equal((await context.fileVault.get(context.document.id)).recognition.id, saved.id);
  assert.equal(currentDocument(context).contentRecognition.resultId, saved.id);
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
  await assert.rejects(saveLocalDocumentRecognition(saveInput(context, { workspaceId: "other-workspace" })), /已变化/);
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

test("四类条款候选经人工保存后成为合同与账单依据，金额仍取人工计划", async () => {
  const context = await fixture("合同");
  const beforeBillCount = context.store.getActiveWorkspace().bills.length;
  const text = "退款条款：七日内申请。\n扣除已履约金额。\n折扣条款：符合全年预付条件享九折。\n佣金条款：实际到账的3%。\n退款不计佣金。\n履约条件：每月交付并经双方验收。" + "每次服务均须保留交付和验收记录。".repeat(160);
  const pages = [{ pageNumber: 2, method: "ocr", text, confidence: 90 }];
  const extracted = extractDocumentFieldSuggestions(pages, "合同");
  const saved = await saveLocalDocumentRecognition(saveInput(context, { result: { version: 1, mode: "local", pages, text, ...extracted, recognizedAt: now().toISOString() } }));
  assert.equal(currentDocument(context).structuredData.discountTerms, "");
  assert.equal(currentDocument(context).contentRecognition.suggestedFields.performanceTerms.truncated, true);
  assert.equal(context.store.getActiveWorkspace().bills.length, beforeBillCount);
  const terms = Object.fromEntries(Object.entries(extracted.suggestedFields).map(([key, candidate]) => [key, candidate.value]));
  updateLocalDocumentMetadata({ ...context, documentId: context.document.id, actor: "核对人", patch: {
    structuredData: { ...terms, partyB: "合同对方", counterpartyParty: "partyB", contractType: "sales", amount: 1000, periodAmount: 1000, settlementMode: "one_time", firstBillDate: "2026-09-01", billingEndDate: "2026-09-30" },
    recognitionConfirmation: { resultId: saved.id, fields: Object.keys(terms) },
  } });
  const reloaded = createFinanceDeskStore({ repository: createLocalFoundationRepository({ storage: context.storage, now }) });
  const document = reloaded.getActiveWorkspace().documents.find((item) => item.id === context.document.id);
  for (const [key, value] of Object.entries(terms)) {
    assert.equal(document.structuredData[key], value);
    assert.equal(document.contentRecognition.confirmation.fields[key], value);
    assert.deepEqual(document.contentRecognition.confirmation.sources[key].sourcePages, [2]);
  }
  const next = applyContractBillingPlan(reloaded.getActiveWorkspace(), { documentId: document.id, asOf: "2026-09-01" }, { actor: "账单确认人", at: now().toISOString() });
  const bill = next.bills.find((item) => item.contractDocumentId === document.id);
  assert.equal(bill.amount, 1000, "识别到九折、3%不会自动改账单金额");
  assert.deepEqual(bill.contractBasis.terms, terms);
  assert.equal(bill.contractBasis.documentHash, context.document.hash);
  assert.equal(bill.contractBasis.acceptedBy, "账单确认人");
  assert.equal(next.workspace.vouchers.length, reloaded.getActiveWorkspace().vouchers.length);
  assert.equal((await context.fileVault.get(context.document.id)).blob, context.file);
});

test("条款多处表述进入复核待办，人工整理保存后解除账单阻塞并保留原文", async () => {
  const context = await fixture("合同");
  const pages = [
    { pageNumber: 1, method: "pdf-text", text: "合同金额：1000元\n退款条款：首期可全退。" },
    { pageNumber: 2, method: "pdf-text", text: "合同金额：2000元\n退款条款：后续期扣除已履约金额。" },
  ];
  const extracted = extractDocumentFieldSuggestions(pages, "合同");
  const result = { version: 1, mode: "local", pages, text: pages.map((page) => page.text).join("\n"), ...extracted, recognizedAt: now().toISOString() };
  const saved = await saveLocalDocumentRecognition(saveInput(context, { result }));
  const contract = { partyB: "合同对方", counterpartyParty: "partyB", contractType: "sales", amount: 1000, periodAmount: 1000, settlementMode: "one_time", firstBillDate: "2026-09-01", billingEndDate: "2026-09-30" };
  updateLocalDocumentMetadata({ ...context, documentId: context.document.id, patch: { structuredData: contract } });
  let workspace = context.store.getActiveWorkspace();
  assert.equal(workspace.exceptionTasks.filter((task) => task.code === "document_recognition_review" && task.status === "open").length, 2);
  assert.equal(buildContractBillingPlan(workspace, { documentId: context.document.id, asOf: "2026-09-01" }).canConfirm, false);
  assert.throws(() => applyContractBillingPlan(workspace, { documentId: context.document.id, asOf: "2026-09-01" }), /待复核/);
  updateLocalDocumentMetadata({ ...context, documentId: context.document.id, actor: "合同核对人", patch: {
    structuredData: { refundTerms: "本次为首期1000元，可全退；后续期另按2000元及已履约情况处理。" },
    recognitionReview: { resultId: saved.id, note: "两处金额适用于不同期次，本次只生成首期账单。" },
  } });
  workspace = context.store.getActiveWorkspace();
  const tasks = workspace.exceptionTasks.filter((task) => task.code === "document_recognition_review");
  assert.ok(tasks.every((task) => task.status === "resolved" && task.resolvedBy === "合同核对人"));
  assert.deepEqual(tasks.find((task) => task.recognitionFinding.field === "amount").recognitionFinding.sources.map((source) => source.value), [1000, 2000]);
  assert.ok(tasks.every((task) => task.history.at(-1).note.includes("不同期次")));
  assert.equal(buildContractBillingPlan(workspace, { documentId: context.document.id, asOf: "2026-09-01" }).canConfirm, true);
  const next = applyContractBillingPlan(workspace, { documentId: context.document.id, asOf: "2026-09-01" });
  assert.equal(next.bills.find((bill) => bill.contractDocumentId === context.document.id).amount, 1000);
  assert.deepEqual((await getLocalDocumentRecognition({ ...context, document: currentDocument(context) })).result.reviewItems, result.reviewItems);
  await saveLocalDocumentRecognition(saveInput(context, { result }));
  assert.ok(context.store.getActiveWorkspace().exceptionTasks.filter((task) => task.code === "document_recognition_review").every((task) => task.status === "resolved"), "相同原文再次识别不抹掉人工复核");
});
