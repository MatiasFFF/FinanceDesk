import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { createInitialState } from "../src/domain/foundation.js";
import { createFinanceDeskStore } from "../src/store/financeDeskStore.js";
import { createLocalFoundationRepository, createMemoryStorage } from "../src/storage/localFoundationRepository.js";
import { createMemoryFileVault } from "../src/features/intake/browserFileVault.js";
import { createDocumentMetadata } from "../src/features/intake/documentIntake.js";
import { generateWorkspaceBackup, restoreWorkspaceBackup } from "../src/features/workspaces/workspaceBackup.js";
import { workflowSourceFingerprint } from "../src/productWorkflow.js";

const now = () => new Date("2026-09-05T04:00:00.000Z");

async function fixture(contents = ["合同原件甲", "合同原件乙"]) {
  const state = createInitialState({ now });
  const workspace = state.workspaces[0];
  const vault = createMemoryFileVault();
  workspace.documents = [];
  for (const [index, content] of contents.entries()) {
    const file = Object.assign(new Blob([content], { type: "text/plain" }), { name: "同名合同.txt" });
    const document = await createDocumentMetadata(file, { id: `backup-doc-${index}`, period: "2026-08" });
    workspace.documents.push(document);
    await vault.put({ id: document.id, workspaceId: workspace.id, hash: document.hash, name: document.name, blob: file });
  }
  const repository = createLocalFoundationRepository({ storage: createMemoryStorage(), now });
  repository.save(state);
  const store = createFinanceDeskStore({ repository });
  return { store, vault, repository, workspaceId: workspace.id };
}

async function bundle(source) {
  const result = await generateWorkspaceBackup({ store: source.store, fileVault: source.vault, now });
  return { ...result, file: new Blob([result.bytes]) };
}

test("完整备份可在空文件库恢复数据、同名不同内容的原件及资料关联", async () => {
  const source = await fixture();
  const backup = await bundle(source);
  assert.equal(backup.manifest.complete, true);
  assert.equal(new Set(backup.manifest.files.map((item) => item.path)).size, 2);
  const target = await fixture([]);
  const result = await restoreWorkspaceBackup({ store: target.store, fileVault: target.vault, file: backup.file, mode: "replace", now });
  assert.deepEqual([result.restored, result.missing], [2, 0]);
  const documents = target.store.getActiveWorkspace().documents;
  for (const [index, document] of documents.entries()) {
    assert.equal(document.storage.availableLocally, true);
    const record = await target.vault.getOwned(document.storage.blobId, target.workspaceId, document.hash);
    assert.equal(await record.blob.text(), index ? "合同原件乙" : "合同原件甲");
  }
  const reloaded = createFinanceDeskStore({ repository: target.repository });
  assert.equal(reloaded.getActiveWorkspace().documents[0].storage.availableLocally, true);
  assert.equal(reloaded.getActiveWorkspace().auditLog[0].action, "导入含原件备份");
  assert.equal(workflowSourceFingerprint(reloaded.getActiveWorkspace()), workflowSourceFingerprint(source.store.getActiveWorkspace()));
});

test("合并导入相同工作台 ID 时隔离原件，不覆盖本机同 ID 资料", async () => {
  const source = await fixture(["来自备份"]);
  const target = await fixture(["本机原件"]);
  const backup = await bundle(source);
  await restoreWorkspaceBackup({ store: target.store, fileVault: target.vault, file: backup.file, mode: "merge", now });
  const [existing, added] = target.store.getState().workspaces;
  assert.notEqual(existing.id, added.id);
  const oldFile = await target.vault.get(existing.documents[0].storage.blobId);
  const newFile = await target.vault.get(added.documents[0].storage.blobId);
  assert.equal(await oldFile.blob.text(), "本机原件");
  assert.equal(await newFile.blob.text(), "来自备份");
  assert.equal(newFile.workspaceId, added.id);
  assert.notEqual(newFile.id, oldFile.id);
});

