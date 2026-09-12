import { useEffect, useState } from "react";
import { BUSINESS_EVENT_INVOICE_STATUSES, BUSINESS_EVENT_TAX_TREATMENTS, manualBusinessEventTypesForWorkspace } from "../reconciliation/reconciliationEngine.js";
import { workspaceAccountDefinitions } from "../../domain/accounting/model.js";
import { buildProposalUpdates, invoiceFieldLabels, periodTransactions, proposalAccountLabel, proposalEditValues } from "./aiWorkflow.js";

const money = (value) => value == null || value === "" ? "未填写" : Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fieldLabels = invoiceFieldLabels;
const labelFor = (options, value) => options.find((option) => option.id === value)?.label || "待确认";

function Details({ rows }) {
  return <dl className="ai-proposal-preview">{rows.map(([label, value]) => <div className="ai-proposal-field" key={label}><dt>{label}</dt><dd>{value === "" || value == null ? "未填写" : value}</dd></div>)}</dl>;
}

export function BankPreview({ preview }) {
  const transactions = preview.transactions || [];
  return <>
    <Details rows={[["原件", preview.fileName], ["银行账户", preview.accountName], ["本次可导入", `${preview.importedCount || 0} 笔`], ["重复记录", `${preview.duplicateCount || 0} 笔`], ["需修正记录", `${preview.errorCount || 0} 笔`]]} />
    {!!preview.missingFields?.length && <p className="ai-error">还缺少列对应关系：{preview.missingFields.map((key) => preview.mappingFields?.[key]?.label || key).join("、")}。</p>}
    {!!transactions.length && <div className="ai-preview-table-wrap"><table className="ai-preview-table"><caption>流水预览{preview.importedCount > transactions.length ? `（前 ${transactions.length} 笔，共 ${preview.importedCount} 笔可导入）` : ""}</caption><thead><tr><th>日期</th><th>交易对方 / 摘要</th><th>金额（元）</th><th>余额（元）</th></tr></thead><tbody>{transactions.map((row, index) => <tr key={row.id || index}><td>{row.date}</td><td>{row.counterparty || "对方待补充"}<small>{row.summary}</small></td><td>{money(row.amount)}</td><td>{money(row.balance)}</td></tr>)}</tbody></table></div>}
    {!!preview.errors?.length && <ul className="ai-preview-errors">{preview.errors.map((error, index) => <li key={index}>{typeof error === "string" ? error : `${error.rowNumber ? `第 ${error.rowNumber} 行：` : ""}${error.message || error.reason || "该行需要核对"}`}</li>)}</ul>}
    {!!preview.rows?.length && <div className="ai-preview-table-wrap"><table className="ai-preview-table"><caption>原文件样例行</caption><thead><tr><th>行号</th>{preview.headers.map((header, index) => <th key={index}>{header}</th>)}</tr></thead><tbody>{preview.rows.map((row) => <tr key={row.rowNumber}><th>{row.rowNumber}</th>{row.cells.map((cell, index) => <td key={index}>{String(cell.value ?? "")}</td>)}</tr>)}</tbody></table></div>}
    {preview.headers?.length > 0 && <details className="ai-preview-mapping"><summary>查看列对应关系</summary><Details rows={Object.entries(preview.mapping || {}).filter(([, column]) => Number.isInteger(column) && column >= 0).map(([key, column]) => [preview.mappingFields?.[key]?.label || "数据列", preview.headers[column] || "未选择"])} /></details>}
  </>;
}

export function proposalHasPreview(proposal) {
  if (proposal.kind === "bank_import") return !!proposal.preview && Array.isArray(proposal.preview.transactions);
  if (proposal.kind === "document_fields") return Array.isArray(proposal.preview?.fields) && proposal.preview.fields.length > 0;
  if (proposal.kind === "bank_business") return !!proposal.preview?.transaction && !!proposal.preview?.businessTypeLabel;
  return false;
}

