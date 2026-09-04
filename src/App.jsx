import { useEffect, useRef, useState } from "react";
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
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { transactionStatus, uid } from "./financeData.js";
import {
  attachEvidenceDocument,
  buildManagementMetrics,
  createCustomerConfirmationPackage,
  exportFrozenReportExcel,
  freezeReportVersion as freezeAccountingReportVersion,
  recordCustomerConfirmation,
  recordFrozenReportExcelExport,
  recordReconciliationSuggestions,
  reviewTransactionEvidence,
} from "./domain/accounting/index.js";
import { AccountingWorkbench, ReceivablesPayablesPanel } from "./features/accounting/AccountingWorkbench.jsx";
import { BankImportPanel } from "./features/intake/BankImportPanel.jsx";
import { copyWorkspaceLocalFiles, removeLocalDocument, saveLocalDocument } from "./features/intake/documentIntake.js";
import { MemberLedgerPage } from "./features/members/MemberLedgerPage.jsx";
import {
  MEMBER_EVENT_DEFINITIONS,
  MEMBER_STATUS_OPTIONS,
  addMember,
  addMemberBusinessEvent,
  updateMemberBusinessEventStatus,
  updateMemberStatus,
} from "./features/members/memberLedger.js";
import { FoundationRecordsPanel } from "./features/workspaces/FoundationRecordsPanel.jsx";
import { WorkspaceManager } from "./features/workspaces/WorkspaceManager.jsx";
import {
  CLOSE_STAGES,
  PRODUCT_NAME,
  WORKSPACE_MODULE_OPTIONS,
  archivePeriod,
  attachReceipt,
  audit,
  buildReportSnapshot,
  confirmPayrollSocialData,
  ensureWorkspace,
  enterNextPeriod,
  defaultWorkspaceModules,
  exportLocalFilingPackage,
  formatCurrency,
  formatDateTime,
  formatPeriod,
  freezeReportVersion,
  importLocalReceipt,
  markPackageExported,
  prepareFilingDraft,
  primaryNavigationForWorkspace,
  reportVersionDiff,
  workspaceModuleEnabled,
  workflowChecks,
} from "./productWorkflow.js";
import { useFinanceDesk } from "./store/FinanceDeskProvider.jsx";

const PAGE_ICONS = {
  overview: HouseLine,
  members: UsersThree,
  reconcile: SealCheck,
  reports: ChartBar,
  tax: ShieldCheck,
  archive: Archive,
  setup: GearSix,
};

const PAGE_HEADINGS = {
  overview: ["月结总览", "一眼看清本期进度、风险和下一步。"],
  members: ["会员业务台账", "真实记录充值、耗课、退款、余额与教练提成。"],
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

function Sidebar({ state, workspace, page, onPage, onSwitchWorkspace, onSwitchUser, onOpenWorkspaceDialog }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const workspaceMenuRef = useRef(null);
  const workspaceTriggerRef = useRef(null);
  const accountSwitcherRef = useRef(null);
  const accountTriggerRef = useRef(null);
  const navigation = primaryNavigationForWorkspace(workspace);
  const activeUsers = (workspace?.users || []).filter((user) => user.status === "active");
  const operator = activeUsers.find((user) => user.id === state.activeUserId)
    || activeUsers[0]
    || null;
  const roleName = (user) => workspace.roles?.find((role) => role.id === user?.roleId || role.name === user?.role)?.name || user?.role || "未设置角色";
  const operatorRole = operator
    ? roleName(operator)
    : "可在基础资料中设置";
  useEffect(() => {
    setMenuOpen(false);
    setAccountOpen(false);
  }, [workspace?.id]);
  useEffect(() => {
    if (!menuOpen) return undefined;
    function closeOnOutsidePointer(event) {
      if (!workspaceMenuRef.current?.contains(event.target)) setMenuOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      workspaceTriggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);
  useEffect(() => {
    if (!accountOpen) return undefined;
    function closeOnOutsidePointer(event) {
      if (!accountSwitcherRef.current?.contains(event.target)) setAccountOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key !== "Escape") return;
      setAccountOpen(false);
      accountTriggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [accountOpen]);
  return (
    <aside className="sidebar">
      <div className="sidebar-brand-wrap" ref={workspaceMenuRef}>
        <button ref={workspaceTriggerRef} className="brand" aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => { setAccountOpen(false); setMenuOpen((value) => !value); }} type="button">
          <span className="brand-copy"><strong>{PRODUCT_NAME}</strong><small>{workspace?.name || "还没有工作台"}</small></span>
          <CaretDown size={14} />
        </button>
        {menuOpen && (
          <WorkspaceMenu state={state} activeWorkspace={workspace} onSwitch={onSwitchWorkspace} onOpenDialog={onOpenWorkspaceDialog} onClose={() => setMenuOpen(false)} />
        )}
      </div>

      <nav className="primary-nav" aria-label="主导航">
        {navigation.map((item) => {
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
        <div className="account-switcher" ref={accountSwitcherRef}>
          <button ref={accountTriggerRef} className="account-card account-switcher-trigger" aria-expanded={accountOpen} aria-haspopup="menu" aria-label="切换本地操作人员" onClick={() => { setMenuOpen(false); setAccountOpen((value) => !value); }} type="button"><span className="avatar">{operator?.name?.trim()?.slice(0, 1) || "—"}</span><div><strong>{operator?.name || "未设置操作人员"}</strong><small>{operatorRole}</small></div><CaretDown size={14} /></button>
          {accountOpen && (
            <div className="account-switcher-menu" role="menu">
              {activeUsers.length ? (
                <>
                  {activeUsers.map((user) => <button className={user.id === operator?.id ? "active" : ""} disabled={user.id === operator?.id} key={user.id} onClick={() => { onSwitchUser(user.id); setAccountOpen(false); }} role="menuitem" type="button"><span className="avatar">{user.name?.trim()?.slice(0, 1) || "—"}</span><span><strong>{user.name}</strong><small>{roleName(user)}</small></span>{user.id === operator?.id && <Check size={16} weight="bold" />}</button>)}
                  <button className="account-switcher-manage" onClick={() => { onPage("setup"); setAccountOpen(false); }} role="menuitem" type="button"><GearSix size={16} /><span><strong>管理人员与角色</strong><small>前往基础资料</small></span></button>
                </>
              ) : (
                <button className="account-switcher-empty" onClick={() => { onPage("setup"); setAccountOpen(false); }} role="menuitem" type="button"><Plus size={16} /><span><strong>去基础资料添加人员</strong><small>不创建虚构登录身份</small></span></button>
              )}
            </div>
          )}
        </div>
        <BoundaryNote compact />
      </div>
    </aside>
  );
}

function BottomNav({ workspace, page, onPage }) {
  return (
    <nav className="bottom-nav" aria-label="移动端导航">
      {primaryNavigationForWorkspace(workspace).map((item) => {
        const Icon = PAGE_ICONS[item.id];
        return <button className={page === item.id ? "active" : ""} key={item.id} onClick={() => onPage(item.id)} type="button"><Icon size={19} weight={page === item.id ? "fill" : "regular"} /><span>{item.shortLabel}</span></button>;
      })}
    </nav>
  );
}

function Topbar({ state, workspace, page, workspaceOverlayOpen, onImport, onSwitchWorkspace, onOpenWorkspaceDialog }) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const workspaceMenuRef = useRef(null);
  const workspaceTriggerRef = useRef(null);
  const moreMenuRef = useRef(null);
  const moreTriggerRef = useRef(null);
  const [title, subtitle] = PAGE_HEADINGS[page];
  useEffect(() => {
    setWorkspaceOpen(false);
    setMoreOpen(false);
  }, [page, workspace?.id, workspaceOverlayOpen]);
  useEffect(() => {
    if (!workspaceOpen) return undefined;
    function closeOnOutsidePointer(event) {
      if (!workspaceMenuRef.current?.contains(event.target)) setWorkspaceOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key !== "Escape") return;
      setWorkspaceOpen(false);
      workspaceTriggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [workspaceOpen]);
  useEffect(() => {
    if (!moreOpen) return undefined;
    function closeOnOutsidePointer(event) {
      if (!moreMenuRef.current?.contains(event.target)) setMoreOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key !== "Escape") return;
      setMoreOpen(false);
      moreTriggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [moreOpen]);
  function openWorkspaceDialog(mode) {
    setWorkspaceOpen(false);
    setMoreOpen(false);
    onOpenWorkspaceDialog(mode);
  }
  return (
    <header className="topbar">
      <div className="topbar-title">
        <p className="eyebrow">{workspace ? `${formatPeriod(workspace.currentPeriod)} · ${workspace.isDemo ? "行业模板" : "本地账套"}` : PRODUCT_NAME}</p>
        <h1>{title}</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
      <div className="topbar-actions">
        <div className="mobile-workspace-wrap" ref={workspaceMenuRef}>
          <button ref={workspaceTriggerRef} className="secondary-button mobile-workspace" aria-expanded={workspaceOpen} aria-haspopup="menu" onClick={() => { setMoreOpen(false); setWorkspaceOpen((value) => !value); }} type="button"><span>{workspace?.name || "选择工作台"}</span><CaretDown size={14} /></button>
          {workspaceOpen && <WorkspaceMenu state={state} activeWorkspace={workspace} onSwitch={onSwitchWorkspace} onOpenDialog={openWorkspaceDialog} onClose={() => setWorkspaceOpen(false)} />}
        </div>
        {workspace && <div className="period-select" aria-label={`当前活动账期 ${formatPeriod(workspace.currentPeriod)}`} title="历史账期请在资料归档中查看；新账期由归档流程创建"><CalendarBlank size={18} /><span><small>活动账期</small><strong>{formatPeriod(workspace.currentPeriod)}</strong></span></div>}
        {workspace && workspaceModuleEnabled(workspace, "reconcile") && (page === "overview" || page === "reconcile") && <button className="primary-button" onClick={onImport} type="button"><UploadSimple size={18} weight="bold" />本地导入</button>}
        {workspace && (
          <div className="menu-wrap" ref={moreMenuRef}>
            <button ref={moreTriggerRef} className="icon-button" aria-label="更多操作" aria-expanded={moreOpen} aria-haspopup="menu" onClick={() => { setWorkspaceOpen(false); setMoreOpen((value) => !value); }} type="button"><GearSix size={20} /></button>
            {moreOpen && <div className="popover-menu" role="menu"><button role="menuitem" onClick={() => openWorkspaceDialog("manage")} type="button"><GearSix size={17} />管理、复制与备份</button><button role="menuitem" onClick={() => openWorkspaceDialog("rename")} type="button"><PencilSimple size={17} />重命名工作台</button><button role="menuitem" onClick={() => openWorkspaceDialog("create")} type="button"><Plus size={17} />新建工作台</button><button role="menuitem" onClick={() => openWorkspaceDialog("delete")} type="button"><Trash size={17} />删除工作台</button></div>}
          </div>
        )}
      </div>
    </header>
  );
}

function StageRail({ workspace, onPage }) {
  const flow = workflowChecks(workspace);
  const stages = CLOSE_STAGES.filter((stage) => workspaceModuleEnabled(workspace, stage.page));
  const periodTransactions = workspace.transactions.filter((item) => String(item.date || "").startsWith(workspace.currentPeriod));
  const done = {
    documents: workspace.documents.some((item) => item.period === workspace.currentPeriod) || periodTransactions.length === 0,
    match: periodTransactions.length > 0,
    reconcile: flow.unresolved.length === 0,
    vouchers: workspace.vouchers.some((item) => item.status === "posted" && String(item.date || "").startsWith(workspace.currentPeriod)),
    reports: Boolean(flow.version),
    confirm: Boolean(workspace.tax.ownerConfirmedAt),
  };
  const firstPending = stages.findIndex((stage) => !done[stage.id]);
  const activeIndex = firstPending < 0 ? stages.length - 1 : firstPending;
  return (
    <div className="stage-rail" aria-label="月结阶段">
      {stages.map((stage, index) => <button className={`stage-step ${done[stage.id] ? "done" : ""} ${index === activeIndex ? "active" : ""}`} key={stage.id} onClick={() => onPage(stage.page)} type="button"><span className="stage-dot">{done[stage.id] ? <Check size={12} weight="bold" /> : index + 1}</span><span>{stage.label}</span></button>)}
    </div>
  );
}

function MetricCard({ label, value, note, icon: Icon, tone = "plain", onClick }) {
  const content = <><span className="metric-icon"><Icon size={20} /></span><span className="metric-copy"><small>{label}</small><strong>{value}</strong><span>{note}</span></span>{onClick && <ArrowRight size={16} className="metric-arrow" />}</>;
  return onClick ? <button className={`metric-card ${tone}`} onClick={onClick} type="button">{content}</button> : <article className={`metric-card ${tone}`}>{content}</article>;
}

function OverviewPage({ workspace, onPage, onResolveNotice }) {
  const flow = workflowChecks(workspace);
  const reconciliationEnabled = workspaceModuleEnabled(workspace, "reconcile");
  const taxEnabled = workspaceModuleEnabled(workspace, "tax");
  const snapshot = flow.snapshot;
  const periodTransactions = workspace.transactions.filter((item) => String(item.date || "").startsWith(workspace.currentPeriod));
  const periodNotices = (workspace.delivery.notices || []).filter((notice) => notice.period === workspace.currentPeriod);
  const openNotices = periodNotices.filter((notice) => notice.status !== "resolved");
  const completionItems = [
    workspace.documents.length > 0,
    openNotices.length === 0,
    ...(reconciliationEnabled ? [periodTransactions.length > 0, flow.unresolved.length === 0, workspace.vouchers.length > 0] : []),
    Boolean(flow.version),
    ...(taxEnabled ? [Boolean(workspace.tax.ownerConfirmedAt)] : []),
  ];
  const progress = Math.round((completionItems.filter(Boolean).length / completionItems.length) * 100);
  const nextAction = openNotices.length
    ? { title: `先处理 ${openNotices.length} 项上期结转事项`, body: "延期事项已带入本期，处理后会保留来源与审计记录。", page: "overview", action: "查看结转事项" }
    : reconciliationEnabled && flow.unresolved.length
    ? { title: `先处理 ${flow.unresolved.length} 笔未完成流水`, body: "低置信度和证据不足事项不会自动入账。", page: "reconcile", action: "进入批量核销" }
    : !flow.version
      ? { title: "冻结本期第一版报表", body: "冻结后会保留不可覆盖的版本快照和后续差异。", page: "reports", action: "查看报表" }
      : taxEnabled && !workspace.tax.financeConfirmedAt
        ? { title: "请客户完成首次数据确认", body: "财务数据与工资社保会分别留下确认记录。", page: "tax", action: "开始确认" }
        : taxEnabled && !workspace.tax.ownerConfirmedAt
          ? { title: "完成提交前最终确认", body: "最终确认后才能导出本地申报包。", page: "tax", action: "继续确认" }
          : taxEnabled && !workspace.delivery.filing.receipt
            ? { title: "等待真实外部办理回执", body: "税务局未连接；请在外部办理后把回执导回本地。", page: "tax", action: "查看申报边界" }
            : !workspace.delivery.filing.archivedAt
              ? { title: "回执齐全，可以完成归档", body: "归档会锁定本期交付索引，并准备下一期期初。", page: "archive", action: "进入归档" }
              : { title: "本期已经归档", body: "可以在归档页确认继承内容并进入下一期。", page: "archive", action: "查看归档" };
  const focusTransaction = flow.unresolved[0] || periodTransactions[0];
  const linkedDocuments = focusTransaction ? workspace.documents.filter((document) => focusTransaction.evidenceIds?.includes(document.id)) : [];
  const tasks = [
    { label: "处理上期结转事项", meta: openNotices.length ? `${openNotices.length} 项待处理` : "已完成", done: openNotices.length === 0, page: "overview" },
    ...(reconciliationEnabled ? [{ label: "完成异常与低置信度复核", meta: flow.unresolved.length ? `${flow.unresolved.length} 笔待处理` : "已完成", done: flow.unresolved.length === 0, page: "reconcile" }] : []),
    { label: "冻结月度报表版本", meta: flow.version ? `${flow.version.label} · ${formatDateTime(flow.version.createdAt)}` : "尚未冻结", done: Boolean(flow.version), page: "reports" },
    ...(taxEnabled ? [{ label: "客户首次确认财务与工资社保", meta: workspace.tax.financeConfirmedAt && workspace.tax.payrollConfirmedAt ? formatDateTime(workspace.tax.financeConfirmedAt) : "等待确认", done: Boolean(workspace.tax.financeConfirmedAt && workspace.tax.payrollConfirmedAt), page: "tax" }] : []),
    { label: "最终确认、回执与归档", meta: workspace.delivery.filing.archivedAt ? formatDateTime(workspace.delivery.filing.archivedAt) : "尚未归档", done: Boolean(workspace.delivery.filing.archivedAt), page: "archive" },
  ];
  return (
    <div className="page-content overview-page">
      <StageRail workspace={workspace} onPage={onPage} />
      <section className="hero-grid">
        <article className="progress-card"><div className="section-heading compact"><div><p className="eyebrow">本月关账进度</p><h2>{progress === 100 ? "本期交付已经闭环" : "距离关账，还差几件小事"}</h2></div><span className="progress-number">{progress}%</span></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div><div className="progress-meta"><span><i className="dot sage" />已完成 {completionItems.filter(Boolean).length} / {completionItems.length} 个阶段</span>{reconciliationEnabled && <span><i className="dot clay" />{flow.unresolved.length} 笔待复核</span>}</div></article>
        <article className="next-action-card"><span className="card-kicker"><Sparkle size={17} weight="fill" />下一步建议</span><h3>{nextAction.title}</h3><p>{nextAction.body}</p><button className="text-button" onClick={() => onPage(nextAction.page)} type="button">{nextAction.action}<ArrowRight size={16} /></button></article>
      </section>
      {periodNotices.length > 0 && <section className="panel carry-forward-panel"><div className="panel-heading"><div><p className="eyebrow">S13 · 跨期事项</p><h2>上期延续到本期的待办</h2></div><TonePill tone={openNotices.length ? "warning" : "success"}>{openNotices.length ? `${openNotices.length} 项待处理` : "全部处理完成"}</TonePill></div><div className="carry-forward-list">{periodNotices.map((notice) => <article className={notice.status === "resolved" ? "resolved" : ""} key={notice.id}><span><strong>{notice.message}</strong><small>来源 {notice.sourceId} · {formatCurrency(notice.amount, { sign: true })}</small></span>{notice.status === "resolved" ? <TonePill tone="success">已处理</TonePill> : <button className="secondary-button" onClick={() => onResolveNotice(notice.id)} type="button">标记已处理</button>}</article>)}</div></section>}
      <section className="metric-grid four">
        <MetricCard label="本月收款" value={formatCurrency(snapshot.summary.cashIn)} note={`${periodTransactions.filter((item) => Number(item.amount) > 0).length} 笔流入`} icon={Bank} />
        <MetricCard label="本月收入" value={formatCurrency(snapshot.summary.revenue)} note="来自已入账凭证" icon={TrendUp} tone="sage" onClick={() => onPage("reports")} />
        <MetricCard label="本月利润" value={formatCurrency(snapshot.summary.profit)} note="税前本地口径" icon={ChartBar} />
        {taxEnabled && <MetricCard label="预计税费" value={formatCurrency(snapshot.summary.estimatedTax)} note="演示估算，不可申报" icon={Receipt} tone="clay" onClick={() => onPage("tax")} />}
      </section>
      <section className="overview-grid">
        <article className="panel task-panel"><div className="panel-heading"><div><p className="eyebrow">月结任务</p><h2>本期待办</h2></div><TonePill tone={flow.unresolved.length ? "warning" : "success"}>{flow.unresolved.length ? `${flow.unresolved.length} 项阻塞` : "可以继续"}</TonePill></div><div className="task-list">{tasks.map((task) => <button className="task-row" key={task.label} onClick={() => onPage(task.page)} type="button"><span className={`task-check ${task.done ? "done" : ""}`}>{task.done && <Check size={13} weight="bold" />}</span><span><strong>{task.label}</strong><small>{task.meta}</small></span><ArrowRight size={16} /></button>)}</div></article>
        {reconciliationEnabled && <article className="panel evidence-preview"><div className="panel-heading"><div><p className="eyebrow">单笔证据预览</p><h2>{focusTransaction ? focusTransaction.summary : "还没有流水"}</h2></div>{focusTransaction && <TonePill tone={focusTransaction.status === "reconciled" ? "success" : "warning"}>{transactionStatus(focusTransaction).label}</TonePill>}</div>{focusTransaction ? <><div className="evidence-flow"><div className="flow-node good"><Bank size={19} /><span>银行流水</span><small>{formatCurrency(focusTransaction.amount, { sign: true })}</small></div><ArrowRight size={18} /><div className={`flow-node ${focusTransaction.allocations?.length || focusTransaction.directAccount ? "good" : "missing"}`}><Receipt size={19} /><span>业务判断</span><small>{focusTransaction.suggestion || "待确认"}</small></div><ArrowRight size={18} /><div className={`flow-node ${linkedDocuments.length ? "good" : "missing"}`}><FileText size={19} /><span>本地证据</span><small>{linkedDocuments.length ? `${linkedDocuments.length} 份已关联` : "等待补齐"}</small></div></div>{focusTransaction.exceptionReason && <div className="warning-note"><WarningCircle size={18} /><span><strong>待复核：</strong>{focusTransaction.exceptionReason}</span></div>}<button className="primary-button wide" onClick={() => onPage("reconcile")} type="button">打开单笔证据复核<ArrowRight size={17} /></button></> : <EmptyState title="等待本地流水" description="导入 CSV 后，这里会显示第一条证据链。" />}</article>}
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
        return <div aria-selected={focusedId === item.id} className={`transaction-grid-row transaction-row ${focusedId === item.id ? "focused" : ""}`} key={item.id} onClick={() => onFocus(item.id)} onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && onFocus(item.id)} role="button" tabIndex={0}><label className="check-cell" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selectedIds.has(item.id)} onChange={(event) => onToggle(item.id, event.target.checked)} aria-label={`选择 ${item.counterparty}`} /></label><span className="date-cell" data-label="日期">{dateLabel(item.date)}</span><span className="transaction-main" data-label="交易"><strong>{item.counterparty}</strong><small>{item.summary}</small></span><span className="suggestion-cell" data-label="建议处理"><strong>{item.suggestion || "待确认"}</strong><small>{item.classification?.confidence ?? item.confidence ?? 0}% 置信度</small></span><span className={Number(item.amount) < 0 ? "amount expense" : "amount income"} data-label="金额">{formatCurrency(item.amount, { sign: true })}</span><span data-label="证据"><EvidenceMeter transaction={item} /></span><span data-label="状态"><TonePill tone={status.tone}>{status.label}</TonePill></span></div>;
      })}
      {!items.length && <EmptyState icon={MagnifyingGlass} title="没有符合条件的流水" description="换一个筛选条件或关键词试试。" />}
    </div>
  );
}

function TransactionDetail({ workspace, transaction, onClose, onStatus, onEvidence, onLinkEvidence, onToast }) {
  const evidenceInput = useRef(null);
  const [evidenceCategory, setEvidenceCategory] = useState("发票");
  const [existingEvidenceId, setExistingEvidenceId] = useState("");
  useEffect(() => {
    setEvidenceCategory("发票");
    setExistingEvidenceId("");
  }, [transaction?.id]);
  if (!transaction) return null;
  const linkedDocuments = workspace.documents.filter((item) => transaction.evidenceIds?.includes(item.id));
  const availableDocuments = workspace.documents.filter((item) => !transaction.evidenceIds?.includes(item.id));
  const allocations = (transaction.allocations || []).map((allocation) => ({ ...allocation, bill: workspace.bills.find((bill) => bill.id === allocation.billId) }));
  return (
    <aside className="detail-panel">
      <div className="detail-heading"><div><p className="eyebrow">单笔证据复核</p><h2>{transaction.counterparty}</h2></div><button className="icon-button compact" onClick={onClose} aria-label="关闭详情" type="button"><X size={19} /></button></div>
      <div className="detail-scroll">
        <section className="detail-section"><div className="detail-section-title"><i className="section-mark sage" />银行流水</div><dl className="detail-list"><div><dt>交易日期</dt><dd>{transaction.date}</dd></div><div><dt>流水号</dt><dd>{transaction.serial}</dd></div><div><dt>摘要</dt><dd>{transaction.summary}</dd></div><div><dt>金额</dt><dd className={Number(transaction.amount) < 0 ? "expense" : "income"}>{formatCurrency(transaction.amount, { sign: true })}</dd></div><div><dt>置信度</dt><dd>{transaction.classification?.confidence ?? transaction.confidence ?? 0}%</dd></div></dl></section>
        <section className="detail-section"><div className="detail-section-title"><i className="section-mark clay" />会计判断与核销</div><p className="match-reason"><Sparkle size={16} weight="fill" />{transaction.suggestion || "尚未形成建议处理"}</p>{allocations.length ? <div className="allocation-list">{allocations.map((allocation) => <div key={`${allocation.billId}-${allocation.amount}`}><span><strong>{allocation.bill?.no || allocation.billId}</strong><small>{allocation.bill?.summary || "本地账单"}</small></span><b>{formatCurrency(allocation.amount)}</b></div>)}</div> : <p className="quiet-copy">当前没有关联账单；人工复核后可以暂存判断，但不会伪造外部匹配。</p>}</section>
        <section className="detail-section">
          <div className="detail-section-title"><i className="section-mark sage" />本地证据</div>
          {linkedDocuments.length ? <div className="evidence-file-list">{linkedDocuments.map((document) => <div key={document.id}><FileText size={18} /><span><strong>{document.name}</strong><small>{document.type || document.category || "本地资料"} · {fileSize(document.size)}</small></span><CheckCircle size={17} weight="fill" /></div>)}</div> : <div className="missing-evidence"><WarningCircle size={20} /><span><strong>还没有关联证据</strong><small>{transaction.exceptionReason || "请选择本地文件补充证据。"}</small></span></div>}
          {availableDocuments.length > 0 && <div className="existing-evidence-link"><label className="field-label"><span>关联资料库中的已有文件</span><select value={existingEvidenceId} onChange={(event) => setExistingEvidenceId(event.target.value)}><option value="">请选择已有资料</option>{availableDocuments.map((document) => <option value={document.id} key={document.id}>{document.name} · {document.category || document.type || "本地资料"}</option>)}</select></label><button className="secondary-button wide" disabled={!existingEvidenceId} onClick={() => { if (onLinkEvidence(transaction.id, existingEvidenceId)) setExistingEvidenceId(""); }} type="button"><FileText size={17} />关联已有资料</button></div>}
          <label className="field-label"><span>上传新证据的类别</span><select value={evidenceCategory} onChange={(event) => setEvidenceCategory(event.target.value)}><option>发票</option><option>合同</option><option>审批单</option><option>采购单</option><option>结算单</option>{workspaceModuleEnabled(workspace, "members") && <><option>会员协议</option><option>签到记录</option></>}<option>工资表</option><option>社保数据</option><option>退款申请</option><option>内部转账回单</option><option>其他资料</option></select></label>
          <input ref={evidenceInput} hidden type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) onEvidence(transaction.id, file, evidenceCategory); event.target.value = ""; }} />
          <button className="secondary-button wide" onClick={() => evidenceInput.current?.click()} type="button"><FileArrowUp size={17} />上传新的本地证据</button>
        </section>
        <AccountingWorkbench transactionId={transaction.id} onToast={onToast} />
      </div>
      <div className="detail-actions"><button className="secondary-button" onClick={() => onStatus([transaction.id], "ignored")} type="button">暂不处理</button><span className="detail-action-note">核销与入账请使用上方真实会计处理区</span></div>
    </aside>
  );
}

