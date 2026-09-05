import { createDemoWorkspace } from "../financeData.js";

export const CURRENT_SCHEMA_VERSION = 4;
export const FINANCE_DESK_STORAGE_KEY = "financedesk.local-state.v4";
export const FINANCE_DESK_BACKUP_KEY = `${FINANCE_DESK_STORAGE_KEY}.last-good`;
export const LEGACY_STORAGE_KEYS = [
  "shanlan-finance-workbench-v3",
  "shanlan-finance-demo-v1",
];

export const WORKSPACE_ENTITY_COLLECTIONS = Object.freeze([
  "books",
  "stores",
  "users",
  "roles",
  "authorizations",
  "ruleSets",
  "counterparties",
  "members",
  "contracts",
  "invoices",
  "approvals",
  "personnelRecords",
  "inventoryItems",
]);

export const WORKSPACE_OPERATIONAL_COLLECTIONS = Object.freeze([
  "bankImports",
  "transactions",
  "businessEvents",
  "bills",
  "documents",
  "evidenceLinks",
  "vouchers",
  "exceptionTasks",
  "confirmations",
  "reportVersions",
  "inventoryMovements",
]);

export const WORKSPACE_MODULE_DEFAULTS = Object.freeze({
  overview: true,
  members: false,
  payroll: false,
  inventory: false,
  reconcile: true,
  reports: true,
  tax: true,
  archive: true,
  setup: true,
});

export const FITNESS_WORKSPACE_MODULE_DEFAULTS = Object.freeze({
  ...WORKSPACE_MODULE_DEFAULTS,
  members: true,
  payroll: true,
});

export const DEFAULT_WORKSPACE_TERMINOLOGY = Object.freeze({
  customer: "客户",
  supplier: "供应商",
  personnel: "员工",
  location: "门店",
  member: "会员",
  coach: "教练",
  service: "服务",
});

export const MANAGEMENT_REPORT_DISPLAY_ITEMS = Object.freeze([
  { id: "ownerCash", label: "现金余额" },
  { id: "ownerCashIn", label: "本月收款" },
  { id: "ownerRevenue", label: "本月收入" },
  { id: "ownerGrossProfit", label: "本月毛利" },
  { id: "ownerProfit", label: "本月利润" },
  { id: "ownerPrepaid", label: "客户预收 / 未履约服务", memberBusinessLabel: "会员预收 / 未履约服务" },
  { id: "ownerReceivable", label: "应收账款" },
  { id: "ownerPayable", label: "供应商应付" },
  { id: "ownerPrepayment", label: "供应商预付" },
  { id: "ownerRefund", label: "本月退款" },
  { id: "ownerCommission", label: "销售费用 · 业务提成", accountId: "expenseCommission" },
  { id: "ownerInventory", label: "库存金额", accountId: "inventory" },
  { id: "ownerInventoryLoss", label: "本期库存损耗" },
  { id: "ownerTax", label: "预计税款（本地估算）" },
  { id: "ownerGap", label: "未来现金缺口" },
].map((item) => Object.freeze(item)));

export function managementReportDefaultLabel(item, options = {}) {
  if (!item) return "管理指标";
  return options.memberBusiness && item.memberBusinessLabel ? item.memberBusinessLabel : item.label;
}

export function normalizeManagementReportConfig(config) {
  const source = Array.isArray(config?.displayItems) ? config.displayItems : [];
  const byId = new Map(source.map((item) => [item?.id, item]));
  return {
    displayItems: MANAGEMENT_REPORT_DISPLAY_ITEMS.map((definition) => {
      const item = byId.get(definition.id);
      return {
        id: definition.id,
        visible: item?.visible !== false,
        label: typeof item?.label === "string" ? item.label.trim() : "",
      };
    }),
  };
}

export function applyManagementReportConfig(rows, config) {
  const displayItems = normalizeManagementReportConfig(config).displayItems;
  const byId = new Map(displayItems.map((item) => [item.id, item]));
  return (rows || []).flatMap((row) => {
    const item = byId.get(row.id);
    if (item?.visible === false) return [];
    return [{ ...row, ...(item.label ? { label: item.label } : {}) }];
  });
}

export function normalizeWorkspaceTerminology(terminology) {
  return Object.fromEntries(Object.entries(DEFAULT_WORKSPACE_TERMINOLOGY).map(([key, fallback]) => {
    const value = typeof terminology?.[key] === "string" ? terminology[key].trim() : "";
    return [key, value || fallback];
  }));
}

const ALWAYS_ENABLED_WORKSPACE_MODULES = Object.freeze(["overview", "reports", "archive", "setup"]);
const CONFIGURABLE_WORKSPACE_MODULES = Object.freeze(["members", "payroll", "inventory", "reconcile", "tax"]);

export function normalizeWorkspaceModules(modules, options = {}) {
  const defaults = options.fitnessTemplate ? FITNESS_WORKSPACE_MODULE_DEFAULTS : WORKSPACE_MODULE_DEFAULTS;
  const normalized = { ...defaults };
  if (typeof options.payrollDefault === "boolean" && typeof modules?.payroll !== "boolean") {
    normalized.payroll = options.payrollDefault;
  }
  CONFIGURABLE_WORKSPACE_MODULES.forEach((id) => {
    if (typeof modules?.[id] === "boolean") normalized[id] = modules[id];
  });
  ALWAYS_ENABLED_WORKSPACE_MODULES.forEach((id) => { normalized[id] = true; });
  return normalized;
}

const ALL_MUTABLE_COLLECTIONS = new Set([
  ...WORKSPACE_ENTITY_COLLECTIONS,
  ...WORKSPACE_OPERATIONAL_COLLECTIONS,
]);

const DEFAULT_ROLE_DEFINITIONS = [
  {
    id: "role-owner",
    name: "经营者",
    permissions: ["workspace.manage", "data.read", "data.write", "documents.add", "rules.manage", "confirm.finance", "confirm.owner"],
    status: "active",
  },
  {
    id: "role-finance",
    name: "财务负责人",
    permissions: ["workspace.manage", "data.read", "data.write", "documents.add", "rules.manage", "confirm.finance"],
    status: "active",
  },
  {
    id: "role-staff",
    name: "资料协作者",
    permissions: ["data.read", "documents.add"],
    status: "active",
  },
];

export const BLANK_WORKSPACE_INITIAL_ROLE_OPTIONS = Object.freeze(
  DEFAULT_ROLE_DEFINITIONS
    .filter((role) => role.status === "active" && (role.permissions.includes("*") || role.permissions.includes("workspace.manage")))
    .map((role) => Object.freeze({ id: role.id, name: role.name })),
);

const BUILTIN_ROLE_REQUIRED_PERMISSIONS = Object.fromEntries(
  DEFAULT_ROLE_DEFINITIONS.map((role) => [role.id, role.permissions]),
);

const DEFAULT_RULE_SET = {
  id: "rules-default",
  name: "默认账务规则",
  version: 1,
  status: "draft",
  confidenceThreshold: 85,
  requireEvidenceForExpense: true,
  autoDraftVoucher: false,
  recognition: {
    revenue: "人工确认后确认收入",
    prepayment: "收款先计入预收，履约后确认收入",
    refund: "关联原收款与履约记录后处理",
  },
  categoryKeywords: [],
};

