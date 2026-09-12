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
  const linkedIds = collectSourceIds(transaction.evidenceIds, transaction.documentIds, transaction.sourceDocumentId,
    (transaction.allocations || []).filter((allocation) => ["confirmed", "posted"].includes(allocation.status)).map((allocation) => {
      const bill = (workspace.bills || []).find((item) => item.id === allocation.billId);
      return collectSourceIds(allocation.evidenceIds, bill?.evidenceIds, bill?.documentIds);
    }));
  const documents = (workspace.documents || []).filter((document) => linkedIds.includes(document.id));
  const types = new Set(documents.flatMap(normalizeDocumentType));
  if (transaction.counterpartTransactionId && (workspace.transactions || []).some((other) => other.id === transaction.counterpartTransactionId)) types.add("internalCounterpart");
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
  inventory.linkedIds.forEach((id) => {
    const document = inventory.documents.find((item) => item.id === id);
    if (!document || ["deleted", "voided", "cancelled"].includes(document.status) || !document.hash || !document.storage?.availableLocally || Number(document.size) <= 0) {
      issues.push({ code: "original_unavailable", message: `资料 ${document?.name || id} 缺少可核验本地原件，请补回原文件` });
    }
  });
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

export const MANUAL_VOUCHER_BASIS_KINDS = Object.freeze({
  business: "业务凭证",
  adjustment: "更正 / 调整",
  accrual: "暂估",
  closing: "结转",
});

export function manualVoucherSourceOptions(workspace) {
  const labels = { transactions: "银行流水", businessEvents: "业务事件", bills: "往来账单", contracts: "合同", invoices: "发票", approvals: "审批单", inventoryItems: "库存物料", inventoryMovements: "库存流水", payrollRecords: "工资社保记录", payrollImports: "工资社保导入" };
  const records = Object.entries(labels).flatMap(([collection, label]) => (workspace[collection] || [])
    .filter((record) => !["deleted", "voided", "cancelled", "reversed", "rejected", "withdrawn"].includes(record.status)
      && record.voidStatus !== "voided")
    .map((record) => ({
      id: record.id,
      label: `${label} · ${record.no || record.businessEventNo || record.summary || record.name || (record.itemName && `${record.date} ${record.itemName} ${record.typeLabel || ""}`) || record.id}`,
      record,
    })));
  return [...records, ...(workspace.transactions || []).flatMap((transaction) => (transaction.allocations || [])
    .filter((allocation) => ["confirmed", "posted"].includes(allocation.status))
    .map((allocation) => ({ id: allocation.id, label: `核销 · ${transaction.counterparty || transaction.date} · ${allocation.billId}`, record: allocation })))];
}

