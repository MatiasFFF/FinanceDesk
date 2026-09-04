import {
  AccountingRuleError,
  BILL_KINDS,
  EVENT_TYPES,
  accountingRules,
  absoluteAmount,
  activeAllocations,
  allocationDirectionMatchesBill,
  appendAuditEntry,
  cloneAccountingState,
  collectSourceIds,
  dateDistanceInDays,
  nextRecordId,
  normalizeText,
  operationContext,
  periodOf,
  roundMoney,
  sumMoney,
  transactionUnallocatedAmount,
} from "../../domain/accounting/model.js";
import { classifyBankTransaction } from "../../domain/accounting/classification.js";
import { assessTransactionEvidence } from "../evidence/evidenceEngine.js";

function allAllocations(workspace) {
  return (workspace.transactions || []).flatMap((transaction) => transaction.allocations || []);
}

function findTransaction(workspace, transactionId) {
  const transaction = (workspace.transactions || []).find((item) => item.id === transactionId);
  if (!transaction) throw new AccountingRuleError("TRANSACTION_NOT_FOUND", `找不到银行流水：${transactionId}`);
  return transaction;
}

function findBill(workspace, billId) {
  const bill = (workspace.bills || []).find((item) => item.id === billId);
  if (!bill) throw new AccountingRuleError("BILL_NOT_FOUND", `找不到往来账单：${billId}`);
  return bill;
}

export function confirmedAllocationsForBill(workspace, billId, { asOf } = {}) {
  return (workspace.transactions || []).flatMap((transaction) => (
    activeAllocations(transaction)
      .filter((allocation) => (
        allocation.billId === billId && allocation.status !== "suspected" && (!asOf || transaction.date <= asOf)
      ))
      .map((allocation) => ({ ...allocation, transactionId: allocation.transactionId || transaction.id }))
  ));
}

export function confirmedAllocatedForBill(workspace, billId, options) {
  return sumMoney(confirmedAllocationsForBill(workspace, billId, options).map((allocation) => allocation.amount));
}

export function billSettlement(workspace, billOrId, options = {}) {
  const bill = typeof billOrId === "string" ? findBill(workspace, billOrId) : billOrId;
  const allocations = confirmedAllocationsForBill(workspace, bill.id, options);
  const allocated = sumMoney(allocations.map((allocation) => allocation.amount));
  const remaining = roundMoney(Number(bill.amount || 0) - allocated);
  let status = "pending";
  if (allocated > 0 && remaining > 0) status = "partial";
  if (remaining <= 0.01) status = "fully_reconciled";
  if (bill.kind === BILL_KINDS.DEPOSIT_RECEIVED && remaining > 0.01) status = "deposit_balance";
  if (bill.kind === BILL_KINDS.PREPAYMENT_PAID && remaining > 0.01) status = "prepayment_balance";
  return {
    billId: bill.id,
    kind: bill.kind,
    amount: roundMoney(bill.amount),
    allocated,
    remaining: Math.max(0, remaining),
    status,
    allocationIds: allocations.map((allocation) => allocation.id),
    transactionIds: [...new Set(allocations.map((allocation) => allocation.transactionId))],
    fundingPeriods: [...new Set(allocations.map((allocation) => {
      const transaction = (workspace.transactions || []).find((item) => item.id === allocation.transactionId);
      return periodOf(transaction?.date);
    }).filter(Boolean))],
  };
}

export function transactionSettlement(transaction) {
  const active = activeAllocations(transaction).filter((allocation) => allocation.status !== "suspected");
  const allocated = sumMoney(active.map((allocation) => allocation.amount));
  const remaining = Math.max(0, roundMoney(absoluteAmount(transaction.amount) - allocated));
  let status = "pending";
  if (allocated > 0 && remaining > 0.01) status = "partial";
  if (remaining <= 0.01 && allocated > 0) status = "fully_reconciled";
  if (!allocated && (transaction.matchSuggestions || []).length) status = "suspected";
  if (transaction.status === "exception") status = "exception";
  if ((transaction.refundLinks || []).some((link) => link.status !== "reversed")) status = "refund_matched";
  if (transaction.internalTransferLink?.status === "confirmed") status = "internal_transfer";
  return {
    transactionId: transaction.id,
    amount: absoluteAmount(transaction.amount),
    allocated,
    remaining,
    status,
    allocationIds: active.map((allocation) => allocation.id),
  };
}