export function AiProposalPreview({ proposal, workspace }) {
  const preview = proposal.preview;
  if (!proposalHasPreview(proposal)) return <p className="ai-error">这条建议缺少可核对的明细，请暂不采用并让助手重新整理。</p>;
  if (proposal.kind === "bank_import") return <BankPreview preview={preview} />;
  if (proposal.kind === "document_fields") return <><Details rows={[["原件", preview.name], ["类别", preview.category]]} /><div className="ai-preview-table-wrap"><table className="ai-preview-table"><caption>本次字段修改</caption><thead><tr><th>字段</th><th>当前内容</th><th>建议内容</th></tr></thead><tbody>{preview.fields.map((field) => <tr key={field.key}><th scope="row">{fieldLabels[field.key] || "票据字段"}</th><td>{field.before == null || field.before === "" ? "未填写" : String(field.before)}</td><td>{field.after == null || field.after === "" ? "未填写" : String(field.after)}</td></tr>)}</tbody></table></div></>;
  const transaction = preview.transaction;
  const voucher = preview.voucher;
  return <>
    <Details rows={[["交易日期", transaction.date], ["交易对方", preview.counterparty || transaction.counterparty], ["摘要", transaction.summary], ["交易金额", `${money(transaction.amount)} 元`], ["业务归属", preview.businessTypeLabel], ["会计科目", preview.accountLabel], ["税务处理", labelFor(BUSINESS_EVENT_TAX_TREATMENTS, preview.taxTreatment)], ["发票状态", labelFor(BUSINESS_EVENT_INVOICE_STATUSES, preview.invoiceStatus)], ...(preview.referenceNo ? [["业务编号", preview.referenceNo]] : [])]} />
    {voucher?.lines?.length > 0 && <div className="ai-preview-table-wrap"><table className="ai-preview-table"><caption>拟生成凭证分录 · {voucher.summary || preview.businessTypeLabel}</caption><thead><tr><th>科目</th><th>借方（元）</th><th>贷方（元）</th></tr></thead><tbody>{voucher.lines.map((line, index) => <tr key={line.id || index}><td>{proposalAccountLabel(workspace, line.account)}{line.auxiliaryLabel && <small>{line.auxiliaryLabel}</small>}</td><td>{money(line.debit || 0)}</td><td>{money(line.credit || 0)}</td></tr>)}</tbody></table></div>}
    {preview.draftIssue?.message && <p className="ai-notice">凭证还需补充：{preview.draftIssue.message}。本次仅确认业务归属，补齐后再生成凭证。</p>}
  </>;
}

