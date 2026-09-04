import {
  EVENT_TYPES,
  accountingRules,
  appendAuditEntry,
  cloneAccountingState,
  collectSourceIds,
  nextRecordId,
  operationContext,
  roundMoney,
} from "../../domain/accounting/model.js";
import { classifyBankTransaction } from "../../domain/accounting/classification.js";

const DOCUMENT_TYPE_ALIASES = {
  bankStatement: ["bankstatement", "银行流水", "银行回单", "回单"],
  invoice: ["invoice", "发票", "数电发票"],
  contract: ["contract", "合同", "会员协议", "协议"],
  order: ["order", "订单", "销售单", "课程订单", "业务账单"],
  settlement: ["settlement", "结算单", "平台账单", "对账单"],
  approval: ["approval", "审批单", "审批记录", "付款申请", "退款申请"],
  purchaseOrder: ["purchaseorder", "采购单", "入库单"],
  attendance: ["attendance", "签到", "耗课记录", "服务记录"],
  payroll: ["payroll", "工资表", "薪资表"],
  socialSecurity: ["socialsecurity", "社保表", "社保数据"],
  refundBasis: ["refundbasis", "退款单", "退款申请", "原充值记录"],
  transferReceipt: ["transferreceipt", "内部转账回单", "转账回单"],
};

export const DEFAULT_EVIDENCE_REQUIREMENTS = Object.freeze({
  [EVENT_TYPES.CUSTOMER_RECEIPT]: [
    { id: "bank", label: "银行流水", anyOf: ["bankStatement"] },
    { id: "business", label: "合同、订单、发票或结算单", anyOf: ["contract", "order", "invoice", "settlement"] },
  ],
  [EVENT_TYPES.MEMBER_RECHARGE]: [
    { id: "bank", label: "银行流水", anyOf: ["bankStatement"] },
    { id: "memberAgreement", label: "会员协议或充值订单", anyOf: ["contract", "order"] },
  ],
  [EVENT_TYPES.MEMBER_CONSUMPTION]: [
    { id: "service", label: "签到或服务完成记录", anyOf: ["attendance"] },
    { id: "memberAgreement", label: "会员协议或订单", anyOf: ["contract", "order"] },
  ],
  [EVENT_TYPES.SUPPLIER_SETTLEMENT]: [
    { id: "bank", label: "银行流水", anyOf: ["bankStatement"] },
    { id: "purchase", label: "采购单或合同", anyOf: ["purchaseOrder", "contract"] },
    { id: "invoice", label: "采购发票", anyOf: ["invoice"] },
    { id: "approval", label: "付款审批", anyOf: ["approval"] },
  ],
  [EVENT_TYPES.SUPPLIER_PREPAYMENT]: [
    { id: "bank", label: "银行流水", anyOf: ["bankStatement"] },
    { id: "purchase", label: "采购单或合同", anyOf: ["purchaseOrder", "contract"] },
    { id: "approval", label: "付款审批", anyOf: ["approval"] },
  ],
  [EVENT_TYPES.PURCHASE_EXPENSE]: [
    { id: "bank", label: "银行流水", anyOf: ["bankStatement"] },
    { id: "invoice", label: "发票", anyOf: ["invoice"] },
    { id: "approval", label: "付款审批", anyOf: ["approval"] },
  ],
  [EVENT_TYPES.PAYROLL]: [
    { id: "bank", label: "银行流水", anyOf: ["bankStatement"] },
    { id: "payroll", label: "工资表", anyOf: ["payroll"] },
  ],
  [EVENT_TYPES.RENT_AND_PROPERTY]: [
    { id: "bank", label: "银行流水", anyOf: ["bankStatement"] },
    { id: "contract", label: "租赁合同", anyOf: ["contract"] },
    { id: "invoice", label: "租金或物业发票", anyOf: ["invoice"] },
  ],
  [EVENT_TYPES.BANK_FEE]: [
    { id: "bank", label: "银行流水或回单", anyOf: ["bankStatement"] },
  ],
  [EVENT_TYPES.LOAN]: [
    { id: "bank", label: "银行流水", anyOf: ["bankStatement"] },
    { id: "contract", label: "借款合同或审批", anyOf: ["contract", "approval"] },
  ],
  [EVENT_TYPES.EMPLOYEE_ADVANCE]: [
    { id: "bank", label: "银行流水", anyOf: ["bankStatement"] },
    { id: "approval", label: "报销或代垫审批", anyOf: ["approval"] },
    { id: "invoice", label: "发票", anyOf: ["invoice"] },
  ],
  [EVENT_TYPES.RELATED_PARTY]: [
    { id: "bank", label: "银行流水", anyOf: ["bankStatement"] },
    { id: "approval", label: "负责人确认或审批", anyOf: ["approval"] },
  ],
  [EVENT_TYPES.REFUND]: [
    { id: "bank", label: "银行流水", anyOf: ["bankStatement"] },
    { id: "refund", label: "退款申请及原业务依据", anyOf: ["refundBasis", "approval"] },
  ],
  [EVENT_TYPES.INTERNAL_TRANSFER]: [
    { id: "bank", label: "转出流水", anyOf: ["bankStatement"] },
    { id: "counterpart", label: "转入账户或回单", anyOf: ["internalCounterpart", "transferReceipt"] },
  ],
  [EVENT_TYPES.UNKNOWN]: [],
});

