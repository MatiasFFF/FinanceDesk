import assert from "node:assert/strict";
import test from "node:test";

import {
  accountDefinition,
  buildFinancialStatements,
  buildTaxWorkpaper,
  createAccountingFixture,
  createCustomerConfirmationPackage,
  freezeReportVersion as freezeAccountingReportVersion,
  recordCustomerConfirmation,
} from "../src/domain/accounting/index.js";
import {
  createInitialState,
  normalizeWorkspace,
} from "../src/domain/foundation.js";
import {
  createLocalFoundationRepository,
  createMemoryStorage,
} from "../src/storage/localFoundationRepository.js";
import { createFinanceDeskStore } from "../src/store/financeDeskStore.js";
import {
  PRIMARY_NAV,
  PRODUCT_NAME,
  archivePeriod,
  attachReceipt,
  buildReportSnapshot,
  enterNextPeriod,
  ensureWorkspace,
  freezeReportVersion,
  markPackageExported,
  prepareFilingDraft,
  workflowChecks,
  workflowSourceFingerprint,
} from "../src/productWorkflow.js";

const fixedNow = () => new Date("2026-09-04T08:00:00.000Z");

function integratedStore(workspace) {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const state = createInitialState({ now: fixedNow });
  const normalized = normalizeWorkspace(ensureWorkspace(workspace), { now: fixedNow });
  repository.save({
    ...state,
    activeWorkspaceId: normalized.id,
    workspaces: [normalized],
  });
  return {
    repository,
    store: createFinanceDeskStore({ repository }),
  };
}

function closeableWorkspace() {
  const workspace = normalizeWorkspace(ensureWorkspace(createAccountingFixture()), { now: fixedNow });
  workspace.transactions = workspace.transactions.map((transaction) => ({ ...transaction, status: "ignored" }));
  workspace.vouchers = workspace.vouchers.map((voucher) => ({ ...voucher, status: "posted" }));
  workspace.exceptionTasks = [];
  workspace.bankImports = [];
  return workspace;
}

test("product identity and the complete local foundation remain reachable from primary navigation", () => {
  assert.equal(PRODUCT_NAME, "财务工作台");
  assert.equal(PRIMARY_NAV.some((item) => item.id === "setup" && item.label === "基础资料"), true);
});

test("one repository preserves product workflow and accounting-engine fields across reloads", () => {
  const fixture = createAccountingFixture();
  fixture.id = "workspace-integrated";
  fixture.name = "集成测试工作台";
  const { repository, store } = integratedStore(fixture);
  const current = store.getActiveWorkspace();

  store.actions.replaceWorkspace(current.id, {
    ...current,
    delivery: {
      reportVersions: [{ id: "delivery-v1", period: current.currentPeriod, label: "V1" }],
      filing: { period: current.currentPeriod, draftCreatedAt: "2026-09-04T08:01:00.000Z" },
      archives: [],
      notices: [],
    },
    reportVersions: [{ id: "engine-report-1", period: current.currentPeriod, status: "frozen" }],
    confirmations: [{ id: "confirmation-1", period: current.currentPeriod, status: "approved" }],
    exceptionTasks: [{ id: "exception-1", sourceId: current.transactions[0].id, status: "resolved" }],
  });

  const reloaded = createFinanceDeskStore({ repository }).getActiveWorkspace();
  assert.equal(reloaded.delivery.reportVersions[0].id, "delivery-v1");
  assert.equal(reloaded.reportVersions[0].id, "engine-report-1");
  assert.equal(reloaded.confirmations[0].status, "approved");
  assert.equal(reloaded.exceptionTasks[0].status, "resolved");
});

test("whole-workspace updates remain isolated when another workspace is created", () => {
  const fixture = createAccountingFixture();
  fixture.id = "workspace-one";
  fixture.name = "第一工作台";
  const { store } = integratedStore(fixture);
  const first = store.getActiveWorkspace();
  const second = store.actions.createWorkspace({ name: "第二工作台" });

  store.actions.replaceWorkspace(second.id, {
    ...second,
    tax: { ...second.tax, note: "只属于第二工作台" },
    delivery: { ...ensureWorkspace(second).delivery, notices: [{ id: "notice-second" }] },
  });

  const state = store.getState();
  assert.equal(state.workspaces.find((item) => item.id === first.id).tax.note || "", "");
  assert.equal(state.workspaces.find((item) => item.id === second.id).tax.note, "只属于第二工作台");
  assert.equal(state.workspaces.find((item) => item.id === second.id).delivery.notices[0].id, "notice-second");
});

