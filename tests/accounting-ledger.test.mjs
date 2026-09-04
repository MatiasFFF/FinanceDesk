import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAccountingLedgers,
  buildDetailLedger,
  buildGeneralLedger,
  buildJournalLedger,
  buildLedgerFilterOptions,
  effectivePostedVouchers,
  ledgerToCsv,
} from "../src/domain/accounting/ledger.js";

function ledgerWorkspace() {
  return {
    currentPeriod: "2026-08",
    openingLedger: { cash: 1000, equity: -1000 },
    businessEvents: [
      {
        id: "event-customer",
        type: "memberConsumption",
        memberId: "customer-1",
        memberName: "李女士",
        storeId: "store-east",
        storeName: "东馆",
        department: "私教部",
        project: "塑形课",
      },
      {
        id: "event-employee",
        type: "commission",
        coachId: "employee-1",
        coach: "陈教练",
        storeId: "store-west",
        storeName: "西馆",
        department: "教练部",
        project: "团课",
      },
    ],
    bills: [
      { id: "bill-supplier", kind: "payable", counterparty: "力行器械" },
    ],
    transactions: [],
    advanceApplications: [],
    vouchers: [
      {
        id: "voucher-july",
        no: "记-007",
        date: "2026-07-31",
        period: "2026-07",
        summary: "七月收款",
        status: "posted",
        version: 1,
        sourceIds: ["source-july"],
        lines: [
          { account: "cash", debit: 200, credit: 0, sourceIds: ["source-july"] },
          { account: "revenuePrivate", debit: 0, credit: 200, sourceIds: ["source-july"] },
        ],
      },
      {
        id: "voucher-customer",
        no: "记-001",
        date: "2026-08-05",
        period: "2026-08",
        summary: "会员充值",
        status: "posted",
        version: 1,
        memberEventId: "event-customer",
        sourceIds: ["event-customer"],
        evidenceIds: ["document-customer"],
        lines: [
          { account: "cash", debit: 300, credit: 0, taxAmount: 18.87, sourceIds: ["event-customer"] },
          { account: "contractLiability", debit: 0, credit: 300, sourceIds: ["event-customer"] },
        ],
      },
      {
        id: "voucher-original",
        no: "记-002",
        date: "2026-08-10",
        period: "2026-08",
        summary: "原费用版本",
        status: "posted",
        version: 1,
        sourceIds: ["source-original"],
        lines: [
          { account: "expenseOther", debit: 100, credit: 0, sourceIds: ["source-original"] },
          { account: "cash", debit: 0, credit: 100, sourceIds: ["source-original"] },
        ],
      },
      {
        id: "voucher-revision",
        no: "记-003",
        date: "2026-08-10",
        period: "2026-08",
        summary: "修订\"费用\"",
        status: "posted",
        version: 2,
        revisionOf: "voucher-original",
        sourceIds: ["source-revised"],
        lines: [
          { account: "expenseOther", debit: 40, credit: 0, sourceIds: ["source-revised"] },
          { account: "cash", debit: 0, credit: 40, sourceIds: ["source-revised"] },
        ],
      },
      {
        id: "voucher-draft",
        no: null,
        date: "2026-08-12",
        period: "2026-08",
        summary: "未入账草稿",
        status: "draft",
        version: 1,
        sourceIds: ["source-draft"],
        lines: [
          { account: "cash", debit: 9999, credit: 0, sourceIds: ["source-draft"] },
          { account: "revenuePrivate", debit: 0, credit: 9999, sourceIds: ["source-draft"] },
        ],
      },
      {
        id: "voucher-voided",
        no: "记-004",
        date: "2026-08-15",
        period: "2026-08",
        summary: "已作废凭证",
        status: "posted",
        voidedAt: "2026-08-16T00:00:00.000Z",
        version: 1,
        sourceIds: ["source-voided"],
        lines: [
          { account: "cash", debit: 8888, credit: 0, sourceIds: ["source-voided"] },
          { account: "revenuePrivate", debit: 0, credit: 8888, sourceIds: ["source-voided"] },
        ],
      },
      {
        id: "voucher-supplier",
        no: "记-009",
        date: "2026-09-02",
        period: "2026-09",
        summary: "采购入账",
        status: "posted",
        version: 1,
        sourceIds: ["bill-supplier"],
        lines: [
          { account: "equipment", debit: 80, credit: 0, sourceIds: ["bill-supplier"] },
          { account: "payable", debit: 0, credit: 80, sourceIds: ["bill-supplier"] },
        ],
      },
      {
        id: "voucher-employee",
        no: "记-010",
        date: "2026-09-03",
        period: "2026-09",
        summary: "计提提成",
        status: "posted",
        version: 1,
        memberEventId: "event-employee",
        sourceIds: ["event-employee"],
        lines: [
          { account: "expenseCommission", debit: 60, credit: 0, sourceIds: ["event-employee"] },
          { account: "payrollPayable", debit: 0, credit: 60, sourceIds: ["event-employee"] },
        ],
      },
    ],
  };
}

