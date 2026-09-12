import test from "node:test";
import assert from "node:assert/strict";
import { listDeepSeekModels, ASSISTANT_REQUEST_TIMEOUT_MS } from "../src/application/deepseekClient.js";
import { DEFAULT_DEEPSEEK_MODEL_SETTINGS, normalizeDeepSeekModelSettings } from "../src/application/deepseekModels.js";
import { requestDeepSeekModels } from "../server/deepseekModels.js";
import { createFinanceDeskService } from "../src/application/financeDeskService.js";
import { buildFinancialStatements } from "../src/domain/accounting/reporting.js";
import { buildAiReportModel } from "../src/features/ai-simple/aiReportModel.js";
import { createAiTabSession, aiSessionContextKey } from "../src/features/ai-simple/aiModeSession.js";
import { navigationTargetError, proposalDestinations, resolveWorkbenchNavigation } from "../src/features/ai-simple/aiWorkflow.js";
import { BANK_CSV, BANK_MAPPING, createJourneyFixture, reloadJourney, namedBlob, toolCall } from "./helpers/aiSimpleJourneyFixture.mjs";
import { SYNTHETIC_KEY, initialMessages, jsonResponse, linkedAssistant, providerReply, tabNavigationFixture } from "./fixtures/ai-model-linkage/protocolFixture.mjs";

const selected = { model: "deepseek-v4-pro", thinking: "enabled", reasoningEffort: "high" };
const sessionFor = () => createAiTabSession({ defaultModelSettings: DEFAULT_DEEPSEEK_MODEL_SETTINGS, normalizeModelSettings: normalizeDeepSeekModelSettings });
const workspace = (f) => f.store.getState().workspaces.find((item) => item.id === f.workspaceId);
const withoutPrivateData = (value, ...privateValues) => {
  const serialized = JSON.stringify(value);
  for (const item of [SYNTHETIC_KEY, ...privateValues]) assert.equal(serialized.includes(item), false, "private transport data must not enter public results or finance storage");
};
const feeInput = (transactionId, documentId) => ({ transactionId, businessType: "bankFee", account: "expenseFee",
  taxTreatment: "input_non_deductible", invoiceStatus: "not_applicable", evidenceIds: [documentId], reason: "人工核对合成银行原件的账户管理手续费" });

async function pendingImport(f) {
  const [attachment] = await f.service.uploadFiles([namedBlob(BANK_CSV)]);
  const input = { documentId: attachment.documentId, accountId: f.account.id, mapping: BANK_MAPPING };
  const { proposal } = await f.service.invokeTool("prepare_bank_import", input);
  return { attachment, input, proposal };
}

