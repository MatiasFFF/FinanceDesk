import assert from "node:assert/strict";
import test from "node:test";

import {
  activeWorkspaceUser,
  assertWorkspacePermission,
  createBlankWorkspace,
  createInitialState,
  migrateState,
  workspaceUserPermissions,
} from "../src/domain/foundation.js";
import { createLocalFoundationRepository, createMemoryStorage } from "../src/storage/localFoundationRepository.js";
import { createFinanceDeskStore } from "../src/store/financeDeskStore.js";

const timestamp = "2026-09-05T12:00:00.000Z";
const fixedNow = () => new Date(timestamp);
const options = { timestamp };

function personnelStore({ withOtherUser = true } = {}) {
  const repository = createLocalFoundationRepository({ storage: createMemoryStorage(), now: fixedNow });
  const workspace = createBlankWorkspace({
    id: "workspace-personnel-permissions",
    name: "本地人员权限工作台",
    currentPeriod: "2026-09",
    initialUserName: "陈会计",
    initialUserRoleId: "role-finance",
  }, options);
  const employeeUserId = workspace.users[0].id;
  repository.save({
    ...createInitialState(options),
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    activeUserId: employeeUserId,
  });
  const store = createFinanceDeskStore({ repository });
  store.actions.upsertEntity(workspace.id, "personnelRecords", {
    id: "person-employee", name: "陈会计", status: "active", userId: employeeUserId,
  }, options);
  if (withOtherUser) {
    store.actions.upsertEntity(workspace.id, "users", {
      id: "user-other-owner", name: "陈会计", roleId: "role-owner", status: "active",
    }, options);
  }
  return { store, repository, workspaceId: workspace.id, employeeUserId, otherUserId: "user-other-owner", personnelId: "person-employee" };
}

test("停用或离职收回明确关联账户的本地权限，同名账户与历史记录保留", async (t) => {
  for (const status of ["inactive", "departed"]) {
    await t.test(status, () => {
      const { store, workspaceId, employeeUserId, otherUserId, personnelId } = personnelStore();
      const original = structuredClone(store.getActiveWorkspace());
      store.actions.setEntityStatus(workspaceId, "personnelRecords", personnelId, status, options);
      const current = store.getActiveWorkspace();
      assert.equal(current.users.find((user) => user.id === employeeUserId).status, "inactive");
      assert.equal(current.users.find((user) => user.id === employeeUserId).name, "陈会计");
      assert.equal(current.users.find((user) => user.id === otherUserId).status, "active");
      assert.equal(store.getState().activeUserId, null);
      assert.equal(activeWorkspaceUser(store.getState()), null);
      assert.deepEqual(workspaceUserPermissions(store.getState()), []);
      assert.deepEqual(current.auditLog.slice(0, original.auditLog.length), original.auditLog);
      const revocation = current.auditLog.find((entry) => entry.action === "人员状态收回本地权限");
      assert.equal(revocation.objectId, employeeUserId);
      assert.equal(revocation.personnelRecordId, personnelId);
      assert.equal(revocation.actor, "陈会计");
      assert.deepEqual(revocation.before, { status: "active" });
      assert.deepEqual(revocation.after, { status: "inactive" });

      const beforeRejectedWrite = structuredClone(store.getState());
      assert.throws(() => store.actions.upsertEntity(workspaceId, "documents", { name: "不能借同名管理员继续操作" }, options), /没有可用的本地用户/);
      assert.throws(() => store.actions.switchUser(workspaceId, employeeUserId, options), /启用用户/);
      assert.throws(() => assertWorkspacePermission({ ...store.getState(), activeUserId: employeeUserId }, workspaceId, "data.write"), /没有可用的本地用户/);
      assert.deepEqual(store.getState(), beforeRejectedWrite);
      store.actions.switchWorkspace(workspaceId, options);
      assert.equal(store.getState().activeUserId, null);

      store.actions.switchUser(workspaceId, otherUserId, options);
      store.actions.upsertEntity(workspaceId, "documents", { id: "document-after-switch", name: "明确切换后的操作" }, options);
      assert.equal(store.getState().activeUserId, otherUserId);
      assert.ok(store.getActiveWorkspace().documents.some((document) => document.id === "document-after-switch"));
    });
  }
});

test("整份工作台更新与重新载入保留收权结果，单向 ID 关联也生效", async (t) => {
  for (const remainingLink of ["personnel.userId", "user.personnelRecordId"]) {
    await t.test(remainingLink, () => {
      const { store, repository, workspaceId, employeeUserId, personnelId } = personnelStore();
      const updated = structuredClone(store.getActiveWorkspace());
      const user = updated.users.find((item) => item.id === employeeUserId);
      const personnel = updated.personnelRecords.find((item) => item.id === personnelId);
      if (remainingLink === "personnel.userId") delete user.personnelRecordId;
      else delete personnel.userId;
      personnel.status = "departed";

      const migrated = migrateState({ ...store.getState(), workspaces: [updated] }, options);
      assert.equal(migrated.activeUserId, null);
      assert.equal(migrated.workspaces[0].users.find((item) => item.id === employeeUserId).status, "inactive");
      store.actions.replaceWorkspace(workspaceId, updated, options);
      const reloaded = createFinanceDeskStore({ repository });
      assert.equal(reloaded.getState().activeUserId, null);
      assert.equal(reloaded.getActiveWorkspace().users.find((item) => item.id === employeeUserId).status, "inactive");
      assert.equal(reloaded.getActiveWorkspace().auditLog.filter((entry) => entry.action === "人员状态收回本地权限").length, 1);
      assert.throws(() => reloaded.actions.replaceWorkspace(workspaceId, reloaded.getActiveWorkspace(), options), /没有可用的本地用户/);
    });
  }
});

