import test from "node:test";
import assert from "node:assert/strict";
import { createBlankWorkspace, createInitialState, normalizeWorkspace } from "../src/domain/foundation.js";
import { createFinanceDeskStore } from "../src/store/financeDeskStore.js";
import { createLocalFoundationRepository, createMemoryStorage } from "../src/storage/localFoundationRepository.js";
import { createMemoryFileVault } from "../src/features/intake/browserFileVault.js";
import { saveLocalDocument, saveLocalDocumentRecognition } from "../src/features/intake/documentIntake.js";
import { createAiFinanceService } from "../src/application/aiFinanceService.js";
import { runFinanceAssistant, ASSISTANT_TOOL_RESULT_LIMIT } from "../src/application/deepseekClient.js";

// Synthetic local files and an in-memory ledger only. No live account, OCR,
// browser, server or external API is required by these behavior cases.
const now = () => new Date("2026-09-12T08:00:00.000Z");
const csv = "日期,对方,摘要,收入,支出,流水号,余额\n2026-09-01,客户甲,服务款,100,,PIPE001,200\n2026-09-02,银行,手续费,,25,PIPE002,175";
const bankFile = (text = csv) => Object.assign(new Blob([text], { type: "text/csv" }), { name: "恢复流水.csv" });
function fixture() {
  const workspace = normalizeWorkspace(createBlankWorkspace({ id: "pipeline-local", name: "合成测试工作台", currentPeriod: "2026-09" }, { now }), { now });
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now });
  repository.save({ ...createInitialState({ now }), workspaces: [workspace], activeWorkspaceId: workspace.id, activeUserId: null });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = workspace.id;
  const period = workspace.currentPeriod;
  const createService = (targetStore = store) => createAiFinanceService({ store: targetStore, fileVault, workspaceId, period });
  return { store, fileVault, workspaceId, period, storage, repository, createService, service: createService() };
}
async function prepared(f) {
  const file = bankFile();
  const account = f.service.createBankAccount({ name: "本地账户" });
  const [attachment] = await f.service.uploadFiles([file]);
  const { proposal } = await f.service.invokeTool("prepare_bank_import", { documentId: attachment.documentId, accountId: account.id });
  return { file, account, attachment, proposal };
}
function reload(f) {
  const store = createFinanceDeskStore({ repository: createLocalFoundationRepository({ storage: f.storage, now }) });
  return { store, service: f.createService(store) };
}

test("reuploading missing original restores the same document and existing confirmation without duplicate records", async () => {
  const f = fixture();
  const { file, attachment, proposal } = await prepared(f);
  const document = f.store.getActiveWorkspace().documents.find((item) => item.id === attachment.documentId);
  await f.fileVault.delete(document.storage.blobId);
  const before = f.store.getActiveWorkspace();
  f.store.actions.replaceWorkspace(f.workspaceId, { ...before, documents: before.documents.map((item) => item.id === document.id
    ? { ...item, storage: { ...item.storage, availableLocally: false } } : item) });
  await assert.rejects(f.service.readOriginal(document.id), { code: "AI_ORIGINAL_UNAVAILABLE" });
  const restored = await f.service.uploadFiles([file]);
  assert.equal(restored[0].documentId, document.id);
  assert.equal(f.store.getActiveWorkspace().documents.length, 1);
  assert.equal(f.store.getActiveWorkspace().documents[0].storage.availableLocally, true);
  assert.equal((await f.service.readOriginal(document.id)).blob, file);
  assert.equal(f.service.getConversation().proposals[0].id, proposal.id);
  assert.equal(f.service.getConversation().proposals[0].status, "pending");
  const applied = await f.service.confirmProposal(proposal.id);
  assert.equal(applied.result.counts.imported, 2);
  assert.equal((await f.fileVault.listByWorkspace(f.workspaceId)).length, 1);
  assert.equal(f.store.getActiveWorkspace().transactions.length, 2);
  assert.ok(f.store.getActiveWorkspace().transactions.every((item) => item.evidenceIds.includes(document.id)));
});

