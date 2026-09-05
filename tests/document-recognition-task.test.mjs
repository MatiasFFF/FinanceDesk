import test from "node:test";
import assert from "node:assert/strict";
import { createDocumentRecognitionTask } from "../src/features/intake/documentRecognitionTask.js";
import { createDocumentMetadata } from "../src/features/intake/documentIntake.js";
import { createMemoryFileVault } from "../src/features/intake/browserFileVault.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const result = () => ({ mode: "local", text: "本地识别正文", pages: [{ pageNumber: 1, text: "本地识别正文" }], suggestedFields: {} });

async function fixture() {
  const fileVault = createMemoryFileVault();
  const blob = Object.assign(new Blob(["original"]), { name: "资料.png" });
  const document = await createDocumentMetadata(blob, { id: "doc", category: "合同", structuredData: { partyA: "人工甲方" } });
  const workspace = (id) => ({ id, documents: [structuredClone(document)], exceptionTasks: [],
    users: [{ id: "user-a", name: "甲员工", roleId: "role", status: "active" }, { id: "user-b", name: "乙员工", roleId: "role", status: "active" }],
    roles: [{ id: "role", status: "active", permissions: ["documents.add"] }], personnelRecords: [],
  });
  let state = { activeWorkspaceId: "one", activeUserId: "user-a", workspaces: [workspace("one"), workspace("two")] };
  const listeners = new Set();
  const audits = [];
  const store = {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    change(change) { state = change(state); [...listeners].forEach((listener) => listener(state)); },
    actions: { replaceWorkspace(id, next) {
      audits.push({ workspaceId: id, userId: state.activeUserId });
      store.change((current) => ({ ...current, workspaces: current.workspaces.map((item) => item.id === id ? next : item) }));
    } },
  };
  await fileVault.put({ id: document.id, workspaceId: "one", hash: document.hash, blob });
  let calls = 0;
  const requests = [];
  const waiters = [];
  const runner = createDocumentRecognitionTask(store, { loadEngine: async () => ({
    async recognizeLocalDocument(input) {
      calls += 1;
      const gate = deferred();
      const request = { ...input, gate, cleanup: null };
      const abort = () => gate.reject(new DOMException("cancelled", "AbortError"));
      input.signal.addEventListener("abort", abort, { once: true });
      if (waiters.length) waiters.shift()(request); else requests.push(request);
      try { return await gate.promise; }
      finally { input.signal.removeEventListener("abort", abort); if (request.cleanup) await request.cleanup.promise; }
    },
  }) });
  return {
    store, fileVault, document, runner, audits,
    start: () => runner.start({ workspaceId: "one", document: store.getState().workspaces.find((item) => item.id === "one").documents[0], fileVault }),
    nextEngine: () => requests.length ? Promise.resolve(requests.shift()) : new Promise((resolve) => waiters.push(resolve)),
    get calls() { return calls; }, get listeners() { return listeners.size; },
  };
}

test("关闭面板再回来复用一个识别任务，重复点击不重读引擎，完成后保存原资料", async () => {
  const context = await fixture();
  const detach = context.runner.subscribe(() => {});
  const operation = context.start();
  const engine = await context.nextEngine();
  detach();
  assert.equal(engine.signal.aborted, false);
  assert.equal(context.start(), operation);
  engine.onProgress({ stage: "recognizing", progress: 0.5 });
  const returnedView = context.runner.subscribe(() => {});
  assert.equal(context.runner.getSnapshot().progress.progress, 0.5);
  engine.gate.resolve(result());
  await operation;
  returnedView();
  assert.equal(context.calls, 1);
  assert.equal(context.runner.getSnapshot().status, "completed");
  assert.equal(context.runner.getSnapshot().hasResult, false);
  assert.equal(context.listeners, 0);
  const saved = context.store.getState().workspaces[0].documents[0];
  assert.ok(saved.contentRecognition.resultId);
  assert.equal(saved.structuredData.partyA, "人工甲方");
  assert.equal((await context.fileVault.get(saved.id)).recognition.result.text, "本地识别正文");
});

test("切到另一工作台只保留已计算结果，回原工作台再保存且不重新识别", async () => {
  const context = await fixture();
  const operation = context.start();
  const engine = await context.nextEngine();
  context.store.change((state) => ({ ...state, activeWorkspaceId: "two" }));
  engine.gate.resolve(result());
  await operation;
  assert.equal(engine.signal.aborted, false);
  assert.equal(context.runner.getSnapshot().status, "ready");
  assert.equal(context.runner.getSnapshot().hasResult, true);
  assert.equal(context.audits.length, 0);
  await context.runner.resume();
  assert.equal(context.audits.length, 0);
  context.store.change((state) => ({ ...state, activeWorkspaceId: "one" }));
  await context.runner.resume();
  assert.equal(context.calls, 1);
  assert.deepEqual(context.audits, [{ workspaceId: "one", userId: "user-a" }]);
  assert.equal(context.store.getState().workspaces[1].documents[0].contentRecognition.resultId, undefined);
});

