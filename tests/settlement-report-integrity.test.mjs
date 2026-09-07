import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { createBlankWorkspace } from "../src/domain/foundation.js";
import { confirmOpeningBalances } from "../src/domain/periods.js";
import { upsertWorkspaceAccount } from "../src/domain/accounting/model.js";
import { buildCashFlowStatement, buildFinancialStatements, buildFrozenReportExcelWorkbook, buildReceivablePayableAgeing, freezeReportVersion as freezeDomainReport } from "../src/domain/accounting/reporting.js";
import { confirmCashFlowClassification } from "../src/domain/accounting/cashFlowClassification.js";
import { buildAgeingSchedule, createSettlementBill } from "../src/features/reconciliation/reconciliationEngine.js";
import { assertSettlementRecognition, buildBillRecognitionOptions, buildSettlementLedgerCheck, buildSettlementRecognition, buildSettlementRecognitionDraft, linkBillRecognitionVoucher } from "../src/features/reconciliation/settlementRecognition.js";
import { buildReportSnapshot, workflowSourceFingerprint } from "../src/productWorkflow.js";

const context = { actor: "测试会计", at: "2026-09-07T08:00:00.000Z", mode: "manual" };
function workspaceFixture() {
  return confirmOpeningBalances(createBlankWorkspace({ id: "settlement-integrity", name: "往来报表测试", currentPeriod: "2026-09" }, { timestamp: context.at }), { bank: 10000, equity: -10000 }, context.actor);
}
function bill(id, kind = "receivable", amount = 1000, date = "2026-09-01", extra = {}) {
  return { id, no: id, kind, amount, date, dueDate: "2026-09-30", counterparty: id, status: "active", ...extra };
}
function voucher(id, lines, date = "2026-09-05") {
  return { id, no: id, date, period: date.slice(0, 7), status: "posted", summary: id, sourceIds: [], lines };
}
function line(account, debit, credit, billId) { return { account, debit, credit, sourceIds: billId ? [billId] : [] }; }

test("bill creation leaves income untouched and settlement requires actual confirmation", () => {
  let workspace = createSettlementBill(workspaceFixture(), { kind: "receivable", counterparty: "客户甲", amount: 1000, date: "2026-09-01", dueDate: "2026-09-20" }, context);
  const id = workspace.bills[0].id;
  const receipt = voucher("receipt", [line("bank", 1000, 0), line("receivable", 0, 1000, id)]);
  assert.equal(workspace.vouchers.length, 0);
  assert.equal(buildFinancialStatements(workspace).incomeStatement.netRevenue.value, 0);
  assert.throws(() => assertSettlementRecognition(workspace, receipt), (error) => error.code === "SETTLEMENT_RECOGNITION_REQUIRED");
  const draft = buildSettlementRecognitionDraft(workspace, id);
  assert.equal(draft.lines[0].account, "receivable");
  assert.equal(draft.lines[1].account, "");
  workspace.vouchers.push(voucher("recognition", [line("receivable", 1000, 0, id), line("revenuePrivate", 0, 1000, id)], "2026-09-01"));
  assert.equal(assertSettlementRecognition(workspace, receipt).passed, true);
  workspace.vouchers.push(receipt);
  workspace.transactions.push({ id: "receipt-source", date: receipt.date, amount: 1000, allocations: [{ id: "allocation", billId: id, amount: 1000, status: "posted" }] });
  assert.equal(buildSettlementLedgerCheck(workspace).passed, true);
  assert.equal(buildFinancialStatements(workspace).incomeStatement.netRevenue.value, 1000);
});

