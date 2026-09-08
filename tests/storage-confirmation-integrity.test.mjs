import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { FINANCE_DESK_STORAGE_KEY, createBlankWorkspace, createInitialState, hasWorkspacePermission } from "../src/domain/foundation.js";
import { confirmOpeningBalances } from "../src/domain/periods.js";
import { createLocalFoundationRepository, createMemoryStorage } from "../src/storage/localFoundationRepository.js";
import { createFinanceDeskStore } from "../src/store/financeDeskStore.js";
import { ensureWorkspace, freezeReportVersion, prepareFilingDraft, workflowChecks } from "../src/productWorkflow.js";

const now = () => new Date("2026-09-07T08:00:00.000Z");

function seed(storage = createMemoryStorage(), { users = false } = {}) {
  const workspace = createBlankWorkspace({ id: "integrity-workspace", name: "安全保存工作台", currentPeriod: "2026-09", modules: { reconcile: false, payroll: false },
    ...(users ? { initialUserName: "负责人", initialUserRoleId: "role-owner" } : {}),
  }, { now });
  if (users) {
    workspace.roles.push({ id: "role-editor", name: "仅编辑", status: "active", permissions: ["data.read", "data.write"] });
    workspace.users.push({ id: "finance", name: "财务", roleId: "role-finance", status: "active" },
      { id: "editor", name: "仅编辑人员", roleId: "role-editor", status: "active" });
  }
  createLocalFoundationRepository({ storage, now }).save({ ...createInitialState({ now }), workspaces: [workspace], activeWorkspaceId: workspace.id, activeUserId: workspace.users[0]?.id || null });
  return storage;
}

function storeFor(storage, options = {}) {
  return createFinanceDeskStore({ repository: createLocalFoundationRepository({ storage, now, ...options }) });
}

// Deterministic implementation of the exclusive request/abort contract used by
// the repository; real browser lock behavior is a separate integration check.
function exclusiveLocks() {
  const held = new Set();
  const queue = [];
  function drain() {
    for (const entry of [...queue]) {
      if (held.has(entry.name)) continue;
      queue.splice(queue.indexOf(entry), 1);
      entry.started = true;
      held.add(entry.name);
      Promise.resolve().then(() => entry.callback({ name: entry.name })).then(entry.resolve, entry.reject).finally(() => {
        held.delete(entry.name);
        drain();
      });
    }
  }
  return {
    request(name, { signal }, callback) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
        const entry = { name, callback, resolve, reject, started: false };
        signal.addEventListener("abort", () => {
          if (entry.started) return;
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
        queue.push(entry);
        drain();
      });
    },
  };
}

test("stale store cannot overwrite another window's bill; its state and pending input are retained", () => {
  const storage = seed();
  const a = storeFor(storage);
  const b = storeFor(storage);
  const before = b.getState();
  const input = { financeContact: "尚未保存的联系人" };
  a.actions.upsertEntity(a.getActiveWorkspace().id, "bills", { id: "bill-from-a", amount: 1200, kind: "receivable", period: "2026-09", counterparty: "测试客户", date: "2026-09-01", dueDate: "2026-09-30" });
  const saved = storage.getItem(FINANCE_DESK_STORAGE_KEY);
  assert.throws(() => b.actions.updateCompanyProfile(b.getActiveWorkspace().id, input), { code: "LOCAL_STATE_STALE" });
  assert.equal(b.getState(), before);
  assert.equal(input.financeContact, "尚未保存的联系人");
  assert.equal(storage.getItem(FINANCE_DESK_STORAGE_KEY), saved);
  assert.ok(storeFor(storage).getActiveWorkspace().bills.some((bill) => bill.id === "bill-from-a"));
  assert.equal(b.getPersistenceStatus().canWrite, false);
});

