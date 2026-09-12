import test from "node:test";
import assert from "node:assert/strict";
import {
  createBlankWorkspace, createFinanceDeskService, createFinanceDeskStore, createInitialState,
  createLocalFoundationRepository, createMemoryFileVault, createMemoryStorage, getWorkspace,
} from "../src/foundation.js";
import {
  applyBankImport, detectBankFieldMapping, inspectBankSourceGroups, normalizeBankDate,
  parseDelimitedText, prepareBankImport, transactionDedupeKey,
} from "../src/features/intake/bankStatementImport.js";

// All account numbers, names, amounts and times here are fictional.
const headers = ["账号", "账号名称", "收(付)方账号", "交易日", "交易时间", "收(付)方名称", "摘要", "用途", "收入金额", "支出金额", "余额", "银行", "类型"];
const now = () => new Date("2026-09-12T08:00:00Z");
const accounts = [
  { id: "bank-a", name: "虚构甲行", accountNumber: "3101", currency: "CNY", status: "active", openingBalance: 1000, statementClosing: 1200 },
  { id: "bank-b", name: "虚构乙行", accountNumber: "3202", currency: "CNY", status: "active", openingBalance: 2000, statementClosing: 1970 },
  { id: "bank-c", name: "虚构丙行", accountNumber: "3303", currency: "CNY", status: "active", openingBalance: 3000, statementClosing: 3040 },
];
const row = (account, time, income, expense, balance, bank, date = "20260812", party = "虚构客户") =>
  [account, "虚构公司分部", "00009999", date, time, party, "服务费", "普通业务", income, expense, balance, bank, "转账"];

function mergedTable() {
  return [headers,
    row("0000003101", "09:01:00", 100, "", 1100, "虚构甲行"),
    row("0000003202", "08:00:00", "", 30, 1970, "虚构乙行", "20260812 08:00:00"),
    row("0000003101", "09:02:00", 100, "", 1200, "虚构甲行"),
    row("0000003303", "11:00:00", 40, "", 3040, "虚构丙行"),
    row("0000003101", "09:02:00", 100, "", 1200, "虚构甲行"),
  ];
}

function fixture() {
  const workspace = createBlankWorkspace({ id: "multi", name: "虚构多账户", currentPeriod: "2026-08" }, { now });
  workspace.bankAccounts = structuredClone(accounts);
  workspace.accounts = workspace.bankAccounts;
  const state = { ...createInitialState({ now }), workspaces: [workspace], activeWorkspaceId: workspace.id };
  const repository = createLocalFoundationRepository({ storage: createMemoryStorage(), now });
  repository.save(state);
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  return { workspace, state, store, fileVault, service: createFinanceDeskService({ store, fileVault }) };
}

test("bank mapping prioritizes calendar dates and separates own/counterparty accounts", () => {
  const mapping = detectBankFieldMapping(headers);
  assert.equal(mapping.date, 3);
  assert.equal(mapping.time, 4);
  assert.equal(mapping.sourceAccount, 0);
  assert.equal(mapping.sourceAccountName, 1);
  assert.equal(mapping.counterpartyAccount, 2);
  assert.equal(mapping.counterparty, 5);
  assert.equal(mapping.sourceBank, 11);
  assert.equal(mapping.summary, 6);
  const reversed = detectBankFieldMapping(["交易时间", "交易日", "金额"]);
  assert.equal(reversed.date, 1);
  assert.equal(reversed.time, 0);
  assert.equal(detectBankFieldMapping(["时间", "金额"]).date, undefined);
});

test("compact date-time supports text and numeric dates while rejecting impossible dates and clocks", () => {
  for (const value of ["20260812 14:26:51", "20260812", 20260812, "20260812142651", 20260812142651, "2026-08-12T14:26:51.010Z"]) {
    assert.equal(normalizeBankDate(value), "2026-08-12");
  }
  assert.equal(normalizeBankDate("20240229 23:59:59"), "2024-02-29");
  for (const value of ["20260229 14:26:51", "20260431 14:26:51", "20261301", 20261301, "14:26:51", 0.5, "20260812 25:00:00", "20260812 14:61:00"]) {
    assert.equal(normalizeBankDate(value), null, String(value));
  }
});

