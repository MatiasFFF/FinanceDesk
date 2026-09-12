import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DEEPSEEK_MODEL_SETTINGS, normalizeDeepSeekModelSettings } from "../src/application/deepseekModels.js";
import { hasModelSettingsChanges } from "../src/features/ai-simple/aiModelSettings.js";
import { canCloseCompletedReview, hasProposalReviewChanges, moveRevisedProposalNote } from "../src/features/ai-simple/aiProposalInteractions.js";
import { conversationSendBlocker } from "../src/features/ai-simple/aiAttachments.js";
import { createAiTabSession } from "../src/features/ai-simple/aiModeSession.js";

const savedSettings = { ...DEFAULT_DEEPSEEK_MODEL_SETTINGS };
const writable = { archived: false, persistenceStatus: { canWrite: true }, accessError: "", canAddDocuments: true };

test("settings need leave protection only while a key or model edit is unsaved", () => {
  assert.equal(hasModelSettingsChanges("", { ...savedSettings }, savedSettings), false);
  assert.equal(hasModelSettingsChanges("   ", { ...savedSettings }, savedSettings), false);
  assert.equal(hasModelSettingsChanges("test_unsaved_key", savedSettings, savedSettings), true);
  for (const edit of [{ model: "deepseek-v4-pro" }, { thinking: "enabled" }, { reasoningEffort: "max" }]) {
    assert.equal(hasModelSettingsChanges("", { ...savedSettings, ...edit }, savedSettings), true);
  }
  const selection = { ...savedSettings, thinking: "enabled" };
  selection.thinking = savedSettings.thinking;
  assert.equal(hasModelSettingsChanges("", selection, savedSettings), false, "reverting a change removes the leave prompt");
});

test("saving preferences consumes only those edits and does not require replacing an existing key", () => {
  const session = createAiTabSession({ defaultModelSettings: savedSettings, normalizeModelSettings: normalizeDeepSeekModelSettings });
  session.setApiKey("test_existing_tab_key");
  const selection = { ...savedSettings, model: "deepseek-v4-pro", thinking: "enabled" };
  assert.equal(hasModelSettingsChanges("", selection, session.getSnapshot().modelSettings), true);
  session.setModelSettings(selection);
  assert.equal(hasModelSettingsChanges("", selection, session.getSnapshot().modelSettings), false);
  assert.equal(session.readKey(), "test_existing_tab_key");
  assert.doesNotMatch(JSON.stringify(session.getSnapshot()), /test_existing_tab_key/);
});

test("clearing the saved key does not discard an unsaved model selection", () => {
  const session = createAiTabSession({ defaultModelSettings: savedSettings, normalizeModelSettings: normalizeDeepSeekModelSettings });
  session.setApiKey("test_existing_tab_key");
  const selection = { ...savedSettings, thinking: "enabled" };
  session.clearApiKey();
  assert.equal(hasModelSettingsChanges("", selection, session.getSnapshot().modelSettings), true);
  assert.equal(selection.thinking, "enabled");
  assert.equal(session.getSnapshot().configured, false);
});

test("saving an account never consumes another proposal note or editor draft", () => {
  const draft = { accountName: "基本账户", accountNumber: "1234", notes: { first: "请核对这张票据" }, editorDirty: false };
  const before = structuredClone(draft);
  assert.equal(canCloseCompletedReview([], draft, { account: true }), false);
  assert.deepEqual(draft, before, "checking whether to close must preserve all typed values");
  assert.equal(canCloseCompletedReview([], { ...draft, notes: {}, editorDirty: true }, { account: true }), false);
  assert.equal(canCloseCompletedReview([{ id: "first", status: "pending" }], { ...draft, notes: {} }, { account: true }), false);
  assert.equal(canCloseCompletedReview([], { ...draft, notes: {} }, { account: true }), true, "only the saved account fields may be ignored");
});

test("confirming the final proposal closes only if no other unsaved fields remain", () => {
  const proposals = [{ id: "first", status: "applied" }];
  const draft = { accountName: "", accountNumber: "", notes: { first: "本次确认的说明" }, editorDirty: false };
  assert.equal(canCloseCompletedReview(proposals, draft, { proposalId: "first" }), true);
  assert.equal(canCloseCompletedReview(proposals, { ...draft, accountName: "尚未保存的账户" }, { proposalId: "first" }), false);
  assert.equal(canCloseCompletedReview(proposals, { ...draft, accountNumber: "1234" }, { proposalId: "first" }), false);
  assert.equal(canCloseCompletedReview(proposals, { ...draft, notes: { ...draft.notes, second: "另一个事项的说明" } }, { proposalId: "first" }), false);
  assert.equal(canCloseCompletedReview([...proposals, { id: "second", status: "pending" }], draft, { proposalId: "first" }), false);
  assert.equal(hasProposalReviewChanges(draft), true, "ordinary close still protects the note before it has been submitted");
});

test("automatic send and manual send share the same archive, storage and identity boundaries", () => {
  assert.equal(conversationSendBlocker(writable), "");
  assert.match(conversationSendBlocker({ ...writable, archived: true }), /已归档/);
  assert.equal(conversationSendBlocker({ ...writable, persistenceStatus: { canWrite: false, message: "当前窗口已落后" } }), "当前窗口已落后");
  assert.match(conversationSendBlocker({ ...writable, persistenceStatus: { canWrite: false } }), /无法保存/);
  assert.equal(conversationSendBlocker({ ...writable, accessError: "请选择有效操作身份" }), "请选择有效操作身份");
  assert.match(conversationSendBlocker({ ...writable, canAddDocuments: false }), /没有添加资料权限/);
  assert.equal(conversationSendBlocker({ ...writable, apiKey: "" }), "", "key setup is reached only after local write access is established");
});

test("a revised proposal keeps its typed note visible under the new ID without an invisible dirty entry", () => {
  const original = { previous: "这笔金额已核对", other: "另一条建议的说明" };
  const moved = moveRevisedProposalNote(original, "previous", "revised");
  assert.deepEqual(moved, { revised: "这笔金额已核对", other: "另一条建议的说明" });
  assert.equal(original.previous, "这笔金额已核对", "the previous state object is not mutated");
  const revisedAgain = moveRevisedProposalNote(moved, "revised", "latest");
  assert.equal(revisedAgain.revised, undefined);
  assert.equal(revisedAgain.latest, "这笔金额已核对");
  assert.equal(canCloseCompletedReview([{ id: "latest", status: "applied" }], { notes: revisedAgain }, { proposalId: "latest" }), false, "another note still protects the dialog");
  assert.equal(canCloseCompletedReview([{ id: "latest", status: "applied" }], { notes: { ...revisedAgain, other: "" } }, { proposalId: "latest" }), true, "there is no hidden note under a superseded ID after confirmation");
});

test("note migration preserves an existing destination note and handles unchanged or absent source IDs", () => {
  const notes = { previous: "原建议说明", revised: "新建议已有说明", other: "保留" };
  assert.deepEqual(moveRevisedProposalNote(notes, "previous", "revised"), { revised: "新建议已有说明\n原建议说明", other: "保留" });
  assert.equal(moveRevisedProposalNote(notes, "previous", "previous"), notes);
  assert.equal(moveRevisedProposalNote(notes, "absent", "revised"), notes);
  assert.deepEqual(moveRevisedProposalNote({ previous: "", revised: "已有说明" }, "previous", "revised"), { revised: "已有说明" });
});