test("the visible report snapshot uses the accounting engine for statements and tax workpaper", () => {
  const workspace = ensureWorkspace(createAccountingFixture());
  const snapshot = buildReportSnapshot(workspace);
  const statements = buildFinancialStatements(workspace, { period: workspace.currentPeriod });
  const tax = buildTaxWorkpaper(workspace, { period: workspace.currentPeriod });

  assert.equal(snapshot.summary.revenue, statements.incomeStatement.netRevenue.value);
  assert.equal(snapshot.summary.profit, statements.incomeStatement.profit.value);
  assert.equal(snapshot.summary.assets, statements.balanceSheet.assets.value);
  assert.equal(snapshot.summary.difference, statements.balanceSheet.difference.value);
  assert.equal(
    snapshot.taxWorkpaper.rows.find((row) => row.id === "vatPayable").value,
    tax.vatPayable.value,
  );
  assert.equal(Object.values(snapshot.summary.engineChecks).every((check) => typeof check.passed === "boolean"), true);
  assert.equal(snapshot.sections.cashflow.rows.find((row) => row.id === "netCash").value, statements.cashFlow.netChange.value);
});

test("report totals retain formulas and voucher-level detail whose amounts reconcile to the visible number", () => {
  const workspace = ensureWorkspace(createAccountingFixture());
  const snapshot = buildReportSnapshot(workspace);
  const sumDetails = (row) => Math.round(row.details.reduce((sum, item) => sum + Number(item.amount || 0), 0) * 100) / 100;
  const assets = snapshot.sections.balance.rows.find((row) => row.id === "assets");
  const profit = snapshot.sections.income.rows.find((row) => row.id === "profit");
  const ownerGrossProfit = snapshot.sections.owner.rows.find((row) => row.id === "ownerGrossProfit");

  assert.match(assets.formula, /资产类科目/);
  assert.equal(sumDetails(assets), assets.value);
  assert.match(profit.formula, /营业收入/);
  assert.equal(sumDetails(profit), profit.value);
  assert.equal(ownerGrossProfit.details.length > 0, true);
});

test("a real product bank account id is treated as cash and enters the statements", () => {
  const workspace = createInitialState({ now: fixedNow }).workspaces[0];
  const account = workspace.bankAccounts[0];
  const definition = accountDefinition(account.id, workspace);
  assert.equal(definition.category, "asset");
  assert.equal(definition.cash, true);
});

test("only posted and explicitly ignored items stop blocking the product close workflow", () => {
  const workspace = ensureWorkspace(createAccountingFixture());
  workspace.transactions = workspace.transactions.slice(0, 4).map((transaction, index) => ({
    ...transaction,
    date: workspace.currentPeriod + "-15",
    status: ["posted", "ignored", "pending", "reconciled"][index],
  }));

  const flow = workflowChecks(workspace);
  assert.deepEqual(flow.unresolved.map((item) => item.status), ["pending", "reconciled"]);
});

test("an inherited open notice is visible to the workflow and blocks a new close until resolved", () => {
  const workspace = ensureWorkspace(createAccountingFixture());
  workspace.transactions = workspace.transactions.map((transaction) => ({ ...transaction, status: "ignored" }));
  workspace.exceptionTasks = [];
  workspace.delivery.notices = [{
    id: "carry-2026-08-txn-old",
    period: workspace.currentPeriod,
    sourceId: "txn-old",
    status: "open",
    message: "上期待处理事项",
    amount: 88,
  }];

  const blocked = workflowChecks(workspace);
  assert.equal(blocked.openNotices.length, 1);
  assert.equal(blocked.checks.find((item) => item.id === "exceptions").ok, false);

  workspace.delivery.notices[0].status = "resolved";
  const resolved = workflowChecks(workspace);
  assert.equal(resolved.openNotices.length, 0);
  assert.equal(resolved.checks.find((item) => item.id === "exceptions").ok, true);
});

