import { useEffect, useMemo, useRef, useState } from "react";
import {
  Buildings,
  CaretDown,
  CaretUp,
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
  CATEGORY_RULE_BUSINESS_TYPES,
  accountDefinition,
  accountingRules,
  activeAccountingRuleSet,
  categoryKeywordRules,
  saveActiveAccountingRuleSet,
  setWorkspaceAccountStatus,
  upsertWorkspaceAccount,
  workspaceAccountDefinitions,
} from "../../domain/accounting/model.js";
import {
  DEFAULT_WORKSPACE_TERMINOLOGY,
  MANAGEMENT_REPORT_DISPLAY_ITEMS,
  managementReportDefaultLabel,
  normalizeManagementReportConfig,
  normalizeWorkspaceTerminology,
} from "../../domain/foundation.js";
import { BankImportPanel } from "../intake/BankImportPanel.jsx";
import { DocumentIntakePanel } from "../intake/DocumentIntakePanel.jsx";
import "./foundation-ui.css";

const STAGES = [
  { id: "s0", label: "企业资料" },
  { id: "s1", label: "账务规则" },
  { id: "s2", label: "往来与合同" },
  { id: "s3", label: "银行流水" },
  { id: "s4", label: "发票与人员" },
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
  departed: "离职",
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

const PERMISSION_OPTIONS = [
  ["workspace.manage", "管理工作台", "管理工作台、人员与角色"],
  ["data.read", "查看数据", "查看当前工作台中的业务数据"],
  ["data.write", "处理业务", "新增和修改业务记录"],
  ["documents.add", "管理资料", "上传、关联和管理本地资料"],
  ["rules.manage", "管理规则", "调整当前工作台的账务规则"],
  ["confirm.finance", "财务确认", "执行财务复核与确认"],
  ["confirm.owner", "负责人确认", "执行负责人最终确认"],
  ["*", "全部权限", "拥有当前工作台的全部操作权限"],
];

const PERMISSION_LABELS = Object.fromEntries(PERMISSION_OPTIONS.map(([id, label]) => [id, label]));

const TERMINOLOGY_FIELDS = Object.freeze([
  { key: "customer", label: "客户称呼" },
  { key: "supplier", label: "供应商称呼" },
  { key: "personnel", label: "员工称呼" },
  { key: "location", label: "场所称呼" },
  { key: "member", label: "会员称呼", memberOnly: true },
  { key: "coach", label: "教练称呼", memberOnly: true },
  { key: "service", label: "服务称呼" },
]);

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

const TERMINOLOGY_TOKEN_KEYS = Object.freeze({
  客户: "customer",
  供应商: "supplier",
  员工: "personnel",
  门店: "location",
  会员: "member",
  教练: "coach",
  服务: "service",
});

function localizeTerminologyText(value, terminology) {
  if (typeof value !== "string") return value;
  return value.replace(/客户|供应商|员工|门店|会员|教练|服务/g, (token) => terminology[TERMINOLOGY_TOKEN_KEYS[token]] || token);
}

function localizedRecordTypeLabels(terminology) {
  return {
    ...Object.fromEntries(Object.entries(RECORD_TYPE_LABELS).map(([id, label]) => [id, localizeTerminologyText(label, terminology)])),
    memberConsumption: `${terminology.member}${terminology.service}核销`,
    consumption: `${terminology.member}${terminology.service}核销`,
    commission: `${terminology.coach}提成`,
    commissionPayment: `${terminology.coach}提成付款`,
  };
}

function recordTypeLabel(item, terminology) {
  const type = item.businessType || item.type || item.kind;
  return localizedRecordTypeLabels(terminology)[type] || item.businessTypeLabel || type || "";
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
      { key: "status", label: "状态", type: "select", options: [["active", "已启用"], ["inactive", "已停用"]] },
    ],
  },
  roles: {
    title: "角色",
    icon: ShieldCheck,
    fields: [
      { key: "name", label: "角色名称", required: true },
      { key: "permissions", label: "权限", type: "permissions" },
      { key: "status", label: "状态", type: "status" },
    ],
    fromDraft: (draft) => {
      const next = { ...draft, permissions: [...new Set(Array.isArray(draft.permissions) ? draft.permissions : [])] };
      delete next.permissionsText;
      return next;
    },
    toDraft: (item) => {
      const next = { ...item, permissions: [...new Set(item.permissions || [])] };
      delete next.permissionsText;
      return next;
    },
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
      { key: "userId", label: "关联操作用户", type: "select", options: [] },
      { key: "status", label: "状态", type: "status", options: [...STATUS_OPTIONS, ["departed", "离职"]] },
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

function localizedCollectionConfig(collection, terminology) {
  const base = COLLECTION_CONFIG[collection];
  const titles = {
    stores: terminology.location,
    users: `${terminology.personnel}操作用户`,
    counterparties: `${terminology.customer}与${terminology.supplier}`,
    bills: `${terminology.customer}与${terminology.supplier}往来账单`,
    businessEvents: `${terminology.service}及其他业务事件`,
    personnelRecords: `${terminology.personnel}资料`,
  };
  const fieldLabels = {
    stores: { name: `${terminology.location}名称`, address: `${terminology.location}地址` },
    users: { name: `${terminology.personnel}姓名` },
    counterparties: { name: `${terminology.customer} / ${terminology.supplier}名称`, kind: `${terminology.customer} / ${terminology.supplier}类型` },
    contracts: { counterpartyName: `签约方（${terminology.customer} / ${terminology.supplier}）` },
    bills: { counterparty: `账单主体（${terminology.customer} / ${terminology.supplier}）` },
    businessEvents: { summary: `${terminology.service} / 业务说明`, counterparty: `相关方（${terminology.customer} / ${terminology.supplier}）` },
    personnelRecords: { name: `${terminology.personnel}姓名`, department: `部门 / ${terminology.location}`, role: `${terminology.personnel}岗位` },
  };
  const typeLabels = localizedRecordTypeLabels(terminology);
  return {
    ...base,
    title: titles[collection] || localizeTerminologyText(base.title, terminology),
    fields: base.fields.map((field) => ({
      ...field,
      label: fieldLabels[collection]?.[field.key] || localizeTerminologyText(field.label, terminology),
      placeholder: localizeTerminologyText(field.placeholder, terminology),
      ...(field.options ? { options: field.options.map(([id, label]) => [id, typeLabels[id] || localizeTerminologyText(label, terminology)]) } : {}),
    })),
  };
}

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
  return Object.fromEntries(config.fields.map((field) => [
    field.key,
    field.type === "status"
      ? "active"
      : field.type === "select"
        ? field.options?.[0]?.[0] || ""
        : field.type === "permissions"
          ? []
          : "",
  ]));
}

