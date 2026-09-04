import { createId } from "../../domain/foundation.js";
import { attachEvidenceDocument, reviewTransactionEvidence } from "../evidence/evidenceEngine.js";

function fallbackHash(buffer) {
  const bytes = new Uint8Array(buffer);
  let hash = 2166136261;
  bytes.forEach((byte) => {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  });
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export async function hashLocalFile(file) {
  const buffer = await file.arrayBuffer();
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return fallbackHash(buffer);
}

export async function createDocumentMetadata(file, options = {}) {
  if (!file || typeof file.arrayBuffer !== "function") throw new Error("请选择有效的本地文件");
  const timestamp = options.createdAt || new Date().toISOString();
  const id = options.id || createId("document");
  return {
    id,
    name: options.name || file.name || "未命名资料",
    category: options.category || "其他资料",
    mimeType: file.type || options.mimeType || "application/octet-stream",
    size: Number(file.size || 0),
    lastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
    period: options.period || null,
    source: "local-file",
    sourceActor: options.actor || "本地用户",
    lifecycleStatus: options.lifecycleStatus || "已获取",
    archiveStatus: options.archiveStatus || "active",
    version: options.version || 1,
    hash: await hashLocalFile(file),
    relatedObjectIds: [...new Set(options.relatedObjectIds || [])],
    storage: {
      mode: "indexeddb",
      blobId: id,
      externalUpload: false,
      availableLocally: true,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function saveLocalDocument(input) {
  const { store, fileVault, workspaceId, file } = input;
  if (!store?.actions || !fileVault) throw new Error("资料录入需要工作台 store 和本地文件保险箱");
  const metadata = await createDocumentMetadata(file, input.metadata || {});
  await fileVault.put({
    id: metadata.id,
    workspaceId,
    name: metadata.name,
    mimeType: metadata.mimeType,
    size: metadata.size,
    hash: metadata.hash,
    blob: file,
    createdAt: metadata.createdAt,
  });
  try {
    store.actions.upsertEntity(workspaceId, "documents", metadata, {
      actor: input.metadata?.actor,
      label: "本地资料",
      detail: `${metadata.name}（${metadata.category}，仅保存在当前浏览器）`,
    });
    if (metadata.relatedObjectIds.length) {
      store.actions.linkEvidence(workspaceId, {
        documentIds: [metadata.id],
        objectIds: metadata.relatedObjectIds,
        relation: input.relation || "supports",
        note: input.note || "",
      }, { actor: input.metadata?.actor });
      const current = store.getState().workspaces.find((workspace) => workspace.id === workspaceId);
      const transactionIds = metadata.relatedObjectIds.filter((objectId) => current?.transactions?.some((transaction) => transaction.id === objectId));
      if (transactionIds.length) {
        const next = transactionIds.reduce((workspace, transactionId) => attachEvidenceDocument(
          workspace,
          { transactionId, documentId: metadata.id },
          { actor: input.metadata?.actor || "本地用户", mode: "manual" },
        ), current);
        store.actions.replaceWorkspace(workspaceId, next);
      }
    }
    return metadata;
  } catch (error) {
    await fileVault.delete(metadata.id);
    throw error;
  }
}

export async function removeLocalDocument(input) {
  const { store, fileVault, workspaceId, documentId } = input;
  const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
  const document = workspace?.documents?.find((item) => item.id === documentId);
  if (!document) throw new Error("找不到要删除的本地资料");
  const lockedVoucher = (workspace.vouchers || []).find((voucher) => (
    ["posted", "superseded"].includes(voucher.status) && voucher.evidenceIds?.includes(documentId)
  ));
  const archivedReceipt = (workspace.delivery?.archives || []).find((archive) => archive.receipt?.documentId === documentId);
  if (document.archiveStatus === "archived" || lockedVoucher || archivedReceipt) {
    throw new Error("该资料已进入已入账凭证或期间归档，不能直接删除；请通过更正或新版本处理");
  }
  const blobId = document?.storage?.blobId || (document?.storage?.mode === "indexeddb" ? null : documentId);
  const affectedTransactionIds = (workspace.transactions || [])
    .filter((transaction) => [...(transaction.evidenceIds || []), ...(transaction.documentIds || [])].includes(documentId))
    .map((transaction) => transaction.id);
  let next = {
    ...workspace,
    documents: workspace.documents.filter((item) => item.id !== documentId),
    evidenceLinks: (workspace.evidenceLinks || []).filter((link) => !link.documentIds?.includes(documentId)),
    transactions: (workspace.transactions || []).map((transaction) => ({
      ...transaction,
      evidenceIds: (transaction.evidenceIds || []).filter((id) => id !== documentId),
      documentIds: (transaction.documentIds || []).filter((id) => id !== documentId),
    })),
    vouchers: (workspace.vouchers || []).map((voucher) => ["draft", "changes_requested"].includes(voucher.status)
      ? { ...voucher, evidenceIds: (voucher.evidenceIds || []).filter((id) => id !== documentId) }
      : voucher),
  };
  affectedTransactionIds.forEach((transactionId) => {
    next = reviewTransactionEvidence(next, transactionId, { actor: input.actor || "本地用户", mode: "manual" });
  });
  store.actions.replaceWorkspace(workspaceId, next, {
    audit: {
      actor: input.actor || "本地用户",
      action: "删除本地资料",
      detail: `${document.name}；已同步重算 ${affectedTransactionIds.length} 笔流水的证据状态`,
    },
  });
  if (blobId) await fileVault.delete(blobId);
}

export async function copyWorkspaceLocalFiles({ store, fileVault, sourceWorkspaceId, targetWorkspaceId }) {
  const state = store.getState();
  const source = state.workspaces.find((workspace) => workspace.id === sourceWorkspaceId);
  const target = state.workspaces.find((workspace) => workspace.id === targetWorkspaceId);
  if (!source || !target) throw new Error("找不到要复制的来源或目标工作台");

  const copiedBlobIds = [];
  try {
    const documents = [];
    for (const document of target.documents || []) {
      const sourceDocument = source.documents?.find((candidate) => candidate.id === document.id);
      const sourceBlobId = sourceDocument?.storage?.blobId;
      const sourceRecord = fileVault && sourceBlobId ? await fileVault.get(sourceBlobId) : null;
      if (!sourceRecord?.blob || sourceRecord.workspaceId !== sourceWorkspaceId) {
        documents.push({
          ...document,
          storage: document.storage ? { ...document.storage, availableLocally: false } : document.storage,
        });
        continue;
      }
      const blobId = createId("blob");
      await fileVault.put({ ...sourceRecord, id: blobId, workspaceId: targetWorkspaceId, createdAt: new Date().toISOString() });
      copiedBlobIds.push(blobId);
      documents.push({
        ...document,
        storage: { ...document.storage, blobId, availableLocally: true },
      });
    }
    store.actions.replaceWorkspace(targetWorkspaceId, { ...target, documents }, {
      audit: {
        actor: "本地用户",
        action: "复制工作台本地文件",
        detail: `从「${source.name}」复制 ${copiedBlobIds.length} 份原文件`,
      },
    });
    return { copied: copiedBlobIds.length, total: documents.length };
  } catch (error) {
    if (fileVault) {
      for (const blobId of copiedBlobIds) await fileVault.delete(blobId);
    }
    throw error;
  }
}

export async function refreshLocalFileAvailability({ store, fileVault }) {
  if (!fileVault) return { available: 0, missing: 0 };
  let available = 0;
  let missing = 0;
  const workspaceIds = store.getState().workspaces.map((workspace) => workspace.id);
  for (const workspaceId of workspaceIds) {
    const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
    const documents = [];
    for (const document of workspace.documents || []) {
      const blobId = document.storage?.blobId || document.storage?.backupBlobId;
      const record = blobId ? await fileVault.get(blobId) : null;
      const isAvailable = Boolean(record?.blob && record.workspaceId === workspaceId);
      if (isAvailable) available += 1;
      else if (document.storage?.mode === "indexeddb") missing += 1;
      documents.push({
        ...document,
        storage: document.storage?.mode === "indexeddb"
          ? { ...document.storage, blobId: isAvailable ? blobId : null, availableLocally: isAvailable }
          : document.storage,
      });
    }
    store.actions.replaceWorkspace(workspaceId, { ...workspace, documents });
  }
  return { available, missing };
}

export function downloadStoredDocument(record) {
  if (!record?.blob) throw new Error("本地文件内容不可用");
  const url = URL.createObjectURL(record.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = record.name || "本地资料";
  anchor.click();
  URL.revokeObjectURL(url);
}