export function assessManualVoucherEvidence(workspace, voucher) {
  const issues = [];
  const add = (code, message) => issues.push({ code, message });
  const basis = voucher.basis || {};
  const kind = basis.kind || "business";
  const sourceIds = collectSourceIds(voucher.sourceIds, (voucher.lines || []).map((line) => line.sourceIds));
  const options = manualVoucherSourceOptions(workspace);
  const plan = voucher.reconciliationCorrection;
  if (plan?.status === "pending" && options.some((option) => option.id === plan.originalAllocation.id)
    && (workspace.bills || []).some((bill) => bill.id === plan.replacement.billId)) {
    options.push({ id: plan.replacement.id, record: plan.replacement });
  }
  const sources = sourceIds.map((id) => options.find((option) => option.id === id));
  const invalidSources = sourceIds.filter((id, index) => !sources[index]);
  if (invalidSources.length) add("voucher_source_invalid", `来源已不存在或不属于有效业务记录：${invalidSources.join("、")}；请载入草稿重新选择`);
  if (voucher.inventoryMovementId) {
    const movement = (workspace.inventoryMovements || []).find((item) => item.id === voucher.inventoryMovementId);
    const item = (workspace.inventoryItems || []).find((item) => item.id === movement?.itemId);
    const inventoryItemIds = sourceIds.filter((id) => (workspace.inventoryItems || []).some((item) => item.id === id));
    if (!movement || !item || !["loss", "stockLoss"].includes(movement.type)
      || !sourceIds.includes(movement.id) || !sourceIds.includes(item.id)
      || inventoryItemIds.some((id) => id !== item.id)
      || (voucher.lines || []).some((line) => !line.sourceIds?.includes(movement.id) || !line.sourceIds?.includes(item.id))) {
      add("voucher_inventory_source_invalid", "库存损耗凭证的流水、物料与分录关联不一致；请依据正确的库存流水重新生成草稿");
    }
    if (movement && !inventoryVoucherAmountMatches(voucher, movement)) {
      add("voucher_inventory_amount_changed", `库存成本已变化：当前损耗 ${roundMoney(movement.amount).toFixed(2)} 元，凭证金额已过期；请在库存页按当前成本更新草稿或创建更正`);
    }
  }
  const referenceIds = collectSourceIds(basis.voucherIds, voucher.revisionOf);
  const references = referenceIds.map((id) => (workspace.vouchers || []).find((item) => (
    item.id === id && item.id !== voucher.id && ["posted", "superseded"].includes(item.status)
    && !item.voidedAt && !item.cancelledAt
  )));
  if (references.some((item) => !item)) add("voucher_reference_invalid", "原凭证不存在、未入账或已作废；请重新选择可追溯的已入账凭证");
  if (!Object.hasOwn(MANUAL_VOUCHER_BASIS_KINDS, kind)) add("voucher_basis_invalid", "请选择业务、调整、暂估或结转依据");
  if (kind === "business" && !sources.some(Boolean) && !voucher.revisionOf) {
    add("voucher_source_missing", "尚未关联业务来源；请在分录中选择当前工作台的业务记录");
  }
  if (kind !== "business" && !String(basis.description || "").trim()) {
    add("voucher_calculation_missing", "请填写调整或计算说明，并关联原凭证或上传计算文件");
  }
  if (kind !== "business" && !references.some(Boolean) && !basis.calculationDocumentId) {
    add("voucher_basis_missing", "请关联已入账原凭证或选择已上传的计算文件；仅填写说明不能作为入账依据");
  }

  const documentIds = new Set(collectSourceIds(voucher.evidenceIds, basis.calculationDocumentId));
  const visited = new Set([voucher.id]);
  function addReferenceDocuments(reference) {
    if (!reference || visited.has(reference.id)) return;
    visited.add(reference.id);
    collectSourceIds(reference.evidenceIds, reference.basis?.calculationDocumentId).forEach((id) => documentIds.add(id));
    collectSourceIds(reference.basis?.voucherIds, reference.revisionOf).forEach((id) => {
      addReferenceDocuments((workspace.vouchers || []).find((item) => item.id === id && ["posted", "superseded"].includes(item.status)));
    });
  }
  if (!documentIds.size) {
    references.forEach(addReferenceDocuments);
    sources.filter(Boolean).forEach(({ record }) => {
      collectSourceIds(record.evidenceIds, record.documentIds, record.documentId, record.sourceDocumentId).forEach((id) => documentIds.add(id));
    });
  }
  const documents = [...documentIds].map((id) => (workspace.documents || []).find((document) => document.id === id));
  if (!documents.length) add("voucher_original_missing", "尚无原始依据；请上传并关联原始资料或计算文件，也可沿原凭证补齐依据");
  [...documentIds].forEach((id, index) => {
    const document = documents[index];
    if (!document || ["deleted", "voided", "cancelled"].includes(document.status) || document.voidStatus === "voided") {
      add(`voucher_document_missing:${id}`, `资料 ${id} 不存在或已作废；请取消此关联并补充有效原件`);
    } else if (!document.hash || !document.storage?.availableLocally || Number(document.size) <= 0) {
      add(`voucher_original_unavailable:${id}`, `${document.name || id} 缺少本地原文件；请重新上传并选择原件`);
    }
  });
  return { complete: issues.length === 0, issues, sourceIds, referenceIds, documents: documents.filter(Boolean), documentIds: [...documentIds] };
}