const NEUTRAL_ACCOUNT_LABELS = Object.freeze([
  { id: "revenuePrivate", label: "主营业务收入 · 服务收入" },
  { id: "revenueGroup", label: "主营业务收入 · 其他收入" },
  { id: "expenseCommission", label: "销售费用 · 业务提成" },
]);

function nowIso(now = () => new Date()) {
  const value = now();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function createId(prefix = "item") {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function deepClone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function timestamped(item, timestamp) {
  return {
    ...item,
    createdAt: item.createdAt || timestamp,
    updatedAt: item.updatedAt || item.createdAt || timestamp,
  };
}

function inactivePersonnelForUser(workspace, user) {
  return (workspace.personnelRecords || []).find((personnel) => (
    ["inactive", "departed"].includes(personnel.status)
    && (personnel.id === user.personnelRecordId || personnel.userId === user.id)
  ));
}

function revokePersonnelUserAccess(workspace, user, personnel, timestamp, actor) {
  if (user.status !== "active") return user;
  workspace.auditLog.push(timestamped({
    id: createId("log"),
    at: timestamp,
    actor: actor || "本地人员资料同步",
    action: "人员状态收回本地权限",
    detail: `${personnel.name || personnel.id}已${personnel.status === "departed" ? "离职" : "停用"}，停用关联操作用户「${user.name}」`,
    objectType: "users",
    objectId: user.id,
    personnelRecordId: personnel.id,
    before: { status: user.status },
    after: { status: "inactive" },
  }, timestamp));
  return { ...user, status: "inactive", updatedAt: timestamp };
}

function normalizeDocuments(documents, timestamp) {
  return uniqueById((documents || []).map((document) => timestamped({
    ...document,
    name: document.name || document.title || "未命名资料",
    category: document.category || document.type || "其他资料",
    source: document.source || "本地录入",
    lifecycleStatus: document.lifecycleStatus || document.status || "已获取",
    archiveStatus: document.archiveStatus || (document.status === "已归档" ? "archived" : "active"),
    relatedObjectIds: deepClone(document.relatedObjectIds || document.relatedIds || []),
    storage: {
      mode: "browser-local",
      externalUpload: false,
      ...(document.storage || {}),
    },
  }, timestamp)));
}

function sampleCounterparties(workspace, timestamp) {
  const byName = new Map();
  (workspace.bills || []).forEach((bill) => {
    const name = String(bill.counterparty || "").trim();
    if (!name || byName.has(name)) return;
    byName.set(name, timestamped({
      id: `counterparty-${byName.size + 1}`,
      name,
      kind: bill.kind === "payable" || bill.kind === "prepaymentPaid" ? "supplier" : "customer",
      status: "active",
      source: "template",
    }, timestamp));
  });
  return [...byName.values()];
}

function defaultStages() {
  return {
    s0: { status: "in_progress", updatedAt: null },
    s1: { status: "draft", updatedAt: null },
    s2: { status: "collecting", updatedAt: null },
    s3: { status: "not_started", updatedAt: null },
    s4: { status: "not_started", updatedAt: null },
  };
}

export function normalizeWorkspace(input, options = {}) {
  const timestamp = options.timestamp || nowIso(options.now);
  const workspace = deepClone(input || {});
  const id = workspace.id || createId("workspace");
  const name = String(workspace.name || workspace.company?.legalName || "未命名工作台").trim();
  const isFitnessTemplate = workspace.templateId === "fitness-studio"
    || workspace.isDemo
    || (workspace.templateId === undefined && id === "workspace-shanlan");
  const hasMemberBusiness = isFitnessTemplate
    || (workspace.members || []).length > 0
    || (workspace.businessEvents || []).some((event) => event.memberId || event.memberName || event.coach);
  const company = {
    legalName: name,
    entityType: "limited_company",
    taxId: "",
    industry: "其他服务业",
    taxpayerType: "小规模纳税人",
    ownerName: "",
    verificationStatus: "unverified",
    financeContact: "",
    ...(workspace.company || {}),
  };
  const books = workspace.books?.length ? workspace.books : [{
    id: `book-${id}`,
    name: "默认账套",
    accountingStandard: "小企业会计准则",
    currency: "CNY",
    status: "active",
  }];
  const stores = workspace.stores?.length ? workspace.stores : [{
    id: `store-${id}`,
    name: isFitnessTemplate ? "山岚健身工作室" : name,
    status: "active",
    address: "",
  }];
  const sourceUsers = Array.isArray(workspace.users)
    ? workspace.users
    : [{ id: "user-accountant", name: "本地负责人", roleId: "role-owner", role: "经营者" }];
  const users = sourceUsers.map((user, index) => ({
    id: user.id || `user-${index + 1}`,
    name: user.name || "未命名用户",
    roleId: user.roleId || (user.role === "经营者" ? "role-owner" : "role-finance"),
    role: user.role || "财务负责人",
    status: user.status || "active",
    localOnly: true,
    ...user,
  }));
  const roleSource = workspace.roles?.length ? workspace.roles : DEFAULT_ROLE_DEFINITIONS;
  const roles = roleSource.map((role) => ({
    status: "active",
    ...role,
    permissions: [...new Set(Array.isArray(role.permissions)
      ? role.permissions
      : (BUILTIN_ROLE_REQUIRED_PERMISSIONS[role.id] || []))],
  }));
  const legacyRule = workspace.rules || {};
  const ruleSets = workspace.ruleSets?.length ? workspace.ruleSets : [{
    ...DEFAULT_RULE_SET,
    confidenceThreshold: legacyRule.confidenceThreshold ?? DEFAULT_RULE_SET.confidenceThreshold,
    requireEvidenceForExpense: legacyRule.requireEvidenceForExpense ?? DEFAULT_RULE_SET.requireEvidenceForExpense,
    autoDraftVoucher: legacyRule.autoDraftVoucher ?? DEFAULT_RULE_SET.autoDraftVoucher,
    categoryKeywords: deepClone(legacyRule.categoryKeywords || []),
    status: isFitnessTemplate ? "active" : "draft",
  }];
  const accounts = workspace.bankAccounts || workspace.accounts || [];
  const bankAccounts = accounts.map((account) => ({
    currency: "CNY",
    status: "active",
    sourceMode: "manual-import",
    externalConnection: "not_connected",
    ...account,
  }));
  const authorizationSource = workspace.authorizations?.length ? workspace.authorizations : [
    {
      id: `authorization-bank-${id}`,
      system: "bank",
      label: "银行数据",
      status: "not_connected",
      mode: "future-connector",
      scope: "当前工作台",
      note: "第一版仅支持本地 CSV/Excel 导入，未连接银行。",
    },
    {
      id: `authorization-tax-${id}`,
      system: "tax",
      label: "电子税务局",
      status: "not_connected",
      mode: "future-connector",
      scope: "当前工作台",
      note: "未来能力；当前不会自动登录、填报或提交。",
    },
    {
      id: `authorization-ai-${id}`,
      system: "ai_ocr",
      label: "AI / OCR",
      status: "not_connected",
      mode: "future-connector",
      scope: "当前工作台",
      note: "未来能力；当前资料仅由浏览器本地处理。",
    },
  ];
  const authorizations = authorizationSource.map((authorization) => ({
    grantedBy: "",
    grantedAt: null,
    expiresAt: null,
    revokedAt: null,
    proofDocumentId: null,
    externalConnection: false,
    ...authorization,
  }));
  const currentPeriod = workspace.currentPeriod || timestamp.slice(0, 7);
  const deliverySource = workspace.delivery || {};
  const filingSource = deliverySource.filing || {};

  const normalized = {
    ...workspace,
    id,
    name,
    templateId: workspace.templateId || (isFitnessTemplate ? "fitness-studio" : null),
    templateLabel: workspace.templateLabel || (isFitnessTemplate ? "健身工作室模板" : "空白工作台"),
    isDemo: Boolean(workspace.isDemo),
    createdAt: workspace.createdAt || timestamp,
    updatedAt: workspace.updatedAt || timestamp,
    modules: normalizeWorkspaceModules(workspace.modules, { fitnessTemplate: hasMemberBusiness, payrollDefault: isFitnessTemplate }),
    terminology: normalizeWorkspaceTerminology(workspace.terminology),
    managementReport: normalizeManagementReportConfig(workspace.managementReport),
    currentPeriod,
    periods: [...new Set([currentPeriod, ...(workspace.periods || [])])],
    company,
    chartOfAccounts: deepClone(workspace.chartOfAccounts?.length ? workspace.chartOfAccounts : (isFitnessTemplate ? [] : NEUTRAL_ACCOUNT_LABELS)),
    books: uniqueById(books.map((item) => timestamped(item, timestamp))),
    stores: uniqueById(stores.map((item) => timestamped(item, timestamp))),
    users: uniqueById(users.map((item) => timestamped(item, timestamp))),
    localUsersConfigured: workspace.localUsersConfigured === true || users.length > 0,
    roles: uniqueById(roles.map((item) => timestamped(item, timestamp))),
    authorizations: uniqueById(authorizations.map((item) => timestamped(item, timestamp))),
    ruleSets: uniqueById(ruleSets.map((item) => timestamped(item, timestamp))),
    counterparties: uniqueById((workspace.counterparties || sampleCounterparties(workspace, timestamp)).map((item) => timestamped(item, timestamp))),
    members: uniqueById((workspace.members || []).map((item) => timestamped(item, timestamp))),
    contracts: uniqueById((workspace.contracts || []).map((item) => timestamped(item, timestamp))),
    invoices: uniqueById((workspace.invoices || []).map((item) => timestamped(item, timestamp))),
    approvals: uniqueById((workspace.approvals || []).map((item) => timestamped(item, timestamp))),
    personnelRecords: uniqueById((workspace.personnelRecords || []).map((item) => timestamped(item, timestamp))),
    inventoryItems: uniqueById((workspace.inventoryItems || []).map((item) => timestamped(item, timestamp))),
    bankAccounts: uniqueById(bankAccounts.map((item) => timestamped(item, timestamp))),
    accounts: uniqueById(bankAccounts.map((item) => timestamped(item, timestamp))),
    bankImports: uniqueById((workspace.bankImports || []).map((item) => timestamped(item, timestamp))),
    transactions: uniqueById((workspace.transactions || []).map((item) => timestamped(item, timestamp))),
    businessEvents: uniqueById((workspace.businessEvents || []).map((item) => timestamped(item, timestamp))),
    bills: uniqueById((workspace.bills || []).map((item) => timestamped(item, timestamp))),
    documents: normalizeDocuments(workspace.documents, timestamp),
    evidenceLinks: uniqueById((workspace.evidenceLinks || []).map((item) => timestamped(item, timestamp))),
    vouchers: uniqueById((workspace.vouchers || []).map((item) => timestamped(item, timestamp))),
    exceptionTasks: uniqueById((workspace.exceptionTasks || []).map((item) => timestamped(item, timestamp))),
    confirmations: uniqueById((workspace.confirmations || []).map((item) => timestamped(item, timestamp))),
    reportVersions: uniqueById((workspace.reportVersions || []).map((item) => timestamped(item, timestamp))),
    inventoryMovements: uniqueById((workspace.inventoryMovements || []).map((item) => timestamped(item, timestamp))),
    auditLog: uniqueById((workspace.auditLog || []).map((item) => timestamped(item, timestamp))),
    tax: {
      period: currentPeriod,
      vatRate: 0.03,
      surtaxRate: 0.12,
      incomeTaxRate: 0.05,
      ...(workspace.tax || {}),
    },
    delivery: {
      ...deliverySource,
      reportVersions: uniqueById((deliverySource.reportVersions || []).map((item) => timestamped(item, timestamp))),
      filing: {
        period: currentPeriod,
        draftCreatedAt: null,
        draftVersionId: null,
        initialConfirmationId: null,
        finalConfirmedVersionId: null,
        exportedAt: null,
        exportedPackage: null,
        receipt: null,
        archivedAt: null,
        ...filingSource,
      },
      archives: uniqueById((deliverySource.archives || []).map((item) => timestamped(item, timestamp))),
      notices: uniqueById((deliverySource.notices || []).map((item) => timestamped(item, timestamp))),
    },
    stages: { ...defaultStages(), ...(workspace.stages || {}) },
    integrations: {
      bank: { availability: "future", connected: false, currentMethod: "local-file-import" },
      tax: { availability: "future", connected: false, currentMethod: "manual-export" },
      aiOcr: { availability: "future", connected: false, currentMethod: "manual-entry" },
      ...(workspace.integrations || {}),
    },
  };
  normalized.users = normalized.users.map((user) => {
    const personnel = inactivePersonnelForUser(normalized, user);
    return personnel ? revokePersonnelUserAccess(normalized, user, personnel, timestamp, options.actor) : user;
  });
  return normalized;
}

function createFitnessTemplateWorkspace(options = {}) {
  const timestamp = options.timestamp || nowIso(options.now);
  const demo = createDemoWorkspace();
  return normalizeWorkspace({
    ...demo,
    name: "山岚健身工作室",
    templateId: "fitness-studio",
    templateLabel: "健身行业模板",
    terminology: normalizeWorkspaceTerminology(),
    personnelRecords: [
      { id: "person-coach-chen", name: "陈教练", type: "employee", department: "教练部", status: "active", role: "私教" },
      { id: "person-coach-song", name: "宋教练", type: "employee", department: "教练部", status: "active", role: "团课教练" },
    ],
    contracts: [
      { id: "contract-member-li", no: "HY-202608-014", title: "李女士私教会员协议", kind: "sales", counterpartyName: "李女士", amount: 4800, status: "active", documentIds: ["doc-li-contract"] },
    ],
    invoices: [
      { id: "invoice-power-aug", no: "DEMO-POWER-202608", kind: "purchase", seller: "国家电网", amount: 320.5, taxAmount: 0, status: "verified_locally", documentIds: ["doc-power-invoice"] },
    ],
    approvals: [
      { id: "approval-equipment", no: "SP-202608-002", kind: "purchase", title: "力量器械采购", amount: 3680, status: "missing", relatedObjectIds: ["txn-equipment"] },
    ],
  }, { timestamp });
}

export function createInitialState(options = {}) {
  const timestamp = options.timestamp || nowIso(options.now);
  const template = createFitnessTemplateWorkspace({ timestamp });
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    activeWorkspaceId: template.id,
    activeUserId: template.users[0]?.id || null,
    createdAt: timestamp,
    updatedAt: timestamp,
    workspaces: [template],
    auditLog: [{
      id: createId("system-log"),
      at: timestamp,
      actor: "系统",
      action: "初始化财务工作台",
      detail: "首次仅创建山岚健身工作室行业模板，未连接任何外部服务。",
      workspaceId: template.id,
    }],
  };
}

export function createBlankWorkspace(input = {}, options = {}) {
  const timestamp = options.timestamp || nowIso(options.now);
  const id = input.id || createId("workspace");
  const name = String(input.name || "新工作台").trim();
  const initialUserName = String(input.initialUserName || "").trim();
  const initialRoleId = input.initialUserRoleId || BLANK_WORKSPACE_INITIAL_ROLE_OPTIONS[0]?.id;
  const initialRole = DEFAULT_ROLE_DEFINITIONS.find((role) => role.id === initialRoleId);
  if (!Array.isArray(input.users) && initialUserName && (!initialRole || !BLANK_WORKSPACE_INITIAL_ROLE_OPTIONS.some((role) => role.id === initialRole.id))) {
    throw new Error("首位本地操作人员必须选择具备“管理工作台”权限的有效角色");
  }
  const users = Array.isArray(input.users)
    ? deepClone(input.users)
    : initialUserName
      ? [{ id: `user-${id}`, name: initialUserName, roleId: initialRole.id, role: initialRole.name, status: "active", localOnly: true }]
      : [];
  return normalizeWorkspace({
    id,
    name,
    templateId: null,
    templateLabel: "空白工作台",
    isDemo: false,
    company: {
      legalName: input.legalName || name,
      entityType: input.entityType || "limited_company",
      industry: input.industry || "其他服务业",
      taxpayerType: input.taxpayerType || "小规模纳税人",
      taxId: input.taxId || "",
      ownerName: input.ownerName || "",
      financeContact: input.financeContact || "",
      verificationStatus: "unverified",
    },
    currentPeriod: input.currentPeriod || timestamp.slice(0, 7),
    modules: normalizeWorkspaceModules(input.modules),
    terminology: normalizeWorkspaceTerminology(input.terminology),
    periods: [input.currentPeriod || timestamp.slice(0, 7)],
    books: [{ id: `book-${id}`, name: "默认账套", accountingStandard: "小企业会计准则", currency: "CNY", status: "active" }],
    stores: [{ id: `store-${id}`, name, status: "active", address: "" }],
    users,
    roles: Array.isArray(input.roles) ? deepClone(input.roles) : undefined,
    counterparties: [],
    members: [],
    contracts: [],
    invoices: [],
    approvals: [],
    personnelRecords: [],
    inventoryItems: [],
    bankAccounts: [],
    bankImports: [],
    transactions: [],
    businessEvents: [],
    bills: [],
    documents: [],
    evidenceLinks: [],
    vouchers: [],
    exceptionTasks: [],
    confirmations: [],
    reportVersions: [],
    inventoryMovements: [],
    openingLedger: {},
    tax: {},
  }, { timestamp });
}

export function migrateState(rawState, options = {}) {
  const timestamp = options.timestamp || nowIso(options.now);
  if (!rawState) return createInitialState({ timestamp });
  let source = deepClone(rawState);

  if (Array.isArray(source)) {
    const seeded = createInitialState({ timestamp });
    seeded.workspaces[0].transactions = uniqueById(source.map((item) => timestamped(item, timestamp)));
    seeded.updatedAt = timestamp;
    return seeded;
  }
  if (source.payload?.workspaces) source = source.payload;
  if (!Array.isArray(source.workspaces)) throw new Error("备份中缺少工作台数据");
  if (!source.workspaces.length) return createInitialState({ timestamp });

  const workspaces = source.workspaces.map((workspace) => normalizeWorkspace(workspace, { timestamp }));
  const activeWorkspaceId = workspaces.some((item) => item.id === source.activeWorkspaceId)
    ? source.activeWorkspaceId
    : workspaces[0].id;
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) || workspaces[0];
  const activeUserId = activeWorkspace.users.some((user) => user.id === source.activeUserId && user.status === "active")
    ? source.activeUserId
    : null;
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    activeWorkspaceId,
    activeUserId,
    createdAt: source.createdAt || timestamp,
    updatedAt: timestamp,
    workspaces,
    auditLog: uniqueById((source.auditLog || []).map((item) => timestamped(item, timestamp))),
  };
}

