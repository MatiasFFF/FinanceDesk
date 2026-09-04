import assert from "node:assert/strict";
import test from "node:test";

import { createAccountingFixture } from "../src/domain/accounting/fixtures.js";
import { AccountingRuleError } from "../src/domain/accounting/model.js";
import {
  buildFinancialStatements,
  buildManagementMetrics,
  buildTaxWorkpaper,
  createCustomerConfirmationPackage,
  freezeReportVersion,
  recordCustomerConfirmation,
} from "../src/domain/accounting/reporting.js";
import {
  buildAttachmentPackage,
  createPostedVoucherRevision,
  createVoucherDraft,
  postVoucher,
  reviseDraftVoucher,
  traceVoucherSources,
  validateVoucherBalance,
  vouchersForSource,
} from "../src/domain/accounting/vouchers.js";
import {
  recordManualConfirmation,
  reviewTransactionEvidence,
} from "../src/features/evidence/evidenceEngine.js";

const context = { actor: "测试会计", at: "2026-09-06T13:00:00.000Z" };

test("reconciled split receipt produces a balanced traceable draft and attachment package", () => {
  let workspace = createAccountingFixture({ withReconciliations: true, withPostedVouchers: false });
  workspace = createVoucherDraft(workspace, { transactionId: "txn-split" }, context);
  const voucher = workspace.vouchers[0];
  const validation = validateVoucherBalance(voucher);
  assert.equal(validation.balanced, true);
  assert.equal(validation.debit, 1500);
  assert.equal(validation.credit, 1500);
  assert.ok(voucher.sourceIds.includes("allocation-0001"));
  assert.ok(voucher.sourceIds.includes("bill-ar-2"));

  const attachments = buildAttachmentPackage(workspace, voucher.id);
  assert.equal(attachments.status, "complete");
  assert.ok(attachments.manifest.some((item) => item.id === "doc-settlement"));
  const trace = traceVoucherSources(workspace, voucher.id);
  assert.deepEqual(trace.transactions.map((item) => item.id), ["txn-split"]);
  assert.deepEqual(trace.bills.map((item) => item.id), ["bill-ar-1", "bill-ar-2"]);
  assert.ok(trace.documents.some((item) => item.id === "doc-settlement"));
  assert.equal(vouchersForSource(workspace, "bill-ar-1")[0].id, voucher.id);
  workspace = postVoucher(workspace, { voucherId: voucher.id, mode: "automatic" }, { ...context, at: "2026-09-06T13:00:30.000Z" });
  assert.equal(workspace.transactions.find((item) => item.id === "txn-split").status, "posted");
});

test("manual posting still requires explicit confirmation when evidence is incomplete", () => {
  let workspace = createAccountingFixture({ withReconciliations: false, withPostedVouchers: false });
  workspace = createVoucherDraft(workspace, { transactionId: "txn-prepay" }, context);
  assert.throws(() => postVoucher(workspace, {
    voucherId: workspace.vouchers[0].id,
    mode: "manual",
    reviewNote: "只填写复核意见，未补齐证据",
  }, context), (error) => error instanceof AccountingRuleError && error.code === "EVIDENCE_CONFIRMATION_REQUIRED");
});

test("low-confidence source cannot post automatically and needs an audited manual confirmation", () => {
  let workspace = createAccountingFixture({ withReconciliations: false, withPostedVouchers: false });
  workspace.transactions.find((item) => item.id === "txn-fee").confidence = 70;
  workspace = reviewTransactionEvidence(workspace, "txn-fee", context);
  workspace = createVoucherDraft(workspace, { transactionId: "txn-fee" }, { ...context, at: "2026-09-06T13:01:00.000Z" });
  const voucherId = workspace.vouchers[0].id;

  assert.throws(() => postVoucher(workspace, { voucherId, mode: "automatic" }, context), (error) => (
    error instanceof AccountingRuleError && error.code === "UNRESOLVED_EXCEPTION"
  ));

  workspace = recordManualConfirmation(workspace, {
    transactionId: "txn-fee",
    decision: "approve",
    reason: "已核对银行回单，确认为账户管理手续费",
  }, { ...context, at: "2026-09-06T13:02:00.000Z" });
  workspace = postVoucher(workspace, {
    voucherId,
    mode: "manual",
    reviewNote: "人工复核科目和金额无误",
  }, { ...context, at: "2026-09-06T13:03:00.000Z" });
  const posted = workspace.vouchers.find((item) => item.id === voucherId);
  assert.equal(posted.status, "posted");
  assert.equal(posted.reviews.at(-1).decision, "approve");
  assert.ok(workspace.auditLog.some((item) => item.action === "evidence.manual_approve"));
  assert.equal(workspace.auditLog.at(-1).action, "voucher.post");
});

