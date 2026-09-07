import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePeriodLeaveGuard } from "../workspaces/periodNavigation.js";
import {
  Archive,
  CheckCircle,
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
import { assertWorkspacePermission } from "../../domain/foundation.js";
import {
  applyWorkspaceTerminology,
  buildVatReconciliationSummary,
  buildPayrollAccountingSummary,
  createPayrollAccrualDraft,
  confirmPayrollSocialData,
  getPayrollSocialConfirmationState,
  recordVatReconciliation,
  workspaceModuleEnabled,
  workspaceTerminology,
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
  getLocalDocumentRecognition,
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
import { getDocumentRecognitionTask, isRecognitionTaskPending } from "./documentRecognitionTask.js";
import { calculateContractPeriodAmount } from "./contractBillingAmounts.js";
import { buildContractDiscountSuggestion } from "./contractDiscountTerms.js";
import { resolveContractCounterparty } from "./contractCounterparty.js";
import "./document-intake-panel.css";
import "../workspaces/foundation-ui.css";

const PayrollVoucherWorkbench = lazy(() => import("../accounting/AccountingWorkbench.jsx").then((module) => ({ default: module.AccountingWorkbench })));

const CATEGORIES = ["主体资料", "合同", "银行流水", "业务资料", "发票", "审批资料", "人员资料", "工资表", "社保数据", "会计资料", "申报回执", "其他资料"];
const PAYROLL_DOCUMENT_CATEGORIES = new Set(["工资表", "社保表", "社保数据", "工资社保数据", "payroll", "socialSecurity"]);
const RECOGNITION_FIELD_LABELS = {
  partyA: "合同甲方", partyB: "合同乙方", amount: "金额", invoiceNumber: "发票号码", invoiceDate: "发票日期",
  counterparty: "往来单位", taxAmount: "税额", taxRate: "税率（%）", applicant: "申请人", supplier: "收付款对象",
  approvalDate: "审批日期", serviceStartDate: "服务开始日期", serviceEndDate: "服务结束日期",
  refundTerms: "退款条款", commissionTerms: "佣金条款", firstBillDate: "首次账单日", periodAmount: "每期金额", settlementCycle: "结算周期",
  discountTerms: "折扣条款", performanceTerms: "履约条件",
};

function documentEditDraft(document, workspace) {
  return { id: document.id, name: document.name || "", category: document.category || "其他资料", period: document.period || "",
    relatedObjectIds: getDocumentRelatedObjectIds(workspace, document.id),
    structuredData: normalizeDocumentStructuredData(document.category, document.structuredData || {}) };
}

function recognitionProgressLabel(progress) {
  const stage = { loading: "正在加载本地识别引擎", extracting: "正在读取 PDF 文字", recognizing: "正在识别文字" }[progress?.stage] || "正在准备原件";
  return `${stage}${progress?.pageNumber ? ` · 第 ${progress.pageNumber}/${progress.totalPages || "?"} 页` : ""}`;
}

function isPayrollDocumentCategory(category) {
  return PAYROLL_DOCUMENT_CATEGORIES.has(String(category || "").trim());
}

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

function categoryDisplayLabel(category, workspace) {
  if (category === "人员资料") return `${workspaceTerminology(workspace).personnel}资料`;
  return category;
}

function structuredDetailLines(document, workspace) {
  const kind = documentStructuredKind(document.category);
  const details = document.structuredData || {};
  const terminology = workspaceTerminology(workspace);
  const displayText = (value) => applyWorkspaceTerminology(value, workspace);
  if (kind === "contract") {
    return [
      `合同主体：${details.partyA || "未填写"} ↔ ${details.partyB || "未填写"} · 金额 ${amountLabel(details.amount)}`,
      `合同类型：${displayText(CONTRACT_TYPES[details.contractType] || "未选择")} · ${CONTRACT_SETTLEMENT_MODES[details.settlementMode] ? displayText(CONTRACT_SETTLEMENT_MODES[details.settlementMode]) : (details.settlementCycle || "未设置结算")}`,
      `账单计划：每期${details.discountRule?.enabled ? "折前" : ""} ${amountLabel(details.periodAmount)}${details.discountRule?.enabled ? ` · 优惠后 ${amountLabel(calculateContractPeriodAmount(details).netAmount)}` : ""} · 首次 ${details.firstBillDate || "未填写"} · 结束 ${details.billingEndDate || "未填写"} · ${displayText(CONTRACT_DUE_DATE_RULES[details.dueDateRule] || "未设置到期规则")}${details.dueDateRule === "days_after" ? ` ${details.dueDays || 0} 天` : ""}`,
      `${terminology.service}期限：${details.serviceStartDate || "未填写"} 至 ${details.serviceEndDate || "未填写"}`,
      `退款条款：${details.refundTerms || "未填写"}`,
      `折扣条款：${details.discountTerms || "未填写"}`,
      `佣金条款：${details.commissionTerms || "未填写"}`,
      `履约条件：${details.performanceTerms || "未填写"}`,
    ];
  }
  if (kind === "invoice") {
    return [
      `发票号码：${details.invoiceNumber || "未填写"} · 日期 ${details.invoiceDate || "未填写"} · ${statusLabel(INVOICE_TAX_DIRECTION_OPTIONS, details.taxDirection, "未分类")}`,
      `${details.taxDirection === "output" ? terminology.customer : (details.taxDirection === "input" ? terminology.supplier : "往来单位")}：${details.counterparty || "未填写"} · 金额 ${amountLabel(details.amount)} · 税额 ${amountLabel(details.taxAmount)} · 税率 ${details.taxRate == null ? "未填写" : `${details.taxRate}%`}`,
      `查验 ${statusLabel(INVOICE_STATUS_OPTIONS.verificationStatus, details.verificationStatus, "未查验")} · 红字 ${statusLabel(INVOICE_STATUS_OPTIONS.redLetterStatus, details.redLetterStatus, "正常蓝字")} · 作废 ${statusLabel(INVOICE_STATUS_OPTIONS.voidStatus, details.voidStatus, "有效")} · 认证 ${statusLabel(INVOICE_STATUS_OPTIONS.certificationStatus, details.certificationStatus, "无需认证")}`,
      details.redLetterStatus === "normal"
        ? `关联账单：${details.linkedBillId || "尚未确认"}`
        : `原发票：${details.originalInvoiceDocumentId || "未选择"} · 原账单：${details.originalBillId || "未选择"} · 已调整账单：${details.linkedBillId || "尚未确认"}`,
    ];
  }
  if (kind === "approval") {
    return [
      `审批类型：${displayText(APPROVAL_TYPES[details.approvalType] || "未选择")} · ${statusLabel(APPROVAL_STATUS_OPTIONS, details.approvalStatus, "草稿")} · 日期 ${details.approvalDate || "未填写"}`,
      `申请人：${details.applicant || "未填写"} · ${terminology.supplier}／对象：${details.supplier || "未填写"} · 金额 ${amountLabel(details.amount)}`,
      `业务关联：${details.linkStatus === "linked" ? `${details.linkedTargetType === "bill" ? "账单" : "银行流水"} ${details.linkedTargetId}` : (details.linkStatus === "invalidated" ? "原关联已失效，等待重新处理" : "尚未确认")} · 业务事件 ${details.businessEventId || "未生成"}`,
    ];
  }
  return [];
}

function ContractDiscountFields({ details, onChange, document }) {
  const rule = details.discountRule || { enabled: false, kind: "none", percent: null, fixedAmount: null };
  const suggestion = buildContractDiscountSuggestion(document);
  const termsChanged = String(details.discountTerms || "") !== String(document?.structuredData?.discountTerms || "");
  const amounts = calculateContractPeriodAmount(details);
  const updateRule = (patch) => onChange({ ...details, discountRule: { ...rule, ...patch } });
  const updateManualRule = (patch) => updateRule({ ...patch, source: { kind: "manual", text: "" } });
  return (
    <div className="document-contract-discount">
      <label className="document-contract-discount-toggle"><input type="checkbox" checked={rule.enabled === true} onChange={(event) => updateRule({ enabled: event.target.checked, kind: rule.kind === "none" ? "percent" : rule.kind })} /><span>启用每期优惠计算</span></label>
      {termsChanged && <p className="foundation-hint">先保存条款，再获取折扣建议；也可手动填写优惠规则。</p>}
      {!termsChanged && suggestion.status === "suggested" && <div className="document-contract-discount-suggestion"><span>条款建议：每期{suggestion.kind === "percent" ? `优惠 ${suggestion.value}%` : `减免 ${amountLabel(suggestion.value)}`}</span><button className="secondary-button" type="button" onClick={() => updateRule({ enabled: true, kind: suggestion.kind, percent: suggestion.kind === "percent" ? suggestion.value : null, fixedAmount: suggestion.kind === "fixed" ? suggestion.value : null, source: { kind: "saved_terms", text: suggestion.sourceText, documentId: suggestion.source.documentId, documentHash: suggestion.source.documentHash, documentVersion: suggestion.source.documentVersion } })}>采用建议并启用</button></div>}
      {!termsChanged && suggestion.status === "needs_review" && <div className="document-contract-discount-review"><p><WarningCircle size={16} /> 条款待复核：{suggestion.reason}</p><p>{suggestion.sourceText}</p></div>}
      {rule.enabled && <>
        <p className="foundation-hint">每期金额现为折前基数。优惠按每期计算；依据：{rule.source?.kind === "saved_terms" ? "已采用的合同条款" : "人工填写"}。</p>
        <div className="document-contract-discount-fields">
          <label className="foundation-field"><span>优惠方式</span><select value={rule.kind} onChange={(event) => updateManualRule({ kind: event.target.value })}><option value="percent">每期比例优惠</option><option value="fixed">每期固定减免</option></select></label>
          {rule.kind === "percent" ? <label className="foundation-field"><span>优惠比例（%，八折填 20）</span><input type="number" min="0" max="100" step="0.01" value={rule.percent ?? ""} onChange={(event) => updateManualRule({ percent: event.target.value })} /></label> : <label className="foundation-field"><span>每期减免金额（元）</span><input type="number" min="0" step="0.01" value={rule.fixedAmount ?? ""} onChange={(event) => updateManualRule({ fixedAmount: event.target.value })} /></label>}
        </div>
        {amounts.errors.length ? <p className="foundation-error"><WarningCircle size={16} /><span>{amounts.errors.join("；")}</span></p> : <div className="document-contract-discount-result" aria-live="polite"><span>折前 {amountLabel(amounts.grossAmount)}</span><span>优惠 {amountLabel(amounts.discountAmount)}</span><strong>最终每期 {amountLabel(amounts.netAmount)}</strong></div>}
      </>}
    </div>
  );
}

function StructuredDataFields({ category, value, onChange, workspace, currentDocumentId }) {
  const kind = documentStructuredKind(category);
  if (!kind) return null;
  const details = value?.kind === kind ? value : normalizeDocumentStructuredData(category, {});
  const terminology = workspaceTerminology(workspace);
  const displayText = (text) => applyWorkspaceTerminology(text, workspace);
  const update = (key, nextValue) => onChange({ ...details, [key]: nextValue });
  if (kind === "contract") {
    const membershipEnabled = workspaceModuleEnabled(workspace, "members");
    const counterparty = resolveContractCounterparty(workspace, details);
    const contractTypes = Object.entries(CONTRACT_TYPES).filter(([id]) => (
      id !== "membership" || membershipEnabled || details.contractType === "membership"
    ));
    return (
      <div className="document-intake-controls document-structured-fields">
        <label className="foundation-field"><span>合同甲方</span><input value={details.partyA || ""} onChange={(event) => update("partyA", event.target.value)} /></label>
        <label className="foundation-field"><span>合同乙方</span><input value={details.partyB || ""} onChange={(event) => update("partyB", event.target.value)} /></label>
        <label className="foundation-field"><span>账单往来对方</span><select value={details.counterpartyParty || "auto"} onChange={(event) => update("counterpartyParty", event.target.value)}><option value="auto">自动判定{counterparty.selection === "auto" && counterparty.counterparty ? ` · ${counterparty.counterparty}` : ""}</option><option value="partyA">甲方{details.partyA ? ` · ${details.partyA}` : "（未填写）"}</option><option value="partyB">乙方{details.partyB ? ` · ${details.partyB}` : "（未填写）"}</option></select><small className={counterparty.errors.length ? "document-contract-counterparty-error" : "foundation-hint"}>{counterparty.errors.length ? counterparty.errors.join("；") : `账单对方：${counterparty.counterparty}`}</small></label>
        <label className="foundation-field"><span>合同类型</span><select value={details.contractType || "unclassified"} onChange={(event) => update("contractType", event.target.value)}>{contractTypes.map(([id, label]) => <option value={id} key={id}>{displayText(label)}{id === "membership" && !membershipEnabled ? `（${terminology.member}模块已停用）` : ""}</option>)}</select></label>
        <label className="foundation-field"><span>合同金额</span><input type="number" min="0" step="0.01" value={details.amount ?? ""} onChange={(event) => update("amount", event.target.value)} /></label>
        <label className="foundation-field"><span>结算方式</span><select value={details.settlementMode || "unconfigured"} onChange={(event) => update("settlementMode", event.target.value)}>{Object.entries(CONTRACT_SETTLEMENT_MODES).map(([id, label]) => <option value={id} key={id}>{displayText(label)}</option>)}</select></label>
        <label className="foundation-field"><span>{details.discountRule?.enabled ? "每期折前金额" : "每期金额"}</span><input type="number" min="0" step="0.01" value={details.periodAmount ?? ""} onChange={(event) => update("periodAmount", event.target.value)} /></label>
        <label className="foundation-field"><span>首次账单日</span><input type="date" value={details.firstBillDate || ""} onChange={(event) => update("firstBillDate", event.target.value)} /></label>
        <label className="foundation-field"><span>到期日规则</span><select value={details.dueDateRule || "on_bill_date"} onChange={(event) => update("dueDateRule", event.target.value)}>{Object.entries(CONTRACT_DUE_DATE_RULES).map(([id, label]) => <option value={id} key={id}>{displayText(label)}</option>)}</select></label>
        {details.dueDateRule === "days_after" && <label className="foundation-field"><span>账单后多少天到期</span><input type="number" min="0" step="1" value={details.dueDays ?? 0} onChange={(event) => update("dueDays", event.target.value)} /></label>}
        <label className="foundation-field"><span>账单结束日期</span><input type="date" value={details.billingEndDate || ""} onChange={(event) => update("billingEndDate", event.target.value)} /></label>
        <label className="foundation-field"><span>{terminology.service}开始日期</span><input type="date" value={details.serviceStartDate || ""} onChange={(event) => update("serviceStartDate", event.target.value)} /></label>
        <label className="foundation-field"><span>{terminology.service}结束日期</span><input type="date" value={details.serviceEndDate || ""} onChange={(event) => update("serviceEndDate", event.target.value)} /></label>
        <div className="document-contract-terms">
          {[["refundTerms", "退款条款"], ["discountTerms", "折扣条款"], ["commissionTerms", "佣金条款"], ["performanceTerms", "履约条件"]].map(([key, label]) => (
            <label className="foundation-field" key={key}><span>{label}</span><textarea rows={3} value={details[key] || ""} onChange={(event) => update(key, event.target.value)} /></label>
          ))}
        </div>
        <ContractDiscountFields details={details} onChange={onChange} document={workspace.documents?.find((document) => document.id === currentDocumentId)} />
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
      <div className="document-intake-controls document-structured-fields">
        <label className="foundation-field"><span>发票号码</span><input value={details.invoiceNumber || ""} onChange={(event) => update("invoiceNumber", event.target.value)} placeholder="保存时检查重复" /></label>
        <label className="foundation-field"><span>发票日期</span><input type="date" value={details.invoiceDate || ""} onChange={(event) => update("invoiceDate", event.target.value)} /></label>
        <label className="foundation-field"><span>增值税方向（人工选择）</span><select value={details.taxDirection || "unclassified"} onChange={(event) => update("taxDirection", event.target.value)}>{INVOICE_TAX_DIRECTION_OPTIONS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
        <label className="foundation-field"><span>{details.taxDirection === "output" ? terminology.customer : (details.taxDirection === "input" ? terminology.supplier : `${terminology.customer}／${terminology.supplier}`)}</span><input value={details.counterparty || ""} onChange={(event) => update("counterparty", event.target.value)} placeholder="用于建议匹配已有账单" /></label>
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
    <div className="document-intake-controls document-structured-fields">
      <label className="foundation-field"><span>审批类型</span><select value={details.approvalType || "unclassified"} onChange={(event) => update("approvalType", event.target.value)}>{Object.entries(APPROVAL_TYPES).map(([id, label]) => <option value={id} key={id}>{displayText(label)}</option>)}</select></label>
      <label className="foundation-field"><span>申请人</span><input value={details.applicant || ""} onChange={(event) => update("applicant", event.target.value)} /></label>
      <label className="foundation-field"><span>{terminology.supplier}／收退款对象</span><input value={details.supplier || ""} onChange={(event) => update("supplier", event.target.value)} placeholder="报销可留空，使用申请人匹配" /></label>
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

export function DocumentIntakePanel({ defaultCategory = "其他资料", compact = false, payrollOnly = false, onToast, onNavigate, activeSection, onSectionChange, focusRequest }) {
  const { state, activeWorkspace, actions, store, fileVault } = useFinanceDesk();
  const terminology = workspaceTerminology(activeWorkspace);
  const displayText = (value) => applyWorkspaceTerminology(value, activeWorkspace);
  const payrollEnabled = workspaceModuleEnabled(activeWorkspace, "payroll");
  const actor = activeWorkspace.users?.find((user) => (
    user.id === state.activeUserId
    && user.status === "active"
    && String(user.name || "").trim()
  ))?.name?.trim() || (activeWorkspace.localUsersConfigured || activeWorkspace.users?.length ? "未选择操作身份" : "本地用户");
  const inputRef = useRef(null);
  const voucherExportRef = useRef(null);
  const [localSection, setLocalSection] = useState("files");
  const selectedSection = payrollOnly ? "payroll" : (activeSection ?? localSection);
  const [uploadOpen, setUploadOpen] = useState(false);
  function selectSection(nextSection) {
    setLocalSection(nextSection);
    onSectionChange?.(nextSection);
  }
  const payrollFileInputRef = useRef(null);
  const payrollImportJobRef = useRef(null);
  const documentActionCancelRef = useRef(null);
  const documentActionTriggerRef = useRef(null);
  const [category, setCategory] = useState(() => payrollEnabled || !isPayrollDocumentCategory(defaultCategory) ? defaultCategory : "其他资料");
  const [period, setPeriod] = useState(activeWorkspace.currentPeriod || "");
  const [relatedObjectId, setRelatedObjectId] = useState("");
  const [query, setQuery] = useState("");
  const [periodFilter, setPeriodFilter] = useState(activeWorkspace.currentPeriod || "all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const hasFilters = Boolean(query.trim() || periodFilter !== (activeWorkspace.currentPeriod || "all") || categoryFilter !== "all" || statusFilter !== "all");
  const [editing, setEditing] = useState(null);
  const [editReturnTarget, setEditReturnTarget] = useState(null);
  const [preview, setPreview] = useState(null);
  const [detailDocumentId, setDetailDocumentId] = useState(null);
  const [recognitionView, setRecognitionView] = useState(null);
  const [recognitionNotice, setRecognitionNotice] = useState("");
  const [recognitionPage, setRecognitionPage] = useState(0);
  const recognitionRunner = useMemo(() => getDocumentRecognitionTask(store), [store]);
  const recognitionTask = useSyncExternalStore(recognitionRunner.subscribe, recognitionRunner.getSnapshot, recognitionRunner.getSnapshot);
  const selectedRecognitionTask = recognitionTask?.workspaceId === activeWorkspace.id && recognitionTask.documentId === detailDocumentId ? recognitionTask : null;
  const recognitionProgress = selectedRecognitionTask?.progress || null;
  const recognitionPending = isRecognitionTaskPending(recognitionTask);
  const detailDocument = activeWorkspace.documents.find((document) => document.id === detailDocumentId);
  const standaloneFile = typeof window !== "undefined" && window.location.protocol === "file:";
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
  const [payrollAccrualBusy, setPayrollAccrualBusy] = useState(false);
  const [payrollAccrualReason, setPayrollAccrualReason] = useState("");
  const [payrollVouchersOpen, setPayrollVouchersOpen] = useState(false);
  const [payrollVouchersVisited, setPayrollVouchersVisited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uploadFeedback, setUploadFeedback] = useState(null);
  const [matchFeedback, setMatchFeedback] = useState(null);
  const handledFocusRequest = useRef(null);
  usePeriodLeaveGuard({ dirty: Boolean(editing || payrollFilePreview || payrollAccrualReason), busy: busy || recognitionPending || payrollImportBusy || payrollAccrualBusy || generatingPackage || generatingMonthlyArchive });
  const relatedGroups = useMemo(() => {
    const currentTerminology = workspaceTerminology(activeWorkspace);
    return RELATED_GROUPS.map(([label, collection]) => ({
      label: collection === "personnelRecords"
        ? currentTerminology.personnel
        : applyWorkspaceTerminology(label, activeWorkspace),
      collection,
      items: activeWorkspace[collection] || [],
    })).filter((group) => group.items.length);
  }, [activeWorkspace]);
  const relatedLabels = useMemo(() => new Map(relatedGroups.flatMap((group) => group.items.map((item) => [
    item.id,
    `${group.label} · ${relatedLabel(item)}`,
  ]))), [relatedGroups]);
  const selectableCategories = useMemo(() => CATEGORIES.filter((item) => payrollEnabled || !isPayrollDocumentCategory(item)), [payrollEnabled]);
  const categories = useMemo(() => [...new Set([...CATEGORIES, ...activeWorkspace.documents.map((document) => document.category).filter(Boolean)])]
    .filter((item) => payrollEnabled || !isPayrollDocumentCategory(item)), [activeWorkspace.documents, payrollEnabled]);
  const documentPeriods = useMemo(() => [...new Set([activeWorkspace.currentPeriod, ...activeWorkspace.documents.map((document) => document.period).filter(Boolean)])].sort().reverse(), [activeWorkspace.currentPeriod, activeWorkspace.documents]);
  const filteredDocuments = useMemo(() => filterLocalDocuments(activeWorkspace, {
    query,
    period: periodFilter,
    category: categoryFilter,
    status: statusFilter,
  }), [activeWorkspace, query, periodFilter, categoryFilter, statusFilter]);
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
  const payrollSocialSummary = useMemo(() => payrollEnabled ? buildPayrollSocialSummary(activeWorkspace, { period: activeWorkspace.currentPeriod }) : null, [activeWorkspace, payrollEnabled]);
  const payrollAccounting = useMemo(() => payrollEnabled ? buildPayrollAccountingSummary(activeWorkspace, { period: activeWorkspace.currentPeriod }) : null, [activeWorkspace, payrollEnabled]);
  const payrollVoucherIds = [...new Set([...(payrollAccounting?.voucherIds || []), payrollAccounting?.draftVoucherId, payrollAccounting?.postedVoucherId, ...(payrollAccounting?.issues || []).flatMap((item) => item.voucherIds || [])].filter(Boolean))];
  const payrollSocialConfirmation = useMemo(() => payrollEnabled ? getPayrollSocialConfirmationState(activeWorkspace) : null, [activeWorkspace, payrollEnabled]);
  const payrollImportPlan = useMemo(() => payrollEnabled && payrollFilePreview ? preparePayrollSocialImport(activeWorkspace, {
    table: payrollFilePreview.table,
    inspection: payrollFilePreview.inspection,
    mapping: payrollFieldMapping,
    sourceKind: payrollImportKind,
    defaultPeriod: payrollImportPeriod,
    fileName: payrollFilePreview.fileName,
    importedAt: payrollFilePreview.importedAt,
    id: payrollFilePreview.id,
  }) : null, [activeWorkspace, payrollEnabled, payrollFilePreview, payrollFieldMapping, payrollImportKind, payrollImportPeriod]);
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
  const latestMonthlyArchiveExport = monthlyArchiveExports.at(-1);
  const monthlyArchiveIssues = [
    ...(monthlyArchivePlan?.missingItems || []),
    ...(latestMonthlyArchiveExport?.missingItems || []).filter((item) => item.key?.startsWith("runtime:")
      && !monthlyArchivePlan?.missingItems.some((current) => current.documentId && current.documentId === item.documentId))
      .map((item) => ({ ...item, previousExport: true })),
  ].filter((item, index, all) => {
    if (item.key === "check:voucherAttachments") return !all.some((other) => other.key?.startsWith("voucher:") || (other.kind === "original_file" && other.sectionKey !== "receipt"));
    if (item.key === "check:exceptions") return !all.some((other) => ["unresolved_exception", "unresolved_notice"].includes(other.kind));
    return all.findIndex((other) => other.key === item.key) === index;
  });
  const hasPendingInput = Boolean(editing || payrollFilePreview || vatReconciliation.items.some((item) => {
    const draft = vatReconciliationDrafts[item.kind];
    return draft && (draft.reason !== (item.activeRecord?.reason || item.storedRecord?.reason || "")
      || String(draft.adjustmentAmount) !== String(item.activeRecord?.adjustmentAmount ?? item.storedRecord?.adjustmentAmount ?? ""));
  }));
  const visibleDocuments = editing && !filteredDocuments.some((document) => document.id === editing.id)
    ? [...(activeWorkspace.documents || []).filter((document) => document.id === editing.id), ...filteredDocuments]
    : filteredDocuments;

  function cancelRecognition() {
    setRecognitionNotice("");
    void recognitionRunner.cancel({ workspaceId: activeWorkspace.id, documentId: detailDocumentId });
  }

  useEffect(() => {
    void recognitionRunner.resume();
  }, [recognitionRunner, activeWorkspace.id]);

  useEffect(() => {
    setRecognitionView(null);
    setRecognitionNotice("");
    setRecognitionPage(0);
    if (selectedSection !== "files" || !detailDocument?.contentRecognition?.resultId) return;
    let cancelled = false;
    getLocalDocumentRecognition({ fileVault, workspaceId: activeWorkspace.id, document: detailDocument }).then((saved) => {
      if (cancelled) return;
      setRecognitionView(saved);
      if (!saved) setRecognitionNotice("本机缺少这份资料的识别正文，可重新识别。已保存的字段与人工确认仍保留。");
    }).catch((caught) => { if (!cancelled) setRecognitionNotice(caught.message || "本机识别正文暂不可用，可重新识别。"); });
    return () => { cancelled = true; };
  }, [activeWorkspace.id, activeWorkspace.currentPeriod, selectedSection, detailDocumentId, detailDocument?.hash, detailDocument?.contentRecognition?.resultId, fileVault]);

  useEffect(() => {
    if (detailDocumentId && !visibleDocuments.some((document) => document.id === detailDocumentId)) {
      setDetailDocumentId(null);
    }
  }, [detailDocumentId, visibleDocuments]);

  function recognizeDocument(document) {
    if (standaloneFile) { setRecognitionNotice("请从本地网页打开 FinanceDesk 后使用文字识别。"); return; }
    setRecognitionNotice("");
    try {
      // The task owns async work; panel navigation only changes its subscription/view.
      void recognitionRunner.start({ workspaceId: activeWorkspace.id, document, fileVault });
    } catch (caught) {
      setRecognitionNotice(caught.message || "本地识别暂不可用。");
    }
  }

  function fillRecognitionCandidate(document, key, candidate) {
    if (candidate.truncated) return;
    if (editing && editing.id !== document.id) { setError("请先保存或取消当前资料的编辑。"); return; }
    const draft = editing || documentEditDraft(document, activeWorkspace);
    if (draft.category !== document.category || document.contentRecognition?.sourceHash !== document.hash) return;
    const existing = draft.structuredData?.[key];
    if (existing !== null && existing !== undefined && existing !== "") return;
    setEditing({ ...draft, structuredData: { ...draft.structuredData, [key]: candidate.value },
      recognitionConfirmation: { resultId: document.contentRecognition.resultId, fields: [...new Set([...(draft.recognitionConfirmation?.fields || []), key])] } });
  }

  useEffect(() => {
    setCategory(payrollEnabled || !isPayrollDocumentCategory(defaultCategory) ? defaultCategory : "其他资料");
    setPeriod(activeWorkspace.currentPeriod || "");
    setRelatedObjectId("");
    setQuery("");
    setPeriodFilter(activeWorkspace.currentPeriod || "all");
    setCategoryFilter("all");
    setStatusFilter("all");
    setEditing(null);
    setEditReturnTarget(null);
    setPreview(null);
    setDetailDocumentId(null);
    setPendingDocumentAction(null);
    documentActionTriggerRef.current = null;
    setSelectedVoucherId(activeWorkspace.vouchers?.[0]?.id || "");
    setSelectedArchivePeriod(activeWorkspace.currentPeriod || "");
    setPayrollImportPeriod(activeWorkspace.currentPeriod || "");
    payrollImportJobRef.current = null;
    setPayrollAccrualBusy(false);
    setPayrollAccrualReason("");
    setPayrollVouchersOpen(false);
    setPayrollVouchersVisited(false);
    setPayrollFilePreview(null);
    setPayrollFieldMapping({});
    setPayrollImportBusy(false);
    setError("");
    setUploadFeedback(null);
    setMatchFeedback(null);
    setUploadOpen(false);
  }, [activeWorkspace.id, activeWorkspace.currentPeriod, defaultCategory]);

  useEffect(() => {
    if (!focusRequest?.nonce || handledFocusRequest.current === focusRequest.nonce) return;
    handledFocusRequest.current = focusRequest.nonce;
    const targetSection = focusRequest.section || "files";
    selectSection(targetSection);
    if (!focusRequest.documentId) return;
    const document = activeWorkspace.documents.find((item) => item.id === focusRequest.documentId);
    if (!document) {
      setError("没有找到要处理的资料，可能已被删除或属于其他工作台。");
      return;
    }
    setQuery(document.name || "");
    setPeriodFilter("all");
    setCategoryFilter("all");
    setStatusFilter("all");
    if (focusRequest.action === "edit") beginEdit(document, focusRequest.returnTo || null);
    else {
      selectSection("files");
      setDetailDocumentId(document.id);
    }
  }, [focusRequest, activeWorkspace.id]);

  useEffect(() => {
    if (!payrollEnabled && selectedSection === "payroll") selectSection("files");
    if (!payrollEnabled && isPayrollDocumentCategory(category)) setCategory("其他资料");
  }, [payrollEnabled, selectedSection, category]);

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
    if (!payrollEnabled && isPayrollDocumentCategory(category)) {
      setError("当前工作台未启用工资与社保模块，不能新增对应类别资料");
      return;
    }
    setBusy(true);
    setError("");
    setUploadFeedback(null);
    try {
      const savedDocuments = [];
      for (const file of files) {
        const document = await saveLocalDocument({
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
        savedDocuments.push(document);
      }
      const message = `已将 ${files.length} 份原文件保存到当前浏览器`;
      const firstStructuredDocument = ["contract", "invoice"].includes(documentStructuredKind(category))
        ? savedDocuments[0]
        : null;
      setQuery("");
      setPeriodFilter(period || "all");
      setCategoryFilter("all");
      setStatusFilter("all");
      setUploadFeedback({
        tone: "success",
        message,
        documentId: firstStructuredDocument?.id || null,
        documentCount: savedDocuments.length,
      });
      onToast?.(message);
    } catch (caught) {
      setUploadFeedback({ tone: "error", message: caught.message || "资料保存失败" });
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
    setDetailDocumentId(document.id);
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
    setEditReturnTarget(null);
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

  function beginEdit(document, returnTarget = null) {
    selectSection("files");
    if (editing) {
      if (editing.id !== document.id) setError("请先保存或取消当前资料的编辑，再打开另一份资料。");
      return;
    }
    clearPendingDocumentAction();
    setError("");
    setQuery(document.name || "");
    setPeriodFilter("all");
    setCategoryFilter("all");
    setStatusFilter("all");
    setDetailDocumentId(document.id);
    setEditReturnTarget(returnTarget);
    setEditing(documentEditDraft(document, activeWorkspace));
  }

  function changeEditCategory(nextCategory) {
    if (!payrollEnabled && isPayrollDocumentCategory(nextCategory)) return;
    setEditing((current) => {
      const currentKind = documentStructuredKind(current.category);
      const nextKind = documentStructuredKind(nextCategory);
      return {
        ...current,
        category: nextCategory,
        recognitionConfirmation: null,
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
      const returnTarget = editReturnTarget;
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
          recognitionConfirmation: editing.recognitionConfirmation,
          recognitionReview: editing.recognitionReview?.note?.trim() ? editing.recognitionReview : undefined,
        },
      });
      closeEditing();
      onToast?.("资料详情、分类与业务关联已更新");
      if (returnTarget) window.requestAnimationFrame(() => {
        if (returnTarget.page && onNavigate) onNavigate(returnTarget.page, returnTarget);
        else if (returnTarget.section) {
          selectSection(returnTarget.section);
          if (returnTarget.documentId) window.requestAnimationFrame(() => {
            const target = document.getElementById(`document-business-${returnTarget.documentId}`);
            target?.focus({ preventScroll: true });
            target?.scrollIntoView({ behavior: "smooth", block: "center" });
          });
        }
      });
    } catch (caught) {
      setError(caught.message || "资料修改失败");
    }
  }

  function refreshMissingTasks() {
    setError("");
    setMatchFeedback(null);
    try {
      const result = refreshDocumentMissingTasks({ store, workspaceId: activeWorkspace.id });
      const message = result.changed
        ? `缺件待办已刷新：当前待补 ${result.open} 项`
        : `缺件待办已是最新状态：当前待补 ${result.open} 项`;
      setMatchFeedback({ tone: "success", message });
      onToast?.(message);
    } catch (caught) {
      setMatchFeedback({ tone: "error", message: caught.message || "资料缺件待办刷新失败" });
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
      onToast?.(`${displayText(item.label)}已保存；冻结版本与原确认如有，将按新底稿失效`);
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
    if (!file || !payrollEnabled || payrollImportBusy) return;
    const job = { workspaceId: activeWorkspace.id, period: activeWorkspace.currentPeriod };
    payrollImportJobRef.current = job;
    setError("");
    setPayrollImportBusy(true);
    try {
      const result = await readPayrollSocialFile(file);
      if (payrollImportJobRef.current !== job || store.getActiveWorkspace()?.id !== job.workspaceId || store.getActiveWorkspace()?.currentPeriod !== job.period) return;
      const preview = {
        ...result,
        file,
        workspaceId: job.workspaceId,
        period: job.period,
        id: `payroll-import-${Date.now()}`,
        importedAt: new Date().toISOString(),
      };
      setPayrollFilePreview(preview);
      setPayrollFieldMapping(result.inspection.mapping);
      onToast?.(`${result.fileName} 已在当前浏览器读取，请核对字段映射后写入`);
    } catch (caught) {
      if (payrollImportJobRef.current !== job) return;
      setPayrollFilePreview(null);
      setPayrollFieldMapping({});
      setError(caught.message || "工资社保文件读取失败");
    } finally {
      if (payrollImportJobRef.current === job) { payrollImportJobRef.current = null; setPayrollImportBusy(false); }
    }
  }

  function updatePayrollFieldMapping(field, value) {
    if (!payrollEnabled) return;
    setPayrollFieldMapping((current) => ({ ...current, [field]: value === "" ? null : Number(value) }));
  }

  async function commitPayrollSocialImport() {
    if (!payrollEnabled || !payrollImportPlan || payrollImportBusy) return;
    const preview = payrollFilePreview;
    const job = { workspaceId: activeWorkspace.id, period: activeWorkspace.currentPeriod, userId: store.getState().activeUserId };
    const isCurrent = () => payrollImportJobRef.current === job && store.getActiveWorkspace()?.id === job.workspaceId && store.getActiveWorkspace()?.currentPeriod === job.period && store.getState().activeUserId === job.userId;
    payrollImportJobRef.current = job;
    setPayrollImportBusy(true);
    setError("");
    try {
      const current = store.getActiveWorkspace();
      if (!preview.file || preview.workspaceId !== current.id || preview.period !== current.currentPeriod) throw new Error("所属工作台或账期已变化，请重新选择工资社保原文件");
      assertWorkspacePermission(store.getState(), current.id, "data.write");
      const input = {
        table: preview.table,
        inspection: preview.inspection,
        mapping: payrollFieldMapping,
        sourceKind: payrollImportKind,
        defaultPeriod: payrollImportPeriod,
        fileName: preview.fileName,
        importedAt: preview.importedAt,
        id: preview.id,
      };
      const previewPlan = preparePayrollSocialImport(current, input);
      if (!previewPlan.canApply) throw new Error([...previewPlan.mappingErrors, ...previewPlan.errors.map((item) => `第 ${item.rowNumber} 行：${item.message}`)].join("；") || "工资社保数据尚未通过导入校验");
      const document = await saveLocalDocument({ store, fileVault, workspaceId: current.id, file: preview.file, metadata: { category: "其他资料", period: payrollImportPeriod, actor }, isCurrent });
      if (!isCurrent()) return;
      const latest = store.getActiveWorkspace();
      const currentPlan = preparePayrollSocialImport(latest, { ...input, sourceDocumentId: document.id, sourceDocumentHash: document.hash, sourceDocumentVersion: document.version });
      const next = applyPayrollSocialImport(latest, currentPlan, { actor });
      actions.replaceWorkspace(latest.id, next, { requiredPermission: "data.write" });
      setPayrollFilePreview(null);
      setPayrollFieldMapping({});
      onToast?.(`${displayText(PAYROLL_SOCIAL_IMPORT_KINDS[currentPlan.sourceKind])}已写入 ${currentPlan.rows.length} 人次；旧冻结与确认已撤销`);
    } catch (caught) {
      if (payrollImportJobRef.current === job && store.getActiveWorkspace()?.id === job.workspaceId && store.getActiveWorkspace()?.currentPeriod === job.period) setError(caught.message || "工资社保数据写入失败");
    } finally {
      if (payrollImportJobRef.current === job) { payrollImportJobRef.current = null; setPayrollImportBusy(false); }
    }
  }

  async function generatePayrollAccrual() {
    if (payrollAccrualBusy || payrollImportBusy || payrollFilePreview) return;
    const current = store.getActiveWorkspace();
    const activeUserId = store.getState().activeUserId;
    setPayrollAccrualBusy(true);
    setError("");
    try {
      assertWorkspacePermission(store.getState(), current.id, "data.write");
      const next = await createPayrollAccrualDraft(current, { reason: payrollAccrualReason.trim() }, { actor, fileVault });
      if (store.getActiveWorkspace() !== current || store.getState().activeUserId !== activeUserId) throw new Error("生成期间工作台数据或操作身份已变化，请重新生成计提草稿");
      actions.replaceWorkspace(current.id, next, { requiredPermission: "data.write" });
      setPayrollAccrualReason("");
      setPayrollVouchersVisited(true);
      setPayrollVouchersOpen(true);
      onToast?.("工资计提草稿已生成，请核对依据并填写复核意见后入账");
    } catch (caught) {
      if (store.getActiveWorkspace()?.id === current.id && store.getActiveWorkspace()?.currentPeriod === current.currentPeriod) setError(caught.message || "工资计提草稿生成失败");
    } finally {
      if (store.getActiveWorkspace()?.id === current.id && store.getActiveWorkspace()?.currentPeriod === current.currentPeriod) setPayrollAccrualBusy(false);
    }
  }

  function togglePayrollSocialConfirmation(section, confirmed) {
    if (!payrollEnabled) return;
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const next = confirmPayrollSocialData(current, { section, confirmed }, { actor: `${terminology.customer}负责人` });
      actions.replaceWorkspace(current.id, next, { requiredPermission: "data.write" });
      onToast?.(`${section === "payroll" ? "工资表" : "社保表"}${confirmed ? `已由${terminology.customer}确认` : "确认已撤销"}`);
    } catch (caught) {
      setError(caught.message || "工资社保确认失败");
    }
  }

  function confirmSuggestion(suggestion) {
    setError("");
    setMatchFeedback(null);
    setConfirmingSuggestionId(suggestion.id);
    try {
      const result = confirmDocumentMatch({
        store,
        workspaceId: activeWorkspace.id,
        suggestionId: suggestion.id,
      });
      const message = `已确认资料关联，并自动关闭 ${result.closedTaskCount} 项缺件待办`;
      setMatchFeedback({ tone: "success", message });
      onToast?.(message);
    } catch (caught) {
      setMatchFeedback({ tone: "error", message: caught.message || "资料匹配确认失败" });
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
        ? `已在本地下载完整财务档案：${result.fileName}；原文件 ${result.manifest.originalFileCount} 份已装入并核验`
        : `已在本地导出不完整草稿包：${result.fileName}；清单列出 ${result.manifest.missingItems.length} 项缺失`);
    } catch (caught) {
      setError(caught.message || "月度财务档案包生成失败");
    } finally {
      setGeneratingMonthlyArchive(false);
    }
  }

  function archiveResolution(item) {
    if (item.sectionKey === "receipt") return { label: "前往导入回执", page: "archive" };
    if (item.documentId || item.kind === "original_file") return { label: "查看原件", section: "files", documentId: item.documentId };
    const attachment = monthlyArchivePlan?.voucherAttachments.find((entry) => item.voucherId === entry.voucherId || item.key?.startsWith(`voucher:${entry.voucherId}:`));
    if (attachment) return { label: "查看凭证附件", section: "exports", voucherId: attachment.voucherId };
    if (item.sectionKey === "voucherAttachments") return { label: "查看缺件与匹配", section: "missing" };
    if (item.sectionKey === "payroll") return payrollEnabled ? { label: "补齐工资社保", section: "payroll" } : { instruction: "需启用工资社保模块后补齐该期间资料。" };
    if (item.sectionKey === "reports") return { label: "前往报表中心", page: "reports" };
    if (["taxWorkpaper", "filingPackage", "initialConfirmation", "finalConfirmation"].includes(item.sectionKey)) return { label: "前往确认与申报", page: "tax" };
    if (["vouchers", "exceptions"].includes(item.sectionKey)) return { label: "前往核销与凭证", page: "reconcile" };
    return { instruction: item.sectionKey === "moduleSnapshot" ? "需要该期间原有的模块快照，当前设置不能替代。" : "保留此项待核实，不生成替代记录。" };
  }

  function resolveArchiveItem(item) {
    const resolution = archiveResolution(item);
    if (resolution.section) {
      selectSection(resolution.section);
      if (resolution.voucherId) {
        setSelectedVoucherId(resolution.voucherId);
        if (voucherExportRef.current) voucherExportRef.current.open = true;
        window.requestAnimationFrame(() => voucherExportRef.current?.scrollIntoView({ block: "nearest" }));
      }
      if (resolution.section === "files") {
        const document = activeWorkspace.documents.find((record) => record.id === resolution.documentId);
        setQuery(document?.name || "");
        setCategoryFilter("all");
        setStatusFilter(document ? "all" : "missing");
      }
      return;
    }
    if (hasPendingInput) {
      setError("还有未保存的资料输入。请先保存或取消编辑、处理导入预览，再前往其他页面。");
      return;
    }
    onNavigate?.(resolution.page);
  }

  function archiveIssueLabel(item) {
    const document = activeWorkspace.documents.find((record) => record.id === item.documentId);
    const voucher = monthlyArchivePlan?.vouchers.find((record) => item.voucherId === record.id || item.key?.startsWith(`voucher:${record.id}:`));
    let label = document?.name || item.label || "待补资料";
    if (item.documentId && !document) label = label.replaceAll(item.documentId, "原始资料");
    if (voucher && !voucher.no) label = label.replaceAll(voucher.id, "相关凭证");
    return displayText(label);
  }

  return (
    <section className={`foundation-section document-intake-panel ${compact ? "compact" : "intake-wide"} ${payrollOnly ? "payroll-embedded" : ""}`} data-unsaved-changes={hasPendingInput || undefined}>
      {!payrollOnly && <><div className="foundation-section-heading"><div><h3><FileText size={18} />本地资料库</h3></div><button className="primary-button" type="button" aria-expanded={uploadOpen && selectedSection === "files"} disabled={!fileVault || busy} onClick={() => { selectSection("files"); setUploadOpen((open) => selectedSection === "files" ? !open : true); }}><FileArrowUp size={17} />上传原文件</button></div>
      <nav className="document-section-nav" aria-label="资料库分组">{[
        { id: "files", label: "文件", count: activeWorkspace.documents.length },
        { id: "business", label: "合同与发票" },
        ...(payrollEnabled ? [{ id: "payroll", label: "工资社保" }] : []),
        { id: "missing", label: "缺件与匹配", count: openDocumentTasks.length || null },
        { id: "exports", label: "导出归档" },
      ].map((item) => <button key={item.id} type="button" className={selectedSection === item.id ? "active" : ""} aria-pressed={selectedSection === item.id} onClick={() => selectSection(item.id)}>{item.label}{item.count != null && <span>{item.count}</span>}</button>)}</nav></>}
      {editing && selectedSection !== "files" && <div className="document-draft-reminder"><span>“{editing.name}”的编辑内容已保留。</span><button className="secondary-button" type="button" onClick={() => selectSection("files")}>继续编辑</button></div>}
      {!payrollEnabled && payrollFilePreview && <div className="document-draft-reminder"><span>工资社保模块已停用，未导入的文件预览已保留。</span><button className="secondary-button" type="button" onClick={() => { setPayrollFilePreview(null); setPayrollFieldMapping({}); }}>取消此次导入</button></div>}
      {error && <div className="foundation-error" role="alert"><WarningCircle size={18} /><span>{displayText(error)}</span></div>}
      {!fileVault && <div className="foundation-error"><WarningCircle size={18} />当前环境不支持浏览器本地文件保险箱，只能查看已有资料元数据。</div>}
      <div className="document-intake-upload-zone" hidden={selectedSection !== "files" || !uploadOpen}>
        <div className="document-intake-controls document-upload-controls">
          <label className="foundation-field"><span>资料类别</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{selectableCategories.map((item) => <option value={item} key={item}>{categoryDisplayLabel(item, activeWorkspace)}</option>)}</select></label>
          <label className="foundation-field"><span>业务期间</span><input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} /></label>
          <label className="foundation-field"><span>关联业务（可选）</span><select value={relatedObjectId} onChange={(event) => setRelatedObjectId(event.target.value)}><option value="">暂不关联</option>{relatedGroups.map((group) => <optgroup label={group.label} key={group.collection}>{group.items.map((item) => <option value={item.id} key={item.id}>{relatedLabel(item)}</option>)}</optgroup>)}</select></label>
          <button className="secondary-button" type="button" disabled={!fileVault || busy} onClick={() => inputRef.current?.click()}><FileArrowUp size={17} />{busy ? "正在保存…" : "选择文件并上传"}</button>
          <input ref={inputRef} type="file" multiple hidden onChange={addFiles} />
        </div>
        <p className="foundation-hint">选择类别和期间后上传文件。原文件保存在当前浏览器；换设备前请导出含原件的资料包。</p>
        {uploadFeedback && <div className={`${uploadFeedback.tone === "error" ? "foundation-error" : "foundation-notice"} import-feedback document-upload-feedback`} role={uploadFeedback.tone === "error" ? "alert" : "status"} aria-live="polite">{uploadFeedback.tone === "error" ? <WarningCircle size={18} /> : <CheckCircle size={18} weight="fill" />}<span>{displayText(uploadFeedback.message)}</span>{uploadFeedback.documentId && <button className="secondary-button" type="button" onClick={() => {
          const document = activeWorkspace.documents.find((item) => item.id === uploadFeedback.documentId);
          if (!document) { setError("没有找到刚上传的资料，请在文件列表中重新选择。"); return; }
          beginEdit(document, { section: "business", documentId: document.id });
        }}>{uploadFeedback.documentCount > 1 ? "先补齐第一份资料字段" : "补齐本次资料字段"}</button>}</div>}
        <p className="foundation-hint">字段可人工录入；PDF 与图片可在资料详情中本地识别。</p>
      </div>
      <div className="document-intake-controls document-filter-controls" hidden={selectedSection !== "files"}>
        <div className="document-filter-search">
          <label className="foundation-field"><span>搜索资料</span><span className="search-field"><MagnifyingGlass size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="文件名、类别或关联业务" /></span></label>
          {hasFilters && <button className="document-filter-clear" type="button" onClick={() => { setQuery(""); setPeriodFilter(activeWorkspace.currentPeriod || "all"); setCategoryFilter("all"); setStatusFilter("all"); }}>清空筛选</button>}
        </div>
        <label className="foundation-field"><span>期间</span><select value={periodFilter} onChange={(event) => setPeriodFilter(event.target.value)}><option value="all">全部期间</option>{documentPeriods.map((item) => <option value={item} key={item}>{item}{item === activeWorkspace.currentPeriod ? "（当前）" : ""}</option>)}</select></label>
        <label className="foundation-field"><span>类别</span><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">全部类别</option>{categories.map((item) => <option value={item} key={item}>{categoryDisplayLabel(item, activeWorkspace)}</option>)}</select></label>
        <label className="foundation-field"><span>状态</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">全部状态</option><option value="active">未归档</option><option value="archived">已归档</option><option value="linked">已关联</option><option value="unlinked">未使用，可删除</option><option value="available">原文件可用</option><option value="missing">原文件缺失</option></select></label>
      </div>
      {preview && (
        <div className="bank-import-workspace document-preview-panel" hidden={selectedSection !== "files"}>
          <div className="foundation-section-heading"><div><h3>{preview.document.name}</h3></div><button className="foundation-icon-button" type="button" aria-label="关闭预览" onClick={closePreview}><X size={17} /></button></div>
          {preview.kind === "image" && <img className="document-preview-image" src={preview.url} alt={preview.document.name} />}
          {preview.kind === "pdf" && <iframe className="document-preview-frame" src={preview.url} title={`预览 ${preview.document.name}`} />}
          {preview.kind === "text" && <div className="bank-preview-scroll document-preview-text"><pre className="document-preview-pre">{preview.text}</pre>{preview.truncated && <p className="foundation-hint">内容较长，页面仅显示前 300,000 个字符；下载可查看完整原文件。</p>}</div>}
          {preview.kind === "audio" && <audio className="document-preview-audio" src={preview.url} controls />}
          {preview.kind === "video" && <video className="document-preview-video" src={preview.url} controls />}
          {preview.kind === "unsupported" && <div className="foundation-notice"><WarningCircle size={18} />该格式无法由浏览器直接预览，原文件仍可完整下载。</div>}
          <div className="foundation-inline-actions document-preview-actions"><button className="secondary-button" type="button" onClick={() => download(preview.document)}><DownloadSimple size={16} />下载原文件</button><button className="secondary-button" type="button" onClick={closePreview}>关闭预览</button></div>
        </div>
      )}
      <div className={`document-record-grid${editing ? " is-editing" : ""}`} hidden={selectedSection !== "files"}>
        {visibleDocuments.map((document) => {
          const locallyAvailable = document.storage?.mode === "indexeddb" && document.storage?.availableLocally;
          const canReadOriginal = Boolean(locallyAvailable && fileVault);
          const canPreview = canReadOriginal && previewKind(document.mimeType, document.name) !== "unsupported";
          const usage = getLocalDocumentUsage(activeWorkspace, document.id);
          const archived = usage.some((item) => item.kind === "archive");
          const isEditing = editing?.id === document.id;
          const pendingAction = pendingDocumentAction?.documentId === document.id ? pendingDocumentAction.action : null;
          const confirmationId = `document-action-${document.id}`;
          const recognition = document.contentRecognition;
          const recognitionCurrent = recognition?.sourceHash === document.hash && recognition?.category === document.category;
          const recognitionBusy = detailDocumentId === document.id && Boolean(recognitionProgress);
          const recognisable = document.mimeType === "application/pdf" || /^image\/(png|jpeg|webp|bmp|tiff|gif)$/.test(document.mimeType || "") || /\.(pdf|png|jpe?g|webp|bmp|tiff?|gif)$/i.test(document.name || "");
          const fullRecognition = detailDocumentId === document.id && recognitionView?.id === recognition?.resultId && recognitionView?.sourceHash === document.hash ? recognitionView.result : null;
          const candidates = recognitionCurrent ? Object.entries(fullRecognition?.suggestedFields || recognition.suggestedFields || {}).filter(([key]) => RECOGNITION_FIELD_LABELS[key]) : [];
          const documentReviews = (activeWorkspace.exceptionTasks || []).filter((task) => task.code === "document_recognition_review" && task.sourceId === document.id && task.sourceHash === document.hash);
          const hasPendingReview = documentReviews.some((task) => task.status !== "resolved");
          return (
            <article className="document-record" key={document.id}>
              <span className="document-record-icon"><FileText size={20} /></span>
              <div>
                <strong>{document.name}</strong>
                <small>{categoryDisplayLabel(document.category, activeWorkspace)} · {document.period || "未分期"} · {fileSize(document.size)}</small>
                <div className="document-state-row"><span>{archived ? "已归档" : "未归档"}</span><span className={locallyAvailable ? "original-available" : "original-missing"}>原件：{locallyAvailable ? "本机可用" : "本机缺失"}</span></div>
                <details className="document-trace-details" open={detailDocumentId === document.id}><summary onClick={(event) => {
                  event.preventDefault();
                  setDetailDocumentId((current) => current === document.id ? null : document.id);
                }}>资料详情与追溯</summary>
                  {!archived && <div className="document-secondary-actions">
                    {!isEditing && <button className="secondary-button" type="button" onClick={() => beginEdit(document)}><PencilSimple size={15} />编辑资料</button>}
                    <button className="secondary-button" type="button" aria-haspopup="dialog" aria-expanded={pendingAction === "archive"} aria-controls={confirmationId} onClick={(event) => requestDocumentAction(document, "archive", event.currentTarget)}><Archive size={15} />归档</button>
                    {usage.length === 0 && <button className="secondary-button" type="button" aria-label="删除未使用资料" aria-haspopup="dialog" aria-expanded={pendingAction === "delete"} aria-controls={confirmationId} onClick={(event) => requestDocumentAction(document, "delete", event.currentTarget)}><Trash size={15} />删除</button>}
                  </div>}
                  {!locallyAvailable && <p>当前设备没有原件，暂不能预览或下载。</p>}
                  {canReadOriginal && !canPreview && <p>此格式不支持页面预览，可下载原文件查看。</p>}
                  {archived ? <p>已归档资料不能直接修改或删除。</p> : usage.length > 0 && <p>资料已被业务使用，不能删除。</p>}
                  <p>{usage.length ? `关联：${usage.map((item) => displayText(item.label)).join("、")}` : "暂无业务关联"}</p>
                  {structuredDetailLines(document, activeWorkspace).map((line) => <p key={line}>{line}</p>)}
                  {(recognisable || recognition?.resultId) && <div className="document-recognition">
                    <div className="document-recognition-actions">
                      <strong>本地文字识别</strong>
                      {recognisable && !archived && <button type="button" className="secondary-button" disabled={!canReadOriginal || recognitionPending || isEditing || standaloneFile}
                        onClick={() => recognizeDocument(document)}>{recognition?.resultId ? "重新识别" : "识别文字"}</button>}
                      {detailDocumentId === document.id && selectedRecognitionTask?.status === "ready" && <button type="button" className="secondary-button" onClick={() => { setRecognitionNotice(""); void recognitionRunner.resume({ explicit: true }); }}>保存识别结果</button>}
                      {detailDocumentId === document.id && isRecognitionTaskPending(selectedRecognitionTask) && <button type="button" className="secondary-button" disabled={selectedRecognitionTask.status === "cancelling"} onClick={cancelRecognition}>取消识别</button>}
                    </div>
                    {standaloneFile ? <p>请从本地网页打开 FinanceDesk 后使用文字识别。</p> : !recognition?.resultId && <p>首次使用需加载本地引擎。最多 30 MB、30 页；文件在本机处理，候选需人工核对。</p>}
                    {recognitionBusy && <div className="document-recognition-progress" role="status">
                      <span>{recognitionProgressLabel(recognitionProgress)}</span>
                      <progress aria-label="当前识别步骤进度" max="1" value={Math.max(0, Math.min(1, recognitionProgress.progress || 0))} />
                    </div>}
                    {detailDocumentId === document.id && (recognitionNotice || selectedRecognitionTask?.notice) && <p role="status">{recognitionNotice || selectedRecognitionTask.notice}</p>}
                    {detailDocumentId === document.id && recognitionPending && !selectedRecognitionTask && <p role="status">已有其他资料正在识别或等待保存，请返回该资料查看。</p>}
                    {recognition?.resultId && !recognitionCurrent && <p>资料类别或原件已变化，请重新识别后再使用候选。</p>}
                    {candidates.length > 0 && <>
                      <p>候选只填入空白草稿，核对后保存；已有内容可在“编辑资料”中调整。</p>
                      <ul className="document-recognition-candidates">{candidates.map(([key, candidate]) => {
                        const draftValue = (isEditing ? editing.structuredData : document.structuredData)?.[key];
                        const occupied = draftValue !== null && draftValue !== undefined && draftValue !== "";
                        const applied = isEditing && editing.recognitionConfirmation?.fields?.includes(key);
                        return <li key={key}><div><span>{RECOGNITION_FIELD_LABELS[key]}：<strong>{String(candidate.value)}</strong></span>
                          <small className="document-clause-source">第 {(candidate.sourcePages || [candidate.pageNumber || 1]).join("、")} 页 · {candidate.sourceText}{candidate.sourceTruncated ? "…" : ""}</small></div>
                          {!archived && (key === "settlementCycle" || occupied || candidate.truncated
                            ? <small>{candidate.truncated ? "读取完整原文后填写" : key === "settlementCycle" ? "请人工选择结算方式" : applied ? "已填入草稿" : "已有内容"}</small>
                            : (!editing || (isEditing && editing.category === document.category)) && <button type="button" className="secondary-button" onClick={() => fillRecognitionCandidate(document, key, candidate)}>填入草稿</button>)}
                        </li>;
                      })}</ul>
                    </>}
                    {recognition?.confirmation && <p>上次人工确认：{recognition.confirmation.actor} · {recognition.confirmation.confirmedAt?.slice(0, 10)}</p>}
                    {documentReviews.map((task) => <details className="document-recognition-review" key={task.id}>
                      <summary>{task.recognitionFinding.label} · {task.status === "resolved" ? "已复核" : "待复核"}</summary>
                      <p>{task.recognitionFinding.reason}</p>
                      {task.recognitionFinding.sources.map((source, index) => <p className="document-clause-source" key={index}>第 {(source.sourcePages || [source.pageNumber]).join("、")} 页 · {source.sourceText}</p>)}
                      {task.status === "resolved" && <p>{task.resolvedBy}：{task.history.at(-1)?.note}</p>}
                    </details>)}
                    {hasPendingReview && !isEditing && <p>请在“编辑资料”中核对条款，填写复核说明后保存。</p>}
                    {detailDocumentId === document.id && recognitionView?.sourceHash === document.hash && <>
                      {recognitionView.result.warnings?.map((warning, index) => <p key={index}>{warning}</p>)}
                      {!candidates.length && recognitionCurrent && <p>未找到可直接填写的字段，请参照正文人工录入。</p>}
                      <details className="document-recognition-text"><summary>查看识别正文（{recognitionView.result.pages.length} 页）</summary>
                        {recognitionView.result.pages.length > 1 && <label>页码 <select aria-label="识别正文页码" value={recognitionPage} onChange={(event) => setRecognitionPage(Number(event.target.value))}>{recognitionView.result.pages.map((page, index) => <option key={index} value={index}>第 {page.pageNumber} 页</option>)}</select></label>}
                        <pre>{recognitionView.result.pages[recognitionPage]?.text || "本页未识别到文字。"}</pre>
                      </details>
                    </>}
                  </div>}
                  <p>文档编号：<code>{document.id}</code></p><p>原件哈希：<code>{document.hash || "尚无可核验的原件记录"}</code></p>
                </details>
                {isEditing && (
                  <div className="bank-import-workspace document-editor-panel">
                    <div className="document-intake-controls document-edit-controls">
                      <label className="foundation-field"><span>文件名称</span><input value={editing.name} onChange={(event) => setEditing((current) => ({ ...current, name: event.target.value }))} /></label>
                      <label className="foundation-field"><span>资料类别</span><select value={editing.category} onChange={(event) => changeEditCategory(event.target.value)}>{selectableCategories.map((item) => <option value={item} key={item}>{categoryDisplayLabel(item, activeWorkspace)}</option>)}</select></label>
                      <label className="foundation-field"><span>业务期间</span><input type="month" value={editing.period} onChange={(event) => setEditing((current) => ({ ...current, period: event.target.value }))} /></label>
                      <label className="foundation-field"><span>添加关联对象</span><select value="" onChange={(event) => addEditRelation(event.target.value)}><option value="">选择后加入</option>{relatedGroups.map((group) => <optgroup label={group.label} key={group.collection}>{group.items.filter((item) => !editing.relatedObjectIds.includes(item.id)).map((item) => <option value={item.id} key={item.id}>{relatedLabel(item)}</option>)}</optgroup>)}</select></label>
                    </div>
                    <StructuredDataFields category={editing.category} value={editing.structuredData} onChange={(structuredData) => setEditing((current) => ({ ...current, structuredData }))} workspace={activeWorkspace} currentDocumentId={editing.id} />
                    {hasPendingReview && editing.category === "合同" && <label className="foundation-field"><span>条款复核说明</span><textarea rows={2} value={editing.recognitionReview?.note || ""} onChange={(event) => setEditing((current) => ({ ...current, recognitionReview: { resultId: recognition.resultId, note: event.target.value } }))} placeholder="说明采用哪种条件、金额或日期；保存后解决对应待办" /></label>}
                    <div className="permission-chip-list">{editing.relatedObjectIds.map((objectId) => <span key={objectId}>{relatedLabels.get(objectId) || objectId} <button type="button" aria-label={`解除 ${relatedLabels.get(objectId) || objectId} 关联`} onClick={() => removeEditRelation(objectId)}>×</button></span>)}</div>
                    <div className="foundation-inline-actions document-editor-actions"><button className="primary-button" type="button" onClick={saveEdit}>{editing.recognitionReview?.note?.trim() ? "保存并完成复核" : editing.recognitionConfirmation?.fields?.length ? "确认所填候选并保存" : "保存资料详情"}</button><button className="secondary-button" type="button" onClick={closeEditing}>取消</button></div>
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
              {canReadOriginal && <div className="document-primary-actions">
                {canPreview && <button className="secondary-button" type="button" aria-label="页面预览" onClick={() => showPreview(document)}><Eye size={15} />预览</button>}
                <button className="secondary-button" type="button" aria-label="下载原文件" onClick={() => download(document)}><DownloadSimple size={15} />下载</button>
              </div>}
            </article>
          );
        })}
        {!visibleDocuments.length && <div className="foundation-empty document-empty-action"><p>没有符合当前条件的资料。</p>{activeWorkspace.documents.length ? <button className="secondary-button" type="button" onClick={() => { setQuery(""); setPeriodFilter(activeWorkspace.currentPeriod || "all"); setCategoryFilter("all"); setStatusFilter("all"); }}>查看本期全部资料</button> : <button className="primary-button" type="button" disabled={!fileVault || busy} onClick={() => setUploadOpen(true)}><FileArrowUp size={16} />上传第一份资料</button>}</div>}
      </div>
      <div className="bank-import-workspace" hidden={selectedSection !== "business"}>
        <div className="foundation-section-heading">
          <div><h3>合同账单计划</h3></div>
          <span>{contractBillingPlans.length} 份合同 · 待生成 {contractBillingPlans.reduce((sum, plan) => sum + plan.items.length, 0)} 张</span>
        </div>
        <p className="foundation-hint">{workspaceModuleEnabled(activeWorkspace, "members") ? `销售、${terminology.member}和平台合同生成应收账单` : "销售和平台合同生成应收账单"}；采购和租赁合同生成应付账单。确认后生成账单并关联合同。</p>
        <div className="foundation-record-list document-contract-plan-list">
          {contractBillingPlans.map((plan) => {
            const discountSuggestion = buildContractDiscountSuggestion(plan.document);
            const completed = !plan.items.length && plan.duplicatePeriods.length > 0 && plan.existingBills.length > 0
              && plan.errors.every((message) => message.startsWith("同一合同同一期不得重复生成："));
            const displayErrors = completed ? [] : plan.errors;
            return (
            <article className="foundation-record document-return-target" id={`document-business-${plan.documentId}`} key={plan.documentId} tabIndex={-1}>
              <div style={{ width: "100%" }}>
                <strong>{plan.document?.name || plan.documentId}</strong>
                <small>{displayText(CONTRACT_TYPES[plan.contractType] || "未选择合同类型")} · {plan.billKind === "receivable" ? "应收账单" : (plan.billKind === "payable" ? "应付账单" : "尚未确定账单方向")} · 对方 {plan.counterparty || "未填写"}</small>
                {!displayErrors.length && !completed && <>
                  {plan.discountRule?.enabled && <div className="document-contract-discount-result"><span>每期折前 {amountLabel(plan.grossAmount)}</span><span>优惠 {amountLabel(plan.discountAmount)}</span><strong>最终每期 {amountLabel(plan.netAmount)}</strong></div>}
                  <p>合同金额 {amountLabel(plan.contractAmount)}{!plan.discountRule?.enabled && <> · 每期 {amountLabel(plan.periodAmount)}</>} · 计划总额 {amountLabel(plan.plannedTotalAmount)} · 本次待生成 {plan.items.length} 张／{amountLabel(plan.pendingTotalAmount)}</p>
                </>}
                {!!plan.existingBills.length && <p>已生成 {plan.existingBills.length} 张／{amountLabel(plan.generatedTotalAmount)}{completed && " · 本次无待生成"}</p>}
                {discountSuggestion.status === "needs_review" && <div className="document-contract-discount-review"><p><WarningCircle size={16} /> 折扣条款待复核：{discountSuggestion.reason}</p><details><summary>查看条款原文</summary><p>{discountSuggestion.sourceText}</p></details></div>}
                {!!displayErrors.length && <><p>补齐合同资料后可生成</p><details><summary>查看待补齐与核对事项（{displayErrors.length}）</summary><ul>{displayErrors.map((message) => <li key={message}>{displayText(message)}</li>)}</ul></details></>}
                {!!plan.existingBills.length && <details><summary>查看已生成账单（{plan.existingBills.length}）</summary>{plan.existingBills.map((bill) => <p key={bill.id}>{bill.no || bill.id} · {bill.billingPeriod || bill.date} · {bill.counterparty} · {amountLabel(bill.amount)}</p>)}</details>}
                {!!plan.items.length && !displayErrors.length && <details open>
                  <summary>本次账单预览（{plan.items.length}）</summary>
                  {plan.items.map((item) => <p key={`${plan.documentId}-${item.billingPeriod}`}>{item.billingPeriod} · {item.billKind === "receivable" ? "应收" : "应付"} · 账单日 {item.date} · 到期日 {item.dueDate} · {plan.discountRule?.enabled && <>折前 {amountLabel(item.grossAmount)} − 优惠 {amountLabel(item.discountAmount)} = </>}{amountLabel(item.amount)} · {item.counterparty}</p>)}
                </details>}
              </div>
              <div className="document-contract-plan-actions">
                {plan.document && plan.document.archiveStatus !== "archived" && <button className="secondary-button" type="button" onClick={() => beginEdit(plan.document, { section: "business", documentId: plan.documentId })}>{displayErrors.length ? "补齐合同字段" : "编辑合同"}</button>}
                {!completed && <button className="primary-button" type="button" disabled={!plan.canConfirm} onClick={() => confirmContractBillingPlan(plan)}>确认并写入账单</button>}
              </div>
            </article>
            );
          })}
          {!contractBillingPlans.length && <div className="foundation-empty document-empty-action"><p>当前还没有结构化合同资料。</p><button className="primary-button" type="button" onClick={() => { setCategory("合同"); selectSection("files"); setUploadOpen(true); }}>上传合同并补齐账单计划</button></div>}
        </div>
      </div>
      <div className="bank-import-workspace" hidden={selectedSection !== "business"}>
        <div className="foundation-section-heading">
          <div><h3>审批单与业务链</h3></div>
          <span>{approvalConnections.filter((item) => item.details.linkStatus === "linked").length} / {approvalConnections.length} 已关联</span>
        </div>
        <p className="foundation-hint">仅已批准的审批单参与匹配；请核对对象、金额和日期后确认关联。付款与入账仍需另行处理。</p>
        <div className="foundation-record-list">
          {approvalConnections.map((item) => {
            const { document, details, linkedTarget, businessEvent, pendingTask, suggestions } = item;
            const approved = details.approvalStatus === "approved";
            return (
              <article className="foundation-record" key={`approval-link-${document.id}`}>
                <div style={{ width: "100%" }}>
                  <strong>{document.name} · {displayText(APPROVAL_TYPES[details.approvalType] || "未选择类型")}</strong>
                  <small>{statusLabel(APPROVAL_STATUS_OPTIONS, details.approvalStatus, "草稿")} · {details.approvalDate || "未填写日期"} · {details.supplier || details.applicant || `未填写申请人／${terminology.supplier}`} · {amountLabel(details.amount)}</small>
                  {details.linkStatus === "linked" && linkedTarget && <p>已人工关联{details.linkedTargetType === "bill" ? "账单" : "银行流水"}：{linkedTarget.no || linkedTarget.summary || linkedTarget.id} · 业务事件 {businessEvent?.businessEventNo || businessEvent?.id || details.businessEventId} · 仍须后续人工付款／入账</p>}
                  {details.linkStatus === "invalidated" && <div className="foundation-error"><WarningCircle size={18} /><span>审批已驳回或撤回，原业务关系已失效，相关业务重新进入异常。</span></div>}
                  {pendingTask && <p>{displayText(pendingTask.message)}</p>}
                  {approved && details.linkStatus !== "linked" && suggestions.map((suggestion) => (
                    <div className="foundation-record" key={suggestion.id}>
                      <div><strong>建议关联{suggestion.targetType === "bill" ? "账单" : "银行流水"}：{suggestion.target.no || suggestion.target.summary || suggestion.target.id}</strong><small>{suggestion.target.counterparty || "未填写往来单位"} · {suggestion.target.date || "未填写日期"} · {amountLabel(Math.abs(Number(suggestion.target.amount || 0)))}</small><p>{suggestion.reasons.map(displayText).join("；")} · 匹配分 {suggestion.score}</p></div>
                      <button className="primary-button" type="button" onClick={() => confirmApprovalLink(suggestion)}>人工确认关联</button>
                    </div>
                  ))}
                  {approved && details.linkStatus !== "linked" && !suggestions.length && <p>当前没有类型、申请人／{terminology.supplier}、金额和日期同时一致的已有账单或银行流水，审批单保持待处理。</p>}
                  {!approved && <p>当前状态不能进入后续业务；改为“已批准”并保存后，才会出现匹配建议。</p>}
                </div>
              </article>
            );
          })}
          {!approvalConnections.length && <p className="foundation-empty">当前还没有结构化审批单资料。</p>}
        </div>
      </div>
      <div className="bank-import-workspace" hidden={selectedSection !== "business"}>
        <div className="foundation-section-heading">
          <div><h3>增值税发票来源</h3><p>{activeWorkspace.currentPeriod}</p></div>
          <span>{invoiceVatSummary.usesStructuredInvoices ? "发票汇总口径" : "仍用原估算口径"}</span>
        </div>
        <p className="foundation-hint">本期已分类、已关联业务或凭证的有效发票参与汇总。作废排除、红字扣减；未认证进项不抵扣。查验状态需人工录入。</p>
        <div className="foundation-section-heading" style={{ marginTop: 18 }}>
          <div><h3>发票与应收应付账单</h3></div>
          <span>{invoiceBillConnections.filter((item) => item.linkedBill).length} / {invoiceBillConnections.length} 已关联</span>
        </div>
        <p className="foundation-hint">销项按{terminology.customer}、价税合计和日期建议应收账单，进项按{terminology.supplier}、价税合计和日期建议应付账单。建议本身不写数据；人工确认后才关联，确认没有合适账单后才可新建。红字只冲减已关联的原账单。</p>
        <div className="foundation-record-list">
          {invoiceBillConnections.map((item) => {
            const { document, details, linkedBill, suggestions } = item;
            const billKindLabel = details.taxDirection === "output" ? "应收" : (details.taxDirection === "input" ? "应付" : "未确定");
            const canCreate = details.redLetterStatus === "normal"
              && details.voidStatus !== "voided"
              && ["output", "input"].includes(details.taxDirection)
              && Boolean(details.counterparty && details.invoiceDate && Number(details.amount) > 0);
            return (
              <article className="foundation-record document-return-target" id={`document-business-${document.id}`} key={`invoice-bill-${document.id}`} tabIndex={-1}>
                <div style={{ width: "100%" }}>
                  <strong>{details.invoiceNumber || document.name} · {details.taxDirection === "output" ? "销项 → 应收" : (details.taxDirection === "input" ? "进项 → 应付" : "请先选择销项／进项")}</strong>
                  <small>{details.counterparty || `未填写${terminology.customer}／${terminology.supplier}`} · {details.invoiceDate || "未填写日期"} · 价税合计 {amountLabel(details.amount)}</small>
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
                          <div><strong>建议 {billKindLabel}：{suggestion.bill.no || suggestion.bill.id}</strong><small>{suggestion.bill.counterparty} · {amountLabel(suggestion.bill.amount)} · {suggestion.bill.date || "未填写账单日期"}</small><p>{suggestion.reasons.map(displayText).join("；")} · 匹配分 {suggestion.score}</p></div>
                          <button className="primary-button" type="button" onClick={() => confirmInvoiceBill(suggestion)}>人工确认关联</button>
                        </div>
                      ))}
                      {!suggestions.length && <p>没有找到同时满足往来单位、金额和日期条件的已有{billKindLabel === "未确定" ? "" : billKindLabel}账单。</p>}
                      <button className="secondary-button" type="button" disabled={!canCreate} onClick={() => confirmInvoiceBillCreation(document.id)}>确认无合适账单并新建{billKindLabel}账单</button>
                      {!canCreate && <><p>请先补齐销项／进项、{terminology.customer}／{terminology.supplier}、价税合计和发票日期。</p>{document.archiveStatus !== "archived" && <button className="secondary-button" type="button" onClick={() => beginEdit(document, { section: "business", documentId: document.id })}>补齐发票字段</button>}</>}
                    </>
                  )}
                </div>
              </article>
            );
          })}
          {!invoiceBillConnections.length && <div className="foundation-empty document-empty-action"><p>当前还没有结构化发票资料。</p><button className="primary-button" type="button" onClick={() => { setCategory("发票"); selectSection("files"); setUploadOpen(true); }}>上传第一张发票</button></div>}
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
                <div><strong>{row.invoiceNumber || "未填写发票号码"} · {row.name}</strong><small>{statusLabel(INVOICE_TAX_DIRECTION_OPTIONS, row.taxDirection, "未分类")} · {row.invoiceDate || "未填写日期"} · 关联 {row.linkedObjectIds.length} 个对象</small><p>价税合计 {amountLabel(row.grossAmount)} · 税额 {amountLabel(row.taxAmount)} · 税率 {row.taxRate ?? "未填"}% · {row.taxAmountSource === "derived_from_gross_and_rate" ? "税额由价税合计与税率计算" : "税额为人工录入"}</p><p>{displayText(row.reason)}；查验 {statusLabel(INVOICE_STATUS_OPTIONS.verificationStatus, row.verificationStatus, "未查验")} · 红字 {statusLabel(INVOICE_STATUS_OPTIONS.redLetterStatus, row.redLetterStatus, "正常蓝字")} · 作废 {statusLabel(INVOICE_STATUS_OPTIONS.voidStatus, row.voidStatus, "有效")} · 认证 {statusLabel(INVOICE_STATUS_OPTIONS.certificationStatus, row.certificationStatus, "无需认证")}</p></div>
                <span><strong>{bucketLabel}</strong><small>来源 {row.documentId}</small></span>
              </article>
            );
          })}
          {!invoiceVatSummary.rows.length && <p className="foundation-empty">本期还没有结构化发票；税务页暂时继续使用原有本地估算口径。</p>}
        </div>
        <div className="foundation-section-heading" style={{ marginTop: 18 }}>
          <div><h3>增值税差异核对</h3></div>
          <span>{vatReconciliation.unresolvedItems.length ? `待解释 ${vatReconciliation.unresolvedItems.length} 项` : "两项已核对"}</span>
        </div>
        <p className="foundation-hint">调整仅用于税务底稿，请填写差额原因。来源变化后需要重新核对。</p>
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
                  <strong>{displayText(item.label)}</strong>
                  <small>{VAT_RECONCILIATION_STATUS_LABELS[item.status]} · 当前口径：发票数 + 本地调整 − 账面数</small>
                  <p>账面数 {amountLabel(item.bookAmount)} · 发票数 {amountLabel(item.invoiceAmount)} · 调整前差额 {amountLabel(item.differenceBeforeAdjustment)}</p>
                  <div className="document-intake-controls document-reconciliation-controls">
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
      {payrollEnabled && <div className="bank-import-workspace payroll-workspace" hidden={selectedSection !== "payroll"}>
        <div className="payroll-next-step">
          <span><strong>{payrollFilePreview ? "先确认当前导入预览" : !payrollSocialSummary.counts.payroll || !payrollSocialSummary.counts.socialSecurity ? "先补齐工资表与社保表" : payrollSocialSummary.hasDifferences ? `先处理 ${payrollSocialSummary.counts.issues} 人差异` : payrollAccounting.draftVoucherId && !payrollAccounting.postedAndMatched ? "下一步：复核计提凭证" : payrollAccounting.postedAndMatched ? "工资计提已入账，可进入报表" : "下一步：生成工资计提草稿"}</strong><small>{activeWorkspace.currentPeriod} · 导入 → 逐人核对 → 计提草稿 → 复核入账 → 报表</small></span>
          {!payrollFilePreview && (!payrollSocialSummary.counts.payroll || !payrollSocialSummary.counts.socialSecurity) && <button className="primary-button" type="button" disabled={payrollImportBusy} onClick={() => payrollFileInputRef.current?.click()}>选择待补资料</button>}
          {payrollAccounting.draftVoucherId && !payrollAccounting.postedAndMatched && <button className="primary-button" type="button" onClick={() => { setPayrollVouchersVisited(true); setPayrollVouchersOpen(true); }}>复核计提凭证</button>}
          {payrollAccounting.postedAndMatched && onNavigate && <button className="primary-button" type="button" onClick={() => onNavigate("reports")}>进入报表</button>}
        </div>
        <section className="payroll-accounting-summary" aria-label="工资计提与账面核对">
          <div className="foundation-section-heading"><div><h3>工资计提</h3>{!payrollAccounting.issues.length && <p>{payrollAccounting.message}</p>}</div><span>{payrollAccounting.postedAndMatched ? payrollAccounting.noAccrualNeeded ? "零金额 · 无需计提" : "已入账 · 核对一致" : payrollAccounting.draftVoucherId && payrollAccounting.readyToDraft ? "草稿待更新" : payrollAccounting.draftVoucherId ? "待复核入账" : "待处理"}</span></div>
          {!!payrollAccounting.issues.length && <ul className="payroll-accounting-issues">{payrollAccounting.issues.map((item, index) => <li key={`${item.code}-${index}`}>{displayText(item.message)}</li>)}</ul>}
          {payrollFilePreview && <p>当前有未提交的导入预览，请先保存或取消，再处理计提凭证。</p>}
          <div className="payroll-accounting-actions">
            {!payrollAccounting.postedAndMatched && (!payrollAccounting.draftVoucherId || payrollAccounting.readyToDraft) && <>
              {payrollAccounting.postedVoucherId && <label className="foundation-field"><span>计提更正原因</span><input value={payrollAccrualReason} disabled={payrollAccrualBusy} onChange={(event) => setPayrollAccrualReason(event.target.value)} placeholder="说明工资或社保数据变化的原因" /></label>}
              <button className="primary-button" type="button" disabled={payrollAccrualBusy || payrollImportBusy || Boolean(payrollFilePreview) || !payrollAccounting.readyToDraft || Boolean(payrollAccounting.postedVoucherId && !payrollAccrualReason.trim())} onClick={generatePayrollAccrual}>{payrollAccrualBusy ? "正在核验原件…" : payrollAccounting.draftVoucherId ? "按当前资料更新草稿" : payrollAccounting.postedVoucherId ? "生成计提更正草稿" : "生成计提草稿"}</button>
            </>}
            {payrollAccounting.draftVoucherId && <button className="primary-button" type="button" onClick={() => { setPayrollVouchersVisited(true); setPayrollVouchersOpen(true); }}>复核计提凭证</button>}
            {payrollAccounting.postedAndMatched && onNavigate && <button className="primary-button" type="button" disabled={payrollImportBusy || Boolean(payrollFilePreview)} onClick={() => onNavigate("reports")}>去报表冻结版本</button>}
          </div>
          <details className="payroll-review-details"><summary>工资资料与账面金额</summary><div className="payroll-book-comparison"><table><thead><tr><th>核对项目</th><th>资料应计</th><th>账面计提</th><th>差额</th></tr></thead><tbody>{payrollAccounting.rows.map((row) => <tr key={row.key}><td>{displayText(row.label)}</td><td>{amountLabel(row.expected)}</td><td>{amountLabel(row.posted)}</td><td>{amountLabel(row.difference)}</td></tr>)}</tbody></table></div></details>
          {payrollVoucherIds.length > 0 && <details className="payroll-review-details" open={payrollVouchersOpen} onToggle={(event) => { if (event.target !== event.currentTarget) return; setPayrollVouchersOpen(event.currentTarget.open); if (event.currentTarget.open) setPayrollVouchersVisited(true); }}>
            <summary>关联计提凭证与冲突来源 · {payrollVoucherIds.length} 张</summary>
            {payrollVouchersVisited && <Suspense fallback={<p role="status" style={{ fontSize: "var(--font-body, 14px)" }}>正在加载计提凭证…</p>}><PayrollVoucherWorkbench voucherIds={payrollVoucherIds} showLedger={false} title="工资计提凭证" onToast={onToast} actionBlockedReason={payrollImportBusy || payrollFilePreview ? "请先保存或取消当前导入，再复核计提凭证。" : ""} /></Suspense>}
          </details>}
        </section>
        <div className="foundation-section-heading payroll-import-heading">
          <div><h3>工资与社保导入核对</h3><p>{activeWorkspace.currentPeriod} · 支持 CSV、XLS 和 XLSX</p></div>
          <span>工资 {payrollSocialSummary.counts.payroll} 人 · 社保 {payrollSocialSummary.counts.socialSecurity} 人 · 差异 {payrollSocialSummary.counts.issues} 人</span>
        </div>
        <p className="foundation-hint payroll-import-hint">确认字段后导入；同一{terminology.personnel}、同一期间的同类记录将被覆盖。</p>
        <div className="document-intake-controls document-import-controls payroll-import-controls">
        <label className="foundation-field"><span>导入类型</span><select disabled={payrollImportBusy} value={payrollImportKind} onChange={(event) => setPayrollImportKind(event.target.value)}>{Object.entries(PAYROLL_SOCIAL_IMPORT_KINDS).map(([id, label]) => <option value={id} key={id}>{displayText(label)}</option>)}</select></label>
          <label className="foundation-field"><span>默认所属期</span><input disabled={payrollImportBusy} type="month" value={payrollImportPeriod} onChange={(event) => setPayrollImportPeriod(event.target.value)} /></label>
          <button className="secondary-button" type="button" disabled={payrollImportBusy} onClick={() => payrollFileInputRef.current?.click()}><FileArrowUp size={17} />{payrollImportBusy ? "读取中…" : `选择${displayText(PAYROLL_SOCIAL_IMPORT_KINDS[payrollImportKind])}`}</button>
          <input ref={payrollFileInputRef} type="file" accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={choosePayrollSocialFile} />
        </div>
        {payrollFilePreview && payrollImportPlan && (
          <div className="bank-import-workspace">
            <div className="foundation-section-heading"><div><h3>{payrollFilePreview.fileName}</h3><p>{payrollFilePreview.sheetName ? `工作表 ${payrollFilePreview.sheetName}` : "CSV"}</p></div><span>{payrollImportPlan.canApply ? `可写入 ${payrollImportPlan.rows.length} 人次` : "映射或数据待修正"}</span></div>
            <div className="document-intake-controls document-structured-fields">
              {Object.entries(PAYROLL_SOCIAL_FIELD_DEFINITIONS).map(([field, definition]) => (
                <label className="foundation-field" key={field}>
                  <span>{displayText(definition.label)}{definition.required ? "（必填）" : ""}</span>
                  <select disabled={payrollImportBusy} value={payrollFieldMapping[field] ?? ""} onChange={(event) => updatePayrollFieldMapping(field, event.target.value)}>
                    <option value="">不映射</option>
                    {payrollFilePreview.inspection.headers.map((header, index) => <option value={index} key={`${field}-${index}`}>{header || `第 ${index + 1} 列`}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <p className="foundation-hint">文件内重复 {payrollImportPlan.duplicateRowCount} 行 · 将覆盖已有同{terminology.personnel}同期间记录 {payrollImportPlan.replacementCount} 行。</p>
            {!!payrollImportPlan.mappingErrors.length && <div className="foundation-error"><WarningCircle size={18} /><span>{payrollImportPlan.mappingErrors.map(displayText).join("；")}</span></div>}
            {!!payrollImportPlan.errors.length && <div className="foundation-error"><WarningCircle size={18} /><span>{payrollImportPlan.errors.slice(0, 8).map((item) => `第 ${item.rowNumber} 行 ${item.employeeName || ""}：${displayText(item.message)}`).join("；")}</span></div>}
            <div className="foundation-record-list">
              {payrollImportPlan.rows.slice(0, 5).map((row) => <article className="foundation-record" key={row.dedupeKey}><div><strong>{row.employeeName} · {row.period}</strong><small>{row.personnelId ? `已匹配${terminology.personnel} ${row.personnelId}` : `${terminology.personnel}档案未匹配`}</small><p>应发 {amountLabel(row.grossSalary)} · 个人社保 {amountLabel(row.personalSocial)} · 企业社保 {amountLabel(row.employerSocial)} · 个税 {amountLabel(row.individualIncomeTax)} · 实发 {amountLabel(row.netSalary)}</p></div><span><strong>第 {row.sourceRowNumber} 行</strong><small>{displayText(PAYROLL_SOCIAL_IMPORT_KINDS[row.sourceKind])}</small></span></article>)}
            </div>
            <div className="foundation-inline-actions"><button className="primary-button" type="button" disabled={payrollImportBusy || !payrollImportPlan.canApply} onClick={commitPayrollSocialImport}>{payrollImportBusy ? "正在保存原件与数据…" : "保存原件并导入"}</button><button className="secondary-button" disabled={payrollImportBusy} type="button" onClick={() => { setPayrollFilePreview(null); setPayrollFieldMapping({}); }}>取消</button></div>
          </div>
        )}
        <details className="payroll-review-details payroll-person-review" defaultOpen={payrollSocialSummary.hasDifferences}>
          <summary>逐人核对 · {payrollSocialSummary.hasDifferences ? `${payrollSocialSummary.counts.issues} 人待处理` : `${payrollSocialSummary.rows.length} 人一致`}</summary>
        <div className="foundation-record-list">
          {payrollSocialSummary.rows.map((row) => {
            const hasRecords = Boolean(row.payrollRecord || row.socialSecurityRecord);
            return (
            <article className="foundation-record" key={row.key}>
              <div>
                <strong>{row.employeeName}</strong>
                <small>{!hasRecords ? row.person?.department || "未填写部门" : !row.person ? `${terminology.personnel}档案缺失` : (row.personnelStatus === "active" || !row.personnelStatus ? `在职 · ${row.person.department || "未填写部门"}` : `离职／非在职 · 状态 ${row.personnelStatus}`)}</small>
                {hasRecords && <>
                <p>工资表：应发 {amountLabel(row.payrollRecord?.grossSalary)} · 个人社保 {amountLabel(row.payrollRecord?.personalSocial)} · 企业社保 {amountLabel(row.payrollRecord?.employerSocial)} · 个税 {amountLabel(row.payrollRecord?.individualIncomeTax)} · 实发 {amountLabel(row.payrollRecord?.netSalary)}</p>
                <p>社保表：工资／基数 {amountLabel(row.socialSecurityRecord?.grossSalary)} · 个人社保 {amountLabel(row.socialSecurityRecord?.personalSocial)} · 企业社保 {amountLabel(row.socialSecurityRecord?.employerSocial)}</p>
                <p>金额差异（工资表 − 社保表）：应发／基数 {row.differences.grossSalary == null ? "不可比" : amountLabel(row.differences.grossSalary)} · 个人社保 {row.differences.personalSocial == null ? "不可比" : amountLabel(row.differences.personalSocial)} · 企业社保 {row.differences.employerSocial == null ? "不可比" : amountLabel(row.differences.employerSocial)}</p>
                </>}
              </div>
              <span><strong>{!hasRecords ? "工资表、社保表均缺失" : row.matched ? "一致" : row.issues.map((issue) => displayText(issue.label)).join("；")}</strong>{hasRecords && <small>{row.payrollRecord?.sourceFileName || "缺工资表"} · {row.socialSecurityRecord?.sourceFileName || "缺社保表"}</small>}</span>
            </article>
            );
          })}
          {!payrollSocialSummary.rows.length && <p className="foundation-empty">当前期间没有工资或社保记录，也没有在职{terminology.personnel}可核对。</p>}
        </div>
        </details>
        {!payrollOnly && <><div className="foundation-section-heading" style={{ marginTop: 18 }}>
          <div><h3>{terminology.customer}确认</h3></div>
          <span>{payrollSocialConfirmation.version ? payrollSocialConfirmation.version.label : "需先重新冻结报表"}</span>
        </div>
        <p className="foundation-hint">工资和社保需由{terminology.customer}分别确认；重新导入或修改后需再次确认。</p>
        <div className="foundation-record-list">
          <article className="foundation-record">
            <label><input type="checkbox" checked={payrollSocialConfirmation.payroll.confirmed} disabled={!payrollSocialConfirmation.version || !payrollSocialConfirmation.payroll.available} onChange={(event) => togglePayrollSocialConfirmation("payroll", event.target.checked)} /> {terminology.customer}确认本期工资表</label>
            <span><strong>{payrollSocialConfirmation.payroll.confirmed ? "已确认" : "未确认"}</strong><small>{payrollSocialConfirmation.payroll.available ? `${payrollSocialSummary.counts.payroll} 人 · 应发 ${amountLabel(payrollSocialSummary.totals.payroll.grossSalary)}` : "请先导入工资表"}</small></span>
          </article>
          <article className="foundation-record">
            <label><input type="checkbox" checked={payrollSocialConfirmation.socialSecurity.confirmed} disabled={!payrollSocialConfirmation.version || !payrollSocialConfirmation.socialSecurity.available} onChange={(event) => togglePayrollSocialConfirmation("socialSecurity", event.target.checked)} /> {terminology.customer}确认本期社保表</label>
            <span><strong>{payrollSocialConfirmation.socialSecurity.confirmed ? "已确认" : "未确认"}</strong><small>{payrollSocialConfirmation.socialSecurity.available ? `${payrollSocialSummary.counts.socialSecurity} 人 · 社保合计 ${amountLabel(payrollSocialSummary.totals.socialSecurityPayable)}` : "请先导入社保表"}</small></span>
          </article>
        </div>
        </>}
        {!!(activeWorkspace.payrollImports || []).length && <p className="foundation-hint">当前工作台已记录 {(activeWorkspace.payrollImports || []).length} 个本地导入批次；最近一次为 {(activeWorkspace.payrollImports || []).at(-1).fileName}。</p>}
      </div>}
      <div className="bank-import-workspace" hidden={selectedSection !== "missing"}>
        <div className="foundation-section-heading">
          <div><h3>资料匹配与缺件待办</h3></div>
          <span>建议 {matchSuggestions.length} · 待补 {openDocumentTasks.length} · 已关闭 {resolvedDocumentTaskCount}</span>
        </div>
        <p className="foundation-hint">请核对资料、往来单位、金额和日期，再确认关联。</p>
        <div className="foundation-inline-actions"><button className="secondary-button" type="button" onClick={refreshMissingTasks}>刷新缺件待办</button></div>
        {matchFeedback && <div className={`${matchFeedback.tone === "error" ? "foundation-error" : "foundation-notice"} import-feedback document-match-feedback`} role={matchFeedback.tone === "error" ? "alert" : "status"} aria-live="polite">{matchFeedback.tone === "error" ? <WarningCircle size={18} /> : <CheckCircle size={18} weight="fill" />}<span>{displayText(matchFeedback.message)}</span></div>}
        {!!openDocumentTasks.length && (
          <div className="foundation-record-list">
            {openDocumentTasks.map((task) => {
              const documentId = task.missingEvidence?.find((item) => item.documentId)?.documentId;
              const document = activeWorkspace.documents.find((item) => item.id === documentId);
              const openTask = () => {
                const returnTarget = task.sourceType === "bankTransaction"
                  ? { page: "reconcile", panel: "transactions", transactionId: task.sourceId }
                  : task.sourceType === "voucher"
                    ? { page: "reconcile", panel: "vouchers", voucherId: task.sourceId }
                    : { section: "missing" };
                if (document) { beginEdit(document, returnTarget); return; }
                if (task.sourceType === "bankTransaction" && onNavigate) { onNavigate("reconcile", { panel: "transactions", transactionId: task.sourceId }); return; }
                if (task.sourceType === "voucher" && onNavigate) { onNavigate("reconcile", { panel: "vouchers", voucherId: task.sourceId }); return; }
                selectSection("files");
                setUploadOpen(true);
              };
              return <article className="foundation-record" key={task.id}><div><strong>{displayText(task.message)}</strong><small>{matchTargetLabel(task.sourceType)} · 等待补齐并确认关联</small></div><button className="secondary-button" type="button" onClick={openTask}>{document ? "打开资料补齐" : task.sourceType === "bankTransaction" ? "打开对应流水" : task.sourceType === "voucher" ? "打开对应凭证" : "上传缺失资料"}</button></article>;
            })}
          </div>
        )}
        <div className="foundation-record-list">
          {matchSuggestions.map((suggestion) => (
            <article className="foundation-record" key={suggestion.id}>
              <div><strong>{suggestion.documentName} → {suggestion.sourceLabel}</strong><small>{documentKindLabel(suggestion.documentKind)} · {matchTargetLabel(suggestion.sourceType)} · 匹配分 {suggestion.score}</small><p>{suggestion.reasons.map(displayText).join("；")}</p></div>
              <button className="primary-button" type="button" disabled={confirmingSuggestionId === suggestion.id} onClick={() => confirmSuggestion(suggestion)}>{confirmingSuggestionId === suggestion.id ? "确认中…" : "确认关联"}</button>
            </article>
          ))}
          {!matchSuggestions.length && <p className="foundation-empty">当前没有达到建议阈值的未确认匹配；可先补录资料详情，或在资料编辑区手动关联。</p>}
        </div>
      </div>
      <div className="bank-import-workspace monthly-financial-archive" hidden={selectedSection !== "exports"}>
        <div className="foundation-section-heading"><div><h3>月度资料包</h3></div></div>
        <div className="document-intake-controls document-action-controls">
          <label className="foundation-field"><span>财务期间</span><select value={selectedArchivePeriod} onChange={(event) => setSelectedArchivePeriod(event.target.value)}>{archivePeriods.map((archivePeriod) => <option value={archivePeriod} key={archivePeriod}>{archivePeriod}</option>)}</select></label>
          <button className="primary-button" type="button" disabled={!fileVault || !monthlyArchivePlan || generatingMonthlyArchive} onClick={generateMonthlyArchive}><DownloadSimple size={17} />{generatingMonthlyArchive ? "正在核对原件…" : "导出资料包"}</button>
        </div>
        {monthlyArchivePlan ? (
          <>
            <div className={`archive-package-summary${monthlyArchivePlan.isComplete ? "" : " is-draft"}`}>
              <div><strong>{monthlyArchivePlan.isComplete ? "清单齐备，待核验原件" : "草稿 · 仍有待处理项"}</strong><p>期间记录{monthlyArchivePlan.archiveRecord ? "已归档" : "尚未归档"}。导出时会核对并装入原文件；缺件会标为草稿。</p></div>
              {latestMonthlyArchiveExport && <span>最近导出：{latestMonthlyArchiveExport.isComplete ? "完整资料包" : "草稿资料包"}{latestMonthlyArchiveExport.originalFileCount != null && ` · ${latestMonthlyArchiveExport.originalFileCount} 份原件`}</span>}
            </div>
            {!!monthlyArchiveIssues.length && <ul className="archive-action-list">
              {monthlyArchiveIssues.map((item) => {
                const resolution = archiveResolution(item);
                return <li key={item.key}><div><strong>{archiveIssueLabel(item)}</strong><p>{item.previousExport ? "上次原件核验：" : ""}{displayText(item.reason).replaceAll("哈希", "校验信息")}</p></div>{resolution.section || (resolution.page && onNavigate) ? <button className="secondary-button" type="button" onClick={() => resolveArchiveItem(item)}>{resolution.label}</button> : <small>{resolution.instruction || `请${resolution.label}`}</small>}</li>;
              })}
            </ul>}
            <details className="document-trace-details archive-section-details">
              <summary>完整清单与导出记录</summary>
              <p className="foundation-hint">{monthlyArchivePlan.moduleSnapshot.known ? `${monthlyArchivePlan.moduleSnapshot.source === "workspace.modules" ? "当前工作台" : "该期间保存的"}模块：确认与申报${monthlyArchivePlan.moduleSnapshot.taxEnabled ? "适用" : "不适用"}，工资社保${monthlyArchivePlan.moduleSnapshot.payrollEnabled ? "适用" : "不适用"}。` : "历史模块快照缺失，未采用当前开关豁免历史必需项。"}</p>
              <div className="foundation-record-list">
                {monthlyArchivePlan.sections.map((section) => {
                  const statusText = { collected: "已收集", missing: "缺失", not_required: "不适用", pending_generation: "导出时生成" }[section.status];
                  return <article className="foundation-record" key={section.key}><div><strong>{displayText(section.label)}</strong><small>{displayText(section.detail)}</small></div><span>{statusText}</span></article>;
                })}
              </div>
              {!!monthlyArchiveExports.length && <ul>{monthlyArchiveExports.map((record) => <li key={record.id}>{record.generatedAt} · {record.fileName}</li>)}</ul>}
              <pre>{JSON.stringify({ moduleSnapshot: monthlyArchivePlan.moduleSnapshot, missingItems: monthlyArchivePlan.missingItems, originalFiles: latestMonthlyArchiveExport?.originalFiles || [], packageHash: latestMonthlyArchiveExport?.hash || null }, null, 2)}</pre>
            </details>
          </>
        ) : <p className="foundation-empty">当前工作台没有可导出的财务期间。</p>}
      </div>
      <details className="document-voucher-export" ref={voucherExportRef} hidden={selectedSection !== "exports"}>
        <summary>单张凭证附件包<span>按凭证选择原件</span></summary>
      <div className="bank-import-workspace">
        <p className="foundation-hint">下载包包含已关联原件、复核记录和缺失清单。</p>
        <div className="document-intake-controls document-action-controls">
          <label className="foundation-field"><span>凭证</span><select value={selectedVoucherId} onChange={(event) => setSelectedVoucherId(event.target.value)}><option value="">请选择凭证</option>{(activeWorkspace.vouchers || []).map((voucher) => <option value={voucher.id} key={voucher.id}>{voucher.no || "未编号凭证"} · {voucher.summary || "无摘要"}{voucher.status === "invalidated" ? "（失效历史）" : ""}</option>)}</select></label>
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
                    <div><strong>{String(section.order).padStart(2, "0")} · {displayText(section.label)}</strong><small>{documentText}</small><p>{displayText(recordText)}</p></div>
                    <span><strong>{statusText}</strong><small>{section.required ? "本包检查项" : "当前凭证未要求"}</small></span>
                  </article>
                );
              })}
            </div>
            {!!voucherPackagePlan.missingItems.length && <div className="foundation-notice"><WarningCircle size={18} /><span><strong>当前缺失：</strong> {voucherPackagePlan.missingItems.map((item) => `${displayText(item.label)}（${displayText(item.reason)}）`).join("；")}</span></div>}
            {!!selectedVoucher?.attachmentPackages?.length && <p className="foundation-hint">最近一次：{selectedVoucher.attachmentPackages.at(-1).generatedAt} · {selectedVoucher.attachmentPackages.at(-1).fileName}</p>}
          </>
        ) : <p className="foundation-empty">当前工作台还没有可选凭证。</p>}
      </div>
      </details>

    </section>
  );
}