test("same-file recovery repairs corrupted bytes while retaining valid recognition and field suggestions", async () => {
  const f = fixture();
  const file = Object.assign(new Blob(["synthetic invoice bytes"], { type: "application/pdf" }), { name: "恢复票据.pdf" });
  const document = await saveLocalDocument({ ...f, file, metadata: { category: "发票", period: f.period } });
  await saveLocalDocumentRecognition({ ...f, documentId: document.id, sourceHash: document.hash, category: "发票",
    result: { mode: "local", text: "合计128.50", pages: [{ pageNumber: 1, text: "合计128.50" }], suggestedFields: {} } });
  const { proposal } = await f.service.invokeTool("propose_document_fields", { documentId: document.id, fields: { amount: 128.5 }, reason: "合成文字依据" });
  const stored = await f.fileVault.get(document.id);
  await f.fileVault.put({ ...stored, blob: new Blob(["corrupt bytes"]) });
  const [restored] = await f.service.uploadFiles([file]);
  assert.equal(restored.documentId, document.id);
  assert.equal(restored.recognitionStatus, "completed", "valid saved recognition is reused without rerunning OCR");
  assert.equal((await f.fileVault.get(document.id)).recognition.id, stored.recognition.id);
  assert.equal((await f.service.confirmProposal(proposal.id)).proposal.status, "applied");
  assert.equal(f.store.getActiveWorkspace().documents[0].structuredData.amount, 128.5);
  assert.equal(f.store.getActiveWorkspace().documents.length, 1);
});

test("reupload recovery cannot replace a blob owned by another workspace or bypass changed targets", async () => {
  const f = fixture();
  const { file, attachment } = await prepared(f);
  const owned = await f.fileVault.get(attachment.documentId);
  const foreign = { ...owned, workspaceId: "another-workspace", blob: new Blob(["foreign-content"]) };
  await f.fileVault.put(foreign);
  await assert.rejects(f.service.uploadFiles([file]), { code: "AI_ORIGINAL_UNAVAILABLE" });
  assert.equal(await f.fileVault.get(attachment.documentId), foreign);
  const replacement = { ...owned, hash: "newer-original-hash" };
  await f.fileVault.put(replacement);
  await assert.rejects(f.service.uploadFiles([file]), { code: "AI_SOURCE_CHANGED" });
  assert.equal(await f.fileVault.get(attachment.documentId), replacement);
  await f.fileVault.delete(attachment.documentId);
  f.store.actions.setPeriod(f.workspaceId, "2026-10");
  await assert.rejects(f.service.uploadFiles([file]), { code: "AI_TARGET_CHANGED" });
  assert.equal(await f.fileVault.get(attachment.documentId), undefined);
});

test("cancel before restoring bytes prevents writes; retry can finish a prior restoration whose availability update was interrupted", async () => {
  const f = fixture();
  const { file, attachment } = await prepared(f);
  const original = f.store.getActiveWorkspace();
  f.store.actions.replaceWorkspace(f.workspaceId, { ...original, documents: original.documents.map((item) => ({ ...item, storage: { ...item.storage, availableLocally: false } })) });
  await f.fileVault.delete(attachment.documentId);
  const controller = new AbortController();
  const get = f.fileVault.get.bind(f.fileVault);
  f.fileVault.get = async (...args) => { const value = await get(...args); controller.abort(); return value; };
  await assert.rejects(f.service.uploadFiles([file], { signal: controller.signal }), { name: "AbortError" });
  assert.equal(await get(attachment.documentId), undefined);
  f.fileVault.get = get;
  const afterPut = new AbortController();
  const put = f.fileVault.put.bind(f.fileVault);
  f.fileVault.put = async (record) => { const id = await put(record); afterPut.abort(); return id; };
  await assert.rejects(f.service.uploadFiles([file], { signal: afterPut.signal }), { name: "AbortError" });
  assert.equal((await get(attachment.documentId)).blob, file, "already restored user bytes are retained");
  assert.equal(f.store.getActiveWorkspace().documents[0].storage.availableLocally, false);
  f.fileVault.put = put;
  const [restored] = await f.service.uploadFiles([file]);
  assert.equal(restored.documentId, attachment.documentId);
  assert.equal(f.store.getActiveWorkspace().documents[0].storage.availableLocally, true);
  assert.equal(f.store.getActiveWorkspace().documents.length, 1);
});

