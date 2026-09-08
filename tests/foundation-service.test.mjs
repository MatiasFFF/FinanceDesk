import test from "node:test";
import assert from "node:assert/strict";
import {
  FINANCE_DESK_OPERATIONS, createBlankWorkspace, createFinanceDeskService, createFinanceDeskStore,
  createInitialState, createLocalFoundationRepository, createMemoryFileVault, createMemoryStorage,
  getWorkspace, prepareBankImport, removeLocalDocument, saveLocalDocument,
} from "../src/foundation.js";
import { activateWorkspacePeriod, capturePeriodState } from "../src/domain/periods.js";

const now = () => new Date("2026-09-08T08:00:00.000Z");
const csv = "日期,对方,摘要,收入,支出,流水号,余额\n2026-08-01,客户甲,服务款,100,,S001,200\n2026-08-02,银行,手续费,,25,S002,175";
const file = (content = csv) => Object.assign(new Blob([content], { type: "text/csv" }), { name: "银行流水.csv" });

function fixture({ users = false, resolveWorkspaceUserId } = {}) {
  const workspaces = ["view", "target"].map((id) => {
    const workspace = createBlankWorkspace({ id, name: id, currentPeriod: "2026-09",
      ...(users ? { initialUserName: `${id}负责人`, initialUserRoleId: "role-owner" } : {}),
    }, { now });
    workspace.bankAccounts = [{ id: `${id}-bank`, name: "银行账户", accountNumber: id === "view" ? "1234" : "5678", currency: "CNY", status: "active", openingBalance: 900, statementClosing: 950 }];
    workspace.accounts = workspace.bankAccounts;
    workspace.periodStates = { "2026-09": capturePeriodState(workspace), "2026-08": {
      ...capturePeriodState(workspace), tax: { ...workspace.tax, period: "2026-08", vatRate: 0.01 },
      filing: { period: "2026-08" }, bankBalances: { [`${id}-bank`]: { openingBalance: 100, statementClosing: 175 } },
    } };
    return workspace;
  });
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now });
  repository.save({ ...createInitialState({ now }), workspaces, activeWorkspaceId: "view", activeUserId: workspaces[0].users[0]?.id || null });
  const store = createFinanceDeskStore({ repository, ...(resolveWorkspaceUserId ? { resolveWorkspaceUserId } : {}) });
  const fileVault = createMemoryFileVault();
  const service = createFinanceDeskService({ store, fileVault });
  return { store, fileVault, service, repository, storage };
}

async function preview(f, extra = {}) {
  const parsed = await f.service.registerBankFile(file(), { workspaceId: "target" });
  const plan = f.service.prepareBankImport({ workspaceId: "target", period: "2026-08", accountId: "target-bank", fileRef: parsed.fileRef, ...extra });
  return { parsed, plan, input: { workspaceId: "target", planId: plan.planId } };
}

test("pure JS service imports into another workspace and month without changing the displayed selections", async () => {
  const f = fixture();
  const beforeView = structuredClone(getWorkspace(f.store.getState(), "view"));
  const before = f.store.getState();
  assert.equal(f.service.listWorkspaces().workspaces.length, 2);
  const context = f.service.getWorkspaceContext({ workspaceId: "target", period: "2026-08" });
  assert.equal(context.accounts[0].openingBalance, 100);
  assert.equal(f.store.getState(), before, "queries do not write or navigate");
  const { plan, input } = await preview(f);
  assert.equal(plan.importableRowCount, 2);
  const result = await f.service.executeBankImport(input);
  assert.equal(result.status, "imported");
  assert.equal(result.counts.imported, 2);
  assert.equal(result.import.id, plan.planId);
  assert.equal(result.transactionIds.length, 2);
  assert.equal(result.documentIds.length, 1);
  const state = f.store.getState();
  assert.equal(state.activeWorkspaceId, "view");
  assert.deepEqual(getWorkspace(state, "view"), beforeView);
  const target = getWorkspace(state, "target");
  assert.equal(target.currentPeriod, "2026-09");
  assert.equal(target.bankAccounts[0].openingBalance, 900);
  assert.equal(target.bankAccounts[0].statementClosing, 950);
  const august = activateWorkspacePeriod(target, "2026-08");
  assert.equal(august.bankAccounts[0].openingBalance, 100);
  assert.equal(august.bankAccounts[0].statementClosing, 175);
  assert.equal(august.tax.vatRate, 0.01);
  assert.equal(target.documents[0].hash, plan.fileHash);
  assert.deepEqual(target.documents[0].relatedObjectIds, ["target-bank"]);
  assert.ok(target.evidenceLinks.some((link) => link.documentIds.includes(result.documentIds[0]) && link.objectIds.includes("target-bank")));
  assert.ok(target.transactions.every((transaction) => transaction.evidenceIds.includes(result.documentIds[0]) && transaction.importId === result.import.id));
  assert.equal(await (await f.fileVault.get(result.documentIds[0])).blob.text(), csv);
  assert.ok(result.nextActions.some((action) => action.action === "review_bank_transactions" && action.transactionIds.length === 2));
  assert.ok(result.missingItems.length, "unknown counterparty remains a meaningful review item");
  assert.deepEqual(f.service.getBankImportResult({ workspaceId: "target", importId: result.import.id }), result);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  const reloaded = createFinanceDeskStore({ repository: f.repository });
  assert.equal(activateWorkspacePeriod(getWorkspace(reloaded.getState(), "target"), "2026-08").bankAccounts[0].statementClosing, 175);
  f.store.actions.switchWorkspace("target");
  f.store.actions.setPeriod("target", result.period);
  assert.equal(f.store.getActiveWorkspace().currentPeriod, "2026-08", "page can still explicitly navigate after importing");
});

