import { lazy, Suspense, useState } from "react";
import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import { AiDialog } from "./AiDialog.jsx";

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

export function AiResources({ initialTab = "documents", transactionId, documentId, voucherId, onClose, onToast }) {
  const { activeWorkspace } = useFinanceDesk();
  const [tab, setTab] = useState(transactionId ? "transactions" : initialTab);
  const [selectedTransaction, setSelectedTransaction] = useState(transactionId || "");
  const [error, setError] = useState("");
  function leave(action) { try { if (allowAiPanelLeave()) { setError(""); action(); } } catch (caught) { setError(caught.message); } }
  function navigate(page, options = {}) {
    const next = { documents: "documents", vouchers: "vouchers", reports: "reports", setup: "setup", bankImport: "bankImport", reconcile: "transactions" }[page];
    if (next) leave(() => { if (options.transactionId) setSelectedTransaction(options.transactionId); setTab(next); });
  }
  const transactions = (activeWorkspace.transactions || []).filter((transaction) => (transaction.period || transaction.date?.slice(0, 7)) === activeWorkspace.currentPeriod);
  return <AiDialog wide title="资料与报表" onClose={() => leave(onClose)}>
    <div className="ai-resource-context">{activeWorkspace.name} · {activeWorkspace.currentPeriod}</div>
    <nav className="ai-resource-tabs" aria-label="资料与报表内容">{[["documents", "资料"], ["transactions", "流水"], ["vouchers", "凭证"], ["reports", "报表"], ["setup", "基础资料"]].map(([id, label]) => <button key={id} className={tab === id ? "is-active" : ""} type="button" aria-current={tab === id ? "page" : undefined} onClick={() => { if (id !== tab) leave(() => setTab(id)); }}>{label}</button>)}</nav>
    {error && <p className="ai-error" role="alert">{error}</p>}
    <div className="ai-resource-body"><Suspense fallback={<p className="ai-helper" role="status">正在打开…</p>}>
      {tab === "documents" && <Documents onToast={onToast} onNavigate={navigate} focusRequest={documentId ? { documentId, nonce: documentId } : null} />}
      {tab === "vouchers" && <Accounting onToast={onToast} focusVoucherId={voucherId} focusRequestNonce={voucherId} />}
      {tab === "reports" && <Reports workspace={activeWorkspace} onVouchers={() => setTab("vouchers")} />}
      {tab === "setup" && <Foundation initialStage={activeWorkspace.bankAccounts?.length ? "s0" : "s3"} onToast={onToast} />}
      {tab === "bankImport" && <BankImport onToast={onToast} onRequestAccountSetup={() => leave(() => setTab("setup"))} onComplete={() => setTab("transactions")} />}
      {tab === "transactions" && <div className="ai-transactions">
        <div className="ai-resource-toolbar"><label className="ai-field"><span>银行流水</span><select value={selectedTransaction} onChange={(event) => leave(() => setSelectedTransaction(event.target.value))}><option value="">选择一笔流水</option>{transactions.map((transaction) => <option key={transaction.id} value={transaction.id}>{transaction.date} · {transaction.counterparty || transaction.summary || "待确认对方"} · ¥{Number(transaction.amount || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2 })}</option>)}</select></label><button type="button" className="ai-text-button" onClick={() => leave(() => setTab("bankImport"))}>导入流水</button></div>
        {selectedTransaction && transactions.some((transaction) => transaction.id === selectedTransaction) ? <Accounting key={selectedTransaction} transactionId={selectedTransaction} onToast={onToast} /> : <p className="ai-empty-copy">{transactions.length ? "选择流水后，可核对原件、业务归属并生成凭证。" : "本期还没有银行流水，可以在对话中上传，也可以直接导入。"}</p>}
      </div>}
    </Suspense></div>
  </AiDialog>;
}
