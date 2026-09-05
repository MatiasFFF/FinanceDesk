import {
  CURRENT_SCHEMA_VERSION,
  FINANCE_DESK_BACKUP_KEY,
  FINANCE_DESK_STORAGE_KEY,
  LEGACY_STORAGE_KEYS,
  assertValidState,
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

  function save(state) {
    const valid = assertValidState(migrateState(state, migrationOptions()));
    const previous = storage.getItem(key);
    if (previous) {
      try {
        parseStoredState(previous, migrationOptions());
        storage.setItem(backupKey, previous);
      } catch {
        // A corrupt primary copy is never promoted to the last-good backup.
      }
    }
    storage.setItem(key, serializeState(valid, clock().toISOString()));
    return deepClone(valid);
  }

  function load() {
    const primary = storage.getItem(key);
    if (primary) {
      try {
        const state = parseStoredState(primary, migrationOptions());
        return { state, source: "primary", recovered: false, errors: [] };
      } catch (error) {
        const backup = storage.getItem(backupKey);
        if (backup) {
          try {
            const state = parseStoredState(backup, migrationOptions());
            storage.setItem(key, serializeState(state, clock().toISOString()));
            return { state, source: "backup", recovered: true, errors: [error.message] };
          } catch (backupError) {
            const state = createInitialState(migrationOptions());
            storage.setItem(key, serializeState(state, clock().toISOString()));
            return { state, source: "seed", recovered: true, errors: [error.message, backupError.message] };
          }
        }
        const state = createInitialState(migrationOptions());
        storage.setItem(key, serializeState(state, clock().toISOString()));
        return { state, source: "seed", recovered: true, errors: [error.message] };
      }
    }

    for (const legacyKey of LEGACY_STORAGE_KEYS) {
      const legacy = storage.getItem(legacyKey);
      if (!legacy) continue;
      try {
        const parsed = JSON.parse(legacy);
        const state = assertValidState(migrateState(parsed, migrationOptions()));
        storage.setItem(key, serializeState(state, clock().toISOString()));
        return { state, source: `legacy:${legacyKey}`, recovered: false, errors: [] };
      } catch {
        // Continue to the next known legacy key before falling back to seed data.
      }
    }

    const state = createInitialState(migrationOptions());
    storage.setItem(key, serializeState(state, clock().toISOString()));
    return { state, source: "seed", recovered: false, errors: [] };
  }

  function clearPrimary() {
    storage.removeItem(key);
  }

  function clearAllLocalCopies() {
    storage.removeItem(key);
    storage.removeItem(backupKey);
    LEGACY_STORAGE_KEYS.forEach((legacyKey) => storage.removeItem(legacyKey));
  }

  return { key, backupKey, load, save, clearPrimary, clearAllLocalCopies };
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
