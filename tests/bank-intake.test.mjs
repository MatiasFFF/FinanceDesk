import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import JSZip from "jszip";

import {
  applyBankImport,
  applyPlatformSettlementImport,
  buildDocumentMatchSuggestions,
  buildMonthlyFinancialArchivePlan,
  buildVoucherAttachmentPackagePlan,
  confirmDocumentMatch,
  buildBankMonthlyReconciliation,
  copyWorkspaceLocalFiles,
  createBankCsvTemplate,
  createFinanceDeskStore,
  createInitialState,
  createLocalFoundationRepository,
  createMemoryFileVault,
  createMemoryStorage,
  detectBankFieldMapping,
  filterLocalDocuments,
  getDocumentRelatedObjectIds,
  getDocumentMissingRequirements,
  getLocalDocumentUsage,
  getMonthlyFinancialArchivePeriods,
  getWorkspace,
  generateMonthlyFinancialArchivePackage,
  generateVoucherAttachmentPackage,
  inspectBankTable,
  parseDelimitedText,
  prepareBankImport,
  preparePlatformSettlementImport,
  readBankFile,
  readPlatformSettlementFile,
  refreshLocalFileAvailability,
  refreshDocumentMissingTasks,
  removeLocalDocument,
  saveLocalDocument,
  updateLocalDocumentMetadata,
  updateWorkspace,
} from "../src/foundation.js";

const fixedTimestamp = "2026-09-04T08:00:00.000Z";
const fixedNow = () => new Date(fixedTimestamp);

