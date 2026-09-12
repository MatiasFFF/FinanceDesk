import test from "node:test";
import assert from "node:assert/strict";
import { createBlankWorkspace, createInitialState, normalizeWorkspace } from "../src/domain/foundation.js";
import { createAccountingFixture } from "../src/domain/accounting/fixtures.js";
import { createFinanceDeskStore } from "../src/store/financeDeskStore.js";
import { createLocalFoundationRepository, createMemoryStorage } from "../src/storage/localFoundationRepository.js";
import { createMemoryFileVault } from "../src/features/intake/browserFileVault.js";
import { saveLocalDocument, saveLocalDocumentRecognition, updateLocalDocumentMetadata } from "../src/features/intake/documentIntake.js";
import { createAiFinanceService } from "../src/application/aiFinanceService.js";
import { withVoucherEvidence } from "./helpers/voucherEvidenceFixture.mjs";

const now = () => new Date("2026-09-12T08:00:00.000Z");
const csv = "日期,对方,摘要,收入,支出,流水号,余额\n2026-09-01,客户甲,服务款,100,,S001,200\n2026-09-02,银行,手续费,,25,S002,175";
const bankFile = (text = csv) => Object.assign(new Blob([text], { type: "text/csv" }), { name: "银行流水.csv" });

function fixture(workspace = createBlankWorkspace({ id: "ai-target", name: "简版工作台", currentPeriod: "2026-09" }, { now }), fileVault = createMemoryFileVault()) {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now });
  const normalized = normalizeWorkspace(workspace, { now });
  repository.save({ ...createInitialState({ now }), workspaces: [normalized], activeWorkspaceId: workspace.id,
    activeUserId: normalized.users.find((user) => user.status === "active")?.id || null });
  const store = createFinanceDeskStore({ repository });
  const workspaceId = workspace.id;
  const period = workspace.currentPeriod;
  const createService = (targetStore = store) => createAiFinanceService({ store: targetStore, fileVault, workspaceId, period });
  return { store, workspaceId, period, fileVault, storage, repository, createService, service: createService() };
}

async function importProposal(f, file = bankFile()) {
  const account = f.service.createBankAccount({ name: "测试账户", accountNumber: "1234" });
  const [attachment] = await f.service.uploadFiles([file]);
  const prepared = await f.service.invokeTool("prepare_bank_import", { documentId: attachment.documentId, accountId: account.id });
  return { account, attachment, proposal: prepared.proposal };
}

async function invoiceFixture() {
  const f = fixture();
  const file = Object.assign(new Blob(["synthetic invoice original"], { type: "application/pdf" }), { name: "票据.pdf" });
  const document = await saveLocalDocument({ ...f, file, metadata: { category: "发票", period: f.period, structuredData: { counterparty: "原填写单位" } } });
  const text = "发票号码：12345678901234567890\n价税合计：128.50\n销售方：候选单位";
  await saveLocalDocumentRecognition({ ...f, documentId: document.id, sourceHash: document.hash, category: "发票",
    result: { mode: "local", text, pages: [{ pageNumber: 1, text }], suggestedFields: { amount: { value: 128.5, pageNumber: 1, sourceText: "价税合计：128.50" } } } });
  return { ...f, document };
}

test("uploaded bank original, user message and pending import survive reload; confirmation imports once and reuses that original", async () => {
  const f = fixture();
  const { account, attachment, proposal } = await importProposal(f);
  f.service.appendMessage({ role: "user", content: "整理这份流水", attachments: [attachment], apiKey: "must-not-be-saved" });
  assert.equal(f.store.getActiveWorkspace().transactions.length, 0, "model preparation must not import");
  assert.equal(proposal.preview.importedCount, 2);
  assert.equal(proposal.payload, undefined, "UI receives a reviewable proposal, not mutation input");
  const reloaded = createFinanceDeskStore({ repository: createLocalFoundationRepository({ storage: f.storage, now }) });
  const service = f.createService(reloaded);
  assert.equal(service.getConversation().messages[0].attachments[0].documentId, attachment.documentId);
  assert.equal(service.getConversation().proposals[0].status, "pending");
  const [first, concurrent] = await Promise.all([service.confirmProposal(proposal.id), service.confirmProposal(proposal.id)]);
  assert.deepEqual(first, concurrent);
  assert.equal(first.result.counts.imported, 2);
  assert.deepEqual((await service.confirmProposal(proposal.id)).result, first.result);
  const duplicate = await service.invokeTool("prepare_bank_import", { documentId: attachment.documentId, accountId: account.id });
  assert.equal((await service.confirmProposal(duplicate.proposal.id)).result.counts.imported, 0);
  const workspace = reloaded.getActiveWorkspace();
  assert.equal(workspace.transactions.length, 2);
  assert.equal(workspace.documents.length, 1);
  assert.equal(workspace.bankImports.length, 1);
  assert.ok(workspace.transactions.every((item) => item.evidenceIds.includes(attachment.documentId)));
  assert.equal((await f.fileVault.listByWorkspace(f.workspaceId)).length, 1);
  assert.equal(JSON.stringify(workspace.aiSimple).includes("must-not-be-saved"), false);
  assert.equal(service.getContext("reports").reports.ledger.vouchers.length, 0, "unposted imports do not enter reports");
});

