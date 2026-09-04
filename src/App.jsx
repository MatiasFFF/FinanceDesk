import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowRight,
  Bank,
  CalendarBlank,
  CaretDown,
  ChartBar,
  Check,
  CheckCircle,
  Clock,
  CloudSlash,
  DownloadSimple,
  FileArrowUp,
  FileText,
  FolderOpen,
  GearSix,
  HouseLine,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Receipt,
  SealCheck,
  ShieldCheck,
  Sparkle,
  Trash,
  TrendUp,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { transactionStatus, uid } from "./financeData.js";
import {
  createCustomerConfirmationPackage,
  freezeReportVersion as freezeAccountingReportVersion,
  recordCustomerConfirmation,
  recordReconciliationSuggestions,
  reviewTransactionEvidence,
} from "./domain/accounting/index.js";
import { AccountingWorkbench } from "./features/accounting/AccountingWorkbench.jsx";
import { BankImportPanel } from "./features/intake/BankImportPanel.jsx";
import { saveLocalDocument } from "./features/intake/documentIntake.js";
import { FoundationRecordsPanel } from "./features/workspaces/FoundationRecordsPanel.jsx";
import { WorkspaceManager } from "./features/workspaces/WorkspaceManager.jsx";
import {
  CLOSE_STAGES,
  PRIMARY_NAV,
  PRODUCT_NAME,
  archivePeriod,
  attachReceipt,
  audit,
  buildReportSnapshot,
  ensureWorkspace,
  enterNextPeriod,
  exportLocalFilingPackage,
  formatCurrency,
  formatDateTime,
  formatPeriod,
  freezeReportVersion,
  importLocalReceipt,
  markPackageExported,
  prepareFilingDraft,
  reportVersionDiff,
  workflowChecks,
} from "./productWorkflow.js";
import { useFinanceDesk } from "./store/FinanceDeskProvider.jsx";

const PAGE_ICONS = {
  overview: HouseLine,
  reconcile: SealCheck,
  reports: ChartBar,
  tax: ShieldCheck,
  archive: Archive,
  setup: GearSix,
};

const PAGE_HEADINGS = {
  overview: ["月结总览", "一眼看清本期进度、风险和下一步。"],
  reconcile: ["批量核销", "先处理整月流水，再深入单笔证据。"],
  reports: ["报表中心", "三大报表、老板视角、版本冻结与差异都在这里。"],
  tax: ["确认与申报", "本地准备底稿、两次确认和申报包，不伪装连接税务局。"],
  archive: ["资料归档", "把真实回执、报表版本、确认记录和操作日志收拢归档。"],
  setup: ["基础资料", "维护企业、规则、合同、账户、发票、人员与本地资料。"],
};

const FILTERS = [
  { id: "all", label: "全部" },
  { id: "unresolved", label: "待处理" },
  { id: "reconciled", label: "已核销" },
  { id: "ignored", label: "暂不处理" },
];