test("原件损坏会在修改本地数据前拒绝导入", async () => {
  const source = await fixture();
  const backup = await bundle(source);
  const zip = await JSZip.loadAsync(backup.bytes);
  zip.file(backup.manifest.files[0].path, "被替换的文件");
  const target = await fixture(["现有资料"]);
  const before = target.store.getState();
  await assert.rejects(restoreWorkspaceBackup({ store: target.store, fileVault: target.vault, file: new Blob([await zip.generateAsync({ type: "uint8array" })]), mode: "replace", now }), /校验失败/);
  assert.equal(target.store.getState(), before);
  assert.equal(await (await target.vault.get("backup-doc-0")).blob.text(), "现有资料");
});

test("缺少原件的备份明确不完整，恢复后不伪装文件可用", async () => {
  const source = await fixture();
  await source.vault.delete("backup-doc-1");
  const backup = await bundle(source);
  assert.equal(backup.manifest.complete, false);
  assert.match(backup.fileName, /不完整/);
  assert.equal(backup.manifest.missingFiles.length, 1);
  const target = await fixture([]);
  const result = await restoreWorkspaceBackup({ store: target.store, fileVault: target.vault, file: backup.file, mode: "replace", now });
  assert.equal(result.missing, 1);
  assert.equal(target.store.getActiveWorkspace().documents[1].storage.availableLocally, false);
});

test("完整清单遗漏资料时拒绝导入", async () => {
  const backup = await bundle(await fixture());
  const zip = await JSZip.loadAsync(backup.bytes);
  zip.file("manifest.json", JSON.stringify({ ...backup.manifest, files: [] }));
  const target = await fixture([]);
  await assert.rejects(restoreWorkspaceBackup({ store: target.store, fileVault: target.vault, file: new Blob([await zip.generateAsync({ type: "uint8array" })]), mode: "replace", now }), /标为完整/);
  assert.equal((await target.vault.listByWorkspace(target.workspaceId)).length, 0);
});

test("文件保存中途失败时保留旧数据并清理本次临时文件", async () => {
  const backup = await bundle(await fixture());
  const target = await fixture(["现有资料"]);
  const before = target.store.getState();
  let writes = 0;
  const failingVault = { ...target.vault, async put(record) { if (++writes === 2) throw new Error("文件空间不足"); return target.vault.put(record); } };
  await assert.rejects(restoreWorkspaceBackup({ store: target.store, fileVault: failingVault, file: backup.file, mode: "replace", now }), /空间不足/);
  assert.equal(target.store.getState(), before);
  assert.deepEqual((await target.vault.listByWorkspace(target.workspaceId)).map((record) => record.id), ["backup-doc-0"]);
});

test("数据保存失败时不删除旧原件", async () => {
  const backup = await bundle(await fixture());
  const target = await fixture(["现有资料"]);
  const before = target.store.getState();
  target.store.actions.importBackup = () => { throw new Error("本地数据空间不足"); };
  await assert.rejects(restoreWorkspaceBackup({ store: target.store, fileVault: target.vault, file: backup.file, mode: "replace", now }), /空间不足/);
  assert.equal(target.store.getState(), before);
  assert.equal((await target.vault.listByWorkspace(target.workspaceId)).length, 1);
  assert.equal(await (await target.vault.get("backup-doc-0")).blob.text(), "现有资料");
});

test("恢复期间产生的新操作不会被旧备份静默覆盖", async () => {
  const backup = await bundle(await fixture());
  const target = await fixture([]);
  let changed = false;
  const changingVault = { ...target.vault, async put(record) {
    await target.vault.put(record);
    if (!changed) {
      changed = true;
      target.store.actions.renameWorkspace(target.workspaceId, "刚刚修改的名称");
    }
  } };
  await assert.rejects(restoreWorkspaceBackup({ store: target.store, fileVault: changingVault, file: backup.file, mode: "replace", now }), /数据发生变化/);
  assert.equal(target.store.getActiveWorkspace().name, "刚刚修改的名称");
  assert.equal((await target.vault.listByWorkspace(target.workspaceId)).length, 0);
});

test("数据已保存但界面通知失败时保留已恢复原件", async () => {
  const backup = await bundle(await fixture());
  const target = await fixture([]);
  target.store.subscribe(() => { throw new Error("界面更新中断"); });
  await assert.rejects(restoreWorkspaceBackup({ store: target.store, fileVault: target.vault, file: backup.file, mode: "replace", now }), /数据已恢复/);
  for (const document of target.store.getActiveWorkspace().documents) {
    assert.ok(await target.vault.get(document.storage.blobId));
  }
});
