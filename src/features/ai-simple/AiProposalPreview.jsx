import { BUSINESS_EVENT_INVOICE_STATUSES, BUSINESS_EVENT_TAX_TREATMENTS } from "../reconciliation/reconciliationEngine.js";
import { workspaceAccountDefinitions } from "../../domain/accounting/model.js";

const money = (value) => value == null || value === "" ? "未填写" : Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fieldLabels = { invoiceNumber: "发票号码", invoiceDate: "开票日期", counterparty: "交易对方", amount: "金额", taxAmount: "税额", taxRate: "税率" };
const labelFor = (options, value) => options.find((option) => option.id === value)?.label || "待确认";

function Details({ rows }) {
  return <dl className="ai-proposal-preview">{rows.map(([label, value]) => <div className="ai-proposal-field" key={label}><dt>{label}</dt><dd>{value === "" || value == null ? "未填写" : value}</dd></div>)}</dl>;
}

export function BankPreview({ preview }) {
  const transactions = preview.transactions || [];
  return <>
    <Details rows={[["原件", preview.fileName], ["银行账户", preview.accountName], ["本次可导入", `${preview.importedCount || 0} 笔`], ["重复记录", `${preview.duplicateCount || 0} 笔`], ["需修正记录", `${preview.errorCount || 0} 笔`]]} />
    {!!transactions.length && <div className="ai-preview-table-wrap"><table className="ai-preview-table"><caption>流水预览{preview.importedCount > transactions.length ? `（前 ${transactions.length} 笔，共 ${preview.importedCount} 笔可导入）` : ""}</caption><thead><tr><th>日期</th><th>交易对方 / 摘要</th><th>金额（元）</th><th>余额（元）</th></tr></thead><tbody>{transactions.map((row, index) => <tr key={row.id || index}><td>{row.date}</td><td>{row.counterparty || "对方待补充"}<small>{row.summary}</small></td><td>{money(row.amount)}</td><td>{money(row.balance)}</td></tr>)}</tbody></table></div>}
    {!!preview.errors?.length && <ul className="ai-preview-errors">{preview.errors.map((error, index) => <li key={index}>{typeof error === "string" ? error : `${error.rowNumber ? `第 ${error.rowNumber} 行：` : ""}${error.message || error.reason || "该行需要核对"}`}</li>)}</ul>}
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
  const accounts = workspaceAccountDefinitions(workspace);
  const transaction = preview.transaction;
  const voucher = preview.voucher;
  return <>
    <Details rows={[["交易日期", transaction.date], ["交易对方", preview.counterparty || transaction.counterparty], ["摘要", transaction.summary], ["交易金额", `${money(transaction.amount)} 元`], ["业务归属", preview.businessTypeLabel], ["会计科目", preview.accountLabel], ["税务处理", labelFor(BUSINESS_EVENT_TAX_TREATMENTS, preview.taxTreatment)], ["发票状态", labelFor(BUSINESS_EVENT_INVOICE_STATUSES, preview.invoiceStatus)], ...(preview.referenceNo ? [["业务编号", preview.referenceNo]] : [])]} />
    {voucher?.lines?.length > 0 && <div className="ai-preview-table-wrap"><table className="ai-preview-table"><caption>拟生成凭证分录 · {voucher.summary || preview.businessTypeLabel}</caption><thead><tr><th>科目</th><th>借方（元）</th><th>贷方（元）</th></tr></thead><tbody>{voucher.lines.map((line, index) => <tr key={line.id || index}><td>{accounts.find((account) => account.id === line.account)?.label || "科目待确认"}{line.auxiliaryLabel && <small>{line.auxiliaryLabel}</small>}</td><td>{money(line.debit || 0)}</td><td>{money(line.credit || 0)}</td></tr>)}</tbody></table></div>}
    {preview.draftIssue?.message && <p className="ai-notice">凭证还需补充：{preview.draftIssue.message}。本次仅确认业务归属，补齐后再生成凭证。</p>}
  </>;
}
