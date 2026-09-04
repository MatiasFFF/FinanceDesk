import { createId } from "../../domain/foundation.js";
import { buildFinancialStatements, buildManagementMetrics, buildTaxWorkpaper } from "../../domain/accounting/reporting.js";
import { attachEvidenceDocument, reviewTransactionEvidence } from "../evidence/evidenceEngine.js";
import { normalizeMoney, parseDelimitedText } from "./bankStatementImport.js";

const LINKABLE_COLLECTIONS = [
  "vouchers",
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
  vouchers: "凭证",
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
  taxDirection: ["unclassified", "output", "input"],
  verificationStatus: ["unverified", "verified", "failed"],
  redLetterStatus: ["normal", "red_applied", "red_issued"],
  voidStatus: ["valid", "voided"],
  certificationStatus: ["not_required", "pending", "certified", "rejected"],
};

const APPROVAL_STATUSES = ["draft", "pending", "approved", "rejected", "withdrawn"];

export const APPROVAL_TYPES = Object.freeze({
  unclassified: "未选择",
  reimbursement: "报销",
  payment_request: "付款申请",
  loan_repayment: "借款／还款",
  procurement: "采购",
  refund: "退款",
});

const APPROVAL_TYPE_ALIASES = Object.freeze({
  报销: "reimbursement",
  费用报销: "reimbursement",
  付款: "payment_request",
  付款申请: "payment_request",
  借款: "loan_repayment",
  还款: "loan_repayment",
  "借款/还款": "loan_repayment",
  "借款／还款": "loan_repayment",
  采购: "procurement",
  采购付款: "procurement",
  退款: "refund",
});

export const CONTRACT_TYPES = Object.freeze({
  unclassified: "未选择",
  sales: "销售合同",
  purchase: "采购合同",
  lease: "租赁合同",
  membership: "会员合同",
  platform: "平台合同",
});

export const CONTRACT_SETTLEMENT_MODES = Object.freeze({
  unconfigured: "未设置",
  one_time: "一次性结算",
  monthly: "按月结算",
});

export const CONTRACT_DUE_DATE_RULES = Object.freeze({
  on_bill_date: "账单日当天到期",
  days_after: "账单日后 N 天到期",
  month_end: "账单当月月末到期",
});

export const PAYROLL_SOCIAL_IMPORT_KINDS = Object.freeze({
  payroll: "工资表",
  socialSecurity: "社保表",
});

