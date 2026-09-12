import test from "node:test";
import assert from "node:assert/strict";
import {
  FINANCE_DESK_OPERATIONS, createBlankWorkspace, createFinanceDeskService, createFinanceDeskStore,
  createInitialState, createLocalFoundationRepository, createMemoryFileVault, createMemoryStorage,
  getWorkspace, prepareBankImport, removeLocalDocument, saveLocalDocument,
} from "../src/foundation.js";
import { activateWorkspacePeriod, capturePeriodState } from "../src/domain/periods.js";
import { bankExceptionTasksForPeriod, reconcileBankAccountPeriod } from "../src/features/intake/bankStatementImport.js";

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
  assert.deepEqual(FINANCE_DESK_OPERATIONS.map((item) => item.name).sort(), ["executeBankImport", "getBankImportResult", "getWorkspaceContext", "listWorkspaces", "prepareBankImport", "getVoucherContext", "postVoucher", "importReceipt", "reverseAdvanceApplication"].sort());
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

test("bank options reject malformed values before storage while keeping empty UI mappings and zero-threshold defaults", async () => {
  const f = fixture();
  const parsed = await f.service.registerBankFile(file(), { workspaceId: "target" });
  const input = { workspaceId: "target", period: "2026-08", accountId: "target-bank", fileRef: parsed.fileRef };
  const before = f.store.getState();
  const badOptions = [
    { mapping: [] }, { mapping: { date: "0" } }, { mapping: { date: -1 } },
    { mapping: { date: 0.5 } }, { mapping: { date: parsed.table[0].length } }, { mapping: { unknown: 0 } },
    { openingBalance: NaN }, { statementClosing: Infinity }, { openingBalance: Number.MAX_VALUE },
    { statementClosing: "不是金额" }, { openingBalance: {} },
    { largeTransactionThreshold: "10000" }, { largeTransactionThreshold: -1 }, { largeTransactionThreshold: Infinity },
    { counterpartyMappings: [] }, { counterpartyMappings: { key: "客户甲" } },
    { counterpartyMappings: { key: { objectId: 12 } } }, { counterpartyMappings: { key: { unexpected: "值" } } },
  ];
  for (const options of badOptions) {
    assert.throws(() => f.service.prepareBankImport({ ...input, ...options }), { code: "BANK_IMPORT_INPUT_INVALID" });
    assert.throws(() => prepareBankImport(getWorkspace(before, "target"), { ...input, table: parsed.table, ...options }), { code: "BANK_IMPORT_INPUT_INVALID" });
  }
  const valid = f.service.prepareBankImport({ ...input, mapping: {}, counterpartyMappings: {}, openingBalance: "  ", statementClosing: null, largeTransactionThreshold: 0 });
  assert.equal(valid.importableRowCount, 2);
  assert.equal(valid.reconciliation.openingBalance, 100);
  assert.equal(valid.reconciliation.statementClosing, 175);
  assert.ok(valid.largeTransactionThreshold >= 10000);
  const numericStrings = f.service.prepareBankImport({ ...input, openingBalance: "100.00", statementClosing: "175.00" });
  assert.equal(numericStrings.reconciliation.passed, true);
  assert.equal(f.store.getState(), before);
  assert.equal((await f.fileVault.listByWorkspace("target")).length, 0);
});