test("linkage: fetched model selection reaches the real proxy, and response identity survives the conversation reload", async () => {
  const f = createJourneyFixture();
  const modelRequests = [];
  const available = await listDeepSeekModels({ apiKey: SYNTHETIC_KEY, fetchImpl: async (url, init) => {
    modelRequests.push({ url, method: init.method });
    assert.equal(url, "/api/deepseek-models");
    assert.equal(init.headers.Authorization, `Bearer ${SYNTHETIC_KEY}`);
    assert.equal(init.cache, "no-store");
    const models = await requestDeepSeekModels({ authorization: init.headers.Authorization, signal: init.signal,
      fetchImpl: async (target, options) => {
        assert.equal(target, "https://api.deepseek.com/models");
        assert.equal(options.headers.Authorization, `Bearer ${SYNTHETIC_KEY}`);
        return jsonResponse({ object: "list", data: [
          { id: "deepseek-flash", object: "model", owned_by: "deepseek" },
          { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" },
        ] });
      } });
    return jsonResponse({ models });
  } });
  assert.deepEqual(modelRequests, [{ url: "/api/deepseek-models", method: "GET" }]);
  assert.deepEqual(available.map((item) => item.id), ["deepseek-flash", "deepseek-v4-pro"]);
  const session = sessionFor();
  session.setApiKey(SYNTHETIC_KEY);
  session.setModelSettings({ ...selected, model: available[1].id });
  const returnedModel = "deepseek-v4-pro-synthetic-response";
  const run = linkedAssistant(f, [providerReply({ model: returnedModel, content: "合成资料读取完成" })], {
    ...session.getSnapshot().modelSettings, apiKey: session.readKey(),
  });
  const answer = await run.run();
  assert.equal(run.trace.providerRequests.length, 1);
  const sent = run.trace.providerRequests[0].payload;
  assert.equal(sent.model, "deepseek-v4-pro");
  assert.deepEqual(sent.thinking, { type: "enabled" });
  assert.equal(sent.reasoning_effort, "high");
  assert.equal(sent.tool_choice, "auto");
  const expected = { requestedModel: "deepseek-v4-pro", responseModel: returnedModel, thinking: "enabled", reasoningEffort: "high" };
  assert.deepEqual(answer.modelMetadata, expected);
  assert.deepEqual(run.trace.messages[0].modelMetadata, expected);
  assert.deepEqual(reloadJourney(f).service.getConversation().messages.at(-1).modelMetadata, expected);
  withoutPrivateData([available, answer, run.trace, f.storage.dump(), session.getSnapshot()]);
});

test("linkage: a missing provider identity remains unknown rather than becoming the selected model", async () => {
  const f = createJourneyFixture();
  const run = linkedAssistant(f, [providerReply({ model: null })], { ...selected, thinking: "disabled" });
  const answer = await run.run();
  assert.equal(answer.modelMetadata.requestedModel, selected.model);
  assert.equal(answer.modelMetadata.responseModel, null);
  assert.equal(answer.modelMetadata.reasoningEffort, null);
  assert.equal(Object.hasOwn(run.trace.providerRequests[0].payload, "reasoning_effort"), false);
  assert.equal(reloadJourney(f).service.getConversation().messages.at(-1).modelMetadata.responseModel, null);
});

test("linkage: thinking tool rounds preserve private reasoning and query actual ledger values without persisting reasoning", async () => {
  const f = createJourneyFixture();
  const privateThought = "synthetic-private-reasoning-round-one";
  const run = linkedAssistant(f, [
    providerReply({ content: "读取本期账本", reasoning: `${privateThought} ${SYNTHETIC_KEY}`, calls: [toolCall("live_context", "get_context", { section: "reports" })] }),
    providerReply({ content: "本期已入账费用为0元", reasoning: "synthetic-private-reasoning-round-two" }),
  ], { ...selected, messages: [...initialMessages(),
    { role: "assistant", content: "历史参考金额为999元" },
    { role: "user", content: "重新读取当前本地账本" },
  ] });
  const answer = await run.run();
  assert.equal(run.trace.providerRequests.length, 2);
  assert.deepEqual(run.trace.executed, [{ name: "get_context", input: { section: "reports" } }]);
  assert.ok(JSON.stringify(run.trace.providerRequests[0].payload.messages).includes("历史参考金额为999元"), "saved conversation remains available as labelled reference");
  assert.equal(answer.toolResults[0].result.reports.incomeStatement.expenses.value, 0);
  const continuation = run.trace.providerRequests[1].payload.messages;
  const assistant = continuation.find((item) => item.tool_calls?.some((call) => call.id === "live_context"));
  assert.ok(assistant.reasoning_content.includes(privateThought));
  assert.equal(assistant.reasoning_content.includes(SYNTHETIC_KEY), false);
  const result = continuation.find((item) => item.role === "tool" && item.tool_call_id === "live_context");
  assert.equal(JSON.parse(result.content).reports.incomeStatement.expenses.value, 0);
  for (const request of run.trace.providerRequests) {
    assert.equal(request.payload.model, selected.model);
    assert.deepEqual(request.payload.thinking, { type: "enabled" });
  }
  withoutPrivateData([answer, run.trace.messages, f.storage.dump()], privateThought, "synthetic-private-reasoning-round-two");
  assert.equal(JSON.stringify(answer).includes("reasoning_content"), false);
});

test("linkage: cancelling after a prepared import keeps the pending proposal and original but never starts the second tool", async () => {
  const f = createJourneyFixture();
  const [attachment] = await f.service.uploadFiles([namedBlob(BANK_CSV)]);
  const controller = new AbortController();
  const thought = "synthetic-cancelled-private-reasoning";
  const run = linkedAssistant(f, [providerReply({ content: "准备流水导入", reasoning: thought, calls: [
    toolCall("prepare_before_cancel", "prepare_bank_import", { documentId: attachment.documentId, accountId: f.account.id, mapping: BANK_MAPPING }),
    toolCall("never_started", "get_context", { section: "reports" }),
  ] })], { ...selected, signal: controller.signal, onToolResult: () => controller.abort() });
  let stopped;
  await assert.rejects(run.run(), (error) => { stopped = error; return error.code === "ASSISTANT_CANCELLED"; });
  assert.equal(run.trace.executed.length, 1);
  assert.equal(stopped.toolResults.length, 1);
  const restored = reloadJourney(f);
  assert.equal(restored.service.getConversation().proposals[0].status, "pending");
  assert.equal(workspace(restored).transactions.length, 0);
  assert.equal(workspace(restored).vouchers.length, 0);
  assert.equal(await (await restored.service.readOriginal(attachment.documentId)).blob.text(), BANK_CSV);
  assert.equal(stopped.messages.filter((item) => item.role === "tool").length, 2, "the unstarted call gets a nonexecuted protocol result");
  withoutPrivateData([stopped.message, stopped.messages, stopped.toolResults, run.trace.messages, f.storage.dump()], thought);
});

test("linkage: invalid credentials stop before tools and preserve existing proposals and originals", async () => {
  const f = createJourneyFixture();
  const { attachment, proposal } = await pendingImport(f);
  const before = f.storage.dump();
  const run = linkedAssistant(f, [jsonResponse({ error: `synthetic provider echo ${SYNTHETIC_KEY}` }, 401)], selected);
  let stopped;
  await assert.rejects(run.run(), (error) => { stopped = error; return error.code === "KEY_REQUIRED"; });
  assert.equal(run.trace.providerRequests.length, 1, "no automatic credential retry");
  assert.equal(run.trace.executed.length, 0);
  assert.deepEqual(f.storage.dump(), before);
  assert.equal(reloadJourney(f).service.getConversation().proposals.find((item) => item.id === proposal.id).status, "pending");
  assert.equal(await (await f.service.readOriginal(attachment.documentId)).blob.text(), BANK_CSV);
  withoutPrivateData([stopped.message, stopped.messages, stopped.toolResults, f.storage.dump()]);
});

test("linkage: client timeout aborts the in-process upstream and leaves the ledger unchanged", async (t) => {
  const f = createJourneyFixture();
  await pendingImport(f);
  const before = f.storage.dump();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let upstreamSignal;
  const run = linkedAssistant(f, [({ signal }) => {
    upstreamSignal = signal;
    const waiting = new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("synthetic timeout")), { once: true }));
    t.mock.timers.tick(ASSISTANT_REQUEST_TIMEOUT_MS);
    return waiting;
  }], selected);
  await assert.rejects(run.run(), { code: "ASSISTANT_TIMEOUT" });
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(run.trace.providerRequests.length, 1);
  assert.equal(run.trace.executed.length, 0);
  assert.deepEqual(f.storage.dump(), before);
});