export function AiProposalEditor({ proposal, workspace, busy, onSave, onCancel, onDirtyChange }) {
  const [initial] = useState(() => proposalEditValues(proposal));
  const [values, setValues] = useState(initial);
  const [error, setError] = useState("");
  const [failedPreview, setFailedPreview] = useState(null);
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  const preview = proposal.preview || {};
  const documents = (workspace.documents || []).filter((item) => item.period === workspace.currentPeriod);
  const types = manualBusinessEventTypesForWorkspace(workspace);
  const accounts = workspaceAccountDefinitions(workspace);
  function change(group, key, value) { setValues((current) => ({ ...current, [group]: { ...current[group], [key]: value } })); setFailedPreview(null); setError(""); }
  async function save(event) {
    event.preventDefault(); setError("");
    try {
      const result = await onSave(proposal.id, buildProposalUpdates(proposal.kind, values));
      if (result?.status !== "pending_confirmation") { setFailedPreview(result?.preview || null); setError(result?.message || "修改尚不能生成可确认预览，请继续修正。"); }
    } catch (caught) { setError(caught.message || "修改未保存，请核对后继续。"); }
  }
  function select(label, group, key, options, optional = false) {
    return <label className="ai-field" key={key}><span>{label}{optional ? "（可选）" : ""}</span><select value={values[group]?.[key] ?? ""} onChange={(event) => change(group, key, event.target.value)} disabled={busy} required={!optional}><option value="">{optional ? "不关联" : "请选择"}</option>{options.map((option) => <option key={option.id} value={option.id}>{option.label || option.name}</option>)}</select></label>;
  }
  const classification = values.classification || {};
  return <form className="ai-proposal-editor" onSubmit={save}>
    <p className="ai-helper">修改后先重新计算预览，核对新的内容后再确认。</p>
    {proposal.kind === "bank_import" && <><p className="ai-helper">日期必须选择；金额可选一列正负金额，或分别选择收入、支出列。未使用的列保持“不使用”。</p><div className="ai-proposal-edit-grid">{Object.entries(preview.mappingFields || {}).map(([key, field]) => <label className="ai-field" key={key}><span>{field.label}</span><select disabled={busy} value={values.mapping?.[key] ?? ""} onChange={(event) => change("mapping", key, event.target.value)}><option value="">不使用</option>{(preview.headers || []).map((header, index) => <option value={index} key={index}>第 {index + 1} 列 · {header}</option>)}</select></label>)}</div></>}
    {proposal.kind === "document_fields" && <><div className="ai-proposal-edit-grid">{Object.entries(values.fields || {}).map(([key, value]) => <label className="ai-field" key={key}><span>{fieldLabels[key] || key}</span><input disabled={busy} type={key === "invoiceDate" ? "date" : "text"} inputMode={["amount", "taxAmount", "taxRate"].includes(key) ? "decimal" : undefined} value={value ?? ""} onChange={(event) => change("fields", key, event.target.value)} /></label>)}</div>{(preview.allowedFields || []).some((key) => !Object.hasOwn(values.fields || {}, key)) && <label className="ai-field"><span>补充其他票据字段</span><select disabled={busy} value="" onChange={(event) => { if (event.target.value) change("fields", event.target.value, documents.find((item) => item.id === preview.documentId)?.structuredData?.[event.target.value] ?? ""); }}><option value="">选择字段</option>{preview.allowedFields.filter((key) => !Object.hasOwn(values.fields || {}, key)).map((key) => <option key={key} value={key}>{fieldLabels[key] || key}</option>)}</select></label>}</>}
    {proposal.kind === "bank_business" && <>
      <p className="ai-notice">原流水：{preview.transaction?.date} · {money(preview.transaction?.amount)} 元。交易金额与日期保持原始记录。</p>
      <div className="ai-proposal-edit-grid">
        {select("业务类型", "classification", "businessType", types)}
        {select("会计科目", "classification", "account", accounts)}
        {select("税务处理", "classification", "taxTreatment", BUSINESS_EVENT_TAX_TREATMENTS)}
        {select("发票状态", "classification", "invoiceStatus", BUSINESS_EVENT_INVOICE_STATUSES)}
        <label className="ai-field"><span>交易对方</span><input disabled={busy} value={classification.counterparty ?? ""} placeholder={preview.transaction?.counterparty || "按真实资料填写"} onChange={(event) => change("classification", "counterparty", event.target.value)} /></label>
        <label className="ai-field"><span>业务编号（按所选业务要求）</span><input disabled={busy} value={classification.referenceNo ?? ""} onChange={(event) => change("classification", "referenceNo", event.target.value)} /></label>
        {select("关联账单", "classification", "relatedBillId", (workspace.bills || []).filter((bill) => (bill.period || bill.businessPeriod || bill.date?.slice(0, 7)) <= workspace.currentPeriod && !["cancelled", "void"].includes(bill.status)).map((bill) => ({ id: bill.id, label: [bill.number || bill.billNo || bill.referenceNo, bill.counterparty || bill.summary, money(bill.amount)].filter(Boolean).join(" · ") })), true)}
        {select("关联流水", "classification", "relatedTransactionId", periodTransactions(workspace).filter((item) => item.id !== preview.transaction?.id).map((item) => ({ id: item.id, label: `${item.date} · ${item.counterparty || item.summary || "对方待补充"} · ${money(item.amount)}元` })), true)}
      </div>
      <fieldset className="ai-proposal-evidence" disabled={busy}><legend>支持这次判断的原件</legend>{documents.length ? documents.map((document) => <label key={document.id}><input type="checkbox" checked={(classification.evidenceIds || []).includes(document.id)} onChange={(event) => change("classification", "evidenceIds", event.target.checked ? [...(classification.evidenceIds || []), document.id] : (classification.evidenceIds || []).filter((id) => id !== document.id))} /><span>{document.name}</span></label>) : <p className="ai-helper">本期还没有原件，请先上传对应资料。</p>}</fieldset>
      <label className="ai-field"><span>判断依据</span><textarea required disabled={busy} value={classification.reason || ""} onChange={(event) => change("classification", "reason", event.target.value)} /></label>
    </>}
    {error && <p className="ai-error" role="alert">{error}</p>}
    {failedPreview && <div className="ai-proposal-revision-preview"><BankPreview preview={failedPreview} /></div>}
    <div className="ai-dialog-actions ai-proposal-edit-actions"><button type="button" className="ai-text-button" disabled={busy} onClick={onCancel}>取消修改</button><button className="ai-primary-button" type="submit" disabled={busy || !dirty}>{busy ? "正在重新计算…" : "保存修改并重算预览"}</button></div>
  </form>;
}
