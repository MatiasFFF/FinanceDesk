import test from "node:test";
import assert from "node:assert/strict";

import {
  CURRENT_SCHEMA_VERSION,
  FINANCE_DESK_BACKUP_KEY,
  FINANCE_DESK_STORAGE_KEY,
  addWorkspace,
  clearWorkspace,
  createFinanceDeskStore,
  createInitialState,
  createLocalFoundationRepository,
  createMemoryStorage,
  exportBackupJson,
  getWorkspace,
  importBackupJson,
  migrateState,
  recordLocalAuthorization,
  removeWorkspaceEntity,
  renameWorkspace,
  setWorkspaceStageStatus,
  stageCompletionIssues,
  switchWorkspace,
  updateWorkspace,
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

test("银行账户写入口拒绝无效或重复的账号资料，并允许负余额", () => {
  const initial = createInitialState({ now: fixedNow });
  let state = addWorkspace(initial, {
    id: "workspace-bank-validation",
    name: "银行账户校验工作台",
  }, { now: fixedNow }).state;

  state = upsertWorkspaceEntity(state, "workspace-bank-validation", "bankAccounts", {
    id: "bank-valid",
    name: "基本户",
    accountNumber: "1234",
    openingBalance: -100,
    statementClosing: "-80.50",
    status: "active",
  }, { now: fixedNow }).state;
  assert.equal(getWorkspace(state, "workspace-bank-validation").bankAccounts[0].openingBalance, -100);
  assert.doesNotThrow(() => upsertWorkspaceEntity(state, "workspace-bank-validation", "bankAccounts", {
    ...getWorkspace(state, "workspace-bank-validation").bankAccounts[0],
    name: "基本户（已编辑）",
  }, { now: fixedNow }));
  assert.throws(() => upsertWorkspaceEntity(state, "workspace-bank-validation", "bankAccounts", {
    name: " ",
    accountNumber: "5678",
  }, { now: fixedNow }), /银行账户名称不能为空/);
  assert.throws(() => upsertWorkspaceEntity(state, "workspace-bank-validation", "bankAccounts", {
    name: "一般户",
    accountNumber: "12A4",
  }, { now: fixedNow }), /恰好 4 位数字/);
  assert.throws(() => upsertWorkspaceEntity(state, "workspace-bank-validation", "bankAccounts", {
    name: "一般户",
    accountNumber: "5678",
    openingBalance: "不是数字",
  }, { now: fixedNow }), /期初余额必须是有限数字/);
  assert.throws(() => upsertWorkspaceEntity(state, "workspace-bank-validation", "bankAccounts", {
    name: "重复账户",
    accountNumber: "1234",
  }, { now: fixedNow }), /已被其他银行账户使用/);
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
  const initial = createInitialState({ now: fixedNow });
  const state = updateWorkspace(initial, initial.activeWorkspaceId, (workspace) => ({
    ...workspace,
    documents: [{
      id: "document-local-only",
      name: "仅浏览器原文件.pdf",
      storage: { mode: "indexeddb", blobId: "blob-local-only", availableLocally: true },
    }],
  }), null, { now: fixedNow });
  const json = exportBackupJson(state, { now: fixedNow });
  const replaced = importBackupJson(json, { mode: "replace", now: fixedNow });
  const merged = importBackupJson(json, { mode: "merge", currentState: state, now: fixedNow });

  assert.equal(replaced.workspaces.length, 1);
  assert.equal(merged.workspaces.length, 2);
  assert.notEqual(merged.workspaces[0].id, merged.workspaces[1].id);
  assert.match(merged.workspaces[1].name, /导入/);
  assert.equal(replaced.workspaces[0].documents[0].storage.availableLocally, false, "JSON 不包含 Blob，导入后不得伪装原文件可用");
  assert.equal(replaced.workspaces[0].documents[0].storage.blobId, null, "未核对归属前不得复用全局 Blob ID");
});

test("清空单工作台只影响目标工作台", () => {
  const initial = createInitialState({ now: fixedNow });
  const { state: withCopy } = addWorkspace(initial, {
    id: "workspace-copy",
    sourceWorkspaceId: initial.activeWorkspaceId,
    name: "保留数据的副本",
  }, { now: fixedNow });
  const originalCount = getWorkspace(withCopy, initial.activeWorkspaceId).transactions.length;
  const withDownstreamState = updateWorkspace(withCopy, "workspace-copy", (workspace) => ({
    ...workspace,
    exceptionTasks: [{ id: "exception-old" }],
    confirmations: [{ id: "confirmation-old" }],
    reportVersions: [{ id: "engine-report-old" }],
    delivery: {
      reportVersions: [{ id: "product-report-old" }],
      filing: { period: workspace.currentPeriod, exportedAt: fixedNow().toISOString(), receipt: { id: "receipt-old" } },
      archives: [{ id: "archive-old" }],
      notices: [],
    },
  }), null, { now: fixedNow });
  const cleared = clearWorkspace(withDownstreamState, "workspace-copy", { scope: "operational", now: fixedNow });

  const clearedWorkspace = getWorkspace(cleared, "workspace-copy");
  assert.equal(clearedWorkspace.transactions.length, 0);
  assert.equal(clearedWorkspace.exceptionTasks.length, 0);
  assert.equal(clearedWorkspace.confirmations.length, 0);
  assert.equal(clearedWorkspace.reportVersions.length, 0);
  assert.equal(clearedWorkspace.delivery.reportVersions.length, 0);
  assert.equal(clearedWorkspace.delivery.archives.length, 0);
  assert.equal(clearedWorkspace.delivery.filing.exportedAt, null);
  assert.equal(getWorkspace(cleared, initial.activeWorkspaceId).transactions.length, originalCount);
  assert.ok(clearedWorkspace.company.legalName);
});

test("切换工作台会同步切换到目标工作台的启用用户", () => {
  const initial = createInitialState({ now: fixedNow });
  const sourceId = initial.activeWorkspaceId;
  const { state: created } = addWorkspace(initial, {
    id: "workspace-user-scope",
    name: "独立用户工作台",
  }, { now: fixedNow });
  let state = upsertWorkspaceEntity(created, "workspace-user-scope", "users", {
    id: "user-second-owner",
    name: "第二负责人",
    roleId: "role-owner",
    role: "经营者",
    status: "active",
  }, { now: fixedNow }).state;
  state = switchWorkspace(state, sourceId, { now: fixedNow });
  state = switchWorkspace(state, "workspace-user-scope", { now: fixedNow });

  assert.equal(state.activeWorkspaceId, "workspace-user-scope");
  assert.equal(getWorkspace(state).users.some((user) => user.id === state.activeUserId && user.status === "active"), true);
});

test("角色权限在 store 写入口真实拦截，资料协作者仍可添加资料元数据", () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const workspaceId = store.getState().activeWorkspaceId;
  store.actions.upsertEntity(workspaceId, "users", {
    id: "user-staff-test",
    name: "资料协作者测试",
    roleId: "role-staff",
    role: "资料协作者",
    status: "active",
  });
  store.actions.switchUser(workspaceId, "user-staff-test");

  assert.throws(() => store.actions.replaceWorkspace(workspaceId, store.getActiveWorkspace()), /缺少权限 data\.write/);
  assert.throws(() => store.actions.createWorkspace({ name: "不应创建" }), /缺少权限 workspace\.manage/);
  assert.doesNotThrow(() => store.actions.upsertEntity(workspaceId, "documents", {
    id: "document-staff-added",
    name: "协作者资料索引",
    status: "active",
  }));
});

test("被业务对象引用的基础记录不能直接硬删除", () => {
  const state = createInitialState({ now: fixedNow });
  const workspaceId = state.activeWorkspaceId;
  assert.throws(
    () => removeWorkspaceEntity(state, workspaceId, "bankAccounts", "bank-cmb-8821", { now: fixedNow }),
    /仍被.*引用/,
  );
});

test("阶段完成会核对未结事项，授权到期会留下失效状态", () => {
  const initial = createInitialState({ now: fixedNow });
  const workspaceId = initial.activeWorkspaceId;
  const workspace = getWorkspace(initial);
  assert.equal(stageCompletionIssues(workspace, "s4", fixedNow().toISOString()).some((item) => item.includes("力量器械采购")), true);
  assert.throws(() => setWorkspaceStageStatus(initial, workspaceId, "s4", "complete", { now: fixedNow }), /仍有未完成事项/);

  const recorded = recordLocalAuthorization(initial, workspaceId, {
    id: "authorization-expired",
    system: "bank",
    label: "历史银行授权",
    scope: "本地流水文件",
    expiresAt: "2026-09-01",
  }, { now: fixedNow });
  assert.equal(recorded.item.status, "expired");
});