test("counterparty mappings resolve target-workspace identities and preserve departed personnel and manual names", async () => {
  const f = fixture();
  f.store.actions.replaceWorkspace("view", { ...getWorkspace(f.store.getState(), "view"), counterparties: [{ id: "foreign-partner", name: "其他工作台客户", kind: "customer", status: "active" }] });
  f.store.actions.replaceWorkspace("target", { ...getWorkspace(f.store.getState(), "target"),
    counterparties: [{ id: "real-partner", name: "真实关联方", kind: "related_party", status: "inactive" }],
    personnelRecords: [{ id: "departed-person", name: "已离职员工", kind: "supplier", status: "departed" }],
  });
  const { parsed, plan } = await preview(f);
  const key = plan.transactions[0].counterpartyAliasKey;
  const input = { workspaceId: "target", period: "2026-08", accountId: "target-bank", fileRef: parsed.fileRef };
  const mapping = { rawName: "客户甲", counterpartyAccount: "", standardName: "调用方伪造的客户名称", objectType: "counterparty", objectId: "real-partner", kind: "customer", targetKey: "counterparty:real-partner" };
  for (const invalid of [{ objectId: "foreign-partner" }, { objectId: "missing" }, { objectType: "personnelRecord" }]) {
    const counterpartyMappings = { [key]: { ...mapping, ...invalid } };
    assert.throws(() => f.service.prepareBankImport({ ...input, counterpartyMappings }), { code: "BANK_COUNTERPARTY_UNAVAILABLE" });
    assert.throws(() => prepareBankImport(getWorkspace(f.store.getState(), "target"), { ...input, table: parsed.table, counterpartyMappings }), { code: "BANK_COUNTERPARTY_UNAVAILABLE" });
  }
  const actual = f.service.prepareBankImport({ ...input, counterpartyMappings: { [key]: mapping } });
  assert.equal(actual.transactions[0].counterparty, "真实关联方");
  assert.equal(actual.transactions[0].counterpartyKind, "related_party");
  assert.equal(actual.anomalyCounts.bank_related_party, 1, "caller cannot relabel a related party as an ordinary customer");
  const departed = f.service.prepareBankImport({ ...input, counterpartyMappings: { [key]: { ...mapping, objectType: "personnelRecord", objectId: "departed-person", targetKey: "personnelRecord:departed-person" } } });
  assert.equal(departed.transactions[0].counterparty, "已离职员工");
  assert.equal(departed.transactions[0].counterpartyKind, "employee");
  const settled = await f.service.executeBankImport({ workspaceId: "target", planId: departed.planId });
  assert.equal(settled.import.transactions[0].counterpartyObjectId, "departed-person", "departure does not erase a financial identity");

  const manualFixture = fixture();
  const manual = await preview(manualFixture, { counterpartyMappings: { [key]: { ...mapping, objectType: "manual", objectId: null, targetKey: "manual", standardName: " 手工标准名称 " } } });
  const manualResult = await manualFixture.service.executeBankImport(manual.input);
  assert.equal(manualResult.import.transactions[0].counterparty, "手工标准名称");
  assert.equal(manualResult.import.transactions[0].counterpartyObjectId, null);
  assert.equal(manualResult.import.transactions[0].counterpartyKind, "customer");
});

test("execution re-resolves renamed objects and refuses objects deleted during original I/O without orphaning data", async () => {
  for (const change of ["rename", "delete"]) {
    const f = fixture();
    f.store.actions.replaceWorkspace("target", { ...getWorkspace(f.store.getState(), "target"), counterparties: [{ id: "partner", name: "原名称", kind: "customer", status: "active" }] });
    const first = await preview(f);
    const mapping = { rawName: "客户甲", objectId: "partner", objectType: "counterparty", standardName: "原名称", kind: "customer" };
    const prepared = await preview(f, { counterpartyMappings: { [first.plan.transactions[0].counterpartyAliasKey]: mapping } });
    const put = f.fileVault.put.bind(f.fileVault);
    f.fileVault.put = async (record) => {
      await put(record);
      const target = getWorkspace(f.store.getState(), "target");
      f.store.actions.replaceWorkspace("target", { ...target, counterparties: change === "delete" ? [] : [{ ...target.counterparties[0], name: "最新名称", kind: "related_party", status: "inactive" }] });
    };
    if (change === "delete") {
      await assert.rejects(f.service.executeBankImport(prepared.input), { code: "BANK_COUNTERPARTY_UNAVAILABLE" });
      assert.equal(getWorkspace(f.store.getState(), "target").transactions.length, 0);
      assert.equal(getWorkspace(f.store.getState(), "target").documents.length, 0);
      assert.equal((await f.fileVault.listByWorkspace("target")).length, 0);
    } else {
      const result = await f.service.executeBankImport(prepared.input);
      assert.equal(result.import.transactions[0].counterparty, "最新名称");
      assert.equal(result.import.transactions[0].counterpartyKind, "related_party");
      const nextFile = await f.service.registerBankFile(file(csv.replaceAll("S00", "LATER-00")), { workspaceId: "target" });
      const next = f.service.prepareBankImport({ workspaceId: "target", period: "2026-08", accountId: "target-bank", fileRef: nextFile.fileRef });
      assert.equal(next.transactions[0].counterparty, "最新名称", "saved aliases retain still-existing inactive identities");
      assert.equal(next.transactions[0].counterpartyKind, "related_party");
    }
  }
});

