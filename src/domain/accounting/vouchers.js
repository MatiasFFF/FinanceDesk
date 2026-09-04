import {
  AccountingRuleError,
  BILL_KINDS,
  EVENT_TYPES,
  accountingRules,
  absoluteAmount,
  activeAllocations,
  appendAuditEntry,
  cloneAccountingState,
  collectSourceIds,
  nextRecordId,
  operationContext,
  roundMoney,
  sumMoney,
} from "./model.js";
import { classifyBankTransaction } from "./classification.js";
import {
  assessTransactionEvidence,
  unresolvedExceptionTasks,
} from "../../features/evidence/evidenceEngine.js";

function findTransaction(workspace, transactionId) {
  const transaction = (workspace.transactions || []).find((item) => item.id === transactionId);
  if (!transaction) throw new AccountingRuleError("TRANSACTION_NOT_FOUND", `找不到银行流水：${transactionId}`);
  return transaction;
}

function findVoucher(workspace, voucherId) {
  const voucher = (workspace.vouchers || []).find((item) => item.id === voucherId);
  if (!voucher) throw new AccountingRuleError("VOUCHER_NOT_FOUND", `找不到凭证：${voucherId}`);
  return voucher;
}

function findBill(workspace, billId) {
  return (workspace.bills || []).find((item) => item.id === billId);
}

function voucherAccountForBill(bill) {
  return {
    [BILL_KINDS.RECEIVABLE]: "receivable",
    [BILL_KINDS.PAYABLE]: "payable",
    [BILL_KINDS.DEPOSIT_RECEIVED]: "contractLiability",
    [BILL_KINDS.PREPAYMENT_PAID]: "prepayment",
  }[bill?.kind];
}

function postedSourceIds(workspace) {
  return new Set((workspace.vouchers || [])
    .filter((voucher) => ["posted", "draft", "changes_requested"].includes(voucher.status))
    .flatMap((voucher) => voucher.sourceIds || []));
}

function aggregateLines(lines) {
  const grouped = new Map();
  lines.forEach((line) => {
    const key = `${line.account}|${line.auxiliaryId || ""}`;
    const current = grouped.get(key) || {
      account: line.account,
      auxiliaryId: line.auxiliaryId || null,
      debit: 0,
      credit: 0,
      sourceIds: [],
    };
    current.debit = roundMoney(current.debit + Number(line.debit || 0));
    current.credit = roundMoney(current.credit + Number(line.credit || 0));
    current.sourceIds = collectSourceIds(current.sourceIds, line.sourceIds || []);
    grouped.set(key, current);
  });
  return [...grouped.values()].filter((line) => line.debit || line.credit);
}

function billAllocationLines(workspace, transaction, availableAllocations) {
  const incoming = Number(transaction.amount) >= 0;
  const counterLines = availableAllocations.map((allocation) => {
    const bill = findBill(workspace, allocation.billId);
    if (!bill) throw new AccountingRuleError("BILL_NOT_FOUND", `找不到核销对应账单：${allocation.billId}`);
    const account = voucherAccountForBill(bill);
    if (!account) throw new AccountingRuleError("UNSUPPORTED_BILL_KIND", `暂不支持账单类型：${bill.kind}`);
    return {
      account,
      auxiliaryId: bill.counterparty || null,
      debit: incoming ? 0 : allocation.amount,
      credit: incoming ? allocation.amount : 0,
      sourceIds: [bill.id, allocation.id],
    };
  });
  const total = sumMoney(availableAllocations.map((allocation) => allocation.amount));
  return aggregateLines([
    {
      account: transaction.accountId || "bank",
      debit: incoming ? total : 0,
      credit: incoming ? 0 : total,
      sourceIds: [transaction.id],
    },
    ...counterLines,
  ]);
}