test("failed import retains the uploaded original and pending proposal for a deliberate retry", async () => {
  const f = fixture();
  const { attachment, proposal } = await importProposal(f);
  const apply = f.store.actions.applyBankImport;
  f.store.actions.applyBankImport = () => { throw new Error("模拟业务保存失败"); };
  await assert.rejects(f.service.confirmProposal(proposal.id), /模拟业务保存失败/);
  assert.equal(f.store.getActiveWorkspace().documents[0].id, attachment.documentId);
  assert.ok((await f.fileVault.get(attachment.documentId)).blob);
  assert.equal(f.service.getConversation().proposals[0].status, "pending");
  f.store.actions.applyBankImport = apply;
  assert.equal((await f.service.confirmProposal(proposal.id)).result.counts.imported, 2);
});

test("unknown column names return actual headers and rows; an explicit valid mapping can then prepare import", async () => {
  const f = fixture();
  const account = f.service.createBankAccount({ name: "映射账户" });
  const [attachment] = await f.service.uploadFiles([bankFile("甲列,乙列,丙列,丁列\n2026-09-01,银行,-25,管理手续费")]);
  const input = { documentId: attachment.documentId, accountId: account.id };
  const missing = await f.service.invokeTool("prepare_bank_import", input);
  assert.equal(missing.status, "needs_mapping");
  assert.deepEqual(missing.preview.headers, ["甲列", "乙列", "丙列", "丁列"]);
  assert.equal(missing.preview.rows[0].cells[2].value, "-25");
  const ready = await f.service.invokeTool("prepare_bank_import", { ...input, mapping: { date: 0, counterparty: 1, amount: 2, summary: 3 } });
  assert.equal(ready.status, "pending_confirmation");
  assert.equal(ready.proposal.preview.importedCount, 1);
});

test("switching period during original validation stops bank import and keeps its original", async () => {
  const f = fixture();
  const { attachment, proposal } = await importProposal(f);
  const read = f.fileVault.getOwned.bind(f.fileVault);
  let switched = false;
  f.fileVault.getOwned = async (...args) => {
    const record = await read(...args);
    if (!switched) { switched = true; f.store.actions.setPeriod(f.workspaceId, "2026-10"); }
    return record;
  };
  await assert.rejects(f.service.confirmProposal(proposal.id), { code: "AI_TARGET_CHANGED" });
  assert.equal(f.store.getActiveWorkspace().transactions.length, 0);
  assert.ok((await f.fileVault.get(attachment.documentId)).blob);
  assert.equal(f.store.getActiveWorkspace().aiSimple.conversations[f.period].proposals[0].status, "pending");
});

