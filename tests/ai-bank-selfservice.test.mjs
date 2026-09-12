import test from "node:test";
import assert from "node:assert/strict";
import { runFinanceAssistant } from "../src/application/deepseekClient.js";
import { AI_FINANCE_TOOLS } from "../src/application/aiFinanceTools.js";
import { createAiFinanceService } from "../src/application/aiFinanceService.js";
import { createBlankWorkspace, createInitialState } from "../src/domain/foundation.js";
import { createFinanceDeskStore } from "../src/store/financeDeskStore.js";
import { createLocalFoundationRepository, createMemoryStorage } from "../src/storage/localFoundationRepository.js";
import { createMemoryFileVault } from "../src/features/intake/browserFileVault.js";

// Synthetic responses and bank data only; these tests never contact a provider.
const key = "synthetic_bank_continuation_key";
const initial = [{ role: "user", content: "请核对已保存的银行文件" }];
const response = (message, finishReason = "stop") => new Response(JSON.stringify({ message, finishReason }), {
  headers: { "Content-Type": "application/json" },
});
const toolCall = { id: "bank-analysis-1", type: "function", function: { name: "read_bank_statement", arguments: '{"documentId":"synthetic-document"}' } };
const thinkingReply = (content, calls) => response({ role: "assistant", content,
  reasoning_content: "synthetic-live-reasoning", ...(calls ? { tool_calls: calls } : {}) }, calls ? "tool_calls" : "stop");

test("timed out thinking resumes its completed bank tool result without executing it again", async () => {
  let requests = 0;
  let executions = 0;
  let interrupted;
  try {
    await runFinanceAssistant({ apiKey: key, messages: initial, model: "deepseek-flash", thinking: "enabled", reasoningEffort: "max",
      executeTool: async () => { executions += 1; return { status: "analyzed", analysis: { rowCount: 144,
        groups: [{ groupId: "group-1", summary: { rowCount: 144, income: 2448, expense: 0 } }] } }; },
      fetchImpl: async () => ++requests === 1 ? thinkingReply("", [toolCall]) : new Response("", { status: 504 }) });
  } catch (error) { interrupted = error; }
  assert.equal(interrupted.code, "ASSISTANT_TIMEOUT");
  assert.equal(interrupted.recovery.canContinue, true);
  assert.equal(interrupted.recovery.completedToolCount, 1);
  assert.equal(executions, 1);
  assert.equal(JSON.stringify(interrupted).includes("synthetic-live-reasoning"), false);
  assert.equal(JSON.stringify(interrupted).includes(key), false);
  const resumed = await runFinanceAssistant({ apiKey: key, messages: initial, model: "deepseek-flash", thinking: "enabled", reasoningEffort: "max",
    continuation: interrupted.continuation, executeTool: () => assert.fail("completed analysis must not replay"),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, "deepseek-flash");
      assert.equal(body.thinking, "enabled");
      assert.equal(body.reasoningEffort, "max");
      assert.equal(body.messages.at(-2).reasoning_content, "synthetic-live-reasoning");
      assert.equal(body.messages.at(-1).tool_call_id, toolCall.id);
      assert.equal(JSON.parse(body.messages.at(-1).content).analysis.groups[0].summary.income, 2448);
      return thinkingReply("已读取144行，请核对账户。");
    } });
  assert.equal(resumed.toolResults.length, 1);
  assert.equal(resumed.message.content, "已读取144行，请核对账户。");
  assert.equal(executions, 1);
});

test("an explicit disabled-thinking continuation retains bank results but sends no reasoning", async () => {
  let requests = 0;
  let interrupted;
  await assert.rejects(runFinanceAssistant({ apiKey: key, messages: initial, thinking: "enabled",
    executeTool: async () => ({ status: "analyzed", analysis: { rowCount: 1, groups: [{ groupId: "g", summary: { rowCount: 1, income: 19 } }] } }),
    fetchImpl: async () => ++requests === 1 ? thinkingReply("", [toolCall]) : new Response("", { status: 504 }),
  }), (error) => { interrupted = error; return error.code === "ASSISTANT_TIMEOUT"; });
  await runFinanceAssistant({ apiKey: key, messages: initial, continuation: interrupted.continuation, thinking: "disabled",
    executeTool: () => assert.fail("must retain the existing analysis"), fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.thinking, "disabled");
      assert.ok(body.messages.every((item) => !Object.hasOwn(item, "reasoning_content")));
      assert.equal(body.messages.at(-1).tool_call_id, toolCall.id);
      return response({ role: "assistant", content: "本组收入19元。" });
    } });
});

function fixture() {
  const now = () => new Date("2026-09-12T08:00:00.000Z");
  const workspace = createBlankWorkspace({ id: "self-service-bank", name: "虚构工作台", currentPeriod: "2026-09" }, { now });
  const repository = createLocalFoundationRepository({ storage: createMemoryStorage(), now });
  repository.save({ ...createInitialState({ now }), workspaces: [workspace], activeWorkspaceId: workspace.id });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const service = createAiFinanceService({ store, fileVault, workspaceId: workspace.id, period: workspace.currentPeriod });
  return { service, store, fileVault };
}
const bankFile = () => Object.assign(new Blob([
  "本方账号,本方银行,交易日期,交易时间,收入,支出,余额,摘要\n",
  "99900000001111,虚构甲银行,20260901,080001,100,,100,客户款\n",
  "99900000002222,虚构乙银行,20260902,080002,200,,200,客户款\n",
]), { name: "虚构合并银行.csv" });

