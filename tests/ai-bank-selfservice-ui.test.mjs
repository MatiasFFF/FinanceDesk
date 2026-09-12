import test from "node:test";
import assert from "node:assert/strict";
import { bankAccountDraft, bankAccountLabel, bankAmountRows, bankGroupView, bankMoney, bankPreparedReadback, bankRetrySettings, bankSaveErrorMessage, bankSourceRows, hasLocalBankAttachments } from "../src/features/ai-simple/aiBankSelfService.js";
import { createAiTabSession } from "../src/features/ai-simple/aiModeSession.js";

function proposal(overrides = {}) {
  return { id: "group-proposal", kind: "bank_import", status: "pending", preview: {
    sourceGroupId: "source-group", canConfirm: true, importedCount: 430, duplicateCount: 2, errorCount: 0,
    group: { groupId: "source-group", sourceBank: "海湾银行", sourceAccountName: "示例公司", sourceAccount: "9900000123456789", accountTail: "6789", sourceRowNumbers: [2, 4, 6] },
    summary: { rowCount: 432, uniqueRowCount: 430, income: 9000, expense: 1250, rawIncome: 9050, rawExpense: 1260, dateFrom: "2026-08-01", dateTo: "2026-08-31", openingBalance: null, statementClosing: null, balanceDifference: null },
    accountResolution: { status: "new", accountId: "pending-private-account", suggestedAccount: { id: "pending-private-account", name: "海湾银行 · 尾号6789", accountNumber: "6789" }, candidateAccounts: [] },
    transactions: Array.from({ length: 20 }, () => ({ amount: 1 })), ...overrides } };
}

test("group UI uses the complete deterministic summary and separates raw rows from deduplicated amounts", () => {
  const item = proposal();
  const view = bankGroupView(item);
  assert.equal(view.rowCount, 432);
  assert.equal(view.summary.income, 9000);
  assert.equal(view.summary.rawIncome, 9050);
  assert.equal(view.summary.expense, 1250);
  assert.equal(view.summary.rawExpense, 1260);
  assert.equal(view.dateRange, "2026-08-01 至 2026-08-31");
  assert.equal(view.status, "待确认导入");
  assert.equal(view.confirmLabel, "确认账户并导入本组");
  item.preview.transactions.length = 0;
  assert.equal(bankGroupView(item).summary.income, 9000, "empty or truncated samples cannot alter totals");
});

test("unavailable balances remain unknown while a calculated zero remains zero", () => {
  for (const value of [null, undefined, "", "invalid", Number.NaN]) assert.equal(bankMoney(value), "待核对");
  assert.equal(bankMoney(0), "0.00");
  assert.equal(bankGroupView(proposal()).summary.openingBalance, null);
  assert.equal(bankGroupView({ preview: { group: {} } }).rowCount, null);
});

test("pending account choices and erroneous groups stay blocked while applied status remains explicit", () => {
  for (const status of ["ambiguous", "missing"]) {
    const view = bankGroupView(proposal({ canConfirm: false, accountResolution: { status } }));
    assert.equal(view.blocked, true); assert.equal(view.status, "待确认账户");
  }
  const erroneous = proposal({ errorCount: 1, canConfirm: false });
  assert.equal(bankGroupView(erroneous).status, "需修正原件");
  assert.equal(bankGroupView(erroneous).blocked, true);
  assert.equal(bankGroupView({ ...erroneous, status: "applied" }).status, "已导入");
  assert.equal(bankGroupView({ ...proposal(), status: "failed" }).status, "导入失败");
});

test("new account correction starts with the extracted name and tail, never a synthetic account ID selection", () => {
  const draft = bankAccountDraft(proposal(), { bankAccounts: [] });
  assert.equal(draft.accountId, "new");
  assert.equal(draft.accountNumber, "6789");
  assert.equal(draft.name, "海湾银行 · 尾号6789");
  assert.equal(draft.mustChoose, false, "a normal new group needs only the import confirmation");
  assert.equal(bankAccountLabel({ id: "internal-id", name: draft.name, accountNumber: draft.accountNumber }), draft.name);
  assert.equal(bankGroupView(proposal()).label, "海湾银行 · 示例公司 · 尾号 6789");
  assert.equal(bankSourceRows(proposal().preview.group), "原表第 2、4、6 行");
});

test("ambiguous accounts have no silently preselected candidate and inactive accounts are unavailable", () => {
  const candidateAccounts = [{ id: "a", name: "基本户", accountNumber: "1111" }, { id: "b", name: "一般户", accountNumber: "2222" }, { id: "c", name: "已停用", status: "inactive" }];
  const view = bankAccountDraft(proposal({ accountResolution: { status: "ambiguous", candidateAccounts } }), { bankAccounts: [] });
  assert.equal(view.accountId, "");
  assert.equal(view.mustChoose, true);
  assert.deepEqual(view.candidates.map(({ id }) => id), ["a", "b"]);
  assert.equal(bankAccountLabel(view.candidates[0]), "基本户 · 尾号 1111");
});

test("retry keeps original settings and only an explicit choice disables thinking", () => {
  const original = { model: "deepseek-v4-pro", thinking: "enabled", reasoningEffort: "high" };
  const saved = { model: "deepseek-flash", thinking: "disabled", reasoningEffort: "high" };
  const recovery = { modelSettings: original, continuation: {} };
  assert.deepEqual(bankRetrySettings(saved, recovery), original);
  assert.deepEqual(bankRetrySettings(saved, recovery, true), { ...original, thinking: "disabled" });
  assert.equal(recovery.modelSettings.thinking, "enabled");
  assert.equal(saved.model, "deepseek-flash");
  assert.deepEqual(bankRetrySettings(saved, null), saved);
});

