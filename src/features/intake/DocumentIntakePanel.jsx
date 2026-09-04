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
  buildDocumentMatchSuggestions,
  buildMonthlyFinancialArchivePlan,
  buildVoucherAttachmentPackagePlan,
  confirmDocumentMatch,
  documentStructuredKind,
  downloadStoredDocument,
  filterLocalDocuments,
  getDocumentRelatedObjectIds,
  getDocumentMissingRequirements,
  getLocalDocumentUsage,
  getMonthlyFinancialArchivePeriods,
  getStoredDocumentRecord,
  generateMonthlyFinancialArchivePackage,
  generateVoucherAttachmentPackage,
  normalizeDocumentStructuredData,
  refreshDocumentMissingTasks,
  removeLocalDocument,
  saveLocalDocument,
  updateLocalDocumentMetadata,
} from "./documentIntake.js";

const CATEGORIES = ["主体资料", "合同", "银行流水", "业务资料", "发票", "审批资料", "人员资料", "会计资料", "申报回执", "其他资料"];

const RELATED_GROUPS = [
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
      `服务期限：${details.serviceStartDate || "未填写"} 至 ${details.serviceEndDate || "未填写"} · 结算周期 ${details.settlementCycle || "未填写"}`,
      `退款条款：${details.refundTerms || "未填写"}`,
      `佣金条款：${details.commissionTerms || "未填写"}`,
    ];
  }
  if (kind === "invoice") {
    return [
      `发票号码：${details.invoiceNumber || "未填写"} · 日期 ${details.invoiceDate || "未填写"}`,
      `金额 ${amountLabel(details.amount)} · 税额 ${amountLabel(details.taxAmount)} · 税率 ${details.taxRate == null ? "未填写" : `${details.taxRate}%`}`,
      `查验 ${statusLabel(INVOICE_STATUS_OPTIONS.verificationStatus, details.verificationStatus, "未查验")} · 红字 ${statusLabel(INVOICE_STATUS_OPTIONS.redLetterStatus, details.redLetterStatus, "正常蓝字")} · 作废 ${statusLabel(INVOICE_STATUS_OPTIONS.voidStatus, details.voidStatus, "有效")} · 认证 ${statusLabel(INVOICE_STATUS_OPTIONS.certificationStatus, details.certificationStatus, "无需认证")}`,
    ];
  }
  if (kind === "approval") {
    return [`审批类型：${details.approvalType || "未填写"} · 申请人 ${details.applicant || "未填写"} · 金额 ${amountLabel(details.amount)} · ${statusLabel(APPROVAL_STATUS_OPTIONS, details.approvalStatus, "草稿")}`];
  }
  return [];
}