function ReconcilePage({ workspace, onPage, onStatus, onReview, onEvidence, onLinkEvidence, onExportSelected, onResolveException, onToast }) {
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
  const customerDisputes = (workspace.exceptionTasks || []).filter((task) => task.code === "customer_dispute" && task.status !== "resolved");
  return (
    <div className="reconcile-page">
      <div className="reconcile-main">
        <StageRail workspace={workspace} onPage={onPage} />
        {customerDisputes.length > 0 && <section className="panel dispute-review-panel"><div><p className="eyebrow">S7 · 客户异议退回</p><h2>先处理客户提出的差异</h2></div>{customerDisputes.map((task) => <article key={task.id}><span><strong>{task.message}</strong><small>{task.sourceId} · {formatDateTime(task.createdAt)}</small></span><button className="secondary-button" type="button" onClick={() => onResolveException(task.id)}>已处理，关闭异议</button></article>)}</section>}
        <ReceivablesPayablesPanel showMemberBusiness={workspaceModuleEnabled(workspace, "members")} onToast={onToast} />
        <section className="workspace-toolbar"><div className="filter-tabs" role="tablist" aria-label="流水状态筛选">{FILTERS.map((item) => <button className={filter === item.id ? "active" : ""} key={item.id} onClick={() => setFilter(item.id)} role="tab" type="button">{item.label}<span>{counts[item.id]}</span></button>)}</div><label className="search-field"><MagnifyingGlass size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索对方、摘要或流水号" /><button className={query ? "visible" : ""} onClick={() => setQuery("")} type="button" aria-label="清空搜索"><X size={15} /></button></label></section>
        {selection.length > 0 && <div className="batch-bar"><span><strong>已选择 {selection.length} 笔</strong><small>批量动作只作用于当前选择</small></span><div><button className="soft-button" onClick={() => onExportSelected(selection)} type="button"><DownloadSimple size={16} />导出所选</button><button className="secondary-button" onClick={() => onStatus([...selectedIds], "ignored")} type="button">暂不处理</button><button className="primary-button" onClick={() => onReview([...selectedIds])} type="button">运行规则复核</button><button className="icon-button compact" onClick={() => setSelectedIds(new Set())} type="button" aria-label="清除选择"><X size={17} /></button></div></div>}
        <section className="panel table-panel"><div className="table-heading"><span>本期流水</span><span>{filtered.length} / {periodTransactions.length} 笔</span></div><TransactionList items={filtered} selectedIds={selectedIds} focusedId={focusedId} onToggle={toggle} onToggleAll={toggleAll} onFocus={setFocusedId} /></section>
        <BoundaryNote />
      </div>
      <TransactionDetail workspace={workspace} transaction={focused} onClose={() => setFocusedId(null)} onStatus={onStatus} onEvidence={onEvidence} onLinkEvidence={onLinkEvidence} onToast={onToast} />
    </div>
  );
}

