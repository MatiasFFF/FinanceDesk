import assert from "node:assert/strict";
import test from "node:test";

import { createAccountingFixture as rawAccountingFixture } from "../src/domain/accounting/fixtures.js";
import { withVoucherEvidence } from "./helpers/voucherEvidenceFixture.mjs";
import { AccountingRuleError } from "../src/domain/accounting/model.js";
import { buildGeneralLedger, effectivePostedVouchers } from "../src/domain/accounting/ledger.js";
import { createVoucherDraft, postVoucher, postVoucherWithEvidence, vouchersForSource } from "../src/domain/accounting/vouchers.js";
import { reviewTransactionEvidence } from "../src/features/evidence/evidenceEngine.js";
import { postWorkspaceVoucher } from "../src/application/financeDeskService.js";
import {
  createFinanceDeskStore,
  createInitialState,
  createLocalFoundationRepository,
  createMemoryStorage,
} from "../src/foundation.js";
import {
  MANUAL_BUSINESS_EVENT_TYPES,
  advanceApplicationTargets,
  advanceBalance,
  applyAdvanceToBill,
  applyReconciliation,
  billSettlement,
  buildAdvanceBalances,
  buildAgeingSchedule,
  buildReconciliationExceptionCases,
  confirmBankTransactionBusinessEvent,
  confirmReconciliationSuggestion,
  confirmedAdvanceApplications,
  cancelReconciliationCorrection,
  createReconciliationCorrection,
  createSettlementBill,
  linkInternalTransfer,
  linkRefundToOriginal,
  handleReconciliationException,
  recordReconciliationSuggestions,
  redoReconciliation,
  reverseReconciliation,
  suggestReconciliations,
  transactionSettlement,
} from "../src/features/reconciliation/reconciliationEngine.js";

const context = { actor: "测试会计", at: "2026-09-06T12:00:00.000Z", mode: "manual" };

// These settlement tests start from explicitly confirmed opening receivables and
// payables when they omit original posted vouchers; receipt posting is not revenue
// recognition. The complete fixture already contains its original confirmations.
function createAccountingFixture(options = {}) {
  const workspace = rawAccountingFixture(options);
  for (const bill of workspace.bills) if (["depositReceived", "prepaymentPaid"].includes(bill.kind)) bill.cashFlowCategory = "operating";
  if (options.withPostedVouchers === false) {
    workspace.openingStatus = { status: "confirmed", source: "manual", confirmedBy: context.actor };
    workspace.openingLedger = { ...workspace.openingLedger, receivable: 3200, payable: -900, equity: -27300 };
    for (const bill of workspace.bills) if (["receivable", "payable"].includes(bill.kind)) bill.recognitionBasis = "opening";
  }
  return workspace;
}

async function postWithFixtureEvidence(workspace, input, postingContext = context) {
  const fixture = await withVoucherEvidence(workspace);
  return postVoucherWithEvidence(fixture.workspace, input, { ...postingContext, fileVault: fixture.fileVault });
}

function blankFixture() {
  return createAccountingFixture({ withReconciliations: false, withPostedVouchers: false });
}

async function postedSplitReceiptFixture() {
  let workspace = applyReconciliation(blankFixture(), {
    transactionId: "txn-split",
    allocations: [{ billId: "bill-ar-1", amount: 1000 }, { billId: "bill-ar-2", amount: 500 }],
  }, context);
  workspace = createVoucherDraft(workspace, { transactionId: "txn-split" }, context);
  return postWithFixtureEvidence(workspace, { voucherId: workspace.vouchers[0].id, mode: "automatic" }, context);
}

function automaticMatchingFixture() {
  const workspace = blankFixture();
  const classification = {
    eventType: "customerReceipt",
    account: "receivable",
    confidence: 98,
    reasons: ["标准客户收款"],
    riskFlags: [],
    candidateBillIds: [],
    requiresManualReview: false,
    source: "manual",
  };
  workspace.bills = [
    { id: "bill-match-full", no: "YS-MATCH-001", kind: "receivable", counterparty: "星河客户", counterpartyObjectId: "customer-starry", counterpartyStandardized: true, summary: "整单", amount: 1000, date: "2026-08-01", dueDate: "2026-08-20", evidenceIds: [] },
    { id: "bill-match-a", no: "YS-MATCH-002", kind: "receivable", counterparty: "星河客户", counterpartyObjectId: "customer-starry", counterpartyStandardized: true, summary: "分单 A", amount: 600, date: "2026-08-02", dueDate: "2026-08-20", evidenceIds: [] },
    { id: "bill-match-b", no: "YS-MATCH-003", kind: "receivable", counterparty: "星河客户", counterpartyObjectId: "customer-starry", counterpartyStandardized: true, summary: "分单 B", amount: 400, date: "2026-08-03", dueDate: "2026-08-20", evidenceIds: [] },
  ];
  workspace.transactions = [
    { id: "txn-match-full", accountId: "bank:operating", date: "2026-08-20", counterparty: "星河客户", counterpartyObjectId: "customer-starry", counterpartyStandardized: true, amount: 1000, serial: "MATCH-001", evidenceIds: [], allocations: [], status: "pending", classification },
    { id: "txn-match-a", accountId: "bank:operating", date: "2026-08-18", counterparty: "星河客户", counterpartyObjectId: "customer-starry", counterpartyStandardized: true, amount: 600, serial: "MATCH-002", evidenceIds: [], allocations: [], status: "pending", classification },
    { id: "txn-match-b", accountId: "bank:operating", date: "2026-08-19", counterparty: "星河客户", counterpartyObjectId: "customer-starry", counterpartyStandardized: true, amount: 400, serial: "MATCH-003", evidenceIds: [], allocations: [], status: "pending", classification },
  ];
  workspace.exceptionTasks = [];
  workspace.vouchers = [];
  return workspace;
}

test("manual bank business-event catalogue covers all fourteen business types including distinct borrowing and repayment", () => {
  assert.deepEqual(MANUAL_BUSINESS_EVENT_TYPES.map((definition) => definition.id), [
    "customerReceipt",
    "memberRecharge",
    "supplierPayment",
    "supplierPrepayment",
    "purchaseExpense",
    "payroll",
    "rentAndProperty",
    "bankFee",
    "loanBorrowing",
    "loanRepayment",
    "employeeAdvance",
    "relatedParty",
    "refund",
    "internalTransfer",
  ]);
  assert.deepEqual(
    MANUAL_BUSINESS_EVENT_TYPES.filter((definition) => definition.eventType === "loan").map((definition) => definition.allowedDirections),
    [["in"], ["out"]],
  );
});

