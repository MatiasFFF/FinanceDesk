import {
  CURRENT_SCHEMA_VERSION,
  FINANCE_DESK_BACKUP_KEY,
  FINANCE_DESK_STORAGE_KEY,
  LEGACY_STORAGE_KEYS,
  assertValidState,
  createId,
  createInitialState,
  deepClone,
  migrateState,
} from "../domain/foundation.js";

export const BACKUP_FORMAT = "financedesk-browser-backup";
export const BACKUP_FORMAT_VERSION = 1;

function checksum(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function markImportedFilesUnverified(state) {
  return {
    ...state,
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      documents: (workspace.documents || []).map((document) => ({
        ...document,
        storage: document.storage?.mode === "indexeddb"
          ? {
            ...document.storage,
            backupBlobId: document.storage.blobId || document.storage.backupBlobId || null,
            blobId: null,
            availableLocally: false,
          }
          : document.storage,
      })),
    })),
  };
}

function applyRestoredFiles(state, files = []) {
  if (!files.length) return state;
  const remaining = new Map(files.map((file) => [`${file.workspaceId}\u0000${file.documentId}`, file]));
  if (remaining.size !== files.length) throw new Error("备份包含重复的原件关联");
  const next = {
    ...state,
    workspaces: state.workspaces.map((workspace) => ({
      ...workspace,
      documents: (workspace.documents || []).map((document) => {
        const key = `${workspace.id}\u0000${document.id}`;
        const file = remaining.get(key);
        if (!file) return document;
        if (!file.blobId || !file.hash || file.hash !== document.hash) throw new Error("恢复原件与资料索引不一致");
        remaining.delete(key);
        return { ...document, storage: { ...document.storage, mode: "indexeddb", blobId: file.blobId, backupBlobId: null, availableLocally: true } };
      }),
    })),
  };
  if (remaining.size) throw new Error("恢复原件找不到所属资料");
  return next;
}

function serializeState(state, writtenAt = new Date().toISOString()) {
  const payload = JSON.stringify(state);
  return JSON.stringify({
    envelopeVersion: 1,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    writtenAt,
    checksum: checksum(payload),
    payload: state,
  });
}

function parseStoredState(text, options = {}) {
  if (!text) throw new Error("本地数据为空");
  const parsed = JSON.parse(text);
  const rawState = parsed?.envelopeVersion === 1 ? parsed.payload : parsed;
  if (parsed?.envelopeVersion === 1) {
    const actual = checksum(JSON.stringify(rawState));
    if (actual !== parsed.checksum) throw new Error("本地数据校验失败");
  }
  return assertValidState(migrateState(rawState, options));
}

export function createMemoryStorage(initialEntries = {}) {
  const entries = new Map(Object.entries(initialEntries));
  return {
    getItem(key) { return entries.has(key) ? entries.get(key) : null; },
    setItem(key, value) { entries.set(key, String(value)); },
    removeItem(key) { entries.delete(key); },
    clear() { entries.clear(); },
    dump() { return Object.fromEntries(entries); },
  };
}