export function validateState(state) {
  const errors = [];
  if (!state || typeof state !== "object") return { ok: false, errors: ["状态不是对象"] };
  if (state.schemaVersion !== CURRENT_SCHEMA_VERSION) errors.push(`数据版本必须为 ${CURRENT_SCHEMA_VERSION}`);
  if (!Array.isArray(state.workspaces) || state.workspaces.length === 0) errors.push("至少需要一个工作台");
  const ids = new Set();
  (state.workspaces || []).forEach((workspace, workspaceIndex) => {
    if (!workspace?.id) errors.push(`第 ${workspaceIndex + 1} 个工作台缺少 id`);
    if (ids.has(workspace?.id)) errors.push(`工作台 id 重复：${workspace.id}`);
    ids.add(workspace?.id);
    if (!String(workspace?.name || "").trim()) errors.push(`工作台 ${workspace?.id || workspaceIndex + 1} 缺少名称`);
    if (!workspace?.modules || typeof workspace.modules !== "object") errors.push(`工作台 ${workspace?.id || workspaceIndex + 1} 缺少模块配置`);
    [...WORKSPACE_ENTITY_COLLECTIONS, ...WORKSPACE_OPERATIONAL_COLLECTIONS, "bankAccounts", "auditLog"].forEach((key) => {
      if (!Array.isArray(workspace?.[key])) errors.push(`工作台 ${workspace?.id || workspaceIndex + 1} 的 ${key} 必须是数组`);
    });
  });
  if (state.workspaces?.length && !ids.has(state.activeWorkspaceId)) errors.push("当前工作台不存在");
  const activeWorkspace = state.workspaces?.find((workspace) => workspace.id === state.activeWorkspaceId);
  const activeUsers = activeWorkspace?.users?.filter((user) => user.status === "active") || [];
  if (state.activeUserId != null && !activeUsers.some((user) => user.id === state.activeUserId)) {
    errors.push("当前本地操作用户不属于活动工作台或已停用");
  }
  if (!activeUsers.length && state.activeUserId != null) errors.push("没有启用用户时，当前本地操作用户必须为空");
  return { ok: errors.length === 0, errors };
}