function DrilldownPanel({ row, sectionLabel, onClose }) {
  if (!row) return null;
  return <aside className="detail-panel report-detail"><div className="detail-heading"><div><p className="eyebrow">{sectionLabel} · 数字追溯</p><h2>{row.label}</h2></div><button className="icon-button compact" onClick={onClose} type="button" aria-label="关闭下钻"><X size={19} /></button></div><div className="detail-scroll"><div className="drill-total"><span>报表金额</span><strong>{formatCurrency(row.value)}</strong></div>{row.formula && <div className="drill-formula"><small>计算口径</small><strong>{row.formula}</strong></div>}{row.details?.length ? <div className="drill-list">{row.details.map((item) => <div key={item.id}><span><strong>{item.title}</strong><small>{item.date || "—"} · {item.reference || "本地记录"}</small>{item.description && <small>{item.description}</small>}{(item.sourceIds?.length || item.evidenceIds?.length) && <small>{item.sourceIds?.length || 0} 个业务来源 · {item.evidenceIds?.length || 0} 份凭证附件</small>}</span><b>{formatCurrency(item.amount, { sign: true })}</b></div>)}</div> : <EmptyState title="当前数字来自明确计算口径" description={row.formula || "没有额外的单笔来源。"} />}</div></aside>;
}

const STORE_REPORT_METRICS = [
  { id: "collections", label: "本期收款" },
  { id: "recognizedRevenue", label: "确认收入" },
  { id: "refunds", label: "退款" },
  { id: "coachCommission", label: "教练提成" },
  { id: "grossProfit", label: "毛利" },
  { id: "unfulfilledBalance", label: "预收 / 未履约" },
];