test("bank tool schema and read-only analysis do not require an existing bank account", async () => {
  assert.deepEqual(AI_FINANCE_TOOLS.find((item) => item.function.name === "prepare_bank_import").function.parameters.required, ["documentId"]);
  const f = fixture();
  const [file] = await f.service.uploadFiles([bankFile()]);
  const result = await f.service.invokeTool("read_bank_statement", { documentId: file.documentId });
  assert.equal(result.analysis.rowCount, 2);
  assert.equal(result.analysis.summary.income, 300);
  assert.equal(result.analysis.groups.length, 2);
  assert.equal(f.store.getActiveWorkspace().bankAccounts.length, 0);
  assert.equal(f.service.getConversation().proposals.length, 0);
});

test("one account confirmation does not invalidate the other group's pending proposal", async () => {
  const f = fixture();
  const [file] = await f.service.uploadFiles([bankFile()]);
  const first = await f.service.prepareBankFile({ documentId: file.documentId });
  const repeated = await f.service.prepareBankFile({ documentId: file.documentId });
  assert.deepEqual(first.proposals.map((item) => item.id), repeated.proposals.map((item) => item.id));
  assert.equal(f.store.getActiveWorkspace().bankAccounts.length, 0);
  assert.ok(first.proposals.every((item) => item.preview.accountResolution.status === "new" && item.preview.canConfirm));
  assert.ok(first.proposals.every((item) => item.preview.accountResolution.suggestedAccount.openingBalance == null));
  await f.service.confirmProposal(first.proposals[0].id);
  const second = await f.service.confirmProposal(first.proposals[1].id);
  assert.equal(second.result.counts.imported, 1);
  assert.equal(f.store.getActiveWorkspace().bankAccounts.length, 2);
  assert.equal(f.store.getActiveWorkspace().transactions.length, 2);
  assert.ok(f.store.getActiveWorkspace().bankAccounts.every((item) => item.openingBalance == null));
  assert.ok(f.service.getConversation().proposals.every((item) => item.status === "applied"));
});

test("bank confirmations store references and shrink earlier full results when retrying the remaining group", async () => {
  const f = fixture();
  const [file] = await f.service.uploadFiles([bankFile()]);
  const prepared = await f.service.prepareBankFile({ documentId: file.documentId });
  const first = await f.service.confirmProposal(prepared.proposals[0].id);
  assert.equal(first.result.import.transactions.length, 1, "the public result still reads the real imported rows");
  let workspace = f.store.getActiveWorkspace();
  let saved = workspace.aiSimple.conversations["2026-09"].proposals[0];
  assert.equal(saved.result.import, undefined, "the conversation must not save a second complete bank import");
  assert.equal(saved.preview.transactions[0].raw, undefined);
  assert.ok(workspace.transactions[0].raw, "the financial source row must remain intact");

  // Reproduce the old persisted shape without any real user's data. A later
  // normal confirmation must reclaim that redundant copy in the same save.
  const previousShape = structuredClone(workspace);
  previousShape.aiSimple.conversations["2026-09"].proposals[0].result = structuredClone(first.result);
  previousShape.aiSimple.conversations["2026-09"].proposals[0].preview.transactions = structuredClone(first.result.import.transactions);
  f.store.actions.replaceWorkspace(workspace.id, previousShape, { period: "2026-09" });
  const second = await f.service.confirmProposal(prepared.proposals[1].id);
  assert.equal(second.result.counts.imported, 1);
  workspace = f.store.getActiveWorkspace();
  assert.equal(workspace.transactions.length, 2);
  assert.ok(workspace.transactions.every((item) => item.raw && item.evidenceIds.includes(file.documentId)));
  assert.ok(workspace.aiSimple.conversations["2026-09"].proposals.every((item) => item.status === "applied"
    && !item.result.import && item.preview.transactions.every((row) => !row.raw)));
  assert.deepEqual((await f.service.confirmProposal(prepared.proposals[0].id)).result.counts, first.result.counts);
  assert.ok((await f.fileVault.get(file.documentId)).blob);
});

test("reupload keeps only unfinished groups pending and returns already imported without another confirmation", async () => {
  const f = fixture();
  const [file] = await f.service.uploadFiles([bankFile()]);
  const initial = await f.service.prepareBankFile({ documentId: file.documentId });
  await f.service.confirmProposal(initial.proposals[0].id);
  const mixed = await f.service.prepareBankFile({ documentId: file.documentId });
  assert.equal(mixed.status, "pending_confirmation");
  assert.equal(mixed.alreadyImportedGroups.length, 1);
  assert.equal(mixed.alreadyImportedGroups[0].counts.imported, 0);
  assert.deepEqual(mixed.proposals.map((item) => item.id), [initial.proposals[1].id]);
  await f.service.confirmProposal(initial.proposals[1].id);
  f.store.actions.applyBankImport = () => assert.fail("reupload must not replay a bank import");
  f.store.actions.replaceWorkspace = () => assert.fail("already imported preparation needs no new saved confirmation");
  const done = await f.service.prepareBankFile({ documentId: file.documentId });
  assert.equal(done.status, "already_imported");
  assert.deepEqual(done.proposals, []);
  assert.equal(done.proposal, undefined);
  assert.equal(done.alreadyImportedGroups.length, 2);
  assert.equal(done.alreadyImportedGroups.reduce((total, group) => total + group.counts.duplicates, 0), 2);
  assert.match(done.message, /没有新增.*不需要再次确认/);
  assert.equal(f.store.getActiveWorkspace().transactions.length, 2);
});
