import { lazy, Suspense, useRef, useState } from "react";
import { ArrowLeft, MagnifyingGlass } from "@phosphor-icons/react";
import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import { AiDialog } from "./AiDialog.jsx";
import { filterTransactions, periodTransactions, transactionBrowseState } from "./aiWorkflow.js";

const Documents = lazy(() => import("../intake/DocumentIntakePanel.jsx").then((module) => ({ default: module.DocumentIntakePanel })));
const Accounting = lazy(() => import("../accounting/AccountingWorkbench.jsx").then((module) => ({ default: module.AccountingWorkbench })));
const Foundation = lazy(() => import("../workspaces/FoundationRecordsPanel.jsx").then((module) => ({ default: module.FoundationRecordsPanel })));
const BankImport = lazy(() => import("../intake/BankImportPanel.jsx").then((module) => ({ default: module.BankImportPanel })));
const Reports = lazy(() => import("./AiReports.jsx"));

export function allowAiPanelLeave() {
  const detail = { busy: false, dirty: false };
  window.dispatchEvent(new CustomEvent("financedesk:before-period-change", { detail }));
  if (detail.busy) throw new Error("资料正在保存或识别，请完成或取消后再离开。");
  return !detail.dirty || window.confirm("当前有尚未保存的编辑。确定离开并放弃这些编辑吗？");
}

