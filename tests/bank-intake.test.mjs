import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import {
  applyBankImport,
  copyWorkspaceLocalFiles,
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
  refreshLocalFileAvailability,
  removeLocalDocument,
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

test("银行导入保留原始行、识别重复，并在坏行修正前拒绝落库", () => {
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

  assert.throws(
    () => applyBankImport(state, workspace.id, plan, { now: fixedNow, actor: "测试会计" }),
    /仍有 1 行错误/,
  );

  const correctedPlan = prepareBankImport(workspace, {
    accountId: "bank-test",
    fileName: "测试银行流水-已修正.csv",
    table: table.slice(0, -1),
    importedAt: fixedTimestamp,
    openingBalance: 1000,
    statementClosing: 1120,
  });
  const applied = applyBankImport(state, workspace.id, correctedPlan, { now: fixedNow, actor: "测试会计" });
  const updated = getWorkspace(applied);
  assert.equal(updated.transactions.length, workspace.transactions.length + 2);
  assert.equal(updated.bankImports.length, 1);
  assert.equal(updated.stages.s3.status, "complete");
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
  assert.throws(() => applyBankImport(stateWithTestAccount(), workspace.id, plan, { now: fixedNow }), /尚未勾稽通过/);
});

test("空白工作台可随首份已勾稽流水建立活动账期，已有业务时拒绝跨期混入", () => {
  const initial = createInitialState({ now: fixedNow });
  const workspaceId = initial.activeWorkspaceId;
  const blankState = updateWorkspace(initial, workspaceId, (workspace) => ({
    ...workspace,
    currentPeriod: "2026-09",
    periods: ["2026-09"],
    transactions: [],
    vouchers: [],
    bankImports: [],
    delivery: { ...workspace.delivery, reportVersions: [], filing: { ...workspace.delivery.filing, period: "2026-09", draftCreatedAt: null } },
    bankAccounts: [{ id: "bank-blank", name: "空白账户", openingBalance: 1000, statementClosing: 1120, status: "active", currency: "CNY" }],
  }), null, { now: fixedNow });
  const blankWorkspace = getWorkspace(blankState);
  const table = [
    ["交易日期", "对方名称", "摘要", "金额", "流水号", "账户余额"],
    ["2026-08-01", "客户甲", "收款", 100, "A-1", 1100],
    ["2026-08-02", "客户乙", "收款", 20, "A-2", 1120],
  ];
  const plan = prepareBankImport(blankWorkspace, {
    accountId: "bank-blank",
    fileName: "首份流水.csv",
    table,
    importedAt: fixedTimestamp,
    openingBalance: 1000,
    statementClosing: 1120,
  });
  const applied = applyBankImport(blankState, workspaceId, plan, { now: fixedNow });
  assert.equal(getWorkspace(applied).currentPeriod, "2026-08");
  assert.equal(getWorkspace(applied).periods[0], "2026-08");

  const alreadyHasData = getWorkspace(applied);
  const laterTable = [
    ["交易日期", "对方名称", "摘要", "金额", "流水号", "账户余额"],
    ["2026-09-01", "客户丙", "收款", 10, "B-1", 1130],
  ];
  const laterPlan = prepareBankImport(alreadyHasData, {
    accountId: "bank-blank",
    fileName: "跨期流水.csv",
    table: laterTable,
    importedAt: fixedTimestamp,
    openingBalance: 1120,
    statementClosing: 1130,
  });
  assert.throws(() => applyBankImport(applied, workspaceId, laterPlan, { now: fixedNow }), /已有业务数据时不能导入/);
});

test("同一文件混入多个账期时预检查直接拒绝", () => {
  const workspace = getWorkspace(stateWithTestAccount());
  const table = [
    ["交易日期", "对方名称", "摘要", "金额"],
    ["2026-08-31", "客户甲", "八月收款", 10],
    ["2026-09-01", "客户乙", "九月收款", 20],
  ];
  assert.throws(() => prepareBankImport(workspace, {
    accountId: "bank-test",
    fileName: "混合账期.csv",
    table,
    openingBalance: 1000,
    statementClosing: 1030,
  }), /一次只能导入一个账期/);
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

test("通用资料入口关联流水时会回写证据并重新计算待办", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const transactionId = store.getActiveWorkspace().transactions[0].id;
  const file = Object.assign(new Blob(["invoice evidence"], { type: "text/plain" }), {
    name: "补充发票.txt",
    lastModified: Date.parse(fixedTimestamp),
  });
  const metadata = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file,
    metadata: { category: "发票", relatedObjectIds: [transactionId], actor: "测试会计" },
  });

  const transaction = store.getActiveWorkspace().transactions.find((item) => item.id === transactionId);
  assert.equal(transaction.evidenceIds.includes(metadata.id), true);
  assert.equal(Boolean(transaction.evidenceAssessment), true);
  assert.equal(store.getActiveWorkspace().evidenceLinks.some((item) => item.documentIds.includes(metadata.id)), true);
});

