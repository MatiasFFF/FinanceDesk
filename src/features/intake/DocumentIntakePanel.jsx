import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  DownloadSimple,
  Eye,
  FileArrowUp,
  FileText,
  MagnifyingGlass,
  PencilSimple,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import {
  buildVatReconciliationSummary,
  confirmPayrollSocialData,
  getPayrollSocialConfirmationState,
  recordVatReconciliation,
  workspaceModuleEnabled,
} from "../../productWorkflow.js";
import {
  CONTRACT_DUE_DATE_RULES,
  CONTRACT_SETTLEMENT_MODES,
  CONTRACT_TYPES,
  APPROVAL_TYPES,
  PAYROLL_SOCIAL_FIELD_DEFINITIONS,
  PAYROLL_SOCIAL_IMPORT_KINDS,
  applyRedInvoiceBillAdjustment,
  applyContractBillingPlan,
  applyPayrollSocialImport,
  buildContractBillingPlan,
  buildApprovalLinkSuggestions,
  buildInvoiceBillSuggestions,
  buildPayrollSocialSummary,
  buildDocumentMatchSuggestions,
  buildMonthlyFinancialArchivePlan,
  buildStructuredInvoiceVatSummary,
  buildVoucherAttachmentPackagePlan,
  confirmDocumentMatch,
  confirmApprovalBusinessLink,
  confirmInvoiceBillMatch,
  createBillFromInvoice,
  documentStructuredKind,
  downloadStoredDocument,
  filterLocalDocuments,
  getDocumentRelatedObjectIds,
  getDocumentTaskRequirements,
  getLocalDocumentUsage,
  getMonthlyFinancialArchivePeriods,
  getStoredDocumentRecord,
  generateMonthlyFinancialArchivePackage,
  generateVoucherAttachmentPackage,
  normalizeDocumentStructuredData,
  preparePayrollSocialImport,
  readPayrollSocialFile,
  refreshDocumentMissingTasks,
  removeLocalDocument,
  saveLocalDocument,
  updateLocalDocumentMetadata,
} from "./documentIntake.js";

const CATEGORIES = ["主体资料", "合同", "银行流水", "业务资料", "发票", "审批资料", "人员资料", "会计资料", "申报回执", "其他资料"];

const RELATED_GROUPS = [
  ["凭证", "vouchers"],
  ["银行账户", "bankAccounts"],
  ["银行流水", "transactions"],
  ["业务事件", "businessEvents"],
  ["应收应付与预收预付", "bills"],
  ["合同", "contracts"],
  ["发票", "invoices"],
  ["审批单", "approvals"],
  ["人员", "personnelRecords"],
];

const INVOICE_STATUS_OPTIONS = {
  verificationStatus: [["unverified", "未查验"], ["verified", "已查验"], ["failed", "查验异常"]],
  redLetterStatus: [["normal", "正常蓝字"], ["red_applied", "红字申请中"], ["red_issued", "已开红字"]],
  voidStatus: [["valid", "有效"], ["voided", "已作废"]],
  certificationStatus: [["not_required", "无需认证"], ["pending", "待认证"], ["certified", "已认证"], ["rejected", "认证异常"]],
};

const INVOICE_TAX_DIRECTION_OPTIONS = [["unclassified", "未分类"], ["output", "销项发票"], ["input", "进项发票"]];

const VAT_RECONCILIATION_STATUS_LABELS = {
  no_difference: "无差额",
  explained: "已解释",
  source_changed: "来源已变化，需重新核对",
  unexplained: "待解释",
};

const APPROVAL_STATUS_OPTIONS = [["draft", "草稿"], ["pending", "审批中"], ["approved", "已通过"], ["rejected", "已驳回"], ["withdrawn", "已撤回"]];

function statusLabel(options, value, fallback) {
  return options.find(([id]) => id === value)?.[1] || fallback;
}

function relatedLabel(item) {
  return item.name || item.title || item.no || item.counterparty || item.summary || item.id;
}