function StoreManagementReport({ report }) {
  return (
    <section className="panel store-management-report">
      <div className="panel-heading"><div><p className="eyebrow">老板报表 · 门店经营</p><h2>按门店查看收款、收入与履约余额</h2><p>实时读取已入账会员业务；毛利口径为确认收入减教练提成。展开门店可追溯到会员、业务事件和凭证。</p></div><span>{report.stores.length} 家门店</span></div>
      {report.postingCoverage.unpostedEventCount > 0 && <div className="store-report-notice"><WarningCircle size={16} /><span>本期另有 {report.postingCoverage.unpostedEventCount} 笔已确认业务尚未入账，暂不进入门店报表。</span></div>}
      <div className="store-report-table">
        <div className="store-report-row heading"><span>门店</span>{STORE_REPORT_METRICS.map((metric) => <span key={metric.id}>{metric.label}</span>)}</div>
        {report.stores.map((store) => (
          <details className="store-report-store" key={store.id}>
            <summary className="store-report-row"><span><strong>{store.name}</strong><small>{store.sources.length} 条来源 · {store.voucherIds.length} 张凭证</small></span>{STORE_REPORT_METRICS.map((metric) => <strong key={metric.id}>{formatCurrency(store.metrics[metric.id])}</strong>)}</summary>
            <div className="store-report-drilldown">
              <section>
                <div className="subheading"><strong>会员明细</strong><span>{store.members.length} 名</span></div>
                {store.members.length ? <div className="store-member-list">{store.members.map((member) => <article key={member.id}><span><strong>{member.name}</strong><small>{[member.coach, member.department, member.project].filter(Boolean).join(" · ") || "未记录教练 / 部门 / 项目"}</small></span><span><small>收款 / 收入</small><strong>{formatCurrency(member.metrics.collections)} / {formatCurrency(member.metrics.recognizedRevenue)}</strong></span><span><small>退款 / 提成</small><strong>{formatCurrency(member.metrics.refunds)} / {formatCurrency(member.metrics.coachCommission)}</strong></span><span><small>未履约</small><strong>{formatCurrency(member.metrics.unfulfilledBalance)}</strong></span></article>)}</div> : <p className="quiet-copy">当前门店没有会员维度来源。</p>}
              </section>
              <section>
                <div className="subheading"><strong>业务与凭证来源</strong><span>{store.sources.length} 条</span></div>
                {store.sources.length ? <div className="store-source-list">{store.sources.map((source) => {
                  const impacts = STORE_REPORT_METRICS.filter((metric) => Number(source.impacts?.[metric.id] || 0) !== 0);
                  return <article key={source.id}><span><strong>{source.label}{source.memberName ? " · " + source.memberName : ""}</strong><small>{source.date || "期初"} · {[source.coach, source.department, source.project].filter(Boolean).join(" · ") || "未记录教练 / 部门 / 项目"}</small><small>{source.voucherIds.length ? "凭证 " + source.voucherIds.join("、") : "会员期初来源"} · 事件 {source.eventId || source.id}</small></span><span>{impacts.map((metric) => <small key={metric.id}>{metric.label} {formatCurrency(source.impacts[metric.id], { sign: true })}</small>)}</span></article>;
                })}</div> : <p className="quiet-copy">尚无已入账会员业务来源。</p>}
              </section>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function BillSourceRows({ rows }) {
  return rows.length ? <div className="owner-source-rows">{rows.map((row) => {
    const timing = row.kind === "account"
      ? "银行账户"
      : ["depositReceived", "prepaymentPaid"].includes(row.kind)
        ? "预收 / 预付余额，不进入普通账龄"
        : row.dueDate ? "到期 " + row.dueDate : "缺少到期日";
    return <article key={row.billId || row.id}><span><strong>{row.counterparty || row.label || row.billNo}</strong><small>{row.summary || row.reference || "本地业务来源"}</small><small>{row.billNo || row.reference || row.billId} · {timing} · 来源 {row.sourceIds?.join("、") || "—"}</small></span><strong>{formatCurrency(row.balance ?? row.availableBalance ?? row.amount)}</strong></article>;
  })}</div> : <p className="quiet-copy">当前没有对应来源。</p>;
}

function ForecastEventRows({ events }) {
  return events.length ? <div className="owner-source-rows">{events.map((event) => <article key={event.id}><span><strong>{event.label}</strong><small>{event.dueDate ? "原到期日 " + event.dueDate + (event.overdueAtStart ? " · 已逾期，列入预测首日" : "") : "缺少明确支付 / 回款日期"}{event.basis ? " · " + event.basis : ""}</small><small>{event.reference || "本地记录"} · 来源 {event.sourceIds?.join("、") || "—"}</small></span><strong>{formatCurrency(event.cashEffect ?? (event.type === "receivable" ? event.amount : -event.amount), { sign: true })}</strong></article>)}</div> : <p className="quiet-copy">当前没有对应来源。</p>;
}

function OwnerLiquidityReport({ management }) {
  const ageing = management.ageing;
  const forecast = management.cashForecast;
  const forecastTotals = [
    { id: "receivable", label: "预计应收回款" },
    { id: "payable", label: "到期应付" },
    { id: "payroll", label: "已确认工资" },
    { id: "socialSecurity", label: "已确认社保" },
    { id: "tax", label: "已确认税款" },
  ];
  return (
    <section className="panel owner-liquidity-report">
      <div className="panel-heading"><div><p className="eyebrow">老板报表 · 资金与往来</p><h2>真实账龄与未来 30 天现金</h2><p>账龄只统计未核销的普通应收、应付；预收与预付单列。现金预测仅采用明确到期日和已确认金额，缺日期项目不进入曲线。</p></div><span>截至 {ageing.asOf}</span></div>
      <div className="owner-liquidity-layout">
        <section className="owner-report-section">
          <div className="subheading"><strong>应收应付账龄</strong><span>未核销余额</span></div>
          <div className="ageing-table">
            <div className="ageing-row heading"><span>账龄</span><span>应收</span><span>应付</span></div>
            {ageing.buckets.map((bucket) => <details key={bucket.id}><summary className="ageing-row"><span>{bucket.label}<small>{bucket.rows.length} 笔</small></span><strong>{formatCurrency(bucket.receivable.value)}</strong><strong>{formatCurrency(bucket.payable.value)}</strong></summary><BillSourceRows rows={bucket.rows} /></details>)}
          </div>
          <details className={ageing.missingDueDate.rows.length ? "owner-missing-sources warning" : "owner-missing-sources"} open={ageing.missingDueDate.rows.length > 0}>
            <summary><span><strong>缺少到期日</strong><small>不猜测，不放入账龄区间或现金预测</small></span><span>应收 {formatCurrency(ageing.missingDueDate.receivable.value)} · 应付 {formatCurrency(ageing.missingDueDate.payable.value)}</span></summary>
            <BillSourceRows rows={ageing.missingDueDate.rows} />
          </details>
          <div className="advance-exclusion">
            <div><strong>预收 / 预付单独管理</strong><small>{ageing.excludedAdvances.reason}</small></div>
            <details><summary>客户预收 <strong>{formatCurrency(ageing.excludedAdvances.customerDeposits.value)}</strong></summary><BillSourceRows rows={ageing.excludedAdvances.customerDeposits.rows} /></details>
            <details><summary>供应商预付 <strong>{formatCurrency(ageing.excludedAdvances.supplierPrepayments.value)}</strong></summary><BillSourceRows rows={ageing.excludedAdvances.supplierPrepayments.rows} /></details>
          </div>
        </section>

        <section className="owner-report-section">
          <div className="subheading"><strong>未来 30 天现金预测</strong><span>{forecast.startDate} 至 {forecast.endDate}</span></div>
          <p className="forecast-formula">{forecast.formula}</p>
          <div className="forecast-key-grid">
            <details><summary><span>当前银行余额</span><strong>{formatCurrency(forecast.currentBalance.value)}</strong></summary><BillSourceRows rows={forecast.currentBalance.accounts.map((account) => ({ ...account, kind: "account", amount: account.value, reference: account.id }))} /></details>
            <details><summary><span>最低预测余额</span><strong>{formatCurrency(forecast.minimumBalance.value)}</strong><small>{forecast.minimumBalance.date}</small></summary><BillSourceRows rows={forecast.currentBalance.accounts.map((account) => ({ ...account, kind: "account", amount: account.value, reference: account.id }))} /><ForecastEventRows events={forecast.minimumBalance.events} /></details>
            <details className={forecast.cashShortfall.value > 0 ? "danger" : ""}><summary><span>现金缺口</span><strong>{formatCurrency(forecast.cashShortfall.value)}</strong><small>{forecast.deficitDate || "预测期内无缺口"}</small></summary><BillSourceRows rows={forecast.currentBalance.accounts.map((account) => ({ ...account, kind: "account", amount: account.value, reference: account.id }))} /><ForecastEventRows events={forecast.cashShortfall.events} /></details>
          </div>
          <div className="forecast-total-grid">{forecastTotals.map((item) => {
            const total = forecast.totals[item.id];
            return <details key={item.id}><summary><span>{item.label}</span><strong>{formatCurrency(total.value)}</strong></summary><ForecastEventRows events={total.events} /></details>;
          })}</div>
          <div className="forecast-week-list">
            <div className="forecast-week-row heading"><span>周期</span><span>预计流入</span><span>预计流出</span><span>期末余额</span></div>
            {forecast.weeks.map((week) => <details key={week.id}><summary className="forecast-week-row"><span><strong>{week.label}</strong><small>{week.startDate} 至 {week.endDate}</small></span><strong>{formatCurrency(week.receipts)}</strong><strong>{formatCurrency(week.payments)}</strong><strong>{formatCurrency(week.closingBalance)}</strong></summary><div className="forecast-day-list">{week.rows.map((day) => <article key={day.date}><div className="forecast-day-row"><span>{day.date}</span><span>+{formatCurrency(day.receipts)}</span><span>−{formatCurrency(day.payments)}</span><strong>{formatCurrency(day.closingBalance)}</strong></div><ForecastEventRows events={day.events} /></article>)}</div></details>)}
          </div>
          {forecast.missingSchedule.length > 0 && <details className="owner-missing-sources warning" open><summary><span><strong>{forecast.missingSchedule.length} 项缺少预测日期</strong><small>已确认金额保留，但不会擅自放入某一天</small></span><span>查看来源</span></summary><ForecastEventRows events={forecast.missingSchedule} /></details>}
        </section>
      </div>
    </section>
  );
}

function ReportsPage({ workspace, onPage, onFreeze, onExportExcel }) {
  const [sectionId, setSectionId] = useState("balance");
  const [versionId, setVersionId] = useState("live");
  const [drill, setDrill] = useState(null);
  useEffect(() => { setVersionId("live"); setDrill(null); }, [workspace.id, workspace.currentPeriod]);
  const live = buildReportSnapshot(workspace);
  const management = buildManagementMetrics(workspace, { period: workspace.currentPeriod });
  const storeReport = management.storeReport;
  const versions = workspace.delivery.reportVersions.filter((item) => item.period === workspace.currentPeriod);
  const selectedVersion = versions.find((item) => item.id === versionId);
  const snapshot = selectedVersion?.snapshot || live;
  const section = snapshot.sections[sectionId];
  const latest = versions[0];
  const previous = versions[1];
  const differences = latest && previous ? reportVersionDiff(latest, previous) : [];
  const statementChecks = Object.values(live.summary.engineChecks || {});
  const balanced = statementChecks.every((check) => check.passed);
  const flow = workflowChecks(workspace);
  const readyToFreeze = balanced && flow.bankReconciliationIssues.length === 0 && flow.unresolved.length === 0 && flow.pendingVouchers.length === 0;
  const currentFrozenVersion = flow.version;
  const excelExportReady = Boolean(currentFrozenVersion?.sourceFingerprint);
  const reportExports = (workspace.delivery.reportExports || []).filter((item) => item.period === workspace.currentPeriod && item.kind === "xlsx");
  const memberBusinessEnabled = workspaceModuleEnabled(workspace, "members");
  const taxEnabled = workspaceModuleEnabled(workspace, "tax");
  return (
    <div className="page-content reports-page">
      <StageRail workspace={workspace} onPage={onPage} />
      <section className="report-toolbar panel"><div><p className="eyebrow">S9 · 本地报表</p><h2>{selectedVersion ? `${selectedVersion.label} 冻结版本` : "实时草稿"}</h2><p>{selectedVersion ? `冻结于 ${formatDateTime(selectedVersion.createdAt)}，不会被后续修改覆盖。` : "数字会随本地凭证与税务调整更新。冻结后形成版本快照。"}</p></div><div className="report-toolbar-actions"><label className="compact-select"><span>查看版本</span><select value={versionId} onChange={(event) => setVersionId(event.target.value)}><option value="live">实时草稿</option>{versions.map((item) => <option key={item.id} value={item.id}>{item.label} · {formatDateTime(item.createdAt)}</option>)}</select><CaretDown size={13} /></label><button className="secondary-button" disabled={!excelExportReady} onClick={onExportExcel} title={excelExportReady ? `导出当前 ${currentFrozenVersion.label}，不上传网络` : "请先冻结当前数据；旧版本或已变化的数据不能导出"} type="button"><DownloadSimple size={17} />导出当前冻结版 Excel</button><button className="primary-button" disabled={!readyToFreeze} onClick={onFreeze} type="button"><SealCheck size={17} />冻结新版本</button></div></section>
      {!balanced && <div className="danger-banner"><WarningCircle size={18} /><span><strong>报表尚未勾稽：</strong>{statementChecks.filter((check) => !check.passed).map((check) => formatCurrency(check.difference)).join(" / ")}，修正试算、资产负债或现金变动差异后才能冻结。</span></div>}
      {balanced && !readyToFreeze && <div className="danger-banner"><WarningCircle size={18} /><span><strong>月结链路尚未完成：</strong>{flow.bankReconciliationIssues.length ? `${flow.bankReconciliationIssues.length} 份银行流水勾稽未通过。` : flow.unresolved.length ? `${flow.unresolved.length} 笔流水尚未入账或暂不处理。` : `${flow.pendingVouchers.length} 张凭证草稿或更正尚未入账。`}</span></div>}
      <section className="metric-grid four report-summary"><MetricCard label="资产合计" value={formatCurrency(snapshot.summary.assets)} note="资产负债表" icon={Bank} /><MetricCard label="营业收入" value={formatCurrency(snapshot.summary.revenue)} note="利润表" icon={TrendUp} tone="sage" /><MetricCard label="本月利润" value={formatCurrency(snapshot.summary.profit)} note="税前本地口径" icon={ChartBar} /><MetricCard label="三表勾稽" value={Object.values(snapshot.summary.engineChecks || {}).every((check) => check.passed) ? "通过" : "需处理"} note="试算 · 资产负债 · 现金变动" icon={CheckCircle} tone={Object.values(snapshot.summary.engineChecks || {}).every((check) => check.passed) ? "sage" : "clay"} /></section>
      <div className="reports-layout">
        <section className="panel statement-panel"><div className="report-tabs" role="tablist">{Object.entries(snapshot.sections).map(([id, value]) => <button className={sectionId === id ? "active" : ""} key={id} onClick={() => { setSectionId(id); setDrill(null); }} role="tab" type="button">{value.label}</button>)}</div><div className="statement-heading"><span>项目</span><span>本期金额</span></div><div className="statement-rows">{section.rows.map((row) => <button className={/(合计|利润|净增加|期末|缺口)/.test(row.label) ? "total" : ""} key={row.id} onClick={() => setDrill(row)} type="button"><span>{row.label}<small>{row.details?.length ? `${row.details.length} 条来源` : "查看口径"}</small></span><strong>{formatCurrency(row.value)}</strong><ArrowRight size={15} /></button>)}</div><div className="statement-foot"><span>{formatPeriod(snapshot.period)}</span><span>{selectedVersion ? `${selectedVersion.label} · 已冻结` : "实时草稿 · 未冻结"}</span></div></section>
        <aside className="panel version-panel"><div className="panel-heading"><div><p className="eyebrow">版本与差异</p><h2>不可覆盖的报表记录</h2></div><Clock size={21} /></div>{versions.length ? <div className="version-list">{versions.map((version, index) => <button className={version.id === versionId ? "active" : ""} key={version.id} onClick={() => setVersionId(version.id)} type="button"><span><strong>{version.label}</strong><small>{formatDateTime(version.createdAt)} · {version.actor}</small></span><TonePill tone="success">已冻结</TonePill>{index === 0 && <em>当前</em>}</button>)}</div> : <EmptyState title="还没有冻结版本" description="勾稽通过后冻结 V1，后续修改会形成 V2、V3，而不是覆盖旧数字。" />}<div className="version-diff"><div className="subheading"><strong>{previous ? `${latest.label} 对比 ${previous.label}` : "版本差异"}</strong><span>{differences.length} 项变化</span></div>{previous ? (differences.length ? differences.slice(0, 8).map((item) => <div key={item.id}><span><small>{item.section}</small><strong>{item.label}</strong></span><b className={item.delta > 0 ? "income" : "expense"}>{formatCurrency(item.delta, { sign: true })}</b></div>) : <p className="quiet-copy">最新两个版本的报表数字一致，时间与确认记录仍分别保留。</p>) : <p className="quiet-copy">冻结第二个版本后，这里会逐项显示与上一版本的差异。</p>}</div><div className="report-export-history"><div className="subheading"><strong>Excel 本地导出</strong><span>{reportExports.length} 次</span></div>{reportExports.length ? reportExports.slice(0, 3).map((item) => <article key={item.id}><DownloadSimple size={17} /><span><strong>{item.reportVersionLabel} · {item.fileName}</strong><small>{formatDateTime(item.exportedAt)} · {fileSize(item.size)} · 仅本地，未上传</small></span></article>) : <p className="quiet-copy">当前期间还没有 Excel 导出记录。</p>}</div>{taxEnabled && <button className="secondary-button wide" onClick={() => onPage("tax")} type="button">进入确认与申报<ArrowRight size={16} /></button>}</aside>
      </div>
      {sectionId === "owner" && <>{memberBusinessEnabled && <StoreManagementReport report={storeReport} />}<OwnerLiquidityReport management={management} /></>}
      <BoundaryNote />
      <DrilldownPanel row={drill} sectionLabel={section.label} onClose={() => setDrill(null)} />
    </div>
  );
}

function CheckRows({ items, onNavigate }) {
  return <div className="check-rows">{items.map((item) => <button key={item.id} onClick={() => !item.ok && onNavigate?.(item.page)} type="button"><span className={`check-icon ${item.ok ? "ok" : ""}`}>{item.ok ? <Check size={13} weight="bold" /> : <WarningCircle size={15} />}</span><span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>{!item.ok && <ArrowRight size={15} />}</button>)}</div>;
}

function buildFinalConfirmationSnapshot(workspace, existingFlow = workflowChecks(workspace)) {
  const version = existingFlow.version;
  const report = version?.snapshot || existingFlow.snapshot;
  const taxRows = Object.fromEntries((report.taxWorkpaper?.rows || []).map((row) => [row.id, row]));
  const cashFlowRows = Object.fromEntries((report.sections?.cashflow?.rows || []).map((row) => [row.id, row]));
  const numberValue = (value) => Number(value || 0);
  const taxes = {
    vat: { label: "应交增值税", value: numberValue(taxRows.vatPayable?.value), basis: taxRows.vatPayable?.formula || "来自本地税务底稿" },
    surtax: { label: "附加税费", value: numberValue(taxRows.surtax?.value), basis: taxRows.surtax?.formula || "来自本地税务底稿" },
    incomeTax: { label: "所得税", value: numberValue(taxRows.incomeTax?.value), basis: taxRows.incomeTax?.formula || "来自本地税务底稿" },
    individualIncomeTax: { label: "代扣个税", value: numberValue(taxRows.individualIncomeTax?.value), basis: taxRows.individualIncomeTax?.formula || "来自当前工资表" },
    total: { label: "预计申报税费合计", value: numberValue(taxRows.taxTotal?.value ?? report.summary?.estimatedTax), basis: taxRows.taxTotal?.formula || "不含代扣个税" },
  };
  const unresolvedItems = [
    ...existingFlow.openExceptionTasks.map((item) => ({ id: item.id, type: "异常任务", label: item.message || item.code || item.id, detail: item.sourceId || "S7 异常处理" })),
    ...existingFlow.unresolved.map((item) => ({ id: item.id, type: "未决流水", label: item.summary || item.counterparty || item.id, detail: item.serial || item.date || "待完成入账处理" })),
    ...existingFlow.openNotices.map((item) => ({ id: item.id, type: "跨期事项", label: item.message || item.id, detail: item.sourceId || "待处理" })),
    ...existingFlow.pendingVouchers.map((item) => ({ id: item.id, type: "待复核凭证", label: item.summary || item.number || item.id, detail: item.status || "待复核" })),
    ...existingFlow.bankReconciliationIssues.map((item) => ({ id: item.id, type: "银行勾稽", label: item.fileName || item.accountName || item.id, detail: item.status || "待完成" })),
  ];
  const vatRisks = report.taxWorkpaper?.vatReconciliation?.unresolvedItems || [];
  const deductionAmount = numberValue(taxes.total.value) + numberValue(taxes.individualIncomeTax.value);
  return {
    period: workspace.currentPeriod,
    reportVersionId: version?.id || null,
    reportVersionLabel: version?.label || null,
    reportSourceFingerprint: version?.sourceFingerprint || null,
    filingDraftVersionId: workspace.delivery.filing.draftVersionId || null,
    filingDraftCreatedAt: workspace.delivery.filing.draftCreatedAt || null,
    taxes,
    statements: {
      balance: {
        label: "资产负债表",
        metrics: [
          { label: "资产", value: numberValue(report.summary?.assets) },
          { label: "负债", value: numberValue(report.summary?.liabilities) },
          { label: "所有者权益", value: numberValue(report.summary?.equity) },
        ],
      },
      income: {
        label: "利润表",
        metrics: [
          { label: "收入", value: numberValue(report.summary?.revenue) },
          { label: "成本", value: numberValue(report.summary?.cost) },
          { label: "期间费用", value: numberValue(report.summary?.expenses) },
          { label: "利润", value: numberValue(report.summary?.profit) },
        ],
      },
      cashflow: {
        label: "现金流量表",
        metrics: [
          { label: "经营活动净额", value: numberValue(cashFlowRows.operating?.value) },
          { label: "现金净增加额", value: numberValue(cashFlowRows.netCash?.value) },
          { label: "期末现金", value: numberValue(cashFlowRows.closingCash?.value ?? report.summary?.cashBalance) },
        ],
      },
    },
    payrollSocial: {
      payroll: numberValue(taxRows.payroll?.value),
      socialSecurity: numberValue(taxRows.socialSecurity?.value),
      total: numberValue(taxRows.payroll?.value) + numberValue(taxRows.socialSecurity?.value),
    },
    deduction: {
      required: deductionAmount > 0,
      amount: deductionAmount,
    },
    risks: [
      { id: "local-only", level: "warning", label: "尚未提交税务局", detail: "本页只记录确认并生成本地申报包，仍需在外部完成正式申报。" },
      { id: "calculation-basis", level: "warning", label: "本地计算口径", detail: report.taxWorkpaper?.disclaimer || "税额来自当前冻结底稿，不是税务局回执。" },
      ...vatRisks.map((item) => ({ id: `vat-${item.kind || item.id}`, level: "danger", label: item.label || "增值税差异", detail: `仍有 ${formatCurrency(item.differenceAfterAdjustment ?? item.differenceBeforeAdjustment, { sign: true })} 差异待解释` })),
      ...(unresolvedItems.length ? [{ id: "open-items", level: "danger", label: "仍有未处理事项", detail: `${unresolvedItems.length} 项业务、凭证或勾稽事项尚未完成` }] : []),
    ],
    unresolvedItems,
  };
}

function TaxPage({ workspace, onPage, onTaxChange, onTaxCommit, onSectionDecision, onPrepareDraft, onFinalConfirm, onExport, onReceipt }) {
  const flow = workflowChecks(workspace);
  const version = flow.version;
  const snapshot = version?.snapshot || flow.snapshot;
  const prerequisiteChecks = flow.checks.slice(0, 5);
  const filing = workspace.delivery.filing;
  const activeConfirmation = [...(workspace.confirmations || [])].reverse().find((confirmation) => (
    confirmation.kind === "tax"
    && confirmation.period === workspace.currentPeriod
    && confirmation.reportVersionId === version?.id
  ));
  const storedFinalConfirmation = (workspace.confirmations || []).find((confirmation) => confirmation.id === workspace.tax.finalConfirmationId)
    || [...(workspace.confirmations || [])].reverse().find((confirmation) => confirmation.kind === "final" && confirmation.period === workspace.currentPeriod);
  const finalConfirmationCurrent = Boolean(
    storedFinalConfirmation
    && storedFinalConfirmation.kind === "final"
    && storedFinalConfirmation.status === "approved"
    && storedFinalConfirmation.snapshot
    && storedFinalConfirmation.selections
    && storedFinalConfirmation.signature?.name
    && storedFinalConfirmation.reportVersionId === version?.id
    && storedFinalConfirmation.reportSourceFingerprint === (version?.sourceFingerprint || null)
    && storedFinalConfirmation.filingDraftVersionId === filing.draftVersionId
    && storedFinalConfirmation.filingDraftCreatedAt === filing.draftCreatedAt
    && workspace.tax.ownerConfirmedAt
    && workspace.tax.ownerConfirmedVersionId === version?.id
    && filing.finalConfirmedVersionId === version?.id,
  );
  const currentFinalSnapshot = buildFinalConfirmationSnapshot(workspace, flow);
  const displayedFinalSnapshot = finalConfirmationCurrent ? storedFinalConfirmation.snapshot : currentFinalSnapshot;
  const [sectionDrafts, setSectionDrafts] = useState({});
  const [finalChecks, setFinalChecks] = useState({
    numbersReviewed: Boolean(finalConfirmationCurrent && storedFinalConfirmation.selections?.numbersReviewed),
    risksAcknowledged: Boolean(finalConfirmationCurrent && storedFinalConfirmation.selections?.risksAcknowledged),
    localOnlyAcknowledged: Boolean(finalConfirmationCurrent && storedFinalConfirmation.selections?.localOnlyAcknowledged),
  });
  const [deductionAuthorization, setDeductionAuthorization] = useState(finalConfirmationCurrent ? storedFinalConfirmation.selections?.deductionAuthorization || "" : "");
  const [confirmer, setConfirmer] = useState(finalConfirmationCurrent ? storedFinalConfirmation.signature?.name || workspace.tax.confirmedBy || "" : "");
  const receiptInput = useRef(null);
  useEffect(() => {
    setSectionDrafts({});
    setFinalChecks({
      numbersReviewed: Boolean(finalConfirmationCurrent && storedFinalConfirmation?.selections?.numbersReviewed),
      risksAcknowledged: Boolean(finalConfirmationCurrent && storedFinalConfirmation?.selections?.risksAcknowledged),
      localOnlyAcknowledged: Boolean(finalConfirmationCurrent && storedFinalConfirmation?.selections?.localOnlyAcknowledged),
    });
    setDeductionAuthorization(finalConfirmationCurrent ? storedFinalConfirmation?.selections?.deductionAuthorization || "" : "");
    setConfirmer(finalConfirmationCurrent ? storedFinalConfirmation?.signature?.name || workspace.tax.confirmedBy || "" : "");
  }, [workspace.id, workspace.currentPeriod, version?.id, filing.draftCreatedAt, finalConfirmationCurrent]);

  const summarizeSources = (rows, fallback) => {
    const seen = new Set();
    const details = rows.filter(Boolean).flatMap((row) => row.details || []).filter((detail) => {
      const key = detail.id || `${detail.title || ""}:${detail.reference || ""}:${detail.amount || 0}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (details.length) {
      const labels = [...new Set(details.map((detail) => detail.reference || detail.title).filter(Boolean))].slice(0, 2);
      return `${details.length} 条本地来源${labels.length ? ` · ${labels.join("、")}` : ""}`;
    }
    const formula = rows.find((row) => row?.formula)?.formula;
    return formula ? `计算口径：${formula}` : fallback;
  };
  const incomeById = Object.fromEntries((snapshot.sections.income?.rows || []).map((row) => [row.id, row]));
  const balanceById = Object.fromEntries((snapshot.sections.balance?.rows || []).map((row) => [row.id, row]));
  const workpaperById = Object.fromEntries(snapshot.taxWorkpaper.rows.map((row) => [row.id, row]));
  const pendingSources = [...flow.openExceptionTasks, ...flow.unresolved, ...flow.openNotices];
  const confirmationItems = [
    { id: "revenue", label: "收入", amount: formatCurrency(snapshot.summary.revenue), sourceSummary: summarizeSources([incomeById.revenue], "来自当前冻结利润表"), majorByDefault: true },
    { id: "costExpense", label: "成本费用", amount: formatCurrency(Number(snapshot.summary.cost || 0) + Number(snapshot.summary.expenses || 0)), sourceSummary: summarizeSources([incomeById.expenses, incomeById.profit], "来自当前冻结利润表及已入账凭证"), majorByDefault: true },
    { id: "vat", label: "应交税额", amount: formatCurrency(workpaperById.vatPayable?.value || 0), sourceSummary: summarizeSources([workpaperById.vatPayable], "来自当前冻结税务底稿"), majorByDefault: true },
    { id: "inputVat", label: "进项税", amount: formatCurrency(workpaperById.inputVat?.value || 0), sourceSummary: summarizeSources([workpaperById.inputVat], "来自进项发票或进项税科目"), majorByDefault: false },
    { id: "payroll", label: "工资", amount: formatCurrency(workpaperById.payroll?.value || 0), sourceSummary: summarizeSources([workpaperById.payroll], "来自当前期间工资表"), majorByDefault: true },
    { id: "socialSecurity", label: "社保", amount: formatCurrency(workpaperById.socialSecurity?.value || 0), sourceSummary: summarizeSources([workpaperById.socialSecurity], "来自当前期间社保表"), majorByDefault: true },
    { id: "finance", label: "财务报表", amount: `资产 ${formatCurrency(snapshot.summary.assets)} · 利润 ${formatCurrency(snapshot.summary.profit)}`, sourceSummary: summarizeSources([balanceById.assets, incomeById.profit], "来自当前冻结的资产负债表与利润表"), majorByDefault: true },
    { id: "openItems", label: "待核实事项", amount: pendingSources.length ? `${pendingSources.length} 项` : "0 项", sourceSummary: pendingSources.length ? pendingSources.slice(0, 2).map((item) => item.message || item.summary || item.counterparty || item.id).join("；") : "异常任务、未决流水与跨期事项均为 0", majorByDefault: false },
  ];
  const approvedCount = confirmationItems.filter((item) => activeConfirmation?.sections?.[item.id]?.status === "approved").length;
  const packageApproved = Boolean(activeConfirmation) && confirmationItems.every((item) => activeConfirmation.sections?.[item.id]?.status === "approved");
  const workflowConfirmationDone = ["finance", "payroll", "socialSecurity"].every((id) => flow.checks.find((item) => item.id === id)?.ok);
  const initialDone = Boolean(packageApproved && workflowConfirmationDone && filing.initialConfirmationId === activeConfirmation?.id);
  const canConfirmSections = Boolean(version) && prerequisiteChecks.every((item) => item.ok);
  const canStartFinalConfirmation = Boolean(initialDone && version && filing.draftCreatedAt && filing.draftVersionId === version.id);
  const finalReady = canStartFinalConfirmation
    && Object.values(finalChecks).every(Boolean)
    && ["authorize_external", "do_not_authorize"].includes(deductionAuthorization)
    && confirmer.trim().length > 0;
  const exportReady = finalConfirmationCurrent && flow.export.every((item) => item.ok);
  return (
    <div className="page-content tax-page">
      <StageRail workspace={workspace} onPage={onPage} />
      <section className="tax-boundary-card"><span className="boundary-icon"><CloudSlash size={27} /></span><div><p className="eyebrow">安全边界</p><h2>电子税务局未连接</h2><p>第一版只生成本地底稿与申报包。真实填报、提交和缴税必须在电子税务局或未来的本地安全执行器中完成。</p></div><TonePill tone="neutral">后续连接能力</TonePill></section>
      <div className="tax-layout">
        <div className="tax-main-column">
          <section className="panel workpaper-panel"><div className="panel-heading"><div><p className="eyebrow">S10–S11 · 申报底稿</p><h2>{formatPeriod(workspace.currentPeriod)} 本地复核稿</h2></div>{version ? <TonePill tone="success">基于 {version.label}</TonePill> : <TonePill tone="warning">尚未冻结报表</TonePill>}</div><div className="workpaper-grid">{snapshot.taxWorkpaper.rows.map((row) => <div key={row.id}><span>{row.label}</span><strong>{formatCurrency(row.value)}</strong></div>)}</div><p className="workpaper-disclaimer"><WarningCircle size={16} />{snapshot.taxWorkpaper.disclaimer}</p><div className="tax-input-grid"><label><span>增值税计税基础调整</span><input type="number" step="0.01" value={workspace.tax.adjustments} onChange={(event) => onTaxChange("adjustments", Number(event.target.value))} onBlur={() => onTaxCommit("adjustments")} /></label><label><span>工资薪金</span><input type="number" step="0.01" value={workspace.tax.payroll} onChange={(event) => onTaxChange("payroll", Number(event.target.value))} onBlur={() => onTaxCommit("payroll")} /></label><label><span>社保数据</span><input type="number" step="0.01" value={workspace.tax.socialSecurity} onChange={(event) => onTaxChange("socialSecurity", Number(event.target.value))} onBlur={() => onTaxCommit("socialSecurity")} /></label><label className="full"><span>复核备注</span><textarea value={workspace.tax.note} onChange={(event) => onTaxChange("note", event.target.value)} onBlur={() => onTaxCommit("note")} placeholder="记录本期特殊口径或待说明事项" /></label></div><p className="edit-warning">修改底稿会撤销后续确认与导出状态；请重新冻结报表版本后再继续。</p></section>
          <section className="panel confirmation-panel">
            <div className="panel-heading"><div><p className="eyebrow">第一次客户确认</p><h2>八项数据逐项确认</h2></div><TonePill tone={initialDone ? "success" : activeConfirmation?.status === "disputed" ? "danger" : "warning"}>{initialDone ? "8 / 8 已确认" : `${approvedCount} / ${confirmationItems.length}`}</TonePill></div>
            <CheckRows items={prerequisiteChecks} onNavigate={onPage} />
            {!canConfirmSections && <p className="confirmation-gate"><WarningCircle size={16} />先完成上方五项前置条件，才能保存每一项客户结论。</p>}
            <div className="confirmation-list">{confirmationItems.map((item) => {
              const savedSection = activeConfirmation?.sections?.[item.id];
              const savedDecision = [...(activeConfirmation?.decisions || [])].reverse().find((decision) => decision.section === item.id);
              const status = savedSection?.status || "pending";
              const locked = status === "approved" || status === "rejected";
              const draft = sectionDrafts[item.id] || {};
              const decision = draft.decision || "";
              const note = draft.note || "";
              const isMajor = draft.isMajor ?? item.majorByDefault;
              const responsibleName = draft.responsibleName || "";
              const updateDraft = (fields) => setSectionDrafts((current) => ({ ...current, [item.id]: { ...(current[item.id] || {}), ...fields } }));
              const canSave = canConfirmSections && !locked && Boolean(decision) && note.trim().length > 0 && (!isMajor || responsibleName.trim().length > 0);
              return (
                <article className={`confirmation-item ${status}`} key={item.id}>
                  <div className="confirmation-item-heading"><div><span>{item.label}</span><strong>{item.amount}</strong></div><TonePill tone={status === "approved" ? "success" : status === "rejected" ? "danger" : "neutral"}>{status === "approved" ? "已确认" : status === "rejected" ? "有异议" : "待确认"}</TonePill></div>
                  <p className="confirmation-source"><FileText size={15} /><span><strong>来源摘要</strong>{item.sourceSummary}</span></p>
                  {locked ? (
                    <div className={`confirmation-record ${status}`}><span>{status === "approved" ? <CheckCircle size={19} weight="fill" /> : <WarningCircle size={19} weight="fill" />}</span><div><strong>{status === "approved" ? "本项已单独确认" : "本项异议已转入 S7"}</strong><small>{savedSection.confirmedBy || savedDecision?.actor || "客户负责人"} · {formatDateTime(savedSection.confirmedAt || savedDecision?.at)}</small><p>{savedDecision?.note || "已记录到本地确认链"}</p></div></div>
                  ) : (
                    <div className="confirmation-form">
                      <fieldset className="confirmation-decisions"><legend>本项结论</legend><label><input checked={decision === "approve"} disabled={!canConfirmSections} name={`confirmation-${item.id}`} onChange={() => updateDraft({ decision: "approve" })} type="radio" /><span>确认</span></label><label><input checked={decision === "reject"} disabled={!canConfirmSections} name={`confirmation-${item.id}`} onChange={() => updateDraft({ decision: "reject" })} type="radio" /><span>有异议</span></label></fieldset>
                      <label className="confirmation-note"><span>本项说明 <b>必填</b></span><textarea disabled={!canConfirmSections} onChange={(event) => updateDraft({ note: event.target.value })} placeholder={decision === "reject" ? "写明差异、正确口径或需补充的资料" : "写明已核对的来源与结论"} value={note} /></label>
                      <label className="major-toggle"><input checked={isMajor} disabled={!canConfirmSections} onChange={(event) => updateDraft({ isMajor: event.target.checked })} type="checkbox" /><span><strong>本项属于重大事项</strong><small>重大事项必须由负责人单独签字。</small></span></label>
                      {isMajor && <label className="confirmation-signer"><span>负责人签字姓名 <b>必填</b></span><input disabled={!canConfirmSections} onChange={(event) => updateDraft({ responsibleName: event.target.value })} placeholder="输入本项负责人姓名" value={responsibleName} /></label>}
                      {decision === "reject" && <p className="confirmation-reject-warning"><WarningCircle size={15} />保存后将立即生成 S7 异常事项并返回异常处理。</p>}
                      <button className={decision === "reject" ? "danger-button" : "secondary-button"} disabled={!canSave} onClick={() => {
                        const saved = onSectionDecision({ section: item.id, decision, note: note.trim(), isMajor, responsibleName: responsibleName.trim() });
                        if (saved) setSectionDrafts((current) => ({ ...current, [item.id]: {} }));
                      }} type="button">{decision === "reject" ? "保存异议并退回 S7" : "保存本项确认"}</button>
                    </div>
                  )}
                </article>
              );
            })}</div>
            <p className={`confirmation-summary ${initialDone ? "done" : ""}`}>{initialDone ? `八项已全部逐项确认，完成时间 ${formatDateTime(workspace.tax.financeConfirmedAt)}` : `还需确认 ${confirmationItems.length - approvedCount} 项；全部完成前不能生成申报底稿。`}</p>
          </section>
        </div>
        <aside className="tax-side-column">
          <section className="panel filing-steps-panel"><div className="panel-heading"><div><p className="eyebrow">S11–S12 · 提交前流程</p><h2>本地申报包</h2></div><ShieldCheck size={22} /></div><ol className="filing-timeline"><li className={initialDone ? "done" : "active"}><span>{initialDone ? <Check size={13} weight="bold" /> : 1}</span><div><strong>第一次客户确认</strong><small>{formatDateTime(workspace.tax.financeConfirmedAt)}</small></div></li><li className={filing.draftCreatedAt ? "done" : initialDone ? "active" : ""}><span>{filing.draftCreatedAt ? <Check size={13} weight="bold" /> : 2}</span><div><strong>生成本地申报底稿</strong><small>{formatDateTime(filing.draftCreatedAt)}</small></div></li><li className={finalConfirmationCurrent ? "done" : filing.draftCreatedAt ? "active" : ""}><span>{finalConfirmationCurrent ? <Check size={13} weight="bold" /> : 3}</span><div><strong>第二次最终确认</strong><small>{finalConfirmationCurrent ? formatDateTime(storedFinalConfirmation.confirmedAt) : "等待逐项确认"}</small></div></li><li className={filing.exportedAt ? "done" : finalConfirmationCurrent ? "active" : ""}><span>{filing.exportedAt ? <Check size={13} weight="bold" /> : 4}</span><div><strong>导出本地申报包</strong><small>{formatDateTime(filing.exportedAt)}</small></div></li><li className={filing.receipt ? "done" : filing.exportedAt ? "active" : ""}><span>{filing.receipt ? <Check size={13} weight="bold" /> : 5}</span><div><strong>导回真实办理回执</strong><small>{filing.receipt?.name || "等待外部办理"}</small></div></li></ol><button className="secondary-button wide" disabled={!initialDone || Boolean(filing.draftCreatedAt)} onClick={onPrepareDraft} type="button">{filing.draftCreatedAt ? "底稿已生成" : "生成本地申报底稿"}</button></section>
          <section className="panel package-panel"><div className="panel-heading"><div><p className="eyebrow">文件交付</p><h2>导出与回执</h2></div><DownloadSimple size={21} /></div><CheckRows items={flow.export} onNavigate={onPage} /><button className="primary-button wide" disabled={!exportReady} onClick={onExport} type="button"><DownloadSimple size={17} />{filing.exportedAt ? "重新导出本地申报包" : "导出本地申报包"}</button><input ref={receiptInput} hidden type="file" accept=".pdf,.json,.xml,.txt,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) onReceipt(file); event.target.value = ""; }} /><button className="secondary-button wide" disabled={!filing.exportedAt} onClick={() => receiptInput.current?.click()} type="button"><UploadSimple size={17} />{filing.receipt ? "替换本地回执" : "导入真实外部回执"}</button>{filing.receipt && <div className="receipt-card"><Receipt size={21} /><span><strong>{filing.receipt.name}</strong><small>{fileSize(filing.receipt.size)} · SHA-256 {filing.receipt.hash.slice(0, 10)}…</small></span><CheckCircle size={18} weight="fill" /></div>}</section>
        </aside>
      </div>
      <section className="panel final-confirm-panel final-confirm-workspace">
        <div className="panel-heading"><div><p className="eyebrow">S12 · 第二次客户确认</p><h2>提交前最终责任确认</h2></div><TonePill tone={finalConfirmationCurrent ? "success" : storedFinalConfirmation ? "warning" : "neutral"}>{finalConfirmationCurrent ? "已记录 · 未提交" : storedFinalConfirmation ? "上次确认已失效" : "等待确认"}</TonePill></div>
        <p className="final-boundary-copy">这里保存客户对当前冻结数字、风险和外部扣款选择的最终确认，只生成本地申报包；不会提交税务局，也不会自动扣款或缴税。</p>
        {storedFinalConfirmation && !finalConfirmationCurrent && <p className="final-invalid-banner"><WarningCircle size={17} />上一次最终确认对应的报表版本、底稿或数据已变化，必须按当前数字重新完成全部确认。</p>}
        {!canStartFinalConfirmation && !finalConfirmationCurrent && <p className="confirmation-gate"><WarningCircle size={16} />先完成八项第一次确认并生成当前冻结版本的本地申报底稿。</p>}
        <div className="final-context-strip"><div><span>申报所属期</span><strong>{formatPeriod(displayedFinalSnapshot.period)}</strong></div><div><span>冻结报表</span><strong>{displayedFinalSnapshot.reportVersionLabel || "尚未冻结"}</strong></div><div><span>本地底稿</span><strong>{displayedFinalSnapshot.filingDraftCreatedAt ? formatDateTime(displayedFinalSnapshot.filingDraftCreatedAt) : "尚未生成"}</strong></div><div><span>税务局状态</span><strong>尚未提交</strong></div></div>
        <div className="final-review-grid">
          <div className="final-review-main">
            <section className="final-review-section"><div className="subheading"><strong>各税种金额</strong><span>当前冻结底稿</span></div><div className="final-tax-grid">{Object.entries(displayedFinalSnapshot.taxes).map(([id, item]) => <article className={id === "total" ? "total" : ""} key={id}><span>{item.label}</span><strong>{formatCurrency(item.value)}</strong><small>{item.basis}</small></article>)}</div></section>
            <section className="final-review-section"><div className="subheading"><strong>三大报表关键数字</strong><span>与最终确认记录绑定</span></div><div className="final-statement-grid">{Object.values(displayedFinalSnapshot.statements).map((statement) => <article key={statement.label}><strong>{statement.label}</strong><dl>{statement.metrics.map((metric) => <div key={metric.label}><dt>{metric.label}</dt><dd>{formatCurrency(metric.value)}</dd></div>)}</dl></article>)}</div></section>
            <section className="final-review-section"><div className="subheading"><strong>工资与社保总额</strong><span>当前冻结数据</span></div><div className="final-payroll-grid"><div><span>工资</span><strong>{formatCurrency(displayedFinalSnapshot.payrollSocial.payroll)}</strong></div><div><span>社保</span><strong>{formatCurrency(displayedFinalSnapshot.payrollSocial.socialSecurity)}</strong></div><div className="total"><span>合计</span><strong>{formatCurrency(displayedFinalSnapshot.payrollSocial.total)}</strong></div></div></section>
          </div>
          <div className="final-review-side">
            <section className={`final-deduction-summary ${displayedFinalSnapshot.deduction.required ? "required" : ""}`}><span>是否需要扣款</span><strong>{displayedFinalSnapshot.deduction.required ? "预计需要在外部办理扣款" : "当前预计无需扣款"}</strong><b>{formatCurrency(displayedFinalSnapshot.deduction.amount)}</b><small>这里只判断当前底稿金额，不会发起银行或税务扣款。</small></section>
            <section className="final-risk-section"><div className="subheading"><strong>申报风险</strong><span>{displayedFinalSnapshot.risks.length} 项</span></div><div className="final-risk-list">{displayedFinalSnapshot.risks.map((risk) => <article className={risk.level} key={risk.id}><WarningCircle size={17} /><span><strong>{risk.label}</strong><small>{risk.detail}</small></span></article>)}</div></section>
            <section className="final-open-section"><div className="subheading"><strong>仍未处理事项</strong><span>{displayedFinalSnapshot.unresolvedItems.length} 项</span></div>{displayedFinalSnapshot.unresolvedItems.length ? <div className="final-open-list">{displayedFinalSnapshot.unresolvedItems.map((item) => <article key={`${item.type}-${item.id}`}><span><strong>{item.type} · {item.label}</strong><small>{item.detail}</small></span></article>)}</div> : <p className="final-empty-state"><CheckCircle size={18} weight="fill" />当前没有未处理的流水、异常、凭证、跨期或银行勾稽事项。</p>}</section>
          </div>
        </div>
        {finalConfirmationCurrent ? (
          <div className="final-confirmation-receipt"><CheckCircle size={24} weight="fill" /><div><strong>最终确认记录已保存，但尚未提交税务局</strong><p>{storedFinalConfirmation.signature.name} · {formatDateTime(storedFinalConfirmation.confirmedAt)}</p><small>{storedFinalConfirmation.selections.deductionAuthorization === "authorize_external" ? "已授权在外部渠道办理扣款" : "未授权外部扣款，将另行办理"}。本地工作台没有执行扣款。</small></div></div>
        ) : (
          <div className="final-confirm-form">
            <div className="final-attestations"><label><input checked={finalChecks.numbersReviewed} disabled={!canStartFinalConfirmation} onChange={(event) => setFinalChecks((current) => ({ ...current, numbersReviewed: event.target.checked }))} type="checkbox" /><span><strong>数字已复核</strong><small>我已逐项核对所属期、各税种、三大报表以及工资社保金额。</small></span></label><label><input checked={finalChecks.risksAcknowledged} disabled={!canStartFinalConfirmation} onChange={(event) => setFinalChecks((current) => ({ ...current, risksAcknowledged: event.target.checked }))} type="checkbox" /><span><strong>风险已知晓</strong><small>我已阅读本地计算口径、申报风险和仍未处理事项。</small></span></label><label><input checked={finalChecks.localOnlyAcknowledged} disabled={!canStartFinalConfirmation} onChange={(event) => setFinalChecks((current) => ({ ...current, localOnlyAcknowledged: event.target.checked }))} type="checkbox" /><span><strong>理解这里只生成本地申报包、尚未提交税务局</strong><small>确认不会触发申报、缴税或银行扣款。</small></span></label></div>
            <fieldset className="final-deduction-choice" disabled={!canStartFinalConfirmation}><legend>外部扣款授权 <b>必选</b></legend><label><input checked={deductionAuthorization === "authorize_external"} name="deduction-authorization" onChange={() => setDeductionAuthorization("authorize_external")} type="radio" /><span><strong>授权外部办理扣款</strong><small>仅记录授权意向，仍需在税务局或银行渠道执行。</small></span></label><label><input checked={deductionAuthorization === "do_not_authorize"} name="deduction-authorization" onChange={() => setDeductionAuthorization("do_not_authorize")} type="radio" /><span><strong>不授权外部扣款</strong><small>由负责人另行安排缴税，不在本工作台执行。</small></span></label></fieldset>
            <label className="final-signer"><span>最终负责人姓名 <b>必填</b></span><input disabled={!canStartFinalConfirmation} onChange={(event) => setConfirmer(event.target.value)} placeholder="输入承担最终责任的姓名" value={confirmer} /></label>
            <button className="primary-button" disabled={!finalReady} onClick={() => onFinalConfirm({ name: confirmer.trim(), selections: { ...finalChecks, deductionAuthorization } })} type="button"><ShieldCheck size={17} />保存最终确认（不提交税务局）</button>
          </div>
        )}
      </section>
    </div>
  );
}

function ArchivePage({ workspace, onPage, onDocuments, onReceipt, onArchive, onNextPeriod, onExportIndex }) {
  const [tab, setTab] = useState("documents");
  const [query, setQuery] = useState("");
  const docsInput = useRef(null);
  const receiptInput = useRef(null);
  const flow = workflowChecks(workspace);
  const taxEnabled = workspaceModuleEnabled(workspace, "tax");
  const filing = workspace.delivery.filing;
  const archived = workspace.delivery.archives.find((item) => item.period === workspace.currentPeriod);
  const documents = workspace.documents.filter((item) => `${item.name} ${item.type || item.category || ""} ${item.status || item.lifecycleStatus || ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const archiveReady = flow.archive.every((item) => item.ok);
  return (
    <div className="page-content archive-page">
      <StageRail workspace={workspace} onPage={onPage} />
      <section className="archive-hero"><div><p className="eyebrow">S13 · {taxEnabled ? "回执、归档与下一期" : "归档与下一期"}</p><h2>{archived ? `${formatPeriod(workspace.currentPeriod)} 已归档` : "让本期交付真正闭环"}</h2><p>{archived ? `归档于 ${formatDateTime(archived.archivedAt)}，${taxEnabled ? "报表、确认、回执" : "报表、资料、操作记录"}与期末余额已经建立索引。` : taxEnabled ? "必须先导入真实外部办理回执，再把本地申报包、确认记录和操作日志一起归档。" : "把当前冻结报表、本期资料和操作记录建立本地归档索引。"}</p></div><div className="archive-hero-actions"><button className="secondary-button" onClick={onExportIndex} type="button"><DownloadSimple size={17} />导出归档索引</button>{archived ? <button className="primary-button" onClick={onNextPeriod} type="button">进入下一期<ArrowRight size={17} /></button> : <button className="primary-button" disabled={!archiveReady} onClick={onArchive} type="button"><Archive size={17} />完成本期归档</button>}</div></section>
      <section className="metric-grid four archive-status-grid"><MetricCard label="冻结报表" value={flow.version?.label || "未完成"} note={flow.version ? formatDateTime(flow.version.createdAt) : "先去报表中心"} icon={ChartBar} tone={flow.version ? "sage" : "clay"} onClick={() => onPage("reports")} />{taxEnabled ? <><MetricCard label="两次确认" value={workspace.tax.ownerConfirmedAt ? "已完成" : "未完成"} note={workspace.tax.confirmedBy || "等待客户"} icon={ShieldCheck} tone={workspace.tax.ownerConfirmedAt ? "sage" : "clay"} onClick={() => onPage("tax")} /><MetricCard label="本地申报包" value={filing.exportedAt ? "已导出" : "未导出"} note={formatDateTime(filing.exportedAt)} icon={DownloadSimple} /><MetricCard label="真实回执" value={filing.receipt ? "已导入" : "待导入"} note={filing.receipt?.name || "来自外部办理"} icon={Receipt} tone={filing.receipt ? "sage" : "clay"} /></> : <><MetricCard label="本期资料" value={`${documents.length} 份`} note="浏览器本地记录" icon={FileText} /><MetricCard label="操作记录" value={`${workspace.auditLog.length} 条`} note="当前工作台" icon={Clock} /></>}</section>
      {taxEnabled && !filing.receipt && <section className="receipt-upload-card"><span><Receipt size={25} /></span><div><strong>导入真实外部办理回执</strong><p>选择在电子税务局或本地安全执行器中取得的 PDF、XML、JSON 或文本回执。文件只在本地读取并记录哈希。</p></div><input ref={receiptInput} hidden type="file" accept=".pdf,.json,.xml,.txt,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) onReceipt(file); event.target.value = ""; }} /><button className="primary-button" disabled={!filing.exportedAt} onClick={() => receiptInput.current?.click()} type="button"><UploadSimple size={17} />选择回执</button></section>}
      <section className="panel archive-content-panel"><div className="archive-toolbar"><div className="report-tabs"><button className={tab === "documents" ? "active" : ""} onClick={() => setTab("documents")} type="button">本地资料</button><button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")} type="button">操作日志</button><button className={tab === "periods" ? "active" : ""} onClick={() => setTab("periods")} type="button">历史归档</button></div>{tab === "documents" && <div className="archive-tools"><label className="search-field"><MagnifyingGlass size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件" /></label><input ref={docsInput} hidden type="file" multiple onChange={(event) => { onDocuments(Array.from(event.target.files || [])); event.target.value = ""; }} /><button className="secondary-button" onClick={() => docsInput.current?.click()} type="button"><FileArrowUp size={17} />添加本地资料</button></div>}</div>{tab === "documents" && (documents.length ? <div className="document-grid">{documents.map((document) => <article className="document-card" key={document.id}><span className="document-icon"><FileText size={22} /></span><div><small>{document.type || document.category || "本地资料"} · {document.period || "未分期"}</small><strong>{document.name}</strong><p>{fileSize(document.size)} · {document.hash ? "已记录校验标识" : "本地元数据"}</p></div><TonePill tone={document.status?.includes("待") ? "warning" : "success"}>{document.status || "已获取"}</TonePill></article>)}</div> : <EmptyState title="没有符合条件的资料" description="添加本地文件或清空搜索条件。" />)}{tab === "logs" && (workspace.auditLog.length ? <div className="audit-list">{workspace.auditLog.map((item) => <div key={item.id}><span className="audit-dot" /><span><strong>{item.action}</strong><small>{item.detail}</small></span><span><strong>{item.actor}</strong><small>{formatDateTime(item.at)}</small></span></div>)}</div> : <EmptyState title="还没有操作日志" description="确认、导出、导入和归档动作都会记录在这里。" />)}{tab === "periods" && (workspace.delivery.archives.length ? <div className="period-archive-list">{workspace.delivery.archives.map((item) => <article key={item.id}><span className="archive-badge"><Archive size={20} /></span><div><strong>{formatPeriod(item.period)}</strong><small>{item.reportVersionLabel} · {item.confirmations.confirmedBy || "客户"} · {formatDateTime(item.archivedAt)}</small></div><span><strong>{formatCurrency(item.summary.profit)}</strong><small>本期利润</small></span><TonePill tone="success">已归档</TonePill></article>)}</div> : <EmptyState title="还没有历史归档" description={taxEnabled ? "本期回执导入并通过校验后，可以形成第一条归档记录。" : "冻结报表和本地资料通过校验后，可以形成第一条归档记录。"} />)}</section>
      {!archived && <div className="archive-check-panel panel"><div className="panel-heading"><div><p className="eyebrow">归档校验</p><h2>{archiveReady ? "全部条件已满足" : "还不能完成归档"}</h2></div><TonePill tone={archiveReady ? "success" : "warning"}>{flow.archive.filter((item) => item.ok).length} / {flow.archive.length}</TonePill></div><CheckRows items={flow.archive} onNavigate={onPage} /></div>}
      <BoundaryNote />
    </div>
  );
}

function blankWorkspaceForm() {
  return {
    name: "",
    legalName: "",
    industry: "其他服务业",
    taxpayerType: "小规模纳税人",
    mode: "blank",
    modules: defaultWorkspaceModules("blank"),
  };
}

function WorkspaceDialog({ mode, workspace, onClose, onSubmit }) {
  const [form, setForm] = useState(blankWorkspaceForm);
  useEffect(() => {
    if (mode === "rename") setForm((current) => ({ ...current, name: workspace?.name || "" }));
    if (mode === "create") setForm(blankWorkspaceForm());
  }, [mode, workspace?.id]);
  useEffect(() => {
    if (!mode) return undefined;
    function handleKeyDown(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mode, onClose]);
  if (!mode) return null;
  const title = mode === "create" ? "新建工作台" : mode === "rename" ? "重命名工作台" : "删除工作台";
  function submit(event) { event.preventDefault(); if (mode !== "delete" && !form.name.trim()) return; onSubmit(form); }
  function selectMode(nextMode) {
    setForm((current) => ({
      ...current,
      mode: nextMode,
      industry: nextMode === "template" ? "私教健身工作室" : "其他服务业",
      modules: defaultWorkspaceModules(nextMode === "template" ? "fitness" : "blank"),
    }));
  }
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form className="modal-card workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title" onSubmit={submit}><div className="modal-heading"><div><p className="eyebrow">{PRODUCT_NAME}</p><h2 id="workspace-dialog-title">{title}</h2></div><button className="icon-button compact" onClick={onClose} type="button" aria-label="关闭"><X size={19} /></button></div>{mode === "create" && <><p className="modal-intro">默认从不带样例数据的空白工作台开始；“山岚健身工作室”仅作为可选本地示例模板。</p><div className="choice-cards workspace-mode-cards"><label className={form.mode === "blank" ? "active" : ""}><input type="radio" name="mode" value="blank" checked={form.mode === "blank"} onChange={(event) => selectMode(event.target.value)} /><span><strong>创建空白工作台</strong><small>不带会员、人员或行业样例数据</small></span></label><label className={form.mode === "template" ? "active" : ""}><input type="radio" name="mode" value="template" checked={form.mode === "template"} onChange={(event) => selectMode(event.target.value)} /><span><strong>复制健身示例模板</strong><small>复制山岚样例数据，用于体验完整流程</small></span></label></div><div className="form-grid"><label><span>工作台名称 *</span><input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：微光设计事务所" /></label><label><span>企业法定名称</span><input value={form.legalName} onChange={(event) => setForm({ ...form, legalName: event.target.value })} placeholder="可稍后补充" /></label><label><span>行业</span><input value={form.industry} onChange={(event) => setForm({ ...form, industry: event.target.value })} /></label><label><span>纳税人类型</span><select value={form.taxpayerType} onChange={(event) => setForm({ ...form, taxpayerType: event.target.value })}><option>小规模纳税人</option><option>一般纳税人</option></select></label></div><div className="workspace-module-grid">{WORKSPACE_MODULE_OPTIONS.map((module) => <label className={form.modules[module.id] ? "active" : ""} key={module.id}><input type="checkbox" checked={Boolean(form.modules[module.id])} onChange={(event) => setForm((current) => ({ ...current, modules: { ...current.modules, [module.id]: event.target.checked } }))} /><span><strong>{module.label}</strong><small>{module.description}</small></span></label>)}</div><p className="modal-intro">月结总览、报表中心、资料归档和基础资料始终保留。</p></>}{mode === "rename" && <label className="field-label"><span>新的工作台名称</span><input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>}{mode === "delete" && <div className="delete-warning"><WarningCircle size={24} /><div><strong>确认删除“{workspace?.name}”？</strong><p>这会移除当前浏览器中的本地工作台数据，无法从本页面恢复。其他工作台不会受影响。</p></div></div>}<div className="modal-actions"><button className="secondary-button" onClick={onClose} type="button">取消</button><button className={mode === "delete" ? "danger-button" : "primary-button"} type="submit">{mode === "create" ? "创建并进入" : mode === "rename" ? "保存名称" : "确认删除"}</button></div></form></div>
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
  function template() { downloadText("\ufeff日期,对方,摘要,金额\n2026-08-31,示例客户,服务收入,880.00", "财务工作台-银行流水模板.csv", "text/csv;charset=utf-8"); }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal-card import-dialog" role="dialog" aria-modal="true"><div className="modal-heading"><div><p className="eyebrow">浏览器本地处理</p><h2>导入银行流水 CSV</h2></div><button className="icon-button compact" onClick={onClose} type="button" aria-label="关闭"><X size={19} /></button></div><p className="modal-intro">文件不会上传网络。导入后先进入待复核状态，不会因为“建议匹配”自动入账。</p><div className={`drop-zone ${dragging ? "dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); readFile(event.dataTransfer.files?.[0]); }} onClick={() => inputRef.current?.click()}><input ref={inputRef} hidden type="file" accept=".csv,text/csv" onChange={(event) => readFile(event.target.files?.[0])} /><span><UploadSimple size={27} /></span><strong>拖入 CSV，或点击选择文件</strong><small>字段：日期、对方、摘要、金额</small></div>{error && <p className="form-error"><WarningCircle size={16} />{error}</p>}<div className="modal-actions"><button className="secondary-button" onClick={template} type="button"><DownloadSimple size={17} />下载模板</button><button className="primary-button" onClick={() => inputRef.current?.click()} type="button">选择 CSV</button></div></section></div>;
}

function LocalBankImportDialog({ open, onClose, onToast, onComplete }) {
  useEffect(() => {
    if (!open) return undefined;
    function handleKeyDown(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop foundation-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card foundation-manager bank-import-dialog" role="dialog" aria-modal="true" aria-labelledby="bank-import-title">
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
  return <main className="no-workspace"><p className="eyebrow">{PRODUCT_NAME}</p><h1>先创建一个属于你的工作台</h1><p>可以从空白开始，也可以复制“山岚健身工作室”行业模板。模板不是固定品牌，之后可以改名或删除。</p><button className="primary-button" onClick={onCreate} type="button"><Plus size={18} />新建工作台</button><BoundaryNote /></main>;
}

function App() {
  const { state, activeWorkspace, actions, store, fileVault, loadReport } = useFinanceDesk();
  const [page, setPage] = useState("overview");
  const [workspaceDialog, setWorkspaceDialog] = useState(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const workspace = activeWorkspace ? ensureWorkspace(activeWorkspace) : null;
  const navigation = workspace ? primaryNavigationForWorkspace(workspace) : [];
  const enabledPageIds = new Set(navigation.map((item) => item.id));
  const activePage = enabledPageIds.has(page) ? page : "overview";
  const activeOperator = workspace?.users?.find((user) => user.id === state.activeUserId && user.status === "active") || null;
  const operator = activeOperator
    || workspace?.users?.find((user) => user.status === "active")
    || null;
  const actorName = activeOperator?.name?.trim() || "本地用户";
  useEffect(() => { if (page !== activePage) setPage(activePage); }, [page, activePage]);
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: "auto" }); }, [activePage, workspace?.id]);
  useEffect(() => { if (!toast) return undefined; const timer = window.setTimeout(() => setToast(null), 3200); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!workspaceDialog && !managerOpen && !importOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [workspaceDialog, managerOpen, importOpen]);
  function navigateToPage(nextPage) {
    setPage(enabledPageIds.has(nextPage) ? nextPage : "overview");
  }
  function mutateActive(updater, actionOptions = {}) {
    const current = store.getActiveWorkspace();
    if (!current) return;
    actions.replaceWorkspace(current.id, ensureWorkspace(updater(ensureWorkspace(current))), actionOptions);
  }
  function openWorkspaceDialog(mode) {
    if (mode === "manage") setManagerOpen(true);
    else setWorkspaceDialog(mode);
  }
  function switchWorkspace(id) {
    try {
      actions.switchWorkspace(id);
      setPage("overview");
      setToast({ tone: "success", message: "已切换到" + (state.workspaces.find((item) => item.id === id)?.name || "工作台") });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "工作台切换失败" });
    }
  }
  function switchUser(userId) {
    try {
      const current = store.getActiveWorkspace();
      const user = current?.users?.find((candidate) => candidate.id === userId && candidate.status === "active");
      if (!current || !user) throw new Error("只能切换到当前工作台中的有效人员");
      const role = current.roles?.find((candidate) => candidate.id === user.roleId || candidate.name === user.role)?.name || user.role || "未设置角色";
      actions.switchUser(current.id, user.id);
      setToast({ tone: "success", message: `已切换为 ${user.name} · ${role}` });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "操作人员切换失败" });
    }
  }
  async function submitWorkspaceDialog(form) {
    try {
      if (workspaceDialog === "create") {
        const template = state.workspaces.find((item) => item.isDemo || item.templateId === "fitness-studio");
        const input = form.mode === "template" && template
          ? { name: form.name.trim(), legalName: form.legalName.trim(), industry: form.industry, taxpayerType: form.taxpayerType, modules: form.modules, sourceWorkspaceId: template.id }
          : { ...form, name: form.name.trim(), legalName: form.legalName.trim(), templateId: undefined };
        const created = actions.createWorkspace(input);
        if (input.sourceWorkspaceId) {
          await copyWorkspaceLocalFiles({
            store,
            fileVault,
            sourceWorkspaceId: input.sourceWorkspaceId,
            targetWorkspaceId: created.id,
          });
        }
        setPage("overview");
        setToast({ tone: "success", message: "已创建“" + created.name + "”" });
      } else if (workspaceDialog === "rename" && workspace) {
        const name = form.name.trim();
        actions.renameWorkspace(workspace.id, name);
        setToast({ tone: "success", message: "工作台已改名为“" + name + "”" });
      } else if (workspaceDialog === "delete" && workspace) {
        if (state.workspaces.length === 1) throw new Error("至少保留一个工作台；请先新建工作台，再删除当前工作台。");
        const deletedName = workspace.name;
        const savedFiles = fileVault ? await fileVault.listByWorkspace(workspace.id) : [];
        if (fileVault) await fileVault.clearWorkspace(workspace.id);
        try {
          actions.deleteWorkspace(workspace.id);
        } catch (error) {
          if (fileVault) for (const record of savedFiles) await fileVault.put(record);
          throw error;
        }
        setPage("overview");
        setToast({ tone: "success", message: "已从本地删除“" + deletedName + "”" });
      }
      setWorkspaceDialog(null);
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "工作台操作失败" });
    }
  }
  function setTransactionStatus(ids, status) {
    if (!workspace || !ids.length) return;
    if (status !== "ignored") {
      setToast({ tone: "warning", message: "核销必须通过单笔会计处理区完成，不能直接改状态" });
      return;
    }
    const idSet = new Set(ids);
    try {
      mutateActive((current) => audit({
        ...current,
        transactions: current.transactions.map((item) => idSet.has(item.id) ? { ...item, status: "ignored", reviewedAt: new Date().toISOString() } : item),
      }, "暂不处理流水", idSet.size + " 笔 · 保留原始流水与审计记录", actorName));
      setToast({ tone: "success", message: "已将 " + idSet.size + " 笔设为暂不处理" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "流水状态更新失败" });
    }
  }
  function reviewTransactions(ids) {
    if (!ids.length) return;
    try {
      mutateActive((current) => ids.reduce((next, id) => {
        const reviewed = reviewTransactionEvidence(next, id, { actor: actorName, mode: "local-rule" });
        return recordReconciliationSuggestions(reviewed, id, { actor: actorName, mode: "local-rule" });
      }, current));
      setToast({ tone: "success", message: "已复核 " + ids.length + " 笔并生成本地匹配建议；未自动核销或入账" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "批量规则复核失败" });
    }
  }
  async function addEvidence(transactionId, file, category = "会计资料") {
    try {
      await saveLocalDocument({
        store,
        fileVault,
        workspaceId: workspace.id,
        file,
        metadata: {
          category,
          period: workspace.currentPeriod,
          relatedObjectIds: [transactionId],
        },
        relation: "supports",
        note: "单笔流水复核证据",
      });
      setToast({ tone: "success", message: "原文件与证据关联已保存在当前浏览器，请完成人工确认" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "本地证据保存失败" });
    }
  }
  function linkExistingEvidence(transactionId, documentId) {
    if (!documentId) return false;
    try {
      mutateActive((current) => {
        const linkedAt = new Date().toISOString();
        const linked = attachEvidenceDocument(
          current,
          { transactionId, documentId },
          { actor: actorName, mode: "manual", at: linkedAt },
        );
        const relationExists = (linked.evidenceLinks || []).some((item) => (
          item.status !== "inactive"
          && item.documentIds?.includes(documentId)
          && item.objectIds?.includes(transactionId)
        ));
        return {
          ...linked,
          documents: linked.documents.map((document) => document.id === documentId ? {
            ...document,
            relatedObjectIds: [...new Set([...(document.relatedObjectIds || []), transactionId])],
            updatedAt: linkedAt,
          } : document),
          evidenceLinks: relationExists ? linked.evidenceLinks : [...(linked.evidenceLinks || []), {
            id: uid("evidence-link"),
            documentIds: [documentId],
            objectIds: [transactionId],
            relation: "supports",
            note: "单笔流水复核证据",
            status: "active",
            createdAt: linkedAt,
            updatedAt: linkedAt,
          }],
        };
      }, { requiredPermission: "documents.add" });
      setToast({ tone: "success", message: "已有资料已关联到流水，并同步更新凭证证据来源" });
      return true;
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "已有资料关联失败" });
      return false;
    }
  }
  function addLedgerMember(values) {
    try {
      mutateActive((current) => audit(
        addMember(current, values, { actor: actorName }),
        "新增会员",
        `${values.name} · ${values.coach || "未分配教练"}`,
        actorName,
      ));
      setToast({ tone: "success", message: `会员“${values.name}”已保存到当前工作台` });
      return true;
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "会员保存失败" });
      return false;
    }
  }
  function changeLedgerMemberStatus(memberId, status) {
    try {
      const member = workspace.members.find((item) => item.id === memberId);
      const label = MEMBER_STATUS_OPTIONS.find((item) => item.value === status)?.label || status;
      mutateActive((current) => audit(
        updateMemberStatus(current, memberId, status, { actor: actorName }),
        "更新会员状态",
        `${member?.name || memberId} → ${label}`,
        actorName,
      ));
      setToast({ tone: "success", message: `${member?.name || "会员"}已更新为“${label}”` });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "会员状态更新失败" });
    }
  }
  function addLedgerEvent(values) {
    try {
      const definition = MEMBER_EVENT_DEFINITIONS[values.kind];
      mutateActive((current) => audit(
        addMemberBusinessEvent(current, values, { actor: actorName }),
        `新增${definition?.label || "会员业务"}`,
        `${values.date} · ${values.amount} 元 · 待确认`,
        actorName,
      ));
      setToast({ tone: "success", message: `${definition?.label || "业务"}已新增，等待确认` });
      return true;
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "会员业务保存失败" });
      return false;
    }
  }
  function changeLedgerEventStatus(eventId, status) {
    try {
      const event = workspace.businessEvents.find((item) => item.id === eventId);
      mutateActive((current) => audit(
        updateMemberBusinessEventStatus(current, eventId, status, { actor: actorName }),
        "更新会员业务状态",
        `${event?.accountingLabel || event?.memberName || eventId} → ${status}`,
        actorName,
      ));
      setToast({ tone: "success", message: status === "void" ? "业务已作废，余额已同步恢复" : "业务状态与会员余额已更新" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "业务状态更新失败" });
    }
  }
  function exportSelected(items) {
    try {
      const rows = [["日期", "对方", "摘要", "金额", "状态", "流水号"], ...items.map((item) => [item.date, item.counterparty, item.summary, item.amount, transactionStatus(item).label, item.serial])];
      const csv = `\ufeff${rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n")}`;
      mutateActive((current) => audit(current, "导出所选流水", `${items.length} 笔 · CSV`, actorName), { allowArchivedTransition: true, requiredPermission: "data.read" });
      downloadText(csv, `${PRODUCT_NAME}-${workspace.currentPeriod}-所选流水.csv`, "text/csv;charset=utf-8");
      setToast({ tone: "success", message: `已导出 ${items.length} 笔所选流水` });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "流水导出失败" });
    }
  }
  function freezeReport() {
    try {
      const snapshot = buildReportSnapshot(workspace);
      if (!Object.values(snapshot.summary.engineChecks || {}).every((check) => check.passed)) {
        setToast({ tone: "danger", message: "三表尚未勾稽，不能冻结版本。" });
        return;
      }
      mutateActive((current) => {
        const engineFrozen = freezeAccountingReportVersion(
          current,
          { period: current.currentPeriod, label: "月度财务报表" },
          { actor: actorName },
        );
        return freezeReportVersion(engineFrozen, actorName);
      });
      setToast({ tone: "success", message: "已冻结 " + workspace.currentPeriod + " 新报表版本与来源快照" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "报表校验未通过" });
    }
  }
  async function exportReportExcel() {
    try {
      const current = ensureWorkspace(store.getActiveWorkspace());
      const flow = workflowChecks(current);
      if (!flow.version?.sourceFingerprint) throw new Error("当前没有可导出的有效冻结版本，请先重新冻结报表");
      const metadata = await exportFrozenReportExcel(current, {
        reportVersion: flow.version,
        currentSourceFingerprint: flow.version.sourceFingerprint,
      });
      mutateActive((latest) => {
        const latestFlow = workflowChecks(latest);
        if (!latestFlow.version || latestFlow.version.id !== metadata.reportVersionId || latestFlow.version.sourceFingerprint !== metadata.sourceFingerprint) {
          throw new Error("导出期间数据已经变化，不能把旧版本写入本地导出记录");
        }
        return recordFrozenReportExcelExport(latest, metadata, { actor: actorName, at: metadata.generatedAt });
      });
      setToast({ tone: "success", message: `${metadata.reportVersionLabel} Excel 已下载并记录在本地，未上传网络` });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "Excel 导出失败" });
    }
  }
  function changeTax(field, value) {
    try {
      mutateActive((current) => ({ ...current, tax: { ...current.tax, [field]: value, frozenAt: null, financeConfirmedAt: null, payrollConfirmedAt: null, ownerConfirmedAt: null, confirmedBy: "", financeConfirmedVersionId: null, payrollConfirmedVersionId: null, ownerConfirmedVersionId: null }, delivery: { ...current.delivery, filing: { period: current.currentPeriod, draftCreatedAt: null, draftVersionId: null, initialConfirmationId: null, finalConfirmedVersionId: null, exportedAt: null, exportedPackage: null, receipt: null, archivedAt: null } } }));
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "申报底稿更新失败" });
    }
  }
  function commitTax(field) {
    try {
      const labels = { adjustments: "增值税计税基础调整", payroll: "工资薪金", socialSecurity: "社保数据", note: "复核备注" };
      mutateActive((current) => audit(current, "修改申报底稿", `${labels[field] || field}已更新，后续确认状态已撤销`, actorName));
      setToast({ tone: "warning", message: "底稿已更新，请重新冻结报表并确认" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "申报底稿保存失败" });
    }
  }
  function recordInitialConfirmationSection({ section, decision, note, isMajor, responsibleName }) {
    try {
      if (!note?.trim()) throw new Error("每一项确认都必须填写说明");
      if (isMajor && !responsibleName?.trim()) throw new Error("重大事项必须填写本项负责人签字姓名");
      const at = new Date().toISOString();
      const decisionActor = isMajor ? responsibleName.trim() : "客户负责人";
      mutateActive((current) => {
        const flow = workflowChecks(current);
        const missingPrerequisites = flow.checks.slice(0, 5).filter((item) => !item.ok);
        if (!flow.version) throw new Error("当前报表版本已变化，请重新冻结后确认");
        if (missingPrerequisites.length) throw new Error(`首次确认前仍需完成：${missingPrerequisites.map((item) => item.label).join("、")}`);

        let next = current;
        let confirmation = [...(next.confirmations || [])].reverse().find((item) => (
          item.kind === "tax"
          && item.period === next.currentPeriod
          && item.reportVersionId === flow.version.id
          && item.status !== "disputed"
        ));
        if (!confirmation) {
          next = createCustomerConfirmationPackage(
            next,
            { period: next.currentPeriod, reportVersionId: flow.version.id },
            { actor: actorName, at },
          );
          confirmation = next.confirmations.at(-1);
        }
        if (confirmation.sections?.[section]?.status !== "pending") throw new Error("本项已保存，不能重复覆盖原确认记录");

        next = recordCustomerConfirmation(next, {
          confirmationId: confirmation.id,
          section,
          decision,
          note: isMajor ? `重大事项：${note.trim()}` : note.trim(),
        }, { actor: decisionActor, at });
        if (decision === "approve" && ["payroll", "socialSecurity"].includes(section)) {
          next = confirmPayrollSocialData(next, { section, confirmed: true }, { actor: actorName, at });
        }

        const savedConfirmation = next.confirmations.find((item) => item.id === confirmation.id);
        const allApproved = Object.values(savedConfirmation.sections || {}).every((item) => item.status === "approved");
        const resetFiling = {
          ...next.delivery.filing,
          period: next.currentPeriod,
          draftCreatedAt: null,
          draftVersionId: null,
          initialConfirmationId: confirmation.id,
          finalConfirmedVersionId: null,
          exportedAt: null,
          exportedPackage: null,
          receipt: null,
          archivedAt: null,
        };
        if (decision === "reject") {
          return audit({
            ...next,
            tax: {
              ...next.tax,
              financeConfirmedAt: null,
              payrollConfirmedAt: null,
              socialSecurityConfirmedAt: null,
              ownerConfirmedAt: null,
              confirmedBy: "",
              financeConfirmedVersionId: null,
              payrollConfirmedVersionId: null,
              socialSecurityConfirmedVersionId: null,
              payrollConfirmedFingerprint: null,
              socialSecurityConfirmedFingerprint: null,
              ownerConfirmedVersionId: null,
            },
            delivery: { ...next.delivery, filing: resetFiling },
          }, "客户异议退回 S7", `${section}：${note.trim()}`, actorName);
        }

        const withResetDownstream = {
          ...next,
          tax: { ...next.tax, ownerConfirmedAt: null, ownerConfirmedVersionId: null, confirmedBy: "" },
          delivery: { ...next.delivery, filing: resetFiling },
        };
        if (!allApproved) return withResetDownstream;
        return audit({
          ...withResetDownstream,
          tax: {
            ...withResetDownstream.tax,
            financeConfirmedAt: savedConfirmation.updatedAt || at,
            financeConfirmedVersionId: flow.version.id,
          },
        }, "客户第一次确认完成", "收入、成本费用、应交税额、进项税、工资、社保、财务报表与待核实事项均已逐项确认", actorName);
      });
      if (decision === "reject") {
        navigateToPage("reconcile");
        setToast({ tone: "warning", message: "异议已形成 S7 异常任务，已返回异常处理" });
      } else {
        setToast({ tone: "success", message: "本项确认已写入本地 confirmation 数据链" });
      }
      return true;
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "客户确认记录失败" });
      return false;
    }
  }
  function resolveException(taskId) {
    try {
      mutateActive((current) => {
        const now = new Date().toISOString();
        const task = (current.exceptionTasks || []).find((item) => item.id === taskId);
        if (!task) throw new Error("找不到要关闭的异常任务");
        return audit({
          ...current,
          exceptionTasks: current.exceptionTasks.map((item) => item.id === taskId ? { ...item, status: "resolved", resolvedAt: now, updatedAt: now, history: [...(item.history || []), { at: now, actor: actorName, action: "resolved", note: "已在本地复核并准备重新出具报表" }] } : item),
        }, "关闭异常任务", `${task.code}：${task.message}`, actorName);
      });
      setToast({ tone: "success", message: "异议已关闭；请重新核对并冻结新的报表版本" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "异常任务关闭失败" });
    }
  }
  function resolveNotice(noticeId) {
    try {
      mutateActive((current) => {
        const notice = (current.delivery.notices || []).find((item) => item.id === noticeId);
        if (!notice) throw new Error("找不到要处理的跨期事项");
        const resolvedAt = new Date().toISOString();
        return audit({
          ...current,
          delivery: {
            ...current.delivery,
            notices: current.delivery.notices.map((item) => item.id === noticeId ? { ...item, status: "resolved", resolvedAt, resolvedBy: actorName } : item),
          },
        }, "处理跨期事项", `${notice.sourceId}：${notice.message}`, actorName);
      });
      setToast({ tone: "success", message: "跨期事项已处理并保留来源记录" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "跨期事项处理失败" });
    }
  }
  function prepareDraft() {
    try {
      mutateActive((current) => {
        const flow = workflowChecks(current);
        const confirmation = (current.confirmations || []).find((item) => item.id === current.delivery.filing.initialConfirmationId);
        const confirmationComplete = Boolean(
          confirmation
          && confirmation.kind === "tax"
          && confirmation.period === current.currentPeriod
          && confirmation.reportVersionId === flow.version?.id
          && confirmation.status === "approved"
          && ["finance", "revenue", "costExpense", "vat", "inputVat", "payroll", "socialSecurity", "openItems"].every((section) => confirmation.sections?.[section]?.status === "approved"),
        );
        if (!confirmationComplete) throw new Error("还不能生成底稿：八项客户确认尚未全部完成");
        const missing = flow.prepare.filter((item) => !item.ok);
        if (missing.length) throw new Error(`还不能生成底稿：${missing.map((item) => item.label).join("、")}`);
        return prepareFilingDraft(current, actorName);
      });
      setToast({ tone: "success", message: "本地申报底稿已生成，尚未连接税务局" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "申报底稿生成失败" });
    }
  }
  function finalConfirm({ name, selections }) {
    try {
      if (!name?.trim()) throw new Error("请填写最终负责人姓名");
      if (!selections?.numbersReviewed || !selections?.risksAcknowledged || !selections?.localOnlyAcknowledged) throw new Error("请完成三项最终确认声明");
      if (!["authorize_external", "do_not_authorize"].includes(selections?.deductionAuthorization)) throw new Error("请选择是否授权外部扣款");
      const now = new Date().toISOString();
      mutateActive((current) => {
        const flow = workflowChecks(current);
        const versionId = flow.version?.id;
        const initialConfirmation = (current.confirmations || []).find((item) => item.id === current.delivery.filing.initialConfirmationId);
        const initialConfirmationComplete = Boolean(
          initialConfirmation
          && initialConfirmation.status === "approved"
          && initialConfirmation.reportVersionId === versionId
          && ["finance", "revenue", "costExpense", "vat", "inputVat", "payroll", "socialSecurity", "openItems"].every((section) => initialConfirmation.sections?.[section]?.status === "approved"),
        );
        if (!versionId || current.delivery.filing.draftVersionId !== versionId || !current.delivery.filing.draftCreatedAt) throw new Error("当前底稿与报表版本不一致，请重新生成");
        if (!initialConfirmationComplete || !flow.prepare.every((item) => item.ok)) throw new Error("第一次客户确认或前置复核已失效，请重新完成");

        const snapshot = buildFinalConfirmationSnapshot(current, flow);
        const finalRecord = {
          id: uid("final-confirmation"),
          kind: "final",
          period: current.currentPeriod,
          version: (current.confirmations || []).filter((item) => item.kind === "final" && item.period === current.currentPeriod).length + 1,
          status: "approved",
          createdAt: now,
          confirmedAt: now,
          confirmedBy: name.trim(),
          reportVersionId: versionId,
          reportSourceFingerprint: flow.version.sourceFingerprint || null,
          filingDraftVersionId: current.delivery.filing.draftVersionId,
          filingDraftCreatedAt: current.delivery.filing.draftCreatedAt,
          selections: {
            numbersReviewed: true,
            risksAcknowledged: true,
            localOnlyAcknowledged: true,
            deductionAuthorization: selections.deductionAuthorization,
          },
          signature: { name: name.trim(), signedAt: now },
          snapshot,
          decisions: [{ id: uid("decision"), decision: "approve", actor: name.trim(), at: now, note: "最终数字、风险、本地包边界和外部扣款选择已逐项确认" }],
          sourceIds: [versionId, current.delivery.filing.initialConfirmationId].filter(Boolean),
        };
        const next = {
          ...current,
          confirmations: [...(current.confirmations || []), finalRecord],
          tax: {
            ...current.tax,
            ownerConfirmedAt: now,
            confirmedBy: name.trim(),
            ownerConfirmedVersionId: versionId,
            finalConfirmationId: finalRecord.id,
          },
          delivery: {
            ...current.delivery,
            filing: {
              ...current.delivery.filing,
              finalConfirmedVersionId: versionId,
              exportedAt: null,
              exportedPackage: null,
              receipt: null,
              archivedAt: null,
            },
          },
        };
        const deductionLabel = selections.deductionAuthorization === "authorize_external" ? "授权外部办理扣款" : "不授权外部扣款";
        return audit(next, "客户第二次最终确认", `${name.trim()}确认 ${versionId} 当前数字与风险；${deductionLabel}；仅保存本地记录，未提交税务局、未执行扣款`, actorName);
      });
      setToast({ tone: "success", message: "最终确认快照已保存；尚未提交税务局，也未执行扣款" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "最终确认失败" });
    }
  }
  async function exportPackage() { try { const meta = await exportLocalFilingPackage(workspace); mutateActive((current) => markPackageExported(current, meta, actorName)); setToast({ tone: "success", message: "本地申报包已导出；这不代表已提交税务局" }); } catch (error) { setToast({ tone: "danger", message: error.message || "本地申报包导出失败" }); } }
  async function receiveReceipt(file) {
    let document = null;
    try {
      document = await saveLocalDocument({
        store,
        fileVault,
        workspaceId: workspace.id,
        file,
        metadata: {
          category: "申报回执",
          period: workspace.currentPeriod,
          deliveryArtifact: true,
        },
      });
      const receipt = await importLocalReceipt(file);
      mutateActive((current) => attachReceipt(current, { ...receipt, documentId: document.id, storage: document.storage }, actorName));
      setToast({ tone: "success", message: "真实外部回执原件与索引已保存在当前浏览器" });
    } catch (error) {
      if (document) {
        try {
          await removeLocalDocument({ store, fileVault, workspaceId: workspace.id, documentId: document.id });
        } catch {
          // The visible document record is retained if compensating cleanup cannot complete.
        }
      }
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
      setToast({ tone: "success", message: "已把 " + files.length + " 份资料与原文件保存到当前浏览器" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "本地资料保存失败" });
    }
  }
  function completeArchive() {
    try {
      const missing = workflowChecks(workspace).archive.filter((item) => !item.ok);
      if (missing.length) throw new Error(`还不能归档：${missing.map((item) => item.label).join("、")}`);
      mutateActive((current) => archivePeriod(current, actorName));
      setToast({ tone: "success", message: `${workspace.currentPeriod} 已完成本地归档` });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "期间归档失败" });
    }
  }
  function goNextPeriod() { try { const next = enterNextPeriod(workspace, actorName); if (next.currentPeriod === workspace.currentPeriod) { setToast({ tone: "warning", message: "请先完成本期归档。" }); return; } mutateActive(() => next, { allowArchivedTransition: true }); setPage("overview"); setToast({ tone: "success", message: `已进入${formatPeriod(next.currentPeriod)}，期末余额已继承` }); } catch (error) { setToast({ tone: "danger", message: error.message || "无法进入下一期" }); } }
  function exportArchiveIndex() {
    try {
      const index = { product: PRODUCT_NAME, workspace: workspace.name, exportedAt: new Date().toISOString(), archives: workspace.delivery.archives, activeFiling: workspace.delivery.filing, auditLog: workspace.auditLog };
      mutateActive((current) => audit(current, "导出归档索引", `${current.delivery.archives.length} 个期间 · JSON`, actorName), { allowArchivedTransition: true, requiredPermission: "data.read" });
      downloadText(JSON.stringify(index, null, 2), `${PRODUCT_NAME}-${workspace.name}-归档索引.json`, "application/json;charset=utf-8");
      setToast({ tone: "success", message: "归档索引已导出到本地" });
    } catch (error) {
      setToast({ tone: "danger", message: error.message || "归档索引导出失败" });
    }
  }
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
      <Sidebar state={state} workspace={workspace} page={activePage} onPage={navigateToPage} onSwitchWorkspace={switchWorkspace} onSwitchUser={switchUser} onOpenWorkspaceDialog={openWorkspaceDialog} />
      <div className="app-main">
        <Topbar state={state} workspace={workspace} page={activePage} workspaceOverlayOpen={Boolean(workspaceDialog || managerOpen)} onImport={() => setImportOpen(true)} onSwitchWorkspace={switchWorkspace} onOpenWorkspaceDialog={openWorkspaceDialog} />
        {loadReport.recovered && <div className="danger-banner recovery-banner"><WarningCircle size={18} /><span><strong>{loadReport.source === "backup" ? "本地数据已从上一次有效副本恢复。" : "本地主副本与备用副本均无法读取，当前已加载初始模板。"}</strong>{loadReport.errors?.length ? ` 原因：${loadReport.errors.join("；")}` : " 请先核对数据并导出备份。"}</span></div>}
        {activePage === "overview" && <OverviewPage workspace={workspace} onPage={navigateToPage} onResolveNotice={resolveNotice} />}
        {activePage === "members" && <MemberLedgerPage workspace={workspace} onAddMember={addLedgerMember} onMemberStatus={changeLedgerMemberStatus} onAddEvent={addLedgerEvent} onEventStatus={changeLedgerEventStatus} />}
        {activePage === "reconcile" && <ReconcilePage workspace={workspace} onPage={navigateToPage} onStatus={setTransactionStatus} onReview={reviewTransactions} onEvidence={addEvidence} onLinkEvidence={linkExistingEvidence} onExportSelected={exportSelected} onResolveException={resolveException} onToast={(message) => setToast({ tone: "success", message })} />}
        {activePage === "reports" && <ReportsPage workspace={workspace} onPage={navigateToPage} onFreeze={freezeReport} onExportExcel={exportReportExcel} />}
        {activePage === "tax" && <TaxPage workspace={workspace} onPage={navigateToPage} onTaxChange={changeTax} onTaxCommit={commitTax} onSectionDecision={recordInitialConfirmationSection} onPrepareDraft={prepareDraft} onFinalConfirm={finalConfirm} onExport={exportPackage} onReceipt={receiveReceipt} />}
        {activePage === "archive" && <ArchivePage workspace={workspace} onPage={navigateToPage} onDocuments={addDocuments} onReceipt={receiveReceipt} onArchive={completeArchive} onNextPeriod={goNextPeriod} onExportIndex={exportArchiveIndex} />}
        {activePage === "setup" && <FoundationRecordsPanel onToast={(message) => setToast({ tone: "success", message })} />}
      </div>
      <BottomNav workspace={workspace} page={activePage} onPage={navigateToPage} />
      <WorkspaceDialog mode={workspaceDialog} workspace={workspace} onClose={() => setWorkspaceDialog(null)} onSubmit={submitWorkspaceDialog} />
      <WorkspaceManager open={managerOpen} onClose={() => setManagerOpen(false)} onToast={(message) => setToast({ tone: "success", message })} />
      <LocalBankImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onToast={(message) => setToast({ tone: "success", message })}
        onComplete={() => navigateToPage("reconcile")}
      />
      {toast && <div className={"toast " + toast.tone}><CheckCircle size={19} weight="fill" />{toast.message}</div>}
    </div>
  );
}

export default App;
export { App };
