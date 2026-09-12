import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { FINANCE_DESK_STORAGE_KEY, FINANCE_DESK_BACKUP_KEY } from "../src/domain/foundation.js";
import { createFinanceDeskStore } from "../src/store/financeDeskStore.js";
import { createLocalFoundationRepository, createMemoryStorage } from "../src/storage/localFoundationRepository.js";
import { createMemoryFileVault } from "../src/features/intake/browserFileVault.js";
import { createAiFinanceService } from "../src/application/aiFinanceService.js";
import { AI_FINANCE_TOOLS } from "../src/application/aiFinanceTools.js";
import { assistantReply, scriptedAssistant, toolCall } from "./helpers/aiSimpleJourneyFixture.mjs";

const PERIOD = "2026-09";
const now = () => new Date("2026-09-12T08:00:00.000Z");
// These are column labels only. Every account, bank, party and amount below is
// invented; no customer original, real account or real transaction is a fixture.
const HEADERS = ["账号", "账号名称", "收(付)方账号", "交易日", "交易时间", "收(付)方名称", "摘要", "用途", "收入金额", "支出金额", "余额", "银行", "类型"];
const SOURCES = [
  { accountNumber: "TEST-ACCOUNT-1101", tail: "1101", name: "虚构星砂经营户", bank: "虚构星砂银行", opening: 1000 },
  { accountNumber: "TEST-ACCOUNT-2202", tail: "2202", name: "虚构月屿经营户", bank: "虚构月屿银行", opening: 2000 },
  { accountNumber: "TEST-ACCOUNT-3303", tail: "3303", name: "虚构云帆经营户", bank: "虚构云帆银行", opening: 3000 },
];
const workspace = (fixture) => fixture.store.getActiveWorkspace();

function sourceRow(source, { date = 20260903, time = "090000", income = 17, expense = "", balance, index = 0 } = {}) {
  return [source.accountNumber, source.name, "TEST-COUNTERPARTY-9000", date, time,
    "虚构灯塔采购社", "虚构货款", "服务结算", income, expense,
    balance ?? source.opening + 17 * (index + 1), source.bank, "转账"];
}

function smallTable({ duplicates = true } = {}) {
  // Per source: three legal equal-amount receipts, including two in the same
  // second with different balances, and one payment. Interleave the banks so
  // grouping must use the own account, never adjacent ranges or counterparty.
  const rowsBySource = SOURCES.map((source) => {
    const rows = [
      sourceRow(source, { time: 90000, balance: source.opening + 17 }),
      sourceRow(source, { time: "090001", balance: source.opening + 34 }),
      sourceRow(source, { time: "090001", balance: source.opening + 51 }),
      sourceRow(source, { date: "20260903", time: "20260903101530", income: "", expense: 7, balance: source.opening + 44 }),
    ];
    if (duplicates) rows.splice(2, 0, [...rows[1]]);
    return rows;
  });
  return [HEADERS, ...rowsBySource[0].flatMap((_, index) => rowsBySource.map((rows) => rows[index]))];
}

function fullTable() {
  // 3 x 144 = 432 unique rows. Equal receipts deliberately share the old
  // date/amount/counterparty/summary key; each has its own time and balance.
  return [HEADERS, ...Array.from({ length: 144 }, (_, index) => SOURCES.map((source) => {
    const hours = String(9 + Math.floor(index / 60)).padStart(2, "0");
    const minutes = String(index % 60).padStart(2, "0");
    return sourceRow(source, { time: `20260903${hours}${minutes}00`, index });
  })).flat()];
}

function longChineseTable() {
  // Same 432-row shape as the reported browser journey, but all values are
  // invented. Uneven groups exercise a large saved group followed by two small
  // pending groups, instead of the older short-text 144/144/144 fixture.
  const counts = [412, 12, 8];
  return [HEADERS, ...SOURCES.flatMap((source, groupIndex) => {
    let balance = source.opening;
    return Array.from({ length: counts[groupIndex] }, (_, index) => {
      const sequence = String(index + 1).padStart(4, "0");
      const hours = String(9 + Math.floor(index / 60)).padStart(2, "0");
      const minutes = String(index % 60).padStart(2, "0");
      const income = index % 5 ? 17 + index % 7 * 3 : "";
      const expense = index % 5 ? "" : 7 + index % 3;
      balance += Number(income) - Number(expense);
      const row = sourceRow(source, { time: `20260903${hours}${minutes}00`, income, expense, balance });
      row[1] = `${source.name}虚构文化服务有限公司结算账户`;
      row[2] = `SYNTHETIC-PARTNER-${groupIndex}-${sequence}`;
      row[5] = `虚构灯塔文化与技术咨询有限公司第${sequence}项目部`;
      row[6] = `虚构第${sequence}批项目服务款结算，按验收单支付设计与材料尾款`;
      row[7] = `虚构项目执行费用，含方案设计、材料及验收整理；双方按合同分次收付，仅为本地测试数据。`;
      row[11] = `${source.bank}虚构示例园区支行`;
      row[12] = "企业网银转账";
      return row;
    });
  })];
}