function StructuredDataFields({ category, value, onChange }) {
  const kind = documentStructuredKind(category);
  if (!kind) return null;
  const details = value?.kind === kind ? value : normalizeDocumentStructuredData(category, {});
  const update = (key, nextValue) => onChange({ ...details, [key]: nextValue });
  if (kind === "contract") {
    return (
      <div className="document-intake-controls">
        <label className="foundation-field"><span>合同甲方</span><input value={details.partyA || ""} onChange={(event) => update("partyA", event.target.value)} /></label>
        <label className="foundation-field"><span>合同乙方</span><input value={details.partyB || ""} onChange={(event) => update("partyB", event.target.value)} /></label>
        <label className="foundation-field"><span>合同金额</span><input type="number" min="0" step="0.01" value={details.amount ?? ""} onChange={(event) => update("amount", event.target.value)} /></label>
        <label className="foundation-field"><span>结算周期</span><input value={details.settlementCycle || ""} onChange={(event) => update("settlementCycle", event.target.value)} placeholder="月结 / 季结 / 按里程碑" /></label>
        <label className="foundation-field"><span>服务开始日期</span><input type="date" value={details.serviceStartDate || ""} onChange={(event) => update("serviceStartDate", event.target.value)} /></label>
        <label className="foundation-field"><span>服务结束日期</span><input type="date" value={details.serviceEndDate || ""} onChange={(event) => update("serviceEndDate", event.target.value)} /></label>
        <label className="foundation-field"><span>退款条款</span><input value={details.refundTerms || ""} onChange={(event) => update("refundTerms", event.target.value)} placeholder="退款条件、扣费与时限" /></label>
        <label className="foundation-field"><span>佣金条款</span><input value={details.commissionTerms || ""} onChange={(event) => update("commissionTerms", event.target.value)} placeholder="佣金比例、计提与支付条件" /></label>
      </div>
    );
  }
  if (kind === "invoice") {
    return (
      <div className="document-intake-controls">
        <label className="foundation-field"><span>发票号码</span><input value={details.invoiceNumber || ""} onChange={(event) => update("invoiceNumber", event.target.value)} placeholder="保存时检查重复" /></label>
        <label className="foundation-field"><span>发票日期</span><input type="date" value={details.invoiceDate || ""} onChange={(event) => update("invoiceDate", event.target.value)} /></label>
        <label className="foundation-field"><span>价税合计</span><input type="number" min="0" step="0.01" value={details.amount ?? ""} onChange={(event) => update("amount", event.target.value)} /></label>
        <label className="foundation-field"><span>税额</span><input type="number" min="0" step="0.01" value={details.taxAmount ?? ""} onChange={(event) => update("taxAmount", event.target.value)} /></label>
        <label className="foundation-field"><span>税率（%）</span><input type="number" min="0" max="100" step="0.01" value={details.taxRate ?? ""} onChange={(event) => update("taxRate", event.target.value)} /></label>
        <label className="foundation-field"><span>查验状态</span><select value={details.verificationStatus} onChange={(event) => update("verificationStatus", event.target.value)}>{INVOICE_STATUS_OPTIONS.verificationStatus.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
        <label className="foundation-field"><span>红字状态</span><select value={details.redLetterStatus} onChange={(event) => update("redLetterStatus", event.target.value)}>{INVOICE_STATUS_OPTIONS.redLetterStatus.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
        <label className="foundation-field"><span>作废状态</span><select value={details.voidStatus} onChange={(event) => update("voidStatus", event.target.value)}>{INVOICE_STATUS_OPTIONS.voidStatus.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
        <label className="foundation-field"><span>认证状态</span><select value={details.certificationStatus} onChange={(event) => update("certificationStatus", event.target.value)}>{INVOICE_STATUS_OPTIONS.certificationStatus.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
      </div>
    );
  }
  return (
    <div className="document-intake-controls">
      <label className="foundation-field"><span>审批类型</span><input value={details.approvalType || ""} onChange={(event) => update("approvalType", event.target.value)} placeholder="报销 / 付款 / 采购" /></label>
      <label className="foundation-field"><span>申请人</span><input value={details.applicant || ""} onChange={(event) => update("applicant", event.target.value)} /></label>
      <label className="foundation-field"><span>审批金额</span><input type="number" min="0" step="0.01" value={details.amount ?? ""} onChange={(event) => update("amount", event.target.value)} /></label>
      <label className="foundation-field"><span>审批状态</span><select value={details.approvalStatus} onChange={(event) => update("approvalStatus", event.target.value)}>{APPROVAL_STATUS_OPTIONS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
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
  return sourceType === "bankTransaction" ? "银行流水" : "业务事件";
}

function documentKindLabel(kind) {
  return { contract: "合同", invoice: "发票", approval: "审批单" }[kind] || "资料";
}

export function DocumentIntakePanel({ defaultCategory = "其他资料", compact = false, onToast }) {
  const { activeWorkspace, actions, store, fileVault } = useFinanceDesk();
  const inputRef = useRef(null);
  const [category, setCategory] = useState(defaultCategory);
  const [period, setPeriod] = useState(activeWorkspace.currentPeriod || "");
  const [relatedObjectId, setRelatedObjectId] = useState("");
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirmingSuggestionId, setConfirmingSuggestionId] = useState("");
  const [selectedVoucherId, setSelectedVoucherId] = useState(activeWorkspace.vouchers?.[0]?.id || "");
  const [generatingPackage, setGeneratingPackage] = useState(false);
  const [selectedArchivePeriod, setSelectedArchivePeriod] = useState(activeWorkspace.currentPeriod || "");
  const [generatingMonthlyArchive, setGeneratingMonthlyArchive] = useState(false);
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
  const missingRequirements = useMemo(() => getDocumentMissingRequirements(activeWorkspace), [activeWorkspace]);
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
    setEditing(null);
    setPreview(null);
    setSelectedVoucherId(activeWorkspace.vouchers?.[0]?.id || "");
    setSelectedArchivePeriod(activeWorkspace.currentPeriod || "");
    setError("");
  }, [activeWorkspace.id, activeWorkspace.currentPeriod, defaultCategory]);

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

  async function remove(document) {
    const usage = getLocalDocumentUsage(activeWorkspace, document.id);
    if (usage.length) {
      setError(`该资料正在使用，不能删除：${usage.map((item) => item.label).join("、")}`);
      return;
    }
    if (!window.confirm(`确定删除「${document.name}」及其浏览器本地原文件吗？`)) return;
    setError("");
    try {
      await removeLocalDocument({ store, fileVault, workspaceId: activeWorkspace.id, documentId: document.id });
      if (preview?.document.id === document.id) setPreview(null);
      if (editing?.id === document.id) setEditing(null);
      onToast?.("未使用的本地资料已删除");
    } catch (caught) {
      setError(caught.message || "资料删除失败");
    }
  }

  function archive(document) {
    if (!window.confirm(`归档后不能直接修改或删除「${document.name}」，确定继续吗？`)) return;
    setError("");
    try {
      actions.upsertEntity(activeWorkspace.id, "documents", { ...document, lifecycleStatus: "已归档", archiveStatus: "archived" }, { label: "资料状态" });
      if (editing?.id === document.id) setEditing(null);
      onToast?.("资料已标记归档");
    } catch (caught) {
      setError(caught.message || "资料归档失败");
    }
  }

  function beginEdit(document) {
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
      setEditing(null);
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
          <div className="foundation-section-heading"><div><small>浏览器本地预览</small><h3>{preview.document.name}</h3></div><button className="foundation-icon-button" type="button" aria-label="关闭预览" onClick={() => setPreview(null)}><X size={17} /></button></div>
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
                    <StructuredDataFields category={editing.category} value={editing.structuredData} onChange={(structuredData) => setEditing((current) => ({ ...current, structuredData }))} />
                    <div className="permission-chip-list">{editing.relatedObjectIds.map((objectId) => <span key={objectId}>{relatedLabels.get(objectId) || objectId} <button type="button" aria-label={`解除 ${relatedLabels.get(objectId) || objectId} 关联`} onClick={() => removeEditRelation(objectId)}>×</button></span>)}</div>
                    <div className="foundation-inline-actions"><button className="primary-button" type="button" onClick={saveEdit}>保存资料详情</button><button className="secondary-button" type="button" onClick={() => setEditing(null)}>取消</button></div>
                  </div>
                )}
              </div>
              <span className="foundation-record-actions">
                <button type="button" disabled={!locallyAvailable || !fileVault} aria-label="页面预览" title="页面预览" onClick={() => showPreview(document)}><Eye size={15} /></button>
                <button type="button" disabled={!locallyAvailable || !fileVault} aria-label="下载原文件" title="下载原文件" onClick={() => download(document)}><DownloadSimple size={15} /></button>
                <button type="button" disabled={archived} aria-label="编辑资料详情" title={archived ? "已归档资料不能直接修改" : "编辑资料详情"} onClick={() => beginEdit(document)}><PencilSimple size={15} /></button>
                <button type="button" disabled={archived} aria-label="标记归档" title={archived ? "资料已归档" : "标记归档"} onClick={() => archive(document)}><Archive size={15} /></button>
                <button type="button" disabled={usage.length > 0} aria-label="删除未使用资料" title={usage.length ? `不能删除：${usage.map((item) => item.label).join("、")}` : "删除未使用资料"} onClick={() => remove(document)}><Trash size={15} /></button>
              </span>
            </article>
          );
        })}
        {!filteredDocuments.length && <p className="foundation-empty">没有符合当前条件的资料。</p>}
      </div>
    </section>
  );
}