test("复制工作台会复制独立 Blob，删除副本资料不影响来源工作台", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const sourceWorkspaceId = store.getState().activeWorkspaceId;
  const file = Object.assign(new Blob(["source evidence"], { type: "text/plain" }), {
    name: "来源凭证.txt",
    lastModified: Date.parse(fixedTimestamp),
  });
  const sourceDocument = await saveLocalDocument({ store, fileVault, workspaceId: sourceWorkspaceId, file });
  const target = store.actions.createWorkspace({ name: "独立副本", sourceWorkspaceId });

  await copyWorkspaceLocalFiles({ store, fileVault, sourceWorkspaceId, targetWorkspaceId: target.id });
  const copiedDocument = store.getActiveWorkspace().documents.find((item) => item.id === sourceDocument.id);
  assert.notEqual(copiedDocument.storage.blobId, sourceDocument.storage.blobId);
  assert.equal((await fileVault.get(copiedDocument.storage.blobId)).workspaceId, target.id);

  await removeLocalDocument({ store, fileVault, workspaceId: target.id, documentId: copiedDocument.id });
  assert.equal(Boolean(await fileVault.get(sourceDocument.storage.blobId)), true);
  assert.equal(store.getState().workspaces.find((item) => item.id === sourceWorkspaceId).documents.length > 0, true);
});

test("资料关联对象必须属于当前工作台，失败时不留下孤立 Blob", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const file = Object.assign(new Blob(["invalid link"], { type: "text/plain" }), { name: "错误关联.txt" });

  await assert.rejects(() => saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file,
    metadata: { relatedObjectIds: ["object-from-another-workspace"] },
  }), /关联对象不属于当前工作台/);
  assert.equal((await fileVault.listByWorkspace(workspaceId)).length, 0);
});

test("旧备份中跨工作台复用的 Blob 会在启动核对时复制成独立归属", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const sourceWorkspaceId = store.getState().activeWorkspaceId;
  const file = Object.assign(new Blob(["legacy shared blob"], { type: "text/plain" }), { name: "旧资料.txt" });
  const sourceDocument = await saveLocalDocument({ store, fileVault, workspaceId: sourceWorkspaceId, file });
  const target = store.actions.createWorkspace({ name: "旧副本", sourceWorkspaceId });
  const targetWorkspace = store.getActiveWorkspace();
  store.actions.replaceWorkspace(target.id, {
    ...targetWorkspace,
    documents: targetWorkspace.documents.map((document) => document.id === sourceDocument.id
      ? { ...document, storage: { ...document.storage, blobId: sourceDocument.storage.blobId, backupBlobId: sourceDocument.storage.blobId, availableLocally: false } }
      : document),
  });

  const result = await refreshLocalFileAvailability({ store, fileVault });
  const repairedDocument = store.getActiveWorkspace().documents.find((document) => document.id === sourceDocument.id);
  assert.equal(result.repaired, 1);
  assert.notEqual(repairedDocument.storage.blobId, sourceDocument.storage.blobId);
  assert.equal((await fileVault.get(repairedDocument.storage.blobId)).workspaceId, target.id);
});
