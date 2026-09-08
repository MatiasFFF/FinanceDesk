import { createId } from "../../domain/foundation.js";
import { exportBackupJson, importBackupJson } from "../../storage/localFoundationRepository.js";
import { hashLocalFile, pruneUnreferencedLocalFiles, refreshLocalFileAvailability } from "../intake/documentIntake.js";

const FORMAT = "financedesk-full-backup";
const VERSION = 1;

async function fileHash(blob, expected) {
  if (!String(expected).startsWith("fnv1a-")) return hashLocalFile(blob);
  let hash = 2166136261;
  for (const byte of new Uint8Array(await blob.arrayBuffer())) {
    hash = Math.imul(hash ^ byte, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function safeName(name) {
  return String(name || "资料").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 160);
}

export async function generateWorkspaceBackup({ store, fileVault, now = () => new Date() }) {
  const data = store.actions.exportBackup({ now });
  const initialState = store.getState();
  const state = JSON.parse(data).state;
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const files = [];
  const missingFiles = [];
  for (const workspace of state.workspaces) {
    for (const document of workspace.documents || []) {
      try {
        const blobId = document.storage?.blobId || document.storage?.backupBlobId || document.id;
        const record = await fileVault?.get(blobId);
        if (!record?.blob || record.workspaceId !== workspace.id) throw new Error("当前设备缺少原件");
        if (!document.hash || (record.hash && record.hash !== document.hash)) throw new Error("原件校验信息与资料不一致");
        if (await fileHash(record.blob, document.hash) !== document.hash) throw new Error("原件内容已变化");
        const path = `originals/${files.length + 1}-${safeName(document.name)}`;
        const bytes = new Uint8Array(await record.blob.arrayBuffer());
        zip.file(path, bytes);
        files.push({ workspaceId: workspace.id, documentId: document.id, path, hash: document.hash, size: bytes.byteLength, name: document.name, mimeType: document.mimeType || record.blob.type || "application/octet-stream" });
      } catch (error) {
        missingFiles.push({ workspaceId: workspace.id, documentId: document.id, name: document.name, reason: error.message });
      }
    }
  }
  const manifest = { format: FORMAT, version: VERSION, exportedAt: now().toISOString(), complete: missingFiles.length === 0, files, missingFiles };
  zip.file("data.json", data);
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("阅读说明.txt", `FinanceDesk 本地备份\n在工作台管理中选择“导入备份”，即可恢复业务数据与包内原件。\n${missingFiles.length ? `本备份缺少 ${missingFiles.length} 份原件，具体资料见 manifest.json 的 missingFiles。` : "原件已逐份核验并包含在 originals 目录。"}\n请妥善保管此文件，其中包含财务资料。\n`);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  if (store.getState() !== initialState) throw new Error("备份期间数据发生变化，请在当前操作完成后重新导出");
  return { bytes, manifest, fileName: `财务工作台${manifest.complete ? "完整" : "不完整"}备份-${manifest.exportedAt.slice(0, 10)}.zip` };
}

export async function restoreWorkspaceBackup({ store, fileVault, file, mode = "merge", actor = "本地用户", now = () => new Date() }) {
  if (!fileVault) throw new Error("当前浏览器无法保存备份原件");
  if (!["merge", "replace"].includes(mode)) throw new Error("请选择有效的导入方式");
  const initialState = store.getState();
  const preserveExistingFiles = store.getPersistenceStatus().status === "recovery_required";
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer(), { checkCRC32: true });
  const manifestFile = zip.file("manifest.json");
  const dataFile = zip.file("data.json");
  if (!manifestFile || !dataFile) throw new Error("这不是 FinanceDesk 完整备份文件");
  const manifest = JSON.parse(await manifestFile.async("string"));
  if (manifest.format !== FORMAT || manifest.version !== VERSION || !Array.isArray(manifest.files)) throw new Error("不支持的完整备份格式");
  const imported = importBackupJson(await dataFile.async("string"), { mode: "replace", now });
  const timestamp = now().toISOString();
  const actorLog = { id: createId("audit"), at: timestamp, actor, action: "导入含原件备份", detail: `${mode === "merge" ? "合并" : "替换"}导入业务数据与原件` };
  for (const workspace of imported.workspaces) workspace.auditLog = [{ ...actorLog, id: createId("audit") }, ...(workspace.auditLog || [])];
  const data = exportBackupJson(imported, { now });
  const preview = importBackupJson(data, { mode, currentState: initialState, now, timestamp });
  const targets = mode === "merge" ? preview.workspaces.slice(initialState.workspaces.length) : preview.workspaces;
  const workspaceMap = new Map(imported.workspaces.map((workspace, index) => [workspace.id, targets[index]]));
  const seen = new Set();
  const paths = new Set();
  const prepared = [];
  for (const item of manifest.files) {
    const target = workspaceMap.get(item.workspaceId);
    const document = target?.documents?.find((candidate) => candidate.id === item.documentId);
    const key = `${item.workspaceId}\u0000${item.documentId}`;
    if (!document || seen.has(key) || paths.has(item.path) || !item.path?.startsWith("originals/") || !item.hash || item.hash !== document.hash) throw new Error("备份原件清单与资料索引不一致");
    seen.add(key);
    paths.add(item.path);
    const source = zip.file(item.path);
    if (!source) throw new Error(`备份缺少原件：${document.name}`);
    const bytes = await source.async("uint8array");
    const blob = new Blob([bytes], { type: item.mimeType || "application/octet-stream" });
    if (bytes.byteLength !== item.size || await fileHash(blob, item.hash) !== item.hash) throw new Error(`备份原件校验失败：${document.name}`);
    prepared.push({ id: createId("restored-file"), workspaceId: target.id, documentId: document.id, name: document.name, hash: item.hash, blob, createdAt: timestamp });
  }
  const missing = targets.reduce((total, workspace) => total + (workspace.documents || []).length, 0) - prepared.length;
  if (manifest.complete && missing) throw new Error("备份标为完整，但有资料没有对应原件");
  const previousFiles = mode === "replace" && !preserveExistingFiles
    ? (await Promise.all(initialState.workspaces.map((workspace) => fileVault.listByWorkspace(workspace.id)))).flat()
    : [];
  const staged = [];
  try {
    for (const record of prepared) {
      staged.push(record.id);
      await fileVault.put(record);
    }
    if (store.getState() !== initialState) throw new Error("恢复期间数据发生变化，尚未替换现有数据，请重新导入");
    store.actions.importBackup(data, { mode, timestamp, now, restoredFiles: prepared.map((record) => ({ workspaceId: record.workspaceId, documentId: record.documentId, blobId: record.id, hash: record.hash })) });
  } catch (error) {
    const referenced = new Set(store.getState().workspaces.flatMap((workspace) => (workspace.documents || []).flatMap((document) => [document.storage?.blobId, document.storage?.backupBlobId]).filter(Boolean)));
    const cleanup = await Promise.allSettled(staged.filter((id) => !referenced.has(id)).map((id) => fileVault.delete(id)));
    if (staged.some((id) => referenced.has(id))) error.message += "；数据已恢复，但界面更新失败，请重新打开工作台";
    if (cleanup.some((item) => item.status === "rejected")) error.message += "；未关联的临时原件未能全部清理";
    throw error;
  }
  let retainedOldFiles = 0;
  for (const record of previousFiles) {
    try { await fileVault.delete(record.id); } catch { retainedOldFiles += 1; }
  }
  return { restored: prepared.length, missing, workspaces: targets.length, retainedOldFiles, preserveExistingFiles };
}

export async function restoreWorkspaceJsonBackup({ store, fileVault, text, mode = "merge", actor = "本地用户" }) {
  const preserveExistingFiles = store.getPersistenceStatus().status === "recovery_required";
  const previousWorkspaceIds = new Set(store.getState().workspaces.map((workspace) => workspace.id));
  store.actions.importBackup(text, { mode });
  if (mode === "replace" && fileVault && !preserveExistingFiles) {
    const nextIds = new Set(store.getState().workspaces.map((workspace) => workspace.id));
    for (const workspaceId of previousWorkspaceIds) if (!nextIds.has(workspaceId)) await fileVault.clearWorkspace(workspaceId);
  }
  const availability = await refreshLocalFileAvailability({ store, fileVault });
  const cleanup = preserveExistingFiles ? { removed: 0 } : await pruneUnreferencedLocalFiles({ store, fileVault });
  const current = store.getActiveWorkspace();
  store.actions.replaceWorkspace(current.id, current, {
    allowArchivedTransition: true, requiredPermission: "workspace.manage",
    audit: { actor, action: "导入工作台备份",
      detail: `${mode === "merge" ? "合并" : "替换"}导入；${availability.available} 份原文件仍可用，${availability.repaired} 份旧副本已隔离，${availability.missing} 份需重新关联，${preserveExistingFiles ? "无法读取的旧账本原件全部保留" : `清理 ${cleanup.removed} 份孤立文件`}`,
    },
  });
  return { ...availability, cleanup, preserveExistingFiles };
}
