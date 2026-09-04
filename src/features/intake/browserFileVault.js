export const FILE_VAULT_DATABASE = "financedesk-local-files";
export const FILE_VAULT_STORE = "files";

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本地文件操作失败"));
  });
}

export function createBrowserFileVault(options = {}) {
  const indexedDB = options.indexedDB || globalThis.indexedDB;
  if (!indexedDB) throw new Error("当前浏览器不支持 IndexedDB 本地文件存储");
  const databaseName = options.databaseName || FILE_VAULT_DATABASE;

  async function open() {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(FILE_VAULT_STORE)) {
        const store = database.createObjectStore(FILE_VAULT_STORE, { keyPath: "id" });
        store.createIndex("workspaceId", "workspaceId", { unique: false });
      }
    };
    return requestResult(request);
  }

  async function transaction(mode, callback) {
    const database = await open();
    try {
      const tx = database.transaction(FILE_VAULT_STORE, mode);
      const completed = new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error("本地文件事务失败"));
        tx.onabort = () => reject(tx.error || new Error("本地文件事务已取消"));
      });
      const result = await callback(tx.objectStore(FILE_VAULT_STORE));
      await completed;
      return result;
    } finally {
      database.close();
    }
  }

  return {
    async put(record) {
      if (!record?.id || !record?.workspaceId || !record?.blob) throw new Error("本地文件记录缺少 id、workspaceId 或 blob");
      await transaction("readwrite", (store) => requestResult(store.put(record)));
      return record.id;
    },
    async get(id) {
      return transaction("readonly", (store) => requestResult(store.get(id)));
    },
    async delete(id) {
      await transaction("readwrite", (store) => requestResult(store.delete(id)));
    },
    async listByWorkspace(workspaceId) {
      return transaction("readonly", (store) => requestResult(store.index("workspaceId").getAll(workspaceId)));
    },
    async clearWorkspace(workspaceId) {
      const records = await this.listByWorkspace(workspaceId);
      await transaction("readwrite", (store) => {
        records.forEach((record) => store.delete(record.id));
      });
      return records.length;
    },
  };
}

export function createMemoryFileVault() {
  const records = new Map();
  return {
    async put(record) { records.set(record.id, record); return record.id; },
    async get(id) { return records.get(id); },
    async delete(id) { records.delete(id); },
    async listByWorkspace(workspaceId) { return [...records.values()].filter((record) => record.workspaceId === workspaceId); },
    async clearWorkspace(workspaceId) {
      const ids = [...records.values()].filter((record) => record.workspaceId === workspaceId).map((record) => record.id);
      ids.forEach((id) => records.delete(id));
      return ids.length;
    },
  };
}
