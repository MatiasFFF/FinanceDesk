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
  revenuePrivate: { label: "主营业务收入 · 私教课", category: "revenue", normalSide: "credit" },
  revenueGroup: { label: "主营业务收入 · 团课", category: "revenue", normalSide: "credit" },
  salesReturns: { label: "销售退款与折让", category: "contraRevenue", normalSide: "debit" },
  costOfSales: { label: "主营业务成本", category: "cost", normalSide: "debit" },
  expenseRent: { label: "管理费用 · 房租物业", category: "expense", normalSide: "debit" },
  expenseUtility: { label: "管理费用 · 水电费", category: "expense", normalSide: "debit" },
  expenseFee: { label: "财务费用 · 手续费", category: "expense", normalSide: "debit" },
  expenseCommission: { label: "销售费用 · 教练提成", category: "expense", normalSide: "debit" },
  expensePayroll: { label: "管理费用 · 工资", category: "expense", normalSide: "debit" },
  expenseOther: { label: "管理费用 · 其他", category: "expense", normalSide: "debit" },
});

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

export function accountDefinition(accountId, workspace = {}) {
  const baseId = String(accountId || "").split(":")[0];
  const custom = (workspace.chartOfAccounts || []).find((account) => account.id === accountId || account.id === baseId);
  const bankAccount = [...(workspace.bankAccounts || []), ...(workspace.accounts || [])]
    .find((account) => account.id === accountId);
  return custom || ACCOUNT_CATALOG[accountId] || ACCOUNT_CATALOG[baseId] || (bankAccount ? {
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
