import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowLeft, MagnifyingGlass } from "@phosphor-icons/react";
import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import { AiDialog } from "./AiDialog.jsx";
import { filterTransactions, navigationTargetError, periodTransactions, rememberAiDocumentFocus, resolveAiResourceNavigation, resolveWorkbenchNavigation, transactionBrowseState } from "./aiWorkflow.js";

const Documents = lazy(() => import("../intake/DocumentIntakePanel.jsx").then((module) => ({ default: module.DocumentIntakePanel })));
const Accounting = lazy(() => import("../accounting/AccountingWorkbench.jsx").then((module) => ({ default: module.AccountingWorkbench })));
const BankImport = lazy(() => import("../intake/BankImportPanel.jsx").then((module) => ({ default: module.BankImportPanel })));
const Reports = lazy(() => import("./AiReports.jsx"));

export function allowAiPanelLeave() {
  const detail = { busy: false, dirty: false };
  window.dispatchEvent(new CustomEvent("financedesk:before-period-change", { detail }));
  if (detail.busy) throw new Error("资料正在保存或识别，请完成或取消后再离开。");
  return !detail.dirty || window.confirm("当前有尚未保存的编辑。确定离开并放弃这些编辑吗？");
}

export function AiResources({ initialTab = "documents", workspaceId, period, transactionId, documentId, voucherId, importId, importDocumentId, section, action, returnTo, resourceState, onRememberState, onOpenFullWorkbench, onClose, onToast }) {
  const { activeWorkspace } = useFinanceDesk();
  const [origin] = useState(() => ({ workspaceId: workspaceId || activeWorkspace.id, period: period || activeWorkspace.currentPeriod }));
  const [location, setLocation] = useState(() => resourceState?.location || { tab: voucherId ? "vouchers" : transactionId ? "transactions" : initialTab, detail: !!transactionId && !voucherId, options: { transactionId, documentId, voucherId, importId, importDocumentId, section, action, returnTo }, nonce: 1 });
  const { tab } = location;
  const selectedTransaction = location.options.transactionId || "";
  const [query, setQuery] = useState(resourceState?.query || "");
  const [filter, setFilter] = useState(resourceState?.filter || "all");
  const [limit, setLimit] = useState(resourceState?.limit || 50);
  const [reportSection, setReportSection] = useState(resourceState?.reportSection || "income");
  const [error, setError] = useState("");
  const historyRef = useRef([...(resourceState?.history || [])]);
  const listScrollRef = useRef(resourceState?.listScroll || 0);
  const listRef = useRef(null);
  const rememberStateRef = useRef(onRememberState);
  const snapshotRef = useRef(null);
  rememberStateRef.current = onRememberState;
  snapshotRef.current = snapshot;
  useEffect(() => () => rememberStateRef.current?.(snapshotRef.current()), []);
  function leave(action) { try { if (allowAiPanelLeave()) { setError(""); action(); } } catch (caught) { setError(caught.message); } }
  function snapshot() { return { location, history: [...historyRef.current], query, filter, limit, reportSection, listScroll: listScrollRef.current }; }
  function changeLocation(next, { remember = true } = {}) {
    if (tab === "transactions" && !location.detail) listScrollRef.current = listRef.current?.scrollTop || 0;
    if (remember) historyRef.current.push({ location, query, filter, limit, listScroll: listScrollRef.current });
    setLocation((current) => ({ ...current, ...next, nonce: current.nonce + 1 }));
  }
  function back() {
    leave(() => {
      if (tab === "transactions" && location.detail) {
        if (historyRef.current.at(-1)?.location.tab === "transactions" && !historyRef.current.at(-1)?.location.detail) historyRef.current.pop();
        changeLocation({ detail: false, options: { ...location.options, transactionId: "" } }, { remember: false }); return;
      }
      const previous = historyRef.current.pop();
      if (previous) { setLocation({ ...previous.location, nonce: location.nonce + 1 }); setQuery(previous.query); setFilter(previous.filter); setLimit(previous.limit); listScrollRef.current = previous.listScroll; }
    });
  }
  function openFull(page, options = {}) {
    try {
      const reason = navigationTargetError(activeWorkspace, { ...origin, options });
      if (reason) throw new Error(reason);
      if (!onOpenFullWorkbench) throw new Error("完整工作台入口尚未就绪，请稍后再打开。");
      const target = resolveWorkbenchNavigation(page, options);
      onOpenFullWorkbench(target.page, target.options, snapshot());
    } catch (caught) { setError(caught.message); }
  }
  function navigate(page, options = {}) {
    const target = resolveAiResourceNavigation(page, options);
    if (target.mode === "full") { openFull(target.page, target.options); return; }
    leave(() => {
      const reason = navigationTargetError(activeWorkspace, { ...origin, options });
      if (reason) throw new Error(reason);
      changeLocation({ tab: target.tab, detail: target.tab === "transactions" && !!options.transactionId, options: target.options });
      if (target.tab === "transactions" && (options.transactionId || options.importId || options.importDocumentId)) { setQuery(""); setFilter("all"); setLimit(50); }
    });
  }
  const transactions = periodTransactions(activeWorkspace);
  const batchFilter = location.options.importDocumentId || location.options.importId || "";
  const batchIds = new Set((activeWorkspace.bankImports || []).filter((record) => record.period === activeWorkspace.currentPeriod
    && (!location.options.importDocumentId || record.sourceDocumentId === location.options.importDocumentId)
    && (!location.options.importId || record.id === location.options.importId)).map((record) => record.id));
  const visible = filterTransactions(activeWorkspace, { query, status: filter }).filter((item) => !batchFilter || batchIds.has(item.importId));
  const targetError = navigationTargetError(activeWorkspace, { ...origin, options: location.options });
  const currentTransaction = transactions.find((item) => item.id === selectedTransaction);
  const currentDocument = activeWorkspace.documents?.find((item) => item.id === location.options.documentId);
  const currentVoucher = activeWorkspace.vouchers?.find((item) => item.id === location.options.voucherId);
  const objectLabel = tab === "transactions" && location.detail ? `${currentTransaction?.date || ""} · ${currentTransaction?.counterparty || currentTransaction?.summary || "已选流水"}`
    : tab === "documents" ? currentDocument?.name : tab === "vouchers" ? currentVoucher?.number || currentVoucher?.voucherNo || currentVoucher?.summary : null;
  return <AiDialog wide className="ai-resources-dialog" title="资料与报表" onClose={() => leave(onClose)} headerAction={onOpenFullWorkbench && <button type="button" className="ai-text-button ai-version-switch" onClick={() => openFull(tab, tab === "reports" ? { ...location.options, section: reportSection } : location.options)}>完整工作台</button>}>
    <div className="ai-resource-context">{activeWorkspace.name} · {activeWorkspace.currentPeriod}</div>
    <nav className="ai-resource-tabs" aria-label="资料与报表内容">{[["documents", "资料"], ["transactions", "流水"], ["vouchers", "凭证"], ["reports", "报表"]].map(([id, label]) => <button key={id} className={tab === id ? "is-active" : ""} type="button" aria-current={tab === id ? "page" : undefined} onClick={() => { if (id !== tab || targetError) navigate(id); }}>{label}</button>)}<button type="button" onClick={() => navigate("setup")}>基础设置</button></nav>
    {(objectLabel || historyRef.current.length > 0 || location.detail) && <div className="ai-resource-breadcrumb">{(historyRef.current.length > 0 || (tab === "transactions" && location.detail)) && <button type="button" className="ai-text-button" onClick={back}><ArrowLeft size={16} />{tab === "transactions" && location.detail ? "返回流水列表" : "返回上一处"}</button>}{objectLabel && <span title={objectLabel}>{objectLabel}</span>}</div>}
    {error && <p className="ai-error" role="alert">{error}</p>}
    {targetError ? <p className="ai-error" role="alert">{targetError}</p> : <div className="ai-resource-body"><Suspense fallback={<p className="ai-helper" role="status">正在打开…</p>}>
      {tab === "documents" && <Documents onToast={onToast} onNavigate={navigate} focusRequest={{ ...location.options, nonce: location.nonce }} onDocumentFocusChange={(documentId) => setLocation((current) => rememberAiDocumentFocus(current, documentId))} />}
      {tab === "vouchers" && <Accounting onToast={onToast} focusVoucherId={location.options.voucherId} focusRequestNonce={location.nonce} />}
      {tab === "reports" && <><Reports workspace={activeWorkspace} initialSection={reportSection} onSectionChange={setReportSection} onToast={onToast} onNavigate={navigate} onVouchers={({ voucherId: id } = {}) => navigate("vouchers", { voucherId: id || "" })} /><div className="ai-resource-toolbar"><button type="button" className="ai-text-button" onClick={() => navigate("reports", { section: "opening-balances" })}>期初余额</button><button type="button" className="ai-text-button" onClick={() => navigate("archive")}>本期归档</button></div></>}
      {tab === "setup" && <button type="button" className="ai-secondary-button" onClick={() => navigate("setup", location.options)}>在完整工作台打开基础设置</button>}
      {tab === "bankImport" && <BankImport onToast={onToast} onRequestAccountSetup={() => navigate("setup", { stage: "s3" })} onComplete={(plan) => { setQuery(""); setFilter("all"); setLimit(50); changeLocation({ tab: "transactions", detail: false, options: { importId: plan?.id || "" } }); }} />}
      {tab === "transactions" && <div className="ai-transactions">
        {location.detail ? currentTransaction ? <Accounting key={selectedTransaction} transactionId={selectedTransaction} onToast={onToast} /> : <p className="ai-error">这笔流水已不在当前账期，请返回列表选择。</p> : <>
          <div className="ai-resource-toolbar"><p className="ai-helper">本期 {transactions.length} 笔流水</p><button type="button" className="ai-text-button" onClick={() => navigate("bankImport")}>导入流水</button></div>
          <div className="ai-transaction-filters"><label className="ai-field"><span><MagnifyingGlass size={16} />搜索流水</span><input type="search" value={query} placeholder="对方、摘要、日期或金额" onChange={(event) => { setQuery(event.target.value); setLimit(50); }} /></label><label className="ai-field"><span>处理状态</span><select value={filter} onChange={(event) => { setFilter(event.target.value); setLimit(50); }}>{[["all", "全部状态"], ["exception", "待核对"], ["pending", "待整理"], ["draft", "有凭证草稿"], ["posted", "有已入账凭证"]].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label></div>
          {batchFilter && <p className="ai-helper">当前查看所选批次的导入流水。<button type="button" className="ai-inline-button" onClick={() => changeLocation({ options: { ...location.options, importId: "", importDocumentId: "" } })}>显示本期全部</button></p>}
          <div className="ai-transaction-list" ref={(element) => { listRef.current = element; if (element) element.scrollTop = listScrollRef.current; }} onScroll={(event) => { listScrollRef.current = event.currentTarget.scrollTop; }} aria-label="本期银行流水">
            {visible.slice(0, limit).map((transaction) => <button className={`ai-transaction-row${selectedTransaction === transaction.id ? " is-selected" : ""}`} type="button" key={transaction.id} onClick={() => leave(() => changeLocation({ tab: "transactions", detail: true, options: { ...location.options, transactionId: transaction.id } }))}><span className="ai-transaction-main"><strong>{transaction.counterparty || "交易对方待补充"}</strong><span>{transaction.summary || "摘要待补充"}</span><small className="ai-transaction-meta">{transaction.date} · {transactionBrowseState(transaction, activeWorkspace).label}</small></span><span className="ai-transaction-amount">{Number(transaction.amount || 0) > 0 ? "+" : ""}{Number(transaction.amount || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}<small>元</small></span></button>)}
          </div>
          {!visible.length && <p className="ai-empty-copy">{transactions.length ? "没有匹配的流水，试试其他关键词或处理状态。" : "本期还没有银行流水，可以在对话中上传，也可以直接导入。"}</p>}
          {visible.length > limit && <button type="button" className="ai-text-button" onClick={() => setLimit((value) => value + 50)}>再显示 {Math.min(50, visible.length - limit)} 笔（共 {visible.length} 笔）</button>}
        </>}
      </div>}
    </Suspense></div>}
  </AiDialog>;
}
