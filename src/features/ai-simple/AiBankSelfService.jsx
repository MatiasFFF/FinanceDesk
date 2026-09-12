import { useEffect, useState } from "react";
import { bankAccountDraft, bankAccountLabel, bankGroupView, bankMoney, bankSaveErrorMessage } from "./aiBankSelfService.js";

export function BankGroupSummary({ proposals, alreadyImportedGroups = [], busy, onReview }) {
  const groups = [...proposals.filter((proposal) => proposal.kind === "bank_import" && proposal.preview?.group), ...alreadyImportedGroups.map((item) => ({
    id: `readback-${item.documentId}-${item.sourceGroupId}`, kind: "bank_import", status: "already_imported", preview: item,
  }))];
  if (!groups.length) return null;
  return <div className="ai-bank-summary ai-preview-table-wrap"><table className="ai-preview-table">
    <caption>原表分账户核对 · {groups.length} 组</caption>
    <thead><tr><th>银行 / 账户</th><th>原表行数</th><th>原表收入（去重，元）</th><th>原表支出（去重，元）</th><th>状态</th></tr></thead>
    <tbody>{groups.map((proposal) => { const view = bankGroupView(proposal); return <tr key={proposal.id}>
      <th scope="row">{view.label}<small>{view.dateRange}</small></th><td>{view.rowCount ?? "待核对"}</td><td>{bankMoney(view.summary.income)}</td><td>{bankMoney(view.summary.expense)}</td>
      <td><span>{view.status}</span>{proposal.status === "pending" && <button type="button" className="ai-text-button" disabled={busy} onClick={() => onReview(proposal.id)}>查看核对</button>}</td>
    </tr>; })}</tbody>
  </table></div>;
}

export function BankAccountResolution({ proposal, workspace, busy, onResolve, onDirtyChange }) {
  const { resolution } = bankGroupView(proposal);
  const suggested = resolution.suggestedAccount || {};
  const [initial] = useState(() => bankAccountDraft(proposal, workspace));
  const { candidates, mustChoose } = initial;
  const [editing, setEditing] = useState(mustChoose);
  const [accountId, setAccountId] = useState(initial.accountId);
  const [name, setName] = useState(initial.name);
  const [accountNumber, setAccountNumber] = useState(initial.accountNumber);
  const [error, setError] = useState("");
  const dirty = editing && (accountId !== initial.accountId || name !== initial.name || accountNumber !== initial.accountNumber);
  useEffect(() => { onDirtyChange(proposal.id, dirty); return () => onDirtyChange(proposal.id, false); }, [proposal.id, dirty, onDirtyChange]);
  if (!resolution.status) return null;
  if (!editing) return <div className="ai-bank-account-resolution"><p className="ai-helper">{resolution.status === "new" ? `原表识别到账户：${bankAccountLabel(suggested)}。确认本组时创建账户并导入。` : `导入到账户：${bankAccountLabel((workspace.bankAccounts || []).find((account) => account.id === resolution.accountId) || { name: proposal.preview.accountName })}。`}</p><button type="button" className="ai-text-button" disabled={busy} onClick={() => setEditing(true)}>更换账户</button></div>;
  return <form className="ai-bank-account-resolution ai-settings-form" onSubmit={async (event) => {
    event.preventDefault(); if (busy) return; setError("");
    try { const result = await onResolve(proposal.id, accountId === "new" ? { name: name.trim(), accountNumber: accountNumber.trim() } : { accountId });
      if (!result?.proposal && !result?.proposals?.length) setError(result?.message || "账户尚未确认，请核对后继续。");
    } catch (caught) { setError(bankSaveErrorMessage(caught)); }
  }}>
    <p className="ai-helper">{resolution.status === "ambiguous" ? "有多个可能匹配的账户，请确认这组流水属于哪一个。" : "请确认这组流水的银行账户。"}</p>
    <label className="ai-field"><span>流水所属账户</span><select required value={accountId} disabled={busy} onChange={(event) => setAccountId(event.target.value)}><option value="">选择账户</option>{candidates.map((account) => <option key={account.id} value={account.id}>{bankAccountLabel(account)}</option>)}<option value="new">添加这组流水的银行账户</option></select></label>
    {accountId === "new" && <div className="ai-proposal-edit-grid"><label className="ai-field"><span>账户名称</span><input required value={name} disabled={busy} placeholder="例如：海湾银行公司账户" onChange={(event) => setName(event.target.value)} /></label><label className="ai-field"><span>账号后四位</span><input required value={accountNumber} pattern="[0-9]{4}" maxLength={4} inputMode="numeric" disabled={busy} autoComplete="off" onChange={(event) => setAccountNumber(event.target.value.replace(/\D/g, ""))} /></label></div>}
    {error && <p className="ai-error" role="alert">{error}</p>}
    <div className="ai-dialog-actions">{!mustChoose && <button type="button" className="ai-text-button" disabled={busy} onClick={() => setEditing(false)}>取消更换</button>}<button type="submit" className="ai-primary-button" disabled={busy || !accountId || accountId === "new" && (!name.trim() || !/^\d{4}$/.test(accountNumber))}>{busy ? "正在重新核对…" : "确认账户并重新核对"}</button></div>
  </form>;
}