export function assertValidState(state) {
  const result = validateState(state);
  if (!result.ok) throw new Error(result.errors.join("；"));
  return state;
}

export function getWorkspace(state, workspaceId = state.activeWorkspaceId) {
  return state.workspaces.find((workspace) => workspace.id === workspaceId) || null;
}

export function activeWorkspaceUser(state, workspaceId = state.activeWorkspaceId) {
  const workspace = getWorkspace(state, workspaceId);
  if (!workspace) return null;
  return workspace.users.find((user) => user.id === state.activeUserId && user.status === "active" && !inactivePersonnelForUser(workspace, user)) || null;
}

export function workspaceUserPermissions(state, workspaceId = state.activeWorkspaceId) {
  const workspace = getWorkspace(state, workspaceId);
  const user = activeWorkspaceUser(state, workspaceId);
  if (!workspace || !user || user.status !== "active") return [];
  const role = workspace.roles.find((candidate) => candidate.id === user.roleId || candidate.name === user.role);
  if (!role || role.status !== "active") return [];
  return [...new Set(role.permissions || [])];
}

export function assertWorkspacePermission(state, workspaceId, permission) {
  const user = activeWorkspaceUser(state, workspaceId);
  if (!user) throw new Error("当前工作台没有可用的本地用户，请先由工作台负责人恢复人员配置");
  const permissions = workspaceUserPermissions(state, workspaceId);
  if (!permissions.includes("*") && !permissions.includes(permission)) {
    throw new Error(`当前用户「${user.name}」缺少权限 ${permission}`);
  }
  return user;
}