export function createLocalFoundationRepository(options = {}) {
  const storage = options.storage || globalThis.localStorage;
  if (!storage) throw new Error("当前环境不支持浏览器本地存储");
  const key = options.key || FINANCE_DESK_STORAGE_KEY;
  const backupKey = options.backupKey || FINANCE_DESK_BACKUP_KEY;
  const clock = options.now || (() => new Date());
  const migrationOptions = () => ({ now: clock });
  const browserStorage = typeof window !== "undefined" && storage === globalThis.localStorage;
  const requiresSession = browserStorage || Object.hasOwn(options, "lockManager");
  const lockManager = Object.hasOwn(options, "lockManager") ? options.lockManager : globalThis.navigator?.locks;
  const eventTarget = options.eventTarget || (browserStorage ? window : null);
  let baseline = storage.getItem(key);
  let pendingInitialState = null;
  let recoveryRequired = false;
  let session = null;
  const persistenceListeners = new Set();
  const messages = {
    waiting: "本页正在等待保存。若已在另一个 FinanceDesk 窗口编辑，请回到那个窗口继续；本页尚未保存的输入会保留。关闭其他窗口后，本页会重新确认是否可以保存。",
    stale: "其他 FinanceDesk 窗口已保存新内容，本页已暂停保存。尚未保存的输入仍保留在本页；请先复制这些输入，再到最新打开的工作台窗口继续。",
    unsupported: "当前环境暂时无法安全保存。本页输入会保留；请先复制未保存内容，再用支持本地保存的现代浏览器打开工作台。",
    closed: "本页保存已暂停，尚未保存的输入仍保留。请先保留输入，再重新打开工作台继续。",
    recovery_required: "本地账本无法读取，原始内容已保留，当前模板仅供查看，保存已暂停。请在备份入口选择有效备份并替换恢复；恢复前会另存无法读取的原文。",
  };
  let persistenceStatus = Object.freeze({ canWrite: !requiresSession, status: requiresSession ? "waiting" : "ready", message: requiresSession ? messages.waiting : "" });

  function setPersistenceStatus(status) {
    if (persistenceStatus.status === status) return;
    persistenceStatus = Object.freeze({ canWrite: status === "ready", status, message: messages[status] || "" });
    persistenceListeners.forEach((listener) => listener());
  }

  function staleError() {
    setPersistenceStatus("stale");
    session?.release?.();
    const error = new Error(messages.stale);
    error.code = "LOCAL_STATE_STALE";
    return error;
  }

  function assertUnchanged() {
    if (storage.getItem(key) !== baseline) throw staleError();
  }

  function assertCanWrite() {
    assertUnchanged();
    if (!persistenceStatus.canWrite) {
      const error = new Error(persistenceStatus.message);
      error.code = recoveryRequired ? "LOCAL_RECOVERY_REQUIRED" : "LOCAL_SAVE_PAUSED";
      throw error;
    }
  }

  function writeState(valid) {
    const previous = storage.getItem(key);
    if (previous) {
      try {
        parseStoredState(previous, migrationOptions());
        storage.setItem(backupKey, previous);
      } catch {
        // A corrupt primary copy is never promoted to the last-good backup.
      }
    }
    const serialized = serializeState(valid, clock().toISOString());
    storage.setItem(key, serialized);
    baseline = serialized;
    pendingInitialState = null;
  }

  // Keep a single browser writer for this repository. Waiting/stale pages retain
  // their React state; acquiring the lock never reloads an older page's snapshot.
  function startSession() {
    if (!requiresSession) return () => {};
    if (session) return () => {};
    if (!lockManager?.request) {
      setPersistenceStatus("unsupported");
      return () => {};
    }
    const current = { stopped: false, controller: new AbortController(), release: null };
    session = current;
    const onStorage = (event) => {
      if (event.storageArea && event.storageArea !== storage) return;
      if ((event.key === key || event.key === null) && storage.getItem(key) !== baseline) staleError();
    };
    eventTarget?.addEventListener("storage", onStorage);
    setPersistenceStatus("waiting");
    const request = Promise.resolve().then(() => lockManager.request(`financedesk:writer:${key}`, { mode: "exclusive", signal: current.controller.signal }, async () => {
      if (current.stopped) return;
      assertUnchanged();
      if (pendingInitialState) writeState(pendingInitialState);
      const held = new Promise((resolve) => { current.release = resolve; });
      setPersistenceStatus(recoveryRequired ? "recovery_required" : "ready");
      await held;
    }));
    request.catch((error) => {
      if (current.stopped || error?.name === "AbortError") return;
      if (error?.code !== "LOCAL_STATE_STALE") setPersistenceStatus("unsupported");
    });
    return () => {
      current.stopped = true;
      current.controller.abort();
      current.release?.();
      eventTarget?.removeEventListener("storage", onStorage);
      if (session === current) {
        session = null;
        setPersistenceStatus("closed");
      }
    };
  }

  function save(state) {
    assertCanWrite();
    const valid = assertValidState(migrateState(state, migrationOptions()));
    writeState(valid);
    return deepClone(valid);
  }

  function load() {
    const primary = storage.getItem(key);
    const backup = storage.getItem(backupKey);
    baseline = primary;
    pendingInitialState = null;
    recoveryRequired = false;
    function initialCopy(state) {
      if (requiresSession && !persistenceStatus.canWrite) pendingInitialState = state;
      else writeState(state);
    }
    const errors = [];
    if (primary != null) {
      try {
        const state = parseStoredState(primary, migrationOptions());
        return { state, source: "primary", recovered: false, errors: [] };
      } catch (error) {
        errors.push(error.message);
      }
    }
    if (backup != null) {
      try {
        const state = parseStoredState(backup, migrationOptions());
        initialCopy(state);
        return { state, source: "backup", recovered: true, errors };
      } catch (error) {
        errors.push(error.message);
      }
    }
    if (errors.length) {
      recoveryRequired = true;
      setPersistenceStatus("recovery_required");
      return { state: createInitialState(migrationOptions()), source: "unreadable", recovered: false, recoveryRequired: true, errors };
    }

    for (const legacyKey of LEGACY_STORAGE_KEYS) {
      const legacy = storage.getItem(legacyKey);
      if (!legacy) continue;
      try {
        const parsed = JSON.parse(legacy);
        const state = assertValidState(migrateState(parsed, migrationOptions()));
        initialCopy(state);
        return { state, source: `legacy:${legacyKey}`, recovered: false, errors: [] };
      } catch {
        // Continue to the next known legacy key before falling back to seed data.
      }
    }

    const state = createInitialState(migrationOptions());
    initialCopy(state);
    return { state, source: "seed", recovered: false, errors: [] };
  }

  function restore(state) {
    if (!recoveryRequired) return save(state);
    assertUnchanged();
    if (requiresSession && !session?.release) throw new Error(messages.waiting);
    const valid = assertValidState(migrateState(state, migrationOptions()));
    // This explicit restore is the only path that may replace unreadable data.
    // Save both original strings first; a failed rescue write leaves them intact.
    const recoveryKey = `${key}.unreadable.${createId("recovery")}`;
    const originals = JSON.stringify({ savedAt: clock().toISOString(), entries: {
      [key]: storage.getItem(key), [backupKey]: storage.getItem(backupKey),
    } });
    storage.setItem(recoveryKey, originals);
    if (storage.getItem(recoveryKey) !== originals) throw new Error("无法保存损坏原文，恢复已停止，原数据未替换");
    writeState(valid);
    recoveryRequired = false;
    setPersistenceStatus("ready");
    return deepClone(valid);
  }

  function clearPrimary() {
    assertCanWrite();
    storage.removeItem(key);
    baseline = null;
    pendingInitialState = null;
  }

  function clearAllLocalCopies() {
    assertCanWrite();
    storage.removeItem(key);
    baseline = null;
    pendingInitialState = null;
    storage.removeItem(backupKey);
    LEGACY_STORAGE_KEYS.forEach((legacyKey) => storage.removeItem(legacyKey));
  }

  return {
    key, backupKey, load, save, restore, clearPrimary, clearAllLocalCopies, startSession, assertCanWrite,
    getPersistenceStatus: () => persistenceStatus,
    subscribePersistence(listener) {
      persistenceListeners.add(listener);
      return () => persistenceListeners.delete(listener);
    },
  };
}