test("显式取消等待旧任务清理后才允许重新启动，不保存取消结果", async () => {
  const context = await fixture();
  context.start();
  const engine = await context.nextEngine();
  engine.cleanup = deferred();
  const cancelled = context.runner.cancel({ workspaceId: "one", documentId: "doc" });
  assert.equal(engine.signal.aborted, true);
  assert.equal(context.runner.getSnapshot().status, "cancelling");
  assert.throws(() => context.runner.start({ workspaceId: "two", document: context.document, fileVault: context.fileVault }), /已有一份/);
  engine.cleanup.resolve();
  await cancelled;
  assert.equal(context.audits.length, 0);
  assert.equal(context.listeners, 0);
  const restarted = context.start();
  const nextEngine = await context.nextEngine();
  nextEngine.gate.resolve(result());
  await restarted;
  assert.equal(context.calls, 2);
  assert.equal(context.runner.getSnapshot().status, "completed");
});

test("识别中身份或权限变更后保留结果，只有明确保存才能按当前授权身份记审计", async (t) => {
  for (const change of ["identity", "permission"]) await t.test(change, async () => {
    const context = await fixture();
    const operation = context.start();
    const engine = await context.nextEngine();
    context.store.change((state) => change === "identity"
      ? { ...state, activeUserId: "user-b" }
      : { ...state, workspaces: state.workspaces.map((item) => item.id === "one" ? { ...item, roles: [{ ...item.roles[0], permissions: [] }] } : item) });
    engine.gate.resolve(result());
    await operation;
    await context.runner.resume();
    assert.equal(context.runner.getSnapshot().status, "ready");
    assert.equal(context.audits.length, 0);
    if (change === "permission") {
      await context.runner.resume({ explicit: true });
      assert.equal(context.audits.length, 0);
      assert.equal(context.runner.getSnapshot().hasResult, true);
      context.store.change((state) => ({ ...state, workspaces: state.workspaces.map((item) => item.id === "one" ? { ...item, roles: [{ ...item.roles[0], permissions: ["documents.add"] }] } : item) }));
    }
    await context.runner.resume({ explicit: true });
    assert.equal(context.calls, 1);
    assert.equal(context.runner.getSnapshot().status, "completed");
    assert.equal(context.audits[0].userId, change === "identity" ? "user-b" : "user-a");
  });
});

test("原工作台删除或原件版本变化会释放未保存正文和状态订阅", async (t) => {
  for (const change of ["workspace", "version"]) await t.test(change, async () => {
    const context = await fixture();
    const operation = context.start();
    const engine = await context.nextEngine();
    context.store.change((state) => ({ ...state, activeWorkspaceId: "two" }));
    engine.gate.resolve(result());
    await operation;
    assert.equal(context.runner.getSnapshot().hasResult, true);
    const released = deferred();
    const detach = context.runner.subscribe(() => { if (context.runner.getSnapshot().status === "failed") released.resolve(); });
    context.store.change((state) => ({ ...state, workspaces: change === "workspace"
      ? state.workspaces.filter((item) => item.id !== "one")
      : state.workspaces.map((item) => item.id === "one" ? { ...item, documents: [{ ...item.documents[0], version: 2 }] } : item) }));
    await released.promise;
    detach();
    assert.equal(context.runner.getSnapshot().hasResult, false);
    assert.equal(context.listeners, 0);
    assert.equal(context.audits.length, 0);
  });
});

test("写入识别正文期间换身份会回退正文，明确保存后只记录新身份的保存动作", async () => {
  const context = await fixture();
  const originalSet = context.fileVault.setRecognition;
  let switchOnce = true;
  context.fileVault.setRecognition = async (...args) => {
    await originalSet(...args);
    if (switchOnce && args[4]?.signal) {
      switchOnce = false;
      context.store.change((state) => ({ ...state, activeUserId: "user-b" }));
    }
  };
  const operation = context.start();
  const engine = await context.nextEngine();
  engine.gate.resolve(result());
  await operation;
  assert.equal(context.runner.getSnapshot().hasResult, true);
  assert.equal(context.audits.length, 0);
  assert.equal((await context.fileVault.get("doc")).recognition, undefined);
  await context.runner.resume({ explicit: true });
  assert.deepEqual(context.audits, [{ workspaceId: "one", userId: "user-b" }]);
  assert.equal(context.calls, 1);
});
