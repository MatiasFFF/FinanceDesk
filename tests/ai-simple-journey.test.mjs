import test from "node:test";
import assert from "node:assert/strict";
import { saveLocalDocument, saveLocalDocumentRecognition } from "../src/features/intake/documentIntake.js";
import { BANK_CSV, BANK_MAPPING, JOURNEY_KEY, createJourneyFixture, reloadJourney,
  namedBlob, toolCall, assistantReply, scriptedAssistant } from "./helpers/aiSimpleJourneyFixture.mjs";

const workspace = (f) => f.store.getState().workspaces.find((item) => item.id === f.workspaceId);
const proposalById = (f, id) => f.service.getConversation().proposals.find((item) => item.id === id);
const businessInput = (transactionId, documentId) => ({ transactionId, businessType: "bankFee", account: "expenseFee",
  taxTreatment: "input_non_deductible", invoiceStatus: "not_applicable", evidenceIds: [documentId], reason: "银行原件显示账户管理手续费" });
const noCredential = (...values) => assert.equal(JSON.stringify(values).includes(JOURNEY_KEY), false, "transport key must not enter messages, tool results or persisted finance data");

async function uploadedBank(f, file = namedBlob(BANK_CSV)) {
  const [attachment] = await f.service.uploadFiles([file]);
  return { attachment, input: { documentId: attachment.documentId, accountId: f.account.id, mapping: BANK_MAPPING } };
}