export function exportBackupJson(state, options = {}) {
  const exportedAt = (options.now ? options.now() : new Date()).toISOString();
  const valid = assertValidState(migrateState(state, { timestamp: exportedAt }));
  const payloadText = JSON.stringify(valid);
  return JSON.stringify({
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt,
    checksum: checksum(payloadText),
    state: valid,
  }, null, 2);
}

export function importBackupJson(text, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    throw new Error("备份文件不是有效的 JSON");
  }
  const rawState = parsed?.format === BACKUP_FORMAT ? parsed.state : parsed;
  if (parsed?.format === BACKUP_FORMAT) {
    if (parsed.formatVersion !== BACKUP_FORMAT_VERSION) throw new Error(`不支持的备份格式版本：${parsed.formatVersion}`);
    if (checksum(JSON.stringify(rawState)) !== parsed.checksum) throw new Error("备份文件校验失败，内容可能已损坏");
  }
  const imported = markImportedFilesUnverified(assertValidState(migrateState(rawState, options)));
  if ((options.mode || "replace") === "replace" || !options.currentState) return applyRestoredFiles(imported, options.restoredFiles);
  if (options.mode !== "merge") throw new Error(`不支持的导入模式：${options.mode}`);

  const current = assertValidState(migrateState(options.currentState, options));
  const ids = new Set(current.workspaces.map((workspace) => workspace.id));
  const additions = imported.workspaces.map((workspace) => {
    if (!ids.has(workspace.id)) {
      ids.add(workspace.id);
      return workspace;
    }
    let suffix = 2;
    let id = `${workspace.id}-import-${suffix}`;
    while (ids.has(id)) {
      suffix += 1;
      id = `${workspace.id}-import-${suffix}`;
    }
    ids.add(id);
    return { ...workspace, id, name: `${workspace.name}（导入）` };
  });
  return applyRestoredFiles(assertValidState({
    ...current,
    workspaces: [...current.workspaces, ...additions],
    updatedAt: options.timestamp || new Date().toISOString(),
  }), options.restoredFiles);
}