test("only the window holding the write session can save, and unchanged waiting windows may take over", async (t) => {
  const storage = seed();
  const lockManager = exclusiveLocks();
  const a = storeFor(storage, { lockManager });
  const b = storeFor(storage, { lockManager });
  const stopA = a.startPersistenceSession();
  const stopB = b.startPersistenceSession();
  t.after(stopA); t.after(stopB);
  await nextTurn();
  assert.equal(a.getPersistenceStatus().canWrite, true);
  assert.equal(b.getPersistenceStatus().canWrite, false);
  const before = b.getState();
  assert.throws(() => b.actions.replaceWorkspace(b.getActiveWorkspace().id, b.getActiveWorkspace()), { code: "LOCAL_SAVE_PAUSED" });
  assert.equal(b.getState(), before);
  stopA();
  await nextTurn();
  assert.equal(a.getPersistenceStatus().canWrite, false);
  assert.equal(b.getPersistenceStatus().canWrite, true);
  b.actions.upsertEntity(b.getActiveWorkspace().id, "bills", { id: "after-takeover", amount: 50, kind: "payable", counterparty: "测试供应商", date: "2026-09-02", dueDate: "2026-09-30" });
  b.actions.setPeriod(b.getActiveWorkspace().id, "2026-08");
  b.actions.setPeriod(b.getActiveWorkspace().id, "2026-09");
  assert.equal(b.getPersistenceStatus().canWrite, true, "same SPA navigation does not release its session");
  assert.ok(b.getActiveWorkspace().bills.some((bill) => bill.id === "after-takeover"));
});

test("storage notices preserve local drafts; stale lock takeover and delayed saves remain blocked", async (t) => {
  const storage = seed();
  const lockManager = exclusiveLocks();
  const eventTarget = new EventTarget();
  const a = storeFor(storage, { lockManager, eventTarget });
  const b = storeFor(storage, { lockManager, eventTarget });
  const stopA = a.startPersistenceSession();
  const stopB = b.startPersistenceSession();
  t.after(stopA); t.after(stopB);
  await nextTurn();
  const before = b.getState();
  const delayedWorkspace = { ...b.getActiveWorkspace(), documents: [{ id: "late-document", name: "原件返回" }] };
  a.actions.upsertEntity(a.getActiveWorkspace().id, "bills", { id: "new-bill", amount: 300, kind: "receivable", counterparty: "测试客户", date: "2026-09-03", dueDate: "2026-09-30" });
  eventTarget.dispatchEvent(Object.assign(new Event("storage"), { key: FINANCE_DESK_STORAGE_KEY, storageArea: storage }));
  assert.equal(a.getPersistenceStatus().canWrite, true);
  assert.equal(b.getPersistenceStatus().status, "stale");
  assert.equal(b.getState(), before);
  stopA();
  await nextTurn();
  assert.equal(b.getPersistenceStatus().status, "stale");
  assert.throws(() => b.actions.replaceWorkspace(delayedWorkspace.id, delayedWorkspace, { requiredPermission: "data.read", allowArchivedTransition: true }), { code: "LOCAL_STATE_STALE" });
  assert.equal(b.getState(), before);
  assert.equal(delayedWorkspace.documents[0].name, "原件返回");
  const fresh = storeFor(storage, { lockManager });
  const stopFresh = fresh.startPersistenceSession();
  t.after(stopFresh);
  await nextTurn();
  assert.equal(fresh.getPersistenceStatus().canWrite, true, "a stale waiting page does not keep the writer lock");
  assert.ok(fresh.getActiveWorkspace().bills.some((bill) => bill.id === "new-bill"));
});

test("StrictMode setup/cleanup/setup leaves one usable session and seed persistence waits for that session", async (t) => {
  const storage = createMemoryStorage();
  const store = storeFor(storage, { lockManager: exclusiveLocks() });
  assert.equal(storage.getItem(FINANCE_DESK_STORAGE_KEY), null);
  store.startPersistenceSession()();
  const stop = store.startPersistenceSession();
  t.after(stop);
  await nextTurn();
  assert.equal(store.getPersistenceStatus().canWrite, true);
  assert.ok(storage.getItem(FINANCE_DESK_STORAGE_KEY));
  store.actions.renameWorkspace(store.getActiveWorkspace().id, "正常单窗口");
  assert.equal(store.getActiveWorkspace().name, "正常单窗口");
});