function stateWithTestAccount() {
  const initial = createInitialState({ now: fixedNow });
  const workspaceId = initial.activeWorkspaceId;
  return updateWorkspace(initial, workspaceId, (workspace) => ({
    ...workspace,
    counterparties: [
      ...(workspace.counterparties || []),
      { id: "counterparty-customer-a", name: "客户甲", kind: "customer", status: "active" },
      { id: "counterparty-supplier-b", name: "供应商乙", kind: "supplier", status: "active" },
    ],
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

function stateWithTransferAccounts() {
  const initial = createInitialState({ now: fixedNow });
  const workspaceId = initial.activeWorkspaceId;
  const bankAccounts = [
    { id: "bank-operating", name: "经营账户", openingBalance: 10000, statementClosing: 8000, currency: "CNY", status: "active" },
    { id: "bank-reserve", name: "备用账户", openingBalance: 5000, statementClosing: 7000, currency: "CNY", status: "active" },
  ];
  return updateWorkspace(initial, workspaceId, (workspace) => ({
    ...workspace,
    currentPeriod: "2026-08",
    periods: ["2026-08"],
    bankAccounts,
    accounts: bankAccounts,
    bankImports: [],
    transactions: [],
    businessEvents: [],
    exceptionTasks: [],
    vouchers: [],
    delivery: {
      ...workspace.delivery,
      reportVersions: [],
      filing: { ...workspace.delivery.filing, period: "2026-08", draftCreatedAt: null },
    },
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

test("空白余额输入会使用账户期初和流水末行余额完成勾稽", () => {
  const workspace = getWorkspace(stateWithTestAccount());
  const table = [
    ["交易日期", "对方名称", "摘要", "金额", "流水号", "账户余额"],
    ["2026-08-01", "客户甲", "收款", 100, "BAL-001", 1100],
    ["2026-08-02", "供应商乙", "付款", -30, "BAL-002", 1070],
  ];
  const plan = prepareBankImport(workspace, {
    accountId: "bank-test",
    fileName: "余额列流水.csv",
    table,
    openingBalance: "",
    statementClosing: "",
    importedAt: fixedTimestamp,
  });

  assert.equal(plan.reconciliation.openingBalance, 1000);
  assert.equal(plan.reconciliation.statementClosing, 1070);
  assert.equal(plan.reconciliation.passed, true);
});

test("所选账期必须与文件内流水日期一致", () => {
  const workspace = getWorkspace(stateWithTestAccount());
  const table = [
    ["交易日期", "对方名称", "摘要", "金额", "流水号", "账户余额"],
    ["2026-08-01", "客户甲", "收款", 100, "PERIOD-001", 1100],
  ];

  assert.throws(() => prepareBankImport(workspace, {
    accountId: "bank-test",
    period: "2026-09",
    fileName: "错期流水.csv",
    table,
    openingBalance: 1000,
    statementClosing: 1100,
  }), /所选账期 2026-09 与流水日期账期 2026-08 不一致/);
});

test("未知对手、异常大额和疑似关联方会落成可见异常任务", () => {
  const state = stateWithTestAccount();
  const workspace = getWorkspace(state);
  const table = [
    ["交易日期", "对方名称", "摘要", "金额", "流水号", "账户余额"],
    ["2026-08-01", "神秘来款", "临时转账", 100, "RISK-001", 1100],
    ["2026-08-02", "已有客户", "大额收款", 50000, "RISK-002", 51100],
    ["2026-08-03", "张股东", "往来款", -200, "RISK-003", 50900],
  ];
  const plan = prepareBankImport(workspace, {
    accountId: "bank-test",
    period: "2026-08",
    fileName: "异常流水.csv",
    table,
    importedAt: fixedTimestamp,
    openingBalance: 1000,
    statementClosing: 50900,
  });

  assert.equal(plan.reconciliation.passed, true);
  assert.deepEqual(new Set(plan.anomalies.map((item) => item.code)), new Set([
    "bank_unknown_counterparty",
    "bank_large_amount",
    "bank_related_party",
  ]));
  assert.equal(plan.transactions.every((transaction) => transaction.status === "exception"), true);

  const applied = applyBankImport(state, workspace.id, plan, { now: fixedNow, actor: "测试会计" });
  const updated = getWorkspace(applied);
  const importedIds = new Set(plan.transactions.map((transaction) => transaction.id));
  const importedExceptions = updated.exceptionTasks.filter((task) => importedIds.has(task.sourceId));
  assert.equal(importedExceptions.length, 3);
  assert.equal(importedExceptions.every((task) => task.status === "open" && task.sourceType === "bankTransaction"), true);
  assert.equal(updated.stages.s3.status, "needs_review");
});

test("人工交易对手映射会保存别名规则、回写旧流水并关闭未知对手异常", () => {
  const state = stateWithTestAccount();
  const workspace = getWorkspace(state);
  const firstInput = {
    accountId: "bank-test",
    period: "2026-08",
    importId: "bank-import-alias-before",
    fileName: "别名首次出现.csv",
    table: [
      ["交易日期", "对方名称", "对方账号", "摘要", "金额", "流水号", "账户余额"],
      ["2026-08-05", "甲方别名", "6222 0001", "收款", 100, "ALIAS-001", 1100],
    ],
    importedAt: "2026-09-01T08:00:00.000Z",
    openingBalance: 1000,
    statementClosing: 1100,
  };
  const firstPlan = prepareBankImport(workspace, firstInput);
  assert.equal(firstPlan.anomalyCounts.bank_unknown_counterparty, 1);
  const afterFirst = applyBankImport(state, workspace.id, firstPlan, { now: fixedNow, actor: "王会计" });
  const beforeMapping = getWorkspace(afterFirst).transactions.find((item) => item.serial === "ALIAS-001");
  assert.equal(getWorkspace(afterFirst).exceptionTasks.some((task) => task.sourceId === beforeMapping.id && task.code === "bank_unknown_counterparty" && task.status === "open"), true);

  const secondInput = {
    accountId: "bank-test",
    period: "2026-08",
    importId: "bank-import-alias-confirm",
    fileName: "别名确认.csv",
    table: [
      ["交易日期", "对方名称", "对方账号", "摘要", "金额", "流水号", "账户余额"],
      ["2026-08-06", "甲方别名", "6222 0001", "补充收款", 50, "ALIAS-002", 1150],
    ],
    importedAt: "2026-09-02T08:00:00.000Z",
    openingBalance: 1100,
    statementClosing: 1150,
  };
  const unmappedPlan = prepareBankImport(getWorkspace(afterFirst), secondInput);
  const aliasKey = unmappedPlan.transactions[0].counterpartyAliasKey;
  const mappedPlan = prepareBankImport(getWorkspace(afterFirst), {
    ...secondInput,
    counterpartyMappings: {
      [aliasKey]: {
        rawName: "甲方别名",
        counterpartyAccount: "6222 0001",
        standardName: "客户甲",
        objectId: "counterparty-customer-a",
        objectType: "counterparty",
        kind: "customer",
      },
    },
  });
  assert.equal(mappedPlan.transactions[0].counterparty, "客户甲");
  assert.equal(mappedPlan.transactions[0].counterpartyObjectId, "counterparty-customer-a");
  assert.equal(mappedPlan.anomalyCounts.bank_unknown_counterparty || 0, 0);

  const applied = applyBankImport(afterFirst, workspace.id, mappedPlan, { now: fixedNow, actor: "李会计" });
  const updated = getWorkspace(applied);
  const oldTransaction = updated.transactions.find((item) => item.serial === "ALIAS-001");
  const newTransaction = updated.transactions.find((item) => item.serial === "ALIAS-002");
  assert.equal(oldTransaction.counterparty, "客户甲");
  assert.equal(oldTransaction.counterpartyObjectId, "counterparty-customer-a");
  assert.equal(newTransaction.counterpartyObjectId, "counterparty-customer-a");
  assert.equal(updated.counterpartyAliasRules.length, 1);
  assert.equal(updated.exceptionTasks.some((task) => task.sourceId === oldTransaction.id && task.code === "bank_unknown_counterparty" && task.status !== "resolved"), false);

  const automaticPlan = prepareBankImport(updated, {
    accountId: "bank-test",
    period: "2026-08",
    importId: "bank-import-alias-auto",
    fileName: "别名自动套用.csv",
    table: [
      ["交易日期", "对方名称", "对方账号", "摘要", "金额", "流水号", "账户余额"],
      ["2026-08-07", "甲方别名", "另一个账号", "同名收款", 20, "ALIAS-003", 1170],
      ["2026-08-08", "另一显示名称", "62220001", "同账号退款", -5, "ALIAS-004", 1165],
    ],
    importedAt: "2026-09-03T08:00:00.000Z",
    openingBalance: 1150,
    statementClosing: 1165,
  });
  assert.equal(automaticPlan.transactions.every((transaction) => transaction.counterparty === "客户甲"), true);
  assert.equal(automaticPlan.transactions.every((transaction) => transaction.counterpartyObjectId === "counterparty-customer-a"), true);
  assert.equal(automaticPlan.anomalyCounts.bank_unknown_counterparty || 0, 0);
});

test("手工标准名称标记为关联方时关闭未知分类但保留关联方复核", () => {
  const state = stateWithTransferAccounts();
  const workspace = getWorkspace(state);
  const input = {
    accountId: "bank-operating",
    period: "2026-08",
    importId: "bank-import-related-alias",
    fileName: "关联方别名.csv",
    table: [
      ["交易日期", "对方名称", "对方账号", "摘要", "金额", "流水号", "账户余额"],
      ["2026-08-12", "私人账户", "88880001", "临时往来", -200, "RELATED-ALIAS-001", 9800],
    ],
    importedAt: fixedTimestamp,
    openingBalance: 10000,
    statementClosing: 9800,
  };
  const preview = prepareBankImport(workspace, input);
  const aliasKey = preview.transactions[0].counterpartyAliasKey;
  const plan = prepareBankImport(workspace, {
    ...input,
    counterpartyMappings: {
      [aliasKey]: {
        rawName: "私人账户",
        counterpartyAccount: "88880001",
        standardName: "张总往来",
        objectId: null,
        objectType: "manual",
        kind: "related_party",
      },
    },
  });

  assert.equal(plan.transactions[0].counterparty, "张总往来");
  assert.equal(plan.anomalyCounts.bank_unknown_counterparty || 0, 0);
  assert.equal(plan.anomalyCounts.bank_related_party, 1);
  const applied = applyBankImport(state, workspace.id, plan, { now: fixedNow, actor: "测试会计" });
  const updated = getWorkspace(applied);
  const transaction = updated.transactions.find((item) => item.serial === "RELATED-ALIAS-001");
  assert.equal(updated.counterpartyAliasRules[0].standardName, "张总往来");
  assert.equal(updated.exceptionTasks.some((task) => task.sourceId === transaction.id && task.code === "bank_unknown_counterparty" && task.status !== "resolved"), false);
  assert.equal(updated.exceptionTasks.some((task) => task.sourceId === transaction.id && task.code === "bank_related_party" && task.status === "open"), true);
});

test("预览后工作台若已写入相同流水，最终落库仍会阻止重复", () => {
  const state = stateWithTestAccount();
  const workspace = getWorkspace(state);
  const table = [
    ["交易日期", "对方名称", "摘要", "金额", "流水号", "账户余额"],
    ["2026-08-01", "客户甲", "收款", 100, "RACE-001", 1100],
  ];
  const base = {
    accountId: "bank-test",
    period: "2026-08",
    fileName: "重复保护.csv",
    table,
    importedAt: fixedTimestamp,
    openingBalance: 1000,
    statementClosing: 1100,
  };
  const firstPlan = prepareBankImport(workspace, { ...base, importId: "bank-import-first" });
  const stalePlan = prepareBankImport(workspace, { ...base, importId: "bank-import-stale" });
  const firstApplied = applyBankImport(state, workspace.id, firstPlan, { now: fixedNow });

  assert.throws(() => applyBankImport(firstApplied, workspace.id, stalePlan, { now: fixedNow }), /全部为重复记录/);
  assert.equal(getWorkspace(firstApplied).transactions.filter((item) => item.serial === "RACE-001").length, 1);
});

test("不同银行账户的等额反向近日期流水会配对为一笔内部转账", () => {
  const initial = stateWithTransferAccounts();
  const workspace = getWorkspace(initial);
  const outgoingPlan = prepareBankImport(workspace, {
    accountId: "bank-operating",
    period: "2026-08",
    importId: "bank-import-transfer-out",
    fileName: "经营账户.csv",
    table: [
      ["交易日期", "对方名称", "摘要", "金额", "流水号", "账户余额"],
      ["2026-08-20", "本企业备用账户", "资金划转", -2000, "TRANSFER-OUT", 8000],
    ],
    importedAt: fixedTimestamp,
    openingBalance: 10000,
    statementClosing: 8000,
  });
  const afterOutgoing = applyBankImport(initial, workspace.id, outgoingPlan, { now: fixedNow });
  const incomingPlan = prepareBankImport(getWorkspace(afterOutgoing), {
    accountId: "bank-reserve",
    period: "2026-08",
    importId: "bank-import-transfer-in",
    fileName: "备用账户.csv",
    table: [
      ["交易日期", "对方名称", "摘要", "金额", "流水号", "账户余额"],
      ["2026-08-21", "本企业经营账户", "资金转入", 2000, "TRANSFER-IN", 7000],
    ],
    importedAt: fixedTimestamp,
    openingBalance: 5000,
    statementClosing: 7000,
  });

  assert.equal(incomingPlan.recognitionCount, 1);
  assert.equal(incomingPlan.recognitions[0].type, "internalTransfer");
  assert.match(incomingPlan.recognitions[0].message, /经营账户 → 备用账户/);

  const applied = applyBankImport(afterOutgoing, workspace.id, incomingPlan, { now: fixedNow, actor: "测试会计" });
  const updated = getWorkspace(applied);
  const outgoing = updated.transactions.find((item) => item.serial === "TRANSFER-OUT");
  const incoming = updated.transactions.find((item) => item.serial === "TRANSFER-IN");
  assert.equal(outgoing.counterpartTransactionId, incoming.id);
  assert.equal(incoming.counterpartTransactionId, outgoing.id);
  assert.equal(outgoing.counterpartAccountId, "bank-reserve");
  assert.equal(incoming.counterpartAccountId, "bank-operating");
  assert.equal(outgoing.transferPairId, incoming.transferPairId);
  assert.equal(outgoing.classification.eventType, "internalTransfer");
  assert.equal(incoming.classification.eventType, "internalTransfer");
  assert.equal(outgoing.classification.account, "bank");
  assert.equal(incoming.classification.account, "bank");
  const transferEvents = updated.businessEvents.filter((event) => event.type === "internalTransfer");
  assert.equal(transferEvents.length, 1);
  assert.equal(transferEvents[0].direction, "transfer");
  assert.equal(transferEvents[0].account, "bank");
  assert.deepEqual(new Set(transferEvents[0].sourceIds), new Set([outgoing.id, incoming.id]));
  assert.equal(updated.exceptionTasks.filter((task) => task.sourceId === outgoing.id && task.status !== "resolved").length, 0);
});

test("明确银行手续费会直接形成手续费业务事件", () => {
  const state = stateWithTransferAccounts();
  const workspace = getWorkspace(state);
  const plan = prepareBankImport(workspace, {
    accountId: "bank-operating",
    period: "2026-08",
    importId: "bank-import-fee",
    fileName: "手续费.csv",
    table: [
      ["交易日期", "对方名称", "摘要", "金额", "流水号", "账户余额"],
      ["2026-08-31", "开户银行", "账户管理手续费", -25, "FEE-001", 9975],
    ],
    importedAt: fixedTimestamp,
    openingBalance: 10000,
    statementClosing: 9975,
  });

  assert.equal(plan.recognitionCount, 1);
  assert.equal(plan.recognitions[0].type, "bankFee");
  assert.equal(plan.anomalyCount, 0);
  assert.equal(plan.transactions[0].classification.eventType, "bankFee");
  assert.equal(plan.transactions[0].directAccount, "expenseFee");

  const applied = applyBankImport(state, workspace.id, plan, { now: fixedNow });
  const updated = getWorkspace(applied);
  const transaction = updated.transactions.find((item) => item.serial === "FEE-001");
  const event = updated.businessEvents.find((item) => item.id === transaction.businessEventId);
  assert.equal(event.type, "bankFee");
  assert.equal(event.account, "expenseFee");
  assert.equal(event.amount, 25);
  assert.deepEqual(event.sourceIds, [transaction.id]);
});

test("平台结算按单号去重并以净额匹配银行到账，完整保留总额手续费退款", () => {
  const initial = stateWithTransferAccounts();
  const workspaceId = initial.activeWorkspaceId;
  const state = updateWorkspace(initial, workspaceId, (workspace) => ({
    ...workspace,
    transactions: [
      { id: "txn-wechat-net", accountId: "bank-operating", date: "2026-08-03", amount: 950, counterparty: "微信支付", summary: "结算入账", serial: "BANK-WX-001", status: "pending" },
      { id: "txn-wechat-different", accountId: "bank-operating", date: "2026-08-06", amount: 480, counterparty: "微信支付", summary: "结算入账", serial: "BANK-WX-002", status: "pending" },
    ],
    platformSettlements: [],
    platformSettlementImports: [],
  }), null, { now: fixedNow });
  const workspace = getWorkspace(state);
  const input = {
    accountId: "bank-operating",
    period: "2026-08",
    channel: "wechat",
    importId: "platform-import-wechat",
    fileName: "微信8月结算.xlsx",
    table: [
      ["结算日期", "结算单号", "交易总额", "手续费", "退款", "净结算额"],
      ["2026-08-01", "WX-001", 1000, 30, 20, 950],
      ["2026-08-01", "WX-001", 1000, 30, 20, 950],
      ["2026-08-05", "WX-002", 500, 10, 0, 490],
      ["2026-08-20", "WX-003", 200, 5, 0, 195],
    ],
    importedAt: fixedTimestamp,
  };
  const plan = preparePlatformSettlementImport(workspace, input);

  assert.equal(plan.importableRowCount, 3);
  assert.equal(plan.duplicateCount, 1);
  assert.equal(plan.matchedCount, 1);
  assert.equal(plan.anomalousRowCount, 2);
  assert.deepEqual(new Set(plan.anomalies.map((item) => item.code)), new Set([
    "platform_settlement_amount_difference",
    "platform_settlement_unmatched",
  ]));
  const matchedPreview = plan.settlements.find((item) => item.settlementNo === "WX-001");
  assert.equal(matchedPreview.grossAmount, 1000);
  assert.equal(matchedPreview.feeAmount, 30);
  assert.equal(matchedPreview.refundAmount, 20);
  assert.equal(matchedPreview.netAmount, 950);
  assert.equal(matchedPreview.bankTransactionId, "txn-wechat-net");

  const applied = applyPlatformSettlementImport(state, workspaceId, plan, { now: fixedNow, actor: "测试会计" });
  const updated = getWorkspace(applied);
  assert.equal(updated.platformSettlements.length, 3);
  assert.equal(updated.platformSettlementImports.length, 1);
  assert.equal(updated.platformSettlementImports[0].actor, "测试会计");
  const settlement = updated.platformSettlements.find((item) => item.settlementNo === "WX-001");
  const bankTransaction = updated.transactions.find((item) => item.id === "txn-wechat-net");
  assert.equal(settlement.bankTransactionId, bankTransaction.id);
  assert.equal(bankTransaction.platformSettlementId, settlement.id);
  assert.deepEqual(bankTransaction.settlementBreakdown, { grossAmount: 1000, feeAmount: 30, refundAmount: 20, netAmount: 950 });
  assert.equal(bankTransaction.classification.account, "receivable");
  const event = updated.businessEvents.find((item) => item.id === `event-${settlement.id}`);
  assert.equal(event.amount, 1000);
  assert.equal(event.netAmount, 950);
  assert.equal(event.accountingComponents.find((item) => item.kind === "grossRevenue").amount, 1000);
  assert.equal(event.accountingComponents.find((item) => item.kind === "platformFee").amount, 30);
  assert.match(event.accountingBasis, /不以净额代替营业收入/);
  assert.deepEqual(new Set(updated.exceptionTasks.filter((task) => task.sourceType === "platformSettlement").map((task) => task.code)), new Set([
    "platform_settlement_amount_difference",
    "platform_settlement_unmatched",
  ]));

  const duplicatePlan = preparePlatformSettlementImport(updated, {
    ...input,
    channel: "alipay",
    importId: "platform-import-duplicate",
    fileName: "支付宝重复单号.csv",
    table: [
      ["结算日期", "结算单号", "交易总额", "手续费", "退款", "净结算额"],
      ["2026-08-25", "WX-001", 1000, 30, 20, 950],
    ],
  });
  assert.equal(duplicatePlan.importableRowCount, 0);
  assert.equal(duplicatePlan.duplicateCount, 1);
  assert.throws(() => applyPlatformSettlementImport(applied, workspaceId, duplicatePlan, { now: fixedNow }), /全部为重复记录/);
});

test("平台结算 CSV、XLSX 与 XLS 都进入同一字段映射", async () => {
  const rows = [
    ["结算日期", "结算单号", "交易总额", "手续费", "退款", "净结算额"],
    ["2026-08-01", "SETTLE-001", 1000, 30, 20, 950],
  ];
  const csvFile = Object.assign(new Blob(["结算日期,结算单号,交易总额,手续费,退款,净结算额\n2026-08-01,SETTLE-001,1000,30,20,950"], { type: "text/csv" }), { name: "微信结算.csv" });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "结算单");
  const xlsxFile = Object.assign(new Blob([XLSX.write(workbook, { type: "array", bookType: "xlsx" })]), { name: "支付宝结算.xlsx" });
  const xlsFile = Object.assign(new Blob([XLSX.write(workbook, { type: "array", bookType: "xls" })]), { name: "POS结算.xls" });
  const results = await Promise.all([csvFile, xlsxFile, xlsFile].map((file) => readPlatformSettlementFile(file)));

  results.forEach((result) => {
    assert.equal(result.table.length, 2);
    assert.deepEqual(result.inspection.missingFields, []);
    assert.equal(result.inspection.mapping.settlementNo, 1);
    assert.equal(result.inspection.mapping.netAmount, 5);
  });
});

test("同账户同期间多批次会合并成一个月度勾稽结果并保留批次记录", () => {
  const initial = stateWithTransferAccounts();
  const workspace = getWorkspace(initial);
  const firstPlan = prepareBankImport(workspace, {
    accountId: "bank-operating",
    period: "2026-08",
    importId: "bank-import-aug-1",
    fileName: "经营账户-8月上.csv",
    table: [
      ["交易日期", "对方名称", "摘要", "金额", "流水号", "账户余额"],
      ["2026-08-01", "客户甲", "收款", 1000, "AUG-001", 11000],
      ["2026-08-10", "供应商乙", "付款", -200, "AUG-002", 10800],
    ],
    importedAt: "2026-09-01T08:00:00.000Z",
    openingBalance: 10000,
    statementClosing: 10800,
  });
  const afterFirst = applyBankImport(initial, workspace.id, firstPlan, { now: fixedNow, actor: "王会计" });
  const secondPlan = prepareBankImport(getWorkspace(afterFirst), {
    accountId: "bank-operating",
    period: "2026-08",
    importId: "bank-import-aug-2",
    fileName: "经营账户-8月下.xlsx",
    table: [
      ["交易日期", "对方名称", "摘要", "金额", "流水号", "账户余额"],
      ["2026-08-11", "客户丙", "收款", 500, "AUG-003", 11300],
      ["2026-08-31", "供应商丁", "付款", -300, "AUG-004", 11000],
      ["2026-08-31", "供应商丁", "付款", -300, "AUG-004", 11000],
    ],
    importedAt: "2026-09-02T09:30:00.000Z",
    openingBalance: 10800,
    statementClosing: 11000,
  });
  const applied = applyBankImport(afterFirst, workspace.id, secondPlan, { now: fixedNow, actor: "李会计" });
  const monthly = buildBankMonthlyReconciliation(getWorkspace(applied), {
    accountId: "bank-operating",
    period: "2026-08",
  });

  assert.equal(monthly.batchCount, 2);
  assert.equal(monthly.transactionCount, 4);
  assert.equal(monthly.openingBalance, 10000);
  assert.equal(monthly.income, 1500);
  assert.equal(monthly.expense, 500);
  assert.equal(monthly.calculatedClosing, 11000);
  assert.equal(monthly.statementClosing, 11000);
  assert.equal(monthly.difference, 0);
  assert.equal(monthly.passed, true);
  assert.equal(monthly.status, "complete");
  assert.equal(monthly.dateFrom, "2026-08-01");
  assert.equal(monthly.dateTo, "2026-08-31");
  assert.equal(monthly.imports[0].fileName, "经营账户-8月下.xlsx");
  assert.equal(monthly.imports[0].actor, "李会计");
  assert.equal(monthly.imports[0].dateFrom, "2026-08-11");
  assert.equal(monthly.imports[0].dateTo, "2026-08-31");
  assert.equal(monthly.imports[0].importableRowCount, 2);
  assert.equal(monthly.imports[0].duplicateCount, 1);
  assert.equal(monthly.imports[0].anomalousRowCount, 2);
  assert.equal(monthly.imports[1].actor, "王会计");
});

test("月度勾稽缺少余额或存在差额时明确保持未完成", () => {
  const base = getWorkspace(stateWithTransferAccounts());
  const transaction = {
    id: "txn-monthly-check",
    importId: "bank-import-monthly-check",
    accountId: "bank-operating",
    date: "2026-08-15",
    amount: 100,
  };
  const importRecord = {
    id: "bank-import-monthly-check",
    accountId: "bank-operating",
    period: "2026-08",
    fileName: "月度核对.csv",
    importedAt: fixedTimestamp,
    dateFrom: "2026-08-15",
    dateTo: "2026-08-15",
    reconciliation: { openingBalance: null, statementClosing: 1100 },
  };
  const missing = buildBankMonthlyReconciliation({
    ...base,
    transactions: [transaction],
    bankImports: [importRecord],
  }, { accountId: "bank-operating", period: "2026-08" });

  assert.equal(missing.available, false);
  assert.equal(missing.passed, false);
  assert.equal(missing.status, "incomplete");
  assert.match(missing.message, /缺少期初余额/);

  const different = buildBankMonthlyReconciliation({
    ...base,
    transactions: [transaction],
    bankImports: [{ ...importRecord, reconciliation: { openingBalance: 1000, statementClosing: 1200 } }],
  }, { accountId: "bank-operating", period: "2026-08" });
  assert.equal(different.available, true);
  assert.equal(different.passed, false);
  assert.equal(different.status, "difference");
  assert.equal(different.difference, 100);
  assert.match(different.message, /勾稽未完成/);
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

test("XLS 文件也能读取并进入同一映射预览", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["日期", "对方", "摘要", "金额"],
    ["2026-08-01", "客户甲", "课程收入", 100],
  ]), "银行流水");
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xls" });
  const file = Object.assign(new Blob([bytes], { type: "application/vnd.ms-excel" }), { name: "银行流水.xls" });
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

test("本地资料库可按名称、类别、状态和关联业务对象搜索筛选", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const contractFile = Object.assign(new Blob(["contract"], { type: "application/pdf" }), { name: "会员合同.pdf" });
  const noteFile = Object.assign(new Blob(["note"], { type: "text/plain" }), { name: "内部说明.txt" });
  const contractDocument = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: contractFile,
    metadata: { category: "合同", relatedObjectIds: ["contract-member-li"], createdAt: fixedTimestamp },
  });
  await saveLocalDocument({ store, fileVault, workspaceId, file: noteFile, metadata: { category: "其他资料" } });
  const workspace = store.getActiveWorkspace();

  assert.deepEqual(filterLocalDocuments(workspace, { query: "会员合同" }).map((item) => item.id), [contractDocument.id]);
  const relatedMatches = filterLocalDocuments(workspace, { query: "李女士私教会员协议" });
  assert.equal(relatedMatches.some((item) => item.id === contractDocument.id), true);
  assert.equal(relatedMatches.every((item) => getDocumentRelatedObjectIds(workspace, item.id).includes("contract-member-li")), true);
  assert.equal(filterLocalDocuments(workspace, { category: "合同" }).some((item) => item.id === contractDocument.id), true);
  assert.equal(filterLocalDocuments(workspace, { status: "linked" }).some((item) => item.id === contractDocument.id), true);
  assert.equal(filterLocalDocuments(workspace, { status: "unlinked" }).some((item) => item.name === "内部说明.txt"), true);
});

test("资料分类、期间和多个业务关联可修改，也可解除普通关联", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const file = Object.assign(new Blob(["approval"], { type: "application/pdf" }), { name: "待分类.pdf" });
  const document = await saveLocalDocument({ store, fileVault, workspaceId, file });

  updateLocalDocumentMetadata({
    store,
    workspaceId,
    documentId: document.id,
    updatedAt: fixedTimestamp,
    patch: {
      name: "采购审批与合同.pdf",
      category: "审批资料",
      period: "2026-08",
      relatedObjectIds: ["approval-equipment", "contract-member-li"],
    },
  });
  let workspace = store.getActiveWorkspace();
  let updated = workspace.documents.find((item) => item.id === document.id);
  assert.equal(updated.name, "采购审批与合同.pdf");
  assert.equal(updated.category, "审批资料");
  assert.equal(updated.period, "2026-08");
  assert.deepEqual(new Set(getDocumentRelatedObjectIds(workspace, document.id)), new Set(["approval-equipment", "contract-member-li"]));
  assert.equal(workspace.evidenceLinks.some((link) => link.documentIds.includes(document.id) && link.objectIds.length === 2), true);

  updateLocalDocumentMetadata({ store, workspaceId, documentId: document.id, patch: { relatedObjectIds: [] } });
  workspace = store.getActiveWorkspace();
  updated = workspace.documents.find((item) => item.id === document.id);
  assert.deepEqual(updated.relatedObjectIds, []);
  assert.deepEqual(getDocumentRelatedObjectIds(workspace, document.id), []);
  assert.equal(workspace.evidenceLinks.some((link) => link.documentIds.includes(document.id)), false);
});

test("只有未使用资料可以删除，普通业务关联需先解除", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const unused = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["unused"]), { name: "未使用.txt" }),
  });
  await removeLocalDocument({ store, fileVault, workspaceId, documentId: unused.id });
  assert.equal(await fileVault.get(unused.storage.blobId), undefined);
  assert.equal(store.getActiveWorkspace().documents.some((item) => item.id === unused.id), false);

  const linked = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["linked"]), { name: "已关联合同.txt" }),
    metadata: { relatedObjectIds: ["contract-member-li"] },
  });
  assert.match(getLocalDocumentUsage(store.getActiveWorkspace(), linked.id)[0].label, /合同/);
  await assert.rejects(
    () => removeLocalDocument({ store, fileVault, workspaceId, documentId: linked.id }),
    /正在使用，不能删除/,
  );
  updateLocalDocumentMetadata({ store, workspaceId, documentId: linked.id, patch: { relatedObjectIds: [] } });
  await removeLocalDocument({ store, fileVault, workspaceId, documentId: linked.id });
  assert.equal(await fileVault.get(linked.storage.blobId), undefined);
});