test("manual confirmation creates a traceable businessEvent with periods, accounting, tax, evidence and no automatic posting", async () => {
  let workspace = (await withVoucherEvidence(blankFixture())).workspace;
  workspace = confirmBankTransactionBusinessEvent(workspace, {
    transactionId: "txn-low",
    businessType: "customerReceipt",
    account: "receivable",
    counterparty: "个人客户王女士",
    referenceNo: "ORDER-202608-018",
    businessPeriod: "2026-08",
    taxTreatment: "taxable_income",
    invoiceStatus: "issued",
    evidenceIds: ["doc-settlement"],
    confidence: 96,
    reason: "已核对客户、课程订单、平台结算单和到账金额",
  }, context);

  const transaction = workspace.transactions.find((item) => item.id === "txn-low");
  const event = workspace.businessEvents.find((item) => item.id === transaction.bankBusinessEventId);
  assert.match(event.businessEventNo, /^BE-202608-\d{3}$/);
  assert.equal(event.businessType, "customerReceipt");
  assert.equal(event.eventType, "customerReceipt");
  assert.equal(event.businessPeriod, "2026-08");
  assert.equal(event.fundingPeriod, "2026-08");
  assert.equal(event.accountingAttributes.primaryAccount, "receivable");
  assert.equal(event.accountingAttributes.postingPolicy, "manual_only");
  assert.equal(event.taxAttributes.treatment, "taxable_income");
  assert.equal(event.evidenceCompleteness, 100);
  assert.equal(event.confidence, 96);
  assert.match(event.judgementBasis, /课程订单/);
  assert.equal(event.status, "confirmed");
  assert.equal(event.automaticPostingAllowed, false);
  assert.equal(transaction.classification.source, "manual-business-event");
  assert.equal(transaction.evidenceAssessment.canAutomaticallyPost, false);
  assert.ok(event.sourceIds.includes("txn-low"));
  assert.ok(event.sourceIds.includes("doc-settlement"));
  assert.equal(workspace.vouchers.length, 0);
  assert.ok(workspace.auditLog.some((entry) => entry.action === "reconciliation.business_event_confirm"));

  const withDraft = createVoucherDraft(workspace, { transactionId: "txn-low" }, context);
  const draft = withDraft.vouchers.at(-1);
  assert.equal(draft.status, "draft");
  assert.equal(draft.bankBusinessEventId, event.id);
  assert.ok(draft.sourceIds.includes("ORDER-202608-018"));
  assert.ok(draft.businessReferences.some((reference) => reference.id === "ORDER-202608-018" && reference.kind === "order_contract"));
  await assert.rejects(() => postWithFixtureEvidence(withDraft, {
    voucherId: draft.id,
    reviewNote: "不应被自动过账",
    mode: "automatic",
  }, { ...context, mode: "automatic" }), (error) => (
    error instanceof AccountingRuleError && error.code === "BANK_BUSINESS_EVENT_MANUAL_POST_REQUIRED"
  ));
  const mismatchedReference = structuredClone(withDraft);
  mismatchedReference.businessEvents.find((item) => item.id === event.id).referenceNo = "ORDER-DIFFERENT-SOURCE";
  await assert.rejects(() => postWithFixtureEvidence(mismatchedReference, {
    voucherId: draft.id,
    reviewNote: "原件齐全也不能把不匹配的外部编号当作真实业务来源",
    mode: "manual",
  }, context), (error) => error instanceof AccountingRuleError && error.code === "VOUCHER_EVIDENCE_REQUIRED" && error.message.includes("ORDER-202608-018"));
  const posted = await postWithFixtureEvidence(withDraft, {
    voucherId: draft.id,
    reviewNote: "已读取银行回单与订单原件，外部订单编号保留为业务依据，人工复核入账",
    mode: "manual",
  }, context);
  const postedVoucher = posted.vouchers.find((voucher) => voucher.id === draft.id);
  assert.equal(postedVoucher.status, "posted");
  assert.ok(postedVoucher.sourceIds.includes("ORDER-202608-018"));
  assert.ok(postedVoucher.businessReferences.some((reference) => reference.id === "ORDER-202608-018" && reference.kind === "order_contract"));
  assert.equal(posted.businessEvents.find((item) => item.id === event.id).accountingStatus, "posted");
});

test("loan repayment remains a review-blocked businessEvent until a reviewer adopts the treatment", async () => {
  let workspace = (await withVoucherEvidence(blankFixture())).workspace;
  workspace = confirmBankTransactionBusinessEvent(workspace, {
    transactionId: "txn-payable",
    businessType: "loanRepayment",
    account: "loan",
    counterparty: "本地合作银行",
    referenceNo: "LOAN-2026-001 / 第一期还款",
    businessPeriod: "2026-08",
    evidenceIds: ["doc-approval"],
    confidence: 98,
    reason: "已核对借款合同、还款计划和银行回单，本笔为本金偿还",
  }, context);
  const transaction = workspace.transactions.find((item) => item.id === "txn-payable");
  let event = workspace.businessEvents.find((item) => item.id === transaction.bankBusinessEventId);
  assert.equal(event.businessType, "loanRepayment");
  assert.equal(event.eventType, "loan");
  assert.equal(event.status, "needs_review");
  assert.equal(event.review.status, "pending");
  assert.equal(workspace.vouchers.length, 0);
  const reviewTask = workspace.exceptionTasks.find((task) => task.sourceId === "txn-payable" && task.code === "business_event_manual_review" && task.status === "open");
  assert.ok(reviewTask);

  const exceptionCase = buildReconciliationExceptionCases(workspace, "txn-payable").find((item) => item.id === reviewTask.id);
  const treatment = exceptionCase.accountingTreatments.find((item) => item.kind === "classification");
  workspace = handleReconciliationException(workspace, {
    exceptionId: reviewTask.id,
    action: "adopt_treatment",
    treatmentId: treatment.id,
    note: "负责人复核确认仅包含本金，不包含需另行确认的利息",
  }, { ...context, at: "2026-09-06T12:30:00.000Z" });
  event = workspace.businessEvents.find((item) => item.id === transaction.bankBusinessEventId);
  assert.equal(event.status, "confirmed");
  assert.equal(event.review.status, "approved");
  assert.equal(workspace.exceptionTasks.find((task) => task.id === reviewTask.id).status, "resolved");
});

test("cross-period classification stays review-blocked and invalid direction or missing business reference is rejected", () => {
  let workspace = blankFixture();
  workspace = confirmBankTransactionBusinessEvent(workspace, {
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
    reason: "9 月到账对应 8 月课程结算补款",
  }, context);
  const event = workspace.businessEvents.find((item) => item.transactionId === "txn-followup" && item.sourceType === "bankTransaction");
  assert.equal(event.crossPeriod, true);
  assert.equal(event.status, "needs_review");
  assert.ok(event.review.reasons.some((reason) => /跨期/.test(reason)));
  assert.ok(workspace.exceptionTasks.some((task) => task.sourceId === "txn-followup" && task.code === "business_event_manual_review" && task.status === "open"));

  assert.throws(() => confirmBankTransactionBusinessEvent(blankFixture(), {
    transactionId: "txn-payable",
    businessType: "loanBorrowing",
    counterparty: "资金方",
    referenceNo: "LOAN-WRONG-DIRECTION",
    businessPeriod: "2026-08",
    confidence: 100,
    reason: "方向错误的借款确认",
  }, context), (error) => error instanceof AccountingRuleError && error.code === "BUSINESS_EVENT_DIRECTION_INVALID");
  assert.throws(() => confirmBankTransactionBusinessEvent(blankFixture(), {
    transactionId: "txn-low",
    businessType: "customerReceipt",
    counterparty: "个人客户",
    businessPeriod: "2026-08",
    taxTreatment: "taxable_income",
    invoiceStatus: "issued",
    confidence: 100,
    reason: "缺少账单或订单编号",
  }, context), (error) => error instanceof AccountingRuleError && error.code === "BUSINESS_EVENT_REFERENCE_REQUIRED");
});

