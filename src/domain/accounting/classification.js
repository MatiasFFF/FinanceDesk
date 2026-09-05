import {
  AccountingRuleError,
  BILL_KINDS,
  EVENT_TYPES,
  accountDefinition,
  accountingRules,
  absoluteAmount,
  allocationDirectionMatchesBill,
  appendAuditEntry,
  cloneAccountingState,
  collectSourceIds,
  dateDistanceInDays,
  normalizeText,
  operationContext,
  periodOf,
  roundMoney,
  workspaceAccountDefinitions,
} from "./model.js";
import { normalizeWorkspaceModules } from "../foundation.js";

const CLASSIFICATION_RULES = [
  { id: "internal-transfer", eventType: EVENT_TYPES.INTERNAL_TRANSFER, pattern: /内部转账|账户调拨|转存|划转/, account: "bank", confidence: 93 },
  { id: "refund", eventType: EVENT_TYPES.REFUND, pattern: /退款|退费|冲退|返还/, direction: "out", account: "salesReturns", confidence: 88 },
  { id: "member-recharge", eventType: EVENT_TYPES.MEMBER_RECHARGE, pattern: /会员|充值|储值|预收|课包/, direction: "in", account: "contractLiability", confidence: 88, requiresMemberModule: true },
  { id: "supplier-prepayment", eventType: EVENT_TYPES.SUPPLIER_PREPAYMENT, pattern: /预付|充值/, direction: "out", account: "prepayment", confidence: 84 },
  { id: "bank-fee", eventType: EVENT_TYPES.BANK_FEE, pattern: /手续费|服务费|拉卡拉|银联/, direction: "out", account: "expenseFee", confidence: 94 },
  { id: "rent", eventType: EVENT_TYPES.RENT_AND_PROPERTY, pattern: /房租|租金|物业/, direction: "out", account: "expenseRent", confidence: 90 },
  { id: "payroll", eventType: EVENT_TYPES.PAYROLL, pattern: /工资|薪资|薪酬|社保|公积金/, direction: "out", account: "expensePayroll", confidence: 88 },
  { id: "loan", eventType: EVENT_TYPES.LOAN, pattern: /借款|还款|贷款/, account: "loan", confidence: 78 },
  { id: "employee-advance", eventType: EVENT_TYPES.EMPLOYEE_ADVANCE, pattern: /员工代垫|备用金|报销/, account: "expenseOther", confidence: 76 },
  { id: "related-party", eventType: EVENT_TYPES.RELATED_PARTY, pattern: /股东|关联方|法人往来/, account: "relatedParty", confidence: 72 },
  { id: "private-revenue", eventType: EVENT_TYPES.CUSTOMER_RECEIPT, pattern: /私教/, direction: "in", account: "revenuePrivate", confidence: 86, requiresMemberModule: true },
  { id: "group-revenue", eventType: EVENT_TYPES.CUSTOMER_RECEIPT, pattern: /团课/, direction: "in", account: "revenueGroup", confidence: 84, requiresMemberModule: true },
  { id: "service-revenue", eventType: EVENT_TYPES.CUSTOMER_RECEIPT, pattern: /课程收入|服务收入|咨询收入/, direction: "in", account: "revenuePrivate", confidence: 82 },
  { id: "platform-receipt", eventType: EVENT_TYPES.CUSTOMER_RECEIPT, pattern: /美团|微信支付|支付宝/, direction: "in", account: "receivable", confidence: 76 },
  { id: "purchase", eventType: EVENT_TYPES.PURCHASE_EXPENSE, pattern: /采购|器械|物料|电费|水费/, direction: "out", account: "expenseOther", confidence: 80 },
];

const MEMBER_ONLY_EVENT_TYPES = new Set([
  EVENT_TYPES.MEMBER_RECHARGE,
  EVENT_TYPES.MEMBER_CONSUMPTION,
]);