test("long document tools read the tail through stable offsets and preserve the complete local source", async () => {
  const f = fixture();
  const text = "正文".repeat(13000) + "\n末页发票金额：987.65\n" + "附件".repeat(13000);
  const file = Object.assign(new Blob(["synthetic multi-page original"], { type: "application/pdf" }), { name: "长发票.pdf" });
  const document = await saveLocalDocument({ ...f, file, metadata: { category: "发票", period: f.period } });
  await saveLocalDocumentRecognition({ ...f, documentId: document.id, sourceHash: document.hash, category: "发票",
    result: { mode: "local", text, pages: [{ pageNumber: 1, text }], suggestedFields: {} } });
  let offset = 0;
  let combined = "";
  let chunks = 0;
  do {
    const result = await f.service.invokeTool("read_document", { documentId: document.id, offset });
    assert.equal(result.offset, offset);
    assert.equal(result.totalChars, text.length);
    assert.ok(result.text.length <= 24000);
    assert.equal(result.truncated, true);
    combined += result.text;
    chunks += 1;
    offset = result.nextOffset;
  } while (offset !== null);
  assert.equal(chunks, 3);
  assert.equal(combined, text);
  assert.match(combined, /987\.65/);
  const beyond = await f.service.invokeTool("read_document", { documentId: document.id, offset: text.length });
  assert.equal(beyond.text, "");
  assert.equal(beyond.nextOffset, null);
  const invalid = await f.service.invokeTool("read_document", { documentId: document.id, offset: -1 });
  assert.equal(invalid.status, "needs_input");
  assert.equal((await f.fileVault.get(document.id)).recognition.result.text, text);
  assert.equal(f.store.getActiveWorkspace().documents[0].structuredData.amount, null);
});

test("bank import and applied confirmation persist in one commit with current unrelated data intact", async () => {
  const f = fixture();
  const { proposal } = await prepared(f);
  f.service.appendMessage({ role: "user", content: "这条消息必须保留" });
  const save = f.repository.save.bind(f.repository);
  const persisted = [];
  f.repository.save = (state, ...args) => { persisted.push(structuredClone(state)); return save(state, ...args); };
  const applied = await f.service.confirmProposal(proposal.id);
  assert.equal(persisted.length, 1);
  const written = persisted[0].workspaces.find((item) => item.id === f.workspaceId);
  assert.equal(written.transactions.length, 2);
  assert.equal(written.bankImports.length, 1);
  assert.equal(written.aiSimple.conversations[f.period].proposals[0].status, "applied");
  assert.equal(written.aiSimple.conversations[f.period].messages[0].content, "这条消息必须保留");
  assert.equal(applied.result.counts.imported, 2);
  const loaded = reload(f);
  assert.deepEqual((await loaded.service.confirmProposal(proposal.id)).result, applied.result);
  assert.equal(loaded.store.getActiveWorkspace().transactions.length, 2);
});