test("new receivables persist with split and repeated payments and remain in voucher sources", () => {
  const fixedNow = () => new Date("2026-09-06T12:00:00.000Z");
  const repository = createLocalFoundationRepository({ storage: createMemoryStorage(), now: fixedNow });
  repository.save(createInitialState({ now: fixedNow }));
  const store = createFinanceDeskStore({ repository });
  const workspaceId = store.getActiveWorkspace().id;
  let workspace = store.getActiveWorkspace();
  workspace = {
    ...workspace,
    currentPeriod: "2026-08",
    transactions: [
      ...workspace.transactions,
      { id: "txn-new-split", accountId: workspace.accounts[0].id, date: "2026-08-20", counterparty: "新客户", summary: "两张账单合并回款", amount: 900, serial: "LOCAL-NEW-001", evidenceIds: [], allocations: [], status: "pending", classification: { eventType: "customerReceipt", account: "receivable", confidence: 100, reasons: ["人工确认客户回款"], riskFlags: [], candidateBillIds: [], requiresManualReview: false, source: "manual" } },
      { id: "txn-new-followup", accountId: workspace.accounts[0].id, date: "2026-08-25", counterparty: "新客户", summary: "第二张账单补款", amount: 300, serial: "LOCAL-NEW-002", evidenceIds: [], allocations: [], status: "pending", classification: { eventType: "customerReceipt", account: "receivable", confidence: 100, reasons: ["人工确认客户回款"], riskFlags: [], candidateBillIds: [], requiresManualReview: false, source: "manual" } },
    ],
  };
  workspace = createSettlementBill(workspace, { kind: "receivable", counterparty: "新客户", summary: "第一张服务账单", amount: 700, date: "2026-08-01", dueDate: "2026-08-31" }, context);
  const firstBill = workspace.bills.at(-1);
  workspace = createSettlementBill(workspace, { kind: "receivable", counterparty: "新客户", summary: "第二张服务账单", amount: 500, date: "2026-08-02", dueDate: "2026-08-31" }, context);
  const secondBill = workspace.bills.at(-1);
  workspace = applyReconciliation(workspace, { transactionId: "txn-new-split", allocations: [{ billId: firstBill.id, amount: 700 }, { billId: secondBill.id, amount: 200 }] }, context);
  workspace = applyReconciliation(workspace, { transactionId: "txn-new-followup", allocations: [{ billId: secondBill.id, amount: 300 }] }, { ...context, at: "2026-09-06T12:05:00.000Z" });
  workspace = createVoucherDraft(workspace, { transactionId: "txn-new-split" }, context);
  workspace = createVoucherDraft(workspace, { transactionId: "txn-new-followup" }, { ...context, at: "2026-09-06T12:06:00.000Z" });
  store.actions.replaceWorkspace(workspaceId, workspace);

  const reloaded = createFinanceDeskStore({ repository }).getActiveWorkspace();
  assert.equal(billSettlement(reloaded, firstBill.id).remaining, 0);
  assert.equal(billSettlement(reloaded, secondBill.id).remaining, 0);
  assert.deepEqual(billSettlement(reloaded, secondBill.id).transactionIds, ["txn-new-split", "txn-new-followup"]);
  assert.equal(vouchersForSource(reloaded, secondBill.id).length, 2);
  assert.ok(vouchersForSource(reloaded, secondBill.id).every((voucher) => voucher.sourceIds.includes(secondBill.id)));
});

test("one receipt splits across bills and one bill accepts multiple cross-month receipts", () => {
  let workspace = blankFixture();
  workspace = applyReconciliation(workspace, {
    transactionId: "txn-split",
    allocations: [
      { billId: "bill-ar-1", amount: 1000 },
      { billId: "bill-ar-2", amount: 500 },
    ],
  }, context);

  assert.equal(transactionSettlement(workspace.transactions.find((item) => item.id === "txn-split")).status, "fully_reconciled");
  assert.equal(billSettlement(workspace, "bill-ar-1").remaining, 0);
  assert.equal(billSettlement(workspace, "bill-ar-2").remaining, 500);

  workspace = { ...workspace, currentPeriod: "2026-09" };
  workspace = applyReconciliation(workspace, {
    transactionId: "txn-followup",
    allocations: [{ billId: "bill-ar-2", amount: 500 }],
  }, { ...context, at: "2026-09-06T12:05:00.000Z" });
  const settled = billSettlement(workspace, "bill-ar-2");
  assert.equal(settled.status, "fully_reconciled");
  assert.deepEqual(settled.transactionIds, ["txn-split", "txn-followup"]);
  assert.deepEqual(settled.fundingPeriods, ["2026-08", "2026-09"]);
  assert.equal(workspace.auditLog.filter((item) => item.action === "reconciliation.allocate").length, 2);
});

test("partial and early receipt preserve both transaction and bill unallocated balances", () => {
  let workspace = blankFixture();
  workspace = applyReconciliation(workspace, {
    transactionId: "txn-partial",
    allocations: [{ billId: "bill-ar-3", amount: 300 }],
  }, context);
  assert.equal(transactionSettlement(workspace.transactions.find((item) => item.id === "txn-partial")).remaining, 0);
  const bill = billSettlement(workspace, "bill-ar-3");
  assert.equal(bill.status, "partial");
  assert.equal(bill.remaining, 900);
  assert.equal(bill.fundingPeriods[0], "2026-08");
});

test("suggested matches never reduce receivables and automatic allocation is finance-review gated", () => {
  const workspace = blankFixture();
  const suggestions = suggestReconciliations(workspace, "txn-split");
  assert.ok(suggestions.length >= 2);
  assert.equal(billSettlement(workspace, "bill-ar-1").remaining, 1000);

  const suggested = recordReconciliationSuggestions(workspace, "txn-split", context);
  const transaction = suggested.transactions.find((item) => item.id === "txn-split");
  assert.equal(transaction.status, "suspected");
  assert.equal(transactionSettlement(transaction).allocated, 0);
  assert.equal(billSettlement(suggested, "bill-ar-1").remaining, 1000);

  assert.throws(() => applyReconciliation(suggested, {
    transactionId: "txn-split",
    allocations: [{ billId: "bill-ar-1", amount: 1000 }],
  }, { ...context, mode: "automatic" }), (error) => (
    error instanceof AccountingRuleError && error.code === "FINANCE_REVIEW_REQUIRED"
  ));
});

test("automatic suggestions explain one-to-one, one-payment-to-many-bills, and one-bill-to-many-payments without mutating balances", () => {
  const workspace = automaticMatchingFixture();
  const before = structuredClone(workspace);
  const fullPaymentSuggestions = suggestReconciliations(workspace, "txn-match-full", { limit: 50 });
  const oneToOne = fullPaymentSuggestions.find((candidate) => (
    candidate.type === "one_to_one" && candidate.billIds[0] === "bill-match-full"
  ));
  const oneToMany = fullPaymentSuggestions.find((candidate) => (
    candidate.type === "one_to_many"
    && candidate.billIds.length === 2
    && candidate.billIds.includes("bill-match-a")
    && candidate.billIds.includes("bill-match-b")
  ));
  const manyToOne = suggestReconciliations(workspace, "txn-match-a", { limit: 50 }).find((candidate) => (
    candidate.type === "many_to_one"
    && candidate.billIds[0] === "bill-match-full"
    && candidate.transactionIds.length === 2
    && candidate.transactionIds.includes("txn-match-a")
    && candidate.transactionIds.includes("txn-match-b")
  ));

  assert.ok(oneToOne);
  assert.ok(oneToMany);
  assert.ok(manyToOne);
  assert.equal(oneToOne.confidence, 98);
  assert.equal(oneToMany.difference, 0);
  assert.equal(manyToOne.difference, 0);
  assert.deepEqual(oneToMany.allocations.map((allocation) => allocation.amount), [600, 400]);
  assert.deepEqual(manyToOne.allocations.map((allocation) => allocation.amount), [600, 400]);
  assert.deepEqual(oneToMany.reasonDetails.map((reason) => reason.key), ["counterparty", "amount", "date", "bill_balance"]);
  assert.deepEqual(workspace, before);
});