function Field({ field, value, onChange }) {
  if (field.type === "permissions") {
    const selected = Array.isArray(value) ? value : [];
    const unknown = selected.filter((permission) => !PERMISSION_LABELS[permission]);
    return (
      <div className="permission-option-grid" role="group" aria-label={field.label}>
        {PERMISSION_OPTIONS.map(([permission, label, description]) => (
          <label className={`permission-option ${selected.includes(permission) ? "selected" : ""}`} key={permission}>
            <input
              type="checkbox"
              checked={selected.includes(permission)}
              onChange={(event) => onChange(event.target.checked
                ? [...new Set([...selected, permission])]
                : selected.filter((item) => item !== permission))}
            />
            <span><strong>{label}</strong><small>{description}</small></span>
          </label>
        ))}
        {unknown.length > 0 && (
          <div className="permission-unknown-list">
            <strong>保留的扩展权限</strong>
            <span>{unknown.map((permission) => <code key={permission}>{permission}</code>)}</span>
            <small>这些权限不是当前界面的内置选项，保存时会原样保留。</small>
          </div>
        )}
      </div>
    );
  }
  const common = { value: value ?? "", onChange: (event) => onChange(event.target.value), required: field.required };
  if (field.type === "status") return <select {...common}>{(field.options || STATUS_OPTIONS).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>;
  if (field.type === "select") return <select {...common}>{field.options.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>;
  return <input {...common} type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "month" ? "month" : "text"} step={field.type === "number" ? "0.01" : undefined} placeholder={field.placeholder || ""} />;
}

function displayName(item, collection, fallbackLabel = "记录", terminology = DEFAULT_WORKSPACE_TERMINOLOGY) {
  if (collection === "businessEvents") {
    const type = recordTypeLabel(item, terminology) || `${terminology.service}业务事件`;
    const subject = item.summary || item.accountingLabel || item.memberName || item.counterparty || item.coach || "";
    return subject && subject !== type ? `${type} · ${subject}` : type;
  }
  if (collection === "bills") {
    return item.no || item.summary || [recordTypeLabel(item, terminology), item.counterparty].filter(Boolean).join(" · ") || `${terminology.customer}与${terminology.supplier}往来账单`;
  }
  return item.name || item.title || item.no || item.summary || item.invoiceNumber || `未命名${fallbackLabel}`;
}

function amountSummary(label, value) {
  if (value == null || value === "") return "";
  return `${label} ¥${Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function recordDescription(item, collection, workspace, terminology = DEFAULT_WORKSPACE_TERMINOLOGY) {
  const parts = [];
  if (collection === "books") {
    parts.push(item.accountingStandard || "会计准则未填写", item.currency ? `本位币 ${item.currency}` : "本位币未填写");
  } else if (collection === "stores") {
    parts.push(item.address || `${terminology.location}地址未填写`);
  } else if (collection === "users") {
    parts.push(workspace.roles.find((role) => role.id === item.roleId)?.name || item.role || "未分配角色");
    const personnel = workspace.personnelRecords.find((record) => record.id === item.personnelRecordId || record.userId === item.id);
    if (personnel) parts.push(`${terminology.personnel}资料 ${personnel.name}`);
  } else if (collection === "roles") {
    parts.push((item.permissions || []).map((permission) => PERMISSION_LABELS[permission] || `扩展权限 ${permission}`).join("、") || "未配置权限");
  } else if (collection === "counterparties") {
    parts.push(recordTypeLabel(item, terminology) || `${terminology.customer} / ${terminology.supplier}主体`, item.taxId ? `税号 ${item.taxId}` : "税号未填写");
  } else if (collection === "contracts") {
    parts.push(item.no ? `合同号 ${item.no}` : "合同号未填写", item.counterpartyName ? `签约方 ${item.counterpartyName}` : "签约方未填写", amountSummary("合同金额", item.amount));
  } else if (collection === "bills") {
    parts.push(recordTypeLabel(item, terminology) || "往来账单", item.counterparty || `${terminology.customer} / ${terminology.supplier}主体未填写`, amountSummary("账单金额", item.amount), item.date ? `业务日 ${item.date}` : "", item.dueDate ? `到期日 ${item.dueDate}` : "");
  } else if (collection === "businessEvents") {
    parts.push(recordTypeLabel(item, terminology) || "业务事件", item.businessPeriod ? `业务期间 ${item.businessPeriod}` : "", item.date ? `发生日 ${item.date}` : "", amountSummary("业务金额", item.amount));
  } else if (collection === "bankAccounts") {
    parts.push(item.accountNumber || item.number ? `账号 ${item.accountNumber || item.number}` : "账号未填写", amountSummary("期初余额", item.openingBalance), amountSummary("对账单期末", item.statementClosing));
  } else if (collection === "invoices") {
    parts.push(item.seller || item.sellerName ? `开票方 ${item.seller || item.sellerName}` : "开票方未填写", amountSummary("价税合计", item.amount), amountSummary("税额", item.taxAmount));
  } else if (collection === "approvals") {
    parts.push(recordTypeLabel(item, terminology) || item.kind || "审批事项", item.no ? `审批号 ${item.no}` : "", amountSummary("金额", item.amount));
  } else if (collection === "personnelRecords") {
    parts.push(item.department ? `归属 ${item.department}` : `部门 / ${terminology.location}未填写`, item.role ? `${terminology.personnel}岗位 ${item.role}` : `${terminology.personnel}岗位未填写`, item.socialSecurityLocation ? `社保归属 ${item.socialSecurityLocation}` : "");
    const user = workspace.users.find((candidate) => candidate.id === item.userId || candidate.personnelRecordId === item.id);
    parts.push(user ? `${terminology.personnel}操作用户 ${user.name}${user.status === "active" ? "" : "（已停用）"}` : `未关联${terminology.personnel}操作用户`);
  } else {
    parts.push(recordTypeLabel(item, terminology));
  }
  if (item.status) parts.push(statusLabel(item.status));
  return parts.filter(Boolean).join(" · ") || "未设置摘要";
}

function EntityEditor({ collection, onToast, pendingDeletion, onRequestDelete, onCancelDelete }) {
  const { activeWorkspace, actions } = useFinanceDesk();
  const membersEnabled = memberModuleEnabled(activeWorkspace);
  const isInitialUserSetup = !activeWorkspace.localUsersConfigured && activeWorkspace.users.length === 0;
  const terminology = useMemo(() => normalizeWorkspaceTerminology(activeWorkspace.terminology), [activeWorkspace.terminology]);
  const config = useMemo(() => {
    const base = localizedCollectionConfig(collection, terminology);
    if (collection === "users") {
      const activeRoles = activeWorkspace.roles.filter((role) => role.status === "active");
      const selectableRoles = isInitialUserSetup
        ? activeRoles.filter((role) => (
          (role.permissions || []).includes("*") || (role.permissions || []).includes("workspace.manage")
        ))
        : activeRoles;
      return {
        ...base,
        fields: base.fields.map((field) => field.key === "roleId"
          ? { ...field, options: selectableRoles.map((role) => [role.id, role.name]) }
          : field),
      };
    }
    if (collection === "personnelRecords") {
      return {
        ...base,
        fields: base.fields.map((field) => field.key === "userId"
          ? {
            ...field,
            options: [
              ["", "不关联操作用户"],
              ...activeWorkspace.users.map((user) => [user.id, `${user.name}${user.status === "active" ? "" : "（已停用）"}`]),
            ],
          }
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
  }, [collection, activeWorkspace.roles, activeWorkspace.users, activeWorkspace.modules, activeWorkspace.enabledModules, activeWorkspace.moduleSettings, isInitialUserSetup, membersEnabled, terminology]);
  const Icon = config.icon;
  const items = collection === "businessEvents" && !membersEnabled
    ? (activeWorkspace[collection] || []).filter((item) => !isMemberBusinessEvent(item))
    : (activeWorkspace[collection] || []);
  const [draft, setDraft] = useState(() => emptyDraft(config));
  const [error, setError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const draftContextRef = useRef({ workspaceId: activeWorkspace.id, collection });
  const pendingDeleteId = pendingDeletion?.workspaceId === activeWorkspace.id && pendingDeletion?.collection === collection
    ? pendingDeletion.itemId
    : null;

  useEffect(() => {
    const context = draftContextRef.current;
    if (context.workspaceId === activeWorkspace.id && context.collection === collection) return;
    draftContextRef.current = { workspaceId: activeWorkspace.id, collection };
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
    const nextDraft = config.toDraft ? config.toDraft(item) : { ...item };
    if (collection === "personnelRecords") {
      const linkedUser = activeWorkspace.users.find((user) => user.id === item.userId || user.personnelRecordId === item.id);
      nextDraft.userId = linkedUser?.id || "";
    }
    setDraft(nextDraft);
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
        throw new Error(`当前工作台未启用${terminology.member}业务，不能新增${terminology.member}充值、${terminology.service}核销或${terminology.coach}提成事件`);
      }
      const savedItem = actions.upsertEntity(activeWorkspace.id, collection, values, { label: config.title });
      const becameFirstUser = collection === "users" && isInitialUserSetup && savedItem.status === "active";
      setDraft(emptyDraft(config));
      setEditorOpen(false);
      onToast?.(becameFirstUser ? `首位${terminology.personnel}操作用户「${savedItem.name}」已保存并成为当前本地操作身份` : `${config.title}已保存`);
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

  function toggleUserStatus(user) {
    onCancelDelete();
    setError("");
    try {
      const nextStatus = user.status === "active" ? "inactive" : "active";
      const savedUser = actions.upsertEntity(activeWorkspace.id, "users", { ...user, status: nextStatus }, { label: config.title });
      if (draft.id === user.id) {
        setDraft(emptyDraft(config));
        setEditorOpen(false);
      }
      onToast?.(`${savedUser.name}已${nextStatus === "active" ? "启用，可从左侧切换" : "停用，不再出现在左侧切换列表"}`);
    } catch (caught) {
      setError(caught.message || `${user.name}状态更新失败`);
    }
  }

  function convertPersonnelToUser(personnel, roleId) {
    setError("");
    try {
      const role = activeWorkspace.roles.find((candidate) => candidate.id === roleId && candidate.status === "active");
      if (!role) throw new Error("请选择一个有效角色");
      actions.upsertEntity(activeWorkspace.id, "users", {
        name: personnel.name,
        roleId: role.id,
        role: role.name,
        status: "active",
        personnelRecordId: personnel.id,
      }, { label: `${terminology.personnel}操作用户` });
      onToast?.(`「${personnel.name}」已成为操作用户，角色为「${role.name}」${isInitialUserSetup ? "，并已切换为当前身份" : ""}`);
    } catch (caught) {
      setError(caught.message || "创建操作用户失败");
    }
  }

  const conversionRoles = activeWorkspace.roles.filter((role) => (
    role.status === "active"
    && (!isInitialUserSetup || (role.permissions || []).includes("*") || (role.permissions || []).includes("workspace.manage"))
  ));

  return (
    <section className={`foundation-section entity-editor foundation-entity-editor${collection === "users" ? " foundation-user-editor" : ""}${editorOpen ? " is-editing" : ""}`}>
      <div className="foundation-section-heading"><div><h3><Icon size={18} /><span>{config.title}</span></h3></div><span>{items.length} 条</span></div>
      {collection === "users" && isInitialUserSetup && <p className="foundation-hint">尚未配置操作用户。首位用户需选择具备“管理工作台”权限的启用角色；保存后会成为当前本地操作身份。</p>}
      {collection === "personnelRecords" && <p className="foundation-hint">关联后共用姓名。{terminology.personnel}停用或离职会停用关联本地用户；恢复权限需明确启用用户。</p>}
      <div className="foundation-record-list foundation-entity-record-list">
        {items.map((item, index) => {
          const name = displayName(item, collection, config.title, terminology);
          const linkedUser = collection === "personnelRecords"
            ? activeWorkspace.users.find((user) => user.id === item.userId || user.personnelRecordId === item.id)
            : null;
          const confirming = pendingDeleteId === item.id;
          const titleId = `${collection}-delete-title-${index}`;
          const descriptionId = `${collection}-delete-description-${index}`;
          return (
            <article className={`foundation-record foundation-entity-record${collection === "users" ? ` foundation-user-record${item.status === "active" ? "" : " is-inactive"}` : ""}${confirming ? " is-confirming-delete" : ""}`} key={item.id}>
              <div className="foundation-entity-record-copy"><strong>{name}</strong><small>{recordDescription(item, collection, activeWorkspace, terminology)}</small></div>
              <span className="foundation-record-actions foundation-entity-record-actions">
                {collection === "personnelRecords" && !linkedUser && <select className="compact-select" value="" aria-label={`将${name}设为操作用户`} disabled={!conversionRoles.length} onChange={(event) => event.target.value && convertPersonnelToUser(item, event.target.value)}><option value="">{conversionRoles.length ? "设为操作用户…" : "无可用角色"}</option>{conversionRoles.map((role) => <option value={role.id} key={role.id}>使用角色：{role.name}</option>)}</select>}
                {collection === "users" && <button className={`foundation-user-status-action ${item.status === "active" ? "is-stop" : "is-enable"}`} type="button" aria-label={`${item.status === "active" ? "停用" : "启用"}${name}`} title={item.status === "active" ? "停用后将从左侧切换列表移除" : "启用后可从左侧切换"} onClick={() => toggleUserStatus(item)}><Power size={14} /><span>{item.status === "active" ? "停用" : "启用"}</span></button>}
                <button type="button" aria-label={`编辑${name}`} onClick={() => edit(item)}><PencilSimple size={15} /></button><button type="button" aria-label={`删除${name}`} aria-haspopup="dialog" aria-expanded={confirming} onClick={() => requestRemove(item)}><Trash size={15} /></button>
              </span>
              {confirming && <div className="foundation-record-delete-confirm" role="alertdialog" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={(event) => { if (event.key === "Escape") cancelRemove(); }}>
                <p id={titleId}><WarningCircle size={16} /><strong>确认删除「{name}」？</strong></p>
                <small id={descriptionId}>删除后无法在本页面撤销，系统仍会执行原有的关联与权限检查。</small>
                <div className="foundation-inline-actions"><button className="secondary-button" type="button" autoFocus onClick={cancelRemove}>取消</button><button className="danger-button" type="button" aria-label={`确认删除${name}`} onClick={() => remove(item)}>确认删除</button></div>
                {deleteError && <p className="entity-error" role="alert">{deleteError}</p>}
              </div>}
            </article>
          );
        })}
        {!items.length && <p className="foundation-empty">还没有{config.title}。</p>}
      </div>
      <button className="foundation-editor-toggle secondary-button" type="button" aria-expanded={editorOpen} aria-controls={`${collection}-editor`} onClick={create}><Plus size={16} />新增{config.title}</button>
      {editorOpen && <div className="foundation-editor-panel foundation-entity-editor-panel" id={`${collection}-editor`}>
        <div className="foundation-section-heading foundation-entity-editor-heading"><div><h4>{draft.id ? `编辑「${displayName(draft, collection, config.title, terminology)}」` : `新增${config.title}`}</h4></div></div>
        <form className="entity-form foundation-entity-form" onSubmit={save}>
          {config.fields.map((field) => field.type === "permissions"
            ? <div className="foundation-field permission-field foundation-entity-field" key={field.key}><span>{field.label}</span><Field field={field} value={draft[field.key]} onChange={(value) => setDraft((current) => ({ ...current, [field.key]: value }))} /></div>
            : <label className="foundation-field foundation-entity-field" key={field.key}><span>{field.label}</span><Field field={field} value={draft[field.key]} onChange={(value) => setDraft((current) => ({ ...current, [field.key]: value }))} /></label>)}
          <div className="foundation-inline-actions foundation-entity-form-actions"><button className="primary-button" type="submit"><Plus size={16} />{draft.id ? "保存修改" : "新增记录"}</button><button className="secondary-button" type="button" onClick={cancel}>取消</button></div>
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
    <section className={`foundation-section entity-editor${editorOpen ? " is-editing" : ""}`}>
      <div className="foundation-section-heading"><div><h3><FileText size={18} />会计科目</h3></div><span>{accounts.filter((account) => account.status !== "inactive").length} 个已启用</span></div>
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
        <div className="foundation-section-heading"><div><h4>{draft.id ? `编辑「${draft.name}」` : "新增科目"}</h4></div></div>
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
    categoryKeywords: categoryKeywordRules(workspace),
  };
}

function nextCategoryRuleId(rules) {
  const maximum = (rules || []).reduce((current, rule) => {
    const match = /^category-rule-(\d+)$/.exec(String(rule.id || ""));
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `category-rule-${String(maximum + 1).padStart(4, "0")}`;
}

const CATEGORY_RULE_PREVIEW_LIMIT = 6;
const MEMBER_CATEGORY_RULE_LANGUAGE = /会员|私教|团课|教练|课包|耗课/;

function AccountingRuleEditor({ onToast }) {
  const { state, activeWorkspace, actions } = useFinanceDesk();
  const active = activeAccountingRuleSet(activeWorkspace);
  const effective = accountingRules(activeWorkspace);
  const membersEnabled = memberModuleEnabled(activeWorkspace);
  const terminology = useMemo(() => normalizeWorkspaceTerminology(activeWorkspace.terminology), [activeWorkspace.terminology]);
  const activeAccounts = useMemo(
    () => workspaceAccountDefinitions(activeWorkspace).filter((account) => account.status !== "inactive"),
    [activeWorkspace],
  );
  const businessTypes = useMemo(
    () => CATEGORY_RULE_BUSINESS_TYPES
      .filter((item) => membersEnabled || !item.memberOnly)
      .map((item) => ({ ...item, label: localizeTerminologyText(item.label, terminology) })),
    [membersEnabled, terminology],
  );
  const [draft, setDraft] = useState(() => ruleDraft(activeWorkspace));
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const categoryRulePreview = useMemo(() => {
    const invalidRuleIndexes = [];
    const eligibleRules = draft.categoryKeywords.flatMap((rule, index) => {
      if (!rule.enabled) return [];
      const businessDefinition = CATEGORY_RULE_BUSINESS_TYPES.find((item) => item.id === rule.businessType);
      const memberOnly = Boolean(businessDefinition?.memberOnly)
        || MEMBER_CATEGORY_RULE_LANGUAGE.test(`${rule.id || ""} ${rule.keyword || ""}`);
      if (!membersEnabled && memberOnly) return [];
      const keyword = String(rule.keyword || "").trim();
      if (!keyword) {
        invalidRuleIndexes.push(index);
        return [];
      }
      try {
        return [{ rule, index, expression: new RegExp(keyword, "i") }];
      } catch {
        invalidRuleIndexes.push(index);
        return [];
      }
    });
    let totalMatches = 0;
    const samples = [];
    (activeWorkspace.transactions || []).forEach((transaction) => {
      const text = `${transaction.counterparty || ""} ${transaction.summary || ""}`;
      const matched = eligibleRules.find(({ expression }) => expression.test(text));
      if (!matched) return;
      totalMatches += 1;
      if (samples.length >= CATEGORY_RULE_PREVIEW_LIMIT) return;
      const businessDefinition = CATEGORY_RULE_BUSINESS_TYPES.find((item) => item.id === matched.rule.businessType);
      const account = activeAccounts.find((item) => item.id === matched.rule.account);
      samples.push({
        transaction,
        rule: matched.rule,
        ruleIndex: matched.index,
        businessTypeLabel: localizeTerminologyText(businessDefinition?.label, terminology) || matched.rule.businessType || "未设置业务类型",
        accountLabel: account?.label || `${matched.rule.account || "未选择科目"}（不可用）`,
      });
    });
    return {
      eligibleRuleCount: eligibleRules.length,
      invalidRuleIndexes,
      samples,
      totalMatches,
      totalTransactions: (activeWorkspace.transactions || []).length,
    };
  }, [draft.categoryKeywords, activeWorkspace.transactions, activeAccounts, membersEnabled, terminology]);

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

  function updateCategoryRule(ruleId, patch) {
    setDraft((current) => ({
      ...current,
      categoryKeywords: current.categoryKeywords.map((rule) => rule.id === ruleId ? { ...rule, ...patch } : rule),
    }));
  }

  function addCategoryRule() {
    setDraft((current) => ({
      ...current,
      categoryKeywords: [
        ...current.categoryKeywords,
        {
          id: nextCategoryRuleId(current.categoryKeywords),
          keyword: "",
          businessType: businessTypes[0]?.id || "customerReceipt",
          account: activeAccounts[0]?.id || "",
          enabled: true,
        },
      ],
    }));
  }

  function removeCategoryRule(ruleId) {
    setDraft((current) => ({
      ...current,
      categoryKeywords: current.categoryKeywords.filter((rule) => rule.id !== ruleId),
    }));
  }

  function moveCategoryRule(ruleId, offset) {
    setDraft((current) => {
      const index = current.categoryKeywords.findIndex((rule) => rule.id === ruleId);
      const targetIndex = index + offset;
      if (index < 0 || targetIndex < 0 || targetIndex >= current.categoryKeywords.length) return current;
      const categoryKeywords = [...current.categoryKeywords];
      [categoryKeywords[index], categoryKeywords[targetIndex]] = [categoryKeywords[targetIndex], categoryKeywords[index]];
      return { ...current, categoryKeywords };
    });
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
    <section className={`foundation-section entity-editor${editorOpen ? " is-editing" : ""}`}>
      <div className="foundation-section-heading"><div><h3><ShieldCheck size={18} />账务规则</h3></div><span>{active?.name || "使用默认值"}</span></div>
      <div className="foundation-summary-grid">
        <article className="foundation-summary-card"><small>判断阈值</small><h4>人工复核 {effective.confidenceThreshold}</h4><p>自动建议 {effective.automaticPostingThreshold}</p></article>
        <article className="foundation-summary-card"><small>金额控制</small><h4>容差 ¥{effective.amountTolerance}</h4><p>超额核销：{effective.allowOverAllocation ? "允许" : "禁止"}</p></article>
        <article className="foundation-summary-card"><small>费用凭证要求</small><h4>{effective.requireEvidenceForExpenses ? "必须提供证据" : "不强制提供证据"}</h4><p>规则保存后立即用于当前工作台</p></article>
        <article className="foundation-summary-card"><small>关键词分类</small><h4>{categoryKeywordRules(activeWorkspace).filter((rule) => rule.enabled).length} 条启用</h4><p>共 {categoryKeywordRules(activeWorkspace).length} 条结构化规则</p></article>
      </div>
      <div className="foundation-notice"><WarningCircle size={17} />自动建议阈值只决定是否形成自动处理建议；系统仍遵守现有复核与入账门槛，不会自动入账。</div>
      <button className="foundation-editor-toggle secondary-button" type="button" aria-expanded={editorOpen} aria-controls="accounting-rule-editor" onClick={edit}><PencilSimple size={16} />编辑规则</button>
      {editorOpen && <div className="foundation-editor-panel" id="accounting-rule-editor">
        <div className="foundation-section-heading"><div><h4>编辑「{draft.name}」</h4></div></div>
        <form className="entity-form" onSubmit={save}>
          <label className="foundation-field"><span>规则名称</span><input required value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
          <label className="foundation-field"><span>人工复核阈值（0–100）</span><input required type="number" min="0" max="100" step="1" value={draft.confidenceThreshold} onChange={(event) => setDraft((current) => ({ ...current, confidenceThreshold: event.target.value }))} /></label>
          <label className="foundation-field"><span>自动建议阈值（0–100）</span><input required type="number" min="0" max="100" step="1" value={draft.automaticPostingThreshold} onChange={(event) => setDraft((current) => ({ ...current, automaticPostingThreshold: event.target.value }))} /></label>
          <label className="foundation-field"><span>金额容差</span><input required type="number" min="0" step="0.01" value={draft.amountTolerance} onChange={(event) => setDraft((current) => ({ ...current, amountTolerance: event.target.value }))} /></label>
          <label className="foundation-field"><span>费用必须有证据</span><select value={String(draft.requireEvidenceForExpenses)} onChange={(event) => setDraft((current) => ({ ...current, requireEvidenceForExpenses: event.target.value === "true" }))}><option value="true">是</option><option value="false">否</option></select></label>
          <label className="foundation-field"><span>允许超额核销</span><select value={String(draft.allowOverAllocation)} onChange={(event) => setDraft((current) => ({ ...current, allowOverAllocation: event.target.value === "true" }))}><option value="false">禁止</option><option value="true">允许</option></select></label>
          <div className="foundation-divider" />
          <div className="foundation-section-heading"><div><h4>关键词分类规则</h4><small>按列表顺序匹配流水摘要与交易对方</small></div><button className="secondary-button" type="button" onClick={addCategoryRule}><Plus size={16} />新增规则</button></div>
          <p className="foundation-hint">关键词支持用“|”表示任一关键词；目标科目只列出当前工作台已启用的科目。规则只形成分类建议，不会自动入账。</p>
          <div className="foundation-record-list category-rule-list">
            {draft.categoryKeywords.map((rule, index) => {
              const selectedBusinessType = CATEGORY_RULE_BUSINESS_TYPES.find((item) => item.id === rule.businessType);
              const businessTypeAvailable = businessTypes.some((item) => item.id === rule.businessType);
              const selectedAccount = activeAccounts.find((account) => account.id === rule.account);
              return (
                <article className="foundation-record category-rule-record" key={rule.id}>
                  <div className="entity-form category-rule-fields">
                    <label className="foundation-field"><span>关键词</span><input required value={rule.keyword} onChange={(event) => updateCategoryRule(rule.id, { keyword: event.target.value })} placeholder="例如：电费|国家电网" /></label>
                    {!businessTypeAvailable && selectedBusinessType
                      ? <label className="foundation-field"><span>业务类型</span><input value={`${localizeTerminologyText(selectedBusinessType.label, terminology)}（${terminology.member}模块已停用）`} readOnly /></label>
                      : <label className="foundation-field"><span>业务类型</span><select required value={rule.businessType} onChange={(event) => updateCategoryRule(rule.id, { businessType: event.target.value })}>{businessTypes.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>}
                    <label className="foundation-field"><span>目标有效科目</span><select required value={rule.account} onChange={(event) => updateCategoryRule(rule.id, { account: event.target.value })}>{!selectedAccount && rule.account && <option value={rule.account} disabled>{rule.account}（已停用或不存在）</option>}{activeAccounts.map((account) => <option value={account.id} key={account.id}>{account.label}</option>)}</select></label>
                    <label className="foundation-field"><span>状态</span><select value={String(rule.enabled)} onChange={(event) => updateCategoryRule(rule.id, { enabled: event.target.value === "true" })}><option value="true">启用</option><option value="false">停用</option></select></label>
                  </div>
                  <span className="foundation-record-actions category-rule-order-actions">
                    <small className="foundation-record-status">优先级 {index + 1}</small>
                    <button type="button" aria-label={`上移第 ${index + 1} 条分类规则`} title="提高优先级" disabled={index === 0} onClick={() => moveCategoryRule(rule.id, -1)}><CaretUp size={15} /></button>
                    <button type="button" aria-label={`下移第 ${index + 1} 条分类规则`} title="降低优先级" disabled={index === draft.categoryKeywords.length - 1} onClick={() => moveCategoryRule(rule.id, 1)}><CaretDown size={15} /></button>
                    <button type="button" aria-label={`删除第 ${index + 1} 条分类规则`} title="删除规则" onClick={() => removeCategoryRule(rule.id)}><Trash size={15} /></button>
                  </span>
                </article>
              );
            })}
            {!draft.categoryKeywords.length && <p className="foundation-empty">还没有关键词分类规则。</p>}
          </div>
          <section className="category-rule-preview" aria-live="polite">
            <div className="category-rule-preview-heading">
              <div><small>即时预览 · 当前工作台真实流水</small><h4>关键词命中结果</h4></div>
              <span>{categoryRulePreview.totalMatches} / {categoryRulePreview.totalTransactions} 条命中</span>
            </div>
            {categoryRulePreview.invalidRuleIndexes.length > 0 && <p className="category-rule-preview-warning">规则 {categoryRulePreview.invalidRuleIndexes.map((index) => index + 1).join("、")} 的关键词为空或表达式无效，当前未参与预览。</p>}
            {categoryRulePreview.totalTransactions === 0
              ? <p className="foundation-empty">当前工作台还没有真实银行流水，暂时无法预览命中结果。</p>
              : categoryRulePreview.eligibleRuleCount === 0
                ? <p className="foundation-empty">当前没有可参与预览的启用规则；停用规则和已关闭模块的{terminology.member}规则不会参与。</p>
                : categoryRulePreview.totalMatches === 0
                  ? <p className="foundation-empty">当前工作台流水没有命中任何启用规则。</p>
                  : <div className="category-rule-preview-list">
                    {categoryRulePreview.samples.map(({ transaction, rule, ruleIndex, businessTypeLabel, accountLabel }, sampleIndex) => {
                      const amount = Number(transaction.amount);
                      const amountLabel = Number.isFinite(amount)
                        ? `${amount >= 0 ? "+" : "-"}¥${Math.abs(amount).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : "金额未填写";
                      return (
                        <article className="category-rule-preview-item" key={`${transaction.id || "transaction"}-${sampleIndex}`}>
                          <div className="category-rule-preview-transaction">
                            <span><strong>{transaction.counterparty || "未填写交易对方"}</strong><small>{transaction.summary || "无流水摘要"}</small></span>
                            <span><small>{transaction.date || "日期未填写"}</small><strong className={amount >= 0 ? "income" : "expense"}>{amountLabel}</strong></span>
                          </div>
                          <dl className="category-rule-preview-meta">
                            <div><dt>命中规则</dt><dd>优先级 {ruleIndex + 1} · {rule.keyword}</dd></div>
                            <div><dt>业务类型</dt><dd>{businessTypeLabel}</dd></div>
                            <div><dt>目标科目</dt><dd>{accountLabel}</dd></div>
                          </dl>
                        </article>
                      );
                    })}
                    {categoryRulePreview.totalMatches > categoryRulePreview.samples.length && <p className="foundation-hint">仅展示前 {CATEGORY_RULE_PREVIEW_LIMIT} 条，共命中 {categoryRulePreview.totalMatches} 条真实流水。</p>}
                  </div>}
          </section>
          <div className="foundation-inline-actions"><button className="primary-button" type="submit">保存并启用规则</button><button className="secondary-button" type="button" onClick={cancel}>取消</button></div>
          {error && <p className="entity-error">{error}</p>}
        </form>
      </div>}
    </section>
  );
}