test("任意状态的凭证引用和资料归档都会阻止误删", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const voucherDocument = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["draft voucher evidence"]), { name: "草稿凭证附件.txt" }),
  });
  const workspace = store.getActiveWorkspace();
  store.actions.replaceWorkspace(workspaceId, {
    ...workspace,
    vouchers: [...workspace.vouchers, {
      id: "voucher-draft-document-guard",
      no: "记-草稿",
      status: "draft",
      evidenceIds: [voucherDocument.id],
      lines: [],
    }],
  });
  await assert.rejects(
    () => removeLocalDocument({ store, fileVault, workspaceId, documentId: voucherDocument.id }),
    /凭证 记-草稿/,
  );

  const archivedDocument = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["archive"]), { name: "已归档审批.txt" }),
    metadata: { archiveStatus: "archived", lifecycleStatus: "已归档" },
  });
  await assert.rejects(
    () => removeLocalDocument({ store, fileVault, workspaceId, documentId: archivedDocument.id }),
    /资料自身已归档/,
  );
});

test("合同与审批结构化字段写回当前工作台资料记录且明确为人工录入", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const contract = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["contract"]), { name: "场地服务合同.pdf" }),
    metadata: {
      category: "合同",
      structuredData: {
        partyA: "山岚健身工作室",
        partyB: "青禾场地管理有限公司",
        amount: "36000.50",
        serviceStartDate: "2026-09-01",
        serviceEndDate: "2027-08-31",
        settlementCycle: "按月结算",
        refundTerms: "提前 30 日书面通知，按未履行月份退款",
        commissionTerms: "不适用",
      },
    },
  });
  let persisted = store.getActiveWorkspace().documents.find((item) => item.id === contract.id);
  assert.deepEqual(persisted.structuredData, {
    kind: "contract",
    partyA: "山岚健身工作室",
    partyB: "青禾场地管理有限公司",
    amount: 36000.5,
    serviceStartDate: "2026-09-01",
    serviceEndDate: "2027-08-31",
    settlementCycle: "按月结算",
    refundTerms: "提前 30 日书面通知，按未履行月份退款",
    commissionTerms: "不适用",
  });
  assert.deepEqual(persisted.contentRecognition, { mode: "manual", ocrStatus: "not_connected" });

  const approval = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["approval"]), { name: "采购审批单.pdf" }),
    metadata: { category: "审批资料" },
  });
  updateLocalDocumentMetadata({
    store,
    workspaceId,
    documentId: approval.id,
    patch: {
      structuredData: {
        approvalType: "采购付款",
        applicant: "陈教练",
        amount: "3680",
        approvalStatus: "approved",
      },
    },
  });
  persisted = store.getActiveWorkspace().documents.find((item) => item.id === approval.id);
  assert.deepEqual(persisted.structuredData, {
    kind: "approval",
    approvalType: "采购付款",
    applicant: "陈教练",
    amount: 3680,
    approvalStatus: "approved",
  });
  assert.deepEqual(persisted.contentRecognition, { mode: "manual", ocrStatus: "not_connected" });
});

