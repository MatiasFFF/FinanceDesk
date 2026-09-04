import { useEffect, useMemo, useState } from "react";
import {
  Buildings,
  Check,
  FileText,
  PencilSimple,
  Plus,
  Power,
  ShieldCheck,
  Trash,
  UsersThree,
  WarningCircle,
} from "@phosphor-icons/react";

import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import {
  ACCOUNT_CATEGORIES,
  accountingRules,
  activeAccountingRuleSet,
  saveActiveAccountingRuleSet,
  setWorkspaceAccountStatus,
  upsertWorkspaceAccount,
  workspaceAccountDefinitions,
} from "../../domain/accounting/model.js";
import { BankImportPanel } from "../intake/BankImportPanel.jsx";
import { DocumentIntakePanel } from "../intake/DocumentIntakePanel.jsx";
import "./foundation-ui.css";

const STAGES = [
  { id: "s0", label: "S0 企业与权限" },
  { id: "s1", label: "S1 账务规则" },
  { id: "s2", label: "S2 往来与合同" },
  { id: "s3", label: "S3 银行流水" },
  { id: "s4", label: "S4 发票与组织" },
  { id: "documents", label: "本地资料库" },
];

const STATUS_OPTIONS = [
  ["draft", "草稿"],
  ["active", "已启用"],
  ["pending", "待处理"],
  ["missing", "资料缺失"],
  ["inactive", "已停用"],
  ["archived", "已归档"],
];

const STATUS_LABELS = Object.freeze({
  ...Object.fromEntries(STATUS_OPTIONS),
  recorded: "已记录",
  revoked: "已撤回",
  not_connected: "未连接",
  verified: "已核验",
  verified_locally: "本地已核验",
  confirmed: "已确认",
  approved: "已批准",
  rejected: "已拒绝",
  complete: "已完成",
  posted: "已入账",
  open: "待处理",
  partial: "部分完成",
  paid: "已结清",
  overdue: "已逾期",
});

function statusLabel(status) {
  return STATUS_LABELS[status] || status || "未设置状态";
}

const RECORD_TYPE_LABELS = Object.freeze({
  customer: "客户",
  supplier: "供应商",
  related_party: "关联方",
  platform: "业务平台",
  receivable: "客户应收",
  payable: "供应商应付",
  depositReceived: "客户预收",
  prepaymentPaid: "供应商预付",
  customerReceipt: "客户收款",
  memberRecharge: "会员充值 / 预收",
  memberConsumption: "会员耗课",
  supplierSettlement: "供应商结算",
  supplierPrepayment: "供应商预付",
  purchaseExpense: "采购费用",
  payroll: "工资社保",
  rentAndProperty: "房租物业",
  bankFee: "银行手续费",
  loan: "借款还款",
  loanBorrowing: "取得借款",
  loanRepayment: "归还借款",
  employeeAdvance: "员工代垫",
  relatedParty: "关联方往来",
  refund: "退款",
  internalTransfer: "内部转账",
  recharge: "会员充值",
  consumption: "会员耗课",
  commission: "教练提成",
  commissionPayment: "提成付款",
});

function recordTypeLabel(item) {
  const type = item.businessType || item.type || item.kind;
  return item.businessTypeLabel || RECORD_TYPE_LABELS[type] || type || "";
}

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

const MEMBER_BUSINESS_EVENT_TYPES = new Set([
  "memberRecharge",
  "memberConsumption",
  "recharge",
  "consumption",
  "commission",
  "commissionPayment",
  "coachCommission",
  "coachCommissionPayment",
]);

function moduleSettingEnabled(value) {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object" && "enabled" in value) return value.enabled !== false;
  return value !== false;
}

function memberModuleEnabled(workspace) {
  const modules = workspace.modules;
  const currentSetting = modules?.members ?? modules?.member;
  if (currentSetting != null) return moduleSettingEnabled(currentSetting);

  const settings = workspace.moduleSettings;
  const explicitSetting = settings?.members ?? settings?.member;
  if (explicitSetting != null) return moduleSettingEnabled(explicitSetting);

  const enabled = workspace.enabledModules;
  if (Array.isArray(enabled)) {
    return enabled.some((item) => {
      const id = typeof item === "string" ? item : item?.id;
      return ["members", "member"].includes(id) && moduleSettingEnabled(item);
    });
  }
  if (enabled && typeof enabled === "object") {
    const explicit = enabled.members ?? enabled.member;
    return explicit == null ? false : moduleSettingEnabled(explicit);
  }
  return true;
}

function isMemberBusinessEvent(item) {
  return MEMBER_BUSINESS_EVENT_TYPES.has(item.businessType || item.type || item.kind || item.eventType);
}

function emptyDraft(config) {
  return Object.fromEntries(config.fields.map((field) => [field.key, field.type === "status" ? "active" : field.type === "select" ? field.options?.[0]?.[0] || "" : ""]));
}