test("registered bytes and stored plans cannot be replaced by caller-supplied workspaces, files, plans or actors", async () => {
  const f = fixture();
  const { parsed, plan } = await preview(f);
  plan.transactions[0].amount = 999999;
  parsed.table[1][3] = 999999;
  assert.equal((await f.service.executeBankImport({ workspaceId: "target", planId: plan.planId })).import.transactions[0].amount, 100);
  for (const bad of [{ actor: "经营者" }, { workspace: {} }, { transactions: [] }, { file: {} }]) {
    const result = await f.service.invoke("executeBankImport", { workspaceId: "target", planId: plan.planId, ...bad });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_OPERATION_INPUT");
  }
  assert.equal((await f.service.invoke("executeBankImport", { workspaceId: "view", planId: plan.planId })).error.code, "BANK_PLAN_EXPIRED");
  assert.equal((await f.service.invoke("replaceWorkspace", {})).error.code, "UNKNOWN_OPERATION");
  await assert.rejects(f.service.registerBankFile({ name: "fake.csv", arrayBuffer() {} }, { workspaceId: "target" }), /真实 File 或 Blob/);
  assert.deepEqual(FINANCE_DESK_OPERATIONS.map((item) => item.name).sort(), ["executeBankImport", "getBankImportResult", "getWorkspaceContext", "listWorkspaces", "prepareBankImport"].sort());
});

test("repeated requests, concurrent same-plan requests and a reselected duplicate file never duplicate entries or originals", async () => {
  const f = fixture();
  const { input } = await preview(f);
  const [a, b] = await Promise.all([f.service.executeBankImport(input), f.service.executeBankImport(input)]);
  assert.deepEqual(a, b);
  assert.equal((await f.service.executeBankImport(input)).status, "already_imported");
  const repeated = await preview(f);
  const duplicate = await f.service.executeBankImport(repeated.input);
  assert.equal(duplicate.status, "duplicate");
  assert.deepEqual(duplicate.counts, { imported: 0, duplicates: 2, errors: 0 });
  assert.deepEqual(duplicate.transactionIds.sort(), a.transactionIds.sort());
  assert.equal(getWorkspace(f.store.getState(), "target").bankImports.length, 1);
  assert.equal((await f.fileVault.listByWorkspace("target")).length, 1);
});

test("asynchronous original writes preserve unrelated edits and use the latest automatic balances", async () => {
  const f = fixture();
  const { input } = await preview(f);
  const put = f.fileVault.put.bind(f.fileVault);
  f.fileVault.put = async (record) => {
    await put(record);
    f.store.actions.updateCompanyProfile("target", { legalName: "保存原件期间的新公司名称" });
    const target = structuredClone(getWorkspace(f.store.getState(), "target"));
    target.periodStates["2026-08"].bankBalances["target-bank"].openingBalance = 200;
    f.store.actions.replaceWorkspace("target", target);
  };
  const result = await f.service.executeBankImport(input);
  assert.equal(result.import.reconciliation.openingBalance, 200);
  assert.equal(getWorkspace(f.store.getState(), "target").company.legalName, "保存原件期间的新公司名称");
  assert.ok(result.nextActions.some((action) => action.action === "reconcile_bank_account"));
});

