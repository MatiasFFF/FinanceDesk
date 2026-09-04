import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFinancialStatements,
  buildTaxWorkpaper,
  createAccountingFixture,
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
  buildReportSnapshot,
  ensureWorkspace,
  workflowChecks,
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
});

test("posted and explicitly ignored items no longer block the product close workflow", () => {
  const workspace = ensureWorkspace(createAccountingFixture());
  workspace.transactions = workspace.transactions.slice(0, 3).map((transaction, index) => ({
    ...transaction,
    date: workspace.currentPeriod + "-15",
    status: ["posted", "ignored", "pending"][index],
  }));

  const flow = workflowChecks(workspace);
  assert.deepEqual(flow.unresolved.map((item) => item.status), ["pending"]);
});
