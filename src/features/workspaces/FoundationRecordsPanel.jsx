import { useEffect, useMemo, useState } from "react";
import {
  Buildings,
  Check,
  FileText,
  PencilSimple,
  Plus,
  ShieldCheck,
  Trash,
  UsersThree,
  WarningCircle,
} from "@phosphor-icons/react";

import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import { BankImportPanel } from "../intake/BankImportPanel.jsx";
import { DocumentIntakePanel } from "../intake/DocumentIntakePanel.jsx";
import "./foundation-ui.css";

const STAGES = [
  { id: "s0", label: "S0 企业与权限" },
  { id: "s1", label: "S1 账务规则" },
  { id: "s2", label: "S2 往来与合同" },
  { id: "s3", label: "S3 银行流水" },
  { id: "s4", label: "S4 发票与组织" },
];

const STATUS_OPTIONS = [
  ["draft", "草稿"],
  ["active", "有效"],
  ["pending", "待处理"],
  ["missing", "缺失"],
  ["inactive", "停用"],
  ["archived", "已归档"],
];

const COLLECTION_CONFIG = {
  books: {
    title: "账套",
    icon: Buildings,
    fields: [
      { key: "name", label: "账套名称", required: true },
      { key: "accountingStandard", label: "会计准则", placeholder: "小企业会计准则" },
      { key: "currency", label: "本位币", placeholder: "CNY" },
      { key: "status", label: "状态", type: "status" },
    ],
  },
  stores: {
    title: "门店",
    icon: Buildings,
    fields: [
      { key: "name", label: "门店名称", required: true },
      { key: "address", label: "地址" },
      { key: "status", label: "状态", type: "status" },
    ],
  },
  users: {
    title: "工作台人员",
    icon: UsersThree,
    fields: [
      { key: "name", label: "姓名", required: true },
      { key: "roleId", label: "角色", type: "select", options: [] },
      { key: "status", label: "状态", type: "status" },
    ],
  },
  roles: {
    title: "角色",
    icon: ShieldCheck,
    fields: [
      { key: "name", label: "角色名称", required: true },
      { key: "permissionsText", label: "权限", placeholder: "data.read, documents.add" },
      { key: "status", label: "状态", type: "status" },
    ],
    fromDraft: (draft) => ({ ...draft, permissions: String(draft.permissionsText || "").split(",").map((item) => item.trim()).filter(Boolean) }),
    toDraft: (item) => ({ ...item, permissionsText: (item.permissions || []).join(", ") }),
  },
  ruleSets: {
    title: "账务规则",
    icon: ShieldCheck,
    fields: [
      { key: "name", label: "规则名称", required: true },
      { key: "confidenceThreshold", label: "人工复核阈值", type: "number", placeholder: "85" },
      { key: "status", label: "状态", type: "status" },
    ],
  },
  counterparties: {
    title: "客户与供应商",
    icon: UsersThree,
    fields: [
      { key: "name", label: "标准名称", required: true },
      { key: "kind", label: "类型", type: "select", options: [["customer", "客户"], ["supplier", "供应商"], ["related_party", "关联方"], ["platform", "平台"]] },
      { key: "taxId", label: "统一社会信用代码 / 税号" },
      { key: "status", label: "状态", type: "status" },
    ],
  },
  contracts: {
    title: "合同与协议",
    icon: FileText,
    fields: [
      { key: "title", label: "合同名称", required: true },
      { key: "no", label: "合同编号" },
      { key: "counterpartyName", label: "对方名称" },
      { key: "amount", label: "合同金额", type: "number" },
      { key: "status", label: "状态", type: "status" },
    ],
  },
  bills: {
    title: "往来账单",
    icon: FileText,
    fields: [
      { key: "no", label: "账单编号", required: true },
      { key: "counterparty", label: "客户 / 供应商", required: true },
      { key: "kind", label: "账单类型", type: "select", options: [["receivable", "应收"], ["payable", "应付"], ["depositReceived", "客户预收"], ["prepaymentPaid", "供应商预付"]] },
      { key: "amount", label: "账单金额", type: "number" },
      { key: "date", label: "业务日期", type: "date" },
      { key: "dueDate", label: "到期日期", type: "date" },
      { key: "status", label: "状态", type: "status" },
    ],
  },
  businessEvents: {
    title: "业务事件",
    icon: FileText,
    fields: [
      { key: "summary", label: "业务说明", required: true },
      { key: "type", label: "业务类型", type: "select", options: [["customerReceipt", "客户收款"], ["memberRecharge", "会员充值 / 预收"], ["memberConsumption", "会员耗课"], ["supplierSettlement", "供应商结算"], ["supplierPrepayment", "供应商预付"], ["purchaseExpense", "采购费用"], ["payroll", "工资社保"], ["rentAndProperty", "房租物业"], ["bankFee", "银行手续费"], ["loan", "借款还款"], ["employeeAdvance", "员工代垫"], ["relatedParty", "关联方往来"], ["refund", "退款"], ["internalTransfer", "内部转账"]] },
      { key: "counterparty", label: "相关方" },
      { key: "amount", label: "业务金额", type: "number" },
      { key: "date", label: "发生日期", type: "date" },
      { key: "businessPeriod", label: "业务期间", type: "month" },
      { key: "status", label: "状态", type: "status" },
    ],
  },
  invoices: {
    title: "发票",
    icon: FileText,
    fields: [
      { key: "no", label: "发票号码", required: true },
      { key: "seller", label: "销售方 / 开票方" },
      { key: "amount", label: "价税合计", type: "number" },
      { key: "taxAmount", label: "税额", type: "number" },
      { key: "status", label: "状态", type: "status" },
    ],
  },
  approvals: {
    title: "审批单",
    icon: Check,
    fields: [
      { key: "title", label: "审批事项", required: true },
      { key: "no", label: "审批编号" },
      { key: "kind", label: "类型", placeholder: "报销 / 付款 / 采购" },
      { key: "amount", label: "金额", type: "number" },
      { key: "status", label: "状态", type: "status" },
    ],
  },
  personnelRecords: {
    title: "人员资料",
    icon: UsersThree,
    fields: [
      { key: "name", label: "姓名", required: true },
      { key: "department", label: "部门 / 门店" },
      { key: "role", label: "岗位" },
      { key: "socialSecurityLocation", label: "社保归属" },
      { key: "status", label: "状态", type: "status" },
    ],
  },
  bankAccounts: {
    title: "银行账户",
    icon: Buildings,
    fields: [
      { key: "name", label: "账户名称", required: true },
      { key: "accountNumber", label: "账号后四位", placeholder: "8821" },
      { key: "openingBalance", label: "期初余额", type: "number" },
      { key: "statementClosing", label: "对账单期末余额", type: "number" },
      { key: "status", label: "状态", type: "status" },
    ],
    fromDraft: (draft) => ({ ...draft, currency: "CNY", sourceMode: "manual-import", externalConnection: "not_connected" }),
  },
};

