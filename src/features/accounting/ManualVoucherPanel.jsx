import { useEffect, useId, useMemo, useRef, useState } from "react";
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
  createManualVoucherDraft,
  postVoucher,
  reviseDraftVoucher,
  validateVoucherBalance,
  workspaceAccountDefinitions,
} from "../../domain/accounting/index.js";
import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
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

export function ManualVoucherPanel({ onToast }) {
  const { activeWorkspace, actions, state, store } = useFinanceDesk();
  const [editor, setEditor] = useState(() => emptyEditor(activeWorkspace));
  const [reviewNotes, setReviewNotes] = useState({});
  const [error, setError] = useState("");
  const editorRef = useRef(null);
  const departmentListId = useId();
  const projectListId = useId();

  const accounts = useMemo(() => activeWorkspace ? accountOptions(activeWorkspace) : [], [activeWorkspace]);
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
    setEditor(emptyEditor(activeWorkspace));
    setReviewNotes({});
    setError("");
  }, [activeWorkspace?.id, activeWorkspace?.currentPeriod]);

  if (!activeWorkspace) return null;

  const actor = actorName(state, activeWorkspace);
  const dateBelongsToPeriod = /^\d{4}-\d{2}-\d{2}$/.test(editor.date)
    && editor.date.startsWith(`${activeWorkspace.currentPeriod}-`);
  const canSave = dateBelongsToPeriod
    && editor.summary.trim().length > 0
    && validation.balanced
    && (!editor.voucherId || editor.revisionReason.trim().length > 0);

  function resetEditor({ scroll = false } = {}) {
    setEditor(emptyEditor(activeWorkspace));
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
    setEditor({
      voucherId: voucher.id,
      date: voucher.date,
      summary: voucher.summary || "",
      lines: (voucher.lines || []).map(createEditableLine),
      evidenceIds: [...(voucher.evidenceIds || [])],
      revisionReason: "",
    });
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
          reason: editor.revisionReason.trim(),
        }, { actor, mode: "manual" })
        : createManualVoucherDraft(current, {
          date: editor.date,
          summary: editor.summary.trim(),
          lines: preparedLines,
          evidenceIds: editor.evidenceIds,
        }, { actor, mode: "manual" });
      actions.replaceWorkspace(current.id, next);
      onToast?.(editor.voucherId ? "手工凭证草稿修订已保存" : "手工凭证草稿已保存");
      setEditor(emptyEditor(next));
    } catch (caught) {
      setError(caught.message || "手工凭证草稿保存失败");
    }
  }

  function postDraft(voucher) {
    const reviewNote = String(reviewNotes[voucher.id] || "").trim();
    if (!reviewNote) {
      setError("人工入账前必须填写复核意见");
      return;
    }
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const next = postVoucher(current, { voucherId: voucher.id, reviewNote, mode: "manual" }, { actor, mode: "manual" });
      actions.replaceWorkspace(current.id, next);
      setReviewNotes((notes) => ({ ...notes, [voucher.id]: "" }));
      onToast?.("手工凭证已完成人工复核并入账");
    } catch (caught) {
      setError(caught.message || "手工凭证入账失败");
    }
  }

  return (
    <section className="manual-voucher-panel">
      <header className="manual-voucher-panel-heading">
        <div><p>本地会计处理</p><h2>手工凭证</h2><span>独立录入真实分录，保存草稿后必须填写复核意见才能人工入账。</span></div>
        <button className="secondary-button" type="button" onClick={() => resetEditor({ scroll: true })}><Plus size={16} />新建空白凭证</button>
      </header>

      {error && <div className="manual-voucher-error" role="alert"><WarningCircle size={18} /><span>{error}</span></div>}

      <form className="manual-voucher-editor" onSubmit={saveDraft} ref={editorRef}>
        <div className="manual-voucher-section-heading">
          <div><small>{editor.voucherId ? "修订已保存草稿" : "新建本期草稿"}</small><h3>{editor.voucherId ? "修改手工凭证" : "录入手工凭证"}</h3></div>
          {editor.voucherId && <span className="manual-voucher-editing-badge"><NotePencil size={15} />{editor.voucherId}</span>}
        </div>

        <div className="manual-voucher-header-fields">
          <label><span>凭证日期 *</span><input required readOnly={Boolean(editor.voucherId)} type="date" min={`${activeWorkspace.currentPeriod}-01`} max={periodEndDate(activeWorkspace.currentPeriod)} value={editor.date} onChange={(event) => setEditor((current) => ({ ...current, date: event.target.value }))} /><small>{editor.voucherId ? "已保存草稿的日期保持不变；换日期请新建草稿" : `必须属于当前账期 ${activeWorkspace.currentPeriod}`}</small></label>
          <label><span>凭证摘要 *</span><input required value={editor.summary} onChange={(event) => setEditor((current) => ({ ...current, summary: event.target.value }))} placeholder="说明本次凭证反映的业务或调整" /></label>
          {editor.voucherId && <label className="manual-voucher-reason"><span>修改原因 *</span><textarea required value={editor.revisionReason} onChange={(event) => setEditor((current) => ({ ...current, revisionReason: event.target.value }))} placeholder="说明本次修改的原因和依据" /></label>}
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
                  <label className="manual-voucher-source-field"><span>来源标识</span><input value={line.sourceIdsText} onChange={(event) => updateLine(line.clientId, { sourceIdsText: event.target.value })} placeholder="用逗号或分号分隔来源标识" /><small>{parseSourceIds(line.sourceIdsText).length ? `${parseSourceIds(line.sourceIdsText).length} 个来源标识` : "未设置分录来源"}</small></label>
                </div>
              </article>
            );
          })}
        </div>

        <div className={`manual-voucher-balance ${validation.balanced ? "is-balanced" : "is-invalid"}`}>
          <span>借方 ¥{money(validation.debit)}</span><span>贷方 ¥{money(validation.credit)}</span><span>税额 ¥{money(validation.taxTotal)}</span><strong>{validation.balanced ? "借贷平衡，可以保存" : `差额 ¥${money(Math.abs(validation.difference))}`}</strong>
        </div>
        {!validation.balanced && <div className="manual-voucher-validation-errors">{validation.errors.map((message) => <span key={message}>{message}</span>)}</div>}

        <fieldset className="manual-voucher-documents">
          <legend>关联当前工作台资料（可多选）</legend>
          {documents.length ? <div className="manual-voucher-document-list">{documents.map((document) => {
            const archived = document.archiveStatus === "archived" || ["archived", "已归档"].includes(document.lifecycleStatus);
            return <label key={document.id}><input type="checkbox" checked={editor.evidenceIds.includes(document.id)} onChange={(event) => toggleEvidence(document.id, event.target.checked)} /><span><strong>{documentLabel(document)}</strong><small>{document.category || document.type || "资料"} · {document.period || "未分期"}{archived ? " · 已归档" : ""}</small></span></label>;
          })}</div> : <p>当前工作台还没有可关联资料；可先保存不带资料的草稿。</p>}
        </fieldset>

        <div className="manual-voucher-editor-actions">
          {editor.voucherId && <button className="secondary-button" type="button" onClick={() => resetEditor()}>取消修改</button>}
          <button className="primary-button" type="submit" disabled={!canSave}><Receipt size={16} />{editor.voucherId ? "保存草稿修订" : "保存手工凭证草稿"}</button>
        </div>
      </form>

      <section className="manual-voucher-records">
        <div className="manual-voucher-section-heading"><div><small>{activeWorkspace.currentPeriod}</small><h3>本期手工凭证</h3></div><span>{manualVouchers.length} 张</span></div>
        {manualVouchers.length ? <div className="manual-voucher-record-list">{manualVouchers.map((voucher) => {
          const status = voucherStatus(voucher.status);
          const voucherValidation = validateVoucherBalance(voucher, accountingRules(activeWorkspace).amountTolerance, activeWorkspace);
          const editable = ["draft", "changes_requested"].includes(voucher.status);
          const editing = editor.voucherId === voucher.id;
          const evidence = (voucher.evidenceIds || []).map((id) => documents.find((document) => document.id === id));
          const latestReview = [...(voucher.reviews || [])].reverse()[0];
          return (
            <article className={`manual-voucher-record is-${status.tone}`} key={voucher.id}>
              <div className="manual-voucher-record-heading">
                <div><span className={`manual-voucher-status is-${status.tone}`}>{status.label}</span><small>{voucher.no || voucher.id} · V{voucher.version || 1}</small><h4>{voucher.summary}</h4><p>{voucher.date} · 借贷各 ¥{money(voucherValidation.debit)} · {voucher.lines?.length || 0} 行分录</p></div>
                {editable && <button className="secondary-button" type="button" disabled={editing} onClick={() => loadDraft(voucher)}><NotePencil size={15} />{editing ? "正在修改" : "载入修改"}</button>}
              </div>
              <details className="manual-voucher-record-details">
                <summary>查看分录与关联资料</summary>
                <div className="manual-voucher-read-lines">{(voucher.lines || []).map((line, index) => <div key={`${voucher.id}-line-${index}`}><span><strong>{accountLabel(activeWorkspace, accounts, line.account)}</strong><small>{[line.storeName, line.department, line.project].filter(Boolean).join(" · ") || "未设置经营维度"}</small><small>{line.sourceIds?.length ? `来源 ${line.sourceIds.join("、")}` : "未设置来源标识"}</small></span><span><small>借 ¥{money(line.debit)} · 贷 ¥{money(line.credit)}</small><strong>{line.taxAmount == null ? "无税额" : `税额 ¥${money(line.taxAmount)}`}</strong></span></div>)}</div>
                <div className="manual-voucher-evidence-summary"><FileText size={16} /><span><strong>关联资料</strong><small>{evidence.length ? evidence.map((document, index) => document ? documentLabel(document) : voucher.evidenceIds[index]).join("、") : "未关联资料"}</small></span></div>
                {latestReview && <div className="manual-voucher-review-record"><CheckCircle size={16} /><span><strong>{latestReview.actor || voucher.postedBy || "本地用户"} · {latestReview.decision === "approve" ? "已复核" : "已记录意见"}</strong><small>{latestReview.note} · {dateTime(latestReview.at || voucher.postedAt)}</small></span></div>}
              </details>
              {editable && <div className="manual-voucher-posting">
                {editing && <p><WarningCircle size={15} />当前凭证正在上方修改；请先保存或取消修改。</p>}
                {!voucherValidation.balanced && <p><WarningCircle size={15} />当前草稿校验未通过，不能入账：{voucherValidation.errors.join("；")}</p>}
                <label><span>复核意见 *</span><textarea value={reviewNotes[voucher.id] || ""} onChange={(event) => setReviewNotes((notes) => ({ ...notes, [voucher.id]: event.target.value }))} placeholder="写明已核对的分录、资料与入账结论" /></label>
                <button className="primary-button" type="button" disabled={editing || !voucherValidation.balanced || !String(reviewNotes[voucher.id] || "").trim()} onClick={() => postDraft(voucher)}><CheckCircle size={16} />人工复核并入账</button>
              </div>}
              {!editable && <div className="manual-voucher-readonly"><CheckCircle size={16} /><span><strong>该凭证为只读记录</strong><small>{voucher.status === "posted" ? `${voucher.postedBy || "本地用户"} 于 ${dateTime(voucher.postedAt)} 入账` : "历史版本不会被直接覆盖"}</small></span></div>}
            </article>
          );
        })}</div> : <div className="manual-voucher-empty"><Receipt size={24} /><strong>本期还没有手工凭证</strong><p>在上方录入至少两行借贷平衡的分录并保存草稿后，会出现在这里等待人工复核。</p></div>}
      </section>
    </section>
  );
}