function finiteStorage(limitBytes = 5 * 1024 * 1024) {
  const backing = createMemoryStorage();
  const chargedBytes = (entries) => Object.entries(entries).reduce((sum, [key, value]) => sum + 2 * (key.length + value.length), 0);
  let peakBytes = 0;
  let quotaRejections = 0;
  let lastRejectedBytes = null;
  return {
    ...backing,
    setItem(key, value) {
      const textKey = String(key);
      const text = String(value);
      // Browser-like atomic replacement: count all keys, including the backup,
      // before modifying any value. JSON envelope overhead is already present.
      const bytes = chargedBytes({ ...backing.dump(), [textKey]: text });
      if (bytes > limitBytes) {
        quotaRejections += 1;
        lastRejectedBytes = bytes;
        throw new DOMException("Synthetic localStorage quota exceeded", "QuotaExceededError");
      }
      backing.setItem(textKey, text);
      peakBytes = Math.max(peakBytes, bytes);
    },
    usage() {
      const entries = backing.dump();
      return { limitBytes, utf16Bytes: chargedBytes(entries), utf8Bytes: Object.entries(entries)
        .reduce((sum, [key, value]) => sum + new TextEncoder().encode(key).byteLength + new TextEncoder().encode(value).byteLength, 0),
      peakBytes, quotaRejections, lastRejectedBytes };
    },
  };
}

function excelFile(table, name = "虚构三银行合并流水.xlsx", { compression = false } = {}) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(table), "合并流水");
  return Object.assign(new Blob([XLSX.write(book, { bookType: "xlsx", type: "array", compression })], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), { name });
}

function createFixture(storage = createMemoryStorage()) {
  const repository = createLocalFoundationRepository({ storage, now });
  const store = createFinanceDeskStore({ repository });
  const created = store.actions.createWorkspace({ id: "bank-selfservice", name: "虚构银行自助工作台", currentPeriod: PERIOD,
    initialUserName: "虚构复核员", initialUserRoleId: "role-owner" });
  const fileVault = createMemoryFileVault();
  const target = { workspaceId: created.id, period: PERIOD };
  return { store, storage, repository, fileVault, ...target, service: createAiFinanceService({ store, fileVault, ...target }) };
}

function reload(fixture) {
  const repository = createLocalFoundationRepository({ storage: fixture.storage, now });
  const store = createFinanceDeskStore({ repository });
  return { ...fixture, store, repository, service: createAiFinanceService({ ...fixture, store }) };
}

async function upload(fixture, table = smallTable()) {
  const file = excelFile(table);
  const [attachment] = await fixture.service.uploadFiles([file]);
  return { file, attachment };
}

async function prepare(fixture, attachment) {
  // Deliberately no accountId, mapping, balance override, API key or model call.
  return fixture.service.prepareBankFile({ documentId: attachment.documentId });
}

function proposalForSource(prepared, source) {
  const proposal = prepared.proposals.find((item) => item.preview.group.sourceAccount === source.accountNumber);
  assert.ok(proposal, `missing independent proposal for ${source.name}`);
  return proposal;
}

function assertGroupCounts(prepared, { rowCount, importedCount, duplicateCount }) {
  assert.equal(prepared.analysis.rowCount, rowCount * SOURCES.length);
  assert.equal(prepared.analysis.groups.length, SOURCES.length);
  assert.equal(prepared.proposals.length, SOURCES.length);
  for (const source of SOURCES) {
    const proposal = proposalForSource(prepared, source);
    assert.equal(proposal.kind, "bank_import");
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.preview.group.summary.rowCount, rowCount);
    assert.equal(proposal.preview.importedCount, importedCount);
    assert.equal(proposal.preview.duplicateCount, duplicateCount);
    assert.equal(proposal.preview.errorCount, 0);
    assert.equal(proposal.preview.canConfirm, true);
  }
}