test("saved, repeated-plan and duplicate-file results keep import snapshots but use the latest account reconciliation", async () => {
  const f = fixture();
  const first = await preview(f, { statementClosing: 999 });
  const saved = await f.service.executeBankImport(first.input);
  assert.equal(saved.import.monthlyReconciliation.passed, false);
  assert.ok(saved.missingItems.some((item) => item.code === "bank_monthly_reconciliation_incomplete"));
  const originalRecord = structuredClone(getWorkspace(f.store.getState(), "target").bankImports[0]);
  const august = activateWorkspacePeriod(getWorkspace(f.store.getState(), "target"), "2026-08");
  august.bankAccounts[0].statementClosing = 175;
  const rechecked = reconcileBankAccountPeriod(august, { accountId: "target-bank", period: "2026-08", reconciledAt: "2026-09-08T09:00:00.000Z" });
  f.store.actions.replaceWorkspace("target", activateWorkspacePeriod(rechecked.workspace, "2026-09"));
  const beforeQuery = f.store.getState();
  const queried = f.service.getBankImportResult({ workspaceId: "target", importId: saved.import.id });
  assert.equal(f.store.getState(), beforeQuery, "current results are computed without rewriting historical records");
  const repeated = await f.service.executeBankImport(first.input);
  const next = await preview(f);
  const duplicate = await f.service.executeBankImport(next.input);
  for (const result of [queried, repeated, duplicate]) {
    assert.equal(result.import.monthlyReconciliation.passed, false);
    assert.equal(result.importSnapshots[0].monthlyReconciliation.passed, false);
    assert.equal(result.currentReconciliation.passed, true);
    assert.equal(result.currentReconciliation.balanceSource, "account_recheck");
    assert.equal(result.nextActions.some((action) => action.action === "reconcile_bank_account"), false);
    assert.equal(result.missingItems.some((item) => item.code === "bank_monthly_reconciliation_incomplete"), false);
    assert.deepEqual(result.currentReconciliation, queried.currentReconciliation);
    assert.deepEqual(result.missingItems, queried.missingItems);
  }
  assert.deepEqual(getWorkspace(f.store.getState(), "target").bankImports[0], originalRecord);
  assert.equal(getWorkspace(f.store.getState(), "target").currentPeriod, "2026-09");
});

test("supplemental imports update current monthly results and duplicate files can identify several historical batches", async () => {
  const f = fixture();
  const header = "日期,对方,摘要,收入,支出,流水号,余额";
  const rows = ["2026-08-01,客户甲,服务款,100,,PART-1,200", "2026-08-02,客户乙,补收款,25,,PART-2,225"];
  async function importRows(selectedRows, balances) {
    const registered = await f.service.registerBankFile(file([header, ...selectedRows].join("\n")), { workspaceId: "target" });
    const plan = f.service.prepareBankImport({ workspaceId: "target", period: "2026-08", accountId: "target-bank", fileRef: registered.fileRef, ...balances });
    return f.service.executeBankImport({ workspaceId: "target", planId: plan.planId });
  }
  const first = await importRows([rows[0]], { openingBalance: 100, statementClosing: 225 });
  assert.equal(first.currentReconciliation.passed, false);
  const second = await importRows([rows[1]], { openingBalance: 200, statementClosing: 225 });
  assert.equal(second.currentReconciliation.passed, true);
  const queried = f.service.getBankImportResult({ workspaceId: "target", importId: first.import.id });
  assert.equal(queried.importSnapshots[0].monthlyReconciliation.passed, false);
  assert.equal(queried.currentReconciliation.passed, true);
  assert.equal(queried.currentReconciliation.transactionCount, 2);
  assert.ok(queried.missingItems.some((item) => item.sourceId === second.transactionIds[0]), "current missing items cover the target account and month, including later batches");
  const duplicate = await importRows(rows);
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.import, null);
  assert.deepEqual(new Set(duplicate.importIds), new Set([first.import.id, second.import.id]));
  assert.equal(duplicate.importSnapshots.length, 2);
  assert.deepEqual(duplicate.currentReconciliation, queried.currentReconciliation);
  assert.deepEqual(duplicate.missingItems, queried.missingItems);
  assert.equal(duplicate.nextActions.find((action) => action.action === "review_bank_transactions").transactionIds.length, 2);
  assert.equal(duplicate.nextActions.some((action) => action.action === "reconcile_bank_account"), false);
  assert.equal((await f.fileVault.listByWorkspace("target")).length, 2);
});