test("发票结构化状态可保存，发票号码在新增和编辑入口都拒绝重复", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const first = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["invoice-1"]), { name: "电费发票一.pdf" }),
    metadata: {
      category: "发票",
      structuredData: {
        invoiceNumber: "FP-2026-0001",
        invoiceDate: "2026-09-04",
        amount: "1130",
        taxAmount: "130",
        taxRate: "13",
        verificationStatus: "verified",
        redLetterStatus: "normal",
        voidStatus: "valid",
        certificationStatus: "certified",
      },
    },
  });
  const persisted = store.getActiveWorkspace().documents.find((item) => item.id === first.id);
  assert.deepEqual(persisted.structuredData, {
    kind: "invoice",
    invoiceNumber: "FP-2026-0001",
    invoiceDate: "2026-09-04",
    amount: 1130,
    taxAmount: 130,
    taxRate: 13,
    verificationStatus: "verified",
    redLetterStatus: "normal",
    voidStatus: "valid",
    certificationStatus: "certified",
  });
  assert.equal(filterLocalDocuments(store.getActiveWorkspace(), { query: "FP-2026-0001" }).some((item) => item.id === first.id), true);

  await assert.rejects(() => saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["duplicate"]), { name: "重复发票.pdf" }),
    metadata: { category: "发票", structuredData: { invoiceNumber: " fp-2026-0001 " } },
  }), /发票号码.*已存在/);
  assert.equal((await fileVault.listByWorkspace(workspaceId)).length, 1, "重复号码应在 Blob 落库前被拒绝");

  const second = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["invoice-2"]), { name: "电费发票二.pdf" }),
    metadata: { category: "发票", structuredData: { invoiceNumber: "FP-2026-0002" } },
  });
  assert.throws(() => updateLocalDocumentMetadata({
    store,
    workspaceId,
    documentId: second.id,
    patch: { structuredData: { invoiceNumber: "FP-2026-0001" } },
  }), /发票号码.*已存在/);
  assert.equal(store.getActiveWorkspace().documents.find((item) => item.id === second.id).structuredData.invoiceNumber, "FP-2026-0002");
});

