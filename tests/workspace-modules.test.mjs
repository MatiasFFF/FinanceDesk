import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createBlankWorkspace,
  createInitialState,
} from "../src/domain/foundation.js";
import {
  createLocalFoundationRepository,
  createMemoryStorage,
} from "../src/storage/localFoundationRepository.js";
import { createFinanceDeskStore } from "../src/store/financeDeskStore.js";
import {
  buildReportSnapshot,
  primaryNavigationForWorkspace,
  workflowChecks,
} from "../src/productWorkflow.js";

const fixedNow = () => new Date("2026-09-05T09:00:00.000Z");

test("blank workspaces start neutral while the fitness example keeps all optional modules", () => {
  const blank = createBlankWorkspace({ id: "workspace-blank", name: "微光设计事务所" }, { now: fixedNow });
  assert.equal(blank.templateLabel, "空白工作台");
  assert.equal(blank.company.industry, "其他服务业");
  assert.deepEqual(blank.users, []);
  assert.deepEqual(blank.members, []);
  assert.deepEqual(blank.personnelRecords, []);
  assert.deepEqual(blank.businessEvents, []);
  assert.equal(blank.modules.members, false);
  assert.equal(blank.modules.reconcile, true);
  assert.equal(blank.modules.tax, true);
  assert.deepEqual(
    { vatRate: blank.tax.vatRate, surtaxRate: blank.tax.surtaxRate, incomeTaxRate: blank.tax.incomeTaxRate },
    { vatRate: 0.03, surtaxRate: 0.12, incomeTaxRate: 0.05 },
  );
  assert.ok(["overview", "reports", "archive", "setup"].every((id) => blank.modules[id]));
  assert.equal(blank.chartOfAccounts.find((account) => account.id === "revenuePrivate").label, "主营业务收入 · 服务收入");
  assert.equal(blank.chartOfAccounts.find((account) => account.id === "expenseCommission").label, "销售费用 · 业务提成");
  assert.doesNotMatch(JSON.stringify({
    company: blank.company,
    stores: blank.stores,
    users: blank.users,
    members: blank.members,
    personnelRecords: blank.personnelRecords,
    businessEvents: blank.businessEvents,
    contracts: blank.contracts,
  }), /会员|教练|私教|团课/);

  const fitness = createInitialState({ now: fixedNow }).workspaces[0];
  assert.equal(fitness.templateId, "fitness-studio");
  assert.ok(["members", "reconcile", "tax"].every((id) => fitness.modules[id]));
});

test("module choices persist per workspace and a workspace without an operator remains configurable", () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const templateId = store.getState().activeWorkspaceId;
  const created = store.actions.createWorkspace({
    id: "workspace-configurable",
    name: "中性服务工作台",
    modules: { members: true, reconcile: false, tax: false },
  });

  assert.deepEqual(created.users, []);
  assert.equal(store.getState().activeUserId, null);
  store.actions.updateWorkspaceModules(created.id, { members: false, tax: true });

  const reloaded = createFinanceDeskStore({ repository });
  assert.deepEqual(
    { ...reloaded.getActiveWorkspace().modules },
    { overview: true, members: false, reconcile: false, reports: true, tax: true, archive: true, setup: true },
  );
  assert.equal(reloaded.getState().activeUserId, null);

  reloaded.actions.upsertEntity(created.id, "users", {
    id: "user-neutral-owner",
    name: "林负责人",
    roleId: "role-owner",
    role: "经营者",
    status: "active",
  });
  assert.equal(reloaded.getState().activeUserId, "user-neutral-owner");
  reloaded.actions.switchWorkspace(templateId);
  reloaded.actions.switchWorkspace(created.id);
  assert.equal(reloaded.getState().activeUserId, "user-neutral-owner");
});

test("workspace navigation and archive requirements follow the persisted module configuration", () => {
  const workspace = createBlankWorkspace({
    id: "workspace-navigation",
    name: "导航测试",
    modules: { members: false, reconcile: false, tax: false },
  }, { now: fixedNow });
  assert.deepEqual(primaryNavigationForWorkspace(workspace).map((item) => item.id), ["overview", "reports", "archive", "setup"]);
  assert.equal(workflowChecks(workspace).archive.some((check) => check.page === "tax"), false);

  const withMembers = { ...workspace, modules: { ...workspace.modules, members: true } };
  assert.equal(primaryNavigationForWorkspace(withMembers).some((item) => item.id === "members"), true);
});