function dateLabel(value) {
  if (!value) return "—";
  const [, month, day] = String(value).split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function fileSize(value) {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function downloadText(content, fileName, type = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function TonePill({ tone = "neutral", children }) {
  return <span className={`tone-pill ${tone}`}>{children}</span>;
}

function EmptyState({ icon: Icon = FolderOpen, title, description, action }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon size={25} /></span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

function BoundaryNote({ compact = false }) {
  return (
    <div className={`boundary-note ${compact ? "compact" : ""}`}>
      <CloudSlash size={18} />
      <div>
        <strong>本地模式</strong>
        <span>银行、税务、AI 与 OCR 均未连接；当前只处理本地文件和浏览器数据。</span>
      </div>
    </div>
  );
}

function WorkspaceMenu({ state, activeWorkspace, onSwitch, onOpenDialog, onClose }) {
  return (
    <div className="workspace-menu" role="menu">
      <p className="menu-label">我的工作台</p>
      <div className="workspace-list">
        {state.workspaces.map((workspace) => (
          <button
            className={workspace.id === activeWorkspace?.id ? "active" : ""}
            key={workspace.id}
            onClick={() => { onSwitch(workspace.id); onClose(); }}
            type="button"
          >
            <span className="workspace-avatar">{workspace.name.slice(0, 1)}</span>
            <span><strong>{workspace.name}</strong><small>{workspace.isDemo ? "可复制行业模板" : workspace.templateLabel}</small></span>
            {workspace.id === activeWorkspace?.id && <Check size={16} weight="bold" />}
          </button>
        ))}
      </div>
      <div className="workspace-menu-actions">
        <button onClick={() => { onOpenDialog("manage"); onClose(); }} type="button"><GearSix size={16} />管理、复制与备份</button>
        <button onClick={() => { onOpenDialog("create"); onClose(); }} type="button"><Plus size={16} />新建工作台</button>
        {activeWorkspace && <button onClick={() => { onOpenDialog("rename"); onClose(); }} type="button"><PencilSimple size={16} />重命名当前工作台</button>}
        {activeWorkspace && <button className="danger-action" onClick={() => { onOpenDialog("delete"); onClose(); }} type="button"><Trash size={16} />删除当前工作台</button>}
      </div>
    </div>
  );
}

function Sidebar({ state, workspace, page, onPage, onSwitchWorkspace, onOpenWorkspaceDialog }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <aside className="sidebar">
      <div className="sidebar-brand-wrap">
        <button className="brand" onClick={() => setMenuOpen((value) => !value)} type="button">
          <span className="brand-mark">财</span>
          <span className="brand-copy"><strong>{PRODUCT_NAME}</strong><small>{workspace?.name || "还没有工作台"}</small></span>
          <CaretDown size={14} />
        </button>
        {menuOpen && (
          <WorkspaceMenu state={state} activeWorkspace={workspace} onSwitch={onSwitchWorkspace} onOpenDialog={onOpenWorkspaceDialog} onClose={() => setMenuOpen(false)} />
        )}
      </div>

      <nav className="primary-nav" aria-label="主导航">
        {PRIMARY_NAV.map((item) => {
          const Icon = PAGE_ICONS[item.id];
          return (
            <button className={page === item.id ? "active" : ""} key={item.id} onClick={() => onPage(item.id)} type="button">
              <Icon size={19} weight={page === item.id ? "fill" : "regular"} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        {workspace && <div className="period-card"><CalendarBlank size={18} /><div><small>当前账期</small><strong>{formatPeriod(workspace.currentPeriod)}</strong></div></div>}
        <div className="account-card"><span className="avatar">会</span><div><strong>周会计</strong><small>本地财务负责人</small></div></div>
        <BoundaryNote compact />
      </div>
    </aside>
  );
}

function BottomNav({ page, onPage }) {
  return (
    <nav className="bottom-nav" aria-label="移动端导航">
      {PRIMARY_NAV.map((item) => {
        const Icon = PAGE_ICONS[item.id];
        return <button className={page === item.id ? "active" : ""} key={item.id} onClick={() => onPage(item.id)} type="button"><Icon size={19} weight={page === item.id ? "fill" : "regular"} /><span>{item.shortLabel}</span></button>;
      })}
    </nav>
  );
}

function Topbar({ state, workspace, page, onPeriod, onImport, onSwitchWorkspace, onOpenWorkspaceDialog }) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [title, subtitle] = PAGE_HEADINGS[page];
  return (
    <header className="topbar">
      <div className="topbar-title">
        <p className="eyebrow">{workspace ? `${formatPeriod(workspace.currentPeriod)} · ${workspace.isDemo ? "行业模板" : "本地账套"}` : PRODUCT_NAME}</p>
        <h1>{title}</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
      <div className="topbar-actions">
        <div className="mobile-workspace-wrap">
          <button className="secondary-button mobile-workspace" onClick={() => setWorkspaceOpen((value) => !value)} type="button"><span>{workspace?.name || "选择工作台"}</span><CaretDown size={14} /></button>
          {workspaceOpen && <WorkspaceMenu state={state} activeWorkspace={workspace} onSwitch={onSwitchWorkspace} onOpenDialog={onOpenWorkspaceDialog} onClose={() => setWorkspaceOpen(false)} />}
        </div>
        {workspace && <label className="period-select"><CalendarBlank size={18} /><select value={workspace.currentPeriod} onChange={(event) => onPeriod(event.target.value)} aria-label="选择账期">{workspace.periods.map((period) => <option key={period} value={period}>{formatPeriod(period)}</option>)}</select><CaretDown size={14} /></label>}
        {workspace && (page === "overview" || page === "reconcile") && <button className="primary-button" onClick={onImport} type="button"><UploadSimple size={18} weight="bold" />本地导入</button>}
        {workspace && (
          <div className="menu-wrap">
            <button className="icon-button" aria-label="更多操作" onClick={() => setMoreOpen((value) => !value)} type="button"><GearSix size={20} /></button>
            {moreOpen && <div className="popover-menu"><button onClick={() => { onOpenWorkspaceDialog("manage"); setMoreOpen(false); }} type="button"><GearSix size={17} />管理、复制与备份</button><button onClick={() => { onOpenWorkspaceDialog("rename"); setMoreOpen(false); }} type="button"><PencilSimple size={17} />重命名工作台</button><button onClick={() => { onOpenWorkspaceDialog("create"); setMoreOpen(false); }} type="button"><Plus size={17} />新建工作台</button><button onClick={() => { onOpenWorkspaceDialog("delete"); setMoreOpen(false); }} type="button"><Trash size={17} />删除工作台</button></div>}
          </div>
        )}
      </div>
    </header>
  );
}

function StageRail({ workspace, onPage }) {
  const flow = workflowChecks(workspace);
  const periodTransactions = workspace.transactions.filter((item) => String(item.date || "").startsWith(workspace.currentPeriod));
  const done = {
    documents: workspace.documents.some((item) => item.period === workspace.currentPeriod) || periodTransactions.length === 0,
    match: periodTransactions.length > 0,
    reconcile: flow.unresolved.length === 0,
    vouchers: workspace.vouchers.some((item) => item.status === "posted" && String(item.date || "").startsWith(workspace.currentPeriod)),
    reports: Boolean(flow.version),
    confirm: Boolean(workspace.tax.ownerConfirmedAt),
  };
  const firstPending = CLOSE_STAGES.findIndex((stage) => !done[stage.id]);
  const activeIndex = firstPending < 0 ? CLOSE_STAGES.length - 1 : firstPending;
  return (
    <div className="stage-rail" aria-label="月结阶段">
      {CLOSE_STAGES.map((stage, index) => <button className={`stage-step ${done[stage.id] ? "done" : ""} ${index === activeIndex ? "active" : ""}`} key={stage.id} onClick={() => onPage(stage.page)} type="button"><span className="stage-dot">{done[stage.id] ? <Check size={12} weight="bold" /> : index + 1}</span><span>{stage.label}</span></button>)}
    </div>
  );
}

function MetricCard({ label, value, note, icon: Icon, tone = "plain", onClick }) {
  const content = <><span className="metric-icon"><Icon size={20} /></span><span className="metric-copy"><small>{label}</small><strong>{value}</strong><span>{note}</span></span>{onClick && <ArrowRight size={16} className="metric-arrow" />}</>;
  return onClick ? <button className={`metric-card ${tone}`} onClick={onClick} type="button">{content}</button> : <article className={`metric-card ${tone}`}>{content}</article>;
}

function OverviewPage({ workspace, onPage }) {
  const flow = workflowChecks(workspace);
  const snapshot = flow.snapshot;
  const periodTransactions = workspace.transactions.filter((item) => String(item.date || "").startsWith(workspace.currentPeriod));
  const completionItems = [workspace.documents.length > 0, periodTransactions.length > 0, flow.unresolved.length === 0, workspace.vouchers.length > 0, Boolean(flow.version), Boolean(workspace.tax.ownerConfirmedAt)];
  const progress = Math.round((completionItems.filter(Boolean).length / completionItems.length) * 100);
  const nextAction = flow.unresolved.length
    ? { title: `先处理 ${flow.unresolved.length} 笔未完成流水`, body: "低置信度和证据不足事项不会自动入账。", page: "reconcile", action: "进入批量核销" }
    : !flow.version
      ? { title: "冻结本期第一版报表", body: "冻结后会保留不可覆盖的版本快照和后续差异。", page: "reports", action: "查看报表" }
      : !workspace.tax.financeConfirmedAt
        ? { title: "请客户完成首次数据确认", body: "财务数据与工资社保会分别留下确认记录。", page: "tax", action: "开始确认" }
        : !workspace.tax.ownerConfirmedAt
          ? { title: "完成提交前最终确认", body: "最终确认后才能导出本地申报包。", page: "tax", action: "继续确认" }
          : !workspace.delivery.filing.receipt
            ? { title: "等待真实外部办理回执", body: "税务局未连接；请在外部办理后把回执导回本地。", page: "tax", action: "查看申报边界" }
            : !workspace.delivery.filing.archivedAt
              ? { title: "回执齐全，可以完成归档", body: "归档会锁定本期交付索引，并准备下一期期初。", page: "archive", action: "进入归档" }
              : { title: "本期已经归档", body: "可以在归档页确认继承内容并进入下一期。", page: "archive", action: "查看归档" };
  const focusTransaction = flow.unresolved[0] || periodTransactions[0];
  const linkedDocuments = focusTransaction ? workspace.documents.filter((document) => focusTransaction.evidenceIds?.includes(document.id)) : [];
  const tasks = [
    { label: "完成异常与低置信度复核", meta: flow.unresolved.length ? `${flow.unresolved.length} 笔待处理` : "已完成", done: flow.unresolved.length === 0, page: "reconcile" },
    { label: "冻结月度报表版本", meta: flow.version ? `${flow.version.label} · ${formatDateTime(flow.version.createdAt)}` : "尚未冻结", done: Boolean(flow.version), page: "reports" },
    { label: "客户首次确认财务与工资社保", meta: workspace.tax.financeConfirmedAt && workspace.tax.payrollConfirmedAt ? formatDateTime(workspace.tax.financeConfirmedAt) : "等待确认", done: Boolean(workspace.tax.financeConfirmedAt && workspace.tax.payrollConfirmedAt), page: "tax" },
    { label: "最终确认、回执与归档", meta: workspace.delivery.filing.archivedAt ? formatDateTime(workspace.delivery.filing.archivedAt) : "尚未归档", done: Boolean(workspace.delivery.filing.archivedAt), page: "archive" },
  ];
  return (
    <div className="page-content overview-page">
      <StageRail workspace={workspace} onPage={onPage} />
      <section className="hero-grid">
        <article className="progress-card"><div className="section-heading compact"><div><p className="eyebrow">本月关账进度</p><h2>{progress === 100 ? "本期交付已经闭环" : "距离关账，还差几件小事"}</h2></div><span className="progress-number">{progress}%</span></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div><div className="progress-meta"><span><i className="dot sage" />已完成 {completionItems.filter(Boolean).length} / {completionItems.length} 个阶段</span><span><i className="dot clay" />{flow.unresolved.length} 笔待复核</span></div></article>
        <article className="next-action-card"><span className="card-kicker"><Sparkle size={17} weight="fill" />下一步建议</span><h3>{nextAction.title}</h3><p>{nextAction.body}</p><button className="text-button" onClick={() => onPage(nextAction.page)} type="button">{nextAction.action}<ArrowRight size={16} /></button></article>
      </section>
      <section className="metric-grid four">
        <MetricCard label="本月收款" value={formatCurrency(snapshot.summary.cashIn)} note={`${periodTransactions.filter((item) => Number(item.amount) > 0).length} 笔流入`} icon={Bank} />
        <MetricCard label="本月收入" value={formatCurrency(snapshot.summary.revenue)} note="来自已入账凭证" icon={TrendUp} tone="sage" onClick={() => onPage("reports")} />
        <MetricCard label="本月利润" value={formatCurrency(snapshot.summary.profit)} note="税前本地口径" icon={ChartBar} />
        <MetricCard label="预计税费" value={formatCurrency(snapshot.summary.estimatedTax)} note="演示估算，不可申报" icon={Receipt} tone="clay" onClick={() => onPage("tax")} />
      </section>
      <section className="overview-grid">
        <article className="panel task-panel"><div className="panel-heading"><div><p className="eyebrow">月结任务</p><h2>本期待办</h2></div><TonePill tone={flow.unresolved.length ? "warning" : "success"}>{flow.unresolved.length ? `${flow.unresolved.length} 项阻塞` : "可以继续"}</TonePill></div><div className="task-list">{tasks.map((task) => <button className="task-row" key={task.label} onClick={() => onPage(task.page)} type="button"><span className={`task-check ${task.done ? "done" : ""}`}>{task.done && <Check size={13} weight="bold" />}</span><span><strong>{task.label}</strong><small>{task.meta}</small></span><ArrowRight size={16} /></button>)}</div></article>
        <article className="panel evidence-preview"><div className="panel-heading"><div><p className="eyebrow">单笔证据预览</p><h2>{focusTransaction ? focusTransaction.summary : "还没有流水"}</h2></div>{focusTransaction && <TonePill tone={focusTransaction.status === "reconciled" ? "success" : "warning"}>{transactionStatus(focusTransaction).label}</TonePill>}</div>{focusTransaction ? <><div className="evidence-flow"><div className="flow-node good"><Bank size={19} /><span>银行流水</span><small>{formatCurrency(focusTransaction.amount, { sign: true })}</small></div><ArrowRight size={18} /><div className={`flow-node ${focusTransaction.allocations?.length || focusTransaction.directAccount ? "good" : "missing"}`}><Receipt size={19} /><span>业务判断</span><small>{focusTransaction.suggestion || "待确认"}</small></div><ArrowRight size={18} /><div className={`flow-node ${linkedDocuments.length ? "good" : "missing"}`}><FileText size={19} /><span>本地证据</span><small>{linkedDocuments.length ? `${linkedDocuments.length} 份已关联` : "等待补齐"}</small></div></div>{focusTransaction.exceptionReason && <div className="warning-note"><WarningCircle size={18} /><span><strong>待复核：</strong>{focusTransaction.exceptionReason}</span></div>}<button className="primary-button wide" onClick={() => onPage("reconcile")} type="button">打开单笔证据复核<ArrowRight size={17} /></button></> : <EmptyState title="等待本地流水" description="导入 CSV 后，这里会显示第一条证据链。" />}</article>
      </section>
      <BoundaryNote />
    </div>
  );
}

function EvidenceMeter({ transaction }) {
  const total = 3;
  const value = 1 + (transaction.allocations?.length || transaction.directAccount ? 1 : 0) + (transaction.evidenceIds?.length ? 1 : 0);
  return <div className="evidence-meter" aria-label={`证据完整度 ${value}/${total}`}><span>{value}/{total}</span><div className="meter-track"><i style={{ width: `${(value / total) * 100}%` }} /></div></div>;
}

function TransactionList({ items, selectedIds, focusedId, onToggle, onToggleAll, onFocus }) {
  const allSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id));
  return (
    <div className="transaction-list">
      <div className="transaction-head transaction-grid-row"><label className="check-cell"><input type="checkbox" checked={allSelected} onChange={(event) => onToggleAll(event.target.checked, items)} aria-label="选择当前列表全部流水" /></label><span>日期</span><span>交易对象 / 摘要</span><span>建议处理</span><span>金额</span><span>证据</span><span>状态</span></div>
      {items.map((item) => {
        const status = transactionStatus(item);
        return <div aria-selected={focusedId === item.id} className={`transaction-grid-row transaction-row ${focusedId === item.id ? "focused" : ""}`} key={item.id} onClick={() => onFocus(item.id)} onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && onFocus(item.id)} role="button" tabIndex={0}><label className="check-cell" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selectedIds.has(item.id)} onChange={(event) => onToggle(item.id, event.target.checked)} aria-label={`选择 ${item.counterparty}`} /></label><span className="date-cell" data-label="日期">{dateLabel(item.date)}</span><span className="transaction-main" data-label="交易"><strong>{item.counterparty}</strong><small>{item.summary}</small></span><span className="suggestion-cell" data-label="建议处理"><strong>{item.suggestion || "待确认"}</strong><small>{item.confidence || 0}% 置信度</small></span><span className={Number(item.amount) < 0 ? "amount expense" : "amount income"} data-label="金额">{formatCurrency(item.amount, { sign: true })}</span><span data-label="证据"><EvidenceMeter transaction={item} /></span><span data-label="状态"><TonePill tone={status.tone}>{status.label}</TonePill></span></div>;
      })}
      {!items.length && <EmptyState icon={MagnifyingGlass} title="没有符合条件的流水" description="换一个筛选条件或关键词试试。" />}
    </div>
  );
}

function TransactionDetail({ workspace, transaction, onClose, onStatus, onEvidence, onToast }) {
  const evidenceInput = useRef(null);
  if (!transaction) return null;
  const linkedDocuments = workspace.documents.filter((item) => transaction.evidenceIds?.includes(item.id));
  const allocations = (transaction.allocations || []).map((allocation) => ({ ...allocation, bill: workspace.bills.find((bill) => bill.id === allocation.billId) }));
  return (
    <aside className="detail-panel">
      <div className="detail-heading"><div><p className="eyebrow">单笔证据复核</p><h2>{transaction.counterparty}</h2></div><button className="icon-button compact" onClick={onClose} aria-label="关闭详情" type="button"><X size={19} /></button></div>
      <div className="detail-scroll">
        <section className="detail-section"><div className="detail-section-title"><i className="section-mark sage" />银行流水</div><dl className="detail-list"><div><dt>交易日期</dt><dd>{transaction.date}</dd></div><div><dt>流水号</dt><dd>{transaction.serial}</dd></div><div><dt>摘要</dt><dd>{transaction.summary}</dd></div><div><dt>金额</dt><dd className={Number(transaction.amount) < 0 ? "expense" : "income"}>{formatCurrency(transaction.amount, { sign: true })}</dd></div><div><dt>置信度</dt><dd>{transaction.confidence || 0}%</dd></div></dl></section>
        <section className="detail-section"><div className="detail-section-title"><i className="section-mark clay" />会计判断与核销</div><p className="match-reason"><Sparkle size={16} weight="fill" />{transaction.suggestion || "尚未形成建议处理"}</p>{allocations.length ? <div className="allocation-list">{allocations.map((allocation) => <div key={`${allocation.billId}-${allocation.amount}`}><span><strong>{allocation.bill?.no || allocation.billId}</strong><small>{allocation.bill?.summary || "本地账单"}</small></span><b>{formatCurrency(allocation.amount)}</b></div>)}</div> : <p className="quiet-copy">当前没有关联账单；人工复核后可以暂存判断，但不会伪造外部匹配。</p>}</section>
        <section className="detail-section"><div className="detail-section-title"><i className="section-mark sage" />本地证据</div>{linkedDocuments.length ? <div className="evidence-file-list">{linkedDocuments.map((document) => <div key={document.id}><FileText size={18} /><span><strong>{document.name}</strong><small>{document.type || document.category || "本地资料"} · {fileSize(document.size)}</small></span><CheckCircle size={17} weight="fill" /></div>)}</div> : <div className="missing-evidence"><WarningCircle size={20} /><span><strong>还没有关联证据</strong><small>{transaction.exceptionReason || "请选择本地文件补充证据。"}</small></span></div>}<input ref={evidenceInput} hidden type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) onEvidence(transaction.id, file); event.target.value = ""; }} /><button className="secondary-button wide" onClick={() => evidenceInput.current?.click()} type="button"><FileArrowUp size={17} />选择本地证据</button></section>
        <AccountingWorkbench transactionId={transaction.id} onToast={onToast} />
      </div>
      <div className="detail-actions"><button className="secondary-button" onClick={() => onStatus([transaction.id], "ignored")} type="button">暂不处理</button><span className="detail-action-note">核销与入账请使用上方真实会计处理区</span></div>
    </aside>
  );
}

