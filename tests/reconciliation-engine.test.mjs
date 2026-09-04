import assert from "node:assert/strict";
import test from "node:test";

import { createAccountingFixture } from "../src/domain/accounting/fixtures.js";
import { AccountingRuleError } from "../src/domain/accounting/model.js";
import { createVoucherDraft, vouchersForSource } from "../src/domain/accounting/vouchers.js";
import {
  createFinanceDeskStore,
  createInitialState,
  createLocalFoundationRepository,
  createMemoryStorage,
} from "../src/foundation.js";
import {
  applyReconciliation,
  billSettlement,
  buildAdvanceBalances,
  buildAgeingSchedule,
  createSettlementBill,
  linkInternalTransfer,
  linkRefundToOriginal,
  recordReconciliationSuggestions,
  redoReconciliation,
  suggestReconciliations,
  transactionSettlement,
} from "../src/features/reconciliation/reconciliationEngine.js";

const context = { actor: "测试会计", at: "2026-09-06T12:00:00.000Z", mode: "manual" };

function blankFixture() {
  return createAccountingFixture({ withReconciliations: false, withPostedVouchers: false });
}

test("new receivables persist with split and repeated payments and remain in voucher sources", () => {
  const fixedNow = () => new Date("2026-09-06T12:00:00.000Z");
  const repository = createLocalFoundationRepository({ storage: createMemoryStorage(), now: fixedNow });
  repository.save(createInitialState({ now: fixedNow }));
  const store = createFinanceDeskStore({ repository });
  const workspaceId = store.getActiveWorkspace().id;
  let workspace = store.getActiveWorkspace();
  workspace = {
    ...workspace,
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