test("journey: revised CSV import, human business confirmation and original-backed posting produce exact report amounts once", async () => {
  let f = createJourneyFixture();
  assert.equal(workspace(f).isDemo, false);
  assert.equal(workspace(f).users.find((item) => item.id === f.store.getState().activeUserId).name, "流程复核人");
  assert.equal(workspace(f).transactions.length, 0);
  const { attachment, input } = await uploadedBank(f);
  const initial = scriptedAssistant(f, [
    assistantReply("读取已保存的银行资料", [toolCall("import_initial", "prepare_bank_import", { ...input, mapping: { ...BANK_MAPPING, amount: 3 } })]),
    assistantReply(`导入建议已准备，等待核对。测试回显 ${JOURNEY_KEY}`),
  ]);
  const initialAnswer = await initial.run();
  const original = initialAnswer.toolResults[0].result.proposal;
  assert.equal(original.kind, "bank_import");
  assert.deepEqual(original.preview.transactions.map((item) => item.amount), [975, 960], "wrong balance mapping is visible before human correction");
  assert.equal(workspace(f).transactions.length, 0, "assistant tool preparation cannot import rows");
  assert.equal(workspace(f).vouchers.length, 0);
  const corrected = (await f.service.reviseProposal(original.id, { mapping: BANK_MAPPING })).proposal;
  assert.notEqual(corrected.id, original.id);
  assert.equal(corrected.revisesProposalId, original.id);
  assert.equal(corrected.revisedBy, "流程复核人");
  assert.deepEqual(corrected.preview.transactions.map((item) => item.amount), [-25, -15]);
  assert.equal(proposalById(f, original.id).status, "superseded");
  assert.equal(proposalById(f, original.id).supersededBy, corrected.id);
  await assert.rejects(f.service.confirmProposal(original.id), { code: "AI_PROPOSAL_CHANGED" });
  assert.equal(workspace(f).transactions.length, 0);

  f = reloadJourney(f);
  assert.deepEqual(proposalById(f, corrected.id).editableValues.mapping, BANK_MAPPING);
  const [imported, concurrent] = await Promise.all([f.service.confirmProposal(corrected.id), f.service.confirmProposal(corrected.id)]);
  assert.deepEqual(concurrent, imported);
  assert.equal(imported.result.counts.imported, 2);
  assert.deepEqual((await f.service.confirmProposal(corrected.id)).result, imported.result);
  const duplicateRound = scriptedAssistant(f, [
    assistantReply("重新读取同一份原件", [toolCall("import_duplicate", "prepare_bank_import", input)]), assistantReply("本批流水已存在"),
  ]);
  const duplicate = (await duplicateRound.run()).toolResults[0].result;
  assert.equal(duplicate.status, "already_imported");
  assert.deepEqual(duplicate.proposals, [], "a fully imported original does not ask the user to confirm again");
  assert.equal(duplicate.alreadyImportedGroups.length, 1);
  assert.deepEqual(duplicate.alreadyImportedGroups[0].counts, { imported: 0, duplicates: 2, errors: 0 });
  assert.equal(workspace(f).transactions.length, 2);
  assert.equal(workspace(f).bankImports.length, 1);
  assert.equal(workspace(f).documents.length, 1);
  assert.ok(workspace(f).transactions.every((item) => item.evidenceIds.includes(attachment.documentId)));
  assert.equal((await f.fileVault.listByWorkspace(f.workspaceId)).length, 1);

  const transaction = workspace(f).transactions.find((item) => item.amount === -25);
  const businessRound = scriptedAssistant(f, [
    assistantReply("核对流水和原件后提出手续费归属", [toolCall("business_prepare", "propose_bank_business", businessInput(transaction.id, attachment.documentId))]),
    assistantReply("费用归属已准备，等待人工确认"),
  ]);
  const businessAnswer = await businessRound.run();
  const business = businessAnswer.toolResults[0].result.proposal;
  assert.equal(workspace(f).vouchers.length, 0, "business suggestion cannot create a live voucher");
  assert.equal(f.service.getContext("reports").reports.incomeStatement.expenses.value, 0);
  const confirmed = await f.service.confirmProposal(business.id, { reason: "已人工核对原件、25元支出和费用归属" });
  assert.ok(confirmed.voucherId, JSON.stringify(confirmed.result.draftIssue));
  assert.equal(confirmed.result.voucher.status, "draft");
  assert.equal(confirmed.proposal.appliedBy, "流程复核人");
  assert.equal(f.service.getContext("reports").reports.ledger.vouchers.length, 0, "drafts stay out of reports");
  assert.deepEqual((await f.service.confirmProposal(business.id)).result, confirmed.result);
  assert.equal(workspace(f).vouchers.length, 1);

  const document = workspace(f).documents.find((item) => item.id === attachment.documentId);
  const savedOriginal = await f.fileVault.get(document.storage.blobId);
  assert.equal(await savedOriginal.blob.text(), BANK_CSV);
  await f.fileVault.delete(document.storage.blobId);
  await assert.rejects(f.service.postVoucher({ voucherId: confirmed.voucherId, reviewNote: "原件不可用时不得入账" }), { code: "VOUCHER_ORIGINAL_REQUIRED" });
  assert.equal(workspace(f).vouchers[0].status, "draft");
  assert.equal(f.service.getContext("reports").reports.incomeStatement.expenses.value, 0);
  await f.fileVault.put(savedOriginal);
  assert.equal(await (await f.service.readOriginal(document.id)).blob.text(), BANK_CSV);
  const posted = await f.service.postVoucher({ voucherId: confirmed.voucherId, reviewNote: "已打开银行原件核对25元收费与分录" });
  assert.equal(posted.voucher.status, "posted");
  const reports = f.service.getContext("reports").reports;
  assert.deepEqual(reports.ledger.vouchers, [confirmed.voucherId]);
  assert.deepEqual(reports.ledger.totals, { debit: 25, credit: 25, difference: 0 });
  assert.equal(reports.ledger.accounts.find((item) => item.accountId === "expenseFee").debit, 25);
  const bankLedger = reports.ledger.accounts.find((item) => item.accountId === f.account.id);
  assert.ok(bankLedger, "posting must use the bank account selected for the CSV import");
  assert.equal(bankLedger.credit, 25);
  assert.equal(reports.incomeStatement.expenses.value, 25, "the other unposted 15-yuan transaction is excluded");
  assert.equal(reports.incomeStatement.profit.value, -25);
  assert.equal(reports.cashFlow.netChange.value, -25);
  assert.ok(reports.incomeStatement.expenses.sourceIds.includes(transaction.id));
  assert.ok(reports.incomeStatement.expenses.sourceIds.includes(confirmed.voucherId));
  assert.equal(reports.checks.trialBalance.passed, true);
  const reportRound = scriptedAssistant(f, [
    assistantReply("读取已入账报表", [toolCall("report_read", "get_context", { section: "reports" })]), assistantReply("本期已入账手续费25元"),
  ]);
  const reportAnswer = await reportRound.run();
  assert.equal(reportAnswer.toolResults[0].result.reports.incomeStatement.expenses.value, 25);
  assert.equal(reloadJourney(f).service.getContext("reports").reports.incomeStatement.expenses.value, 25);
  noCredential(initialAnswer, businessAnswer, reportAnswer, initial.trace, f.storage.dump());
});