function normalizeDocumentType(document) {
  const value = `${document?.type || ""}${document?.category || ""}`.toLowerCase().replace(/[\s·_-]+/g, "");
  return Object.entries(DOCUMENT_TYPE_ALIASES)
    .filter(([, aliases]) => aliases.some((alias) => value.includes(alias)))
    .map(([type]) => type);
}

function evidenceInventory(workspace, transaction, classification) {
  const linkedIds = collectSourceIds(transaction.evidenceIds || [], transaction.documentIds || []);
  const documents = (workspace.documents || []).filter((document) => linkedIds.includes(document.id));
  const types = new Set(documents.flatMap(normalizeDocumentType));
  if (transaction.id) types.add("bankStatement");
  if (classification.counterpartAccountId || transaction.counterpartTransactionId) types.add("internalCounterpart");
  return { linkedIds, documents, types };
}

function requirementsFor(workspace, eventType) {
  const custom = accountingRules(workspace).evidenceRequirements?.[eventType];
  return custom || DEFAULT_EVIDENCE_REQUIREMENTS[eventType] || [];
}

export function assessTransactionEvidence(workspace, transaction, classificationInput) {
  const classification = classificationInput || transaction.classification || classifyBankTransaction(workspace, transaction);
  const requirements = requirementsFor(workspace, classification.eventType);
  const inventory = evidenceInventory(workspace, transaction, classification);
  const groups = requirements.map((requirement) => {
    const matchedTypes = requirement.anyOf.filter((type) => inventory.types.has(type));
    return { ...requirement, satisfied: matchedTypes.length > 0, matchedTypes };
  });
  const satisfied = groups.filter((group) => group.satisfied).length;
  const completeness = groups.length ? roundMoney((satisfied / groups.length) * 100) : 0;
  const missing = groups.filter((group) => !group.satisfied).map((group) => ({ id: group.id, label: group.label }));
  const rules = accountingRules(workspace);
  const issues = [];
  if (classification.eventType === EVENT_TYPES.UNKNOWN) issues.push({ code: "unknown_business", message: "业务性质尚未确认" });
  if (classification.confidence < rules.confidenceThreshold) {
    issues.push({ code: "low_confidence", message: `匹配置信度 ${classification.confidence}% 低于 ${rules.confidenceThreshold}%` });
  }
  if (missing.length) issues.push({ code: "missing_evidence", message: `缺少：${missing.map((item) => item.label).join("、")}` });
  if (classification.riskFlags.includes("responsible_person_confirmation")) {
    issues.push({ code: "responsible_person_confirmation", message: "该事项需要负责人确认" });
  }
  if (classification.riskFlags.includes("transfer_counterpart_missing")) {
    issues.push({ code: "transfer_counterpart_missing", message: "内部转账尚未找到对端账户" });
  }

  const automaticThreshold = rules.automaticPostingThreshold;
  return {
    eventType: classification.eventType,
    required: groups,
    linkedDocumentIds: inventory.linkedIds,
    completeness,
    missing,
    issues,
    assessedAt: null,
    canCreateDraft: classification.eventType !== EVENT_TYPES.UNKNOWN,
    canAutomaticallyPost: issues.length === 0 && completeness === 100 && classification.confidence >= automaticThreshold,
  };
}

function exceptionIdentity(transactionId, issueCode) {
  return `${transactionId}:${issueCode}`;
}

function syncExceptionTasks(workspace, transaction, assessment, context) {
  const tasks = workspace.exceptionTasks || (workspace.exceptionTasks = []);
  const activeCodes = new Set(assessment.issues.map((issue) => issue.code));

  assessment.issues.forEach((issue) => {
    const identity = exceptionIdentity(transaction.id, issue.code);
    const existing = tasks.find((task) => task.identity === identity && task.status !== "resolved");
    if (existing) {
      existing.message = issue.message;
      existing.updatedAt = context.at;
      existing.status = "open";
      existing.missingEvidence = issue.code === "missing_evidence" ? assessment.missing : [];
      return;
    }
    tasks.push({
      id: nextRecordId(tasks, "exception"),
      identity,
      code: issue.code,
      sourceType: "bankTransaction",
      sourceId: transaction.id,
      message: issue.message,
      missingEvidence: issue.code === "missing_evidence" ? assessment.missing : [],
      status: "open",
      createdAt: context.at,
      updatedAt: context.at,
      sourceIds: collectSourceIds(transaction.id, transaction.evidenceIds || []),
      history: [{ at: context.at, actor: context.actor, action: "created", note: issue.message }],
    });
  });

  tasks.filter((task) => task.sourceId === transaction.id && task.status === "open" && !activeCodes.has(task.code))
    .forEach((task) => {
      task.status = "ready_for_review";
      task.updatedAt = context.at;
      task.history.push({ at: context.at, actor: context.actor, action: "evidence_completed", note: "阻碍条件已消失，等待人工确认回流" });
    });
}