test("duplicate results still identify older transactions that have no stored dedupeKey", async () => {
  const f = fixture();
  const first = await preview(f);
  const saved = await f.service.executeBankImport(first.input);
  const target = getWorkspace(f.store.getState(), "target");
  f.store.actions.replaceWorkspace("target", { ...target, transactions: target.transactions.map(({ dedupeKey, ...transaction }) => transaction) });
  const repeated = await preview(f);
  const result = await f.service.executeBankImport(repeated.input);
  assert.equal(result.status, "duplicate");
  assert.deepEqual(result.transactionIds.sort(), saved.transactionIds.sort());
  assert.deepEqual(result.importIds, saved.importIds);
  assert.equal((await f.fileVault.listByWorkspace("target")).length, 1);
});

test("an older explicit balance cannot silently overwrite a balance edited during import", async () => {
  const f = fixture();
  const { input } = await preview(f, { openingBalance: 100, statementClosing: 175 });
  const put = f.fileVault.put.bind(f.fileVault);
  f.fileVault.put = async (record) => {
    await put(record);
    const target = structuredClone(getWorkspace(f.store.getState(), "target"));
    target.periodStates["2026-08"].bankBalances["target-bank"].openingBalance = 200;
    f.store.actions.replaceWorkspace("target", target);
  };
  await assert.rejects(f.service.executeBankImport(input), { code: "BANK_BALANCE_CHANGED" });
  const target = getWorkspace(f.store.getState(), "target");
  assert.equal(activateWorkspacePeriod(target, "2026-08").bankAccounts[0].openingBalance, 200);
  assert.equal(target.transactions.length, 0);
  assert.equal((await f.fileVault.listByWorkspace("target")).length, 0);
});

test("late duplicates remove only this attempt's unused original", async () => {
  const f = fixture();
  const { parsed, input } = await preview(f);
  const getOwned = f.fileVault.getOwned.bind(f.fileVault);
  let injected = false;
  f.fileVault.getOwned = async (...args) => {
    const record = await getOwned(...args);
    if (!injected) {
      injected = true;
      const plan = prepareBankImport(getWorkspace(f.store.getState(), "target"), { table: parsed.table, fileName: "同时导入.csv", accountId: "target-bank", period: "2026-08" });
      f.store.actions.applyBankImport("target", plan);
    }
    return record;
  };
  const result = await f.service.executeBankImport(input);
  assert.equal(result.status, "duplicate");
  assert.equal(getWorkspace(f.store.getState(), "target").transactions.length, 2);
  assert.equal(getWorkspace(f.store.getState(), "target").documents.length, 0);
  assert.equal((await f.fileVault.listByWorkspace("target")).length, 0);
});

test("failed original or bank writes clean newly created data; a source adopted by other work remains intact", async () => {
  for (const failure of ["original", "bank", "adopted"]) {
    const f = fixture();
    const { input } = await preview(f);
    if (failure === "original") {
      const put = f.fileVault.put.bind(f.fileVault);
      f.fileVault.put = async (record) => { await put(record); throw new Error("原件存储失败"); };
    } else f.store.actions.applyBankImport = (_id, plan) => {
      if (failure === "adopted") f.store.actions.linkEvidence("target", { documentIds: [plan.sourceDocumentId], objectIds: ["target-bank"] });
      throw new Error("入账保存失败");
    };
    await assert.rejects(f.service.executeBankImport(input), (error) => {
      assert.match(error.message, /失败/);
      if (failure === "adopted") assert.match(error.cleanup.message, /正在使用/);
      return true;
    });
    const target = getWorkspace(f.store.getState(), "target");
    assert.equal(target.transactions.length, 0);
    assert.equal(target.documents.length, failure === "adopted" ? 1 : 0);
    assert.equal((await f.fileVault.listByWorkspace("target")).length, failure === "adopted" ? 1 : 0);
  }
});

test("archive, account removal and permission changes during original I/O prevent importing into an invalid target", async () => {
  for (const change of ["archive", "account"]) {
    const f = fixture();
    const { input } = await preview(f);
    const put = f.fileVault.put.bind(f.fileVault);
    f.fileVault.put = async (record) => {
      await put(record);
      const target = getWorkspace(f.store.getState(), "target");
      f.store.actions.replaceWorkspace("target", change === "archive"
        ? { ...target, delivery: { ...target.delivery, archives: [{ id: "archive-aug", period: "2026-08" }] } }
        : { ...target, bankAccounts: [], accounts: [] });
    };
    await assert.rejects(f.service.executeBankImport(input), change === "archive" ? /归档/ : /找不到银行账户/);
    assert.equal(getWorkspace(f.store.getState(), "target").transactions.length, 0);
    assert.equal((await f.fileVault.listByWorkspace("target")).length, 0);
  }
  const f = fixture({ users: true, resolveWorkspaceUserId: (id, state) => getWorkspace(state, id).users[0].id });
  const { input } = await preview(f);
  const put = f.fileVault.put.bind(f.fileVault);
  f.fileVault.put = async (record) => {
    await put(record);
    f.store.actions.upsertEntity("target", "roles", { id: "role-owner", name: "只读负责人", status: "active", permissions: ["data.read"] });
  };
  await assert.rejects(f.service.executeBankImport(input), /缺少权限/);
  assert.equal(getWorkspace(f.store.getState(), "target").transactions.length, 0);
});

