import test from "node:test";
import assert from "node:assert/strict";
import { closeAiWorkspaceCreation, resumeAiHomeSubmission } from "../src/features/ai-simple/aiModeSession.js";

test("declining to discard a workspace creation keeps the form and its input", () => {
  const form = { open: true, name: "待建工作室", operator: "经办人" };
  const prompts = [];
  assert.equal(closeAiWorkspaceCreation({ dirty: true, confirm: (message) => { prompts.push(message); return false; }, onClose: () => { form.open = false; form.name = ""; form.operator = ""; } }), false);
  assert.equal(prompts.length, 1);
  assert.deepEqual(form, { open: true, name: "待建工作室", operator: "经办人" });
  assert.equal(closeAiWorkspaceCreation({ dirty: true, confirm: () => true, onClose: () => { form.open = false; } }), true);
  assert.equal(form.open, false);
});

test("an untouched workspace creation closes without a discard prompt", () => {
  let closes = 0;
  closeAiWorkspaceCreation({ dirty: false, confirm: () => { throw new Error("untouched form must not prompt"); }, onClose: () => { closes += 1; } });
  assert.equal(closes, 1);
});

function pendingSubmission() {
  const file = new Blob(["synthetic statement"], { type: "text/csv" });
  const draft = { text: "整理这份流水", files: [{ id: "file-1", file }] };
  const workspace = { id: "workspace-a", currentPeriod: "2026-09" };
  const pendingRef = { current: { workspaceId: workspace.id, period: workspace.currentPeriod, draft } };
  return { draft, workspace, pendingRef, file };
}

test("successful prerequisite setup resumes the original text and file exactly once", () => {
  const request = pendingSubmission();
  const submissions = [];
  const resume = () => resumeAiHomeSubmission({ ...request, configured: true, onSend: () => submissions.push(request.draft) });
  assert.equal(resume(), true);
  assert.equal(resume(), false);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].text, "整理这份流水");
  assert.equal(submissions[0].files.length, 1);
  assert.equal(submissions[0].files[0].file, request.file);
  assert.equal(request.pendingRef.current, null);
});

test("cancelled setup and an ordinary settings save never send a message", () => {
  let sends = 0;
  const cancelled = pendingSubmission();
  cancelled.pendingRef.current = null;
  assert.equal(resumeAiHomeSubmission({ ...cancelled, configured: true, onSend: () => { sends += 1; } }), false);
  const ordinary = { ...pendingSubmission(), pendingRef: { current: null } };
  assert.equal(resumeAiHomeSubmission({ ...ordinary, configured: true, onSend: () => { sends += 1; } }), false);
  assert.equal(sends, 0);
});

test("a saved model without credentials cannot resume a pending send", () => {
  const request = pendingSubmission();
  let sends = 0;
  assert.equal(resumeAiHomeSubmission({ ...request, configured: false, onSend: () => { sends += 1; } }), false);
  assert.equal(request.pendingRef.current, null);
  assert.equal(sends, 0);
});

test("switching the workspace, period, or submitted draft cancels stale continuation", () => {
  for (const change of [
    ({ workspace }) => ({ workspace: { ...workspace, id: "workspace-b" } }),
    ({ workspace }) => ({ workspace: { ...workspace, currentPeriod: "2026-10" } }),
    ({ draft }) => ({ draft: { ...draft, text: "另一条输入" } }),
    ({ draft }) => ({ draft: { ...draft, files: [] } }),
    () => ({ workspace: null }),
  ]) {
    const request = pendingSubmission();
    let sends = 0;
    assert.equal(resumeAiHomeSubmission({ ...request, ...change(request), configured: true, onSend: () => { sends += 1; } }), false);
    assert.equal(request.pendingRef.current, null);
    assert.equal(sends, 0);
    assert.equal(resumeAiHomeSubmission({ ...request, configured: true, onSend: () => { sends += 1; } }), false);
    assert.equal(sends, 0);
  }
});