test("selfservice: one mixed Excel creates three reviewable groups without technical input and confirms each into its own real account", async () => {
  let f = createFixture();
  assert.equal(workspace(f).bankAccounts.length, 0);
  const { file, attachment } = await upload(f);
  const prepared = await prepare(f, attachment);
  assertGroupCounts(prepared, { rowCount: 5, importedCount: 4, duplicateCount: 1 });
  assert.equal(workspace(f).bankAccounts.length, 0, "preparing an import cannot silently create bank accounts");
  assert.equal(workspace(f).transactions.length, 0);
  for (const source of SOURCES) {
    const proposal = proposalForSource(prepared, source);
    assert.equal(proposal.preview.accountResolution.status, "new");
    assert.equal(proposal.preview.accountResolution.suggestedAccount.accountNumber, source.tail);
    assert.deepEqual(proposal.sourceIds, [attachment.documentId]);
    assert.equal(proposal.preview.summary.income, 51);
    assert.equal(proposal.preview.summary.expense, 7);
    assert.equal(proposal.preview.summary.movement, 44);
    assert.equal(proposal.preview.summary.rawIncome, 68, "original totals and unique-row totals must not be confused");
    assert.equal(proposal.preview.summary.openingBalance, source.opening);
    assert.equal(proposal.preview.summary.statementClosing, source.opening + 44);
    assert.equal(proposal.preview.summary.balanceDifference, 0);
    assert.equal(proposal.preview.summary.balanceCheckPassed, true);
  }

  // Reload before the first confirmation: the user can return later without
  // re-uploading, asking an assistant for a mapping, or reconstructing groups.
  f = reload(f);
  for (const [index, source] of SOURCES.entries()) {
    const proposal = proposalForSource(prepared, source);
    const result = await f.service.confirmProposal(proposal.id);
    assert.equal(result.proposal.status, "applied");
    assert.equal(result.result.counts.imported, 4);
    const account = workspace(f).bankAccounts.find((item) => item.accountNumber === source.tail);
    assert.ok(account);
    const rows = workspace(f).transactions.filter((item) => item.accountId === account.id);
    assert.equal(rows.length, 4);
    assert.equal(rows.filter((row) => row.amount === 17).length, 3, "same-second receipts with different balances remain real transactions");
    assert.equal(rows.reduce((total, row) => total + row.amount, 0), 44);
    assert.deepEqual(rows.map((row) => row.time).sort(), ["09:00:00.000", "09:00:01.000", "09:00:01.000", "10:15:30.000"]);
    assert.ok(rows.every((row) => row.date === "2026-09-03" && row.raw["账号"] === source.accountNumber));
    assert.ok(rows.every((row) => row.evidenceIds.includes(attachment.documentId)));
    assert.deepEqual(rows.map((row) => row.sourceRow).sort((a, b) => a - b), [2, 5, 11, 14].map((row) => row + index));
    assert.equal(workspace(f).bankAccounts.length, index + 1);
    assert.equal(workspace(f).transactions.length, (index + 1) * 4);
    assert.equal(f.service.getConversation().proposals.filter((item) => item.status === "pending").length, 2 - index);
    assert.deepEqual((await f.service.confirmProposal(proposal.id)).result, result.result, "repeat confirmation cannot import again");
  }
  assert.equal(workspace(f).bankImports.length, 3);
  assert.equal(workspace(f).documents.length, 1);
  assert.equal(f.service.getContext("reports").reports.ledger.vouchers.length, 0, "imported bank rows are not posted vouchers");
  const [again] = await f.service.uploadFiles([file]);
  assert.equal(again.documentId, attachment.documentId);
  const beforeRepeatPreparation = f.storage.dump();
  const repeated = await prepare(f, again);
  assert.equal(repeated.status, "already_imported");
  assert.deepEqual(repeated.proposals, [], "the user must not reconfirm a fully imported original");
  assert.equal(repeated.alreadyImportedGroups.length, 3);
  for (const group of repeated.alreadyImportedGroups) {
    assert.deepEqual(group.counts, { imported: 0, duplicates: 5, errors: 0 });
    assert.ok(group.documentIds.includes(attachment.documentId));
  }
  assert.deepEqual(f.storage.dump(), beforeRepeatPreparation, "re-reading this completed original creates no new pending work or writes");
  f = reload(f);
  assert.equal(workspace(f).transactions.length, 12);
  assert.equal(workspace(f).bankAccounts.length, 3);
  assert.equal(workspace(f).bankImports.length, 3);
  assert.equal(workspace(f).documents.length, 1);
  assert.equal(f.service.getConversation().proposals.filter((item) => item.status === "pending").length, 0);
  assert.deepEqual(new Uint8Array(await (await f.service.readOriginal(attachment.documentId)).blob.arrayBuffer()), new Uint8Array(await file.arrayBuffer()));
});

