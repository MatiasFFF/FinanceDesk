import { getStoredDocumentRecord, saveLocalDocumentRecognition } from "./documentIntake.js";
import { activeWorkspaceUser, workspaceUserPermissions } from "../../domain/foundation.js";

// One foreground-requested task survives its panel. No queue or idle worker is retained.
const tasks = new WeakMap();
const pendingStatuses = new Set(["preparing", "running", "ready", "saving", "cancelling"]);
export const isRecognitionTaskPending = (task) => pendingStatuses.has(task?.status);

export function getDocumentRecognitionTask(store) {
  if (!tasks.has(store)) tasks.set(store, createDocumentRecognitionTask(store));
  return tasks.get(store);
}

export function createDocumentRecognitionTask(store, {
  loadEngine = () => import("./localDocumentRecognition.js"),
  readOriginal = getStoredDocumentRecord,
  saveResult = saveLocalDocumentRecognition,
} = {}) {
  let job = null;
  let snapshot = null;
  const listeners = new Set();
  const authority = (workspaceId, actorId = store.getState().activeUserId) => {
    const state = { ...store.getState(), activeUserId: actorId };
    const user = activeWorkspaceUser(state, workspaceId);
    return JSON.stringify({ actorId, name: user?.name, roleId: user?.roleId, status: user?.status,
      permissions: workspaceUserPermissions(state, workspaceId).sort() });
  };
  const publish = (current, patch) => {
    if (job !== current) return;
    snapshot = { ...snapshot, ...patch };
    if (!isRecognitionTaskPending(snapshot)) { current.unsubscribe?.(); current.unsubscribe = null; }
    listeners.forEach((listener) => listener());
  };
  const sourceCurrent = (current) => {
    const workspace = store.getState().workspaces.find((item) => item.id === current.workspaceId);
    const document = workspace?.documents?.find((item) => item.id === current.documentId);
    return document && document.hash === current.sourceHash && document.version === current.sourceVersion && document.category === current.category
      && document.archiveStatus !== "archived" && !["archived", "已归档"].includes(document.lifecycleStatus);
  };
  const assertCurrent = (current) => {
    current.controller.signal.throwIfAborted();
    if (job !== current || !sourceCurrent(current)) throw new Error("资料或原件已变化，识别结果未保存。");
  };
  const save = (current, explicit = false) => {
    if (!current?.result || current.controller.signal.aborted) return Promise.resolve();
    if (current.saving) return current.saving;
    if (store.getState().activeWorkspaceId !== current.workspaceId) return Promise.resolve();
    if (explicit) {
      current.actorId = store.getState().activeUserId;
      current.authority = authority(current.workspaceId);
      current.authorizationChanged = false;
    } else if (current.authorizationChanged || authority(current.workspaceId) !== current.authority) {
      publish(current, { status: "ready", notice: "操作身份或权限已变化，识别结果已保留，请确认后保存。" });
      return Promise.resolve();
    }
    current.saving = (async () => {
      try {
        assertCurrent(current);
        publish(current, { status: "saving", progress: null, notice: "正在保存识别结果。" });
        await saveResult({ store, fileVault: current.fileVault, workspaceId: current.workspaceId,
          documentId: current.documentId, sourceHash: current.sourceHash, category: current.category,
          result: current.result, signal: current.controller.signal,
          isCurrent: () => job === current && !current.controller.signal.aborted && Boolean(sourceCurrent(current))
            && !current.authorizationChanged && authority(current.workspaceId) === current.authority,
        });
        current.result = null;
        publish(current, { status: "completed", hasResult: false, notice: "识别结果已保存，候选仍需人工确认。" });
      } catch (error) {
        if (current.controller.signal.aborted) return;
        if (!sourceCurrent(current)) {
          current.result = null;
          publish(current, { status: "failed", hasResult: false, progress: null, notice: "资料或原件已变化，识别结果未保存。" });
        } else {
          publish(current, { status: "ready", hasResult: true, progress: null,
            notice: current.authorizationChanged || authority(current.workspaceId) !== current.authority
              ? "操作身份或权限已变化，识别结果已保留，请确认后保存。"
              : store.getState().activeWorkspaceId !== current.workspaceId
              ? "识别已完成，返回原工作台后保存。"
              : `${error.message || "识别结果暂未保存"}；可重试保存，无需重新识别。`,
          });
        }
      } finally {
        current.saving = null;
      }
    })();
    return current.saving;
  };
  const stop = async (current, invalidated = false) => {
    current.controller.abort();
    current.result = null;
    publish(current, { status: "cancelling", hasResult: false, progress: null,
      notice: invalidated ? "资料或原件已变化，正在释放过期识别结果。" : "正在取消识别…" });
    await Promise.allSettled([current.operation, current.saving]);
    publish(current, { status: invalidated ? "failed" : "cancelled",
      notice: invalidated ? "资料或原件已变化，过期识别结果已释放。" : "已取消，原件和已有字段已保留。" });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    resume: (options = {}) => save(job, options.explicit),
    start({ workspaceId, document, fileVault }) {
      if (isRecognitionTaskPending(snapshot)) {
        if (job.workspaceId === workspaceId && job.documentId === document.id && job.sourceHash === document.hash && job.category === document.category) return job.operation;
        throw new Error("已有一份资料正在识别或等待保存，请完成或取消后再试。");
      }
      const current = { workspaceId, documentId: document.id, sourceHash: document.hash, sourceVersion: document.version, category: document.category,
        actorId: store.getState().activeUserId, authority: authority(workspaceId), authorizationChanged: false,
        fileVault, controller: new AbortController(), result: null, saving: null };
      job = current;
      snapshot = { workspaceId, documentId: document.id, sourceHash: document.hash, category: document.category,
        status: "preparing", progress: { stage: "preparing", progress: 0 }, hasResult: false, notice: "" };
      current.operation = (async () => {
        try {
          assertCurrent(current);
          const record = await readOriginal({ fileVault, workspaceId, document });
          assertCurrent(current);
          const { recognizeLocalDocument } = await loadEngine();
          assertCurrent(current);
          publish(current, { status: "running" });
          const result = await recognizeLocalDocument({ blob: record.blob, name: document.name, mimeType: document.mimeType,
            category: document.category, signal: current.controller.signal,
            onProgress: (progress) => publish(current, { progress }),
          });
          assertCurrent(current);
          current.result = result;
          publish(current, { status: "ready", hasResult: true, progress: null, notice: "识别已完成，返回原工作台后保存。" });
          await save(current);
        } catch (error) {
          current.result = null;
          if (!current.controller.signal.aborted) publish(current, { status: "failed", hasResult: false, progress: null,
            notice: error.message || "本地识别失败，请保留原件并人工填写。" });
        }
      })();
      current.unsubscribe = store.subscribe(() => {
        if (current.controller.signal.aborted) return;
        if (!sourceCurrent(current)) { void stop(current, true); return; }
        if (authority(current.workspaceId, current.actorId) !== current.authority
          || (store.getState().activeWorkspaceId === workspaceId && store.getState().activeUserId !== current.actorId)) {
          current.authorizationChanged = true;
        }
      });
      publish(current, {});
      return current.operation;
    },
    async cancel({ workspaceId, documentId }) {
      const current = job;
      if (!isRecognitionTaskPending(snapshot) || current.workspaceId !== workspaceId || current.documentId !== documentId) return;
      await stop(current);
    },
  };
}