function LocalUserControl({ onToast }) {
  const { state, activeWorkspace, actions } = useFinanceDesk();
  const terminology = useMemo(() => normalizeWorkspaceTerminology(activeWorkspace.terminology), [activeWorkspace.terminology]);
  const [error, setError] = useState("");
  const activeUsers = activeWorkspace.users.filter((user) => user.status === "active");
  const isInitialUserSetup = !activeWorkspace.localUsersConfigured && activeWorkspace.users.length === 0;
  const roleForUser = (user) => activeWorkspace.roles.find((item) => (
    item.status === "active" && (item.id === user?.roleId || item.name === user?.role)
  ));
  const switchableUsers = activeUsers.filter((user) => roleForUser(user));
  const unavailableUsers = activeUsers.filter((user) => !roleForUser(user));
  const currentUser = switchableUsers.find((user) => user.id === state.activeUserId);
  const role = roleForUser(currentUser);

  function switchUser(userId) {
    setError("");
    try {
      actions.switchUser(activeWorkspace.id, userId);
      const user = switchableUsers.find((item) => item.id === userId);
      onToast?.(`当前本地操作身份已切换为「${user?.name || "未命名用户"}」`);
    } catch (caught) {
      setError(caught.message || "切换本地操作身份失败");
    }
  }

  return (
    <section className="foundation-section local-user-control">
      <div className="foundation-section-heading"><h3>操作身份</h3></div>
      <label className="foundation-field"><span>操作人</span><select value={currentUser?.id || ""} onChange={(event) => switchUser(event.target.value)} disabled={!switchableUsers.length}>{!currentUser && <option value="" disabled>{switchableUsers.length ? "请选择操作身份" : isInitialUserSetup ? "尚未配置操作身份" : "暂无可用操作身份"}</option>}{switchableUsers.map((user) => <option value={user.id} key={user.id}>{user.name} · {roleForUser(user)?.name || "未分配角色"}</option>)}</select></label>
      <div className="permission-chip-list">{(role?.permissions || []).map((permission) => <span key={permission}>{PERMISSION_LABELS[permission] || permission}</span>)}</div>
      {unavailableUsers.length > 0 && <p className="foundation-hint">{unavailableUsers.map((user) => user.name).join("、")} 的角色已停用或不存在；请先在“{terminology.personnel}操作用户”中改为启用角色。</p>}
      {error && <p className="entity-error">{error}</p>}
    </section>
  );
}