test("a failed combined bank commit leaves both parts unchanged and a reloaded retry imports exactly once", async () => {
  const f = fixture();
  const { proposal } = await prepared(f);
  const save = f.repository.save.bind(f.repository);
  f.repository.save = (state, ...args) => {
    const workspace = state.workspaces.find((item) => item.id === f.workspaceId);
    if (workspace.aiSimple.conversations[f.period].proposals.some((item) => item.id === proposal.id && item.status === "applied")) throw new Error("合成存储失败");
    return save(state, ...args);
  };
  await assert.rejects(f.service.confirmProposal(proposal.id), /合成存储失败/);
  assert.equal(f.store.getActiveWorkspace().transactions.length, 0);
  assert.equal(f.store.getActiveWorkspace().bankImports.length, 0);
  assert.equal(f.service.getConversation().proposals[0].status, "pending");
  const loaded = reload(f);
  const applied = await loaded.service.confirmProposal(proposal.id);
  assert.equal(applied.result.counts.imported, 2);
  assert.equal(loaded.store.getActiveWorkspace().bankImports.length, 1);
  assert.equal((await loaded.service.confirmProposal(proposal.id)).result.counts.imported, 2);
  assert.equal(loaded.store.getActiveWorkspace().transactions.length, 2);
});

test("a synchronous import-finalization error cannot commit bank data before confirmation", async () => {
  const f = fixture();
  const { proposal } = await prepared(f);
  const apply = f.store.actions.applyBankImport;
  f.store.actions.applyBankImport = (workspaceId, plan, options) => apply(workspaceId, plan, { ...options,
    finalizeWorkspace: (...args) => { options.finalizeWorkspace(...args); throw new Error("合成确认生成失败"); },
  });
  await assert.rejects(f.service.confirmProposal(proposal.id), /合成确认生成失败/);
  assert.equal(f.store.getActiveWorkspace().transactions.length, 0);
  assert.equal(f.store.getActiveWorkspace().bankImports.length, 0);
  assert.equal(f.service.getConversation().proposals[0].status, "pending");
  f.store.actions.applyBankImport = apply;
  assert.equal((await f.service.confirmProposal(proposal.id)).result.counts.imported, 2);
});

test("document pagination through the actual client byte limit delivers every character with matching nextOffset", async () => {
  const source = "本页为条目说明🧾\"\\\n".repeat(4000) + "尾页金额123.45";
  const pages = [];
  const makeCall = (offset) => ({ id: `document-part-${offset}`, type: "function", function: { name: "read_document",
    arguments: JSON.stringify({ documentId: "synthetic-long-document", offset }) } });
  await runFinanceAssistant({ apiKey: "test_pipeline_wire_key_123", messages: [{ role: "user", content: "读完整份合成资料" }],
    executeTool: ({ arguments: { offset } }) => {
      const text = source.slice(offset, offset + 24000);
      return { documentId: "synthetic-long-document", name: "长票据", fields: { counterparty: "长字段".repeat(12000) },
        allowedFields: ["amount"], text, offset, totalChars: source.length,
        nextOffset: offset + text.length < source.length ? offset + text.length : null, truncated: true };
    },
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      const last = payload.messages.at(-1);
      let offset = 0;
      if (last.role === "tool") {
        assert.ok(new TextEncoder().encode(last.content).byteLength <= ASSISTANT_TOOL_RESULT_LIMIT);
        const page = JSON.parse(last.content);
        assert.equal(page.offset, pages.reduce((length, item) => length + item.text.length, 0));
        assert.equal(page.text, source.slice(page.offset, page.offset + page.text.length));
        if (page.nextOffset !== null) assert.equal(page.nextOffset, page.offset + page.text.length);
        assert.equal(page.totalChars, source.length);
        pages.push(page);
        offset = page.nextOffset;
      }
      const calls = offset === null ? [] : [makeCall(offset)];
      return new Response(JSON.stringify({ message: { role: "assistant", content: calls.length ? "继续读取" : "已取得完整合成正文", ...(calls.length ? { tool_calls: calls } : {}) },
        finishReason: calls.length ? "tool_calls" : "stop" }), { headers: { "Content-Type": "application/json" } });
    },
  });
  assert.ok(pages[0].nextOffset < 24000, "wire limit must reduce this oversized source segment");
  assert.equal(pages.at(-1).nextOffset, null);
  assert.equal(pages.map((page) => page.text).join(""), source);
  assert.ok(pages.every((page) => !page.text.includes("已截断")));
});
