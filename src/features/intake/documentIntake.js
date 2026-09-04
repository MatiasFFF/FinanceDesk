import { createId } from "../../domain/foundation.js";
import { buildFinancialStatements, buildManagementMetrics, buildTaxWorkpaper } from "../../domain/accounting/reporting.js";
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

const LINKABLE_COLLECTION_LABELS = {
  bankAccounts: "银行账户",
  transactions: "银行流水",
  businessEvents: "业务事件",
  bills: "往来账单",
  contracts: "合同",
  invoices: "发票",
  approvals: "审批单",
  personnelRecords: "人员资料",
};

const MIME_TYPES_BY_EXTENSION = {
  csv: "text/csv",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const INVOICE_STATUSES = {
  verificationStatus: ["unverified", "verified", "failed"],
  redLetterStatus: ["normal", "red_applied", "red_issued"],
  voidStatus: ["valid", "voided"],
  certificationStatus: ["not_required", "pending", "certified", "rejected"],
};

const APPROVAL_STATUSES = ["draft", "pending", "approved", "rejected", "withdrawn"];

const DOCUMENT_REQUIREMENTS_BY_EVENT = {
  customerReceipt: [{ id: "contract-or-invoice", label: "合同或发票", anyOf: ["contract", "invoice"] }],
  memberRecharge: [{ id: "contract", label: "合同", anyOf: ["contract"] }],
  memberConsumption: [{ id: "contract", label: "合同", anyOf: ["contract"] }],
  supplierSettlement: [
    { id: "invoice", label: "发票", anyOf: ["invoice"] },
    { id: "approval", label: "审批单", anyOf: ["approval"] },
  ],
  supplierPrepayment: [
    { id: "contract", label: "合同", anyOf: ["contract"] },
    { id: "approval", label: "审批单", anyOf: ["approval"] },
  ],
  purchaseExpense: [
    { id: "invoice", label: "发票", anyOf: ["invoice"] },
    { id: "approval", label: "审批单", anyOf: ["approval"] },
  ],
  payroll: [{ id: "approval", label: "审批单", anyOf: ["approval"] }],
  rentAndProperty: [
    { id: "contract", label: "合同", anyOf: ["contract"] },
    { id: "invoice", label: "发票", anyOf: ["invoice"] },
    { id: "approval", label: "审批单", anyOf: ["approval"] },
  ],
  loan: [
    { id: "contract", label: "合同", anyOf: ["contract"] },
    { id: "approval", label: "审批单", anyOf: ["approval"] },
  ],
  employeeAdvance: [{ id: "approval", label: "审批单", anyOf: ["approval"] }],
  relatedParty: [{ id: "approval", label: "审批单", anyOf: ["approval"] }],
  refund: [{ id: "approval", label: "审批单", anyOf: ["approval"] }],
};

function linkableObjectIds(workspace) {
  return new Set(LINKABLE_COLLECTIONS.flatMap((collection) => (workspace?.[collection] || []).map((item) => item.id)));
}

function displayName(item) {
  return item?.name || item?.title || item?.no || item?.counterparty || item?.summary || item?.id || "未命名对象";
}

function linkableObject(workspace, objectId) {
  for (const collection of LINKABLE_COLLECTIONS) {
    const item = (workspace?.[collection] || []).find((candidate) => candidate.id === objectId);
    if (item) return { collection, item };
  }
  return null;
}

function includesDocument(item, documentId) {
  return [
    ...(item?.documentIds || []),
    ...(item?.evidenceIds || []),
  ].includes(documentId);
}

function normalizedText(value) {
  return String(value || "").trim().toLocaleLowerCase("zh-CN");
}

function matchDocumentKind(document) {
  if (["contract", "invoice", "approval"].includes(document?.structuredData?.kind)) return document.structuredData.kind;
  const exact = documentStructuredKind(document?.category);
  if (exact) return exact;
  const text = normalizedText(`${document?.category || ""} ${document?.name || ""}`);
  if (text.includes("合同") || text.includes("协议")) return "contract";
  if (text.includes("发票")) return "invoice";
  if (text.includes("审批") || text.includes("申请单")) return "approval";
  return null;
}

function targetEventType(target) {
  const explicit = target?.classification?.eventType || target?.type;
  if (explicit && explicit !== "unknown") return explicit;
  const text = normalizedText(`${target?.summary || ""} ${target?.counterparty || ""}`);
  if (/内部转账|账户划转/.test(text)) return "internalTransfer";
  if (/手续费|账户管理费/.test(text)) return "bankFee";
  if (/退款|退费/.test(text)) return "refund";
  if (/工资|薪资|社保/.test(text)) return "payroll";
  if (/房租|租金|物业/.test(text)) return "rentAndProperty";
  if (/借款|贷款|还款/.test(text)) return "loan";
  if (/充值|预收/.test(text)) return "memberRecharge";
  if (/采购|费用|付款|报销/.test(text) || Number(target?.amount || 0) < 0 || target?.direction === "out") return "purchaseExpense";
  if (Number(target?.amount || 0) > 0 || target?.direction === "in") return "customerReceipt";
  return "unknown";
}

function matchTargets(workspace) {
  return [
    ...(workspace?.transactions || []).map((target) => ({ sourceType: "bankTransaction", collection: "transactions", target })),
    ...(workspace?.businessEvents || []).map((target) => ({ sourceType: "businessEvent", collection: "businessEvents", target })),
  ];
}

function targetDisplayName(target) {
  return target?.summary || target?.title || target?.counterparty || target?.serial || target?.id || "未命名业务";
}

function targetPeriod(target) {
  return target?.businessPeriod || target?.period || String(target?.date || "").slice(0, 7) || null;
}

function linkedDocumentIdsForTarget(workspace, target) {
  const ids = new Set([...(target?.evidenceIds || []), ...(target?.documentIds || [])]);
  (workspace?.evidenceLinks || []).filter((link) => link.status !== "inactive" && link.objectIds?.includes(target.id))
    .forEach((link) => (link.documentIds || []).forEach((documentId) => ids.add(documentId)));
  (workspace?.documents || []).filter((document) => document.relatedObjectIds?.includes(target.id))
    .forEach((document) => ids.add(document.id));
  return ids;
}

export function documentRequirementsForTarget(target) {
  return DOCUMENT_REQUIREMENTS_BY_EVENT[targetEventType(target)] || [];
}

export function getDocumentMissingRequirements(workspace) {
  return matchTargets(workspace).flatMap(({ sourceType, target }) => {
    const linkedIds = linkedDocumentIdsForTarget(workspace, target);
    const linkedKinds = new Set((workspace.documents || [])
      .filter((document) => linkedIds.has(document.id))
      .map(matchDocumentKind)
      .filter(Boolean));
    return documentRequirementsForTarget(target).map((requirement) => ({
      identity: `document-requirement:${sourceType}:${target.id}:${requirement.id}`,
      sourceType,
      sourceId: target.id,
      sourceLabel: targetDisplayName(target),
      eventType: targetEventType(target),
      requirementId: requirement.id,
      label: requirement.label,
      anyOf: requirement.anyOf,
      satisfied: requirement.anyOf.some((kind) => linkedKinds.has(kind)),
      linkedDocumentIds: [...linkedIds],
    }));
  });
}

function matchScore(document, target, requirements) {
  const kind = matchDocumentKind(document);
  if (!kind) return null;
  const details = document.structuredData || {};
  const reasons = [];
  let score = 0;
  const acceptedRequirement = requirements.find((requirement) => requirement.anyOf.includes(kind));
  if (acceptedRequirement) {
    score += 15;
    reasons.push(`业务待补${acceptedRequirement.label}`);
  }
  const targetParty = normalizedText(target.counterparty || target.counterpartyName || target.party || "");
  const documentParties = [document.name, details.partyA, details.partyB, details.applicant]
    .map(normalizedText)
    .filter(Boolean);
  if (targetParty.length >= 2 && documentParties.some((value) => value.includes(targetParty) || targetParty.includes(value))) {
    score += 35;
    reasons.push(`对方“${target.counterparty || target.counterpartyName || target.party}”相符`);
  }
  const targetAmount = Math.abs(Number(target.amount || 0));
  const documentAmount = Number(details.amount);
  if (targetAmount > 0 && Number.isFinite(documentAmount) && documentAmount >= 0) {
    const difference = Math.abs(targetAmount - documentAmount);
    if (difference <= 0.01) {
      score += 35;
      reasons.push(`金额一致 ${targetAmount.toFixed(2)}`);
    } else if (difference <= Math.max(1, targetAmount * 0.02)) {
      score += 20;
      reasons.push(`金额接近，差额 ${difference.toFixed(2)}`);
    }
  }
  const date = String(target.date || "").slice(0, 10);
  const period = targetPeriod(target);
  if (kind === "contract" && date && details.serviceStartDate && details.serviceEndDate
    && date >= details.serviceStartDate && date <= details.serviceEndDate) {
    score += 20;
    reasons.push("业务日期位于合同服务期限内");
  } else if (kind === "invoice" && date && details.invoiceDate === date) {
    score += 20;
    reasons.push("发票日期与业务日期一致");
  } else if (period && (document.period === period || String(details.invoiceDate || "").slice(0, 7) === period)) {
    score += 15;
    reasons.push(`业务期间同为 ${period}`);
  }
  return score >= 30 ? { score: Math.min(100, score), reasons, kind } : null;
}

export function buildDocumentMatchSuggestions(workspace) {
  const suggestions = [];
  matchTargets(workspace).forEach(({ sourceType, target }) => {
    const linkedIds = linkedDocumentIdsForTarget(workspace, target);
    const requirements = documentRequirementsForTarget(target);
    const candidates = (workspace.documents || []).flatMap((document) => {
      if (linkedIds.has(document.id) || document.archiveStatus === "archived" || document.lifecycleStatus === "已归档") return [];
      const match = matchScore(document, target, requirements);
      if (!match) return [];
      return [{
        id: `document-match:${sourceType}:${target.id}:${document.id}`,
        sourceType,
        sourceId: target.id,
        sourceLabel: targetDisplayName(target),
        eventType: targetEventType(target),
        documentId: document.id,
        documentName: document.name,
        documentKind: match.kind,
        score: match.score,
        reasons: match.reasons,
      }];
    }).sort((left, right) => right.score - left.score || left.documentName.localeCompare(right.documentName, "zh-CN"));
    ["contract", "invoice", "approval"].forEach((kind) => {
      suggestions.push(...candidates.filter((candidate) => candidate.documentKind === kind).slice(0, 2));
    });
  });
  return suggestions.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function syncDocumentMissingTasks(workspace, context = {}) {
  const timestamp = context.at || new Date().toISOString();
  const actor = context.actor || "本地用户";
  const requirements = getDocumentMissingRequirements(workspace);
  const identities = new Set(requirements.map((item) => item.identity));
  const tasks = (workspace.exceptionTasks || []).map((task) => ({ ...task, history: [...(task.history || [])] }));
  let created = 0;
  let resolved = 0;
  let reopened = 0;
  let changed = false;
  requirements.forEach((requirement) => {
    const existing = tasks.find((task) => task.identity === requirement.identity);
    const message = `缺少${requirement.label}：${requirement.sourceLabel}`;
    if (requirement.satisfied) {
      if (existing && existing.status !== "resolved") {
        existing.status = "resolved";
        existing.resolution = "document_link_confirmed";
        existing.resolvedAt = timestamp;
        existing.resolvedBy = actor;
        existing.updatedAt = timestamp;
        existing.history.push({ at: timestamp, actor, action: "resolved", note: "资料已由用户确认关联" });
        resolved += 1;
        changed = true;
      }
      return;
    }
    if (!existing) {
      tasks.push({
        id: createId("document-task"),
        identity: requirement.identity,
        code: "missing_document",
        sourceType: requirement.sourceType,
        sourceId: requirement.sourceId,
        message,
        missingEvidence: [{ id: requirement.requirementId, label: requirement.label, anyOf: requirement.anyOf }],
        status: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
        sourceIds: [requirement.sourceId],
        history: [{ at: timestamp, actor, action: "created", note: message }],
      });
      created += 1;
      changed = true;
      return;
    }
    if (existing.status === "resolved") {
      existing.status = "open";
      existing.resolution = null;
      existing.resolvedAt = null;
      existing.resolvedBy = null;
      existing.updatedAt = timestamp;
      existing.history.push({ at: timestamp, actor, action: "reopened", note: "已确认的资料关联不再存在" });
      reopened += 1;
      changed = true;
    } else if (existing.status !== "open" || existing.message !== message) {
      const priorStatus = existing.status;
      existing.status = "open";
      existing.message = message;
      existing.updatedAt = timestamp;
      if (priorStatus !== "open") existing.history.push({ at: timestamp, actor, action: "kept_open", note: "对应类型资料仍未确认关联" });
      changed = true;
    }
  });
  tasks.filter((task) => task.code === "missing_document" && !identities.has(task.identity) && task.status !== "resolved")
    .forEach((task) => {
      task.status = "resolved";
      task.resolution = "requirement_no_longer_applies";
      task.resolvedAt = timestamp;
      task.resolvedBy = actor;
      task.updatedAt = timestamp;
      task.history.push({ at: timestamp, actor, action: "resolved", note: "该业务已不再需要此类资料" });
      resolved += 1;
      changed = true;
    });
  return {
    workspace: { ...workspace, exceptionTasks: tasks },
    created,
    resolved,
    reopened,
    open: tasks.filter((task) => task.code === "missing_document" && task.status !== "resolved").length,
    changed,
  };
}

function inferMimeType(file, explicitMimeType) {
  if (file?.type) return file.type;
  if (explicitMimeType) return explicitMimeType;
  const extension = String(file?.name || "").split(".").pop()?.toLowerCase();
  return MIME_TYPES_BY_EXTENSION[extension] || "application/octet-stream";
}

function optionalNumber(value, label, maximum = null) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label}必须是大于或等于 0 的数字`);
  if (maximum != null && number > maximum) throw new Error(`${label}不能大于 ${maximum}`);
  return number;
}

function optionalDate(value, label) {
  const date = String(value || "").trim();
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00`))) {
    throw new Error(`${label}不是有效日期`);
  }
  return date;
}

