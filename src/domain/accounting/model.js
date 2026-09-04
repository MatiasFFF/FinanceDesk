export const BILL_KINDS = Object.freeze({
  RECEIVABLE: "receivable",
  PAYABLE: "payable",
  DEPOSIT_RECEIVED: "depositReceived",
  PREPAYMENT_PAID: "prepaymentPaid",
});

export const EVENT_TYPES = Object.freeze({
  CUSTOMER_RECEIPT: "customerReceipt",
  MEMBER_RECHARGE: "memberRecharge",
  MEMBER_CONSUMPTION: "memberConsumption",
  SUPPLIER_SETTLEMENT: "supplierSettlement",
  SUPPLIER_PREPAYMENT: "supplierPrepayment",
  PURCHASE_EXPENSE: "purchaseExpense",
  PAYROLL: "payroll",
  RENT_AND_PROPERTY: "rentAndProperty",
  BANK_FEE: "bankFee",
  LOAN: "loan",
  EMPLOYEE_ADVANCE: "employeeAdvance",
  RELATED_PARTY: "relatedParty",
  REFUND: "refund",
  INTERNAL_TRANSFER: "internalTransfer",
  UNKNOWN: "unknown",
});

export const ACCOUNT_CATALOG = Object.freeze({
  bank: { label: "银行存款", category: "asset", normalSide: "debit", cash: true },
  cash: { label: "库存现金", category: "asset", normalSide: "debit", cash: true },
  receivable: { label: "应收账款", category: "asset", normalSide: "debit" },
  prepayment: { label: "预付账款", category: "asset", normalSide: "debit" },
  equipment: { label: "固定资产", category: "asset", normalSide: "debit" },
  payable: { label: "应付账款", category: "liability", normalSide: "credit" },
  contractLiability: { label: "合同负债", category: "liability", normalSide: "credit" },
  loan: { label: "借款", category: "liability", normalSide: "credit" },
  taxPayable: { label: "应交税费", category: "liability", normalSide: "credit" },
  payrollPayable: { label: "应付职工薪酬", category: "liability", normalSide: "credit" },
  socialSecurityPayable: { label: "应付社保", category: "liability", normalSide: "credit" },
  relatedParty: { label: "关联方往来", category: "liability", normalSide: "credit" },
  equity: { label: "所有者权益", category: "equity", normalSide: "credit" },
  revenuePrivate: { label: "主营业务收入 · 服务收入", category: "revenue", normalSide: "credit" },
  revenueGroup: { label: "主营业务收入 · 其他收入", category: "revenue", normalSide: "credit" },
  salesReturns: { label: "销售退款与折让", category: "contraRevenue", normalSide: "debit" },
  costOfSales: { label: "主营业务成本", category: "cost", normalSide: "debit" },
  expenseRent: { label: "管理费用 · 房租物业", category: "expense", normalSide: "debit" },
  expenseUtility: { label: "管理费用 · 水电费", category: "expense", normalSide: "debit" },
  expenseFee: { label: "财务费用 · 手续费", category: "expense", normalSide: "debit" },
  expenseCommission: { label: "销售费用 · 业务提成", category: "expense", normalSide: "debit" },
  expensePayroll: { label: "管理费用 · 工资", category: "expense", normalSide: "debit" },
  expenseOther: { label: "管理费用 · 其他", category: "expense", normalSide: "debit" },
});

const MEMBER_ACCOUNT_LABELS = Object.freeze({
  revenuePrivate: "主营业务收入 · 私教课",
  revenueGroup: "主营业务收入 · 团课",
  expenseCommission: "销售费用 · 教练提成",
});

export const ACCOUNT_CATEGORIES = Object.freeze([
  { id: "asset", label: "资产" },
  { id: "liability", label: "负债" },
  { id: "equity", label: "所有者权益" },
  { id: "revenue", label: "收入" },
  { id: "contraRevenue", label: "收入抵减" },
  { id: "cost", label: "成本" },
  { id: "expense", label: "费用" },
  { id: "other", label: "其他" },
]);