test("payables may confirm equipment without expensing it; advances never trigger ordinary bill confirmation", () => {
  const workspace = workspaceFixture();
  workspace.bills = [bill("equipment", "payable"), bill("deposit", "depositReceived")];
  const payment = voucher("payment", [line("payable", 1000, 0, "equipment"), line("bank", 0, 1000)]);
  assert.throws(() => assertSettlementRecognition(workspace, payment), /待核对/);
  workspace.vouchers = [voucher("capitalise", [line("equipment", 1000, 0, "equipment"), line("payable", 0, 1000, "equipment")], "2026-09-01")];
  assert.equal(assertSettlementRecognition(workspace, payment).passed, true);
  assert.equal(buildFinancialStatements(workspace).incomeStatement.expenses.value, 0);
  assert.equal(assertSettlementRecognition(workspace, voucher("advance", [line("bank", 1000, 0), line("contractLiability", 0, 1000, "deposit")])).applicable, false);
});

test("a confirmed opening is a finite shared allowance and pending openings cannot cover settlement", () => {
  const workspace = workspaceFixture();
  workspace.openingLedger = { receivable: 1000, equity: -1000 };
  workspace.bills = [bill("prior-a", "receivable", 600, "2026-08-01"), bill("prior-b", "receivable", 600, "2026-08-02")];
  const recognition = buildSettlementRecognition(workspace);
  assert.equal(recognition.rows.reduce((sum, row) => sum + row.openingAmount, 0), 1000);
  assert.equal(recognition.rows[1].availableAmount, 400);
  assert.throws(() => assertSettlementRecognition(workspace, voucher("collect-b", [line("bank", 600, 0), line("receivable", 0, 600, "prior-b")])), /200\.00/);
  workspace.openingStatus = { status: "pending" };
  assert.equal(buildSettlementRecognition(workspace).rows[0].openingAmount, 0);
});

test("existing manual confirmation can be linked by exact line and amount without rewriting posted entries", () => {
  let workspace = workspaceFixture();
  workspace.bills = [bill("a", "receivable", 600), bill("b", "receivable", 500)];
  workspace.vouchers = [voucher("original", [line("receivable", 1000, 0), line("revenuePrivate", 0, 1000)], "2026-09-01")];
  const original = structuredClone(workspace.vouchers);
  assert.equal(buildBillRecognitionOptions(workspace, "a")[0].availableAmount, 1000);
  workspace = linkBillRecognitionVoucher(workspace, { billId: "a", voucherId: "original", lineIndex: 0, amount: 600 }, context);
  assert.equal(buildBillRecognitionOptions(workspace, "b")[0].availableAmount, 400);
  assert.throws(() => linkBillRecognitionVoucher(workspace, { billId: "b", voucherId: "original", lineIndex: 0, amount: 500 }, context), /额度/);
  assert.deepEqual(workspace.vouchers, original);
  assert.equal(buildSettlementRecognition(workspace).rows.find((row) => row.billId === "a").recognizedAmount, 600);
});

test("ageing excludes future and invalid bills, retains old and not-due balances, and respects historical settlement dates", () => {
  const workspace = workspaceFixture();
  workspace.bills = [bill("old", "receivable", 1000, "2026-08-01"), bill("not-due", "payable", 500, "2026-09-01", { dueDate: "2026-10-31" }), bill("future", "receivable", 700, "2026-10-01"), ...["inactive", "voided", "cancelled", "invalidated"].map((status) => bill(status, "receivable", 900, "2026-09-01", { status }))];
  workspace.transactions = [
    { id: "before", date: "2026-09-10", amount: 100, status: "pending", allocations: [{ id: "before-allocation", billId: "old", amount: 100, status: "confirmed" }] },
    { id: "after", date: "2026-10-01", amount: 200, allocations: [{ id: "after-allocation", billId: "old", amount: 200, status: "posted" }] },
    { id: "unconfirmed", date: "2026-09-02", amount: 200, allocations: ["pending", "invalidated", "voided", "rejected", "suspected"].map((status) => ({ id: status, billId: "old", amount: 20, status })) },
  ];
  workspace.advanceApplications = [
    { id: "before-advance", targetBillId: "old", advanceBillId: "deposit", date: "2026-09-15", amount: 200, status: "confirmed" },
    { id: "after-advance", targetBillId: "old", advanceBillId: "deposit", date: "2026-10-01", amount: 200, status: "posted" },
    { id: "pending-advance", targetBillId: "old", advanceBillId: "deposit", date: "2026-09-01", amount: 400, status: "pending" },
  ];
  const ageing = buildAgeingSchedule(workspace, { asOf: "2026-09-30" });
  assert.deepEqual(ageing.rows.map((row) => row.billId), ["old", "not-due"]);
  assert.equal(ageing.rows[0].balance, 700);
  assert.equal(ageing.rows[1].bucket, "notDue");
  assert.ok(ageing.rows[0].sourceIds.includes("before-advance"));
  assert.equal(buildReceivablePayableAgeing(workspace, { asOf: "2026-09-30" }).receivable.value, 700);
});