test("journey: reading a saved invoice, revising candidate fields and confirming never replaces the original or invoice verification", async () => {
  let f = createJourneyFixture();
  // This is a stored-recognition input fixture, not a claim that PDF/OCR ran.
  const text = "发票号码：12345678901234567890\n开票日期：2026-09-03\n销售方：原件供应商\n价税合计：128.50";
  const file = namedBlob(text, "票据字段验收.txt", "text/plain");
  const document = await saveLocalDocument({ ...f, file, metadata: { category: "发票", period: f.period,
    structuredData: { counterparty: "尚未核对的旧名称", amount: 100, verificationStatus: "unverified" } } });
  await saveLocalDocumentRecognition({ ...f, documentId: document.id, sourceHash: document.hash, category: "发票",
    result: { mode: "local", text, pages: [{ pageNumber: 1, text }], suggestedFields: { amount: { value: 128.5, pageNumber: 1, sourceText: "价税合计：128.50" } } } });
  const fieldsRound = scriptedAssistant(f, [
    assistantReply("读取票据正文", [toolCall("invoice_read", "read_document", { documentId: document.id })]),
    assistantReply("整理票据候选字段", [toolCall("invoice_fields", "propose_document_fields", { documentId: document.id,
      fields: { amount: 128, counterparty: "候选供应商", invoiceNumber: "12345678901234567890" }, reason: "候选金额和名称待人工核对" })]),
    assistantReply("票据字段待核对"),
  ]);
  const answer = await fieldsRound.run();
  assert.equal(answer.toolResults[0].result.text, text);
  const original = answer.toolResults[1].result.proposal;
  const corrected = (await f.service.reviseProposal(original.id, { fields: { amount: 128.5, counterparty: "原件供应商" } })).proposal;
  assert.equal(workspace(f).documents[0].structuredData.amount, 100);
  assert.equal(workspace(f).documents[0].structuredData.counterparty, "尚未核对的旧名称");
  assert.equal(corrected.preview.fields.find((item) => item.key === "amount").after, 128.5);
  assert.equal(corrected.editableValues.fields.invoiceNumber, "12345678901234567890", "field patches preserve the other reviewed candidates");
  await assert.rejects(f.service.confirmProposal(original.id), { code: "AI_PROPOSAL_CHANGED" });
  f = reloadJourney(f);
  const confirmed = await f.service.confirmProposal(corrected.id, { reason: "原件金额128.50元，名称已逐字核对" });
  assert.equal(confirmed.proposal.appliedBy, "流程复核人");
  assert.equal(workspace(f).documents[0].structuredData.amount, 128.5);
  assert.equal(workspace(f).documents[0].structuredData.counterparty, "原件供应商");
  assert.equal(workspace(f).documents[0].structuredData.verificationStatus, "unverified");
  assert.equal(workspace(f).documents[0].hash, document.hash);
  assert.equal(await (await f.service.readOriginal(document.id)).blob.text(), text);
  assert.equal((await f.fileVault.listByWorkspace(f.workspaceId)).length, 1);
  assert.equal(workspace(f).vouchers.length, 0);
  assert.equal(f.service.getContext("reports").reports.incomeStatement.expenses.value, 0);
  noCredential(answer, fieldsRound.trace, f.storage.dump());
});