export const DEFAULT_ACCOUNTING_RULES = Object.freeze({
  confidenceThreshold: 85,
  automaticPostingThreshold: 95,
  amountTolerance: 0.01,
  requireEvidenceForExpenses: true,
  allowOverAllocation: false,
});

export class AccountingRuleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AccountingRuleError";
    this.code = code;
    this.details = details;
  }
}

export function roundMoney(value) {
  const number = Number(value || 0);
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

export function sumMoney(values) {
  return roundMoney(values.reduce((sum, value) => sum + Number(value || 0), 0));
}

export function absoluteAmount(value) {
  return roundMoney(Math.abs(Number(value || 0)));
}

export function cloneAccountingState(state) {
  if (typeof structuredClone === "function") return structuredClone(state);
  return JSON.parse(JSON.stringify(state));
}

export function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s·（）()【】\[\]_-]+/g, "")
    .replace(/有限公司|有限责任公司|公司|工作室|商户/g, "");
}

export function periodOf(date) {
  return /^\d{4}-\d{2}/.test(String(date || "")) ? String(date).slice(0, 7) : "";
}

export function dateDistanceInDays(left, right) {
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(leftTime - rightTime) / 86_400_000);
}

export function accountingRules(workspace) {
  const activeRuleSet = [...(workspace.ruleSets || [])]
    .filter((ruleSet) => ruleSet.status === "active")
    .sort((left, right) => String(left.updatedAt || "").localeCompare(String(right.updatedAt || "")))
    .at(-1) || {};
  return {
    ...DEFAULT_ACCOUNTING_RULES,
    ...(workspace.rules || {}),
    ...activeRuleSet,
  };
}

export function activeAccountingRuleSet(workspace = {}) {
  return [...(workspace.ruleSets || [])]
    .filter((ruleSet) => ruleSet.status === "active")
    .sort((left, right) => String(left.updatedAt || "").localeCompare(String(right.updatedAt || "")))
    .at(-1) || null;
}