test("reversals after a historical cutoff retain the settlement then and unconfirmed records never consume opening coverage", () => {
  const workspace = workspaceFixture();
  workspace.bills = [bill("old", "receivable", 1000, "2026-08-01")];
  workspace.transactions = [{ id: "settled", date: "2026-08-20", allocations: [{ id: "reversed", billId: "old", amount: 200, status: "reversed", reversedAt: "2026-10-02T00:00:00.000Z" }, { id: "pending", billId: "old", amount: 400, status: "pending" }] }];
  workspace.openingLedger = { receivable: 800, equity: -800 };
  assert.equal(buildAgeingSchedule(workspace, { asOf: "2026-09-30" }).total, 800);
  assert.equal(buildAgeingSchedule(workspace, { asOf: "2026-10-31" }).total, 1000);
  assert.equal(buildSettlementRecognition(workspace).rows[0].unrecognizedAmount, 0);
});

test("inventory, equipment, loans and configured custom accounts keep account nature and correct cash-flow categories", () => {
  let workspace = workspaceFixture();
  workspace = upsertWorkspaceAccount(workspace, { id: "fixed-custom", name: "自定义设备", category: "asset", normalSide: "debit", cash: false, cashFlowCategory: "investing" }, context);
  workspace.vouchers = [voucher("inventory", [line("inventory", 300, 0), line("bank", 0, 300)]), voucher("equipment", [line("equipment", 700, 0), line("bank", 0, 700)]), voucher("loan", [line("bank", 2000, 0), line("loan", 0, 2000)]), voucher("custom", [line("fixed-custom", 400, 0), line("bank", 0, 400)])];
  const flow = buildCashFlowStatement(workspace);
  assert.deepEqual([flow.operating.value, flow.investing.value, flow.financing.value, flow.netChange.value], [-300, -1100, 2000, 600]);
  assert.equal(workspace.chartOfAccounts.find((account) => account.id === "fixed-custom").category, "asset");
  assert.equal(flow.classificationComplete, true);
});

test("equipment paid through payables follows its original confirmation and full mixed payments split by exact costs", () => {
  const workspace = workspaceFixture();
  workspace.bills = [bill("mixed", "payable")];
  workspace.vouchers = [voucher("purchase", [line("equipment", 700, 0, "mixed"), line("inventory", 300, 0, "mixed"), line("payable", 0, 1000, "mixed")], "2026-09-01"), voucher("payment", [line("payable", 1000, 0, "mixed"), line("bank", 0, 1000)])];
  const flow = buildCashFlowStatement(workspace);
  assert.deepEqual([flow.operating.value, flow.investing.value, flow.netChange.value], [-300, -700, -1000]);
  assert.ok(flow.investing.sourceIds.includes("purchase"));
  workspace.vouchers[1].lines = [line("payable", 500, 0, "mixed"), line("bank", 0, 500)];
  assert.equal(buildCashFlowStatement(workspace).pending.value, -500);
});

test("cash receipts and payments in one voucher keep their separate categories even when net cash is zero", () => {
  const workspace = workspaceFixture();
  workspace.vouchers = [voucher("borrow-and-pay", [line("bank", 1000, 0), line("loan", 0, 1000), line("expenseOther", 1000, 0), line("bank", 0, 1000)])];
  const flow = buildCashFlowStatement(workspace);
  assert.deepEqual([flow.operating.value, flow.financing.value, flow.netChange.value], [-1000, 1000, 0]);
  assert.equal(flow.classificationComplete, true);
});

