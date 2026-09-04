import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowRight,
  Bank,
  CalendarBlank,
  CaretDown,
  Check,
  CheckCircle,
  ClipboardText,
  Clock,
  DotsThree,
  DownloadSimple,
  FileArrowUp,
  FileText,
  GearSix,
  HouseLine,
  MagnifyingGlass,
  Receipt,
  SealCheck,
  SlidersHorizontal,
  Sparkle,
  SpinnerGap,
  TrendUp,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

import { BankImportPanel } from "./features/intake/BankImportPanel.jsx";
import { DocumentIntakePanel } from "./features/intake/DocumentIntakePanel.jsx";
import { FoundationRecordsPanel } from "./features/workspaces/FoundationRecordsPanel.jsx";
import { WorkspaceManager, WorkspaceTrigger } from "./features/workspaces/WorkspaceManager.jsx";
import { useFinanceDesk } from "./store/FinanceDeskProvider.jsx";

const STORAGE_KEY = "shanlan-finance-demo-v1";

const stages = ["资料", "匹配", "核销", "凭证", "报表", "确认"];

const seedTransactions = [
  {
    id: "txn-001",
    date: "2026-08-26",
    counterparty: "美团平台商户",
    summary: "团课收入 · 8 月",
    amount: 1286,
    category: "团课收入",
    status: "pending",
    confidence: 92,
    evidence: 4,
    evidenceTotal: 5,
    missing: "平台结算单",
    source: "招商银行（8821）",
    serial: "2026082600123",
    billNo: "SR-20260826-001",
    customer: "美团平台",
    reason: "金额与课程系统汇总一致，缺少平台结算单。",
  },
  {
    id: "txn-002",
    date: "2026-08-25",
    counterparty: "会员李女士",
    summary: "私教课预收 · 20 节",
    amount: 4800,
    category: "私教课预收",
    status: "pending",
    confidence: 95,
    evidence: 5,
    evidenceTotal: 5,
    missing: "",
    source: "招商银行（8821）",
    serial: "2026082500891",
    billNo: "RC-20260825-014",
    customer: "李女士",
    reason: "会员、金额与课程订单三项完全一致。",
  },
  {
    id: "txn-003",
    date: "2026-08-24",
    counterparty: "拉卡拉支付",
    summary: "收单手续费",
    amount: -12.8,
    category: "支付手续费",
    status: "pending",
    confidence: 98,
    evidence: 5,
    evidenceTotal: 5,
    missing: "",
    source: "招商银行（8821）",
    serial: "2026082403407",
    billNo: "FEE-20260824-003",
    customer: "拉卡拉支付",
    reason: "费率与当日收款流水一致。",
  },
  {
    id: "txn-004",
    date: "2026-08-23",
    counterparty: "会员王先生",
    summary: "私教课预收 · 10 节",
    amount: 2400,
    category: "私教课预收",
    status: "pending",
    confidence: 90,
    evidence: 4,
    evidenceTotal: 5,
    missing: "会员协议",
    source: "招商银行（8821）",
    serial: "2026082300428",
    billNo: "RC-20260823-006",
    customer: "王先生",
    reason: "付款备注可对应订单，但会员协议尚未归档。",
  },
  {
    id: "txn-005",
    date: "2026-08-23",
    counterparty: "支付宝转账",
    summary: "器械采购 · 力量器械",
    amount: -3680,
    category: "器械采购",
    status: "pending",
    confidence: 85,
    evidence: 3,
    evidenceTotal: 5,
    missing: "采购发票、审批记录",
    source: "招商银行（8821）",
    serial: "2026082300572",
    billNo: "PO-20260823-002",
    customer: "力盛器械",
    reason: "付款对象与采购单一致，仍缺发票与审批。",
  },
  {
    id: "txn-006",
    date: "2026-08-20",
    counterparty: "会员张女士",
    summary: "瑜伽小班课预收",
    amount: 299,
    category: "团课预收",
    status: "pending",
    confidence: 88,
    evidence: 4,
    evidenceTotal: 5,
    missing: "课程签到",
    source: "招商银行（8821）",
    serial: "2026082000719",
    billNo: "RC-20260820-011",
    customer: "张女士",
    reason: "已匹配课程订单，等待课后签到记录。",
  },
  {
    id: "txn-007",
    date: "2026-08-18",
    counterparty: "美团平台商户",
    summary: "团课收入 · 周结",
    amount: 956,
    category: "团课收入",
    status: "matched",
    confidence: 97,
    evidence: 5,
    evidenceTotal: 5,
    missing: "",
    source: "招商银行（8821）",
    serial: "2026081800230",
    billNo: "SR-20260818-004",
    customer: "美团平台",
    reason: "平台结算单、订单与到账金额一致。",
  },
  {
    id: "txn-008",
    date: "2026-08-16",
    counterparty: "会员刘先生",
    summary: "私教课收入 · 6 节",
    amount: 1440,
    category: "私教课收入",
    status: "matched",
    confidence: 96,
    evidence: 5,
    evidenceTotal: 5,
    missing: "",
    source: "招商银行（8821）",
    serial: "2026081600168",
    billNo: "SR-20260816-018",
    customer: "刘先生",
    reason: "合同、排课与到账记录一致。",
  },
  {
    id: "txn-009",
    date: "2026-08-14",
    counterparty: "微信支付",
    summary: "团课收入 · 聚合收款",
    amount: 816,
    category: "团课收入",
    status: "matched",
    confidence: 94,
    evidence: 5,
    evidenceTotal: 5,
    missing: "",
    source: "招商银行（8821）",
    serial: "2026081400912",
    billNo: "SR-20260814-028",
    customer: "微信支付",
    reason: "聚合收款明细与课程订单合计一致。",
  },
  {
    id: "txn-010",
    date: "2026-08-12",
    counterparty: "国家电网",
    summary: "工作室电费",
    amount: -320.5,
    category: "水电费",
    status: "matched",
    confidence: 99,
    evidence: 5,
    evidenceTotal: 5,
    missing: "",
    source: "招商银行（8821）",
    serial: "2026081200286",
    billNo: "EXP-20260812-005",
    customer: "国家电网",
    reason: "电子发票、账单与付款金额一致。",
  },
];