test("whole-file analysis accounts for all source rows and separates raw and deduplicated totals", () => {
  const analysis = inspectBankSourceGroups(mergedTable(), { fileHash: "fictional-original" });
  assert.equal(analysis.rowCount, 5);
  assert.equal(analysis.groups.length, 3);
  const [a, b, c] = analysis.groups;
  assert.deepEqual(a.sourceRowNumbers, [2, 4, 6]);
  assert.deepEqual(b.sourceRowNumbers, [3]);
  assert.deepEqual(c.sourceRowNumbers, [5]);
  assert.equal(a.fileHash, "fictional-original");
  assert.equal(a.summary.rowCount, 3);
  assert.equal(a.summary.validRowCount, 3);
  assert.equal(a.summary.uniqueRowCount, 2);
  assert.equal(a.summary.duplicateCount, 1);
  assert.equal(a.summary.income, 200);
  assert.equal(a.summary.rawIncome, 300);
  assert.equal(a.summary.openingBalance, 1000);
  assert.equal(a.summary.statementClosing, 1200);
  assert.equal(a.summary.balanceCheckPassed, true);
  assert.equal(analysis.summary.income, 240);
  assert.equal(analysis.summary.expense, 30);
  assert.equal(analysis.summary.movement, 210);
  assert.deepEqual(analysis.groups.map((group) => group.groupId), inspectBankSourceGroups(mergedTable(), { fileHash: "fictional-original" }).groups.map((group) => group.groupId));
});

test("group plans reject mixed accounts, retain original row numbers and cannot bypass isolation with an explicit mapping", () => {
  const f = fixture();
  const input = { table: mergedTable(), fileHash: "fictional-original", accountId: "bank-a", period: "2026-08" };
  const groups = inspectBankSourceGroups(input.table, input).groups;
  assert.throws(() => prepareBankImport(f.workspace, input), { code: "BANK_SOURCE_GROUP_REQUIRED" });
  assert.throws(() => prepareBankImport(f.workspace, { ...input, exactMapping: true, mapping: { date: 3, credit: 8, debit: 9 } }), { code: "BANK_SOURCE_GROUP_REQUIRED" });
  assert.throws(() => prepareBankImport(f.workspace, { ...input, sourceGroupId: groups[1].groupId }), { code: "BANK_SOURCE_ACCOUNT_MISMATCH" });
  const plan = prepareBankImport(f.workspace, { ...input, sourceGroupId: groups[0].groupId });
  assert.equal(plan.rowCount, 3);
  assert.equal(plan.fileRowCount, 5);
  assert.equal(plan.importableRowCount, 2);
  assert.deepEqual(plan.transactions.map((transaction) => transaction.sourceRow), [2, 4]);
  assert.ok(plan.transactions.every((transaction) => transaction.sourceFileHash === input.fileHash && transaction.sourceGroupId === groups[0].groupId));
  const changed = { ...plan, transactions: plan.transactions.map((transaction) => ({ ...transaction, accountId: "bank-b" })) };
  assert.throws(() => applyBankImport(f.state, f.workspace.id, changed), { code: "BANK_SOURCE_ACCOUNT_MISMATCH" });
});

test("no-serial dedupe keeps different times, same-second different balances and distinct raw evidence", () => {
  const f = fixture();
  const rows = [
    row("0000003101", "09:01:00", 100, "", 1100, "虚构甲行"),
    row("0000003101", "09:02:00", 100, "", 1200, "虚构甲行"),
    row("0000003101", "09:02:00", 100, "", 1300, "虚构甲行"),
  ];
  const plan = prepareBankImport(f.workspace, { accountId: "bank-a", period: "2026-08", table: [headers, ...rows, rows[2]], fileHash: "fictional-dedupe" });
  assert.equal(plan.importableRowCount, 3);
  assert.equal(plan.duplicateCount, 1);
  assert.equal(new Set(plan.transactions.map(transactionDedupeKey)).size, 3);
  const applied = applyBankImport(f.state, f.workspace.id, plan, { now });
  const saved = getWorkspace(applied);
  const again = prepareBankImport(saved, { accountId: "bank-a", period: "2026-08", table: [headers, ...rows, rows[2]], fileHash: "fictional-dedupe" });
  assert.equal(again.importableRowCount, 0);
  assert.equal(again.duplicateCount, 4);
  assert.equal(saved.transactions.length, 3);
});

test("legacy collapsed dedupe keys use saved raw evidence and preserve old transaction objects", () => {
  const f = fixture();
  const table = [headers,
    row("0000003101", "09:01:00", 100, "", 1100, "虚构甲行"),
    row("0000003101", "09:02:00", 100, "", 1200, "虚构甲行"),
  ];
  const original = prepareBankImport(f.workspace, { table, accountId: "bank-a", period: "2026-08", fileHash: "fictional-history" });
  const { time, sourceFileHash, sourceGroupId, sourceAccount, sourceBank, ...legacy } = original.transactions[0];
  legacy.dedupeKey = "bank-a|row|legacy-collapsed-key";
  legacy.status = "posted";
  const workspace = { ...f.workspace, transactions: [legacy] };
  const before = structuredClone(workspace);
  const repair = prepareBankImport(workspace, { table, accountId: "bank-a", period: "2026-08", fileHash: "fictional-history" });
  assert.equal(repair.importableRowCount, 1);
  assert.equal(repair.duplicateCount, 1);
  assert.equal(repair.transactions[0].sourceRow, 3);
  assert.deepEqual(workspace, before);
  const state = { ...f.state, workspaces: [workspace] };
  const saved = getWorkspace(applyBankImport(state, workspace.id, repair, { now }));
  assert.deepEqual(saved.transactions.find((transaction) => transaction.id === legacy.id), legacy);
  assert.equal(saved.transactions.length, 2);
});