test("结构化金额、税率和合同服务期限拒绝明显无效输入", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  await assert.rejects(() => saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["invalid contract"]), { name: "期限错误.pdf" }),
    metadata: { category: "合同", structuredData: { serviceStartDate: "2026-10-01", serviceEndDate: "2026-09-01" } },
  }), /服务结束日期不能早于开始日期/);
  await assert.rejects(() => saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["invalid invoice"]), { name: "税率错误.pdf" }),
    metadata: { category: "发票", structuredData: { invoiceNumber: "FP-INVALID", taxRate: 101 } },
  }), /发票税率不能大于 100/);
});

test("资料匹配建议解释对方、金额和日期依据，但生成建议不会自动关联", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const initial = store.getActiveWorkspace();
  store.actions.replaceWorkspace(workspaceId, {
    ...initial,
    transactions: [{
      id: "txn-document-match",
      accountId: initial.bankAccounts[0].id,
      date: "2026-09-04",
      businessPeriod: "2026-09",
      amount: -3680,
      counterparty: "力行器械",
      summary: "力量器械采购付款",
      status: "pending",
      classification: { eventType: "purchaseExpense", confidence: 96, riskFlags: [] },
      evidenceIds: [],
    }],
    businessEvents: [],
    documents: [],
    evidenceLinks: [],
    exceptionTasks: [],
  });
  const invoice = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["invoice"]), { name: "力行器械采购发票.pdf" }),
    metadata: {
      category: "发票",
      period: "2026-09",
      structuredData: { invoiceNumber: "MATCH-INV-001", invoiceDate: "2026-09-04", amount: 3680 },
    },
  });
  await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["approval"]), { name: "力量器械采购审批单.pdf" }),
    metadata: {
      category: "审批资料",
      period: "2026-09",
      structuredData: { approvalType: "采购付款", applicant: "王店长", amount: 3680, approvalStatus: "approved" },
    },
  });

  const suggestions = buildDocumentMatchSuggestions(store.getActiveWorkspace());
  const invoiceSuggestion = suggestions.find((item) => item.documentId === invoice.id && item.sourceId === "txn-document-match");
  assert.ok(invoiceSuggestion);
  assert.equal(invoiceSuggestion.sourceType, "bankTransaction");
  assert.equal(invoiceSuggestion.reasons.some((reason) => reason.includes("对方")), true);
  assert.equal(invoiceSuggestion.reasons.some((reason) => reason.includes("金额一致")), true);
  assert.equal(invoiceSuggestion.reasons.some((reason) => reason.includes("日期")), true);
  assert.deepEqual(store.getActiveWorkspace().evidenceLinks, []);
  assert.deepEqual(store.getActiveWorkspace().transactions[0].evidenceIds, []);
  assert.deepEqual(store.getActiveWorkspace().documents.find((item) => item.id === invoice.id).relatedObjectIds, []);
});