test("draft revision keeps versions, while posted voucher requires a separate revision", () => {
  let workspace = createAccountingFixture({ withReconciliations: true, withPostedVouchers: false });
  workspace = createVoucherDraft(workspace, { transactionId: "txn-split" }, context);
  const voucherId = workspace.vouchers[0].id;
  workspace = reviseDraftVoucher(workspace, {
    voucherId,
    summary: "收到橙子平台两期结算款",
    reason: "补充跨月结算说明",
  }, { ...context, at: "2026-09-06T13:05:00.000Z" });
  assert.equal(workspace.vouchers[0].version, 2);
  assert.ok(workspace.vouchers[0].versions.length >= 2);
  workspace = postVoucher(workspace, { voucherId, mode: "automatic" }, { ...context, at: "2026-09-06T13:06:00.000Z" });

  assert.throws(() => reviseDraftVoucher(workspace, {
    voucherId,
    summary: "不应覆盖",
    reason: "尝试覆盖",
  }, context), (error) => error instanceof AccountingRuleError && error.code === "POSTED_VOUCHER_IMMUTABLE");

  workspace = createPostedVoucherRevision(workspace, {
    voucherId,
    reason: "增加复核后的摘要说明",
  }, { ...context, at: "2026-09-06T13:07:00.000Z" });
  const revision = workspace.vouchers.find((item) => item.revisionOf === voucherId);
  assert.equal(revision.status, "draft");
  workspace = postVoucher(workspace, { voucherId: revision.id, mode: "automatic" }, { ...context, at: "2026-09-06T13:08:00.000Z" });
  assert.equal(workspace.vouchers.find((item) => item.id === voucherId).status, "superseded");
  assert.equal(workspace.vouchers.find((item) => item.id === revision.id).status, "posted");

  workspace = createVoucherDraft(workspace, { transactionId: "txn-payable" }, { ...context, at: "2026-09-06T13:09:00.000Z" });
  const nextVoucher = workspace.vouchers.find((item) => item.status === "draft" && item.id !== revision.id);
  workspace = postVoucher(workspace, { voucherId: nextVoucher.id, mode: "automatic" }, { ...context, at: "2026-09-06T13:10:00.000Z" });
  const numbers = workspace.vouchers.map((item) => item.no).filter(Boolean);
  assert.equal(new Set(numbers).size, numbers.length);
  assert.equal(workspace.vouchers.find((item) => item.id === nextVoucher.id).no, "记-003");
});

test("three statements reconcile and every summary keeps drilldown sources", () => {
  const workspace = createAccountingFixture();
  const statements = buildFinancialStatements(workspace, { period: "2026-08" });
  assert.equal(statements.incomeStatement.netRevenue.value, 2600);
  assert.equal(statements.incomeStatement.profit.value, 2580);
  assert.equal(statements.balanceSheet.assets.value, 29980);
  assert.equal(statements.balanceSheet.liabilities.value, 2400);
  assert.equal(statements.balanceSheet.equity.value, 27580);
  assert.equal(statements.cashFlow.closingCash.value, 25880);
  assert.equal(Object.values(statements.checks).every((check) => check.passed), true);
  assert.ok(statements.incomeStatement.profit.sourceIds.length > 0);
  assert.ok(statements.balanceSheet.assets.sourceIds.length > 0);
  assert.ok(statements.cashFlow.netChange.sourceIds.length > 0);
});

test("management metrics, tax workpaper and report versions stay source-backed", () => {
  let workspace = createAccountingFixture();
  const management = buildManagementMetrics(workspace, { period: "2026-08", asOf: "2026-08-31" });
  const metric = Object.fromEntries(management.metrics.map((item) => [item.id, item]));
  assert.equal(metric.cash.value, 25880);
  assert.equal(metric.receivable.value, 1400);
  assert.equal(metric.deposit.value, 2400);
  assert.equal(metric.prepayment.value, 1800);
  assert.ok(metric.receivable.sourceIds.includes("bill-ar-2"));

  const tax = buildTaxWorkpaper(workspace, { period: "2026-08" });
  assert.equal(tax.taxableRevenue.value, 2600);
  assert.equal(tax.outputVat.value, 78);
  assert.equal(tax.payroll.value, 6800);
  assert.ok(tax.taxableRevenue.sourceIds.length > 0);
  assert.ok(tax.payroll.sourceIds.includes("doc-payroll"));

  workspace = freezeReportVersion(workspace, { period: "2026-08" }, context);
  assert.equal(workspace.reportVersions[0].status, "frozen");
  assert.equal(workspace.reportVersions[0].statements.checks.balanceSheet.passed, true);
  assert.equal(workspace.auditLog.at(-1).action, "report.freeze");
});

test("customer confirms each section explicitly and every decision is audited", () => {
  let workspace = createAccountingFixture();
  workspace = createCustomerConfirmationPackage(workspace, { period: "2026-08" }, context);
  const confirmationId = workspace.confirmations[0].id;
  const sections = ["finance", "revenue", "costExpense", "vat", "inputVat", "payroll", "socialSecurity", "openItems"];
  for (const [index, section] of sections.entries()) {
    workspace = recordCustomerConfirmation(workspace, {
      confirmationId,
      section,
      decision: "approve",
      note: "已核对",
    }, { actor: "客户负责人", at: `2026-09-06T13:${10 + index}:00.000Z` });
  }
  assert.equal(workspace.confirmations[0].status, "approved");
  assert.equal(workspace.confirmations[0].decisions.length, sections.length);
  assert.equal(workspace.auditLog.filter((item) => item.action === "confirmation.approve").length, sections.length);
  assert.equal(buildTaxWorkpaper(workspace, { period: "2026-08" }).status, "customer_confirmed");
});

test("customer disagreement creates an exception task and blocks the tax workpaper", () => {
  let workspace = createAccountingFixture();
  workspace = createCustomerConfirmationPackage(workspace, { period: "2026-08" }, context);
  workspace = recordCustomerConfirmation(workspace, {
    confirmationId: workspace.confirmations[0].id,
    section: "payroll",
    decision: "reject",
    note: "工资表少了一名兼职教练",
  }, { actor: "客户负责人", at: "2026-09-06T13:20:00.000Z" });
  assert.equal(workspace.confirmations[0].status, "disputed");
  assert.equal(workspace.exceptionTasks.at(-1).code, "customer_dispute");
  assert.equal(buildTaxWorkpaper(workspace, { period: "2026-08" }).status, "blocked_by_exceptions");
});