function ReconcilePage({ workspace, onPage, onStatus, onReview, onEvidence, onExportSelected, onToast }) {
  const [filter, setFilter] = useState("unresolved");
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [focusedId, setFocusedId] = useState(null);
  useEffect(() => { setSelectedIds(new Set()); setFocusedId(null); }, [workspace.id, workspace.currentPeriod]);
  const periodTransactions = workspace.transactions.filter((item) => String(item.date || "").startsWith(workspace.currentPeriod));
  const counts = { all: periodTransactions.length, unresolved: periodTransactions.filter((item) => !["reconciled", "posted", "ignored"].includes(item.status)).length, reconciled: periodTransactions.filter((item) => ["reconciled", "posted"].includes(item.status)).length, ignored: periodTransactions.filter((item) => item.status === "ignored").length };
  const filtered = periodTransactions.filter((item) => { const filterOk = filter === "all" || (filter === "unresolved" ? !["reconciled", "posted", "ignored"].includes(item.status) : filter === "reconciled" ? ["reconciled", "posted"].includes(item.status) : item.status === filter); const haystack = `${item.counterparty} ${item.summary} ${item.serial} ${item.suggestion}`.toLowerCase(); return filterOk && haystack.includes(query.trim().toLowerCase()); });
  const focused = periodTransactions.find((item) => item.id === focusedId) || null;
  function toggle(id, checked) { setSelectedIds((current) => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; }); }
  function toggleAll(checked, items) { setSelectedIds((current) => { const next = new Set(current); items.forEach((item) => checked ? next.add(item.id) : next.delete(item.id)); return next; }); }
  const selection = periodTransactions.filter((item) => selectedIds.has(item.id));
  return (
    <div className="reconcile-page">
      <div className="reconcile-main">
        <StageRail workspace={workspace} onPage={onPage} />
        <section className="workspace-toolbar"><div className="filter-tabs" role="tablist" aria-label="流水状态筛选">{FILTERS.map((item) => <button className={filter === item.id ? "active" : ""} key={item.id} onClick={() => setFilter(item.id)} role="tab" type="button">{item.label}<span>{counts[item.id]}</span></button>)}</div><label className="search-field"><MagnifyingGlass size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索对方、摘要或流水号" /><button className={query ? "visible" : ""} onClick={() => setQuery("")} type="button" aria-label="清空搜索"><X size={15} /></button></label></section>
        {selection.length > 0 && <div className="batch-bar"><span><strong>已选择 {selection.length} 笔</strong><small>批量动作只作用于当前选择</small></span><div><button className="soft-button" onClick={() => onExportSelected(selection)} type="button"><DownloadSimple size={16} />导出所选</button><button className="secondary-button" onClick={() => onStatus([...selectedIds], "ignored")} type="button">暂不处理</button><button className="primary-button" onClick={() => onReview([...selectedIds])} type="button">运行规则复核</button><button className="icon-button compact" onClick={() => setSelectedIds(new Set())} type="button" aria-label="清除选择"><X size={17} /></button></div></div>}
        <section className="panel table-panel"><div className="table-heading"><span>本期流水</span><span>{filtered.length} / {periodTransactions.length} 笔</span></div><TransactionList items={filtered} selectedIds={selectedIds} focusedId={focusedId} onToggle={toggle} onToggleAll={toggleAll} onFocus={setFocusedId} /></section>
        <BoundaryNote />
      </div>
      <TransactionDetail workspace={workspace} transaction={focused} onClose={() => setFocusedId(null)} onStatus={onStatus} onEvidence={onEvidence} onToast={onToast} />
    </div>
  );
}