test("confirming a strong suggestion writes only traceable allocations and keeps partial/full balances accurate", () => {
  const workspace = automaticMatchingFixture();
  const oneToMany = suggestReconciliations(workspace, "txn-match-full", { limit: 50 }).find((candidate) => (
    candidate.type === "one_to_many"
    && candidate.billIds.length === 2
    && candidate.billIds.includes("bill-match-a")
    && candidate.billIds.includes("bill-match-b")
  ));
  const confirmed = confirmReconciliationSuggestion(workspace, {
    transactionId: "txn-match-full",
    suggestionId: oneToMany.id,
    note: "用户确认两张账单归属",
  }, context);

  assert.equal(workspace.transactions[0].allocations.length, 0);
  assert.equal(confirmed.vouchers.length, 0);
  assert.equal(transactionSettlement(confirmed.transactions.find((item) => item.id === "txn-match-full")).status, "fully_reconciled");
  assert.equal(billSettlement(confirmed, "bill-match-a").remaining, 0);
  assert.equal(billSettlement(confirmed, "bill-match-b").remaining, 0);
  const allocations = confirmed.transactions.find((item) => item.id === "txn-match-full").allocations;
  assert.equal(allocations.length, 2);
  assert.ok(allocations.every((allocation) => allocation.status === "confirmed" && allocation.sourceIds.includes(allocation.billId)));

  const withVoucher = createVoucherDraft(confirmed, { transactionId: "txn-match-full" }, context);
  assert.equal(vouchersForSource(withVoucher, "bill-match-a").length, 1);
  assert.equal(vouchersForSource(withVoucher, "bill-match-b").length, 1);
  assert.ok(vouchersForSource(withVoucher, "txn-match-full")[0].sourceIds.includes(allocations[0].id));

  const repeatedWorkspace = automaticMatchingFixture();
  const manyToOne = suggestReconciliations(repeatedWorkspace, "txn-match-a", { limit: 50 }).find((candidate) => (
    candidate.type === "many_to_one"
    && candidate.billIds[0] === "bill-match-full"
    && candidate.transactionIds.length === 2
    && candidate.transactionIds.includes("txn-match-b")
  ));
  const repeatedConfirmed = confirmReconciliationSuggestion(repeatedWorkspace, {
    transactionId: "txn-match-a",
    suggestionId: manyToOne.id,
  }, context);
  assert.equal(billSettlement(repeatedConfirmed, "bill-match-full").status, "fully_reconciled");
  assert.equal(transactionSettlement(repeatedConfirmed.transactions.find((item) => item.id === "txn-match-a")).remaining, 0);
  assert.equal(transactionSettlement(repeatedConfirmed.transactions.find((item) => item.id === "txn-match-b")).remaining, 0);
});

test("low-confidence and unmatched bank differences remain exceptions and cannot be suggestion-confirmed", () => {
  const lowConfidenceWorkspace = automaticMatchingFixture();
  lowConfidenceWorkspace.transactions = [
    { ...lowConfidenceWorkspace.transactions[0], confidence: 40, classification: { ...lowConfidenceWorkspace.transactions[0].classification, confidence: 40 } },
  ];
  lowConfidenceWorkspace.bills = [lowConfidenceWorkspace.bills[0]];
  const lowCandidate = suggestReconciliations(lowConfidenceWorkspace, "txn-match-full")[0];
  assert.equal(lowCandidate.status, "exception");
  const lowRecorded = recordReconciliationSuggestions(lowConfidenceWorkspace, "txn-match-full", context);
  assert.equal(lowRecorded.transactions[0].status, "exception");
  assert.ok(lowRecorded.exceptionTasks.some((task) => task.code === "reconciliation_low_confidence" && task.status === "open"));
  assert.throws(() => confirmReconciliationSuggestion(lowRecorded, {
    transactionId: "txn-match-full",
    suggestionId: lowCandidate.id,
  }, context), (error) => error instanceof AccountingRuleError && error.code === "RECONCILIATION_REVIEW_REQUIRED");
  assert.equal(lowRecorded.transactions[0].allocations.length, 0);

  const differenceWorkspace = automaticMatchingFixture();
  differenceWorkspace.transactions = [differenceWorkspace.transactions[0]];
  differenceWorkspace.bills = [differenceWorkspace.bills[1]];
  const differenceCandidate = suggestReconciliations(differenceWorkspace, "txn-match-full")[0];
  assert.equal(differenceCandidate.difference, 400);
  assert.equal(differenceCandidate.status, "exception");
  const differenceRecorded = recordReconciliationSuggestions(differenceWorkspace, "txn-match-full", context);
  assert.ok(differenceRecorded.exceptionTasks.some((task) => task.code === "reconciliation_amount_difference" && task.status === "open"));
  assert.equal(differenceRecorded.transactions[0].allocations.length, 0);
});

test("S7 exception cases expose trigger, sources, missing content, match basis, treatments, and preserved history", async () => {
  let workspace = blankFixture();
  workspace = reviewTransactionEvidence(workspace, "txn-prepay", context);
  const exceptionCase = buildReconciliationExceptionCases(workspace, "txn-prepay")
    .find((item) => item.code === "missing_evidence");

  assert.ok(exceptionCase);
  assert.match(exceptionCase.triggerReason, /缺少/);
  assert.deepEqual(exceptionCase.relatedTransactions.map((item) => item.id), ["txn-prepay"]);
  assert.ok(exceptionCase.relatedBills.some((bill) => bill.id === "bill-prepay-1"));
  assert.ok(exceptionCase.relatedDocuments.some((document) => document.id === "doc-approval"));
  assert.ok(exceptionCase.missingContents.some((missing) => /采购单|合同/.test(missing.label)));
  assert.ok(exceptionCase.matchBasis.length > 0);
  assert.ok(exceptionCase.accountingTreatments.length > 0);
  assert.ok(exceptionCase.history.length > 0);

  workspace.transactions.find((transaction) => transaction.id === "txn-prepay").evidenceIds.push("doc-purchase");
  workspace = (await withVoucherEvidence(workspace)).workspace;
  workspace = handleReconciliationException(workspace, {
    exceptionId: exceptionCase.id,
    action: "recalculate",
    note: "已补充采购单并重新核对预付金额",
  }, { ...context, at: "2026-09-06T12:20:00.000Z" });
  const recalculatedTask = workspace.exceptionTasks.find((task) => task.id === exceptionCase.id);
  assert.equal(recalculatedTask.status, "ready_for_review");
  assert.equal(recalculatedTask.workflowState, "recalculated_ready_for_review");
  assert.equal(recalculatedTask.lastAction, "recalculate");
  assert.equal(recalculatedTask.history.at(-1).note, "已补充采购单并重新核对预付金额");
  assert.deepEqual(recalculatedTask.missingEvidence, []);
  assert.equal(workspace.transactions.find((transaction) => transaction.id === "txn-prepay").exceptionHistory.at(-1).action, "recalculate");
  assert.ok(workspace.auditLog.some((entry) => entry.action === "reconciliation.exception_recalculate"));
  assert.ok(buildReconciliationExceptionCases(workspace, "txn-prepay").some((item) => item.id === exceptionCase.id));
});