export function syncManualVoucherEvidenceTasks(workspace, voucher, context, extraIssues = []) {
  const assessment = assessManualVoucherEvidence(workspace, voucher);
  const issues = [...assessment.issues, ...extraIssues];
  voucher.blockers = issues;
  const identity = `voucher:${voucher.id}:evidence`;
  const tasks = workspace.exceptionTasks || (workspace.exceptionTasks = []);
  let task = tasks.find((item) => item.identity === identity && item.status !== "resolved");
  if (issues.length) {
    if (!task) {
      task = { id: nextRecordId(tasks, "exception"), identity, code: "voucher_evidence", sourceType: "voucher", sourceId: voucher.id, period: voucher.period, createdAt: context.at, history: [] };
      tasks.push(task);
    }
    task.status = "open";
    task.message = issues.map((issue) => issue.message).join("；");
    task.action = "complete_voucher_evidence";
    task.sourceIds = collectSourceIds(voucher.id, assessment.sourceIds, assessment.referenceIds, assessment.documentIds);
    task.updatedAt = context.at;
    task.history.push({ at: context.at, actor: context.actor, action: "needs_evidence", note: task.message });
  } else if (task) {
    task.status = "resolved";
    task.resolvedAt = context.at;
    task.resolvedBy = context.actor;
    task.updatedAt = context.at;
    task.history.push({ at: context.at, actor: context.actor, action: "evidence_completed", note: "草稿来源与资料已补齐，入账时仍须读取原件并复核" });
  }
  return assessment;
}

export function recordManualVoucherEvidenceFailure(workspace, voucherId, message, context = {}) {
  const next = cloneAccountingState(workspace);
  const voucher = (next.vouchers || []).find((item) => item.id === voucherId);
  if (!voucher || !["draft", "changes_requested"].includes(voucher.status)) return next;
  const resolvedContext = operationContext(context);
  if (voucher.sourceType === "manual" || voucher.judgement?.eventType === "manualVoucher") {
    syncManualVoucherEvidenceTasks(next, voucher, resolvedContext, [{ code: "voucher_original_verification", message }]);
  } else {
    syncVoucherEvidenceTasks(next, voucher, resolvedContext, [{ code: "voucher_original_verification", message }]);
  }
  appendAuditEntry(next, { action: "voucher.evidence_missing", entityType: "voucher", entityId: voucher.id, detail: message, sourceIds: collectSourceIds(voucher.id, voucher.evidenceIds) }, resolvedContext);
  return next;
}

export function inventoryVoucherAmountMatches(voucher, movement) {
  const amount = roundMoney(movement?.amount);
  const debit = roundMoney((voucher.lines || []).reduce((total, line) => total + Number(line.debit || 0), 0));
  const credit = roundMoney((voucher.lines || []).reduce((total, line) => total + Number(line.credit || 0), 0));
  const inventoryCredit = roundMoney((voucher.lines || []).filter((line) => line.account === "inventory")
    .reduce((total, line) => total + Number(line.credit || 0) - Number(line.debit || 0), 0));
  return (amount > 0 || (amount === 0 && voucher.revisionOf)) && debit === amount && credit === amount && inventoryCredit === amount;
}

export function assessInventoryVoucherIntegrity(workspace, { period = workspace.currentPeriod } = {}) {
  const issues = (workspace.vouchers || []).filter((voucher) => voucher.status === "posted" && voucher.inventoryMovementId
    && (!period || voucher.period === period)).flatMap((voucher) => {
    const movement = (workspace.inventoryMovements || []).find((item) => item.id === voucher.inventoryMovementId);
    return movement && inventoryVoucherAmountMatches(voucher, movement) ? [] : [{
      code: "inventory_posted_cost_changed", voucherId: voucher.id, movementId: voucher.inventoryMovementId,
      message: `库存损耗 ${movement?.id || voucher.inventoryMovementId} 的当前成本与已入账凭证 ${voucher.no || voucher.id} 不一致；原凭证金额保留，请按当前成本更正后再确认报表`,
      sourceIds: collectSourceIds(voucher.id, movement?.id, movement?.itemId),
    }];
  });
  return { passed: issues.length === 0, issues, sourceIds: collectSourceIds(issues.map((issue) => issue.sourceIds)) };
}

