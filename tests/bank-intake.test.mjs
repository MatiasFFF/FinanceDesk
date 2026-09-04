import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import {
  applyBankImport,
  createBankCsvTemplate,
  createFinanceDeskStore,
  createInitialState,
  createLocalFoundationRepository,
  createMemoryFileVault,
  createMemoryStorage,
  detectBankFieldMapping,
  getWorkspace,
  inspectBankTable,
  parseDelimitedText,
  prepareBankImport,
  readBankFile,
  saveLocalDocument,
  updateWorkspace,
} from "../src/foundation.js";

const fixedTimestamp = "2026-09-04T08:00:00.000Z";
const fixedNow = () => new Date(fixedTimestamp);

function stateWithTestAccount() {
  const initial = createInitialState({ now: fixedNow });
  const workspaceId = initial.activeWorkspaceId;
  return updateWorkspace(initial, workspaceId, (workspace) => ({
    ...workspace,
    bankAccounts: [{
      id: "bank-test",
      name: "测试银行账户",
      openingBalance: 1000,
      statementClosing: 1120,
      currency: "CNY",
      status: "active",
      sourceMode: "manual-import",
      externalConnection: "not_connected",
    }],
    transactions: [{
      id: "existing-transaction",
      accountId: "bank-test",
      date: "2026-08-03",
      amount: 50,
      counterparty: "已有客户",
      summary: "已有收款",
      serial: "EXIST-001",
      status: "pending",
    }],
  }), null, { now: fixedNow });
}

test("CSV 解析支持引号、逗号与自动字段映射", () => {
  const csv = '\ufeff交易日期,对方名称,摘要,收入金额,支出金额,流水号,账户余额\n2026-08-01,"甲方,上海","课程收入,八月",100,,NEW-001,1100';
  const { table, delimiter } = parseDelimitedText(csv);
  const inspection = inspectBankTable(table);

  assert.equal(delimiter, ",");
  assert.equal(table[1][1], "甲方,上海");
  assert.equal(table[1][2], "课程收入,八月");
  assert.equal(inspection.mapping.date, 0);
  assert.equal(inspection.mapping.credit, 3);
  assert.equal(inspection.mapping.debit, 4);
  assert.deepEqual(inspection.missingFields, []);
});

test("字段映射同时支持常见英文银行表头", () => {
  const mapping = detectBankFieldMapping(["Transaction Date", "Counterparty", "Description", "Amount", "Reference", "Balance"]);
  assert.deepEqual(mapping, { date: 0, amount: 3, counterparty: 1, summary: 2, serial: 4, balance: 5 });
});

test("银行导入保留原始行，识别文件内和工作台内重复，并完成余额勾稽", () => {
  const state = stateWithTestAccount();
  const workspace = getWorkspace(state);
  const table = [
    ["交易日期", "对方名称", "摘要", "收入金额", "支出金额", "流水号", "账户余额"],
    ["2026-08-01", "客户甲", "课程收入", 100, "", "NEW-001", 1100],
    ["2026-08-02", "供应商乙", "采购付款", "", 30, "NEW-002", 1070],
    ["2026-08-02", "供应商乙", "采购付款", "", 30, "NEW-002", 1070],
    ["2026-08-03", "已有客户", "已有收款", 50, "", "EXIST-001", 1120],
    ["错误日期", "客户丙", "无效行", 20, "", "BAD-001", 1140],
  ];
  const plan = prepareBankImport(workspace, {
    accountId: "bank-test",
    fileName: "测试银行流水.csv",
    table,
    importedAt: fixedTimestamp,
    openingBalance: 1000,
    statementClosing: 1120,
  });

  assert.equal(plan.rowCount, 5);
  assert.equal(plan.validRowCount, 3);
  assert.equal(plan.importableRowCount, 2);
  assert.equal(plan.duplicateCount, 2);
  assert.equal(plan.errorCount, 1);
  assert.equal(plan.reconciliation.passed, true);
  assert.equal(plan.reconciliation.movement, 120);
  assert.equal(plan.transactions[0].sourceRow, 2);
  assert.equal(plan.transactions[0].raw["对方名称"], "客户甲");

  const applied = applyBankImport(state, workspace.id, plan, { now: fixedNow, actor: "测试会计" });
  const updated = getWorkspace(applied);
  assert.equal(updated.transactions.length, workspace.transactions.length + 2);
  assert.equal(updated.bankImports.length, 1);
  assert.equal(updated.stages.s3.status, "needs_review", "存在坏行时仍需人工复核");
  assert.match(updated.auditLog.at(-1).detail, /新增 2 笔/);
});

test("余额不平时给出明确差额而不是伪装通过", () => {
  const workspace = getWorkspace(stateWithTestAccount());
  const { table } = parseDelimitedText(createBankCsvTemplate());
  const plan = prepareBankImport(workspace, {
    accountId: "bank-test",
    fileName: "不平流水.csv",
    table,
    importedAt: fixedTimestamp,
    openingBalance: 1000,
    statementClosing: 1500,
  });
  assert.equal(plan.reconciliation.available, true);
  assert.equal(plan.reconciliation.passed, false);
  assert.equal(plan.status, "reconciliation_failed");
  assert.match(plan.reconciliation.message, /余额相差/);
});

test("XLSX 文件读取首个工作表并给出映射预览", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["日期", "对方", "摘要", "金额"],
    ["2026-08-01", "客户甲", "课程收入", 100],
  ]), "银行流水");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  const file = Object.assign(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), { name: "银行流水.xlsx" });
  const result = await readBankFile(file);

  assert.equal(result.sheetName, "银行流水");
  assert.equal(result.table.length, 2);
  assert.deepEqual(result.inspection.missingFields, []);
});

test("资料原文件进入本地文件保险箱，元数据和证据关联进入工作台", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const file = Object.assign(new Blob(["local evidence"], { type: "text/plain" }), {
    name: "本地合同.txt",
    lastModified: Date.parse(fixedTimestamp),
  });
  const metadata = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file,
    metadata: {
      category: "合同",
      period: "2026-08",
      relatedObjectIds: ["contract-member-li"],
      actor: "测试会计",
      createdAt: fixedTimestamp,
    },
  });

  const persisted = await fileVault.get(metadata.id);
  const workspace = store.getActiveWorkspace();
  assert.equal(persisted.workspaceId, workspaceId);
  assert.equal(persisted.blob.size, file.size);
  assert.equal(workspace.documents.some((item) => item.id === metadata.id), true);
  assert.equal(workspace.evidenceLinks.some((item) => item.documentIds.includes(metadata.id)), true);
  assert.equal(metadata.storage.externalUpload, false);
  assert.match(metadata.hash, /^[a-f0-9]{64}$|^fnv1a-/);
});
