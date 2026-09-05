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
import {
  effectiveBankTransactionClassification,
  memberBusinessEnabled,
  resolveWorkspaceAccountDefinition,
} from "./classification.js";
import {
  assessTransactionEvidence,
  unresolvedExceptionTasks,
} from "../../features/evidence/evidenceEngine.js";
import {
  MEMBER_EVENT_DEFINITIONS,
  MEMBER_EVENT_KINDS,
  isRecognizedMemberEvent,
  memberEventKind,
  memberEventStatusLabel,
  synchronizeMemberServiceException,
} from "../../features/members/memberLedger.js";

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

function findBusinessEvent(workspace, eventId) {
  const event = (workspace.businessEvents || []).find((item) => item.id === eventId);
  if (!event) throw new AccountingRuleError("BUSINESS_EVENT_NOT_FOUND", `找不到业务事件：${eventId}`);
  return event;
}

function findAdvanceApplication(workspace, applicationId) {
  const application = (workspace.advanceApplications || []).find((item) => item.id === applicationId);
  if (!application) throw new AccountingRuleError("ADVANCE_APPLICATION_NOT_FOUND", `找不到预收/预付冲销关系：${applicationId}`);
  return application;
}

const VOUCHER_EVENT_LABELS = Object.freeze({
  [EVENT_TYPES.CUSTOMER_RECEIPT]: "客户收款",
  [EVENT_TYPES.SUPPLIER_SETTLEMENT]: "供应商付款",
  [EVENT_TYPES.SUPPLIER_PREPAYMENT]: "供应商预付",
  [EVENT_TYPES.PURCHASE_EXPENSE]: "采购或费用支出",
  [EVENT_TYPES.PAYROLL]: "工资社保支出",
  [EVENT_TYPES.RENT_AND_PROPERTY]: "房租物业支出",
  [EVENT_TYPES.BANK_FEE]: "银行手续费",
  [EVENT_TYPES.LOAN]: "借款往来",
  [EVENT_TYPES.EMPLOYEE_ADVANCE]: "员工代垫",
  [EVENT_TYPES.RELATED_PARTY]: "关联方往来",
  [EVENT_TYPES.REFUND]: "退款",
  [EVENT_TYPES.INTERNAL_TRANSFER]: "内部转账",
});

function resolvedVoucherAccount(workspace, accountValue, errorCode = "VOUCHER_ACCOUNT_INVALID") {
  const account = resolveWorkspaceAccountDefinition(workspace, accountValue, { allowInactive: false });
  if (!account) {
    throw new AccountingRuleError(errorCode, `当前科目表中找不到可用科目：${accountValue || "未选择"}`);
  }
  return account;
}

function effectiveEvidenceAssessment(workspace, transaction, classification) {
  return assessTransactionEvidence(workspace, transaction, classification);
}

function memberScopedEvent(event) {
  return event?.sourceType === "memberEvent"
    || event?.businessType === "memberRecharge"
    || [EVENT_TYPES.MEMBER_RECHARGE, EVENT_TYPES.MEMBER_CONSUMPTION].includes(event?.eventType);
}