test("missing or rejected lock support pauses persistence without mutating data", async () => {
  for (const lockManager of [null, { request() { throw new Error("unavailable"); } }]) {
    const storage = seed();
    const saved = storage.getItem(FINANCE_DESK_STORAGE_KEY);
    const store = storeFor(storage, { lockManager });
    const stop = store.startPersistenceSession();
    await nextTurn();
    assert.equal(store.getPersistenceStatus().status, "unsupported");
    assert.throws(() => store.actions.replaceWorkspace(store.getActiveWorkspace().id, store.getActiveWorkspace()), { code: "LOCAL_SAVE_PAUSED" });
    assert.equal(storage.getItem(FINANCE_DESK_STORAGE_KEY), saved);
    stop();
  }
});

function prepareConfirmationStore({ users = true } = {}) {
  const store = storeFor(seed(createMemoryStorage(), { users }));
  const current = ensureWorkspace(store.getActiveWorkspace());
  store.actions.replaceWorkspace(current.id, freezeReportVersion(confirmOpeningBalances(current, {}, "负责人"), "负责人"));
  return store;
}

function confirmAllSections(store) {
  const version = workflowChecks(ensureWorkspace(store.getActiveWorkspace())).version;
  for (const section of ["revenue", "costExpense", "vat", "inputVat", "finance", "openItems"]) {
    store.actions.recordInitialConfirmationSection(store.getActiveWorkspace().id, {
      reportVersionId: version.id, section, decision: "approve", note: "已核对冻结来源", confirmationName: "实际确认人",
    });
  }
  store.actions.replaceWorkspace(store.getActiveWorkspace().id, prepareFilingDraft(ensureWorkspace(store.getActiveWorkspace()), "财务"));
}

function finalInput(store) {
  const workspace = ensureWorkspace(store.getActiveWorkspace());
  return { reportVersionId: workflowChecks(workspace).version.id, filingDraftCreatedAt: workspace.delivery.filing.draftCreatedAt,
    name: "实际负责人", selections: { numbersReviewed: true, risksAcknowledged: true, localOnlyAcknowledged: true, deductionAuthorization: "do_not_authorize" } };
}

test("data.write cannot substitute for either confirmation permission or caller-supplied overrides", () => {
  const store = prepareConfirmationStore();
  const id = store.getActiveWorkspace().id;
  store.actions.switchUser(id, "editor");
  const editor = store.getActiveWorkspace().users.find((user) => user.id === "editor");
  assert.equal(editor.roleId, "role-editor");
  assert.equal(editor.role, "财务负责人", "a legacy display name cannot override the assigned role ID");
  assert.equal(hasWorkspacePermission(store.getState(), id, "data.write"), true);
  assert.equal(hasWorkspacePermission(store.getState(), id, "confirm.finance"), false);
  assert.equal(hasWorkspacePermission(store.getState(), id, "confirm.owner"), false);
  const before = store.getState();
  const override = { requiredPermission: "data.write", allowArchivedTransition: true };
  assert.throws(() => store.actions.recordInitialConfirmationSection(id, { confirmationName: "经营者" }, override), /confirm\.finance/);
  assert.throws(() => store.actions.recordFinalConfirmation(id, { name: "经营者" }, override), /confirm\.owner/);
  assert.throws(() => store.actions.upsertEntity(id, "confirmations", { id: "forged-initial", sections: { finance: { status: "approved" } } }), /confirm\.finance/);
  assert.throws(() => store.actions.upsertEntity(id, "confirmations", { id: "forged-final", kind: "final", status: "approved", signature: { name: "负责人" } }), /confirm\.owner/);
  assert.throws(() => store.actions.replaceWorkspace(id, { ...store.getActiveWorkspace(), tax: { ...store.getActiveWorkspace().tax, ownerConfirmedAt: now().toISOString() } }), /confirm\.owner/);
  assert.throws(() => store.actions.replaceWorkspace(id, { ...store.getActiveWorkspace(), periodStates: { ...store.getActiveWorkspace().periodStates, "2026-08": { tax: { financeConfirmedAt: now().toISOString() } } } }), /confirm\.finance/);
  assert.equal(store.getState(), before);
});