function directTransactionLines(workspace, transaction, classification) {
  const amount = absoluteAmount(transaction.amount);
  const incoming = Number(transaction.amount) >= 0;
  if (classification.eventType === EVENT_TYPES.INTERNAL_TRANSFER) {
    if (incoming) throw new AccountingRuleError("TRANSFER_SOURCE_REQUIRED", "内部转账凭证应从转出流水生成，避免重复入账");
    const targetAccount = classification.counterpartAccountId || transaction.counterpartAccountId;
    if (!targetAccount) throw new AccountingRuleError("TRANSFER_COUNTERPART_REQUIRED", "内部转账缺少转入账户");
    return [
      { account: targetAccount, debit: amount, credit: 0, sourceIds: collectSourceIds(transaction.counterpartTransactionId) },
      { account: transaction.accountId || "bank", debit: 0, credit: amount, sourceIds: [transaction.id] },
    ];
  }
  const counterAccount = transaction.directAccount || classification.account;
  if (!counterAccount || classification.eventType === EVENT_TYPES.UNKNOWN) {
    throw new AccountingRuleError("ACCOUNTING_JUDGEMENT_REQUIRED", "业务性质或会计科目尚未确认，不能生成凭证草稿");
  }
  return aggregateLines([
    {
      account: transaction.accountId || "bank",
      debit: incoming ? amount : 0,
      credit: incoming ? 0 : amount,
      sourceIds: [transaction.id],
    },
    {
      account: counterAccount,
      debit: incoming ? 0 : amount,
      credit: incoming ? amount : 0,
      sourceIds: collectSourceIds(transaction.id, (transaction.refundLinks || []).map((item) => item.originalSourceId)),
    },
  ]);
}

export function validateVoucherBalance(voucher, tolerance = 0.01) {
  const debit = sumMoney((voucher.lines || []).map((line) => line.debit));
  const credit = sumMoney((voucher.lines || []).map((line) => line.credit));
  const difference = roundMoney(debit - credit);
  const errors = [];
  if (!(voucher.lines || []).length) errors.push("凭证没有分录");
  (voucher.lines || []).forEach((line, index) => {
    if (Number(line.debit || 0) < 0 || Number(line.credit || 0) < 0) errors.push(`第 ${index + 1} 行借贷金额不能为负数`);
    if (Number(line.debit || 0) > 0 && Number(line.credit || 0) > 0) errors.push(`第 ${index + 1} 行不能同时有借方和贷方`);
    if (!line.account) errors.push(`第 ${index + 1} 行缺少会计科目`);
  });
  if (Math.abs(difference) > tolerance) errors.push(`借贷不平，差额 ${difference.toFixed(2)}`);
  return { balanced: errors.length === 0, debit, credit, difference, errors };
}

function evidenceAndSources(workspace, transaction, allocations) {
  const bills = allocations.map((allocation) => findBill(workspace, allocation.billId)).filter(Boolean);
  return {
    sourceIds: collectSourceIds(
      transaction.id,
      transaction.counterpartTransactionId,
      allocations.map((allocation) => [allocation.id, allocation.billId]),
      (transaction.refundLinks || []).map((link) => [link.id, link.originalSourceId]),
    ),
    evidenceIds: collectSourceIds(
      transaction.evidenceIds || [],
      bills.map((bill) => bill.evidenceIds || []),
    ),
  };
}

function voucherSnapshot(voucher, context, reason) {
  return {
    version: voucher.version,
    at: context.at,
    actor: context.actor,
    reason,
    summary: voucher.summary,
    lines: structuredClone(voucher.lines || []),
    evidenceIds: [...(voucher.evidenceIds || [])],
    status: voucher.status,
  };
}

export function createVoucherDraft(workspace, { transactionId, summary, note = "" }, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const transaction = findTransaction(next, transactionId);
  const classification = transaction.classification || classifyBankTransaction(next, transaction);
  const assessment = transaction.evidenceAssessment || assessTransactionEvidence(next, transaction, classification);
  const usedSources = postedSourceIds(next);
  const allocations = activeAllocations(transaction).filter((allocation) => (
    allocation.status !== "suspected" && !usedSources.has(allocation.id)
  ));

  let lines;
  if (allocations.length) {
    lines = billAllocationLines(next, transaction, allocations);
  } else {
    if (activeAllocations(transaction).length && activeAllocations(transaction).every((allocation) => usedSources.has(allocation.id))) {
      throw new AccountingRuleError("SOURCE_ALREADY_VOUCHERED", "这笔流水的有效核销已经生成凭证");
    }
    if (usedSources.has(transaction.id)) throw new AccountingRuleError("SOURCE_ALREADY_VOUCHERED", "这笔流水已经生成凭证");
    lines = directTransactionLines(next, transaction, classification);
  }

  const validation = validateVoucherBalance({ lines }, accountingRules(next).amountTolerance);
  if (!validation.balanced) throw new AccountingRuleError("VOUCHER_UNBALANCED", validation.errors.join("；"), validation);
  const trace = evidenceAndSources(next, transaction, allocations);
  const voucherId = nextRecordId(next.vouchers || [], "voucher");
  const voucher = {
    id: voucherId,
    no: null,
    date: transaction.date,
    period: String(transaction.date || "").slice(0, 7),
    summary: summary || transaction.summary || `处理${transaction.counterparty || "银行流水"}`,
    status: "draft",
    version: 1,
    lines,
    sourceIds: trace.sourceIds,
    evidenceIds: trace.evidenceIds,
    judgement: {
      eventType: classification.eventType,
      confidence: classification.confidence,
      reasons: classification.reasons,
      note,
      ruleSource: classification.source,
    },
    blockers: assessment.issues,
    createdAt: resolvedContext.at,
    createdBy: resolvedContext.actor,
    reviews: [],
    versions: [],
  };
  voucher.versions.push(voucherSnapshot(voucher, resolvedContext, "创建凭证草稿"));
  next.vouchers = [...(next.vouchers || []), voucher];
  appendAuditEntry(next, {
    action: "voucher.create_draft",
    entityType: "voucher",
    entityId: voucher.id,
    detail: `${voucher.summary}；借贷各 ${validation.debit.toFixed(2)}`,
    after: { status: voucher.status, version: voucher.version, validation },
    sourceIds: collectSourceIds(voucher.id, voucher.sourceIds, voucher.evidenceIds),
  }, resolvedContext);
  return next;
}

