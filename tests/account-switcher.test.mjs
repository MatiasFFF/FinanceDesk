import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createLocalFoundationRepository, createMemoryStorage } from "../src/storage/localFoundationRepository.js";
import { createFinanceDeskStore } from "../src/store/financeDeskStore.js";

const fixedNow = () => new Date("2026-09-05T10:00:00.000Z");

test("switchUser immediately changes the current local operator and records its attribution", () => {
  const repository = createLocalFoundationRepository({ storage: createMemoryStorage(), now: fixedNow });
  const store = createFinanceDeskStore({ repository });
  const workspaceId = store.getState().activeWorkspaceId;
  store.actions.upsertEntity(workspaceId, "users", {
    id: "user-second-finance",
    name: "林会计",
    roleId: "role-finance",
    role: "财务负责人",
    status: "active",
  });

  store.actions.switchUser(workspaceId, "user-second-finance");

  assert.equal(store.getState().activeUserId, "user-second-finance");
  assert.equal(store.getState().auditLog.at(-1).action, "切换本地操作用户");
  assert.equal(store.getState().auditLog.at(-1).actor, "林会计");
});

test("sidebar switcher and modal layout hooks are wired to the requested structures", () => {
  const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const managerSource = readFileSync(new URL("../src/features/workspaces/WorkspaceManager.jsx", import.meta.url), "utf8");

  for (const className of ["account-switcher", "account-switcher-trigger", "account-switcher-menu", "account-switcher-empty", "bank-import-dialog", "workspace-mode-cards", "workspace-module-grid"]) {
    assert.ok(appSource.includes(className), `App.jsx 缺少 ${className}`);
  }
  assert.match(appSource, /actions\.switchUser\(current\.id, user\.id\)/);
  assert.match(appSource, /onPage\("setup"\)/);
  assert.match(appSource, /activeUsers\.map/);
  assert.match(appSource, /user\.id === operator\?\.id && <Check/);
  assert.equal((managerSource.match(/className="workspace-module-grid"/g) || []).length, 2);
  assert.equal((managerSource.match(/className="choice-cards"/g) || []).length, 0);
});