function TerminologyEditor({ onToast }) {
  const { activeWorkspace, actions } = useFinanceDesk();
  const membersEnabled = memberModuleEnabled(activeWorkspace);
  const savedTerminology = JSON.stringify(normalizeWorkspaceTerminology(activeWorkspace.terminology));
  const [draft, setDraft] = useState(() => normalizeWorkspaceTerminology(activeWorkspace.terminology));
  const [error, setError] = useState("");
  const visibleFields = TERMINOLOGY_FIELDS.filter((field) => membersEnabled || !field.memberOnly);

  useEffect(() => {
    setDraft(JSON.parse(savedTerminology));
    setError("");
  }, [activeWorkspace.id, savedTerminology]);

  function save(event) {
    event.preventDefault();
    setError("");
    try {
      const terminology = normalizeWorkspaceTerminology(draft);
      actions.replaceWorkspace(activeWorkspace.id, { ...activeWorkspace, terminology }, {
        requiredPermission: "workspace.manage",
        audit: {
          action: "更新业务术语",
          detail: TERMINOLOGY_FIELDS.map((field) => `${field.label}「${terminology[field.key]}」`).join("；"),
          objectType: "terminology",
          objectId: activeWorkspace.id,
        },
      });
      setDraft(terminology);
      onToast?.("业务术语已保存在当前工作台");
    } catch (caught) {
      setError(caught.message || "业务术语保存失败");
    }
  }

  return (
    <section className="foundation-section foundation-terminology-editor" data-unsaved-changes={JSON.stringify(draft) !== savedTerminology || undefined}>
      <div className="foundation-section-heading"><div><h3>业务术语</h3></div><span>{visibleFields.length} 项可编辑</span></div>
      <form className="foundation-terminology-form" onSubmit={save}>
        <div className="foundation-terminology-grid">
          {visibleFields.map((field) => <label className="foundation-field foundation-terminology-field" key={field.key}><span>{field.label}</span><input value={draft[field.key] || ""} placeholder={DEFAULT_WORKSPACE_TERMINOLOGY[field.key]} onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))} /></label>)}
        </div>
        <p className="foundation-hint">留空保存会恢复默认称呼。{!membersEnabled && "会员模块未启用，会员与教练称呼会保留，启用模块后再显示。"}</p>
        <div className="foundation-inline-actions foundation-terminology-actions"><button className="primary-button" type="submit">保存业务术语</button></div>
        {error && <p className="entity-error">{error}</p>}
      </form>
    </section>
  );
}