test("selfservice: 432 legal rows reach the model as deterministic totals without a mapping or pre-existing account", async () => {
  const f = createFixture();
  const { attachment } = await upload(f, fullTable());
  const schema = AI_FINANCE_TOOLS.find((item) => item.function.name === "prepare_bank_import").function.parameters;
  assert.deepEqual(schema.required, ["documentId"], "the assistant must not require an account or technical column selection to read a file");
  const run = scriptedAssistant(f, [
    assistantReply("", [toolCall("whole_bank_file", "prepare_bank_import", { documentId: attachment.documentId })]),
    ({ payload }) => {
      const entry = payload.messages.find((message) => message.role === "tool" && message.tool_call_id === "whole_bank_file");
      assert.ok(entry, "inspect the result actually sent over the model protocol");
      const result = JSON.parse(entry.content);
      assert.equal(result.analysis.rowCount, 432);
      assert.equal(result.analysis.groups.length, 3);
      for (const source of SOURCES) {
        const group = result.analysis.groups.find((item) => item.sourceAccount === source.accountNumber);
        assert.ok(group, `the complete account summary for ${source.name} must survive protocol bounds`);
        assert.equal(group.summary.rowCount, 144);
        assert.equal(group.summary.errorCount, 0);
        assert.equal(group.summary.income, 2448);
        assert.equal(group.summary.expense, 0);
        assert.equal(group.summary.movement, 2448);
        assert.equal(group.summary.dateFrom, "2026-09-03");
        assert.equal(group.summary.dateTo, "2026-09-03");
        assert.equal(group.summary.balanceDifference, 0);
        assert.equal(group.summary.balanceCheckPassed, true);
      }
      return assistantReply("三账户全量核对已准备，等待逐组确认。");
    },
  ]);
  await run.run();
  assert.deepEqual(run.trace.executed, [{ name: "prepare_bank_import", input: { documentId: attachment.documentId } }]);
  assert.equal(workspace(f).transactions.length, 0);
  const proposals = f.service.getConversation().proposals;
  assert.equal(proposals.length, 3);
  assert.equal(proposals.reduce((sum, item) => sum + item.preview.importedCount, 0), 432);
  assert.equal(proposals.reduce((sum, item) => sum + item.preview.duplicateCount, 0), 0);
  for (const proposal of proposals) await f.service.confirmProposal(proposal.id);
  const saved = reload(f);
  assert.equal(workspace(saved).transactions.length, 432, "all accepted rows must survive actual repository serialization");
  assert.ok(workspace(saved).transactions.every((row) => /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(row.time || "")), "compact datetime values must remain usable transaction times");
  for (const source of SOURCES) {
    const account = workspace(saved).bankAccounts.find((item) => item.accountNumber === source.tail);
    assert.equal(workspace(saved).transactions.filter((item) => item.accountId === account.id).length, 144);
  }
});