function DrilldownPanel({ row, sectionLabel, onClose }) {
  if (!row) return null;
  return <aside className="detail-panel report-detail"><div className="detail-heading"><div><p className="eyebrow">{sectionLabel} · 数字追溯</p><h2>{row.label}</h2></div><button className="icon-button compact" onClick={onClose} type="button" aria-label="关闭下钻"><X size={19} /></button></div><div className="detail-scroll"><div className="drill-total"><span>报表金额</span><strong>{formatCurrency(row.value)}</strong></div>{row.details?.length ? <div className="drill-list">{row.details.map((item) => <div key={item.id}><span><strong>{item.title}</strong><small>{item.date || "—"} · {item.reference || "本地记录"}</small>{item.description && <small>{item.description}</small>}</span><b>{formatCurrency(item.amount, { sign: true })}</b></div>)}</div> : <EmptyState title="这是汇总或结转数字" description="当前数字由同表明细或期初余额汇总，没有额外的单笔来源。" />}</div></aside>;
}

function ReportsPage({ workspace, onPage, onFreeze }) {
  const [sectionId, setSectionId] = useState("balance");
  const [versionId, setVersionId] = useState("live");
  const [drill, setDrill] = useState(null);
  useEffect(() => { setVersionId("live"); setDrill(null); }, [workspace.id, workspace.currentPeriod]);
  const live = buildReportSnapshot(workspace);
  const versions = workspace.delivery.reportVersions.filter((item) => item.period === workspace.currentPeriod);
  const selectedVersion = versions.find((item) => item.id === versionId);
  const snapshot = selectedVersion?.snapshot || live;
  const section = snapshot.sections[sectionId];
  const latest = versions[0];
  const previous = versions[1];
  const differences = latest && previous ? reportVersionDiff(latest, previous) : [];
  const balanced = Math.abs(live.summary.difference) < 0.01;
  return (
    <div className="page-content reports-page">
      <StageRail workspace={workspace} onPage={onPage} />
      <section className="report-toolbar panel"><div><p className="eyebrow">S9 · 本地报表</p><h2>{selectedVersion ? `${selectedVersion.label} 冻结版本` : "实时草稿"}</h2><p>{selectedVersion ? `冻结于 ${formatDateTime(selectedVersion.createdAt)}，不会被后续修改覆盖。` : "数字会随本地凭证与税务调整更新。冻结后形成版本快照。"}</p></div><div className="report-toolbar-actions"><label className="compact-select"><span>查看版本</span><select value={versionId} onChange={(event) => setVersionId(event.target.value)}><option value="live">实时草稿</option>{versions.map((item) => <option key={item.id} value={item.id}>{item.label} · {formatDateTime(item.createdAt)}</option>)}</select><CaretDown size={13} /></label><button className="primary-button" disabled={!balanced} onClick={onFreeze} type="button"><SealCheck size={17} />冻结新版本</button></div></section>
      {!balanced && <div className="danger-banner"><WarningCircle size={18} /><span><strong>报表尚未勾稽：</strong>差异 {formatCurrency(live.summary.difference)}，修正后才能冻结。</span></div>}
      <section className="metric-grid four report-summary"><MetricCard label="资产合计" value={formatCurrency(snapshot.summary.assets)} note="资产负债表" icon={Bank} /><MetricCard label="营业收入" value={formatCurrency(snapshot.summary.revenue)} note="利润表" icon={TrendUp} tone="sage" /><MetricCard label="本月利润" value={formatCurrency(snapshot.summary.profit)} note="税前本地口径" icon={ChartBar} /><MetricCard label="三表勾稽" value={formatCurrency(snapshot.summary.difference)} note={Math.abs(snapshot.summary.difference) < 0.01 ? "校验通过" : "需要处理"} icon={CheckCircle} tone={Math.abs(snapshot.summary.difference) < 0.01 ? "sage" : "clay"} /></section>
      <div className="reports-layout">
        <section className="panel statement-panel"><div className="report-tabs" role="tablist">{Object.entries(snapshot.sections).map(([id, value]) => <button className={sectionId === id ? "active" : ""} key={id} onClick={() => { setSectionId(id); setDrill(null); }} role="tab" type="button">{value.label}</button>)}</div><div className="statement-heading"><span>项目</span><span>本期金额</span></div><div className="statement-rows">{section.rows.map((row) => <button className={/(合计|利润|净增加|期末|缺口)/.test(row.label) ? "total" : ""} key={row.id} onClick={() => setDrill(row)} type="button"><span>{row.label}<small>{row.details?.length ? `${row.details.length} 条来源` : "查看口径"}</small></span><strong>{formatCurrency(row.value)}</strong><ArrowRight size={15} /></button>)}</div><div className="statement-foot"><span>{formatPeriod(snapshot.period)}</span><span>{selectedVersion ? `${selectedVersion.label} · 已冻结` : "实时草稿 · 未冻结"}</span></div></section>
        <aside className="panel version-panel"><div className="panel-heading"><div><p className="eyebrow">版本与差异</p><h2>不可覆盖的报表记录</h2></div><Clock size={21} /></div>{versions.length ? <div className="version-list">{versions.map((version, index) => <button className={version.id === versionId ? "active" : ""} key={version.id} onClick={() => setVersionId(version.id)} type="button"><span><strong>{version.label}</strong><small>{formatDateTime(version.createdAt)} · {version.actor}</small></span><TonePill tone="success">已冻结</TonePill>{index === 0 && <em>当前</em>}</button>)}</div> : <EmptyState title="还没有冻结版本" description="勾稽通过后冻结 V1，后续修改会形成 V2、V3，而不是覆盖旧数字。" />}<div className="version-diff"><div className="subheading"><strong>{previous ? `${latest.label} 对比 ${previous.label}` : "版本差异"}</strong><span>{differences.length} 项变化</span></div>{previous ? (differences.length ? differences.slice(0, 8).map((item) => <div key={item.id}><span><small>{item.section}</small><strong>{item.label}</strong></span><b className={item.delta > 0 ? "income" : "expense"}>{formatCurrency(item.delta, { sign: true })}</b></div>) : <p className="quiet-copy">最新两个版本的报表数字一致，时间与确认记录仍分别保留。</p>) : <p className="quiet-copy">冻结第二个版本后，这里会逐项显示与上一版本的差异。</p>}</div><button className="secondary-button wide" onClick={() => onPage("tax")} type="button">进入确认与申报<ArrowRight size={16} /></button></aside>
      </div>
      <BoundaryNote />
      <DrilldownPanel row={drill} sectionLabel={section.label} onClose={() => setDrill(null)} />
    </div>
  );
}

function CheckRows({ items, onNavigate }) {
  return <div className="check-rows">{items.map((item) => <button key={item.id} onClick={() => !item.ok && onNavigate?.(item.page)} type="button"><span className={`check-icon ${item.ok ? "ok" : ""}`}>{item.ok ? <Check size={13} weight="bold" /> : <WarningCircle size={15} />}</span><span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>{!item.ok && <ArrowRight size={15} />}</button>)}</div>;
}

