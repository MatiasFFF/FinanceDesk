import { createId } from "../../domain/foundation.js";
import { attachEvidenceDocument, reviewTransactionEvidence } from "../evidence/evidenceEngine.js";

const LINKABLE_COLLECTIONS = [
  "bankAccounts",
  "transactions",
  "businessEvents",
  "bills",
  "contracts",
  "invoices",
  "approvals",
  "personnelRecords",
];

function linkableObjectIds(workspace) {
  return new Set(LINKABLE_COLLECTIONS.flatMap((collection) => (workspace?.[collection] || []).map((item) => item.id)));
}

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
    deliveryArtifact: Boolean(options.deliveryArtifact),
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
  const current = store.getState().workspaces.find((workspace) => workspace.id === workspaceId);
  if (!current) throw new Error("找不到资料所属工作台");
  const actor = input.metadata?.actor
    || current.users?.find((user) => user.id === store.getState().activeUserId && user.status === "active")?.name
    || "本地用户";
  const metadata = await createDocumentMetadata(file, { ...(input.metadata || {}), actor });
  const allowedIds = linkableObjectIds(current);
  const invalidIds = metadata.relatedObjectIds.filter((objectId) => !allowedIds.has(objectId));
  if (invalidIds.length) throw new Error(`关联对象不属于当前工作台：${invalidIds.join("、")}`);
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
    let next = {
      ...current,
      documents: [...(current.documents || []), metadata],
      evidenceLinks: [...(current.evidenceLinks || [])],
    };
    if (metadata.relatedObjectIds.length) {
      next.evidenceLinks.push({
        id: createId("evidence-link"),
        documentIds: [metadata.id],
        objectIds: metadata.relatedObjectIds,
        relation: input.relation || "supports",
        note: input.note || "",
        status: "active",
        createdAt: metadata.createdAt,
        updatedAt: metadata.createdAt,
      });
      const transactionIds = metadata.relatedObjectIds.filter((objectId) => current.transactions?.some((transaction) => transaction.id === objectId));
      if (transactionIds.length) {
        next = transactionIds.reduce((workspace, transactionId) => attachEvidenceDocument(
          workspace,
          { transactionId, documentId: metadata.id },
          { actor, mode: "manual" },
        ), next);
      }
    }
    store.actions.replaceWorkspace(workspaceId, next, {
      requiredPermission: "documents.add",
      audit: {
        actor,
        action: "添加本地资料",
        detail: `${metadata.name}（${metadata.category}，仅保存在当前浏览器）`,
      },
    });
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
  const actor = input.actor
    || workspace.users?.find((user) => user.id === store.getState().activeUserId && user.status === "active")?.name
    || "本地用户";
  const lockedVoucher = (workspace.vouchers || []).find((voucher) => (
    ["posted", "superseded"].includes(voucher.status) && voucher.evidenceIds?.includes(documentId)
  ));
  const archivedReceipt = (workspace.delivery?.archives || []).find((archive) => archive.receipt?.documentId === documentId);
  const currentReceipt = workspace.delivery?.filing?.receipt?.documentId === documentId;
  const bankSource = (workspace.bankImports || []).find((bankImport) => bankImport.sourceDocumentId === documentId);
  const archivedDocument = (workspace.delivery?.archives || []).find((archive) => (archive.documents || []).some((item) => item.id === documentId));
  if (document.archiveStatus === "archived" || lockedVoucher || archivedReceipt || currentReceipt || bankSource || archivedDocument) {
    throw new Error("该资料已进入已入账凭证或期间归档，不能直接删除；请通过更正或新版本处理");
  }
  const blobId = document?.storage?.blobId || (document?.storage?.mode === "indexeddb" ? null : documentId);
  const ownedRecord = blobId
    ? await (fileVault.getOwned?.(blobId, workspaceId, document.hash) || fileVault.get(blobId).then((record) => record?.workspaceId === workspaceId ? record : null))
    : null;
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
    next = reviewTransactionEvidence(next, transactionId, { actor, mode: "manual" });
  });
  if (ownedRecord) await fileVault.delete(blobId);
  try {
    store.actions.replaceWorkspace(workspaceId, next, {
      requiredPermission: "documents.add",
      audit: {
        actor,
        action: "删除本地资料",
        detail: `${document.name}；已同步重算 ${affectedTransactionIds.length} 笔流水的证据状态`,
      },
    });
  } catch (error) {
    if (ownedRecord) await fileVault.put(ownedRecord);
    throw error;
  }
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
      const sourceRecord = fileVault && sourceBlobId
        ? await (fileVault.getOwned?.(sourceBlobId, sourceWorkspaceId, sourceDocument?.hash) || fileVault.get(sourceBlobId))
        : null;
      if (!sourceRecord?.blob || sourceRecord.workspaceId !== sourceWorkspaceId || (sourceDocument?.hash && sourceRecord.hash && sourceRecord.hash !== sourceDocument.hash)) {
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
      requiredPermission: "documents.add",
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
  if (!fileVault) return { available: 0, missing: 0, repaired: 0 };
  let available = 0;
  let missing = 0;
  let repaired = 0;
  const initialState = store.getState();
  const workspaceIds = initialState.workspaces.map((workspace) => workspace.id);
  for (const workspaceId of workspaceIds) {
    const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
    const documents = [];
    for (const document of workspace.documents || []) {
      const blobId = document.storage?.blobId || document.storage?.backupBlobId;
      let record = blobId ? await fileVault.get(blobId) : null;
      let resolvedBlobId = blobId;
      let isAvailable = Boolean(record?.blob && record.workspaceId === workspaceId && (!document.hash || !record.hash || record.hash === document.hash));
      if (!isAvailable && record?.blob && record.workspaceId !== workspaceId && (!document.hash || !record.hash || record.hash === document.hash)) {
        const legitimateSource = initialState.workspaces.find((candidate) => candidate.id === record.workspaceId
          && (candidate.documents || []).some((sourceDocument) => sourceDocument.id === document.id
            && sourceDocument.storage?.blobId === blobId
            && (!document.hash || !sourceDocument.hash || sourceDocument.hash === document.hash)));
        if (legitimateSource) {
          resolvedBlobId = createId("blob");
          await fileVault.put({ ...record, id: resolvedBlobId, workspaceId, createdAt: new Date().toISOString() });
          record = await fileVault.get(resolvedBlobId);
          isAvailable = true;
          repaired += 1;
        }
      }
      if (isAvailable) available += 1;
      else if (document.storage?.mode === "indexeddb") missing += 1;
      documents.push({
        ...document,
        storage: document.storage?.mode === "indexeddb"
          ? { ...document.storage, blobId: isAvailable ? resolvedBlobId : null, availableLocally: isAvailable }
          : document.storage,
      });
    }
    store.actions.replaceWorkspace(workspaceId, { ...workspace, documents }, {
      allowArchivedTransition: true,
      requiredPermission: "data.read",
    });
  }
  return { available, missing, repaired };
}

export async function pruneUnreferencedLocalFiles({ store, fileVault }) {
  if (!fileVault) return { removed: 0 };
  let removed = 0;
  for (const workspace of store.getState().workspaces) {
    const referenced = new Set((workspace.documents || []).flatMap((document) => [
      document.storage?.blobId,
      document.storage?.backupBlobId,
    ].filter(Boolean)));
    const records = await fileVault.listByWorkspace(workspace.id);
    for (const record of records) {
      if (!referenced.has(record.id)) {
        await fileVault.delete(record.id);
        removed += 1;
      }
    }
  }
  return { removed };
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