test("unknown cash-flow purposes preserve cash totals and can be explicitly resolved without changing posted vouchers", () => {
  let workspace = workspaceFixture();
  workspace.vouchers = [voucher("unknown", [line("asset-custom", 1000, 0), line("bank", 0, 1000)])];
  const original = structuredClone(workspace.vouchers);
  assert.equal(buildCashFlowStatement(workspace).pending.value, -1000);
  assert.equal(buildCashFlowStatement(workspace).closingCash.value, 9000);
  assert.throws(() => freezeDomainReport(workspace, {}, context), (error) => error.code === "REPORT_CHECK_FAILED");
  assert.throws(() => confirmCashFlowClassification(workspace, { voucherId: "unknown", rows: [{ category: "investing", amount: -900 }], note: "设备" }, context), /合计/);
  workspace = confirmCashFlowClassification(workspace, { voucherId: "unknown", rows: [{ category: "investing", amount: -700 }, { category: "operating", amount: -300 }], note: "700设备，300库存" }, context);
  assert.deepEqual(workspace.vouchers, original);
  const flow = buildCashFlowStatement(JSON.parse(JSON.stringify(workspace)));
  assert.equal(flow.classificationComplete, true);
  assert.equal(flow.operating.value + flow.investing.value + flow.financing.value, flow.netChange.value);
});

test("future instalments do not block current settlement checks and custom receivable accounts can be declared", () => {
  let workspace = workspaceFixture();
  workspace.bills = [bill("future", "receivable", 1000, "2026-10-01")];
  assert.equal(buildSettlementLedgerCheck(workspace).passed, true);
  workspace = upsertWorkspaceAccount(workspace, { id: "ar-custom", name: "客户应收", category: "asset", normalSide: "debit", cash: false, settlementRole: "receivable" }, context);
  workspace.bills.push(bill("present"));
  workspace.vouchers.push(voucher("custom-recognition", [line("ar-custom", 1000, 0, "present"), line("revenuePrivate", 0, 1000, "present")], "2026-09-01"));
  assert.equal(buildSettlementLedgerCheck(workspace).passed, true);
});

test("classification changes invalidate only the relevant period and frozen Excel shares all three net amounts", () => {
  let workspace = workspaceFixture();
  workspace.vouchers = [voucher("current", [line("equipment", 1000, 0), line("bank", 0, 1000)]), voucher("other-month", [line("equipment", 50, 0), line("bank", 0, 50)], "2026-08-15")];
  const before = workflowSourceFingerprint(workspace);
  workspace.cashFlowClassifications = { "other-month": { rows: [{ category: "operating", amount: -50 }], note: "8月用途" } };
  assert.equal(workflowSourceFingerprint(workspace), before);
  workspace = confirmCashFlowClassification(workspace, { voucherId: "current", rows: [{ category: "investing", amount: -1000 }], note: "购置设备" }, context);
  const fingerprint = workflowSourceFingerprint(workspace);
  assert.notEqual(fingerprint, before);
  const version = { id: "version", period: workspace.currentPeriod, label: "V1", frozen: true, sourceFingerprint: fingerprint, snapshot: buildReportSnapshot(workspace) };
  workspace.delivery.reportVersions = [version];
  const restored = JSON.parse(JSON.stringify(workspace));
  const flow = buildCashFlowStatement(restored);
  const { workbook } = buildFrozenReportExcelWorkbook(restored, { reportVersion: restored.delivery.reportVersions[0], currentSourceFingerprint: workflowSourceFingerprint(restored) });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets["现金流量表"], { header: 1, defval: "" });
  for (const [label, value] of [["经营活动现金流量净额", flow.operating.value], ["投资活动现金流量净额", flow.investing.value], ["筹资活动现金流量净额", flow.financing.value]]) assert.equal(rows.find((row) => row[0] === label)[1], value);
});
