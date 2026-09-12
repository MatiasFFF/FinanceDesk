import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { FINANCE_DESK_STORAGE_KEY } from "../src/domain/foundation.js";
import { buildAttachmentPackage } from "../src/domain/accounting/index.js";
import { saveLocalDocument, saveLocalDocumentRecognition } from "../src/features/intake/documentIntake.js";
import { buildAiReportModel } from "../src/features/ai-simple/aiReportModel.js";
import { generateAiReportExcel } from "../src/features/ai-simple/aiReportExcel.js";
import { navigationTargetError, voucherOriginalTarget } from "../src/features/ai-simple/aiWorkflow.js";
import { JOURNEY_KEY, createJourneyFixture, reloadJourney, namedBlob, toolCall, assistantReply, scriptedAssistant } from "./helpers/aiSimpleJourneyFixture.mjs";

const workspace = (f) => f.store.getActiveWorkspace();
const proposal = (f, id) => f.service.getConversation().proposals.find((item) => item.id === id);
const csvFile = (rows, name) => namedBlob(`日期,对方,摘要,发生额,流水号\n${rows.join("\n")}`, name);
const mapping = { date: 0, counterparty: 1, summary: 2, amount: 3, serial: 4 };
const rowsOf = (book, name) => XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: "" });
const noKey = (...values) => assert.equal(JSON.stringify(values).includes(JOURNEY_KEY), false);

async function importPlans(f, attachments) {
  const run = scriptedAssistant(f, [assistantReply("按原件分别准备，尚未导入", attachments.map((item, index) =>
    toolCall(`prepare_recovery_${index}`, "prepare_bank_import", { documentId: item.documentId, accountId: f.account.id, mapping }))),
  assistantReply("导入建议待人工确认")]);
  const result = await run.run();
  return result.toolResults.map((entry) => entry.result.proposal);
}

async function feeProposal(f, transaction, documentId) {
  const run = scriptedAssistant(f, [assistantReply("依据银行原件准备费用归属", [toolCall("recovery_fee", "propose_bank_business", {
    transactionId: transaction.id, businessType: "bankFee", account: "expenseFee", taxTreatment: "input_non_deductible",
    invoiceStatus: "not_applicable", evidenceIds: [documentId], reason: "合成银行原件已明确列示账户服务手续费",
  })]), assistantReply("费用归属待人工确认，尚未入账")]);
  return (await run.run()).toolResults[0].result.proposal;
}

async function exportedBook(f) {
  const before = f.storage.dump();
  const generated = await generateAiReportExcel(buildAiReportModel(workspace(f)), { generatedAt: "2026-09-12T12:00:00.000Z" });
  assert.deepEqual(f.storage.dump(), before, "generating the actual XLSX must not change the ledger or freeze reports");
  assert.equal(generated.metadata.frozen, false);
  assert.equal(generated.metadata.downloadRequested, undefined);
  assert.equal(generated.metadata.uploaded, false);
  return { generated, book: XLSX.read(generated.bytes, { type: "array" }) };
}