export function reviewTransactionEvidence(workspace, transactionId, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext({ ...context, mode: context.mode || "local-rule" });
  const transaction = (next.transactions || []).find((item) => item.id === transactionId);
  if (!transaction) throw new Error(`找不到银行流水：${transactionId}`);

  const before = { status: transaction.status, classification: transaction.classification, evidenceAssessment: transaction.evidenceAssessment };
  const classification = classifyBankTransaction(next, transaction);
  const assessment = {
    ...assessTransactionEvidence(next, transaction, classification),
    assessedAt: resolvedContext.at,
  };
  transaction.classification = classification;
  transaction.evidenceAssessment = assessment;
  if (assessment.issues.length) transaction.status = "exception";
  else if (!["reconciled", "posted"].includes(transaction.status)) transaction.status = "pending";
  syncExceptionTasks(next, transaction, assessment, resolvedContext);
  appendAuditEntry(next, {
    action: "evidence.review",
    entityType: "bankTransaction",
    entityId: transaction.id,
    detail: assessment.issues.length ? assessment.issues.map((issue) => issue.message).join("；") : "证据与置信度检查通过",
    before,
    after: { status: transaction.status, classification, evidenceAssessment: assessment },
    sourceIds: collectSourceIds(transaction.id, assessment.linkedDocumentIds),
  }, resolvedContext);
  return next;
}

export function attachEvidenceDocument(workspace, { transactionId, documentId }, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const transaction = (next.transactions || []).find((item) => item.id === transactionId);
  const document = (next.documents || []).find((item) => item.id === documentId);
  if (!transaction) throw new Error(`找不到银行流水：${transactionId}`);
  if (!document) throw new Error(`找不到资料：${documentId}`);
  const before = [...(transaction.evidenceIds || [])];
  transaction.evidenceIds = collectSourceIds(before, documentId);
  appendAuditEntry(next, {
    action: "evidence.attach",
    entityType: "bankTransaction",
    entityId: transaction.id,
    detail: `关联资料「${document.name || document.title || document.id}」`,
    before,
    after: transaction.evidenceIds,
    sourceIds: [transaction.id, document.id],
  }, resolvedContext);
  return reviewTransactionEvidence(next, transactionId, resolvedContext);
}

export function recordManualConfirmation(workspace, {
  transactionId,
  decision,
  reason,
  resolvedCodes,
}, context = {}) {
  if (!reason?.trim()) throw new Error("人工确认必须填写判断依据");
  if (!["approve", "reject"].includes(decision)) throw new Error("人工确认 decision 只能是 approve 或 reject");
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const transaction = (next.transactions || []).find((item) => item.id === transactionId);
  if (!transaction) throw new Error(`找不到银行流水：${transactionId}`);
  const codes = new Set(resolvedCodes || (next.exceptionTasks || [])
    .filter((task) => task.sourceId === transactionId && task.status !== "resolved")
    .map((task) => task.code));
  const confirmation = {
    id: nextRecordId(transaction.manualConfirmations || [], "confirmation"),
    at: resolvedContext.at,
    actor: resolvedContext.actor,
    decision,
    reason: reason.trim(),
    resolvedCodes: [...codes],
  };
  transaction.manualConfirmations = [...(transaction.manualConfirmations || []), confirmation];
  transaction.manualConfirmation = confirmation;
  transaction.status = decision === "approve" ? "pending" : "exception";

  (next.exceptionTasks || []).filter((task) => (
    task.sourceId === transactionId && task.status !== "resolved" && codes.has(task.code)
  )).forEach((task) => {
    task.status = decision === "approve" ? "resolved" : "open";
    task.resolution = decision === "approve" ? "manual_override" : "rejected";
    task.resolvedAt = decision === "approve" ? resolvedContext.at : null;
    task.resolvedBy = decision === "approve" ? resolvedContext.actor : null;
    task.updatedAt = resolvedContext.at;
    task.history.push({ at: resolvedContext.at, actor: resolvedContext.actor, action: decision, note: reason.trim() });
  });

  appendAuditEntry(next, {
    action: `evidence.manual_${decision}`,
    entityType: "bankTransaction",
    entityId: transaction.id,
    detail: reason.trim(),
    after: confirmation,
    sourceIds: collectSourceIds(transaction.id, transaction.evidenceIds || []),
  }, resolvedContext);
  return next;
}

export function unresolvedExceptionTasks(workspace, sourceId) {
  return (workspace.exceptionTasks || []).filter((task) => (
    task.status !== "resolved" && (!sourceId || task.sourceId === sourceId)
  ));
}

export function canManuallyPostTransaction(workspace, transaction) {
  const open = unresolvedExceptionTasks(workspace, transaction.id);
  return open.length === 0 && Boolean(transaction.evidenceAssessment?.canCreateDraft);
}