function fileSize(size) {
  if (!Number.isFinite(Number(size))) return "未知大小";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function amountLabel(value) {
  if (value === "" || value == null) return "未填写";
  return `¥${Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function structuredDetailLines(document) {
  const kind = documentStructuredKind(document.category);
  const details = document.structuredData || {};
  if (kind === "contract") {
    return [
      `合同主体：${details.partyA || "未填写"} ↔ ${details.partyB || "未填写"} · 金额 ${amountLabel(details.amount)}`,
      `合同类型：${CONTRACT_TYPES[details.contractType] || "未选择"} · ${CONTRACT_SETTLEMENT_MODES[details.settlementMode] || details.settlementCycle || "未设置结算"}`,
      `账单计划：每期 ${amountLabel(details.periodAmount)} · 首次 ${details.firstBillDate || "未填写"} · 结束 ${details.billingEndDate || "未填写"} · ${CONTRACT_DUE_DATE_RULES[details.dueDateRule] || "未设置到期规则"}${details.dueDateRule === "days_after" ? ` ${details.dueDays || 0} 天` : ""}`,
      `服务期限：${details.serviceStartDate || "未填写"} 至 ${details.serviceEndDate || "未填写"}`,
      `退款条款：${details.refundTerms || "未填写"}`,
      `佣金条款：${details.commissionTerms || "未填写"}`,
    ];
  }
  if (kind === "invoice") {
    return [
      `发票号码：${details.invoiceNumber || "未填写"} · 日期 ${details.invoiceDate || "未填写"} · ${statusLabel(INVOICE_TAX_DIRECTION_OPTIONS, details.taxDirection, "未分类")}`,
      `${details.taxDirection === "output" ? "客户" : (details.taxDirection === "input" ? "供应商" : "往来单位")}：${details.counterparty || "未填写"} · 金额 ${amountLabel(details.amount)} · 税额 ${amountLabel(details.taxAmount)} · 税率 ${details.taxRate == null ? "未填写" : `${details.taxRate}%`}`,
      `查验 ${statusLabel(INVOICE_STATUS_OPTIONS.verificationStatus, details.verificationStatus, "未查验")} · 红字 ${statusLabel(INVOICE_STATUS_OPTIONS.redLetterStatus, details.redLetterStatus, "正常蓝字")} · 作废 ${statusLabel(INVOICE_STATUS_OPTIONS.voidStatus, details.voidStatus, "有效")} · 认证 ${statusLabel(INVOICE_STATUS_OPTIONS.certificationStatus, details.certificationStatus, "无需认证")}`,
      details.redLetterStatus === "normal"
        ? `关联账单：${details.linkedBillId || "尚未确认"}`
        : `原发票：${details.originalInvoiceDocumentId || "未选择"} · 原账单：${details.originalBillId || "未选择"} · 已调整账单：${details.linkedBillId || "尚未确认"}`,
    ];
  }
  if (kind === "approval") {
    return [
      `审批类型：${APPROVAL_TYPES[details.approvalType] || "未选择"} · ${statusLabel(APPROVAL_STATUS_OPTIONS, details.approvalStatus, "草稿")} · 日期 ${details.approvalDate || "未填写"}`,
      `申请人：${details.applicant || "未填写"} · 供应商／对象：${details.supplier || "未填写"} · 金额 ${amountLabel(details.amount)}`,
      `业务关联：${details.linkStatus === "linked" ? `${details.linkedTargetType === "bill" ? "账单" : "银行流水"} ${details.linkedTargetId}` : (details.linkStatus === "invalidated" ? "原关联已失效，等待重新处理" : "尚未确认")} · 业务事件 ${details.businessEventId || "未生成"}`,
    ];
  }
  return [];
}

function StructuredDataFields({ category, value, onChange, workspace, currentDocumentId }) {
  const kind = documentStructuredKind(category);
  if (!kind) return null;
  const details = value?.kind === kind ? value : normalizeDocumentStructuredData(category, {});
  const update = (key, nextValue) => onChange({ ...details, [key]: nextValue });
  if (kind === "contract") {
    const membershipEnabled = workspaceModuleEnabled(workspace, "members");
    const contractTypes = Object.entries(CONTRACT_TYPES).filter(([id]) => (
      id !== "membership" || membershipEnabled || details.contractType === "membership"
    ));
    return (
      <div className="document-intake-controls">
        <label className="foundation-field"><span>合同甲方</span><input value={details.partyA || ""} onChange={(event) => update("partyA", event.target.value)} /></label>
        <label className="foundation-field"><span>合同乙方</span><input value={details.partyB || ""} onChange={(event) => update("partyB", event.target.value)} /></label>
        <label className="foundation-field"><span>合同类型</span><select value={details.contractType || "unclassified"} onChange={(event) => update("contractType", event.target.value)}>{contractTypes.map(([id, label]) => <option value={id} key={id}>{label}{id === "membership" && !membershipEnabled ? "（会员模块已停用）" : ""}</option>)}</select></label>
        <label className="foundation-field"><span>合同金额</span><input type="number" min="0" step="0.01" value={details.amount ?? ""} onChange={(event) => update("amount", event.target.value)} /></label>
        <label className="foundation-field"><span>结算方式</span><select value={details.settlementMode || "unconfigured"} onChange={(event) => update("settlementMode", event.target.value)}>{Object.entries(CONTRACT_SETTLEMENT_MODES).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
        <label className="foundation-field"><span>每期金额</span><input type="number" min="0" step="0.01" value={details.periodAmount ?? ""} onChange={(event) => update("periodAmount", event.target.value)} /></label>
        <label className="foundation-field"><span>首次账单日</span><input type="date" value={details.firstBillDate || ""} onChange={(event) => update("firstBillDate", event.target.value)} /></label>
        <label className="foundation-field"><span>到期日规则</span><select value={details.dueDateRule || "on_bill_date"} onChange={(event) => update("dueDateRule", event.target.value)}>{Object.entries(CONTRACT_DUE_DATE_RULES).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
        {details.dueDateRule === "days_after" && <label className="foundation-field"><span>账单后多少天到期</span><input type="number" min="0" step="1" value={details.dueDays ?? 0} onChange={(event) => update("dueDays", event.target.value)} /></label>}
        <label className="foundation-field"><span>账单结束日期</span><input type="date" value={details.billingEndDate || ""} onChange={(event) => update("billingEndDate", event.target.value)} /></label>
        <label className="foundation-field"><span>服务开始日期</span><input type="date" value={details.serviceStartDate || ""} onChange={(event) => update("serviceStartDate", event.target.value)} /></label>
        <label className="foundation-field"><span>服务结束日期</span><input type="date" value={details.serviceEndDate || ""} onChange={(event) => update("serviceEndDate", event.target.value)} /></label>
        <label className="foundation-field"><span>退款条款</span><input value={details.refundTerms || ""} onChange={(event) => update("refundTerms", event.target.value)} placeholder="退款条件、扣费与时限" /></label>
        <label className="foundation-field"><span>佣金条款</span><input value={details.commissionTerms || ""} onChange={(event) => update("commissionTerms", event.target.value)} placeholder="佣金比例、计提与支付条件" /></label>
      </div>
    );
  }
  if (kind === "invoice") {
    const expectedBillKind = details.taxDirection === "output" ? "receivable" : (details.taxDirection === "input" ? "payable" : null);
    const originalInvoices = (workspace?.documents || []).filter((document) => (
      document.id !== currentDocumentId
      && documentStructuredKind(document.category) === "invoice"
      && document.structuredData?.redLetterStatus === "normal"
      && document.structuredData?.voidStatus !== "voided"
      && (!expectedBillKind || document.structuredData?.taxDirection === details.taxDirection)
    ));
    const selectedOriginal = originalInvoices.find((document) => document.id === details.originalInvoiceDocumentId);
    const selectedOriginalBillIds = new Set(selectedOriginal ? [
      selectedOriginal.structuredData?.linkedBillId,
      ...getDocumentRelatedObjectIds(workspace, selectedOriginal.id),
    ].filter(Boolean) : []);
    const originalBills = (workspace?.bills || []).filter((bill) => (
      (!expectedBillKind || bill.kind === expectedBillKind)
      && !["void", "inactive"].includes(bill.status)
      && (!selectedOriginal || selectedOriginalBillIds.has(bill.id)
        || [...(bill.documentIds || []), ...(bill.evidenceIds || [])].includes(selectedOriginal.id))
    ));
    const chooseOriginalInvoice = (documentId) => {
      const original = originalInvoices.find((document) => document.id === documentId);
      const relatedIds = original ? new Set([
        original.structuredData?.linkedBillId,
        ...getDocumentRelatedObjectIds(workspace, original.id),
      ].filter(Boolean)) : new Set();
      const relatedBill = (workspace?.bills || []).find((bill) => relatedIds.has(bill.id)
        || [...(bill.documentIds || []), ...(bill.evidenceIds || [])].includes(documentId));
      onChange({ ...details, originalInvoiceDocumentId: documentId, originalBillId: relatedBill?.id || "" });
    };
    return (
      <div className="document-intake-controls">
        <label className="foundation-field"><span>发票号码</span><input value={details.invoiceNumber || ""} onChange={(event) => update("invoiceNumber", event.target.value)} placeholder="保存时检查重复" /></label>
        <label className="foundation-field"><span>发票日期</span><input type="date" value={details.invoiceDate || ""} onChange={(event) => update("invoiceDate", event.target.value)} /></label>
        <label className="foundation-field"><span>增值税方向（人工选择）</span><select value={details.taxDirection || "unclassified"} onChange={(event) => update("taxDirection", event.target.value)}>{INVOICE_TAX_DIRECTION_OPTIONS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
        <label className="foundation-field"><span>{details.taxDirection === "output" ? "客户" : (details.taxDirection === "input" ? "供应商" : "客户／供应商")}</span><input value={details.counterparty || ""} onChange={(event) => update("counterparty", event.target.value)} placeholder="用于建议匹配已有账单" /></label>
        <label className="foundation-field"><span>价税合计</span><input type="number" min="0" step="0.01" value={details.amount ?? ""} onChange={(event) => update("amount", event.target.value)} /></label>
        <label className="foundation-field"><span>税额</span><input type="number" min="0" step="0.01" value={details.taxAmount ?? ""} onChange={(event) => update("taxAmount", event.target.value)} /></label>
        <label className="foundation-field"><span>税率（%）</span><input type="number" min="0" max="100" step="0.01" value={details.taxRate ?? ""} onChange={(event) => update("taxRate", event.target.value)} /></label>
        <label className="foundation-field"><span>查验状态</span><select value={details.verificationStatus} onChange={(event) => update("verificationStatus", event.target.value)}>{INVOICE_STATUS_OPTIONS.verificationStatus.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
        <label className="foundation-field"><span>红字状态</span><select value={details.redLetterStatus} onChange={(event) => update("redLetterStatus", event.target.value)}>{INVOICE_STATUS_OPTIONS.redLetterStatus.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
        <label className="foundation-field"><span>作废状态</span><select value={details.voidStatus} onChange={(event) => update("voidStatus", event.target.value)}>{INVOICE_STATUS_OPTIONS.voidStatus.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
        <label className="foundation-field"><span>认证状态</span><select value={details.certificationStatus} onChange={(event) => update("certificationStatus", event.target.value)}>{INVOICE_STATUS_OPTIONS.certificationStatus.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
        {details.redLetterStatus !== "normal" && <label className="foundation-field"><span>原发票（必须）</span><select value={details.originalInvoiceDocumentId || ""} onChange={(event) => chooseOriginalInvoice(event.target.value)}><option value="">请选择有效原发票</option>{originalInvoices.map((document) => <option value={document.id} key={document.id}>{document.structuredData?.invoiceNumber || document.name} · {document.structuredData?.counterparty || "未填写往来单位"}</option>)}</select></label>}
        {details.redLetterStatus !== "normal" && <label className="foundation-field"><span>原账单（必须）</span><select value={details.originalBillId || ""} onChange={(event) => update("originalBillId", event.target.value)}><option value="">请选择原发票关联账单</option>{originalBills.map((bill) => <option value={bill.id} key={bill.id}>{bill.no || bill.id} · {bill.counterparty} · {amountLabel(bill.amount)}</option>)}</select></label>}
        {!!details.linkedBillId && <p className="foundation-hint">已人工确认到账单：{details.linkedBillId}</p>}
      </div>
    );
  }
  return (
    <div className="document-intake-controls">
      <label className="foundation-field"><span>审批类型</span><select value={details.approvalType || "unclassified"} onChange={(event) => update("approvalType", event.target.value)}>{Object.entries(APPROVAL_TYPES).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
      <label className="foundation-field"><span>申请人</span><input value={details.applicant || ""} onChange={(event) => update("applicant", event.target.value)} /></label>
      <label className="foundation-field"><span>供应商／收退款对象</span><input value={details.supplier || ""} onChange={(event) => update("supplier", event.target.value)} placeholder="报销可留空，使用申请人匹配" /></label>
      <label className="foundation-field"><span>审批日期</span><input type="date" value={details.approvalDate || ""} onChange={(event) => update("approvalDate", event.target.value)} /></label>
      <label className="foundation-field"><span>审批金额</span><input type="number" min="0" step="0.01" value={details.amount ?? ""} onChange={(event) => update("amount", event.target.value)} /></label>
      <label className="foundation-field"><span>审批状态</span><select value={details.approvalStatus} onChange={(event) => update("approvalStatus", event.target.value)}>{APPROVAL_STATUS_OPTIONS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
      {details.linkStatus === "linked" && <p className="foundation-hint">已人工确认：{details.linkedTargetType === "bill" ? "账单" : "银行流水"} {details.linkedTargetId} · 业务事件 {details.businessEventId}</p>}
      {details.linkStatus === "invalidated" && <p className="foundation-hint">原审批业务关系已因驳回或撤回失效；重新批准后需再次人工确认。</p>}
    </div>
  );
}

function previewKind(mimeType, name) {
  const type = String(mimeType || "").toLowerCase();
  const extension = String(name || "").split(".").pop()?.toLowerCase();
  if (type === "application/pdf" || extension === "pdf") return "pdf";
  if (type.startsWith("image/") && type !== "image/svg+xml") return "image";
  if (type.startsWith("text/") || ["application/json", "application/xml"].includes(type) || ["txt", "csv", "json", "xml"].includes(extension)) return "text";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  return "unsupported";
}

function matchTargetLabel(sourceType) {
  if (sourceType === "bankTransaction") return "银行流水";
  if (sourceType === "voucher") return "凭证";
  return "业务事件";
}

function documentKindLabel(kind) {
  return { contract: "合同", invoice: "发票", approval: "审批单" }[kind] || "资料";
}

export function DocumentIntakePanel({ defaultCategory = "其他资料", compact = false, onToast }) {
  const { state, activeWorkspace, actions, store, fileVault } = useFinanceDesk();
  const actor = activeWorkspace.users?.find((user) => (
    user.id === state.activeUserId
    && user.status === "active"
    && String(user.name || "").trim()
  ))?.name?.trim() || activeWorkspace.users?.find((user) => (
    user.status === "active" && String(user.name || "").trim()
  ))?.name?.trim() || "本地用户";
  const inputRef = useRef(null);
  const payrollFileInputRef = useRef(null);
  const documentActionCancelRef = useRef(null);
  const documentActionTriggerRef = useRef(null);
  const [category, setCategory] = useState(defaultCategory);
  const [period, setPeriod] = useState(activeWorkspace.currentPeriod || "");
  const [relatedObjectId, setRelatedObjectId] = useState("");
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);
  const [pendingDocumentAction, setPendingDocumentAction] = useState(null);
  const [confirmingSuggestionId, setConfirmingSuggestionId] = useState("");
  const [selectedVoucherId, setSelectedVoucherId] = useState(activeWorkspace.vouchers?.[0]?.id || "");
  const [generatingPackage, setGeneratingPackage] = useState(false);
  const [selectedArchivePeriod, setSelectedArchivePeriod] = useState(activeWorkspace.currentPeriod || "");
  const [generatingMonthlyArchive, setGeneratingMonthlyArchive] = useState(false);
  const [vatReconciliationDrafts, setVatReconciliationDrafts] = useState({});
  const [payrollImportKind, setPayrollImportKind] = useState("payroll");
  const [payrollImportPeriod, setPayrollImportPeriod] = useState(activeWorkspace.currentPeriod || "");
  const [payrollFilePreview, setPayrollFilePreview] = useState(null);
  const [payrollFieldMapping, setPayrollFieldMapping] = useState({});
  const [payrollImportBusy, setPayrollImportBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const relatedGroups = useMemo(() => RELATED_GROUPS.map(([label, collection]) => ({
    label,
    collection,
    items: activeWorkspace[collection] || [],
  })).filter((group) => group.items.length), [activeWorkspace]);
  const relatedLabels = useMemo(() => new Map(relatedGroups.flatMap((group) => group.items.map((item) => [
    item.id,
    `${group.label} · ${relatedLabel(item)}`,
  ]))), [relatedGroups]);
  const categories = useMemo(() => [...new Set([...CATEGORIES, ...activeWorkspace.documents.map((document) => document.category).filter(Boolean)])], [activeWorkspace.documents]);
  const filteredDocuments = useMemo(() => filterLocalDocuments(activeWorkspace, {
    query,
    category: categoryFilter,
    status: statusFilter,
  }), [activeWorkspace, query, categoryFilter, statusFilter]);
  const matchSuggestions = useMemo(() => buildDocumentMatchSuggestions(activeWorkspace), [activeWorkspace]);
  const missingRequirements = useMemo(() => getDocumentTaskRequirements(activeWorkspace), [activeWorkspace]);
  const invoiceVatSummary = useMemo(() => buildStructuredInvoiceVatSummary(activeWorkspace, { period: activeWorkspace.currentPeriod }), [activeWorkspace]);
  const invoiceBillConnections = useMemo(() => (activeWorkspace.documents || [])
    .filter((document) => documentStructuredKind(document.category) === "invoice")
    .map((document) => {
      const details = document.structuredData || {};
      const linkedBillId = details.linkedBillId || getDocumentRelatedObjectIds(activeWorkspace, document.id)
        .find((objectId) => (activeWorkspace.bills || []).some((bill) => bill.id === objectId)) || "";
      return {
        document,
        details,
        linkedBill: (activeWorkspace.bills || []).find((bill) => bill.id === linkedBillId) || null,
        suggestions: buildInvoiceBillSuggestions(activeWorkspace, { documentId: document.id }).slice(0, 3),
      };
    })
    .sort((left, right) => String(right.details.invoiceDate || right.document.createdAt || "").localeCompare(String(left.details.invoiceDate || left.document.createdAt || ""))), [activeWorkspace]);
  const approvalConnections = useMemo(() => (activeWorkspace.documents || [])
    .filter((document) => documentStructuredKind(document.category) === "approval")
    .map((document) => {
      const details = document.structuredData || {};
      const targets = details.linkedTargetType === "bill" ? (activeWorkspace.bills || []) : (activeWorkspace.transactions || []);
      return {
        document,
        details,
        linkedTarget: targets.find((target) => target.id === details.linkedTargetId) || null,
        businessEvent: (activeWorkspace.businessEvents || []).find((event) => event.id === details.businessEventId) || null,
        pendingTask: (activeWorkspace.exceptionTasks || []).find((task) => task.identity === `approval-link:${document.id}` && task.status !== "resolved") || null,
        suggestions: buildApprovalLinkSuggestions(activeWorkspace, { documentId: document.id }).slice(0, 3),
      };
    })
    .sort((left, right) => String(right.details.approvalDate || right.document.createdAt || "").localeCompare(String(left.details.approvalDate || left.document.createdAt || ""))), [activeWorkspace]);
  const contractBillingPlans = useMemo(() => (activeWorkspace.documents || [])
    .filter((document) => documentStructuredKind(document.category) === "contract")
    .map((document) => buildContractBillingPlan(activeWorkspace, { documentId: document.id })), [activeWorkspace]);
  const vatReconciliation = useMemo(() => buildVatReconciliationSummary(activeWorkspace, { period: activeWorkspace.currentPeriod }), [activeWorkspace]);
  const payrollSocialSummary = useMemo(() => buildPayrollSocialSummary(activeWorkspace, { period: activeWorkspace.currentPeriod }), [activeWorkspace]);
  const payrollSocialConfirmation = useMemo(() => getPayrollSocialConfirmationState(activeWorkspace), [activeWorkspace]);
  const payrollImportPlan = useMemo(() => payrollFilePreview ? preparePayrollSocialImport(activeWorkspace, {
    table: payrollFilePreview.table,
    inspection: payrollFilePreview.inspection,
    mapping: payrollFieldMapping,
    sourceKind: payrollImportKind,
    defaultPeriod: payrollImportPeriod,
    fileName: payrollFilePreview.fileName,
    importedAt: payrollFilePreview.importedAt,
    id: payrollFilePreview.id,
  }) : null, [activeWorkspace, payrollFilePreview, payrollFieldMapping, payrollImportKind, payrollImportPeriod]);
  const vatReconciliationSignature = useMemo(() => JSON.stringify(vatReconciliation.items.map((item) => [
    item.kind,
    item.sourceFingerprint,
    item.storedRecord?.recordedAt || "",
  ])), [vatReconciliation]);
  const missingRequirementSignature = useMemo(() => JSON.stringify(missingRequirements.map((item) => [
    item.identity,
    item.sourceLabel,
    item.label,
    item.satisfied,
  ])), [missingRequirements]);
  const documentTasks = useMemo(() => (activeWorkspace.exceptionTasks || []).filter((task) => task.code === "missing_document"), [activeWorkspace.exceptionTasks]);
  const openDocumentTasks = documentTasks.filter((task) => task.status !== "resolved");
  const resolvedDocumentTaskCount = documentTasks.length - openDocumentTasks.length;
  const selectedVoucher = (activeWorkspace.vouchers || []).find((voucher) => voucher.id === selectedVoucherId) || null;
  const voucherPackagePlan = useMemo(() => (
    selectedVoucher ? buildVoucherAttachmentPackagePlan(activeWorkspace, selectedVoucher.id) : null
  ), [activeWorkspace, selectedVoucher]);
  const archivePeriods = useMemo(() => getMonthlyFinancialArchivePeriods(activeWorkspace), [activeWorkspace]);
  const monthlyArchivePlan = useMemo(() => (
    selectedArchivePeriod ? buildMonthlyFinancialArchivePlan(activeWorkspace, selectedArchivePeriod) : null
  ), [activeWorkspace, selectedArchivePeriod]);
  const monthlyArchiveExports = (activeWorkspace.delivery?.financialArchiveExports || [])
    .filter((record) => record.period === selectedArchivePeriod);

  useEffect(() => {
    setCategory(defaultCategory);
    setPeriod(activeWorkspace.currentPeriod || "");
    setRelatedObjectId("");
    setQuery("");
    setCategoryFilter("all");
    setStatusFilter("all");
    setEditing(null);
    setPreview(null);
    setPendingDocumentAction(null);
    documentActionTriggerRef.current = null;
    setSelectedVoucherId(activeWorkspace.vouchers?.[0]?.id || "");
    setSelectedArchivePeriod(activeWorkspace.currentPeriod || "");
    setPayrollImportPeriod(activeWorkspace.currentPeriod || "");
    setPayrollFilePreview(null);
    setPayrollFieldMapping({});
    setError("");
  }, [activeWorkspace.id, activeWorkspace.currentPeriod, defaultCategory]);

  useEffect(() => {
    if (pendingDocumentAction) documentActionCancelRef.current?.focus();
  }, [pendingDocumentAction]);

  useEffect(() => {
    setVatReconciliationDrafts(Object.fromEntries(vatReconciliation.items.map((item) => [item.kind, {
      reason: item.activeRecord?.reason || item.storedRecord?.reason || "",
      adjustmentAmount: String(item.activeRecord?.adjustmentAmount ?? item.storedRecord?.adjustmentAmount ?? ""),
    }])));
  }, [activeWorkspace.id, activeWorkspace.currentPeriod, vatReconciliationSignature]);

  useEffect(() => {
    setSelectedVoucherId((current) => (
      activeWorkspace.vouchers?.some((voucher) => voucher.id === current)
        ? current
        : (activeWorkspace.vouchers?.[0]?.id || "")
    ));
  }, [activeWorkspace.id, activeWorkspace.vouchers]);

  useEffect(() => {
    setSelectedArchivePeriod((current) => archivePeriods.includes(current) ? current : (archivePeriods[0] || ""));
  }, [activeWorkspace.id, archivePeriods]);

  useEffect(() => () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
  }, [preview?.url]);

  useEffect(() => {
    try {
      refreshDocumentMissingTasks({ store, workspaceId: activeWorkspace.id });
    } catch (caught) {
      setError(caught.message || "资料缺件待办生成失败");
    }
  }, [store, activeWorkspace.id, missingRequirementSignature]);

  async function addFiles(event) {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (!files.length) return;
    setBusy(true);
    setError("");
    try {
      for (const file of files) {
        await saveLocalDocument({
          store,
          fileVault,
          workspaceId: activeWorkspace.id,
          file,
          metadata: {
            category,
            period,
            relatedObjectIds: relatedObjectId.trim() ? [relatedObjectId.trim()] : [],
            actor,
          },
        });
      }
      onToast?.(`已将 ${files.length} 份原文件保存到当前浏览器`);
    } catch (caught) {
      setError(caught.message || "资料保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function loadRecord(document) {
    return getStoredDocumentRecord({ fileVault, workspaceId: activeWorkspace.id, document });
  }

  async function download(document) {
    setError("");
    try {
      const record = await loadRecord(document);
      downloadStoredDocument(record);
      const current = store.getActiveWorkspace();
      actions.replaceWorkspace(current.id, current, {
        allowArchivedTransition: true,
        requiredPermission: "data.read",
        audit: {
          action: "下载本地资料",
          detail: `${document.name} · 原文件未离开当前设备`,
        },
      });
    } catch (caught) {
      setError(caught.message || "找不到这份资料的本地文件内容");
    }
  }

  async function showPreview(document) {
    clearPendingDocumentAction();
    setError("");
    try {
      const record = await loadRecord(document);
      const kind = previewKind(record.mimeType || document.mimeType, record.name || document.name);
      if (kind === "text") {
        const content = await record.blob.slice(0, 300001).text();
        setPreview({ document, kind, text: content.slice(0, 300000), truncated: record.blob.size > 300000 || content.length > 300000 });
        return;
      }
      const typedBlob = record.blob.type
        ? record.blob
        : record.blob.slice(0, record.blob.size, record.mimeType || document.mimeType || "application/octet-stream");
      const url = kind === "unsupported" ? null : URL.createObjectURL(typedBlob);
      setPreview({ document, kind, url });
    } catch (caught) {
      setError(caught.message || "无法预览这份本地文件");
    }
  }

  function clearPendingDocumentAction(restoreFocus = false) {
    const trigger = documentActionTriggerRef.current;
    setPendingDocumentAction(null);
    documentActionTriggerRef.current = null;
    if (restoreFocus && trigger) window.requestAnimationFrame(() => trigger.focus());
  }

  function closePreview() {
    setPreview(null);
    clearPendingDocumentAction();
  }

  function closeEditing() {
    setEditing(null);
    clearPendingDocumentAction();
  }

  function requestDocumentAction(document, action, trigger) {
    const usage = getLocalDocumentUsage(activeWorkspace, document.id);
    if (action === "delete" && usage.length) {
      clearPendingDocumentAction();
      setError(`该资料正在使用，不能删除：${usage.map((item) => item.label).join("、")}`);
      return;
    }
    setError("");
    documentActionTriggerRef.current = trigger;
    setPendingDocumentAction({ action, documentId: document.id });
  }

  async function remove(document) {
    const usage = getLocalDocumentUsage(activeWorkspace, document.id);
    if (usage.length) {
      clearPendingDocumentAction();
      setError(`该资料正在使用，不能删除：${usage.map((item) => item.label).join("、")}`);
      return;
    }
    setError("");
    try {
      await removeLocalDocument({ store, fileVault, workspaceId: activeWorkspace.id, documentId: document.id });
      if (preview?.document.id === document.id) setPreview(null);
      if (editing?.id === document.id) setEditing(null);
      onToast?.("未使用的本地资料已删除");
    } catch (caught) {
      setError(caught.message || "资料删除失败");
    } finally {
      clearPendingDocumentAction();
    }
  }

  function archive(document) {
    setError("");
    try {
      actions.upsertEntity(activeWorkspace.id, "documents", { ...document, lifecycleStatus: "已归档", archiveStatus: "archived" }, { label: "资料状态" });
      if (editing?.id === document.id) setEditing(null);
      onToast?.("资料已标记归档");
    } catch (caught) {
      setError(caught.message || "资料归档失败");
    } finally {
      clearPendingDocumentAction();
    }
  }

  function beginEdit(document) {
    clearPendingDocumentAction();
    setError("");
    setEditing({
      id: document.id,
      name: document.name || "",
      category: document.category || "其他资料",
      period: document.period || "",
      relatedObjectIds: getDocumentRelatedObjectIds(activeWorkspace, document.id),
      structuredData: normalizeDocumentStructuredData(document.category, document.structuredData || {}),
    });
  }

  function changeEditCategory(nextCategory) {
    setEditing((current) => {
      const currentKind = documentStructuredKind(current.category);
      const nextKind = documentStructuredKind(nextCategory);
      return {
        ...current,
        category: nextCategory,
        structuredData: currentKind === nextKind
          ? current.structuredData
          : normalizeDocumentStructuredData(nextCategory, {}),
      };
    });
  }

  function addEditRelation(objectId) {
    if (!objectId) return;
    setEditing((current) => ({ ...current, relatedObjectIds: [...new Set([...current.relatedObjectIds, objectId])] }));
  }

  function removeEditRelation(objectId) {
    setEditing((current) => ({ ...current, relatedObjectIds: current.relatedObjectIds.filter((id) => id !== objectId) }));
  }

  function saveEdit() {
    setError("");
    try {
      updateLocalDocumentMetadata({
        store,
        workspaceId: activeWorkspace.id,
        documentId: editing.id,
        patch: {
          name: editing.name,
          category: editing.category,
          period: editing.period,
          relatedObjectIds: editing.relatedObjectIds,
          structuredData: editing.structuredData,
        },
      });
      closeEditing();
      onToast?.("资料详情、分类与业务关联已更新");
    } catch (caught) {
      setError(caught.message || "资料修改失败");
    }
  }

  function refreshMissingTasks() {
    setError("");
    try {
      const result = refreshDocumentMissingTasks({ store, workspaceId: activeWorkspace.id });
      onToast?.(result.changed
        ? `缺件待办已刷新：当前待补 ${result.open} 项`
        : `缺件待办已是最新状态：当前待补 ${result.open} 项`);
    } catch (caught) {
      setError(caught.message || "资料缺件待办刷新失败");
    }
  }

  function updateVatReconciliationDraft(kind, field, value) {
    setVatReconciliationDrafts((current) => ({
      ...current,
      [kind]: { ...(current[kind] || {}), [field]: value },
    }));
  }

  function saveVatReconciliation(item) {
    setError("");
    try {
      const draft = vatReconciliationDrafts[item.kind] || {};
      const current = store.getActiveWorkspace();
      const next = recordVatReconciliation(current, {
        kind: item.kind,
        reason: draft.reason,
        adjustmentAmount: draft.adjustmentAmount,
      }, { actor });
      actions.replaceWorkspace(current.id, next, { requiredPermission: "data.write" });
      onToast?.(`${item.label}已保存；冻结版本与原确认如有，将按新底稿失效`);
    } catch (caught) {
      setError(caught.message || "增值税差异说明保存失败");
    }
  }

  function confirmContractBillingPlan(plan) {
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const result = applyContractBillingPlan(current, { documentId: plan.documentId, asOf: plan.asOf }, { actor });
      actions.replaceWorkspace(current.id, result.workspace, { requiredPermission: "data.write" });
      onToast?.(`已按合同确认生成 ${result.bills.length} 张${result.plan.billKind === "receivable" ? "应收" : "应付"}账单，可直接进入现有核销链`);
    } catch (caught) {
      setError(caught.message || "合同账单计划生成失败");
    }
  }

  function confirmInvoiceBill(suggestion) {
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const result = confirmInvoiceBillMatch(current, {
        documentId: suggestion.documentId,
        billId: suggestion.billId,
        confirmed: true,
      }, { actor, mode: "manual" });
      actions.replaceWorkspace(current.id, result.workspace, { requiredPermission: "data.write" });
      onToast?.(`已人工确认发票与${result.bill.kind === "receivable" ? "应收" : "应付"}账单 ${result.bill.no || result.bill.id} 的关联`);
    } catch (caught) {
      setError(caught.message || "发票账单关联失败");
    }
  }

  function confirmInvoiceBillCreation(documentId) {
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const result = createBillFromInvoice(current, {
        documentId,
        confirmed: true,
        confirmedNoSuitableBill: true,
      }, { actor, mode: "manual" });
      actions.replaceWorkspace(current.id, result.workspace, { requiredPermission: "data.write" });
      onToast?.(`已确认无合适账单，并从发票生成${result.bill.kind === "receivable" ? "应收" : "应付"}账单 ${result.bill.no}`);
    } catch (caught) {
      setError(caught.message || "从发票生成账单失败");
    }
  }

  function confirmRedInvoiceAdjustment(documentId) {
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const result = applyRedInvoiceBillAdjustment(current, {
        documentId,
        confirmed: true,
      }, { actor, mode: "manual" });
      actions.replaceWorkspace(current.id, result.workspace, { requiredPermission: "data.write" });
      onToast?.(`已用红字发票对原账单 ${result.bill.no || result.bill.id} 形成 ${amountLabel(result.adjustment.amount)} 负向调整`);
    } catch (caught) {
      setError(caught.message || "红字发票负向调整失败");
    }
  }

  function confirmApprovalLink(suggestion) {
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const result = confirmApprovalBusinessLink(current, {
        documentId: suggestion.documentId,
        targetType: suggestion.targetType,
        targetId: suggestion.targetId,
        confirmed: true,
      }, { actor, mode: "manual" });
      actions.replaceWorkspace(current.id, result.workspace, { requiredPermission: "data.write" });
      onToast?.(`已人工确认审批单与${suggestion.targetType === "bill" ? "账单" : "银行流水"}的关系，并${result.businessEvent.source === "approved-document-manual-confirmation" ? "生成" : "补充"}业务事件审批来源；未自动付款或入账`);
    } catch (caught) {
      setError(caught.message || "审批业务关联失败");
    }
  }

  async function choosePayrollSocialFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    setPayrollImportBusy(true);
    try {
      const result = await readPayrollSocialFile(file);
      const preview = {
        ...result,
        id: `payroll-import-${Date.now()}`,
        importedAt: new Date().toISOString(),
      };
      setPayrollFilePreview(preview);
      setPayrollFieldMapping(result.inspection.mapping);
      onToast?.(`${result.fileName} 已在当前浏览器读取，请核对字段映射后写入`);
    } catch (caught) {
      setPayrollFilePreview(null);
      setPayrollFieldMapping({});
      setError(caught.message || "工资社保文件读取失败");
    } finally {
      setPayrollImportBusy(false);
    }
  }

  function updatePayrollFieldMapping(field, value) {
    setPayrollFieldMapping((current) => ({ ...current, [field]: value === "" ? null : Number(value) }));
  }

  function commitPayrollSocialImport() {
    if (!payrollImportPlan) return;
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const currentPlan = preparePayrollSocialImport(current, {
        table: payrollFilePreview.table,
        inspection: payrollFilePreview.inspection,
        mapping: payrollFieldMapping,
        sourceKind: payrollImportKind,
        defaultPeriod: payrollImportPeriod,
        fileName: payrollFilePreview.fileName,
        importedAt: payrollFilePreview.importedAt,
        id: payrollFilePreview.id,
      });
      const next = applyPayrollSocialImport(current, currentPlan, { actor });
      actions.replaceWorkspace(current.id, next, { requiredPermission: "data.write" });
      setPayrollFilePreview(null);
      setPayrollFieldMapping({});
      onToast?.(`${PAYROLL_SOCIAL_IMPORT_KINDS[currentPlan.sourceKind]}已写入 ${currentPlan.rows.length} 人次；旧冻结与确认已撤销`);
    } catch (caught) {
      setError(caught.message || "工资社保数据写入失败");
    }
  }

  function togglePayrollSocialConfirmation(section, confirmed) {
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const next = confirmPayrollSocialData(current, { section, confirmed }, { actor: "客户负责人" });
      actions.replaceWorkspace(current.id, next, { requiredPermission: "data.write" });
      onToast?.(`${section === "payroll" ? "工资表" : "社保表"}${confirmed ? "已由客户确认" : "确认已撤销"}`);
    } catch (caught) {
      setError(caught.message || "工资社保确认失败");
    }
  }

  function confirmSuggestion(suggestion) {
    setError("");
    setConfirmingSuggestionId(suggestion.id);
    try {
      const result = confirmDocumentMatch({
        store,
        workspaceId: activeWorkspace.id,
        suggestionId: suggestion.id,
      });
      onToast?.(`已确认资料关联，并自动关闭 ${result.closedTaskCount} 项缺件待办`);
    } catch (caught) {
      setError(caught.message || "资料匹配确认失败");
    } finally {
      setConfirmingSuggestionId("");
    }
  }

  async function generateAttachmentPackage() {
    if (!selectedVoucher) return;
    setError("");
    setGeneratingPackage(true);
    try {
      const result = await generateVoucherAttachmentPackage({
        store,
        fileVault,
        workspaceId: activeWorkspace.id,
        voucherId: selectedVoucher.id,
      });
      onToast?.(`已在本地生成并下载 ${result.fileName}；收集原文件 ${result.manifest.files.length} 份，缺失 ${result.manifest.missingItems.length} 项`);
    } catch (caught) {
      setError(caught.message || "凭证附件包生成失败");
    } finally {
      setGeneratingPackage(false);
    }
  }

  async function generateMonthlyArchive() {
    if (!monthlyArchivePlan) return;
    setError("");
    setGeneratingMonthlyArchive(true);
    try {
      const result = await generateMonthlyFinancialArchivePackage({
        store,
        fileVault,
        workspaceId: activeWorkspace.id,
        period: monthlyArchivePlan.period,
      });
      onToast?.(result.manifest.isComplete
        ? `已在本地生成并下载完整财务档案：${result.fileName}`
        : `已在本地导出不完整草稿包：${result.fileName}；清单列出 ${result.manifest.missingItems.length} 项缺失`);
    } catch (caught) {
      setError(caught.message || "月度财务档案包生成失败");
    } finally {
      setGeneratingMonthlyArchive(false);
    }
  }

  return (
    <section className={`foundation-section document-intake-panel ${compact ? "compact" : "intake-wide"}`}>
      <div className="foundation-section-heading"><div><small>IndexedDB · 不上传</small><h3><FileText size={18} />本地资料库</h3></div><span>{filteredDocuments.length} / {activeWorkspace.documents.length} 份</span></div>
      {!fileVault && <div className="foundation-error"><WarningCircle size={18} />当前环境不支持浏览器本地文件保险箱，只能查看已有资料元数据。</div>}
      <div className="document-intake-controls">
        <label className="foundation-field"><span>资料类别</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="foundation-field"><span>业务期间</span><input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} /></label>
        <label className="foundation-field"><span>关联业务对象（可选）</span><select value={relatedObjectId} onChange={(event) => setRelatedObjectId(event.target.value)}><option value="">暂不关联</option>{relatedGroups.map((group) => <optgroup label={group.label} key={group.collection}>{group.items.map((item) => <option value={item.id} key={item.id}>{relatedLabel(item)} · {item.id}</option>)}</optgroup>)}</select></label>
        <button className="secondary-button" type="button" disabled={!fileVault || busy} onClick={() => inputRef.current?.click()}><FileArrowUp size={17} />{busy ? "正在保存…" : "上传原文件"}</button>
        <input ref={inputRef} type="file" multiple hidden onChange={addFiles} />
      </div>
      <p className="foundation-hint">合同、发票、审批单等原文件保存在当前浏览器 IndexedDB；分类、期间、校验哈希和业务关联保存在当前工作台，不会上传外部服务。</p>
      <div className="foundation-notice" style={{ marginTop: 12 }}><WarningCircle size={18} /><span><strong>OCR 未连接。</strong> 合同、发票和审批字段必须由本地用户人工录入并核对，系统不会假装从原文件自动识别。</span></div>
      <div className="bank-import-workspace">
        <div className="foundation-section-heading">
          <div><small>结构化合同 · 预览后确认</small><h3>合同账单计划</h3></div>
          <span>{contractBillingPlans.length} 份合同 · 待生成 {contractBillingPlans.reduce((sum, plan) => sum + plan.items.length, 0)} 张</span>
        </div>
        <p className="foundation-hint">{workspaceModuleEnabled(activeWorkspace, "members") ? "销售、会员和平台合同生成应收账单" : "销售和平台合同生成应收账单"}；采购和租赁合同生成应付账单。预览不会写入任何账单，只有点击确认后才写入现有账单列表并关联合同资料。</p>
        <div className="foundation-record-list">
          {contractBillingPlans.map((plan) => (
            <article className="foundation-record" key={plan.documentId}>
              <div style={{ width: "100%" }}>
                <strong>{plan.document?.name || plan.documentId}</strong>
                <small>{CONTRACT_TYPES[plan.contractType] || "未选择合同类型"} · {plan.billKind === "receivable" ? "将生成应收" : (plan.billKind === "payable" ? "将生成应付" : "尚未确定账单方向")} · 对方 {plan.counterparty || "未填写"}</small>
                <p>合同金额 {amountLabel(plan.contractAmount)} · 每期 {amountLabel(plan.periodAmount)} · 计划总额 {amountLabel(plan.plannedTotalAmount)} · 已生成 {amountLabel(plan.generatedTotalAmount)} · 本次待生成 {amountLabel(plan.pendingTotalAmount)}</p>
                {!!plan.duplicatePeriods.length && <p>已存在、不会重复生成：{plan.duplicatePeriods.map((item) => `${item.period}（${item.bill.no || item.bill.id}）`).join("、")}</p>}
                {!!plan.errors.length && <div className="foundation-error"><WarningCircle size={18} /><span>{plan.errors.join("；")}</span></div>}
                <details open>
                  <summary>本次账单预览（{plan.items.length}）</summary>
                  {plan.items.map((item) => <p key={`${plan.documentId}-${item.billingPeriod}`}>{item.billingPeriod} · {item.billKind === "receivable" ? "应收" : "应付"} · 账单日 {item.date} · 到期日 {item.dueDate} · {amountLabel(item.amount)} · {item.counterparty}</p>)}
                  {!plan.items.length && <p>当前没有可生成的新账单。</p>}
                </details>
              </div>
              <button className="primary-button" type="button" disabled={!plan.canConfirm} onClick={() => confirmContractBillingPlan(plan)}>确认并写入账单</button>
            </article>
          ))}
          {!contractBillingPlans.length && <p className="foundation-empty">当前还没有结构化合同资料。上传或编辑合同并补齐账单计划字段后，会先在这里预览。</p>}
        </div>
      </div>
      <div className="bank-import-workspace">
        <div className="foundation-section-heading">
          <div><small>五类审批 · 人工确认</small><h3>审批单与业务链</h3></div>
          <span>{approvalConnections.filter((item) => item.details.linkStatus === "linked").length} / {approvalConnections.length} 已关联</span>
        </div>
        <p className="foundation-hint">报销、付款申请、借款／还款、采购和退款仅在“已批准”后参与建议。系统按申请人／供应商、金额、日期与类型寻找账单或银行流水；只有人工确认才补充业务事件审批来源，不会自动付款、核销、制证或入账。</p>
        <div className="foundation-record-list">
          {approvalConnections.map((item) => {
            const { document, details, linkedTarget, businessEvent, pendingTask, suggestions } = item;
            const approved = details.approvalStatus === "approved";
            return (
              <article className="foundation-record" key={`approval-link-${document.id}`}>
                <div style={{ width: "100%" }}>
                  <strong>{document.name} · {APPROVAL_TYPES[details.approvalType] || "未选择类型"}</strong>
                  <small>{statusLabel(APPROVAL_STATUS_OPTIONS, details.approvalStatus, "草稿")} · {details.approvalDate || "未填写日期"} · {details.supplier || details.applicant || "未填写申请人／供应商"} · {amountLabel(details.amount)}</small>
                  {details.linkStatus === "linked" && linkedTarget && <p>已人工关联{details.linkedTargetType === "bill" ? "账单" : "银行流水"}：{linkedTarget.no || linkedTarget.summary || linkedTarget.id} · 业务事件 {businessEvent?.businessEventNo || businessEvent?.id || details.businessEventId} · 仍须后续人工付款／入账</p>}
                  {details.linkStatus === "invalidated" && <div className="foundation-error"><WarningCircle size={18} /><span>审批已驳回或撤回，原业务关系已失效，相关业务重新进入异常。</span></div>}
                  {pendingTask && <p>{pendingTask.message}</p>}
                  {approved && details.linkStatus !== "linked" && suggestions.map((suggestion) => (
                    <div className="foundation-record" key={suggestion.id}>
                      <div><strong>建议关联{suggestion.targetType === "bill" ? "账单" : "银行流水"}：{suggestion.target.no || suggestion.target.summary || suggestion.target.id}</strong><small>{suggestion.target.counterparty || "未填写往来单位"} · {suggestion.target.date || "未填写日期"} · {amountLabel(Math.abs(Number(suggestion.target.amount || 0)))}</small><p>{suggestion.reasons.join("；")} · 匹配分 {suggestion.score}</p></div>
                      <button className="primary-button" type="button" onClick={() => confirmApprovalLink(suggestion)}>人工确认关联</button>
                    </div>
                  ))}
                  {approved && details.linkStatus !== "linked" && !suggestions.length && <p>当前没有类型、申请人／供应商、金额和日期同时一致的已有账单或银行流水，审批单保持待处理。</p>}
                  {!approved && <p>当前状态不能进入后续业务；改为“已批准”并保存后，才会出现匹配建议。</p>}
                </div>
              </article>
            );
          })}
          {!approvalConnections.length && <p className="foundation-empty">当前还没有结构化审批单资料。</p>}
        </div>
      </div>
      <div className="bank-import-workspace">
        <div className="foundation-section-heading">
          <div><small>{activeWorkspace.currentPeriod} · 结构化发票</small><h3>增值税发票来源</h3></div>
          <span>{invoiceVatSummary.usesStructuredInvoices ? "发票汇总口径" : "仍用原估算口径"}</span>
        </div>
        <p className="foundation-hint">只有人工选择销项/进项、属于本期并已关联业务或凭证的有效发票才进入汇总。作废发票排除，已开红字按负数；未认证进项单独列示且不抵扣。查验状态完全来自人工录入，没有连接税务平台。</p>
        <div className="foundation-section-heading" style={{ marginTop: 18 }}>
          <div><small>人工确认 · 不自动写账</small><h3>发票与应收应付账单</h3></div>
          <span>{invoiceBillConnections.filter((item) => item.linkedBill).length} / {invoiceBillConnections.length} 已关联</span>
        </div>
        <p className="foundation-hint">销项按客户、价税合计和日期建议应收账单，进项按供应商、价税合计和日期建议应付账单。建议本身不写数据；人工确认后才关联，确认没有合适账单后才可新建。红字只冲减已关联的原账单。</p>
        <div className="foundation-record-list">
          {invoiceBillConnections.map((item) => {
            const { document, details, linkedBill, suggestions } = item;
            const billKindLabel = details.taxDirection === "output" ? "应收" : (details.taxDirection === "input" ? "应付" : "未确定");
            const canCreate = details.redLetterStatus === "normal"
              && details.voidStatus !== "voided"
              && ["output", "input"].includes(details.taxDirection)
              && Boolean(details.counterparty && details.invoiceDate && Number(details.amount) > 0);
            return (
              <article className="foundation-record" key={`invoice-bill-${document.id}`}>
                <div style={{ width: "100%" }}>
                  <strong>{details.invoiceNumber || document.name} · {details.taxDirection === "output" ? "销项 → 应收" : (details.taxDirection === "input" ? "进项 → 应付" : "请先选择销项／进项")}</strong>
                  <small>{details.counterparty || "未填写客户／供应商"} · {details.invoiceDate || "未填写日期"} · 价税合计 {amountLabel(details.amount)}</small>
                  {linkedBill && <p>已人工确认关联：{linkedBill.no || linkedBill.id} · {linkedBill.counterparty} · 当前账单金额 {amountLabel(linkedBill.amount)}</p>}
                  {!linkedBill && details.voidStatus === "voided" && <div className="foundation-error"><WarningCircle size={18} /><span>作废发票禁止关联、新建或调整账单。</span></div>}
                  {!linkedBill && details.voidStatus !== "voided" && details.redLetterStatus === "red_applied" && <p>红字申请中：当前不生成账单调整；开具红字后再关联原发票和原账单。</p>}
                  {!linkedBill && details.voidStatus !== "voided" && details.redLetterStatus === "red_issued" && (
                    <>
                      <p>原发票 {details.originalInvoiceDocumentId || "未选择"} · 原账单 {details.originalBillId || "未选择"}。确认后只在原账单形成负向调整，不新建普通账单。</p>
                      <button className="primary-button" type="button" disabled={!details.originalInvoiceDocumentId || !details.originalBillId || !(Number(details.amount) > 0)} onClick={() => confirmRedInvoiceAdjustment(document.id)}>确认红字负向调整</button>
                    </>
                  )}
                  {!linkedBill && details.voidStatus !== "voided" && details.redLetterStatus === "normal" && (
                    <>
                      {suggestions.map((suggestion) => (
                        <div className="foundation-record" key={suggestion.id}>
                          <div><strong>建议 {billKindLabel}：{suggestion.bill.no || suggestion.bill.id}</strong><small>{suggestion.bill.counterparty} · {amountLabel(suggestion.bill.amount)} · {suggestion.bill.date || "未填写账单日期"}</small><p>{suggestion.reasons.join("；")} · 匹配分 {suggestion.score}</p></div>
                          <button className="primary-button" type="button" onClick={() => confirmInvoiceBill(suggestion)}>人工确认关联</button>
                        </div>
                      ))}
                      {!suggestions.length && <p>没有找到同时满足往来单位、金额和日期条件的已有{billKindLabel === "未确定" ? "" : billKindLabel}账单。</p>}
                      <button className="secondary-button" type="button" disabled={!canCreate} onClick={() => confirmInvoiceBillCreation(document.id)}>确认无合适账单并新建{billKindLabel}账单</button>
                      {!canCreate && <p>请先在资料编辑中补齐销项／进项、客户／供应商、价税合计和发票日期。</p>}
                    </>
                  )}
                </div>
              </article>
            );
          })}
          {!invoiceBillConnections.length && <p className="foundation-empty">当前还没有结构化发票资料。</p>}
        </div>
        <div className="foundation-record-list">
          <article className="foundation-record"><div><strong>销项发票</strong><small>价税合计 {amountLabel(invoiceVatSummary.outputGrossAmount)} · 不含税 {amountLabel(invoiceVatSummary.outputNetAmount)}</small></div><span><strong>{amountLabel(invoiceVatSummary.outputVat)}</strong><small>销项税额</small></span></article>
          <article className="foundation-record"><div><strong>已认证进项</strong><small>仅已认证有效进项发票可抵扣</small></div><span><strong>{amountLabel(invoiceVatSummary.deductibleInputVat)}</strong><small>可抵扣</small></span></article>
          <article className="foundation-record"><div><strong>未认证进项</strong><small>认证中、未要求或认证异常均不抵扣</small></div><span><strong>{amountLabel(invoiceVatSummary.nonDeductibleInputVat)}</strong><small>不可抵扣</small></span></article>
          <article className="foundation-record"><div><strong>本期应交增值税</strong><small>max（销项税额 − 可抵扣进项税额，0）</small></div><span><strong>{amountLabel(invoiceVatSummary.vatPayable)}</strong><small>本地底稿</small></span></article>
        </div>
        <div className="foundation-record-list">
          {invoiceVatSummary.rows.map((row) => {
            const bucketLabel = {
              outputVat: "计入销项税额",
              deductibleInputVat: "计入可抵扣进项",
              nonDeductibleInputVat: "列为不可抵扣进项",
              excluded: "未计入汇总",
            }[row.bucket];
            return (
              <article className="foundation-record" key={row.documentId}>
                <div><strong>{row.invoiceNumber || "未填写发票号码"} · {row.name}</strong><small>{statusLabel(INVOICE_TAX_DIRECTION_OPTIONS, row.taxDirection, "未分类")} · {row.invoiceDate || "未填写日期"} · 关联 {row.linkedObjectIds.length} 个对象</small><p>价税合计 {amountLabel(row.grossAmount)} · 税额 {amountLabel(row.taxAmount)} · 税率 {row.taxRate ?? "未填"}% · {row.taxAmountSource === "derived_from_gross_and_rate" ? "税额由价税合计与税率计算" : "税额为人工录入"}</p><p>{row.reason}；查验 {statusLabel(INVOICE_STATUS_OPTIONS.verificationStatus, row.verificationStatus, "未查验")} · 红字 {statusLabel(INVOICE_STATUS_OPTIONS.redLetterStatus, row.redLetterStatus, "正常蓝字")} · 作废 {statusLabel(INVOICE_STATUS_OPTIONS.voidStatus, row.voidStatus, "有效")} · 认证 {statusLabel(INVOICE_STATUS_OPTIONS.certificationStatus, row.certificationStatus, "无需认证")}</p></div>
                <span><strong>{bucketLabel}</strong><small>来源 {row.documentId}</small></span>
              </article>
            );
          })}
          {!invoiceVatSummary.rows.length && <p className="foundation-empty">本期还没有结构化发票；税务页暂时继续使用原有本地估算口径。</p>}
        </div>
        <div className="foundation-section-heading" style={{ marginTop: 18 }}>
          <div><small>发票数 − 账面数 · 本地核对</small><h3>增值税差异核对</h3></div>
          <span>{vatReconciliation.unresolvedItems.length ? `待解释 ${vatReconciliation.unresolvedItems.length} 项` : "两项已核对"}</span>
        </div>
        <p className="foundation-hint">本地调整金额只计入这份税务底稿的发票口径，不修改原凭证或原发票。存在差额时必须填写真实原因；来源发生变化后，旧说明仍保留在历史记录，但最终本地申报包会再次被阻止，直到重新核对。</p>
        <div className="foundation-record-list">
          {vatReconciliation.items.map((item) => {
            const draft = vatReconciliationDrafts[item.kind] || {};
            const draftAdjustment = draft.adjustmentAmount === "" || draft.adjustmentAmount == null ? 0 : Number(draft.adjustmentAmount);
            const previewAdjustedInvoice = Number.isFinite(draftAdjustment) ? item.invoiceAmount + draftAdjustment : item.invoiceAmount;
            const previewDifference = Number.isFinite(draftAdjustment) ? previewAdjustedInvoice - item.bookAmount : item.differenceBeforeAdjustment;
            const history = item.storedRecord?.history || [];
            return (
              <article className="foundation-record" key={item.kind}>
                <div style={{ width: "100%" }}>
                  <strong>{item.label}</strong>
                  <small>{VAT_RECONCILIATION_STATUS_LABELS[item.status]} · 当前口径：发票数 + 本地调整 − 账面数</small>
                  <p>账面数 {amountLabel(item.bookAmount)} · 发票数 {amountLabel(item.invoiceAmount)} · 调整前差额 {amountLabel(item.differenceBeforeAdjustment)}</p>
                  <div className="document-intake-controls">
                    <label className="foundation-field"><span>真实差额原因</span><input value={draft.reason || ""} onChange={(event) => updateVatReconciliationDraft(item.kind, "reason", event.target.value)} placeholder={item.requiresExplanation ? "例如：未开票收入、认证跨期" : "当前无差额，可不填写"} /></label>
                    <label className="foundation-field"><span>本地调整金额（计入发票口径）</span><input type="number" step="0.01" value={draft.adjustmentAmount ?? ""} onChange={(event) => updateVatReconciliationDraft(item.kind, "adjustmentAmount", event.target.value)} placeholder="0.00" /></label>
                    <button className="primary-button" type="button" onClick={() => saveVatReconciliation(item)}>保存说明与调整</button>
                  </div>
                  <p>调整后发票数 {amountLabel(previewAdjustedInvoice)} · 调整后差额 {amountLabel(previewDifference)}</p>
                  <details open>
                    <summary>账面来源明细（{item.bookSources.length}）</summary>
                    {item.bookSources.map((source, index) => <p key={`${item.kind}-book-${source.id}-${index}`}>{source.date || "未填写日期"} · {source.title} · {source.reference || "无凭证号"} · {amountLabel(source.amount)}</p>)}
                    {!item.bookSources.length && <p>没有本期会计来源明细，账面数为 0。</p>}
                  </details>
                  <details open>
                    <summary>发票来源明细（{item.invoiceSources.length}）</summary>
                    {item.invoiceSources.map((source, index) => <p key={`${item.kind}-invoice-${source.id}-${index}`}>{source.date || "未填写日期"} · {source.title} · {source.reference || "无发票号"} · {amountLabel(source.amount)}</p>)}
                    {!item.invoiceSources.length && <p>没有进入当前口径的结构化发票，发票数为 0。</p>}
                  </details>
                  {!!history.length && (
                    <details>
                      <summary>本地核对历史（{history.length}）</summary>
                      {history.map((entry, index) => <p key={`${item.kind}-history-${entry.at}-${index}`}>{entry.at} · {entry.actor} · 调整前 {amountLabel(entry.before?.difference)} · 本地调整 {amountLabel(entry.adjustmentAmount)} · 调整后 {amountLabel(entry.after?.difference)} · {entry.reason || "当时无差额"}</p>)}
                    </details>
                  )}
                </div>
                <span><strong>{VAT_RECONCILIATION_STATUS_LABELS[item.status]}</strong><small>{item.resolved ? "可进入后续流程" : "阻止最终申报包"}</small></span>
              </article>
            );
          })}
        </div>
      </div>
      <div className="bank-import-workspace">
        <div className="foundation-section-heading">
          <div><small>{activeWorkspace.currentPeriod} · CSV / XLS / XLSX · 仅本地</small><h3>工资与社保导入核对</h3></div>
          <span>工资 {payrollSocialSummary.counts.payroll} 人 · 社保 {payrollSocialSummary.counts.socialSecurity} 人 · 差异 {payrollSocialSummary.counts.issues} 人</span>
        </div>
        <p className="foundation-hint">每次选择工资表或社保表，字段确认后按“同类表＋员工＋所属期”覆盖去重写入当前工作台。文件只在当前浏览器解析，不上传；这里不会连接社保、个税或税务平台。</p>
        <div className="document-intake-controls">
          <label className="foundation-field"><span>导入类型</span><select value={payrollImportKind} onChange={(event) => setPayrollImportKind(event.target.value)}>{Object.entries(PAYROLL_SOCIAL_IMPORT_KINDS).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
          <label className="foundation-field"><span>默认所属期</span><input type="month" value={payrollImportPeriod} onChange={(event) => setPayrollImportPeriod(event.target.value)} /></label>
          <button className="secondary-button" type="button" disabled={payrollImportBusy} onClick={() => payrollFileInputRef.current?.click()}><FileArrowUp size={17} />{payrollImportBusy ? "读取中…" : `选择${PAYROLL_SOCIAL_IMPORT_KINDS[payrollImportKind]}`}</button>
          <input ref={payrollFileInputRef} type="file" accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={choosePayrollSocialFile} />
        </div>
        {payrollFilePreview && payrollImportPlan && (
          <div className="bank-import-workspace">
            <div className="foundation-section-heading"><div><small>{payrollFilePreview.sheetName ? `工作表 ${payrollFilePreview.sheetName}` : "CSV"}</small><h3>{payrollFilePreview.fileName}</h3></div><span>{payrollImportPlan.canApply ? `可写入 ${payrollImportPlan.rows.length} 人次` : "映射或数据待修正"}</span></div>
            <div className="document-intake-controls">
              {Object.entries(PAYROLL_SOCIAL_FIELD_DEFINITIONS).map(([field, definition]) => (
                <label className="foundation-field" key={field}>
                  <span>{definition.label}{definition.required ? "（必填）" : ""}</span>
                  <select value={payrollFieldMapping[field] ?? ""} onChange={(event) => updatePayrollFieldMapping(field, event.target.value)}>
                    <option value="">不映射</option>
                    {payrollFilePreview.inspection.headers.map((header, index) => <option value={index} key={`${field}-${index}`}>{header || `第 ${index + 1} 列`}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <p className="foundation-hint">文件内重复 {payrollImportPlan.duplicateRowCount} 行 · 将覆盖已有同员工同期间记录 {payrollImportPlan.replacementCount} 行。</p>
            {!!payrollImportPlan.mappingErrors.length && <div className="foundation-error"><WarningCircle size={18} /><span>{payrollImportPlan.mappingErrors.join("；")}</span></div>}
            {!!payrollImportPlan.errors.length && <div className="foundation-error"><WarningCircle size={18} /><span>{payrollImportPlan.errors.slice(0, 8).map((item) => `第 ${item.rowNumber} 行 ${item.employeeName || ""}：${item.message}`).join("；")}</span></div>}
            <div className="foundation-record-list">
              {payrollImportPlan.rows.slice(0, 5).map((row) => <article className="foundation-record" key={row.dedupeKey}><div><strong>{row.employeeName} · {row.period}</strong><small>{row.personnelId ? `已匹配人员 ${row.personnelId}` : "人员档案未匹配"}</small><p>应发 {amountLabel(row.grossSalary)} · 个人社保 {amountLabel(row.personalSocial)} · 企业社保 {amountLabel(row.employerSocial)} · 个税 {amountLabel(row.individualIncomeTax)} · 实发 {amountLabel(row.netSalary)}</p></div><span><strong>第 {row.sourceRowNumber} 行</strong><small>{PAYROLL_SOCIAL_IMPORT_KINDS[row.sourceKind]}</small></span></article>)}
            </div>
            <div className="foundation-inline-actions"><button className="primary-button" type="button" disabled={!payrollImportPlan.canApply} onClick={commitPayrollSocialImport}>确认映射并写入当前工作台</button><button className="secondary-button" type="button" onClick={() => { setPayrollFilePreview(null); setPayrollFieldMapping({}); }}>取消</button></div>
          </div>
        )}
        <div className="foundation-section-heading" style={{ marginTop: 18 }}>
          <div><small>按员工归属 · 工资表对社保表</small><h3>逐人差异</h3></div>
          <span>{payrollSocialSummary.hasDifferences ? `${payrollSocialSummary.counts.issues} 人待核对` : "人员与金额一致"}</span>
        </div>
        <div className="foundation-record-list">
          {payrollSocialSummary.rows.map((row) => (
            <article className="foundation-record" key={row.key}>
              <div>
                <strong>{row.employeeName}</strong>
                <small>{!row.person ? "人员档案缺失" : (row.personnelStatus === "active" || !row.personnelStatus ? `在职 · ${row.person.department || "未填写部门"}` : `离职／非在职 · 状态 ${row.personnelStatus}`)}</small>
                <p>工资表：应发 {amountLabel(row.payrollRecord?.grossSalary)} · 个人社保 {amountLabel(row.payrollRecord?.personalSocial)} · 企业社保 {amountLabel(row.payrollRecord?.employerSocial)} · 个税 {amountLabel(row.payrollRecord?.individualIncomeTax)} · 实发 {amountLabel(row.payrollRecord?.netSalary)}</p>
                <p>社保表：工资／基数 {amountLabel(row.socialSecurityRecord?.grossSalary)} · 个人社保 {amountLabel(row.socialSecurityRecord?.personalSocial)} · 企业社保 {amountLabel(row.socialSecurityRecord?.employerSocial)}</p>
                <p>金额差异（工资表 − 社保表）：应发／基数 {row.differences.grossSalary == null ? "不可比" : amountLabel(row.differences.grossSalary)} · 个人社保 {row.differences.personalSocial == null ? "不可比" : amountLabel(row.differences.personalSocial)} · 企业社保 {row.differences.employerSocial == null ? "不可比" : amountLabel(row.differences.employerSocial)}</p>
              </div>
              <span><strong>{row.matched ? "一致" : row.issues.map((issue) => issue.label).join("；")}</strong><small>{row.payrollRecord?.sourceFileName || "缺工资表"} · {row.socialSecurityRecord?.sourceFileName || "缺社保表"}</small></span>
            </article>
          ))}
          {!payrollSocialSummary.rows.length && <p className="foundation-empty">当前期间没有工资或社保记录，也没有在职人员可核对。</p>}
        </div>
        <div className="foundation-section-heading" style={{ marginTop: 18 }}>
          <div><small>绑定当前冻结版本 · 两项独立确认</small><h3>客户确认</h3></div>
          <span>{payrollSocialConfirmation.version ? payrollSocialConfirmation.version.label : "需先重新冻结报表"}</span>
        </div>
        <p className="foundation-hint">工资表与社保表必须分别由客户勾选。确认后数据才满足申报底稿与最终本地申报包的流程条件；重新导入或修改数据会自动撤销旧确认。</p>
        <div className="foundation-record-list">
          <article className="foundation-record">
            <label><input type="checkbox" checked={payrollSocialConfirmation.payroll.confirmed} disabled={!payrollSocialConfirmation.version || !payrollSocialConfirmation.payroll.available} onChange={(event) => togglePayrollSocialConfirmation("payroll", event.target.checked)} /> 客户确认本期工资表</label>
            <span><strong>{payrollSocialConfirmation.payroll.confirmed ? "已确认" : "未确认"}</strong><small>{payrollSocialConfirmation.payroll.available ? `${payrollSocialSummary.counts.payroll} 人 · 应发 ${amountLabel(payrollSocialSummary.totals.payroll.grossSalary)}` : "请先导入工资表"}</small></span>
          </article>
          <article className="foundation-record">
            <label><input type="checkbox" checked={payrollSocialConfirmation.socialSecurity.confirmed} disabled={!payrollSocialConfirmation.version || !payrollSocialConfirmation.socialSecurity.available} onChange={(event) => togglePayrollSocialConfirmation("socialSecurity", event.target.checked)} /> 客户确认本期社保表</label>
            <span><strong>{payrollSocialConfirmation.socialSecurity.confirmed ? "已确认" : "未确认"}</strong><small>{payrollSocialConfirmation.socialSecurity.available ? `${payrollSocialSummary.counts.socialSecurity} 人 · 社保合计 ${amountLabel(payrollSocialSummary.totals.socialSecurityPayable)}` : "请先导入社保表"}</small></span>
          </article>
        </div>
        {!!(activeWorkspace.payrollImports || []).length && <p className="foundation-hint">当前工作台已记录 {(activeWorkspace.payrollImports || []).length} 个本地导入批次；最近一次为 {(activeWorkspace.payrollImports || []).at(-1).fileName}，原文件没有上传。</p>}
      </div>
      <div className="bank-import-workspace">
        <div className="foundation-section-heading">
          <div><small>本地规则建议 · 必须人工确认</small><h3>资料匹配与缺件待办</h3></div>
          <span>建议 {matchSuggestions.length} · 待补 {openDocumentTasks.length} · 已关闭 {resolvedDocumentTaskCount}</span>
        </div>
        <p className="foundation-hint">建议只比较资料名称、人工录入字段与业务的对方、金额、日期／期间；生成建议不会建立任何关联。</p>
        <div className="foundation-inline-actions"><button className="secondary-button" type="button" onClick={refreshMissingTasks}>刷新缺件待办</button></div>
        {!!openDocumentTasks.length && (
          <div className="foundation-record-list">
            {openDocumentTasks.map((task) => <article className="foundation-record" key={task.id}><div><strong>{task.message}</strong><small>{matchTargetLabel(task.sourceType)} · 等待补齐并确认关联</small></div></article>)}
          </div>
        )}
        <div className="foundation-record-list">
          {matchSuggestions.map((suggestion) => (
            <article className="foundation-record" key={suggestion.id}>
              <div><strong>{suggestion.documentName} → {suggestion.sourceLabel}</strong><small>{documentKindLabel(suggestion.documentKind)} · {matchTargetLabel(suggestion.sourceType)} · 匹配分 {suggestion.score}</small><p>{suggestion.reasons.join("；")}</p></div>
              <button className="primary-button" type="button" disabled={confirmingSuggestionId === suggestion.id} onClick={() => confirmSuggestion(suggestion)}>{confirmingSuggestionId === suggestion.id ? "确认中…" : "确认关联"}</button>
            </article>
          ))}
          {!matchSuggestions.length && <p className="foundation-empty">当前没有达到建议阈值的未确认匹配；可先补录资料详情，或在资料编辑区手动关联。</p>}
        </div>
      </div>
      <div className="bank-import-workspace">
        <div className="foundation-section-heading">
          <div><small>凭证附件包 · 仅本地生成</small><h3>选择凭证并核对附件</h3></div>
          <span>{selectedVoucher?.attachmentPackages?.length || 0} 次生成记录</span>
        </div>
        <p className="foundation-hint">选择凭证只展示已关联资料和缺失项，不会读取原文件或生成 ZIP；只有点击下方按钮才会从当前浏览器读取原文件、复核哈希并下载，任何内容都不会上传网络。</p>
        <div className="document-intake-controls">
          <label className="foundation-field"><span>凭证</span><select value={selectedVoucherId} onChange={(event) => setSelectedVoucherId(event.target.value)}><option value="">请选择凭证</option>{(activeWorkspace.vouchers || []).map((voucher) => <option value={voucher.id} key={voucher.id}>{voucher.no || "凭证草稿"} · {voucher.summary || voucher.id}</option>)}</select></label>
          <button className="primary-button" type="button" disabled={!fileVault || !selectedVoucher || generatingPackage} onClick={generateAttachmentPackage}><DownloadSimple size={17} />{generatingPackage ? "正在生成 ZIP…" : "生成并下载本地 ZIP"}</button>
        </div>
        {voucherPackagePlan ? (
          <>
            <div className="foundation-record-list">
              {voucherPackagePlan.sections.map((section) => {
                const statusText = section.status === "collected" ? "已收集" : (section.status === "missing" ? "缺失" : "未要求");
                const documentText = section.documents.length
                  ? section.documents.map((document) => `${document.name}${document.storage?.availableLocally ? "" : "（原文件缺失）"}`).join("、")
                  : "没有已关联原文件";
                const recordText = section.key === "missing"
                  ? `缺失清单 ${voucherPackagePlan.missingItems.length} 项`
                  : (section.records.length ? `另有本地记录 ${section.records.length} 条` : "没有关联记录");
                return (
                  <article className="foundation-record" key={section.key}>
                    <div><strong>{String(section.order).padStart(2, "0")} · {section.label}</strong><small>{documentText}</small><p>{recordText}</p></div>
                    <span><strong>{statusText}</strong><small>{section.required ? "本包检查项" : "当前凭证未要求"}</small></span>
                  </article>
                );
              })}
            </div>
            {!!voucherPackagePlan.missingItems.length && <div className="foundation-notice"><WarningCircle size={18} /><span><strong>当前缺失：</strong> {voucherPackagePlan.missingItems.map((item) => `${item.label}（${item.reason}）`).join("；")}</span></div>}
            {!!selectedVoucher?.attachmentPackages?.length && <p className="foundation-hint">最近一次：{selectedVoucher.attachmentPackages.at(-1).generatedAt} · {selectedVoucher.attachmentPackages.at(-1).fileName} · 记录保存在当前工作台，ZIP 本体只下载到本机。</p>}
          </>
        ) : <p className="foundation-empty">当前工作台还没有可选凭证。</p>}
      </div>
      <div className="bank-import-workspace">
        <div className="foundation-section-heading">
          <div><small>整月财务档案 · 本地 ZIP</small><h3>选择期间并核对归档清单</h3></div>
          <span>{monthlyArchivePlan?.isComplete ? "可生成完整档案" : "仅可导出不完整草稿"}</span>
        </div>
        <p className="foundation-hint">选择期间只计算归档清单，不读取回执原文件、不生成 ZIP。点击导出后才会读取并校验真实回执，为 ZIP 内每个文件生成统一哈希；导出记录不会把期间标记为正式归档，也不会上传网络。</p>
        <div className="document-intake-controls">
          <label className="foundation-field"><span>财务期间</span><select value={selectedArchivePeriod} onChange={(event) => setSelectedArchivePeriod(event.target.value)}>{archivePeriods.map((archivePeriod) => <option value={archivePeriod} key={archivePeriod}>{archivePeriod}</option>)}</select></label>
          <button className={monthlyArchivePlan?.isComplete ? "primary-button" : "secondary-button"} type="button" disabled={!fileVault || !monthlyArchivePlan || generatingMonthlyArchive} onClick={generateMonthlyArchive}><DownloadSimple size={17} />{generatingMonthlyArchive ? "正在生成 ZIP…" : (monthlyArchivePlan?.isComplete ? "生成完整财务档案 ZIP" : "导出不完整财务档案草稿")}</button>
        </div>
        {monthlyArchivePlan ? (
          <>
            <div className="foundation-record-list">
              {monthlyArchivePlan.sections.map((section) => {
                const statusText = section.status === "collected" ? "已收集" : (section.status === "missing" ? "缺失" : "点击后生成");
                return <article className="foundation-record" key={section.key}><div><strong>{String(section.order).padStart(2, "0")} · {section.label}</strong><small>{section.detail}</small></div><span><strong>{statusText}</strong><small>{section.count == null ? "" : `${section.count} 项`}</small></span></article>;
              })}
            </div>
            {!!monthlyArchivePlan.missingItems.length && <div className="foundation-notice"><WarningCircle size={18} /><span><strong>不能标记为完整档案：</strong> {monthlyArchivePlan.missingItems.map((item) => `${item.label}（${item.reason}）`).join("；")}。仍可导出文件名和清单均明确标注的“不完整草稿包”。</span></div>}
            {!!monthlyArchiveExports.length && <p className="foundation-hint">本期间已导出 {monthlyArchiveExports.length} 次；最近一次为 {monthlyArchiveExports.at(-1).fileName}。这些是本地导出记录，不等于正式期间归档。</p>}
          </>
        ) : <p className="foundation-empty">当前工作台没有可导出的财务期间。</p>}
      </div>
      <div className="document-intake-controls" style={{ marginTop: 14 }}>
        <label className="foundation-field"><span>搜索资料</span><span className="search-field"><MagnifyingGlass size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="文件名、哈希或关联对象" /></span></label>
        <label className="foundation-field"><span>类别筛选</span><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">全部类别</option>{categories.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        <label className="foundation-field"><span>状态筛选</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">全部状态</option><option value="active">未归档</option><option value="archived">已归档</option><option value="linked">已关联</option><option value="unlinked">未使用，可删除</option><option value="available">原文件可用</option><option value="missing">原文件缺失</option></select></label>
        <button className="secondary-button" type="button" onClick={() => { setQuery(""); setCategoryFilter("all"); setStatusFilter("all"); }}>清空筛选</button>
      </div>
      {error && <div className="foundation-error"><WarningCircle size={18} />{error}</div>}
      {preview && (
        <div className="bank-import-workspace">
          <div className="foundation-section-heading"><div><small>浏览器本地预览</small><h3>{preview.document.name}</h3></div><button className="foundation-icon-button" type="button" aria-label="关闭预览" onClick={closePreview}><X size={17} /></button></div>
          {preview.kind === "image" && <img src={preview.url} alt={preview.document.name} style={{ display: "block", maxWidth: "100%", maxHeight: 560, margin: "0 auto", objectFit: "contain" }} />}
          {preview.kind === "pdf" && <iframe src={preview.url} title={`预览 ${preview.document.name}`} style={{ width: "100%", minHeight: 520, border: "1px solid var(--line-soft)", borderRadius: 8 }} />}
          {preview.kind === "text" && <div className="bank-preview-scroll"><pre style={{ margin: 0, padding: 14, maxHeight: 520, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12 }}>{preview.text}</pre>{preview.truncated && <p className="foundation-hint">内容较长，页面仅显示前 300,000 个字符；下载可查看完整原文件。</p>}</div>}
          {preview.kind === "audio" && <audio src={preview.url} controls style={{ width: "100%" }} />}
          {preview.kind === "video" && <video src={preview.url} controls style={{ width: "100%", maxHeight: 560 }} />}
          {preview.kind === "unsupported" && <div className="foundation-notice"><WarningCircle size={18} />该格式无法由浏览器直接预览，原文件仍可完整下载。</div>}
          <div className="foundation-inline-actions"><button className="secondary-button" type="button" onClick={() => download(preview.document)}><DownloadSimple size={16} />下载原文件</button></div>
        </div>
      )}
      <div className="document-record-grid">
        {filteredDocuments.map((document) => {
          const locallyAvailable = document.storage?.mode === "indexeddb" && document.storage?.availableLocally;
          const usage = getLocalDocumentUsage(activeWorkspace, document.id);
          const archived = usage.some((item) => item.kind === "archive");
          const isEditing = editing?.id === document.id;
          const pendingAction = pendingDocumentAction?.documentId === document.id ? pendingDocumentAction.action : null;
          const confirmationId = `document-action-${document.id}`;
          return (
            <article className="document-record" key={document.id}>
              <span className="document-record-icon"><FileText size={20} /></span>
              <div>
                <strong>{document.name}</strong>
                <small>{document.category} · {document.period || "未分期"} · {fileSize(document.size)} · {archived ? "已归档" : document.lifecycleStatus || "已获取"}</small>
                <p title={usage.map((item) => item.label).join("、")}>{usage.length ? `正在使用：${usage.map((item) => item.label).join("、")}` : "未使用，可安全删除"}</p>
                <p>{document.hash ? `哈希 ${document.hash.slice(0, 12)}… · ${locallyAvailable ? "原文件可用" : "原文件缺失"}` : "仅有资料元数据；未保存原文件"}</p>
                {structuredDetailLines(document).map((line) => <p key={line}>{line}</p>)}
                {documentStructuredKind(document.category) && <p>字段来源：人工录入 · OCR 未连接</p>}
                {isEditing && (
                  <div className="bank-import-workspace">
                    <div className="document-intake-controls">
                      <label className="foundation-field"><span>文件名称</span><input value={editing.name} onChange={(event) => setEditing((current) => ({ ...current, name: event.target.value }))} /></label>
                      <label className="foundation-field"><span>资料类别</span><select value={editing.category} onChange={(event) => changeEditCategory(event.target.value)}>{CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label>
                      <label className="foundation-field"><span>业务期间</span><input type="month" value={editing.period} onChange={(event) => setEditing((current) => ({ ...current, period: event.target.value }))} /></label>
                      <label className="foundation-field"><span>添加关联对象</span><select value="" onChange={(event) => addEditRelation(event.target.value)}><option value="">选择后加入</option>{relatedGroups.map((group) => <optgroup label={group.label} key={group.collection}>{group.items.filter((item) => !editing.relatedObjectIds.includes(item.id)).map((item) => <option value={item.id} key={item.id}>{relatedLabel(item)}</option>)}</optgroup>)}</select></label>
                    </div>
                    <StructuredDataFields category={editing.category} value={editing.structuredData} onChange={(structuredData) => setEditing((current) => ({ ...current, structuredData }))} workspace={activeWorkspace} currentDocumentId={editing.id} />
                    <div className="permission-chip-list">{editing.relatedObjectIds.map((objectId) => <span key={objectId}>{relatedLabels.get(objectId) || objectId} <button type="button" aria-label={`解除 ${relatedLabels.get(objectId) || objectId} 关联`} onClick={() => removeEditRelation(objectId)}>×</button></span>)}</div>
                    <div className="foundation-inline-actions"><button className="primary-button" type="button" onClick={saveEdit}>保存资料详情</button><button className="secondary-button" type="button" onClick={closeEditing}>取消</button></div>
                  </div>
                )}
                {pendingAction && (
                  <div
                    id={confirmationId}
                    className={`document-action-confirmation ${pendingAction}`}
                    role="alertdialog"
                    aria-modal="false"
                    aria-labelledby={`${confirmationId}-title`}
                    aria-describedby={`${confirmationId}-description`}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      event.preventDefault();
                      event.stopPropagation();
                      clearPendingDocumentAction(true);
                    }}
                  >
                    {pendingAction === "delete" ? <WarningCircle size={19} /> : <Archive size={19} />}
                    <div className="document-action-confirmation-copy">
                      <strong id={`${confirmationId}-title`}>{pendingAction === "delete" ? "确认删除资料" : "确认归档资料"}</strong>
                      <p id={`${confirmationId}-description`}>{pendingAction === "delete"
                        ? <>将删除“{document.name}”的资料记录及当前浏览器中的本地原文件，无法从本页面恢复。</>
                        : <>归档“{document.name}”后将不能直接修改或删除；资料记录和本地原文件仍会保留。</>}</p>
                    </div>
                    <div className="document-action-confirmation-actions">
                      <button ref={documentActionCancelRef} className="secondary-button" type="button" onClick={() => clearPendingDocumentAction(true)}>取消</button>
                      <button className={pendingAction === "delete" ? "danger-button" : "primary-button"} type="button" onClick={() => pendingAction === "delete" ? remove(document) : archive(document)}>{pendingAction === "delete" ? "确认删除" : "确认归档"}</button>
                    </div>
                  </div>
                )}
              </div>
              <span className="foundation-record-actions">
                <button type="button" disabled={!locallyAvailable || !fileVault} aria-label="页面预览" title="页面预览" onClick={() => showPreview(document)}><Eye size={15} /></button>
                <button type="button" disabled={!locallyAvailable || !fileVault} aria-label="下载原文件" title="下载原文件" onClick={() => download(document)}><DownloadSimple size={15} /></button>
                <button type="button" disabled={archived} aria-label="编辑资料详情" title={archived ? "已归档资料不能直接修改" : "编辑资料详情"} onClick={() => beginEdit(document)}><PencilSimple size={15} /></button>
                <button type="button" disabled={archived} aria-label="标记归档" aria-haspopup="dialog" aria-expanded={pendingAction === "archive"} aria-controls={confirmationId} title={archived ? "资料已归档" : "标记归档"} onClick={(event) => requestDocumentAction(document, "archive", event.currentTarget)}><Archive size={15} /></button>
                <button type="button" disabled={usage.length > 0} aria-label="删除未使用资料" aria-haspopup="dialog" aria-expanded={pendingAction === "delete"} aria-controls={confirmationId} title={usage.length ? `不能删除：${usage.map((item) => item.label).join("、")}` : "删除未使用资料"} onClick={(event) => requestDocumentAction(document, "delete", event.currentTarget)}><Trash size={15} /></button>
              </span>
            </article>
          );
        })}
        {!filteredDocuments.length && <p className="foundation-empty">没有符合当前条件的资料。</p>}
      </div>
    </section>
  );
}