test("linkage: request cancellation reaches the in-process upstream without executing a late tool", async () => {
  const f = createJourneyFixture();
  const controller = new AbortController();
  let upstreamSignal;
  const run = linkedAssistant(f, [({ signal }) => {
    upstreamSignal = signal;
    const waiting = new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("synthetic abort")), { once: true }));
    controller.abort();
    return waiting;
  }], { ...selected, signal: controller.signal });
  await assert.rejects(run.run(), { code: "ASSISTANT_CANCELLED" });
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(run.trace.executed.length, 0);
  assert.equal(workspace(f).transactions.length, 0);
});

test("linkage: full-workbench posting updates the existing simple service, report view and the next tool response", async (t) => {
  const f = createJourneyFixture();
  const { controller, browser } = tabNavigationFixture();
  t.after(() => controller.dispose());
  const session = sessionFor();
  session.setApiKey(SYNTHETIC_KEY);
  session.setModelSettings(selected);
  const file = namedBlob("尚未发送的合成附件", "待发送.txt", "text/plain");
  const draft = { text: "回简版后继续处理", files: [{ id: "unsent", file }] };
  session.updateContext(f.workspaceId, f.period, "draft", draft);
  const { attachment, proposal } = await pendingImport(f);
  await f.service.confirmProposal(proposal.id);
  const transaction = workspace(f).transactions.find((item) => item.amount === -25);
  const business = (await f.service.invokeTool("propose_bank_business", feeInput(transaction.id, attachment.documentId))).proposal;
  const confirmed = await f.service.confirmProposal(business.id);
  assert.ok(confirmed.voucherId);
  const simpleBefore = buildAiReportModel(workspace(f));
  assert.equal(simpleBefore.pendingCount, 1);
  assert.equal(f.service.getContext("reports").reports.incomeStatement.expenses.value, 0);

  const destination = { ...resolveWorkbenchNavigation("vouchers", { voucherId: confirmed.voucherId }),
    workspaceId: f.workspaceId, period: f.period, nonce: 1 };
  assert.equal(controller.navigate("full", destination), true);
  assert.deepEqual(controller.getSnapshot(), { mode: "full", navigationRequest: destination });
  assert.equal(navigationTargetError(workspace(f), destination), "");
  assert.equal(new URL(browser.location.href).searchParams.get("mode"), "full");

  // This is the shared application entry used by the full workbench, not a
  // fixture-written posted flag or a second independent store.
  const fullService = createFinanceDeskService({ store: f.store, fileVault: f.fileVault });
  await fullService.postVoucher({ workspaceId: f.workspaceId, period: f.period, voucherId: confirmed.voucherId,
    reviewNote: "已在完整工作台核对合成银行原件与25元手续费分录" });
  assert.equal(controller.navigate("ai"), true);
  assert.equal(controller.getSnapshot().mode, "ai");
  assert.equal(new URL(browser.location.href).searchParams.has("mode"), false);
  const fullReports = buildFinancialStatements(workspace(f));
  const simpleReports = buildAiReportModel(workspace(f));
  assert.equal(fullReports.incomeStatement.expenses.value, 25);
  assert.equal(simpleReports.sections.find((item) => item.id === "income").rows.find((item) => item.id === "expenses").value, 25);
  assert.equal(simpleReports.pendingCount, 0);
  assert.deepEqual(fullReports.ledger.vouchers, [confirmed.voucherId]);
  assert.equal(f.service.getContext("reports").reports.incomeStatement.expenses.value, 25, "the pre-existing simple service reads latest state");
  const run = linkedAssistant(f, [
    providerReply({ content: "重新读取完整工作台入账后的报表", reasoning: "synthetic-read-latest", calls: [toolCall("latest_report", "get_context", { section: "reports" })] }),
    providerReply({ content: "已入账费用25元" }),
  ], { ...session.getSnapshot().modelSettings, apiKey: session.readKey() });
  const answer = await run.run();
  assert.equal(answer.toolResults[0].result.reports.incomeStatement.expenses.value, 25);
  assert.equal(reloadJourney(f).service.getContext("reports").reports.incomeStatement.expenses.value, 25);
  const retainedDraft = session.getSnapshot().contexts[aiSessionContextKey(f.workspaceId, f.period)].draft;
  assert.equal(retainedDraft.text, draft.text);
  assert.equal(retainedDraft.files[0].file, file, "unsent File remains in the existing tab session");
  assert.equal(session.readKey(), SYNTHETIC_KEY);
  assert.equal(await (await f.service.readOriginal(attachment.documentId)).blob.text(), BANK_CSV);
  withoutPrivateData([answer, session.getSnapshot(), browser.history.state, f.storage.dump()]);
  const freshTab = sessionFor();
  assert.equal(freshTab.readKey(), "");
  assert.equal(freshTab.getSnapshot().configured, false);
  assert.deepEqual(freshTab.getSnapshot().contexts, {});
});