export function nextRecordId(records = [], prefix = "record") {
  const expression = new RegExp(`^${prefix}-(\\d+)$`);
  const maximum = records.reduce((current, record) => {
    const match = expression.exec(String(record?.id || ""));
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `${prefix}-${String(maximum + 1).padStart(4, "0")}`;
}

export function operationContext(context = {}) {
  return {
    actor: context.actor || "本地用户",
    at: context.at || new Date().toISOString(),
    mode: context.mode || "manual",
    note: context.note || "",
  };
}

export function appendAuditEntry(workspace, entry, context = {}) {
  const resolved = operationContext(context);
  const logs = workspace.auditLog || (workspace.auditLog = []);
  const audit = {
    id: nextRecordId(logs, "audit"),
    at: resolved.at,
    actor: resolved.actor,
    mode: resolved.mode,
    action: entry.action,
    entityType: entry.entityType || "workspace",
    entityId: entry.entityId || workspace.id || "workspace",
    detail: entry.detail || "",
    before: entry.before ?? null,
    after: entry.after ?? null,
    sourceIds: [...new Set(entry.sourceIds || [])],
  };
  logs.push(audit);
  return audit;
}

export function workspaceUsesMemberBusinessTerms(workspace = {}) {
  if (workspace.modules?.members === false) return false;
  if (workspace.modules?.members === true) return true;
  return workspace.templateId === "fitness-studio"
    || Boolean(workspace.isDemo)
    || (workspace.members || []).length > 0
    || (workspace.businessEvents || []).some((event) => event.memberId || event.memberName || event.coach);
}

export function accountDefinition(accountId, workspace = {}) {
  const baseId = String(accountId || "").split(":")[0];
  const exactCustom = (workspace.chartOfAccounts || []).find((account) => account.id === accountId);
  const baseCustom = (workspace.chartOfAccounts || []).find((account) => account.id === baseId);
  const custom = exactCustom || baseCustom;
  const bankAccount = [...(workspace.bankAccounts || []), ...(workspace.accounts || [])]
    .find((account) => account.id === accountId);
  const catalogDefinition = ACCOUNT_CATALOG[accountId] || ACCOUNT_CATALOG[baseId];
  const memberLabel = workspaceUsesMemberBusinessTerms(workspace)
    ? MEMBER_ACCOUNT_LABELS[accountId] || MEMBER_ACCOUNT_LABELS[baseId]
    : null;
  const standard = catalogDefinition ? {
    ...catalogDefinition,
    ...(memberLabel ? { label: memberLabel } : {}),
  } : (bankAccount ? {
    ...bankAccount,
    label: bankAccount.label || bankAccount.name || "银行存款",
    category: "asset",
    normalSide: "debit",
    cash: true,
  } : null) || {
    label: accountId || "未知科目",
    category: "other",
    normalSide: "debit",
  };
  if (!custom) return standard;
  return {
    ...standard,
    ...custom,
    id: accountId || custom.id,
    label: custom.label || custom.name || standard.label,
    name: custom.name || custom.label || standard.label,
    category: custom.category || standard.category,
    normalSide: custom.normalSide || standard.normalSide,
    cash: custom.cash ?? custom.isCash ?? Boolean(standard.cash),
    status: custom.status || "active",
  };
}

export function workspaceAccountDefinitions(workspace = {}) {
  const accountIds = collectSourceIds(
    Object.keys(ACCOUNT_CATALOG),
    (workspace.chartOfAccounts || []).map((account) => account.id),
  );
  return accountIds.map((id) => {
    const custom = (workspace.chartOfAccounts || []).find((account) => account.id === id);
    const definition = accountDefinition(id, workspace);
    return {
      ...definition,
      id,
      label: definition.label || definition.name || id,
      name: definition.name || definition.label || id,
      status: custom?.status || "active",
      builtIn: Object.hasOwn(ACCOUNT_CATALOG, id),
    };
  }).sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
}

function validateAccountValues(values) {
  const name = String(values.name || values.label || "").trim();
  const category = String(values.category || "").trim();
  const normalSide = String(values.normalSide || "").trim();
  if (!name) throw new AccountingRuleError("ACCOUNT_NAME_REQUIRED", "请填写科目名称");
  if (!ACCOUNT_CATEGORIES.some((item) => item.id === category)) {
    throw new AccountingRuleError("ACCOUNT_CATEGORY_INVALID", "请选择有效的科目类别");
  }
  if (!['debit', 'credit'].includes(normalSide)) {
    throw new AccountingRuleError("ACCOUNT_NORMAL_SIDE_INVALID", "科目方向只能是借方或贷方");
  }
  return { name, category, normalSide, cash: Boolean(values.cash) };
}

export function upsertWorkspaceAccount(workspace, values, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const normalized = validateAccountValues(values);
  const records = next.chartOfAccounts || (next.chartOfAccounts = []);
  const accountId = values.id || nextRecordId(records, "account");
  const index = records.findIndex((account) => account.id === accountId);
  const before = index >= 0 ? { ...records[index] } : null;
  const auditBefore = before || (Object.hasOwn(ACCOUNT_CATALOG, accountId) ? {
    id: accountId,
    ...ACCOUNT_CATALOG[accountId],
    status: "active",
    builtIn: true,
  } : null);
  const record = {
    ...(before || {}),
    id: accountId,
    label: normalized.name,
    name: normalized.name,
    category: normalized.category,
    normalSide: normalized.normalSide,
    cash: normalized.cash,
    status: values.status || before?.status || "active",
    builtInOverride: Object.hasOwn(ACCOUNT_CATALOG, accountId),
    createdAt: before?.createdAt || resolvedContext.at,
    createdBy: before?.createdBy || resolvedContext.actor,
    updatedAt: resolvedContext.at,
    updatedBy: resolvedContext.actor,
  };
  if (!['active', 'inactive'].includes(record.status)) {
    throw new AccountingRuleError("ACCOUNT_STATUS_INVALID", "科目状态只能是有效或停用");
  }
  if (index >= 0) records[index] = record;
  else records.push(record);
  appendAuditEntry(next, {
    action: auditBefore ? "account.update" : "account.create",
    entityType: "account",
    entityId: accountId,
    detail: `${auditBefore ? "修改" : "新增"}科目：${record.label}`,
    before: auditBefore,
    after: record,
    sourceIds: [accountId],
  }, resolvedContext);
  return next;
}

export function setWorkspaceAccountStatus(workspace, { accountId, status }, context = {}) {
  if (!['active', 'inactive'].includes(status)) {
    throw new AccountingRuleError("ACCOUNT_STATUS_INVALID", "科目状态只能是有效或停用");
  }
  const current = workspaceAccountDefinitions(workspace).find((account) => account.id === accountId);
  if (!current) throw new AccountingRuleError("ACCOUNT_NOT_FOUND", `找不到科目：${accountId}`);
  const next = upsertWorkspaceAccount(workspace, { ...current, status }, context);
  const audit = next.auditLog?.at(-1);
  if (audit) {
    audit.action = status === "inactive" ? "account.deactivate" : "account.activate";
    audit.detail = `${status === "inactive" ? "停用" : "启用"}科目：${current.label}`;
  }
  return next;
}

function normalizeRuleNumber(value, label, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new AccountingRuleError("ACCOUNTING_RULE_INVALID", `${label}必须在 ${min}–${max === Number.POSITIVE_INFINITY ? "有效数值" : max} 之间`);
  }
  return number;
}

export function saveActiveAccountingRuleSet(workspace, values, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const records = next.ruleSets || (next.ruleSets = []);
  const active = activeAccountingRuleSet(next);
  const index = active ? records.findIndex((ruleSet) => ruleSet.id === active.id) : -1;
  const before = index >= 0 ? { ...records[index] } : null;
  const record = {
    ...(before || {}),
    id: before?.id || nextRecordId(records, "rule-set"),
    name: String(values.name || before?.name || "当前账务规则").trim() || "当前账务规则",
    status: "active",
    confidenceThreshold: normalizeRuleNumber(values.confidenceThreshold, "人工复核阈值", { min: 0, max: 100 }),
    automaticPostingThreshold: normalizeRuleNumber(values.automaticPostingThreshold, "自动建议阈值", { min: 0, max: 100 }),
    amountTolerance: normalizeRuleNumber(values.amountTolerance, "金额容差", { min: 0 }),
    requireEvidenceForExpenses: Boolean(values.requireEvidenceForExpenses),
    allowOverAllocation: Boolean(values.allowOverAllocation),
    createdAt: before?.createdAt || resolvedContext.at,
    createdBy: before?.createdBy || resolvedContext.actor,
    updatedAt: resolvedContext.at,
    updatedBy: resolvedContext.actor,
  };
  if (index >= 0) records[index] = record;
  else records.push(record);
  appendAuditEntry(next, {
    action: before ? "accounting_rules.update" : "accounting_rules.create",
    entityType: "ruleSet",
    entityId: record.id,
    detail: `${before ? "更新" : "创建"}当前有效账务规则：${record.name}`,
    before,
    after: record,
    sourceIds: [record.id],
  }, resolvedContext);
  return next;
}

export function activeAllocations(transaction) {
  return (transaction.allocations || []).filter((allocation) => allocation.status !== "reversed");
}

export function activeAllocationTotal(transaction) {
  return sumMoney(activeAllocations(transaction).map((allocation) => allocation.amount));
}

export function transactionUnallocatedAmount(transaction) {
  return roundMoney(absoluteAmount(transaction.amount) - activeAllocationTotal(transaction));
}

export function allocationDirectionMatchesBill(transaction, bill) {
  if (Number(transaction.amount) >= 0) {
    return bill.kind === BILL_KINDS.RECEIVABLE || bill.kind === BILL_KINDS.DEPOSIT_RECEIVED;
  }
  return bill.kind === BILL_KINDS.PAYABLE || bill.kind === BILL_KINDS.PREPAYMENT_PAID;
}

export function collectSourceIds(...groups) {
  return [...new Set(groups.flat(Infinity).filter(Boolean))];
}