function enumValue(value, allowed, fallback, label) {
  const resolved = value || fallback;
  if (!allowed.includes(resolved)) throw new Error(`${label}无效`);
  return resolved;
}

export function documentStructuredKind(category) {
  if (category === "合同") return "contract";
  if (category === "发票") return "invoice";
  if (["审批资料", "审批单"].includes(category)) return "approval";
  return null;
}

export function normalizeDocumentStructuredData(category, input = {}) {
  const kind = documentStructuredKind(category);
  if (!kind) return null;
  if (kind === "contract") {
    const serviceStartDate = optionalDate(input.serviceStartDate, "服务开始日期");
    const serviceEndDate = optionalDate(input.serviceEndDate, "服务结束日期");
    if (serviceStartDate && serviceEndDate && serviceEndDate < serviceStartDate) throw new Error("服务结束日期不能早于开始日期");
    return {
      kind,
      partyA: String(input.partyA || "").trim(),
      partyB: String(input.partyB || "").trim(),
      amount: optionalNumber(input.amount, "合同金额"),
      serviceStartDate,
      serviceEndDate,
      settlementCycle: String(input.settlementCycle || "").trim(),
      refundTerms: String(input.refundTerms || "").trim(),
      commissionTerms: String(input.commissionTerms || "").trim(),
    };
  }
  if (kind === "invoice") {
    return {
      kind,
      invoiceNumber: String(input.invoiceNumber || "").trim(),
      invoiceDate: optionalDate(input.invoiceDate, "发票日期"),
      amount: optionalNumber(input.amount, "发票金额"),
      taxAmount: optionalNumber(input.taxAmount, "发票税额"),
      taxRate: optionalNumber(input.taxRate, "发票税率", 100),
      verificationStatus: enumValue(input.verificationStatus, INVOICE_STATUSES.verificationStatus, "unverified", "查验状态"),
      redLetterStatus: enumValue(input.redLetterStatus, INVOICE_STATUSES.redLetterStatus, "normal", "红字状态"),
      voidStatus: enumValue(input.voidStatus, INVOICE_STATUSES.voidStatus, "valid", "作废状态"),
      certificationStatus: enumValue(input.certificationStatus, INVOICE_STATUSES.certificationStatus, "not_required", "认证状态"),
    };
  }
  return {
    kind,
    approvalType: String(input.approvalType || "").trim(),
    applicant: String(input.applicant || "").trim(),
    amount: optionalNumber(input.amount, "审批金额"),
    approvalStatus: enumValue(input.approvalStatus, APPROVAL_STATUSES, "draft", "审批状态"),
  };
}

function invoiceNumberKey(value) {
  return String(value || "").trim().toLocaleUpperCase("zh-CN");
}

