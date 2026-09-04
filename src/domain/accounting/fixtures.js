import { EVENT_TYPES } from "./model.js";

const FIXTURE_NOW = "2026-09-06T10:00:00.000Z";

function allocation(id, billId, amount, transactionId, at = FIXTURE_NOW) {
  return {
    id,
    billId,
    transactionId,
    amount,
    status: "confirmed",
    createdAt: at,
    createdBy: "样板会计",
    mode: "manual",
  };
}

export function createAccountingFixture({ withReconciliations = true, withPostedVouchers = true } = {}) {
  const documents = [
    { id: "doc-bank", name: "招商银行流水.csv", type: "银行流水", period: "2026-08" },
    { id: "doc-settlement", name: "平台结算单.pdf", type: "平台结算单", period: "2026-08" },
    { id: "doc-member-contract", name: "会员课包协议.pdf", type: "会员协议", period: "2026-08" },
    { id: "doc-purchase", name: "供应商采购单.pdf", type: "采购单", period: "2026-08" },
    { id: "doc-invoice", name: "供应商发票.pdf", type: "发票", period: "2026-08" },
    { id: "doc-approval", name: "付款审批.pdf", type: "审批记录", period: "2026-08" },
    { id: "doc-refund", name: "会员退款申请.pdf", type: "退款申请", period: "2026-08" },
    { id: "doc-transfer", name: "内部转账回单.pdf", type: "内部转账回单", period: "2026-08" },
    { id: "doc-payroll", name: "8月工资表.xlsx", type: "工资表", period: "2026-08" },
    { id: "doc-social", name: "8月社保表.xlsx", type: "社保表", period: "2026-08" },
  ];

  const bills = [
    { id: "bill-ar-1", no: "YS-202607-001", kind: "receivable", counterparty: "橙子平台", summary: "7月课程结算", amount: 1000, date: "2026-07-20", dueDate: "2026-07-31", evidenceIds: ["doc-settlement"] },
    { id: "bill-ar-2", no: "YS-202608-001", kind: "receivable", counterparty: "橙子平台", summary: "8月课程结算", amount: 1000, date: "2026-08-10", dueDate: "2026-08-31", evidenceIds: ["doc-settlement"] },
    { id: "bill-ar-3", no: "YS-202608-002", kind: "receivable", counterparty: "青禾科技", summary: "企业团课", amount: 1200, date: "2026-08-25", dueDate: "2026-09-10", evidenceIds: ["doc-settlement"] },
    { id: "bill-ap-1", no: "YF-202608-001", kind: "payable", counterparty: "力行器械", summary: "训练器材", amount: 900, date: "2026-08-01", dueDate: "2026-08-20", evidenceIds: ["doc-purchase", "doc-invoice", "doc-approval"] },
    { id: "bill-deposit-1", no: "YS-202608-101", kind: "depositReceived", counterparty: "会员李女士", summary: "20节私教课预收", amount: 2400, date: "2026-08-18", dueDate: "2026-08-18", evidenceIds: ["doc-member-contract"] },
    { id: "bill-prepay-1", no: "YF-202608-101", kind: "prepaymentPaid", counterparty: "场地出租方", summary: "9月租金预付", amount: 1800, date: "2026-08-22", dueDate: "2026-08-22", evidenceIds: ["doc-approval"] },
  ];

  const transactions = [
    { id: "txn-split", accountId: "bank:operating", date: "2026-08-15", counterparty: "橙子平台商户", summary: "7月及8月课程结算款", amount: 1500, serial: "BANK-001", confidence: 97, evidenceIds: ["doc-settlement"], allocations: withReconciliations ? [allocation("allocation-0001", "bill-ar-1", 1000, "txn-split"), allocation("allocation-0002", "bill-ar-2", 500, "txn-split")] : [] },
    { id: "txn-followup", accountId: "bank:operating", date: "2026-09-05", businessPeriod: "2026-08", counterparty: "橙子平台商户", summary: "8月课程结算补款", amount: 500, serial: "BANK-002", confidence: 98, evidenceIds: ["doc-settlement"], allocations: withReconciliations ? [allocation("allocation-0003", "bill-ar-2", 500, "txn-followup")] : [] },
    { id: "txn-partial", accountId: "bank:operating", date: "2026-08-28", counterparty: "青禾科技", summary: "企业团课提前部分回款", amount: 300, serial: "BANK-003", confidence: 94, evidenceIds: ["doc-settlement"], allocations: withReconciliations ? [allocation("allocation-0004", "bill-ar-3", 300, "txn-partial")] : [] },
    { id: "txn-deposit", accountId: "bank:operating", date: "2026-08-18", counterparty: "会员李女士", summary: "私教课充值预收", amount: 2400, serial: "BANK-004", confidence: 98, evidenceIds: ["doc-member-contract"], allocations: withReconciliations ? [allocation("allocation-0005", "bill-deposit-1", 2400, "txn-deposit")] : [] },
    { id: "txn-payable", accountId: "bank:operating", date: "2026-08-20", counterparty: "力行器械", summary: "器材采购付款", amount: -900, serial: "BANK-005", confidence: 96, evidenceIds: ["doc-purchase", "doc-invoice", "doc-approval"], allocations: withReconciliations ? [allocation("allocation-0006", "bill-ap-1", 900, "txn-payable")] : [] },
    { id: "txn-prepay", accountId: "bank:operating", date: "2026-08-22", counterparty: "场地出租方", summary: "9月租金预付", amount: -1800, serial: "BANK-006", confidence: 95, evidenceIds: ["doc-approval"], allocations: withReconciliations ? [allocation("allocation-0007", "bill-prepay-1", 1800, "txn-prepay")] : [] },
    { id: "txn-refund", accountId: "bank:operating", date: "2026-08-26", counterparty: "会员赵女士", summary: "会员剩余课时退款", amount: -600, serial: "BANK-007", confidence: 92, evidenceIds: ["doc-refund"], allocations: [], classification: { eventType: EVENT_TYPES.REFUND, account: "salesReturns", direction: "out", confidence: 92, reasons: ["退款申请可对应原业务"], riskFlags: [], candidateBillIds: [], counterpartAccountId: null, requiresManualReview: false, source: "local-rules" } },
    { id: "txn-transfer-out", accountId: "bank:operating", counterpartAccountId: "bank:reserve", counterpartTransactionId: "txn-transfer-in", date: "2026-08-30", counterparty: "本企业备用账户", summary: "内部账户划转", amount: -2000, serial: "BANK-008", confidence: 99, evidenceIds: ["doc-transfer"], allocations: [] },
    { id: "txn-transfer-in", accountId: "bank:reserve", counterpartAccountId: "bank:operating", counterpartTransactionId: "txn-transfer-out", date: "2026-08-30", counterparty: "本企业经营账户", summary: "内部账户划转", amount: 2000, serial: "BANK-009", confidence: 99, evidenceIds: ["doc-transfer"], allocations: [] },
    { id: "txn-low", accountId: "bank:operating", date: "2026-08-09", counterparty: "个人转账", summary: "转账", amount: 388, serial: "BANK-010", confidence: 32, evidenceIds: [], allocations: [] },
    { id: "txn-fee", accountId: "bank:operating", date: "2026-08-31", counterparty: "银行手续费", summary: "账户管理手续费", amount: -20, serial: "BANK-011", confidence: 99, evidenceIds: [], allocations: [], directAccount: "expenseFee" },
  ];

  const vouchers = withPostedVouchers ? [
    { id: "voucher-0001", no: "记-001", date: "2026-08-10", summary: "确认橙子平台课程收入", status: "posted", version: 1, sourceIds: ["bill-ar-1", "bill-ar-2"], evidenceIds: ["doc-settlement"], lines: [{ account: "receivable", debit: 2000, credit: 0, sourceIds: ["bill-ar-1", "bill-ar-2"] }, { account: "revenueGroup", debit: 0, credit: 2000, sourceIds: ["bill-ar-1", "bill-ar-2"] }] },
    { id: "voucher-0002", no: "记-002", date: "2026-08-25", summary: "确认青禾企业团课收入", status: "posted", version: 1, sourceIds: ["bill-ar-3"], evidenceIds: ["doc-settlement"], lines: [{ account: "receivable", debit: 1200, credit: 0, sourceIds: ["bill-ar-3"] }, { account: "revenueGroup", debit: 0, credit: 1200, sourceIds: ["bill-ar-3"] }] },
    { id: "voucher-0003", no: "记-003", date: "2026-08-15", summary: "收到平台结算款", status: "posted", version: 1, sourceIds: ["txn-split", "allocation-0001", "allocation-0002"], evidenceIds: ["doc-settlement"], lines: [{ account: "bank:operating", debit: 1500, credit: 0, sourceIds: ["txn-split"] }, { account: "receivable", debit: 0, credit: 1500, sourceIds: ["bill-ar-1", "bill-ar-2"] }] },
    { id: "voucher-0004", no: "记-004", date: "2026-08-28", summary: "收到企业团课部分回款", status: "posted", version: 1, sourceIds: ["txn-partial", "allocation-0004"], evidenceIds: ["doc-settlement"], lines: [{ account: "bank:operating", debit: 300, credit: 0, sourceIds: ["txn-partial"] }, { account: "receivable", debit: 0, credit: 300, sourceIds: ["bill-ar-3"] }] },
    { id: "voucher-0005", no: "记-005", date: "2026-08-18", summary: "收到会员课包预收款", status: "posted", version: 1, sourceIds: ["txn-deposit", "allocation-0005"], evidenceIds: ["doc-member-contract"], lines: [{ account: "bank:operating", debit: 2400, credit: 0, sourceIds: ["txn-deposit"] }, { account: "contractLiability", debit: 0, credit: 2400, sourceIds: ["bill-deposit-1"] }] },
    { id: "voucher-0006", no: "记-006", date: "2026-08-01", summary: "确认训练器材采购", status: "posted", version: 1, sourceIds: ["bill-ap-1"], evidenceIds: ["doc-purchase", "doc-invoice"], lines: [{ account: "equipment", debit: 900, credit: 0, sourceIds: ["bill-ap-1"] }, { account: "payable", debit: 0, credit: 900, sourceIds: ["bill-ap-1"] }] },
    { id: "voucher-0007", no: "记-007", date: "2026-08-20", summary: "支付器材采购款", status: "posted", version: 1, sourceIds: ["txn-payable", "allocation-0006"], evidenceIds: ["doc-purchase", "doc-invoice", "doc-approval"], lines: [{ account: "payable", debit: 900, credit: 0, sourceIds: ["bill-ap-1"] }, { account: "bank:operating", debit: 0, credit: 900, sourceIds: ["txn-payable"] }] },
    { id: "voucher-0008", no: "记-008", date: "2026-08-22", summary: "预付9月场地租金", status: "posted", version: 1, sourceIds: ["txn-prepay", "allocation-0007"], evidenceIds: ["doc-approval"], lines: [{ account: "prepayment", debit: 1800, credit: 0, sourceIds: ["bill-prepay-1"] }, { account: "bank:operating", debit: 0, credit: 1800, sourceIds: ["txn-prepay"] }] },
    { id: "voucher-0009", no: "记-009", date: "2026-08-26", summary: "支付会员退款", status: "posted", version: 1, sourceIds: ["txn-refund"], evidenceIds: ["doc-refund"], lines: [{ account: "salesReturns", debit: 600, credit: 0, sourceIds: ["txn-refund"] }, { account: "bank:operating", debit: 0, credit: 600, sourceIds: ["txn-refund"] }] },
    { id: "voucher-0010", no: "记-010", date: "2026-08-30", summary: "经营账户划转备用账户", status: "posted", version: 1, sourceIds: ["txn-transfer-out", "txn-transfer-in"], evidenceIds: ["doc-transfer"], lines: [{ account: "bank:reserve", debit: 2000, credit: 0, sourceIds: ["txn-transfer-in"] }, { account: "bank:operating", debit: 0, credit: 2000, sourceIds: ["txn-transfer-out"] }] },
    { id: "voucher-0011", no: "记-011", date: "2026-08-31", summary: "支付银行手续费", status: "posted", version: 1, sourceIds: ["txn-fee"], evidenceIds: [], lines: [{ account: "expenseFee", debit: 20, credit: 0, sourceIds: ["txn-fee"] }, { account: "bank:operating", debit: 0, credit: 20, sourceIds: ["txn-fee"] }] },
  ] : [];

  return {
    id: "workspace-accounting-fixture",
    name: "山岚健身工作室（可删除样板）",
    currentPeriod: "2026-08",
    rules: {
      confidenceThreshold: 85,
      automaticPostingThreshold: 95,
      amountTolerance: 0.01,
      requireEvidenceForExpenses: true,
    },
    accounts: [
      { id: "bank:operating", name: "招商银行经营账户", number: "6225****8821", openingBalance: 20000 },
      { id: "bank:reserve", name: "招商银行备用账户", number: "6225****9901", openingBalance: 5000 },
    ],
    documents,
    bills,
    transactions,
    businessEvents: [],
    exceptionTasks: [],
    vouchers,
    openingLedger: { "bank:operating": 20000, "bank:reserve": 5000, equity: -25000 },
    reportVersions: [],
    confirmations: [],
    tax: { payroll: 6800, socialSecurity: 1540, sourceIds: ["doc-payroll", "doc-social"] },
    auditLog: [{ id: "audit-0001", at: FIXTURE_NOW, actor: "系统样板", mode: "fixture", action: "fixture.created", entityType: "workspace", entityId: "workspace-accounting-fixture", detail: "载入确定性本地样板数据", before: null, after: null, sourceIds: [] }],
  };
}