test("人工确认后建立三方关联，并按资料类型逐项自动关闭缺件待办", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const initial = store.getActiveWorkspace();
  store.actions.replaceWorkspace(workspaceId, {
    ...initial,
    transactions: [{
      id: "txn-document-confirm",
      accountId: initial.bankAccounts[0].id,
      date: "2026-09-04",
      businessPeriod: "2026-09",
      amount: -3680,
      counterparty: "力行器械",
      summary: "力量器械采购付款",
      status: "pending",
      classification: { eventType: "purchaseExpense", confidence: 96, riskFlags: [] },
      evidenceIds: [],
    }],
    businessEvents: [],
    documents: [],
    evidenceLinks: [],
    exceptionTasks: [],
  });
  const invoice = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["invoice"]), { name: "力行器械采购发票.pdf" }),
    metadata: { category: "发票", period: "2026-09", structuredData: { invoiceNumber: "CONFIRM-INV-001", invoiceDate: "2026-09-04", amount: 3680 } },
  });
  const approval = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["approval"]), { name: "力量器械采购审批单.pdf" }),
    metadata: { category: "审批资料", period: "2026-09", structuredData: { approvalType: "采购付款", amount: 3680, approvalStatus: "approved" } },
  });
  const refreshed = refreshDocumentMissingTasks({ store, workspaceId, actor: "测试会计", at: fixedTimestamp });
  assert.equal(refreshed.created, 2);
  assert.equal(refreshed.open, 2);

  let suggestion = buildDocumentMatchSuggestions(store.getActiveWorkspace()).find((item) => item.documentId === invoice.id);
  const invoiceResult = confirmDocumentMatch({ store, workspaceId, suggestionId: suggestion.id, actor: "测试会计", at: fixedTimestamp });
  assert.equal(invoiceResult.closedTaskCount, 1);
  let workspace = store.getActiveWorkspace();
  let transaction = workspace.transactions.find((item) => item.id === "txn-document-confirm");
  assert.equal(transaction.evidenceIds.includes(invoice.id), true);
  assert.equal(transaction.documentIds.includes(invoice.id), true);
  assert.equal(workspace.documents.find((item) => item.id === invoice.id).relatedObjectIds.includes(transaction.id), true);
  assert.equal(workspace.evidenceLinks.some((link) => link.documentIds.includes(invoice.id) && link.objectIds.includes(transaction.id) && link.relation === "confirmed-document-match"), true);
  assert.equal(workspace.exceptionTasks.find((task) => task.identity.endsWith(":invoice")).status, "resolved");
  assert.equal(workspace.exceptionTasks.find((task) => task.identity.endsWith(":approval")).status, "open");

  suggestion = buildDocumentMatchSuggestions(workspace).find((item) => item.documentId === approval.id);
  const approvalResult = confirmDocumentMatch({ store, workspaceId, suggestionId: suggestion.id, actor: "测试会计", at: fixedTimestamp });
  assert.equal(approvalResult.closedTaskCount, 1);
  workspace = store.getActiveWorkspace();
  assert.equal(workspace.exceptionTasks.filter((task) => task.code === "missing_document" && task.status !== "resolved").length, 0);
});

test("业务事件也可人工确认资料建议，手续费和内部转账不会制造无关缺件", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const initial = store.getActiveWorkspace();
  store.actions.replaceWorkspace(workspaceId, {
    ...initial,
    transactions: [
      { id: "txn-fee-no-doc", date: "2026-09-03", amount: -25, summary: "银行账户管理手续费", classification: { eventType: "bankFee" }, evidenceIds: [] },
      { id: "txn-transfer-no-doc", date: "2026-09-03", amount: -2000, summary: "内部账户划转", classification: { eventType: "internalTransfer" }, evidenceIds: [] },
    ],
    businessEvents: [{
      id: "event-rent-document-match",
      type: "rentAndProperty",
      date: "2026-09-01",
      businessPeriod: "2026-09",
      amount: 1800,
      counterparty: "青禾场地管理有限公司",
      summary: "九月场地租赁",
      evidenceIds: [],
    }],
    documents: [],
    evidenceLinks: [],
    exceptionTasks: [],
  });
  const contract = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["rent contract"]), { name: "青禾场地管理有限公司租赁合同.pdf" }),
    metadata: {
      category: "合同",
      period: "2026-09",
      structuredData: {
        partyA: "山岚健身工作室",
        partyB: "青禾场地管理有限公司",
        amount: 1800,
        serviceStartDate: "2026-09-01",
        serviceEndDate: "2026-09-30",
      },
    },
  });
  const missing = getDocumentMissingRequirements(store.getActiveWorkspace());
  assert.equal(missing.some((item) => ["txn-fee-no-doc", "txn-transfer-no-doc"].includes(item.sourceId)), false);
  assert.deepEqual(new Set(missing.filter((item) => item.sourceId === "event-rent-document-match").map((item) => item.label)), new Set(["合同", "发票", "审批单"]));

  const suggestion = buildDocumentMatchSuggestions(store.getActiveWorkspace()).find((item) => item.documentId === contract.id && item.sourceType === "businessEvent");
  assert.ok(suggestion);
  assert.equal(store.getActiveWorkspace().businessEvents[0].evidenceIds.length, 0);
  confirmDocumentMatch({ store, workspaceId, suggestionId: suggestion.id, actor: "测试会计", at: fixedTimestamp });
  const workspace = store.getActiveWorkspace();
  const event = workspace.businessEvents.find((item) => item.id === "event-rent-document-match");
  assert.equal(event.evidenceIds.includes(contract.id), true);
  assert.equal(event.documentIds.includes(contract.id), true);
  assert.equal(workspace.documents.find((item) => item.id === contract.id).relatedObjectIds.includes(event.id), true);
  assert.equal(workspace.exceptionTasks.find((task) => task.identity.endsWith(":contract")).status, "resolved");
});