test("completeness: a failed import-result save can retry after reload without duplicating rows or consuming another file's pending plan", async () => {
  let f = createJourneyFixture();
  const firstFile = csvFile(["2026-09-03,测试银行,账户管理手续费,-37.25,C001", "2026-09-04,测试银行,短信服务费,-12.75,C002"], "恢复第一批.csv");
  const secondFile = csvFile(["2026-09-05,测试银行,网银服务费,-91.20,C003"], "尚待确认第二批.csv");
  const attachments = await f.service.uploadFiles([firstFile, secondFile]);
  const [firstPlan, secondPlan] = await importPlans(f, attachments);
  assert.equal(workspace(f).transactions.length, 0);
  const write = f.storage.setItem;
  let failedWrites = 0;
  f.storage.setItem = (key, value) => {
    if (key === FINANCE_DESK_STORAGE_KEY && failedWrites === 0) {
      const next = JSON.parse(value).payload.workspaces.find((item) => item.id === f.workspaceId);
      const applied = next.aiSimple?.conversations?.[f.period]?.proposals.find((item) => item.id === firstPlan.id)?.status === "applied";
      if (next.bankImports.length && applied) { failedWrites += 1; throw new Error("synthetic import-result save interruption"); }
    }
    return write(key, value);
  };
  try { await assert.rejects(f.service.confirmProposal(firstPlan.id), /synthetic import-result save interruption/); }
  finally { f.storage.setItem = write; }
  assert.equal(failedWrites, 1, "the interruption must reach the real save of the applied result");
  assert.equal(workspace(f).transactions.length, 0, "a failed combined save cannot leave imported rows behind");
  assert.equal(workspace(f).bankImports.length, 0);
  assert.equal(proposal(f, firstPlan.id).status, "pending");
  assert.equal(proposal(f, secondPlan.id).status, "pending");
  f = reloadJourney(f);
  assert.equal(workspace(f).transactions.length, 0, "reload must also see the unchanged pre-confirmation ledger");
  const recovered = await f.service.confirmProposal(firstPlan.id);
  assert.equal(recovered.proposal.status, "applied");
  assert.deepEqual((await f.service.confirmProposal(firstPlan.id)).result, recovered.result);
  assert.deepEqual(workspace(f).transactions.map((item) => item.serial).sort(), ["C001", "C002"]);
  assert.equal(workspace(f).bankImports.length, 1);
  assert.equal(proposal(f, secondPlan.id).status, "pending");
  assert.equal(workspace(f).documents.length, 2);
  assert.equal(await (await f.service.readOriginal(attachments[1].documentId)).blob.text(), await secondFile.text());

  const transaction = workspace(f).transactions.find((item) => item.serial === "C001");
  const business = await feeProposal(f, transaction, attachments[0].documentId);
  const confirmed = await f.service.confirmProposal(business.id);
  assert.ok(confirmed.voucherId, JSON.stringify(confirmed.result.draftIssue));
  const beforePost = await exportedBook(f);
  assert.equal(rowsOf(beforePost.book, "利润表").find((row) => row[0] === "期间费用")[1], 0);
  assert.equal(beforePost.generated.metadata.pendingCount, 1);
  assert.ok(rowsOf(beforePost.book, "核对状态").some((row) => row[0] === "未计入报表的凭证" && row[4] === confirmed.voucherId));
  await f.service.postVoucher({ voucherId: confirmed.voucherId, reviewNote: "已核对恢复第一批原件的37.25元收费及分录" });
  const { generated, book } = await exportedBook(f);
  assert.equal(rowsOf(book, "利润表").find((row) => row[0] === "期间费用")[1], 37.25);
  assert.equal(rowsOf(book, "利润表").find((row) => row[0] === "本期利润")[1], -37.25);
  assert.equal(rowsOf(book, "现金流量表").find((row) => row[0] === "现金净变动")[1], -37.25);
  const sources = rowsOf(book, "来源明细");
  assert.ok(sources.some((row) => row[5] === confirmed.voucherId && String(row[10]).includes(transaction.id) && String(row[11]).includes(attachments[0].documentId)));
  assert.equal(sources.some((row) => String(row[11]).includes(attachments[1].documentId)), false, "unconfirmed second-file originals cannot become posted report evidence");
  assert.equal(generated.metadata.postedCount, 1);
  assert.equal(generated.metadata.pendingCount, 0);
  assert.equal(proposal(f, secondPlan.id).status, "pending");
  assert.equal(reloadJourney(f).service.getContext("reports").reports.incomeStatement.expenses.value, 37.25);
  noKey(f.storage.dump(), generated.metadata, rowsOf(book, "来源明细"));
});

test("completeness: document tool pagination reaches the invoice tail before a human-approved field update, without replacing its original", async () => {
  let f = createJourneyFixture();
  // Stored-recognition fixture only: no PDF decoder, OCR engine or real model.
  const originalFile = namedBlob("synthetic immutable multi-page invoice bytes", "多页合成票据.pdf", "application/pdf");
  const document = await saveLocalDocument({ ...f, file: originalFile, metadata: { category: "发票", period: f.period,
    structuredData: { counterparty: "人工原名称", amount: 100, verificationStatus: "unverified" } } });
  const prefix = "本页为条目说明，不包含最终金额。\n".repeat(1600);
  const tail = "发票号码：12345678901234567890\n销售方：合成尾页供应商\n价税合计：1876.54";
  const text = `${prefix}${tail}`;
  await saveLocalDocumentRecognition({ ...f, documentId: document.id, sourceHash: document.hash, category: document.category,
    result: { mode: "local", text, pages: [{ pageNumber: 1, text: prefix }, { pageNumber: 2, text: tail }], suggestedFields: {} } });
  const pagesRead = [];
  const run = scriptedAssistant(f, [
    assistantReply("先读取票据正文", [toolCall("long_invoice_first", "read_document", { documentId: document.id })]),
    ({ payload }) => {
      const first = JSON.parse(payload.messages.at(-1).content);
      pagesRead.push(first);
      return assistantReply("正文还有后续，读取尾页", [toolCall("long_invoice_tail", "read_document", { documentId: document.id, offset: first.nextOffset })]);
    },
    ({ payload }) => {
      pagesRead.push(JSON.parse(payload.messages.at(-1).content));
      return assistantReply("根据尾页原文准备候选字段", [toolCall("long_invoice_fields", "propose_document_fields", {
        documentId: document.id, fields: { invoiceNumber: "12345678901234567890", counterparty: "合成尾页供应商", amount: 1876.54 }, reason: "合成票据尾页列示的名称和含税合计，仍待人工复核",
      })]);
    },
    assistantReply("票据金额1876.54元的候选字段已准备，等待人工确认"),
  ]);
  const answer = await run.run();
  assert.equal(pagesRead.length, 2);
  assert.equal(pagesRead[0].offset, 0);
  assert.equal(pagesRead[0].totalChars, text.length);
  assert.equal(pagesRead[0].text.includes("1876.54"), false);
  assert.equal(pagesRead[1].offset, pagesRead[0].nextOffset);
  assert.ok(pagesRead[1].text.includes(tail));
  assert.equal(pagesRead[1].nextOffset, null);
  assert.equal(pagesRead.map((page) => page.text).join(""), text);
  const fieldsPlan = answer.toolResults.find((entry) => entry.call.name === "propose_document_fields").result.proposal;
  assert.equal(workspace(f).documents.find((item) => item.id === document.id).structuredData.amount, 100);
  f = reloadJourney(f);
  await f.service.confirmProposal(fieldsPlan.id, { reason: "人工逐项核对尾页名称、号码与1876.54元合计" });
  const saved = workspace(f).documents.find((item) => item.id === document.id);
  assert.equal(saved.structuredData.amount, 1876.54);
  assert.equal(saved.structuredData.counterparty, "合成尾页供应商");
  assert.equal(saved.structuredData.verificationStatus, "unverified");
  assert.equal(saved.hash, document.hash);
  assert.equal(await (await f.service.readOriginal(document.id)).blob.text(), await originalFile.text());
  assert.equal(workspace(f).vouchers.length, 0, "confirming invoice fields cannot create posted accounting");
  assert.equal(f.service.getContext("reports").reports.incomeStatement.expenses.value, 0);
  assert.equal((await f.fileVault.listByWorkspace(f.workspaceId)).length, 1);
  assert.equal(JSON.stringify(f.storage.dump()).includes(prefix), false, "full recognition text remains in the local file vault");
  noKey(answer, f.storage.dump());
});