export function AiResources({ initialTab = "documents", transactionId, documentId, voucherId, importDocumentId, onClose, onToast }) {
  const { activeWorkspace } = useFinanceDesk();
  const [location, setLocation] = useState({ tab: transactionId ? "transactions" : initialTab, detail: !!transactionId, documentId: documentId || "", voucherId: voucherId || "", nonce: 0 });
  const { tab } = location;
  const [selectedTransaction, setSelectedTransaction] = useState(transactionId || "");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [batchFilter, setBatchFilter] = useState(importDocumentId || "");
  const [limit, setLimit] = useState(50);
  const [error, setError] = useState("");
  const historyRef = useRef([]);
  const listScrollRef = useRef(0);
  const listRef = useRef(null);
  function leave(action) { try { if (allowAiPanelLeave()) { setError(""); action(); } } catch (caught) { setError(caught.message); } }
  function changeLocation(next, { remember = true } = {}) {
    if (tab === "transactions" && !location.detail) listScrollRef.current = listRef.current?.scrollTop || 0;
    if (remember) historyRef.current.push({ location, selectedTransaction });
    setLocation((current) => ({ ...current, ...next, nonce: current.nonce + 1 }));
  }
  function back() {
    leave(() => {
      if (tab === "transactions" && location.detail) {
        if (historyRef.current.at(-1)?.location.tab === "transactions" && !historyRef.current.at(-1)?.location.detail) historyRef.current.pop();
        changeLocation({ detail: false }, { remember: false }); return;
      }
      const previous = historyRef.current.pop();
      if (previous) { setSelectedTransaction(previous.selectedTransaction); setLocation(previous.location); }
    });
  }
  function navigate(page, options = {}) {
    const next = { documents: "documents", vouchers: "vouchers", reports: "reports", setup: "setup", bankImport: "bankImport", reconcile: "transactions", transactions: "transactions" }[page];
    if (next) leave(() => {
      if (options.transactionId) setSelectedTransaction(options.transactionId);
      changeLocation({ tab: next, ...(next === "transactions" ? { detail: !!options.transactionId } : {}), ...(options.documentId ? { documentId: options.documentId } : {}), ...(Object.hasOwn(options, "voucherId") ? { voucherId: options.voucherId || "" } : {}) });
    });
  }
  const transactions = periodTransactions(activeWorkspace);
  const batchIds = new Set((activeWorkspace.bankImports || []).filter((record) => record.sourceDocumentId === batchFilter).map((record) => record.id));
  const visible = filterTransactions(activeWorkspace, { query, status: filter }).filter((item) => !batchFilter || !batchIds.size || batchIds.has(item.importId));
  const currentTransaction = transactions.find((item) => item.id === selectedTransaction);
  const currentDocument = activeWorkspace.documents?.find((item) => item.id === location.documentId);
  const currentVoucher = activeWorkspace.vouchers?.find((item) => item.id === location.voucherId);
  const objectLabel = tab === "transactions" && location.detail ? `${currentTransaction?.date || ""} · ${currentTransaction?.counterparty || currentTransaction?.summary || "已选流水"}`
    : tab === "documents" ? currentDocument?.name : tab === "vouchers" ? currentVoucher?.number || currentVoucher?.voucherNo || currentVoucher?.summary : null;
  return <AiDialog wide className="ai-resources-dialog" title="资料与报表" onClose={() => leave(onClose)}>
    <div className="ai-resource-context">{activeWorkspace.name} · {activeWorkspace.currentPeriod}</div>
    <nav className="ai-resource-tabs" aria-label="资料与报表内容">{[["documents", "资料"], ["transactions", "流水"], ["vouchers", "凭证"], ["reports", "报表"], ["setup", "基础资料"]].map(([id, label]) => <button key={id} className={tab === id ? "is-active" : ""} type="button" aria-current={tab === id ? "page" : undefined} onClick={() => { if (id !== tab) leave(() => changeLocation({ tab: id })); }}>{label}</button>)}</nav>
    {(objectLabel || historyRef.current.length > 0 || location.detail) && <div className="ai-resource-breadcrumb">{(historyRef.current.length > 0 || (tab === "transactions" && location.detail)) && <button type="button" className="ai-text-button" onClick={back}><ArrowLeft size={16} />{tab === "transactions" && location.detail ? "返回流水列表" : "返回上一处"}</button>}{objectLabel && <span title={objectLabel}>{objectLabel}</span>}</div>}
    {error && <p className="ai-error" role="alert">{error}</p>}
    <div className="ai-resource-body"><Suspense fallback={<p className="ai-helper" role="status">正在打开…</p>}>
      {tab === "documents" && <Documents onToast={onToast} onNavigate={navigate} focusRequest={location.documentId ? { documentId: location.documentId, nonce: location.nonce } : null} />}
      {tab === "vouchers" && <Accounting onToast={onToast} focusVoucherId={location.voucherId} focusRequestNonce={location.nonce} />}
      {tab === "reports" && <Reports workspace={activeWorkspace} onToast={onToast} onNavigate={navigate} onVouchers={({ voucherId: id } = {}) => navigate("vouchers", { voucherId: id || "" })} />}
      {tab === "setup" && <Foundation initialStage={activeWorkspace.bankAccounts?.length ? "s0" : "s3"} onToast={onToast} />}
      {tab === "bankImport" && <BankImport onToast={onToast} onRequestAccountSetup={() => navigate("setup")} onComplete={() => { setQuery(""); setFilter("all"); setBatchFilter(""); changeLocation({ tab: "transactions", detail: false }); }} />}
      {tab === "transactions" && <div className="ai-transactions">
        {location.detail ? currentTransaction ? <Accounting key={selectedTransaction} transactionId={selectedTransaction} onToast={onToast} /> : <p className="ai-error">这笔流水已不在当前账期，请返回列表选择。</p> : <>
          <div className="ai-resource-toolbar"><p className="ai-helper">本期 {transactions.length} 笔流水</p><button type="button" className="ai-text-button" onClick={() => navigate("bankImport")}>导入流水</button></div>
          <div className="ai-transaction-filters"><label className="ai-field"><span><MagnifyingGlass size={16} />搜索流水</span><input type="search" value={query} placeholder="对方、摘要、日期或金额" onChange={(event) => { setQuery(event.target.value); setLimit(50); }} /></label><label className="ai-field"><span>处理状态</span><select value={filter} onChange={(event) => { setFilter(event.target.value); setLimit(50); }}>{[["all", "全部状态"], ["exception", "待核对"], ["pending", "待整理"], ["draft", "有凭证草稿"], ["posted", "有已入账凭证"]].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label></div>
          {batchFilter && batchIds.size > 0 && <p className="ai-helper">当前查看所选文件的导入流水。<button type="button" className="ai-inline-button" onClick={() => setBatchFilter("")}>显示本期全部</button></p>}
          <div className="ai-transaction-list" ref={(element) => { listRef.current = element; if (element) element.scrollTop = listScrollRef.current; }} onScroll={(event) => { listScrollRef.current = event.currentTarget.scrollTop; }} aria-label="本期银行流水">
            {visible.slice(0, limit).map((transaction) => <button className={`ai-transaction-row${selectedTransaction === transaction.id ? " is-selected" : ""}`} type="button" key={transaction.id} onClick={() => leave(() => { changeLocation({ tab: "transactions", detail: true }); setSelectedTransaction(transaction.id); })}><span className="ai-transaction-main"><strong>{transaction.counterparty || "交易对方待补充"}</strong><span>{transaction.summary || "摘要待补充"}</span><small className="ai-transaction-meta">{transaction.date} · {transactionBrowseState(transaction, activeWorkspace).label}</small></span><span className="ai-transaction-amount">{Number(transaction.amount || 0) > 0 ? "+" : ""}{Number(transaction.amount || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}<small>元</small></span></button>)}
          </div>
          {!visible.length && <p className="ai-empty-copy">{transactions.length ? "没有匹配的流水，试试其他关键词或处理状态。" : "本期还没有银行流水，可以在对话中上传，也可以直接导入。"}</p>}
          {visible.length > limit && <button type="button" className="ai-text-button" onClick={() => setLimit((value) => value + 50)}>再显示 {Math.min(50, visible.length - limit)} 笔（共 {visible.length} 笔）</button>}
        </>}
      </div>}
    </Suspense></div>
  </AiDialog>;
}