const MEMBER_ONLY_RULE_IDS = new Set([
  "member-recharge",
  "private-revenue",
  "group-revenue",
]);

const MEMBER_RULE_LANGUAGE = /会员|私教|团课|教练|课包|耗课/;

const MEMBER_DISABLED_ACCOUNT_LABELS = Object.freeze({
  revenuePrivate: "主营业务收入 · 服务收入",
  revenueGroup: "主营业务收入 · 其他收入",
  expenseCommission: "销售费用 · 业务提成",
});

const BUSINESS_TYPE_EVENT_TYPES = Object.freeze({
  customerReceipt: EVENT_TYPES.CUSTOMER_RECEIPT,
  memberRecharge: EVENT_TYPES.MEMBER_RECHARGE,
  supplierPayment: EVENT_TYPES.SUPPLIER_SETTLEMENT,
  supplierPrepayment: EVENT_TYPES.SUPPLIER_PREPAYMENT,
  purchaseExpense: EVENT_TYPES.PURCHASE_EXPENSE,
  payroll: EVENT_TYPES.PAYROLL,
  rentAndProperty: EVENT_TYPES.RENT_AND_PROPERTY,
  bankFee: EVENT_TYPES.BANK_FEE,
  loanBorrowing: EVENT_TYPES.LOAN,
  loanRepayment: EVENT_TYPES.LOAN,
  employeeAdvance: EVENT_TYPES.EMPLOYEE_ADVANCE,
  relatedParty: EVENT_TYPES.RELATED_PARTY,
  refund: EVENT_TYPES.REFUND,
  internalTransfer: EVENT_TYPES.INTERNAL_TRANSFER,
});

function directionOf(transaction) {
  return Number(transaction.amount || 0) >= 0 ? "in" : "out";
}

export function memberBusinessEnabled(workspace) {
  const hasMemberBusiness = workspace?.templateId === "fitness-studio"
    || workspace?.isDemo
    || (workspace?.members || []).length > 0
    || (workspace?.businessEvents || []).some((event) => event.memberId || event.memberName || event.coach);
  return normalizeWorkspaceModules(workspace?.modules, { fitnessTemplate: hasMemberBusiness }).members !== false;
}

export function resolveWorkspaceAccountDefinition(workspace, accountValue, { allowInactive = true } = {}) {
  const requested = String(accountValue || "").trim();
  if (!requested) return null;
  const membersEnabled = memberBusinessEnabled(workspace);
  const definitions = workspaceAccountDefinitions(workspace).map((candidate) => {
    const neutralLabel = MEMBER_DISABLED_ACCOUNT_LABELS[candidate.id];
    const hasWorkspaceOverride = (workspace?.chartOfAccounts || []).some((account) => account.id === candidate.id);
    return neutralLabel && !membersEnabled && !hasWorkspaceOverride
      ? { ...candidate, label: neutralLabel, name: neutralLabel }
      : candidate;
  });
  const normalizedRequested = normalizeText(requested);
  let definition = definitions.find((candidate) => candidate.id === requested)
    || definitions.find((candidate) => (
      normalizeText(candidate.label) === normalizedRequested
      || normalizeText(candidate.name) === normalizedRequested
    ));
  if (!definition && requested.includes(":")) {
    const baseId = requested.split(":")[0];
    const base = definitions.find((candidate) => candidate.id === baseId);
    if (base) definition = { ...accountDefinition(requested, workspace), id: requested, status: base.status };
  }
  if (!definition) {
    const bankAccount = [...(workspace?.bankAccounts || []), ...(workspace?.accounts || [])]
      .find((candidate) => candidate.id === requested);
    if (bankAccount) definition = { ...accountDefinition(requested, workspace), id: requested, status: bankAccount.status || "active" };
  }
  if (!definition || (!allowInactive && definition.status === "inactive")) return null;
  return definition;
}