const demoDocuments = [
  { id: 1, title: "8 月银行流水", type: "银行流水", meta: "招商银行 · 134 条", status: "已解析" },
  { id: 2, title: "美团平台结算单", type: "平台账单", meta: "2026-08-01 至 08-31", status: "待补充" },
  { id: 3, title: "会员订单汇总", type: "业务账单", meta: "课程系统 · 86 笔", status: "已解析" },
  { id: 4, title: "8 月费用发票", type: "票据", meta: "18 张 · ¥14,820.30", status: "已归档" },
];

const statusMap = {
  pending: { label: "待核销", tone: "warning" },
  matched: { label: "已核销", tone: "success" },
  ignored: { label: "暂不处理", tone: "neutral" },
};

function loadTransactions() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : seedTransactions;
  } catch {
    return seedTransactions;
  }
}

function money(value) {
  const sign = value < 0 ? "−" : "+";
  return `${sign}¥${Math.abs(value).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDate(date) {
  const [, month, day] = date.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function StatusPill({ status }) {
  const item = statusMap[status] || statusMap.pending;
  return <span className={`status-pill ${item.tone}`}>{item.label}</span>;
}

function EvidenceMeter({ value, total }) {
  return (
    <div className="evidence-meter" aria-label={`证据完整度 ${value}/${total}`}>
      <span>{value}/{total}</span>
      <div className="meter-track">
        <i style={{ width: `${(value / total) * 100}%` }} />
      </div>
    </div>
  );
}

function StageRail({ active = 2, onChange }) {
  return (
    <div className="stage-rail" aria-label="关账阶段">
      {stages.map((stage, index) => (
        <button
          className={`stage-step ${index < active ? "done" : ""} ${index === active ? "active" : ""}`}
          key={stage}
          onClick={() => onChange?.(index)}
          type="button"
        >
          <span className="stage-dot">{index < active ? <Check size={12} weight="bold" /> : index + 1}</span>
          <span>{stage}</span>
        </button>
      ))}
    </div>
  );
}

const navItems = [
  { id: "close", label: "月度关账", mobileLabel: "关账", icon: HouseLine },
  { id: "reconcile", label: "核销工作台", mobileLabel: "核销", icon: SealCheck },
  { id: "reports", label: "凭证与报表", mobileLabel: "凭证报表", icon: ClipboardText },
  { id: "archive", label: "资料档案", mobileLabel: "资料档案", icon: Archive },
  { id: "setup", label: "基础资料", mobileLabel: "基础", icon: GearSix },
];

function Sidebar({ page, setPage, activeWorkspace, onManageWorkspace }) {
  const activeUser = activeWorkspace.users.find((user) => user.status === "active") || activeWorkspace.users[0];
  return (
    <aside className="sidebar">
      <WorkspaceTrigger onClick={onManageWorkspace} />

      <nav className="primary-nav" aria-label="主导航">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={page === item.id ? "active" : ""}
              key={item.id}
              onClick={() => setPage(item.id)}
              type="button"
            >
              <Icon size={19} weight={page === item.id ? "fill" : "regular"} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-bottom">
        <div className="period-card">
          <CalendarBlank size={18} />
          <div><small>当前账期</small><strong>{activeWorkspace.currentPeriod || "未设置"}</strong></div>
        </div>
        <button className="account-card" type="button">
          <span className="avatar">会</span>
          <div><strong>{activeUser?.name || "本地用户"}</strong><small>{activeUser?.role || "尚未设置角色"}</small></div>
        </button>
      </div>
    </aside>
  );
}

function BottomNav({ page, setPage }) {
  return (
    <nav className="bottom-nav" aria-label="移动端导航">
      {navItems.map((item) => {
        const Icon = item.icon;
        return (
          <button className={page === item.id ? "active" : ""} key={item.id} onClick={() => setPage(item.id)} type="button">
            <Icon size={19} weight={page === item.id ? "fill" : "regular"} />
            <span>{item.mobileLabel}</span>
          </button>
        );
      })}
    </nav>
  );
}

function Topbar({ title, subtitle, workspace, onPeriodChange, onImport, onManageWorkspace, onOpenSetup, onReset }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">{workspace.currentPeriod || "未设置账期"} · {workspace.templateLabel || "本地工作台"}</p>
        <h1>{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      <div className="topbar-actions">
        <label className="period-select">
          <CalendarBlank size={18} />
          <select value={workspace.currentPeriod || ""} onChange={(event) => onPeriodChange(event.target.value)} aria-label="选择账期">
            {(workspace.periods || [workspace.currentPeriod]).filter(Boolean).map((period) => <option value={period} key={period}>{period.replace("-", " 年 ")} 月</option>)}
          </select>
          <CaretDown size={14} />
        </label>
        <button className="primary-button" onClick={onImport} type="button">
          <UploadSimple size={18} weight="bold" />
          导入流水
        </button>
        <div className="menu-wrap">
          <button className="icon-button" aria-label="更多操作" onClick={() => setMenuOpen((value) => !value)} type="button">
            <DotsThree size={22} weight="bold" />
          </button>
          {menuOpen && (
            <div className="popover-menu">
              <button type="button" onClick={() => { onOpenSetup(); setMenuOpen(false); }}><GearSix size={17} />基础资料与规则</button>
              <button type="button" onClick={() => { onManageWorkspace(); setMenuOpen(false); }}><Clock size={17} />工作台与备份</button>
              <button type="button" onClick={() => { onReset(); setMenuOpen(false); }}><SpinnerGap size={17} />清空当前业务数据</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function SummaryCard({ label, value, note, icon: Icon, tone = "plain" }) {
  return (
    <article className={`summary-card ${tone}`}>
      <span className="summary-icon"><Icon size={20} /></span>
      <div><small>{label}</small><strong>{value}</strong><p>{note}</p></div>
    </article>
  );
}

function CloseOverview({ transactions, goReconcile }) {
  const pending = transactions.filter((item) => item.status === "pending");
  const selected = pending.find((item) => item.id === "txn-005") || pending[0] || transactions[0];

  return (
    <div className="page-content close-page">
      <StageRail active={2} onChange={(index) => index === 2 && goReconcile()} />

      <section className="hero-grid">
        <article className="progress-card">
          <div className="section-heading compact">
            <div><p className="eyebrow">本月结账进度</p><h2>距离关账，还差几件小事</h2></div>
            <span className="progress-number">64%</span>
          </div>
          <div className="progress-track"><i style={{ width: "64%" }} /></div>
          <div className="progress-meta">
            <span><i className="dot sage" />已完成 4 个步骤</span>
            <span><i className="dot clay" />待处理 {Math.max(pending.length, 6)} 笔</span>
          </div>
        </article>

        <article className="next-action-card">
          <span className="card-kicker"><Sparkle size={17} weight="fill" />下一步建议</span>
          <h3>先补齐器械采购的审批证据</h3>
          <p>这笔付款缺少发票与审批记录，补齐后即可核销并生成凭证草稿。</p>
          <button className="text-button" type="button" onClick={goReconcile}>去处理这笔流水 <ArrowRight size={16} /></button>
        </article>
      </section>

      <section className="summary-row">
        <SummaryCard label="银行流水" value="134" note="本月已完整导入" icon={Bank} />
        <SummaryCard label="已核销" value="128" note="其中 4 笔本页可查看" icon={CheckCircle} tone="sage" />
        <SummaryCard label="待处理" value={Math.max(pending.length, 6)} note="优先补齐 3 笔证据" icon={WarningCircle} tone="clay" />
      </section>

      <section className="overview-grid">
        <article className="panel task-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">关账任务</p><h2>本月待办</h2></div>
            <button className="soft-button" onClick={goReconcile} type="button">查看全部</button>
          </div>
          <div className="task-list">
            {[
              ["核对银行流水", "128 / 134 笔", true],
              ["补齐业务证据", "3 笔缺少附件", false],
              ["确认凭证草稿", "待核销完成后生成", false],
              ["复核月度报表", "预计 9 月 3 日完成", false],
            ].map(([name, meta, done]) => (
              <div className="task-row" key={name}>
                <span className={`task-check ${done ? "done" : ""}`}>{done && <Check size={13} weight="bold" />}</span>
                <div><strong>{name}</strong><small>{meta}</small></div>
                <ArrowRight size={16} />
              </div>
            ))}
          </div>
        </article>

        <article className="panel evidence-preview">
          <div className="panel-heading">
            <div><p className="eyebrow">证据链预览</p><h2>{selected?.summary}</h2></div>
            <StatusPill status={selected?.status} />
          </div>
          <div className="evidence-flow">
            <div className="flow-node good"><Bank size={19} /><span>银行流水</span><small>{money(selected?.amount || 0)}</small></div>
            <ArrowRight size={18} />
            <div className="flow-node good"><Receipt size={19} /><span>采购单</span><small>{selected?.billNo}</small></div>
            <ArrowRight size={18} />
            <div className="flow-node missing"><FileText size={19} /><span>发票 / 审批</span><small>等待补齐</small></div>
          </div>
          <div className="warning-note"><WarningCircle size={18} /><span><strong>缺失：</strong>{selected?.missing || "无"}</span></div>
          <button className="primary-button wide" type="button" onClick={goReconcile}>进入核销工作台 <ArrowRight size={17} /></button>
        </article>
      </section>

      <p className="demo-note"><SealCheck size={16} />当前为本地演示数据，不连接真实银行、税务或 AI 服务。</p>
    </div>
  );
}

function TransactionTable({ items, selectedId, onSelect }) {
  return (
    <div className="table-scroll">
      <table className="transaction-table">
        <thead><tr><th>日期</th><th>交易对象 / 摘要</th><th>建议科目</th><th>金额</th><th>证据</th><th>状态</th></tr></thead>
        <tbody>
          {items.map((item) => (
            <tr
              aria-selected={selectedId === item.id}
              className={selectedId === item.id ? "selected" : ""}
              key={item.id}
              onClick={() => onSelect(item.id)}
              onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && onSelect(item.id)}
              tabIndex={0}
            >
              <td><span className="date-cell">{formatDate(item.date)}</span></td>
              <td><strong>{item.counterparty}</strong><small>{item.summary}</small></td>
              <td><span className="category-tag">{item.category}</span><small>{item.confidence}% 匹配</small></td>
              <td><span className={item.amount < 0 ? "amount expense" : "amount income"}>{money(item.amount)}</span></td>
              <td><EvidenceMeter value={item.evidence} total={item.evidenceTotal} /></td>
              <td><StatusPill status={item.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && <div className="empty-state"><MagnifyingGlass size={28} /><strong>没有符合条件的流水</strong><p>换一个筛选条件或关键词试试。</p></div>}
    </div>
  );
}

function DetailPanel({ item, onClose, updateStatus }) {
  if (!item) return null;
  return (
    <aside className="detail-panel">
      <div className="detail-heading">
        <div><p className="eyebrow">单笔证据详情</p><h2>{item.counterparty}</h2></div>
        <button className="icon-button compact" onClick={onClose} aria-label="关闭详情" type="button"><X size={19} /></button>
      </div>

      <section className="detail-section">
        <div className="detail-section-title"><i className="section-mark sage" />银行流水</div>
        <dl className="detail-list">
          <div><dt>交易日期</dt><dd>{item.date}</dd></div>
          <div><dt>对方名称</dt><dd>{item.counterparty}</dd></div>
          <div><dt>摘要</dt><dd>{item.summary}</dd></div>
          <div><dt>金额</dt><dd className={item.amount < 0 ? "expense" : "income"}>{money(item.amount)}</dd></div>
          <div><dt>账户</dt><dd>{item.source}</dd></div>
          <div><dt>流水号</dt><dd>{item.serial}</dd></div>
        </dl>
      </section>

      <section className="detail-section">
        <div className="detail-section-title"><i className="section-mark clay" />业务单据</div>
        <dl className="detail-list">
          <div><dt>建议科目</dt><dd>{item.category}</dd></div>
          <div><dt>单据编号</dt><dd>{item.billNo}</dd></div>
          <div><dt>客户 / 供应商</dt><dd>{item.customer}</dd></div>
          <div><dt>匹配置信度</dt><dd>{item.confidence}%</dd></div>
        </dl>
        <p className="match-reason"><Sparkle size={16} weight="fill" />{item.reason}</p>
      </section>

      <section className="detail-section evidence-section">
        <div className="detail-section-title"><i className="section-mark clay" />证据</div>
        {item.missing ? (
          <div className="upload-box"><FileArrowUp size={29} /><strong>缺少{item.missing}</strong><p>可在正式版本中拖入文件或从资料档案关联。</p><button type="button" className="text-button">选择本地文件</button></div>
        ) : (
          <div className="complete-box"><CheckCircle size={23} weight="fill" /><div><strong>证据链已完整</strong><p>{item.evidence}/{item.evidenceTotal} 项资料均已关联</p></div></div>
        )}
      </section>

      <div className="detail-actions">
        <button className="secondary-button" type="button" onClick={() => updateStatus(item.id, "ignored")}>暂不处理</button>
        <button className="primary-button" type="button" onClick={() => updateStatus(item.id, "matched")} disabled={item.status === "matched"}>
          <Check size={18} weight="bold" />{item.status === "matched" ? "已完成核销" : "确认核销"}
        </button>
      </div>
    </aside>
  );
}

function ReconcileWorkspace({ transactions, updateStatus }) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const firstTransactionId = transactions[0]?.id || null;
  const [selectedId, setSelectedId] = useState(() => window.matchMedia("(min-width: 1101px)").matches ? firstTransactionId : null);
  const filtered = useMemo(() => transactions.filter((item) => {
    const matchesFilter = filter === "all" || item.status === filter;
    const text = `${item.counterparty} ${item.summary} ${item.category}`.toLowerCase();
    return matchesFilter && text.includes(query.toLowerCase());
  }), [transactions, filter, query]);
  const selected = transactions.find((item) => item.id === selectedId);

  useEffect(() => {
    const desktopQuery = window.matchMedia("(min-width: 1101px)");
    const adaptSelection = (event) => setSelectedId(event.matches ? firstTransactionId : null);
    adaptSelection(desktopQuery);
    desktopQuery.addEventListener("change", adaptSelection);
    return () => desktopQuery.removeEventListener("change", adaptSelection);
  }, [firstTransactionId]);

  return (
    <div className={`reconcile-layout ${selected ? "" : "without-detail"}`}>
      <main className="reconcile-main">
        <StageRail active={2} />
        <section className="workspace-toolbar">
          <div className="filter-tabs">
            {[
              ["all", "全部流水"], ["pending", "待处理"], ["matched", "已核销"], ["ignored", "暂不处理"],
            ].map(([id, label]) => (
              <button className={filter === id ? "active" : ""} key={id} onClick={() => setFilter(id)} type="button">
                {label}<span>{id === "all" ? transactions.length : transactions.filter((item) => item.status === id).length}</span>
              </button>
            ))}
          </div>
          <label className="search-field"><MagnifyingGlass size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索对象、摘要或科目" /></label>
          <button className="soft-button icon-text" type="button"><SlidersHorizontal size={17} />筛选</button>
        </section>

        <section className="panel table-panel">
          <div className="panel-heading table-heading">
            <div><p className="eyebrow">批量核销</p><h2>银行流水</h2></div>
            <span className="table-count">当前展示 {filtered.length} 条演示流水</span>
          </div>
          <TransactionTable items={filtered} selectedId={selectedId} onSelect={setSelectedId} />
        </section>
      </main>
      <DetailPanel item={selected} onClose={() => setSelectedId(null)} updateStatus={updateStatus} />
    </div>
  );
}

function ReportsPage() {
  const [tab, setTab] = useState("vouchers");
  return (
    <div className="page-content reports-page">
      <StageRail active={tab === "vouchers" ? 3 : 4} onChange={(index) => index === 3 ? setTab("vouchers") : index === 4 && setTab("report")} />
      <div className="page-tabs">
        <button className={tab === "vouchers" ? "active" : ""} onClick={() => setTab("vouchers")} type="button">凭证草稿</button>
        <button className={tab === "report" ? "active" : ""} onClick={() => setTab("report")} type="button">财务报表</button>
      </div>
      {tab === "vouchers" ? (
        <section className="panel voucher-panel">
          <div className="panel-heading"><div><p className="eyebrow">待复核</p><h2>本月凭证草稿</h2></div><button className="soft-button" type="button"><DownloadSimple size={16} />导出草稿</button></div>
          <div className="voucher-table-wrap">
            <table className="voucher-table">
              <thead><tr><th>编号</th><th>日期</th><th>摘要</th><th>借方</th><th>贷方</th><th>状态</th></tr></thead>
              <tbody>
                <tr><td>记-001</td><td>08-12</td><td>支付工作室电费</td><td>管理费用 ¥320.50</td><td>银行存款 ¥320.50</td><td><StatusPill status="matched" /></td></tr>
                <tr><td>记-002</td><td>08-16</td><td>确认私教课收入</td><td>银行存款 ¥1,440.00</td><td>主营业务收入 ¥1,440.00</td><td><StatusPill status="matched" /></td></tr>
                <tr><td>记-003</td><td>08-23</td><td>采购力量器械</td><td>固定资产 ¥3,680.00</td><td>银行存款 ¥3,680.00</td><td><StatusPill status="pending" /></td></tr>
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section className="report-grid">
          <article className="panel statement-card">
            <div className="panel-heading"><div><p className="eyebrow">2026 年 8 月</p><h2>简明利润表</h2></div><span className="demo-badge">演示</span></div>
            <dl className="statement-list">
              <div><dt>营业收入</dt><dd>¥86,420.00</dd></div>
              <div><dt>营业成本</dt><dd>−¥18,740.00</dd></div>
              <div><dt>期间费用</dt><dd>−¥31,280.50</dd></div>
              <div className="total"><dt>本月利润</dt><dd>¥36,399.50</dd></div>
            </dl>
          </article>
          <article className="panel trend-card">
            <div className="panel-heading"><div><p className="eyebrow">近 6 个月</p><h2>收入趋势</h2></div><TrendUp size={23} className="sage-text" /></div>
            <div className="bar-chart" aria-label="近六个月收入趋势演示图">
              {[58, 72, 64, 81, 76, 92].map((height, index) => <div className="bar-item" key={index}><i style={{ height: `${height}%` }} /><span>{index + 3}月</span></div>)}
            </div>
          </article>
        </section>
      )}
      <p className="demo-note"><WarningCircle size={16} />报表为演示数据，不可用于正式申报或财务决策。</p>
    </div>
  );
}

function ArchivePage({ onToast }) {
  return (
    <div className="page-content archive-page">
      <DocumentIntakePanel defaultCategory="其他资料" onToast={onToast} />
    </div>
  );
}

function LocalBankImportDialog({ open, onClose, onToast }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card foundation-manager" role="dialog" aria-modal="true" aria-labelledby="local-bank-import-title">
        <div className="modal-heading"><div><p className="eyebrow">浏览器本地</p><h2 id="local-bank-import-title">导入银行流水</h2></div><button className="icon-button" onClick={onClose} type="button" aria-label="关闭"><X size={19} /></button></div>
        <BankImportPanel compact onToast={onToast} onComplete={onClose} />
      </section>
    </div>
  );
}

function ImportDialog({ open, onClose, onImport }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  if (!open) return null;

  function parseCsv(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const lines = String(reader.result).trim().split(/\r?\n/);
      const rows = lines.slice(1).map((line, index) => {
        const [date, counterparty, summary, amount] = line.split(",").map((cell) => cell.trim().replace(/^\"|\"$/g, ""));
        return {
          id: `import-${Date.now()}-${index}`,
          date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "2026-08-31",
          counterparty: counterparty || "未识别交易对象",
          summary: summary || "导入流水",
          amount: Number(amount) || 0,
          category: "待确认科目",
          status: "pending",
          confidence: 0,
          evidence: 1,
          evidenceTotal: 5,
          missing: "业务单据、发票、审批记录",
          source: "本地 CSV 导入",
          serial: `IMPORT-${Date.now()}-${index + 1}`,
          billNo: "待关联",
          customer: counterparty || "待确认",
          reason: "这是本地导入的演示流水，尚未运行匹配规则。",
        };
      });
      onImport(rows);
      onClose();
    };
    reader.readAsText(file, "UTF-8");
  }

  function downloadTemplate() {
    const content = "日期,对方,摘要,金额\n2026-08-31,示例客户,课程收入,880.00";
    const blob = new Blob(["\ufeff", content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "银行流水导入模板.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <div className="modal-heading"><div><p className="eyebrow">本地处理</p><h2 id="import-title">导入银行流水</h2></div><button className="icon-button" onClick={onClose} type="button" aria-label="关闭"><X size={19} /></button></div>
        <p className="modal-intro">支持 UTF-8 CSV，字段依次为：日期、对方、摘要、金额。文件只在浏览器本地读取。</p>
        <div
          className={`drop-zone ${dragging ? "dragging" : ""}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); parseCsv(event.dataTransfer.files[0]); }}
          onClick={() => inputRef.current?.click()}
        >
          <input ref={inputRef} hidden type="file" accept=".csv,text/csv" onChange={(event) => parseCsv(event.target.files[0])} />
          <span><UploadSimple size={26} /></span><strong>拖入 CSV，或点击选择文件</strong><small>建议单次不超过 2,000 条</small>
        </div>
        <div className="modal-actions"><button className="secondary-button" type="button" onClick={downloadTemplate}><DownloadSimple size={17} />下载模板</button><button className="primary-button" type="button" onClick={() => inputRef.current?.click()}>选择 CSV</button></div>
      </section>
    </div>
  );
}