test("the tab session preserves opaque continuation identity without putting a key into UI state", () => {
  const session = createAiTabSession({ defaultModelSettings: { model: "deepseek-v4-pro", thinking: "enabled" } });
  const token = Object.freeze({});
  session.setApiKey("synthetic_private_key");
  session.updateContext("workspace", "2026-08", "replyRecovery", { continuation: token });
  const context = Object.values(session.getSnapshot().contexts)[0];
  assert.equal(context.replyRecovery.continuation, token);
  assert.equal(JSON.stringify(session.getSnapshot()).includes("synthetic_private_key"), false);
  session.updateContext("workspace", "2026-08", "replyRecovery", null);
  assert.equal(Object.values(session.getSnapshot().contexts)[0].replyRecovery, null);
});

test("local bank preparation can continue from home and workspace creation without a model key", () => {
  for (const name of ["合并流水.xlsx", "合并流水.XLS", "银行记录.csv"]) assert.equal(hasLocalBankAttachments({ files: [{ file: { name } }] }), true);
  assert.equal(hasLocalBankAttachments({ files: [{ file: { name: "票据.pdf" } }] }), false);
  assert.equal(hasLocalBankAttachments({ text: "继续整理", files: [] }), false);
  assert.equal(hasLocalBankAttachments(null), false);
});

test("identical totals display one income/expense pair and retain the source totals in details", () => {
  const summary = { income: 1250, expense: 45.2, rawIncome: 1250, rawExpense: 45.2, duplicateCount: 0 };
  const compact = bankAmountRows({ summary, duplicateCount: 0 });
  assert.deepEqual(compact.main, [["原表收入合计", "1,250.00 元"], ["原表支出合计", "45.20 元"]]);
  assert.deepEqual(compact.original, [["原表收入合计", "1,250.00 元"], ["原表支出合计", "45.20 元"]]);
  const changed = bankAmountRows({ summary: { ...summary, rawIncome: 1300 }, duplicateCount: 1 });
  assert.equal(changed.main.length, 4);
  assert.deepEqual(changed.main[0], ["原表收入合计", "1,300.00 元"]);
  assert.deepEqual(changed.main[2], ["原表收入（去重）", "1,250.00 元"]);
  assert.deepEqual(changed.original, []);
  assert.deepEqual(bankAmountRows({ summary, duplicateCount: 432 }).main, compact.main, "already-existing ledger rows do not change original-file amount labels");
});

test("an entirely imported reupload is a complete local result with no confirmation required", () => {
  const item = proposal();
  const readback = bankPreparedReadback({ status: "already_imported", proposals: [],
    analysis: { groups: [{ ...item.preview.group, summary: item.preview.summary }] },
    alreadyImportedGroups: [{ sourceGroupId: "source-group", counts: { imported: 0, duplicates: 432, errors: 0 } }],
    message: "这份原件的432笔流水已全部存在，没有新增，不需要再次确认。" });
  assert.equal(readback.usable, true);
  assert.equal(readback.groups.length, 1);
  assert.equal(readback.groups[0].counts.imported, 0);
  assert.equal(readback.groups[0].summary.income, 9000, "original amounts remain separate from zero newly imported rows");
  const view = bankGroupView({ status: "already_imported", preview: readback.groups[0] });
  assert.equal(view.status, "已导入，无新增");
  assert.equal(view.blocked, false);
  assert.match(readback.message, /不需要再次确认/);
  assert.equal(bankPreparedReadback({ status: "needs_correction", proposals: [] }).usable, false);
});

test("mixed reuploads preserve completed-group feedback alongside only the new pending proposals", () => {
  const item = proposal();
  const result = { status: "pending_confirmation", proposals: [item], analysis: { groups: [{ ...item.preview.group, summary: item.preview.summary }] },
    alreadyImportedGroups: [{ sourceGroupId: "source-group", counts: { imported: 0, duplicates: 432, errors: 0 } }] };
  const readback = bankPreparedReadback(result);
  assert.equal(readback.usable, true);
  assert.equal(readback.groups.length, 1);
  assert.equal(readback.message, "", "a mixed file must not be described as wholly imported");
  assert.equal(result.proposals.length, 1, "readback feedback never creates confirmation proposals");
});

test("storage capacity failures explain the unimported group without exposing browser internals or suggesting deletion", () => {
  for (const error of [{ name: "QuotaExceededError", message: "A write failed" }, { code: "LOCAL_STORAGE_QUOTA_EXCEEDED", message: "A write failed" },
    new Error("Failed to execute 'setItem' on 'Storage': Setting the value exceeded the quota.")]) {
    assert.equal(bankSaveErrorMessage(error, { importing: true }), "本机保存空间不足，本组尚未导入，已保存资料和其它分组保留。");
    assert.equal(bankSaveErrorMessage(error), "本机保存空间不足，本次操作尚未保存，已保存资料和其它分组保留。");
  }
  assert.equal(bankSaveErrorMessage(new Error("账户已停用，请重新选择"), { importing: true }), "账户已停用，请重新选择");
});