export const PAYROLL_SOCIAL_FIELD_DEFINITIONS = Object.freeze({
  employee: { label: "员工", required: true, aliases: ["员工", "员工姓名", "姓名", "人员姓名", "职工姓名", "employee", "employee name", "name"] },
  period: { label: "所属期", aliases: ["所属期", "工资所属期", "薪资月份", "社保所属期", "月份", "期间", "period", "month"] },
  grossSalary: { label: "应发工资", aliases: ["应发工资", "应发合计", "应发薪资", "税前工资", "工资基数", "gross salary", "gross pay"] },
  personalSocial: { label: "个人社保", aliases: ["个人社保", "个人承担社保", "社保个人", "个人缴纳", "个人社保合计", "personal social", "employee social"] },
  employerSocial: { label: "企业社保", aliases: ["企业社保", "单位社保", "公司社保", "单位承担社保", "企业社保合计", "employer social", "company social"] },
  individualIncomeTax: { label: "个税", aliases: ["个税", "个人所得税", "代扣个税", "应纳个税", "income tax", "individual income tax"] },
  netSalary: { label: "实发工资", aliases: ["实发工资", "实发金额", "到手工资", "net salary", "net pay"] },
});

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
  if (kind === "approval" && (details.approvalStatus !== "approved" || !APPROVAL_TYPE_RULES[details.approvalType])) return null;
  const reasons = [];
  let score = 0;
  const acceptedRequirement = requirements.find((requirement) => requirement.anyOf.includes(kind));
  if (acceptedRequirement) {
    score += 15;
    reasons.push(`业务待补${acceptedRequirement.label}`);
  }
  const targetParty = normalizedText(target.counterparty || target.counterpartyName || target.party || "");
  const documentParties = (kind === "approval"
    ? [details.applicant, details.supplier]
    : [document.name, details.partyA, details.partyB, details.applicant])
    .map(normalizedText)
    .filter(Boolean);
  const partyMatches = targetParty.length >= 2 && documentParties.some((value) => value.includes(targetParty) || targetParty.includes(value));
  if (partyMatches) {
    score += 35;
    reasons.push(`对方“${target.counterparty || target.counterpartyName || target.party}”相符`);
  }
  if (kind === "approval" && !partyMatches) return null;
  const targetAmount = Math.abs(Number(target.amount || 0));
  const documentAmount = Number(details.amount);
  if (kind === "approval" && (!(targetAmount > 0) || !(documentAmount > 0))) return null;
  if (targetAmount > 0 && Number.isFinite(documentAmount) && documentAmount >= 0) {
    const difference = Math.abs(targetAmount - documentAmount);
    if (difference <= 0.01) {
      score += 35;
      reasons.push(`金额一致 ${targetAmount.toFixed(2)}`);
    } else if (difference <= Math.max(1, targetAmount * 0.02)) {
      score += 20;
      reasons.push(`金额接近，差额 ${difference.toFixed(2)}`);
    }
    if (kind === "approval" && difference > 0.01) return null;
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
  } else if (kind === "approval") {
    const dateDistance = details.approvalDate && date ? invoiceDateDistance(details.approvalDate, date) : null;
    if (dateDistance == null || dateDistance > 31) return null;
    score += dateDistance === 0 ? 20 : (dateDistance <= 7 ? 15 : 10);
    reasons.push(dateDistance === 0 ? "审批日期与业务日期一致" : `审批日期与业务日期相差 ${dateDistance} 天`);
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
      if (matchDocumentKind(document) === "approval") {
        if (sourceType !== "bankTransaction") return [];
        const rule = APPROVAL_TYPE_RULES[document.structuredData?.approvalType];
        if (!rule || !approvalTargetMatchesRule(rule, "transaction", target)) return [];
      }
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
  const requirements = getDocumentTaskRequirements(workspace);
  const identities = new Set(requirements.map((item) => item.identity));
  const tasks = (workspace.exceptionTasks || []).map((task) => ({ ...task, history: [...(task.history || [])] }));
  let created = 0;
  let resolved = 0;
  let reopened = 0;
  let changed = false;
  requirements.forEach((requirement) => {
    const existing = tasks.find((task) => task.identity === requirement.identity);
    const message = requirement.message || `缺少${requirement.label}：${requirement.sourceLabel}`;
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
        missingEvidence: [{
          id: requirement.requirementId,
          label: requirement.label,
          anyOf: requirement.anyOf || [],
          reason: requirement.reason || null,
          documentId: requirement.documentId || null,
          sectionKey: requirement.sectionKey || null,
        }],
        status: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
        sourceIds: [...new Set([requirement.sourceId, ...(requirement.sourceIds || [])].filter(Boolean))],
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

function normalizedApprovalType(value) {
  const raw = String(value || "").trim();
  const resolved = APPROVAL_TYPE_ALIASES[raw] || raw || "unclassified";
  return enumValue(resolved, Object.keys(APPROVAL_TYPES), "unclassified", "审批类型");
}

export function normalizeDocumentStructuredData(category, input = {}) {
  const kind = documentStructuredKind(category);
  if (!kind) return null;
  if (kind === "contract") {
    const serviceStartDate = optionalDate(input.serviceStartDate, "服务开始日期");
    const serviceEndDate = optionalDate(input.serviceEndDate, "服务结束日期");
    if (serviceStartDate && serviceEndDate && serviceEndDate < serviceStartDate) throw new Error("服务结束日期不能早于开始日期");
    const inferredSettlementMode = input.settlementMode
      || (/按月|月结/.test(String(input.settlementCycle || "")) ? "monthly" : (/一次/.test(String(input.settlementCycle || "")) ? "one_time" : "unconfigured"));
    const settlementMode = enumValue(inferredSettlementMode, Object.keys(CONTRACT_SETTLEMENT_MODES), "unconfigured", "合同结算方式");
    const contractType = enumValue(input.contractType, Object.keys(CONTRACT_TYPES), "unclassified", "合同类型");
    const firstBillDate = optionalDate(input.firstBillDate, "首次账单日");
    const billingEndDate = optionalDate(input.billingEndDate || serviceEndDate, "账单结束日期");
    if (firstBillDate && billingEndDate && billingEndDate < firstBillDate) throw new Error("账单结束日期不能早于首次账单日");
    if (serviceEndDate && billingEndDate && billingEndDate > serviceEndDate) throw new Error("账单结束日期不能晚于合同服务结束日期");
    const dueDateRule = enumValue(input.dueDateRule, Object.keys(CONTRACT_DUE_DATE_RULES), "on_bill_date", "到期日规则");
    const dueDays = optionalNumber(input.dueDays, "账单后到期天数", 3650);
    if (dueDays != null && !Number.isInteger(dueDays)) throw new Error("账单后到期天数必须是整数");
    return {
      kind,
      partyA: String(input.partyA || "").trim(),
      partyB: String(input.partyB || "").trim(),
      amount: optionalNumber(input.amount, "合同金额"),
      serviceStartDate,
      serviceEndDate,
      contractType,
      settlementMode,
      settlementCycle: String(input.settlementCycle || CONTRACT_SETTLEMENT_MODES[settlementMode] || "").trim(),
      periodAmount: optionalNumber(input.periodAmount, "每期金额"),
      firstBillDate,
      dueDateRule,
      dueDays: dueDays ?? 0,
      billingEndDate,
      refundTerms: String(input.refundTerms || "").trim(),
      commissionTerms: String(input.commissionTerms || "").trim(),
    };
  }
  if (kind === "invoice") {
    const amount = optionalNumber(input.amount, "发票价税合计");
    const taxAmount = optionalNumber(input.taxAmount, "发票税额");
    if (amount != null && taxAmount != null && taxAmount > amount) throw new Error("发票税额不能大于价税合计");
    return {
      kind,
      invoiceNumber: String(input.invoiceNumber || "").trim(),
      invoiceDate: optionalDate(input.invoiceDate, "发票日期"),
      taxDirection: enumValue(input.taxDirection, INVOICE_STATUSES.taxDirection, "unclassified", "发票销进项类型"),
      counterparty: String(input.counterparty || "").trim(),
      amount,
      taxAmount,
      taxRate: optionalNumber(input.taxRate, "发票税率", 100),
      verificationStatus: enumValue(input.verificationStatus, INVOICE_STATUSES.verificationStatus, "unverified", "查验状态"),
      redLetterStatus: enumValue(input.redLetterStatus, INVOICE_STATUSES.redLetterStatus, "normal", "红字状态"),
      voidStatus: enumValue(input.voidStatus, INVOICE_STATUSES.voidStatus, "valid", "作废状态"),
      certificationStatus: enumValue(input.certificationStatus, INVOICE_STATUSES.certificationStatus, "not_required", "认证状态"),
      linkedBillId: String(input.linkedBillId || "").trim(),
      originalInvoiceDocumentId: String(input.originalInvoiceDocumentId || "").trim(),
      originalBillId: String(input.originalBillId || "").trim(),
    };
  }
  return {
    kind,
    approvalType: normalizedApprovalType(input.approvalType),
    applicant: String(input.applicant || "").trim(),
    supplier: String(input.supplier || "").trim(),
    approvalDate: optionalDate(input.approvalDate, "审批日期"),
    amount: optionalNumber(input.amount, "审批金额"),
    approvalStatus: enumValue(input.approvalStatus, APPROVAL_STATUSES, "draft", "审批状态"),
    linkedTargetType: enumValue(input.linkedTargetType, ["", "bill", "transaction"], "", "审批关联对象类型"),
    linkedTargetId: String(input.linkedTargetId || "").trim(),
    businessEventId: String(input.businessEventId || "").trim(),
    linkStatus: enumValue(input.linkStatus, ["unlinked", "linked", "invalidated"], "unlinked", "审批业务关联状态"),
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

function contractBillKind(contractType) {
  if (["sales", "membership", "platform"].includes(contractType)) return "receivable";
  if (["purchase", "lease"].includes(contractType)) return "payable";
  return null;
}

function dateFromParts(year, monthIndex, day) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIndex, Math.min(day, lastDay)));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addMonthsToDate(value, months) {
  const [year, month, day] = value.split("-").map(Number);
  return isoDate(dateFromParts(year, month - 1 + months, day));
}

function addDaysToDate(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  return isoDate(new Date(Date.UTC(year, month - 1, day + days)));
}

function monthEndDate(value) {
  const [year, month] = value.split("-").map(Number);
  return isoDate(new Date(Date.UTC(year, month, 0)));
}

function contractDueDate(billDate, rule, dueDays) {
  if (rule === "days_after") return addDaysToDate(billDate, dueDays);
  if (rule === "month_end") return monthEndDate(billDate);
  return billDate;
}

function contractBillNumber(documentId, billKind, period) {
  const prefix = billKind === "receivable" ? "YS" : "YF";
  const suffix = String(documentId || "HT").replace(/[^a-z0-9]/gi, "").slice(-8).toUpperCase() || "HT";
  return `${prefix}-${period.replace("-", "")}-${suffix}`;
}

export function buildContractBillingPlan(workspace, options = {}) {
  const documentId = options.documentId;
  const document = (workspace.documents || []).find((item) => item.id === documentId);
  const errors = [];
  if (!document || documentStructuredKind(document.category) !== "contract") {
    return { documentId, document: null, items: [], existingBills: [], duplicatePeriods: [], errors: ["找不到结构化合同资料"], canConfirm: false };
  }
  let details;
  try {
    details = normalizeDocumentStructuredData("合同", document.structuredData || {});
  } catch (error) {
    return { documentId, document, items: [], existingBills: [], duplicatePeriods: [], errors: [error.message], canConfirm: false };
  }
  const billKind = contractBillKind(details.contractType);
  const contractAmount = Math.round(Number(details.amount || 0) * 100) / 100;
  const periodAmount = Math.round(Number(details.periodAmount || 0) * 100) / 100;
  const firstBillDate = details.firstBillDate;
  const endDate = details.billingEndDate;
  const asOf = String(options.asOf || new Date().toISOString().slice(0, 10));
  const counterparty = String(details.partyB || details.partyA || "").trim();
  const membersSetting = workspace?.modules?.members ?? workspace?.moduleSettings?.members;
  const membershipEnabled = typeof membersSetting === "object"
    ? membersSetting.enabled !== false
    : membersSetting !== false;
  if (details.contractType === "membership" && !membershipEnabled) errors.push("当前工作台未启用会员业务模块，不能生成会员合同账单");
  else if (!billKind) errors.push(`必须先选择销售、采购、租赁${membershipEnabled ? "、会员" : ""}或平台合同类型`);
  if (!counterparty) errors.push("必须填写合同对方");
  if (!(contractAmount > 0)) errors.push("合同金额不足：请填写大于 0 的合同金额");
  if (!(periodAmount > 0)) errors.push("每期金额必须大于 0");
  if (contractAmount > 0 && periodAmount > contractAmount) errors.push(`合同金额不足：每期金额 ${periodAmount.toFixed(2)} 超过合同金额 ${contractAmount.toFixed(2)}`);
  if (!firstBillDate) errors.push("必须填写首次账单日");
  if (!endDate) errors.push("必须填写账单结束日期");
  if (details.settlementMode === "unconfigured") errors.push("必须选择一次性或按月结算");
  if (details.dueDateRule === "days_after" && (!Number.isInteger(details.dueDays) || details.dueDays < 0)) errors.push("账单后到期天数必须是大于或等于 0 的整数");
  if (endDate && endDate < asOf) errors.push(`合同账单计划已于 ${endDate} 过期，不能生成新账单`);

  const scheduleDates = [];
  if (firstBillDate && endDate && firstBillDate <= endDate && details.settlementMode === "one_time") scheduleDates.push(firstBillDate);
  if (firstBillDate && endDate && firstBillDate <= endDate && details.settlementMode === "monthly") {
    for (let index = 0; index < 600; index += 1) {
      const date = addMonthsToDate(firstBillDate, index);
      if (date > endDate) break;
      scheduleDates.push(date);
    }
    if (scheduleDates.length === 600 && addMonthsToDate(firstBillDate, 600) <= endDate) errors.push("按月账单计划超过 600 期，请缩短结束日期");
  }
  const plannedTotalAmount = Math.round(scheduleDates.length * periodAmount * 100) / 100;
  if (contractAmount > 0 && plannedTotalAmount > contractAmount + 0.01) {
    errors.push(`生成总额 ${plannedTotalAmount.toFixed(2)} 超出合同金额 ${contractAmount.toFixed(2)}`);
  }

  const existingBills = (workspace.bills || []).filter((bill) => bill.contractDocumentId === documentId && bill.status !== "void");
  const existingByPeriod = new Map(existingBills.map((bill) => [bill.billingPeriod || String(bill.date || "").slice(0, 7), bill]));
  const duplicatePeriods = [];
  const items = scheduleDates.flatMap((billDate) => {
    const billingPeriod = billDate.slice(0, 7);
    if (existingByPeriod.has(billingPeriod)) {
      duplicatePeriods.push({ period: billingPeriod, bill: existingByPeriod.get(billingPeriod) });
      return [];
    }
    return [{
      billingPeriod,
      billKind,
      counterparty,
      amount: periodAmount,
      date: billDate,
      dueDate: contractDueDate(billDate, details.dueDateRule, details.dueDays),
      no: contractBillNumber(documentId, billKind, billingPeriod),
      summary: `${CONTRACT_TYPES[details.contractType]} · ${billingPeriod} 结算`,
    }];
  });
  const generatedTotalAmount = Math.round(existingBills.reduce((sum, bill) => sum + Number(bill.amount || 0), 0) * 100) / 100;
  const pendingTotalAmount = Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
  const combinedTotalAmount = Math.round((generatedTotalAmount + pendingTotalAmount) * 100) / 100;
  if (contractAmount > 0 && combinedTotalAmount > contractAmount + 0.01) {
    errors.push(`已生成与待生成账单合计 ${combinedTotalAmount.toFixed(2)} 超出合同金额 ${contractAmount.toFixed(2)}`);
  }
  if (!items.length && duplicatePeriods.length && !errors.length) errors.push(`同一合同同一期不得重复生成：${duplicatePeriods.map((item) => item.period).join("、")}`);
  return {
    documentId,
    document,
    details,
    contractType: details.contractType,
    billKind,
    contractAmount,
    periodAmount,
    firstBillDate,
    endDate,
    asOf,
    counterparty,
    scheduleDates,
    plannedTotalAmount,
    existingBills,
    generatedTotalAmount,
    duplicatePeriods,
    items,
    pendingTotalAmount,
    combinedTotalAmount,
    errors: [...new Set(errors)],
    canConfirm: errors.length === 0 && items.length > 0,
  };
}

export function applyContractBillingPlan(workspace, input = {}, context = {}) {
  const plan = buildContractBillingPlan(workspace, { documentId: input.documentId, asOf: input.asOf });
  if (!plan.canConfirm) throw new Error(`合同账单计划不能生成：${plan.errors.join("；") || "没有待生成账单"}`);
  const at = context.at || new Date().toISOString();
  const actor = context.actor || "本地用户";
  const existingNumbers = new Set((workspace.bills || []).map((bill) => bill.no));
  const bills = plan.items.map((item, index) => {
    let no = item.no;
    let suffix = 2;
    while (existingNumbers.has(no)) {
      no = `${item.no}-${suffix}`;
      suffix += 1;
    }
    existingNumbers.add(no);
    return {
      id: createId("bill"),
      no,
      kind: item.billKind,
      counterparty: item.counterparty,
      summary: item.summary,
      amount: item.amount,
      date: item.date,
      dueDate: item.dueDate,
      businessPeriod: item.billingPeriod,
      billingPeriod: item.billingPeriod,
      contractType: plan.contractType,
      contractDocumentId: plan.documentId,
      evidenceIds: [plan.documentId],
      documentIds: [plan.documentId],
      sourceIds: [plan.documentId],
      source: "合同账单计划",
      status: "active",
      scheduleIndex: index + 1,
      createdAt: at,
      createdBy: actor,
    };
  });
  const billIds = bills.map((bill) => bill.id);
  const filing = workspace.delivery?.filing || {};
  const next = {
    ...workspace,
    bills: [...(workspace.bills || []), ...bills],
    documents: (workspace.documents || []).map((document) => document.id === plan.documentId ? {
      ...document,
      relatedObjectIds: [...new Set([...(document.relatedObjectIds || []), ...billIds])],
      updatedAt: at,
    } : document),
    evidenceLinks: [...(workspace.evidenceLinks || []), {
      id: createId("evidence-link"),
      documentIds: [plan.documentId],
      objectIds: billIds,
      relation: "contract-billing-plan",
      note: `${plan.firstBillDate} 至 ${plan.endDate} · ${CONTRACT_SETTLEMENT_MODES[plan.details.settlementMode]}`,
      status: "active",
      createdAt: at,
      updatedAt: at,
    }],
    tax: {
      ...(workspace.tax || {}),
      frozenAt: null,
      financeConfirmedAt: null,
      payrollConfirmedAt: null,
      socialSecurityConfirmedAt: null,
      ownerConfirmedAt: null,
      confirmedBy: "",
      financeConfirmedVersionId: null,
      payrollConfirmedVersionId: null,
      socialSecurityConfirmedVersionId: null,
      payrollConfirmedFingerprint: null,
      socialSecurityConfirmedFingerprint: null,
      ownerConfirmedVersionId: null,
    },
    delivery: {
      ...(workspace.delivery || {}),
      filing: {
        ...filing,
        period: workspace.currentPeriod,
        draftCreatedAt: null,
        draftVersionId: null,
        initialConfirmationId: null,
        finalConfirmedVersionId: null,
        exportedAt: null,
        exportedPackage: null,
        receipt: null,
        archivedAt: null,
      },
    },
    auditLog: [{
      id: createId("log"),
      at,
      actor,
      action: "确认合同账单计划",
      detail: `${plan.document.name} · 生成 ${bills.length} 张${plan.billKind === "receivable" ? "应收" : "应付"}账单 · 合计 ${plan.pendingTotalAmount.toFixed(2)}`,
      sourceIds: [plan.documentId, ...billIds],
    }, ...(workspace.auditLog || [])],
  };
  return { workspace: next, bills, plan };
}

function invoiceBillKind(details) {
  if (details?.taxDirection === "output") return "receivable";
  if (details?.taxDirection === "input") return "payable";
  return null;
}

function invoiceDocumentOrThrow(workspace, documentId) {
  const document = (workspace?.documents || []).find((item) => item.id === documentId);
  if (!document || documentStructuredKind(document.category) !== "invoice") throw new Error("找不到结构化发票资料");
  if (document.archiveStatus === "archived" || ["archived", "已归档"].includes(document.lifecycleStatus)) throw new Error("已归档发票不能修改账单关系");
  return { document, details: normalizeDocumentStructuredData("发票", document.structuredData || {}) };
}

function invoiceLinkedBillIds(workspace, document) {
  const billIds = new Set((workspace?.bills || []).map((bill) => bill.id));
  const ids = new Set(getDocumentRelatedObjectIds(workspace, document.id));
  if (document.structuredData?.linkedBillId) ids.add(document.structuredData.linkedBillId);
  (workspace?.bills || []).forEach((bill) => {
    if ([...(bill.documentIds || []), ...(bill.evidenceIds || []), ...(bill.invoiceDocumentIds || [])].includes(document.id)) ids.add(bill.id);
  });
  return [...ids].filter((id) => billIds.has(id));
}

function invoiceDateDistance(left, right) {
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return null;
  return Math.abs(Math.round((leftTime - rightTime) / 86400000));
}

function invoiceManualConfirmation(input, context, action) {
  if (context.mode === "automatic") throw new Error(`${action}不得自动确认`);
  if (input.confirmed !== true) throw new Error(`${action}需要用户明确人工确认`);
}

function assertInvoiceBillEligibility(details, action) {
  if (details.voidStatus === "voided") throw new Error(`作废发票不得${action}`);
  if (details.redLetterStatus !== "normal") throw new Error(`红字发票不能${action}普通正向账单，请使用原发票和原账单的负向调整`);
  const billKind = invoiceBillKind(details);
  if (!billKind) throw new Error("必须先人工选择销项或进项发票");
  return billKind;
}

function invalidateInvoiceBillConfirmations(workspace, at) {
  const filing = workspace.delivery?.filing || {};
  return {
    ...workspace,
    tax: {
      ...(workspace.tax || {}),
      frozenAt: null,
      financeConfirmedAt: null,
      payrollConfirmedAt: null,
      socialSecurityConfirmedAt: null,
      ownerConfirmedAt: null,
      confirmedBy: "",
      financeConfirmedVersionId: null,
      payrollConfirmedVersionId: null,
      socialSecurityConfirmedVersionId: null,
      payrollConfirmedFingerprint: null,
      socialSecurityConfirmedFingerprint: null,
      ownerConfirmedVersionId: null,
    },
    delivery: {
      ...(workspace.delivery || {}),
      filing: {
        ...filing,
        period: workspace.currentPeriod,
        draftCreatedAt: null,
        draftVersionId: null,
        initialConfirmationId: null,
        finalConfirmedVersionId: null,
        exportedAt: null,
        exportedPackage: null,
        receipt: null,
        archivedAt: null,
        invalidatedAt: at,
      },
    },
  };
}

function finalizeInvoiceBillWorkspace(workspace, at) {
  const recalculated = recalculateStructuredInvoiceVat(workspace, { period: workspace.currentPeriod, at });
  return invalidateInvoiceBillConfirmations(recalculated, at);
}

export function buildInvoiceBillSuggestions(workspace, input = {}) {
  let resolved;
  try {
    resolved = invoiceDocumentOrThrow(workspace, input.documentId);
  } catch {
    return [];
  }
  const { document, details } = resolved;
  if (details.voidStatus === "voided" || details.redLetterStatus !== "normal") return [];
  const billKind = invoiceBillKind(details);
  const counterpartyKey = normalizedText(details.counterparty);
  const invoiceAmount = roundVatMoney(details.amount);
  if (!billKind || !counterpartyKey || !(invoiceAmount > 0) || !details.invoiceDate || invoiceLinkedBillIds(workspace, document).length) return [];

  return (workspace.bills || []).flatMap((bill) => {
    if (bill.kind !== billKind || ["void", "inactive"].includes(bill.status)) return [];
    const billCounterpartyKey = normalizedText(bill.counterparty);
    const reasons = [];
    let score = 0;
    if (billCounterpartyKey === counterpartyKey) {
      score += 50;
      reasons.push(`${billKind === "receivable" ? "客户" : "供应商"}完全一致`);
    } else if (billCounterpartyKey && (billCounterpartyKey.includes(counterpartyKey) || counterpartyKey.includes(billCounterpartyKey))) {
      score += 35;
      reasons.push(`${billKind === "receivable" ? "客户" : "供应商"}名称相近`);
    } else {
      return [];
    }

    const billAmount = roundVatMoney(bill.amount);
    const amountDifference = Math.abs(invoiceAmount - billAmount);
    const amountRatio = amountDifference / Math.max(invoiceAmount, billAmount, 0.01);
    if (amountDifference <= 0.01) {
      score += 35;
      reasons.push("价税合计与账单金额一致");
    } else if (amountRatio <= 0.01) {
      score += 25;
      reasons.push(`金额相差 ${amountDifference.toFixed(2)}`);
    } else if (amountRatio <= 0.05) {
      score += 10;
      reasons.push(`金额接近，相差 ${amountDifference.toFixed(2)}`);
    } else {
      return [];
    }

    const dateCandidates = [bill.date, bill.dueDate].filter(Boolean)
      .map((date) => invoiceDateDistance(details.invoiceDate, date))
      .filter((days) => days != null);
    const dateDistanceDays = dateCandidates.length ? Math.min(...dateCandidates) : null;
    if (dateDistanceDays == null || dateDistanceDays > 31) return [];
    if (dateDistanceDays === 0) score += 15;
    else if (dateDistanceDays <= 7) score += 10;
    else score += 5;
    reasons.push(dateDistanceDays === 0 ? "日期一致" : `日期相差 ${dateDistanceDays} 天`);
    if (score < 60) return [];
    return [{
      id: `invoice-bill-suggestion:${document.id}:${bill.id}`,
      documentId: document.id,
      billId: bill.id,
      billKind,
      score,
      reasons,
      invoiceAmount,
      dateDistanceDays,
      bill,
    }];
  }).sort((left, right) => right.score - left.score || left.dateDistanceDays - right.dateDistanceDays);
}

export function confirmInvoiceBillMatch(workspace, input = {}, context = {}) {
  invoiceManualConfirmation(input, context, "发票账单关联");
  const { document, details } = invoiceDocumentOrThrow(workspace, input.documentId);
  const billKind = assertInvoiceBillEligibility(details, "关联");
  const linkedBillIds = invoiceLinkedBillIds(workspace, document);
  if (linkedBillIds.length) throw new Error(`发票已关联账单 ${linkedBillIds.join("、")}，不能重复确认`);
  const bill = (workspace.bills || []).find((item) => item.id === input.billId);
  if (!bill || ["void", "inactive"].includes(bill.status)) throw new Error("找不到可关联的有效账单");
  if (bill.kind !== billKind) throw new Error(`销项发票只能关联应收账单，进项发票只能关联应付账单`);
  const at = context.at || new Date().toISOString();
  const actor = context.actor || "本地用户";
  const evidenceLink = {
    id: createId("evidence-link"),
    documentIds: [document.id],
    objectIds: [bill.id],
    relation: "confirmed-invoice-bill-match",
    note: `人工确认 · ${details.invoiceNumber || document.name} → ${bill.no || bill.id}`,
    status: "active",
    createdAt: at,
    updatedAt: at,
  };
  const linkedDocument = {
    ...document,
    structuredData: { ...details, linkedBillId: bill.id },
    relatedObjectIds: [...new Set([...(document.relatedObjectIds || []), bill.id])],
    updatedAt: at,
  };
  const linkedBill = {
    ...bill,
    documentIds: [...new Set([...(bill.documentIds || []), document.id])],
    evidenceIds: [...new Set([...(bill.evidenceIds || []), document.id])],
    sourceIds: [...new Set([...(bill.sourceIds || []), document.id])],
    invoiceDocumentIds: [...new Set([...(bill.invoiceDocumentIds || []), document.id])],
    updatedAt: at,
  };
  let next = {
    ...workspace,
    documents: (workspace.documents || []).map((item) => item.id === document.id ? linkedDocument : item),
    bills: (workspace.bills || []).map((item) => item.id === bill.id ? linkedBill : item),
    evidenceLinks: [...(workspace.evidenceLinks || []), evidenceLink],
    auditLog: [{
      id: createId("log"),
      at,
      actor,
      action: "人工确认发票账单关联",
      detail: `${details.invoiceNumber || document.name} · ${bill.no || bill.id}`,
      sourceIds: [document.id, bill.id],
    }, ...(workspace.auditLog || [])],
  };
  next = finalizeInvoiceBillWorkspace(next, at);
  return { workspace: next, document: linkedDocument, bill: linkedBill, evidenceLink };
}

function invoiceBillNumber(workspace, document, billKind, period) {
  const prefix = billKind === "receivable" ? "YS" : "YF";
  const reference = String(document.structuredData?.invoiceNumber || document.id || "FP").replace(/[^a-z0-9]/gi, "").slice(-12).toUpperCase() || "FP";
  const base = `${prefix}-${String(period || "").replace("-", "") || "FP"}-${reference}`;
  const existingNumbers = new Set((workspace.bills || []).map((bill) => bill.no));
  let number = base;
  let suffix = 2;
  while (existingNumbers.has(number)) {
    number = `${base}-${suffix}`;
    suffix += 1;
  }
  return number;
}

export function createBillFromInvoice(workspace, input = {}, context = {}) {
  invoiceManualConfirmation(input, context, "从发票新建账单");
  if (input.confirmedNoSuitableBill !== true) throw new Error("必须确认没有合适的已有账单，才能从发票新建账单");
  const { document, details } = invoiceDocumentOrThrow(workspace, input.documentId);
  const billKind = assertInvoiceBillEligibility(details, "新建");
  if (invoiceLinkedBillIds(workspace, document).length) throw new Error("发票已关联账单，不能重复新建");
  const amount = roundVatMoney(details.amount);
  if (!details.counterparty) throw new Error(`必须填写${billKind === "receivable" ? "客户" : "供应商"}`);
  if (!(amount > 0)) throw new Error("发票价税合计必须大于 0");
  if (!details.invoiceDate) throw new Error("必须填写发票日期");
  const at = context.at || new Date().toISOString();
  const actor = context.actor || "本地用户";
  const businessPeriod = details.invoiceDate.slice(0, 7) || document.period || workspace.currentPeriod;
  const bill = {
    id: createId("bill"),
    no: invoiceBillNumber(workspace, document, billKind, businessPeriod),
    kind: billKind,
    counterparty: details.counterparty,
    summary: `${billKind === "receivable" ? "销项" : "进项"}发票 ${details.invoiceNumber || document.name}`,
    amount,
    date: details.invoiceDate,
    dueDate: details.invoiceDate,
    businessPeriod,
    invoiceDocumentId: document.id,
    invoiceDocumentIds: [document.id],
    evidenceIds: [document.id],
    documentIds: [document.id],
    sourceIds: [document.id],
    source: "结构化发票",
    status: "active",
    createdAt: at,
    createdBy: actor,
  };
  const linkedDocument = {
    ...document,
    structuredData: { ...details, linkedBillId: bill.id },
    relatedObjectIds: [...new Set([...(document.relatedObjectIds || []), bill.id])],
    updatedAt: at,
  };
  const evidenceLink = {
    id: createId("evidence-link"),
    documentIds: [document.id],
    objectIds: [bill.id],
    relation: "invoice-generated-bill",
    note: "用户确认无合适账单后，由结构化发票生成",
    status: "active",
    createdAt: at,
    updatedAt: at,
  };
  let next = {
    ...workspace,
    documents: (workspace.documents || []).map((item) => item.id === document.id ? linkedDocument : item),
    bills: [...(workspace.bills || []), bill],
    evidenceLinks: [...(workspace.evidenceLinks || []), evidenceLink],
    auditLog: [{
      id: createId("log"),
      at,
      actor,
      action: "确认从发票生成账单",
      detail: `${details.invoiceNumber || document.name} · 新建${billKind === "receivable" ? "应收" : "应付"} ${amount.toFixed(2)}`,
      sourceIds: [document.id, bill.id],
    }, ...(workspace.auditLog || [])],
  };
  next = finalizeInvoiceBillWorkspace(next, at);
  return { workspace: next, document: linkedDocument, bill, evidenceLink };
}

export function applyRedInvoiceBillAdjustment(workspace, input = {}, context = {}) {
  invoiceManualConfirmation(input, context, "红字发票负向调整");
  const { document, details } = invoiceDocumentOrThrow(workspace, input.documentId);
  if (details.voidStatus === "voided") throw new Error("作废发票不得形成账单调整");
  if (details.redLetterStatus !== "red_issued") throw new Error("只有已开具红字发票才能形成负向调整");
  const billKind = invoiceBillKind(details);
  if (!billKind) throw new Error("必须先人工选择红字发票的销项或进项方向");
  if (!details.originalInvoiceDocumentId || !details.originalBillId) throw new Error("红字发票必须同时关联原发票和原账单");
  if (details.originalInvoiceDocumentId === document.id) throw new Error("红字发票不能把自身设为原发票");
  if (invoiceLinkedBillIds(workspace, document).length) throw new Error("红字发票已经形成账单调整，不能重复确认");

  const original = invoiceDocumentOrThrow(workspace, details.originalInvoiceDocumentId);
  if (original.details.redLetterStatus !== "normal" || original.details.voidStatus === "voided") throw new Error("原发票必须是有效的正常蓝字发票");
  if (original.details.taxDirection !== details.taxDirection) throw new Error("红字发票与原发票的销进项方向必须一致");
  const bill = (workspace.bills || []).find((item) => item.id === details.originalBillId);
  if (!bill || ["void", "inactive"].includes(bill.status)) throw new Error("找不到红字发票指定的有效原账单");
  if (bill.kind !== billKind) throw new Error("红字发票与原账单方向不一致");
  if (!invoiceLinkedBillIds(workspace, original.document).includes(bill.id)) throw new Error("指定原账单尚未关联原发票");
  if ((bill.adjustments || []).some((adjustment) => adjustment.documentId === document.id)) throw new Error("该红字发票已经调整过原账单");

  const redAmount = roundVatMoney(details.amount);
  const originalInvoiceAmount = roundVatMoney(original.details.amount);
  if (!(redAmount > 0)) throw new Error("红字发票价税合计必须大于 0");
  if (originalInvoiceAmount > 0 && redAmount > originalInvoiceAmount + 0.01) throw new Error("红字金额不能超过原发票价税合计");
  const adjustmentAmount = -Math.abs(redAmount);
  const adjustedBillAmount = roundVatMoney(Number(bill.amount || 0) + adjustmentAmount);
  if (adjustedBillAmount < 0) throw new Error("红字金额不能超过原账单当前金额");

  const at = context.at || new Date().toISOString();
  const actor = context.actor || "本地用户";
  const adjustment = {
    id: createId("bill-adjustment"),
    type: "red-invoice",
    amount: adjustmentAmount,
    documentId: document.id,
    originalInvoiceDocumentId: original.document.id,
    at,
    actor,
  };
  const linkedBill = {
    ...bill,
    originalAmount: bill.originalAmount ?? Number(bill.amount || 0),
    amount: adjustedBillAmount,
    adjustments: [...(bill.adjustments || []), adjustment],
    documentIds: [...new Set([...(bill.documentIds || []), original.document.id, document.id])],
    evidenceIds: [...new Set([...(bill.evidenceIds || []), original.document.id, document.id])],
    sourceIds: [...new Set([...(bill.sourceIds || []), original.document.id, document.id])],
    invoiceDocumentIds: [...new Set([...(bill.invoiceDocumentIds || []), original.document.id, document.id])],
    updatedAt: at,
  };
  const originalDocument = {
    ...original.document,
    structuredData: { ...original.details, linkedBillId: bill.id },
    relatedObjectIds: [...new Set([...(original.document.relatedObjectIds || []), bill.id])],
    updatedAt: at,
  };
  const redDocument = {
    ...document,
    structuredData: {
      ...details,
      linkedBillId: bill.id,
      originalInvoiceDocumentId: original.document.id,
      originalBillId: bill.id,
    },
    relatedObjectIds: [...new Set([...(document.relatedObjectIds || []), bill.id])],
    updatedAt: at,
  };
  const evidenceLink = {
    id: createId("evidence-link"),
    documentIds: [original.document.id, document.id],
    objectIds: [bill.id],
    relation: "red-invoice-bill-adjustment",
    note: `红字发票 ${details.invoiceNumber || document.name} 对原账单负向调整 ${redAmount.toFixed(2)}`,
    status: "active",
    createdAt: at,
    updatedAt: at,
  };
  let next = {
    ...workspace,
    documents: (workspace.documents || []).map((item) => {
      if (item.id === document.id) return redDocument;
      if (item.id === original.document.id) return originalDocument;
      return item;
    }),
    bills: (workspace.bills || []).map((item) => item.id === bill.id ? linkedBill : item),
    evidenceLinks: [...(workspace.evidenceLinks || []), evidenceLink],
    auditLog: [{
      id: createId("log"),
      at,
      actor,
      action: "确认红字发票负向调整",
      detail: `${details.invoiceNumber || document.name} · ${bill.no || bill.id} · ${adjustmentAmount.toFixed(2)}`,
      sourceIds: [original.document.id, document.id, bill.id],
    }, ...(workspace.auditLog || [])],
  };
  next = finalizeInvoiceBillWorkspace(next, at);
  return { workspace: next, document: redDocument, originalDocument, bill: linkedBill, adjustment, evidenceLink };
}

const APPROVAL_TYPE_RULES = Object.freeze({
  reimbursement: {
    billKinds: ["payable"],
    transactionDirections: ["out"],
    eventType: "purchaseExpense",
    compatibleEventTypes: ["purchaseExpense", "employeeAdvance"],
  },
  payment_request: {
    billKinds: ["payable"],
    transactionDirections: ["out"],
    eventType: "supplierSettlement",
    compatibleEventTypes: ["supplierSettlement", "purchaseExpense"],
  },
  loan_repayment: {
    billKinds: ["receivable", "payable"],
    transactionDirections: ["in", "out"],
    eventType: "loan",
    compatibleEventTypes: ["loan", "relatedParty"],
  },
  procurement: {
    billKinds: ["payable"],
    transactionDirections: ["out"],
    eventType: "purchaseExpense",
    compatibleEventTypes: ["purchaseExpense", "supplierSettlement"],
  },
  refund: {
    billKinds: ["receivable", "payable"],
    transactionDirections: ["in", "out"],
    eventType: "refund",
    compatibleEventTypes: ["refund"],
  },
});

function approvalDocumentOrThrow(workspace, documentId) {
  const document = (workspace?.documents || []).find((item) => item.id === documentId);
  if (!document || documentStructuredKind(document.category) !== "approval") throw new Error("找不到结构化审批单资料");
  if (document.archiveStatus === "archived" || ["archived", "已归档"].includes(document.lifecycleStatus)) throw new Error("已归档审批单不能修改业务关系");
  return { document, details: normalizeDocumentStructuredData("审批单", document.structuredData || {}) };
}

function approvalRule(details) {
  return APPROVAL_TYPE_RULES[details?.approvalType] || null;
}

function approvalParty(details) {
  if (["reimbursement", "loan_repayment"].includes(details.approvalType)) return String(details.applicant || details.supplier || "").trim();
  return String(details.supplier || details.applicant || "").trim();
}

function approvalTransactionDirection(transaction) {
  if (["in", "out"].includes(transaction?.direction)) return transaction.direction;
  return Number(transaction?.amount || 0) < 0 ? "out" : "in";
}

function approvalTargetEventType(target) {
  return target?.classification?.eventType || target?.eventType || target?.type || "unknown";
}

function approvalTargetMatchesRule(rule, targetType, target) {
  if (targetType === "bill") return rule.billKinds.includes(target.kind);
  if (targetType !== "transaction" || !rule.transactionDirections.includes(approvalTransactionDirection(target))) return false;
  const eventType = approvalTargetEventType(target);
  return !eventType || eventType === "unknown" || rule.compatibleEventTypes.includes(eventType);
}

function approvalConfirmedTargetIds(workspace, document) {
  const targetIds = new Set();
  if (document.structuredData?.linkStatus === "linked" && document.structuredData?.linkedTargetId) {
    targetIds.add(document.structuredData.linkedTargetId);
  }
  [...(workspace?.bills || []), ...(workspace?.transactions || [])].forEach((target) => {
    if ((target.approvalDocumentIds || []).includes(document.id)) targetIds.add(target.id);
  });
  (workspace?.evidenceLinks || [])
    .filter((link) => link.status !== "inactive" && link.relation === "confirmed-approval-business-link" && link.documentIds?.includes(document.id))
    .forEach((link) => (link.objectIds || []).forEach((id) => targetIds.add(id)));
  const validTargetIds = new Set([...(workspace?.bills || []), ...(workspace?.transactions || [])].map((target) => target.id));
  return [...targetIds].filter((id) => validTargetIds.has(id));
}

function approvalCandidate(workspace, document, details, targetType, target) {
  const rule = approvalRule(details);
  if (!rule || !approvalTargetMatchesRule(rule, targetType, target)) return null;
  if (["void", "inactive"].includes(target.status)) return null;
  const party = approvalParty(details);
  const partyKey = normalizedText(party);
  const targetPartyKey = normalizedText(target.counterparty || target.counterpartyName || target.party || "");
  if (!partyKey || !targetPartyKey) return null;
  const reasons = [`类型符合${APPROVAL_TYPES[details.approvalType]}`];
  let score = 15;
  if (partyKey === targetPartyKey) {
    score += 30;
    reasons.push(`${details.supplier ? "供应商" : "申请人"}完全一致`);
  } else if (partyKey.includes(targetPartyKey) || targetPartyKey.includes(partyKey)) {
    score += 20;
    reasons.push(`${details.supplier ? "供应商" : "申请人"}名称相近`);
  } else {
    return null;
  }
  const approvalAmount = Math.round(Number(details.amount || 0) * 100) / 100;
  const targetAmount = Math.round(Math.abs(Number(target.amount || 0)) * 100) / 100;
  if (!(approvalAmount > 0) || Math.abs(approvalAmount - targetAmount) > 0.01) return null;
  score += 40;
  reasons.push(`金额一致 ${approvalAmount.toFixed(2)}`);
  if (!details.approvalDate) return null;
  const targetDates = (targetType === "bill" ? [target.date, target.dueDate] : [target.date])
    .filter(Boolean)
    .map((date) => invoiceDateDistance(details.approvalDate, String(date).slice(0, 10)))
    .filter((days) => days != null);
  const dateDistanceDays = targetDates.length ? Math.min(...targetDates) : null;
  if (dateDistanceDays == null || dateDistanceDays > 31) return null;
  score += dateDistanceDays === 0 ? 15 : (dateDistanceDays <= 7 ? 10 : 5);
  reasons.push(dateDistanceDays === 0 ? "日期一致" : `日期相差 ${dateDistanceDays} 天`);
  return {
    id: `approval-link-suggestion:${document.id}:${targetType}:${target.id}`,
    documentId: document.id,
    targetType,
    targetId: target.id,
    target,
    approvalType: details.approvalType,
    eventType: rule.eventType,
    score,
    reasons,
    dateDistanceDays,
  };
}

export function buildApprovalLinkSuggestions(workspace, input = {}) {
  let resolved;
  try {
    resolved = approvalDocumentOrThrow(workspace, input.documentId);
  } catch {
    return [];
  }
  const { document, details } = resolved;
  if (details.approvalStatus !== "approved" || !approvalRule(details) || approvalConfirmedTargetIds(workspace, document).length) return [];
  const candidates = [
    ...(workspace.bills || []).map((target) => ({ targetType: "bill", target })),
    ...(workspace.transactions || []).map((target) => ({ targetType: "transaction", target })),
  ];
  return candidates
    .map(({ targetType, target }) => approvalCandidate(workspace, document, details, targetType, target))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.dateDistanceDays - right.dateDistanceDays || left.targetId.localeCompare(right.targetId));
}

function approvalPendingMessage(workspace, document, details) {
  if (details.approvalStatus !== "approved") {
    const label = { draft: "草稿", pending: "审批中", rejected: "已驳回", withdrawn: "已撤回" }[details.approvalStatus] || details.approvalStatus;
    return `审批状态为${label}，不能进入后续业务`;
  }
  if (details.linkStatus === "linked" && approvalConfirmedTargetIds(workspace, document).length) return "";
  const missing = [];
  if (!approvalRule(details)) missing.push("审批类型");
  if (!approvalParty(details)) missing.push(details.approvalType === "reimbursement" ? "申请人" : "申请人／供应商");
  if (!(Number(details.amount) > 0)) missing.push("审批金额");
  if (!details.approvalDate) missing.push("审批日期");
  if (missing.length) return `审批单待处理：请补齐${missing.join("、")}`;
  const suggestions = buildApprovalLinkSuggestions(workspace, { documentId: document.id });
  return suggestions.length
    ? `审批单待人工确认：已找到 ${suggestions.length} 个金额、日期、类型与往来单位一致的对象`
    : "审批单待处理：尚未找到金额、日期、类型与往来单位一致的账单或银行流水";
}

function syncApprovalLinkPendingTask(workspace, documentId, context = {}) {
  const document = (workspace.documents || []).find((item) => item.id === documentId);
  if (!document || documentStructuredKind(document.category) !== "approval") return workspace;
  const details = normalizeDocumentStructuredData("审批单", document.structuredData || {});
  const at = context.at || new Date().toISOString();
  const actor = context.actor || "本地用户";
  const identity = `approval-link:${document.id}`;
  const message = approvalPendingMessage(workspace, document, details);
  const tasks = (workspace.exceptionTasks || []).map((task) => ({ ...task, history: [...(task.history || [])] }));
  const existing = tasks.find((task) => task.identity === identity);
  if (!message) {
    if (existing && existing.status !== "resolved") {
      existing.status = "resolved";
      existing.resolution = "approval_business_link_confirmed";
      existing.resolvedAt = at;
      existing.resolvedBy = actor;
      existing.updatedAt = at;
      existing.history.push({ at, actor, action: "resolved", note: "审批单已人工确认关联业务对象" });
    }
    return { ...workspace, exceptionTasks: tasks };
  }
  if (!existing) {
    tasks.push({
      id: createId("approval-task"),
      identity,
      code: "approval_link_pending",
      sourceType: "approvalDocument",
      sourceId: document.id,
      message,
      status: "open",
      createdAt: at,
      updatedAt: at,
      sourceIds: [document.id],
      history: [{ at, actor, action: "created", note: message }],
    });
  } else if (existing.status === "resolved" || existing.message !== message) {
    const action = existing.status === "resolved" ? "reopened" : "updated";
    existing.status = "open";
    existing.message = message;
    existing.resolution = null;
    existing.resolvedAt = null;
    existing.resolvedBy = null;
    existing.updatedAt = at;
    existing.history.push({ at, actor, action, note: message });
  }
  return { ...workspace, exceptionTasks: tasks };
}

function approvalBusinessEventNumber(workspace, approvalDate) {
  const period = String(approvalDate || workspace.currentPeriod || "").slice(0, 7).replace("-", "") || "UNDATED";
  const prefix = `BE-${period}-AP`;
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  const maximum = (workspace.businessEvents || []).reduce((current, event) => {
    const match = pattern.exec(String(event.businessEventNo || event.no || ""));
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `${prefix}-${String(maximum + 1).padStart(3, "0")}`;
}

function approvalBusinessEventForTarget(workspace, targetType, target, rule, approvalType) {
  return (workspace.businessEvents || []).find((event) => {
    const sameTarget = targetType === "transaction"
      ? (event.transactionId === target.id || event.id === target.approvalBusinessEventId)
      : (event.relatedBillId === target.id || event.billId === target.id || event.id === target.approvalBusinessEventId);
    return sameTarget && (event.eventType === rule.eventType || event.businessType === approvalType);
  }) || null;
}

function resolveApprovalInvalidatedTasks(tasks, documentId, targetId, at, actor) {
  return (tasks || []).map((task) => {
    if (task.code !== "approval_invalidated" || ![...(task.sourceIds || []), task.sourceId].includes(documentId)
      || (targetId && ![...(task.sourceIds || []), task.sourceId].includes(targetId))) return task;
    if (task.status === "resolved") return task;
    return {
      ...task,
      status: "resolved",
      resolution: "approval_reconfirmed",
      resolvedAt: at,
      resolvedBy: actor,
      updatedAt: at,
      history: [...(task.history || []), { at, actor, action: "resolved", note: "审批单重新批准并人工确认关联" }],
    };
  });
}

export function confirmApprovalBusinessLink(workspace, input = {}, context = {}) {
  if (context.mode === "automatic") throw new Error("审批业务关联不得自动确认");
  if (input.confirmed !== true) throw new Error("审批业务关联需要用户明确人工确认");
  const { document, details } = approvalDocumentOrThrow(workspace, input.documentId);
  if (details.approvalStatus !== "approved") throw new Error("只有状态为已批准的审批单才能进入后续业务");
  if (approvalConfirmedTargetIds(workspace, document).length) throw new Error("审批单已经确认关联业务对象，不能重复关联");
  const suggestion = buildApprovalLinkSuggestions(workspace, { documentId: document.id })
    .find((item) => item.targetType === input.targetType && item.targetId === input.targetId);
  if (!suggestion) throw new Error("关联对象与审批单的类型、申请人／供应商、金额或日期不一致，继续保持待处理");
  const targetCollection = suggestion.targetType === "bill" ? "bills" : "transactions";
  const target = (workspace[targetCollection] || []).find((item) => item.id === suggestion.targetId);
  if (!target) throw new Error("找不到要关联的账单或银行流水，审批单继续保持待处理");
  const at = context.at || new Date().toISOString();
  const actor = context.actor || "本地用户";
  const rule = approvalRule(details);
  const existingEvent = approvalBusinessEventForTarget(workspace, suggestion.targetType, target, rule, details.approvalType);
  const eventId = existingEvent?.id || createId("business-event");
  const eventNo = existingEvent?.businessEventNo || existingEvent?.no || approvalBusinessEventNumber(workspace, details.approvalDate);
  const approvalSource = {
    documentId: document.id,
    approvalType: details.approvalType,
    applicant: details.applicant,
    supplier: details.supplier,
    approvalDate: details.approvalDate,
    amount: Number(details.amount),
    status: "approved",
    confirmedAt: at,
    confirmedBy: actor,
  };
  const approvalSources = [...(existingEvent?.approvalSources || []).filter((source) => source.documentId !== document.id), approvalSource];
  const businessEvent = {
    ...(existingEvent || {}),
    id: eventId,
    no: eventNo,
    businessEventNo: eventNo,
    type: existingEvent?.type || rule.eventType,
    sourceType: existingEvent?.sourceType || (suggestion.targetType === "transaction" ? "bankTransaction" : "bill"),
    source: existingEvent?.source || "approved-document-manual-confirmation",
    transactionId: suggestion.targetType === "transaction" ? target.id : (existingEvent?.transactionId || null),
    relatedBillId: suggestion.targetType === "bill" ? target.id : (existingEvent?.relatedBillId || null),
    billId: suggestion.targetType === "bill" ? target.id : (existingEvent?.billId || null),
    businessType: existingEvent?.businessType || details.approvalType,
    businessTypeLabel: existingEvent?.businessTypeLabel || APPROVAL_TYPES[details.approvalType],
    eventType: existingEvent?.eventType || rule.eventType,
    date: existingEvent?.date || target.date || details.approvalDate,
    amount: existingEvent?.amount ?? Math.abs(Number(target.amount || details.amount)),
    direction: existingEvent?.direction || (suggestion.targetType === "transaction" ? approvalTransactionDirection(target) : (target.kind === "receivable" ? "in" : "out")),
    counterparty: existingEvent?.counterparty || target.counterparty || approvalParty(details),
    businessPeriod: existingEvent?.businessPeriod || String(target.businessPeriod || details.approvalDate).slice(0, 7),
    approvalDocumentIds: [...new Set([...(existingEvent?.approvalDocumentIds || []), document.id])],
    invalidatedApprovalDocumentIds: (existingEvent?.invalidatedApprovalDocumentIds || []).filter((id) => id !== document.id),
    approvalSources,
    approvalStatus: "approved",
    approvalReviewRequired: false,
    evidenceIds: [...new Set([...(existingEvent?.evidenceIds || []), ...(target.evidenceIds || []), ...(target.documentIds || []), document.id])],
    documentIds: [...new Set([...(existingEvent?.documentIds || []), ...(target.documentIds || []), ...(target.evidenceIds || []), document.id])],
    sourceIds: [...new Set([...(existingEvent?.sourceIds || []), ...(target.sourceIds || []), target.id, ...(target.documentIds || []), ...(target.evidenceIds || []), document.id])],
    automaticPostingAllowed: false,
    postingPolicy: "manual_only",
    accountingStatus: existingEvent?.accountingStatus || "unprocessed",
    status: existingEvent?.approvalStatus === "invalidated" ? "confirmed" : (existingEvent?.status || "confirmed"),
    history: [...(existingEvent?.history || []), { at, actor, action: existingEvent ? "approval_source_confirmed" : "created_from_approval", note: `${APPROVAL_TYPES[details.approvalType]}审批来源已人工确认` }],
    createdAt: existingEvent?.createdAt || at,
    createdBy: existingEvent?.createdBy || actor,
    updatedAt: at,
    updatedBy: actor,
  };
  const linkedTarget = {
    ...target,
    approvalDocumentIds: [...new Set([...(target.approvalDocumentIds || []), document.id])],
    invalidatedApprovalDocumentIds: (target.invalidatedApprovalDocumentIds || []).filter((id) => id !== document.id),
    documentIds: [...new Set([...(target.documentIds || []), document.id])],
    evidenceIds: [...new Set([...(target.evidenceIds || []), document.id])],
    sourceIds: [...new Set([...(target.sourceIds || []), document.id])],
    approvalBusinessEventId: businessEvent.id,
    approvalStatus: "approved",
    approvalReviewRequired: false,
    updatedAt: at,
  };
  const linkedDocument = {
    ...document,
    structuredData: {
      ...details,
      linkedTargetType: suggestion.targetType,
      linkedTargetId: target.id,
      businessEventId: businessEvent.id,
      linkStatus: "linked",
    },
    relatedObjectIds: [...new Set([...(document.relatedObjectIds || []), target.id, businessEvent.id])],
    updatedAt: at,
  };
  const evidenceLink = {
    id: createId("evidence-link"),
    documentIds: [document.id],
    objectIds: [target.id, businessEvent.id],
    relation: "confirmed-approval-business-link",
    note: `用户人工确认：${suggestion.reasons.join("；")}`,
    status: "active",
    matchScore: suggestion.score,
    matchReasons: suggestion.reasons,
    confirmedAt: at,
    confirmedBy: actor,
    createdAt: at,
    updatedAt: at,
  };
  let next = {
    ...workspace,
    documents: (workspace.documents || []).map((item) => item.id === document.id ? linkedDocument : item),
    [targetCollection]: (workspace[targetCollection] || []).map((item) => item.id === target.id ? linkedTarget : item),
    businessEvents: existingEvent
      ? (workspace.businessEvents || []).map((event) => event.id === existingEvent.id ? businessEvent : event)
      : [...(workspace.businessEvents || []), businessEvent],
    evidenceLinks: [...(workspace.evidenceLinks || []), evidenceLink],
    exceptionTasks: resolveApprovalInvalidatedTasks(workspace.exceptionTasks || [], document.id, target.id, at, actor),
    auditLog: [{
      id: createId("log"),
      at,
      actor,
      action: "人工确认审批业务关联",
      detail: `${APPROVAL_TYPES[details.approvalType]} · ${document.name} → ${target.no || target.summary || target.id}；未自动付款或入账`,
      sourceIds: [document.id, target.id, businessEvent.id],
    }, ...(workspace.auditLog || [])],
  };
  if (suggestion.targetType === "transaction") {
    next = reviewTransactionEvidence(next, target.id, { actor, mode: "manual", at });
  }
  next = syncApprovalLinkPendingTask(next, document.id, { actor, at });
  next = invalidateInvoiceBillConfirmations(next, at);
  return { workspace: next, document: linkedDocument, target: linkedTarget, businessEvent, evidenceLink, suggestion };
}

function invalidateApprovalBusinessLinks(workspace, documentId, context = {}) {
  const document = (workspace.documents || []).find((item) => item.id === documentId);
  if (!document || documentStructuredKind(document.category) !== "approval") return workspace;
  const details = normalizeDocumentStructuredData("审批单", document.structuredData || {});
  const targetId = details.linkedTargetId;
  const targetType = details.linkedTargetType;
  const businessEventId = details.businessEventId;
  if (details.linkStatus !== "linked" || !targetId || !targetType) return workspace;
  const at = context.at || new Date().toISOString();
  const actor = context.actor || "本地用户";
  const reason = `审批单已${details.approvalStatus === "withdrawn" ? "撤回" : "驳回"}，原业务关系失效并需重新复核`;
  const targetCollection = targetType === "bill" ? "bills" : "transactions";
  const invalidatedDocument = {
    ...document,
    structuredData: { ...details, linkStatus: "invalidated" },
    relatedObjectIds: (document.relatedObjectIds || []).filter((id) => ![targetId, businessEventId].includes(id)),
    updatedAt: at,
  };
  const targets = (workspace[targetCollection] || []).map((target) => target.id === targetId ? {
    ...target,
    approvalDocumentIds: (target.approvalDocumentIds || []).filter((id) => id !== document.id),
    invalidatedApprovalDocumentIds: [...new Set([...(target.invalidatedApprovalDocumentIds || []), document.id])],
    documentIds: (target.documentIds || []).filter((id) => id !== document.id),
    evidenceIds: (target.evidenceIds || []).filter((id) => id !== document.id),
    sourceIds: (target.sourceIds || []).filter((id) => id !== document.id),
    approvalStatus: "invalidated",
    approvalReviewRequired: true,
    ...(targetType === "transaction" ? { status: "exception" } : {}),
    updatedAt: at,
  } : target);
  const businessEvents = (workspace.businessEvents || []).map((event) => event.id === businessEventId ? {
    ...event,
    approvalDocumentIds: (event.approvalDocumentIds || []).filter((id) => id !== document.id),
    invalidatedApprovalDocumentIds: [...new Set([...(event.invalidatedApprovalDocumentIds || []), document.id])],
    approvalSources: (event.approvalSources || []).map((source) => source.documentId === document.id ? { ...source, status: "invalidated", invalidatedAt: at, invalidatedBy: actor } : source),
    approvalStatus: "invalidated",
    approvalReviewRequired: true,
    evidenceIds: (event.evidenceIds || []).filter((id) => id !== document.id),
    documentIds: (event.documentIds || []).filter((id) => id !== document.id),
    sourceIds: (event.sourceIds || []).filter((id) => id !== document.id),
    manualReviewRequired: true,
    status: "needs_review",
    review: {
      ...(event.review || {}),
      required: true,
      status: "pending",
      reasons: [...new Set([...(event.review?.reasons || []), reason])],
    },
    history: [...(event.history || []), { at, actor, action: "approval_invalidated", note: reason }],
    updatedAt: at,
    updatedBy: actor,
  } : event);
  const identity = `approval-invalidated:${document.id}:${targetId}`;
  const exceptionTasks = (workspace.exceptionTasks || []).map((task) => ({ ...task, history: [...(task.history || [])] }));
  const existingTask = exceptionTasks.find((task) => task.identity === identity);
  if (existingTask) {
    existingTask.status = "open";
    existingTask.message = reason;
    existingTask.resolution = null;
    existingTask.resolvedAt = null;
    existingTask.resolvedBy = null;
    existingTask.updatedAt = at;
    existingTask.history.push({ at, actor, action: "reopened", note: reason });
  } else {
    exceptionTasks.push({
      id: createId("approval-exception"),
      identity,
      code: "approval_invalidated",
      sourceType: targetType,
      sourceId: targetId,
      message: reason,
      status: "open",
      createdAt: at,
      updatedAt: at,
      sourceIds: [document.id, targetId, ...(businessEventId ? [businessEventId] : [])],
      history: [{ at, actor, action: "created", note: reason }],
    });
  }
  let next = {
    ...workspace,
    documents: (workspace.documents || []).map((item) => item.id === document.id ? invalidatedDocument : item),
    [targetCollection]: targets,
    businessEvents,
    evidenceLinks: (workspace.evidenceLinks || []).map((link) => (
      link.relation === "confirmed-approval-business-link" && link.documentIds?.includes(document.id)
        ? { ...link, status: "inactive", invalidatedAt: at, invalidatedBy: actor, updatedAt: at }
        : link
    )),
    exceptionTasks,
    stages: {
      ...(workspace.stages || {}),
      s3: { ...(workspace.stages?.s3 || {}), status: "needs_review", updatedAt: at },
    },
    auditLog: [{
      id: createId("log"),
      at,
      actor,
      action: "审批状态回退并使业务关系失效",
      detail: `${document.name} · ${reason}`,
      sourceIds: [document.id, targetId, ...(businessEventId ? [businessEventId] : [])],
    }, ...(workspace.auditLog || [])],
  };
  next = invalidateInvoiceBillConfirmations(next, at);
  return next;
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

function roundVatMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function structuredInvoicePeriod(document) {
  return String(document?.structuredData?.invoiceDate || "").slice(0, 7) || document?.period || null;
}

function structuredInvoiceTaxAmount(details) {
  if (details.taxAmount != null) return roundVatMoney(details.taxAmount);
  if (details.amount == null || details.taxRate == null) return null;
  const rate = Number(details.taxRate || 0) / 100;
  return roundVatMoney(rate ? Number(details.amount) * rate / (1 + rate) : 0);
}

function structuredInvoiceLinkedIds(workspace, document) {
  const ids = new Set(getDocumentRelatedObjectIds(workspace, document.id));
  (workspace.vouchers || []).forEach((voucher) => {
    if ([...(voucher.evidenceIds || []), ...(voucher.documentIds || [])].includes(document.id)) ids.add(voucher.id);
  });
  return [...ids];
}

export function buildStructuredInvoiceVatSummary(workspace, options = {}) {
  const period = options.period || workspace?.currentPeriod;
  const rows = (workspace?.documents || [])
    .filter((document) => documentStructuredKind(document.category) === "invoice" && structuredInvoicePeriod(document) === period)
    .map((document) => {
      const details = document.structuredData || {};
      const linkedObjectIds = structuredInvoiceLinkedIds(workspace, document);
      const grossAmount = details.amount == null ? null : roundVatMoney(details.amount);
      const unsignedTaxAmount = structuredInvoiceTaxAmount(details);
      const sign = details.redLetterStatus === "red_issued" ? -1 : 1;
      const taxAmount = unsignedTaxAmount == null ? null : roundVatMoney(unsignedTaxAmount * sign);
      const signedGrossAmount = grossAmount == null ? null : roundVatMoney(grossAmount * sign);
      const netAmount = signedGrossAmount == null || taxAmount == null ? null : roundVatMoney(signedGrossAmount - taxAmount);
      let bucket = "excluded";
      let reason = "";
      if (details.voidStatus === "voided") reason = "发票已作废，不计入增值税汇总";
      else if (!linkedObjectIds.length) reason = "尚未关联业务或凭证，不计入增值税汇总";
      else if (!INVOICE_STATUSES.taxDirection.includes(details.taxDirection) || details.taxDirection === "unclassified") reason = "尚未人工选择销项或进项";
      else if (grossAmount == null) reason = "缺少价税合计";
      else if (taxAmount == null) reason = "缺少税额，且无法由价税合计和税率计算";
      else if (details.taxDirection === "output") {
        bucket = "outputVat";
        reason = details.redLetterStatus === "red_applied" ? "红字申请中，当前仍按原发票正数汇总" : "计入销项税额";
      } else if (details.certificationStatus === "certified") {
        bucket = "deductibleInputVat";
        reason = "已认证，计入可抵扣进项税额";
      } else {
        bucket = "nonDeductibleInputVat";
        reason = "未认证，单独列示且不抵扣销项税额";
      }
      return {
        documentId: document.id,
        name: document.name || document.id,
        invoiceNumber: details.invoiceNumber || "",
        invoiceDate: details.invoiceDate || null,
        period,
        taxDirection: details.taxDirection || "unclassified",
        grossAmount: signedGrossAmount,
        netAmount,
        taxAmount,
        taxRate: details.taxRate,
        taxAmountSource: details.taxAmount != null ? "manual_tax_amount" : (taxAmount == null ? "missing" : "derived_from_gross_and_rate"),
        verificationStatus: details.verificationStatus || "unverified",
        certificationStatus: details.certificationStatus || "not_required",
        redLetterStatus: details.redLetterStatus || "normal",
        voidStatus: details.voidStatus || "valid",
        linkedObjectIds,
        sourceIds: [document.id, ...linkedObjectIds],
        bucket,
        included: bucket !== "excluded",
        deductible: bucket === "deductibleInputVat",
        reason,
        recognitionMode: "manual_structured_invoice",
        onlineVerification: false,
      };
    });
  const sum = (bucket, field) => roundVatMoney(rows
    .filter((row) => row.bucket === bucket)
    .reduce((total, row) => total + Number(row[field] || 0), 0));
  const outputVat = sum("outputVat", "taxAmount");
  const deductibleInputVat = sum("deductibleInputVat", "taxAmount");
  const nonDeductibleInputVat = sum("nonDeductibleInputVat", "taxAmount");
  const usesStructuredInvoices = rows.some((row) => row.included);
  return {
    period,
    sourceMode: usesStructuredInvoices ? "structured_invoices" : "legacy_estimate",
    usesStructuredInvoices,
    outputGrossAmount: sum("outputVat", "grossAmount"),
    outputNetAmount: sum("outputVat", "netAmount"),
    outputVat,
    inputGrossAmount: roundVatMoney(sum("deductibleInputVat", "grossAmount") + sum("nonDeductibleInputVat", "grossAmount")),
    inputNetAmount: roundVatMoney(sum("deductibleInputVat", "netAmount") + sum("nonDeductibleInputVat", "netAmount")),
    inputVat: roundVatMoney(deductibleInputVat + nonDeductibleInputVat),
    deductibleInputVat,
    nonDeductibleInputVat,
    vatPayable: Math.max(0, roundVatMoney(outputVat - deductibleInputVat)),
    inputVatCreditCarryForward: Math.max(0, roundVatMoney(deductibleInputVat - outputVat)),
    sourceIds: rows.filter((row) => row.included).map((row) => row.documentId),
    rows,
    counts: {
      total: rows.length,
      output: rows.filter((row) => row.bucket === "outputVat").length,
      deductibleInput: rows.filter((row) => row.bucket === "deductibleInputVat").length,
      nonDeductibleInput: rows.filter((row) => row.bucket === "nonDeductibleInputVat").length,
      excluded: rows.filter((row) => row.bucket === "excluded").length,
    },
    disclaimer: "仅按本地人工录入的发票字段计算；查验状态不代表已连接税务平台。",
  };
}

function comparableInvoiceVatSummary(summary) {
  if (!summary) return null;
  const { recalculatedAt: _recalculatedAt, ...stable } = summary;
  return stable;
}

export function recalculateStructuredInvoiceVat(workspace, options = {}) {
  const period = options.period || workspace.currentPeriod;
  const summary = buildStructuredInvoiceVatSummary(workspace, { period });
  const previous = workspace.tax?.invoiceVatSummary;
  if (JSON.stringify(comparableInvoiceVatSummary(previous)) === JSON.stringify(summary)) return workspace;
  const timestamp = options.at || new Date().toISOString();
  const filing = workspace.delivery?.filing || {};
  return {
    ...workspace,
    tax: {
      ...(workspace.tax || {}),
      invoiceVatSummary: { ...summary, recalculatedAt: timestamp },
      frozenAt: null,
      financeConfirmedAt: null,
      payrollConfirmedAt: null,
      socialSecurityConfirmedAt: null,
      ownerConfirmedAt: null,
      confirmedBy: "",
      financeConfirmedVersionId: null,
      payrollConfirmedVersionId: null,
      socialSecurityConfirmedVersionId: null,
      payrollConfirmedFingerprint: null,
      socialSecurityConfirmedFingerprint: null,
      ownerConfirmedVersionId: null,
    },
    delivery: {
      ...(workspace.delivery || {}),
      filing: {
        ...filing,
        period,
        draftCreatedAt: null,
        draftVersionId: null,
        initialConfirmationId: null,
        finalConfirmedVersionId: null,
        exportedAt: null,
        exportedPackage: null,
        receipt: null,
        archivedAt: null,
      },
    },
  };
}

function normalizedPayrollHeader(value) {
  return normalizedText(value).replace(/[\s_\-—:：()（）/／\\]+/g, "");
}

function payrollMappingIndex(value) {
  if (value === "" || value == null) return null;
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

export function detectPayrollSocialFieldMapping(headers = []) {
  const normalizedHeaders = headers.map(normalizedPayrollHeader);
  const used = new Set();
  return Object.fromEntries(Object.entries(PAYROLL_SOCIAL_FIELD_DEFINITIONS).map(([field, definition]) => {
    const aliases = definition.aliases.map(normalizedPayrollHeader);
    const index = normalizedHeaders.findIndex((header, candidateIndex) => !used.has(candidateIndex) && aliases.includes(header));
    if (index >= 0) used.add(index);
    return [field, index >= 0 ? index : null];
  }));
}

export function inspectPayrollSocialTable(table = []) {
  if (!Array.isArray(table) || !table.length) {
    return { headerRowIndex: 0, headers: [], mapping: detectPayrollSocialFieldMapping([]), score: 0 };
  }
  const candidates = table.slice(0, 20).map((row, headerRowIndex) => {
    const headers = Array.isArray(row) ? row.map((cell) => String(cell ?? "").trim()) : [];
    const mapping = detectPayrollSocialFieldMapping(headers);
    const score = Object.values(mapping).filter((index) => index != null).length + (mapping.employee != null ? 5 : 0);
    return { headerRowIndex, headers, mapping, score };
  });
  return candidates.sort((left, right) => right.score - left.score || left.headerRowIndex - right.headerRowIndex)[0];
}

export async function readPayrollSocialFile(file, options = {}) {
  if (!file) throw new Error("请选择工资或社保文件");
  const fileName = options.fileName || file.name || "工资社保表";
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "csv" || extension === "txt") {
    const text = typeof file.text === "function"
      ? await file.text()
      : new TextDecoder(options.encoding || "utf-8").decode(await file.arrayBuffer());
    const parsed = parseDelimitedText(text, options);
    return { fileName, sheetName: null, table: parsed.table, delimiter: parsed.delimiter, inspection: inspectPayrollSocialTable(parsed.table) };
  }
  if (!["xlsx", "xls"].includes(extension)) throw new Error("工资与社保导入仅支持 CSV、XLSX 和 XLS 文件");
  const XLSX = await import("xlsx");
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: "array", cellDates: true });
  const sheetName = options.sheetName || workbook.SheetNames[0];
  if (!sheetName || !workbook.Sheets[sheetName]) throw new Error("Excel 文件中没有可读取的工作表");
  const table = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: true });
  return { fileName, sheetName, sheetNames: workbook.SheetNames, table, inspection: inspectPayrollSocialTable(table) };
}

function normalizePayrollPeriod(value, fallback = "") {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 7);
  if (typeof value === "number") {
    const compact = String(Math.trunc(value)).match(/^(\d{4})(\d{2})$/);
    if (compact) value = `${compact[1]}-${compact[2]}`;
    else if (value > 20_000 && value < 80_000) {
      const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
      if (!Number.isNaN(date.valueOf())) return date.toISOString().slice(0, 7);
    }
  }
  const text = String(value ?? "").trim();
  if (!text) {
    const fallbackText = String(fallback ?? "").trim();
    return fallbackText ? normalizePayrollPeriod(fallbackText) : null;
  }
  const match = text.match(/^(\d{4})[\-/.年](\d{1,2})(?:月|(?:[\-/.]\d{1,2}).*)?$/);
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${match[1]}-${String(month).padStart(2, "0")}` : null;
}

function payrollRecordIdentity(record) {
  return record.personnelId ? `person:${record.personnelId}` : `name:${normalizedText(record.employeeName).replace(/\s+/g, "")}`;
}

export function payrollSocialDedupeKey(record) {
  return `${record.sourceKind}:${record.period}:${payrollRecordIdentity(record)}`;
}

function payrollCell(row, mapping, field) {
  const index = payrollMappingIndex(mapping?.[field]);
  return index == null ? undefined : row[index];
}

function payrollMoney(row, mapping, field) {
  const value = payrollCell(row, mapping, field);
  if (value === "" || value == null) return null;
  return normalizeMoney(value);
}

export function preparePayrollSocialImport(workspace, input = {}) {
  const sourceKind = input.sourceKind;
  if (!PAYROLL_SOCIAL_IMPORT_KINDS[sourceKind]) throw new Error("请选择工资表或社保表");
  const table = Array.isArray(input.table) ? input.table : [];
  const inspection = input.inspection || inspectPayrollSocialTable(table);
  const headerRowIndex = Number.isInteger(input.headerRowIndex) ? input.headerRowIndex : inspection.headerRowIndex;
  const headers = table[headerRowIndex]?.map((cell) => String(cell ?? "").trim()) || inspection.headers || [];
  const mapping = Object.fromEntries(Object.keys(PAYROLL_SOCIAL_FIELD_DEFINITIONS).map((field) => [field, payrollMappingIndex(input.mapping?.[field] ?? inspection.mapping?.[field])]));
  const mappingErrors = [];
  if (mapping.employee == null) mappingErrors.push("必须映射员工列");
  if (mapping.period == null && !normalizePayrollPeriod(input.defaultPeriod)) mappingErrors.push("必须映射所属期列或填写默认所属期");
  const relevantFields = sourceKind === "payroll" ? ["grossSalary", "netSalary"] : ["personalSocial", "employerSocial"];
  if (relevantFields.every((field) => mapping[field] == null)) {
    mappingErrors.push(sourceKind === "payroll" ? "工资表至少映射应发工资或实发工资" : "社保表至少映射个人社保或企业社保");
  }

  const personnel = workspace.personnelRecords || [];
  const rowsByKey = new Map();
  const errors = [];
  let duplicateRowCount = 0;
  table.slice(headerRowIndex + 1).forEach((sourceRow, offset) => {
    const sourceRowNumber = headerRowIndex + offset + 2;
    if (!Array.isArray(sourceRow) || sourceRow.every((value) => String(value ?? "").trim() === "")) return;
    const employeeName = String(payrollCell(sourceRow, mapping, "employee") ?? "").trim();
    const period = normalizePayrollPeriod(payrollCell(sourceRow, mapping, "period"), input.defaultPeriod);
    const amounts = Object.fromEntries(["grossSalary", "personalSocial", "employerSocial", "individualIncomeTax", "netSalary"].map((field) => [field, payrollMoney(sourceRow, mapping, field)]));
    const invalidMoneyField = Object.entries(amounts).find(([field, value]) => {
      const raw = payrollCell(sourceRow, mapping, field);
      return raw !== "" && raw != null && value == null;
    });
    if (!employeeName) {
      errors.push({ rowNumber: sourceRowNumber, message: "员工为空" });
      return;
    }
    if (!period) {
      errors.push({ rowNumber: sourceRowNumber, employeeName, message: "所属期无法识别" });
      return;
    }
    if (invalidMoneyField) {
      errors.push({ rowNumber: sourceRowNumber, employeeName, message: `${PAYROLL_SOCIAL_FIELD_DEFINITIONS[invalidMoneyField[0]].label}不是有效金额` });
      return;
    }
    if (relevantFields.every((field) => amounts[field] == null)) {
      errors.push({ rowNumber: sourceRowNumber, employeeName, message: sourceKind === "payroll" ? "缺少应发或实发工资" : "缺少个人或企业社保" });
      return;
    }
    const normalizedEmployee = normalizedText(employeeName).replace(/\s+/g, "");
    const matchedPersonnel = personnel.find((item) => normalizedText(item.id).replace(/\s+/g, "") === normalizedEmployee
      || normalizedText(item.name).replace(/\s+/g, "") === normalizedEmployee) || null;
    const record = {
      sourceKind,
      period,
      employeeName: matchedPersonnel?.name || employeeName,
      personnelId: matchedPersonnel?.id || null,
      personnelStatusAtImport: matchedPersonnel?.status || null,
      ...amounts,
      sourceRowNumber,
    };
    const key = payrollSocialDedupeKey(record);
    if (rowsByKey.has(key)) duplicateRowCount += 1;
    rowsByKey.set(key, { ...record, dedupeKey: key });
  });

  const existingKeys = new Set((workspace.payrollRecords || []).map(payrollSocialDedupeKey));
  const rows = [...rowsByKey.values()];
  const replacementCount = rows.filter((row) => existingKeys.has(row.dedupeKey)).length;
  const periods = [...new Set(rows.map((row) => row.period))];
  return {
    id: input.id || createId("payroll-import"),
    fileName: input.fileName || `${PAYROLL_SOCIAL_IMPORT_KINDS[sourceKind]}.csv`,
    sourceKind,
    importedAt: input.importedAt || new Date().toISOString(),
    headerRowIndex,
    headers,
    mapping,
    rows,
    errors,
    mappingErrors,
    duplicateRowCount,
    replacementCount,
    periods,
    canApply: mappingErrors.length === 0 && errors.length === 0 && rows.length > 0,
    localOnly: true,
  };
}

function payrollDatasetFingerprint(records, personnelRecords) {
  const personnelById = new Map((personnelRecords || []).map((person) => [person.id, person]));
  return JSON.stringify(records
    .map((record) => {
      const person = personnelById.get(record.personnelId);
      return {
        id: record.id,
        sourceKind: record.sourceKind,
        period: record.period,
        employeeName: record.employeeName,
        personnelId: record.personnelId,
        personnelStatus: person?.status || null,
        grossSalary: record.grossSalary,
        personalSocial: record.personalSocial,
        employerSocial: record.employerSocial,
        individualIncomeTax: record.individualIncomeTax,
        netSalary: record.netSalary,
        sourceImportId: record.sourceImportId,
      };
    })
    .sort((left, right) => payrollSocialDedupeKey(left).localeCompare(payrollSocialDedupeKey(right))));
}

export function buildPayrollSocialSummary(workspace, options = {}) {
  const period = options.period || workspace.currentPeriod;
  const periodRecords = (workspace.payrollRecords || []).filter((record) => record.period === period);
  const payrollRecords = periodRecords.filter((record) => record.sourceKind === "payroll");
  const socialSecurityRecords = periodRecords.filter((record) => record.sourceKind === "socialSecurity");
  const personnelRecords = workspace.personnelRecords || [];
  const personnelById = new Map(personnelRecords.map((person) => [person.id, person]));
  const personnelByName = new Map(personnelRecords.map((person) => [normalizedText(person.name).replace(/\s+/g, ""), person]));
  const resolvePerson = (record) => personnelById.get(record?.personnelId) || personnelByName.get(normalizedText(record?.employeeName).replace(/\s+/g, "")) || null;
  const comparisonByKey = new Map();
  const addRecord = (record) => {
    const person = resolvePerson(record);
    const key = person ? `person:${person.id}` : `name:${normalizedText(record.employeeName).replace(/\s+/g, "")}`;
    const current = comparisonByKey.get(key) || { key, person, employeeName: person?.name || record.employeeName, payrollRecord: null, socialSecurityRecord: null };
    current.person = current.person || person;
    current.employeeName = current.person?.name || current.employeeName;
    if (record.sourceKind === "payroll") current.payrollRecord = record;
    else current.socialSecurityRecord = record;
    comparisonByKey.set(key, current);
  };
  periodRecords.forEach(addRecord);
  personnelRecords.filter((person) => !person.status || person.status === "active").forEach((person) => {
    const key = `person:${person.id}`;
    if (!comparisonByKey.has(key)) comparisonByKey.set(key, { key, person, employeeName: person.name, payrollRecord: null, socialSecurityRecord: null });
  });

  const difference = (payrollRecord, socialRecord, field) => {
    if (payrollRecord?.[field] == null || socialRecord?.[field] == null) return null;
    return Math.round((Number(payrollRecord[field]) - Number(socialRecord[field])) * 100) / 100;
  };
  const rows = [...comparisonByKey.values()].map((row) => {
    const issues = [];
    const status = row.person?.status || null;
    if (!row.person) issues.push({ code: "missing_personnel", label: "人员档案缺失" });
    else if (status && status !== "active") issues.push({ code: "departed_personnel", label: `非在职人员（${status}）` });
    if (!row.payrollRecord) issues.push({ code: "missing_payroll", label: "工资表缺失" });
    if (!row.socialSecurityRecord) issues.push({ code: "missing_social_security", label: "社保表缺失" });
    const differences = {
      grossSalary: difference(row.payrollRecord, row.socialSecurityRecord, "grossSalary"),
      personalSocial: difference(row.payrollRecord, row.socialSecurityRecord, "personalSocial"),
      employerSocial: difference(row.payrollRecord, row.socialSecurityRecord, "employerSocial"),
    };
    Object.entries(differences).forEach(([field, value]) => {
      if (value != null && Math.abs(value) > 0.01) issues.push({ code: `${field}_difference`, label: `${PAYROLL_SOCIAL_FIELD_DEFINITIONS[field].label}差额 ${value.toFixed(2)}` });
    });
    return { ...row, personnelStatus: status, differences, issues, matched: issues.length === 0 };
  }).sort((left, right) => left.employeeName.localeCompare(right.employeeName, "zh-CN"));

  const totalsFor = (records) => Object.fromEntries(["grossSalary", "personalSocial", "employerSocial", "individualIncomeTax", "netSalary"].map((field) => [field, Math.round(records.reduce((sum, record) => sum + Number(record[field] || 0), 0) * 100) / 100]));
  const payrollTotals = totalsFor(payrollRecords);
  const socialTotals = totalsFor(socialSecurityRecords);
  return {
    period,
    payrollRecords,
    socialSecurityRecords,
    rows,
    totals: {
      payroll: payrollTotals,
      socialSecurity: socialTotals,
      socialSecurityPayable: Math.round((socialTotals.personalSocial + socialTotals.employerSocial) * 100) / 100,
    },
    fingerprints: {
      payroll: payrollDatasetFingerprint(payrollRecords, personnelRecords),
      socialSecurity: payrollDatasetFingerprint(socialSecurityRecords, personnelRecords),
    },
    counts: {
      payroll: payrollRecords.length,
      socialSecurity: socialSecurityRecords.length,
      compared: rows.length,
      issues: rows.filter((row) => row.issues.length).length,
      missingPersonnel: rows.filter((row) => row.issues.some((issue) => issue.code === "missing_personnel")).length,
      departedPersonnel: rows.filter((row) => row.issues.some((issue) => issue.code === "departed_personnel")).length,
    },
    hasDifferences: rows.some((row) => row.issues.length),
    disclaimer: "工资与社保数据来自当前浏览器本地导入；未连接社保、个税或税务平台。",
  };
}

export function applyPayrollSocialImport(workspace, plan, context = {}) {
  if (!plan?.canApply) {
    const reasons = [...(plan?.mappingErrors || []), ...(plan?.errors || []).map((error) => `第 ${error.rowNumber} 行：${error.message}`)];
    throw new Error(reasons.length ? `工资社保导入前需修正：${reasons.join("；")}` : "工资社保导入没有可写入的有效记录");
  }
  const importedAt = context.at || plan.importedAt || new Date().toISOString();
  const actor = context.actor || "本地用户";
  const existing = workspace.payrollRecords || [];
  const existingByKey = new Map(existing.map((record) => [payrollSocialDedupeKey(record), record]));
  const importedRows = plan.rows.map((row) => {
    const previous = existingByKey.get(row.dedupeKey);
    return {
      ...row,
      id: previous?.id || createId("payroll-record"),
      sourceImportId: plan.id,
      sourceFileName: plan.fileName,
      importedAt,
      importedBy: actor,
      localOnly: true,
    };
  });
  const incomingKeys = new Set(importedRows.map(payrollSocialDedupeKey));
  const payrollRecords = [...existing.filter((record) => !incomingKeys.has(payrollSocialDedupeKey(record))), ...importedRows];
  const importRecord = {
    id: plan.id,
    sourceKind: plan.sourceKind,
    fileName: plan.fileName,
    importedAt,
    importedBy: actor,
    periods: plan.periods,
    mapping: plan.mapping,
    rowCount: importedRows.length,
    duplicateRowCount: plan.duplicateRowCount,
    replacementCount: plan.replacementCount,
    recordIds: importedRows.map((row) => row.id),
    localOnly: true,
    externalUpload: false,
  };
  const base = {
    ...workspace,
    payrollRecords,
    payrollImports: [...(workspace.payrollImports || []), importRecord],
  };
  const currentSummary = buildPayrollSocialSummary(base, { period: workspace.currentPeriod });
  const filing = workspace.delivery?.filing || {};
  return {
    ...base,
    tax: {
      ...(workspace.tax || {}),
      payroll: currentSummary.payrollRecords.length ? currentSummary.totals.payroll.grossSalary : Number(workspace.tax?.payroll || 0),
      socialSecurity: currentSummary.socialSecurityRecords.length ? currentSummary.totals.socialSecurityPayable : Number(workspace.tax?.socialSecurity || 0),
      payrollSourceIds: currentSummary.payrollRecords.map((record) => record.id),
      socialSecuritySourceIds: currentSummary.socialSecurityRecords.map((record) => record.id),
      frozenAt: null,
      financeConfirmedAt: null,
      payrollConfirmedAt: null,
      socialSecurityConfirmedAt: null,
      ownerConfirmedAt: null,
      confirmedBy: "",
      financeConfirmedVersionId: null,
      payrollConfirmedVersionId: null,
      socialSecurityConfirmedVersionId: null,
      payrollConfirmedFingerprint: null,
      socialSecurityConfirmedFingerprint: null,
      ownerConfirmedVersionId: null,
    },
    delivery: {
      ...(workspace.delivery || {}),
      filing: {
        ...filing,
        period: workspace.currentPeriod,
        draftCreatedAt: null,
        draftVersionId: null,
        initialConfirmationId: null,
        finalConfirmedVersionId: null,
        exportedAt: null,
        exportedPackage: null,
        receipt: null,
        archivedAt: null,
      },
    },
    auditLog: [{
      id: createId("log"),
      at: importedAt,
      actor,
      action: `导入${PAYROLL_SOCIAL_IMPORT_KINDS[plan.sourceKind]}`,
      detail: `${plan.fileName} · 写入 ${importedRows.length} 人次 · 文件内去重 ${plan.duplicateRowCount} 行 · 覆盖旧记录 ${plan.replacementCount} 行 · 仅保存在当前浏览器`,
    }, ...(workspace.auditLog || [])],
  };
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
    if (documentStructuredKind(metadata.category) === "invoice" && structuredInvoicePeriod(metadata) === current.currentPeriod) {
      next = recalculateStructuredInvoiceVat(next, { period: current.currentPeriod, at: metadata.updatedAt });
    }
    if (documentStructuredKind(metadata.category) === "approval") {
      next = syncApprovalLinkPendingTask(next, metadata.id, { actor, at: metadata.updatedAt });
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
  if ([document, updatedDocument].some((item) => (
    documentStructuredKind(item.category) === "invoice" && structuredInvoicePeriod(item) === workspace.currentPeriod
  ))) {
    next = recalculateStructuredInvoiceVat(next, { period: workspace.currentPeriod, at: timestamp });
  }
  const approvalWasInvalidated = documentStructuredKind(document.category) === "approval"
    && document.structuredData?.approvalStatus === "approved"
    && ["rejected", "withdrawn"].includes(updatedDocument.structuredData?.approvalStatus);
  if (approvalWasInvalidated) {
    next = invalidateApprovalBusinessLinks(next, documentId, { actor, at: timestamp });
  }
  if (documentStructuredKind(updatedDocument.category) === "approval") {
    next = syncApprovalLinkPendingTask(next, documentId, { actor, at: timestamp });
  }
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
  if (suggestion.documentKind === "approval") {
    const confirmation = confirmApprovalBusinessLink(workspace, {
      documentId: document.id,
      targetType: "transaction",
      targetId: target.id,
      confirmed: true,
    }, { actor: resolvedActor, at: timestamp, mode: "manual" });
    const afterTaskSync = syncDocumentMissingTasks(confirmation.workspace, { actor: resolvedActor, at: timestamp });
    store.actions.replaceWorkspace(workspaceId, afterTaskSync.workspace, {
      requiredPermission: "documents.add",
      audit: {
        actor: resolvedActor,
        action: "确认审批单业务匹配",
        detail: `${document.name} → ${suggestion.sourceLabel}；已补充业务事件审批来源，未自动付款或入账`,
      },
    });
    return {
      suggestion,
      link: confirmation.evidenceLink,
      businessEvent: confirmation.businessEvent,
      closedTaskCount: afterTaskSync.resolved,
      openTaskCount: afterTaskSync.open,
    };
  }
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
  if (documentStructuredKind(document.category) === "invoice" && structuredInvoicePeriod(document) === workspace.currentPeriod) {
    next = recalculateStructuredInvoiceVat(next, { period: workspace.currentPeriod, at: timestamp });
  }
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
    ...(relations.documents.length ? [] : [{
      key: `voucher-original:${voucher.id}`,
      kind: "voucher_original",
      sectionKey: "missing",
      sourceId: voucher.id,
      label: "原始资料",
      reason: `凭证 ${voucher.no || voucher.id} 尚未关联任何原始资料`,
    }]),
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

const VOUCHER_ATTACHMENT_TASK_SECTIONS = new Set(["bankReceipt", "invoice", "contractOrder", "approval"]);

function voucherAttachmentTaskRequirements(workspace) {
  return (workspace?.vouchers || []).flatMap((voucher) => {
    const plan = buildVoucherAttachmentPackagePlan(workspace, voucher.id);
    const sourceLabel = `凭证 ${voucher.no || voucher.id}`;
    return plan.missingItems
      .filter((item) => (
        item.kind === "voucher_original"
        || item.kind === "original_file"
        || (item.kind === "section" && VOUCHER_ATTACHMENT_TASK_SECTIONS.has(item.sectionKey))
      ))
      .map((item) => ({
        identity: `voucher-attachment:${voucher.id}:${item.key}`,
        sourceType: "voucher",
        sourceId: voucher.id,
        sourceIds: [voucher.id, item.documentId, ...plan.sourceIds].filter(Boolean),
        sourceLabel,
        eventType: "voucher_attachment",
        requirementId: item.key,
        label: item.kind === "original_file" ? `${item.label}原文件` : item.label,
        anyOf: [],
        satisfied: false,
        linkedDocumentIds: plan.documents.map((document) => document.id),
        documentId: item.documentId || null,
        sectionKey: item.sectionKey,
        reason: item.reason,
        message: `${sourceLabel}缺件：${item.reason}`,
      }));
  });
}

export function getDocumentTaskRequirements(workspace) {
  return [
    ...getDocumentMissingRequirements(workspace),
    ...voucherAttachmentTaskRequirements(workspace),
  ];
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
    socialSecurityConfirmedAt: confirmationState.socialSecurityConfirmedAt || null,
    financeConfirmedVersionId: confirmationState.financeConfirmedVersionId || null,
    payrollConfirmedVersionId: confirmationState.payrollConfirmedVersionId || null,
    socialSecurityConfirmedVersionId: confirmationState.socialSecurityConfirmedVersionId || null,
  };
  initialConfirmation.complete = Boolean(
    initialConfirmation.id
    && initialConfirmation.financeConfirmedAt
    && initialConfirmation.payrollConfirmedAt
    && initialConfirmation.socialSecurityConfirmedAt
    && initialConfirmation.financeConfirmedVersionId
    && initialConfirmation.payrollConfirmedVersionId
    && initialConfirmation.socialSecurityConfirmedVersionId
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
  const payrollSocialSummary = taxWorkpaper?.payrollSocialSummary || buildPayrollSocialSummary(workspace, { period });
  const payroll = {
    period,
    payroll: taxWorkpaperValue(taxWorkpaper, "payroll"),
    socialSecurity: taxWorkpaperValue(taxWorkpaper, "socialSecurity"),
    summary: payrollSocialSummary,
    payrollRecords: payrollSocialSummary.payrollRecords,
    socialSecurityRecords: payrollSocialSummary.socialSecurityRecords,
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
    { key: "initialConfirmation", label: "第一次客户确认记录完整", ok: initialConfirmation.complete, reason: initialConfirmation.complete ? "首次财务、工资表与社保表确认已分别记录" : "缺少首次财务/工资表/社保表确认时间、记录或版本关联" },
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