async function capacityJourney(t) {
  const storage = finiteStorage();
  const { limitBytes } = storage.usage();
  // Prove that this fixture actually rejects writes at its fixed budget. The
  // application still uses the same storage afterward; its budget never grows.
  assert.throws(() => storage.setItem("quota-probe", "测".repeat(limitBytes / 2)), { name: "QuotaExceededError" });
  assert.deepEqual(storage.dump(), {}, "a rejected setItem must leave existing storage intact");
  const f = createFixture(storage);
  const earlierBackup = storage.getItem(FINANCE_DESK_STORAGE_KEY);
  assert.ok(earlierBackup, "capture a real valid snapshot before bank processing for the independent legacy fixture");
  const existingWorkspaces = structuredClone(f.store.getState().workspaces.filter((item) => item.id !== f.workspaceId));
  assert.ok(existingWorkspaces.length > 0, "retain the default demonstration ledger alongside the empty target");
  assert.equal(workspace(f).transactions.length, 0);
  const table = longChineseTable();
  const file = excelFile(table, "虚构三银行长中文合并流水.xlsx", { compression: true });
  const [attachment] = await f.service.uploadFiles([file]);
  f.service.appendMessage({ role: "user", content: "整理这份三账户合并银行流水，按账户分别核对后确认。", attachments: [attachment] });
  const prepared = await prepare(f, attachment);
  assert.equal(prepared.analysis.rowCount, 432);
  assert.deepEqual(SOURCES.map((source) => proposalForSource(prepared, source).preview.importedCount), [412, 12, 8]);
  const sourceTableUtf16Bytes = JSON.stringify(table).length * 2;
  const reportUsage = (stage, measuredStorage = storage) => t.diagnostic(JSON.stringify({ stage, originalXlsxBytes: file.size,
    sourceTableUtf16Bytes, ...measuredStorage.usage() }));
  reportUsage("prepared");
  return { f, storage, limitBytes, earlierBackup, existingWorkspaces, table, file, attachment, prepared, reportUsage };
}

async function assertCapacityJourneySaved(journey, fixture) {
  const { limitBytes, existingWorkspaces, table, file, attachment, prepared, reportUsage } = journey;
  const f = reload(fixture);
  const { storage } = f;
  assert.equal(workspace(f).transactions.length, 432);
  assert.equal(workspace(f).bankAccounts.length, 3);
  assert.equal(workspace(f).bankImports.length, 3);
  assert.equal(workspace(f).documents.length, 1);
  assert.equal(f.service.getConversation().proposals.filter((item) => item.status === "applied").length, 3);
  assert.equal(f.service.getConversation().proposals.filter((item) => item.status === "pending").length, 0);
  assert.deepEqual(f.store.getState().workspaces.filter((item) => item.id !== f.workspaceId), existingWorkspaces);
  for (const row of workspace(f).transactions) {
    assert.deepEqual(HEADERS.map((header) => row.raw[header]), table[row.sourceRow - 1], "capacity reduction cannot truncate financial source fields");
    assert.ok(row.evidenceIds.includes(attachment.documentId));
  }
  assert.deepEqual(new Uint8Array(await (await f.service.readOriginal(attachment.documentId)).blob.arrayBuffer()), new Uint8Array(await file.arrayBuffer()));
  const beforeRepeat = storage.dump();
  for (const proposal of prepared.proposals) await f.service.confirmProposal(proposal.id);
  assert.deepEqual(storage.dump(), beforeRepeat, "repeated confirmations stay idempotent within the fixed budget");
  assert.ok(storage.usage().utf16Bytes <= limitBytes);
  assert.ok(storage.usage().peakBytes <= limitBytes, "each key replacement, including the backup, obeys the same fixed budget");
  reportUsage("reloaded-idempotent", storage);
}

test("selfservice: finite storage saves a new 412 + 12 + 8 long Chinese bank import without removing existing data", async (t) => {
  const journey = await capacityJourney(t);
  const { f, prepared, reportUsage } = journey;
  for (const [index, source] of SOURCES.entries()) {
    const proposal = proposalForSource(prepared, source);
    const confirmed = await f.service.confirmProposal(proposal.id);
    assert.equal(confirmed.result.counts.imported, [412, 12, 8][index]);
    assert.equal(confirmed.result.import.transactions.length, [412, 12, 8][index]);
    reportUsage(`confirmed-${index + 1}`);
  }
  await assertCapacityJourneySaved(journey, f);
});