test("凭证附件包按固定顺序保留关联原文件并写回本地生成记录", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const initial = store.getActiveWorkspace();
  store.actions.replaceWorkspace(workspaceId, {
    ...initial,
    currentPeriod: "2026-09",
    transactions: [{
      id: "txn-voucher-package",
      accountId: initial.bankAccounts[0].id,
      date: "2026-09-04",
      businessPeriod: "2026-09",
      amount: -3680,
      counterparty: "力行器械",
      summary: "力量器械采购付款",
      classification: { eventType: "purchaseExpense", confidence: 96, riskFlags: [] },
      evidenceIds: [],
      documentIds: [],
      allocations: [],
    }],
    businessEvents: [],
    bills: [],
    documents: [],
    evidenceLinks: [],
    exceptionTasks: [],
    vouchers: [{
      id: "voucher-package-001",
      no: "记-088",
      date: "2026-09-04",
      period: "2026-09",
      summary: "支付力量器械采购款",
      status: "posted",
      version: 1,
      sourceIds: ["txn-voucher-package"],
      evidenceIds: [],
      lines: [
        { account: "equipment", debit: 3680, credit: 0, sourceIds: ["txn-voucher-package"] },
        { account: initial.bankAccounts[0].id, debit: 0, credit: 3680, sourceIds: ["txn-voucher-package"] },
      ],
      judgement: { eventType: "purchaseExpense", confidence: 96, reasons: ["已匹配采购付款"], note: "人工确认" },
      reviews: [{ id: "review-package-001", actor: "复核会计", note: "金额与附件一致", at: fixedTimestamp }],
    }],
    confirmations: [{
      id: "confirmation-package-001",
      kind: "voucher",
      status: "approved",
      sourceIds: ["voucher-package-001"],
      decisions: [{ id: "decision-package-001", decision: "approve", actor: "负责人", at: fixedTimestamp }],
    }],
    auditLog: [{
      id: "audit-package-001",
      at: fixedTimestamp,
      actor: "测试会计",
      action: "voucher.review",
      entityType: "voucher",
      entityId: "voucher-package-001",
      detail: "凭证复核通过",
      sourceIds: ["voucher-package-001", "txn-voucher-package"],
    }],
  });

  const files = [
    ["银行回单.pdf", "银行流水", "bank receipt"],
    ["采购发票.pdf", "发票", "invoice original"],
    ["采购订单.pdf", "合同", "order original"],
    ["付款审批单.pdf", "审批资料", "approval original"],
    ["询价匹配附件.txt", "其他资料", "matching original"],
  ];
  for (const [name, category, content] of files) {
    await saveLocalDocument({
      store,
      fileVault,
      workspaceId,
      file: Object.assign(new Blob([content]), { name }),
      metadata: { category, period: "2026-09", relatedObjectIds: ["txn-voucher-package"] },
    });
  }

  const plan = buildVoucherAttachmentPackagePlan(store.getActiveWorkspace(), "voucher-package-001");
  assert.deepEqual(plan.sections.map((section) => section.label), ["银行回单", "发票", "合同/订单", "审批单", "确认记录", "匹配说明", "复核记录", "缺失资料清单"]);
  assert.equal(plan.sections.every((section) => section.status === "collected"), true);
  assert.equal(plan.missingItems.length, 0);
  assert.equal(store.getActiveWorkspace().vouchers[0].attachmentPackages, undefined);

  const result = await generateVoucherAttachmentPackage({
    store,
    fileVault,
    workspaceId,
    voucherId: "voucher-package-001",
    packageId: "voucher-attachment-package-001",
    actor: "测试会计",
    at: fixedTimestamp,
    download: false,
  });
  assert.equal(result.manifest.localOnly, true);
  assert.equal(result.manifest.externalUpload, false);
  assert.equal(result.manifest.files.length, 5);
  assert.equal(result.manifest.files.every((file) => file.hash), true);
  assert.equal(result.manifest.sourceRelationships.sources.some((source) => source.id === "txn-voucher-package"), true);

  const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
  assert.equal(await zip.file("01-银行回单/银行回单.pdf").async("string"), "bank receipt");
  assert.equal(await zip.file("02-发票/采购发票.pdf").async("string"), "invoice original");
  assert.equal(await zip.file("03-合同-订单/采购订单.pdf").async("string"), "order original");
  assert.equal(await zip.file("04-审批单/付款审批单.pdf").async("string"), "approval original");
  assert.equal(await zip.file("06-匹配说明/询价匹配附件.txt").async("string"), "matching original");
  assert.ok(zip.file("凭证.json"));
  assert.ok(zip.file("来源关系.json"));
  assert.ok(zip.file("哈希清单.json"));
  assert.ok(zip.file("08-缺失资料清单/缺失资料清单.json"));
  const zippedManifest = JSON.parse(await zip.file("附件包清单.json").async("string"));
  assert.equal(zippedManifest.voucher.id, "voucher-package-001");
  assert.equal(zippedManifest.hashes.length, 5);

  const updatedVoucher = store.getActiveWorkspace().vouchers.find((voucher) => voucher.id === "voucher-package-001");
  assert.equal(updatedVoucher.attachmentPackages.length, 1);
  assert.equal(updatedVoucher.attachmentPackages[0].id, "voucher-attachment-package-001");
  assert.equal(updatedVoucher.attachmentPackages[0].localOnly, true);
  assert.equal(updatedVoucher.attachmentPackages[0].externalUpload, false);
  assert.equal(store.getActiveWorkspace().auditLog.at(-1).action, "生成凭证附件包");
});

test("附件包会明确列出未关联与本机缺失的资料，仍可生成缺件清单", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const initial = store.getActiveWorkspace();
  store.actions.replaceWorkspace(workspaceId, {
    ...initial,
    transactions: [{
      id: "txn-voucher-package-missing",
      date: "2026-09-04",
      amount: -500,
      summary: "采购付款",
      classification: { eventType: "purchaseExpense", confidence: 90, riskFlags: [] },
      evidenceIds: ["doc-vault-missing"],
      documentIds: ["doc-vault-missing"],
      allocations: [],
    }],
    businessEvents: [],
    documents: [{
      id: "doc-vault-missing",
      name: "本机已删除的发票.pdf",
      category: "发票",
      hash: "unavailable-hash",
      relatedObjectIds: ["txn-voucher-package-missing"],
      storage: { mode: "indexeddb", blobId: "doc-vault-missing", availableLocally: false, externalUpload: false },
    }],
    evidenceLinks: [],
    exceptionTasks: [],
    confirmations: [],
    auditLog: [],
    vouchers: [{
      id: "voucher-package-missing",
      no: "记-089",
      date: "2026-09-04",
      period: "2026-09",
      summary: "采购付款",
      status: "draft",
      version: 1,
      sourceIds: ["txn-voucher-package-missing"],
      evidenceIds: ["doc-vault-missing"],
      lines: [],
      judgement: { eventType: "purchaseExpense", confidence: 90, reasons: ["采购付款"] },
      reviews: [],
    }],
  });

  const plan = buildVoucherAttachmentPackagePlan(store.getActiveWorkspace(), "voucher-package-missing");
  assert.equal(plan.missingItems.some((item) => item.documentId === "doc-vault-missing"), true);
  assert.equal(plan.missingItems.some((item) => item.sectionKey === "bankReceipt"), true);
  assert.equal(plan.missingItems.some((item) => item.sectionKey === "approval"), true);
  assert.equal(plan.missingItems.some((item) => item.sectionKey === "confirmation"), true);
  assert.equal(plan.missingItems.some((item) => item.sectionKey === "review"), true);

  const result = await generateVoucherAttachmentPackage({
    store,
    fileVault,
    workspaceId,
    voucherId: "voucher-package-missing",
    packageId: "voucher-attachment-package-missing",
    actor: "测试会计",
    at: fixedTimestamp,
    download: false,
  });
  assert.equal(result.manifest.files.length, 0);
  assert.equal(result.manifest.missingItems.length >= plan.missingItems.length, true);
  const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
  const missingList = JSON.parse(await zip.file("08-缺失资料清单/缺失资料清单.json").async("string"));
  assert.equal(missingList.some((item) => item.documentId === "doc-vault-missing"), true);
  assert.equal(store.getActiveWorkspace().vouchers[0].attachmentPackages[0].missingItems.length, result.manifest.missingItems.length);
});