test("离职更新同时解除关联时，原已关联账户仍会停用", () => {
  const { store, workspaceId, employeeUserId, personnelId } = personnelStore();
  store.actions.upsertEntity(workspaceId, "personnelRecords", {
    id: personnelId, status: "departed", userId: null,
  }, options);
  const current = store.getActiveWorkspace();
  assert.equal(current.users.find((user) => user.id === employeeUserId).status, "inactive");
  assert.equal(current.users.find((user) => user.id === employeeUserId).name, "陈会计");
  assert.equal(current.personnelRecords.find((personnel) => personnel.id === personnelId).userId, null);
  assert.equal(store.getState().activeUserId, null);
});

test("恢复人员资料不自动恢复账户，仍离职时也不能单独启用关联账户", () => {
  const { store, workspaceId, employeeUserId, otherUserId, personnelId } = personnelStore();
  store.actions.switchUser(workspaceId, otherUserId, options);
  store.actions.setEntityStatus(workspaceId, "personnelRecords", personnelId, "departed", options);
  assert.throws(() => store.actions.setEntityStatus(workspaceId, "users", employeeUserId, "active", options), /先恢复人员资料/);
  store.actions.setEntityStatus(workspaceId, "personnelRecords", personnelId, "active", options);
  assert.equal(store.getActiveWorkspace().users.find((user) => user.id === employeeUserId).status, "inactive");
  store.actions.setEntityStatus(workspaceId, "users", employeeUserId, "active", options);
  assert.equal(store.getActiveWorkspace().users.find((user) => user.id === employeeUserId).status, "active");
  assert.equal(store.getState().activeUserId, otherUserId);

  store.actions.upsertEntity(workspaceId, "users", {
    id: employeeUserId, status: "inactive", note: "此前独立停用，需另行复核权限",
  }, options);
  const revocationCount = store.getActiveWorkspace().auditLog.filter((entry) => entry.action === "人员状态收回本地权限").length;
  store.actions.setEntityStatus(workspaceId, "personnelRecords", personnelId, "inactive", options);
  store.actions.setEntityStatus(workspaceId, "personnelRecords", personnelId, "active", options);
  const independentlyDisabled = store.getActiveWorkspace().users.find((user) => user.id === employeeUserId);
  assert.equal(independentlyDisabled.status, "inactive");
  assert.equal(independentlyDisabled.note, "此前独立停用，需另行复核权限");
  assert.equal(store.getActiveWorkspace().auditLog.filter((entry) => entry.action === "人员状态收回本地权限").length, revocationCount);
});

test("资料待处理、缺失或归档不等同于离职", () => {
  const { store, workspaceId, employeeUserId, personnelId } = personnelStore();
  for (const status of ["pending", "missing", "archived"]) {
    store.actions.setEntityStatus(workspaceId, "personnelRecords", personnelId, status, options);
    assert.equal(store.getActiveWorkspace().users.find((user) => user.id === employeeUserId).status, "active");
    assert.equal(store.getState().activeUserId, employeeUserId);
  }
});

test("所有账户停用后不能按空白工作台绕过写入权限", () => {
  const { store, repository, workspaceId, personnelId } = personnelStore({ withOtherUser: false });
  store.actions.setEntityStatus(workspaceId, "personnelRecords", personnelId, "departed", options);
  const reloaded = createFinanceDeskStore({ repository });
  assert.equal(reloaded.getState().activeUserId, null);
  const before = structuredClone(reloaded.getState());
  assert.throws(() => reloaded.actions.updateWorkspaceModules(workspaceId, { payroll: true }, options), /没有可用的本地用户/);
  assert.throws(() => reloaded.actions.upsertEntity(workspaceId, "users", { name: "绕过停用创建管理员", roleId: "role-owner", status: "active" }, options), /没有可用的本地用户/);
  assert.throws(() => reloaded.actions.importBackup("{}"), /没有可用的本地用户/);
  assert.deepEqual(reloaded.getState(), before);
});

test("从未配置用户的工作台可以初始化，已有用户的工作台清空后不能重获免校验入口", () => {
  const { store, repository } = personnelStore();
  const workspace = store.actions.createWorkspace({ id: "workspace-first-setup", name: "首次配置工作台" });
  assert.deepEqual(workspace.users, []);
  store.actions.updateWorkspaceModules(workspace.id, { payroll: true }, options);
  const user = store.actions.upsertEntity(workspace.id, "users", {
    id: "first-owner", name: "首位负责人", roleId: "role-owner", status: "active",
  }, options);
  assert.equal(store.getState().activeUserId, user.id);
  store.actions.replaceWorkspace(workspace.id, { ...store.getActiveWorkspace(), users: [], localUsersConfigured: false }, options);
  const reloaded = createFinanceDeskStore({ repository });
  assert.equal(reloaded.getState().activeUserId, null);
  assert.throws(() => reloaded.actions.upsertEntity(workspace.id, "users", { name: "重新冒用首次配置", roleId: "role-owner", status: "active" }, options), /没有可用的本地用户/);
});