test("selfservice: finite storage resumes legacy 424 saved rows and an earlier valid backup by confirming the last 8", async (t) => {
  const journey = await capacityJourney(t);
  const { prepared, reportUsage, earlierBackup } = journey;
  let { f } = journey;
  const fullResults = new Map();
  for (const [index, source] of SOURCES.slice(0, 2).entries()) {
    const proposal = proposalForSource(prepared, source);
    const confirmed = await f.service.confirmProposal(proposal.id);
    assert.equal(confirmed.result.counts.imported, [412, 12][index]);
    assert.equal(confirmed.result.import.transactions.length, [412, 12][index], "public confirmation still resolves the complete imported batch");
    fullResults.set(proposal.id, structuredClone(confirmed.result));
    reportUsage(`confirmed-${index + 1}`);
  }
  assert.equal(workspace(f).transactions.length, 424);

  // Start an independent historical storage image, rather than forcing a
  // larger legacy primary onto the already almost-full new-format primary and
  // backup. Both historical keys must physically fit through bounded setItem.
  // No active backup is removed and no higher or unlimited budget is used.
  const legacyState = structuredClone(f.store.getState());
  const legacy = legacyState.workspaces.find((item) => item.id === f.workspaceId);
  legacy.aiSimple.conversations[PERIOD].proposals = legacy.aiSimple.conversations[PERIOD].proposals.map((proposal) => (
    fullResults.has(proposal.id) ? { ...proposal, result: fullResults.get(proposal.id) } : proposal
  ));
  const legacyStorage = finiteStorage();
  const legacyRepository = createLocalFoundationRepository({ storage: legacyStorage, now });
  try {
    legacyRepository.save(legacyState);
    legacyStorage.setItem(FINANCE_DESK_BACKUP_KEY, earlierBackup);
  } catch (error) {
    reportUsage("legacy-seed-rejected", legacyStorage);
    throw error;
  }
  assert.equal(legacyStorage.getItem(FINANCE_DESK_BACKUP_KEY), earlierBackup);
  reportUsage("legacy-424-initialized", legacyStorage);
  f = reload({ ...f, storage: legacyStorage });
  const storedProposals = workspace(f).aiSimple.conversations[PERIOD].proposals;
  assert.equal(storedProposals.find((item) => item.id === proposalForSource(prepared, SOURCES[0]).id).result.import.transactions.length, 412);
  assert.equal(storedProposals.find((item) => item.id === proposalForSource(prepared, SOURCES[1]).id).result.import.transactions.length, 12);
  const finalProposal = proposalForSource(prepared, SOURCES[2]);
  assert.equal(f.service.getConversation().proposals.find((item) => item.id === finalProposal.id).status, "pending");

  const completed = await f.service.confirmProposal(finalProposal.id);
  assert.equal(completed.result.counts.imported, 8);
  reportUsage("confirmed-final-8", legacyStorage);
  await assertCapacityJourneySaved(journey, f);
});

test("selfservice: failed first persistence saves neither account nor rows nor confirmation; deliberate retry saves all three once", async () => {
  const f = createFixture();
  const { attachment } = await upload(f);
  const prepared = await prepare(f, attachment);
  const first = proposalForSource(prepared, SOURCES[0]);
  const stateBefore = structuredClone(workspace(f));
  const storageBefore = f.storage.dump();
  const save = f.repository.save;
  f.repository.save = () => { throw new Error("虚构仓库保存失败"); };
  try {
    await assert.rejects(f.service.confirmProposal(first.id), /虚构仓库保存失败/);
  } finally {
    f.repository.save = save;
  }
  assert.deepEqual(workspace(f), stateBefore);
  assert.deepEqual(f.storage.dump(), storageBefore);
  assert.equal(workspace(f).bankAccounts.length, 0);
  assert.equal(workspace(f).transactions.length, 0);
  assert.equal(f.service.getConversation().proposals.filter((item) => item.status === "pending").length, 3);
  assert.ok((await f.service.readOriginal(attachment.documentId)).blob);

  let writes = 0;
  f.repository.save = (...args) => { writes += 1; return save(...args); };
  try {
    const confirmed = await f.service.confirmProposal(first.id);
    assert.equal(confirmed.result.counts.imported, 4);
    assert.equal(writes, 1, "account, selected group and applied proposal must share one repository save");
    await f.service.confirmProposal(first.id);
    assert.equal(writes, 1, "an already-confirmed group must not write again");
  } finally {
    f.repository.save = save;
  }
  const persisted = reload(f);
  assert.equal(workspace(persisted).bankAccounts.length, 1);
  assert.equal(workspace(persisted).transactions.length, 4);
  assert.equal(workspace(persisted).bankImports.length, 1);
  assert.equal(persisted.service.getConversation().proposals.find((item) => item.id === first.id).status, "applied");
  assert.equal(persisted.service.getConversation().proposals.filter((item) => item.status === "pending").length, 2);
});