function sourceTransactionsForVoucher(workspace, voucher) {
  const direct = (workspace.transactions || []).filter((transaction) => voucher.sourceIds?.includes(transaction.id));
  const allocationTransactionIds = (workspace.transactions || []).flatMap((transaction) => (
    (transaction.allocations || []).some((allocation) => voucher.sourceIds?.includes(allocation.id)) ? [transaction.id] : []
  ));
  return (workspace.transactions || []).filter((transaction) => (
    direct.some((item) => item.id === transaction.id) || allocationTransactionIds.includes(transaction.id)
  ));
}

function ensurePostingAllowed(workspace, voucher, mode) {
  const transactions = sourceTransactionsForVoucher(workspace, voucher);
  const unresolved = transactions.flatMap((transaction) => unresolvedExceptionTasks(workspace, transaction.id));
  if (unresolved.length) {
    throw new AccountingRuleError("UNRESOLVED_EXCEPTION", "凭证来源仍有未解决异常", {
      exceptionIds: unresolved.map((task) => task.id),
    });
  }
  const rules = accountingRules(workspace);
  transactions.forEach((transaction) => {
    const classification = transaction.classification || classifyBankTransaction(workspace, transaction);
    const assessment = transaction.evidenceAssessment || assessTransactionEvidence(workspace, transaction, classification);
    if (mode === "automatic" && (
      classification.confidence < rules.automaticPostingThreshold || !assessment.canAutomaticallyPost
    )) {
      throw new AccountingRuleError("AUTOMATIC_POSTING_BLOCKED", "低置信度或证据不完整的事项不得自动入账", {
        transactionId: transaction.id,
        confidence: classification.confidence,
        completeness: assessment.completeness,
      });
    }
    if (mode !== "automatic" && classification.confidence < rules.confidenceThreshold && transaction.manualConfirmation?.decision !== "approve") {
      throw new AccountingRuleError("MANUAL_CONFIRMATION_REQUIRED", "低置信度事项必须先完成有依据的人工确认", {
        transactionId: transaction.id,
        confidence: classification.confidence,
      });
    }
  });
}

function nextVoucherNumber(workspace, voucher) {
  const period = voucher.period || String(voucher.date).slice(0, 7);
  const count = (workspace.vouchers || []).filter((item) => (
    item.id !== voucher.id && item.status === "posted" && (item.period || String(item.date).slice(0, 7)) === period
  )).length;
  return `记-${String(count + 1).padStart(3, "0")}`;
}