function toUiTransaction(workspace, transaction) {
  const account = workspace.bankAccounts.find((item) => item.id === transaction.accountId);
  const status = transaction.status === "reconciled"
    ? "matched"
    : transaction.status === "exception"
      ? "pending"
      : transaction.status || "pending";
  const evidenceCount = transaction.evidence ?? Math.min(5, 1 + (transaction.evidenceIds || []).length);
  return {
    ...transaction,
    status,
    category: transaction.category || transaction.suggestion || "待确认科目",
    evidence: evidenceCount,
    evidenceTotal: transaction.evidenceTotal || 5,
    missing: transaction.missing || transaction.exceptionReason || "业务单据、发票或审批资料",
    source: transaction.source || account?.name || "本地银行流水",
    billNo: transaction.billNo || transaction.allocations?.[0]?.billId || "待关联",
    customer: transaction.customer || transaction.counterparty || "待确认",
    reason: transaction.reason || transaction.exceptionReason || "本地导入流水，等待人工确认与证据关联。",
  };
}

function App() {
  const { activeWorkspace, actions, fileVault, loadReport } = useFinanceDesk();
  const [page, setPage] = useState("close");
  const [importOpen, setImportOpen] = useState(false);
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = useState(false);
  const [toast, setToast] = useState("");
  const transactions = useMemo(() => activeWorkspace.transactions.map((item) => toUiTransaction(activeWorkspace, item)), [activeWorkspace]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [page]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (loadReport.recovered) setToast("检测到本地数据损坏，已恢复到最近一次有效副本");
  }, [loadReport.recovered]);

  function updateStatus(id, status) {
    const transaction = activeWorkspace.transactions.find((item) => item.id === id);
    if (!transaction) return;
    actions.upsertEntity(activeWorkspace.id, "transactions", {
      ...transaction,
      status: status === "matched" ? "reconciled" : status,
      reviewedAt: status === "matched" ? new Date().toISOString() : transaction.reviewedAt,
    }, { label: "银行流水状态" });
    setToast(status === "matched" ? "这笔流水已完成核销" : "已移入暂不处理");
  }

  async function resetDemo() {
    if (!window.confirm(`确定清空「${activeWorkspace.name}」的流水、资料、证据和凭证吗？企业设置会保留。`)) return;
    try {
      if (fileVault) await fileVault.clearWorkspace(activeWorkspace.id);
      actions.clearWorkspace(activeWorkspace.id, { scope: "operational" });
      setToast("当前工作台的业务数据已清空");
    } catch (caught) {
      setToast(caught.message || "清空工作台失败");
    }
  }

  const headings = {
    close: ["月度关账", "把资料、流水、凭证和报表收拢在一条清晰路径里。"],
    reconcile: ["核销工作台", "先看批量状态，再深入每一笔证据。"],
    reports: ["凭证与报表", "核销结果形成凭证草稿，再汇总为可复核报表。"],
    archive: ["资料档案", "所有银行流水、业务账单和票据的统一入口。"],
    setup: ["基础资料", "从企业初始化到银行、发票与组织资料，全部保存在当前浏览器。"],
  };

  return (
    <div className="app-shell">
      <Sidebar page={page} setPage={setPage} activeWorkspace={activeWorkspace} onManageWorkspace={() => setWorkspaceManagerOpen(true)} />
      <div className="app-main">
        <Topbar
          title={headings[page][0]}
          subtitle={headings[page][1]}
          workspace={activeWorkspace}
          onPeriodChange={(period) => actions.setPeriod(activeWorkspace.id, period)}
          onImport={() => setImportOpen(true)}
          onManageWorkspace={() => setWorkspaceManagerOpen(true)}
          onOpenSetup={() => setPage("setup")}
          onReset={resetDemo}
        />
        {page === "close" && <CloseOverview transactions={transactions} goReconcile={() => setPage("reconcile")} />}
        {page === "reconcile" && <ReconcileWorkspace transactions={transactions} updateStatus={updateStatus} />}
        {page === "reports" && <ReportsPage />}
        {page === "archive" && <ArchivePage onToast={setToast} />}
        {page === "setup" && <FoundationRecordsPanel onToast={setToast} />}
      </div>
      <BottomNav page={page} setPage={setPage} />
      <LocalBankImportDialog open={importOpen} onClose={() => setImportOpen(false)} onToast={(message) => { setToast(message); setPage("reconcile"); }} />
      <WorkspaceManager open={workspaceManagerOpen} onClose={() => setWorkspaceManagerOpen(false)} onToast={setToast} />
      {toast && <div className="toast"><CheckCircle size={19} weight="fill" />{toast}</div>}
    </div>
  );
}

export default App;
export { App };
