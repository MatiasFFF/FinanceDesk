import assert from "node:assert/strict";
import test from "node:test";

import { createAccountingFixture } from "../src/domain/accounting/fixtures.js";
import { createBlankWorkspace } from "../src/domain/foundation.js";
import { AccountingRuleError } from "../src/domain/accounting/model.js";
import { setBankTransactionBusinessEventDimensions } from "../src/domain/accounting/classification.js";
import {
  buildFinancialStatements,
  buildManagementMetrics,
  buildReceivablePayableAgeing,
  buildStoreManagementReport,
  buildTaxWorkpaper,
  buildThirtyDayCashForecast,
  createCustomerConfirmationPackage,
  freezeReportVersion,
  recordCustomerConfirmation,
} from "../src/domain/accounting/reporting.js";
import {
  buildAttachmentPackage,
  createAdvanceApplicationVoucherDraft,
  createBankBusinessEventVoucherDraft,
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
import {
  applyAdvanceToBill,
  applyReconciliation,
  buildReconciliationExceptionCases,
  confirmBankTransactionBusinessEvent,
  handleReconciliationException,
} from "../src/features/reconciliation/reconciliationEngine.js";

const context = { actor: "测试会计", at: "2026-09-06T13:00:00.000Z" };

test("voucher tax amount stays optional but rejects invalid or negative values", () => {
  const baseLines = [
    { account: "bank:operating", debit: 106, credit: 0, taxAmount: "" },
    { account: "revenuePrivate", debit: 0, credit: 106, taxAmount: 6 },
  ];
  const valid = validateVoucherBalance({ lines: baseLines });
  assert.equal(valid.balanced, true);
  assert.equal(valid.amountsBalanced, true);
  assert.equal(valid.taxTotal, 6);

  const invalid = validateVoucherBalance({
    lines: baseLines.map((line, index) => index === 0 ? { ...line, taxAmount: "不是数字" } : line),
  });
  assert.equal(invalid.balanced, false);
  assert.equal(invalid.amountsBalanced, true);
  assert.match(invalid.errors.join("；"), /税额必须是有效数字/);

  const negative = validateVoucherBalance({
    lines: baseLines.map((line, index) => index === 0 ? { ...line, taxAmount: -1 } : line),
  });
  assert.equal(negative.balanced, false);
  assert.equal(negative.amountsBalanced, true);
  assert.match(negative.errors.join("；"), /税额不能为负数/);
});

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

test("confirmed bank businessEvent creates one manual-only traceable voucher and posted lines flow into existing reports", () => {
  let workspace = createAccountingFixture({ withReconciliations: false, withPostedVouchers: false });
  workspace.stores = [{ id: "store-service", name: "服务中心", status: "active" }];
  workspace = confirmBankTransactionBusinessEvent(workspace, {
    transactionId: "txn-fee",
    businessType: "bankFee",
    account: "expenseFee",
    businessPeriod: "2026-08",
    taxTreatment: "input_non_deductible",
    invoiceStatus: "not_applicable",
    evidenceIds: ["doc-bank"],
    confidence: 100,
    reason: "已核对银行收费回单，确认为账户管理手续费",
  }, context);
  workspace = setBankTransactionBusinessEventDimensions(workspace, {
    transactionId: "txn-fee",
    storeId: "store-service",
    department: "财务部",
    project: "日常经营",
  }, context);
  const transaction = workspace.transactions.find((item) => item.id === "txn-fee");
  const event = workspace.businessEvents.find((item) => item.id === transaction.bankBusinessEventId);
  assert.deepEqual(
    { storeId: event.storeId, storeName: event.storeName, department: event.department, project: event.project },
    { storeId: "store-service", storeName: "服务中心", department: "财务部", project: "日常经营" },
  );
  const beforeStatements = buildFinancialStatements(workspace, { period: "2026-08" });

  workspace = createBankBusinessEventVoucherDraft(workspace, {
    eventId: event.id,
    note: "按人工确认的费用科目和税务属性生成草稿",
  }, { ...context, at: "2026-09-06T13:00:10.000Z", mode: "manual" });
  const voucher = workspace.vouchers[0];
  assert.equal(validateVoucherBalance(voucher).balanced, true);
  assert.deepEqual(voucher.lines.map((line) => [line.account, line.debit, line.credit]), [
    ["bank:operating", 0, 20],
    ["expenseFee", 20, 0],
  ]);
  assert.equal(voucher.lines.every((line) => line.storeId === "store-service" && line.storeName === "服务中心"), true);
  assert.equal(voucher.lines.every((line) => line.department === "财务部" && line.project === "日常经营"), true);
  assert.equal(voucher.bankBusinessEventId, event.id);
  assert.equal(voucher.period, "2026-08");
  assert.equal(voucher.postingPolicy, "manual_only");
  assert.equal(voucher.taxAttributes.treatment, "input_non_deductible");
  assert.ok(voucher.sourceIds.includes("txn-fee"));
  assert.ok(voucher.sourceIds.includes(event.id));
  assert.ok(voucher.evidenceIds.includes("doc-bank"));
  assert.equal(workspace.businessEvents.find((item) => item.id === event.id).accountingStatus, "voucher_draft");
  assert.throws(() => createBankBusinessEventVoucherDraft(workspace, { eventId: event.id }, context), (error) => (
    error instanceof AccountingRuleError && error.code === "SOURCE_ALREADY_VOUCHERED"
  ));
  assert.throws(() => postVoucher(workspace, {
    voucherId: voucher.id,
    mode: "automatic",
  }, context), (error) => error instanceof AccountingRuleError && error.code === "BANK_BUSINESS_EVENT_MANUAL_POST_REQUIRED");
  assert.throws(() => postVoucher(workspace, {
    voucherId: voucher.id,
    mode: "manual",
  }, context), (error) => error instanceof AccountingRuleError && error.code === "REVIEW_NOTE_REQUIRED");

  const attachments = buildAttachmentPackage(workspace, voucher.id);
  assert.equal(attachments.status, "complete");
  assert.ok(attachments.manifest.some((item) => item.id === event.id && item.kind === "业务事件"));
  assert.ok(attachments.manifest.some((item) => item.id === "doc-bank"));
  const trace = traceVoucherSources(workspace, voucher.id);
  assert.deepEqual(trace.transactions.map((item) => item.id), ["txn-fee"]);
  assert.deepEqual(trace.businessEvents.map((item) => item.id), [event.id]);

  workspace = postVoucher(workspace, {
    voucherId: voucher.id,
    mode: "manual",
    reviewNote: "已人工复核银行流水、业务事件、费用科目、税务属性和证据来源",
  }, { ...context, at: "2026-09-06T13:00:20.000Z" });
  const postedEvent = workspace.businessEvents.find((item) => item.id === event.id);
  assert.equal(workspace.vouchers[0].status, "posted");
  assert.equal(postedEvent.accountingStatus, "posted");
  assert.equal(postedEvent.voucherId, voucher.id);
  assert.equal(postedEvent.postedAt, "2026-09-06T13:00:20.000Z");
  assert.equal(postedEvent.accountingAttributes.postingStatus, "posted");

  const afterStatements = buildFinancialStatements(workspace, { period: "2026-08" });
  assert.equal(afterStatements.incomeStatement.profit.value, beforeStatements.incomeStatement.profit.value - 20);
  assert.equal(afterStatements.cashFlow.closingCash.value, beforeStatements.cashFlow.closingCash.value - 20);
  assert.ok(afterStatements.incomeStatement.profit.sourceIds.includes(event.id));
});

test("non-member workspaces calculate traceable profit by location from posted voucher lines", () => {
  const workspace = createBlankWorkspace({
    id: "workspace-location-profit",
    name: "通用服务工作台",
    currentPeriod: "2026-09",
    modules: { members: false },
  }, { timestamp: context.at });
  workspace.stores = [
    { id: "store-east", name: "东区", status: "active" },
    { id: "store-west", name: "西区", status: "active" },
  ];
  workspace.vouchers = [
    {
      id: "voucher-east",
      no: "记-001",
      date: "2026-09-10",
      period: "2026-09",
      status: "posted",
      sourceIds: ["source-east"],
      lines: [
        { account: "bank", debit: 1000, credit: 0, sourceIds: ["bank-east"] },
        { account: "revenuePrivate", debit: 0, credit: 1000, storeId: "store-east", storeName: "东区", sourceIds: ["sale-east"] },
        { account: "costOfSales", debit: 300, credit: 0, storeId: "store-east", storeName: "东区", sourceIds: ["cost-east"] },
        { account: "payable", debit: 0, credit: 300, sourceIds: ["cost-east"] },
        { account: "expenseRent", debit: 100, credit: 0, storeId: "store-east", storeName: "东区", sourceIds: ["rent-east"] },
        { account: "payable", debit: 0, credit: 100, sourceIds: ["rent-east"] },
      ],
    },
    {
      id: "voucher-unassigned",
      no: "记-002",
      date: "2026-09-11",
      period: "2026-09",
      status: "posted",
      sourceIds: ["source-unassigned"],
      lines: [
        { account: "bank", debit: 500, credit: 0, sourceIds: ["bank-unassigned"] },
        { account: "revenuePrivate", debit: 0, credit: 500, sourceIds: ["sale-unassigned"] },
      ],
    },
  ];

  const report = buildStoreManagementReport(workspace, { period: "2026-09", asOf: "2026-09-30" });
  const byStore = Object.fromEntries(report.stores.map((store) => [store.id, store]));
  assert.deepEqual(
    { revenue: byStore["store-east"].metrics.revenue, cost: byStore["store-east"].metrics.cost, expenses: byStore["store-east"].metrics.expenses, profit: byStore["store-east"].metrics.profit },
    { revenue: 1000, cost: 300, expenses: 100, profit: 600 },
  );
  assert.equal(byStore.unassigned.metrics.revenue, 500);
  assert.equal(byStore["store-west"], undefined);
  assert.equal(byStore["store-east"].sources.every((source) => source.voucherId === "voucher-east"), true);
  assert.ok(byStore["store-east"].sourceIds.includes("sale-east"));
  assert.deepEqual(
    { revenue: report.totals.revenue, cost: report.totals.cost, expenses: report.totals.expenses, profit: report.totals.profit },
    { revenue: 1500, cost: 300, expenses: 100, profit: 1100 },
  );
});

test("incomplete evidence and unfinished cross-period S7 review block bank businessEvent drafts", () => {
  let incomplete = createAccountingFixture({ withReconciliations: false, withPostedVouchers: false });
  incomplete = confirmBankTransactionBusinessEvent(incomplete, {
    transactionId: "txn-low",
    businessType: "customerReceipt",
    account: "receivable",
    counterparty: "个人客户",
    referenceNo: "ORDER-NO-EVIDENCE",
    businessPeriod: "2026-08",
    taxTreatment: "taxable_income",
    invoiceStatus: "issued",
    confidence: 100,
    reason: "已确认来款性质，但业务证据尚未补齐",
  }, context);
  const incompleteEvent = incomplete.businessEvents.find((item) => item.id === incomplete.transactions.find((item) => item.id === "txn-low").bankBusinessEventId);
  assert.equal(incompleteEvent.evidenceCompleteness < 100, true);
  assert.throws(() => createBankBusinessEventVoucherDraft(incomplete, {
    eventId: incompleteEvent.id,
  }, context), (error) => error instanceof AccountingRuleError && error.code === "BUSINESS_EVENT_EVIDENCE_INCOMPLETE");

  let crossPeriod = createAccountingFixture({ withReconciliations: false, withPostedVouchers: false });
  crossPeriod = confirmBankTransactionBusinessEvent(crossPeriod, {
    transactionId: "txn-followup",
    businessType: "customerReceipt",
    account: "receivable",
    counterparty: "橙子平台",
    relatedBillId: "bill-ar-2",
    businessPeriod: "2026-08",
    taxTreatment: "taxable_income",
    invoiceStatus: "issued",
    evidenceIds: ["doc-settlement"],
    confidence: 98,
    reason: "9 月到账归属于 8 月课程结算",
  }, context);
  let crossEvent = crossPeriod.businessEvents.find((item) => item.id === crossPeriod.transactions.find((item) => item.id === "txn-followup").bankBusinessEventId);
  assert.equal(crossEvent.evidenceCompleteness, 100);
  assert.throws(() => createBankBusinessEventVoucherDraft(crossPeriod, {
    eventId: crossEvent.id,
  }, context), (error) => error instanceof AccountingRuleError && error.code === "BUSINESS_EVENT_S7_REQUIRED");

  const reviewCase = buildReconciliationExceptionCases(crossPeriod, "txn-followup")
    .find((item) => item.code === "business_event_manual_review");
  const treatment = reviewCase.accountingTreatments.find((item) => item.kind === "classification");
  crossPeriod = handleReconciliationException(crossPeriod, {
    exceptionId: reviewCase.id,
    action: "adopt_treatment",
    treatmentId: treatment.id,
    note: "已复核合同履约期、到账日和跨期归属，确认计入 8 月",
  }, { ...context, at: "2026-09-06T13:00:30.000Z" });
  crossEvent = crossPeriod.businessEvents.find((item) => item.id === crossEvent.id);
  assert.equal(crossEvent.review.status, "approved");
  crossPeriod = createBankBusinessEventVoucherDraft(crossPeriod, {
    eventId: crossEvent.id,
  }, { ...context, at: "2026-09-06T13:00:40.000Z" });
  const voucher = crossPeriod.vouchers[0];
  assert.equal(voucher.period, "2026-08");
  assert.equal(voucher.fundingPeriod, "2026-09");
  assert.ok([crossEvent.id, "txn-followup", "bill-ar-2"].every((sourceId) => voucher.sourceIds.includes(sourceId)));
  assert.deepEqual(traceVoucherSources(crossPeriod, voucher.id).bills.map((bill) => bill.id), ["bill-ar-2"]);
});

test("reviewed internal-transfer businessEvent produces one two-bank voucher without duplicate cash flow", () => {
  let workspace = createAccountingFixture({ withReconciliations: false, withPostedVouchers: false });
  workspace = confirmBankTransactionBusinessEvent(workspace, {
    transactionId: "txn-transfer-out",
    businessType: "internalTransfer",
    account: "bank",
    relatedTransactionId: "txn-transfer-in",
    businessPeriod: "2026-08",
    evidenceIds: ["doc-transfer"],
    confidence: 100,
    reason: "已核对经营账户转出与备用账户转入流水",
  }, context);
  const event = workspace.businessEvents.find((item) => item.id === workspace.transactions.find((item) => item.id === "txn-transfer-out").bankBusinessEventId);
  const reviewCase = buildReconciliationExceptionCases(workspace, "txn-transfer-out")
    .find((item) => item.code === "business_event_manual_review");
  const treatment = reviewCase.accountingTreatments.find((item) => item.kind === "classification");
  workspace = handleReconciliationException(workspace, {
    exceptionId: reviewCase.id,
    action: "adopt_treatment",
    treatmentId: treatment.id,
    note: "已复核两端账户、金额和日期，确认仅记一张内部转账凭证",
  }, { ...context, at: "2026-09-06T13:00:50.000Z" });
  workspace = createBankBusinessEventVoucherDraft(workspace, {
    eventId: event.id,
  }, { ...context, at: "2026-09-06T13:01:00.000Z" });
  const voucher = workspace.vouchers[0];
  assert.deepEqual(voucher.lines.map((line) => [line.account, line.debit, line.credit]), [
    ["bank:reserve", 2000, 0],
    ["bank:operating", 0, 2000],
  ]);
  assert.ok(voucher.sourceIds.includes("txn-transfer-out"));
  assert.ok(voucher.sourceIds.includes("txn-transfer-in"));
  assert.equal(validateVoucherBalance(voucher).balanced, true);
});

test("confirmed customer deposit application creates one manual-only traceable voucher and writes posting state back", () => {
  let workspace = createAccountingFixture({ withReconciliations: false, withPostedVouchers: false });
  workspace = applyReconciliation(workspace, {
    transactionId: "txn-deposit",
    allocations: [{ billId: "bill-deposit-1", amount: 2400 }],
  }, context);
  workspace.bills.push({
    id: "bill-ar-advance-voucher",
    no: "YS-202609-301",
    kind: "receivable",
    counterparty: "会员李女士",
    summary: "预收转应收测试账单",
    amount: 800,
    date: "2026-09-01",
    dueDate: "2026-09-15",
    evidenceIds: ["doc-member-contract"],
  });
  workspace = applyAdvanceToBill(workspace, {
    advanceBillId: "bill-deposit-1",
    targetBillId: "bill-ar-advance-voucher",
    amount: 800,
  }, context);
  const application = workspace.advanceApplications[0];
  const fundingAllocationId = workspace.transactions.find((transaction) => transaction.id === "txn-deposit").allocations[0].id;

  workspace = createAdvanceApplicationVoucherDraft(workspace, {
    applicationId: application.id,
    note: "核对预收余额与目标应收",
  }, { ...context, at: "2026-09-06T13:01:00.000Z" });
  const voucher = workspace.vouchers[0];
  assert.equal(validateVoucherBalance(voucher).balanced, true);
  assert.deepEqual(voucher.lines.map((line) => [line.account, line.debit, line.credit]), [
    ["contractLiability", 800, 0],
    ["receivable", 0, 800],
  ]);
  assert.ok([application.id, "txn-deposit", fundingAllocationId, "bill-deposit-1", "bill-ar-advance-voucher"]
    .every((sourceId) => voucher.sourceIds.includes(sourceId)));
  assert.equal(workspace.advanceApplications[0].accountingStatus, "voucher_draft");
  assert.equal(workspace.advanceApplications[0].draftVoucherId, voucher.id);
  assert.throws(() => createAdvanceApplicationVoucherDraft(workspace, {
    applicationId: application.id,
  }, context), (error) => error instanceof AccountingRuleError && error.code === "SOURCE_ALREADY_VOUCHERED");
  assert.throws(() => postVoucher(workspace, {
    voucherId: voucher.id,
    mode: "automatic",
  }, context), (error) => error instanceof AccountingRuleError && error.code === "ADVANCE_APPLICATION_MANUAL_REVIEW_REQUIRED");

  workspace = postVoucher(workspace, {
    voucherId: voucher.id,
    mode: "manual",
    reviewNote: "已人工核对原收款、预收余额和应收账单",
  }, { ...context, at: "2026-09-06T13:02:00.000Z" });
  const postedApplication = workspace.advanceApplications[0];
  assert.equal(workspace.vouchers[0].status, "posted");
  assert.equal(workspace.vouchers[0].reviews.at(-1).mode, "manual");
  assert.equal(postedApplication.accountingStatus, "posted");
  assert.equal(postedApplication.voucherId, voucher.id);
  assert.equal(postedApplication.draftVoucherId, null);
  assert.equal(postedApplication.postedAt, "2026-09-06T13:02:00.000Z");
  assert.deepEqual(traceVoucherSources(workspace, voucher.id).advanceApplications.map((item) => item.id), [application.id]);
  assert.deepEqual(traceVoucherSources(workspace, voucher.id).bills.map((item) => item.id), ["bill-deposit-1", "bill-ar-advance-voucher"]);
  assert.ok(buildAttachmentPackage(workspace, voucher.id).manifest.some((item) => item.id === application.id && item.kind === "预收/预付冲销"));
});

test("confirmed supplier prepayment application drafts and posts debit-payable credit-prepayment entries", () => {
  let workspace = createAccountingFixture({ withReconciliations: false, withPostedVouchers: false });
  workspace = applyReconciliation(workspace, {
    transactionId: "txn-prepay",
    allocations: [{ billId: "bill-prepay-1", amount: 1800 }],
  }, context);
  workspace.bills.push({
    id: "bill-ap-advance-voucher",
    no: "YF-202609-301",
    kind: "payable",
    counterparty: "场地出租方",
    summary: "预付转应付测试账单",
    amount: 900,
    date: "2026-09-01",
    dueDate: "2026-09-10",
    evidenceIds: ["doc-approval"],
  });
  workspace = applyAdvanceToBill(workspace, {
    advanceBillId: "bill-prepay-1",
    targetBillId: "bill-ap-advance-voucher",
    amount: 900,
  }, context);
  const applicationId = workspace.advanceApplications[0].id;
  workspace = createAdvanceApplicationVoucherDraft(workspace, { applicationId }, context);
  const voucher = workspace.vouchers[0];
  assert.deepEqual(voucher.lines.map((line) => [line.account, line.debit, line.credit]), [
    ["payable", 900, 0],
    ["prepayment", 0, 900],
  ]);

  workspace = reviewTransactionEvidence(workspace, "txn-prepay", context);
  workspace = recordManualConfirmation(workspace, {
    transactionId: "txn-prepay",
    decision: "approve",
    reason: "已核对预付合同、审批与后续应付账单",
  }, { ...context, at: "2026-09-06T13:03:00.000Z" });
  workspace = postVoucher(workspace, {
    voucherId: voucher.id,
    mode: "manual",
    reviewNote: "人工复核借应付贷预付及全部来源无误",
  }, { ...context, at: "2026-09-06T13:04:00.000Z" });
  assert.equal(workspace.vouchers[0].status, "posted");
  assert.equal(workspace.advanceApplications[0].accountingStatus, "posted");
  assert.equal(workspace.advanceApplications[0].voucherId, voucher.id);
});

test("a partially allocated receipt stays open and later allocations create a second traceable voucher", () => {
  let workspace = createAccountingFixture({ withReconciliations: false, withPostedVouchers: false });
  workspace = applyReconciliation(workspace, {
    transactionId: "txn-split",
    allocations: [{ billId: "bill-ar-1", amount: 500 }],
  }, context);
  workspace = createVoucherDraft(workspace, { transactionId: "txn-split" }, context);
  const firstVoucherId = workspace.vouchers.at(-1).id;
  workspace = postVoucher(workspace, { voucherId: firstVoucherId, mode: "automatic" }, context);
  assert.equal(workspace.transactions.find((item) => item.id === "txn-split").status, "pending");

  workspace = applyReconciliation(workspace, {
    transactionId: "txn-split",
    allocations: [{ billId: "bill-ar-1", amount: 500 }, { billId: "bill-ar-2", amount: 500 }],
  }, { ...context, at: "2026-09-06T13:01:00.000Z" });
  workspace = createVoucherDraft(workspace, { transactionId: "txn-split" }, { ...context, at: "2026-09-06T13:02:00.000Z" });
  const secondVoucher = workspace.vouchers.at(-1);
  assert.notEqual(secondVoucher.id, firstVoucherId);
  assert.ok(secondVoucher.sourceIds.includes("bill-ar-1"));
  assert.ok(secondVoucher.sourceIds.includes("bill-ar-2"));
  workspace = postVoucher(workspace, { voucherId: secondVoucher.id, mode: "automatic" }, { ...context, at: "2026-09-06T13:03:00.000Z" });
  assert.equal(workspace.transactions.find((item) => item.id === "txn-split").status, "posted");
  assert.deepEqual(workspace.transactions.find((item) => item.id === "txn-split").postedVoucherIds, [firstVoucherId, secondVoucher.id]);
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
  const dimensionedLines = workspace.vouchers[0].lines.map((line, index) => ({
    ...line,
    auxiliaryId: `party-${index + 1}`,
    auxiliaryLabel: `往来对象 ${index + 1}`,
    auxiliaryType: index === 0 ? "customer" : "supplier",
    storeId: "store-east",
    storeName: "东区门店",
    department: "运营部",
    project: "年度项目",
    taxAmount: index === 0 ? 18.87 : null,
  }));
  workspace = reviseDraftVoucher(workspace, {
    voucherId,
    summary: "收到橙子平台两期结算款",
    lines: dimensionedLines,
    reason: "补充跨月结算说明",
  }, { ...context, at: "2026-09-06T13:05:00.000Z" });
  assert.equal(workspace.vouchers[0].version, 2);
  assert.ok(workspace.vouchers[0].versions.length >= 2);
  assert.deepEqual(workspace.vouchers[0].lines.map((line) => ({
    auxiliaryId: line.auxiliaryId,
    auxiliaryLabel: line.auxiliaryLabel,
    auxiliaryType: line.auxiliaryType,
    storeId: line.storeId,
    storeName: line.storeName,
    department: line.department,
    project: line.project,
    taxAmount: line.taxAmount,
  })), dimensionedLines.map((line) => ({
    auxiliaryId: line.auxiliaryId,
    auxiliaryLabel: line.auxiliaryLabel,
    auxiliaryType: line.auxiliaryType,
    storeId: line.storeId,
    storeName: line.storeName,
    department: line.department,
    project: line.project,
    taxAmount: line.taxAmount,
  })));
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

test("ordinary receivable and payable ageing uses explicit due dates and keeps advances separate", () => {
  const workspace = {
    currentPeriod: "2026-09",
    bills: [
      { id: "ar-not-due", no: "YS-001", kind: "receivable", counterparty: "甲客户", summary: "十月服务款", amount: 1000, date: "2026-09-01", dueDate: "2026-10-10", evidenceIds: ["doc-ar-1"] },
      { id: "ar-1-30", no: "YS-002", kind: "receivable", counterparty: "乙客户", summary: "九月服务款", amount: 600, date: "2026-09-01", dueDate: "2026-09-15", evidenceIds: ["doc-ar-2"] },
      { id: "ar-31-60", no: "YS-003", kind: "receivable", counterparty: "丙客户", amount: 400, date: "2026-08-01", dueDate: "2026-08-15" },
      { id: "ar-61-90", no: "YS-004", kind: "receivable", counterparty: "丁客户", amount: 300, date: "2026-07-01", dueDate: "2026-07-15" },
      { id: "ar-over-90", no: "YS-005", kind: "receivable", counterparty: "戊客户", amount: 200, date: "2026-06-01", dueDate: "2026-06-01" },
      { id: "ar-missing", no: "YS-006", kind: "receivable", counterparty: "缺日期客户", amount: 150, date: "2026-09-03" },
      { id: "ap-1-30", no: "YF-001", kind: "payable", counterparty: "器材商", amount: 700, date: "2026-09-01", dueDate: "2026-09-20" },
      { id: "ap-missing", no: "YF-002", kind: "payable", counterparty: "临时供应商", amount: 250, date: "2026-09-05" },
      { id: "deposit", no: "YSK-001", kind: "depositReceived", counterparty: "会员甲", amount: 500, date: "2026-09-01", dueDate: "2026-09-01" },
      { id: "prepayment", no: "YFK-001", kind: "prepaymentPaid", counterparty: "房东", amount: 300, date: "2026-09-01", dueDate: "2026-09-01" },
    ],
    transactions: [
      { id: "txn-ar-partial", date: "2026-09-10", amount: 100, allocations: [{ id: "allocation-ar", billId: "ar-1-30", amount: 100, status: "confirmed" }] },
      { id: "txn-deposit", date: "2026-09-01", amount: 500, allocations: [{ id: "allocation-deposit", billId: "deposit", amount: 500, status: "confirmed" }] },
      { id: "txn-prepayment", date: "2026-09-01", amount: -300, allocations: [{ id: "allocation-prepayment", billId: "prepayment", amount: 300, status: "confirmed" }] },
    ],
    advanceApplications: [],
  };
  const ageing = buildReceivablePayableAgeing(workspace, { asOf: "2026-09-30" });
  const buckets = Object.fromEntries(ageing.buckets.map((bucket) => [bucket.id, bucket]));
  assert.equal(buckets.notDue.receivable.value, 1000);
  assert.equal(buckets.days1To30.receivable.value, 500);
  assert.equal(buckets.days1To30.payable.value, 700);
  assert.equal(buckets.days31To60.receivable.value, 400);
  assert.equal(buckets.days61To90.receivable.value, 300);
  assert.equal(buckets.daysOver90.receivable.value, 200);
  assert.equal(ageing.receivable.value, 2550);
  assert.equal(ageing.payable.value, 950);
  assert.deepEqual(ageing.missingDueDate.rows.map((row) => row.billId).sort(), ["ap-missing", "ar-missing"]);
  assert.equal(ageing.missingDueDate.receivable.value, 150);
  assert.equal(ageing.missingDueDate.payable.value, 250);
  assert.equal(ageing.rows.some((row) => ["deposit", "prepayment"].includes(row.billId)), false);
  assert.equal(ageing.excludedAdvances.customerDeposits.value, 500);
  assert.equal(ageing.excludedAdvances.supplierPrepayments.value, 300);
  assert.ok(buckets.days1To30.receivable.sourceIds.includes("doc-ar-2"));
});

test("thirty-day cash forecast uses dated bills and confirmed obligations with source drilldown", () => {
  const workspace = {
    id: "workspace-cash-forecast",
    currentPeriod: "2026-09",
    accounts: [{ id: "bank:operating", name: "经营账户" }],
    bankAccounts: [{ id: "bank:operating", name: "经营账户" }],
    openingLedger: { "bank:operating": 1000, equity: -1000 },
    vouchers: [],
    bills: [
      { id: "ar-october", no: "YS-101", kind: "receivable", counterparty: "企业客户", amount: 500, date: "2026-09-20", dueDate: "2026-10-02", evidenceIds: ["doc-ar"] },
      { id: "ap-october", no: "YF-101", kind: "payable", counterparty: "器材商", amount: 1000, date: "2026-09-20", dueDate: "2026-10-04", evidenceIds: ["doc-ap"] },
      { id: "ap-no-date", no: "YF-102", kind: "payable", counterparty: "未知到期供应商", amount: 700, date: "2026-09-20", evidenceIds: ["doc-ap-missing"] },
    ],
    transactions: [],
    advanceApplications: [],
    businessEvents: [],
    members: [],
    exceptionTasks: [],
    confirmations: [],
    reportVersions: [],
    auditLog: [],
    tax: {
      payroll: 200,
      socialSecurity: 100,
      confirmedTaxAmount: 300,
      payrollConfirmedAt: "2026-09-29T10:00:00.000Z",
      socialSecurityConfirmedAt: "2026-09-29T10:01:00.000Z",
      taxConfirmedAt: "2026-09-29T10:02:00.000Z",
      payrollDueDate: "2026-10-05",
      socialSecurityDueDate: "2026-10-06",
      taxDueDate: "2026-10-07",
      payrollSourceIds: ["payroll-source"],
      socialSecuritySourceIds: ["social-source"],
      confirmedTaxSourceIds: ["tax-source"],
    },
  };
  const forecast = buildThirtyDayCashForecast(workspace, {
    period: "2026-09",
    asOf: "2026-09-30",
  });
  assert.equal(forecast.currentBalance.value, 1000);
  assert.equal(forecast.totals.receivable.value, 500);
  assert.equal(forecast.totals.payable.value, 1000);
  assert.equal(forecast.totals.payroll.value, 200);
  assert.equal(forecast.totals.socialSecurity.value, 100);
  assert.equal(forecast.totals.tax.value, 300);
  assert.equal(forecast.days.find((day) => day.date === "2026-10-02").closingBalance, 1500);
  assert.equal(forecast.days.find((day) => day.date === "2026-10-04").closingBalance, 500);
  assert.equal(forecast.minimumBalance.value, -100);
  assert.equal(forecast.minimumBalance.date, "2026-10-07");
  assert.equal(forecast.cashShortfall.value, 100);
  assert.equal(forecast.deficitDate, "2026-10-07");
  assert.equal(forecast.weeks[0].receipts, 500);
  assert.equal(forecast.weeks[0].payments, 1600);
  assert.equal(forecast.weeks[0].closingBalance, -100);
  assert.deepEqual(forecast.missingSchedule.map((item) => item.id), ["forecast-missing-bill:ap-no-date"]);
  assert.ok(forecast.currentBalance.sourceIds.includes("bank:operating"));
  assert.ok(forecast.totals.tax.sourceIds.includes("tax-source"));
  assert.ok(forecast.totals.payable.sourceIds.includes("doc-ap"));

  const withoutTaxConfirmation = buildThirtyDayCashForecast({
    ...workspace,
    tax: { ...workspace.tax, taxConfirmedAt: null },
  }, { period: "2026-09", asOf: "2026-09-30" });
  assert.equal(withoutTaxConfirmation.totals.tax.value, 0);
  assert.equal(withoutTaxConfirmation.minimumBalance.value, 200);
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