test("linkage: applied proposal destinations resolve the exact stored document, transaction and voucher in the selected scope", async () => {
  const f = createJourneyFixture();
  const { attachment, proposal } = await pendingImport(f);
  await f.service.confirmProposal(proposal.id);
  const transaction = workspace(f).transactions.find((item) => item.amount === -25);
  const business = (await f.service.invokeTool("propose_bank_business", feeInput(transaction.id, attachment.documentId))).proposal;
  const confirmed = await f.service.confirmProposal(business.id);
  const applied = f.service.getConversation().proposals.find((item) => item.id === business.id);
  const destinations = proposalDestinations(applied, workspace(f));
  assert.ok(destinations.some((item) => item.documentId === attachment.documentId));
  assert.ok(destinations.some((item) => item.transactionId === transaction.id));
  assert.ok(destinations.some((item) => item.voucherId === confirmed.voucherId));
  for (const destination of destinations) {
    assert.equal(destination.workspaceId, f.workspaceId);
    assert.equal(destination.period, f.period);
    const page = destination.voucherId ? "vouchers" : destination.transactionId ? "transactions" : "documents";
    const { workspaceId, period, label: _label, initialTab: _tab, ...options } = destination;
    const resolved = resolveWorkbenchNavigation(page, options);
    assert.equal(navigationTargetError(workspace(f), { ...resolved, workspaceId, period }), "");
    if (destination.voucherId) assert.deepEqual(resolved, { page: "reconcile", options: { voucherId: confirmed.voucherId, panel: "vouchers" } });
    if (destination.transactionId) assert.equal(resolved.options.transactionId, transaction.id);
  }
  assert.notEqual(navigationTargetError(workspace(f), { workspaceId: "another-company", period: f.period, options: { voucherId: confirmed.voucherId } }), "");
  assert.notEqual(navigationTargetError(workspace(f), { workspaceId: f.workspaceId, period: "2026-08", options: { documentId: attachment.documentId } }), "");
  assert.notEqual(navigationTargetError(workspace(f), { workspaceId: f.workspaceId, period: f.period, options: { transactionId: "missing" } }), "");
});