export function switchActiveUser(state, workspaceId, userId, options = {}) {
  const timestamp = options.timestamp || nowIso(options.now);
  const workspace = getWorkspace(state, workspaceId);
  const user = workspace?.users?.find((candidate) => candidate.id === userId);
  if (!user || user.status !== "active" || inactivePersonnelForUser(workspace, user)) throw new Error("只能切换到当前工作台中的启用用户");
  const role = workspace.roles.find((candidate) => candidate.id === user.roleId || candidate.name === user.role);
  if (!role || role.status !== "active") throw new Error(`人员「${user.name}」没有可用的启用角色，请先调整其角色`);
  const next = { ...state, activeWorkspaceId: workspaceId, activeUserId: userId, updatedAt: timestamp };
  return assertValidState(appendRootAudit(next, {
    actor: user.name,
    action: "切换本地操作用户",
    detail: `当前操作身份切换为「${user.name}」`,
    workspaceId,
  }, timestamp));
}

function appendRootAudit(state, event, timestamp) {
  return {
    ...state,
    updatedAt: timestamp,
    auditLog: [
      ...(state.auditLog || []),
      {
        id: createId("system-log"),
        at: timestamp,
        actor: event.actor || "本地用户",
        action: event.action,
        detail: event.detail || "",
        workspaceId: event.workspaceId || null,
      },
    ],
  };
}