export function postVoucher(workspace, { voucherId, reviewNote, mode = "manual" }, context = {}) {
  if (mode !== "automatic" && !reviewNote?.trim()) throw new AccountingRuleError("REVIEW_NOTE_REQUIRED", "人工入账必须填写复核意见");
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext({ ...context, mode });
  const voucher = findVoucher(next, voucherId);
  if (!["draft", "changes_requested"].includes(voucher.status)) {
    throw new AccountingRuleError("VOUCHER_NOT_POSTABLE", `当前状态不能入账：${voucher.status}`);
  }
  const validation = validateVoucherBalance(voucher, accountingRules(next).amountTolerance);
  if (!validation.balanced) throw new AccountingRuleError("VOUCHER_UNBALANCED", validation.errors.join("；"), validation);
  ensurePostingAllowed(next, voucher, mode);
  const before = { status: voucher.status, version: voucher.version };
  const review = {
    id: nextRecordId(voucher.reviews || [], "review"),
    at: resolvedContext.at,
    actor: resolvedContext.actor,
    decision: "approve",
    note: reviewNote?.trim() || "本地规则自动入账条件全部满足",
    mode,
  };
  voucher.reviews = [...(voucher.reviews || []), review];
  voucher.status = "posted";
  voucher.no = voucher.no || nextVoucherNumber(next, voucher);
  voucher.postedAt = resolvedContext.at;
  voucher.postedBy = resolvedContext.actor;
  voucher.versions = [...(voucher.versions || []), voucherSnapshot(voucher, resolvedContext, "凭证入账")];
  if (voucher.revisionOf) {
    const original = findVoucher(next, voucher.revisionOf);
    original.status = "superseded";
    original.supersededBy = voucher.id;
    original.supersededAt = resolvedContext.at;
  }
  appendAuditEntry(next, {
    action: "voucher.post",
    entityType: "voucher",
    entityId: voucher.id,
    detail: `${voucher.no} ${voucher.summary}；${review.note}`,
    before,
    after: { status: voucher.status, version: voucher.version, review },
    sourceIds: collectSourceIds(voucher.id, voucher.sourceIds, voucher.evidenceIds),
  }, resolvedContext);
  return next;
}

export function reviewVoucher(workspace, { voucherId, decision, note }, context = {}) {
  if (!["approve", "reject"].includes(decision)) throw new AccountingRuleError("INVALID_REVIEW_DECISION", "复核结果只能是 approve 或 reject");
  if (!note?.trim()) throw new AccountingRuleError("REVIEW_NOTE_REQUIRED", "复核必须填写意见");
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const voucher = findVoucher(next, voucherId);
  const review = {
    id: nextRecordId(voucher.reviews || [], "review"),
    at: resolvedContext.at,
    actor: resolvedContext.actor,
    decision,
    note: note.trim(),
    mode: "manual",
  };
  voucher.reviews = [...(voucher.reviews || []), review];
  if (decision === "reject") voucher.status = "changes_requested";
  appendAuditEntry(next, {
    action: `voucher.review_${decision}`,
    entityType: "voucher",
    entityId: voucher.id,
    detail: review.note,
    after: review,
    sourceIds: collectSourceIds(voucher.id, voucher.sourceIds),
  }, resolvedContext);
  return next;
}

export function reviseDraftVoucher(workspace, { voucherId, summary, lines, evidenceIds, reason }, context = {}) {
  if (!reason?.trim()) throw new AccountingRuleError("REVISION_REASON_REQUIRED", "修改凭证必须填写原因");
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const voucher = findVoucher(next, voucherId);
  if (voucher.status === "posted") throw new AccountingRuleError("POSTED_VOUCHER_IMMUTABLE", "已入账凭证不能直接覆盖，请创建修订版");
  if (voucher.status === "superseded") throw new AccountingRuleError("SUPERSEDED_VOUCHER_IMMUTABLE", "已被替代的凭证不能修改");
  const before = voucherSnapshot(voucher, resolvedContext, reason);
  if (summary != null) voucher.summary = summary;
  if (lines != null) voucher.lines = aggregateLines(lines);
  if (evidenceIds != null) voucher.evidenceIds = collectSourceIds(evidenceIds);
  const validation = validateVoucherBalance(voucher, accountingRules(next).amountTolerance);
  if (!validation.balanced) throw new AccountingRuleError("VOUCHER_UNBALANCED", validation.errors.join("；"), validation);
  voucher.version += 1;
  voucher.status = "draft";
  voucher.updatedAt = resolvedContext.at;
  voucher.updatedBy = resolvedContext.actor;
  voucher.versions = [...(voucher.versions || []), before, voucherSnapshot(voucher, resolvedContext, reason.trim())];
  appendAuditEntry(next, {
    action: "voucher.revise",
    entityType: "voucher",
    entityId: voucher.id,
    detail: reason.trim(),
    before: { version: before.version, summary: before.summary, lines: before.lines },
    after: { version: voucher.version, summary: voucher.summary, lines: voucher.lines },
    sourceIds: collectSourceIds(voucher.id, voucher.sourceIds, voucher.evidenceIds),
  }, resolvedContext);
  return next;
}