test("selfservice: one invalid group never silently loses its bad row and a corrected original can finish without repeating the completed groups", async () => {
  const f = createFixture();
  const badTable = smallTable({ duplicates: false });
  badTable.at(-1)[3] = "20260931";
  badTable.at(-1)[4] = "250099";
  const { attachment } = await upload(f, badTable);
  const prepared = await prepare(f, attachment);
  assert.equal(prepared.analysis.rowCount, 12);
  const bad = proposalForSource(prepared, SOURCES[2]);
  assert.equal(bad.preview.group.summary.rowCount, 4);
  assert.equal(bad.preview.errorCount, 1);
  assert.equal(bad.preview.canConfirm, false);
  assert.equal(bad.preview.errors[0].rowNumber, 13, "the error refers to the original Excel row, not a renumbered group");
  await assert.rejects(f.service.confirmProposal(bad.id));
  assert.equal(workspace(f).bankAccounts.length, 0);
  assert.equal(workspace(f).transactions.length, 0);
  assert.equal(f.service.getConversation().proposals.find((item) => item.id === bad.id).status, "pending");
  for (const source of SOURCES.slice(0, 2)) await f.service.confirmProposal(proposalForSource(prepared, source).id);
  assert.equal(workspace(f).transactions.length, 8);
  assert.equal(workspace(f).bankAccounts.length, 2);

  const corrected = await upload(f, smallTable({ duplicates: false }));
  assert.notEqual(corrected.attachment.documentId, attachment.documentId, "the corrected file remains a separate evidence original");
  const retry = await prepare(f, corrected.attachment);
  for (const source of SOURCES.slice(0, 2)) assert.equal(proposalForSource(retry, source).preview.importedCount, 0);
  const ready = proposalForSource(retry, SOURCES[2]);
  assert.equal(ready.preview.errorCount, 0);
  assert.equal(ready.preview.importedCount, 4);
  await f.service.confirmProposal(ready.id);
  const persisted = reload(f);
  assert.equal(workspace(persisted).transactions.length, 12);
  assert.equal(workspace(persisted).bankAccounts.length, 3);
  assert.equal(workspace(persisted).documents.length, 2);
  assert.ok((await f.service.readOriginal(attachment.documentId)).blob, "failed source evidence is retained");
  assert.ok((await f.service.readOriginal(corrected.attachment.documentId)).blob);
});

test("selfservice: an explicit wrong account cannot override the own-account grouping", async () => {
  const f = createFixture();
  const otherAccount = f.service.createBankAccount({ name: "虚构不相干账户", accountNumber: "9999" });
  const { attachment } = await upload(f);
  const prepared = await prepare(f, attachment);
  const proposal = proposalForSource(prepared, SOURCES[0]);
  const wrong = await f.service.resolveBankImportAccount(proposal.id, { accountId: otherAccount.id });
  assert.equal(wrong.status, "needs_correction");
  assert.equal(wrong.preview.canConfirm, false);
  assert.equal(wrong.proposal, undefined, "a conflicting edit cannot replace the valid pending proposal");
  assert.equal(f.service.getConversation().proposals.find((item) => item.id === proposal.id).status, "pending");
  assert.equal(workspace(f).transactions.length, 0);
  await f.service.confirmProposal(proposal.id);
  assert.equal(workspace(f).transactions.filter((item) => item.accountId === otherAccount.id).length, 0);
  assert.equal(workspace(f).transactions.length, 4);
});

test("selfservice: a missing source account asks for a business account once and never needs a technical mapping", async () => {
  const f = createFixture();
  const table = smallTable({ duplicates: false }).filter((row, index) => index === 0 || row[0] === SOURCES[0].accountNumber);
  table.slice(1).forEach((row) => { row[0] = ""; });
  const { attachment } = await upload(f, table);
  const prepared = await prepare(f, attachment);
  assert.equal(prepared.analysis.rowCount, 4);
  assert.equal(prepared.proposals.length, 1);
  const original = prepared.proposals[0];
  assert.equal(original.preview.canConfirm, false);
  assert.equal(original.preview.accountResolution.status, "missing");
  const resolved = await f.service.resolveBankImportAccount(original.id, { name: SOURCES[0].name, accountNumber: SOURCES[0].tail });
  const replacement = resolved.proposal;
  assert.equal(replacement.preview.canConfirm, true);
  assert.equal(replacement.preview.importedCount, 4);
  assert.equal(f.service.getConversation().proposals.find((item) => item.id === original.id).status, "superseded");
  await assert.rejects(f.service.confirmProposal(original.id), { code: "AI_PROPOSAL_CHANGED" });
  assert.equal(workspace(f).bankAccounts.length, 0, "choosing an account still waits for the import confirmation");
  await f.service.confirmProposal(replacement.id);
  assert.equal(workspace(f).transactions.length, 4);
  assert.equal(workspace(f).bankAccounts[0].accountNumber, SOURCES[0].tail);
});

