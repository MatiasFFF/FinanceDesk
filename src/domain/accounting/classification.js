import {
  BILL_KINDS,
  EVENT_TYPES,
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
} from "./model.js";

const CLASSIFICATION_RULES = [
  { id: "internal-transfer", eventType: EVENT_TYPES.INTERNAL_TRANSFER, pattern: /内部转账|账户调拨|转存|划转/, account: "bank", confidence: 93 },
  { id: "refund", eventType: EVENT_TYPES.REFUND, pattern: /退款|退费|冲退|返还/, direction: "out", account: "salesReturns", confidence: 88 },
  { id: "member-recharge", eventType: EVENT_TYPES.MEMBER_RECHARGE, pattern: /会员|充值|储值|预收|课包/, direction: "in", account: "contractLiability", confidence: 88 },
  { id: "supplier-prepayment", eventType: EVENT_TYPES.SUPPLIER_PREPAYMENT, pattern: /预付|充值/, direction: "out", account: "prepayment", confidence: 84 },
  { id: "bank-fee", eventType: EVENT_TYPES.BANK_FEE, pattern: /手续费|服务费|拉卡拉|银联/, direction: "out", account: "expenseFee", confidence: 94 },
  { id: "rent", eventType: EVENT_TYPES.RENT_AND_PROPERTY, pattern: /房租|租金|物业/, direction: "out", account: "expenseRent", confidence: 90 },
  { id: "payroll", eventType: EVENT_TYPES.PAYROLL, pattern: /工资|薪资|薪酬|社保|公积金/, direction: "out", account: "expensePayroll", confidence: 88 },
  { id: "loan", eventType: EVENT_TYPES.LOAN, pattern: /借款|还款|贷款/, account: "loan", confidence: 78 },
  { id: "employee-advance", eventType: EVENT_TYPES.EMPLOYEE_ADVANCE, pattern: /员工代垫|备用金|报销/, account: "expenseOther", confidence: 76 },
  { id: "related-party", eventType: EVENT_TYPES.RELATED_PARTY, pattern: /股东|关联方|法人往来/, account: "relatedParty", confidence: 72 },
  { id: "private-revenue", eventType: EVENT_TYPES.CUSTOMER_RECEIPT, pattern: /私教|课程收入/, direction: "in", account: "revenuePrivate", confidence: 86 },
  { id: "group-revenue", eventType: EVENT_TYPES.CUSTOMER_RECEIPT, pattern: /团课|美团|微信支付|支付宝/, direction: "in", account: "revenueGroup", confidence: 84 },
  { id: "purchase", eventType: EVENT_TYPES.PURCHASE_EXPENSE, pattern: /采购|器械|物料|电费|水费/, direction: "out", account: "expenseOther", confidence: 80 },
];

function directionOf(transaction) {
  return Number(transaction.amount || 0) >= 0 ? "in" : "out";
}

function billEventType(bill) {
  return {
    [BILL_KINDS.RECEIVABLE]: EVENT_TYPES.CUSTOMER_RECEIPT,
    [BILL_KINDS.PAYABLE]: EVENT_TYPES.SUPPLIER_SETTLEMENT,
    [BILL_KINDS.DEPOSIT_RECEIVED]: EVENT_TYPES.MEMBER_RECHARGE,
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

function configuredRule(workspace, transaction, text) {
  return (workspace.rules?.categoryKeywords || []).map((rule, index) => {
    try {
      return { rule, index, expression: new RegExp(rule.keyword, "i") };
    } catch {
      return null;
    }
  }).filter(Boolean).find(({ expression }) => expression.test(text));
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
    (!candidate.direction || candidate.direction === direction) && candidate.pattern.test(text)
  ));
  const custom = configuredRule(workspace, transaction, text);

  let eventType = rule?.eventType || EVENT_TYPES.UNKNOWN;
  let account = custom?.rule.account || rule?.account || "expenseOther";
  let confidence = Number.isFinite(Number(transaction.confidence))
    ? Number(transaction.confidence)
    : (rule?.confidence || 35);
  const reasons = [];

  if (ownAccountMatch || transaction.counterpartAccountId) {
    eventType = EVENT_TYPES.INTERNAL_TRANSFER;
    account = "bank";
    confidence = Math.max(confidence, ownAccountMatch ? 96 : 92);
    reasons.push("交易对象可对应本账套的另一银行账户");
  } else if (leadingBill) {
    eventType = billEventType(leadingBill.bill);
    account = billAccount(leadingBill.bill);
    confidence = Math.max(confidence, leadingBill.score);
    reasons.push(`可对应${leadingBill.bill.no || leadingBill.bill.id}`);
  } else if (rule) {
    reasons.push(`命中本地规则「${rule.id}」`);
  }

  if (custom) reasons.push(`命中账套关键词规则「${custom.rule.keyword}」`);
  if (!reasons.length) reasons.push("没有足够的本地规则或往来账单依据");
  if (periodOf(transaction.date) !== workspace.currentPeriod) reasons.push("资金发生期间与当前账期不同");

  confidence = Math.max(0, Math.min(99, roundMoney(confidence)));
  const riskFlags = [];
  if (confidence < rules.confidenceThreshold) riskFlags.push("low_confidence");
  if (eventType === EVENT_TYPES.UNKNOWN) riskFlags.push("unknown_business");
  if ([EVENT_TYPES.LOAN, EVENT_TYPES.RELATED_PARTY].includes(eventType)) riskFlags.push("responsible_person_confirmation");
  if (eventType === EVENT_TYPES.INTERNAL_TRANSFER && !ownAccountMatch && !transaction.counterpartAccountId) {
    riskFlags.push("transfer_counterpart_missing");
  }

  return {
    ruleId: ownAccountMatch ? "own-account-match" : (rule?.id || custom?.rule.keyword || "unclassified"),
    eventType,
    account,
    direction,
    confidence,
    reasons,
    riskFlags,
    candidateBillIds: candidates.slice(0, 5).map((candidate) => candidate.bill.id),
    counterpartAccountId: transaction.counterpartAccountId || ownAccountMatch?.id || null,
    requiresManualReview: riskFlags.length > 0,
    source: "local-rules",
  };
}

export function recognizeBusinessEvent(workspace, transaction) {
  const classification = transaction.classification || classifyBankTransaction(workspace, transaction);
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
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const transaction = (next.transactions || []).find((item) => item.id === transactionId);
  if (!transaction) throw new Error(`找不到银行流水：${transactionId}`);
  const before = transaction.classification || classifyBankTransaction(next, transaction);
  const confirmation = {
    at: resolvedContext.at,
    actor: resolvedContext.actor,
    reason: reason.trim(),
    eventType,
    account,
  };
  transaction.classification = {
    ...before,
    eventType,
    account,
    confidence: 100,
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