export function updateWorkspace(state, workspaceId, updater, audit, options = {}) {
  const timestamp = options.timestamp || nowIso(options.now);
  let found = false;
  const workspaces = state.workspaces.map((workspace) => {
    if (workspace.id !== workspaceId) return workspace;
    found = true;
    const updated = normalizeWorkspace({
      ...updater(deepClone(workspace)),
      id: workspace.id,
      localUsersConfigured: workspace.localUsersConfigured === true || workspace.users.length > 0,
      updatedAt: timestamp,
    }, { timestamp, actor: audit?.actor || options.actor });
    if (!audit) return updated;
    return {
      ...updated,
      auditLog: [
        ...updated.auditLog,
        {
          id: createId("log"),
          at: timestamp,
          actor: audit.actor || "本地用户",
          action: audit.action,
          detail: audit.detail || "",
          objectType: audit.objectType || null,
          objectId: audit.objectId || null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    };
  });
  if (!found) throw new Error(`找不到工作台：${workspaceId}`);
  const activeWorkspace = workspaces.find((workspace) => workspace.id === state.activeWorkspaceId);
  const activeUserId = activeWorkspace?.users?.some((user) => user.id === state.activeUserId && user.status === "active")
    ? state.activeUserId
    : null;
  const next = { ...state, workspaces, activeUserId, updatedAt: timestamp };
  return assertValidState(audit ? appendRootAudit(next, { ...audit, workspaceId }, timestamp) : next);
}

export function addWorkspace(state, input = {}, options = {}) {
  const timestamp = options.timestamp || nowIso(options.now);
  const sourceId = input.sourceWorkspaceId;
  let workspace;
  if (sourceId) {
    const source = getWorkspace(state, sourceId);
    if (!source) throw new Error(`找不到要复制的工作台：${sourceId}`);
    workspace = normalizeWorkspace({
      ...deepClone(source),
      id: input.id || createId("workspace"),
      name: String(input.name || `${source.name} 副本`).trim(),
      templateLabel: `复制自 ${source.name}`,
      modules: input.modules || source.modules,
      company: {
        ...(source.company || {}),
        legalName: input.legalName || input.name || source.company?.legalName,
        industry: input.industry || source.company?.industry,
        taxpayerType: input.taxpayerType || source.company?.taxpayerType,
      },
      isDemo: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      auditLog: [],
    }, { timestamp });
    workspace.documents = workspace.documents.map((document) => ({
      ...document,
      storage: document.storage ? { ...document.storage, availableLocally: false } : document.storage,
    }));
  } else {
    workspace = createBlankWorkspace(input, { timestamp });
  }
  const next = {
    ...state,
    workspaces: [...state.workspaces, workspace],
    activeWorkspaceId: input.activate === false ? state.activeWorkspaceId : workspace.id,
    activeUserId: input.activate === false
      ? state.activeUserId
      : workspace.users.find((user) => user.status === "active")?.id || null,
    updatedAt: timestamp,
  };
  return {
    state: assertValidState(appendRootAudit(next, {
      actor: input.actor,
      action: sourceId ? "复制工作台" : "创建工作台",
      detail: sourceId ? `从「${getWorkspace(state, sourceId).name}」复制为「${workspace.name}」` : `创建「${workspace.name}」`,
      workspaceId: workspace.id,
    }, timestamp)),
    workspace,
  };
}

export function renameWorkspace(state, workspaceId, name, options = {}) {
  const nextName = String(name || "").trim();
  if (!nextName) throw new Error("工作台名称不能为空");
  const previous = getWorkspace(state, workspaceId);
  if (!previous) throw new Error(`找不到工作台：${workspaceId}`);
  return updateWorkspace(state, workspaceId, (workspace) => ({ ...workspace, name: nextName }), {
    actor: options.actor,
    action: "重命名工作台",
    detail: `「${previous.name}」改为「${nextName}」`,
  }, options);
}

export function updateWorkspaceModules(state, workspaceId, modules, options = {}) {
  const workspace = getWorkspace(state, workspaceId);
  if (!workspace) throw new Error(`找不到工作台：${workspaceId}`);
  const nextModules = normalizeWorkspaceModules({ ...workspace.modules, ...deepClone(modules || {}) }, {
    fitnessTemplate: workspace.templateId === "fitness-studio" || workspace.isDemo,
  });
  return updateWorkspace(state, workspaceId, (current) => ({ ...current, modules: nextModules }), {
    actor: options.actor,
    action: "更新工作台模块",
    detail: `会员业务${nextModules.members ? "启用" : "停用"}；工资与社保${nextModules.payroll ? "启用" : "停用"}；库存与损耗${nextModules.inventory ? "启用" : "停用"}；流水核销${nextModules.reconcile ? "启用" : "停用"}；确认与申报${nextModules.tax ? "启用" : "停用"}`,
  }, options);
}

export function switchWorkspace(state, workspaceId, options = {}) {
  const target = getWorkspace(state, workspaceId);
  if (!target) throw new Error(`找不到工作台：${workspaceId}`);
  const source = getWorkspace(state);
  const sourceActor = activeWorkspaceUser(state)?.name || "本地用户";
  const timestamp = options.timestamp || nowIso(options.now);
  const activeUserId = target.users.find((user) => user.id === state.activeUserId && user.status === "active")?.id
    || (workspaceId !== state.activeWorkspaceId ? target.users.find((user) => user.status === "active" && !inactivePersonnelForUser(target, user))?.id : null)
    || null;
  return assertValidState(appendRootAudit({ ...state, activeWorkspaceId: workspaceId, activeUserId, updatedAt: timestamp }, {
    actor: options.actor || sourceActor,
    action: "切换工作台",
    detail: source?.id === target.id ? `保持在「${target.name}」` : `「${source?.name || "未知工作台"}」切换到「${target.name}」`,
    workspaceId,
  }, timestamp));
}

export function deleteWorkspace(state, workspaceId, options = {}) {
  const target = getWorkspace(state, workspaceId);
  if (!target) throw new Error(`找不到工作台：${workspaceId}`);
  if (state.workspaces.length === 1) throw new Error("至少保留一个工作台；可先创建新工作台再删除当前工作台");
  const timestamp = options.timestamp || nowIso(options.now);
  const workspaces = state.workspaces.filter((workspace) => workspace.id !== workspaceId);
  const next = {
    ...state,
    workspaces,
    activeWorkspaceId: state.activeWorkspaceId === workspaceId ? workspaces[0].id : state.activeWorkspaceId,
    activeUserId: state.activeWorkspaceId === workspaceId
      ? workspaces[0].users.find((user) => user.status === "active")?.id || null
      : state.activeUserId,
    updatedAt: timestamp,
  };
  return assertValidState(appendRootAudit(next, {
    actor: options.actor,
    action: "删除工作台",
    detail: `删除「${target.name}」及其浏览器本地业务数据`,
    workspaceId,
  }, timestamp));
}

export function clearWorkspace(state, workspaceId, options = {}) {
  const scope = options.scope || "operational";
  if (!new Set(["operational", "all"]).has(scope)) throw new Error(`不支持的清空范围：${scope}`);
  return updateWorkspace(state, workspaceId, (workspace) => {
    if (scope === "operational") {
      const cleared = { ...workspace };
      WORKSPACE_OPERATIONAL_COLLECTIONS.forEach((key) => { cleared[key] = []; });
      cleared.tax = {};
      cleared.openingLedger = {};
      cleared.delivery = {
        reportVersions: [],
        filing: {
          period: workspace.currentPeriod,
          draftCreatedAt: null,
          draftVersionId: null,
          exportedAt: null,
          exportedPackage: null,
          receipt: null,
          archivedAt: null,
        },
        archives: [],
        notices: [],
      };
      return cleared;
    }
    const currentUser = workspace.users.find((user) => user.id === state.activeUserId && user.status === "active");
    const currentRole = currentUser
      ? workspace.roles.find((role) => role.id === currentUser.roleId || role.name === currentUser.role)
      : null;
    const blank = createBlankWorkspace({
      id: workspace.id,
      name: workspace.name,
      legalName: workspace.company?.legalName || workspace.name,
      industry: workspace.company?.industry,
      taxpayerType: workspace.company?.taxpayerType,
      currentPeriod: workspace.currentPeriod,
      modules: workspace.modules,
      users: currentUser ? [{
        ...currentUser,
        roleId: currentRole?.id || "role-owner",
        role: currentRole?.name || "经营者",
        status: "active",
      }] : [],
      roles: currentRole ? [{ ...currentRole, status: "active" }] : undefined,
    }, options);
    return { ...blank, auditLog: workspace.auditLog };
  }, {
    actor: options.actor,
    action: "清空工作台数据",
    detail: scope === "all" ? "清空全部设置与业务数据，保留工作台名称" : "清空业务、流水、资料、证据和凭证数据",
  }, options);
}

export function updateCompanyProfile(state, workspaceId, patch, options = {}) {
  return updateWorkspace(state, workspaceId, (workspace) => ({
    ...workspace,
    company: { ...workspace.company, ...deepClone(patch) },
  }), {
    actor: options.actor,
    action: "更新企业资料",
    detail: options.detail || "更新企业主体与初始化资料",
    objectType: "company",
    objectId: workspaceId,
  }, options);
}

export function stageCompletionIssues(workspace, stage, at = new Date().toISOString()) {
  if (!workspace) return ["工作台不存在"];
  const missingOrPending = (collections) => collections.flatMap((collection) => (workspace[collection] || [])
    .filter((item) => ["missing", "pending"].includes(item.status))
    .map((item) => `${collection}/${item.name || item.title || item.no || item.id}`));
  if (stage === "s0") {
    const issues = [];
    if (!String(workspace.company?.legalName || "").trim()) issues.push("企业名称未填写");
    if (!workspace.books.some((item) => item.status === "active")) issues.push("没有启用账套");
    if (!workspace.stores.some((item) => item.status === "active")) issues.push("没有启用门店");
    if (!workspace.users.some((item) => item.status === "active")) issues.push("没有启用用户");
    if (!workspace.roles.some((item) => item.status === "active")) issues.push("没有启用角色");
    const expiredRecords = workspace.authorizations.filter((item) => item.expiresAt && Date.parse(item.expiresAt) <= Date.parse(at) && !["revoked", "expired"].includes(item.status));
    if (expiredRecords.length) issues.push(`${expiredRecords.length} 条授权已过期`);
    return issues;
  }
  if (stage === "s1") {
    const activeRules = workspace.ruleSets.filter((item) => item.status === "active");
    return activeRules.length === 1 ? [] : [activeRules.length ? "同时存在多个启用规则版本" : "没有启用账务规则"];
  }
  if (stage === "s2") return missingOrPending(["counterparties", "contracts", "bills", "businessEvents"]);
  if (stage === "s3") {
    return (workspace.bankImports || []).filter((item) => item.status !== "completed" || !item.reconciliation?.passed)
      .map((item) => `bankImports/${item.fileName || item.id}`);
  }
  if (stage === "s4") return missingOrPending(["invoices", "approvals", "personnelRecords"]);
  return ["未知阶段"];
}

export function setWorkspaceStageStatus(state, workspaceId, stage, status, options = {}) {
  if (!/^s[0-4]$/.test(stage)) throw new Error(`当前底座只允许更新 S0-S4：${stage}`);
  const timestamp = options.timestamp || nowIso(options.now);
  const workspace = getWorkspace(state, workspaceId);
  if (status === "complete") {
    const issues = stageCompletionIssues(workspace, stage, timestamp);
    if (issues.length) throw new Error(`${stage.toUpperCase()} 仍有未完成事项：${issues.slice(0, 3).join("、")}`);
  }
  return updateWorkspace(state, workspaceId, (workspace) => ({
    ...workspace,
    stages: {
      ...workspace.stages,
      [stage]: { status, updatedAt: timestamp },
    },
  }), {
    actor: options.actor,
    action: "更新流程状态",
    detail: `${stage.toUpperCase()}：${status}`,
    objectType: "stages",
    objectId: stage,
  }, { ...options, timestamp });
}

export function setWorkspacePeriod(state, workspaceId, period, options = {}) {
  const nextPeriod = String(period || "").trim();
  if (!/^\d{4}-\d{2}$/.test(nextPeriod)) throw new Error("账期必须是 YYYY-MM 格式");
  return updateWorkspace(state, workspaceId, (workspace) => ({
    ...workspace,
    currentPeriod: nextPeriod,
    periods: [nextPeriod, ...(workspace.periods || []).filter((item) => item !== nextPeriod)],
  }), {
    actor: options.actor,
    action: "切换账期",
    detail: `当前账期设为 ${nextPeriod}`,
    objectType: "period",
    objectId: nextPeriod,
  }, options);
}

export function upsertWorkspaceEntity(state, workspaceId, collection, values, options = {}) {
  if (!ALL_MUTABLE_COLLECTIONS.has(collection) && collection !== "bankAccounts") {
    throw new Error(`不允许写入集合：${collection}`);
  }
  const timestamp = options.timestamp || nowIso(options.now);
  const item = timestamped({ ...deepClone(values), id: values.id || createId(collection.slice(0, -1) || "item") }, timestamp);
  const currentWorkspace = getWorkspace(state, workspaceId);
  if (!currentWorkspace) throw new Error(`找不到工作台：${workspaceId}`);
  const existingItem = (currentWorkspace[collection] || []).find((candidate) => candidate.id === item.id);
  if (collection === "bankAccounts") {
    const bankAccount = { ...existingItem, ...item };
    if (!String(bankAccount.name || "").trim()) throw new Error("银行账户名称不能为空");

    const accountNumber = String(bankAccount.accountNumber ?? "").trim();
    if (accountNumber && !/^\d{4}$/.test(accountNumber)) {
      throw new Error("账号后四位必须是恰好 4 位数字");
    }

    [
      ["openingBalance", "期初余额"],
      ["statementClosing", "对账单期末余额"],
    ].forEach(([key, label]) => {
      const value = bankAccount[key];
      const hasValue = value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
      const isNumericValue = typeof value === "number" || typeof value === "string";
      if (hasValue && (!isNumericValue || !Number.isFinite(Number(value)))) {
        throw new Error(`${label}必须是有限数字`);
      }
    });

    const duplicateAccount = accountNumber && (currentWorkspace.bankAccounts || []).some((candidate) => {
      if (candidate.id === item.id) return false;
      const candidateNumber = String(candidate.accountNumber || candidate.number || "").trim();
      return candidateNumber.match(/(\d{4})$/)?.[1] === accountNumber;
    });
    if (duplicateAccount) throw new Error(`账号后四位 ${accountNumber} 已被其他银行账户使用`);
  }
  const effectiveStatus = item.status || existingItem?.status || "active";
  const bootstrappingFirstUser = collection === "users" && !currentWorkspace.localUsersConfigured && !currentWorkspace.users.length && effectiveStatus === "active";
  let assignedRole = null;
  if (collection === "users" && effectiveStatus === "active") {
    const proposedUser = { ...existingItem, ...item };
    if (inactivePersonnelForUser(currentWorkspace, proposedUser)) {
      throw new Error("关联人员已离职或停用；请先恢复人员资料，再明确启用本地操作用户");
    }
    assignedRole = currentWorkspace.roles.find((candidate) => (
      candidate.id === proposedUser.roleId || candidate.name === proposedUser.role
    ));
    if (!assignedRole || assignedRole.status !== "active") {
      throw new Error("启用人员必须选择一个已启用的有效角色");
    }
  }
  if (bootstrappingFirstUser) {
    const permissions = assignedRole?.permissions || [];
    if (!permissions.includes("*") && !permissions.includes("workspace.manage")) {
      throw new Error("首位启用人员必须选择具备“管理工作台”权限的启用角色，避免首次配置后无法继续管理");
    }
  }
  if (collection === "users" && item.id === state.activeUserId && effectiveStatus !== "active") {
    throw new Error("当前正在使用的本地用户不能停用；请先切换到其他启用用户");
  }
  const activeUser = activeWorkspaceUser(state, workspaceId);
  const previousRoleName = collection === "roles" ? existingItem?.name : null;
  const assignedActiveUsers = collection === "roles"
    ? currentWorkspace.users.filter((user) => user.status === "active" && (
      user.roleId === item.id || (!user.roleId && user.role === previousRoleName)
    ))
    : [];
  if (collection === "roles" && effectiveStatus !== "active" && assignedActiveUsers.length) {
    throw new Error(`角色仍分配给启用人员：${assignedActiveUsers.map((user) => user.name).join("、")}；请先调整人员角色或停用人员`);
  }
  if (collection === "roles" && activeUser && (activeUser.roleId === item.id || (!activeUser.roleId && activeUser.role === previousRoleName))) {
    const permissions = item.permissions || existingItem?.permissions || [];
    if (!permissions.includes("*") && !permissions.includes("workspace.manage")) {
      throw new Error("当前操作身份所属角色必须保留“管理工作台”权限；如需移除，请先切换到其他管理员");
    }
  }
  const created = !(currentWorkspace[collection] || []).some((candidate) => candidate.id === item.id);
  const next = updateWorkspace(state, workspaceId, (workspace) => {
    const existing = workspace[collection] || [];
    const prepared = collection === "ruleSets" && item.status === "active"
      ? existing.map((candidate) => candidate.id === item.id ? candidate : { ...candidate, status: "inactive", updatedAt: timestamp })
      : existing;
    const items = created
      ? [...prepared, item]
      : prepared.map((candidate) => candidate.id === item.id ? { ...candidate, ...item, createdAt: candidate.createdAt, updatedAt: timestamp } : candidate);
    const updatedWorkspace = { ...workspace, [collection]: items };
    const savedItem = items.find((candidate) => candidate.id === item.id);
    if (collection === "roles") {
      return {
        ...updatedWorkspace,
        users: (workspace.users || []).map((user) => (
          user.roleId === item.id || (!user.roleId && previousRoleName && user.role === previousRoleName)
            ? { ...user, roleId: item.id, role: item.name, updatedAt: timestamp }
            : user
        )),
      };
    }
    if (collection === "users") {
      const relationWasProvided = Object.prototype.hasOwnProperty.call(values, "personnelRecordId");
      const previousPersonnelRecordId = existingItem?.personnelRecordId || workspace.personnelRecords.find((personnel) => personnel.userId === item.id)?.id || null;
      const personnelRecordId = relationWasProvided ? (item.personnelRecordId || null) : previousPersonnelRecordId;
      return {
        ...updatedWorkspace,
        users: items.map((user) => {
          if (user.id === item.id) return { ...user, personnelRecordId };
          if (personnelRecordId && user.personnelRecordId === personnelRecordId) return { ...user, personnelRecordId: null, updatedAt: timestamp };
          return user;
        }),
        personnelRecords: (workspace.personnelRecords || []).map((personnel) => {
          if (personnel.id === personnelRecordId) return { ...personnel, userId: item.id, name: savedItem.name || personnel.name, updatedAt: timestamp };
          if (personnel.userId === item.id || personnel.id === previousPersonnelRecordId) return { ...personnel, userId: null, updatedAt: timestamp };
          return personnel;
        }),
      };
    }
    if (collection === "personnelRecords") {
      const relationWasProvided = Object.prototype.hasOwnProperty.call(values, "userId");
      const previousUserId = existingItem?.userId || workspace.users.find((user) => user.personnelRecordId === item.id)?.id || null;
      const userId = relationWasProvided ? (item.userId || null) : previousUserId;
      return {
        ...updatedWorkspace,
        personnelRecords: items.map((personnel) => {
          if (personnel.id === item.id) return { ...personnel, userId };
          if (userId && personnel.userId === userId) return { ...personnel, userId: null, updatedAt: timestamp };
          return personnel;
        }),
        users: (workspace.users || []).map((user) => {
          const linked = user.id === userId || user.id === previousUserId || user.personnelRecordId === item.id;
          const updatedUser = linked && ["inactive", "departed"].includes(savedItem.status)
            ? revokePersonnelUserAccess(updatedWorkspace, user, savedItem, timestamp, options.actor)
            : user;
          if (user.id === userId) return { ...updatedUser, personnelRecordId: item.id, name: savedItem.name || user.name, updatedAt: timestamp };
          if (user.personnelRecordId === item.id || user.id === previousUserId) return { ...updatedUser, personnelRecordId: null, updatedAt: timestamp };
          return user;
        }),
      };
    }
    return updatedWorkspace;
  }, {
    actor: options.actor,
    action: created ? `新增${options.label || collection}` : `更新${options.label || collection}`,
    detail: options.detail || item.name || item.title || item.no || item.id,
    objectType: collection,
    objectId: item.id,
  }, { ...options, timestamp });
  const finalState = bootstrappingFirstUser
    ? switchActiveUser(next, workspaceId, item.id, { actor: item.name, timestamp })
    : next;
  return { state: finalState, item: getWorkspace(finalState, workspaceId)[collection].find((candidate) => candidate.id === item.id), created };
}

function collectReferencePaths(workspace, collection, itemId) {
  const root = {
    ...workspace,
    [collection]: (workspace[collection] || []).filter((item) => item.id !== itemId),
    auditLog: [],
  };
  if (collection === "bankAccounts") root.accounts = [];
  if (collection === "users") {
    root.personnelRecords = (root.personnelRecords || []).map((personnel) => (
      personnel.userId === itemId ? { ...personnel, userId: null } : personnel
    ));
  }
  if (collection === "personnelRecords") {
    root.users = (root.users || []).map((user) => (
      user.personnelRecordId === itemId ? { ...user, personnelRecordId: null } : user
    ));
  }
  const paths = [];
  function visit(value, path) {
    if (paths.length >= 6 || value == null) return;
    if (typeof value === "string") {
      if (value === itemId) paths.push(path.join("."));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }
    if (typeof value === "object") {
      Object.entries(value).forEach(([key, item]) => {
        if (key === itemId) paths.push([...path, key].join("."));
        visit(item, [...path, key]);
      });
    }
  }
  visit(root, []);
  return [...new Set(paths)];
}

export function removeWorkspaceEntity(state, workspaceId, collection, itemId, options = {}) {
  if (!ALL_MUTABLE_COLLECTIONS.has(collection) && collection !== "bankAccounts") {
    throw new Error(`不允许删除集合：${collection}`);
  }
  const workspace = getWorkspace(state, workspaceId);
  const item = workspace?.[collection]?.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`找不到要删除的记录：${collection}/${itemId}`);
  const timestamp = options.timestamp || nowIso(options.now);
  if (state.activeUserId === itemId) throw new Error("当前正在使用的本地用户不能删除；请先切换到其他启用用户");
  if (collection === "ruleSets" && item.status === "active") throw new Error("正在生效的规则版本不能删除；请先启用另一版本或将其停用");
  if (collection === "roles") {
    const assignedUsers = workspace.users.filter((user) => user.roleId === itemId || (!user.roleId && user.role === item.name));
    if (assignedUsers.length) {
      throw new Error(`角色仍分配给人员：${assignedUsers.map((user) => user.name).join("、")}；请先调整人员角色再删除`);
    }
  }
  const references = collectReferencePaths(workspace, collection, itemId);
  if (references.length) {
    throw new Error(`该记录仍被 ${references.slice(0, 3).join("、")} 引用，不能直接删除；请先解除关联或改为停用`);
  }
  return updateWorkspace(state, workspaceId, (current) => ({
    ...current,
    [collection]: current[collection].filter((candidate) => candidate.id !== itemId),
    ...(collection === "bankAccounts" ? { accounts: current.accounts.filter((candidate) => candidate.id !== itemId) } : {}),
    ...(collection === "users" ? {
      personnelRecords: current.personnelRecords.map((personnel) => (
        personnel.userId === itemId ? { ...personnel, userId: null, updatedAt: timestamp } : personnel
      )),
    } : {}),
    ...(collection === "personnelRecords" ? {
      users: current.users.map((user) => (
        user.personnelRecordId === itemId ? { ...user, personnelRecordId: null, updatedAt: timestamp } : user
      )),
    } : {}),
  }), {
    actor: options.actor,
    action: `删除${options.label || collection}`,
    detail: options.detail || item.name || item.title || item.no || item.id,
    objectType: collection,
    objectId: itemId,
  }, { ...options, timestamp });
}

export function setWorkspaceEntityStatus(state, workspaceId, collection, itemId, status, options = {}) {
  const workspace = getWorkspace(state, workspaceId);
  const item = workspace?.[collection]?.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`找不到记录：${collection}/${itemId}`);
  return upsertWorkspaceEntity(state, workspaceId, collection, { ...item, status }, {
    ...options,
    detail: options.detail || `${item.name || item.title || item.no || item.id}：${item.status || "未设置"} → ${status}`,
  }).state;
}