function ManagementReportDisplayEditor({ onToast }) {
  const { activeWorkspace, actions } = useFinanceDesk();
  const savedDisplayConfig = JSON.stringify(normalizeManagementReportConfig(activeWorkspace.managementReport));
  const memberBusiness = memberModuleEnabled(activeWorkspace);
  const terminology = normalizeWorkspaceTerminology(activeWorkspace.terminology);
  const [draft, setDraft] = useState(() => normalizeManagementReportConfig(activeWorkspace.managementReport));
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(JSON.parse(savedDisplayConfig));
    setError("");
  }, [activeWorkspace.id, savedDisplayConfig]);

  function updateItem(itemId, patch) {
    setDraft((current) => ({
      ...current,
      displayItems: current.displayItems.map((item) => item.id === itemId ? { ...item, ...patch } : item),
    }));
  }

  function save(event) {
    event.preventDefault();
    setError("");
    try {
      const managementReport = normalizeManagementReportConfig(draft);
      const visibleCount = managementReport.displayItems.filter((item) => item.visible).length;
      const renamedCount = managementReport.displayItems.filter((item) => item.label).length;
      actions.replaceWorkspace(activeWorkspace.id, { ...activeWorkspace, managementReport }, {
        requiredPermission: "workspace.manage",
        audit: {
          action: "更新管理报表显示项",
          detail: `显示 ${visibleCount} 项；自定义名称 ${renamedCount} 项；未修改计算公式与来源`,
          objectType: "managementReport",
          objectId: activeWorkspace.id,
        },
      });
      setDraft(managementReport);
      onToast?.(visibleCount === 0
        ? "管理报表显示项已保存；报表将显示空状态"
        : "管理报表显示项已保存在当前工作台");
    } catch (caught) {
      setError(caught.message || "管理报表显示项保存失败");
    }
  }

  function restoreDefault() {
    setError("");
    try {
      const managementReport = normalizeManagementReportConfig();
      actions.replaceWorkspace(activeWorkspace.id, { ...activeWorkspace, managementReport }, {
        requiredPermission: "workspace.manage",
        audit: {
          action: "恢复管理报表默认显示项",
          detail: `恢复默认显示 ${managementReport.displayItems.length} 项并清除自定义名称；未修改计算公式与来源`,
          objectType: "managementReport",
          objectId: activeWorkspace.id,
        },
      });
      setDraft(managementReport);
      onToast?.("管理报表显示项已恢复默认并保存在当前工作台");
    } catch (caught) {
      setError(caught.message || "恢复管理报表默认显示项失败");
    }
  }

  const visibleCount = draft.displayItems.filter((item) => item.visible).length;
  const itemById = new Map(draft.displayItems.map((item) => [item.id, item]));

  return (
    <section className="foundation-section management-report-display-editor" data-unsaved-changes={JSON.stringify(draft) !== savedDisplayConfig || undefined}>
      <div className="foundation-section-heading"><div><h3>管理报表显示项</h3></div><span>{visibleCount} / {MANAGEMENT_REPORT_DISPLAY_ITEMS.length} 项显示</span></div>
      <form className="management-report-display-form" onSubmit={save}>
        <p className="foundation-hint">这里只控制老板报表中的显示与名称；金额、计算公式、来源明细和下钻关系保持原样。</p>
        <div className="management-report-display-grid">
          {MANAGEMENT_REPORT_DISPLAY_ITEMS.map((definition) => {
            const item = itemById.get(definition.id);
            const rawDefaultLabel = definition.accountId
              ? accountDefinition(definition.accountId, activeWorkspace).label
              : managementReportDefaultLabel(definition, { memberBusiness });
            const defaultLabel = localizeTerminologyText(rawDefaultLabel, terminology);
            return (
              <article className={`management-report-display-item ${item?.visible ? "" : "is-hidden"}`} key={definition.id}>
                <label className="management-report-display-toggle">
                  <input type="checkbox" checked={item?.visible !== false} onChange={(event) => updateItem(definition.id, { visible: event.target.checked })} />
                  <span><strong>{defaultLabel}</strong><small>{item?.visible ? "报表中显示" : "报表中隐藏"}</small></span>
                </label>
                <label className="foundation-field"><span>自定义显示名称</span><input value={item?.label || ""} onChange={(event) => updateItem(definition.id, { label: event.target.value })} placeholder={`默认：${defaultLabel}`} /></label>
              </article>
            );
          })}
        </div>
        {visibleCount === 0 && <p className="foundation-notice management-report-empty-notice" role="status"><WarningCircle size={17} /><span>当前已隐藏全部指标。保存会成功，管理报表将显示空状态；这不是保存失败。可随时恢复默认显示项。</span></p>}
        <div className="foundation-inline-actions wrap management-report-display-actions"><button className="secondary-button" type="button" onClick={restoreDefault}>恢复默认显示项</button><button className="primary-button" type="submit">保存管理报表显示项</button></div>
        {error && <p className="entity-error">{error}</p>}
      </form>
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
    if (editorOpen) return;
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
    <section className={`foundation-section company-profile${editorOpen ? " is-editing" : ""}`}>
      <div className="foundation-section-heading"><div><h3><Buildings size={18} />{editorOpen ? "编辑企业资料" : "企业资料"}</h3>{activeWorkspace.company.verificationStatus === "verified" && <small>已核验</small>}</div>{!editorOpen && <button className="secondary-button" type="button" aria-expanded={editorOpen} aria-controls="company-profile-editor" onClick={edit}><PencilSimple size={16} />编辑企业资料</button>}</div>
      {!editorOpen && <div className="foundation-summary-grid">
        <article className="foundation-summary-card"><small>企业身份</small><h4>{activeWorkspace.company.legalName || "未填写主体名称"}</h4><p>统一社会信用代码：{activeWorkspace.company.taxId || "未填写"}</p></article>
        <article className="foundation-summary-card"><small>负责人</small><h4>{activeWorkspace.company.ownerName || "未填写经营者"}</h4><p>财务负责人：{activeWorkspace.company.financeContact || "未填写"}</p></article>
        <article className="foundation-summary-card"><small>企业属性</small><h4>{activeWorkspace.company.industry || "未填写行业"}</h4><p>纳税人类型：{activeWorkspace.company.taxpayerType || "未填写"}</p></article>
      </div>}
      {editorOpen && <div className="foundation-editor-panel" id="company-profile-editor">
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
  const terminology = useMemo(() => normalizeWorkspaceTerminology(activeWorkspace.terminology), [activeWorkspace.terminology]);
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
    <section className={`foundation-section authorization-editor${editorOpen ? " is-editing" : ""}`}>
      <div className="foundation-section-heading"><div><h3>本地授权记录</h3></div><span>{activeWorkspace.authorizations.length} 条</span></div>
      <div className="foundation-notice"><WarningCircle size={17} />此处只记录{terminology.customer}允许处理的范围，不会保存银行或税务密码，也不会连接银行、税务、AI 或 OCR。</div>
      <div className="foundation-record-list authorization-list">
        {activeWorkspace.authorizations.map((authorization) => <article className="foundation-record" key={authorization.id}><div><strong>{authorization.label || authorization.system}</strong><small>{effectiveStatus(authorization)} · {authorization.scope || "未填写范围"}{authorization.expiresAt ? ` · 至 ${String(authorization.expiresAt).slice(0, 10)}` : ""}</small></div><span className="foundation-record-actions"><button type="button" aria-label={`编辑${authorization.label || authorization.system}授权`} onClick={() => edit(authorization)}><PencilSimple size={15} /></button>{authorization.status !== "revoked" && <button type="button" aria-label={`撤回${authorization.label || authorization.system}授权`} title="撤回授权" onClick={() => revoke(authorization)}><Power size={15} /></button>}</span></article>)}
        {!activeWorkspace.authorizations.length && <p className="foundation-empty">还没有本地授权记录。</p>}
      </div>
      <button className="foundation-editor-toggle secondary-button" type="button" aria-expanded={editorOpen} aria-controls="authorization-editor" onClick={create}><Plus size={16} />新增授权记录</button>
      {editorOpen && <div className="foundation-editor-panel" id="authorization-editor">
        <div className="foundation-section-heading"><div><h4>{draft.id ? `编辑「${draft.label || draft.system}」` : "记录可处理的数据范围"}</h4></div></div>
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
  const stageLabel = STAGES.find((item) => item.id === stage)?.label || "资料";
  return (
    <div className="stage-status-control"><span>资料进度</span><select aria-label={`${stageLabel}进度`} value={value} onChange={(event) => { setError(""); try { actions.setStageStatus(activeWorkspace.id, stage, event.target.value); onToast?.(`${stageLabel}进度已更新`); } catch (caught) { setError(caught.message || "资料进度更新失败"); } }}><option value="not_started">未开始</option><option value="draft">草稿</option><option value="collecting">资料收集中</option><option value="in_progress">进行中</option><option value="needs_review">待复核</option><option value="complete">已完成</option></select>{error && <small className="entity-error">{error}</small>}</div>
  );
}

export function FoundationRecordsPanel({ initialStage = "s0", onToast, onNavigate }) {
  const { activeWorkspace } = useFinanceDesk();
  const [stage, setStage] = useState(initialStage);
  const [visitedStages, setVisitedStages] = useState([initialStage]);
  const [documentSection, setDocumentSection] = useState("files");
  const [pendingDeletion, setPendingDeletion] = useState(null);
  const [navigationNotice, setNavigationNotice] = useState("");
  const pageRef = useRef(null);

  useEffect(() => setPendingDeletion(null), [stage, activeWorkspace.id]);

  function navigateStage(nextStage) {
    setNavigationNotice("");
    setVisitedStages((current) => current.includes(nextStage) ? current : [...current, nextStage]);
    setStage(nextStage);
  }

  function navigatePage(page) {
    const pending = pageRef.current?.querySelector('.is-editing, [data-unsaved-changes="true"], .bank-import-file-workspace, .bank-import-panel [aria-label="取消当前结算文件"]');
    if (pending) {
      const pendingStage = pending.closest(".foundation-stage-panel")?.dataset.foundationStage;
      if (pendingStage) navigateStage(pendingStage);
      for (let details = pending.closest("details"); details; details = details.parentElement?.closest("details")) details.open = true;
      setNavigationNotice("页面跳转尚未执行。请先完成或取消当前编辑或导入，输入内容已保留。");
      return;
    }
    setNavigationNotice("");
    onNavigate?.(page);
  }

  function renderStage(stageId) {
    const entityEditor = (collection) => <EntityEditor
      collection={collection}
      key={collection}
      onToast={onToast}
      pendingDeletion={pendingDeletion}
      onRequestDelete={setPendingDeletion}
      onCancelDelete={() => setPendingDeletion(null)}
    />;
    const disclosure = (title, description, children) => <details className="foundation-disclosure"><summary><span><strong>{title}</strong><small>{description}</small></span><CaretDown size={16} /></summary><div className="foundation-disclosure-body">{children}</div></details>;
    if (stageId === "documents") return <DocumentIntakePanel onToast={onToast} onNavigate={onNavigate ? navigatePage : undefined} activeSection={documentSection} onSectionChange={setDocumentSection} />;
    if (stageId === "s0") return <>
      <CompanyProfile onToast={onToast} onBeginEditing={() => setPendingDeletion(null)} />
      {disclosure("账套与门店", "会计制度、本位币与经营场所", <>{entityEditor("books")}{entityEditor("stores")}</>)}
      {disclosure("操作身份与权限", "切换操作人，管理用户、角色与本地授权", <><LocalUserControl onToast={onToast} />{entityEditor("users")}{entityEditor("roles")}<AuthorizationEditor onToast={onToast} onBeginEditing={() => setPendingDeletion(null)} /></>)}
      {disclosure("业务称呼", "调整当前工作台的客户、员工等称呼", <TerminologyEditor onToast={onToast} />)}
    </>;
    if (stageId === "s1") return <><AccountCatalogEditor onToast={onToast} /><AccountingRuleEditor onToast={onToast} />{disclosure("管理报表显示偏好", "选择管理指标与显示名称", <ManagementReportDisplayEditor onToast={onToast} />)}</>;
    if (stageId === "s2") return <>{entityEditor("counterparties")}{entityEditor("contracts")}{entityEditor("bills")}{entityEditor("businessEvents")}</>;
    if (stageId === "s3") return <>{entityEditor("bankAccounts")}<BankImportPanel onToast={onToast} /></>;
    return <>{entityEditor("invoices")}{entityEditor("approvals")}{entityEditor("personnelRecords")}</>;
  }

  return (
    <div className="page-content foundation-page" ref={pageRef}>
      <div className="foundation-navigation">
        <nav className="foundation-stage-tabs" aria-label="基础资料分组">{STAGES.map((item) => <button className={stage === item.id ? "active" : ""} aria-pressed={stage === item.id} key={item.id} type="button" onClick={() => navigateStage(item.id)}>{item.label}</button>)}</nav>
      </div>
      {navigationNotice && <div className="foundation-notice" role="status"><WarningCircle size={18} /><span>{navigationNotice}</span></div>}
      {STAGES.filter((item) => visitedStages.includes(item.id)).map((item) => <div className="foundation-grid foundation-stage-panel" data-foundation-stage={item.id} hidden={stage !== item.id} key={item.id}>{renderStage(item.id)}</div>)}
      {stage !== "documents" && <StageStatusControl key={stage} stage={stage} onToast={onToast} />}
    </div>
  );
}