test("reports stay neutral when member business is disabled", () => {
  const workspace = createBlankWorkspace({ id: "workspace-neutral-report", name: "通用服务工作台" }, { now: fixedNow });
  const snapshot = buildReportSnapshot(workspace);
  const labels = [
    ...snapshot.sections.income.rows.map((row) => row.label),
    ...snapshot.sections.owner.rows.map((row) => row.label),
  ].join(" ");
  assert.match(labels, /服务收入/);
  assert.doesNotMatch(labels, /会员|教练|私教|团课/);
});

test("management report display preferences hide and rename rows without changing their values", () => {
  const workspace = createBlankWorkspace({ id: "workspace-report-preferences", name: "管理报表配置" }, { now: fixedNow });
  const baseline = buildReportSnapshot(workspace).sections.owner.rows;
  const revenue = baseline.find((row) => row.id === "ownerRevenue");
  workspace.managementReport = {
    displayItems: [
      { id: "ownerCash", visible: false, label: "" },
      { id: "ownerRevenue", visible: true, label: "经营收入" },
    ],
  };
  const configured = buildReportSnapshot(workspace).sections.owner.rows;
  assert.equal(configured.some((row) => row.id === "ownerCash"), false);
  assert.equal(configured.find((row) => row.id === "ownerRevenue").label, "经营收入");
  assert.equal(configured.find((row) => row.id === "ownerRevenue").value, revenue.value);
  assert.deepEqual(configured.find((row) => row.id === "ownerRevenue").details, revenue.details);
});

test("app wiring uses workspace modules for creation, navigation, operator identity, and reconciliation", () => {
  const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const managerSource = readFileSync(new URL("../src/features/workspaces/WorkspaceManager.jsx", import.meta.url), "utf8");
  const accountingSource = readFileSync(new URL("../src/features/accounting/AccountingWorkbench.jsx", import.meta.url), "utf8");
  const bankImportSource = readFileSync(new URL("../src/features/intake/BankImportPanel.jsx", import.meta.url), "utf8");

  assert.match(appSource, /mode: "blank"/);
  assert.match(appSource, /industry: "其他服务业"/);
  assert.match(appSource, /primaryNavigationForWorkspace\(workspace\)/);
  assert.match(appSource, /未设置\$\{terminology\.personnel\}操作人/);
  assert.doesNotMatch(appSource, /<strong>周会计<\/strong>/);
  assert.match(appSource, /showMemberBusiness=\{workspaceModuleEnabled\(workspace, "members"\)\}/);
  assert.match(appSource, /management-report-empty/);
  assert.match(appSource, /去基础资料恢复显示项/);
  assert.match(appSource, /BLANK_WORKSPACE_INITIAL_ROLE_OPTIONS/);
  assert.match(appSource, /initialUserName: form\.initialUserName\.trim\(\)/);
  assert.match(appSource, /initialUserRoleId: form\.initialUserRoleId/);
  assert.match(appSource, /financeContact: form\.financeContact\.trim\(\)/);
  assert.match(appSource, /onDownloadDocument=\{downloadArchiveDocument\}/);
  assert.match(appSource, /getStoredDocumentRecord\(\{ fileVault, workspaceId: current\.id, document \}\)/);
  assert.match(appSource, /downloadStoredDocument\(record\)/);
  assert.match(appSource, /setSetupInitialStage\("s3"\)/);
  assert.match(appSource, /onRequestAccountSetup=\{requestBankAccountSetup\}/);
  assert.match(managerSource, /actions\.updateWorkspaceModules/);
  assert.match(accountingSource, /showMemberBusiness && memberBusinessEnabled\(activeWorkspace\) && <MemberBusinessAccountingQueue/);
  assert.match(accountingSource, /workspaceAccountOptions\(activeWorkspace\)/);
  assert.match(accountingSource, /accountDefinition\(account\.id, workspace\)/);
  assert.match(bankImportSource, /去基础资料添加银行账户/);
  assert.match(bankImportSource, /下载银行流水 CSV 模板/);
  assert.match(bankImportSource, /下载平台结算 CSV 模板/);
  assert.match(bankImportSource, /\["日期", "对方", "摘要", "收入", "支出", "流水号", "余额"\]/);
  assert.match(bankImportSource, /\["结算日期", "结算单号", "交易总额", "手续费", "退款", "净结算额"\]/);
});
