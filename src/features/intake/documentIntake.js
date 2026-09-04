import { createId } from "../../domain/foundation.js";

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
  const linkedEvidence = (workspace?.evidenceLinks || []).filter((link) => link.documentIds?.includes(documentId));
  linkedEvidence.forEach((link) => store.actions.removeEntity(workspaceId, "evidenceLinks", link.id, {
    actor: input.actor,
    label: "证据关联",
  }));
  store.actions.removeEntity(workspaceId, "documents", documentId, {
    actor: input.actor,
    label: "本地资料",
  });
  await fileVault.delete(documentId);
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