export function syncInventoryVoucherIntegrityTasks(workspace, context) {
  const assessment = assessInventoryVoucherIntegrity(workspace);
  const tasks = workspace.exceptionTasks || (workspace.exceptionTasks = []);
  const active = new Set(assessment.issues.map((issue) => issue.voucherId));
  assessment.issues.forEach((issue) => {
    const identity = `inventory-cost:${issue.voucherId}`;
    let task = tasks.find((item) => item.identity === identity);
    if (!task) { task = { id: nextRecordId(tasks, "exception"), identity, createdAt: context.at, history: [] }; tasks.push(task); }
    Object.assign(task, { code: issue.code, sourceType: "voucher", sourceId: issue.voucherId, sourceIds: issue.sourceIds,
      period: workspace.currentPeriod, status: "open", message: issue.message, action: "correct_inventory_cost", updatedAt: context.at });
  });
  tasks.filter((task) => task.code === "inventory_posted_cost_changed" && task.period === workspace.currentPeriod && !active.has(task.sourceId) && task.status !== "resolved")
    .forEach((task) => { task.status = "resolved"; task.resolvedAt = context.at; task.resolvedBy = context.actor; task.resolution = "inventory_cost_corrected"; });
  return assessment;
}

// Follow explicit source IDs only. A bank allocation never expands into unrelated sibling allocations.
export function voucherEvidenceSources(workspace, voucher) {
  const collections = ["transactions", "businessEvents", "bills", "contracts", "invoices", "approvals", "inventoryMovements", "inventoryItems", "payrollRecords", "payrollImports", "bankImports", "advanceApplications", "members", "membershipPackages", "stores", "personnelRecords"];
  const records = new Map(collections.flatMap((collection) => (workspace[collection] || []).map((record) => [record.id, { collection, record }])));
  (workspace.transactions || []).forEach((transaction) => (transaction.allocations || []).forEach((record) => records.set(record.id, { collection: "allocations", record, transaction })));
  (workspace.transactions || []).forEach((transaction) => (transaction.refundLinks || []).forEach((record) => records.set(record.id, { collection: "refundLinks", record, transaction })));
  const roots = collectSourceIds(voucher.sourceIds, (voucher.lines || []).map((line) => line.sourceIds), voucher.memberEventId, voucher.bankBusinessEventId, voucher.inventoryMovementId, voucher.advanceApplicationId);
  const bankEvent = (workspace.businessEvents || []).find((event) => event.id === voucher.bankBusinessEventId
    && event.sourceType === "bankTransaction" && event.status === "confirmed"
    && (workspace.transactions || []).some((transaction) => transaction.id === event.transactionId && transaction.id === voucher.transactionId));
  const localEntityIds = collectSourceIds(voucher.transactionId, voucher.memberEventId, voucher.bankBusinessEventId, voucher.inventoryMovementId,
    voucher.advanceApplicationId, bankEvent?.relatedBillId, bankEvent?.relatedTransactionId);
  // referenceNo is an external business number, not a local order entity. Only
  // its explicit, unchanged order_contract reference on a real confirmed event
  // has that meaning; this must not exempt missing bills, transactions or files.
  const externalReferenceIds = new Set((voucher.businessReferences || []).filter((reference) => reference.kind === "order_contract"
    && typeof reference.id === "string" && reference.id.trim() && reference.id === bankEvent?.referenceNo
    && !localEntityIds.includes(reference.id)).map((reference) => reference.id));
  const ids = new Set(roots);
  const documentIds = new Set(collectSourceIds(voucher.evidenceIds, voucher.basis?.calculationDocumentId));
  const sources = [];
  for (const id of ids) {
    const source = records.get(id);
    const document = (workspace.documents || []).find((item) => item.id === id);
    if (document) documentIds.add(id);
    if (!source) continue;
    sources.push(source);
    const { record } = source;
    collectSourceIds(record.evidenceIds, record.documentIds, record.documentId, record.sourceDocumentId, record.invoiceDocumentIds).forEach((documentId) => documentIds.add(documentId));
    // A newly rebuilt advance voucher snapshots its current funding allocations.
    // The application keeps historical funding IDs for audit, not as live sources
    // of this replacement draft. Explicit voucher roots and all originals are
    // still checked, and posting validates every reconciliationSources entry.
    const historicalAdvanceSources = source.collection === "advanceApplications" && record.id === voucher.advanceApplicationId
      && voucher.reconciliationSources?.length > 0;
    collectSourceIds(historicalAdvanceSources ? [] : record.sourceIds, record.billId, record.relatedBillId, record.transactionId, record.allocationId, record.contractId, record.invoiceId, record.approvalId, record.originalSourceId,
      record.sourceImportId, record.advanceBillId, record.targetBillId, record.itemId, source.transaction?.id).forEach((sourceId) => ids.add(sourceId));
  }
  return { sourceIds: [...ids], roots, sources, documentIds: [...documentIds], invalidSourceIds: roots.filter((id) => !records.has(id)
    && !externalReferenceIds.has(id) && !(workspace.documents || []).some((document) => document.id === id)) };
}