test("a frozen report becomes stale after its financial source data changes", () => {
  const base = ensureWorkspace(createAccountingFixture());
  base.transactions = base.transactions.map((transaction) => ({ ...transaction, status: "ignored" }));
  base.vouchers = base.vouchers.map((voucher) => ({ ...voucher, status: "posted" }));
  const frozen = freezeReportVersion(base, "测试会计");
  assert.equal(workflowChecks(frozen).version?.label, "V1");

  const changed = {
    ...frozen,
    tax: { ...frozen.tax, adjustments: Number(frozen.tax.adjustments || 0) + 100 },
  };
  const flow = workflowChecks(changed);
  assert.equal(flow.version, null);
  assert.equal(flow.checks.find((item) => item.id === "frozen").ok, false);
  assert.match(flow.checks.find((item) => item.id === "frozen").detail, /重新冻结/);
});

test("a frozen report also becomes stale when the company identity changes", () => {
  const base = closeableWorkspace();
  const frozen = freezeReportVersion(base, "测试会计");
  const changed = { ...frozen, company: { ...frozen.company, legalName: "更名后的企业" } };
  assert.equal(workflowChecks(changed).version, null);
});

test("VAT adjustments change the taxable base, output VAT and payable VAT", () => {
  const base = closeableWorkspace();
  const before = buildTaxWorkpaper(base, { period: base.currentPeriod });
  const changed = { ...base, tax: { ...base.tax, adjustments: Number(base.tax.adjustments || 0) + 100 } };
  const after = buildTaxWorkpaper(changed, { period: changed.currentPeriod });
  assert.equal(after.taxableBase.value, before.taxableBase.value + 100);
  assert.equal(after.outputVat.value, before.outputVat.value + 3);
  assert.equal(after.vatPayable.value, before.vatPayable.value + 3);
});

test("a pending correction voucher blocks confirmation even when its source transaction is already posted", () => {
  const workspace = ensureWorkspace(createAccountingFixture());
  workspace.transactions = workspace.transactions.map((transaction) => ({ ...transaction, status: "posted" }));
  workspace.vouchers.push({
    id: "voucher-correction-draft",
    period: workspace.currentPeriod,
    status: "draft",
    version: 2,
    lines: [],
  });

  const flow = workflowChecks(workspace);
  assert.equal(flow.pendingVouchers.length, 1);
  assert.equal(flow.checks.find((item) => item.id === "vouchers").ok, false);
});

test("a failed bank reconciliation blocks report freezing and confirmation", () => {
  const workspace = ensureWorkspace(createAccountingFixture());
  workspace.transactions = workspace.transactions.map((transaction) => ({ ...transaction, status: "ignored" }));
  workspace.vouchers = workspace.vouchers.map((voucher) => ({ ...voucher, status: "posted" }));
  workspace.bankImports = [{
    id: "bank-import-failed",
    period: workspace.currentPeriod,
    status: "reconciliation_failed",
    reconciliation: { passed: false, difference: 125 },
  }];
  const flow = workflowChecks(workspace);
  assert.equal(flow.bankReconciliationIssues.length, 1);
  assert.equal(flow.checks.find((item) => item.id === "bank").ok, false);
});

test("freezing V2 clears every confirmation and delivery artifact bound to V1", () => {
  const base = ensureWorkspace(createAccountingFixture());
  base.transactions = base.transactions.map((transaction) => ({ ...transaction, status: "ignored" }));
  base.vouchers = base.vouchers.map((voucher) => ({ ...voucher, status: "posted" }));
  const v1 = freezeReportVersion(base, "测试会计");
  const v1Id = v1.delivery.reportVersions[0].id;
  v1.tax = {
    ...v1.tax,
    financeConfirmedAt: fixedNow().toISOString(),
    payrollConfirmedAt: fixedNow().toISOString(),
    ownerConfirmedAt: fixedNow().toISOString(),
    financeConfirmedVersionId: v1Id,
    payrollConfirmedVersionId: v1Id,
    ownerConfirmedVersionId: v1Id,
  };
  v1.delivery.filing = {
    ...v1.delivery.filing,
    draftCreatedAt: fixedNow().toISOString(),
    draftVersionId: v1Id,
    finalConfirmedVersionId: v1Id,
    exportedAt: fixedNow().toISOString(),
    exportedPackage: { reportVersionId: v1Id },
    receipt: { id: "receipt-v1", reportVersionId: v1Id },
  };

  const v2 = freezeReportVersion(v1, "测试会计");
  assert.equal(v2.delivery.reportVersions[0].label, "V2");
  assert.equal(v2.tax.financeConfirmedAt, null);
  assert.equal(v2.tax.ownerConfirmedVersionId, null);
  assert.equal(v2.delivery.filing.draftVersionId, null);
  assert.equal(v2.delivery.filing.exportedPackage, null);
  assert.equal(v2.delivery.filing.receipt, null);
});