function matchScore(transaction, bill, remaining) {
  const transactionName = normalizeText(transaction.counterparty);
  const billName = normalizeText(bill.counterparty);
  const nameMatch = Boolean(transactionName && billName && (
    transactionName.includes(billName) || billName.includes(transactionName)
  ));
  const amount = Math.min(transactionUnallocatedAmount(transaction), remaining);
  const exactAmount = Math.abs(transactionUnallocatedAmount(transaction) - remaining) <= 0.01;
  const days = dateDistanceInDays(transaction.date, bill.dueDate || bill.date);
  let score = 20;
  if (nameMatch) score += 42;
  if (exactAmount) score += 25;
  else if (amount > 0) score += 12;
  if (days <= 7) score += 8;
  else if (days <= 31) score += 4;
  return { score: Math.min(99, score), nameMatch, exactAmount, days, amount };
}

export function suggestReconciliations(workspace, transactionId, { limit = 5 } = {}) {
  const transaction = findTransaction(workspace, transactionId);
  const classification = transaction.classification || classifyBankTransaction(workspace, transaction);
  if ([EVENT_TYPES.INTERNAL_TRANSFER, EVENT_TYPES.REFUND, EVENT_TYPES.UNKNOWN].includes(classification.eventType)) return [];
  if (transactionUnallocatedAmount(transaction) <= 0.01) return [];
  const rules = accountingRules(workspace);
  return (workspace.bills || [])
    .filter((bill) => allocationDirectionMatchesBill(transaction, bill))
    .map((bill) => {
      const settlement = billSettlement(workspace, bill);
      if (settlement.remaining <= 0.01) return null;
      const match = matchScore(transaction, bill, settlement.remaining);
      if (!match.nameMatch && !match.exactAmount) return null;
      const confidence = roundMoney(Math.min(match.score, classification.confidence));
      return {
        id: `suggestion-${transaction.id}-${bill.id}`,
        transactionId: transaction.id,
        billId: bill.id,
        billNo: bill.no,
        billKind: bill.kind,
        suggestedAmount: roundMoney(match.amount),
        confidence,
        status: confidence >= rules.automaticPostingThreshold ? "strong" : "suspected",
        reasons: [
          match.nameMatch ? "交易对象一致" : null,
          match.exactAmount ? "未核销金额完全一致" : "可做部分核销",
          match.days <= 31 ? `相距 ${match.days} 天` : "跨期匹配",
        ].filter(Boolean),
        sourceIds: [transaction.id, bill.id],
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.confidence - left.confidence || left.billId.localeCompare(right.billId))
    .slice(0, limit);
}

export function recordReconciliationSuggestions(workspace, transactionId, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext({ ...context, mode: "local-rule" });
  const transaction = findTransaction(next, transactionId);
  const before = transaction.matchSuggestions || [];
  const suggestions = suggestReconciliations(next, transactionId);
  transaction.matchSuggestions = suggestions.map((suggestion) => ({ ...suggestion, createdAt: resolvedContext.at }));
  if (!activeAllocations(transaction).length && suggestions.length && transaction.status !== "exception") transaction.status = "suspected";
  appendAuditEntry(next, {
    action: "reconciliation.suggest",
    entityType: "bankTransaction",
    entityId: transaction.id,
    detail: suggestions.length ? `形成 ${suggestions.length} 个本地疑似匹配` : "没有找到可解释的账单匹配",
    before,
    after: transaction.matchSuggestions,
    sourceIds: collectSourceIds(transaction.id, suggestions.map((item) => item.billId)),
  }, resolvedContext);
  return next;
}

function validateAutomaticReconciliation(workspace, transaction) {
  const rules = accountingRules(workspace);
  const classification = transaction.classification || classifyBankTransaction(workspace, transaction);
  const assessment = transaction.evidenceAssessment || assessTransactionEvidence(workspace, transaction, classification);
  if (!rules.allowAutomaticReconciliation) {
    throw new AccountingRuleError("FINANCE_REVIEW_REQUIRED", "客户和供应商核销必须由财务人员确认；本地规则只能形成建议");
  }
  if (classification.confidence < rules.automaticPostingThreshold || !assessment.canAutomaticallyPost) {
    throw new AccountingRuleError("AUTOMATIC_RECONCILIATION_BLOCKED", "置信度或证据不满足自动核销阈值", {
      confidence: classification.confidence,
      completeness: assessment.completeness,
    });
  }
}

export function applyReconciliation(workspace, { transactionId, allocations, note = "" }, context = {}) {
  if (!Array.isArray(allocations) || !allocations.length) {
    throw new AccountingRuleError("ALLOCATION_REQUIRED", "至少需要一条核销分配");
  }
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const transaction = findTransaction(next, transactionId);
  const classification = transaction.classification || classifyBankTransaction(next, transaction);
  if ([EVENT_TYPES.INTERNAL_TRANSFER, EVENT_TYPES.REFUND, EVENT_TYPES.UNKNOWN].includes(classification.eventType)) {
    throw new AccountingRuleError("NON_BILL_EVENT", "退款、内部转账或未知事项不能按普通应收应付核销");
  }
  if (resolvedContext.mode === "automatic") validateAutomaticReconciliation(next, transaction);

  const before = transactionSettlement(transaction);
  const requested = sumMoney(allocations.map((item) => item.amount));
  const transactionRemaining = transactionUnallocatedAmount(transaction);
  const tolerance = accountingRules(next).amountTolerance;
  if (requested - transactionRemaining > tolerance) {
    throw new AccountingRuleError("TRANSACTION_OVER_ALLOCATED", "本次核销超过流水未核销余额", { requested, transactionRemaining });
  }

  const temporaryBillUsage = new Map();
  const created = allocations.map((input) => {
    const bill = findBill(next, input.billId);
    if (!allocationDirectionMatchesBill(transaction, bill)) {
      throw new AccountingRuleError("DIRECTION_MISMATCH", "收款只能核销应收/预收，付款只能核销应付/预付", {
        transactionId,
        billId: bill.id,
      });
    }
    const amount = roundMoney(input.amount);
    if (amount <= 0) throw new AccountingRuleError("INVALID_ALLOCATION_AMOUNT", "核销金额必须大于 0", { amount });
    const alreadyRequested = temporaryBillUsage.get(bill.id) || 0;
    const remaining = roundMoney(billSettlement(next, bill).remaining - alreadyRequested);
    if (amount - remaining > tolerance) {
      throw new AccountingRuleError("BILL_OVER_ALLOCATED", `核销金额超过账单 ${bill.no || bill.id} 的剩余余额`, { amount, remaining });
    }
    temporaryBillUsage.set(bill.id, roundMoney(alreadyRequested + amount));
    return {
      id: nextRecordId([...allAllocations(next), ...temporaryBillUsage.keys()].map((item) => typeof item === "string" ? { id: item } : item), "allocation"),
      transactionId: transaction.id,
      billId: bill.id,
      amount,
      status: "confirmed",
      mode: resolvedContext.mode,
      createdAt: resolvedContext.at,
      createdBy: resolvedContext.actor,
      note: input.note || note,
      businessPeriod: input.businessPeriod || bill.businessPeriod || periodOf(bill.date),
      fundingPeriod: periodOf(transaction.date),
    };
  });

  // nextRecordId needs to see allocations created earlier in this same operation.
  const existingIds = allAllocations(next);
  created.forEach((item, index) => {
    item.id = nextRecordId([...existingIds, ...created.slice(0, index)], "allocation");
  });
  transaction.allocations = [...(transaction.allocations || []), ...created];
  const allocatedBillIds = new Set(created.map((item) => item.billId));
  transaction.matchSuggestions = (transaction.matchSuggestions || []).filter((item) => !allocatedBillIds.has(item.billId));
  const after = transactionSettlement(transaction);
  transaction.status = after.status === "fully_reconciled" ? "reconciled" : "pending";
  transaction.reviewedAt = resolvedContext.at;
  transaction.reviewedBy = resolvedContext.actor;

  appendAuditEntry(next, {
    action: "reconciliation.allocate",
    entityType: "bankTransaction",
    entityId: transaction.id,
    detail: `${created.length} 条核销，共 ${requested.toFixed(2)}；未核销 ${after.remaining.toFixed(2)}`,
    before,
    after,
    sourceIds: collectSourceIds(transaction.id, created.map((item) => [item.id, item.billId])),
  }, resolvedContext);
  return next;
}

export function reverseReconciliation(workspace, { allocationId, reason }, context = {}) {
  if (!reason?.trim()) throw new AccountingRuleError("REVERSAL_REASON_REQUIRED", "撤销核销必须填写原因");
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  let transaction;
  let allocation;
  for (const item of next.transactions || []) {
    const found = (item.allocations || []).find((candidate) => candidate.id === allocationId);
    if (found) {
      transaction = item;
      allocation = found;
      break;
    }
  }
  if (!allocation || !transaction) throw new AccountingRuleError("ALLOCATION_NOT_FOUND", `找不到核销记录：${allocationId}`);
  if (allocation.status === "reversed") throw new AccountingRuleError("ALREADY_REVERSED", "该核销记录已经撤销");
  const before = transactionSettlement(transaction);
  allocation.status = "reversed";
  allocation.reversedAt = resolvedContext.at;
  allocation.reversedBy = resolvedContext.actor;
  allocation.reversalReason = reason.trim();
  const after = transactionSettlement(transaction);
  transaction.status = after.allocated > 0 ? "pending" : "pending";
  appendAuditEntry(next, {
    action: "reconciliation.reverse",
    entityType: "allocation",
    entityId: allocation.id,
    detail: reason.trim(),
    before,
    after,
    sourceIds: [transaction.id, allocation.billId, allocation.id],
  }, resolvedContext);
  return next;
}

export function redoReconciliation(workspace, { allocationIds, transactionId, allocations, reason }, context = {}) {
  if (!Array.isArray(allocationIds) || !allocationIds.length) {
    throw new AccountingRuleError("REVERSAL_REQUIRED", "重做核销前必须指定要撤销的核销记录");
  }
  let next = workspace;
  allocationIds.forEach((allocationId, index) => {
    next = reverseReconciliation(next, { allocationId, reason }, {
      ...context,
      at: context.at || new Date(Date.now() + index).toISOString(),
    });
  });
  next = applyReconciliation(next, { transactionId, allocations, note: `重做：${reason}` }, context);
  const cloned = cloneAccountingState(next);
  appendAuditEntry(cloned, {
    action: "reconciliation.redo",
    entityType: "bankTransaction",
    entityId: transactionId,
    detail: reason,
    sourceIds: collectSourceIds(transactionId, allocationIds, allocations.map((item) => item.billId)),
  }, operationContext(context));
  return cloned;
}

export function linkRefundToOriginal(workspace, {
  refundTransactionId,
  originalSourceId,
  amount,
  reason,
}, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const refund = findTransaction(next, refundTransactionId);
  const classification = refund.classification || classifyBankTransaction(next, refund);
  if (classification.eventType !== EVENT_TYPES.REFUND || Number(refund.amount) >= 0) {
    throw new AccountingRuleError("NOT_A_REFUND", "只有支出的退款流水可以关联原业务");
  }
  const originalTransaction = (next.transactions || []).find((item) => item.id === originalSourceId);
  const originalBill = (next.bills || []).find((item) => item.id === originalSourceId);
  if (!originalTransaction && !originalBill) throw new AccountingRuleError("ORIGINAL_SOURCE_NOT_FOUND", `找不到退款原业务：${originalSourceId}`);
  if (originalTransaction && Number(originalTransaction.amount) <= 0) {
    throw new AccountingRuleError("ORIGINAL_SOURCE_INVALID", "退款只能关联原收款流水");
  }
  if (originalBill && !["receivable", "depositReceived"].includes(originalBill.kind)) {
    throw new AccountingRuleError("ORIGINAL_SOURCE_INVALID", "退款只能关联客户应收或预收业务");
  }
  if (!reason?.trim()) throw new AccountingRuleError("REFUND_REASON_REQUIRED", "退款关联必须填写判断依据");
  const linked = sumMoney((refund.refundLinks || []).filter((item) => item.status !== "reversed").map((item) => item.amount));
  const refundRemaining = roundMoney(absoluteAmount(refund.amount) - linked);
  const resolvedAmount = roundMoney(amount || refundRemaining);
  if (resolvedAmount <= 0 || resolvedAmount - refundRemaining > accountingRules(next).amountTolerance) {
    throw new AccountingRuleError("REFUND_OVER_LINKED", "退款关联金额超过未匹配余额", { resolvedAmount, refundRemaining });
  }
  const originalAmount = absoluteAmount(originalTransaction?.amount ?? originalBill?.amount);
  const alreadyRefunded = sumMoney((next.transactions || []).flatMap((transaction) => (
    (transaction.refundLinks || []).filter((item) => item.status !== "reversed" && item.originalSourceId === originalSourceId).map((item) => item.amount)
  )));
  const refundableBalance = roundMoney(originalAmount - alreadyRefunded);
  if (resolvedAmount - refundableBalance > accountingRules(next).amountTolerance) {
    throw new AccountingRuleError("ORIGINAL_SOURCE_OVER_REFUNDED", "累计退款金额超过原收款或原业务金额", { resolvedAmount, refundableBalance, originalAmount });
  }
  const link = {
    id: nextRecordId((refund.refundLinks || []), "refund-link"),
    originalSourceId,
    amount: resolvedAmount,
    status: "confirmed",
    reason: reason || "关联原业务退款",
    createdAt: resolvedContext.at,
    createdBy: resolvedContext.actor,
  };
  refund.refundLinks = [...(refund.refundLinks || []), link];
  refund.status = Math.abs(refundRemaining - resolvedAmount) <= 0.01 ? "reconciled" : "pending";
  appendAuditEntry(next, {
    action: "reconciliation.refund_link",
    entityType: "bankTransaction",
    entityId: refund.id,
    detail: `${link.reason}，金额 ${resolvedAmount.toFixed(2)}`,
    after: link,
    sourceIds: [refund.id, originalSourceId, link.id],
  }, resolvedContext);
  return next;
}

export function linkInternalTransfer(workspace, { outgoingTransactionId, incomingTransactionId }, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const outgoing = findTransaction(next, outgoingTransactionId);
  const incoming = findTransaction(next, incomingTransactionId);
  const tolerance = accountingRules(next).amountTolerance;
  if (Number(outgoing.amount) >= 0 || Number(incoming.amount) <= 0) {
    throw new AccountingRuleError("TRANSFER_DIRECTION_INVALID", "内部转账必须由一笔转出和一笔转入组成");
  }
  if (outgoing.accountId === incoming.accountId) throw new AccountingRuleError("TRANSFER_ACCOUNT_INVALID", "内部转账的转出和转入账户不能相同");
  if (Math.abs(absoluteAmount(outgoing.amount) - absoluteAmount(incoming.amount)) > tolerance) {
    throw new AccountingRuleError("TRANSFER_AMOUNT_MISMATCH", "内部转账两端金额不一致");
  }
  if (outgoing.internalTransferLink?.status === "confirmed" || incoming.internalTransferLink?.status === "confirmed") {
    throw new AccountingRuleError("TRANSFER_ALREADY_LINKED", "其中一端流水已经完成内部转账配对");
  }
  const linkId = nextRecordId((next.internalTransferLinks || []), "transfer-link");
  const link = {
    id: linkId,
    outgoingTransactionId,
    incomingTransactionId,
    amount: absoluteAmount(outgoing.amount),
    status: "confirmed",
    createdAt: resolvedContext.at,
    createdBy: resolvedContext.actor,
  };
  next.internalTransferLinks = [...(next.internalTransferLinks || []), link];
  outgoing.counterpartTransactionId = incoming.id;
  outgoing.counterpartAccountId = incoming.accountId;
  outgoing.internalTransferLink = link;
  outgoing.status = "reconciled";
  incoming.counterpartTransactionId = outgoing.id;
  incoming.counterpartAccountId = outgoing.accountId;
  incoming.internalTransferLink = link;
  incoming.status = "reconciled";
  appendAuditEntry(next, {
    action: "reconciliation.internal_transfer",
    entityType: "internalTransfer",
    entityId: link.id,
    detail: `${outgoing.accountId} → ${incoming.accountId}，金额 ${link.amount.toFixed(2)}`,
    after: link,
    sourceIds: [outgoing.id, incoming.id, link.id],
  }, resolvedContext);
  return next;
}

function overdueDays(asOf, dueDate) {
  const asOfTime = Date.parse(`${asOf}T00:00:00Z`);
  const dueTime = Date.parse(`${dueDate}T00:00:00Z`);
  if (!Number.isFinite(asOfTime) || !Number.isFinite(dueTime)) return 0;
  return Math.max(0, Math.floor((asOfTime - dueTime) / 86_400_000));
}

function ageingBucket(days) {
  if (days <= 0) return "notDue";
  if (days <= 30) return "days1To30";
  if (days <= 60) return "days31To60";
  if (days <= 90) return "days61To90";
  return "daysOver90";
}

export function buildAgeingSchedule(workspace, { asOf, kind } = {}) {
  const resolvedDate = asOf || `${workspace.currentPeriod}-28`;
  const allowedKinds = kind ? [kind] : [BILL_KINDS.RECEIVABLE, BILL_KINDS.PAYABLE];
  const rows = (workspace.bills || [])
    .filter((bill) => allowedKinds.includes(bill.kind))
    .map((bill) => {
      const settlement = billSettlement(workspace, bill, { asOf: resolvedDate });
      const days = overdueDays(resolvedDate, bill.dueDate || bill.date);
      return {
        billId: bill.id,
        billNo: bill.no,
        kind: bill.kind,
        counterparty: bill.counterparty,
        dueDate: bill.dueDate || bill.date,
        originalAmount: roundMoney(bill.amount),
        settledAmount: settlement.allocated,
        balance: settlement.remaining,
        daysOverdue: days,
        bucket: ageingBucket(days),
        sourceIds: collectSourceIds(bill.id, settlement.transactionIds),
      };
    })
    .filter((row) => row.balance > 0.01);
  const buckets = ["notDue", "days1To30", "days31To60", "days61To90", "daysOver90"].map((bucket) => {
    const bucketRows = rows.filter((row) => row.bucket === bucket);
    return {
      bucket,
      amount: sumMoney(bucketRows.map((row) => row.balance)),
      sourceIds: bucketRows.map((row) => row.billId),
    };
  });
  return {
    asOf: resolvedDate,
    kind: kind || "receivableAndPayable",
    total: sumMoney(rows.map((row) => row.balance)),
    rows,
    buckets,
    excludedKinds: [BILL_KINDS.DEPOSIT_RECEIVED, BILL_KINDS.PREPAYMENT_PAID],
  };
}

export function buildAdvanceBalances(workspace) {
  const rows = (workspace.bills || [])
    .filter((bill) => [BILL_KINDS.DEPOSIT_RECEIVED, BILL_KINDS.PREPAYMENT_PAID].includes(bill.kind))
    .map((bill) => {
      const settlement = billSettlement(workspace, bill);
      return {
        billId: bill.id,
        billNo: bill.no,
        kind: bill.kind,
        counterparty: bill.counterparty,
        originalAmount: roundMoney(bill.amount),
        fundedAmount: settlement.allocated,
        pendingFunding: settlement.remaining,
        sourceIds: collectSourceIds(bill.id, settlement.transactionIds),
      };
    });
  return {
    depositsReceived: sumMoney(rows.filter((row) => row.kind === BILL_KINDS.DEPOSIT_RECEIVED).map((row) => row.fundedAmount)),
    prepaymentsPaid: sumMoney(rows.filter((row) => row.kind === BILL_KINDS.PREPAYMENT_PAID).map((row) => row.fundedAmount)),
    rows,
  };
}
