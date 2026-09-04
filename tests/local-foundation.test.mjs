import test from "node:test";
import assert from "node:assert/strict";

import {
  CURRENT_SCHEMA_VERSION,
  FINANCE_DESK_BACKUP_KEY,
  FINANCE_DESK_STORAGE_KEY,
  addWorkspace,
  clearWorkspace,
  createInitialState,
  createLocalFoundationRepository,
  createMemoryStorage,
  exportBackupJson,
  getWorkspace,
  importBackupJson,
  migrateState,
  renameWorkspace,
  switchWorkspace,
  upsertWorkspaceEntity,
  validateState,
} from "../src/foundation.js";

const fixedNow = () => new Date("2026-09-04T08:00:00.000Z");

test("首次只创建山岚行业模板，且外部能力均未连接", () => {
  const state = createInitialState({ now: fixedNow });
  assert.equal(state.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(state.workspaces.length, 1);
  assert.equal(state.workspaces[0].name, "山岚健身工作室");
  assert.equal(state.workspaces[0].templateId, "fitness-studio");
  assert.ok(state.workspaces[0].authorizations.every((item) => item.status === "not_connected"));
  assert.ok(Object.values(state.workspaces[0].integrations).every((item) => item.connected === false));
  assert.equal(validateState(state).ok, true);
});

test("工作台复制、重命名和切换保持数据隔离", () => {
  const initial = createInitialState({ now: fixedNow });
  const sourceId = initial.activeWorkspaceId;
  const copied = addWorkspace(initial, {
    id: "workspace-copy",
    sourceWorkspaceId: sourceId,
    name: "新门店财务工作台",
  }, { now: fixedNow });

  let state = copied.state;
  const sourceBefore = getWorkspace(state, sourceId);
  const sourceCounterpartyCount = sourceBefore.counterparties.length;
  const upserted = upsertWorkspaceEntity(state, "workspace-copy", "counterparties", {
    id: "counterparty-only-in-copy",
    name: "副本专属客户",
    kind: "customer",
    status: "active",
  }, { now: fixedNow });
  state = renameWorkspace(upserted.state, "workspace-copy", "虹桥门店", { now: fixedNow });
  state = switchWorkspace(state, sourceId, { now: fixedNow });

  assert.equal(getWorkspace(state, sourceId).counterparties.length, sourceCounterpartyCount);
  assert.equal(getWorkspace(state, sourceId).counterparties.some((item) => item.id === "counterparty-only-in-copy"), false);
  assert.equal(getWorkspace(state, "workspace-copy").counterparties.some((item) => item.id === "counterparty-only-in-copy"), true);
  assert.equal(getWorkspace(state, "workspace-copy").name, "虹桥门店");
  assert.equal(state.activeWorkspaceId, sourceId);
});

test("v3 数据迁移到当前模型并补足 S0-S4 集合", () => {
  const legacy = {
    version: 3,
    activeWorkspaceId: "legacy-workspace",
    activeUserId: "legacy-user",
    workspaces: [{
      id: "legacy-workspace",
      name: "旧账套",
      company: { legalName: "旧公司" },
      users: [{ id: "legacy-user", name: "陈会计", role: "财务负责人" }],
      accounts: [{ id: "bank-1", name: "基本户", openingBalance: 10 }],
      transactions: [{ id: "txn-1", date: "2026-08-01", amount: 20 }],
    }],
  };
  const state = migrateState(legacy, { now: fixedNow });
  const workspace = state.workspaces[0];

  assert.equal(state.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(workspace.bankAccounts[0].id, "bank-1");
  for (const collection of ["books", "stores", "roles", "authorizations", "ruleSets", "counterparties", "contracts", "invoices", "approvals", "personnelRecords", "bankImports", "documents", "evidenceLinks", "auditLog"]) {
    assert.ok(Array.isArray(workspace[collection]), `${collection} should be an array`);
  }
  assert.equal(validateState(state).ok, true);
});

test("本地仓库从最近一次有效副本恢复损坏的主数据", () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const first = createInitialState({ now: fixedNow });
  repository.save(first);
  const second = renameWorkspace(first, first.activeWorkspaceId, "已保存的新名称", { now: fixedNow });
  repository.save(second);

  storage.setItem(FINANCE_DESK_STORAGE_KEY, "{corrupt-json");
  const loaded = repository.load();

  assert.equal(loaded.recovered, true);
  assert.equal(loaded.source, "backup");
  assert.equal(loaded.state.workspaces[0].name, "山岚健身工作室");
  assert.ok(storage.getItem(FINANCE_DESK_BACKUP_KEY));
});

test("JSON 备份可校验导出、替换导入和合并导入", () => {
  const state = createInitialState({ now: fixedNow });
  const json = exportBackupJson(state, { now: fixedNow });
  const replaced = importBackupJson(json, { mode: "replace", now: fixedNow });
  const merged = importBackupJson(json, { mode: "merge", currentState: state, now: fixedNow });

  assert.equal(replaced.workspaces.length, 1);
  assert.equal(merged.workspaces.length, 2);
  assert.notEqual(merged.workspaces[0].id, merged.workspaces[1].id);
  assert.match(merged.workspaces[1].name, /导入/);
});

test("清空单工作台只影响目标工作台", () => {
  const initial = createInitialState({ now: fixedNow });
  const { state: withCopy } = addWorkspace(initial, {
    id: "workspace-copy",
    sourceWorkspaceId: initial.activeWorkspaceId,
    name: "保留数据的副本",
  }, { now: fixedNow });
  const originalCount = getWorkspace(withCopy, initial.activeWorkspaceId).transactions.length;
  const cleared = clearWorkspace(withCopy, "workspace-copy", { scope: "operational", now: fixedNow });

  assert.equal(getWorkspace(cleared, "workspace-copy").transactions.length, 0);
  assert.equal(getWorkspace(cleared, initial.activeWorkspaceId).transactions.length, originalCount);
  assert.ok(getWorkspace(cleared, "workspace-copy").company.legalName);
});