export function createPostedVoucherRevision(workspace, { voucherId, reason }, context = {}) {
  if (!reason?.trim()) throw new AccountingRuleError("REVISION_REASON_REQUIRED", "创建修订版必须填写原因");
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const original = findVoucher(next, voucherId);
  if (original.status !== "posted") throw new AccountingRuleError("POSTED_VOUCHER_REQUIRED", "只有已入账凭证需要创建独立修订版");
  const revision = {
    ...cloneAccountingState(original),
    id: nextRecordId(next.vouchers || [], "voucher"),
    no: null,
    status: "draft",
    version: Number(original.version || 1) + 1,
    revisionOf: original.id,
    revisionReason: reason.trim(),
    createdAt: resolvedContext.at,
    createdBy: resolvedContext.actor,
    postedAt: null,
    postedBy: null,
    supersededBy: null,
    reviews: [],
    versions: [voucherSnapshot(original, resolvedContext, "修订前已入账版本")],
  };
  next.vouchers.push(revision);
  appendAuditEntry(next, {
    action: "voucher.create_revision",
    entityType: "voucher",
    entityId: revision.id,
    detail: `${reason.trim()}；原凭证 ${original.no || original.id}`,
    after: { revisionOf: original.id, version: revision.version },
    sourceIds: collectSourceIds(original.id, revision.id, revision.sourceIds),
  }, resolvedContext);
  return next;
}

export function buildAttachmentPackage(workspace, voucherId) {
  const voucher = findVoucher(workspace, voucherId);
  const documents = (workspace.documents || []).filter((document) => voucher.evidenceIds?.includes(document.id));
  const transactions = sourceTransactionsForVoucher(workspace, voucher);
  const assessments = transactions.map((transaction) => (
    transaction.evidenceAssessment || assessTransactionEvidence(
      workspace,
      transaction,
      transaction.classification || classifyBankTransaction(workspace, transaction),
    )
  ));
  const missing = assessments.flatMap((assessment) => assessment.missing).filter((item, index, all) => (
    all.findIndex((candidate) => candidate.id === item.id) === index
  ));
  return {
    voucherId: voucher.id,
    voucherNo: voucher.no,
    version: voucher.version,
    status: missing.length ? "incomplete" : "complete",
    manifest: [
      ...transactions.map((transaction) => ({ kind: "银行流水", id: transaction.id, name: `${transaction.date} ${transaction.counterparty}`, sourceIds: [transaction.id] })),
      ...documents.map((document) => ({ kind: document.type || "资料", id: document.id, name: document.name || document.title || document.id, sourceIds: [document.id] })),
      { kind: "业务匹配说明", id: `${voucher.id}-judgement`, name: voucher.judgement?.reasons?.join("；") || voucher.summary, sourceIds: voucher.sourceIds || [] },
      ...(voucher.reviews || []).map((review) => ({ kind: "人工复核记录", id: review.id, name: `${review.actor}：${review.note}`, sourceIds: [voucher.id] })),
    ],
    missing,
    sourceIds: collectSourceIds(voucher.id, voucher.sourceIds, voucher.evidenceIds),
  };
}

export function vouchersForSource(workspace, sourceId) {
  return (workspace.vouchers || []).filter((voucher) => (
    voucher.sourceIds?.includes(sourceId) || voucher.evidenceIds?.includes(sourceId) ||
    (voucher.lines || []).some((line) => line.sourceIds?.includes(sourceId))
  ));
}

export function traceVoucherSources(workspace, voucherId) {
  const voucher = findVoucher(workspace, voucherId);
  const transactions = sourceTransactionsForVoucher(workspace, voucher);
  const allocations = transactions.flatMap((transaction) => (
    (transaction.allocations || []).filter((allocation) => voucher.sourceIds?.includes(allocation.id))
  ));
  const billIds = collectSourceIds(
    allocations.map((allocation) => allocation.billId),
    (workspace.bills || []).filter((bill) => voucher.sourceIds?.includes(bill.id)).map((bill) => bill.id),
  );
  const bills = (workspace.bills || []).filter((bill) => billIds.includes(bill.id));
  const events = (workspace.businessEvents || []).filter((event) => (
    voucher.sourceIds?.includes(event.id) || (event.sourceIds || []).some((id) => voucher.sourceIds?.includes(id))
  ));
  const documents = (workspace.documents || []).filter((document) => voucher.evidenceIds?.includes(document.id));
  const audit = (workspace.auditLog || []).filter((entry) => (
    entry.entityId === voucher.id || (entry.sourceIds || []).some((id) => voucher.sourceIds?.includes(id))
  ));
  return {
    voucher,
    transactions,
    allocations,
    bills,
    businessEvents: events,
    documents,
    reviews: voucher.reviews || [],
    versions: voucher.versions || [],
    audit,
    sourceIds: collectSourceIds(voucher.id, voucher.sourceIds, voucher.evidenceIds),
  };
}