test("journey: cancelling a multi-file upload retains completed originals and reload can finish without duplicates", async () => {
  let f = createJourneyFixture();
  const first = namedBlob(BANK_CSV, "第一批流水.csv");
  const second = namedBlob("日期,对方,摘要,发生额,流水号\n2026-09-03,测试银行,网银服务费,-5,J003", "第二批流水.csv");
  const controller = new AbortController();
  let stopped;
  await assert.rejects(f.service.uploadFiles([first, second], { signal: controller.signal,
    onProgress: ({ stage, name }) => { if (stage === "saving" && name === second.name) controller.abort(); } }), (error) => {
    stopped = error;
    return error.name === "AbortError";
  });
  assert.equal(stopped.uploaded.length, 1);
  const completedId = stopped.uploaded[0].documentId;
  assert.equal(workspace(f).documents.length, 1);
  assert.equal(workspace(f).transactions.length, 0);
  assert.equal(await (await f.service.readOriginal(completedId)).blob.text(), BANK_CSV);
  f = reloadJourney(f);
  const finished = await f.service.uploadFiles([first, second]);
  assert.equal(finished[0].documentId, completedId);
  assert.equal(new Set(finished.map((item) => item.documentId)).size, 2);
  assert.equal(workspace(f).documents.length, 2);
  assert.equal((await f.fileVault.listByWorkspace(f.workspaceId)).length, 2);
  assert.equal(await (await f.service.readOriginal(finished[1].documentId)).blob.text(), await second.text());
});

test("journey: recoverable tool input, provider failure and cancellation retain completed work without replaying confirmation", async () => {
  let f = createJourneyFixture();
  const { attachment, input } = await uploadedBank(f);
  const recoveryRound = scriptedAssistant(f, [
    assistantReply("先准备导入", [toolCall("missing_account", "prepare_bank_import", { documentId: attachment.documentId })]),
    assistantReply("采用当前工作台的已选账户", [toolCall("corrected_account", "prepare_bank_import", input)]),
    () => { throw new Error(`Synthetic upstream connection failure ${JOURNEY_KEY}`); },
  ]);
  let interrupted;
  await assert.rejects(recoveryRound.run(), (error) => { interrupted = error; return error.code === "ASSISTANT_UNAVAILABLE"; });
  assert.equal(recoveryRound.trace.providerRequests.length, 3, "a reviewable missing account must return to the provider before retry");
  assert.equal(interrupted.toolResults.length, 2);
  const missing = interrupted.toolResults[0].result;
  assert.equal(missing.status, "needs_correction");
  assert.equal(missing.proposal.preview.accountResolution.status, "missing");
  assert.equal(missing.proposal.preview.canConfirm, false);
  assert.deepEqual(missing.proposal.sourceIds, [attachment.documentId]);
  assert.equal(proposalById(f, missing.proposal.id).status, "pending", "missing business account stays reviewable after the provider fails");
  const prepared = interrupted.toolResults[1].result.proposal;
  assert.equal(proposalById(f, prepared.id).status, "pending");
  assert.equal(workspace(f).transactions.length, 0);
  assert.equal(workspace(f).documents.length, 1);
  f = reloadJourney(f);
  assert.equal(proposalById(f, missing.proposal.id).status, "pending");
  assert.ok((await f.service.readOriginal(attachment.documentId)).blob);
  const resumed = scriptedAssistant(f, [
    assistantReply("重新查询工作台现状", [toolCall("resume_context", "get_context", { section: "overview" })]), assistantReply("导入建议仍在，等待人工确认"),
  ], { messages: [...interrupted.messages, { role: "user", content: "连接恢复，继续查看刚才的导入建议" }] });
  const resumedAnswer = await resumed.run();
  assert.equal(resumedAnswer.toolResults[0].result.proposals.find((item) => item.id === prepared.id).status, "pending");
  assert.equal(workspace(f).transactions.length, 0, "resuming the assistant cannot replay human confirmation");
  await f.service.confirmProposal(prepared.id);
  const importedIds = workspace(f).transactions.map((item) => item.id);
  const controller = new AbortController();
  const cancelled = scriptedAssistant(f, [
    assistantReply("准备费用归属，随后读取报表", [
      toolCall("cancel_business", "propose_bank_business", businessInput(importedIds[0], attachment.documentId)),
      toolCall("cancel_unfinished_report", "get_context", { section: "reports" }),
    ]),
  ], { signal: controller.signal, onToolResult: () => controller.abort() });
  let cancellation;
  await assert.rejects(cancelled.run(), (error) => { cancellation = error; return error.code === "ASSISTANT_CANCELLED"; });
  assert.equal(cancelled.trace.executed.length, 1, "unstarted tools in the interrupted batch must not run");
  const business = cancellation.toolResults[0].result.proposal;
  assert.equal(proposalById(f, business.id).status, "pending");
  assert.deepEqual(workspace(f).transactions.map((item) => item.id), importedIds);
  assert.equal(workspace(f).vouchers.length, 0);
  f = reloadJourney(f);
  const afterCancel = scriptedAssistant(f, [
    assistantReply("读取已保存的建议", [toolCall("after_cancel_context", "get_context", { section: "overview" })]), assistantReply("流水已导入，费用归属仍待确认"),
  ], { messages: [...cancellation.messages, { role: "user", content: "继续查看已保存结果" }] });
  const afterCancelAnswer = await afterCancel.run();
  assert.equal(afterCancel.trace.providerRequests.length, 2, "interrupted transcript must be accepted by the real proxy without re-executing its calls");
  assert.equal(afterCancelAnswer.toolResults[0].result.proposals.find((item) => item.id === business.id).status, "pending");
  assert.equal(workspace(f).bankImports.length, 1);
  assert.equal(workspace(f).transactions.length, 2);
  assert.equal(workspace(f).vouchers.length, 0);
  assert.equal(await (await f.service.readOriginal(attachment.documentId)).blob.text(), BANK_CSV);
  noCredential(interrupted.message, interrupted.messages, interrupted.toolResults, recoveryRound.trace,
    cancellation.message, cancellation.messages, cancellation.toolResults, afterCancelAnswer, f.storage.dump());
});