function defaultAccountForEventType(eventType) {
  return {
    [EVENT_TYPES.CUSTOMER_RECEIPT]: "receivable",
    [EVENT_TYPES.MEMBER_RECHARGE]: "contractLiability",
    [EVENT_TYPES.SUPPLIER_SETTLEMENT]: "payable",
    [EVENT_TYPES.SUPPLIER_PREPAYMENT]: "prepayment",
    [EVENT_TYPES.PURCHASE_EXPENSE]: "expenseOther",
    [EVENT_TYPES.PAYROLL]: "expensePayroll",
    [EVENT_TYPES.RENT_AND_PROPERTY]: "expenseRent",
    [EVENT_TYPES.BANK_FEE]: "expenseFee",
    [EVENT_TYPES.LOAN]: "loan",
    [EVENT_TYPES.EMPLOYEE_ADVANCE]: "expenseOther",
    [EVENT_TYPES.RELATED_PARTY]: "relatedParty",
    [EVENT_TYPES.REFUND]: "salesReturns",
    [EVENT_TYPES.INTERNAL_TRANSFER]: "bank",
  }[eventType] || null;
}

function configuredEventType(rule, account, direction) {
  const explicit = rule.eventType || BUSINESS_TYPE_EVENT_TYPES[rule.businessType];
  if (Object.values(EVENT_TYPES).includes(explicit) && explicit !== EVENT_TYPES.UNKNOWN) return explicit;
  if (!account) return EVENT_TYPES.UNKNOWN;
  const byAccount = {
    receivable: EVENT_TYPES.CUSTOMER_RECEIPT,
    revenuePrivate: EVENT_TYPES.CUSTOMER_RECEIPT,
    revenueGroup: EVENT_TYPES.CUSTOMER_RECEIPT,
    contractLiability: EVENT_TYPES.CUSTOMER_RECEIPT,
    payable: EVENT_TYPES.SUPPLIER_SETTLEMENT,
    prepayment: EVENT_TYPES.SUPPLIER_PREPAYMENT,
    expenseFee: EVENT_TYPES.BANK_FEE,
    expensePayroll: EVENT_TYPES.PAYROLL,
    expenseRent: EVENT_TYPES.RENT_AND_PROPERTY,
    loan: EVENT_TYPES.LOAN,
    relatedParty: EVENT_TYPES.RELATED_PARTY,
    salesReturns: EVENT_TYPES.REFUND,
    bank: EVENT_TYPES.INTERNAL_TRANSFER,
  }[String(account.id || "").split(":")[0]];
  if (byAccount) return byAccount;
  if (direction === "in" && account.category === "revenue") return EVENT_TYPES.CUSTOMER_RECEIPT;
  if (direction === "out" && ["expense", "cost"].includes(account.category)) return EVENT_TYPES.PURCHASE_EXPENSE;
  if (account.category === "contraRevenue") return EVENT_TYPES.REFUND;
  if (account.cash) return EVENT_TYPES.INTERNAL_TRANSFER;
  return EVENT_TYPES.UNKNOWN;
}

function memberOnlyConfiguredRule(rule) {
  const eventType = rule.eventType || BUSINESS_TYPE_EVENT_TYPES[rule.businessType];
  return rule.requiresMemberModule === true
    || MEMBER_ONLY_EVENT_TYPES.has(eventType)
    || MEMBER_ONLY_RULE_IDS.has(rule.id)
    || MEMBER_RULE_LANGUAGE.test(`${rule.id || ""} ${rule.name || ""} ${rule.label || ""} ${rule.keyword || ""}`);
}

function billEventType(workspace, bill) {
  return {
    [BILL_KINDS.RECEIVABLE]: EVENT_TYPES.CUSTOMER_RECEIPT,
    [BILL_KINDS.PAYABLE]: EVENT_TYPES.SUPPLIER_SETTLEMENT,
    [BILL_KINDS.DEPOSIT_RECEIVED]: memberBusinessEnabled(workspace)
      ? EVENT_TYPES.MEMBER_RECHARGE
      : EVENT_TYPES.CUSTOMER_RECEIPT,
    [BILL_KINDS.PREPAYMENT_PAID]: EVENT_TYPES.SUPPLIER_PREPAYMENT,
  }[bill.kind] || EVENT_TYPES.UNKNOWN;
}