function emptyDraft(config) {
  return Object.fromEntries(config.fields.map((field) => [field.key, field.type === "status" ? "active" : field.type === "select" ? field.options?.[0]?.[0] || "" : ""]));
}

function Field({ field, value, onChange }) {
  const common = { value: value ?? "", onChange: (event) => onChange(event.target.value), required: field.required };
  if (field.type === "status") return <select {...common}>{STATUS_OPTIONS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>;
  if (field.type === "select") return <select {...common}>{field.options.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>;
  return <input {...common} type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "month" ? "month" : "text"} step={field.type === "number" ? "0.01" : undefined} placeholder={field.placeholder || ""} />;
}

function displayName(item) {
  return item.name || item.title || item.no || item.summary || item.id;
}

function EntityEditor({ collection, onToast }) {
  const { activeWorkspace, actions } = useFinanceDesk();
  const config = useMemo(() => {
    const base = COLLECTION_CONFIG[collection];
    if (collection !== "users") return base;
    return {
      ...base,
      fields: base.fields.map((field) => field.key === "roleId"
        ? { ...field, options: activeWorkspace.roles.map((role) => [role.id, `${role.name}${role.status === "active" ? "" : "（停用）"}`]) }
        : field),
    };
  }, [collection, activeWorkspace.roles]);
  const Icon = config.icon;
  const items = activeWorkspace[collection] || [];
  const [draft, setDraft] = useState(() => emptyDraft(config));
  const [error, setError] = useState("");

  useEffect(() => setDraft(emptyDraft(config)), [activeWorkspace.id, collection, config]);

  function edit(item) {
    setDraft(config.toDraft ? config.toDraft(item) : { ...item });
    setError("");
  }

  function save(event) {
    event.preventDefault();
    setError("");
    try {
      const normalized = Object.fromEntries(Object.entries(draft).map(([key, value]) => {
        const field = config.fields.find((candidate) => candidate.key === key);
        return [key, field?.type === "number" ? Number(value || 0) : value];
      }));
      let values = config.fromDraft ? config.fromDraft(normalized) : normalized;
      if (collection === "users") {
        const role = activeWorkspace.roles.find((item) => item.id === values.roleId);
        if (!role || role.status !== "active") throw new Error("请选择一个有效角色");
        values = { ...values, role: role.name };
      }
      actions.upsertEntity(activeWorkspace.id, collection, values, { label: config.title });
      setDraft(emptyDraft(config));
      onToast?.(`${config.title}已保存`);
    } catch (caught) {
      setError(caught.message || "保存失败");
    }
  }

  function remove(item) {
    if (!window.confirm(`确定删除「${displayName(item)}」吗？`)) return;
    try {
      actions.removeEntity(activeWorkspace.id, collection, item.id, { label: config.title });
      if (draft.id === item.id) setDraft(emptyDraft(config));
      onToast?.(`${config.title}已删除`);
    } catch (caught) {
      setError(caught.message || "删除失败");
    }
  }

  return (
    <section className="foundation-section entity-editor">
      <div className="foundation-section-heading"><div><small>本地资料</small><h3><Icon size={18} />{config.title}</h3></div><span>{items.length} 条</span></div>
      <div className="foundation-record-list">
        {items.map((item) => (
          <article className="foundation-record" key={item.id}>
            <div><strong>{displayName(item)}</strong><small>{collection === "users" ? `${activeWorkspace.roles.find((role) => role.id === item.roleId)?.name || item.role || "未分配角色"} · ${item.status || "未设置状态"}` : item.status || item.kind || "未设置状态"}</small></div>
            <span className="foundation-record-actions"><button type="button" aria-label="编辑" onClick={() => edit(item)}><PencilSimple size={15} /></button><button type="button" aria-label="删除" onClick={() => remove(item)}><Trash size={15} /></button></span>
          </article>
        ))}
        {!items.length && <p className="foundation-empty">还没有记录。</p>}
      </div>
      <form className="entity-form" onSubmit={save}>
        {config.fields.map((field) => <label className="foundation-field" key={field.key}><span>{field.label}</span><Field field={field} value={draft[field.key]} onChange={(value) => setDraft((current) => ({ ...current, [field.key]: value }))} /></label>)}
        <div className="foundation-inline-actions"><button className="primary-button" type="submit"><Plus size={16} />{draft.id ? "保存修改" : "新增记录"}</button>{draft.id && <button className="secondary-button" type="button" onClick={() => setDraft(emptyDraft(config))}>取消编辑</button>}</div>
        {error && <p className="entity-error">{error}</p>}
      </form>
    </section>
  );
}

const PERMISSION_LABELS = {
  "workspace.manage": "管理工作台",
  "data.read": "查看数据",
  "data.write": "处理业务",
  "documents.add": "管理资料",
  "rules.manage": "管理规则",
  "confirm.finance": "财务确认",
  "confirm.owner": "负责人确认",
};

function LocalUserControl({ onToast }) {
  const { state, activeWorkspace, actions } = useFinanceDesk();
  const [error, setError] = useState("");
  const activeUsers = activeWorkspace.users.filter((user) => user.status === "active");
  const currentUser = activeUsers.find((user) => user.id === state.activeUserId) || activeUsers[0];
  const role = activeWorkspace.roles.find((item) => item.id === currentUser?.roleId || item.name === currentUser?.role);

  function switchUser(userId) {
    setError("");
    try {
      actions.switchUser(activeWorkspace.id, userId);
      const user = activeUsers.find((item) => item.id === userId);
      onToast?.(`当前本地操作身份已切换为「${user?.name || "未命名用户"}」`);
    } catch (caught) {
      setError(caught.message || "切换本地操作身份失败");
    }
  }

  return (
    <section className="foundation-section local-user-control">
      <div className="foundation-section-heading"><div><small>审计与最小权限</small><h3><UsersThree size={18} />当前本地操作身份</h3></div><span>{role?.name || "无有效角色"}</span></div>
      <label className="foundation-field"><span>以哪位人员操作</span><select value={currentUser?.id || ""} onChange={(event) => switchUser(event.target.value)} disabled={!activeUsers.length}>{activeUsers.map((user) => <option value={user.id} key={user.id}>{user.name} · {activeWorkspace.roles.find((item) => item.id === user.roleId)?.name || user.role || "未分配角色"}</option>)}</select></label>
      <div className="permission-chip-list">{(role?.permissions || []).map((permission) => <span key={permission}>{PERMISSION_LABELS[permission] || permission}</span>)}</div>
      <p className="foundation-hint">这是当前浏览器里的操作身份，用于真实权限拦截和审计归属；它不是联网登录或多因素认证。</p>
      {error && <p className="entity-error">{error}</p>}
    </section>
  );
}

function CompanyProfile({ onToast }) {
  const { activeWorkspace, actions } = useFinanceDesk();
  const [draft, setDraft] = useState(activeWorkspace.company);
  const [error, setError] = useState("");
  useEffect(() => setDraft(activeWorkspace.company), [activeWorkspace.id, activeWorkspace.company]);
  function save(event) {
    event.preventDefault();
    setError("");
    try {
      actions.updateCompanyProfile(activeWorkspace.id, draft);
      onToast?.("企业资料已保存在当前浏览器");
    } catch (caught) {
      setError(caught.message || "企业资料保存失败");
    }
  }
  return (
    <section className="foundation-section company-profile">
      <div className="foundation-section-heading"><div><small>企业初始化</small><h3><Buildings size={18} />企业主体</h3></div><span>{draft.verificationStatus === "verified" ? "已核验" : "本地录入"}</span></div>
      <form className="entity-form company-form" onSubmit={save}>
        {[
          ["legalName", "企业 / 个体户全称"], ["taxId", "统一社会信用代码"], ["ownerName", "法定代表人 / 经营者"], ["financeContact", "财务负责人"], ["industry", "行业"], ["taxpayerType", "纳税人类型"],
        ].map(([key, label]) => <label className="foundation-field" key={key}><span>{label}</span><input value={draft[key] || ""} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} /></label>)}
        <button className="primary-button" type="submit">保存企业资料</button>
        {error && <p className="entity-error">{error}</p>}
      </form>
    </section>
  );
}

