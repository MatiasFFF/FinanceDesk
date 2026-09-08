import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  FINANCE_DESK_STORAGE_KEY as key, FINANCE_DESK_BACKUP_KEY as backupKey,
  createInitialState, createFinanceDeskStore, createLocalFoundationRepository, createMemoryStorage,
  createMemoryFileVault, exportBackupJson, renameWorkspace,
} from "../src/foundation.js";
import { generateWorkspaceBackup, restoreWorkspaceBackup, restoreWorkspaceJsonBackup } from "../src/features/workspaces/workspaceBackup.js";

const now = () => new Date("2026-09-08T08:00:00.000Z");

test("first empty storage still persists a normal initial state", () => {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now });
  assert.equal(repository.load().source, "seed");
  assert.equal(repository.getPersistenceStatus().canWrite, true);
  assert.equal(repository.load().source, "primary");
  assert.ok(storage.getItem(key));
});

test("a valid backup restores a corrupt or missing primary without replacing the valid backup with a template", () => {
  for (const primary of ["{bad-primary", null, ""]) {
    const storage = createMemoryStorage();
    const repository = createLocalFoundationRepository({ storage, now });
    const initial = createInitialState({ now });
    repository.save(renameWorkspace(initial, initial.activeWorkspaceId, "有效备份里的公司", { now }));
    repository.save(initial);
    const originalBackup = storage.getItem(backupKey);
    if (primary == null) storage.removeItem(key); else storage.setItem(key, primary);
    const report = repository.load();
    assert.equal(report.source, "backup");
    assert.equal(report.state.workspaces[0].name, "有效备份里的公司");
    assert.equal(storage.getItem(backupKey), originalBackup);
    assert.equal(repository.load().source, "primary");
  }
});

test("unreadable copies retain their exact raw values and block seed writes, including after acquiring a session", async (t) => {
  for (const originals of [{ [key]: "{bad-primary", [backupKey]: "{bad-backup" }, { [key]: "{only-primary" }, { [backupKey]: "{only-backup" }]) {
    const storage = createMemoryStorage(originals);
    const repository = createLocalFoundationRepository({ storage, now, lockManager: { request: (_name, _options, callback) => callback() } });
    const store = createFinanceDeskStore({ repository });
    assert.equal(store.getLoadReport().recoveryRequired, true);
    assert.equal(store.getLoadReport().recovered, false);
    const stop = store.startPersistenceSession();
    t.after(stop);
    await nextTurn();
    assert.equal(store.getPersistenceStatus().status, "recovery_required");
    assert.equal(store.getPersistenceStatus().canWrite, false);
    assert.throws(() => repository.save(createInitialState({ now })), { code: "LOCAL_RECOVERY_REQUIRED" });
    assert.deepEqual(storage.dump(), originals);
    const replacement = createInitialState({ now });
    replacement.workspaces[0].company.legalName = "从有效备份恢复的公司";
    assert.throws(() => store.actions.importBackup(exportBackupJson(replacement), { mode: "merge" }), /不能合并/);
    store.actions.importBackup(exportBackupJson(replacement), { mode: "replace" });
    assert.equal(store.getPersistenceStatus().status, "ready");
    assert.equal(store.getActiveWorkspace().company.legalName, "从有效备份恢复的公司");
    const rescue = Object.entries(storage.dump()).find(([name]) => name.startsWith(`${key}.unreadable.`));
    assert.ok(rescue);
    const expectedEntries = { [key]: originals[key] ?? null, [backupKey]: originals[backupKey] ?? null };
    assert.deepEqual(JSON.parse(rescue[1]).entries, expectedEntries);
    assert.equal(repository.load().source, "primary");
  }
});

test("invalid backups and failed preservation writes leave damaged originals unchanged", () => {
  const originals = { [key]: "{bad-primary", [backupKey]: "{bad-backup" };
  const storage = createMemoryStorage(originals);
  const set = storage.setItem.bind(storage);
  storage.setItem = (name, value) => {
    if (name.startsWith(`${key}.unreadable.`)) throw new Error("存储空间不足");
    set(name, value);
  };
  const store = createFinanceDeskStore({ repository: createLocalFoundationRepository({ storage, now }) });
  assert.throws(() => store.actions.importBackup("{bad", { mode: "replace" }));
  assert.deepEqual(storage.dump(), originals);
  assert.throws(() => store.actions.importBackup(exportBackupJson(createInitialState({ now })), { mode: "replace" }), /空间不足/);
  assert.deepEqual(storage.dump(), originals);
  assert.equal(store.getPersistenceStatus().status, "recovery_required");
});

test("JSON and ZIP recovery preserve originals absent from the older backup, while healthy JSON replacement still prunes them", async () => {
  const valid = createInitialState({ now });
  valid.workspaces[0].documents = [];
  const sourceRepository = createLocalFoundationRepository({ storage: createMemoryStorage(), now });
  sourceRepository.save(valid);
  const sourceStore = createFinanceDeskStore({ repository: sourceRepository });
  const zipped = await generateWorkspaceBackup({ store: sourceStore, fileVault: createMemoryFileVault(), now });
  for (const format of ["json", "zip", "healthy-json"]) {
    const fileVault = createMemoryFileVault();
    const workspaceId = valid.activeWorkspaceId;
    const blob = new Blob(["较旧备份没有记录，但仍可能恢复的原件"]);
    await fileVault.put({ id: "newer-original", workspaceId, blob });
    const storage = createMemoryStorage(format === "healthy-json" ? {} : { [key]: "{bad-primary", [backupKey]: "{bad-backup" });
    const repository = createLocalFoundationRepository({ storage, now });
    if (format === "healthy-json") repository.save(valid);
    const store = createFinanceDeskStore({ repository });
    const result = format === "zip"
      ? await restoreWorkspaceBackup({ store, fileVault, file: new Blob([zipped.bytes]), mode: "replace", now })
      : await restoreWorkspaceJsonBackup({ store, fileVault, text: exportBackupJson(valid), mode: "replace" });
    assert.equal(result.preserveExistingFiles, format !== "healthy-json");
    const retained = await fileVault.get("newer-original");
    assert.equal(Boolean(retained), format !== "healthy-json");
    if (retained) assert.equal(await retained.blob.text(), await blob.text());
    assert.equal(store.getPersistenceStatus().canWrite, true);
  }
});