function billAccount(bill) {
  return {
    [BILL_KINDS.RECEIVABLE]: "receivable",
    [BILL_KINDS.PAYABLE]: "payable",
    [BILL_KINDS.DEPOSIT_RECEIVED]: "contractLiability",
    [BILL_KINDS.PREPAYMENT_PAID]: "prepayment",
  }[bill.kind] || "expenseOther";
}

function candidateBills(workspace, transaction) {
  const counterparty = normalizeText(transaction.counterparty);
  return (workspace.bills || [])
    .filter((bill) => allocationDirectionMatchesBill(transaction, bill))
    .map((bill) => {
      const billCounterparty = normalizeText(bill.counterparty);
      const nameMatch = Boolean(counterparty && billCounterparty && (
        counterparty.includes(billCounterparty) || billCounterparty.includes(counterparty)
      ));
      const exactAmount = Math.abs(Number(bill.amount || 0) - absoluteAmount(transaction.amount)) <= 0.01;
      const days = dateDistanceInDays(transaction.date, bill.dueDate || bill.date);
      const score = Math.min(99, 55 + (nameMatch ? 22 : 0) + (exactAmount ? 16 : 0) + (days <= 31 ? 5 : 0));
      return { bill, nameMatch, exactAmount, days, score };
    })
    .filter((candidate) => candidate.nameMatch || candidate.exactAmount)
    .sort((left, right) => right.score - left.score || left.days - right.days || left.bill.id.localeCompare(right.bill.id));
}

function configuredRule(workspace, rules, text, direction) {
  return (rules.categoryKeywords || []).map((rule, index) => {
    if (rule?.enabled === false || ["inactive", "disabled"].includes(rule?.status)) return null;
    if (!memberBusinessEnabled(workspace) && memberOnlyConfiguredRule(rule || {})) return null;
    const allowedDirections = Array.isArray(rule?.allowedDirections)
      ? rule.allowedDirections
      : (rule?.direction ? [rule.direction] : []);
    if (allowedDirections.length && !allowedDirections.includes(direction)) return null;
    try {
      return { rule, index, expression: new RegExp(rule.keyword, "i") };
    } catch {
      return null;
    }
  }).filter(Boolean).map((match) => {
    const requestedAccount = match.rule.account || match.rule.accountId || "";
    const account = requestedAccount
      ? resolveWorkspaceAccountDefinition(workspace, requestedAccount)
      : null;
    const eventType = configuredEventType(match.rule, account, direction);
    const fallbackAccount = !account && !requestedAccount
      ? resolveWorkspaceAccountDefinition(workspace, defaultAccountForEventType(eventType))
      : null;
    return {
      ...match,
      account: account || fallbackAccount,
      eventType,
      invalidAccount: Boolean(requestedAccount && !account),
    };
  }).find(({ expression }) => expression.test(text));
}