test("completeness: re-uploading a missing original repairs its pending import in place and preserves exact evidence through posting and XLSX export", async () => {
  let f = createJourneyFixture();
  const file = csvFile(["2026-09-06,测试银行,账户管理手续费,-68.40,R001", "2026-09-07,测试银行,短信服务费,-31.60,R002"], "恢复原件.csv");
  const [attachment] = await f.service.uploadFiles([file]);
  const [pending] = await importPlans(f, [attachment]);
  const original = workspace(f).documents.find((item) => item.id === attachment.documentId);
  await f.fileVault.delete(original.storage.blobId);
  await assert.rejects(f.service.confirmProposal(pending.id), { code: "AI_ORIGINAL_UNAVAILABLE" });
  assert.equal(workspace(f).transactions.length, 0);
  f = reloadJourney(f);
  const [restored] = await f.service.uploadFiles([file]);
  assert.equal(restored.documentId, attachment.documentId);
  assert.equal(workspace(f).documents.length, 1);
  assert.equal(workspace(f).documents[0].hash, original.hash);
  assert.equal(proposal(f, pending.id).status, "pending");
  assert.equal(await (await f.service.readOriginal(restored.documentId)).blob.text(), await file.text());
  const imported = await f.service.confirmProposal(pending.id);
  assert.equal(imported.result.counts.imported, 2);
  assert.deepEqual((await f.service.confirmProposal(pending.id)).result, imported.result);
  assert.equal(workspace(f).bankImports.length, 1);
  assert.deepEqual(workspace(f).transactions.map((item) => item.serial).sort(), ["R001", "R002"]);
  assert.ok(workspace(f).transactions.every((item) => item.evidenceIds.includes(restored.documentId)));
  const transaction = workspace(f).transactions.find((item) => item.serial === "R001");
  const business = await feeProposal(f, transaction, restored.documentId);
  const confirmed = await f.service.confirmProposal(business.id);
  assert.ok(confirmed.voucherId, JSON.stringify(confirmed.result.draftIssue));
  const voucher = workspace(f).vouchers.find((item) => item.id === confirmed.voucherId);
  const entry = buildAttachmentPackage(workspace(f), voucher.id).manifest.find((item) => item.id === original.id);
  assert.ok(entry, "restored evidence must appear in the actual voucher attachment manifest");
  const target = voucherOriginalTarget(workspace(f), voucher, entry);
  assert.equal(target.page, "documents");
  assert.equal(target.options.documentId, original.id);
  assert.equal(navigationTargetError(workspace(f), target), "");
  assert.equal(await (await f.service.readOriginal(target.options.documentId)).blob.text(), await file.text());
  assert.equal(target.options.returnTo.panel, "vouchers");
  assert.equal(target.options.returnTo.voucherId, confirmed.voucherId);
  assert.equal(navigationTargetError(workspace(f), { ...target.options.returnTo, options: target.options.returnTo }), "");
  await f.service.postVoucher({ voucherId: confirmed.voucherId, reviewNote: "原件已重新关联，核对68.40元收费及分录" });
  const { book } = await exportedBook(f);
  assert.equal(rowsOf(book, "利润表").find((row) => row[0] === "期间费用")[1], 68.4);
  assert.equal(rowsOf(book, "现金流量表").find((row) => row[0] === "现金净变动")[1], -68.4);
  assert.ok(rowsOf(book, "来源明细").some((row) => row[5] === confirmed.voucherId && String(row[11]).includes(original.id)));
  assert.equal((await f.fileVault.listByWorkspace(f.workspaceId)).length, 1);
  assert.equal(reloadJourney(f).service.getContext("reports").reports.incomeStatement.expenses.value, 68.4);
  noKey(f.storage.dump(), rowsOf(book, "来源明细"));
});