test("legacy bank tasks follow real source months without contaminating September or losing current-month issues", async () => {
  const f = fixture();
  const prepared = await preview(f);
  const augustImport = await f.service.executeBankImport(prepared.input);
  const target = getWorkspace(f.store.getState(), "target");
  assert.ok(target.exceptionTasks.every((task) => task.period === "2026-08"), "new bank tasks record their period");
  const legacyAugustTasks = target.exceptionTasks.map(({ period, ...task }) => task);
  f.store.actions.replaceWorkspace("target", { ...target, exceptionTasks: legacyAugustTasks });
  const beforeSeptember = getWorkspace(f.store.getState(), "target");
  const augustState = structuredClone(beforeSeptember.periodStates["2026-08"]);
  const septemberFile = await f.service.registerBankFile(file("日期,对方,摘要,收入,支出,流水号,余额\n2026-09-02,银行,手续费,,25,SEP-1,875"), { workspaceId: "target" });
  const septemberPlan = f.service.prepareBankImport({ workspaceId: "target", period: "2026-09", accountId: "target-bank", fileRef: septemberFile.fileRef, openingBalance: 900, statementClosing: 875 });
  const septemberImport = await f.service.executeBankImport({ workspaceId: "target", planId: septemberPlan.planId });
  const afterSeptember = getWorkspace(f.store.getState(), "target");
  assert.equal(afterSeptember.stages.s3.status, "complete");
  assert.deepEqual(afterSeptember.exceptionTasks.filter((task) => legacyAugustTasks.some((old) => old.id === task.id)), legacyAugustTasks);
  assert.deepEqual(afterSeptember.periodStates["2026-08"], augustState);
  assert.equal(septemberImport.missingItems.length, 0);
  assert.ok(f.service.getBankImportResult({ workspaceId: "target", importId: augustImport.import.id }).missingItems.length);
  const currentTask = { id: "legacy-september", sourceType: "bankTransaction", sourceId: septemberImport.transactionIds[0], code: "bank_review_required", message: "本月需要复核", status: "open" };
  const withLegacyCurrent = { ...afterSeptember, exceptionTasks: [...afterSeptember.exceptionTasks, currentTask] };
  const rechecked = reconcileBankAccountPeriod(withLegacyCurrent, { accountId: "target-bank", period: "2026-09" });
  assert.equal(rechecked.reconciliation.passed, true);
  assert.equal(rechecked.workspace.stages.s3.status, "needs_review");
  assert.deepEqual(bankExceptionTasksForPeriod(rechecked.workspace, "2026-09").map((task) => task.id), [currentTask.id]);
  const sourceFallbacks = [
    { id: "by-import", sourceType: "bankTransaction", importId: augustImport.import.id },
    { id: "by-source-list", sourceType: "bankTransaction", sourceIds: augustImport.transactionIds },
    { id: "by-reconciliation", sourceType: "bankReconciliation", sourceId: "target-bank", reconciliation: { period: "2026-08" } },
    { id: "by-identity", sourceType: "bankReconciliation", sourceId: "target-bank", identity: "bank_monthly_reconciliation_incomplete:target-bank:2026-08" },
    { id: "unknown-month", sourceType: "bankTransaction", sourceId: "missing-source" },
  ];
  assert.deepEqual(bankExceptionTasksForPeriod(afterSeptember, "2026-08", { accountId: "target-bank", tasks: sourceFallbacks }).map((task) => task.id), sourceFallbacks.slice(0, 4).map((task) => task.id));
  assert.deepEqual(bankExceptionTasksForPeriod(afterSeptember, "2026-09", { tasks: sourceFallbacks }), []);
  assert.equal(sourceFallbacks[4].sourceId, "missing-source", "unattributable historical data is preserved rather than assigned to the displayed month");
});