test("balances follow transaction date/time and stable source order, and invalid rows remain visible", () => {
  const rows = [
    row("0000003101", "09:02:00", 100, "", 1300, "虚构甲行"),
    row("0000003101", "09:01:00", 100, "", 1100, "虚构甲行"),
    row("0000003101", "09:01:30", 100, "", 1200, "虚构甲行"),
  ];
  const analysis = inspectBankSourceGroups([headers, ...rows]);
  assert.equal(analysis.groups[0].summary.openingBalance, 1000);
  assert.equal(analysis.groups[0].summary.statementClosing, 1300);
  assert.equal(analysis.groups[0].summary.balanceCheckPassed, true);
  const invalid = inspectBankSourceGroups([headers, ...rows, row("0000003202", "09:00:00", 15, "", 2015, "虚构乙行", "20260230")]);
  assert.equal(invalid.rowCount, 4);
  assert.equal(invalid.summary.errorCount, 1);
  assert.equal(invalid.groups[1].errors[0].rowNumber, 5);
  assert.equal(invalid.groups[1].summary.balanceCheckPassed, false);
  const csv = `${headers.join(",")}\n${rows[0].join(",")}\n\n${rows[1].join(",")}`;
  assert.deepEqual(inspectBankSourceGroups(parseDelimitedText(csv).table).groups[0].sourceRowNumbers, [2, 4]);
  const numericTime = [headers,
    row("0000003101", 20260812090100, 100, "", 1200, "虚构甲行"),
    row("0000003101", 90000, 100, "", 1100, "虚构甲行"),
  ];
  const f = fixture();
  const numericPlan = prepareBankImport(f.workspace, { table: numericTime, accountId: "bank-a", period: "2026-08" });
  assert.deepEqual(numericPlan.transactions.map((transaction) => transaction.time), ["09:01:00.000", "09:00:00.000"]);
  assert.equal(numericPlan.sourceGroup.summary.balanceCheckPassed, true);
  const changedBalance = prepareBankImport(f.workspace, { table: [headers, rows[0], rows[1], rows[2]], accountId: "bank-a", period: "2026-08" });
  assert.deepEqual(changedBalance.balanceConflicts, [{ field: "statementClosing", saved: 1200, statement: 1300, preserved: true }]);
  assert.equal(getWorkspace(applyBankImport(f.state, f.workspace.id, changedBalance, { now })).bankAccounts[0].statementClosing, 1200);
});

test("shared service prepares and commits each source independently and keeps one original for later groups", async () => {
  const f = fixture();
  const table = mergedTable();
  const file = Object.assign(new Blob([table.map((cells) => cells.join(",")).join("\n")], { type: "text/csv" }), { name: "虚构合并流水.csv" });
  const registered = await f.service.registerBankFile(file, { workspaceId: f.workspace.id });
  const source = f.service.inspectBankFileSources({ workspaceId: f.workspace.id, period: "2026-08", fileRef: registered.fileRef });
  assert.deepEqual(source.groups.map((group) => group.matchedAccountId), ["bank-a", "bank-b", "bank-c"]);
  const plans = source.groups.map((group) => f.service.prepareBankImport({ workspaceId: f.workspace.id, period: "2026-08",
    fileRef: registered.fileRef, accountId: group.matchedAccountId, sourceGroupId: group.groupId }));
  const results = [];
  for (const plan of plans) results.push(await f.service.executeBankImport({ workspaceId: f.workspace.id, planId: plan.planId }));
  assert.deepEqual(results.map((result) => result.counts.imported), [2, 1, 1]);
  const saved = getWorkspace(f.store.getState());
  assert.equal(saved.documents.length, 1);
  assert.equal(saved.transactions.length, 4);
  assert.deepEqual(saved.bankImports.map((record) => record.sourceRowNumbers), [[2, 4, 6], [3], [5]]);
  assert.ok(saved.transactions.every((transaction) => transaction.evidenceIds.includes(saved.documents[0].id)));
  const repeated = await f.service.registerBankFile(file, { workspaceId: f.workspace.id });
  const repeatPlan = f.service.prepareBankImport({ workspaceId: f.workspace.id, period: "2026-08", fileRef: repeated.fileRef,
    accountId: "bank-a", sourceGroupId: source.groups[0].groupId });
  const duplicate = await f.service.executeBankImport({ workspaceId: f.workspace.id, planId: repeatPlan.planId });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.transactionIds.length, 2);
  assert.equal(getWorkspace(f.store.getState()).documents.length, 1);
});
