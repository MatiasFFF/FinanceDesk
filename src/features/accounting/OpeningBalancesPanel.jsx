import { useEffect, useRef, useState } from "react";
import { workspaceAccountDefinitions } from "../../domain/accounting/model.js";
import { isPeriodArchived, openingBalancesReady } from "../../domain/periods.js";
import { usePeriodLeaveGuard } from "../workspaces/periodNavigation.js";

export function OpeningBalancesPanel({ workspace, onSave, focusRequest }) {
  const [open, setOpen] = useState(false);
  const [balances, setBalances] = useState(workspace.openingLedger || {});
  const [error, setError] = useState("");
  const panelRef = useRef(null);
  const openingSignature = JSON.stringify(workspace.openingLedger || {});
  useEffect(() => {
    setOpen(false);
    setBalances(workspace.openingLedger || {});
    setError("");
  }, [workspace.id, workspace.currentPeriod, openingSignature]);
  useEffect(() => {
    if (focusRequest?.section !== "opening-balances") return;
    setOpen(true);
    window.requestAnimationFrame(() => {
      panelRef.current?.focus({ preventScroll: true });
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [focusRequest]);
  usePeriodLeaveGuard({ dirty: open && JSON.stringify(balances) !== JSON.stringify(workspace.openingLedger || {}) });
  if (isPeriodArchived(workspace)) return null;
  const ready = openingBalancesReady(workspace);
  const definitions = workspaceAccountDefinitions(workspace);
  const accounts = definitions.filter((account) => ["asset", "contraAsset", "liability", "equity"].includes(account.category)
    || Number(balances[account.id] || 0) !== 0);
  const unknown = Object.keys(balances).filter((id) => !definitions.some((account) => account.id === id));
  const rows = [...accounts, ...unknown.map((id) => ({ id, label: id }))];
  function save(event) {
    event.preventDefault();
    try { onSave(balances); setOpen(false); setError(""); }
    catch (caught) { setError(caught.message); }
  }
  return (
    <section className="panel period-opening-panel" id="opening-balances" ref={panelRef} tabIndex={-1}>
      <div className="panel-heading"><div><h2>本期期初余额</h2><p>{workspace.openingStatus?.message || (ready ? (workspace.openingCarryForward ? `已从 ${workspace.openingCarryForward.fromPeriod} 结转` : "已确认") : "可先处理本期业务；冻结报表前需要确认期初余额。")}</p></div><button className="secondary-button" type="button" onClick={() => setOpen((value) => !value)}>{open ? "收起" : ready ? "查看与调整" : "核对期初"}</button></div>
      {open && <form onSubmit={save}>
        <p>借方余额填正数，贷方余额填负数；确无期初余额时，保留零并确认。</p>
        {workspace.openingStatus?.suggestedLedger && <button className="text-button" type="button" onClick={() => setBalances(workspace.openingStatus.suggestedLedger)}>填入上期结转的科目余额</button>}
        <div className="period-opening-grid">{rows.map((account) => <label key={account.id}><span>{account.label}</span><input type="number" step="0.01" value={balances[account.id] ?? ""} placeholder="0.00" onChange={(event) => setBalances((current) => ({ ...current, [account.id]: event.target.value }))} /></label>)}</div>
        {error && <p role="alert" className="foundation-error">{error}</p>}
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => { setBalances(workspace.openingLedger || {}); setOpen(false); }}>取消</button><button className="primary-button" type="submit">确认期初余额</button></div>
      </form>}
    </section>
  );
}