function defaultVoucherSummary(workspace, transaction, classification, lines, label) {
  const bankAccount = transaction.accountId || "bank";
  const counterLine = (lines || []).find((line) => line.account !== bankAccount);
  const accountLabel = resolveWorkspaceAccountDefinition(
    workspace,
    counterLine?.account || classification.account,
  )?.label || classification.accountLabel || counterLine?.account || classification.account;
  const subject = transaction.counterparty || transaction.summary || "银行流水";
  return `${label || VOUCHER_EVENT_LABELS[classification.eventType] || "银行流水处理"} · ${subject}${accountLabel ? ` · ${accountLabel}` : ""}`;
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

function voucherLineDimension(line, ...names) {
  for (const name of names) {
    const value = line?.[name] ?? line?.dimensions?.[name];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}

function aggregateLines(lines) {
  const grouped = new Map();
  lines.forEach((line) => {
    const direction = Number(line.debit || 0) > 0 ? "debit" : Number(line.credit || 0) > 0 ? "credit" : "empty";
    const rawTaxAmount = line.taxAmount;
    const taxAmount = rawTaxAmount == null || String(rawTaxAmount).trim() === "" || !Number.isFinite(Number(rawTaxAmount))
      ? null
      : roundMoney(rawTaxAmount);
    const dimensions = {
      auxiliaryId: voucherLineDimension(line, "auxiliaryId", "counterpartyId"),
      auxiliaryLabel: voucherLineDimension(line, "auxiliaryLabel", "counterparty", "counterpartyName"),
      auxiliaryType: voucherLineDimension(line, "auxiliaryType", "counterpartyType"),
      storeId: voucherLineDimension(line, "storeId", "locationId"),
      storeName: voucherLineDimension(line, "storeName", "store", "locationName"),
      department: voucherLineDimension(line, "department", "departmentName"),
      project: voucherLineDimension(line, "project", "projectName"),
    };
    const key = JSON.stringify([
      line.account,
      dimensions.auxiliaryId,
      dimensions.auxiliaryLabel,
      dimensions.auxiliaryType,
      dimensions.storeId,
      dimensions.storeName,
      dimensions.department,
      dimensions.project,
      direction,
    ]);
    const current = grouped.get(key) || {
      account: line.account,
      ...dimensions,
      debit: 0,
      credit: 0,
      taxAmount: null,
      sourceIds: [],
    };
    current.debit = roundMoney(current.debit + Number(line.debit || 0));
    current.credit = roundMoney(current.credit + Number(line.credit || 0));
    if (taxAmount != null) current.taxAmount = roundMoney(Number(current.taxAmount || 0) + taxAmount);
    current.sourceIds = collectSourceIds(current.sourceIds, line.sourceIds || []);
    grouped.set(key, current);
  });
  return [...grouped.values()].filter((line) => line.debit || line.credit);
}

function voucherLineAccountMetadata(workspace, lines = []) {
  const accountsById = new Map();
  lines.forEach((line, lineIndex) => {
    const accountId = String(line.account || "").trim();
    if (!accountId) return;
    const definition = resolveWorkspaceAccountDefinition(workspace, accountId);
    const current = accountsById.get(accountId) || {
      account: accountId,
      accountLabel: definition?.label || accountId,
      category: definition?.category || "other",
      cash: Boolean(definition?.cash),
      debit: 0,
      credit: 0,
      lineCount: 0,
      lineIndexes: [],
      auxiliaryIds: [],
      sourceIds: [],
    };
    current.debit = roundMoney(current.debit + Number(line.debit || 0));
    current.credit = roundMoney(current.credit + Number(line.credit || 0));
    current.lineCount += 1;
    current.lineIndexes.push(lineIndex);
    current.auxiliaryIds = collectSourceIds(current.auxiliaryIds, line.auxiliaryId);
    current.sourceIds = collectSourceIds(current.sourceIds, line.sourceIds || []);
    accountsById.set(accountId, current);
  });

  const lineAccounts = [...accountsById.values()];
  const businessAccounts = lineAccounts.filter((account) => !account.cash);
  const primaryAccount = businessAccounts.length === 1 ? businessAccounts[0] : null;
  const accountMode = primaryAccount
    ? "single_business_account"
    : businessAccounts.length > 1
      ? "multiple_business_accounts"
      : lineAccounts.length
        ? "cash_only"
        : "empty";
  return {
    account: primaryAccount?.account || null,
    accountLabel: primaryAccount?.accountLabel || null,
    accountMode,
    lineAccounts,
  };
}

function originalVoucherAccountJudgement(judgement = {}) {
  const accountingAttributes = structuredClone(judgement.accountingAttributes || {});
  const account = judgement.account ?? accountingAttributes.primaryAccount ?? null;
  return {
    account,
    accountLabel: judgement.accountLabel ?? accountingAttributes.primaryAccountLabel ?? account,
    accountingAttributes,
  };
}

function synchronizeVoucherJudgementAccounts(workspace, voucher, context, reason) {
  const judgement = voucher.judgement || {};
  const originalAccountJudgement = judgement.originalAccountJudgement
    ? structuredClone(judgement.originalAccountJudgement)
    : originalVoucherAccountJudgement(judgement);
  const current = voucherLineAccountMetadata(workspace, voucher.lines || []);
  const lineAccounts = structuredClone(current.lineAccounts);
  const accountingAttributes = {
    ...(judgement.accountingAttributes || {}),
    primaryAccount: current.account,
    primaryAccountLabel: current.accountLabel,
    accountMode: current.accountMode,
    lineAccounts,
  };

  voucher.judgement = {
    ...judgement,
    originalAccountJudgement,
    account: current.account,
    accountLabel: current.accountLabel,
    accountMode: current.accountMode,
    lineAccounts,
    accountingAttributes,
    accountSync: {
      source: "voucher.lines",
      version: voucher.version,
      at: context.at,
      actor: context.actor,
      reason: String(reason || "同步凭证分录科目").trim(),
    },
  };
  if (voucher.accountingAttributes) {
    voucher.accountingAttributes = {
      ...voucher.accountingAttributes,
      primaryAccount: current.account,
      primaryAccountLabel: current.accountLabel,
      accountMode: current.accountMode,
      lineAccounts: structuredClone(lineAccounts),
    };
  }
}

function advanceApplicationVoucherLines(workspace, application) {
  const advanceBill = findBill(workspace, application.advanceBillId);
  const targetBill = findBill(workspace, application.targetBillId);
  if (!advanceBill || !targetBill) {
    throw new AccountingRuleError("ADVANCE_APPLICATION_SOURCE_MISSING", "预收/预付冲销缺少来源账单或目标账单");
  }
  const amount = roundMoney(application.amount);
  if (advanceBill.kind === BILL_KINDS.DEPOSIT_RECEIVED && targetBill.kind === BILL_KINDS.RECEIVABLE) {
    return aggregateLines([
      { account: "contractLiability", auxiliaryId: advanceBill.counterparty, debit: amount, credit: 0, sourceIds: [advanceBill.id, application.id] },
      { account: "receivable", auxiliaryId: targetBill.counterparty, debit: 0, credit: amount, sourceIds: [targetBill.id, application.id] },
    ]);
  }
  if (advanceBill.kind === BILL_KINDS.PREPAYMENT_PAID && targetBill.kind === BILL_KINDS.PAYABLE) {
    return aggregateLines([
      { account: "payable", auxiliaryId: targetBill.counterparty, debit: amount, credit: 0, sourceIds: [targetBill.id, application.id] },
      { account: "prepayment", auxiliaryId: advanceBill.counterparty, debit: 0, credit: amount, sourceIds: [advanceBill.id, application.id] },
    ]);
  }
  throw new AccountingRuleError("ADVANCE_APPLICATION_KIND_MISMATCH", "预收只能冲应收，预付只能冲应付");
}

function memberEventVoucherLines(workspace, event) {
  if (!memberBusinessEnabled(workspace)) {
    throw new AccountingRuleError("MEMBER_MODULE_DISABLED", "当前工作台未启用会员模块，不能生成会员业务凭证");
  }
  const kind = memberEventKind(event);
  const amount = absoluteAmount(event.amount);
  const sourceIds = [event.id];
  const bankAccount = event.bankAccountId
    || workspace.bankAccounts?.[0]?.id
    || workspace.accounts?.[0]?.id
    || "bank";
  const entries = {
    [MEMBER_EVENT_KINDS.RECHARGE]: [
      { account: bankAccount, debit: amount, credit: 0, sourceIds },
      { account: "contractLiability", debit: 0, credit: amount, sourceIds },
    ],
    [MEMBER_EVENT_KINDS.CONSUMPTION]: [
      { account: "contractLiability", debit: amount, credit: 0, sourceIds },
      { account: "revenuePrivate", debit: 0, credit: amount, sourceIds },
    ],
    [MEMBER_EVENT_KINDS.REFUND]: [
      { account: "contractLiability", debit: amount, credit: 0, sourceIds },
      { account: bankAccount, debit: 0, credit: amount, sourceIds },
    ],
    [MEMBER_EVENT_KINDS.COMMISSION]: [
      { account: "expenseCommission", debit: amount, credit: 0, sourceIds },
      { account: "payrollPayable", debit: 0, credit: amount, sourceIds },
    ],
    [MEMBER_EVENT_KINDS.COMMISSION_PAYMENT]: [
      { account: "payrollPayable", debit: amount, credit: 0, sourceIds },
      { account: bankAccount, debit: 0, credit: amount, sourceIds },
    ],
  }[kind];
  if (!entries) throw new AccountingRuleError("UNSUPPORTED_MEMBER_EVENT", "该会员业务暂不支持生成会计凭证");
  return aggregateLines(entries);
}

export function vouchersForMemberEvent(workspace, eventOrId) {
  const event = typeof eventOrId === "string"
    ? (workspace.businessEvents || []).find((item) => item.id === eventOrId)
    : eventOrId;
  if (!event) return [];
  const sourceIds = new Set(collectSourceIds(event.id, event.billId));
  return (workspace.vouchers || []).filter((voucher) => (
    (voucher.sourceIds || []).some((sourceId) => sourceIds.has(sourceId))
    || (voucher.lines || []).some((line) => (line.sourceIds || []).some((sourceId) => sourceIds.has(sourceId)))
  ));
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
  const classificationOwnsAccount = [
    "workspace-rule",
    "manual-confirmation",
    "manual-business-event",
    "manual-business-event-reviewed",
  ].includes(classification.source);
  const counterAccount = classificationOwnsAccount
    ? classification.account
    : (transaction.directAccount || classification.account);
  if (!counterAccount || classification.eventType === EVENT_TYPES.UNKNOWN) {
    throw new AccountingRuleError("ACCOUNTING_JUDGEMENT_REQUIRED", "业务性质或会计科目尚未确认，不能生成凭证草稿");
  }
  const resolvedCounterAccount = resolvedVoucherAccount(workspace, counterAccount, "ACCOUNTING_JUDGEMENT_REQUIRED");
  return aggregateLines([
    {
      account: transaction.accountId || "bank",
      debit: incoming ? amount : 0,
      credit: incoming ? 0 : amount,
      sourceIds: [transaction.id],
    },
    {
      account: resolvedCounterAccount.id,
      debit: incoming ? 0 : amount,
      credit: incoming ? amount : 0,
      sourceIds: collectSourceIds(transaction.id, (transaction.refundLinks || []).map((item) => item.originalSourceId)),
    },
  ]);
}

const HIGH_RISK_BANK_BUSINESS_TYPES = new Set([
  "loanBorrowing",
  "loanRepayment",
  "employeeAdvance",
  "relatedParty",
  "refund",
  "internalTransfer",
]);

function findBankBusinessEvent(workspace, eventId) {
  const event = findBusinessEvent(workspace, eventId);
  if (event.sourceType !== "bankTransaction" || !event.transactionId) {
    throw new AccountingRuleError("NOT_A_BANK_BUSINESS_EVENT", "该业务事件不是银行流水人工确认事件");
  }
  return event;
}

function bankBusinessEventVoucherLines(workspace, event, transaction) {
  const amount = absoluteAmount(transaction.amount);
  if (Math.abs(amount - absoluteAmount(event.amount)) > accountingRules(workspace).amountTolerance) {
    throw new AccountingRuleError("BUSINESS_EVENT_AMOUNT_MISMATCH", "业务事件金额与银行流水金额不一致，必须重新确认");
  }
  const taxAttributes = structuredClone(event.taxAttributes || {});
  const withEventAttributes = (lines) => lines.map((line) => ({
    ...line,
    businessEventId: event.id,
    taxAttributes,
  }));

  if (event.businessType === "internalTransfer") {
    const related = findTransaction(workspace, event.counterpartTransactionId || event.relatedTransactionId);
    const outgoing = Number(transaction.amount) < 0 ? transaction : related;
    const incoming = Number(transaction.amount) > 0 ? transaction : related;
    if (Number(outgoing.amount) >= 0 || Number(incoming.amount) <= 0) {
      throw new AccountingRuleError("TRANSFER_DIRECTION_INVALID", "内部转账必须由一笔转出和一笔转入组成");
    }
    if (outgoing.accountId === incoming.accountId) {
      throw new AccountingRuleError("TRANSFER_ACCOUNT_INVALID", "内部转账两端银行账户不能相同");
    }
    if (Math.abs(absoluteAmount(outgoing.amount) - absoluteAmount(incoming.amount)) > accountingRules(workspace).amountTolerance) {
      throw new AccountingRuleError("TRANSFER_AMOUNT_MISMATCH", "内部转账两端金额不一致");
    }
    const sourceIds = collectSourceIds(event.id, outgoing.id, incoming.id, event.referenceNo);
    return withEventAttributes(aggregateLines([
      { account: incoming.accountId || "bank", debit: amount, credit: 0, sourceIds },
      { account: outgoing.accountId || "bank", debit: 0, credit: amount, sourceIds },
    ]));
  }

  const primaryAccount = event.accountingAttributes?.primaryAccount;
  const cashAccount = event.accountingAttributes?.cashAccountId || transaction.accountId || "bank";
  if (!primaryAccount) throw new AccountingRuleError("BUSINESS_EVENT_ACCOUNT_REQUIRED", "业务事件缺少已确认的会计主科目");
  const resolvedPrimaryAccount = resolvedVoucherAccount(workspace, primaryAccount, "BUSINESS_EVENT_ACCOUNT_REQUIRED");
  if (resolvedPrimaryAccount.id === cashAccount) {
    throw new AccountingRuleError("BUSINESS_EVENT_ACCOUNT_INVALID", "业务主科目不能与当前银行账户相同");
  }
  const incoming = event.direction === "in";
  const sourceIds = collectSourceIds(event.id, transaction.id, event.relatedBillId, event.referenceNo);
  return withEventAttributes(aggregateLines([
    {
      account: cashAccount,
      debit: incoming ? amount : 0,
      credit: incoming ? 0 : amount,
      sourceIds,
    },
    {
      account: resolvedPrimaryAccount.id,
      auxiliaryId: event.counterparty || null,
      debit: incoming ? 0 : amount,
      credit: incoming ? amount : 0,
      sourceIds,
    },
  ]));
}

export function createBankBusinessEventVoucherDraft(workspace, {
  eventId,
  summary,
  note = "",
}, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext({ ...context, mode: context.mode || "manual" });
  if (resolvedContext.mode !== "manual") {
    throw new AccountingRuleError("BANK_BUSINESS_EVENT_MANUAL_DRAFT_REQUIRED", "银行业务事件只能由财务人员手工生成凭证草稿");
  }
  const event = findBankBusinessEvent(next, eventId);
  const transaction = findTransaction(next, event.transactionId);
  if (!memberBusinessEnabled(next) && memberScopedEvent(event)) {
    throw new AccountingRuleError("MEMBER_MODULE_DISABLED", "当前工作台未启用会员模块，不能生成会员业务凭证");
  }
  const activeVoucher = (next.vouchers || []).find((voucher) => (
    (voucher.bankBusinessEventId === event.id || voucher.sourceIds?.includes(event.id))
    && voucher.status !== "superseded"
  ));
  if (activeVoucher) {
    throw new AccountingRuleError("SOURCE_ALREADY_VOUCHERED", `业务事件 ${event.businessEventNo || event.id} 已有${activeVoucher.no || "凭证草稿"}`);
  }
  if (["voucher_draft", "posted"].includes(event.accountingStatus)) {
    throw new AccountingRuleError("SOURCE_ALREADY_VOUCHERED", `业务事件 ${event.businessEventNo || event.id} 已进入凭证链`);
  }

  const classification = effectiveBankTransactionClassification(next, transaction);
  const assessment = effectiveEvidenceAssessment(next, transaction, classification);
  if (Number(event.evidenceCompleteness) !== 100 || Number(assessment.completeness) !== 100) {
    throw new AccountingRuleError("BUSINESS_EVENT_EVIDENCE_INCOMPLETE", "证据不完整，不能生成银行业务事件凭证草稿", {
      eventCompleteness: event.evidenceCompleteness,
      transactionCompleteness: assessment.completeness,
      missing: event.evidence?.missing || assessment.missing,
    });
  }
  if (event.taxAttributes?.status !== "confirmed" || event.taxAttributes?.treatment === "tax_pending") {
    throw new AccountingRuleError("BUSINESS_EVENT_TAX_UNCONFIRMED", "税务属性尚未确认，不能生成凭证草稿");
  }
  const unresolved = unresolvedExceptionTasks(next, transaction.id);
  if (unresolved.length || event.review?.required || event.status !== "confirmed") {
    throw new AccountingRuleError("BUSINESS_EVENT_S7_REQUIRED", "业务事件仍有未完成的 S7 复核，不能生成凭证草稿", {
      exceptionIds: unresolved.map((task) => task.id),
    });
  }
  if ((event.crossPeriod || HIGH_RISK_BANK_BUSINESS_TYPES.has(event.businessType)) && event.review?.status !== "approved") {
    throw new AccountingRuleError("BUSINESS_EVENT_REVIEW_REQUIRED", "跨期或高风险业务必须完成 S7 人工复核后才能生成凭证草稿");
  }

  const lines = bankBusinessEventVoucherLines(next, event, transaction);
  const validation = validateVoucherBalance({ lines }, accountingRules(next).amountTolerance, next);
  if (!validation.balanced) throw new AccountingRuleError("VOUCHER_UNBALANCED", validation.errors.join("；"), validation);
  const relatedBill = event.relatedBillId ? findBill(next, event.relatedBillId) : null;
  const relatedTransaction = event.relatedTransactionId ? findTransaction(next, event.relatedTransactionId) : null;
  const internalTransfer = event.businessType === "internalTransfer";
  const sourceIds = collectSourceIds(
    event.id,
    transaction.id,
    event.relatedBillId,
    event.referenceNo,
    internalTransfer ? relatedTransaction?.id : null,
  );
  const relatedSourceIds = collectSourceIds(
    !internalTransfer ? relatedTransaction?.id : null,
  );
  const evidenceIds = collectSourceIds(
    event.evidenceIds || [],
    transaction.evidenceIds || [],
    relatedBill?.evidenceIds || [],
    relatedTransaction?.evidenceIds || [],
  );
  const businessReferences = [
    ...(relatedBill ? [{ kind: "bill", id: relatedBill.id, label: relatedBill.no || relatedBill.id }] : []),
    ...(event.referenceNo ? [{ kind: "order_contract", id: event.referenceNo, label: event.referenceNo }] : []),
    ...(relatedTransaction ? [{ kind: internalTransfer ? "transfer_counterpart" : "original_transaction", id: relatedTransaction.id, label: relatedTransaction.serial || relatedTransaction.id }] : []),
  ];
  const voucher = {
    id: nextRecordId(next.vouchers || [], "voucher"),
    no: null,
    date: event.date || transaction.date,
    period: event.businessPeriod,
    fundingPeriod: event.fundingPeriod,
    summary: summary || defaultVoucherSummary(
      next,
      transaction,
      classification,
      lines,
      event.businessTypeLabel || VOUCHER_EVENT_LABELS[event.eventType],
    ),
    status: "draft",
    version: 1,
    sourceType: "bankBusinessEvent",
    bankBusinessEventId: event.id,
    transactionId: transaction.id,
    lines,
    sourceIds,
    relatedSourceIds,
    evidenceIds,
    businessReferences,
    accountingAttributes: structuredClone(event.accountingAttributes || {}),
    taxAttributes: structuredClone(event.taxAttributes || {}),
    judgement: {
      eventType: event.eventType,
      businessType: event.businessType,
      account: event.accountingAttributes?.primaryAccount,
      accountLabel: resolveWorkspaceAccountDefinition(next, event.accountingAttributes?.primaryAccount)?.label
        || event.accountingAttributes?.primaryAccountLabel
        || event.accountingAttributes?.primaryAccount,
      confidence: event.confidence,
      reasons: event.reasons || [],
      note,
      ruleSource: "confirmed-bank-business-event",
      accountingAttributes: structuredClone(event.accountingAttributes || {}),
      taxAttributes: structuredClone(event.taxAttributes || {}),
      evidenceCompleteness: event.evidenceCompleteness,
    },
    blockers: [],
    postingPolicy: "manual_only",
    createdAt: resolvedContext.at,
    createdBy: resolvedContext.actor,
    reviews: [],
    versions: [],
  };
  synchronizeVoucherJudgementAccounts(next, voucher, resolvedContext, "由已确认银行业务事件生成凭证草稿");
  voucher.versions.push(voucherSnapshot(voucher, resolvedContext, "由已确认银行业务事件生成凭证草稿"));
  next.vouchers = [...(next.vouchers || []), voucher];
  event.accountingStatus = "voucher_draft";
  event.draftVoucherId = voucher.id;
  event.accountingAttributes = {
    ...(event.accountingAttributes || {}),
    postingStatus: "voucher_draft",
  };
  event.updatedAt = resolvedContext.at;
  event.updatedBy = resolvedContext.actor;
  appendAuditEntry(next, {
    action: "voucher.create_bank_business_event_draft",
    entityType: "voucher",
    entityId: voucher.id,
    detail: `${voucher.summary}；借贷各 ${validation.debit.toFixed(2)}；仅允许人工复核入账`,
    after: { status: voucher.status, version: voucher.version, validation, businessEventId: event.id },
    sourceIds: collectSourceIds(voucher.id, sourceIds, relatedSourceIds, evidenceIds),
  }, resolvedContext);
  return next;
}

export function validateVoucherBalance(voucher, tolerance = 0.01, workspace = null) {
  const lines = voucher.lines || [];
  const normalizedAmounts = lines.map((line) => {
    const debit = Number(line.debit ?? 0);
    const credit = Number(line.credit ?? 0);
    const rawTaxAmount = line.taxAmount;
    const taxAmountEmpty = rawTaxAmount == null || String(rawTaxAmount).trim() === "";
    const taxAmount = taxAmountEmpty ? null : Number(rawTaxAmount);
    return {
      debit,
      credit,
      taxAmount,
      validDebit: Number.isFinite(debit),
      validCredit: Number.isFinite(credit),
      validTaxAmount: taxAmountEmpty || Number.isFinite(taxAmount),
    };
  });
  const debit = sumMoney(normalizedAmounts.map((line) => line.validDebit ? line.debit : 0));
  const credit = sumMoney(normalizedAmounts.map((line) => line.validCredit ? line.credit : 0));
  const taxTotal = sumMoney(normalizedAmounts.map((line) => line.validTaxAmount && line.taxAmount != null ? line.taxAmount : 0));
  const difference = roundMoney(debit - credit);
  const amountsBalanced = Math.abs(difference) <= tolerance;
  const errors = [];
  if (lines.length < 2) errors.push("凭证至少需要两行分录");
  lines.forEach((line, index) => {
    const amounts = normalizedAmounts[index];
    const account = String(line.account || "").trim();
    if (!amounts.validDebit || !amounts.validCredit) {
      errors.push(`第 ${index + 1} 行借贷金额必须是有效数字`);
    } else if (amounts.debit < 0 || amounts.credit < 0) {
      errors.push(`第 ${index + 1} 行借贷金额不能为负数`);
    } else if (amounts.debit > 0 && amounts.credit > 0) {
      errors.push(`第 ${index + 1} 行不能同时填写借方和贷方`);
    } else if (amounts.debit <= 0 && amounts.credit <= 0) {
      errors.push(`第 ${index + 1} 行必须填写借方或贷方金额`);
    }
    if (!amounts.validTaxAmount) {
      errors.push(`第 ${index + 1} 行税额必须是有效数字`);
    } else if (amounts.taxAmount != null && amounts.taxAmount < 0) {
      errors.push(`第 ${index + 1} 行税额不能为负数`);
    }
    if (!account) {
      errors.push(`第 ${index + 1} 行缺少会计科目`);
    } else if (workspace && !resolveWorkspaceAccountDefinition(workspace, account, { allowInactive: false })) {
      errors.push(`第 ${index + 1} 行会计科目不存在或已停用`);
    }
  });
  if (!amountsBalanced) errors.push(`借贷不平，差额 ${difference.toFixed(2)}`);
  return { balanced: errors.length === 0, amountsBalanced, debit, credit, taxTotal, difference, errors };
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
    judgement: structuredClone(voucher.judgement || {}),
    accountingAttributes: structuredClone(voucher.accountingAttributes || {}),
    status: voucher.status,
  };
}

export function createVoucherDraft(workspace, { transactionId, summary, note = "" }, context = {}) {
  const sourceTransaction = findTransaction(workspace, transactionId);
  const bankBusinessEvent = (workspace.businessEvents || []).find((event) => (
    event.id === sourceTransaction.bankBusinessEventId
    || (event.sourceType === "bankTransaction" && event.transactionId === sourceTransaction.id)
  ));
  if (bankBusinessEvent) {
    return createBankBusinessEventVoucherDraft(workspace, {
      eventId: bankBusinessEvent.id,
      summary,
      note,
    }, context);
  }
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const transaction = findTransaction(next, transactionId);
  const classification = effectiveBankTransactionClassification(next, transaction);
  const assessment = effectiveEvidenceAssessment(next, transaction, classification);
  const usedSources = postedSourceIds(next);
  const allocations = activeAllocations(transaction).filter((allocation) => (
    allocation.status !== "suspected"
    && !usedSources.has(allocation.id)
    && (allocation.id || !usedSources.has(allocation.billId))
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

  const validation = validateVoucherBalance({ lines }, accountingRules(next).amountTolerance, next);
  if (!validation.balanced) throw new AccountingRuleError("VOUCHER_UNBALANCED", validation.errors.join("；"), validation);
  const trace = evidenceAndSources(next, transaction, allocations);
  const voucherId = nextRecordId(next.vouchers || [], "voucher");
  const voucher = {
    id: voucherId,
    no: null,
    date: transaction.date,
    period: String(transaction.date || "").slice(0, 7),
    summary: summary || defaultVoucherSummary(next, transaction, classification, lines),
    status: "draft",
    version: 1,
    lines,
    sourceIds: trace.sourceIds,
    evidenceIds: trace.evidenceIds,
    judgement: {
      eventType: classification.eventType,
      account: classification.account,
      accountLabel: resolveWorkspaceAccountDefinition(next, classification.account)?.label
        || classification.accountLabel
        || classification.account,
      ruleId: classification.ruleId,
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
  synchronizeVoucherJudgementAccounts(next, voucher, resolvedContext, "创建凭证草稿");
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

export function createMemberEventVoucherDraft(workspace, { eventId, summary, note = "" }, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  if (!memberBusinessEnabled(next)) {
    throw new AccountingRuleError("MEMBER_MODULE_DISABLED", "当前工作台未启用会员模块，不能生成会员业务凭证");
  }
  const event = findBusinessEvent(next, eventId);
  const kind = memberEventKind(event);
  const definition = MEMBER_EVENT_DEFINITIONS[kind];
  if (!definition || !isRecognizedMemberEvent(event)) {
    throw new AccountingRuleError("MEMBER_EVENT_NOT_CONFIRMED", "会员业务必须先确认，才能生成凭证");
  }
  const existing = vouchersForMemberEvent(next, event).find((voucher) => voucher.status !== "superseded");
  if (existing) {
    throw new AccountingRuleError("SOURCE_ALREADY_VOUCHERED", `这笔会员业务已有${existing.no || "凭证草稿"}`);
  }

  const lines = memberEventVoucherLines(next, event);
  const validation = validateVoucherBalance({ lines }, accountingRules(next).amountTolerance, next);
  if (!validation.balanced) throw new AccountingRuleError("VOUCHER_UNBALANCED", validation.errors.join("；"), validation);
  const relatedBill = event.billId ? findBill(next, event.billId) : null;
  const voucher = {
    id: nextRecordId(next.vouchers || [], "voucher"),
    no: null,
    date: event.date,
    period: String(event.date || "").slice(0, 7),
    summary: summary || `${definition.label} · ${event.memberName || event.coach || "会员业务"}`,
    status: "draft",
    version: 1,
    sourceType: "memberEvent",
    memberEventId: event.id,
    lines,
    sourceIds: collectSourceIds(event.id, event.billId),
    relatedSourceIds: collectSourceIds(
      event.originalRechargeId,
      event.commissionEventId,
      event.commissionSourceIds || [],
    ),
    evidenceIds: collectSourceIds(event.evidenceIds || [], relatedBill?.evidenceIds || []),
    judgement: {
      eventType: definition.accountingEventType,
      confidence: 100,
      reasons: [`会员台账状态：${memberEventStatusLabel(event)}`, definition.suggestedEntry],
      note,
      ruleSource: "confirmed-member-ledger",
    },
    blockers: [],
    createdAt: resolvedContext.at,
    createdBy: resolvedContext.actor,
    reviews: [],
    versions: [],
  };
  synchronizeVoucherJudgementAccounts(next, voucher, resolvedContext, "由已确认会员业务生成凭证草稿");
  voucher.versions.push(voucherSnapshot(voucher, resolvedContext, "由已确认会员业务生成凭证草稿"));
  next.vouchers = [...(next.vouchers || []), voucher];
  event.accountingStatus = "voucher_draft";
  event.draftVoucherId = voucher.id;
  event.updatedAt = resolvedContext.at;
  appendAuditEntry(next, {
    action: "voucher.create_member_event_draft",
    entityType: "voucher",
    entityId: voucher.id,
    detail: `${voucher.summary}；借贷各 ${validation.debit.toFixed(2)}`,
    after: { status: voucher.status, version: voucher.version, validation },
    sourceIds: collectSourceIds(voucher.id, voucher.sourceIds, voucher.evidenceIds),
  }, resolvedContext);
  return next;
}

export function createAdvanceApplicationVoucherDraft(workspace, { applicationId, summary, note = "" }, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const application = findAdvanceApplication(next, applicationId);
  if (application.status !== "confirmed") {
    throw new AccountingRuleError("ADVANCE_APPLICATION_NOT_CONFIRMED", "预收/预付冲销关系必须先人工确认，才能生成凭证");
  }
  const existing = (next.vouchers || []).find((voucher) => (
    voucher.advanceApplicationId === application.id && voucher.status !== "superseded"
  ));
  if (existing) {
    throw new AccountingRuleError("SOURCE_ALREADY_VOUCHERED", `这笔冲销关系已有${existing.no || "凭证草稿"}`);
  }

  const advanceBill = findBill(next, application.advanceBillId);
  const targetBill = findBill(next, application.targetBillId);
  const lines = advanceApplicationVoucherLines(next, application);
  const validation = validateVoucherBalance({ lines }, accountingRules(next).amountTolerance, next);
  if (!validation.balanced) throw new AccountingRuleError("VOUCHER_UNBALANCED", validation.errors.join("；"), validation);
  const sourceIds = collectSourceIds(
    application.id,
    application.sourceIds || [],
    application.advanceBillId,
    application.targetBillId,
  );
  const sourceTransactions = sourceTransactionsForVoucher(next, { sourceIds });
  const evidenceIds = collectSourceIds(
    advanceBill?.evidenceIds || [],
    targetBill?.evidenceIds || [],
    sourceTransactions.map((transaction) => transaction.evidenceIds || []),
  );
  const voucher = {
    id: nextRecordId(next.vouchers || [], "voucher"),
    no: null,
    date: application.date,
    period: application.businessPeriod || String(application.date || "").slice(0, 7),
    summary: summary || `${advanceBill?.no || application.advanceBillId} 冲销 ${targetBill?.no || application.targetBillId}`,
    status: "draft",
    version: 1,
    sourceType: "advanceApplication",
    advanceApplicationId: application.id,
    lines,
    sourceIds,
    evidenceIds,
    judgement: {
      eventType: application.type,
      confidence: 100,
      reasons: [
        "预收/预付冲销关系已经人工确认",
        advanceBill?.kind === BILL_KINDS.DEPOSIT_RECEIVED ? "借合同负债，贷应收账款" : "借应付账款，贷预付账款",
      ],
      note,
      ruleSource: "confirmed-advance-application",
    },
    blockers: [],
    createdAt: resolvedContext.at,
    createdBy: resolvedContext.actor,
    reviews: [],
    versions: [],
  };
  synchronizeVoucherJudgementAccounts(next, voucher, resolvedContext, "由已确认预收/预付冲销关系生成凭证草稿");
  voucher.versions.push(voucherSnapshot(voucher, resolvedContext, "由已确认预收/预付冲销关系生成凭证草稿"));
  next.vouchers = [...(next.vouchers || []), voucher];
  application.accountingStatus = "voucher_draft";
  application.draftVoucherId = voucher.id;
  application.updatedAt = resolvedContext.at;
  appendAuditEntry(next, {
    action: "voucher.create_advance_application_draft",
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
  const linkedEvent = (workspace.businessEvents || []).find((event) => (
    event.id === voucher.memberEventId
    || event.id === voucher.bankBusinessEventId
    || voucher.sourceIds?.includes(event.id)
  ));
  if (!memberBusinessEnabled(workspace) && (voucher.sourceType === "memberEvent" || memberScopedEvent(linkedEvent))) {
    throw new AccountingRuleError("MEMBER_MODULE_DISABLED", "当前工作台未启用会员模块，会员业务凭证不能入账");
  }
  const transactions = sourceTransactionsForVoucher(workspace, voucher);
  const unresolved = transactions.flatMap((transaction) => unresolvedExceptionTasks(workspace, transaction.id));
  if (unresolved.length) {
    throw new AccountingRuleError("UNRESOLVED_EXCEPTION", "凭证来源仍有未解决异常", {
      exceptionIds: unresolved.map((task) => task.id),
    });
  }
  const rules = accountingRules(workspace);
  transactions.forEach((transaction) => {
    const classification = effectiveBankTransactionClassification(workspace, transaction);
    const assessment = effectiveEvidenceAssessment(workspace, transaction, classification);
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
    if (mode !== "automatic" && assessment.issues.length && transaction.manualConfirmation?.decision !== "approve") {
      throw new AccountingRuleError("EVIDENCE_CONFIRMATION_REQUIRED", "证据不完整或存在风险的事项必须先完成人工确认", {
        transactionId: transaction.id,
        issues: assessment.issues.map((issue) => issue.code),
        completeness: assessment.completeness,
      });
    }
  });
}

function nextVoucherNumber(workspace, voucher) {
  const period = voucher.period || String(voucher.date).slice(0, 7);
  const maximum = (workspace.vouchers || []).reduce((current, item) => {
    if (item.id === voucher.id || (item.period || String(item.date).slice(0, 7)) !== period) return current;
    const match = /^记-(\d+)$/.exec(String(item.no || ""));
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `记-${String(maximum + 1).padStart(3, "0")}`;
}

export function postVoucher(workspace, { voucherId, reviewNote, mode = "manual" }, context = {}) {
  if (mode !== "automatic" && !reviewNote?.trim()) throw new AccountingRuleError("REVIEW_NOTE_REQUIRED", "人工入账必须填写复核意见");
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext({ ...context, mode });
  const voucher = findVoucher(next, voucherId);
  if (voucher.bankBusinessEventId && mode !== "manual") {
    throw new AccountingRuleError("BANK_BUSINESS_EVENT_MANUAL_POST_REQUIRED", "银行业务事件凭证只能由财务人员填写复核意见后入账");
  }
  if (voucher.advanceApplicationId && mode !== "manual") {
    throw new AccountingRuleError("ADVANCE_APPLICATION_MANUAL_REVIEW_REQUIRED", "预收/预付冲销凭证必须由财务人员人工复核后入账");
  }
  if (!["draft", "changes_requested"].includes(voucher.status)) {
    throw new AccountingRuleError("VOUCHER_NOT_POSTABLE", `当前状态不能入账：${voucher.status}`);
  }
  const validation = validateVoucherBalance(voucher, accountingRules(next).amountTolerance, next);
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
  const postedAllocationSourceIds = new Set((next.vouchers || [])
    .filter((item) => ["posted", "superseded"].includes(item.status))
    .flatMap((item) => item.sourceIds || []));
  sourceTransactionsForVoucher(next, voucher).forEach((transaction) => {
    const allocations = activeAllocations(transaction).filter((allocation) => allocation.status !== "suspected");
    const remaining = Math.max(0, roundMoney(
      absoluteAmount(transaction.amount) - sumMoney(allocations.map((allocation) => allocation.amount)),
    ));
    const allAllocationsPosted = allocations.every((allocation) => (
      postedAllocationSourceIds.has(allocation.id) || (!allocation.id && postedAllocationSourceIds.has(allocation.billId))
    ));
    transaction.status = allocations.length && (remaining > 0.01 || !allAllocationsPosted) ? "pending" : "posted";
    transaction.postedVoucherId = voucher.id;
    transaction.postedVoucherIds = collectSourceIds(transaction.postedVoucherIds || [], voucher.id);
    transaction.postedAt = resolvedContext.at;
  });
  const memberEvents = voucher.memberEventId
    ? (next.businessEvents || []).filter((event) => event.id === voucher.memberEventId)
    : (() => {
      const voucherSourceIds = new Set(collectSourceIds(
        voucher.sourceIds || [],
        (voucher.lines || []).flatMap((line) => line.sourceIds || []),
      ));
      return (next.businessEvents || []).filter((event) => voucherSourceIds.has(event.id));
    })();
  memberEvents.forEach((event) => {
    event.accountingStatus = "posted";
    event.postedVoucherId = voucher.id;
    event.draftVoucherId = null;
    event.postedAt = resolvedContext.at;
    event.updatedAt = resolvedContext.at;
    if (event.sourceType === "bankTransaction") {
      event.voucherId = voucher.id;
      event.postedBy = resolvedContext.actor;
      event.updatedBy = resolvedContext.actor;
      event.accountingAttributes = {
        ...(event.accountingAttributes || {}),
        postingStatus: "posted",
      };
    }
  });
  if (voucher.advanceApplicationId) {
    const application = findAdvanceApplication(next, voucher.advanceApplicationId);
    application.accountingStatus = "posted";
    application.voucherId = voucher.id;
    application.draftVoucherId = null;
    application.postedAt = resolvedContext.at;
    application.updatedAt = resolvedContext.at;
  }
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
  return synchronizeMemberServiceException(next, { period: next.currentPeriod }, resolvedContext);
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
  if (lines != null) {
    const inputValidation = validateVoucherBalance({ lines }, accountingRules(next).amountTolerance, next);
    if (!inputValidation.balanced) {
      throw new AccountingRuleError("VOUCHER_LINES_INVALID", inputValidation.errors.join("；"), inputValidation);
    }
    voucher.lines = aggregateLines(lines);
  }
  if (evidenceIds != null) voucher.evidenceIds = collectSourceIds(evidenceIds);
  const validation = validateVoucherBalance(voucher, accountingRules(next).amountTolerance, next);
  if (!validation.balanced) throw new AccountingRuleError("VOUCHER_UNBALANCED", validation.errors.join("；"), validation);
  voucher.version += 1;
  voucher.status = "draft";
  voucher.updatedAt = resolvedContext.at;
  voucher.updatedBy = resolvedContext.actor;
  synchronizeVoucherJudgementAccounts(next, voucher, resolvedContext, reason.trim());
  voucher.versions = [...(voucher.versions || []), before, voucherSnapshot(voucher, resolvedContext, reason.trim())];
  appendAuditEntry(next, {
    action: "voucher.revise",
    entityType: "voucher",
    entityId: voucher.id,
    detail: reason.trim(),
    before: { version: before.version, summary: before.summary, lines: before.lines, judgement: before.judgement },
    after: { version: voucher.version, summary: voucher.summary, lines: voucher.lines, judgement: structuredClone(voucher.judgement) },
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
  synchronizeVoucherJudgementAccounts(next, revision, resolvedContext, reason.trim());
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
  const businessEvents = (workspace.businessEvents || []).filter((event) => voucher.sourceIds?.includes(event.id));
  const bills = (workspace.bills || []).filter((bill) => voucher.sourceIds?.includes(bill.id));
  const businessReferences = voucher.businessReferences || [];
  const advanceApplications = (workspace.advanceApplications || []).filter((application) => (
    application.id === voucher.advanceApplicationId || voucher.sourceIds?.includes(application.id)
  ));
  const assessments = transactions.map((transaction) => {
    const classification = effectiveBankTransactionClassification(workspace, transaction);
    return effectiveEvidenceAssessment(workspace, transaction, classification);
  });
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
      ...businessEvents.map((event) => ({ kind: "业务事件", id: event.id, name: `${event.businessEventNo || event.id} · ${event.businessTypeLabel || event.businessType || event.type}`, sourceIds: [event.id] })),
      ...bills.map((bill) => ({ kind: "往来账单", id: bill.id, name: `${bill.no || bill.id} · ${bill.counterparty || bill.summary || "账单"}`, sourceIds: [bill.id] })),
      ...businessReferences.filter((reference) => reference.kind !== "bill").map((reference) => ({ kind: reference.kind === "order_contract" ? "订单 / 合同" : "关联业务", id: reference.id, name: reference.label || reference.id, sourceIds: [reference.id] })),
      ...advanceApplications.map((application) => ({ kind: "预收/预付冲销", id: application.id, name: application.voucherSource?.summary || application.note || application.id, sourceIds: application.sourceIds || [application.id] })),
      ...documents.map((document) => ({ kind: document.type || "资料", id: document.id, name: document.name || document.title || document.id, sourceIds: [document.id] })),
      { kind: "业务匹配说明", id: `${voucher.id}-judgement`, name: voucher.judgement?.reasons?.join("；") || voucher.summary, sourceIds: voucher.sourceIds || [] },
      ...(voucher.reviews || []).map((review) => ({ kind: "人工复核记录", id: review.id, name: `${review.actor}：${review.note}`, sourceIds: [voucher.id] })),
    ],
    missing,
    sourceIds: collectSourceIds(voucher.id, voucher.sourceIds, voucher.relatedSourceIds, voucher.evidenceIds),
  };
}

export function vouchersForSource(workspace, sourceId) {
  return (workspace.vouchers || []).filter((voucher) => (
    voucher.sourceIds?.includes(sourceId) || voucher.relatedSourceIds?.includes(sourceId) || voucher.evidenceIds?.includes(sourceId) ||
    (voucher.businessReferences || []).some((reference) => reference.id === sourceId) ||
    (voucher.lines || []).some((line) => line.sourceIds?.includes(sourceId))
  ));
}

export function traceVoucherSources(workspace, voucherId) {
  const voucher = findVoucher(workspace, voucherId);
  const transactions = sourceTransactionsForVoucher(workspace, voucher);
  const relatedTransactions = (workspace.transactions || []).filter((transaction) => voucher.relatedSourceIds?.includes(transaction.id));
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
  const advanceApplications = (workspace.advanceApplications || []).filter((application) => (
    application.id === voucher.advanceApplicationId || voucher.sourceIds?.includes(application.id)
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
    relatedTransactions,
    businessReferences: voucher.businessReferences || [],
    advanceApplications,
    documents,
    reviews: voucher.reviews || [],
    versions: voucher.versions || [],
    audit,
    sourceIds: collectSourceIds(voucher.id, voucher.sourceIds, voucher.relatedSourceIds, voucher.evidenceIds),
  };
}