test("S7 defer and rematch actions keep unresolved matches blocked until a strong candidate exists", () => {
  let workspace = automaticMatchingFixture();
  workspace.transactions = [{
    ...workspace.transactions[0],
    confidence: 40,
    classification: { ...workspace.transactions[0].classification, confidence: 40 },
  }];
  workspace.bills = [workspace.bills[0]];
  workspace = recordReconciliationSuggestions(workspace, "txn-match-full", context);
  const exceptionId = workspace.exceptionTasks.find((task) => task.code === "reconciliation_low_confidence").id;

  workspace = handleReconciliationException(workspace, {
    exceptionId,
    action: "defer",
    note: "等待客户补充付款说明",
  }, { ...context, at: "2026-09-06T12:21:00.000Z" });
  assert.equal(workspace.exceptionTasks.find((task) => task.id === exceptionId).workflowState, "deferred");
  assert.equal(workspace.transactions[0].status, "exception");

  workspace = handleReconciliationException(workspace, {
    exceptionId,
    action: "rematch",
    note: "按当前资料重新匹配",
  }, { ...context, at: "2026-09-06T12:22:00.000Z" });
  assert.equal(workspace.exceptionTasks.find((task) => task.id === exceptionId).status, "open");
  assert.equal(workspace.exceptionTasks.find((task) => task.id === exceptionId).workflowState, "awaiting_verification");
  assert.equal(workspace.transactions[0].status, "exception");

  workspace.transactions[0].confidence = 98;
  workspace.transactions[0].classification.confidence = 98;
  workspace = handleReconciliationException(workspace, {
    exceptionId,
    action: "rematch",
    note: "交易对手资料已核对，重新形成强匹配",
  }, { ...context, at: "2026-09-06T12:23:00.000Z" });
  const rematchedTask = workspace.exceptionTasks.find((task) => task.id === exceptionId);
  assert.equal(rematchedTask.status, "resolved");
  assert.equal(rematchedTask.resolution, "returned_to_matching");
  assert.equal(rematchedTask.workflowState, "returned_to_matching");
  assert.equal(workspace.transactions[0].status, "suspected");
  assert.ok(workspace.transactions[0].matchSuggestions.some((suggestion) => !suggestion.requiresManualReview));
  assert.deepEqual(rematchedTask.history.filter((entry) => ["defer", "rematch"].includes(entry.action)).slice(-3).map((entry) => entry.action), ["defer", "rematch", "rematch"]);
});

test("S7 adopting an explicit treatment is the only action that confirms a low-confidence match for voucher preparation", () => {
  let workspace = automaticMatchingFixture();
  workspace.transactions = [{
    ...workspace.transactions[0],
    confidence: 40,
    classification: { ...workspace.transactions[0].classification, confidence: 40 },
  }];
  workspace.bills = [workspace.bills[0]];
  workspace = recordReconciliationSuggestions(workspace, "txn-match-full", context);
  const exceptionCase = buildReconciliationExceptionCases(workspace, "txn-match-full")
    .find((item) => item.code === "reconciliation_low_confidence");
  const treatment = exceptionCase.accountingTreatments.find((item) => item.kind === "reconciliation");
  assert.ok(treatment);

  workspace = handleReconciliationException(workspace, {
    exceptionId: exceptionCase.id,
    action: "adopt_treatment",
    treatmentId: treatment.id,
    note: "已逐项核对客户、金额、日期和账单余额，采用该核销",
  }, { ...context, at: "2026-09-06T12:24:00.000Z" });
  const task = workspace.exceptionTasks.find((item) => item.id === exceptionCase.id);
  assert.equal(task.status, "resolved");
  assert.equal(task.workflowState, "treatment_adopted");
  assert.equal(task.selectedTreatmentId, treatment.id);
  assert.equal(transactionSettlement(workspace.transactions[0]).status, "fully_reconciled");
  assert.equal(workspace.transactions[0].manualConfirmation.decision, "approve");
  assert.equal(workspace.transactions[0].allocations.length, 1);

  workspace = createVoucherDraft(workspace, { transactionId: "txn-match-full" }, context);
  assert.equal(workspace.vouchers.length, 1);

  let differenceWorkspace = automaticMatchingFixture();
  differenceWorkspace.transactions = [differenceWorkspace.transactions[0]];
  differenceWorkspace.bills = [differenceWorkspace.bills[1]];
  differenceWorkspace = recordReconciliationSuggestions(differenceWorkspace, "txn-match-full", context);
  const differenceCase = buildReconciliationExceptionCases(differenceWorkspace, "txn-match-full")
    .find((item) => item.code === "reconciliation_amount_difference");
  assert.equal(differenceCase.accountingTreatments.some((item) => item.kind === "reconciliation"), false);
  assert.equal(differenceWorkspace.transactions[0].allocations.length, 0);
});

test("deposit and prepayment balances stay outside ordinary ageing", () => {
  let workspace = blankFixture();
  workspace = applyReconciliation(workspace, {
    transactionId: "txn-deposit",
    allocations: [{ billId: "bill-deposit-1", amount: 2400 }],
  }, context);
  workspace = applyReconciliation(workspace, {
    transactionId: "txn-prepay",
    allocations: [{ billId: "bill-prepay-1", amount: 1800 }],
  }, { ...context, at: "2026-09-06T12:06:00.000Z" });

  const ageing = buildAgeingSchedule(workspace, { asOf: "2026-09-30" });
  assert.equal(ageing.rows.some((row) => row.billId === "bill-deposit-1" || row.billId === "bill-prepay-1"), false);
  assert.deepEqual(ageing.excludedKinds, ["depositReceived", "prepaymentPaid"]);
  const advances = buildAdvanceBalances(workspace);
  assert.equal(advances.depositsReceived, 2400);
  assert.equal(advances.prepaymentsPaid, 1800);
});