export function assertUniqueInvoiceNumber(workspace, document, excludedDocumentId = null) {
  if (documentStructuredKind(document?.category) !== "invoice") return;
  const key = invoiceNumberKey(document.structuredData?.invoiceNumber);
  if (!key) return;
  const duplicate = (workspace?.documents || []).find((candidate) => candidate.id !== excludedDocumentId
    && documentStructuredKind(candidate.category) === "invoice"
    && invoiceNumberKey(candidate.structuredData?.invoiceNumber) === key);
  if (duplicate) throw new Error(`发票号码 ${document.structuredData.invoiceNumber} 已存在于资料「${duplicate.name}」，不能重复保存`);
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
  const category = options.category || "其他资料";
  return {
    id,
    name: options.name || file.name || "未命名资料",
    category,
    mimeType: inferMimeType(file, options.mimeType),
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
    structuredData: normalizeDocumentStructuredData(category, options.structuredData),
    contentRecognition: {
      mode: "manual",
      ocrStatus: "not_connected",
    },
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

export function getDocumentRelatedObjectIds(workspace, documentId) {
  const document = workspace?.documents?.find((item) => item.id === documentId);
  if (!document) return [];
  const allowedIds = linkableObjectIds(workspace);
  const relatedIds = new Set(document.relatedObjectIds || []);
  (workspace.evidenceLinks || [])
    .filter((link) => link.status !== "inactive" && link.documentIds?.includes(documentId))
    .forEach((link) => (link.objectIds || []).forEach((objectId) => relatedIds.add(objectId)));
  LINKABLE_COLLECTIONS.forEach((collection) => {
    (workspace[collection] || []).forEach((item) => {
      if (includesDocument(item, documentId)) relatedIds.add(item.id);
    });
  });
  return [...relatedIds].filter((objectId) => allowedIds.has(objectId));
}

export function getLocalDocumentUsage(workspace, documentId) {
  const document = workspace?.documents?.find((item) => item.id === documentId);
  if (!document) return [];
  const usage = [];
  const seen = new Set();
  const add = (kind, id, label) => {
    const key = `${kind}:${id || label}`;
    if (seen.has(key)) return;
    seen.add(key);
    usage.push({ kind, id: id || null, label });
  };

  if (document.archiveStatus === "archived" || ["archived", "已归档"].includes(document.lifecycleStatus) || document.status === "archived") {
    add("archive", document.id, "资料自身已归档");
  }
  (workspace.vouchers || []).forEach((voucher) => {
    if ([...(voucher.evidenceIds || []), ...(voucher.documentIds || []), ...(voucher.sourceIds || [])].includes(documentId)) {
      add("voucher", voucher.id, `凭证 ${voucher.no || voucher.id}`);
    }
  });
  (workspace.delivery?.archives || []).forEach((archive) => {
    const archivedIds = [
      ...(archive.documentIds || []),
      ...(archive.documents || []).map((item) => typeof item === "string" ? item : item?.id),
      archive.receipt?.documentId,
    ];
    if (archivedIds.includes(documentId)) add("archive", archive.id, `期间归档 ${archive.period || archive.id}`);
  });
  if (workspace.delivery?.filing?.receipt?.documentId === documentId) {
    add("filing", workspace.delivery.filing.period, "当前申报回执");
  }
  (workspace.bankImports || []).forEach((bankImport) => {
    if (bankImport.sourceDocumentId === documentId) add("bank-import", bankImport.id, `银行导入 ${bankImport.fileName || bankImport.id}`);
  });
  (workspace.authorizations || []).forEach((authorization) => {
    if (authorization.proofDocumentId === documentId) add("authorization", authorization.id, `授权记录 ${authorization.label || authorization.id}`);
  });
  getDocumentRelatedObjectIds(workspace, documentId).forEach((objectId) => {
    const linked = linkableObject(workspace, objectId);
    add("business-object", objectId, `${LINKABLE_COLLECTION_LABELS[linked?.collection] || "业务对象"} ${displayName(linked?.item)}`);
  });
  return usage;
}

export function filterLocalDocuments(workspace, filters = {}) {
  const query = normalizedText(filters.query);
  const category = filters.category || "all";
  const status = filters.status || "all";
  return [...(workspace?.documents || [])]
    .filter((document) => {
      const usage = getLocalDocumentUsage(workspace, document.id);
      const archived = usage.some((item) => item.kind === "archive");
      const locallyAvailable = document.storage?.mode === "indexeddb" && document.storage?.availableLocally;
      const searchText = normalizedText([
        document.name,
        document.category,
        document.period,
        document.sourceActor,
        document.hash,
        ...Object.values(document.structuredData || {}),
        ...usage.map((item) => item.label),
      ].filter(Boolean).join(" "));
      if (query && !searchText.includes(query)) return false;
      if (category !== "all" && document.category !== category) return false;
      if (status === "active" && archived) return false;
      if (status === "archived" && !archived) return false;
      if (status === "linked" && !usage.some((item) => item.kind !== "archive")) return false;
      if (status === "unlinked" && usage.length) return false;
      if (status === "available" && !locallyAvailable) return false;
      if (status === "missing" && locallyAvailable) return false;
      return true;
    })
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
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
  assertUniqueInvoiceNumber(current, metadata);
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

export function updateLocalDocumentMetadata(input) {
  const { store, workspaceId, documentId } = input;
  if (!store?.actions) throw new Error("资料修改需要工作台 store");
  const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
  const document = workspace?.documents?.find((item) => item.id === documentId);
  if (!document) throw new Error("找不到要修改的本地资料");
  if (document.archiveStatus === "archived" || ["archived", "已归档"].includes(document.lifecycleStatus)) {
    throw new Error("已归档资料不能直接修改；请通过新版本处理");
  }
  const patch = input.patch || {};
  const relatedObjectIds = [...new Set(patch.relatedObjectIds === undefined
    ? getDocumentRelatedObjectIds(workspace, documentId)
    : (patch.relatedObjectIds || []))].filter(Boolean);
  const allowedIds = linkableObjectIds(workspace);
  const invalidIds = relatedObjectIds.filter((objectId) => !allowedIds.has(objectId));
  if (invalidIds.length) throw new Error(`关联对象不属于当前工作台：${invalidIds.join("、")}`);
  const timestamp = input.updatedAt || new Date().toISOString();
  const actor = input.actor
    || workspace.users?.find((user) => user.id === store.getState().activeUserId && user.status === "active")?.name
    || "本地用户";
  const previousRelatedIds = getDocumentRelatedObjectIds(workspace, documentId);
  const previousTransactionIds = new Set((workspace.transactions || [])
    .filter((transaction) => includesDocument(transaction, documentId) || previousRelatedIds.includes(transaction.id))
    .map((transaction) => transaction.id));
  const nextTransactionIds = new Set(relatedObjectIds.filter((objectId) => (workspace.transactions || []).some((transaction) => transaction.id === objectId)));
  const existingLink = (workspace.evidenceLinks || []).find((link) => link.documentIds?.includes(documentId));
  const category = patch.category || document.category || "其他资料";
  const nextKind = documentStructuredKind(category);
  const structuredInput = patch.structuredData === undefined
    ? (document.structuredData?.kind === nextKind ? document.structuredData : {})
    : (document.structuredData?.kind === nextKind
      ? { ...document.structuredData, ...(patch.structuredData || {}) }
      : (patch.structuredData || {}));
  const updatedDocument = {
    ...document,
    name: String(patch.name ?? document.name).trim() || document.name,
    category,
    period: patch.period === undefined ? document.period : (patch.period || null),
    relatedObjectIds,
    structuredData: normalizeDocumentStructuredData(category, structuredInput),
    contentRecognition: {
      mode: "manual",
      ocrStatus: "not_connected",
    },
    updatedAt: timestamp,
  };
  assertUniqueInvoiceNumber(workspace, updatedDocument, documentId);
  const evidenceLinks = (workspace.evidenceLinks || []).flatMap((link) => {
    if (!link.documentIds?.includes(documentId)) return [link];
    const documentIds = link.documentIds.filter((id) => id !== documentId);
    return documentIds.length ? [{ ...link, documentIds, updatedAt: timestamp }] : [];
  });
  if (relatedObjectIds.length) {
    evidenceLinks.push({
      id: createId("evidence-link"),
      documentIds: [documentId],
      objectIds: relatedObjectIds,
      relation: input.relation || existingLink?.relation || "supports",
      note: input.note ?? existingLink?.note ?? "",
      status: "active",
      createdAt: existingLink?.createdAt || timestamp,
      updatedAt: timestamp,
    });
  }
  let next = {
    ...workspace,
    documents: workspace.documents.map((item) => item.id === documentId ? updatedDocument : item),
    evidenceLinks,
    transactions: (workspace.transactions || []).map((transaction) => {
      const shouldLink = nextTransactionIds.has(transaction.id);
      return {
        ...transaction,
        evidenceIds: shouldLink
          ? [...new Set([...(transaction.evidenceIds || []), documentId])]
          : (transaction.evidenceIds || []).filter((id) => id !== documentId),
        documentIds: shouldLink
          ? transaction.documentIds
          : (transaction.documentIds || []).filter((id) => id !== documentId),
      };
    }),
  };
  new Set([...previousTransactionIds, ...nextTransactionIds]).forEach((transactionId) => {
    next = reviewTransactionEvidence(next, transactionId, { actor, mode: "manual" });
  });
  store.actions.replaceWorkspace(workspaceId, next, {
    requiredPermission: "documents.add",
    audit: {
      actor,
      action: "更新本地资料",
      detail: `${updatedDocument.name}（${updatedDocument.category}）· 关联 ${relatedObjectIds.length} 个业务对象`,
    },
  });
  return store.getState().workspaces.find((item) => item.id === workspaceId)?.documents?.find((item) => item.id === documentId);
}

export function refreshDocumentMissingTasks({ store, workspaceId, actor, at }) {
  if (!store?.actions) throw new Error("缺件待办刷新需要工作台 store");
  const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
  if (!workspace) throw new Error("找不到要刷新缺件待办的工作台");
  const resolvedActor = actor
    || workspace.users?.find((user) => user.id === store.getState().activeUserId && user.status === "active")?.name
    || "本地用户";
  const result = syncDocumentMissingTasks(workspace, { actor: resolvedActor, at });
  if (result.changed) {
    store.actions.replaceWorkspace(workspaceId, result.workspace, {
      requiredPermission: "documents.add",
      audit: {
        actor: resolvedActor,
        action: "刷新资料缺件待办",
        detail: `新增 ${result.created} 项，关闭 ${result.resolved} 项，重新打开 ${result.reopened} 项，当前待补 ${result.open} 项`,
      },
    });
  }
  return { created: result.created, resolved: result.resolved, reopened: result.reopened, open: result.open, changed: result.changed };
}

export function confirmDocumentMatch({ store, workspaceId, suggestionId, actor, at }) {
  if (!store?.actions) throw new Error("确认资料匹配需要工作台 store");
  const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
  if (!workspace) throw new Error("找不到资料所属工作台");
  const suggestion = buildDocumentMatchSuggestions(workspace).find((item) => item.id === suggestionId);
  if (!suggestion) throw new Error("匹配建议已失效，请刷新后重新确认");
  const document = workspace.documents.find((item) => item.id === suggestion.documentId);
  const collection = suggestion.sourceType === "bankTransaction" ? "transactions" : "businessEvents";
  const target = (workspace[collection] || []).find((item) => item.id === suggestion.sourceId);
  if (!document || !target) throw new Error("匹配资料或业务对象已不存在");
  if (document.archiveStatus === "archived" || document.lifecycleStatus === "已归档") throw new Error("已归档资料不能新增业务关联");
  if (linkedDocumentIdsForTarget(workspace, target).has(document.id)) throw new Error("该资料已经关联到当前业务");
  const timestamp = at || new Date().toISOString();
  const resolvedActor = actor
    || workspace.users?.find((user) => user.id === store.getState().activeUserId && user.status === "active")?.name
    || "本地用户";
  const beforeTaskSync = syncDocumentMissingTasks(workspace, { actor: resolvedActor, at: timestamp });
  const base = beforeTaskSync.workspace;
  const link = {
    id: createId("evidence-link"),
    documentIds: [document.id],
    objectIds: [target.id],
    relation: "confirmed-document-match",
    note: `用户确认匹配：${suggestion.reasons.join("；")}`,
    status: "active",
    matchScore: suggestion.score,
    matchReasons: suggestion.reasons,
    confirmedAt: timestamp,
    confirmedBy: resolvedActor,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  let next = {
    ...base,
    documents: base.documents.map((item) => item.id === document.id ? {
      ...item,
      relatedObjectIds: [...new Set([...(item.relatedObjectIds || []), target.id])],
      updatedAt: timestamp,
    } : item),
    evidenceLinks: [...(base.evidenceLinks || []), link],
    [collection]: (base[collection] || []).map((item) => item.id === target.id ? {
      ...item,
      evidenceIds: [...new Set([...(item.evidenceIds || []), document.id])],
      documentIds: [...new Set([...(item.documentIds || []), document.id])],
      updatedAt: timestamp,
    } : item),
  };
  if (suggestion.sourceType === "bankTransaction") {
    next = reviewTransactionEvidence(next, target.id, { actor: resolvedActor, mode: "manual", at: timestamp });
  }
  const afterTaskSync = syncDocumentMissingTasks(next, { actor: resolvedActor, at: timestamp });
  next = afterTaskSync.workspace;
  store.actions.replaceWorkspace(workspaceId, next, {
    requiredPermission: "documents.add",
    audit: {
      actor: resolvedActor,
      action: "确认资料匹配",
      detail: `${document.name} → ${suggestion.sourceLabel}；${suggestion.reasons.join("、")}`,
    },
  });
  return {
    suggestion,
    link,
    closedTaskCount: afterTaskSync.resolved,
    openTaskCount: afterTaskSync.open,
  };
}

export async function removeLocalDocument(input) {
  const { store, fileVault, workspaceId, documentId } = input;
  const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
  const document = workspace?.documents?.find((item) => item.id === documentId);
  if (!document) throw new Error("找不到要删除的本地资料");
  const actor = input.actor
    || workspace.users?.find((user) => user.id === store.getState().activeUserId && user.status === "active")?.name
    || "本地用户";
  const usage = getLocalDocumentUsage(workspace, documentId);
  if (usage.length) throw new Error(`该资料正在使用，不能删除：${usage.map((item) => item.label).join("、")}；请先解除普通业务关联，凭证或归档引用需通过更正／新版本处理`);
  if (document.storage?.availableLocally && !fileVault) throw new Error("当前浏览器无法访问本地文件保险箱，不能安全删除原文件");
  const blobId = document?.storage?.blobId || (document?.storage?.mode === "indexeddb" ? null : documentId);
  const ownedRecord = blobId && fileVault
    ? await (fileVault.getOwned?.(blobId, workspaceId, document.hash) || fileVault.get(blobId).then((record) => record?.workspaceId === workspaceId ? record : null))
    : null;
  const next = {
    ...workspace,
    documents: workspace.documents.filter((item) => item.id !== documentId),
    evidenceLinks: (workspace.evidenceLinks || []).filter((link) => !link.documentIds?.includes(documentId)),
  };
  if (ownedRecord) await fileVault.delete(blobId);
  try {
    store.actions.replaceWorkspace(workspaceId, next, {
      requiredPermission: "documents.add",
      audit: {
        actor,
        action: "删除本地资料",
        detail: `${document.name}；删除时未发现业务、凭证或归档引用`,
      },
    });
  } catch (error) {
    if (ownedRecord) await fileVault.put(ownedRecord);
    throw error;
  }
}

export async function getStoredDocumentRecord({ fileVault, workspaceId, document }) {
  if (!fileVault) throw new Error("当前浏览器不支持本地文件保险箱");
  if (!document) throw new Error("找不到资料索引");
  const blobId = document.storage?.blobId || document.id;
  const record = fileVault.getOwned
    ? await fileVault.getOwned(blobId, workspaceId, document.hash)
    : await fileVault.get(blobId);
  if (!record || record.workspaceId !== workspaceId || (document.hash && record.hash && record.hash !== document.hash)) {
    throw new Error("该文件不属于当前工作台或本地内容已变化，请重新关联原文件");
  }
  return record;
}

export const VOUCHER_ATTACHMENT_SECTIONS = Object.freeze([
  { key: "bankReceipt", order: 1, label: "银行回单", recordFile: null },
  { key: "invoice", order: 2, label: "发票", recordFile: null },
  { key: "contractOrder", order: 3, label: "合同/订单", recordFile: null },
  { key: "approval", order: 4, label: "审批单", recordFile: null },
  { key: "confirmation", order: 5, label: "确认记录", recordFile: "确认记录.json" },
  { key: "matching", order: 6, label: "匹配说明", recordFile: "匹配说明.json" },
  { key: "review", order: 7, label: "复核记录", recordFile: "复核记录.json" },
  { key: "missing", order: 8, label: "缺失资料清单", recordFile: "缺失资料清单.json" },
]);

const VOUCHER_SOURCE_COLLECTIONS = [
  "transactions",
  "businessEvents",
  "bills",
  "contracts",
  "invoices",
  "approvals",
  "personnelRecords",
];

const VOUCHER_SOURCE_COLLECTION_LABELS = {
  transactions: "银行流水",
  businessEvents: "业务事件",
  bills: "往来账单",
  contracts: "合同",
  invoices: "发票",
  approvals: "审批单",
  personnelRecords: "人员资料",
};

function addSourceIds(target, values) {
  (Array.isArray(values) ? values.flat(Infinity) : [values]).filter(Boolean).forEach((value) => target.add(value));
}

function voucherSourceGraph(workspace, voucher) {
  const sourceIds = new Set();
  addSourceIds(sourceIds, [
    voucher.sourceIds,
    voucher.relatedSourceIds,
    voucher.memberEventId,
    (voucher.lines || []).map((line) => line.sourceIds || []),
  ]);

  let changed = true;
  while (changed) {
    const before = sourceIds.size;
    (workspace.transactions || []).forEach((transaction) => {
      const allocations = transaction.allocations || [];
      if (!sourceIds.has(transaction.id) && !allocations.some((allocation) => sourceIds.has(allocation.id))) return;
      addSourceIds(sourceIds, [
        transaction.id,
        transaction.counterpartTransactionId,
        transaction.sourceIds,
        allocations.map((allocation) => [allocation.id, allocation.billId]),
      ]);
    });
    VOUCHER_SOURCE_COLLECTIONS.filter((collection) => collection !== "transactions").forEach((collection) => {
      (workspace[collection] || []).forEach((item) => {
        if (!sourceIds.has(item.id)) return;
        addSourceIds(sourceIds, [
          item.sourceIds,
          item.relatedSourceIds,
          item.billId,
          item.contractId,
          item.invoiceId,
          item.approvalId,
          item.originalRechargeId,
          item.commissionEventId,
          item.commissionSourceIds,
        ]);
      });
    });
    changed = sourceIds.size !== before;
  }

  const sourceObjects = VOUCHER_SOURCE_COLLECTIONS.flatMap((collection) => (
    (workspace[collection] || [])
      .filter((item) => sourceIds.has(item.id))
      .map((item) => ({ collection, label: VOUCHER_SOURCE_COLLECTION_LABELS[collection], item }))
  ));
  return { sourceIds, sourceObjects };
}

function voucherDocumentSectionKey(document) {
  const text = normalizedText(`${document?.category || ""} ${document?.type || ""} ${document?.name || ""}`);
  const kind = matchDocumentKind(document);
  if (/银行.*(回单|流水|对账)|回单|银行流水|对账单/.test(text)) return "bankReceipt";
  if (kind === "invoice") return "invoice";
  if (kind === "contract" || /合同|协议|订单|采购单/.test(text)) return "contractOrder";
  if (kind === "approval" || /审批|申请单|报销单/.test(text)) return "approval";
  if (/确认|签收|验收|回执/.test(text)) return "confirmation";
  if (/复核|审核|查验/.test(text)) return "review";
  return "matching";
}

function voucherAttachmentRelations(workspace, voucher) {
  const graph = voucherSourceGraph(workspace, voucher);
  const relationObjectIds = new Set([voucher.id, ...graph.sourceIds, ...graph.sourceObjects.map(({ item }) => item.id)]);
  const documentIds = new Set([...(voucher.evidenceIds || []), ...(voucher.documentIds || [])]);
  graph.sourceObjects.forEach(({ item }) => addSourceIds(documentIds, [item.evidenceIds, item.documentIds]));

  const sourceImportIds = new Set(graph.sourceObjects
    .filter(({ collection }) => collection === "transactions")
    .map(({ item }) => item.importId)
    .filter(Boolean));
  (workspace.bankImports || []).forEach((bankImport) => {
    if (sourceImportIds.has(bankImport.id) || graph.sourceIds.has(bankImport.id)) addSourceIds(documentIds, bankImport.sourceDocumentId);
  });

  (workspace.evidenceLinks || []).filter((link) => (
    link.status !== "inactive" && (link.objectIds || []).some((objectId) => relationObjectIds.has(objectId))
  )).forEach((link) => addSourceIds(documentIds, link.documentIds));
  (workspace.documents || []).filter((document) => (
    (document.relatedObjectIds || []).some((objectId) => relationObjectIds.has(objectId))
  )).forEach((document) => documentIds.add(document.id));

  const documents = (workspace.documents || []).filter((document) => documentIds.has(document.id));
  const evidenceLinks = (workspace.evidenceLinks || []).filter((link) => (
    link.status !== "inactive" && (
      (link.objectIds || []).some((objectId) => relationObjectIds.has(objectId))
      || (link.documentIds || []).some((documentId) => documentIds.has(documentId))
    )
  ));
  return { ...graph, relationObjectIds, documentIds, documents, evidenceLinks };
}

function relevantConfirmations(workspace, voucher, relations) {
  const relatedIds = new Set([voucher.id, ...relations.sourceIds, ...relations.documentIds]);
  return (workspace.confirmations || []).filter((confirmation) => {
    const ids = [
      ...(confirmation.sourceIds || []),
      ...(confirmation.decisions || []).flatMap((decision) => decision.sourceIds || []),
      ...Object.values(confirmation.sections || {}).flatMap((section) => section.sourceIds || []),
    ];
    return ids.some((id) => relatedIds.has(id));
  });
}

function relevantReviewRecords(workspace, voucher, relations) {
  const relatedIds = new Set([voucher.id, ...relations.sourceIds, ...relations.documentIds]);
  const audit = (workspace.auditLog || []).filter((entry) => (
    relatedIds.has(entry.entityId) || (entry.sourceIds || []).some((id) => relatedIds.has(id))
  ));
  return [
    ...(voucher.reviews || []).map((record) => ({ recordType: "voucherReview", ...record })),
    ...audit.map((record) => ({ recordType: "auditLog", ...record })),
  ];
}

function uniqueMissingItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.key || `${item.sectionKey || "general"}:${item.documentId || item.sourceId || item.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildVoucherAttachmentPackagePlan(workspace, voucherId) {
  const voucher = (workspace?.vouchers || []).find((item) => item.id === voucherId);
  if (!voucher) throw new Error("找不到要生成附件包的凭证");
  const relations = voucherAttachmentRelations(workspace, voucher);
  const confirmations = relevantConfirmations(workspace, voucher, relations);
  const matchingRecords = [
    {
      recordType: "voucherJudgement",
      voucherId: voucher.id,
      eventType: voucher.judgement?.eventType || null,
      confidence: voucher.judgement?.confidence ?? null,
      reasons: voucher.judgement?.reasons || [],
      note: voucher.judgement?.note || "",
      summary: voucher.summary || "",
      sourceIds: voucher.sourceIds || [],
    },
    ...relations.evidenceLinks.map((link) => ({ recordType: "evidenceLink", ...link })),
  ];
  const reviews = relevantReviewRecords(workspace, voucher, relations);
  const documentsBySection = Object.fromEntries(VOUCHER_ATTACHMENT_SECTIONS.map((section) => [section.key, []]));
  relations.documents.forEach((document) => documentsBySection[voucherDocumentSectionKey(document)].push(document));

  const relevantTargetIds = new Set(relations.sourceObjects
    .filter(({ collection }) => ["transactions", "businessEvents"].includes(collection))
    .map(({ item }) => item.id));
  const missingRequirements = getDocumentMissingRequirements(workspace)
    .filter((requirement) => relevantTargetIds.has(requirement.sourceId) && !requirement.satisfied);
  const requiredSections = new Set(["confirmation", "matching", "review", "missing"]);
  if (relations.sourceObjects.some(({ collection }) => collection === "transactions")) requiredSections.add("bankReceipt");
  relations.sourceObjects.filter(({ collection }) => ["transactions", "businessEvents"].includes(collection)).forEach(({ item }) => {
    documentRequirementsForTarget(item).forEach((requirement) => {
      if (requirement.anyOf.length !== 1) return;
      if (requirement.anyOf[0] === "invoice") requiredSections.add("invoice");
      if (requirement.anyOf[0] === "contract") requiredSections.add("contractOrder");
      if (requirement.anyOf[0] === "approval") requiredSections.add("approval");
    });
  });

  const recordsBySection = {
    bankReceipt: [],
    invoice: [],
    contractOrder: [],
    approval: [],
    confirmation: confirmations,
    matching: matchingRecords,
    review: reviews,
    missing: [],
  };
  const missingItems = [
    ...relations.documents.filter((document) => !document.storage?.availableLocally).map((document) => ({
      key: `document:${document.id}`,
      kind: "original_file",
      sectionKey: voucherDocumentSectionKey(document),
      documentId: document.id,
      label: document.name || document.id,
      reason: "已有关联资料索引，但当前浏览器没有原文件",
    })),
    ...missingRequirements.map((requirement) => ({
      key: `requirement:${requirement.identity}`,
      kind: "business_requirement",
      sectionKey: requirement.anyOf.length === 1
        ? ({ invoice: "invoice", contract: "contractOrder", approval: "approval" }[requirement.anyOf[0]] || "missing")
        : "missing",
      sourceId: requirement.sourceId,
      label: requirement.label,
      reason: `${requirement.sourceLabel} 尚未关联${requirement.label}`,
    })),
  ];
  const initialSections = VOUCHER_ATTACHMENT_SECTIONS.filter((section) => section.key !== "missing").map((section) => {
    const documents = documentsBySection[section.key];
    const availableDocumentCount = documents.filter((document) => document.storage?.availableLocally).length;
    const records = recordsBySection[section.key];
    const required = requiredSections.has(section.key);
    const status = availableDocumentCount || records.length ? "collected" : (required ? "missing" : "not_required");
    if (status === "missing" && !missingItems.some((item) => item.sectionKey === section.key)) {
      missingItems.push({
        key: `section:${section.key}`,
        kind: "section",
        sectionKey: section.key,
        label: section.label,
        reason: `当前凭证未关联${section.label}`,
      });
    }
    return { ...section, required, status, documents, records, availableDocumentCount };
  });
  const resolvedMissingItems = uniqueMissingItems(missingItems);
  recordsBySection.missing = resolvedMissingItems;
  const sections = [
    ...initialSections,
    {
      ...VOUCHER_ATTACHMENT_SECTIONS.find((section) => section.key === "missing"),
      required: true,
      status: "collected",
      documents: [],
      records: resolvedMissingItems,
      availableDocumentCount: 0,
    },
  ];
  return {
    voucher,
    voucherId: voucher.id,
    voucherNo: voucher.no || null,
    sourceIds: [...relations.sourceIds],
    sourceObjects: relations.sourceObjects,
    evidenceLinks: relations.evidenceLinks,
    documents: relations.documents,
    confirmations,
    matchingRecords,
    reviews,
    missingItems: resolvedMissingItems,
    sections,
  };
}

function safeZipName(value, fallback) {
  const safe = String(value || fallback || "未命名")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return safe || fallback || "未命名";
}

function uniqueZipPath(folder, name, usedPaths) {
  const safeName = safeZipName(name, "原文件");
  const dot = safeName.lastIndexOf(".");
  const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
  const extension = dot > 0 ? safeName.slice(dot) : "";
  let candidate = `${folder}/${safeName}`;
  let suffix = 2;
  while (usedPaths.has(candidate)) {
    candidate = `${folder}/${stem}-${suffix}${extension}`;
    suffix += 1;
  }
  usedPaths.add(candidate);
  return candidate;
}

function jsonFile(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function voucherPackageSnapshot(voucher) {
  return {
    id: voucher.id,
    no: voucher.no || null,
    date: voucher.date || null,
    period: voucher.period || null,
    summary: voucher.summary || "",
    status: voucher.status || null,
    version: voucher.version || 1,
    lines: voucher.lines || [],
    sourceIds: voucher.sourceIds || [],
    relatedSourceIds: voucher.relatedSourceIds || [],
    evidenceIds: voucher.evidenceIds || [],
    documentIds: voucher.documentIds || [],
    judgement: voucher.judgement || null,
    blockers: voucher.blockers || [],
  };
}

function sourceRelationshipSnapshot(plan) {
  return {
    voucherId: plan.voucherId,
    sourceIds: plan.sourceIds,
    sources: plan.sourceObjects.map(({ collection, label, item }) => ({
      collection,
      kind: label,
      id: item.id,
      name: displayName(item),
      date: item.date || null,
      period: item.businessPeriod || item.period || null,
      amount: item.amount ?? null,
      sourceIds: item.sourceIds || [],
      evidenceIds: item.evidenceIds || [],
      documentIds: item.documentIds || [],
    })),
    evidenceLinks: plan.evidenceLinks,
  };
}

function archiveByteLength(archive) {
  return Number(archive?.size ?? archive?.byteLength ?? archive?.length ?? 0);
}

function downloadLocalArchive(blob, fileName) {
  if (!blob || typeof document === "undefined" || !globalThis.URL?.createObjectURL) throw new Error("当前环境无法触发本地 ZIP 下载");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function generateVoucherAttachmentPackage(input) {
  const { store, fileVault, workspaceId, voucherId } = input;
  if (!store?.actions) throw new Error("生成凭证附件包需要工作台 store");
  if (!fileVault) throw new Error("当前浏览器不支持本地文件保险箱，无法生成附件包");
  const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
  if (!workspace) throw new Error("找不到附件包所属工作台");
  const plan = buildVoucherAttachmentPackagePlan(workspace, voucherId);
  const generatedAt = input.at || new Date().toISOString();
  const generatedBy = input.actor
    || workspace.users?.find((user) => user.id === store.getState().activeUserId && user.status === "active")?.name
    || "本地用户";
  const packageId = input.packageId || createId("voucher-attachment-package");
  const Zip = input.Zip || (await import("jszip")).default;
  const zip = new Zip();
  const usedPaths = new Set();
  const packagedFiles = [];
  const runtimeMissing = [];

  VOUCHER_ATTACHMENT_SECTIONS.forEach((section) => zip.folder(`${String(section.order).padStart(2, "0")}-${safeZipName(section.label)}`));
  for (const section of plan.sections) {
    const folder = `${String(section.order).padStart(2, "0")}-${safeZipName(section.label)}`;
    for (const documentMetadata of section.documents) {
      try {
        const record = await getStoredDocumentRecord({ fileVault, workspaceId, document: documentMetadata });
        const actualHash = await hashLocalFile(record.blob);
        if (documentMetadata.hash && actualHash !== documentMetadata.hash) throw new Error("原文件哈希与工作台记录不一致");
        const archivePath = uniqueZipPath(folder, record.name || documentMetadata.name, usedPaths);
        zip.file(archivePath, new Uint8Array(await record.blob.arrayBuffer()));
        packagedFiles.push({
          sectionKey: section.key,
          sectionLabel: section.label,
          documentId: documentMetadata.id,
          name: record.name || documentMetadata.name,
          archivePath,
          mimeType: record.mimeType || documentMetadata.mimeType || "application/octet-stream",
          size: Number(record.size ?? documentMetadata.size ?? record.blob.size ?? 0),
          hash: actualHash,
          hashAlgorithm: actualHash.startsWith("fnv1a-") ? "FNV-1a fallback" : "SHA-256",
          relatedObjectIds: documentMetadata.relatedObjectIds || [],
        });
      } catch (error) {
        runtimeMissing.push({
          key: `runtime-document:${documentMetadata.id}`,
          kind: "original_file",
          sectionKey: section.key,
          documentId: documentMetadata.id,
          label: documentMetadata.name || documentMetadata.id,
          reason: error.message || "当前浏览器无法读取原文件",
        });
      }
    }
  }

  const missingItems = uniqueMissingItems([...plan.missingItems, ...runtimeMissing]);
  const voucherSnapshot = voucherPackageSnapshot(plan.voucher);
  const relationships = sourceRelationshipSnapshot(plan);
  const finalSections = plan.sections.map((section) => {
    const packagedDocumentIds = packagedFiles.filter((file) => file.sectionKey === section.key).map((file) => file.documentId);
    const recordCount = section.key === "missing" ? missingItems.length : section.records.length;
    const hasContent = packagedDocumentIds.length > 0 || recordCount > 0 || section.key === "missing";
    return {
      key: section.key,
      order: section.order,
      label: section.label,
      required: section.required,
      status: hasContent ? "collected" : (section.required ? "missing" : "not_required"),
      linkedDocumentIds: section.documents.map((documentMetadata) => documentMetadata.id),
      packagedDocumentIds,
      recordCount,
    };
  });
  const manifest = {
    packageId,
    product: "FinanceDesk",
    generatedAt,
    generatedBy,
    localOnly: true,
    externalUpload: false,
    voucher: voucherSnapshot,
    sections: finalSections,
    sourceRelationships: relationships,
    files: packagedFiles,
    hashes: packagedFiles.map(({ documentId, name, archivePath, hash, hashAlgorithm }) => ({ documentId, name, archivePath, hash, hashAlgorithm })),
    missingItems,
  };

  zip.file("凭证.json", jsonFile(voucherSnapshot));
  zip.file("来源关系.json", jsonFile(relationships));
  zip.file("哈希清单.json", jsonFile(manifest.hashes));
  zip.file("05-确认记录/确认记录.json", jsonFile(plan.confirmations));
  zip.file("06-匹配说明/匹配说明.json", jsonFile(plan.matchingRecords));
  zip.file("07-复核记录/复核记录.json", jsonFile(plan.reviews));
  zip.file("08-缺失资料清单/缺失资料清单.json", jsonFile(missingItems));
  zip.file("附件包清单.json", jsonFile(manifest));
  const archive = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const fileName = safeZipName(`${plan.voucher.no || plan.voucher.id}-附件包-${generatedAt.slice(0, 10)}.zip`, "凭证附件包.zip");
  const packageRecord = {
    id: packageId,
    voucherId: plan.voucher.id,
    voucherNo: plan.voucher.no || null,
    voucherVersion: plan.voucher.version || 1,
    fileName,
    size: archiveByteLength(archive),
    documentIds: packagedFiles.map((file) => file.documentId),
    hashes: manifest.hashes,
    missingItems,
    sourceIds: [plan.voucher.id, ...plan.sourceIds],
    generatedAt,
    generatedBy,
    localOnly: true,
    externalUpload: false,
  };
  const latestWorkspace = store.getState().workspaces.find((item) => item.id === workspaceId);
  const latestVoucher = latestWorkspace?.vouchers?.find((item) => item.id === voucherId);
  if (!latestWorkspace || !latestVoucher) throw new Error("附件包生成期间凭证已不存在，未写入下载记录");
  store.actions.replaceWorkspace(workspaceId, {
    ...latestWorkspace,
    vouchers: latestWorkspace.vouchers.map((voucher) => voucher.id === voucherId ? {
      ...voucher,
      attachmentPackages: [...(voucher.attachmentPackages || []), packageRecord],
      updatedAt: generatedAt,
    } : voucher),
  }, {
    allowArchivedTransition: true,
    requiredPermission: "data.read",
    audit: {
      actor: generatedBy,
      action: "生成凭证附件包",
      detail: `${plan.voucher.no || plan.voucher.id} · 原文件 ${packagedFiles.length} 份 · 缺失 ${missingItems.length} 项 · 仅本地下载`,
    },
  });
  if (input.download !== false) downloadLocalArchive(archive, fileName);
  return { archive, fileName, manifest, packageRecord };
}

export const MONTHLY_FINANCIAL_ARCHIVE_SECTIONS = Object.freeze([
  { key: "vouchers", order: 1, label: "凭证与分录" },
  { key: "voucherAttachments", order: 2, label: "凭证附件包或附件清单" },
  { key: "reports", order: 3, label: "三大报表与管理报表" },
  { key: "taxFiling", order: 4, label: "税务申报底稿与本地申报包" },
  { key: "payroll", order: 5, label: "工资社保数据" },
  { key: "confirmations", order: 6, label: "两次客户确认记录" },
  { key: "receipt", order: 7, label: "真实回执原文件" },
  { key: "exceptions", order: 8, label: "异常处理记录" },
  { key: "audit", order: 9, label: "操作日志" },
  { key: "hashes", order: 10, label: "统一哈希清单" },
]);

function periodOfRecord(item) {
  return item?.period || item?.businessPeriod || String(item?.date || "").slice(0, 7) || null;

}

export function getMonthlyFinancialArchivePeriods(workspace) {
  return [...new Set([
    workspace?.currentPeriod,
    ...(workspace?.periods || []),
    ...(workspace?.vouchers || []).map(periodOfRecord),
    ...(workspace?.reportVersions || []).map((item) => item.period),
    ...(workspace?.delivery?.reportVersions || []).map((item) => item.period),
    ...(workspace?.delivery?.archives || []).map((item) => item.period),
  ].filter(Boolean))].sort((left, right) => right.localeCompare(left));
}

function latestPeriodReportVersion(workspace, period, archiveRecord) {
  const versions = [...(workspace?.delivery?.reportVersions || []), ...(workspace?.reportVersions || [])]
    .filter((item, index, all) => item?.id && all.findIndex((candidate) => candidate?.id === item.id) === index)
    .filter((item) => item.period === period)
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  return versions.find((item) => item.id === archiveRecord?.reportVersionId) || versions[0] || null;
}

function safelyBuildMonthlySnapshot(builder, workspace, period) {
  try {
    return { value: builder(workspace, { period }), error: null };
  } catch (error) {
    return { value: null, error: error.message || "快照计算失败" };
  }
}

function reportSection(snapshot, reportVersion, liveStatements, key) {
  const productSectionKeys = { balanceSheet: "balance", incomeStatement: "income", cashFlow: "cashflow" };
  return snapshot?.sections?.[productSectionKeys[key]]
    || snapshot?.[key]
    || snapshot?.statements?.[key]
    || reportVersion?.statements?.[key]
    || liveStatements?.[key]
    || null;
}

function taxWorkpaperValue(workpaper, key) {
  if (workpaper?.[key]?.value !== undefined) return workpaper[key].value;
  const row = workpaper?.rows?.find((item) => item.id === key);
  return row?.value;
}

function monthlyVoucherAttachmentManifest(workspace, voucher, archivedPackage) {
  const currentVoucher = (workspace.vouchers || []).find((item) => item.id === voucher.id);
  if (!currentVoucher) {
    return {
      voucherId: voucher.id,
      voucherNo: voucher.no || null,
      generatedPackages: voucher.attachmentPackages || [],
      manifest: archivedPackage || null,
      missingItems: archivedPackage?.missing || [{ key: `attachment:${voucher.id}`, label: "凭证附件清单", reason: "当前工作台已无法重建该历史凭证的附件关系" }],
    };
  }
  try {
    const plan = buildVoucherAttachmentPackagePlan(workspace, currentVoucher.id);
    return {
      voucherId: currentVoucher.id,
      voucherNo: currentVoucher.no || null,
      generatedPackages: currentVoucher.attachmentPackages || [],
      manifest: {
        voucherId: plan.voucherId,
        voucherNo: plan.voucherNo,
        sourceIds: plan.sourceIds,
        sections: plan.sections.map((section) => ({
          key: section.key,
          order: section.order,
          label: section.label,
          required: section.required,
          status: section.status,
          documentIds: section.documents.map((document) => document.id),
          recordCount: section.records.length,
        })),
        documents: plan.documents.map((documentMetadata) => ({
          id: documentMetadata.id,
          name: documentMetadata.name,
          category: documentMetadata.category || documentMetadata.type || null,
          mimeType: documentMetadata.mimeType || null,
          size: documentMetadata.size || 0,
          hash: documentMetadata.hash || null,
          relatedObjectIds: documentMetadata.relatedObjectIds || [],
          storage: documentMetadata.storage || null,
        })),
        evidenceLinks: plan.evidenceLinks,
        missingItems: plan.missingItems,
      },
      missingItems: plan.missingItems,
    };
  } catch (error) {
    return {
      voucherId: currentVoucher.id,
      voucherNo: currentVoucher.no || null,
      generatedPackages: currentVoucher.attachmentPackages || [],
      manifest: archivedPackage || null,
      missingItems: [{ key: `attachment:${currentVoucher.id}`, label: "凭证附件清单", reason: error.message || "附件清单生成失败" }],
    };
  }
}

function periodExceptionRecords(workspace, period, archiveRecord, sourceIds) {
  if (archiveRecord?.exceptionRecords) return archiveRecord.exceptionRecords;
  return (workspace.exceptionTasks || []).filter((task) => (
    task.period === period
    || String(task.createdAt || task.updatedAt || "").startsWith(period)
    || sourceIds.has(task.sourceId)
    || (task.sourceIds || []).some((id) => sourceIds.has(id))
    || (period === workspace.currentPeriod && task.status !== "resolved")
  ));
}

function periodAuditRecords(workspace, period, archiveRecord, sourceIds) {
  if (archiveRecord?.auditSnapshot) return archiveRecord.auditSnapshot;
  return (workspace.auditLog || []).filter((entry) => (
    String(entry.at || entry.createdAt || "").startsWith(period)
    || sourceIds.has(entry.entityId)
    || (entry.sourceIds || []).some((id) => sourceIds.has(id))
  ));
}

function monthlySection(section, status, detail, count = null) {
  return { ...section, status, detail, count };
}

export function buildMonthlyFinancialArchivePlan(workspace, period = workspace?.currentPeriod) {
  if (!workspace) throw new Error("找不到要导出的工作台");
  if (!/^\d{4}-\d{2}$/.test(String(period || ""))) throw new Error("请选择有效的财务期间");
  const archiveRecord = (workspace.delivery?.archives || []).find((item) => item.period === period) || null;
  const vouchers = archiveRecord?.vouchers || (workspace.vouchers || []).filter((voucher) => periodOfRecord(voucher) === period);
  const periodSources = new Set(vouchers.flatMap((voucher) => [
    voucher.id,
    ...(voucher.sourceIds || []),
    ...(voucher.evidenceIds || []),
    ...(voucher.lines || []).flatMap((line) => line.sourceIds || []),
  ]));
  (workspace.transactions || []).filter((transaction) => periodOfRecord(transaction) === period).forEach((transaction) => periodSources.add(transaction.id));
  const reportVersion = latestPeriodReportVersion(workspace, period, archiveRecord);
  const frozenSnapshot = archiveRecord?.reportSnapshot
    || reportVersion?.snapshot
    || (reportVersion?.statements ? { statements: reportVersion.statements } : null);
  const liveStatementsResult = safelyBuildMonthlySnapshot(buildFinancialStatements, workspace, period);
  const managementResult = safelyBuildMonthlySnapshot(buildManagementMetrics, workspace, period);
  const taxResult = period === workspace.currentPeriod
    ? safelyBuildMonthlySnapshot(buildTaxWorkpaper, workspace, period)
    : { value: null, error: null };
  const liveStatements = liveStatementsResult.value;
  const financialStatements = {
    balanceSheet: reportSection(frozenSnapshot, reportVersion, liveStatements, "balanceSheet"),
    incomeStatement: reportSection(frozenSnapshot, reportVersion, liveStatements, "incomeStatement"),
    cashFlow: reportSection(frozenSnapshot, reportVersion, liveStatements, "cashFlow"),
  };
  const managementReport = frozenSnapshot?.sections?.owner
    || frozenSnapshot?.managementReport
    || frozenSnapshot?.management
    || managementResult.value;
  const taxWorkpaper = frozenSnapshot?.taxWorkpaper || reportVersion?.taxWorkpaper || taxResult.value;
  const filing = archiveRecord?.filing
    || ((workspace.delivery?.filing?.period || workspace.currentPeriod) === period ? workspace.delivery?.filing : null);
  const filingPackage = filing?.exportedPackage || archiveRecord?.package || null;
  const receipt = filing?.receipt || archiveRecord?.receipt || null;
  const archiveDocuments = archiveRecord?.documents || [];
  const receiptDocument = [...(workspace.documents || []), ...archiveDocuments]
    .find((document) => document.id === receipt?.documentId) || null;
  const confirmationState = archiveRecord?.confirmations || (period === workspace.currentPeriod ? workspace.tax || {} : {});
  const initialConfirmation = {
    id: filing?.initialConfirmationId || confirmationState.initialConfirmationId || null,
    financeConfirmedAt: confirmationState.financeConfirmedAt || null,
    payrollConfirmedAt: confirmationState.payrollConfirmedAt || null,
    financeConfirmedVersionId: confirmationState.financeConfirmedVersionId || null,
    payrollConfirmedVersionId: confirmationState.payrollConfirmedVersionId || null,
  };
  initialConfirmation.complete = Boolean(
    initialConfirmation.id
    && initialConfirmation.financeConfirmedAt
    && initialConfirmation.payrollConfirmedAt
    && initialConfirmation.financeConfirmedVersionId
    && initialConfirmation.payrollConfirmedVersionId
  );
  const finalConfirmation = {
    ownerConfirmedAt: confirmationState.ownerConfirmedAt || null,
    confirmedBy: confirmationState.confirmedBy || null,
    ownerConfirmedVersionId: confirmationState.ownerConfirmedVersionId || null,
    finalConfirmedVersionId: filing?.finalConfirmedVersionId || confirmationState.finalConfirmedVersionId || null,
  };
  finalConfirmation.complete = Boolean(
    finalConfirmation.ownerConfirmedAt
    && finalConfirmation.confirmedBy
    && finalConfirmation.ownerConfirmedVersionId
    && finalConfirmation.finalConfirmedVersionId
  );
  const confirmationPackages = archiveRecord?.confirmationPackages
    || (workspace.confirmations || []).filter((confirmation) => confirmation.period === period);
  const payroll = {
    period,
    payroll: taxWorkpaperValue(taxWorkpaper, "payroll"),
    socialSecurity: taxWorkpaperValue(taxWorkpaper, "socialSecurity"),
    payrollSourceIds: period === workspace.currentPeriod ? workspace.tax?.payrollSourceIds || [] : [],
    socialSecuritySourceIds: period === workspace.currentPeriod ? workspace.tax?.socialSecuritySourceIds || [] : [],
    documents: [...(workspace.documents || []), ...archiveDocuments].filter((document, index, all) => (
      all.findIndex((candidate) => candidate.id === document.id) === index
      && (!periodOfRecord(document) || periodOfRecord(document) === period)
      && /工资|薪资|社保|公积金/.test(`${document.category || document.type || ""} ${document.name || ""}`)
    )),
  };
  const archivedAttachmentPackages = archiveRecord?.attachmentPackages || [];
  const voucherAttachments = vouchers.map((voucher) => monthlyVoucherAttachmentManifest(
    workspace,
    voucher,
    archivedAttachmentPackages.find((item) => item.voucherId === voucher.id),
  ));
  const exceptionRecords = periodExceptionRecords(workspace, period, archiveRecord, periodSources);
  const notices = (workspace.delivery?.notices || []).filter((notice) => notice.period === period);
  const auditLog = periodAuditRecords(workspace, period, archiveRecord, periodSources);
  const reportChecks = frozenSnapshot?.summary?.engineChecks
    || reportVersion?.statements?.checks
    || liveStatements?.checks
    || {};
  const reportChecksPassed = Object.keys(reportChecks).length > 0
    && Object.values(reportChecks).every((check) => check?.passed !== false);
  const pendingVouchers = vouchers.filter((voucher) => !["posted", "superseded"].includes(voucher.status));
  const attachmentMissing = voucherAttachments.flatMap((attachment) => attachment.missingItems.map((item) => ({
    ...item,
    key: `voucher:${attachment.voucherId}:${item.key || item.label}`,
    label: `${attachment.voucherNo || attachment.voucherId} · ${item.label}`,
  })));
  const unresolvedExceptions = exceptionRecords.filter((record) => record.status !== "resolved");
  const unresolvedNotices = notices.filter((notice) => notice.status !== "resolved");
  const receiptLinksToPackage = Boolean(
    receipt
    && filingPackage
    && receipt.packageId === filingPackage.id
    && receipt.packageHash === filingPackage.hash
    && (!reportVersion || receipt.reportVersionId === reportVersion.id)
  );
  const checks = [
    { key: "vouchers", label: "本期凭证已全部复核入账", ok: pendingVouchers.length === 0, reason: pendingVouchers.length ? `${pendingVouchers.length} 张凭证仍是草稿或待更正状态` : "凭证与分录清单已形成" },
    { key: "voucherAttachments", label: "各凭证附件清单无缺件", ok: attachmentMissing.length === 0, reason: attachmentMissing.length ? `${attachmentMissing.length} 项凭证附件或记录缺失` : `${voucherAttachments.length} 张凭证均已形成附件清单` },
    { key: "reports", label: "三大报表已有冻结版本且勾稽通过", ok: Boolean(frozenSnapshot && Object.values(financialStatements).every(Boolean) && managementReport && reportChecksPassed), reason: frozenSnapshot ? (reportChecksPassed ? "冻结报表与管理报表可用" : "冻结报表勾稽未全部通过") : "本期没有冻结报表版本" },
    { key: "taxWorkpaper", label: "税务申报底稿已形成", ok: Boolean(taxWorkpaper && filing?.draftCreatedAt && filing?.draftVersionId), reason: filing?.draftCreatedAt ? "税务底稿可用" : "尚未生成本地税务申报底稿" },
    { key: "filingPackage", label: "本地申报包信息完整", ok: Boolean(filingPackage?.id && filingPackage?.hash && filingPackage?.reportVersionId), reason: filingPackage ? "本地申报包元数据可用" : "尚未导出本地申报包" },
    { key: "payroll", label: "工资社保数据已记录", ok: payroll.payroll !== undefined && payroll.socialSecurity !== undefined, reason: payroll.payroll !== undefined && payroll.socialSecurity !== undefined ? "工资与社保数值已进入底稿" : "缺少工资或社保数据快照" },
    { key: "initialConfirmation", label: "第一次客户确认记录完整", ok: initialConfirmation.complete, reason: initialConfirmation.complete ? "首次财务与工资社保确认已记录" : "缺少首次财务/工资社保确认时间、记录或版本关联" },
    { key: "finalConfirmation", label: "第二次最终责任确认记录完整", ok: finalConfirmation.complete, reason: finalConfirmation.complete ? "最终责任确认已记录" : "缺少最终确认人、时间或版本关联" },
    { key: "receipt", label: "真实回执与本地申报包关系有效", ok: Boolean(receiptLinksToPackage && receiptDocument?.hash && receiptDocument?.storage?.availableLocally), reason: !receipt ? "尚未导入真实办理回执" : (!receiptDocument?.storage?.availableLocally ? "回执索引存在，但当前浏览器没有原文件" : (receiptLinksToPackage ? "回执原文件及申报包关联可用" : "回执与本地申报包版本或哈希关系不一致")) },
    { key: "exceptions", label: "异常与跨期待办均已处理", ok: unresolvedExceptions.length === 0 && unresolvedNotices.length === 0, reason: unresolvedExceptions.length || unresolvedNotices.length ? `${unresolvedExceptions.length} 项异常、${unresolvedNotices.length} 项跨期待办未解决` : "当前没有未解决事项" },
    { key: "audit", label: "操作日志可追溯", ok: auditLog.length > 0 || vouchers.length === 0, reason: auditLog.length ? `${auditLog.length} 条期间相关日志` : (vouchers.length ? "本期存在凭证但没有可追溯操作日志" : "无业务期间的空日志清单") },
  ];
  const missingItems = uniqueMissingItems([
    ...checks.filter((check) => !check.ok).map((check) => ({ key: `check:${check.key}`, kind: "required_archive_item", sectionKey: check.key, label: check.label, reason: check.reason })),
    ...attachmentMissing,
    ...unresolvedExceptions.map((record) => ({ key: `exception:${record.id}`, kind: "unresolved_exception", sectionKey: "exceptions", label: record.message || record.code || record.id, reason: "异常尚未关闭" })),
    ...unresolvedNotices.map((notice) => ({ key: `notice:${notice.id}`, kind: "unresolved_notice", sectionKey: "exceptions", label: notice.title || notice.message || notice.id, reason: "跨期待办尚未关闭" })),
  ]);
  const checkByKey = new Map(checks.map((check) => [check.key, check]));
  const sections = [
    monthlySection(MONTHLY_FINANCIAL_ARCHIVE_SECTIONS[0], checkByKey.get("vouchers").ok ? "collected" : "missing", `${vouchers.length} 张凭证，${vouchers.reduce((sum, voucher) => sum + (voucher.lines || []).length, 0)} 条分录`, vouchers.length),
    monthlySection(MONTHLY_FINANCIAL_ARCHIVE_SECTIONS[1], checkByKey.get("voucherAttachments").ok ? "collected" : "missing", `${voucherAttachments.length} 份附件清单，缺失 ${attachmentMissing.length} 项`, voucherAttachments.length),
    monthlySection(MONTHLY_FINANCIAL_ARCHIVE_SECTIONS[2], checkByKey.get("reports").ok ? "collected" : "missing", reportVersion ? `${reportVersion.label || reportVersion.id} · 冻结快照` : "仅有即时草稿快照，未冻结"),
    monthlySection(MONTHLY_FINANCIAL_ARCHIVE_SECTIONS[3], checkByKey.get("taxWorkpaper").ok && checkByKey.get("filingPackage").ok ? "collected" : "missing", filingPackage?.fileName || "缺少本地申报包信息"),
    monthlySection(MONTHLY_FINANCIAL_ARCHIVE_SECTIONS[4], checkByKey.get("payroll").ok ? "collected" : "missing", `工资 ${payroll.payroll ?? "缺失"} · 社保 ${payroll.socialSecurity ?? "缺失"}`),
    monthlySection(MONTHLY_FINANCIAL_ARCHIVE_SECTIONS[5], initialConfirmation.complete && finalConfirmation.complete ? "collected" : "missing", `首次确认 ${initialConfirmation.complete ? "已完成" : "缺失"} · 最终确认 ${finalConfirmation.complete ? "已完成" : "缺失"}`),
    monthlySection(MONTHLY_FINANCIAL_ARCHIVE_SECTIONS[6], checkByKey.get("receipt").ok ? "collected" : "missing", receipt?.name || "尚未导入真实回执"),
    monthlySection(MONTHLY_FINANCIAL_ARCHIVE_SECTIONS[7], checkByKey.get("exceptions").ok ? "collected" : "missing", `${exceptionRecords.length} 条异常记录，未解决 ${unresolvedExceptions.length + unresolvedNotices.length} 项`, exceptionRecords.length),
    monthlySection(MONTHLY_FINANCIAL_ARCHIVE_SECTIONS[8], checkByKey.get("audit").ok ? "collected" : "missing", `${auditLog.length} 条期间相关日志`, auditLog.length),
    monthlySection(MONTHLY_FINANCIAL_ARCHIVE_SECTIONS[9], "pending_generation", "点击导出后为 ZIP 内每个文件生成哈希"),
  ];
  return {
    period,
    isComplete: missingItems.length === 0,
    status: missingItems.length ? "incomplete_draft" : "complete",
    archiveRecord,
    vouchers,
    voucherAttachments,
    reportVersion,
    frozenSnapshot,
    financialStatements,
    managementReport,
    reportBuildErrors: [liveStatementsResult.error, managementResult.error, taxResult.error].filter(Boolean),
    taxWorkpaper,
    filing,
    filingPackage,
    payroll,
    initialConfirmation,
    finalConfirmation,
    confirmationPackages,
    receipt,
    receiptDocument,
    exceptionRecords,
    notices,
    auditLog,
    checks,
    missingItems,
    sections,
  };
}

function archiveAuditCsv(entries) {
  const cell = (value) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows = [["时间", "操作者", "动作", "详情"], ...entries.map((entry) => [entry.at || entry.createdAt, entry.actor, entry.action, entry.detail])];
  return `\ufeff${rows.map((row) => row.map(cell).join(",")).join("\n")}`;
}

function monthlyAttachmentHashReferences(voucherAttachments) {
  const references = voucherAttachments.flatMap((attachment) => [
    ...(attachment.manifest?.documents || []).map((documentMetadata) => ({
      voucherId: attachment.voucherId,
      documentId: documentMetadata.id,
      name: documentMetadata.name,
      hash: documentMetadata.hash,
      referenceType: "attachment_manifest",
    })),
    ...(attachment.generatedPackages || []).flatMap((packageRecord) => (packageRecord.hashes || []).map((hash) => ({
      voucherId: attachment.voucherId,
      packageId: packageRecord.id,
      ...hash,
      referenceType: "generated_voucher_package",
    }))),
  ]).filter((reference) => reference.hash);
  return references.filter((reference, index, all) => all.findIndex((candidate) => (
    candidate.voucherId === reference.voucherId
    && candidate.documentId === reference.documentId
    && candidate.hash === reference.hash
  )) === index);
}

async function archiveContentDescriptor(path, content, mimeType = "application/json") {
  const bytes = content instanceof Uint8Array
    ? content
    : new TextEncoder().encode(String(content));
  const hash = await hashLocalFile(new Blob([bytes], { type: mimeType }));
  return {
    path,
    bytes,
    mimeType,
    size: bytes.byteLength,
    hash,
    hashAlgorithm: hash.startsWith("fnv1a-") ? "FNV-1a fallback" : "SHA-256",
  };
}

export async function generateMonthlyFinancialArchivePackage(input) {
  const { store, fileVault, workspaceId, period } = input;
  if (!store?.actions) throw new Error("生成月度财务档案包需要工作台 store");
  if (!fileVault) throw new Error("当前浏览器不支持本地文件保险箱，无法生成月度档案包");
  const workspace = store.getState().workspaces.find((item) => item.id === workspaceId);
  if (!workspace) throw new Error("找不到月度档案所属工作台");
  const plan = buildMonthlyFinancialArchivePlan(workspace, period);
  const generatedAt = input.at || new Date().toISOString();
  const generatedBy = input.actor
    || workspace.users?.find((user) => user.id === store.getState().activeUserId && user.status === "active")?.name
    || "本地用户";
  const packageId = input.packageId || createId("monthly-financial-archive");
  const runtimeMissing = [];
  let receiptDescriptor = null;
  if (plan.receipt && plan.receiptDocument?.storage?.availableLocally) {
    try {
      const record = await getStoredDocumentRecord({ fileVault, workspaceId, document: plan.receiptDocument });
      const bytes = new Uint8Array(await record.blob.arrayBuffer());
      receiptDescriptor = await archiveContentDescriptor(
        `07-真实回执/${safeZipName(record.name || plan.receiptDocument.name, "真实回执原文件")}`,
        bytes,
        record.mimeType || plan.receiptDocument.mimeType || "application/octet-stream",
      );
      const expectedHashes = [plan.receiptDocument.hash, plan.receipt.hash].filter(Boolean);
      if (expectedHashes.some((hash) => hash !== receiptDescriptor.hash)) throw new Error("真实回执原文件哈希与工作台记录不一致");
    } catch (error) {
      receiptDescriptor = null;
      runtimeMissing.push({
        key: "runtime:receipt-original",
        kind: "original_file",
        sectionKey: "receipt",
        documentId: plan.receiptDocument.id,
        label: plan.receiptDocument.name || "真实回执原文件",
        reason: error.message || "当前浏览器无法读取真实回执原文件",
      });
    }
  }
  const missingItems = uniqueMissingItems([...plan.missingItems, ...runtimeMissing]);
  const isComplete = missingItems.length === 0;
  const status = isComplete ? "complete" : "incomplete_draft";
  const statusLabel = isComplete ? "完整财务档案" : "不完整财务档案草稿";
  const fileName = safeZipName(`FinanceDesk-${workspace.name}-${plan.period}-${statusLabel}.zip`, `FinanceDesk-${plan.period}-${statusLabel}.zip`);
  const manifest = {
    packageId,
    product: "FinanceDesk",
    workspace: { id: workspace.id, name: workspace.name },
    period: plan.period,
    generatedAt,
    generatedBy,
    status,
    isComplete,
    localOnly: true,
    externalUpload: false,
    officialPeriodArchiveChanged: false,
    sections: plan.sections.map((section) => section.key === "receipt" && runtimeMissing.length
      ? { ...section, status: "missing", detail: runtimeMissing[0].reason }
      : section),
    checks: plan.checks,
    missingItems,
    hashManifest: "统一哈希清单.json",
  };
  const contents = [
    await archiveContentDescriptor("01-凭证与分录/凭证与分录.json", jsonFile({ period: plan.period, vouchers: plan.vouchers })),
    await archiveContentDescriptor("02-凭证附件/附件包与附件清单.json", jsonFile({ period: plan.period, vouchers: plan.voucherAttachments })),
    await archiveContentDescriptor("03-财务与管理报表/资产负债表.json", jsonFile(plan.financialStatements.balanceSheet)),
    await archiveContentDescriptor("03-财务与管理报表/利润表.json", jsonFile(plan.financialStatements.incomeStatement)),
    await archiveContentDescriptor("03-财务与管理报表/现金流量表.json", jsonFile(plan.financialStatements.cashFlow)),
    await archiveContentDescriptor("03-财务与管理报表/管理报表.json", jsonFile(plan.managementReport)),
    await archiveContentDescriptor("03-财务与管理报表/冻结版本与原始快照.json", jsonFile({ reportVersion: plan.reportVersion, frozenSnapshot: plan.frozenSnapshot, buildErrors: plan.reportBuildErrors })),
    await archiveContentDescriptor("04-税务申报/税务申报底稿.json", jsonFile(plan.taxWorkpaper)),
    await archiveContentDescriptor("04-税务申报/本地申报包信息.json", jsonFile({ filing: plan.filing, exportedPackage: plan.filingPackage, disclaimer: "本地申报包信息不代表已连接或提交至税务局。" })),
    await archiveContentDescriptor("05-工资社保/工资与社保数据.json", jsonFile(plan.payroll)),
    await archiveContentDescriptor("06-客户确认/第一次客户确认.json", jsonFile(plan.initialConfirmation)),
    await archiveContentDescriptor("06-客户确认/第二次最终确认.json", jsonFile(plan.finalConfirmation)),
    await archiveContentDescriptor("06-客户确认/客户确认包记录.json", jsonFile(plan.confirmationPackages)),
    await archiveContentDescriptor("07-真实回执/回执信息.json", jsonFile(plan.receipt)),
    await archiveContentDescriptor("08-异常处理/异常处理记录.json", jsonFile({ exceptions: plan.exceptionRecords, notices: plan.notices })),
    await archiveContentDescriptor("09-操作日志/操作日志.json", jsonFile(plan.auditLog)),
    await archiveContentDescriptor("09-操作日志/操作日志.csv", archiveAuditCsv(plan.auditLog), "text/csv"),
    await archiveContentDescriptor("档案包清单.json", jsonFile(manifest)),
  ];
  if (receiptDescriptor) contents.push(receiptDescriptor);
  const hashManifest = {
    packageId,
    period: plan.period,
    generatedAt,
    algorithm: contents.every((item) => item.hashAlgorithm === "SHA-256") ? "SHA-256" : "per-entry; see hashAlgorithm",
    files: contents.map(({ path, mimeType, size, hash, hashAlgorithm }) => ({ path, mimeType, size, hash, hashAlgorithm })),
    referencedAttachmentOriginals: monthlyAttachmentHashReferences(plan.voucherAttachments),
    selfExcluded: "统一哈希清单.json 为避免循环校验，不包含自身哈希。",
  };
  const hashDescriptor = await archiveContentDescriptor("统一哈希清单.json", jsonFile(hashManifest));
  const Zip = input.Zip || (await import("jszip")).default;
  const zip = new Zip();
  [...contents, hashDescriptor].forEach((item) => zip.file(item.path, item.bytes));
  const archive = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const archiveHash = await hashLocalFile(archive);
  const packageRecord = {
    id: packageId,
    period: plan.period,
    status,
    isComplete,
    fileName,
    size: archiveByteLength(archive),
    hash: archiveHash,
    missingItems,
    generatedAt,
    generatedBy,
    localOnly: true,
    externalUpload: false,
    officialPeriodArchiveChanged: false,
  };
  const latestWorkspace = store.getState().workspaces.find((item) => item.id === workspaceId);
  if (!latestWorkspace) throw new Error("档案包生成期间工作台已不存在，未写入导出记录");
  store.actions.replaceWorkspace(workspaceId, {
    ...latestWorkspace,
    delivery: {
      ...latestWorkspace.delivery,
      financialArchiveExports: [...(latestWorkspace.delivery?.financialArchiveExports || []), packageRecord],
    },
  }, {
    allowArchivedTransition: true,
    requiredPermission: "data.read",
    audit: {
      actor: generatedBy,
      action: isComplete ? "导出完整月度财务档案包" : "导出不完整月度财务草稿包",
      detail: `${plan.period} · ${fileName} · 缺失 ${missingItems.length} 项 · 仅本地下载`,
    },
  });
  if (input.download !== false) downloadLocalArchive(archive, fileName);
  return { archive, fileName, manifest, hashManifest, packageRecord };
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
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