test("journey: switching the workspace while the provider responds stops tool writes and preserves the original target's pending work", async () => {
  const f = createJourneyFixture();
  const { attachment, input } = await uploadedBank(f);
  const preparedRound = scriptedAssistant(f, [
    assistantReply("准备本期银行导入", [toolCall("target_initial", "prepare_bank_import", input)]), assistantReply("导入建议待确认"),
  ]);
  const pending = (await preparedRound.run()).toolResults[0].result.proposal;
  const other = f.store.actions.createWorkspace({ id: "ai-journey-other", name: "另一个工作台", currentPeriod: f.period,
    initialUserName: "另一位负责人", initialUserRoleId: "role-owner", activate: false });
  const switched = scriptedAssistant(f, [() => {
    f.store.actions.switchWorkspace(other.id);
    return assistantReply("", [toolCall("late_import", "prepare_bank_import", input)]);
  }]);
  let stopped;
  await assert.rejects(switched.run(), (error) => { stopped = error; return error.code === "AI_TARGET_CHANGED"; });
  await assert.rejects(f.service.confirmProposal(pending.id), { code: "AI_TARGET_CHANGED" });
  assert.equal(f.store.getActiveWorkspace().id, other.id);
  assert.equal(f.store.getActiveWorkspace().transactions.length, 0);
  assert.equal(f.store.getActiveWorkspace().documents.length, 0);
  assert.equal(f.store.getActiveWorkspace().vouchers.length, 0);
  assert.equal(workspace(f).transactions.length, 0);
  assert.equal(workspace(f).aiSimple.conversations[f.period].proposals.find((item) => item.id === pending.id).status, "pending");
  assert.equal(workspace(f).documents[0].id, attachment.documentId);
  assert.equal((await f.fileVault.listByWorkspace(other.id)).length, 0);
  const record = await f.fileVault.get(workspace(f).documents[0].storage.blobId);
  assert.equal(record.workspaceId, f.workspaceId);
  assert.equal(await record.blob.text(), BANK_CSV);
  noCredential(stopped.message, stopped.messages, stopped.toolResults, switched.trace, f.storage.dump());
});