function AuthorizationEditor({ onToast }) {
  const { activeWorkspace, actions } = useFinanceDesk();
  const [draft, setDraft] = useState({ system: "bank", label: "银行数据", scope: "本地文件导入", status: "recorded", grantedBy: "", expiresAt: "", proofDocumentId: "", note: "" });
  const [error, setError] = useState("");
  function save(event) {
    event.preventDefault();
    setError("");
    try {
      actions.recordAuthorization(activeWorkspace.id, draft, { label: "本地授权记录" });
      setDraft((current) => ({ ...current, note: "", proofDocumentId: "" }));
      onToast?.("授权范围、期限和凭证索引已保存；未建立任何外部连接");
    } catch (caught) {
      setError(caught.message || "授权记录保存失败");
    }
  }
  const effectiveStatus = (authorization) => authorization.status === "revoked"
    ? "已撤回"
    : authorization.expiresAt && Date.parse(authorization.expiresAt) <= Date.now()
      ? "已过期"
      : authorization.status === "not_connected"
        ? "未连接"
        : "有效记录";
  return (
    <section className="foundation-section">
      <div className="foundation-section-heading"><div><small>不连接外部系统</small><h3><ShieldCheck size={18} />本地授权记录</h3></div><span>{activeWorkspace.authorizations.length} 条</span></div>
      <div className="foundation-notice"><WarningCircle size={17} />此处只记录客户允许处理的范围，不会保存银行或税务密码，也不会连接银行、税务、AI 或 OCR。</div>
      <div className="foundation-record-list authorization-list">{activeWorkspace.authorizations.map((authorization) => <article className="foundation-record" key={authorization.id}><div><strong>{authorization.label || authorization.system}</strong><small>{effectiveStatus(authorization)} · {authorization.scope || "未填写范围"}{authorization.expiresAt ? ` · 至 ${String(authorization.expiresAt).slice(0, 10)}` : ""}</small></div></article>)}</div>
      <form className="entity-form" onSubmit={save}>
        <label className="foundation-field"><span>数据源</span><select value={draft.system} onChange={(event) => setDraft((current) => ({ ...current, system: event.target.value, label: event.target.selectedOptions[0].text }))}><option value="bank">银行数据</option><option value="tax">税务资料</option><option value="business">经营系统文件</option><option value="finance">现有财务软件文件</option></select></label>
        <label className="foundation-field"><span>允许范围</span><input value={draft.scope} onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value }))} /></label>
        <label className="foundation-field"><span>授权人</span><input value={draft.grantedBy} onChange={(event) => setDraft((current) => ({ ...current, grantedBy: event.target.value }))} placeholder="法定代表人 / 负责人" /></label>
        <label className="foundation-field"><span>有效期至（可选）</span><input type="date" value={draft.expiresAt} onChange={(event) => setDraft((current) => ({ ...current, expiresAt: event.target.value }))} /></label>
        <label className="foundation-field"><span>授权凭证（可选）</span><select value={draft.proofDocumentId} onChange={(event) => setDraft((current) => ({ ...current, proofDocumentId: event.target.value }))}><option value="">暂不关联</option>{activeWorkspace.documents.map((document) => <option value={document.id} key={document.id}>{document.name}</option>)}</select></label>
        <label className="foundation-field"><span>授权状态</span><select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))}><option value="recorded">有效记录</option><option value="revoked">已撤回</option></select></label>
        <label className="foundation-field"><span>授权说明</span><input value={draft.note} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} placeholder="谁在何时允许处理哪些本地文件" /></label>
        <button className="primary-button" type="submit">记录本地授权</button>
        {error && <p className="entity-error">{error}</p>}
      </form>
    </section>
  );
}