test("customer deposits can be manually applied in parts to later receivables with voucher-ready sources", () => {
  let workspace = blankFixture();
  workspace = applyReconciliation(workspace, {
    transactionId: "txn-deposit",
    allocations: [{ billId: "bill-deposit-1", amount: 2400 }],
  }, context);
  workspace.bills.push(
    { id: "bill-ar-deposit-a", no: "YS-202608-201", kind: "receivable", counterparty: "会员李女士", summary: "后续私教课账单 A", amount: 1000, date: "2026-08-25", dueDate: "2026-09-10", evidenceIds: [] },
    { id: "bill-ar-deposit-b", no: "YS-202609-201", kind: "receivable", counterparty: "会员李女士", summary: "后续私教课账单 B", amount: 1800, date: "2026-09-01", dueDate: "2026-09-30", evidenceIds: [] },
  );

  workspace = applyAdvanceToBill(workspace, {
    advanceBillId: "bill-deposit-1",
    targetBillId: "bill-ar-deposit-a",
    amount: 600,
    note: "第一次冲销",
  }, context);
  workspace = applyAdvanceToBill(workspace, {
    advanceBillId: "bill-deposit-1",
    targetBillId: "bill-ar-deposit-a",
    amount: 400,
    note: "第二次冲销",
  }, { ...context, at: "2026-09-06T12:05:00.000Z" });
  workspace = applyAdvanceToBill(workspace, {
    advanceBillId: "bill-deposit-1",
    targetBillId: "bill-ar-deposit-b",
    amount: 500,
    note: "第三次冲销",
  }, { ...context, at: "2026-09-06T12:10:00.000Z" });

  const balance = advanceBalance(workspace, "bill-deposit-1");
  assert.equal(balance.originalBalance, 2400);
  assert.equal(balance.usedAmount, 1500);
  assert.equal(balance.availableBalance, 900);
  assert.equal(billSettlement(workspace, "bill-ar-deposit-a").status, "fully_reconciled");
  assert.equal(billSettlement(workspace, "bill-ar-deposit-b").advanceApplied, 500);
  assert.equal(billSettlement(workspace, "bill-ar-deposit-b").remaining, 1300);
  assert.equal(advanceApplicationTargets(workspace, "bill-deposit-1").some((target) => target.billId === "bill-ar-deposit-a"), false);

  const applications = confirmedAdvanceApplications(workspace, { advanceBillId: "bill-deposit-1" });
  const fundingAllocation = workspace.transactions.find((transaction) => transaction.id === "txn-deposit").allocations[0];
  assert.equal(applications.length, 3);
  assert.equal(applications[0].accountingStatus, "unprocessed");
  assert.equal(applications[0].voucherId, null);
  assert.ok(applications[0].sourceIds.includes(fundingAllocation.id));
  assert.ok(applications[0].sourceIds.includes("txn-deposit"));
  assert.deepEqual(applications[0].voucherSource.lines.map((line) => [line.account, line.debit, line.credit]), [
    ["contractLiability", 600, 0],
    ["receivable", 0, 600],
  ]);
  assert.equal(workspace.vouchers.length, 0);

  const ageing = buildAgeingSchedule(workspace, { asOf: "2026-09-30", kind: "receivable" });
  assert.equal(ageing.rows.some((row) => row.billId === "bill-deposit-1"), false);
  assert.equal(ageing.rows.find((row) => row.billId === "bill-ar-deposit-b").balance, 1300);
  assert.equal(buildAdvanceBalances(workspace).depositsReceived, 900);
});

test("supplier prepayments settle later payables separately from monthly matching and require manual confirmation", () => {
  let workspace = blankFixture();
  workspace = applyReconciliation(workspace, {
    transactionId: "txn-prepay",
    allocations: [{ billId: "bill-prepay-1", amount: 1800 }],
  }, context);
  workspace.bills.push(
    { id: "bill-ap-prepay-a", no: "YF-202609-201", kind: "payable", counterparty: "场地出租方", summary: "9 月场地账单", amount: 1000, date: "2026-09-01", dueDate: "2026-09-10", evidenceIds: [] },
    { id: "bill-ap-prepay-b", no: "YF-202609-202", kind: "payable", counterparty: "场地出租方", summary: "9 月追加账单", amount: 1000, date: "2026-09-02", dueDate: "2026-09-15", evidenceIds: [] },
    { id: "bill-prepay-next", no: "YFK-202609-201", kind: "prepaymentPaid", counterparty: "场地出租方", summary: "10 月新增预付计划", amount: 500, date: "2026-09-03", dueDate: "2026-09-03", evidenceIds: [] },
  );

  workspace = applyAdvanceToBill(workspace, { advanceBillId: "bill-prepay-1", targetBillId: "bill-ap-prepay-a", amount: 400 }, context);
  workspace = applyAdvanceToBill(workspace, { advanceBillId: "bill-prepay-1", targetBillId: "bill-ap-prepay-a", amount: 600 }, { ...context, at: "2026-09-06T12:05:00.000Z" });
  workspace = applyAdvanceToBill(workspace, { advanceBillId: "bill-prepay-1", targetBillId: "bill-ap-prepay-b", amount: 500 }, { ...context, at: "2026-09-06T12:10:00.000Z" });

  const balance = advanceBalance(workspace, "bill-prepay-1");
  assert.equal(balance.originalBalance, 1800);
  assert.equal(balance.usedAmount, 1500);
  assert.equal(balance.availableBalance, 300);
  assert.equal(billSettlement(workspace, "bill-ap-prepay-a").remaining, 0);
  assert.equal(billSettlement(workspace, "bill-ap-prepay-b").remaining, 500);
  const application = confirmedAdvanceApplications(workspace, { advanceBillId: "bill-prepay-1" })[0];
  assert.deepEqual(application.voucherSource.lines.map((line) => [line.account, line.debit, line.credit]), [
    ["payable", 400, 0],
    ["prepayment", 0, 400],
  ]);

  workspace.transactions.push({
    id: "txn-monthly-supplier",
    accountId: "bank:operating",
    date: "2026-09-15",
    counterparty: "场地出租方",
    amount: -500,
    serial: "MATCH-MONTHLY-001",
    evidenceIds: [],
    allocations: [],
    status: "pending",
    classification: { eventType: "supplierSettlement", account: "payable", confidence: 98, reasons: ["月结付款"], riskFlags: [], candidateBillIds: [], requiresManualReview: false, source: "manual" },
  });
  const monthlySuggestions = suggestReconciliations(workspace, "txn-monthly-supplier", { limit: 50 });
  assert.ok(monthlySuggestions.length > 0);
  assert.ok(monthlySuggestions.every((candidate) => candidate.billIds.every((billId) => workspace.bills.find((bill) => bill.id === billId).kind === "payable")));
  assert.equal(monthlySuggestions.some((candidate) => candidate.billIds.includes("bill-prepay-next")), false);

  assert.throws(() => applyAdvanceToBill(workspace, {
    advanceBillId: "bill-prepay-1",
    targetBillId: "bill-ap-prepay-b",
    amount: 100,
  }, { ...context, mode: "automatic" }), (error) => error instanceof AccountingRuleError && error.code === "USER_CONFIRMATION_REQUIRED");
  const ageing = buildAgeingSchedule(workspace, { asOf: "2026-09-30", kind: "payable" });
  assert.equal(ageing.rows.some((row) => row.billId === "bill-prepay-1" || row.billId === "bill-prepay-next"), false);
  assert.equal(ageing.rows.find((row) => row.billId === "bill-ap-prepay-b").balance, 500);
  assert.equal(buildAdvanceBalances(workspace).prepaymentsPaid, 300);
});

test("reconciliation can be reversed and redone without deleting history", () => {
  let workspace = blankFixture();
  workspace = applyReconciliation(workspace, {
    transactionId: "txn-split",
    allocations: [
      { billId: "bill-ar-1", amount: 1000 },
      { billId: "bill-ar-2", amount: 500 },
    ],
  }, context);
  const originalAllocationId = workspace.transactions.find((item) => item.id === "txn-split").allocations[0].id;

  workspace = redoReconciliation(workspace, {
    allocationIds: [originalAllocationId],
    transactionId: "txn-split",
    allocations: [{ billId: "bill-ar-1", amount: 1000 }],
    reason: "复核后重做到账归属",
  }, { ...context, at: "2026-09-06T12:10:00.000Z" });

  const allocations = workspace.transactions.find((item) => item.id === "txn-split").allocations;
  assert.equal(allocations.find((item) => item.id === originalAllocationId).status, "reversed");
  assert.equal(allocations.filter((item) => item.status !== "reversed").length, 2);
  assert.equal(billSettlement(workspace, "bill-ar-1").remaining, 0);
  assert.ok(workspace.auditLog.some((item) => item.action === "reconciliation.reverse"));
  assert.equal(workspace.auditLog.at(-1).action, "reconciliation.redo");
});

