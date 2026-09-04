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
]);

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
  const isFitnessTemplate = id === "workspace-shanlan" || workspace.templateId === "fitness-studio" || workspace.isDemo;
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
  const sourceUsers = workspace.users?.length ? workspace.users : [{ id: "user-accountant", name: "本地负责人", roleId: "role-owner", role: "经营者" }];
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
    ...role,
    permissions: [...new Set([
      ...(role.permissions || []),
      ...(BUILTIN_ROLE_REQUIRED_PERMISSIONS[role.id] || []),
    ])],
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
    currentPeriod,
    periods: [...new Set([currentPeriod, ...(workspace.periods || [])])],
    company,
    books: uniqueById(books.map((item) => timestamped(item, timestamp))),
    stores: uniqueById(stores.map((item) => timestamped(item, timestamp))),
    users: uniqueById(users.map((item) => timestamped(item, timestamp))),
    roles: uniqueById(roles.map((item) => timestamped(item, timestamp))),
    authorizations: uniqueById(authorizations.map((item) => timestamped(item, timestamp))),
    ruleSets: uniqueById(ruleSets.map((item) => timestamped(item, timestamp))),
    counterparties: uniqueById((workspace.counterparties || sampleCounterparties(workspace, timestamp)).map((item) => timestamped(item, timestamp))),
    members: uniqueById((workspace.members || []).map((item) => timestamped(item, timestamp))),
    contracts: uniqueById((workspace.contracts || []).map((item) => timestamped(item, timestamp))),
    invoices: uniqueById((workspace.invoices || []).map((item) => timestamped(item, timestamp))),
    approvals: uniqueById((workspace.approvals || []).map((item) => timestamped(item, timestamp))),
    personnelRecords: uniqueById((workspace.personnelRecords || []).map((item) => timestamped(item, timestamp))),
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
    auditLog: uniqueById((workspace.auditLog || []).map((item) => timestamped(item, timestamp))),
    tax: { period: currentPeriod, ...(workspace.tax || {}) },
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
      verificationStatus: "unverified",
    },
    currentPeriod: input.currentPeriod || timestamp.slice(0, 7),
    periods: [input.currentPeriod || timestamp.slice(0, 7)],
    books: [{ id: `book-${id}`, name: "默认账套", accountingStandard: "小企业会计准则", currency: "CNY", status: "active" }],
    stores: [{ id: `store-${id}`, name, status: "active", address: "" }],
    users: [],
    bankAccounts: [],
    transactions: [],
    businessEvents: [],
    bills: [],
    documents: [],
    vouchers: [],
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
    : activeWorkspace.users.find((user) => user.status === "active")?.id || null;
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
    [...WORKSPACE_ENTITY_COLLECTIONS, ...WORKSPACE_OPERATIONAL_COLLECTIONS, "bankAccounts", "auditLog"].forEach((key) => {
      if (!Array.isArray(workspace?.[key])) errors.push(`工作台 ${workspace?.id || workspaceIndex + 1} 的 ${key} 必须是数组`);
    });
  });
  if (state.workspaces?.length && !ids.has(state.activeWorkspaceId)) errors.push("当前工作台不存在");
  const activeWorkspace = state.workspaces?.find((workspace) => workspace.id === state.activeWorkspaceId);
  if (activeWorkspace && !activeWorkspace.users.some((user) => user.id === state.activeUserId && user.status === "active")) {
    errors.push("当前本地操作用户不属于活动工作台或已停用");
  }
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
  return workspace.users.find((user) => user.id === state.activeUserId && user.status === "active")
    || workspace.users.find((user) => user.status === "active")
    || null;
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
  if (!user || user.status !== "active") throw new Error("只能切换到当前工作台中的启用用户");
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
      updatedAt: timestamp,
    }, { timestamp });
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
  const next = { ...state, workspaces, updatedAt: timestamp };
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

export function switchWorkspace(state, workspaceId, options = {}) {
  const target = getWorkspace(state, workspaceId);
  if (!target) throw new Error(`找不到工作台：${workspaceId}`);
  const timestamp = options.timestamp || nowIso(options.now);
  const activeUserId = target.users.find((user) => user.id === state.activeUserId && user.status === "active")?.id
    || target.users.find((user) => user.status === "active")?.id
    || null;
  return assertValidState(appendRootAudit({ ...state, activeWorkspaceId: workspaceId, activeUserId, updatedAt: timestamp }, {
    actor: options.actor,
    action: "切换工作台",
    detail: `切换到「${target.name}」`,
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
    const blank = createBlankWorkspace({
      id: workspace.id,
      name: workspace.name,
      legalName: workspace.company?.legalName || workspace.name,
      industry: workspace.company?.industry,
      taxpayerType: workspace.company?.taxpayerType,
      currentPeriod: workspace.currentPeriod,
    }, options);
    const currentUser = workspace.users.find((user) => user.id === state.activeUserId && user.status === "active");
    if (currentUser) {
      blank.users = [{
        ...blank.users[0],
        id: currentUser.id,
        name: currentUser.name,
        roleId: "role-owner",
        role: "经营者",
        status: "active",
      }];
    }
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
  if (collection === "users" && item.id === state.activeUserId && item.status !== "active") {
    throw new Error("当前正在使用的本地用户不能停用；请先切换到其他启用用户");
  }
  const activeUser = activeWorkspaceUser(state, workspaceId);
  if (collection === "roles" && item.status !== "active" && activeUser && (activeUser.roleId === item.id || activeUser.role === item.name)) {
    throw new Error("当前用户所属角色不能停用；请先切换用户或调整该用户角色");
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
    return { ...workspace, [collection]: items };
  }, {
    actor: options.actor,
    action: created ? `新增${options.label || collection}` : `更新${options.label || collection}`,
    detail: options.detail || item.name || item.title || item.no || item.id,
    objectType: collection,
    objectId: item.id,
  }, { ...options, timestamp });
  return { state: next, item: getWorkspace(next, workspaceId)[collection].find((candidate) => candidate.id === item.id), created };
}

function collectReferencePaths(workspace, collection, itemId) {
  const root = {
    ...workspace,
    [collection]: (workspace[collection] || []).filter((item) => item.id !== itemId),
    auditLog: [],
  };
  if (collection === "bankAccounts") root.accounts = [];
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
  if (state.activeUserId === itemId) throw new Error("当前正在使用的本地用户不能删除；请先切换用户或停用该用户");
  if (collection === "ruleSets" && item.status === "active") throw new Error("正在生效的规则版本不能删除；请先启用另一版本或将其停用");
  const references = collectReferencePaths(workspace, collection, itemId);
  if (references.length) {
    throw new Error(`该记录仍被 ${references.slice(0, 3).join("、")} 引用，不能直接删除；请先解除关联或改为停用`);
  }
  return updateWorkspace(state, workspaceId, (current) => ({
    ...current,
    [collection]: current[collection].filter((candidate) => candidate.id !== itemId),
    ...(collection === "bankAccounts" ? { accounts: current.accounts.filter((candidate) => candidate.id !== itemId) } : {}),
  }), {
    actor: options.actor,
    action: `删除${options.label || collection}`,
    detail: options.detail || item.name || item.title || item.no || item.id,
    objectType: collection,
    objectId: itemId,
  }, options);
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