function TaxPage({ workspace, onPage, onTaxChange, onTaxCommit, onInitialConfirm, onPrepareDraft, onFinalConfirm, onExport, onReceipt }) {
  const [financeChecked, setFinanceChecked] = useState(false);
  const [payrollChecked, setPayrollChecked] = useState(false);
  const [finalChecked, setFinalChecked] = useState(false);
  const [confirmer, setConfirmer] = useState(workspace.tax.confirmedBy || "");
  const receiptInput = useRef(null);
  useEffect(() => { setFinanceChecked(false); setPayrollChecked(false); setFinalChecked(false); setConfirmer(workspace.tax.confirmedBy || ""); }, [workspace.id, workspace.currentPeriod]);
  const flow = workflowChecks(workspace);
  const version = flow.version;
  const snapshot = version?.snapshot || flow.snapshot;
  const prerequisiteChecks = flow.checks.slice(0, 3);
  const initialReady = prerequisiteChecks.every((item) => item.ok) && financeChecked && payrollChecked;
  const initialDone = Boolean(workspace.tax.financeConfirmedAt && workspace.tax.payrollConfirmedAt);
  const finalReady = initialDone && Boolean(workspace.delivery.filing.draftCreatedAt) && finalChecked && confirmer.trim().length > 0;
  const exportReady = flow.export.every((item) => item.ok);
  const filing = workspace.delivery.filing;
  return (
    <div className="page-content tax-page">
      <StageRail workspace={workspace} onPage={onPage} />
      <section className="tax-boundary-card"><span className="boundary-icon"><CloudSlash size={27} /></span><div><p className="eyebrow">安全边界</p><h2>电子税务局未连接</h2><p>第一版只生成本地底稿与申报包。真实填报、提交和缴税必须在电子税务局或未来的本地安全执行器中完成。</p></div><TonePill tone="neutral">后续连接能力</TonePill></section>
      <div className="tax-layout">
        <div className="tax-main-column">
          <section className="panel workpaper-panel"><div className="panel-heading"><div><p className="eyebrow">S10–S11 · 申报底稿</p><h2>{formatPeriod(workspace.currentPeriod)} 本地复核稿</h2></div>{version ? <TonePill tone="success">基于 {version.label}</TonePill> : <TonePill tone="warning">尚未冻结报表</TonePill>}</div><div className="workpaper-grid">{snapshot.taxWorkpaper.rows.map((row) => <div key={row.id}><span>{row.label}</span><strong>{formatCurrency(row.value)}</strong></div>)}</div><p className="workpaper-disclaimer"><WarningCircle size={16} />{snapshot.taxWorkpaper.disclaimer}</p><div className="tax-input-grid"><label><span>税会调整</span><input type="number" step="0.01" value={workspace.tax.adjustments} onChange={(event) => onTaxChange("adjustments", Number(event.target.value))} onBlur={() => onTaxCommit("adjustments")} /></label><label><span>工资薪金</span><input type="number" step="0.01" value={workspace.tax.payroll} onChange={(event) => onTaxChange("payroll", Number(event.target.value))} onBlur={() => onTaxCommit("payroll")} /></label><label><span>社保数据</span><input type="number" step="0.01" value={workspace.tax.socialSecurity} onChange={(event) => onTaxChange("socialSecurity", Number(event.target.value))} onBlur={() => onTaxCommit("socialSecurity")} /></label><label className="full"><span>复核备注</span><textarea value={workspace.tax.note} onChange={(event) => onTaxChange("note", event.target.value)} onBlur={() => onTaxCommit("note")} placeholder="记录本期特殊口径或待说明事项" /></label></div><p className="edit-warning">修改底稿会撤销后续确认与导出状态；请重新冻结报表版本后再继续。</p></section>
          <section className="panel confirmation-panel"><div className="panel-heading"><div><p className="eyebrow">第一次客户确认</p><h2>确认财务数据与工资社保</h2></div>{initialDone && <TonePill tone="success">已确认</TonePill>}</div><CheckRows items={prerequisiteChecks} onNavigate={onPage} /><div className="confirmation-options"><label><input type="checkbox" checked={financeChecked || Boolean(workspace.tax.financeConfirmedAt)} disabled={Boolean(workspace.tax.financeConfirmedAt)} onChange={(event) => setFinanceChecked(event.target.checked)} /><span><strong>我已查看收入、成本费用、预计税额和三大报表</strong><small>有异议时先回到流水或报表处理，不带疑问进入申报。</small></span></label><label><input type="checkbox" checked={payrollChecked || Boolean(workspace.tax.payrollConfirmedAt)} disabled={Boolean(workspace.tax.payrollConfirmedAt)} onChange={(event) => setPayrollChecked(event.target.checked)} /><span><strong>我已单独核对工资薪金与社保数据</strong><small>此确认与最终提交责任确认分开记录。</small></span></label></div><button className="primary-button wide" disabled={initialDone || !initialReady} onClick={onInitialConfirm} type="button">{initialDone ? `首次确认于 ${formatDateTime(workspace.tax.financeConfirmedAt)}` : "完成第一次客户确认"}</button></section>
        </div>
        <aside className="tax-side-column">
          <section className="panel filing-steps-panel"><div className="panel-heading"><div><p className="eyebrow">S11–S12 · 提交前流程</p><h2>本地申报包</h2></div><ShieldCheck size={22} /></div><ol className="filing-timeline"><li className={initialDone ? "done" : "active"}><span>{initialDone ? <Check size={13} weight="bold" /> : 1}</span><div><strong>第一次客户确认</strong><small>{formatDateTime(workspace.tax.financeConfirmedAt)}</small></div></li><li className={filing.draftCreatedAt ? "done" : initialDone ? "active" : ""}><span>{filing.draftCreatedAt ? <Check size={13} weight="bold" /> : 2}</span><div><strong>生成本地申报底稿</strong><small>{formatDateTime(filing.draftCreatedAt)}</small></div></li><li className={workspace.tax.ownerConfirmedAt ? "done" : filing.draftCreatedAt ? "active" : ""}><span>{workspace.tax.ownerConfirmedAt ? <Check size={13} weight="bold" /> : 3}</span><div><strong>第二次最终确认</strong><small>{formatDateTime(workspace.tax.ownerConfirmedAt)}</small></div></li><li className={filing.exportedAt ? "done" : workspace.tax.ownerConfirmedAt ? "active" : ""}><span>{filing.exportedAt ? <Check size={13} weight="bold" /> : 4}</span><div><strong>导出本地申报包</strong><small>{formatDateTime(filing.exportedAt)}</small></div></li><li className={filing.receipt ? "done" : filing.exportedAt ? "active" : ""}><span>{filing.receipt ? <Check size={13} weight="bold" /> : 5}</span><div><strong>导回真实办理回执</strong><small>{filing.receipt?.name || "等待外部办理"}</small></div></li></ol><button className="secondary-button wide" disabled={!initialDone || Boolean(filing.draftCreatedAt)} onClick={onPrepareDraft} type="button">{filing.draftCreatedAt ? "底稿已生成" : "生成本地申报底稿"}</button></section>
          <section className="panel final-confirm-panel"><div className="panel-heading"><div><p className="eyebrow">第二次客户确认</p><h2>提交前最终责任确认</h2></div>{workspace.tax.ownerConfirmedAt && <TonePill tone="success">已确认</TonePill>}</div><p>再次核对所属期、预计税额、工资社保、风险提示和是否扣款。本地工作台不会替你点击税务局提交。</p><dl className="final-summary"><div><dt>所属期</dt><dd>{formatPeriod(workspace.currentPeriod)}</dd></div><div><dt>预计税费</dt><dd>{formatCurrency(snapshot.summary.estimatedTax)}</dd></div><div><dt>工资 / 社保</dt><dd>{formatCurrency(workspace.tax.payroll)} / {formatCurrency(workspace.tax.socialSecurity)}</dd></div><div><dt>自动扣款</dt><dd>未启用 · 外部办理</dd></div></dl><label className="field-label"><span>确认人姓名</span><input value={confirmer} disabled={Boolean(workspace.tax.ownerConfirmedAt)} onChange={(event) => setConfirmer(event.target.value)} placeholder="例如：林岚" /></label><label className="confirmation-check"><input type="checkbox" checked={finalChecked || Boolean(workspace.tax.ownerConfirmedAt)} disabled={Boolean(workspace.tax.ownerConfirmedAt)} onChange={(event) => setFinalChecked(event.target.checked)} /><span><strong>我确认以上数据，并知晓仍需在外部完成真实申报</strong><small>此操作只记录本地最终确认，不会向税务局发送数据。</small></span></label><button className="primary-button wide" disabled={Boolean(workspace.tax.ownerConfirmedAt) || !finalReady} onClick={() => onFinalConfirm(confirmer.trim())} type="button">{workspace.tax.ownerConfirmedAt ? `最终确认：${workspace.tax.confirmedBy}` : "完成第二次最终确认"}</button></section>
          <section className="panel package-panel"><div className="panel-heading"><div><p className="eyebrow">文件交付</p><h2>导出与回执</h2></div><DownloadSimple size={21} /></div><CheckRows items={flow.export} onNavigate={onPage} /><button className="primary-button wide" disabled={!exportReady} onClick={onExport} type="button"><DownloadSimple size={17} />{filing.exportedAt ? "重新导出本地申报包" : "导出本地申报包"}</button><input ref={receiptInput} hidden type="file" accept=".pdf,.json,.xml,.txt,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) onReceipt(file); event.target.value = ""; }} /><button className="secondary-button wide" disabled={!filing.exportedAt} onClick={() => receiptInput.current?.click()} type="button"><UploadSimple size={17} />{filing.receipt ? "替换本地回执" : "导入真实外部回执"}</button>{filing.receipt && <div className="receipt-card"><Receipt size={21} /><span><strong>{filing.receipt.name}</strong><small>{fileSize(filing.receipt.size)} · SHA-256 {filing.receipt.hash.slice(0, 10)}…</small></span><CheckCircle size={18} weight="fill" /></div>}</section>
        </aside>
      </div>
    </div>
  );
}