for (const change of ["company", "period"]) test(`linkage: a late ${change} response cannot apply the old target's import or overwrite its draft`, async () => {
  const f = createJourneyFixture();
  const { input, proposal } = await pendingImport(f);
  const session = sessionFor();
  session.setApiKey(SYNTHETIC_KEY);
  session.updateContext(f.workspaceId, f.period, "draft", { text: "原目标尚未发送", files: [] });
  const other = change === "company" ? f.store.actions.createWorkspace({ id: "model-linkage-other", name: "另一家合成公司", currentPeriod: f.period,
    initialUserName: "合成负责人", initialUserRoleId: "role-owner", activate: false }) : null;
  const run = linkedAssistant(f, [() => {
    if (other) f.store.actions.switchWorkspace(other.id);
    else f.store.actions.setPeriod(f.workspaceId, "2026-10");
    return providerReply({ content: "", reasoning: "synthetic-late-target", calls: [toolCall("late_target_import", "prepare_bank_import", input)] });
  }], selected);
  await assert.rejects(run.run(), { code: "AI_TARGET_CHANGED" });
  await assert.rejects(f.service.confirmProposal(proposal.id), { code: "AI_TARGET_CHANGED" });
  const active = f.store.getActiveWorkspace();
  session.updateContext(active.id, active.currentPeriod, "draft", { text: "新目标自己的输入", files: [] });
  assert.equal(session.getSnapshot().contexts[aiSessionContextKey(f.workspaceId, f.period)].draft.text, "原目标尚未发送");
  assert.equal(session.getSnapshot().contexts[aiSessionContextKey(active.id, active.currentPeriod)].draft.text, "新目标自己的输入");
  assert.equal(workspace(f).aiSimple.conversations[f.period].proposals.find((item) => item.id === proposal.id).status, "pending");
  assert.equal(workspace(f).transactions.length, 0);
  assert.equal(active.transactions.length, 0);
  assert.equal(session.readKey(), SYNTHETIC_KEY);
  withoutPrivateData([session.getSnapshot(), f.storage.dump()]);
});

test("linkage: archived targets remain readable through both report paths, and tools and confirmations remain read-only", async () => {
  const f = createJourneyFixture();
  const { attachment, input, proposal } = await pendingImport(f);
  const archived = structuredClone(workspace(f));
  // Synthetic archive state only: this does not claim the real close/archive
  // workflow ran, which is outside this model-and-entry linkage scope.
  archived.delivery.archives = [{ id: "synthetic-model-linkage-archive", period: f.period }];
  f.store.actions.replaceWorkspace(f.workspaceId, archived);
  const before = f.storage.dump();
  assert.equal(f.service.getContext().archived, true);
  assert.equal(buildAiReportModel(workspace(f)).archived, true);
  assert.equal(buildFinancialStatements(workspace(f)).incomeStatement.expenses.value, 0);
  assert.equal(navigationTargetError(workspace(f), { workspaceId: f.workspaceId, period: f.period, options: { documentId: attachment.documentId } }), "");
  assert.equal(await (await f.service.readOriginal(attachment.documentId)).blob.text(), BANK_CSV);
  await assert.rejects(f.service.confirmProposal(proposal.id), { code: "AI_PERIOD_ARCHIVED" });
  const run = linkedAssistant(f, [providerReply({ content: "", reasoning: "synthetic-archived", calls: [toolCall("archived_write", "prepare_bank_import", input)] })], selected);
  await assert.rejects(run.run(), { code: "AI_PERIOD_ARCHIVED" });
  assert.equal(run.trace.providerRequests.length, 1);
  assert.deepEqual(f.storage.dump(), before);
});