export function classifyBankTransaction(workspace, transaction) {
  const rules = accountingRules(workspace);
  const text = `${transaction.counterparty || ""} ${transaction.summary || ""} ${transaction.memo || ""}`;
  const direction = directionOf(transaction);
  const candidates = candidateBills(workspace, transaction);
  const leadingBill = candidates[0];
  const ownAccounts = (workspace.accounts || []).filter((account) => account.id !== transaction.accountId);
  const normalizedText = normalizeText(text);
  const ownAccountMatch = ownAccounts.find((account) => {
    const fragments = [account.name, account.number, account.lastFour].map(normalizeText).filter(Boolean);
    return fragments.some((fragment) => normalizedText.includes(fragment));
  });
  const rule = CLASSIFICATION_RULES.find((candidate) => (
    (!candidate.requiresMemberModule || memberBusinessEnabled(workspace))
    && (!candidate.direction || candidate.direction === direction)
    && candidate.pattern.test(text)
  ));
  const custom = configuredRule(workspace, rules, text, direction);
  const hasOwnAccountMatch = Boolean(ownAccountMatch || transaction.counterpartAccountId);
  const appliedCustom = !hasOwnAccountMatch && !leadingBill ? custom : null;
  const configuredConfidence = Number(appliedCustom?.rule.confidence);

  let eventType = appliedCustom?.eventType || rule?.eventType || EVENT_TYPES.UNKNOWN;
  let account = appliedCustom?.account?.id || rule?.account || "expenseOther";
  let confidence = Number.isFinite(Number(transaction.confidence))
    ? Number(transaction.confidence)
    : (Number.isFinite(configuredConfidence) ? configuredConfidence : ((appliedCustom ? 88 : rule?.confidence) || 35));
  const reasons = [];

  if (hasOwnAccountMatch) {
    eventType = EVENT_TYPES.INTERNAL_TRANSFER;
    account = "bank";
    confidence = Math.max(confidence, ownAccountMatch ? 96 : 92);
    reasons.push("交易对象可对应本账套的另一银行账户");
  } else if (leadingBill) {
    eventType = billEventType(workspace, leadingBill.bill);
    account = billAccount(leadingBill.bill);
    confidence = Math.max(confidence, leadingBill.score);
    reasons.push(`可对应${leadingBill.bill.no || leadingBill.bill.id}`);
  } else if (appliedCustom) {
    reasons.push(`命中当前账套规则「${appliedCustom.rule.label || appliedCustom.rule.name || appliedCustom.rule.keyword}」`);
    if (appliedCustom.account) reasons.push(`规则科目：${appliedCustom.account.label}`);
    if (appliedCustom.invalidAccount) reasons.push(`规则科目「${appliedCustom.rule.account || appliedCustom.rule.accountId}」在当前科目表中不存在`);
  } else if (rule) {
    reasons.push(`命中本地规则「${rule.id}」`);
  }

  if (!reasons.length) reasons.push("没有足够的本地规则或往来账单依据");
  if (periodOf(transaction.date) !== workspace.currentPeriod) reasons.push("资金发生期间与当前账期不同");

  confidence = Math.max(0, Math.min(99, roundMoney(confidence)));
  const riskFlags = [];
  const resolvedAccount = resolveWorkspaceAccountDefinition(workspace, account);
  if (appliedCustom?.invalidAccount || !resolvedAccount) riskFlags.push("invalid_account");
  if (resolvedAccount?.status === "inactive") riskFlags.push("inactive_account");
  if (confidence < rules.confidenceThreshold) riskFlags.push("low_confidence");
  if (eventType === EVENT_TYPES.UNKNOWN) riskFlags.push("unknown_business");
  if ([EVENT_TYPES.LOAN, EVENT_TYPES.RELATED_PARTY].includes(eventType)) riskFlags.push("responsible_person_confirmation");
  if (eventType === EVENT_TYPES.INTERNAL_TRANSFER && !ownAccountMatch && !transaction.counterpartAccountId) {
    riskFlags.push("transfer_counterpart_missing");
  }

  return {
    ruleId: hasOwnAccountMatch
      ? "own-account-match"
      : (leadingBill
        ? `bill-match:${leadingBill.bill.id}`
        : (appliedCustom?.rule.id || appliedCustom?.rule.keyword || rule?.id || "unclassified")),
    ruleLabel: appliedCustom?.rule.label || appliedCustom?.rule.name || null,
    ruleKeyword: appliedCustom?.rule.keyword || null,
    eventType,
    account,
    accountLabel: resolvedAccount?.label || account,
    direction,
    confidence,
    reasons,
    riskFlags,
    candidateBillIds: candidates.slice(0, 5).map((candidate) => candidate.bill.id),
    counterpartAccountId: transaction.counterpartAccountId || ownAccountMatch?.id || null,
    requiresManualReview: riskFlags.length > 0,
    source: hasOwnAccountMatch
      ? "own-account-match"
      : (leadingBill ? "bill-match" : (appliedCustom ? "workspace-rule" : "local-rules")),
  };
}

