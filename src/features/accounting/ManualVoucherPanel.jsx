import { useEffect, useId, useMemo, useRef, useState } from "react";
import { usePeriodLeaveGuard } from "../workspaces/periodNavigation.js";
import {
  CheckCircle,
  FileText,
  NotePencil,
  Plus,
  Receipt,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";

import {
  accountDefinition,
  accountingRules,
  assessManualVoucherEvidence,
  cancelReconciliationCorrection,
  createManualVoucherDraft,
  createPostedVoucherRevision,
  MANUAL_VOUCHER_BASIS_KINDS,
  manualVoucherSourceOptions,
  postVoucherWithEvidence,
  recordManualVoucherEvidenceFailure,
  reviseDraftVoucher,
  validateVoucherBalance,
  workspaceAccountDefinitions,
} from "../../domain/accounting/index.js";
import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import { saveLocalDocument } from "../intake/documentIntake.js";
import { buildSettlementRecognitionDraft } from "../reconciliation/settlementRecognition.js";
import "./manual-voucher-panel.css";

let lineSequence = 0;

function nextLineId() {
  lineSequence += 1;
  return `manual-voucher-line-${lineSequence}`;
}

function currentPeriodDate(period) {
  const today = new Date().toISOString().slice(0, 10);
  return today.startsWith(`${period}-`) ? today : `${period}-01`;
}

function periodEndDate(period) {
  const [year, month] = String(period || "").split("-").map(Number);
  if (!year || !month) return "";
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function createEditableLine(values = {}) {
  const debit = Number(values.debit || 0);
  const credit = Number(values.credit || 0);
  const taxAmount = values.taxAmount;
  return {
    ...values,
    clientId: nextLineId(),
    account: values.account || "",
    storeId: values.storeId || "",
    storeName: values.storeName || "",
    department: values.department || "",
    project: values.project || "",
    debit: debit ? String(values.debit) : "",
    credit: credit ? String(values.credit) : "",
    taxAmount: taxAmount == null || String(taxAmount).trim() === "" ? "" : String(taxAmount),
    sourceIdsText: Array.isArray(values.sourceIds) ? values.sourceIds.join("，") : (values.sourceIdsText || ""),
  };
}

function emptyEditor(workspace) {
  const period = workspace?.currentPeriod || new Date().toISOString().slice(0, 7);
  return {
    voucherId: null,
    date: currentPeriodDate(period),
    summary: "",
    lines: [createEditableLine(), createEditableLine()],
    evidenceIds: [],
    basis: { kind: "business", description: "", voucherIds: [], calculationDocumentId: "" },
    revisionReason: "",
  };
}

function parseSourceIds(value) {
  return [...new Set(String(value || "")
    .split(/[,，;；\n]+/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function money(value) {
  return Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function dateTime(value) {
  if (!value) return "未记录时间";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString("zh-CN", { hour12: false });
}

function actorName(state, workspace) {
  return workspace?.users?.find((user) => user.id === state.activeUserId && user.status === "active")?.name?.trim()
    || "本地用户";
}

function accountOptions(workspace) {
  const byId = new Map(workspaceAccountDefinitions(workspace).map((account) => [account.id, account]));
  [...(workspace?.bankAccounts || []), ...(workspace?.accounts || [])].forEach((account) => {
    if (!account?.id || byId.has(account.id)) return;
    const definition = accountDefinition(account.id, workspace);
    byId.set(account.id, {
      ...definition,
      id: account.id,
      label: account.label || account.name || account.accountName || definition.label || account.id,
      status: account.status || "active",
    });
  });
  return [...byId.values()]
    .filter((account) => account.status !== "inactive")
    .sort((left, right) => String(left.label || left.id).localeCompare(String(right.label || right.id), "zh-CN"));
}

function uniqueText(values) {
  return [...new Set(values.flat(Infinity).map((value) => String(value || "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function dimensionOptions(workspace) {
  const lines = (workspace.vouchers || []).flatMap((voucher) => voucher.lines || []);
  const records = [
    ...(workspace.businessEvents || []),
    ...(workspace.bills || []),
    ...lines,
  ];
  return {
    stores: (workspace.stores || []).filter((store) => store.status !== "inactive"),
    departments: uniqueText([
      (workspace.personnelRecords || []).map((record) => record.department),
      records.map((record) => record.department || record.departmentName),
    ]),
    projects: uniqueText(records.map((record) => record.project || record.projectName)),
  };
}

function lineForDomain(line, stores) {
  const stored = Object.fromEntries(Object.entries(line).filter(([key]) => !["clientId", "sourceIdsText"].includes(key)));
  const store = stores.find((candidate) => candidate.id === line.storeId);
  const rawTaxAmount = String(line.taxAmount ?? "").trim();
  return {
    ...stored,
    account: String(line.account || "").trim(),
    storeId: line.storeId || null,
    storeName: store?.name || line.storeName || null,
    department: String(line.department || "").trim() || null,
    project: String(line.project || "").trim() || null,
    debit: String(line.debit ?? "").trim() === "" ? 0 : Number(line.debit),
    credit: String(line.credit ?? "").trim() === "" ? 0 : Number(line.credit),
    taxAmount: rawTaxAmount === "" ? null : Number(rawTaxAmount),
    sourceIds: parseSourceIds(line.sourceIdsText),
  };
}

function voucherStatus(status) {
  return {
    draft: { label: "草稿", tone: "draft" },
    changes_requested: { label: "待修订", tone: "warning" },
    posted: { label: "已入账", tone: "posted" },
    superseded: { label: "已被替代", tone: "muted" },
    invalidated: { label: "来源失效 / 已取消", tone: "muted" },
  }[status] || { label: status || "未知状态", tone: "muted" };
}

function accountLabel(workspace, options, accountId) {
  return options.find((account) => account.id === accountId)?.label
    || accountDefinition(accountId, workspace)?.label
    || accountId
    || "未选择科目";
}

function documentLabel(document) {
  return document.name || document.title || document.id;
}

export function ManualVoucherPanel({ onToast, request }) {
  const { activeWorkspace, actions, state, store, fileVault } = useFinanceDesk();
  const [editor, setEditor] = useState(() => emptyEditor(activeWorkspace));
  const [editorOpen, setEditorOpen] = useState(false);
  const [reviewNotes, setReviewNotes] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingRequest, setPendingRequest] = useState(null);
  const handledRequest = useRef(null);
  const editorRef = useRef(null);
  const editorBaseline = useRef(JSON.stringify(editor));
  usePeriodLeaveGuard({ dirty: editorOpen && JSON.stringify(editor) !== editorBaseline.current, busy });
  const departmentListId = useId();
  const projectListId = useId();

  const accounts = useMemo(() => activeWorkspace ? accountOptions(activeWorkspace) : [], [activeWorkspace]);
  const sourceOptions = useMemo(() => activeWorkspace ? manualVoucherSourceOptions(activeWorkspace) : [], [activeWorkspace]);
  const dimensions = useMemo(() => activeWorkspace ? dimensionOptions(activeWorkspace) : { stores: [], departments: [], projects: [] }, [activeWorkspace]);
  const documents = useMemo(() => activeWorkspace ? [...(activeWorkspace.documents || [])].sort((left, right) => {
    const leftCurrent = left.period === activeWorkspace.currentPeriod ? 1 : 0;
    const rightCurrent = right.period === activeWorkspace.currentPeriod ? 1 : 0;
    return rightCurrent - leftCurrent || String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
  }) : [], [activeWorkspace]);
  const manualVouchers = useMemo(() => activeWorkspace ? [...(activeWorkspace.vouchers || [])]
    .filter((voucher) => voucher.period === activeWorkspace.currentPeriod
      && (voucher.sourceType === "manual" || voucher.judgement?.eventType === "manualVoucher"))
    .sort((left, right) => String(right.date || "").localeCompare(String(left.date || ""))
      || String(right.createdAt || "").localeCompare(String(left.createdAt || ""))) : [], [activeWorkspace]);
  const preparedLines = useMemo(
    () => editor.lines.map((line) => lineForDomain(line, dimensions.stores)),
    [editor.lines, dimensions.stores],
  );
  const validation = useMemo(
    () => activeWorkspace
      ? validateVoucherBalance({ lines: preparedLines }, accountingRules(activeWorkspace).amountTolerance, activeWorkspace)
      : { balanced: false, debit: 0, credit: 0, taxTotal: 0, difference: 0, errors: [] },
    [activeWorkspace, preparedLines],
  );

  useEffect(() => {
    const blank = emptyEditor(activeWorkspace);
    setEditor(blank);
    editorBaseline.current = JSON.stringify(blank);
    setEditorOpen(false);
    setReviewNotes({});
    setError("");
  }, [activeWorkspace?.id, activeWorkspace?.currentPeriod]);

  useEffect(() => {
    if (!request?.billId || !activeWorkspace) return;
    const key = `${activeWorkspace.id}:${request.nonce}:${request.billId}`;
    if (handledRequest.current === key) return;
    handledRequest.current = key;
    setPendingRequest({ ...request, workspaceId: activeWorkspace.id, period: activeWorkspace.currentPeriod });
    setEditorOpen(true);
  }, [request?.billId, request?.nonce, activeWorkspace?.id]);

  useEffect(() => {
    if (!pendingRequest || !activeWorkspace || busy) return;
    if (pendingRequest.workspaceId !== activeWorkspace.id || pendingRequest.period !== activeWorkspace.currentPeriod) { setPendingRequest(null); return; }
    if (JSON.stringify(editor) !== editorBaseline.current) return;
    try {
      const suggested = buildSettlementRecognitionDraft(activeWorkspace, pendingRequest.billId);
      const loaded = { ...emptyEditor(activeWorkspace), date: suggested.date, summary: suggested.summary,
        lines: suggested.lines.map(createEditableLine), evidenceIds: suggested.evidenceIds || [] };
      // Prefilled business input is unsaved until the user supplies the counter-account and saves it.
      setEditor(loaded);
      setEditorOpen(true);
      setError("");
      setPendingRequest(null);
      requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (caught) { setError(caught.message); setPendingRequest(null); }
  }, [pendingRequest, activeWorkspace, editor, busy]);

  if (!activeWorkspace) return null;

  const actor = actorName(state, activeWorkspace);
  const dateBelongsToPeriod = /^\d{4}-\d{2}-\d{2}$/.test(editor.date)
    && editor.date.startsWith(`${activeWorkspace.currentPeriod}-`);
  const canSave = dateBelongsToPeriod
    && !busy
    && editor.summary.trim().length > 0
    && validation.balanced
    && (!editor.voucherId || editor.revisionReason.trim().length > 0);
  const hasUnsavedInput = JSON.stringify(editor) !== editorBaseline.current;
  const hasLineInput = editor.lines.some((line) => line.account || line.debit || line.credit);

  function resetEditor({ scroll = false } = {}) {
    const blank = emptyEditor(activeWorkspace);
    setEditor(blank);
    editorBaseline.current = JSON.stringify(blank);
    setEditorOpen(false);
    setError("");
    if (scroll) requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function updateLine(clientId, patch) {
    setEditor((current) => ({
      ...current,
      lines: current.lines.map((line) => line.clientId === clientId ? { ...line, ...patch } : line),
    }));
  }

  function addLine() {
    setEditor((current) => ({ ...current, lines: [...current.lines, createEditableLine()] }));
  }

  function removeLine(clientId) {
    setEditor((current) => current.lines.length <= 2
      ? current
      : { ...current, lines: current.lines.filter((line) => line.clientId !== clientId) });
  }

  function toggleEvidence(documentId, checked) {
    setEditor((current) => ({
      ...current,
      evidenceIds: checked
        ? [...new Set([...current.evidenceIds, documentId])]
        : current.evidenceIds.filter((id) => id !== documentId),
    }));
  }

  function loadDraft(voucher) {
    if (!["draft", "changes_requested"].includes(voucher.status)) return;
    if (hasUnsavedInput) {
      setEditorOpen(true);
      if (editor.voucherId !== voucher.id) setError("正在编辑的内容尚未保存；请先保存，或明确放弃本次输入后再载入其他凭证。");
      return;
    }
    const loaded = {
      voucherId: voucher.id,
      date: voucher.date,
      summary: voucher.summary || "",
      lines: (voucher.lines || []).map(createEditableLine),
      evidenceIds: [...(voucher.evidenceIds || [])],
      basis: { kind: "business", description: "", voucherIds: [], calculationDocumentId: "", ...(voucher.basis || {}) },
      revisionReason: "",
    };
    setEditor(loaded);
    editorBaseline.current = JSON.stringify(loaded);
    setEditorOpen(true);
    setError("");
    requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function saveDraft(event) {
    event.preventDefault();
    setError("");
    if (!canSave) {
      setError(!dateBelongsToPeriod
        ? `凭证日期必须属于当前账期 ${activeWorkspace.currentPeriod}`
        : !editor.summary.trim()
          ? "请填写凭证摘要"
          : editor.voucherId && !editor.revisionReason.trim()
            ? "修改已保存草稿必须填写修改原因"
            : validation.errors.join("；") || "请先补全有效且借贷平衡的分录");
      return;
    }
    try {
      const current = store.getActiveWorkspace();
      const next = editor.voucherId
        ? reviseDraftVoucher(current, {
          voucherId: editor.voucherId,
          summary: editor.summary.trim(),
          lines: preparedLines,
          evidenceIds: editor.evidenceIds,
          basis: editor.basis,
          reason: editor.revisionReason.trim(),
        }, { actor, mode: "manual" })
        : createManualVoucherDraft(current, {
          date: editor.date,
          summary: editor.summary.trim(),
          lines: preparedLines,
          evidenceIds: editor.evidenceIds,
          basis: editor.basis,
        }, { actor, mode: "manual" });
      actions.replaceWorkspace(current.id, next);
      onToast?.(editor.voucherId ? "手工凭证草稿修订已保存" : "手工凭证草稿已保存");
      const blank = emptyEditor(next);
      setEditor(blank);
      editorBaseline.current = JSON.stringify(blank);
      setEditorOpen(false);
    } catch (caught) {
      setError(caught.message || "手工凭证草稿保存失败");
    }
  }

  async function postDraft(voucher) {
    if (busy) return;
    const reviewNote = String(reviewNotes[voucher.id] || "").trim();
    if (!reviewNote) {
      setError("人工入账前必须填写复核意见");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const current = store.getActiveWorkspace();
      const next = await postVoucherWithEvidence(current, { voucherId: voucher.id, reviewNote, mode: "manual" }, { actor, mode: "manual", fileVault });
      if (store.getActiveWorkspace() !== current) throw new Error("原件核验期间工作台数据发生变化，请重新复核入账");
      actions.replaceWorkspace(current.id, next);
      setReviewNotes((notes) => ({ ...notes, [voucher.id]: "" }));
      onToast?.("手工凭证已完成人工复核并入账");
    } catch (caught) {
      setError(caught.message || "手工凭证入账失败");
      if (["VOUCHER_EVIDENCE_REQUIRED", "VOUCHER_ORIGINAL_REQUIRED"].includes(caught.code)) {
        const current = store.getActiveWorkspace();
        if (current.id === activeWorkspace.id) {
          try { actions.replaceWorkspace(current.id, recordManualVoucherEvidenceFailure(current, voucher.id, caught.message, { actor })); }
          catch (recordError) { setError(`${caught.message}；补件任务未保存：${recordError.message}`); }
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function uploadOriginal(file) {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      const document = await saveLocalDocument({ store, fileVault, workspaceId: activeWorkspace.id, file, metadata: { category: "会计资料", period: activeWorkspace.currentPeriod, actor } });
      if (store.getActiveWorkspace().id !== activeWorkspace.id) return;
      setEditor((current) => ({
        ...current,
        evidenceIds: [...new Set([...current.evidenceIds, document.id])],
        basis: { ...current.basis, calculationDocumentId: current.basis.kind !== "business" && !current.basis.calculationDocumentId ? document.id : current.basis.calculationDocumentId },
      }));
      onToast?.("原文件已保存并勾选；保存草稿即可关联到凭证");
    } catch (caught) {
      setError(caught.message || "原文件上传失败");
    } finally { setBusy(false); }
  }

  function createRevision(voucher) {
    if (hasUnsavedInput) { setEditorOpen(true); setError("请先保存或放弃当前输入，再创建另一张更正草稿。"); return; }
    const reason = String(reviewNotes[voucher.id] || "").trim();
    try {
      const current = store.getActiveWorkspace();
      const next = createPostedVoucherRevision(current, { voucherId: voucher.id, reason }, { actor });
      actions.replaceWorkspace(current.id, next);
      loadDraft(next.vouchers[next.vouchers.length - 1]);
      onToast?.("更正草稿已创建，原凭证在更正入账前继续有效");
    } catch (caught) { setError(caught.message); }
  }

  function cancelRevision(voucher) {
    try {
      const current = store.getActiveWorkspace();
      const next = cancelReconciliationCorrection(current, { voucherId: voucher.id, reason: reviewNotes[voucher.id] }, { actor });
      actions.replaceWorkspace(current.id, next);
      if (editor.voucherId === voucher.id) resetEditor();
      onToast?.("更正草稿已取消，原凭证保持有效");
    } catch (caught) { setError(caught.message); }
  }

  return (
    <section className="manual-voucher-panel">
      <header className="manual-voucher-panel-heading">
        <div><h2>手工凭证</h2><span>可先存草稿；入账前须补齐来源、核验原件并填写复核意见。</span></div>
        <button className="secondary-button" type="button" aria-expanded={editorOpen} disabled={busy} onClick={() => setEditorOpen((current) => !current)}><Plus size={16} />{editorOpen ? "收起录入 · 保留输入" : hasUnsavedInput || editor.voucherId ? "继续编辑" : "录入手工凭证"}</button>
      </header>

      {error && <div className="manual-voucher-error" role="alert"><WarningCircle size={18} /><span>{error}</span></div>}
      {pendingRequest && hasUnsavedInput && <div className="manual-voucher-error" role="status"><WarningCircle size={18} /><span>已收到该账单的确认请求。当前输入已保留；请先保存或通过下方按钮明确放弃当前输入，再载入账单。</span></div>}

      <form className="manual-voucher-editor" onSubmit={saveDraft} ref={editorRef} hidden={!editorOpen}>
        <div className="manual-voucher-section-heading">
          <div><h3>{editor.voucherId ? "修改手工凭证" : "录入手工凭证"}</h3></div>
          {editor.voucherId && <span className="manual-voucher-editing-badge"><NotePencil size={15} />已保存草稿</span>}
        </div>

        <div className="manual-voucher-header-fields">
          <label><span>凭证日期 *</span><input required readOnly={Boolean(editor.voucherId)} type="date" min={`${activeWorkspace.currentPeriod}-01`} max={periodEndDate(activeWorkspace.currentPeriod)} value={editor.date} onChange={(event) => setEditor((current) => ({ ...current, date: event.target.value }))} /><small>{editor.voucherId ? "已保存草稿的日期保持不变；换日期请新建草稿" : `必须属于当前账期 ${activeWorkspace.currentPeriod}`}</small></label>
          <label><span>凭证摘要 *</span><input required value={editor.summary} onChange={(event) => setEditor((current) => ({ ...current, summary: event.target.value }))} placeholder="说明本次凭证反映的业务或调整" /></label>
          {editor.voucherId && <label className="manual-voucher-reason"><span>修改原因 *</span><textarea required value={editor.revisionReason} onChange={(event) => setEditor((current) => ({ ...current, revisionReason: event.target.value }))} placeholder="说明本次修改的原因和依据" /></label>}
        </div>

        <div className="manual-voucher-header-fields">
          <label><span>凭证依据</span><select value={editor.basis.kind} onChange={(event) => setEditor((current) => ({ ...current, basis: { ...current.basis, kind: event.target.value } }))}>{Object.entries(MANUAL_VOUCHER_BASIS_KINDS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          {editor.basis.kind !== "business" && <>
            <label><span>调整 / 计算说明</span><textarea value={editor.basis.description} onChange={(event) => setEditor((current) => ({ ...current, basis: { ...current.basis, description: event.target.value } }))} placeholder="说明调整对象、计算方法与金额来源" /></label>
            <label><span>关联原凭证（可多选）</span><select multiple value={editor.basis.voucherIds} onChange={(event) => setEditor((current) => ({ ...current, basis: { ...current.basis, voucherIds: Array.from(event.target.selectedOptions, (option) => option.value) } }))}>{(activeWorkspace.vouchers || []).filter((voucher) => voucher.id !== editor.voucherId && ["posted", "superseded"].includes(voucher.status)).map((voucher) => <option value={voucher.id} key={voucher.id}>{voucher.period} · {voucher.no || voucher.id} · {voucher.summary}{voucher.status === "superseded" ? "（历史）" : ""}</option>)}</select></label>
            <label><span>计算依据文件</span><select value={editor.basis.calculationDocumentId} onChange={(event) => setEditor((current) => ({ ...current, basis: { ...current.basis, calculationDocumentId: event.target.value } }))}><option value="">选择已上传文件，或沿原凭证追溯</option>{documents.map((document) => <option value={document.id} key={document.id}>{documentLabel(document)}</option>)}</select><small>暂估、结转和历史调整可使用原凭证或计算文件，不要求银行流水。</small></label>
          </>}
        </div>

        <div className="manual-voucher-lines-heading"><div><strong>凭证分录</strong><small>至少两行；每行只能填写借方或贷方一侧。</small></div><button className="soft-button" type="button" onClick={addLine}><Plus size={15} />增加分录</button></div>
        <div className="manual-voucher-lines">
          {editor.lines.map((line, index) => {
            const historicalAccount = line.account && !accounts.some((account) => account.id === line.account);
            const historicalStore = line.storeId && !dimensions.stores.some((store) => store.id === line.storeId);
            return (
              <article className="manual-voucher-line" key={line.clientId}>
                <div className="manual-voucher-line-heading"><strong>分录 {index + 1}</strong><button type="button" disabled={editor.lines.length <= 2} onClick={() => removeLine(line.clientId)}><Trash size={14} />删除分录</button></div>
                <div className="manual-voucher-line-main">
                  <label className="manual-voucher-account-field"><span>会计科目 *</span><select required value={line.account} onChange={(event) => updateLine(line.clientId, { account: event.target.value })}><option value="">请选择当前有效科目</option>{historicalAccount && <option value={line.account} disabled>{accountLabel(activeWorkspace, accounts, line.account)}（已停用或无效）</option>}{accounts.map((account) => <option value={account.id} key={account.id}>{account.label}</option>)}</select><small>{line.account || "尚未选择"}</small></label>
                  <label><span>借方金额</span><input type="number" min="0" step="0.01" inputMode="decimal" value={line.debit} onChange={(event) => updateLine(line.clientId, { debit: event.target.value, ...(Number(event.target.value) > 0 ? { credit: "" } : {}) })} placeholder="0.00" /></label>
                  <label><span>贷方金额</span><input type="number" min="0" step="0.01" inputMode="decimal" value={line.credit} onChange={(event) => updateLine(line.clientId, { credit: event.target.value, ...(Number(event.target.value) > 0 ? { debit: "" } : {}) })} placeholder="0.00" /></label>
                  <label><span>税额（可选）</span><input type="number" min="0" step="0.01" inputMode="decimal" value={line.taxAmount} onChange={(event) => updateLine(line.clientId, { taxAmount: event.target.value })} placeholder="0.00" /><small>仅记录，不参与借贷平衡</small></label>
                </div>
                <div className="manual-voucher-line-dimensions">
                  <label><span>场所</span><select value={line.storeId} onChange={(event) => {
                    const selected = dimensions.stores.find((store) => store.id === event.target.value);
                    updateLine(line.clientId, { storeId: selected?.id || "", storeName: selected?.name || "" });
                  }}><option value="">不设置</option>{historicalStore && <option value={line.storeId}>{line.storeName || line.storeId}（历史）</option>}{dimensions.stores.map((store) => <option value={store.id} key={store.id}>{store.name || store.id}</option>)}</select></label>
                  <label><span>部门</span><input list={`${departmentListId}-${index}`} value={line.department} onChange={(event) => updateLine(line.clientId, { department: event.target.value })} placeholder="选择已有部门或手填" /><datalist id={`${departmentListId}-${index}`}>{dimensions.departments.map((department) => <option value={department} key={department} />)}</datalist></label>
                  <label><span>项目</span><input list={`${projectListId}-${index}`} value={line.project} onChange={(event) => updateLine(line.clientId, { project: event.target.value })} placeholder="选择已有项目或手填" /><datalist id={`${projectListId}-${index}`}>{dimensions.projects.map((project) => <option value={project} key={project} />)}</datalist></label>
                  <label className="manual-voucher-source-field"><span>业务来源（可多选）</span><select multiple value={parseSourceIds(line.sourceIdsText)} onChange={(event) => updateLine(line.clientId, { sourceIdsText: Array.from(event.target.selectedOptions, (option) => option.value).join("，") })}>{parseSourceIds(line.sourceIdsText).filter((id) => !sourceOptions.some((option) => option.id === id)).map((id) => <option value={id} key={id}>{id}（来源失效，请取消选择）</option>)}{sourceOptions.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select><small>{parseSourceIds(line.sourceIdsText).length ? `${parseSourceIds(line.sourceIdsText).length} 项来源` : "业务凭证请选择实际来源；调整、暂估、结转可在上方关联依据"}</small></label>
                </div>
              </article>
            );
          })}
        </div>

        <div className={`manual-voucher-balance ${validation.balanced ? "is-balanced" : hasLineInput ? "is-invalid" : ""}`}>
          <span>借方 ¥{money(validation.debit)}</span><span>贷方 ¥{money(validation.credit)}</span><span>税额 ¥{money(validation.taxTotal)}</span><strong>{!hasLineInput ? "填写分录后核对借贷" : validation.balanced ? "借贷平衡，可以保存" : `差额 ¥${money(Math.abs(validation.difference))}`}</strong>
        </div>
        {hasLineInput && !validation.balanced && <div className="manual-voucher-validation-errors">{validation.errors.map((message) => <span key={message}>{message}</span>)}</div>}

        <fieldset className="manual-voucher-documents">
          <legend>关联当前工作台资料（可多选）</legend>
          <label><span>{busy ? "正在处理原文件…" : "上传原始资料 / 计算文件"}</span><input type="file" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; uploadOriginal(file); }} /></label>
          {editor.evidenceIds.filter((id) => !documents.some((document) => document.id === id)).map((id) => <label key={id}><input type="checkbox" checked onChange={() => toggleEvidence(id, false)} /><span>资料 {id} 已不存在，请取消关联并上传有效原件</span></label>)}
          {documents.length ? <div className="manual-voucher-document-list">{documents.map((document) => {
            const archived = document.archiveStatus === "archived" || ["archived", "已归档"].includes(document.lifecycleStatus);
            return <label key={document.id}><input type="checkbox" checked={editor.evidenceIds.includes(document.id)} onChange={(event) => toggleEvidence(document.id, event.target.checked)} /><span><strong>{documentLabel(document)}</strong><small>{document.category || document.type || "资料"} · {document.period || "未分期"}{archived ? " · 已归档" : ""}</small></span></label>;
          })}</div> : <p>当前工作台还没有可关联资料；可先保存不带资料的草稿。</p>}
        </fieldset>

        <div className="manual-voucher-editor-actions">
          <button className="secondary-button" type="button" disabled={busy} onClick={() => setEditorOpen(false)}>收起并保留输入</button>
          {(hasUnsavedInput || editor.voucherId) && <button className="soft-button" type="button" disabled={busy} onClick={() => resetEditor()}>放弃本次输入</button>}
          <button className="primary-button" type="submit" disabled={!canSave}><Receipt size={16} />{editor.voucherId ? "保存草稿修订" : "保存手工凭证草稿"}</button>
        </div>
      </form>

      <section className="manual-voucher-records">
        <div className="manual-voucher-section-heading"><div><h3>本期手工凭证</h3><small>{activeWorkspace.currentPeriod}</small></div><span>{manualVouchers.length} 张</span></div>
        {manualVouchers.length ? <div className="manual-voucher-record-list">{manualVouchers.map((voucher) => {
          const status = voucherStatus(voucher.status);
          const voucherValidation = validateVoucherBalance(voucher, accountingRules(activeWorkspace).amountTolerance, activeWorkspace);
          const editable = ["draft", "changes_requested"].includes(voucher.status);
          const editing = editor.voucherId === voucher.id;
          const evidence = (voucher.evidenceIds || []).map((id) => documents.find((document) => document.id === id));
          const latestReview = [...(voucher.reviews || [])].reverse()[0];
          const evidenceAssessment = assessManualVoucherEvidence(activeWorkspace, voucher);
          const evidenceTask = (activeWorkspace.exceptionTasks || []).find((task) => task.sourceId === voucher.id && task.code === "voucher_evidence" && task.status !== "resolved");
          return (
            <article className={`manual-voucher-record is-${status.tone}`} key={voucher.id}>
              <div className="manual-voucher-record-heading">
                <div><h4>{voucher.summary}</h4><small>{voucher.no || "未编号草稿"} · V{voucher.version || 1}</small><span className={`manual-voucher-status is-${status.tone}`}>{status.label}</span><p>{voucher.date} · 借贷各 ¥{money(voucherValidation.debit)} · {voucher.lines?.length || 0} 行分录</p></div>
                {editable && <button className="secondary-button" type="button" disabled={busy} onClick={() => editing ? setEditorOpen(true) : loadDraft(voucher)}><NotePencil size={15} />{editing ? "继续修改" : "载入修改"}</button>}
              </div>
              <details className="manual-voucher-record-details">
                <summary>查看分录与关联资料</summary>
                <div className="manual-voucher-read-lines">{(voucher.lines || []).map((line, index) => <div key={`${voucher.id}-line-${index}`}><span><strong>{accountLabel(activeWorkspace, accounts, line.account)}</strong><small>{[line.storeName, line.department, line.project].filter(Boolean).join(" · ") || "未设置经营维度"}</small><small>{line.sourceIds?.length ? `来源 ${line.sourceIds.join("、")}` : "未设置来源标识"}</small></span><span><small>借 ¥{money(line.debit)} · 贷 ¥{money(line.credit)}</small><strong>{line.taxAmount == null ? "无税额" : `税额 ¥${money(line.taxAmount)}`}</strong></span></div>)}</div>
                <div className="manual-voucher-evidence-summary"><FileText size={16} /><span><strong>关联资料</strong><small>{evidence.length ? evidence.map((document, index) => document ? documentLabel(document) : voucher.evidenceIds[index]).join("、") : "未关联资料"}</small></span></div>
                <p>{MANUAL_VOUCHER_BASIS_KINDS[voucher.basis?.kind || "business"]} · {voucher.basis?.description || "按所选业务来源记录"}{evidenceAssessment.referenceIds.length ? ` · 原凭证 ${evidenceAssessment.referenceIds.join("、")}` : ""}</p>
                {latestReview && <div className="manual-voucher-review-record"><CheckCircle size={16} /><span><strong>{latestReview.actor || voucher.postedBy || "本地用户"} · {latestReview.decision === "approve" ? "已复核" : "已记录意见"}</strong><small>{latestReview.note} · {dateTime(latestReview.at || voucher.postedAt)}</small></span></div>}
              </details>
              {editable && <details className="manual-voucher-posting-details"><summary>{evidenceAssessment.complete ? "复核并入账" : "补齐依据后复核"}</summary><div className="manual-voucher-posting">
                {(!evidenceAssessment.complete || evidenceTask) && <p><WarningCircle size={15} />{evidenceTask?.message || evidenceAssessment.issues.map((issue) => issue.message).join("；")}<button className="secondary-button" type="button" onClick={() => loadDraft(voucher)}>载入补件</button></p>}
                {editing && <p><WarningCircle size={15} />当前凭证正在上方修改；请先保存或取消修改。</p>}
                {!voucherValidation.balanced && <p><WarningCircle size={15} />当前草稿校验未通过，不能入账：{voucherValidation.errors.join("；")}</p>}
                <label><span>复核意见 *</span><textarea value={reviewNotes[voucher.id] || ""} onChange={(event) => setReviewNotes((notes) => ({ ...notes, [voucher.id]: event.target.value }))} placeholder="写明已核对的分录、资料与入账结论" /></label>
                <button className="primary-button" type="button" disabled={busy || editing || !voucherValidation.balanced || !evidenceAssessment.complete || !String(reviewNotes[voucher.id] || "").trim()} onClick={() => postDraft(voucher)}><CheckCircle size={16} />{busy ? "正在核验原件…" : "核验原件并复核入账"}</button>
                {voucher.revisionOf && <button className="secondary-button" type="button" disabled={busy || !String(reviewNotes[voucher.id] || "").trim()} onClick={() => cancelRevision(voucher)}>按所填意见取消更正草稿</button>}
              </div></details>}
              {voucher.status === "posted" && <details className="manual-voucher-posting-details"><summary>更正此凭证</summary><div className="manual-voucher-posting"><label><span>更正原因</span><textarea value={reviewNotes[voucher.id] || ""} onChange={(event) => setReviewNotes((notes) => ({ ...notes, [voucher.id]: event.target.value }))} placeholder="原凭证保留，新的更正草稿复核入账后替代原版本" /></label><button className="secondary-button" type="button" disabled={busy || !String(reviewNotes[voucher.id] || "").trim()} onClick={() => createRevision(voucher)}>创建更正草稿</button></div></details>}
            </article>
          );
        })}</div> : <div className="manual-voucher-empty"><Receipt size={20} /><strong>本期还没有手工凭证</strong><p>点击“录入手工凭证”开始；可先保存草稿，再补齐依据。</p></div>}
      </section>
    </section>
  );
}