test("missing or disabled assigned roles cannot borrow permission from an owner display name", () => {
  for (const roleState of ["missing", "inactive"]) {
    const storage = seed(createMemoryStorage(), { users: true });
    const repository = createLocalFoundationRepository({ storage, now });
    const state = repository.load().state;
    const workspace = state.workspaces[0];
    const editor = workspace.users.find((user) => user.id === "editor");
    editor.role = "经营者";
    if (roleState === "missing") editor.roleId = "role-not-found";
    else workspace.roles.find((role) => role.id === editor.roleId).status = "inactive";
    repository.save(state);
    const store = storeFor(storage);
    const id = workspace.id;
    const editorState = { ...store.getState(), activeUserId: "editor" };
    assert.equal(hasWorkspacePermission(editorState, id, "data.write"), false);
    assert.equal(hasWorkspacePermission(editorState, id, "confirm.finance"), false);
    assert.equal(hasWorkspacePermission(editorState, id, "confirm.owner"), false);
    assert.throws(() => store.actions.switchUser(id, "editor"), /没有可用的启用角色/);
  }
});

test("finance can save first confirmations, only owner can save final confirmation, and history remains navigable", () => {
  const store = prepareConfirmationStore();
  const id = store.getActiveWorkspace().id;
  const ownerId = store.getState().activeUserId;
  store.actions.switchUser(id, "finance");
  confirmAllSections(store);
  const beforeFinal = store.getState();
  assert.throws(() => store.actions.recordFinalConfirmation(id, finalInput(store)), /confirm\.owner/);
  assert.equal(store.getState(), beforeFinal);
  store.actions.switchUser(id, ownerId);
  store.actions.recordFinalConfirmation(id, finalInput(store));
  const finalId = store.getActiveWorkspace().tax.finalConfirmationId;
  assert.ok(finalId);
  assert.equal(store.getActiveWorkspace().confirmations.at(-1).signature.name, "实际负责人");
  store.actions.switchUser(id, "editor");
  store.actions.setPeriod(id, "2026-08");
  store.actions.setPeriod(id, "2026-09");
  assert.equal(store.getActiveWorkspace().tax.finalConfirmationId, finalId);
  const current = store.getActiveWorkspace();
  store.actions.replaceWorkspace(id, { ...current, tax: { ...current.tax, financeConfirmedAt: null, ownerConfirmedAt: null, ownerConfirmedVersionId: null, confirmedBy: "" },
    delivery: { ...current.delivery, filing: { ...current.delivery.filing, finalConfirmedVersionId: null } } });
  assert.equal(store.getActiveWorkspace().tax.ownerConfirmedAt, null, "invalidating a saved confirmation does not require granting one");
});

test("first-use workspace without users retains local confirmations; archived periods reject new confirmations", () => {
  const store = prepareConfirmationStore({ users: false });
  const id = store.getActiveWorkspace().id;
  assert.equal(hasWorkspacePermission(store.getState(), id, "confirm.owner"), true);
  confirmAllSections(store);
  const input = finalInput(store);
  store.actions.recordFinalConfirmation(id, input);
  assert.ok(store.getActiveWorkspace().tax.ownerConfirmedAt);
  const current = store.getActiveWorkspace();
  store.actions.replaceWorkspace(id, { ...current, delivery: { ...current.delivery, archives: [{ id: "archive", period: current.currentPeriod, archivedAt: now().toISOString() }] } });
  assert.throws(() => store.actions.recordFinalConfirmation(id, input, { allowArchivedTransition: true }), /归档/);
  assert.throws(() => store.actions.recordInitialConfirmationSection(id, {}, { allowArchivedTransition: true }), /归档/);
});