test("selfservice: provider failure after local preparation keeps all account groups available for local continuation", async () => {
  const f = createFixture();
  const { attachment } = await upload(f);
  const prepared = await prepare(f, attachment);
  const pendingIds = prepared.proposals.map((item) => item.id);
  const run = scriptedAssistant(f, [new Response(JSON.stringify({ error: { message: "虚构上游暂时不可用" } }), {
    status: 503, headers: { "Content-Type": "application/json" },
  })]);
  await assert.rejects(run.run());
  assert.equal(run.trace.executed.length, 0, "the failed provider request cannot run tools or confirm imports");
  const persisted = reload(f);
  assert.deepEqual(persisted.service.getConversation().proposals.filter((item) => item.status === "pending").map((item) => item.id), pendingIds);
  assert.equal(workspace(persisted).transactions.length, 0);
  assert.equal(workspace(persisted).bankAccounts.length, 0);
  assert.ok((await persisted.service.readOriginal(attachment.documentId)).blob);
  await persisted.service.confirmProposal(pendingIds[0]);
  assert.equal(workspace(persisted).transactions.length, 4, "continuation requires only the saved original and explicit user confirmation");
  assert.equal(persisted.service.getConversation().proposals.filter((item) => item.status === "pending").length, 2);
});

test("selfservice: losing write permission or archiving the period blocks all group confirmations without discarding originals", async (t) => {
  for (const boundary of ["permission", "archive"]) await t.test(boundary, async () => {
    const f = createFixture();
    const { attachment } = await upload(f);
    const prepared = await prepare(f, attachment);
    const changed = structuredClone(workspace(f));
    if (boundary === "archive") {
      // Synthetic boundary state only; this does not run or claim acceptance
      // of the separate month-close/archive workflow.
      changed.delivery.archives = [{ id: "synthetic-selfservice-archive", period: PERIOD }];
    } else {
      changed.roles = changed.roles.map((role) => ({ ...role, permissions: role.permissions.filter((permission) => permission !== "data.write") }));
    }
    f.store.actions.replaceWorkspace(f.workspaceId, changed);
    const before = f.storage.dump();
    const code = boundary === "archive" ? "AI_PERIOD_ARCHIVED" : "AI_ACCESS_DENIED";
    await assert.rejects(f.service.confirmProposal(prepared.proposals[0].id), { code });
    await assert.rejects(prepare(f, attachment), { code });
    assert.deepEqual(f.storage.dump(), before);
    assert.equal(workspace(f).transactions.length, 0);
    assert.equal(workspace(f).bankAccounts.length, 0);
    assert.equal(f.service.getConversation().proposals.filter((item) => item.status === "pending").length, 3);
    assert.ok((await f.service.readOriginal(attachment.documentId)).blob);
  });
});

test("selfservice: switching period during final original verification cannot create the group account or its transactions", async () => {
  const f = createFixture();
  const { attachment } = await upload(f);
  const prepared = await prepare(f, attachment);
  const getOwned = f.fileVault.getOwned.bind(f.fileVault);
  let switched = false;
  f.fileVault.getOwned = async (...args) => {
    const original = await getOwned(...args);
    if (!switched) { switched = true; f.store.actions.setPeriod(f.workspaceId, "2026-10"); }
    return original;
  };
  await assert.rejects(f.service.confirmProposal(prepared.proposals[0].id), { code: "AI_TARGET_CHANGED" });
  assert.equal(workspace(f).bankAccounts.length, 0);
  assert.equal(workspace(f).transactions.length, 0);
  assert.equal(workspace(f).aiSimple.conversations[PERIOD].proposals.filter((item) => item.status === "pending").length, 3);
  assert.ok((await f.fileVault.get(attachment.documentId)).blob);
});