function ArchivePage({ workspace, onPage, onDocuments, onReceipt, onArchive, onNextPeriod, onExportIndex }) {
  const [tab, setTab] = useState("documents");
  const [query, setQuery] = useState("");
  const docsInput = useRef(null);
  const receiptInput = useRef(null);
  const flow = workflowChecks(workspace);
  const filing = workspace.delivery.filing;
  const archived = workspace.delivery.archives.find((item) => item.period === workspace.currentPeriod);
  const documents = workspace.documents.filter((item) => `${item.name} ${item.type || item.category || ""} ${item.status || item.lifecycleStatus || ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const archiveReady = flow.archive.every((item) => item.ok);
  return (
    <div className="page-content archive-page">
      <StageRail workspace={workspace} onPage={onPage} />
      <section className="archive-hero"><div><p className="eyebrow">S13 · 回执、归档与下一期</p><h2>{archived ? `${formatPeriod(workspace.currentPeriod)} 已归档` : "让本期交付真正闭环"}</h2><p>{archived ? `归档于 ${formatDateTime(archived.archivedAt)}，报表、确认、回执与期末余额已经建立索引。` : "必须先导入真实外部办理回执，再把本地申报包、确认记录和操作日志一起归档。"}</p></div><div className="archive-hero-actions"><button className="secondary-button" onClick={onExportIndex} type="button"><DownloadSimple size={17} />导出归档索引</button>{archived ? <button className="primary-button" onClick={onNextPeriod} type="button">进入下一期<ArrowRight size={17} /></button> : <button className="primary-button" disabled={!archiveReady} onClick={onArchive} type="button"><Archive size={17} />完成本期归档</button>}</div></section>
      <section className="metric-grid four archive-status-grid"><MetricCard label="冻结报表" value={flow.version?.label || "未完成"} note={flow.version ? formatDateTime(flow.version.createdAt) : "先去报表中心"} icon={ChartBar} tone={flow.version ? "sage" : "clay"} onClick={() => onPage("reports")} /><MetricCard label="两次确认" value={workspace.tax.ownerConfirmedAt ? "已完成" : "未完成"} note={workspace.tax.confirmedBy || "等待客户"} icon={ShieldCheck} tone={workspace.tax.ownerConfirmedAt ? "sage" : "clay"} onClick={() => onPage("tax")} /><MetricCard label="本地申报包" value={filing.exportedAt ? "已导出" : "未导出"} note={formatDateTime(filing.exportedAt)} icon={DownloadSimple} /><MetricCard label="真实回执" value={filing.receipt ? "已导入" : "待导入"} note={filing.receipt?.name || "来自外部办理"} icon={Receipt} tone={filing.receipt ? "sage" : "clay"} /></section>
      {!filing.receipt && <section className="receipt-upload-card"><span><Receipt size={25} /></span><div><strong>导入真实外部办理回执</strong><p>选择在电子税务局或本地安全执行器中取得的 PDF、XML、JSON 或文本回执。文件只在本地读取并记录哈希。</p></div><input ref={receiptInput} hidden type="file" accept=".pdf,.json,.xml,.txt,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) onReceipt(file); event.target.value = ""; }} /><button className="primary-button" disabled={!filing.exportedAt} onClick={() => receiptInput.current?.click()} type="button"><UploadSimple size={17} />选择回执</button></section>}
      <section className="panel archive-content-panel"><div className="archive-toolbar"><div className="report-tabs"><button className={tab === "documents" ? "active" : ""} onClick={() => setTab("documents")} type="button">本地资料</button><button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")} type="button">操作日志</button><button className={tab === "periods" ? "active" : ""} onClick={() => setTab("periods")} type="button">历史归档</button></div>{tab === "documents" && <div className="archive-tools"><label className="search-field"><MagnifyingGlass size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件" /></label><input ref={docsInput} hidden type="file" multiple onChange={(event) => { onDocuments(Array.from(event.target.files || [])); event.target.value = ""; }} /><button className="secondary-button" onClick={() => docsInput.current?.click()} type="button"><FileArrowUp size={17} />添加本地资料</button></div>}</div>{tab === "documents" && (documents.length ? <div className="document-grid">{documents.map((document) => <article className="document-card" key={document.id}><span className="document-icon"><FileText size={22} /></span><div><small>{document.type || document.category || "本地资料"} · {document.period || "未分期"}</small><strong>{document.name}</strong><p>{fileSize(document.size)} · {document.hash ? "已记录校验标识" : "本地元数据"}</p></div><TonePill tone={document.status?.includes("待") ? "warning" : "success"}>{document.status || "已获取"}</TonePill></article>)}</div> : <EmptyState title="没有符合条件的资料" description="添加本地文件或清空搜索条件。" />)}{tab === "logs" && (workspace.auditLog.length ? <div className="audit-list">{workspace.auditLog.map((item) => <div key={item.id}><span className="audit-dot" /><span><strong>{item.action}</strong><small>{item.detail}</small></span><span><strong>{item.actor}</strong><small>{formatDateTime(item.at)}</small></span></div>)}</div> : <EmptyState title="还没有操作日志" description="确认、导出、导入和归档动作都会记录在这里。" />)}{tab === "periods" && (workspace.delivery.archives.length ? <div className="period-archive-list">{workspace.delivery.archives.map((item) => <article key={item.id}><span className="archive-badge"><Archive size={20} /></span><div><strong>{formatPeriod(item.period)}</strong><small>{item.reportVersionLabel} · {item.confirmations.confirmedBy || "客户"} · {formatDateTime(item.archivedAt)}</small></div><span><strong>{formatCurrency(item.summary.profit)}</strong><small>本期利润</small></span><TonePill tone="success">已归档</TonePill></article>)}</div> : <EmptyState title="还没有历史归档" description="本期回执导入并通过校验后，可以形成第一条归档记录。" />)}</section>
      {!archived && <div className="archive-check-panel panel"><div className="panel-heading"><div><p className="eyebrow">归档校验</p><h2>{archiveReady ? "全部条件已满足" : "还不能完成归档"}</h2></div><TonePill tone={archiveReady ? "success" : "warning"}>{flow.archive.filter((item) => item.ok).length} / {flow.archive.length}</TonePill></div><CheckRows items={flow.archive} onNavigate={onPage} /></div>}
      <BoundaryNote />
    </div>
  );
}

function WorkspaceDialog({ mode, workspace, onClose, onSubmit }) {
  const [form, setForm] = useState({ name: "", legalName: "", industry: "通用服务型企业", taxpayerType: "小规模纳税人", mode: "template" });
  useEffect(() => { if (mode === "rename") setForm((current) => ({ ...current, name: workspace?.name || "" })); if (mode === "create") setForm({ name: "", legalName: "", industry: "私教健身工作室", taxpayerType: "小规模纳税人", mode: "template" }); }, [mode, workspace?.id]);
  if (!mode) return null;
  const title = mode === "create" ? "新建工作台" : mode === "rename" ? "重命名工作台" : "删除工作台";
  function submit(event) { event.preventDefault(); if (mode !== "delete" && !form.name.trim()) return; onSubmit(form); }
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="modal-card workspace-dialog" onSubmit={submit}><div className="modal-heading"><div><p className="eyebrow">{PRODUCT_NAME}</p><h2>{title}</h2></div><button className="icon-button compact" onClick={onClose} type="button" aria-label="关闭"><X size={19} /></button></div>{mode === "create" && <><p className="modal-intro">可以从“山岚健身工作室”行业模板复制，也可以从空白工作台开始。模板只是可删除、可改名的本地样例。</p><div className="choice-cards"><label className={form.mode === "template" ? "active" : ""}><input type="radio" name="mode" value="template" checked={form.mode === "template"} onChange={(event) => setForm({ ...form, mode: event.target.value })} /><span><strong>复制行业模板</strong><small>带本地样例数据，适合直接体验完整流程</small></span></label><label className={form.mode === "blank" ? "active" : ""}><input type="radio" name="mode" value="blank" checked={form.mode === "blank"} onChange={(event) => setForm({ ...form, mode: event.target.value })} /><span><strong>创建空白工作台</strong><small>只保留本地流程与配置</small></span></label></div><div className="form-grid"><label><span>工作台名称 *</span><input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：微光设计事务所" /></label><label><span>企业法定名称</span><input value={form.legalName} onChange={(event) => setForm({ ...form, legalName: event.target.value })} placeholder="可稍后补充" /></label><label><span>行业</span><input value={form.industry} onChange={(event) => setForm({ ...form, industry: event.target.value })} /></label><label><span>纳税人类型</span><select value={form.taxpayerType} onChange={(event) => setForm({ ...form, taxpayerType: event.target.value })}><option>小规模纳税人</option><option>一般纳税人</option></select></label></div></>}{mode === "rename" && <label className="field-label"><span>新的工作台名称</span><input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>}{mode === "delete" && <div className="delete-warning"><WarningCircle size={24} /><div><strong>确认删除“{workspace?.name}”？</strong><p>这会移除当前浏览器中的本地工作台数据，无法从本页面恢复。其他工作台不会受影响。</p></div></div>}<div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">取消</button><button className={mode === "delete" ? "danger-button" : "primary-button"} type="submit">{mode === "create" ? "创建并进入" : mode === "rename" ? "保存名称" : "确认删除"}</button></div></form></div>
  );
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { cells.push(cell.trim()); cell = ""; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function ImportDialog({ open, workspace, onClose, onImport }) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  if (!open) return null;
  function readFile(file) {
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) { setError("当前产品壳只接收 CSV；Excel 解析由本地导入模块后续接入。"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const lines = String(reader.result || "").replace(/^\ufeff/, "").split(/\r?\n/).filter((line) => line.trim());
      if (lines.length < 2) { setError("CSV 至少需要表头和一行数据。"); return; }
      const headers = parseCsvLine(lines[0]).map((item) => item.toLowerCase());
      const find = (...names) => headers.findIndex((header) => names.some((name) => header.includes(name)));
      const indexes = { date: find("日期", "date"), counterparty: find("对方", "counterparty"), summary: find("摘要", "summary"), amount: find("金额", "amount") };
      if (Object.values(indexes).some((index) => index < 0)) { setError("需要包含日期、对方、摘要、金额四列。"); return; }
      const rows = lines.slice(1).map((line, index) => {
        const cells = parseCsvLine(line);
        const amount = Number(String(cells[indexes.amount] || "0").replaceAll(",", ""));
        return { id: uid("txn-local"), accountId: workspace.accounts[0]?.id || "bank-local-import", date: /^\d{4}-\d{2}-\d{2}$/.test(cells[indexes.date]) ? cells[indexes.date] : `${workspace.currentPeriod}-01`, counterparty: cells[indexes.counterparty] || "未识别交易对象", summary: cells[indexes.summary] || "本地导入流水", amount: Number.isFinite(amount) ? amount : 0, serial: `LOCAL-${Date.now()}-${index + 1}`, suggestion: "待人工确认", confidence: 0, evidenceIds: [], allocations: [], status: "pending", exceptionReason: "本地导入后尚未完成业务匹配与证据关联" };
      });
      onImport(rows, file);
      onClose();
    };
    reader.onerror = () => setError("无法读取该文件，请确认它是 UTF-8 CSV。");
    reader.readAsText(file, "UTF-8");
  }
  function template() { downloadText("\ufeff日期,对方,摘要,金额\n2026-08-31,示例客户,课程收入,880.00", "财务工作台-银行流水模板.csv", "text/csv;charset=utf-8"); }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal-card import-dialog" role="dialog" aria-modal="true"><div className="modal-heading"><div><p className="eyebrow">浏览器本地处理</p><h2>导入银行流水 CSV</h2></div><button className="icon-button compact" onClick={onClose} type="button" aria-label="关闭"><X size={19} /></button></div><p className="modal-intro">文件不会上传网络。导入后先进入待复核状态，不会因为“建议匹配”自动入账。</p><div className={`drop-zone ${dragging ? "dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); readFile(event.dataTransfer.files?.[0]); }} onClick={() => inputRef.current?.click()}><input ref={inputRef} hidden type="file" accept=".csv,text/csv" onChange={(event) => readFile(event.target.files?.[0])} /><span><UploadSimple size={27} /></span><strong>拖入 CSV，或点击选择文件</strong><small>字段：日期、对方、摘要、金额</small></div>{error && <p className="form-error"><WarningCircle size={16} />{error}</p>}<div className="modal-actions"><button className="secondary-button" onClick={template} type="button"><DownloadSimple size={17} />下载模板</button><button className="primary-button" onClick={() => inputRef.current?.click()} type="button">选择 CSV</button></div></section></div>;
}

function LocalBankImportDialog({ open, onClose, onToast, onComplete }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop foundation-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card foundation-manager" role="dialog" aria-modal="true" aria-labelledby="bank-import-title">
        <div className="modal-heading">
          <div><p className="eyebrow">浏览器本地处理</p><h2 id="bank-import-title">导入银行流水</h2></div>
          <button className="icon-button compact" onClick={onClose} type="button" aria-label="关闭"><X size={19} /></button>
        </div>
        <BankImportPanel onToast={onToast} onComplete={(plan) => { onComplete?.(plan); onClose(); }} />
      </section>
    </div>
  );
}

function NoWorkspace({ onCreate }) {
  return <main className="no-workspace"><span className="welcome-mark">财</span><p className="eyebrow">{PRODUCT_NAME}</p><h1>先创建一个属于你的工作台</h1><p>可以从空白开始，也可以复制“山岚健身工作室”行业模板。模板不是固定品牌，之后可以改名或删除。</p><button className="primary-button" onClick={onCreate} type="button"><Plus size={18} />新建工作台</button><BoundaryNote /></main>;
}

function App() {
  const { state, activeWorkspace, actions, store, fileVault } = useFinanceDesk();
  const [page, setPage] = useState("overview");
  const [workspaceDialog, setWorkspaceDialog] = useState(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const workspace = activeWorkspace ? ensureWorkspace(activeWorkspace) : null;
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: "auto" }); }, [page, workspace?.id]);
  useEffect(() => { if (!toast) return undefined; const timer = window.setTimeout(() => setToast(null), 3200); return () => window.clearTimeout(timer); }, [toast]);
  function mutateActive(updater) {
    const current = store.getActiveWorkspace();
    if (!current) return;
    actions.replaceWorkspace(current.id, ensureWorkspace(updater(ensureWorkspace(current))));
  }
  function openWorkspaceDialog(mode) {
    if (mode === "manage") setManagerOpen(true);
    else setWorkspaceDialog(mode);
  }
  function switchWorkspace(id) {
    actions.switchWorkspace(id);
    setPage("overview");
    setToast({ tone: "success", message: "已切换到" + (state.workspaces.find((item) => item.id === id)?.name || "工作台") });
  }
  async function submitWorkspaceDialog(form) {
    try {
      if (workspaceDialog === "create") {
        const template = state.workspaces.find((item) => item.isDemo || item.templateId === "fitness-studio");
        const input = form.mode === "template" && template
          ? { name: form.name.trim(), sourceWorkspaceId: template.id }
          : { ...form, name: form.name.trim(), legalName: form.legalName.trim() };
        const created = actions.createWorkspace(input);
        actions.updateCompanyProfile(created.id, {
          legalName: form.legalName.trim() || form.name.trim(),
          industry: form.industry,
          taxpayerType: form.taxpayerType,
        });
        setPage("overview");
        setToast({ tone: "success", message: "已创建“" + created.name + "”" });
      } else if (workspaceDialog === "rename" && workspace) {
        const name = form.name.trim();
        actions.renameWorkspace(workspace.id, name);
        setToast({ tone: "success", message: "工作台已改名为“" + name + "”" });
      } else if (workspaceDialog === "delete" && workspace) {
        const deletedName = workspace.name;
        if (fileVault) await fileVault.clearWorkspace(workspace.id);
        actions.deleteWorkspace(workspace.id);
        setPage("overview");
        setToast({ tone: "success", message: "已从本地删除“" + deletedName + "”" });
      }
      setWorkspaceDialog(null);
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "工作台操作失败" });
    }
  }
  function changePeriod(period) { if (!workspace || period === workspace.currentPeriod) return; mutateActive((current) => audit({ ...current, currentPeriod: period, tax: { ...current.tax, period }, delivery: { ...current.delivery, filing: { ...current.delivery.filing, period } } }, "切换账期", `${current.currentPeriod} → ${period}`)); setToast({ tone: "success", message: `已切换到${formatPeriod(period)}` }); }
  function setTransactionStatus(ids, status) {
    if (!workspace || !ids.length) return;
    if (status !== "ignored") {
      setToast({ tone: "warning", message: "核销必须通过单笔会计处理区完成，不能直接改状态" });
      return;
    }
    const idSet = new Set(ids);
    mutateActive((current) => audit({
      ...current,
      transactions: current.transactions.map((item) => idSet.has(item.id) ? { ...item, status: "ignored", reviewedAt: new Date().toISOString() } : item),
    }, "暂不处理流水", idSet.size + " 笔 · 保留原始流水与审计记录"));
    setToast({ tone: "success", message: "已将 " + idSet.size + " 笔设为暂不处理" });
  }
  function reviewTransactions(ids) {
    if (!ids.length) return;
    try {
      mutateActive((current) => ids.reduce((next, id) => {
        const reviewed = reviewTransactionEvidence(next, id, { actor: "周会计", mode: "local-rule" });
        return recordReconciliationSuggestions(reviewed, id, { actor: "周会计", mode: "local-rule" });
      }, current));
      setToast({ tone: "success", message: "已复核 " + ids.length + " 笔并生成本地匹配建议；未自动核销或入账" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "批量规则复核失败" });
    }
  }
  async function addEvidence(transactionId, file) {
    try {
      const document = await saveLocalDocument({
        store,
        fileVault,
        workspaceId: workspace.id,
        file,
        metadata: {
          category: "会计资料",
          period: workspace.currentPeriod,
          relatedObjectIds: [transactionId],
        },
        relation: "supports",
        note: "单笔流水复核证据",
      });
      mutateActive((current) => audit({
        ...current,
        transactions: current.transactions.map((item) => item.id === transactionId ? {
          ...item,
          evidenceIds: [...new Set([...(item.evidenceIds || []), document.id])],
          status: "pending",
          exceptionReason: "",
        } : item),
      }, "补充单笔证据", document.name + " · 关联 " + transactionId + " · SHA-256 " + document.hash.slice(0, 12) + "…"));
      setToast({ tone: "success", message: "原文件与证据关联已保存在当前浏览器，请完成人工确认" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "本地证据保存失败" });
    }
  }
  function exportSelected(items) { const rows = [["日期", "对方", "摘要", "金额", "状态", "流水号"], ...items.map((item) => [item.date, item.counterparty, item.summary, item.amount, transactionStatus(item).label, item.serial])]; const csv = `\ufeff${rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n")}`; downloadText(csv, `${PRODUCT_NAME}-${workspace.currentPeriod}-所选流水.csv`, "text/csv;charset=utf-8"); mutateActive((current) => audit(current, "导出所选流水", `${items.length} 笔 · CSV`)); setToast({ tone: "success", message: `已导出 ${items.length} 笔所选流水` }); }
  function freezeReport() {
    try {
      const snapshot = buildReportSnapshot(workspace);
      if (Math.abs(snapshot.summary.difference) >= 0.01) {
        setToast({ tone: "danger", message: "三表尚未勾稽，不能冻结版本。" });
        return;
      }
      mutateActive((current) => {
        const engineFrozen = freezeAccountingReportVersion(
          current,
          { period: current.currentPeriod, label: "月度财务报表" },
          { actor: "周会计" },
        );
        return freezeReportVersion(engineFrozen, "周会计");
      });
      setToast({ tone: "success", message: "已冻结 " + workspace.currentPeriod + " 新报表版本与来源快照" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "报表校验未通过" });
    }
  }
  function changeTax(field, value) { mutateActive((current) => ({ ...current, tax: { ...current.tax, [field]: value, frozenAt: null, financeConfirmedAt: null, payrollConfirmedAt: null, ownerConfirmedAt: null, confirmedBy: "" }, delivery: { ...current.delivery, filing: { period: current.currentPeriod, draftCreatedAt: null, draftVersionId: null, exportedAt: null, exportedPackage: null, receipt: null, archivedAt: null } } })); }
  function commitTax(field) { const labels = { adjustments: "税会调整", payroll: "工资薪金", socialSecurity: "社保数据", note: "复核备注" }; mutateActive((current) => audit(current, "修改申报底稿", `${labels[field] || field}已更新，后续确认状态已撤销`)); setToast({ tone: "warning", message: "底稿已更新，请重新冻结报表并确认" }); }
  function initialConfirm() {
    try {
      const now = new Date().toISOString();
      mutateActive((current) => {
        let next = createCustomerConfirmationPackage(
          current,
          { period: current.currentPeriod },
          { actor: "周会计", at: now },
        );
        const confirmationId = next.confirmations.at(-1).id;
        ["finance", "revenue", "vat", "payroll", "socialSecurity"].forEach((section, index) => {
          next = recordCustomerConfirmation(next, {
            confirmationId,
            section,
            decision: "approve",
            note: "客户在本地工作台完成首次核对",
          }, { actor: "客户负责人", at: new Date(Date.parse(now) + index).toISOString() });
        });
        return audit({
          ...next,
          tax: { ...next.tax, financeConfirmedAt: now, payrollConfirmedAt: now },
        }, "客户第一次确认", "财务、收入、增值税、工资与社保五个部分已逐项记录");
      });
      setToast({ tone: "success", message: "第一次客户确认已逐项记录并写入审计链" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "客户确认记录失败" });
    }
  }
  function prepareDraft() { mutateActive((current) => prepareFilingDraft(current)); setToast({ tone: "success", message: "本地申报底稿已生成，尚未连接税务局" }); }
  function finalConfirm(name) { const now = new Date().toISOString(); mutateActive((current) => audit({ ...current, tax: { ...current.tax, ownerConfirmedAt: now, confirmedBy: name } }, "客户第二次最终确认", `${name}确认本地申报数据并知晓需外部办理`)); setToast({ tone: "success", message: "第二次最终确认已记录，可以导出本地申报包" }); }
  async function exportPackage() { try { const meta = await exportLocalFilingPackage(workspace); mutateActive((current) => markPackageExported(current, meta)); setToast({ tone: "success", message: "本地申报包已导出；这不代表已提交税务局" }); } catch (error) { setToast({ tone: "danger", message: error.message || "本地申报包导出失败" }); } }
  async function receiveReceipt(file) {
    try {
      const document = await saveLocalDocument({
        store,
        fileVault,
        workspaceId: workspace.id,
        file,
        metadata: {
          category: "申报回执",
          period: workspace.currentPeriod,
        },
      });
      const receipt = await importLocalReceipt(file);
      mutateActive((current) => attachReceipt(current, { ...receipt, documentId: document.id, storage: document.storage }));
      setToast({ tone: "success", message: "真实外部回执原件与索引已保存在当前浏览器" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "无法保存该回执文件" });
    }
  }
  async function addDocuments(files) {
    if (!files.length) return;
    try {
      for (const file of files) {
        await saveLocalDocument({
          store,
          fileVault,
          workspaceId: workspace.id,
          file,
          metadata: {
            category: "会计资料",
            period: workspace.currentPeriod,
          },
        });
      }
      mutateActive((current) => audit(current, "添加本地资料", files.length + " 份 · 原文件保存在浏览器 IndexedDB"));
      setToast({ tone: "success", message: "已把 " + files.length + " 份资料与原文件保存到当前浏览器" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "本地资料保存失败" });
    }
  }
  function completeArchive() { mutateActive((current) => archivePeriod(current)); setToast({ tone: "success", message: `${workspace.currentPeriod} 已完成本地归档` }); }
  function goNextPeriod() { const next = enterNextPeriod(workspace); if (next.currentPeriod === workspace.currentPeriod) { setToast({ tone: "warning", message: "请先完成本期归档。" }); return; } mutateActive(() => next); setPage("overview"); setToast({ tone: "success", message: `已进入${formatPeriod(next.currentPeriod)}，期末余额已继承` }); }
  function exportArchiveIndex() { const index = { product: PRODUCT_NAME, workspace: workspace.name, exportedAt: new Date().toISOString(), archives: workspace.delivery.archives, activeFiling: workspace.delivery.filing, auditLog: workspace.auditLog }; downloadText(JSON.stringify(index, null, 2), `${PRODUCT_NAME}-${workspace.name}-归档索引.json`, "application/json;charset=utf-8"); mutateActive((current) => audit(current, "导出归档索引", `${current.delivery.archives.length} 个期间 · JSON`)); setToast({ tone: "success", message: "归档索引已导出到本地" }); }
  if (!workspace) {
    return (
      <div className="app-shell empty-shell">
        <NoWorkspace onCreate={() => setWorkspaceDialog("create")} />
        <WorkspaceDialog mode={workspaceDialog} workspace={null} onClose={() => setWorkspaceDialog(null)} onSubmit={submitWorkspaceDialog} />
        {toast && <div className={"toast " + toast.tone}><CheckCircle size={19} weight="fill" />{toast.message}</div>}
      </div>
    );
  }
  return (
    <div className="app-shell">
      <Sidebar state={state} workspace={workspace} page={page} onPage={setPage} onSwitchWorkspace={switchWorkspace} onOpenWorkspaceDialog={openWorkspaceDialog} />
      <div className="app-main">
        <Topbar state={state} workspace={workspace} page={page} onPeriod={changePeriod} onImport={() => setImportOpen(true)} onSwitchWorkspace={switchWorkspace} onOpenWorkspaceDialog={openWorkspaceDialog} />
        {page === "overview" && <OverviewPage workspace={workspace} onPage={setPage} />}
        {page === "reconcile" && <ReconcilePage workspace={workspace} onPage={setPage} onStatus={setTransactionStatus} onReview={reviewTransactions} onEvidence={addEvidence} onExportSelected={exportSelected} onToast={(message) => setToast({ tone: "success", message })} />}
        {page === "reports" && <ReportsPage workspace={workspace} onPage={setPage} onFreeze={freezeReport} />}
        {page === "tax" && <TaxPage workspace={workspace} onPage={setPage} onTaxChange={changeTax} onTaxCommit={commitTax} onInitialConfirm={initialConfirm} onPrepareDraft={prepareDraft} onFinalConfirm={finalConfirm} onExport={exportPackage} onReceipt={receiveReceipt} />}
        {page === "archive" && <ArchivePage workspace={workspace} onPage={setPage} onDocuments={addDocuments} onReceipt={receiveReceipt} onArchive={completeArchive} onNextPeriod={goNextPeriod} onExportIndex={exportArchiveIndex} />}
        {page === "setup" && <FoundationRecordsPanel onToast={(message) => setToast({ tone: "success", message })} />}
      </div>
      <BottomNav page={page} onPage={setPage} />
      <WorkspaceDialog mode={workspaceDialog} workspace={workspace} onClose={() => setWorkspaceDialog(null)} onSubmit={submitWorkspaceDialog} />
      <WorkspaceManager open={managerOpen} onClose={() => setManagerOpen(false)} onToast={(message) => setToast({ tone: "success", message })} />
      <LocalBankImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onToast={(message) => setToast({ tone: "success", message })}
        onComplete={() => setPage("reconcile")}
      />
      {toast && <div className={"toast " + toast.tone}><CheckCircle size={19} weight="fill" />{toast.message}</div>}
    </div>
  );
}

export default App;
export { App };