test("cancellation at the final original verification prevents financial writes without deleting the user's upload", async () => {
  const f = fixture();
  const { attachment, proposal } = await importProposal(f);
  const controller = new AbortController();
  const read = f.fileVault.getOwned.bind(f.fileVault);
  let reads = 0;
  f.fileVault.getOwned = async (...args) => {
    const record = await read(...args);
    if (++reads === 3) controller.abort();
    return record;
  };
  await assert.rejects(f.service.confirmProposal(proposal.id, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.store.getActiveWorkspace().transactions.length, 0);
  assert.ok((await f.fileVault.get(attachment.documentId)).blob);
});

test("document suggestions preserve actual fields until confirmed and reject stale manual edits", async () => {
  const f = await invoiceFixture();
  const before = structuredClone(f.store.getActiveWorkspace().documents[0].structuredData);
  const proposal = (await f.service.invokeTool("propose_document_fields", { documentId: f.document.id,
    fields: { amount: 128.5, counterparty: "候选单位" }, reason: "已根据票据候选文字整理，待人工核对" })).proposal;
  assert.deepEqual(f.store.getActiveWorkspace().documents[0].structuredData, before);
  updateLocalDocumentMetadata({ ...f, documentId: f.document.id, patch: { structuredData: { amount: 129 } } });
  await assert.rejects(f.service.confirmProposal(proposal.id), { code: "AI_SOURCE_CHANGED" });
  assert.equal(f.store.getActiveWorkspace().documents[0].structuredData.amount, 129);
  f.service.dismissProposal(proposal.id);
  const fresh = (await f.service.invokeTool("propose_document_fields", { documentId: f.document.id,
    fields: { amount: 128.5 }, reason: "人工重新核对原件" })).proposal;
  const result = await f.service.confirmProposal(fresh.id, { reason: "已打开原件核对金额" });
  assert.equal(result.proposal.status, "applied");
  assert.equal(result.proposal.appliedBy, "本地用户");
  assert.equal(f.store.getActiveWorkspace().documents[0].structuredData.amount, 128.5);
  assert.equal(f.store.getActiveWorkspace().documents[0].structuredData.counterparty, "原填写单位");
  assert.equal(f.store.getActiveWorkspace().documents[0].structuredData.verificationStatus, "unverified");
  await assert.rejects(f.service.invokeTool("propose_document_fields", { documentId: f.document.id, fields: { verificationStatus: "verified" }, reason: "模型不能替代查验" }), /允许的候选字段/);
});

test("tools reject unknown operations, cross-target parameters, nonfinite amounts and other-period originals", async () => {
  const f = await invoiceFixture();
  await assert.rejects(f.service.invokeTool("postVoucher", {}), { code: "AI_UNKNOWN_TOOL" });
  await assert.rejects(f.service.invokeTool("get_context", { section: "overview", workspaceId: "other" }), /不支持的参数/);
  await assert.rejects(f.service.invokeTool("propose_document_fields", { documentId: f.document.id, fields: { amount: Infinity }, reason: "bad" }), /有效数值/);
  const next = structuredClone(f.store.getActiveWorkspace());
  next.documents[0].period = "2026-08";
  f.store.actions.replaceWorkspace(f.workspaceId, next);
  await assert.rejects(f.service.invokeTool("read_document", { documentId: f.document.id }), { code: "AI_DOCUMENT_NOT_FOUND" });
});

test("stored chat strips unknown credential fields and key-shaped text; archive and user changes retain existing boundaries", async () => {
  const f = fixture();
  f.service.appendMessage({ role: "assistant", content: "sk-testcredential123456789", apiKey: "secret", tool_calls: [{ unsafe: true }] });
  const message = f.service.getConversation().messages[0];
  assert.equal(message.content, "[密钥已隐藏]");
  assert.equal(message.apiKey, undefined);
  assert.equal(message.tool_calls, undefined);
  const archived = structuredClone(f.store.getActiveWorkspace());
  archived.delivery.archives = [{ id: "archive-test", period: f.period }];
  f.store.actions.replaceWorkspace(f.workspaceId, archived);
  assert.equal(f.service.getContext().archived, true);
  assert.throws(() => f.service.appendMessage({ role: "user", content: "改历史" }), /归档/);
  const other = fixture();
  other.store.actions.upsertEntity(other.workspaceId, "users", { id: "owner", name: "负责人", roleId: "role-owner", status: "active" });
  assert.throws(() => other.service.getContext(), { code: "AI_TARGET_CHANGED" });
});

test("confirmed bank business creates a draft through the existing core; only explicit original-backed posting changes reports", async () => {
  const evidence = await withVoucherEvidence(createAccountingFixture({ withReconciliations: false, withPostedVouchers: false }));
  evidence.workspace.documents = evidence.workspace.documents.map((document) => ({ ...document, period: evidence.workspace.currentPeriod }));
  const f = fixture(evidence.workspace, evidence.fileVault);
  const input = { transactionId: "txn-fee", businessType: "bankFee", account: "expenseFee", taxTreatment: "input_non_deductible",
    invoiceStatus: "not_applicable", evidenceIds: ["doc-bank"], reason: "银行原件显示账户管理手续费" };
  const proposal = (await f.service.invokeTool("propose_bank_business", input)).proposal;
  assert.equal(f.store.getActiveWorkspace().vouchers.length, 0);
  assert.equal(f.store.getActiveWorkspace().transactions.find((item) => item.id === input.transactionId).bankBusinessEventId, undefined);
  const confirmed = await f.service.confirmProposal(proposal.id, { reason: "已核对银行原件与费用归属" });
  assert.ok(confirmed.voucherId, JSON.stringify(confirmed.result.draftIssue));
  assert.equal(confirmed.result.voucher.status, "draft");
  assert.equal(f.service.getContext("reports").reports.ledger.vouchers.length, 0);
  assert.deepEqual((await f.service.confirmProposal(proposal.id)).result, confirmed.result);
  const posted = await f.service.postVoucher({ voucherId: confirmed.voucherId, reviewNote: "已核对收费回单和分录" });
  assert.equal(posted.voucher.status, "posted");
  const reports = f.service.getContext("reports").reports;
  assert.ok(reports.ledger.vouchers.includes(confirmed.voucherId));
  assert.equal(reports.checks.trialBalance.passed, true);
});
