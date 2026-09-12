import { useEffect, useMemo, useRef, useState } from "react";
import { aiReportMoney as money, buildAiReportModel } from "./aiReportModel.js";

function VoucherSource({ entry, cash = false, onVouchers }) {
  return <li>
    <button className="ai-inline-button" type="button" onClick={() => onVouchers?.({ voucherId: entry.voucherId })} aria-label={`查看凭证 ${entry.voucherNo || entry.voucherId}`}>{entry.voucherNo || entry.voucherId}</button>
    <span>{entry.date} · {entry.summary || "无摘要"}</span>
    <span className="ai-report-entry-amount">{cash ? `${money(entry.amount)} 元` : `借 ${money(entry.debit)} · 贷 ${money(entry.credit)}`}</span>
  </li>;
}

function AccountDetails({ section, onVouchers }) {
  const lines = section.details.filter((line) => line.entries.length || line.account.opening !== 0);
  if (!lines.length) return null;
  return <details className="ai-report-details"><summary>科目与凭证来源</summary>
    {lines.map((line) => <details className="ai-report-account" key={line.id}>
      <summary><span className="ai-report-account-name"><span className="ai-report-account-code">{line.group}</span>{line.label}</span><strong>{money(line.value)}</strong></summary>
      <p className="ai-helper">科目 {line.id}{section.id === "balance" ? ` · 期初余额 ${money(line.account.opening)} 元（借方为正、贷方为负）` : " · 本期发生额"}</p>
      {line.entries.length ? <ul className="ai-report-sources">{line.entries.map((entry, index) => <VoucherSource key={`${entry.voucherId}-${index}`} entry={entry} onVouchers={onVouchers} />)}</ul>
        : <p className="ai-helper">仅有期初余额，本期没有该科目的已入账凭证。</p>}
    </details>)}
    {section.id === "balance" && <p className="ai-helper">所有者权益中的本期利润，可在利润表查看收入、成本与费用的凭证来源。</p>}
  </details>;
}

function CashDetails({ section, onVouchers }) {
  const groups = section.cashGroups.filter((group) => group.entries.length);
  if (!groups.length) return null;
  return <details className="ai-report-details"><summary>现金变动与凭证来源</summary>
    {groups.map((group) => <details className="ai-report-account" key={group.id}>
      <summary><span className="ai-report-account-name">{group.label}<span className="ai-report-account-code">{group.entries.length} 笔</span></span><strong>{money(group.value)}</strong></summary>
      <ul className="ai-report-sources">{group.entries.map((entry) => <VoucherSource key={entry.id} entry={entry} cash onVouchers={onVouchers} />)}</ul>
      {group.id === "pending" && <p className="ai-helper">{[...new Set(group.entries.map((entry) => entry.reason).filter(Boolean))].join("；") || "请核对凭证对应业务的现金流用途。"}</p>}
    </details>)}
  </details>;
}

export default function AiReports({ workspace, onVouchers, onToast }) {
  const model = useMemo(() => buildAiReportModel(workspace), [workspace]);
  const [selected, setSelected] = useState("income");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const currentModel = useRef(model);
  const mounted = useRef(true);
  currentModel.current = model;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setError(""); }, [workspace.id, workspace.currentPeriod]);
  const section = model.sections.find((item) => item.id === selected);

  async function exportExcel() {
    setError("");
    setExporting(true);
    const exportedModel = model;
    try {
      const { generateAiReportExcel, downloadAiReportExcel } = await import("./aiReportExcel.js");
      const generated = await generateAiReportExcel(exportedModel);
      if (!mounted.current) return;
      if (currentModel.current !== exportedModel) throw new Error("本期数据已更新，请重新导出当前报表。");
      downloadAiReportExcel(generated);
      onToast?.("已发起本期核对稿下载，文件包含三张报表、来源明细与核对状态。");
    } catch (caught) {
      if (mounted.current) setError(caught.message || "Excel 导出失败，请重试。");
    } finally {
      if (mounted.current) setExporting(false);
    }
  }

  return <div className="ai-reports">
    <div className="ai-report-toolbar">
      <div className="ai-report-context"><h3>{model.period} 本期报表</h3><p>{model.postedCount} 张已入账凭证{model.archived ? " · 已归档，只读" : ""}<button className="ai-inline-button" type="button" onClick={() => onVouchers?.({})}>查看凭证</button></p></div>
      <button className="ai-secondary-button" type="button" disabled={exporting} onClick={exportExcel}>{exporting ? "正在生成 Excel…" : "导出本期 Excel"}</button>
    </div>
    <p className="ai-helper">{model.basis}</p>
    {model.notes.length > 0 && <div className="ai-report-status ai-notice" role="status"><h4>本期仍有 {model.notes.length} 项待核对</h4><ul>{model.notes.map((note) => <li key={note.id}>
      <strong>{note.title}</strong><p>{note.detail}</p>
      {note.voucherIds.length > 0 && <button className="ai-inline-button" type="button" onClick={() => onVouchers?.({ voucherId: note.voucherIds[0] })}>{note.id === "pendingVouchers" ? "复核待入账凭证" : "查看相关凭证"}</button>}
    </li>)}</ul></div>}
    <nav className="ai-report-tabs" aria-label="选择财务报表">{model.sections.map((item) => <button type="button" key={item.id} className={selected === item.id ? "is-active" : ""} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>{item.title}</button>)}</nav>
    {!model.postedCount && <p className="ai-report-empty">{model.hasOpeningBalances ? "本期尚无已入账凭证；资产负债与现金余额包含期初余额。" : "本期暂无已入账金额。凭证复核入账后，报表会随之更新。"}</p>}
    <section className="ai-report-section" aria-label={section.title}>
      <h3>{section.title}</h3>
      <div className="ai-report-table-wrap"><table><thead><tr><th scope="col">项目</th><th scope="col">金额（元）</th></tr></thead><tbody>{section.rows.map((row) => <tr key={row.id} className={[row.total && "is-total", row.warning && "is-warning"].filter(Boolean).join(" ")}><th scope="row">{row.label}</th><td>{money(row.value)}</td></tr>)}</tbody></table></div>
      {section.id === "cashflow" ? <CashDetails key={`${model.period}-cash`} section={section} onVouchers={onVouchers} /> : <AccountDetails key={`${model.period}-${section.id}`} section={section} onVouchers={onVouchers} />}
    </section>
    <p className="ai-report-export-note">导出为本期核对稿，包含未完成状态与来源引用；不代表报表已冻结或本期已确认。</p>
    {error && <p className="ai-error" role="alert">{error}</p>}
  </div>;
}