export function assessVoucherEvidence(workspace, voucher) {
  const trace = voucherEvidenceSources(workspace, voucher);
  const issues = trace.invalidSourceIds.map((id) => ({ code: "voucher_source_invalid", message: `凭证来源 ${id} 已不存在，请重新关联真实业务来源` }));
  trace.sources.forEach(({ record, collection }) => {
    if (["deleted", "void", "voided", "cancelled", "reversed", "rejected", "withdrawn", "revoked"].includes(record.status)
      || record.voidStatus === "voided" || (collection === "allocations" && !["confirmed", "posted"].includes(record.status))) {
      issues.push({ code: "voucher_source_invalid", message: `凭证来源 ${record.id} 已失效或未确认，请按当前业务重新生成` });
    }
  });
  const documents = trace.documentIds.map((id) => (workspace.documents || []).find((document) => document.id === id));
  if (!documents.length) issues.push({ code: "voucher_original_missing", message: "尚无原始依据，请在资料页关联本笔业务的原文件后入账" });
  trace.documentIds.forEach((id, index) => {
    const document = documents[index];
    if (!document || ["deleted", "voided", "cancelled"].includes(document.status) || document.voidStatus === "voided"
      || !document.hash || !document.storage?.availableLocally || Number(document.size) <= 0) {
      issues.push({ code: "voucher_original_unavailable", message: `${document?.name || id} 缺少有效本地原文件，请在资料页补回原件` });
    }
  });
  const types = new Set(documents.filter(Boolean).flatMap(normalizeDocumentType));
  const transactions = trace.sources.filter((source) => source.collection === "transactions").map((source) => source.record);
  const requirements = [...requirementsFor(workspace, voucher.judgement?.eventType).filter((requirement) => transactions.length || requirement.id !== "bank"), ...transactions.flatMap((transaction) => requirementsFor(workspace, (transaction.classification || classifyBankTransaction(workspace, transaction)).eventType))];
  if (transactions.some((transaction) => transaction.counterpartTransactionId && trace.sourceIds.includes(transaction.counterpartTransactionId))) types.add("internalCounterpart");
  [...new Map(requirements.map((requirement) => [requirement.id, requirement])).values()].forEach((requirement) => {
    if (!requirement.anyOf.some((type) => types.has(type))) issues.push({ code: "voucher_required_original_missing", message: `缺少本笔业务所需的${requirement.label}原件；人工业务确认不能替代原文件` });
  });
  return { ...trace, documents: documents.filter(Boolean), complete: issues.length === 0, issues, referenceIds: [] };
}

export function syncVoucherEvidenceTasks(workspace, voucher, context, extraIssues = []) {
  const assessment = assessVoucherEvidence(workspace, voucher);
  const issues = [...assessment.issues, ...extraIssues];
  voucher.blockers = issues;
  const tasks = workspace.exceptionTasks || (workspace.exceptionTasks = []);
  const identity = `voucher:${voucher.id}:evidence`;
  let task = tasks.find((item) => item.identity === identity);
  if (issues.length) {
    if (!task) { task = { id: nextRecordId(tasks, "exception"), identity, code: "voucher_evidence", sourceType: "voucher", sourceId: voucher.id, period: voucher.period, createdAt: context.at, history: [] }; tasks.push(task); }
    Object.assign(task, { status: "open", action: "complete_voucher_evidence", message: issues.map((issue) => issue.message).join("；"), sourceIds: collectSourceIds(voucher.id, assessment.sourceIds, assessment.documentIds), updatedAt: context.at });
  } else if (task && task.status !== "resolved") {
    Object.assign(task, { status: "resolved", resolvedAt: context.at, resolvedBy: context.actor, resolution: "originals_verified" });
  }
  return assessment;
}
