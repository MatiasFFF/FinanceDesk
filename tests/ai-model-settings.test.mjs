import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DEEPSEEK_MODEL_SETTINGS, KNOWN_DEEPSEEK_MODELS, normalizeDeepSeekModels } from "../src/application/deepseekModels.js";
import { currentModelLabel, messageModelLabel, modelOptions, replyModelMetadata, settingsForModel, snapshotModelSettings } from "../src/features/ai-simple/aiModelSettings.js";
import { createAiFinanceService } from "../src/application/aiFinanceService.js";
import { createBlankWorkspace, createInitialState, normalizeWorkspace } from "../src/domain/foundation.js";
import { createFinanceDeskStore } from "../src/store/financeDeskStore.js";
import { createLocalFoundationRepository, createMemoryStorage } from "../src/storage/localFoundationRepository.js";
import { createMemoryFileVault } from "../src/features/intake/browserFileVault.js";

test("a running request keeps its selected model and thinking settings when the next selection changes", () => {
  const selected = { ...DEFAULT_DEEPSEEK_MODEL_SETTINGS, thinking: "enabled", reasoningEffort: "max", apiKey: "sk-test-only-secret" };
  const request = snapshotModelSettings(selected);
  selected.model = "deepseek-v4-pro"; selected.thinking = "disabled"; selected.reasoningEffort = "low";
  assert.deepEqual(request, { model: "deepseek-flash", thinking: "enabled", reasoningEffort: "max" });
  assert.ok(Object.isFrozen(request));
  assert.equal(JSON.stringify(request).includes("secret"), false);
  assert.match(currentModelLabel(request), /思考 · 最高/);
});

test("new official model IDs can be selected without inheriting unconfirmed thinking capability", () => {
  const models = normalizeDeepSeekModels({ object: "list", data: [{ id: "deepseek-new-official", owned_by: "deepseek" }] });
  const selection = settingsForModel({ model: "deepseek-flash", thinking: "enabled", reasoningEffort: "max" }, models[0].id);
  assert.equal(selection.model, "deepseek-new-official");
  assert.equal(selection.thinking, "disabled");
  assert.equal(models[0].capabilities.known, false);
  assert.deepEqual(models[0].capabilities.reasoningEfforts, []);
});

test("official list results do not acquire static models that the account did not return", () => {
  const unread = modelOptions(null, DEFAULT_DEEPSEEK_MODEL_SETTINGS.model);
  assert.equal(unread.length, KNOWN_DEEPSEEK_MODELS.length);
  const official = normalizeDeepSeekModels({ object: "list", data: [{ id: "deepseek-new-official", owned_by: "deepseek" }] });
  const result = modelOptions(official, "deepseek-flash");
  assert.deepEqual(result.filter((item) => !item.unavailable).map((item) => item.id), ["deepseek-new-official"]);
  assert.equal(result.find((item) => item.id === "deepseek-flash").unavailable, true);
  assert.equal(modelOptions([], "deepseek-flash").filter((item) => !item.unavailable).length, 0);
  assert.equal(official.length, 1, "the provider response remains unchanged");
});

test("reply labels distinguish requested model, returned model and an absent provider model", () => {
  const settings = snapshotModelSettings(DEFAULT_DEEPSEEK_MODEL_SETTINGS);
  const returned = replyModelMetadata(settings, { responseModel: "deepseek-flash-20260912", reasoningEffort: null });
  assert.deepEqual(returned, { requestedModel: "deepseek-flash", responseModel: "deepseek-flash-20260912", thinking: "disabled", reasoningEffort: null });
  assert.match(messageModelLabel(returned), /请求：deepseek-flash · 返回：deepseek-flash-20260912/);
  const absent = replyModelMetadata(settings);
  assert.equal(absent.responseModel, null);
  assert.match(messageModelLabel(absent), /返回型号未提供/);
  assert.equal(messageModelLabel(null), "", "old messages are not relabelled from current settings");
});

function fixture() {
  const now = () => new Date("2026-09-12T08:00:00.000Z");
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now });
  const workspace = normalizeWorkspace(createBlankWorkspace({ id: "ai-model-metadata", name: "模型元数据", currentPeriod: "2026-09" }, { now }), { now });
  repository.save({ ...createInitialState({ now }), workspaces: [workspace], activeWorkspaceId: workspace.id,
    activeUserId: workspace.users.find((user) => user.status === "active")?.id || null });
  const fileVault = createMemoryFileVault();
  const makeService = () => createAiFinanceService({ store: createFinanceDeskStore({ repository }), fileVault, workspaceId: workspace.id, period: workspace.currentPeriod });
  return { service: makeService(), reload: makeService };
}

test("model metadata survives ledger reload without storing keys, reasoning text or later preferences", () => {
  const f = fixture();
  f.service.appendMessage({ role: "assistant", content: "以前的回复" });
  const firstMetadata = { requestedModel: "deepseek-flash", responseModel: "deepseek-flash-20260912", thinking: "enabled", reasoningEffort: "max",
    apiKey: "sk-test-only-secret", reasoning_content: "private-reasoning-must-not-persist" };
  f.service.appendMessage({ role: "assistant", content: "第一条新回复", modelMetadata: firstMetadata, reasoning_content: "private-reasoning-must-not-persist" });
  firstMetadata.requestedModel = "deepseek-v4-pro";
  f.service.appendMessage({ role: "assistant", content: "第二条新回复", modelMetadata: { requestedModel: "deepseek-v4-pro", responseModel: null, thinking: "disabled", reasoningEffort: "high" } });
  const messages = f.reload().getConversation().messages;
  assert.equal(messages[0].modelMetadata, undefined);
  assert.deepEqual(messages[1].modelMetadata, { requestedModel: "deepseek-flash", responseModel: "deepseek-flash-20260912", thinking: "enabled", reasoningEffort: "max" });
  assert.deepEqual(messages[2].modelMetadata, { requestedModel: "deepseek-v4-pro", responseModel: null, thinking: "disabled", reasoningEffort: null });
  assert.doesNotMatch(JSON.stringify(messages), /sk-test-only-secret|private-reasoning-must-not-persist|reasoning_content/);
});

test("metadata accepts only safe model IDs and never annotates user messages", () => {
  const f = fixture();
  const metadata = { requestedModel: "deepseek-flash", responseModel: "sk-test-only-secret", thinking: "disabled", reasoningEffort: "high" };
  f.service.appendMessage({ role: "assistant", content: "提供方返回了无效型号", modelMetadata: metadata });
  f.service.appendMessage({ role: "assistant", content: "无效的请求型号", modelMetadata: { ...metadata, requestedModel: "sk-test-only-secret" } });
  f.service.appendMessage({ role: "user", content: "用户输入", modelMetadata: metadata });
  const messages = f.reload().getConversation().messages;
  assert.equal(messages[0].modelMetadata.responseModel, null);
  assert.equal(messages[1].modelMetadata, undefined);
  assert.equal(messages[2].modelMetadata, undefined);
  assert.doesNotMatch(JSON.stringify(messages), /sk-test-only-secret/);
});