export function recordLocalAuthorization(state, workspaceId, values, options = {}) {
  const timestamp = options.timestamp || nowIso(options.now);
  const expiresAt = values.expiresAt || null;
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw new Error("授权有效期不是有效日期");
  const workspace = getWorkspace(state, workspaceId);
  if (values.proofDocumentId && !workspace?.documents?.some((document) => document.id === values.proofDocumentId)) {
    throw new Error("授权凭证不属于当前工作台");
  }
  const expired = expiresAt ? Date.parse(expiresAt) <= Date.parse(timestamp) : false;
  const revoked = values.status === "revoked";
  return upsertWorkspaceEntity(state, workspaceId, "authorizations", {
    ...values,
    status: revoked ? "revoked" : expired ? "expired" : (values.status || "recorded"),
    grantedAt: values.grantedAt || timestamp,
    grantedBy: values.grantedBy || options.actor || "本地负责人",
    expiresAt,
    revokedAt: revoked ? (values.revokedAt || timestamp) : null,
    proofDocumentId: values.proofDocumentId || null,
    mode: "local-record",
    externalConnection: false,
  }, {
    ...options,
    timestamp,
    label: "本地授权记录",
    detail: options.detail || `${values.label || values.system || "数据源"}：仅记录授权，不建立外部连接`,
  });
}

export function linkEvidence(state, workspaceId, values, options = {}) {
  const documentIds = [...new Set(values.documentIds || [])];
  const objectIds = [...new Set(values.objectIds || [])];
  if (!documentIds.length || !objectIds.length) throw new Error("证据关联必须同时包含资料和业务对象");
  return upsertWorkspaceEntity(state, workspaceId, "evidenceLinks", {
    id: values.id,
    documentIds,
    objectIds,
    relation: values.relation || "supports",
    note: values.note || "",
    status: values.status || "active",
  }, {
    ...options,
    label: "证据关联",
    detail: options.detail || `关联 ${documentIds.length} 份资料与 ${objectIds.length} 个业务对象`,
  });
}