test("完整月度财务档案包含全部快照、真实回执原文件与统一哈希，但不改动正式归档", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const initial = store.getActiveWorkspace();
  const bankAccountId = initial.bankAccounts[0].id;
  const reportSnapshot = {
    summary: {
      engineChecks: {
        trialBalance: { passed: true },
        balanceSheet: { passed: true },
        cashMovement: { passed: true },
      },
    },
    sections: {
      balance: { label: "资产负债表", rows: [] },
      income: { label: "利润表", rows: [] },
      cashflow: { label: "现金流量表", rows: [] },
      owner: { label: "管理报表", rows: [] },
    },
    taxWorkpaper: {
      rows: [
        { id: "payroll", label: "工资薪金", value: 5000 },
        { id: "socialSecurity", label: "社保数据", value: 1000 },
      ],
    },
  };
  store.actions.replaceWorkspace(workspaceId, {
    ...initial,
    currentPeriod: "2026-09",
    periods: ["2026-09"],
    transactions: [{
      id: "txn-monthly-archive",
      accountId: bankAccountId,
      date: "2026-09-04",
      businessPeriod: "2026-09",
      amount: -20,
      summary: "银行手续费",
      status: "posted",
      classification: { eventType: "bankFee", confidence: 99, riskFlags: [] },
      evidenceIds: [],
      documentIds: [],
      allocations: [],
    }],
    businessEvents: [],
    bills: [],
    documents: [],
    evidenceLinks: [],
    vouchers: [{
      id: "voucher-monthly-archive",
      no: "记-090",
      date: "2026-09-04",
      period: "2026-09",
      summary: "计提银行手续费",
      status: "posted",
      version: 1,
      sourceIds: ["txn-monthly-archive"],
      evidenceIds: [],
      lines: [
        { account: "expenseFee", debit: 20, credit: 0, sourceIds: ["txn-monthly-archive"] },
        { account: bankAccountId, debit: 0, credit: 20, sourceIds: ["txn-monthly-archive"] },
      ],
      judgement: { eventType: "bankFee", confidence: 99, reasons: ["银行手续费"] },
      reviews: [{ id: "review-monthly-archive", actor: "复核会计", note: "复核通过", at: fixedTimestamp }],
    }],
    exceptionTasks: [],
    confirmations: [{
      id: "confirmation-monthly-archive",
      kind: "tax",
      period: "2026-09",
      reportVersionId: "report-monthly-archive",
      status: "approved",
      sourceIds: ["voucher-monthly-archive"],
      decisions: [{ id: "decision-monthly-archive", decision: "approve", actor: "客户负责人", at: fixedTimestamp }],
    }],
    reportVersions: [],
    tax: {
      ...initial.tax,
      period: "2026-09",
      payroll: 5000,
      socialSecurity: 1000,
      financeConfirmedAt: fixedTimestamp,
      payrollConfirmedAt: fixedTimestamp,
      ownerConfirmedAt: fixedTimestamp,
      confirmedBy: "客户负责人",
      financeConfirmedVersionId: "report-monthly-archive",
      payrollConfirmedVersionId: "report-monthly-archive",
      ownerConfirmedVersionId: "report-monthly-archive",
    },
    auditLog: [{
      id: "audit-monthly-archive",
      at: fixedTimestamp,
      actor: "复核会计",
      action: "voucher.review",
      entityType: "voucher",
      entityId: "voucher-monthly-archive",
      detail: "凭证复核通过",
      sourceIds: ["voucher-monthly-archive", "txn-monthly-archive"],
    }],
    delivery: {
      ...initial.delivery,
      reportVersions: [{
        id: "report-monthly-archive",
        period: "2026-09",
        label: "V1",
        createdAt: fixedTimestamp,
        frozen: true,
        snapshot: reportSnapshot,
      }],
      filing: {
        ...initial.delivery.filing,
        period: "2026-09",
        draftCreatedAt: fixedTimestamp,
        draftVersionId: "report-monthly-archive",
        initialConfirmationId: "confirmation-monthly-archive",
        finalConfirmedVersionId: "report-monthly-archive",
        exportedAt: fixedTimestamp,
        exportedPackage: {
          id: "filing-package-monthly-archive",
          fileName: "FinanceDesk-2026-09-本地申报包.zip",
          hash: "filing-package-hash",
          reportVersionId: "report-monthly-archive",
        },
        receipt: null,
      },
      archives: [],
      notices: [],
    },
  });

  await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["bank receipt original"]), { name: "9月银行手续费回单.pdf" }),
    metadata: { category: "银行流水", period: "2026-09", relatedObjectIds: ["txn-monthly-archive"], createdAt: fixedTimestamp },
  });
  const receiptDocument = await saveLocalDocument({
    store,
    fileVault,
    workspaceId,
    file: Object.assign(new Blob(["official filing receipt"]), { name: "电子税务局真实回执.pdf" }),
    metadata: { category: "申报回执", period: "2026-09", deliveryArtifact: true, createdAt: fixedTimestamp },
  });
  const withReceipt = store.getActiveWorkspace();
  store.actions.replaceWorkspace(workspaceId, {
    ...withReceipt,
    delivery: {
      ...withReceipt.delivery,
      filing: {
        ...withReceipt.delivery.filing,
        receipt: {
          id: "receipt-monthly-archive",
          name: receiptDocument.name,
          documentId: receiptDocument.id,
          hash: receiptDocument.hash,
          storage: receiptDocument.storage,
          importedAt: fixedTimestamp,
          reportVersionId: "report-monthly-archive",
          packageId: "filing-package-monthly-archive",
          packageHash: "filing-package-hash",
        },
      },
    },
  });

  const plan = buildMonthlyFinancialArchivePlan(store.getActiveWorkspace(), "2026-09");
  assert.equal(getMonthlyFinancialArchivePeriods(store.getActiveWorkspace()).includes("2026-09"), true);
  assert.equal(plan.isComplete, true);
  assert.equal(plan.sections.length, 10);
  assert.equal(plan.missingItems.length, 0);
  assert.equal(store.getActiveWorkspace().delivery.financialArchiveExports, undefined);
  const previousOfficialArchives = store.getActiveWorkspace().delivery.archives.length;

  const result = await generateMonthlyFinancialArchivePackage({
    store,
    fileVault,
    workspaceId,
    period: "2026-09",
    packageId: "monthly-financial-archive-complete",
    actor: "测试会计",
    at: fixedTimestamp,
    download: false,
  });
  assert.equal(result.manifest.isComplete, true);
  assert.equal(result.manifest.status, "complete");
  assert.match(result.fileName, /完整财务档案\.zip$/);
  assert.doesNotMatch(result.fileName, /草稿/);
  assert.equal(result.manifest.localOnly, true);
  assert.equal(result.manifest.officialPeriodArchiveChanged, false);

  const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
  assert.equal(await zip.file("07-真实回执/电子税务局真实回执.pdf").async("string"), "official filing receipt");
  assert.ok(zip.file("01-凭证与分录/凭证与分录.json"));
  assert.ok(zip.file("02-凭证附件/附件包与附件清单.json"));
  assert.ok(zip.file("03-财务与管理报表/资产负债表.json"));
  assert.ok(zip.file("03-财务与管理报表/利润表.json"));
  assert.ok(zip.file("03-财务与管理报表/现金流量表.json"));
  assert.ok(zip.file("03-财务与管理报表/管理报表.json"));
  assert.ok(zip.file("04-税务申报/税务申报底稿.json"));
  assert.ok(zip.file("05-工资社保/工资与社保数据.json"));
  assert.ok(zip.file("06-客户确认/第一次客户确认.json"));
  assert.ok(zip.file("06-客户确认/第二次最终确认.json"));
  assert.ok(zip.file("08-异常处理/异常处理记录.json"));
  assert.ok(zip.file("09-操作日志/操作日志.json"));
  const hashManifest = JSON.parse(await zip.file("统一哈希清单.json").async("string"));
  assert.equal(hashManifest.files.some((file) => file.path === "07-真实回执/电子税务局真实回执.pdf" && file.hash), true);
  assert.equal(hashManifest.files.every((file) => file.hash), true);
  assert.equal(hashManifest.selfExcluded.includes("自身哈希"), true);

  const updatedWorkspace = store.getActiveWorkspace();
  assert.equal(updatedWorkspace.delivery.archives.length, previousOfficialArchives);
  assert.equal(updatedWorkspace.delivery.financialArchiveExports.length, 1);
  assert.equal(updatedWorkspace.delivery.financialArchiveExports[0].status, "complete");
  assert.equal(updatedWorkspace.delivery.financialArchiveExports[0].officialPeriodArchiveChanged, false);
});

test("月度档案缺少必需项目时只能导出名称和清单明确的不完整草稿包", async () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const workspaceId = store.getState().activeWorkspaceId;
  const before = store.getActiveWorkspace();
  const officialArchiveCount = before.delivery.archives.length;
  const plan = buildMonthlyFinancialArchivePlan(before, before.currentPeriod);

  assert.equal(plan.isComplete, false);
  assert.equal(plan.status, "incomplete_draft");
  assert.equal(plan.missingItems.some((item) => item.sectionKey === "reports"), true);
  assert.equal(plan.missingItems.some((item) => item.sectionKey === "receipt"), true);
  assert.equal(plan.missingItems.some((item) => item.sectionKey === "initialConfirmation"), true);
  assert.equal(before.delivery.financialArchiveExports, undefined);

  const result = await generateMonthlyFinancialArchivePackage({
    store,
    fileVault,
    workspaceId,
    period: before.currentPeriod,
    packageId: "monthly-financial-archive-draft",
    actor: "测试会计",
    at: fixedTimestamp,
    download: false,
  });
  assert.equal(result.manifest.isComplete, false);
  assert.equal(result.manifest.status, "incomplete_draft");
  assert.match(result.fileName, /不完整财务档案草稿\.zip$/);
  assert.equal(result.manifest.missingItems.length, plan.missingItems.length);

  const zip = await JSZip.loadAsync(await result.archive.arrayBuffer());
  const zippedManifest = JSON.parse(await zip.file("档案包清单.json").async("string"));
  assert.equal(zippedManifest.isComplete, false);
  assert.equal(zippedManifest.missingItems.length, plan.missingItems.length);
  assert.ok(zip.file("统一哈希清单.json"));
  const after = store.getActiveWorkspace();
  assert.equal(after.delivery.archives.length, officialArchiveCount);
  assert.equal(after.delivery.financialArchiveExports[0].status, "incomplete_draft");
  assert.equal(after.auditLog.at(-1).action, "导出不完整月度财务草稿包");
});