export function effectiveBankTransactionClassification(workspace, transaction) {
  const stored = transaction?.classification;
  const refreshableRuleClassification = ["local-rules", "workspace-rule"].includes(stored?.source);
  const memberOnlyStored = MEMBER_ONLY_EVENT_TYPES.has(stored?.eventType)
    || stored?.businessType === "memberRecharge"
    || MEMBER_ONLY_RULE_IDS.has(stored?.ruleId)
    || MEMBER_RULE_LANGUAGE.test(`${stored?.ruleId || ""} ${stored?.ruleKeyword || ""} ${stored?.ruleLabel || ""}`);
  if (stored && (refreshableRuleClassification || (memberOnlyStored && !memberBusinessEnabled(workspace)))) {
    return classifyBankTransaction(workspace, transaction);
  }
  if (stored && (!memberOnlyStored || memberBusinessEnabled(workspace))) {
    const resolvedAccount = resolveWorkspaceAccountDefinition(workspace, stored.account);
    const invalidAccount = Boolean(stored.account && !resolvedAccount);
    const inactiveAccount = resolvedAccount?.status === "inactive";
    const riskFlags = [...new Set([
      ...(stored.riskFlags || []),
      ...(invalidAccount ? ["invalid_account"] : []),
      ...(inactiveAccount ? ["inactive_account"] : []),
    ])];
    return {
      ...stored,
      account: resolvedAccount?.id || stored.account,
      accountLabel: resolvedAccount?.label || stored.accountLabel || stored.account,
      riskFlags,
      requiresManualReview: Boolean(stored.requiresManualReview || invalidAccount || inactiveAccount),
    };
  }
  return classifyBankTransaction(workspace, transaction);
}

export function recognizeBusinessEvent(workspace, transaction) {
  const classification = effectiveBankTransactionClassification(workspace, transaction);
  return {
    id: `event-${transaction.id}`,
    type: classification.eventType,
    date: transaction.date,
    businessPeriod: transaction.businessPeriod || periodOf(transaction.date),
    fundingPeriod: periodOf(transaction.date),
    amount: absoluteAmount(transaction.amount),
    direction: classification.direction,
    counterparty: transaction.counterparty || "待确认",
    account: classification.account,
    accountLabel: classification.accountLabel,
    taxCategory: transaction.taxCategory || "待确认",
    confidence: classification.confidence,
    sourceIds: [transaction.id, ...classification.candidateBillIds],
    status: classification.requiresManualReview ? "needs_review" : "recognized",
    reasons: classification.reasons,
  };
}

export function classifyWorkspaceTransactions(workspace) {
  return (workspace.transactions || []).map((transaction) => {
    const classification = classifyBankTransaction(workspace, transaction);
    return {
      transactionId: transaction.id,
      classification,
      event: recognizeBusinessEvent(workspace, { ...transaction, classification }),
    };
  });
}