test("non-active workspaces require a real local identity; audit names cannot grant permission", async () => {
  const blocked = fixture({ users: true });
  assert.deepEqual(blocked.service.listWorkspaces().workspaces.map((item) => item.id), ["view"]);
  await assert.rejects(preview(blocked), /没有可用的本地用户/);
  const f = fixture({ users: true, resolveWorkspaceUserId: (id, state) => getWorkspace(state, id).users[0].id });
  const beforeUser = f.store.getState().activeUserId;
  const { input } = await preview(f);
  const result = await f.service.executeBankImport(input);
  assert.equal(result.import.actor, "target负责人");
  assert.equal(f.store.getState().activeUserId, beforeUser);
  assert.equal(f.store.getState().activeWorkspaceId, "view");
  f.store.actions.upsertEntity("target", "roles", { id: "role-owner", name: "权限已撤销", status: "active", permissions: [] });
  await assert.rejects(f.service.executeBankImport(input), /缺少权限 data\.read/);
});

test("file and plan references expire on release, while an in-flight import retains its original", async () => {
  const f = fixture();
  const { parsed, input } = await preview(f);
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const put = f.fileVault.put.bind(f.fileVault);
  f.fileVault.put = async (record) => { entered(); await gate; return put(record); };
  const running = f.service.executeBankImport(input);
  await waiting;
  f.service.releaseBankFile(parsed.fileRef);
  resume();
  assert.equal((await running).counts.imported, 2);
  await assert.rejects(f.service.executeBankImport(input), { code: "BANK_PLAN_EXPIRED" });
  assert.throws(() => f.service.prepareBankImport({ workspaceId: "target", period: "2026-08", accountId: "target-bank", fileRef: parsed.fileRef }), { code: "FILE_REFERENCE_EXPIRED" });
});

test("an archived displayed month does not block importing into another open month", async () => {
  const f = fixture();
  const target = getWorkspace(f.store.getState(), "target");
  f.store.actions.replaceWorkspace("target", { ...target, delivery: { ...target.delivery, archives: [{ id: "archive-sep", period: "2026-09" }] } });
  const { input } = await preview(f);
  assert.equal((await f.service.executeBankImport(input)).counts.imported, 2);
  assert.equal(getWorkspace(f.store.getState(), "target").currentPeriod, "2026-09");
});

test("asynchronous deletion keeps concurrent company edits and refuses new links, metadata changes or archiving", async () => {
  for (const change of ["company", "link", "metadata", "archive"]) {
    const f = fixture();
    const document = await saveLocalDocument({ store: f.store, fileVault: f.fileVault, workspaceId: "target", file: file(), metadata: { period: "2026-08" } });
    const remove = f.fileVault.delete.bind(f.fileVault);
    f.fileVault.delete = async (id) => {
      await remove(id);
      f.store.actions.updateCompanyProfile("target", { legalName: "删除期间的新公司名称" });
      const target = getWorkspace(f.store.getState(), "target");
      if (change === "link") f.store.actions.linkEvidence("target", { documentIds: [document.id], objectIds: ["target-bank"] });
      if (change === "metadata") f.store.actions.upsertEntity("target", "documents", { ...document, name: "刚改的新名称.csv" });
      if (change === "archive") f.store.actions.replaceWorkspace("target", { ...target, delivery: { ...target.delivery, archives: [{ id: "archive-aug", period: "2026-08" }] } });
    };
    const deletion = removeLocalDocument({ store: f.store, fileVault: f.fileVault, workspaceId: "target", documentId: document.id });
    if (change === "company") await deletion;
    else await assert.rejects(deletion, /正在使用|已变化|归档/);
    const target = getWorkspace(f.store.getState(), "target");
    assert.equal(target.company.legalName, "删除期间的新公司名称");
    assert.equal(target.documents.length, change === "company" ? 0 : 1);
    assert.equal(Boolean(await f.fileVault.get(document.id)), change !== "company");
  }
});