function Field({ field, value, onChange }) {
  const common = { value: value ?? "", onChange: (event) => onChange(event.target.value), required: field.required };
  if (field.type === "status") return <select {...common}>{STATUS_OPTIONS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>;
  if (field.type === "select") return <select {...common}>{field.options.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>;
  return <input {...common} type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "month" ? "month" : "text"} step={field.type === "number" ? "0.01" : undefined} placeholder={field.placeholder || ""} />;
}

function displayName(item, collection, fallbackLabel = "记录") {
  if (collection === "businessEvents") {
    const type = recordTypeLabel(item) || "业务事件";
    const subject = item.summary || item.accountingLabel || item.memberName || item.counterparty || item.coach || "";
    return subject && subject !== type ? `${type} · ${subject}` : type;
  }
  if (collection === "bills") {
    return item.no || item.summary || [recordTypeLabel(item), item.counterparty].filter(Boolean).join(" · ") || "往来账单";
  }
  return item.name || item.title || item.no || item.summary || item.invoiceNumber || `未命名${fallbackLabel}`;
}

function amountSummary(label, value) {
  if (value == null || value === "") return "";
  return `${label} ¥${Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function recordDescription(item, collection, workspace) {
  const parts = [];
  if (collection === "books") {
    parts.push(item.accountingStandard || "会计准则未填写", item.currency ? `本位币 ${item.currency}` : "本位币未填写");
  } else if (collection === "stores") {
    parts.push(item.address || "地址未填写");
  } else if (collection === "users") {
    parts.push(workspace.roles.find((role) => role.id === item.roleId)?.name || item.role || "未分配角色");
  } else if (collection === "roles") {
    parts.push(`${(item.permissions || []).length} 项权限`);
  } else if (collection === "counterparties") {
    parts.push(recordTypeLabel(item) || "往来单位", item.taxId ? `税号 ${item.taxId}` : "税号未填写");
  } else if (collection === "contracts") {
    parts.push(item.no ? `合同号 ${item.no}` : "合同号未填写", item.counterpartyName ? `签约方 ${item.counterpartyName}` : "签约方未填写", amountSummary("合同金额", item.amount));
  } else if (collection === "bills") {
    parts.push(recordTypeLabel(item) || "往来账单", item.counterparty || "往来方未填写", amountSummary("账单金额", item.amount), item.date ? `业务日 ${item.date}` : "", item.dueDate ? `到期日 ${item.dueDate}` : "");
  } else if (collection === "businessEvents") {
    parts.push(recordTypeLabel(item) || "业务事件", item.businessPeriod ? `业务期间 ${item.businessPeriod}` : "", item.date ? `发生日 ${item.date}` : "", amountSummary("业务金额", item.amount));
  } else if (collection === "bankAccounts") {
    parts.push(item.accountNumber || item.number ? `账号 ${item.accountNumber || item.number}` : "账号未填写", amountSummary("期初余额", item.openingBalance), amountSummary("对账单期末", item.statementClosing));
  } else if (collection === "invoices") {
    parts.push(item.seller || item.sellerName ? `开票方 ${item.seller || item.sellerName}` : "开票方未填写", amountSummary("价税合计", item.amount), amountSummary("税额", item.taxAmount));
  } else if (collection === "approvals") {
    parts.push(recordTypeLabel(item) || item.kind || "审批事项", item.no ? `审批号 ${item.no}` : "", amountSummary("金额", item.amount));
  } else if (collection === "personnelRecords") {
    parts.push(item.department ? `部门 ${item.department}` : "部门未填写", item.role ? `岗位 ${item.role}` : "岗位未填写", item.socialSecurityLocation ? `社保归属 ${item.socialSecurityLocation}` : "");
  } else {
    parts.push(recordTypeLabel(item));
  }
  if (item.status) parts.push(statusLabel(item.status));
  return parts.filter(Boolean).join(" · ") || "未设置摘要";
}

function EntityEditor({ collection, onToast, pendingDeletion, onRequestDelete, onCancelDelete }) {
  const { activeWorkspace, actions } = useFinanceDesk();
  const membersEnabled = memberModuleEnabled(activeWorkspace);
  const hasActiveUsers = activeWorkspace.users.some((user) => user.status === "active");
  const config = useMemo(() => {
    const base = COLLECTION_CONFIG[collection];
    if (collection === "users") {
      const selectableRoles = hasActiveUsers
        ? activeWorkspace.roles
        : activeWorkspace.roles.filter((role) => (
          role.status === "active"
          && ((role.permissions || []).includes("*") || (role.permissions || []).includes("workspace.manage"))
        ));
      return {
        ...base,
        fields: base.fields.map((field) => field.key === "roleId"
          ? { ...field, options: selectableRoles.map((role) => [role.id, `${role.name}${role.status === "active" ? "" : "（停用）"}`]) }
          : field),
      };
    }
    if (collection === "businessEvents" && !membersEnabled) {
      return {
        ...base,
        fields: base.fields.map((field) => field.key === "type"
          ? { ...field, options: field.options.filter(([id]) => !MEMBER_BUSINESS_EVENT_TYPES.has(id)) }
          : field),
      };
    }
    return base;
  }, [collection, activeWorkspace.roles, activeWorkspace.modules, activeWorkspace.enabledModules, activeWorkspace.moduleSettings, hasActiveUsers, membersEnabled]);
  const Icon = config.icon;
  const items = collection === "businessEvents" && !membersEnabled
    ? (activeWorkspace[collection] || []).filter((item) => !isMemberBusinessEvent(item))
    : (activeWorkspace[collection] || []);
  const [draft, setDraft] = useState(() => emptyDraft(config));
  const [error, setError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const pendingDeleteId = pendingDeletion?.workspaceId === activeWorkspace.id && pendingDeletion?.collection === collection
    ? pendingDeletion.itemId
    : null;

  useEffect(() => {
    setDraft(emptyDraft(config));
    setError("");
    setDeleteError("");
    setEditorOpen(false);
  }, [activeWorkspace.id, collection, config]);

  useEffect(() => setDeleteError(""), [pendingDeleteId]);

  function create() {
    onCancelDelete();
    setDraft(emptyDraft(config));
    setError("");
    setEditorOpen(true);
  }

  function edit(item) {
    onCancelDelete();
    setDraft(config.toDraft ? config.toDraft(item) : { ...item });
    setError("");
    setEditorOpen(true);
  }

  function cancel() {
    onCancelDelete();
    setDraft(emptyDraft(config));
    setError("");
    setEditorOpen(false);
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
      if (collection === "businessEvents" && !membersEnabled && isMemberBusinessEvent(values)) {
        throw new Error("当前工作台未启用会员业务，不能新增会员充值、耗课或教练提成事件");
      }
      const savedItem = actions.upsertEntity(activeWorkspace.id, collection, values, { label: config.title });
      const becameFirstUser = collection === "users" && !hasActiveUsers && savedItem.status === "active";
      setDraft(emptyDraft(config));
      setEditorOpen(false);
      onToast?.(becameFirstUser ? `首位人员「${savedItem.name}」已保存并成为当前本地操作身份` : `${config.title}已保存`);
    } catch (caught) {
      setError(caught.message || "保存失败");
    }
  }

  function requestRemove(item) {
    setDeleteError("");
    onRequestDelete({ workspaceId: activeWorkspace.id, collection, itemId: item.id });
  }

  function cancelRemove() {
    setDeleteError("");
    onCancelDelete();
  }

  function remove(item) {
    try {
      actions.removeEntity(activeWorkspace.id, collection, item.id, { label: config.title });
      if (draft.id === item.id) cancel();
      setDeleteError("");
      onCancelDelete();
      onToast?.(`${config.title}已删除`);
    } catch (caught) {
      setDeleteError(caught.message || "删除失败");
    }
  }

  return (
    <section className="foundation-section entity-editor">
      <div className="foundation-section-heading"><div><small>{collection === "users" ? "可新增、改名、调整角色、停用或删除" : "本地资料"}</small><h3><Icon size={18} />{config.title}</h3></div><span>{items.length} 条</span></div>
      {collection === "users" && !hasActiveUsers && <p className="foundation-hint">当前没有启用人员。首位启用人员需选择具备“管理工作台”权限的启用角色；保存后会自动成为当前本地操作身份。</p>}
      {collection === "users" && items.some((item) => ["周会计", "林岚"].includes(item.name)) && <p className="foundation-hint">周会计、林岚只是当前模板的示例人员，可直接修改或删除；左下身份切换器会即时读取这里的有效人员。</p>}
      <div className="foundation-record-list">
        {items.map((item, index) => {
          const name = displayName(item, collection, config.title);
          const confirming = pendingDeleteId === item.id;
          const titleId = `${collection}-delete-title-${index}`;
          const descriptionId = `${collection}-delete-description-${index}`;
          return (
            <article className={`foundation-record${confirming ? " is-confirming-delete" : ""}`} key={item.id}>
              <div><strong>{name}</strong><small>{recordDescription(item, collection, activeWorkspace)}</small></div>
              <span className="foundation-record-actions"><button type="button" aria-label={`编辑${name}`} onClick={() => edit(item)}><PencilSimple size={15} /></button><button type="button" aria-label={`删除${name}`} aria-haspopup="dialog" aria-expanded={confirming} onClick={() => requestRemove(item)}><Trash size={15} /></button></span>
              {confirming && <div className="foundation-record-delete-confirm" role="alertdialog" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={(event) => { if (event.key === "Escape") cancelRemove(); }}>
                <p id={titleId}><WarningCircle size={16} /><strong>确认删除「{name}」？</strong></p>
                <small id={descriptionId}>删除后无法在本页面撤销，系统仍会执行原有的关联与权限检查。</small>
                <div className="foundation-inline-actions"><button className="secondary-button" type="button" autoFocus onClick={cancelRemove}>取消</button><button className="danger-button" type="button" aria-label={`确认删除${name}`} onClick={() => remove(item)}>确认删除</button></div>
                {deleteError && <p className="entity-error" role="alert">{deleteError}</p>}
              </div>}
            </article>
          );
        })}
        {!items.length && <p className="foundation-empty">还没有记录。</p>}
      </div>
      <button className="foundation-editor-toggle secondary-button" type="button" aria-expanded={editorOpen} aria-controls={`${collection}-editor`} onClick={create}><Plus size={16} />新增{config.title}</button>
      {editorOpen && <div className="foundation-editor-panel" id={`${collection}-editor`}>
        <div className="foundation-section-heading"><div><small>{draft.id ? "编辑现有记录" : "新增本地记录"}</small><h4>{draft.id ? `编辑「${displayName(draft, collection, config.title)}」` : `新增${config.title}`}</h4></div></div>
        <form className="entity-form" onSubmit={save}>
          {config.fields.map((field) => <label className="foundation-field" key={field.key}><span>{field.label}</span><Field field={field} value={draft[field.key]} onChange={(value) => setDraft((current) => ({ ...current, [field.key]: value }))} /></label>)}
          <div className="foundation-inline-actions"><button className="primary-button" type="submit"><Plus size={16} />{draft.id ? "保存修改" : "新增记录"}</button><button className="secondary-button" type="button" onClick={cancel}>取消</button></div>
          {error && <p className="entity-error">{error}</p>}
        </form>
      </div>}
      {error && !editorOpen && <p className="entity-error">{error}</p>}
    </section>
  );
}

function operationActor(state, workspace) {
  return workspace.users?.find((user) => user.id === state.activeUserId)?.name || "本地用户";
}

function emptyAccountDraft() {
  return { id: "", name: "", category: "expense", normalSide: "debit", cash: false };
}

function AccountCatalogEditor({ onToast }) {
  const { state, activeWorkspace, actions } = useFinanceDesk();
  const accounts = useMemo(() => workspaceAccountDefinitions(activeWorkspace), [activeWorkspace]);
  const [draft, setDraft] = useState(emptyAccountDraft);
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    setDraft(emptyAccountDraft());
    setError("");
    setEditorOpen(false);
  }, [activeWorkspace.id]);

  function create() {
    setDraft(emptyAccountDraft());
    setError("");
    setEditorOpen(true);
  }

  function edit(account) {
    setDraft({
      id: account.id,
      name: account.label,
      category: account.category,
      normalSide: account.normalSide,
      cash: Boolean(account.cash),
    });
    setError("");
    setEditorOpen(true);
  }

  function cancel() {
    setDraft(emptyAccountDraft());
    setError("");
    setEditorOpen(false);
  }

  function save(event) {
    event.preventDefault();
    setError("");
    try {
      const next = upsertWorkspaceAccount(activeWorkspace, draft, {
        actor: operationActor(state, activeWorkspace),
        mode: "manual",
      });
      actions.replaceWorkspace(activeWorkspace.id, next);
      setDraft(emptyAccountDraft());
      setEditorOpen(false);
      onToast?.(draft.id ? "科目修改已保存，并立即用于凭证、账簿和报表" : "新科目已保存到当前工作台");
    } catch (caught) {
      setError(caught.message || "科目保存失败");
    }
  }

  function toggleStatus(account) {
    setError("");
    try {
      const status = account.status === "inactive" ? "active" : "inactive";
      const next = setWorkspaceAccountStatus(activeWorkspace, { accountId: account.id, status }, {
        actor: operationActor(state, activeWorkspace),
        mode: "manual",
      });
      actions.replaceWorkspace(activeWorkspace.id, next);
      if (draft.id === account.id) cancel();
      onToast?.(`科目已${status === "inactive" ? "停用" : "启用"}；历史凭证仍保留当前名称`);
    } catch (caught) {
      setError(caught.message || "科目状态更新失败");
    }
  }

  return (
    <section className="foundation-section entity-editor">
      <div className="foundation-section-heading"><div><small>当前工作台科目表</small><h3><FileText size={18} />会计科目</h3></div><span>{accounts.filter((account) => account.status !== "inactive").length} 个已启用</span></div>
      <div className="foundation-record-list">
        {accounts.map((account) => {
          const categoryLabel = ACCOUNT_CATEGORIES.find((item) => item.id === account.category)?.label || "其他";
          return (
          <article className="foundation-record" key={account.id}>
            <div className="foundation-record-main">
              <strong>{account.label}</strong>
              <div className="foundation-record-business-meta"><span>{categoryLabel}</span><span>{account.normalSide === "credit" ? "贷方余额" : "借方余额"}</span><span>{account.cash ? "现金类科目" : "非现金类科目"}</span></div>
            </div>
            <span className="foundation-record-actions">
              <small className="foundation-record-status">{statusLabel(account.status)}</small>
              <button type="button" aria-label={`编辑${account.label}`} onClick={() => edit(account)}><PencilSimple size={15} /></button>
              <button type="button" aria-label={`${account.status === "inactive" ? "启用" : "停用"}${account.label}`} title={account.status === "inactive" ? "启用科目" : "停用科目"} onClick={() => toggleStatus(account)}><Power size={15} /></button>
            </span>
          </article>
          );
        })}
        {!accounts.length && <p className="foundation-empty">还没有会计科目。</p>}
      </div>
      <button className="foundation-editor-toggle secondary-button" type="button" aria-expanded={editorOpen} aria-controls="account-catalog-editor" onClick={create}><Plus size={16} />新增科目</button>
      {editorOpen && <div className="foundation-editor-panel" id="account-catalog-editor">
        <div className="foundation-section-heading"><div><small>{draft.id ? "编辑现有科目" : "新增会计科目"}</small><h4>{draft.id ? `编辑「${draft.name}」` : "新增科目"}</h4></div></div>
        <form className="entity-form" onSubmit={save}>
          {draft.id && <label className="foundation-field"><span>科目编码</span><input value={draft.id} readOnly /></label>}
          <label className="foundation-field"><span>科目名称</span><input required value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如：主营业务收入" /></label>
          <label className="foundation-field"><span>科目类别</span><select value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))}>{ACCOUNT_CATEGORIES.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
          <label className="foundation-field"><span>余额方向</span><select value={draft.normalSide} onChange={(event) => setDraft((current) => ({ ...current, normalSide: event.target.value }))}><option value="debit">借方</option><option value="credit">贷方</option></select></label>
          <label className="foundation-field"><span>现金类科目</span><select value={String(draft.cash)} onChange={(event) => setDraft((current) => ({ ...current, cash: event.target.value === "true" }))}><option value="false">否</option><option value="true">是</option></select></label>
          <div className="foundation-inline-actions"><button className="primary-button" type="submit"><Plus size={16} />{draft.id ? "保存科目修改" : "新增科目"}</button><button className="secondary-button" type="button" onClick={cancel}>取消</button></div>
          {error && <p className="entity-error">{error}</p>}
        </form>
      </div>}
      {error && !editorOpen && <p className="entity-error">{error}</p>}
    </section>
  );
}

function ruleDraft(workspace) {
  const rules = accountingRules(workspace);
  const active = activeAccountingRuleSet(workspace);
  return {
    name: active?.name || "当前账务规则",
    confidenceThreshold: rules.confidenceThreshold,
    automaticPostingThreshold: rules.automaticPostingThreshold,
    amountTolerance: rules.amountTolerance,
    requireEvidenceForExpenses: rules.requireEvidenceForExpenses,
    allowOverAllocation: rules.allowOverAllocation,
  };
}

function AccountingRuleEditor({ onToast }) {
  const { state, activeWorkspace, actions } = useFinanceDesk();
  const active = activeAccountingRuleSet(activeWorkspace);
  const effective = accountingRules(activeWorkspace);
  const [draft, setDraft] = useState(() => ruleDraft(activeWorkspace));
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    setDraft(ruleDraft(activeWorkspace));
    setError("");
    setEditorOpen(false);
  }, [activeWorkspace.id, active?.updatedAt]);

  function edit() {
    setDraft(ruleDraft(activeWorkspace));
    setError("");
    setEditorOpen(true);
  }

  function cancel() {
    setDraft(ruleDraft(activeWorkspace));
    setError("");
    setEditorOpen(false);
  }

  function save(event) {
    event.preventDefault();
    setError("");
    try {
      const next = saveActiveAccountingRuleSet(activeWorkspace, draft, {
        actor: operationActor(state, activeWorkspace),
        mode: "manual",
      });
      actions.replaceWorkspace(activeWorkspace.id, next);
      setEditorOpen(false);
      onToast?.("当前有效账务规则已保存并立即生效");
    } catch (caught) {
      setError(caught.message || "账务规则保存失败");
    }
  }

  return (
    <section className="foundation-section entity-editor">
      <div className="foundation-section-heading"><div><small>当前有效规则集</small><h3><ShieldCheck size={18} />账务规则</h3></div><span>{active?.name || "使用默认值"}</span></div>
      <div className="foundation-summary-grid">
        <article className="foundation-summary-card"><small>判断阈值</small><h4>人工复核 {effective.confidenceThreshold}</h4><p>自动建议 {effective.automaticPostingThreshold}</p></article>
        <article className="foundation-summary-card"><small>金额控制</small><h4>容差 ¥{effective.amountTolerance}</h4><p>超额核销：{effective.allowOverAllocation ? "允许" : "禁止"}</p></article>
        <article className="foundation-summary-card"><small>费用凭证要求</small><h4>{effective.requireEvidenceForExpenses ? "必须提供证据" : "不强制提供证据"}</h4><p>规则保存后立即用于当前工作台</p></article>
      </div>
      <div className="foundation-notice"><WarningCircle size={17} />自动建议阈值只决定是否形成自动处理建议；系统仍遵守现有复核与入账门槛，不会自动入账。</div>
      <button className="foundation-editor-toggle secondary-button" type="button" aria-expanded={editorOpen} aria-controls="accounting-rule-editor" onClick={edit}><PencilSimple size={16} />编辑规则</button>
      {editorOpen && <div className="foundation-editor-panel" id="accounting-rule-editor">
        <div className="foundation-section-heading"><div><small>编辑当前有效规则集</small><h4>{draft.name}</h4></div></div>
        <form className="entity-form" onSubmit={save}>
          <label className="foundation-field"><span>规则名称</span><input required value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
          <label className="foundation-field"><span>人工复核阈值（0–100）</span><input required type="number" min="0" max="100" step="1" value={draft.confidenceThreshold} onChange={(event) => setDraft((current) => ({ ...current, confidenceThreshold: event.target.value }))} /></label>
          <label className="foundation-field"><span>自动建议阈值（0–100）</span><input required type="number" min="0" max="100" step="1" value={draft.automaticPostingThreshold} onChange={(event) => setDraft((current) => ({ ...current, automaticPostingThreshold: event.target.value }))} /></label>
          <label className="foundation-field"><span>金额容差</span><input required type="number" min="0" step="0.01" value={draft.amountTolerance} onChange={(event) => setDraft((current) => ({ ...current, amountTolerance: event.target.value }))} /></label>
          <label className="foundation-field"><span>费用必须有证据</span><select value={String(draft.requireEvidenceForExpenses)} onChange={(event) => setDraft((current) => ({ ...current, requireEvidenceForExpenses: event.target.value === "true" }))}><option value="true">是</option><option value="false">否</option></select></label>
          <label className="foundation-field"><span>允许超额核销</span><select value={String(draft.allowOverAllocation)} onChange={(event) => setDraft((current) => ({ ...current, allowOverAllocation: event.target.value === "true" }))}><option value="false">禁止</option><option value="true">允许</option></select></label>
          <div className="foundation-inline-actions"><button className="primary-button" type="submit">保存并启用规则</button><button className="secondary-button" type="button" onClick={cancel}>取消</button></div>
          {error && <p className="entity-error">{error}</p>}
        </form>
      </div>}
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

function CompanyProfile({ onToast, onBeginEditing }) {
  const { activeWorkspace, actions } = useFinanceDesk();
  const [draft, setDraft] = useState(activeWorkspace.company);
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  useEffect(() => {
    setDraft(activeWorkspace.company);
    setError("");
    setEditorOpen(false);
  }, [activeWorkspace.id]);

  function edit() {
    onBeginEditing();
    setDraft(activeWorkspace.company);
    setError("");
    setEditorOpen(true);
  }

  function cancel() {
    setDraft(activeWorkspace.company);
    setError("");
    setEditorOpen(false);
  }

  function save(event) {
    event.preventDefault();
    setError("");
    try {
      actions.updateCompanyProfile(activeWorkspace.id, draft);
      setEditorOpen(false);
      onToast?.("企业资料已保存在当前浏览器");
    } catch (caught) {
      setError(caught.message || "企业资料保存失败");
    }
  }
  return (
    <section className="foundation-section company-profile">
      <div className="foundation-section-heading"><div><small>企业初始化</small><h3><Buildings size={18} />企业主体</h3></div><span>{activeWorkspace.company.verificationStatus === "verified" ? "已核验" : "本地录入"}</span></div>
      <div className="foundation-summary-grid">
        <article className="foundation-summary-card"><small>企业身份</small><h4>{activeWorkspace.company.legalName || "未填写主体名称"}</h4><p>统一社会信用代码：{activeWorkspace.company.taxId || "未填写"}</p></article>
        <article className="foundation-summary-card"><small>负责人</small><h4>{activeWorkspace.company.ownerName || "未填写经营者"}</h4><p>财务负责人：{activeWorkspace.company.financeContact || "未填写"}</p></article>
        <article className="foundation-summary-card"><small>企业属性</small><h4>{activeWorkspace.company.industry || "未填写行业"}</h4><p>纳税人类型：{activeWorkspace.company.taxpayerType || "未填写"}</p></article>
      </div>
      <button className="foundation-editor-toggle secondary-button" type="button" aria-expanded={editorOpen} aria-controls="company-profile-editor" onClick={edit}><PencilSimple size={16} />编辑企业资料</button>
      {editorOpen && <div className="foundation-editor-panel" id="company-profile-editor">
        <div className="foundation-section-heading"><div><small>编辑企业主体</small><h4>{draft.legalName || "企业资料"}</h4></div></div>
        <form className="entity-form company-form" onSubmit={save}>
          {[
            ["legalName", "企业 / 个体户全称"], ["taxId", "统一社会信用代码"], ["ownerName", "法定代表人 / 经营者"], ["financeContact", "财务负责人"], ["industry", "行业"], ["taxpayerType", "纳税人类型"],
          ].map(([key, label]) => <label className="foundation-field" key={key}><span>{label}</span><input value={draft[key] || ""} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} /></label>)}
          <div className="foundation-inline-actions"><button className="primary-button" type="submit">保存企业资料</button><button className="secondary-button" type="button" onClick={cancel}>取消</button></div>
          {error && <p className="entity-error">{error}</p>}
        </form>
      </div>}
    </section>
  );
}

function emptyAuthorizationDraft() {
  return { system: "bank", label: "银行数据", scope: "本地文件导入", status: "recorded", grantedBy: "", expiresAt: "", proofDocumentId: "", note: "" };
}

function AuthorizationEditor({ onToast, onBeginEditing }) {
  const { activeWorkspace, actions } = useFinanceDesk();
  const [draft, setDraft] = useState(emptyAuthorizationDraft);
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    setDraft(emptyAuthorizationDraft());
    setError("");
    setEditorOpen(false);
  }, [activeWorkspace.id]);

  function create() {
    onBeginEditing();
    setDraft(emptyAuthorizationDraft());
    setError("");
    setEditorOpen(true);
  }

  function edit(authorization) {
    onBeginEditing();
    setDraft({
      ...emptyAuthorizationDraft(),
      ...authorization,
      status: authorization.status === "revoked" ? "revoked" : "recorded",
      expiresAt: authorization.expiresAt ? String(authorization.expiresAt).slice(0, 10) : "",
      proofDocumentId: authorization.proofDocumentId || "",
    });
    setError("");
    setEditorOpen(true);
  }

  function cancel() {
    setDraft(emptyAuthorizationDraft());
    setError("");
    setEditorOpen(false);
  }

  function save(event) {
    event.preventDefault();
    setError("");
    try {
      const editing = Boolean(draft.id);
      actions.recordAuthorization(activeWorkspace.id, draft, { label: "本地授权记录" });
      setDraft(emptyAuthorizationDraft());
      setEditorOpen(false);
      onToast?.(editing ? "授权记录已更新；未建立任何外部连接" : "授权范围、期限和凭证索引已保存；未建立任何外部连接");
    } catch (caught) {
      setError(caught.message || "授权记录保存失败");
    }
  }

  function revoke(authorization) {
    setError("");
    try {
      actions.recordAuthorization(activeWorkspace.id, { ...authorization, status: "revoked" }, {
        label: "本地授权记录",
        detail: `${authorization.label || authorization.system || "数据源"}：授权已撤回`,
      });
      if (draft.id === authorization.id) cancel();
      onToast?.(`「${authorization.label || authorization.system}」授权记录已撤回`);
    } catch (caught) {
      setError(caught.message || "撤回授权失败");
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
      <div className="foundation-record-list authorization-list">
        {activeWorkspace.authorizations.map((authorization) => <article className="foundation-record" key={authorization.id}><div><strong>{authorization.label || authorization.system}</strong><small>{effectiveStatus(authorization)} · {authorization.scope || "未填写范围"}{authorization.expiresAt ? ` · 至 ${String(authorization.expiresAt).slice(0, 10)}` : ""}</small></div><span className="foundation-record-actions"><button type="button" aria-label={`编辑${authorization.label || authorization.system}授权`} onClick={() => edit(authorization)}><PencilSimple size={15} /></button>{authorization.status !== "revoked" && <button type="button" aria-label={`撤回${authorization.label || authorization.system}授权`} title="撤回授权" onClick={() => revoke(authorization)}><Power size={15} /></button>}</span></article>)}
        {!activeWorkspace.authorizations.length && <p className="foundation-empty">还没有本地授权记录。</p>}
      </div>
      <button className="foundation-editor-toggle secondary-button" type="button" aria-expanded={editorOpen} aria-controls="authorization-editor" onClick={create}><Plus size={16} />新增授权记录</button>
      {editorOpen && <div className="foundation-editor-panel" id="authorization-editor">
        <div className="foundation-section-heading"><div><small>{draft.id ? "编辑本地授权" : "新增本地授权"}</small><h4>{draft.id ? `编辑「${draft.label || draft.system}」` : "记录可处理的数据范围"}</h4></div></div>
        <form className="entity-form" onSubmit={save}>
          <label className="foundation-field"><span>数据源</span><select value={draft.system} onChange={(event) => setDraft((current) => ({ ...current, system: event.target.value, label: event.target.selectedOptions[0].text }))}><option value="bank">银行数据</option><option value="tax">税务资料</option><option value="business">经营系统文件</option><option value="finance">现有财务软件文件</option></select></label>
          <label className="foundation-field"><span>允许范围</span><input value={draft.scope} onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value }))} /></label>
          <label className="foundation-field"><span>授权人</span><input value={draft.grantedBy} onChange={(event) => setDraft((current) => ({ ...current, grantedBy: event.target.value }))} placeholder="法定代表人 / 负责人" /></label>
          <label className="foundation-field"><span>有效期至（可选）</span><input type="date" value={draft.expiresAt} onChange={(event) => setDraft((current) => ({ ...current, expiresAt: event.target.value }))} /></label>
          <label className="foundation-field"><span>授权凭证（可选）</span><select value={draft.proofDocumentId} onChange={(event) => setDraft((current) => ({ ...current, proofDocumentId: event.target.value }))}><option value="">暂不关联</option>{activeWorkspace.documents.map((document) => <option value={document.id} key={document.id}>{document.name}</option>)}</select></label>
          <label className="foundation-field"><span>授权状态</span><select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))}><option value="recorded">有效记录</option><option value="revoked">已撤回</option></select></label>
          <label className="foundation-field"><span>授权说明</span><input value={draft.note} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} placeholder="谁在何时允许处理哪些本地文件" /></label>
          <div className="foundation-inline-actions"><button className="primary-button" type="submit">{draft.id ? "保存授权修改" : "记录本地授权"}</button><button className="secondary-button" type="button" onClick={cancel}>取消</button></div>
          {error && <p className="entity-error">{error}</p>}
        </form>
      </div>}
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
  const [pendingDeletion, setPendingDeletion] = useState(null);

  useEffect(() => setPendingDeletion(null), [stage, activeWorkspace.id]);

  const body = useMemo(() => {
    const entityEditor = (collection) => <EntityEditor
      collection={collection}
      key={collection}
      onToast={onToast}
      pendingDeletion={pendingDeletion}
      onRequestDelete={setPendingDeletion}
      onCancelDelete={() => setPendingDeletion(null)}
    />;
    if (stage === "documents") return <div className="foundation-grid"><DocumentIntakePanel defaultCategory="其他资料" onToast={onToast} /></div>;
    if (stage === "s0") return <div className="foundation-grid"><LocalUserControl onToast={onToast} /><CompanyProfile onToast={onToast} onBeginEditing={() => setPendingDeletion(null)} />{entityEditor("books")}{entityEditor("stores")}{entityEditor("users")}{entityEditor("roles")}<AuthorizationEditor onToast={onToast} onBeginEditing={() => setPendingDeletion(null)} /></div>;
    if (stage === "s1") return <div className="foundation-grid"><AccountCatalogEditor onToast={onToast} /><AccountingRuleEditor onToast={onToast} /></div>;
    if (stage === "s2") return <div className="foundation-grid">{entityEditor("counterparties")}{entityEditor("contracts")}{entityEditor("bills")}{entityEditor("businessEvents")}<DocumentIntakePanel defaultCategory="合同" onToast={onToast} /></div>;
    if (stage === "s3") return <div className="foundation-grid">{entityEditor("bankAccounts")}<BankImportPanel onToast={onToast} /></div>;
    return <div className="foundation-grid">{entityEditor("invoices")}{entityEditor("approvals")}{entityEditor("personnelRecords")}<DocumentIntakePanel defaultCategory="人员资料" onToast={onToast} /></div>;
  }, [stage, activeWorkspace.id, onToast, pendingDeletion]);

  return (
    <div className="page-content foundation-page">
      <section className="foundation-page-heading">
        <div><p className="eyebrow">S0–S4 与本地资料库</p><h2>企业、规则、业务数据与原文件</h2><p>每一项修改都会保存在当前工作台并写入操作审计；不同工作台的数据与原文件互相隔离。</p></div>
        {stage !== "documents" && <StageStatusControl stage={stage} onToast={onToast} />}
      </section>
      <nav className="foundation-stage-tabs" aria-label="基础资料阶段">{STAGES.map((item) => <button className={stage === item.id ? "active" : ""} key={item.id} type="button" onClick={() => setStage(item.id)}>{item.label}</button>)}</nav>
      {body}
    </div>
  );
}