export function applyManualClassification(workspace, {
  transactionId,
  eventType,
  account,
  reason,
}, context = {}) {
  if (!reason?.trim()) throw new Error("人工分类必须填写判断依据");
  if (!eventType || eventType === EVENT_TYPES.UNKNOWN || !Object.values(EVENT_TYPES).includes(eventType)) {
    throw new Error("人工分类必须选择明确的业务类型");
  }
  if (!account) throw new Error("人工分类必须选择会计科目");
  if (MEMBER_ONLY_EVENT_TYPES.has(eventType) && !memberBusinessEnabled(workspace)) {
    throw new AccountingRuleError("MEMBER_MODULE_DISABLED", "当前工作台未启用会员模块，不能选择会员业务");
  }
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const transaction = (next.transactions || []).find((item) => item.id === transactionId);
  if (!transaction) throw new Error(`找不到银行流水：${transactionId}`);
  const resolvedAccount = resolveWorkspaceAccountDefinition(next, account, { allowInactive: false });
  if (!resolvedAccount) {
    throw new AccountingRuleError("ACCOUNT_NOT_AVAILABLE", `当前科目表中找不到可用科目：${account}`);
  }
  const before = effectiveBankTransactionClassification(next, transaction);
  const retainedConfidence = Number.isFinite(Number(before.confidence))
    ? roundMoney(before.confidence)
    : 0;
  const confirmation = {
    at: resolvedContext.at,
    actor: resolvedContext.actor,
    reason: reason.trim(),
    eventType,
    account: resolvedAccount.id,
    accountLabel: resolvedAccount.label,
  };
  transaction.classification = {
    ...before,
    ruleId: "manual-confirmation",
    ruleLabel: null,
    ruleKeyword: null,
    eventType,
    account: resolvedAccount.id,
    accountLabel: resolvedAccount.label,
    confidence: retainedConfidence,
    reasons: [reason.trim()],
    riskFlags: [],
    requiresManualReview: false,
    source: "manual-confirmation",
  };
  transaction.manualClassification = confirmation;
  transaction.status = "pending";
  appendAuditEntry(next, {
    action: "classification.manual_confirm",
    entityType: "bankTransaction",
    entityId: transaction.id,
    detail: reason.trim(),
    before,
    after: transaction.classification,
    sourceIds: collectSourceIds(transaction.id, transaction.evidenceIds || []),
  }, resolvedContext);
  return next;
}

export function setBankTransactionBusinessEventDimensions(workspace, {
  transactionId,
  storeId = "",
  department = "",
  project = "",
}, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext({ ...context, mode: "manual" });
  const transaction = (next.transactions || []).find((item) => item.id === transactionId);
  if (!transaction) throw new AccountingRuleError("TRANSACTION_NOT_FOUND", `找不到银行流水：${transactionId}`);
  const businessEvent = (next.businessEvents || []).find((event) => (
    event.id === transaction.bankBusinessEventId
    || (event.sourceType === "bankTransaction" && event.transactionId === transaction.id)
  ));
  if (!businessEvent) {
    throw new AccountingRuleError("BUSINESS_EVENT_NOT_FOUND", "银行业务事件尚未形成，不能保存场所、部门和项目");
  }

  const normalizedStoreId = String(storeId || "").trim();
  const store = normalizedStoreId
    ? (next.stores || []).find((item) => item.id === normalizedStoreId)
    : null;
  if (normalizedStoreId && !store) {
    throw new AccountingRuleError("BUSINESS_EVENT_STORE_NOT_FOUND", `当前工作台找不到所选场所：${normalizedStoreId}`);
  }
  const before = {
    storeId: businessEvent.storeId || null,
    storeName: businessEvent.storeName || null,
    department: businessEvent.department || null,
    project: businessEvent.project || null,
  };
  const dimensions = {
    storeId: store?.id || null,
    storeName: store?.name || null,
    department: String(department || "").trim() || null,
    project: String(project || "").trim() || null,
  };
  Object.assign(businessEvent, dimensions, {
    updatedAt: resolvedContext.at,
    updatedBy: resolvedContext.actor,
  });
  appendAuditEntry(next, {
    action: "classification.business_event_dimensions_confirm",
    entityType: "businessEvent",
    entityId: businessEvent.id,
    detail: [dimensions.storeName, dimensions.department, dimensions.project].filter(Boolean).join(" · ") || "未设置场所、部门或项目",
    before,
    after: dimensions,
    sourceIds: collectSourceIds(businessEvent.id, transaction.id),
  }, resolvedContext);
  return next;
}