test("application service commits correction and voucher together and preserves both when latest target balance changes", async () => {
  for (const race of [false, true]) {
    const original = await postedSplitReceiptFixture();
    const allocation = original.transactions.find((item) => item.id === "txn-split").allocations[0];
    const pending = createReconciliationCorrection(original, { allocationId: allocation.id, billId: "bill-deposit-1", reason: "更正到账归属" }, context);
    const fixture = await withVoucherEvidence(pending);
    fixture.workspace.users = [{ id: "service-accountant", name: "服务会计", roleId: "service-accountant-role", status: "active" }];
    fixture.workspace.roles = [...(fixture.workspace.roles || []), { id: "service-accountant-role", name: "入账会计", status: "active", permissions: ["data.read", "data.write", "documents.add"] }];
    fixture.workspace.localUsersConfigured = true;
    const repository = createLocalFoundationRepository({ storage: createMemoryStorage() });
    repository.save({ ...createInitialState(), workspaces: [fixture.workspace], activeWorkspaceId: fixture.workspace.id, activeUserId: "service-accountant" });
    const store = createFinanceDeskStore({ repository });
    const getOwned = fixture.fileVault.getOwned.bind(fixture.fileVault);
    let changed = false;
    fixture.fileVault.getOwned = async (...args) => {
      const record = await getOwned(...args);
      if (race && !changed) {
        changed = true;
        const latest = structuredClone(store.getActiveWorkspace());
        latest.transactions.push({ id: "concurrent-funding", date: `${latest.currentPeriod}-15`, amount: 2000, status: "pending",
          allocations: [{ id: "concurrent-allocation", billId: "bill-deposit-1", amount: 2000, status: "confirmed" }] });
        store.actions.replaceWorkspace(latest.id, latest);
      }
      return record;
    };
    const input = { workspaceId: fixture.workspace.id, period: fixture.workspace.currentPeriod, voucherId: pending.vouchers.at(-1).id, reviewNote: "已核对原核销和更正归属" };
    if (race) await assert.rejects(postWorkspaceVoucher({ store, fileVault: fixture.fileVault }, input), (error) => error.code === "BILL_OVER_ALLOCATED");
    else assert.equal((await postWorkspaceVoucher({ store, fileVault: fixture.fileVault }, input)).voucher.status, "posted");
    const latest = store.getActiveWorkspace();
    assert.equal(latest.transactions.find((item) => item.id === "txn-split").allocations[0].status, race ? "confirmed" : "reversed");
    assert.equal(latest.vouchers.find((voucher) => voucher.id === original.vouchers[0].id).status, race ? "posted" : "superseded");
    assert.equal(latest.vouchers.find((voucher) => voucher.id === input.voucherId).status, race ? "draft" : "posted");
  }
});

test("posted reconciliation correction replaces bill balances and the effective ledger together", async () => {
  let workspace = await postedSplitReceiptFixture();
  const original = structuredClone(workspace.vouchers[0]);
  const originalAllocation = structuredClone(workspace.transactions.find((item) => item.id === "txn-split").allocations[0]);
  const originalLedger = buildGeneralLedger(workspace, { period: "2026-08" });
  assert.throws(() => reverseReconciliation(workspace, {
    allocationId: originalAllocation.id, reason: "已入账核销不能单独撤销",
  }, context), (error) => error instanceof AccountingRuleError && error.code === "POSTED_RECONCILIATION_CORRECTION_REQUIRED");

  workspace = createReconciliationCorrection(workspace, {
    allocationId: originalAllocation.id,
    billId: "bill-deposit-1",
    reason: "其中 1000 元实际为预收款",
  }, context);
  const revision = workspace.vouchers.at(-1);
  assert.equal(revision.revisionOf, original.id);
  assert.equal(revision.reconciliationCorrection.status, "pending");
  assert.equal(billSettlement(workspace, "bill-ar-1").remaining, 0);
  assert.equal(billSettlement(workspace, "bill-deposit-1").remaining, 2400);
  assert.deepEqual(buildGeneralLedger(workspace, { period: "2026-08" }), originalLedger);

  workspace = await postWithFixtureEvidence(workspace, {
    voucherId: revision.id, mode: "manual", reviewNote: "已核对预收账单和原核销金额",
  }, { ...context, at: "2026-09-06T12:20:00.000Z" });
  const allocations = workspace.transactions.find((item) => item.id === "txn-split").allocations;
  const replacement = allocations.find((item) => item.correctionOf === originalAllocation.id);
  assert.equal(allocations.find((item) => item.id === originalAllocation.id).status, "reversed");
  assert.equal(replacement.billId, "bill-deposit-1");
  assert.equal(replacement.amount, 1000);
  assert.equal(replacement.voucherId, revision.id);
  assert.equal(allocations.filter((item) => item.status !== "reversed").length, 2);
  assert.equal(billSettlement(workspace, "bill-ar-1").remaining, 1000);
  assert.equal(billSettlement(workspace, "bill-ar-2").remaining, 500);
  assert.equal(billSettlement(workspace, "bill-deposit-1").remaining, 1400);

  const ledger = buildGeneralLedger(workspace, { period: "2026-08" });
  assert.equal(ledger.rows.find((row) => row.account === "bank:operating").debit, 1500);
  assert.equal(ledger.rows.find((row) => row.account === "receivable").credit, 500);
  assert.equal(ledger.rows.find((row) => row.account === "contractLiability").credit, 1000);
  assert.deepEqual(effectivePostedVouchers(workspace).map((voucher) => voucher.id), [revision.id]);
  const retainedOriginal = workspace.vouchers.find((voucher) => voucher.id === original.id);
  assert.equal(retainedOriginal.status, "superseded");
  assert.deepEqual(retainedOriginal.lines, original.lines);
  assert.deepEqual(retainedOriginal.reviews, original.reviews);
  assert.equal(workspace.vouchers.find((voucher) => voucher.id === revision.id).reconciliationCorrection.status, "committed");
  assert.ok(workspace.auditLog.some((entry) => entry.action === "reconciliation.correct" && entry.sourceIds.includes(revision.id)));
  await assert.rejects(() => postWithFixtureEvidence(workspace, {
    voucherId: revision.id, mode: "manual", reviewNote: "不能重复入账",
  }, context), (error) => error instanceof AccountingRuleError && error.code === "VOUCHER_NOT_POSTABLE");
  assert.throws(() => createVoucherDraft(workspace, {
    transactionId: "txn-split",
  }, context), (error) => error instanceof AccountingRuleError && error.code === "SOURCE_ALREADY_VOUCHERED");
});