test("the full frozen-version confirmation, package, receipt, archive and next-period chain remains bound", () => {
  let workspace = closeableWorkspace();
  workspace = freezeAccountingReportVersion(
    workspace,
    { period: workspace.currentPeriod, label: "月度财务报表" },
    { actor: "测试会计", at: "2026-09-04T08:01:00.000Z" },
  );
  workspace = freezeReportVersion(workspace, "测试会计");
  const versionId = workflowChecks(workspace).version.id;
  workspace = createCustomerConfirmationPackage(
    workspace,
    { period: workspace.currentPeriod, reportVersionId: versionId },
    { actor: "测试会计", at: "2026-09-04T08:02:00.000Z" },
  );
  const confirmationId = workspace.confirmations.at(-1).id;
  for (const [index, section] of ["finance", "revenue", "costExpense", "vat", "inputVat", "payroll", "socialSecurity", "openItems"].entries()) {
    workspace = recordCustomerConfirmation(workspace, {
      confirmationId,
      section,
      decision: "approve",
      note: "本地逐项确认",
    }, { actor: "客户负责人", at: `2026-09-04T08:${String(3 + index).padStart(2, "0")}:00.000Z` });
  }
  workspace = {
    ...workspace,
    tax: {
      ...workspace.tax,
      financeConfirmedAt: "2026-09-04T08:12:00.000Z",
      payrollConfirmedAt: "2026-09-04T08:12:00.000Z",
      financeConfirmedVersionId: versionId,
      payrollConfirmedVersionId: versionId,
    },
    delivery: {
      ...workspace.delivery,
      filing: { ...workspace.delivery.filing, initialConfirmationId: confirmationId },
    },
  };
  workspace = prepareFilingDraft(workspace, "测试会计");
  workspace = {
    ...workspace,
    tax: {
      ...workspace.tax,
      ownerConfirmedAt: "2026-09-04T08:13:00.000Z",
      ownerConfirmedVersionId: versionId,
      confirmedBy: "客户负责人",
    },
    delivery: {
      ...workspace.delivery,
      filing: { ...workspace.delivery.filing, finalConfirmedVersionId: versionId },
    },
  };
  workspace = markPackageExported(workspace, {
    id: "filing-package-test",
    fileName: "申报包.zip",
    size: 1024,
    hash: "package-sha256",
    exportedAt: "2026-09-04T08:14:00.000Z",
    reportVersionId: versionId,
  }, "测试会计");
  workspace = {
    ...workspace,
    documents: [...workspace.documents, {
      id: "receipt-document-test",
      name: "真实回执.txt",
      category: "申报回执",
      deliveryArtifact: true,
      period: workspace.currentPeriod,
      hash: "receipt-sha256",
      relatedObjectIds: [],
      storage: { mode: "indexeddb", blobId: "receipt-document-test", availableLocally: true },
    }],
  };
  workspace = attachReceipt(workspace, {
    id: "receipt-test",
    name: "真实回执.txt",
    hash: "receipt-sha256",
    documentId: "receipt-document-test",
    importedAt: "2026-09-04T08:15:00.000Z",
  }, "测试会计");
  assert.equal(workflowChecks(workspace).archive.every((check) => check.ok), true);

  const fingerprint = workflowSourceFingerprint(workspace);
  const archived = archivePeriod(workspace, "测试会计");
  assert.equal(archived.delivery.archives[0].sourceFingerprint, fingerprint);
  assert.equal(archived.documents.find((document) => document.id === "receipt-document-test").archiveStatus, "archived");

  const { store } = integratedStore(archived);
  assert.throws(() => store.actions.replaceWorkspace(archived.id, { ...store.getActiveWorkspace(), tax: { ...archived.tax, payroll: 1 } }), /已经归档/);
  assert.doesNotThrow(() => store.actions.replaceWorkspace(archived.id, store.getActiveWorkspace(), { allowArchivedTransition: true, requiredPermission: "data.read" }));

  const next = enterNextPeriod(archived, "测试会计");
  assert.notEqual(next.currentPeriod, archived.currentPeriod);
  assert.equal(next.tax.payroll, 0);
  assert.equal(next.tax.socialSecurity, 0);
  assert.deepEqual(next.tax.sourceIds, []);
  assert.deepEqual(next.tax.payrollSourceIds, []);
  assert.deepEqual(next.tax.socialSecuritySourceIds, []);
});