function StageStatusControl({ stage, onToast }) {
  const { activeWorkspace, actions } = useFinanceDesk();
  const [error, setError] = useState("");
  const value = activeWorkspace.stages[stage]?.status || "not_started";
  return (
    <div className="stage-status-control"><span>阶段状态</span><select value={value} onChange={(event) => { setError(""); try { actions.setStageStatus(activeWorkspace.id, stage, event.target.value); onToast?.(`${stage.toUpperCase()} 状态已更新`); } catch (caught) { setError(caught.message || "阶段状态更新失败"); } }}><option value="not_started">未开始</option><option value="draft">草稿</option><option value="collecting">资料收集中</option><option value="in_progress">进行中</option><option value="needs_review">待复核</option><option value="complete">已完成</option></select>{error && <small className="entity-error">{error}</small>}</div>
  );
}

export function FoundationRecordsPanel({ initialStage = "s0", onToast }) {
  const { activeWorkspace } = useFinanceDesk();
  const [stage, setStage] = useState(initialStage);
  const body = useMemo(() => {
    if (stage === "s0") return <div className="foundation-grid"><LocalUserControl onToast={onToast} /><CompanyProfile onToast={onToast} /><EntityEditor collection="books" onToast={onToast} /><EntityEditor collection="stores" onToast={onToast} /><EntityEditor collection="users" onToast={onToast} /><EntityEditor collection="roles" onToast={onToast} /><AuthorizationEditor onToast={onToast} /></div>;
    if (stage === "s1") return <div className="foundation-grid"><EntityEditor collection="ruleSets" onToast={onToast} /></div>;
    if (stage === "s2") return <div className="foundation-grid"><EntityEditor collection="counterparties" onToast={onToast} /><EntityEditor collection="contracts" onToast={onToast} /><EntityEditor collection="bills" onToast={onToast} /><EntityEditor collection="businessEvents" onToast={onToast} /><DocumentIntakePanel defaultCategory="合同" onToast={onToast} /></div>;
    if (stage === "s3") return <div className="foundation-grid"><EntityEditor collection="bankAccounts" onToast={onToast} /><BankImportPanel onToast={onToast} /></div>;
    return <div className="foundation-grid"><EntityEditor collection="invoices" onToast={onToast} /><EntityEditor collection="approvals" onToast={onToast} /><EntityEditor collection="personnelRecords" onToast={onToast} /><DocumentIntakePanel defaultCategory="人员资料" onToast={onToast} /></div>;
  }, [stage, activeWorkspace.id, onToast]);

  return (
    <div className="page-content foundation-page">
      <section className="foundation-page-heading">
        <div><p className="eyebrow">S0–S4 本地数据入口</p><h2>企业、规则、合同、流水与组织资料</h2><p>每一项修改都会保存在当前工作台并写入操作审计；不同工作台的数据互相隔离。</p></div>
        <StageStatusControl stage={stage} onToast={onToast} />
      </section>
      <nav className="foundation-stage-tabs" aria-label="基础资料阶段">{STAGES.map((item) => <button className={stage === item.id ? "active" : ""} key={item.id} type="button" onClick={() => setStage(item.id)}>{item.label}</button>)}</nav>
      {body}
    </div>
  );
}