test("账簿只纳入当前有效的已入账凭证版本", () => {
  const workspace = ledgerWorkspace();
  const ids = effectivePostedVouchers(workspace).map((voucher) => voucher.id);

  assert.deepEqual(ids, [
    "voucher-july",
    "voucher-customer",
    "voucher-revision",
    "voucher-supplier",
    "voucher-employee",
  ]);

  const journal = buildJournalLedger(workspace, { period: "2026-08" });
  assert.equal(journal.rows.length, 4);
  assert.equal(journal.totals.debit, 340);
  assert.equal(journal.totals.credit, 340);
  assert.equal(journal.rows.some((row) => row.sourceIds.includes("source-draft")), false);
  assert.equal(journal.rows.some((row) => row.sourceIds.includes("source-original")), false);
  assert.equal(journal.rows.some((row) => row.sourceIds.includes("source-voided")), false);
});

test("总账以期初加期间发生额计算期末余额", () => {
  const workspace = ledgerWorkspace();
  const general = buildGeneralLedger(workspace, { period: "2026-08", account: "cash" });

  assert.equal(general.rows.length, 1);
  assert.deepEqual(general.rows[0], {
    account: "cash",
    accountLabel: "库存现金",
    normalSide: "debit",
    openingBalance: 1200,
    openingDirection: "借",
    openingSignedBalance: 1200,
    debit: 300,
    credit: 40,
    taxAmount: 18.87,
    closingBalance: 1460,
    closingDirection: "借",
    closingSignedBalance: 1460,
    voucherIds: ["voucher-customer", "voucher-revision"],
    originalSourceIds: ["cash", "source-july", "event-customer", "source-revised"],
  });
});

test("明细账按日期和凭证号给出运行余额并保留追溯链", () => {
  const detail = buildDetailLedger(ledgerWorkspace(), { period: "2026-08", account: "cash" });

  assert.deepEqual(detail.rows.map((row) => [row.date, row.voucherNo, row.runningDirection, row.runningBalance]), [
    ["2026-08-05", "记-001", "借", 1500],
    ["2026-08-10", "记-003", "借", 1460],
  ]);
  assert.equal(detail.rows[0].voucherId, "voucher-customer");
  assert.deepEqual(detail.rows[0].originalSourceIds, ["event-customer"]);
  assert.equal(detail.rows[1].voucherVersion, 2);
});

test("账簿支持期间、科目、往来对象和组织维度筛选", () => {
  const workspace = ledgerWorkspace();
  const filters = {
    period: "2026-08",
    account: "contractLiability",
    auxiliaryType: "customer",
    auxiliaryId: "customer-1",
    storeId: "store-east",
    department: "私教部",
    project: "塑形课",
  };
  const ledgers = buildAccountingLedgers(workspace, filters);

  assert.equal(ledgers.journal.rows.length, 1);
  assert.equal(ledgers.journal.rows[0].voucherId, "voucher-customer");
  assert.deepEqual(ledgers.journal.rows[0].auxiliaryLabels, ["李女士"]);
  assert.deepEqual(ledgers.journal.rows[0].storeNames, ["东馆"]);
  assert.equal(ledgers.general.rows[0].closingDirection, "贷");
  assert.equal(ledgers.general.rows[0].closingBalance, 300);

  const options = buildLedgerFilterOptions(workspace);
  assert.deepEqual(new Set(options.auxiliaryTypes.map((item) => item.id)), new Set(["customer", "supplier", "employee"]));
  assert.ok(options.stores.some((item) => item.id === "store-east" && item.label === "东馆"));
  assert.ok(options.departments.includes("私教部"));
  assert.ok(options.projects.includes("塑形课"));
});

test("本地 CSV 导出包含凭证、余额和原始 sourceIds", () => {
  const workspace = ledgerWorkspace();
  const journal = buildJournalLedger(workspace, { period: "2026-08" });
  const detail = buildDetailLedger(workspace, { period: "2026-08", account: "cash" });
  const general = buildGeneralLedger(workspace, { period: "2026-08", account: "cash" });

  const journalCsv = ledgerToCsv("journal", journal);
  assert.ok(journalCsv.startsWith("\ufeff"));
  assert.match(journalCsv, /"凭证ID"/);
  assert.match(journalCsv, /"原始sourceIds"/);
  assert.match(journalCsv, /"voucher-revision"/);
  assert.match(journalCsv, /"修订""费用"""/);

  assert.match(ledgerToCsv("detail", detail), /"运行余额"/);
  assert.match(ledgerToCsv("general", general), /"期初余额"/);
  assert.match(ledgerToCsv("general", general), /"期末余额"/);
});