test("reversing an unposted reconciliation invalidates stale drafts and replacement posts once", async () => {
  let workspace = applyReconciliation(blankFixture(), {
    transactionId: "txn-split",
    allocations: [{ billId: "bill-ar-1", amount: 1000 }, { billId: "bill-ar-2", amount: 500 }],
  }, context);
  workspace = createVoucherDraft(workspace, { transactionId: "txn-split" }, context);
  const staleDraft = structuredClone(workspace.vouchers[0]);
  const originalAllocationId = workspace.transactions.find((item) => item.id === "txn-split").allocations[0].id;
  workspace = reverseReconciliation(workspace, {
    allocationId: originalAllocationId, reason: "草稿复核发现账单选错",
  }, context);
  const invalidated = workspace.vouchers.find((voucher) => voucher.id === staleDraft.id);
  assert.equal(invalidated.status, "invalidated");
  assert.deepEqual(invalidated.lines, staleDraft.lines);
  assert.ok(invalidated.versions.length > staleDraft.versions.length);
  assert.throws(() => postVoucher(workspace, {
    voucherId: staleDraft.id, mode: "automatic",
  }, context), (error) => error instanceof AccountingRuleError && error.code === "VOUCHER_NOT_POSTABLE");
  assert.equal(effectivePostedVouchers(workspace).length, 0);

  workspace = applyReconciliation(workspace, {
    transactionId: "txn-split", allocations: [{ billId: "bill-deposit-1", amount: 1000 }],
  }, context);
  workspace = createVoucherDraft(workspace, { transactionId: "txn-split" }, context);
  const replacementId = workspace.vouchers.at(-1).id;
  assert.notEqual(replacementId, staleDraft.id);
  assert.equal(workspace.vouchers.at(-1).sourceIds.includes(originalAllocationId), false);
  workspace = await postWithFixtureEvidence(workspace, { voucherId: replacementId, mode: "automatic" }, context);
  assert.deepEqual(effectivePostedVouchers(workspace).map((voucher) => voucher.id), [replacementId]);
  const ledger = buildGeneralLedger(workspace, { period: "2026-08" });
  assert.equal(ledger.rows.find((row) => row.account === "bank:operating").debit, 1500);
  assert.equal(ledger.rows.find((row) => row.account === "receivable").credit, 500);
  assert.equal(ledger.rows.find((row) => row.account === "contractLiability").credit, 1000);
  assert.equal(billSettlement(workspace, "bill-ar-1").remaining, 1000);
  assert.equal(billSettlement(workspace, "bill-deposit-1").remaining, 1400);
  assert.equal(workspace.vouchers.find((voucher) => voucher.id === staleDraft.id).status, "invalidated");
  assert.throws(() => createVoucherDraft(workspace, { transactionId: "txn-split" }, context), (error) => error instanceof AccountingRuleError && error.code === "SOURCE_ALREADY_VOUCHERED");
});

test("blocked or cancelled reconciliation corrections preserve the original allocation and posting", async (t) => {
  const original = await postedSplitReceiptFixture();
  const allocationId = original.transactions.find((item) => item.id === "txn-split").allocations[0].id;
  const pending = createReconciliationCorrection(original, {
    allocationId, billId: "bill-deposit-1", reason: "修正款项归属",
  }, context);
  const revisionId = pending.vouchers.at(-1).id;
  for (const scenario of [
    { name: "target no longer has enough balance", code: "BILL_OVER_ALLOCATED", change: (workspace) => { workspace.bills.find((bill) => bill.id === "bill-deposit-1").amount = 999; } },
    { name: "original allocation changed", code: "CORRECTION_SOURCE_CHANGED", change: (workspace) => { workspace.transactions.find((item) => item.id === "txn-split").allocations[0].amount = 999; } },
    { name: "period was archived", code: "PERIOD_ARCHIVED", change: (workspace) => { workspace.delivery = { archives: [{ period: "2026-08" }] }; } },
    { name: "voucher belongs to a historical period", code: "HISTORICAL_PERIOD_IMMUTABLE", change: (workspace) => { workspace.currentPeriod = "2026-09"; } },
  ]) {
    await t.test(scenario.name, async () => {
      const workspace = structuredClone(pending);
      scenario.change(workspace);
      const before = structuredClone(workspace);
      await assert.rejects(() => postWithFixtureEvidence(workspace, {
        voucherId: revisionId, mode: "manual", reviewNote: "入账前重核当前来源和期间",
      }, context), (error) => error instanceof AccountingRuleError && error.code === scenario.code);
      assert.deepEqual(workspace, before);
      assert.deepEqual(effectivePostedVouchers(workspace).map((voucher) => voucher.id), [original.vouchers[0].id]);
      assert.deepEqual(buildGeneralLedger(workspace, { period: "2026-08" }), buildGeneralLedger(original, { period: "2026-08" }));
    });
  }
  const cancelled = cancelReconciliationCorrection(pending, {
    voucherId: revisionId, reason: "复核后保留原核销",
  }, context);
  assert.equal(cancelled.vouchers.find((voucher) => voucher.id === revisionId).status, "invalidated");
  assert.deepEqual(cancelled.transactions, original.transactions);
  assert.deepEqual(cancelled.vouchers.find((voucher) => voucher.id === original.vouchers[0].id), original.vouchers[0]);
});

test("refunds and internal transfers use dedicated traceable links", () => {
  let workspace = blankFixture();
  workspace = linkRefundToOriginal(workspace, {
    refundTransactionId: "txn-refund",
    originalSourceId: "txn-deposit",
    amount: 600,
    reason: "核对原充值后退款",
  }, context);
  assert.equal(workspace.transactions.find((item) => item.id === "txn-refund").status, "reconciled");
  assert.equal(workspace.auditLog.at(-1).action, "reconciliation.refund_link");

  workspace = linkInternalTransfer(workspace, {
    outgoingTransactionId: "txn-transfer-out",
    incomingTransactionId: "txn-transfer-in",
  }, { ...context, at: "2026-09-06T12:15:00.000Z" });
  assert.equal(workspace.transactions.find((item) => item.id === "txn-transfer-out").internalTransferLink.amount, 2000);
  assert.equal(workspace.transactions.find((item) => item.id === "txn-transfer-in").status, "reconciled");
  assert.equal(workspace.auditLog.at(-1).action, "reconciliation.internal_transfer");

  assert.throws(() => linkInternalTransfer(workspace, {
    outgoingTransactionId: "txn-transfer-out",
    incomingTransactionId: "txn-transfer-in",
  }, context), (error) => error instanceof AccountingRuleError && error.code === "TRANSFER_ALREADY_LINKED");

  workspace.transactions.push({
    ...workspace.transactions.find((item) => item.id === "txn-refund"),
    id: "txn-refund-second",
    amount: -2000,
    serial: "BANK-REFUND-SECOND",
    refundLinks: [],
  });
  assert.throws(() => linkRefundToOriginal(workspace, {
    refundTransactionId: "txn-refund-second",
    originalSourceId: "txn-deposit",
    amount: 2000,
    reason: "第二笔退款超过原收款剩余额度",
  }, context), (error) => error instanceof AccountingRuleError && error.code === "ORIGINAL_SOURCE_OVER_REFUNDED");
});

test("over-allocation is rejected before changing the caller state", () => {
  const workspace = blankFixture();
  assert.throws(() => applyReconciliation(workspace, {
    transactionId: "txn-split",
    allocations: [{ billId: "bill-ar-1", amount: 1500 }],
  }, context), (error) => error instanceof AccountingRuleError && error.code === "BILL_OVER_ALLOCATED");
  assert.equal(workspace.transactions.find((item) => item.id === "txn-split").allocations.length, 0);
  assert.equal(workspace.auditLog.length, 1);
});
