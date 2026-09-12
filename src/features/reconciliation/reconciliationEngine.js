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
import { settlementBillIsEffective, settlementRecordIsEffective, settlementTransactionIsEffective, settlementPeriodEnd } from "./settlementRecognition.js";
import { assertBillWrite } from "../../domain/accounting/billWriteRules.js";
import { isPeriodArchived, validAccountingPeriod } from "../../domain/periods.js";
import {
  applyManualClassification,
  classifyBankTransaction,
  effectiveBankTransactionClassification,
  memberBusinessEnabled,
  resolveWorkspaceAccountDefinition,
} from "../../domain/accounting/classification.js";
import {
  assessTransactionEvidence,
  recordManualConfirmation,
  reviewTransactionEvidence,
  unresolvedExceptionTasks,
} from "../evidence/evidenceEngine.js";
import {
  assertAccountingPeriodWritable,
  cancelVoucherDraft,
  buildReconciliationCorrectionLines,
  createPostedVoucherRevision,
  invalidateReconciliationDrafts,
  reviseDraftVoucher,
  vouchersForAdvanceApplication,
  vouchersForReconciliation,
} from "../../domain/accounting/vouchers.js";

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

const BILL_NUMBER_PREFIXES = {
  [BILL_KINDS.RECEIVABLE]: "YS",
  [BILL_KINDS.PAYABLE]: "YF",
  [BILL_KINDS.DEPOSIT_RECEIVED]: "YSK",
  [BILL_KINDS.PREPAYMENT_PAID]: "YFK",
};

const ADVANCE_TARGET_KINDS = {
  [BILL_KINDS.DEPOSIT_RECEIVED]: BILL_KINDS.RECEIVABLE,
  [BILL_KINDS.PREPAYMENT_PAID]: BILL_KINDS.PAYABLE,
};

const TRANSACTION_BILL_KINDS = {
  [EVENT_TYPES.CUSTOMER_RECEIPT]: BILL_KINDS.RECEIVABLE,
  [EVENT_TYPES.MEMBER_RECHARGE]: BILL_KINDS.DEPOSIT_RECEIVED,
  [EVENT_TYPES.SUPPLIER_SETTLEMENT]: BILL_KINDS.PAYABLE,
  [EVENT_TYPES.SUPPLIER_PREPAYMENT]: BILL_KINDS.PREPAYMENT_PAID,
};

export const BUSINESS_EVENT_TAX_TREATMENTS = Object.freeze([
  { id: "taxable_income", label: "应税收入" },
  { id: "tax_exempt", label: "免税 / 不征税收入" },
  { id: "deferred_revenue", label: "预收阶段暂不确认收入税务" },
  { id: "input_deductible", label: "进项税可抵扣" },
  { id: "input_non_deductible", label: "进项税不可抵扣" },
  { id: "prepayment_no_tax", label: "预付阶段暂不确认进项" },
  { id: "non_taxable", label: "非应税资金往来" },
  { id: "tax_pending", label: "税务属性待复核" },
]);

export const BUSINESS_EVENT_INVOICE_STATUSES = Object.freeze([
  { id: "issued", label: "已开票" },
  { id: "obtained", label: "已取得发票" },
  { id: "pending", label: "待开 / 待取得" },
  { id: "not_applicable", label: "不适用" },
]);

export const MANUAL_BUSINESS_EVENT_TYPES = Object.freeze([
  {
    id: "customerReceipt",
    label: "客户收款",
    eventType: EVENT_TYPES.CUSTOMER_RECEIPT,
    allowedDirections: ["in"],
    account: "receivable",
    counterpartyRequired: true,
    billKinds: [BILL_KINDS.RECEIVABLE],
    referenceMode: "bill_or_reference",
    referenceLabel: "销售订单 / 结算单编号",
    taxTreatments: ["taxable_income", "tax_exempt", "tax_pending"],
    invoiceRequired: true,
    evidenceHint: "合同、订单、发票或结算单",
    accountingTreatment: "确认客户来款并冲销应收或保留待核销余额",
  },
  {
    id: "memberRecharge",
    label: "会员充值",
    requiresMemberModule: true,
    eventType: EVENT_TYPES.MEMBER_RECHARGE,
    allowedDirections: ["in"],
    account: "contractLiability",
    counterpartyRequired: true,
    billKinds: [BILL_KINDS.DEPOSIT_RECEIVED],
    referenceMode: "bill_or_reference",
    referenceLabel: "会员订单 / 协议编号",
    taxTreatments: ["deferred_revenue", "taxable_income", "tax_pending"],
    invoiceRequired: true,
    evidenceHint: "会员协议或充值订单",
    accountingTreatment: "确认会员预收，后续按履约情况结转",
  },
  {
    id: "supplierPayment",
    label: "供应商付款",
    eventType: EVENT_TYPES.SUPPLIER_SETTLEMENT,
    allowedDirections: ["out"],
    account: "payable",
    counterpartyRequired: true,
    billKinds: [BILL_KINDS.PAYABLE],
    referenceMode: "bill_or_reference",
    referenceLabel: "采购订单 / 合同编号",
    taxTreatments: ["input_deductible", "input_non_deductible", "tax_pending"],
    invoiceRequired: true,
    evidenceHint: "采购单或合同、发票、付款审批",
    accountingTreatment: "确认供应商付款并冲销应付",
  },
  {
    id: "supplierPrepayment",
    label: "供应商预付",
    eventType: EVENT_TYPES.SUPPLIER_PREPAYMENT,
    allowedDirections: ["out"],
    account: "prepayment",
    counterpartyRequired: true,
    billKinds: [BILL_KINDS.PREPAYMENT_PAID],
    referenceMode: "bill_or_reference",
    referenceLabel: "预付订单 / 合同编号",
    taxTreatments: ["prepayment_no_tax", "input_deductible", "tax_pending"],
    invoiceRequired: true,
    evidenceHint: "采购单或合同、付款审批",
    accountingTreatment: "确认供应商预付款，后续与应付账单冲销",
  },
  {
    id: "purchaseExpense",
    label: "采购费用",
    eventType: EVENT_TYPES.PURCHASE_EXPENSE,
    allowedDirections: ["out"],
    account: "expenseOther",
    counterpartyRequired: true,
    billKinds: [BILL_KINDS.PAYABLE],
    referenceMode: "bill_or_reference",
    referenceLabel: "采购订单 / 报销单编号",
    taxTreatments: ["input_deductible", "input_non_deductible", "tax_pending"],
    invoiceRequired: true,
    evidenceHint: "发票和付款审批",
    accountingTreatment: "确认当期采购或费用支出",
  },
  {
    id: "payroll",
    label: "工资社保",
    eventType: EVENT_TYPES.PAYROLL,
    allowedDirections: ["out"],
    account: "expensePayroll",
    counterpartyRequired: true,
    billKinds: [],
    referenceMode: "none",
    fixedTaxTreatment: "non_taxable",
    evidenceHint: "工资表及相关社保资料",
    accountingTreatment: "确认工资或社保支出",
  },
  {
    id: "rentAndProperty",
    label: "房租物业",
    eventType: EVENT_TYPES.RENT_AND_PROPERTY,
    allowedDirections: ["out"],
    account: "expenseRent",
    counterpartyRequired: true,
    billKinds: [BILL_KINDS.PAYABLE],
    referenceMode: "bill_or_reference",
    referenceLabel: "租赁合同 / 物业账单编号",
    taxTreatments: ["input_deductible", "input_non_deductible", "tax_pending"],
    invoiceRequired: true,
    evidenceHint: "租赁合同和租金或物业发票",
    accountingTreatment: "确认房租或物业费用",
  },
  {
    id: "bankFee",
    label: "银行手续费",
    eventType: EVENT_TYPES.BANK_FEE,
    allowedDirections: ["out"],
    account: "expenseFee",
    counterpartyRequired: false,
    billKinds: [],
    referenceMode: "none",
    taxTreatments: ["input_deductible", "input_non_deductible", "tax_pending"],
    invoiceRequired: true,
    evidenceHint: "银行流水或收费回单",
    accountingTreatment: "确认银行手续费支出",
  },
  {
    id: "loanBorrowing",
    label: "借款",
    eventType: EVENT_TYPES.LOAN,
    allowedDirections: ["in"],
    account: "loan",
    counterpartyRequired: true,
    billKinds: [],
    referenceMode: "reference",
    referenceLabel: "借款合同 / 审批编号",
    fixedTaxTreatment: "non_taxable",
    alwaysReview: true,
    manualReviewReason: "借款事项必须由负责人复核合同、期限和资金性质",
    evidenceHint: "借款合同或审批资料",
    accountingTreatment: "确认借款本金流入",
  },
  {
    id: "loanRepayment",
    label: "还款",
    eventType: EVENT_TYPES.LOAN,
    allowedDirections: ["out"],
    account: "loan",
    counterpartyRequired: true,
    billKinds: [],
    referenceMode: "reference",
    referenceLabel: "借款合同 / 还款计划编号",
    fixedTaxTreatment: "non_taxable",
    alwaysReview: true,
    manualReviewReason: "还款事项必须复核本金、利息和对应借款合同",
    evidenceHint: "借款合同、还款计划或审批资料",
    accountingTreatment: "确认借款本金偿还；利息需单独复核",
  },
  {
    id: "employeeAdvance",
    label: "员工代垫",
    eventType: EVENT_TYPES.EMPLOYEE_ADVANCE,
    allowedDirections: ["in", "out"],
    account: "expenseOther",
    counterpartyRequired: true,
    billKinds: [],
    referenceMode: "reference",
    referenceLabel: "报销单 / 代垫审批编号",
    taxTreatments: ["input_deductible", "input_non_deductible", "tax_pending"],
    invoiceRequired: true,
    alwaysReview: true,
    manualReviewReason: "员工代垫必须复核实际承担方、报销范围和审批",
    evidenceHint: "报销或代垫审批及发票",
    accountingTreatment: "确认员工代垫或归还代垫款",
  },
  {
    id: "relatedParty",
    label: "股东 / 关联方往来",
    eventType: EVENT_TYPES.RELATED_PARTY,
    allowedDirections: ["in", "out"],
    account: "relatedParty",
    counterpartyRequired: true,
    billKinds: [],
    referenceMode: "reference",
    referenceLabel: "审批 / 往来说明编号",
    fixedTaxTreatment: "non_taxable",
    alwaysReview: true,
    manualReviewReason: "股东或关联方往来必须由负责人确认资金性质",
    evidenceHint: "负责人确认或审批资料",
    accountingTreatment: "确认股东或关联方资金往来",
  },
  {
    id: "refund",
    label: "退款",
    eventType: EVENT_TYPES.REFUND,
    allowedDirections: ["in", "out"],
    account: "salesReturns",
    counterpartyRequired: true,
    billKinds: [],
    referenceMode: "none",
    relatedTransactionRole: "original_transaction",
    taxTreatments: ["taxable_income", "input_deductible", "input_non_deductible", "tax_pending"],
    invoiceRequired: true,
    alwaysReview: true,
    manualReviewReason: "退款必须复核原业务、可退余额和税务冲回方式",
    evidenceHint: "退款申请及原业务依据",
    accountingTreatment: "按原业务性质确认退款或税务冲回",
  },
  {
    id: "internalTransfer",
    label: "内部转账",
    eventType: EVENT_TYPES.INTERNAL_TRANSFER,
    allowedDirections: ["in", "out"],
    account: "bank",
    counterpartyRequired: false,
    billKinds: [],
    referenceMode: "none",
    relatedTransactionRole: "counterpart_transaction",
    fixedTaxTreatment: "non_taxable",
    alwaysReview: true,
    manualReviewReason: "内部转账必须复核两端账户、方向和金额，避免重复入账",
    evidenceHint: "另一端流水或内部转账回单",
    accountingTreatment: "仅确认账户间调拨，两端资金只入账一次",
  },
]);

export function manualBusinessEventTypesForWorkspace(workspace) {
  return MANUAL_BUSINESS_EVENT_TYPES
    .filter((definition) => !definition.requiresMemberModule || memberBusinessEnabled(workspace))
    .map((definition) => {
      const account = resolveWorkspaceAccountDefinition(workspace, definition.account);
      const accountLabel = account?.label || definition.account;
      return {
        ...definition,
        account: account?.id || definition.account,
        accountLabel,
        accountingTreatment: `${definition.accountingTreatment}；主科目：${accountLabel}`,
      };
    });
}

export function manualBusinessEventDefinition(businessType, workspace) {
  const definitions = workspace ? manualBusinessEventTypesForWorkspace(workspace) : MANUAL_BUSINESS_EVENT_TYPES;
  return definitions.find((definition) => definition.id === businessType) || null;
}

function isAdvanceBill(bill) {
  return Boolean(ADVANCE_TARGET_KINDS[bill?.kind]);
}

function nextBillNumber(workspace, kind, date) {
  const prefix = BILL_NUMBER_PREFIXES[kind];
  const period = periodOf(date).replace("-", "") || "UNDATED";
  const pattern = new RegExp(`^${prefix}-${period}-(\\d+)$`);
  const maximum = (workspace.bills || []).reduce((current, bill) => {
    const match = pattern.exec(String(bill.no || ""));
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `${prefix}-${period}-${String(maximum + 1).padStart(3, "0")}`;
}

export function createSettlementBill(workspace, input, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const kind = input?.kind;
  if (!Object.values(BILL_KINDS).includes(kind)) {
    throw new AccountingRuleError("INVALID_BILL_KIND", "请选择客户应收、供应商应付、客户预收或供应商预付");
  }
  const counterparty = String(input?.counterparty || "").trim();
  if (!counterparty) throw new AccountingRuleError("BILL_COUNTERPARTY_REQUIRED", "请填写客户或供应商名称");
  const amount = roundMoney(input?.amount);
  if (!Number.isFinite(Number(input?.amount)) || amount <= 0) {
    throw new AccountingRuleError("INVALID_BILL_AMOUNT", "账单金额必须大于 0");
  }
  const date = String(input?.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AccountingRuleError("INVALID_BILL_DATE", "账单日期必须是有效的 YYYY-MM-DD 日期");
  }
  const dueDate = String(input?.dueDate || date).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new AccountingRuleError("INVALID_BILL_DUE_DATE", "到期日期必须是有效的 YYYY-MM-DD 日期");
  }
  const no = String(input?.no || "").trim() || nextBillNumber(next, kind, date);
  if ((next.bills || []).some((bill) => bill.no === no)) {
    throw new AccountingRuleError("DUPLICATE_BILL_NUMBER", `账单编号已存在：${no}`);
  }
  const bill = {
    id: nextRecordId(next.bills || [], "bill"),
    no,
    kind,
    counterparty,
    ...(input?.counterpartyObjectId ? { counterpartyObjectId: input.counterpartyObjectId } : {}),
    ...(input?.counterpartyStandardized || input?.counterpartyObjectId ? { counterpartyStandardized: true } : {}),
    summary: String(input?.summary || "").trim() || counterparty,
    amount,
    date,
    dueDate,
    businessPeriod: input?.businessPeriod || periodOf(date),
    recognitionBasis: input?.recognitionBasis === "opening" ? "opening" : "business",
    evidenceIds: collectSourceIds(input?.evidenceIds || []),
    source: input?.source || "手工新增",
    status: "active",
    createdAt: resolvedContext.at,
    createdBy: resolvedContext.actor,
  };
  assertBillWrite(next, null, bill);
  next.bills = [...(next.bills || []), bill];
  appendAuditEntry(next, {
    action: "reconciliation.bill_create",
    entityType: "bill",
    entityId: bill.id,
    detail: `${bill.no} ${bill.counterparty}，金额 ${bill.amount.toFixed(2)}`,
    after: bill,
    sourceIds: collectSourceIds(bill.id, bill.evidenceIds),
  }, resolvedContext);
  return next;
}

const BUSINESS_EVENT_EXCEPTION_CODES = new Set([
  "unknown_business",
  "low_confidence",
  "missing_evidence",
  "responsible_person_confirmation",
  "transfer_counterpart_missing",
  "business_event_manual_review",
]);

function bankTransactionDirection(transaction) {
  return Number(transaction.amount || 0) >= 0 ? "in" : "out";
}

function nextBusinessEventNumber(workspace, fundingPeriod) {
  const period = String(fundingPeriod || "").replace("-", "") || "UNDATED";
  const prefix = `BE-${period}`;
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  const maximum = (workspace.businessEvents || []).reduce((current, event) => {
    const match = pattern.exec(String(event.businessEventNo || event.no || ""));
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `${prefix}-${String(maximum + 1).padStart(3, "0")}`;
}

function transactionBusinessEvent(workspace, transaction) {
  return (workspace.businessEvents || []).find((event) => (
    event.id === transaction.bankBusinessEventId
    || (event.sourceType === "bankTransaction" && event.transactionId === transaction.id)
  )) || null;
}

function explicitBusinessEventReviewReasons(definition, {
  businessPeriod,
  fundingPeriod,
  taxTreatment,
  reviewApproved = false,
}) {
  if (reviewApproved) return [];
  return [
    ...(definition.alwaysReview ? [definition.manualReviewReason || `${definition.label}需要人工复核`] : []),
    ...(businessPeriod !== fundingPeriod ? [`业务期 ${businessPeriod} 与资金期 ${fundingPeriod} 不同，必须复核跨期归属`] : []),
    ...(taxTreatment === "tax_pending" ? ["税务属性仍为待复核"] : []),
  ];
}

function buildBusinessEventEvidenceAssessment(workspace, transaction, classification, definition, values, context) {
  const base = assessTransactionEvidence(workspace, transaction, classification);
  const explicitReviewReasons = explicitBusinessEventReviewReasons(definition, values);
  const issues = [...base.issues];
  if (explicitReviewReasons.length) {
    issues.push({
      code: "business_event_manual_review",
      message: explicitReviewReasons.join("；"),
    });
  }
  return {
    ...base,
    issues,
    assessedAt: context.at,
    canAutomaticallyPost: false,
    postingPolicy: "manual_only",
  };
}

function syncBusinessEventExceptionTasks(workspace, transaction, event, assessment, context, {
  completedStatus = "resolved",
} = {}) {
  const tasks = workspace.exceptionTasks || (workspace.exceptionTasks = []);
  const activeIssues = assessment.issues.filter((issue) => BUSINESS_EVENT_EXCEPTION_CODES.has(issue.code));
  const activeCodes = new Set(activeIssues.map((issue) => issue.code));
  const sourceIds = collectSourceIds(event.id, event.sourceIds, event.evidenceIds);

  activeIssues.forEach((issue) => {
    const identity = `${transaction.id}:${issue.code}`;
    const existing = tasks.find((task) => task.identity === identity && task.status !== "resolved");
    if (existing) {
      existing.message = issue.message;
      existing.status = "open";
      existing.updatedAt = context.at;
      existing.missingEvidence = issue.code === "missing_evidence" ? assessment.missing : [];
      existing.sourceIds = sourceIds;
      existing.history = [...(existing.history || []), {
        at: context.at,
        actor: context.actor,
        action: "business_event_reassessed",
        note: issue.message,
      }];
      return;
    }
    tasks.push({
      id: nextRecordId(tasks, "exception"),
      identity,
      code: issue.code,
      sourceType: "bankTransaction",
      sourceId: transaction.id,
      message: issue.message,
      missingEvidence: issue.code === "missing_evidence" ? assessment.missing : [],
      status: "open",
      workflowState: "awaiting_verification",
      createdAt: context.at,
      updatedAt: context.at,
      sourceIds,
      history: [{ at: context.at, actor: context.actor, action: "created", note: issue.message }],
    });
  });

  tasks.filter((task) => (
    task.sourceId === transaction.id
    && task.status !== "resolved"
    && BUSINESS_EVENT_EXCEPTION_CODES.has(task.code)
    && !activeCodes.has(task.code)
  )).forEach((task) => {
    task.status = completedStatus;
    task.resolution = completedStatus === "resolved" ? "business_event_confirmed" : null;
    task.resolvedAt = completedStatus === "resolved" ? context.at : null;
    task.resolvedBy = completedStatus === "resolved" ? context.actor : null;
    task.updatedAt = context.at;
    task.history = [...(task.history || []), {
      at: context.at,
      actor: context.actor,
      action: completedStatus === "resolved" ? "business_event_confirmed" : "evidence_completed",
      note: completedStatus === "resolved" ? "人工业务事件已确认，原阻碍条件已消失" : "阻碍条件已消失，等待人工确认回流",
    }];
  });
}

function updateBusinessEventReviewState(workspace, transaction, event, context, { approveWhenClear = false } = {}) {
  const outstanding = unresolvedExceptionTasks(workspace, transaction.id)
    .filter((task) => BUSINESS_EVENT_EXCEPTION_CODES.has(task.code));
  const needsReview = outstanding.length > 0;
  const previousReview = event.review || {};
  const approved = approveWhenClear && !needsReview && previousReview.status === "pending";
  event.manualReviewRequired = needsReview;
  event.status = needsReview ? "needs_review" : "confirmed";
  event.review = {
    ...previousReview,
    required: needsReview,
    status: needsReview ? "pending" : (approved ? "approved" : (previousReview.status === "approved" ? "approved" : "not_required")),
    reasons: outstanding.map((task) => task.message),
    ...(approved ? { reviewedAt: context.at, reviewedBy: context.actor } : {}),
  };
  transaction.classification = {
    ...(transaction.classification || {}),
    eventType: event.eventType,
    businessType: event.businessType,
    account: event.accountingAttributes.primaryAccount,
    accountLabel: resolveWorkspaceAccountDefinition(workspace, event.accountingAttributes.primaryAccount)?.label
      || event.accountingAttributes.primaryAccountLabel
      || event.accountingAttributes.primaryAccount,
    direction: event.direction,
    confidence: event.confidence,
    reasons: event.reasons,
    riskFlags: outstanding.map((task) => task.code),
    requiresManualReview: needsReview,
    source: approved ? "manual-business-event-reviewed" : "manual-business-event",
  };
  if (transaction.evidenceAssessment) transaction.evidenceAssessment.canAutomaticallyPost = false;
  return needsReview;
}

function validateRelatedBusinessTransaction(workspace, transaction, definition, relatedTransactionId) {
  if (!definition.relatedTransactionRole) return null;
  if (!relatedTransactionId) {
    throw new AccountingRuleError(
      "BUSINESS_EVENT_RELATED_TRANSACTION_REQUIRED",
      definition.relatedTransactionRole === "original_transaction" ? "退款必须选择原业务流水" : "内部转账必须选择另一端流水",
    );
  }
  const related = findTransaction(workspace, relatedTransactionId);
  if (related.id === transaction.id) throw new AccountingRuleError("BUSINESS_EVENT_SELF_LINK", "不能把当前流水关联到自身");
  if (Math.sign(Number(related.amount)) === Math.sign(Number(transaction.amount))) {
    throw new AccountingRuleError("BUSINESS_EVENT_RELATED_DIRECTION_INVALID", "关联流水必须与当前流水方向相反");
  }
  if (definition.relatedTransactionRole === "counterpart_transaction") {
    const tolerance = accountingRules(workspace).amountTolerance;
    if (related.accountId === transaction.accountId) {
      throw new AccountingRuleError("TRANSFER_ACCOUNT_INVALID", "内部转账的两端银行账户不能相同");
    }
    if (Math.abs(absoluteAmount(related.amount) - absoluteAmount(transaction.amount)) > tolerance) {
      throw new AccountingRuleError("TRANSFER_AMOUNT_INVALID", "内部转账两端流水金额必须一致");
    }
  }
  return related;
}

export function confirmBankTransactionBusinessEvent(workspace, input, context = {}) {
  const definition = manualBusinessEventDefinition(input?.businessType, workspace);
  if (input?.businessType === "memberRecharge" && !memberBusinessEnabled(workspace)) {
    throw new AccountingRuleError("MEMBER_MODULE_DISABLED", "当前工作台未启用会员模块，不能选择会员充值业务");
  }
  if (!definition) throw new AccountingRuleError("BUSINESS_EVENT_TYPE_REQUIRED", "请选择明确的业务类型");
  const resolvedContext = operationContext({ ...context, mode: "manual" });
  const seed = cloneAccountingState(workspace);
  const seedTransaction = findTransaction(seed, input.transactionId);
  const direction = bankTransactionDirection(seedTransaction);
  if (!definition.allowedDirections.includes(direction)) {
    throw new AccountingRuleError(
      "BUSINESS_EVENT_DIRECTION_INVALID",
      `${definition.label}不适用于这笔${direction === "in" ? "收款" : "付款"}流水`,
    );
  }

  const counterparty = String(input.counterparty ?? seedTransaction.counterparty ?? "").trim();
  if (definition.counterpartyRequired && !counterparty) {
    throw new AccountingRuleError("BUSINESS_EVENT_COUNTERPARTY_REQUIRED", `${definition.label}必须填写交易对手`);
  }
  const businessPeriod = String(input.businessPeriod || "").trim();
  if (!/^\d{4}-\d{2}$/.test(businessPeriod)) {
    throw new AccountingRuleError("BUSINESS_EVENT_PERIOD_REQUIRED", "业务期间必须是有效的 YYYY-MM");
  }
  const fundingPeriod = periodOf(seedTransaction.date);
  if (!fundingPeriod) throw new AccountingRuleError("BUSINESS_EVENT_FUNDING_PERIOD_INVALID", "流水日期无法形成有效资金期间");
  const reason = String(input.reason || "").trim();
  if (!reason) throw new AccountingRuleError("BUSINESS_EVENT_REASON_REQUIRED", "人工确认必须填写判断依据");
  const seedClassification = effectiveBankTransactionClassification(seed, seedTransaction);
  const confidence = input.confidence == null || input.confidence === ""
    ? Number(seedClassification.confidence)
    : Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    throw new AccountingRuleError("BUSINESS_EVENT_CONFIDENCE_INVALID", "置信度必须在 0 到 100 之间");
  }

  const relatedBillId = String(input.relatedBillId || "").trim();
  const relatedBill = relatedBillId ? findBill(seed, relatedBillId) : null;
  if (relatedBill && !definition.billKinds.includes(relatedBill.kind)) {
    throw new AccountingRuleError("BUSINESS_EVENT_BILL_KIND_INVALID", `所选账单不属于${definition.label}可用类型`);
  }
  if (relatedBill && !allocationDirectionMatchesBill(seedTransaction, relatedBill)) {
    throw new AccountingRuleError("BUSINESS_EVENT_BILL_DIRECTION_INVALID", "所选账单与流水收支方向不一致");
  }
  const referenceNo = String(input.referenceNo || "").trim();
  if (definition.referenceMode === "bill_or_reference" && !relatedBill && !referenceNo) {
    throw new AccountingRuleError("BUSINESS_EVENT_REFERENCE_REQUIRED", `${definition.label}必须选择账单，或填写订单 / 合同编号`);
  }
  if (definition.referenceMode === "reference" && !referenceNo) {
    throw new AccountingRuleError("BUSINESS_EVENT_REFERENCE_REQUIRED", `${definition.label}必须填写${definition.referenceLabel || "业务依据编号"}`);
  }

  const relatedTransaction = validateRelatedBusinessTransaction(
    seed,
    seedTransaction,
    definition,
    String(input.relatedTransactionId || "").trim(),
  );
  const allowedTaxTreatments = definition.fixedTaxTreatment
    ? [definition.fixedTaxTreatment]
    : (definition.taxTreatments || []);
  const taxTreatment = definition.fixedTaxTreatment || String(input.taxTreatment || "").trim();
  if (!allowedTaxTreatments.includes(taxTreatment)) {
    throw new AccountingRuleError("BUSINESS_EVENT_TAX_REQUIRED", "请选择与业务类型相符的税务属性");
  }
  const invoiceStatus = definition.invoiceRequired
    ? String(input.invoiceStatus || "").trim()
    : "not_applicable";
  if (!BUSINESS_EVENT_INVOICE_STATUSES.some((status) => status.id === invoiceStatus)) {
    throw new AccountingRuleError("BUSINESS_EVENT_INVOICE_STATUS_REQUIRED", "请选择发票状态");
  }

  const selectedEvidenceIds = collectSourceIds(input.evidenceIds || []);
  const unknownEvidenceId = selectedEvidenceIds.find((documentId) => (
    !(seed.documents || []).some((document) => document.id === documentId)
  ));
  if (unknownEvidenceId) {
    throw new AccountingRuleError("BUSINESS_EVENT_EVIDENCE_NOT_FOUND", `找不到所选证据：${unknownEvidenceId}`);
  }
  seedTransaction.evidenceIds = collectSourceIds(
    seedTransaction.evidenceIds || [],
    relatedBill?.evidenceIds || [],
    relatedTransaction?.evidenceIds || [],
    selectedEvidenceIds,
  );

  const requestedAccount = String(input.account || definition.account || "").trim();
  const resolvedAccount = resolveWorkspaceAccountDefinition(seed, requestedAccount, { allowInactive: false });
  if (!resolvedAccount) {
    throw new AccountingRuleError("BUSINESS_EVENT_ACCOUNT_INVALID", `当前科目表中找不到可用科目：${requestedAccount || "未选择"}`);
  }
  const account = resolvedAccount.id;
  const accountLabel = resolvedAccount.label;
  let next = applyManualClassification(seed, {
    transactionId: seedTransaction.id,
    eventType: definition.eventType,
    account,
    reason,
  }, resolvedContext);
  const transaction = findTransaction(next, seedTransaction.id);
  const existingEvent = transactionBusinessEvent(next, transaction);
  const relatedTransactionAfter = relatedTransaction ? findTransaction(next, relatedTransaction.id) : null;
  const preliminaryClassification = {
    ...(transaction.classification || {}),
    eventType: definition.eventType,
    businessType: definition.id,
    account,
    accountLabel,
    direction,
    confidence: roundMoney(confidence),
    reasons: [reason],
    riskFlags: [],
    candidateBillIds: relatedBill ? [relatedBill.id] : [],
    counterpartAccountId: definition.relatedTransactionRole === "counterpart_transaction" ? relatedTransactionAfter?.accountId || null : null,
    requiresManualReview: false,
    source: "manual-business-event",
  };
  const assessment = buildBusinessEventEvidenceAssessment(next, transaction, preliminaryClassification, definition, {
    businessPeriod,
    fundingPeriod,
    taxTreatment,
    reviewApproved: false,
  }, resolvedContext);
  const systemReasons = [
    `${definition.label}由${resolvedContext.actor}人工确认`,
    `主科目：${accountLabel}`,
    `业务期 ${businessPeriod}；资金期 ${fundingPeriod}`,
    `证据完整度 ${assessment.completeness}%`,
    `税务属性：${BUSINESS_EVENT_TAX_TREATMENTS.find((item) => item.id === taxTreatment)?.label || taxTreatment}`,
  ];
  transaction.classification = {
    ...preliminaryClassification,
    reasons: [reason, ...systemReasons],
    riskFlags: assessment.issues.map((issue) => issue.code),
    requiresManualReview: assessment.issues.length > 0,
  };
  transaction.evidenceAssessment = assessment;
  transaction.businessPeriod = businessPeriod;
  transaction.manualClassification = {
    ...(transaction.manualClassification || {}),
    businessType: definition.id,
    confidence: roundMoney(confidence),
  };

  const eventId = existingEvent?.id || nextRecordId(next.businessEvents || [], "business-event");
  const businessEventNo = existingEvent?.businessEventNo || existingEvent?.no || nextBusinessEventNumber(next, fundingPeriod);
  const sourceIds = collectSourceIds(
    transaction.id,
    relatedBill?.id,
    relatedTransactionAfter?.id,
    transaction.evidenceIds || [],
  );
  const history = [...(existingEvent?.history || []), {
    at: resolvedContext.at,
    actor: resolvedContext.actor,
    action: existingEvent ? "reconfirmed" : "confirmed",
    note: reason,
  }];
  const businessEvent = {
    ...(existingEvent || {}),
    id: eventId,
    no: businessEventNo,
    businessEventNo,
    type: "bankTransaction",
    sourceType: "bankTransaction",
    source: "bank-transaction-manual-confirmation",
    transactionId: transaction.id,
    businessType: definition.id,
    businessTypeLabel: definition.label,
    eventType: definition.eventType,
    date: transaction.date,
    amount: absoluteAmount(transaction.amount),
    direction,
    counterparty: counterparty || relatedTransactionAfter?.counterparty || "银行账户",
    relatedBillId: relatedBill?.id || null,
    billId: relatedBill?.id || null,
    referenceNo: referenceNo || null,
    relatedTransactionId: relatedTransactionAfter?.id || null,
    originalTransactionId: definition.relatedTransactionRole === "original_transaction" ? relatedTransactionAfter?.id || null : null,
    counterpartTransactionId: definition.relatedTransactionRole === "counterpart_transaction" ? relatedTransactionAfter?.id || null : null,
    businessPeriod,
    fundingPeriod,
    crossPeriod: businessPeriod !== fundingPeriod,
    accountingAttributes: {
      primaryAccount: account,
      primaryAccountLabel: accountLabel,
      cashAccountId: transaction.accountId || "bank",
      treatment: definition.accountingTreatment,
      postingPolicy: "manual_only",
      postingStatus: existingEvent?.accountingAttributes?.postingStatus || "unposted",
    },
    taxAttributes: {
      treatment: taxTreatment,
      invoiceStatus,
      taxPeriod: businessPeriod,
      status: taxTreatment === "tax_pending" ? "pending_review" : "confirmed",
    },
    evidenceIds: [...(transaction.evidenceIds || [])],
    evidenceCompleteness: assessment.completeness,
    evidence: {
      completeness: assessment.completeness,
      linkedDocumentIds: assessment.linkedDocumentIds,
      required: assessment.required,
      missing: assessment.missing,
    },
    confidence: roundMoney(confidence),
    confidenceSource: "manual-confirmation",
    judgementBasis: reason,
    reasons: transaction.classification.reasons,
    automaticPostingAllowed: false,
    postingPolicy: "manual_only",
    accountingStatus: existingEvent?.accountingStatus || "unprocessed",
    manualReviewRequired: assessment.issues.length > 0,
    status: assessment.issues.length > 0 ? "needs_review" : "confirmed",
    review: {
      required: assessment.issues.length > 0,
      status: assessment.issues.length > 0 ? "pending" : "not_required",
      reasons: assessment.issues.map((issue) => issue.message),
    },
    sourceIds,
    history,
    createdAt: existingEvent?.createdAt || resolvedContext.at,
    createdBy: existingEvent?.createdBy || resolvedContext.actor,
    updatedAt: resolvedContext.at,
    updatedBy: resolvedContext.actor,
  };
  if (existingEvent) {
    next.businessEvents = (next.businessEvents || []).map((event) => event.id === existingEvent.id ? businessEvent : event);
  } else {
    next.businessEvents = [...(next.businessEvents || []), businessEvent];
  }
  transaction.bankBusinessEventId = businessEvent.id;
  transaction.businessEventNo = businessEvent.businessEventNo;
  syncBusinessEventExceptionTasks(next, transaction, businessEvent, assessment, resolvedContext);
  updateBusinessEventReviewState(next, transaction, businessEvent, resolvedContext);
  if (unresolvedExceptionTasks(next, transaction.id).length) transaction.status = "exception";
  else if (!["reconciled", "posted"].includes(transaction.status)) transaction.status = "pending";

  appendAuditEntry(next, {
    action: existingEvent ? "reconciliation.business_event_reconfirm" : "reconciliation.business_event_confirm",
    entityType: "businessEvent",
    entityId: businessEvent.id,
    detail: `${businessEvent.businessEventNo} · ${definition.label}；仅形成业务事件，未生成或入账凭证`,
    before: existingEvent,
    after: businessEvent,
    sourceIds: collectSourceIds(businessEvent.id, sourceIds),
  }, resolvedContext);
  return next;
}

function reassessBankTransactionBusinessEvent(workspace, transactionId, context) {
  const next = cloneAccountingState(workspace);
  const transaction = findTransaction(next, transactionId);
  const event = transactionBusinessEvent(next, transaction);
  if (!event) return null;
  const definition = manualBusinessEventDefinition(event.businessType, next);
  if (!definition) return null;
  const relatedBill = event.relatedBillId ? findBill(next, event.relatedBillId) : null;
  const relatedTransaction = event.relatedTransactionId ? findTransaction(next, event.relatedTransactionId) : null;
  transaction.evidenceIds = collectSourceIds(
    transaction.evidenceIds || [],
    event.evidenceIds || [],
    relatedBill?.evidenceIds || [],
    relatedTransaction?.evidenceIds || [],
  );
  const classification = {
    ...(transaction.classification || {}),
    eventType: event.eventType,
    businessType: event.businessType,
    account: event.accountingAttributes.primaryAccount,
    accountLabel: resolveWorkspaceAccountDefinition(next, event.accountingAttributes.primaryAccount)?.label
      || event.accountingAttributes.primaryAccountLabel
      || event.accountingAttributes.primaryAccount,
    direction: event.direction,
    confidence: event.confidence,
    reasons: event.reasons,
    riskFlags: [],
    candidateBillIds: relatedBill ? [relatedBill.id] : [],
    counterpartAccountId: event.counterpartTransactionId ? relatedTransaction?.accountId || null : null,
    requiresManualReview: false,
    source: "manual-business-event",
  };
  const assessment = buildBusinessEventEvidenceAssessment(next, transaction, classification, definition, {
    businessPeriod: event.businessPeriod,
    fundingPeriod: event.fundingPeriod,
    taxTreatment: event.taxAttributes.treatment,
    reviewApproved: event.review?.status === "approved",
  }, context);
  transaction.classification = {
    ...classification,
    riskFlags: assessment.issues.map((issue) => issue.code),
    requiresManualReview: assessment.issues.length > 0,
  };
  transaction.evidenceAssessment = assessment;
  event.evidenceIds = [...transaction.evidenceIds];
  event.evidenceCompleteness = assessment.completeness;
  event.evidence = {
    completeness: assessment.completeness,
    linkedDocumentIds: assessment.linkedDocumentIds,
    required: assessment.required,
    missing: assessment.missing,
  };
  event.updatedAt = context.at;
  event.updatedBy = context.actor;
  syncBusinessEventExceptionTasks(next, transaction, event, assessment, context, { completedStatus: "ready_for_review" });
  updateBusinessEventReviewState(next, transaction, event, context);
  transaction.status = unresolvedExceptionTasks(next, transaction.id).length ? "exception" : "pending";
  return next;
}

export function confirmedAllocationsForBill(workspace, billId, { asOf } = {}) {
  return (workspace.transactions || []).flatMap((transaction) => (
    (transaction.allocations || [])
      .filter((allocation) => (
        allocation.billId === billId && settlementTransactionIsEffective(transaction, asOf)
        && settlementRecordIsEffective(allocation, asOf, allocation.date || transaction.date)
      ))
      .map((allocation) => ({ ...allocation, transactionId: allocation.transactionId || transaction.id }))
  ));
}

export function confirmedAdvanceApplications(workspace, { advanceBillId, targetBillId, asOf } = {}) {
  return (workspace.advanceApplications || []).filter((application) => {
    const effectiveDate = application.date || String(application.createdAt || "").slice(0, 10);
    return settlementRecordIsEffective(application, asOf, effectiveDate)
      && (!advanceBillId || application.advanceBillId === advanceBillId)
      && (!targetBillId || application.targetBillId === targetBillId);
  });
}

export function confirmedAllocatedForBill(workspace, billId, options) {
  return sumMoney([
    ...confirmedAllocationsForBill(workspace, billId, options).map((allocation) => allocation.amount),
    ...confirmedAdvanceApplications(workspace, { targetBillId: billId, asOf: options?.asOf }).map((application) => application.amount),
  ]);
}

export function billSettlement(workspace, billOrId, options = {}) {
  const bill = typeof billOrId === "string" ? findBill(workspace, billOrId) : billOrId;
  const allocations = confirmedAllocationsForBill(workspace, bill.id, options);
  const advanceApplications = isAdvanceBill(bill)
    ? []
    : confirmedAdvanceApplications(workspace, { targetBillId: bill.id, asOf: options.asOf });
  const cashAllocated = sumMoney(allocations.map((allocation) => allocation.amount));
  const advanceApplied = sumMoney(advanceApplications.map((application) => application.amount));
  const allocated = sumMoney([cashAllocated, advanceApplied]);
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
    cashAllocated,
    advanceApplied,
    remaining: Math.max(0, remaining),
    status,
    allocationIds: allocations.map((allocation) => allocation.id),
    advanceApplicationIds: advanceApplications.map((application) => application.id),
    transactionIds: [...new Set(allocations.map((allocation) => allocation.transactionId))],
    advanceBillIds: [...new Set(advanceApplications.map((application) => application.advanceBillId))],
    fundingPeriods: [...new Set(allocations.map((allocation) => {
      const transaction = (workspace.transactions || []).find((item) => item.id === allocation.transactionId);
      return periodOf(transaction?.date);
    }).filter(Boolean))],
  };
}

export function advanceBalance(workspace, advanceBillOrId, options = {}) {
  const advanceBill = typeof advanceBillOrId === "string" ? findBill(workspace, advanceBillOrId) : advanceBillOrId;
  if (!isAdvanceBill(advanceBill)) {
    throw new AccountingRuleError("NOT_AN_ADVANCE_BILL", "只有客户预收或供应商预付可以计算可用余额");
  }
  const funding = billSettlement(workspace, advanceBill, options);
  const applications = confirmedAdvanceApplications(workspace, { advanceBillId: advanceBill.id, asOf: options.asOf });
  const usedAmount = sumMoney(applications.map((application) => application.amount));
  const availableBalance = Math.max(0, roundMoney(funding.allocated - usedAmount));
  return {
    advanceBillId: advanceBill.id,
    kind: advanceBill.kind,
    originalAmount: roundMoney(advanceBill.amount),
    originalBalance: funding.allocated,
    fundedAmount: funding.allocated,
    pendingFunding: funding.remaining,
    usedAmount,
    remaining: availableBalance,
    availableBalance,
    applicationIds: applications.map((application) => application.id),
    targetBillIds: [...new Set(applications.map((application) => application.targetBillId))],
    sourceIds: collectSourceIds(
      advanceBill.id,
      funding.allocationIds,
      funding.transactionIds,
      applications.map((application) => application.sourceIds || [application.id, application.targetBillId]),
    ),
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

const NON_BILL_EVENT_TYPES = new Set([
  EVENT_TYPES.INTERNAL_TRANSFER,
  EVENT_TYPES.REFUND,
  EVENT_TYPES.UNKNOWN,
]);

const MATCH_TYPE_ORDER = {
  one_to_one: 0,
  one_to_many: 1,
  many_to_one: 2,
};

function counterpartyIdentity(workspace, record) {
  const name = normalizeText(record?.counterparty);
  const alias = (workspace.counterpartyAliasRules || []).find((rule) => (
    name && normalizeText(rule.standardName) === name
  ));
  return {
    name,
    objectId: record?.counterpartyObjectId || alias?.objectId || null,
    standardized: Boolean(
      record?.counterpartyStandardized
      || record?.counterpartyAliasRuleId
      || record?.counterpartyObjectId
      || alias
    ),
  };
}

function counterpartyMatch(workspace, transaction, bill) {
  const transactionParty = counterpartyIdentity(workspace, transaction);
  const billParty = counterpartyIdentity(workspace, bill);
  if (transactionParty.objectId && billParty.objectId) {
    const matched = transactionParty.objectId === billParty.objectId;
    return {
      matched,
      score: matched ? 45 : 0,
      reason: matched ? "标准化交易对手对象一致" : "标准化交易对手对象不一致",
    };
  }
  const exactName = Boolean(transactionParty.name && transactionParty.name === billParty.name);
  const containedName = Boolean(transactionParty.name && billParty.name && (
    transactionParty.name.includes(billParty.name) || billParty.name.includes(transactionParty.name)
  ));
  if (exactName) {
    return {
      matched: true,
      score: transactionParty.standardized || billParty.standardized ? 43 : 40,
      reason: transactionParty.standardized || billParty.standardized ? "标准化交易对手名称一致" : "交易对象名称一致",
    };
  }
  return {
    matched: containedName,
    score: containedName ? 34 : 0,
    reason: containedName ? "交易对象名称可对应" : "交易对象无法对应",
  };
}

export function advanceApplicationTargets(workspace, advanceBillId) {
  const advanceBill = findBill(workspace, advanceBillId);
  if (!isAdvanceBill(advanceBill)) return [];
  const targetKind = ADVANCE_TARGET_KINDS[advanceBill.kind];
  return (workspace.bills || [])
    .filter((bill) => bill.kind === targetKind)
    .filter((bill) => String(bill.date || "") >= String(advanceBill.date || ""))
    .filter((bill) => counterpartyMatch(workspace, advanceBill, bill).matched)
    .map((bill) => {
      const settlement = billSettlement(workspace, bill);
      return {
        billId: bill.id,
        billNo: bill.no,
        kind: bill.kind,
        counterparty: bill.counterparty,
        date: bill.date,
        originalAmount: roundMoney(bill.amount),
        settledAmount: settlement.allocated,
        remaining: settlement.remaining,
      };
    })
    .filter((target) => target.remaining > accountingRules(workspace).amountTolerance)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)) || left.billId.localeCompare(right.billId));
}

export function applyAdvanceToBill(workspace, {
  advanceBillId,
  targetBillId,
  amount,
  date,
  note = "",
}, context = {}) {
  if (context.mode === "automatic" || context.mode === "local-rule") {
    throw new AccountingRuleError("USER_CONFIRMATION_REQUIRED", "预收或预付余额只能在人工确认后使用");
  }
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext({ ...context, mode: "manual" });
  const advanceBill = findBill(next, advanceBillId);
  const targetBill = findBill(next, targetBillId);
  const targetKind = ADVANCE_TARGET_KINDS[advanceBill.kind];
  if (!targetKind) {
    throw new AccountingRuleError("NOT_AN_ADVANCE_BILL", "余额来源必须是客户预收或供应商预付");
  }
  if (targetBill.kind !== targetKind) {
    throw new AccountingRuleError(
      "ADVANCE_TARGET_KIND_MISMATCH",
      advanceBill.kind === BILL_KINDS.DEPOSIT_RECEIVED
        ? "客户预收只能冲销后续应收账单"
        : "供应商预付只能冲销后续应付账单",
    );
  }
  if (String(targetBill.date || "") < String(advanceBill.date || "")) {
    throw new AccountingRuleError("ADVANCE_TARGET_PRECEDES_ADVANCE", "只能选择预收或预付形成之后的账单");
  }
  if (!counterpartyMatch(next, advanceBill, targetBill).matched) {
    throw new AccountingRuleError("ADVANCE_COUNTERPARTY_MISMATCH", "预收或预付与目标账单的标准化交易对手不一致");
  }

  const resolvedAmount = roundMoney(amount);
  if (!Number.isFinite(Number(amount)) || resolvedAmount <= 0) {
    throw new AccountingRuleError("INVALID_ADVANCE_APPLICATION_AMOUNT", "本次使用金额必须大于 0");
  }
  const rules = accountingRules(next);
  const beforeAdvance = advanceBalance(next, advanceBill);
  const beforeTarget = billSettlement(next, targetBill);
  if (resolvedAmount - beforeAdvance.availableBalance > rules.amountTolerance) {
    throw new AccountingRuleError("ADVANCE_BALANCE_EXCEEDED", "本次使用金额超过预收或预付剩余余额", {
      amount: resolvedAmount,
      remaining: beforeAdvance.availableBalance,
    });
  }
  if (resolvedAmount - beforeTarget.remaining > rules.amountTolerance) {
    throw new AccountingRuleError("ADVANCE_TARGET_OVER_SETTLED", "本次使用金额超过目标账单未核销余额", {
      amount: resolvedAmount,
      remaining: beforeTarget.remaining,
    });
  }

  const fundingAllocations = confirmedAllocationsForBill(next, advanceBill.id);
  const applicationId = nextRecordId(next.advanceApplications || [], "advance-application");
  const applicationDate = date || targetBill.date || resolvedContext.at.slice(0, 10);
  const sourceIds = collectSourceIds(
    applicationId,
    advanceBill.id,
    targetBill.id,
    fundingAllocations.map((allocation) => [allocation.id, allocation.transactionId]),
  );
  const application = {
    id: applicationId,
    type: advanceBill.kind === BILL_KINDS.DEPOSIT_RECEIVED
      ? "customer_deposit_application"
      : "supplier_prepayment_application",
    advanceBillId: advanceBill.id,
    targetBillId: targetBill.id,
    amount: resolvedAmount,
    date: applicationDate,
    businessPeriod: targetBill.businessPeriod || periodOf(targetBill.date),
    status: "confirmed",
    accountingStatus: "unprocessed",
    draftVoucherId: null,
    voucherId: null,
    createdAt: resolvedContext.at,
    createdBy: resolvedContext.actor,
    updatedAt: resolvedContext.at,
    mode: "manual",
    note: note || "人工确认使用预收/预付余额",
    sourceIds,
    voucherSource: {
      sourceType: "advanceApplication",
      sourceId: applicationId,
      sourceIds,
      date: applicationDate,
      summary: `${advanceBill.no || advanceBill.id} 冲销 ${targetBill.no || targetBill.id}`,
      amount: resolvedAmount,
      lines: advanceBill.kind === BILL_KINDS.DEPOSIT_RECEIVED
        ? [
          { account: "contractLiability", debit: resolvedAmount, credit: 0, sourceIds: [advanceBill.id, applicationId] },
          { account: "receivable", debit: 0, credit: resolvedAmount, sourceIds: [targetBill.id, applicationId] },
        ]
        : [
          { account: "payable", debit: resolvedAmount, credit: 0, sourceIds: [targetBill.id, applicationId] },
          { account: "prepayment", debit: 0, credit: resolvedAmount, sourceIds: [advanceBill.id, applicationId] },
        ],
    },
  };
  next.advanceApplications = [...(next.advanceApplications || []), application];
  const afterAdvance = advanceBalance(next, advanceBill);
  const afterTarget = billSettlement(next, targetBill);
  appendAuditEntry(next, {
    action: "reconciliation.advance_apply",
    entityType: "advanceApplication",
    entityId: application.id,
    detail: `${advanceBill.no || advanceBill.id} 使用 ${resolvedAmount.toFixed(2)} 冲销 ${targetBill.no || targetBill.id}`,
    before: { advance: beforeAdvance, target: beforeTarget },
    after: { application, advance: afterAdvance, target: afterTarget },
    sourceIds,
  }, resolvedContext);
  return next;
}

export function reverseAdvanceApplication(workspace, { applicationId, reason }, context = {}) {
  if (typeof reason !== "string" || !reason.trim()) throw new AccountingRuleError("ADVANCE_REVERSAL_REASON_REQUIRED", "撤回冲销必须填写原因");
  let next = cloneAccountingState(workspace);
  let application = (next.advanceApplications || []).find((item) => item.id === applicationId);
  if (!application) throw new AccountingRuleError("ADVANCE_APPLICATION_NOT_FOUND", "找不到这笔预收/预付冲销，请刷新后重试");
  const relatedVouchers = vouchersForAdvanceApplication(next, application);
  if (application.accountingStatus === "posted" || application.status === "posted" || relatedVouchers.some((voucher) => voucher.status === "posted")) {
    throw new AccountingRuleError("POSTED_ADVANCE_CORRECTION_REQUIRED", "这笔冲销已经入账，不能直接撤回；请通过原凭证处理更正并保留冲销记录", { applicationId, voucherIds: relatedVouchers.filter((voucher) => voucher.status === "posted").map((voucher) => voucher.id) });
  }
  if (application.status !== "confirmed") throw new AccountingRuleError("ADVANCE_APPLICATION_NOT_ACTIVE", "这笔冲销已撤回或已失效，不能重复撤回");
  assertAccountingPeriodWritable(next, application.businessPeriod || periodOf(application.date));
  if (isPeriodArchived(next, periodOf(application.date))) throw new AccountingRuleError("PERIOD_ARCHIVED", "冲销所属账期已归档，不能直接撤回；请在未归档账期处理调整");
  relatedVouchers.forEach((voucher) => assertAccountingPeriodWritable(next, voucher.period));
  const resolved = operationContext({ ...context, mode: "manual" });
  const note = reason.trim();
  const asOf = settlementPeriodEnd(next.currentPeriod);
  const before = { advance: advanceBalance(next, application.advanceBillId, { asOf }), target: billSettlement(next, application.targetBillId, { asOf }) };
  for (const voucher of relatedVouchers) next = cancelVoucherDraft(next, { voucherId: voucher.id, reason: `撤回冲销：${note}` }, resolved);
  application = next.advanceApplications.find((item) => item.id === applicationId);
  // This unposted application was entered in error: void it in its own open
  // accounting period. cancelledAt remains the actual wall-clock audit time.
  Object.assign(application, { status: "cancelled", accountingStatus: "cancelled", draftVoucherId: null,
    cancelledAt: resolved.at, cancelledBy: resolved.actor, cancellationReason: note, updatedAt: resolved.at, updatedBy: resolved.actor });
  (next.exceptionTasks || []).filter((task) => task.sourceId === applicationId && task.status !== "resolved").forEach((task) => {
    Object.assign(task, { status: "resolved", resolution: "advance_application_cancelled", resolvedAt: resolved.at, resolvedBy: resolved.actor });
    task.history = [...(task.history || []), { at: resolved.at, actor: resolved.actor, action: "advance_application_cancelled", note }];
  });
  appendAuditEntry(next, { action: "reconciliation.advance_reverse", entityType: "advanceApplication", entityId: applicationId,
    detail: `${note}；恢复预收/预付可用余额和对应账单未核销金额`, before,
    after: { application, advance: advanceBalance(next, application.advanceBillId, { asOf }), target: billSettlement(next, application.targetBillId, { asOf }) },
    sourceIds: collectSourceIds(applicationId, application.advanceBillId, application.targetBillId, relatedVouchers.map((voucher) => voucher.id)),
  }, resolved);
  return next;
}

function assertAdvanceFundingCoverage(workspace, billId) {
  const bill = findBill(workspace, billId);
  if (!isAdvanceBill(bill)) return;
  const periods = new Set([workspace.currentPeriod, ...(workspace.advanceApplications || [])
    .filter((application) => application.advanceBillId === billId && ["confirmed", "posted", "reversed"].includes(application.status))
    .flatMap((application) => [application.businessPeriod, periodOf(application.date)])].filter(validAccountingPeriod));
  // Future cash must not hide a deficit in an earlier application month.
  for (const period of [...periods].sort().concat(null)) {
    const asOf = period ? settlementPeriodEnd(period) : undefined;
    const balance = advanceBalance(workspace, bill, { asOf });
    if (balance.fundedAmount + accountingRules(workspace).amountTolerance >= balance.usedAmount) continue;
    const applications = confirmedAdvanceApplications(workspace, { advanceBillId: billId, asOf });
    const targets = [...new Set(applications.map((application) => {
      const target = findBill(workspace, application.targetBillId);
      return target.no || target.summary || "对应账单";
    }))];
    throw new AccountingRuleError("ADVANCE_FUNDING_IN_USE", `撤销后 ${bill.no || bill.summary || "这笔预收/预付"}${period ? ` 在 ${period} 月末` : ""}的资金仅剩 ${balance.fundedAmount.toFixed(2)} 元，不足以覆盖已使用的 ${balance.usedAmount.toFixed(2)} 元。请在预收/预付余额中先撤回对应 ${targets.join("、")} 的未入账冲销；已入账冲销请通过原凭证处理更正。`, { advanceBillId: billId, period, fundedAmount: balance.fundedAmount, usedAmount: balance.usedAmount, applicationIds: applications.map((application) => application.id) });
  }
}

function combinations(items, minimumSize, maximumSize) {
  const results = [];
  function visit(start, selected) {
    if (selected.length >= minimumSize) results.push(selected);
    if (selected.length >= maximumSize) return;
    for (let index = start; index < items.length; index += 1) {
      visit(index + 1, [...selected, items[index]]);
    }
  }
  visit(0, []);
  return results;
}

function allocateCandidate(transactions, bills, billBalances, tolerance) {
  const transactionRemaining = new Map(transactions.map((transaction) => [
    transaction.id,
    transactionUnallocatedAmount(transaction),
  ]));
  const remainingBills = new Map(bills.map((bill) => [bill.id, billBalances.get(bill.id)]));
  const allocations = [];
  transactions.forEach((transaction) => {
    bills.forEach((bill) => {
      const availableTransaction = transactionRemaining.get(transaction.id) || 0;
      const availableBill = remainingBills.get(bill.id) || 0;
      const amount = roundMoney(Math.min(availableTransaction, availableBill));
      if (amount <= tolerance) return;
      allocations.push({ transactionId: transaction.id, billId: bill.id, amount });
      transactionRemaining.set(transaction.id, roundMoney(availableTransaction - amount));
      remainingBills.set(bill.id, roundMoney(availableBill - amount));
    });
  });
  return allocations;
}

function transactionConfidence(workspace, transaction) {
  const explicit = transaction.classification?.confidence ?? transaction.confidence;
  return Number.isFinite(Number(explicit))
    ? Number(explicit)
    : classifyBankTransaction(workspace, transaction).confidence;
}

function buildCandidate(workspace, focusTransaction, matchType, transactions, bills, billBalances) {
  const rules = accountingRules(workspace);
  const allocations = allocateCandidate(transactions, bills, billBalances, rules.amountTolerance);
  if (!allocations.length) return null;

  const allocatedTransactionIds = new Set(allocations.map((allocation) => allocation.transactionId));
  const allocatedBillIds = new Set(allocations.map((allocation) => allocation.billId));
  const effectiveTransactions = transactions.filter((transaction) => allocatedTransactionIds.has(transaction.id));
  const effectiveBills = bills.filter((bill) => allocatedBillIds.has(bill.id));
  if (matchType === "one_to_many" && effectiveBills.length < 2) return null;
  if (matchType === "many_to_one" && effectiveTransactions.length < 2) return null;

  const transactionById = new Map(effectiveTransactions.map((transaction) => [transaction.id, transaction]));
  const billById = new Map(effectiveBills.map((bill) => [bill.id, bill]));
  const partyMatches = allocations.map((allocation) => counterpartyMatch(
    workspace,
    transactionById.get(allocation.transactionId),
    billById.get(allocation.billId),
  ));
  const allPartiesMatch = partyMatches.every((match) => match.matched);
  const partyScore = allPartiesMatch ? Math.min(...partyMatches.map((match) => match.score)) : 0;
  const transactionTotal = sumMoney(effectiveTransactions.map((transaction) => transactionUnallocatedAmount(transaction)));
  const billBalanceTotal = sumMoney(effectiveBills.map((bill) => billBalances.get(bill.id)));
  const matchedAmount = sumMoney(allocations.map((allocation) => allocation.amount));
  const difference = Math.max(0, roundMoney(transactionTotal - matchedAmount));
  const billBalanceAfter = Math.max(0, roundMoney(billBalanceTotal - matchedAmount));
  const exactTotals = Math.abs(transactionTotal - billBalanceTotal) <= rules.amountTolerance;
  const fullyAssigned = difference <= rules.amountTolerance;
  const maximumDays = Math.max(...allocations.map((allocation) => {
    const transaction = transactionById.get(allocation.transactionId);
    const bill = billById.get(allocation.billId);
    return dateDistanceInDays(transaction.date, bill.dueDate || bill.date);
  }));
  const coverageScore = transactionTotal > 0 ? 25 * (matchedAmount / transactionTotal) : 0;
  const balanceScore = exactTotals ? 10 : (billBalanceTotal >= transactionTotal ? 6 : 0);
  const dateScore = maximumDays <= 7 ? 15 : maximumDays <= 31 ? 10 : maximumDays <= 90 ? 5 : 0;
  const rawConfidence = Math.min(99, partyScore + coverageScore + balanceScore + dateScore + 5);
  const confidenceCap = Math.min(...effectiveTransactions.map((transaction) => transactionConfidence(workspace, transaction)));
  const confidence = roundMoney(Math.max(0, Math.min(rawConfidence, confidenceCap)));
  const lowConfidence = confidence < rules.confidenceThreshold;
  const requiresManualReview = !allPartiesMatch || !fullyAssigned || lowConfidence;
  const partyReason = allPartiesMatch
    ? partyMatches[0].reason
    : "候选中存在无法对应的交易对象";
  const amountReason = fullyAssigned
    ? (exactTotals
      ? `金额一致：流水与账单余额均为 ¥${transactionTotal.toFixed(2)}`
      : `流水 ¥${transactionTotal.toFixed(2)} 可全部分配，账单仍余 ¥${billBalanceAfter.toFixed(2)}`)
    : `存在差额：流水仍有 ¥${difference.toFixed(2)} 无法分配`;
  const dateReason = Number.isFinite(maximumDays)
    ? `日期核对：最远相距 ${maximumDays} 天`
    : "日期无法形成有效比较";
  const balanceReason = `${effectiveBills.length} 张账单均按当前未核销余额计算`;
  const reasons = [partyReason, amountReason, dateReason, balanceReason];
  if (lowConfidence) reasons.push(`候选置信度 ${confidence}% 低于 ${rules.confidenceThreshold}%`);

  const transactionIds = effectiveTransactions.map((transaction) => transaction.id);
  const billIds = effectiveBills.map((bill) => bill.id);
  const billNos = effectiveBills.map((bill) => bill.no || bill.id);
  const candidateId = `suggestion-${matchType}-${[...transactionIds].sort().join("+")}-${[...billIds].sort().join("+")}`;
  return {
    id: candidateId,
    type: matchType,
    matchType,
    transactionId: focusTransaction.id,
    transactionIds,
    billId: bills[0].id,
    billIds,
    billNo: billNos.join(" + "),
    billNos,
    billKind: bills[0].kind,
    allocations,
    suggestedAmount: sumMoney(allocations
      .filter((allocation) => allocation.transactionId === focusTransaction.id)
      .map((allocation) => allocation.amount)),
    matchedAmount,
    transactionTotal,
    billBalanceTotal,
    billBalanceAfter,
    difference,
    confidence,
    status: requiresManualReview ? "exception" : "strong",
    requiresManualReview,
    reasons,
    reasonDetails: [
      { key: "counterparty", matched: allPartiesMatch, reason: partyReason },
      { key: "amount", matched: fullyAssigned, reason: amountReason },
      { key: "date", matched: Number.isFinite(maximumDays) && maximumDays <= 31, reason: dateReason },
      { key: "bill_balance", matched: true, reason: balanceReason },
    ],
    sourceIds: collectSourceIds(transactionIds, billIds),
  };
}

function candidateKey(candidate) {
  return `${candidate.type}|${candidate.transactionIds.join(",")}|${candidate.billIds.join(",")}`;
}

function buildReconciliationCandidates(workspace, transactionId) {
  const focusTransaction = findTransaction(workspace, transactionId);
  const classification = effectiveBankTransactionClassification(workspace, focusTransaction);
  const tolerance = accountingRules(workspace).amountTolerance;
  if (NON_BILL_EVENT_TYPES.has(classification.eventType)) return [];
  const expectedBillKind = TRANSACTION_BILL_KINDS[classification.eventType];
  if (!expectedBillKind) return [];
  if (transactionUnallocatedAmount(focusTransaction) <= tolerance) return [];

  const billBalances = new Map();
  const openBills = (workspace.bills || [])
    .filter((bill) => allocationDirectionMatchesBill(focusTransaction, bill))
    .filter((bill) => bill.kind === expectedBillKind)
    .filter((bill) => {
      const remaining = billSettlement(workspace, bill).remaining;
      billBalances.set(bill.id, remaining);
      return remaining > tolerance;
    });
  const candidates = [];
  const seen = new Set();
  function add(matchType, transactions, bills) {
    const candidate = buildCandidate(workspace, focusTransaction, matchType, transactions, bills, billBalances);
    if (!candidate) return;
    const key = candidateKey(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  }

  openBills.forEach((bill) => {
    const match = counterpartyMatch(workspace, focusTransaction, bill);
    const exactAmount = Math.abs(transactionUnallocatedAmount(focusTransaction) - billBalances.get(bill.id)) <= tolerance;
    if (match.matched || exactAmount) add("one_to_one", [focusTransaction], [bill]);
  });

  const matchedBills = openBills
    .filter((bill) => counterpartyMatch(workspace, focusTransaction, bill).matched)
    .sort((left, right) => (
      String(left.dueDate || left.date).localeCompare(String(right.dueDate || right.date))
      || left.id.localeCompare(right.id)
    ));
  combinations(matchedBills.slice(0, 8), 2, Math.min(4, matchedBills.length))
    .forEach((bills) => add("one_to_many", [focusTransaction], bills));
  if (matchedBills.length > 4) add("one_to_many", [focusTransaction], matchedBills);

  matchedBills.forEach((bill) => {
    const otherTransactions = (workspace.transactions || [])
      .filter((transaction) => transaction.id !== focusTransaction.id)
      .filter((transaction) => transactionUnallocatedAmount(transaction) > tolerance)
      .filter((transaction) => allocationDirectionMatchesBill(transaction, bill))
      .filter((transaction) => {
        const candidateClassification = effectiveBankTransactionClassification(workspace, transaction);
        return TRANSACTION_BILL_KINDS[candidateClassification.eventType] === bill.kind;
      })
      .filter((transaction) => counterpartyMatch(workspace, transaction, bill).matched)
      .sort((left, right) => String(left.date).localeCompare(String(right.date)) || left.id.localeCompare(right.id));
    combinations(otherTransactions.slice(0, 7), 1, Math.min(3, otherTransactions.length))
      .forEach((others) => add("many_to_one", [focusTransaction, ...others], [bill]));
    if (otherTransactions.length > 3) add("many_to_one", [focusTransaction, ...otherTransactions], [bill]);
  });

  return candidates.sort((left, right) => (
    Number(left.requiresManualReview) - Number(right.requiresManualReview)
    || left.difference - right.difference
    || right.confidence - left.confidence
    || MATCH_TYPE_ORDER[left.type] - MATCH_TYPE_ORDER[right.type]
    || left.id.localeCompare(right.id)
  ));
}

export function suggestReconciliations(workspace, transactionId, { limit = 8 } = {}) {
  return buildReconciliationCandidates(workspace, transactionId).slice(0, limit);
}

function syncReconciliationSuggestionExceptions(workspace, transaction, suggestion, context) {
  const rules = accountingRules(workspace);
  const definitions = [];
  if (suggestion?.confidence < rules.confidenceThreshold) {
    definitions.push({
      code: "reconciliation_low_confidence",
      message: `核销候选置信度 ${suggestion.confidence}% 低于 ${rules.confidenceThreshold}%`,
    });
  }
  if (suggestion?.difference > rules.amountTolerance) {
    definitions.push({
      code: "reconciliation_amount_difference",
      message: `核销候选仍有 ¥${suggestion.difference.toFixed(2)} 流水差额`,
    });
  }
  const activeCodes = new Set(definitions.map((definition) => definition.code));
  const tasks = workspace.exceptionTasks || (workspace.exceptionTasks = []);
  definitions.forEach((definition) => {
    const identity = `${transaction.id}:${definition.code}`;
    const existing = tasks.find((task) => task.identity === identity && task.status !== "resolved");
    if (existing) {
      existing.message = definition.message;
      existing.status = "open";
      existing.updatedAt = context.at;
      existing.sourceIds = collectSourceIds(transaction.id, suggestion?.sourceIds || []);
      return;
    }
    tasks.push({
      id: nextRecordId(tasks, "exception"),
      identity,
      code: definition.code,
      sourceType: "bankTransaction",
      sourceId: transaction.id,
      message: definition.message,
      missingEvidence: [],
      status: "open",
      createdAt: context.at,
      updatedAt: context.at,
      sourceIds: collectSourceIds(transaction.id, suggestion?.sourceIds || []),
      history: [{ at: context.at, actor: context.actor, action: "created", note: definition.message }],
    });
  });
  tasks
    .filter((task) => task.sourceId === transaction.id
      && ["reconciliation_low_confidence", "reconciliation_amount_difference"].includes(task.code)
      && task.status === "open"
      && !activeCodes.has(task.code))
    .forEach((task) => {
      task.status = "ready_for_review";
      task.updatedAt = context.at;
      task.history = [...(task.history || []), {
        at: context.at,
        actor: context.actor,
        action: "candidate_improved",
        note: "当前最佳核销候选已不再触发该异常",
      }];
    });
  return definitions;
}

export function recordReconciliationSuggestions(workspace, transactionId, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext({ ...context, mode: "local-rule" });
  const transaction = findTransaction(next, transactionId);
  const before = transaction.matchSuggestions || [];
  const suggestions = suggestReconciliations(next, transactionId);
  transaction.matchSuggestions = suggestions.map((suggestion) => ({ ...suggestion, createdAt: resolvedContext.at }));
  const suggestionIssues = syncReconciliationSuggestionExceptions(next, transaction, suggestions[0], resolvedContext);
  if (suggestions.length && suggestionIssues.length) {
    transaction.status = "exception";
  } else if (!activeAllocations(transaction).length && suggestions.length) {
    transaction.status = transaction.status === "exception" ? "exception" : "suspected";
  }
  appendAuditEntry(next, {
    action: "reconciliation.suggest",
    entityType: "bankTransaction",
    entityId: transaction.id,
    detail: suggestions.length ? `形成 ${suggestions.length} 个本地疑似匹配` : "没有找到可解释的账单匹配",
    before,
    after: transaction.matchSuggestions,
    sourceIds: collectSourceIds(transaction.id, suggestions.map((item) => item.sourceIds)),
  }, resolvedContext);
  return next;
}

const EXCEPTION_ACTIONS = new Set(["recalculate", "rematch", "adopt_treatment", "defer"]);

const TREATMENT_LABELS = {
  [EVENT_TYPES.CUSTOMER_RECEIPT]: "客户收款 / 冲应收",
  [EVENT_TYPES.MEMBER_RECHARGE]: "客户预收",
  [EVENT_TYPES.SUPPLIER_SETTLEMENT]: "供应商月结 / 冲应付",
  [EVENT_TYPES.SUPPLIER_PREPAYMENT]: "供应商预付",
  [EVENT_TYPES.PURCHASE_EXPENSE]: "采购费用",
  [EVENT_TYPES.PAYROLL]: "工资社保",
  [EVENT_TYPES.RENT_AND_PROPERTY]: "房租物业",
  [EVENT_TYPES.BANK_FEE]: "银行手续费",
  [EVENT_TYPES.REFUND]: "退款",
  [EVENT_TYPES.LOAN]: "借款或还款",
  [EVENT_TYPES.EMPLOYEE_ADVANCE]: "员工代垫",
  [EVENT_TYPES.RELATED_PARTY]: "关联方往来",
  [EVENT_TYPES.INTERNAL_TRANSFER]: "内部转账",
};

function directTreatment(workspace, eventType, account) {
  const resolvedAccount = resolveWorkspaceAccountDefinition(workspace, account, { allowInactive: false });
  if (!resolvedAccount) return null;
  return {
    id: `classification:${eventType}:${resolvedAccount.id}`,
    kind: "classification",
    eventType,
    account: resolvedAccount.id,
    accountLabel: resolvedAccount.label,
    label: `${TREATMENT_LABELS[eventType] || eventType} → ${resolvedAccount.label}`,
  };
}

function accountingTreatmentsForException(workspace, transaction, classification, suggestions) {
  const rules = accountingRules(workspace);
  const treatments = suggestions
    .filter((suggestion) => suggestion.transactionIds.length === 1 && suggestion.difference <= rules.amountTolerance)
    .slice(0, 5)
    .map((suggestion) => ({
      id: `reconciliation:${suggestion.id}`,
      kind: "reconciliation",
      suggestionId: suggestion.id,
      label: `按 ${suggestion.billNos.join(" + ")} 核销 ¥${suggestion.matchedAmount.toFixed(2)}（${suggestion.confidence}%）`,
      confidence: suggestion.confidence,
      reasons: suggestion.reasons,
    }));
  if (classification.eventType !== EVENT_TYPES.UNKNOWN && classification.account) {
    treatments.push(directTreatment(workspace, classification.eventType, classification.account));
  } else if (Number(transaction.amount) >= 0) {
    treatments.push(
      directTreatment(workspace, EVENT_TYPES.CUSTOMER_RECEIPT, "receivable"),
      ...(memberBusinessEnabled(workspace)
        ? [directTreatment(workspace, EVENT_TYPES.MEMBER_RECHARGE, "contractLiability")]
        : []),
      directTreatment(workspace, EVENT_TYPES.RELATED_PARTY, "relatedParty"),
    );
  } else {
    treatments.push(
      directTreatment(workspace, EVENT_TYPES.SUPPLIER_SETTLEMENT, "payable"),
      directTreatment(workspace, EVENT_TYPES.SUPPLIER_PREPAYMENT, "prepayment"),
      directTreatment(workspace, EVENT_TYPES.PURCHASE_EXPENSE, "expenseOther"),
      directTreatment(workspace, EVENT_TYPES.REFUND, "salesReturns"),
    );
  }
  return treatments.filter(Boolean).filter((treatment, index, all) => (
    all.findIndex((candidate) => candidate.id === treatment.id) === index
  ));
}

export function buildReconciliationExceptionCases(workspace, transactionId) {
  const tasks = unresolvedExceptionTasks(workspace, transactionId)
    .filter((task) => task.sourceType === "bankTransaction" || !task.sourceType);
  return tasks.map((task) => {
    const transaction = findTransaction(workspace, task.sourceId);
    const classification = effectiveBankTransactionClassification(workspace, transaction);
    const assessment = assessTransactionEvidence(workspace, transaction, classification);
    const suggestions = (transaction.matchSuggestions || []).length
      ? transaction.matchSuggestions
      : suggestReconciliations(workspace, transaction.id, { limit: 8 });
    const relatedTransactionIds = collectSourceIds(transaction.id, suggestions.map((suggestion) => suggestion.transactionIds));
    const relatedBillIds = collectSourceIds(
      task.sourceIds || [],
      classification.candidateBillIds || [],
      suggestions.map((suggestion) => suggestion.billIds),
      activeAllocations(transaction).map((allocation) => allocation.billId),
    ).filter((sourceId) => (workspace.bills || []).some((bill) => bill.id === sourceId));
    const relatedBills = relatedBillIds.map((billId) => {
      const bill = findBill(workspace, billId);
      return {
        id: bill.id,
        no: bill.no,
        kind: bill.kind,
        counterparty: bill.counterparty,
        amount: roundMoney(bill.amount),
        remaining: billSettlement(workspace, bill).remaining,
      };
    });
    const relatedDocumentIds = collectSourceIds(
      task.sourceIds || [],
      transaction.evidenceIds || [],
      assessment.linkedDocumentIds || [],
      relatedBills.map((bill) => findBill(workspace, bill.id).evidenceIds || []),
    );
    const relatedDocuments = (workspace.documents || [])
      .filter((document) => relatedDocumentIds.includes(document.id))
      .map((document) => ({ id: document.id, name: document.name || document.title || document.id, type: document.type || "资料" }));
    const matchBasis = collectSourceIds(
      classification.reasons || [],
      suggestions.slice(0, 3).map((suggestion) => (
        `${suggestion.billNos.join(" + ")} · ${suggestion.confidence}% · ${suggestion.reasons.join("；")}`
      )),
    );
    return {
      id: task.id,
      code: task.code,
      status: task.status,
      workflowState: task.workflowState || (task.status === "ready_for_review" ? "ready_for_review" : "awaiting_verification"),
      triggerReason: task.message || task.code,
      transaction: {
        id: transaction.id,
        serial: transaction.serial,
        date: transaction.date,
        counterparty: transaction.counterparty,
        summary: transaction.summary,
        amount: roundMoney(transaction.amount),
        status: transaction.status,
      },
      relatedTransactions: (workspace.transactions || [])
        .filter((candidate) => relatedTransactionIds.includes(candidate.id))
        .map((candidate) => ({ id: candidate.id, serial: candidate.serial, date: candidate.date, counterparty: candidate.counterparty, amount: roundMoney(candidate.amount) })),
      relatedBills,
      relatedDocuments,
      missingContents: (task.missingEvidence || assessment.missing || []).map((item) => ({
        id: item.id || item.code || String(item),
        label: item.label || item.message || String(item),
      })),
      matchBasis,
      accountingTreatments: accountingTreatmentsForException(workspace, transaction, classification, suggestions),
      history: [...(task.history || [])],
      sourceIds: collectSourceIds(transaction.id, task.sourceIds || [], relatedTransactionIds, relatedBillIds, relatedDocumentIds),
    };
  });
}

export function handleReconciliationException(workspace, {
  exceptionId,
  action,
  note,
  treatmentId,
}, context = {}) {
  if (!EXCEPTION_ACTIONS.has(action)) throw new AccountingRuleError("INVALID_EXCEPTION_ACTION", "请选择有效的异常处理动作");
  if (!note?.trim()) throw new AccountingRuleError("EXCEPTION_REVIEW_NOTE_REQUIRED", "异常处理必须填写复核说明");
  const sourceTask = (workspace.exceptionTasks || []).find((item) => item.id === exceptionId && item.status !== "resolved");
  const initialCase = sourceTask
    ? buildReconciliationExceptionCases(workspace, sourceTask.sourceId).find((item) => item.id === exceptionId)
    : null;
  if (!initialCase) throw new AccountingRuleError("EXCEPTION_NOT_FOUND", `找不到待处理异常：${exceptionId}`);
  const resolvedContext = operationContext({ ...context, mode: "manual" });
  const before = { status: initialCase.status, workflowState: initialCase.workflowState };
  let next = cloneAccountingState(workspace);

  if (action === "recalculate") {
    next = reassessBankTransactionBusinessEvent(next, initialCase.transaction.id, resolvedContext)
      || reviewTransactionEvidence(next, initialCase.transaction.id, { ...resolvedContext, mode: "local-rule" });
    next = recordReconciliationSuggestions(next, initialCase.transaction.id, { ...resolvedContext, mode: "local-rule" });
  } else if (action === "rematch") {
    const transaction = findTransaction(next, initialCase.transaction.id);
    transaction.matchSuggestions = [];
    if (!["reconciled", "posted"].includes(transaction.status)) transaction.status = "pending";
    next = recordReconciliationSuggestions(next, transaction.id, { ...resolvedContext, mode: "local-rule" });
    const refreshed = findTransaction(next, transaction.id);
    const strongSuggestion = (refreshed.matchSuggestions || []).find((suggestion) => !suggestion.requiresManualReview);
    const task = (next.exceptionTasks || []).find((item) => item.id === exceptionId);
    if (strongSuggestion && task?.code?.startsWith("reconciliation_")) {
      task.status = "resolved";
      task.resolution = "returned_to_matching";
      task.resolvedAt = resolvedContext.at;
      task.resolvedBy = resolvedContext.actor;
      task.workflowState = "returned_to_matching";
      const otherOpen = unresolvedExceptionTasks(next, refreshed.id).filter((item) => item.id !== task.id);
      refreshed.status = otherOpen.length ? "exception" : "suspected";
    } else if (task) {
      task.status = "open";
      task.workflowState = "awaiting_verification";
      refreshed.status = "exception";
    }
  } else if (action === "adopt_treatment") {
    const treatment = initialCase.accountingTreatments.find((item) => item.id === treatmentId);
    if (!treatment) throw new AccountingRuleError("ACCOUNTING_TREATMENT_REQUIRED", "请选择要采用的会计处理");
    if (treatment.kind === "reconciliation") {
      const suggestion = suggestReconciliations(next, initialCase.transaction.id, { limit: 100 })
        .find((candidate) => candidate.id === treatment.suggestionId);
      if (!suggestion || suggestion.transactionIds.length !== 1 || suggestion.difference > accountingRules(next).amountTolerance) {
        throw new AccountingRuleError("ACCOUNTING_TREATMENT_UNRESOLVED", "该匹配仍有差额或已失效，不能强制采用");
      }
      next = recordManualConfirmation(next, {
        transactionId: initialCase.transaction.id,
        decision: "approve",
        reason: note.trim(),
        resolvedCodes: [initialCase.code],
      }, resolvedContext);
      next = applyReconciliation(next, {
        transactionId: initialCase.transaction.id,
        allocations: suggestion.allocations.map((allocation) => ({ billId: allocation.billId, amount: allocation.amount })),
        note: note.trim(),
      }, resolvedContext);
    } else {
      next = applyManualClassification(next, {
        transactionId: initialCase.transaction.id,
        eventType: treatment.eventType,
        account: treatment.account,
        reason: note.trim(),
      }, resolvedContext);
      next = recordManualConfirmation(next, {
        transactionId: initialCase.transaction.id,
        decision: "approve",
        reason: note.trim(),
        resolvedCodes: [initialCase.code],
      }, resolvedContext);
    }
    const transaction = findTransaction(next, initialCase.transaction.id);
    if (unresolvedExceptionTasks(next, transaction.id).length) transaction.status = "exception";
    const task = (next.exceptionTasks || []).find((item) => item.id === exceptionId);
    if (task) {
      task.workflowState = "treatment_adopted";
      task.selectedTreatmentId = treatment.id;
      task.selectedTreatmentLabel = treatment.label;
    }
  } else {
    const transaction = findTransaction(next, initialCase.transaction.id);
    const task = (next.exceptionTasks || []).find((item) => item.id === exceptionId);
    task.status = "open";
    task.workflowState = "deferred";
    task.resolution = "deferred";
    task.resolvedAt = null;
    task.resolvedBy = null;
    transaction.status = "exception";
  }

  const task = (next.exceptionTasks || []).find((item) => item.id === exceptionId);
  const transaction = findTransaction(next, initialCase.transaction.id);
  if (action === "recalculate" && task) {
    task.workflowState = task.status === "ready_for_review" ? "recalculated_ready_for_review" : "awaiting_evidence";
    if (task.status === "ready_for_review") task.missingEvidence = [];
  }
  const actionRecord = {
    at: resolvedContext.at,
    actor: resolvedContext.actor,
    action,
    note: note.trim(),
    treatmentId: treatmentId || null,
    fromStatus: before.status,
    toStatus: task?.status || "resolved",
  };
  if (task) {
    task.reviewNote = note.trim();
    task.lastAction = action;
    task.updatedAt = resolvedContext.at;
    task.history = [...(task.history || []), actionRecord];
  }
  transaction.exceptionHistory = [...(transaction.exceptionHistory || []), { ...actionRecord, exceptionId }];
  const linkedBusinessEvent = transactionBusinessEvent(next, transaction);
  if (linkedBusinessEvent) {
    updateBusinessEventReviewState(next, transaction, linkedBusinessEvent, resolvedContext, {
      approveWhenClear: action === "adopt_treatment",
    });
  }
  appendAuditEntry(next, {
    action: `reconciliation.exception_${action}`,
    entityType: "exceptionTask",
    entityId: exceptionId,
    detail: note.trim(),
    before,
    after: { status: task?.status || "resolved", workflowState: task?.workflowState || "resolved", treatmentId: treatmentId || null },
    sourceIds: initialCase.sourceIds,
  }, resolvedContext);
  return next;
}

function validateAutomaticReconciliation(workspace, transaction) {
  const rules = accountingRules(workspace);
  const classification = effectiveBankTransactionClassification(workspace, transaction);
  const assessment = assessTransactionEvidence(workspace, transaction, classification);
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

export function buildReconciliationAllocationDraft(workspace, { transactionId, allocations = [] }) {
  const transaction = findTransaction(workspace, transactionId);
  const tolerance = accountingRules(workspace).amountTolerance;
  const transactionRemaining = transactionUnallocatedAmount(transaction);
  const temporaryBillUsage = new Map();
  const issues = [];

  const rows = allocations.map((input) => {
    const bill = (workspace.bills || []).find((item) => item.id === input.billId);
    const numericAmount = Number(input.amount);
    const amount = Number.isFinite(numericAmount) ? roundMoney(numericAmount) : null;

    if (!bill) {
      const issue = {
        code: "BILL_NOT_FOUND",
        message: "所选账单已不存在，请重新选择",
        details: { billId: input.billId },
      };
      issues.push(issue);
      return { billId: input.billId, amount, billRemaining: 0, available: 0, issue };
    }

    const alreadyRequested = temporaryBillUsage.get(bill.id) || 0;
    const billRemaining = billSettlement(workspace, bill).remaining;
    const available = Math.max(0, roundMoney(billRemaining - alreadyRequested));
    let issue = null;

    if (amount === null || amount <= 0) {
      issue = {
        code: "INVALID_ALLOCATION_AMOUNT",
        message: "核销金额必须是大于 0 的有效数字",
        details: { amount: input.amount, billId: bill.id },
      };
    } else if (!allocationDirectionMatchesBill(transaction, bill)) {
      issue = {
        code: "DIRECTION_MISMATCH",
        message: "收款只能核销应收/预收，付款只能核销应付/预付",
        details: { transactionId, billId: bill.id },
      };
    } else if (amount - available > tolerance) {
      issue = {
        code: "BILL_OVER_ALLOCATED",
        message: `核销金额超过账单 ${bill.no || bill.id} 的剩余余额`,
        details: { amount, remaining: available },
      };
    }

    if (amount !== null && amount > 0) {
      temporaryBillUsage.set(bill.id, roundMoney(alreadyRequested + amount));
    }
    if (issue) issues.push(issue);

    return {
      billId: bill.id,
      billNo: bill.no || bill.id,
      amount,
      billRemaining,
      available,
      issue,
    };
  });

  const requested = sumMoney(rows.map((row) => (row.amount !== null && row.amount > 0 ? row.amount : 0)));
  const overBy = Math.max(0, roundMoney(requested - transactionRemaining));
  if (overBy > tolerance) {
    issues.unshift({
      code: "TRANSACTION_OVER_ALLOCATED",
      message: `本次分配超过流水未核销余额 ${overBy.toFixed(2)}`,
      details: { requested, transactionRemaining, overBy },
    });
  }

  return {
    transactionId,
    transactionRemaining,
    requested,
    remainingAfter: Math.max(0, roundMoney(transactionRemaining - requested)),
    overBy,
    rows,
    issues,
    valid: rows.length > 0 && issues.length === 0,
    message: rows.length ? issues[0]?.message || "" : "请至少填写一笔本次核销金额",
  };
}

export function applyReconciliation(workspace, { transactionId, allocations, note = "" }, context = {}) {
  if (!Array.isArray(allocations) || !allocations.length) {
    throw new AccountingRuleError("ALLOCATION_REQUIRED", "至少需要一条核销分配");
  }
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const transaction = findTransaction(next, transactionId);
  assertAccountingPeriodWritable(next, periodOf(transaction.date));
  const classification = effectiveBankTransactionClassification(next, transaction);
  if ([EVENT_TYPES.INTERNAL_TRANSFER, EVENT_TYPES.REFUND, EVENT_TYPES.UNKNOWN].includes(classification.eventType)) {
    throw new AccountingRuleError("NON_BILL_EVENT", "退款、内部转账或未知事项不能按普通应收应付核销");
  }
  if (resolvedContext.mode === "automatic") validateAutomaticReconciliation(next, transaction);

  const before = transactionSettlement(transaction);
  const allocationDraft = buildReconciliationAllocationDraft(next, { transactionId, allocations });
  if (!allocationDraft.valid) {
    const issue = allocationDraft.issues[0];
    throw new AccountingRuleError(issue.code, issue.message, issue.details);
  }
  const requested = allocationDraft.requested;

  const created = allocationDraft.rows.map((row, index) => {
    const input = allocations[index];
    const bill = findBill(next, row.billId);
    return {
      id: nextRecordId(allAllocations(next), "allocation"),
      transactionId: transaction.id,
      billId: bill.id,
      amount: row.amount,
      status: "confirmed",
      mode: resolvedContext.mode,
      createdAt: resolvedContext.at,
      createdBy: resolvedContext.actor,
      note: input.note || note,
      businessPeriod: input.businessPeriod || bill.businessPeriod || periodOf(bill.date),
      fundingPeriod: periodOf(transaction.date),
      sourceIds: collectSourceIds(transaction.id, bill.id),
    };
  });

  // nextRecordId needs to see allocations created earlier in this same operation.
  const existingIds = allAllocations(next);
  created.forEach((item, index) => {
    item.id = nextRecordId([...existingIds, ...created.slice(0, index)], "allocation");
  });
  transaction.allocations = [...(transaction.allocations || []), ...created];
  const allocatedBillIds = new Set(created.map((item) => item.billId));
  transaction.matchSuggestions = (transaction.matchSuggestions || []).filter((item) => (
    !(item.billIds || [item.billId]).some((billId) => allocatedBillIds.has(billId))
  ));
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

export function confirmReconciliationSuggestion(workspace, {
  transactionId,
  suggestionId,
  note = "",
}, context = {}) {
  if (context.mode === "automatic" || context.mode === "local-rule") {
    throw new AccountingRuleError("USER_CONFIRMATION_REQUIRED", "匹配建议只能在用户明确确认后写入核销分配");
  }
  const resolvedContext = operationContext({ ...context, mode: "manual" });
  const suggestion = buildReconciliationCandidates(workspace, transactionId)
    .find((candidate) => candidate.id === suggestionId);
  if (!suggestion) {
    throw new AccountingRuleError("RECONCILIATION_SUGGESTION_STALE", "该匹配建议已失效，请重新生成后再确认");
  }
  if (suggestion.requiresManualReview) {
    throw new AccountingRuleError("RECONCILIATION_REVIEW_REQUIRED", "低置信度或仍有差额的候选必须继续作为异常人工处理", {
      confidence: suggestion.confidence,
      difference: suggestion.difference,
    });
  }

  const allocationIdsBefore = new Set(allAllocations(workspace).map((allocation) => allocation.id));
  let next = workspace;
  suggestion.transactionIds.forEach((candidateTransactionId) => {
    const allocations = suggestion.allocations
      .filter((allocation) => allocation.transactionId === candidateTransactionId)
      .map((allocation) => ({ billId: allocation.billId, amount: allocation.amount }));
    if (!allocations.length) return;
    next = applyReconciliation(next, {
      transactionId: candidateTransactionId,
      allocations,
      note: note || `用户确认核销建议 ${suggestion.id}`,
    }, resolvedContext);
  });

  const confirmed = cloneAccountingState(next);
  const createdAllocationIds = allAllocations(confirmed)
    .filter((allocation) => !allocationIdsBefore.has(allocation.id))
    .map((allocation) => allocation.id);
  appendAuditEntry(confirmed, {
    action: "reconciliation.suggestion_confirm",
    entityType: "reconciliationSuggestion",
    entityId: suggestion.id,
    detail: `用户确认${suggestion.transactionIds.length} 笔流水与 ${suggestion.billIds.length} 张账单，核销 ${suggestion.matchedAmount.toFixed(2)}`,
    before: suggestion,
    after: { allocationIds: createdAllocationIds },
    sourceIds: collectSourceIds(suggestion.sourceIds, createdAllocationIds),
  }, resolvedContext);
  return confirmed;
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
  assertAccountingPeriodWritable(next, allocation.fundingPeriod || periodOf(transaction.date));
  if (allocation.status === "reversed") throw new AccountingRuleError("ALREADY_REVERSED", "该核销记录已经撤销");
  const posted = vouchersForReconciliation(next, transaction.id, allocation.id).filter((voucher) => voucher.status === "posted");
  if (posted.length) throw new AccountingRuleError("POSTED_RECONCILIATION_CORRECTION_REQUIRED", "该核销已经入账；请选择正确账单并创建核销更正草稿，复核入账时同步替换核销和凭证", { voucherIds: posted.map((voucher) => voucher.id) });
  const before = transactionSettlement(transaction);
  allocation.status = "reversed";
  allocation.reversalEffectiveDate = allocation.date || transaction.date;
  assertAdvanceFundingCoverage(next, allocation.billId);
  allocation.reversedAt = resolvedContext.at;
  allocation.reversedBy = resolvedContext.actor;
  allocation.reversalReason = reason.trim();
  const after = transactionSettlement(transaction);
  transaction.status = "pending";
  appendAuditEntry(next, {
    action: "reconciliation.reverse",
    entityType: "allocation",
    entityId: allocation.id,
    detail: reason.trim(),
    before,
    after,
    sourceIds: [transaction.id, allocation.billId, allocation.id],
  }, resolvedContext);
  return invalidateReconciliationDrafts(next, transaction.id, allocation.id, `撤销核销：${reason.trim()}`, resolvedContext);
}

function correctionAllocation(workspace, allocationId) {
  for (const transaction of workspace.transactions || []) {
    const allocation = (transaction.allocations || []).find((item) => item.id === allocationId);
    if (allocation) return { transaction, allocation };
  }
  throw new AccountingRuleError("ALLOCATION_NOT_FOUND", `找不到核销记录：${allocationId}`);
}

function validateCorrectionReplacement(workspace, allocation, transaction, replacement) {
  assertAccountingPeriodWritable(workspace, allocation.fundingPeriod || periodOf(transaction.date));
  if (allocation.status === "reversed") throw new AccountingRuleError("ALREADY_REVERSED", "原核销已变化，请取消旧更正草稿后重新选择");
  if (allocation.billId === replacement.billId) throw new AccountingRuleError("CORRECTION_TARGET_REQUIRED", "请选择与原核销不同的正确账单");
  if (roundMoney(allocation.amount) !== roundMoney(replacement.amount)) throw new AccountingRuleError("CORRECTION_AMOUNT_CHANGED", "本次核销更正保持原核销金额，请重新选择正确账单");
  const preview = cloneAccountingState(workspace);
  Object.assign(correctionAllocation(preview, allocation.id).allocation, { status: "reversed", reversalEffectiveDate: allocation.date || transaction.date });
  assertAdvanceFundingCoverage(preview, allocation.billId);
  const draft = buildReconciliationAllocationDraft(preview, { transactionId: transaction.id, allocations: [replacement] });
  if (!draft.valid) throw new AccountingRuleError(draft.issues[0].code, draft.issues[0].message, draft.issues[0].details);
}

export function createReconciliationCorrection(workspace, { allocationId, billId, reason }, context = {}) {
  if (!reason?.trim()) throw new AccountingRuleError("REVERSAL_REASON_REQUIRED", "核销更正必须填写原因");
  const { transaction, allocation } = correctionAllocation(workspace, allocationId);
  const posted = vouchersForReconciliation(workspace, transaction.id, allocationId).filter((voucher) => voucher.status === "posted");
  if (posted.length !== 1) throw new AccountingRuleError("CORRECTION_VOUCHER_REQUIRED", "核销更正需要唯一有效的已入账凭证；未入账记录可直接撤销后重新核销");
  const resolvedContext = operationContext({ ...context, mode: "manual" });
  const replacement = { billId, amount: allocation.amount };
  validateCorrectionReplacement(workspace, allocation, transaction, replacement);
  let next = createPostedVoucherRevision(workspace, { voucherId: posted[0].id, reason }, resolvedContext);
  const revision = next.vouchers[next.vouchers.length - 1];
  const targetBill = findBill(next, billId);
  const plannedAllocation = {
    ...replacement,
    id: `allocation-correction-${revision.id}`,
    transactionId: transaction.id,
    status: "confirmed",
    mode: "manual",
    fundingPeriod: allocation.fundingPeriod || periodOf(transaction.date),
    businessPeriod: targetBill.businessPeriod || periodOf(targetBill.date),
    sourceIds: [transaction.id, billId],
    note: reason.trim(),
  };
  const rebuilt = buildReconciliationCorrectionLines(next, revision, allocation, plannedAllocation);
  next = reviseDraftVoucher(next, {
    voucherId: revision.id,
    ...rebuilt,
    reconciliationCorrection: { transactionId: transaction.id, originalAllocation: structuredClone(allocation), replacement: plannedAllocation, reason: reason.trim(), status: "pending" },
    reason: `核销更正：${reason.trim()}`,
  }, resolvedContext);
  appendAuditEntry(next, { action: "reconciliation.prepare_correction", entityType: "allocation", entityId: allocation.id, detail: `${reason.trim()}；原核销与凭证继续有效，待 ${revision.id} 复核入账`, sourceIds: [transaction.id, allocation.id, billId, posted[0].id, revision.id] }, resolvedContext);
  return next;
}

export function cancelReconciliationCorrection(workspace, { voucherId, reason }, context = {}) {
  if (!reason?.trim()) throw new AccountingRuleError("REVISION_REASON_REQUIRED", "取消更正草稿必须填写原因");
  const voucher = (workspace.vouchers || []).find((item) => item.id === voucherId);
  if (!voucher?.revisionOf || !["draft", "changes_requested"].includes(voucher.status)) throw new AccountingRuleError("CORRECTION_DRAFT_REQUIRED", "只能取消尚未入账的更正草稿");
  return cancelVoucherDraft(workspace, { voucherId, reason }, context);
}

// Called on postVoucher's private clone. Any later posting error discards this
// change together with the voucher, so business and accounting commit together.
export function commitReconciliationCorrection(workspace, voucher, context) {
  const plan = voucher.reconciliationCorrection;
  if (plan?.status !== "pending") throw new AccountingRuleError("CORRECTION_NOT_PENDING", "该核销更正已经处理，不能重复入账");
  const { transaction, allocation } = correctionAllocation(workspace, plan.originalAllocation.id);
  if (transaction.id !== plan.transactionId || allocation.billId !== plan.originalAllocation.billId
    || roundMoney(allocation.amount) !== roundMoney(plan.originalAllocation.amount)) {
    throw new AccountingRuleError("CORRECTION_SOURCE_CHANGED", "原核销已变化，请取消此草稿并从当前记录重新更正");
  }
  const posted = vouchersForReconciliation(workspace, transaction.id, allocation.id).filter((item) => item.status === "posted");
  if (posted.length !== 1 || posted[0].id !== voucher.revisionOf) throw new AccountingRuleError("CORRECTION_ORIGINAL_CHANGED", "核销对应的有效凭证已变化，请重新创建更正");
  assertAccountingPeriodWritable(workspace, posted[0].period);
  validateCorrectionReplacement(workspace, allocation, transaction, plan.replacement);
  if (allAllocations(workspace).some((item) => item.id === plan.replacement.id)) throw new AccountingRuleError("CORRECTION_ALREADY_APPLIED", "目标核销记录已存在，请取消此草稿后重新更正");
  const before = transactionSettlement(transaction);
  allocation.status = "reversed";
  allocation.reversedAt = context.at;
  allocation.reversalEffectiveDate = allocation.date || transaction.date;
  allocation.reversedBy = context.actor;
  allocation.reversalReason = plan.reason;
  allocation.correctedByVoucherId = voucher.id;
  const replacement = { ...structuredClone(plan.replacement), createdAt: context.at, createdBy: context.actor, correctionOf: allocation.id, voucherId: voucher.id };
  transaction.allocations.push(replacement);
  plan.status = "committed";
  plan.committedAt = context.at;
  voucher.reconciliationSources = (transaction.allocations || []).filter((item) => voucher.sourceIds?.includes(item.id)).map(({ id, billId, amount }) => ({ id, billId, amount }));
  const event = (workspace.businessEvents || []).find((item) => item.id === voucher.bankBusinessEventId && item.relatedBillId === allocation.billId);
  if (event) {
    event.versions = [...(event.versions || []), { at: context.at, actor: context.actor, reason: plan.reason, relatedBillId: event.relatedBillId, sourceIds: [...(event.sourceIds || [])] }];
    event.relatedBillId = replacement.billId;
    event.sourceIds = collectSourceIds((event.sourceIds || []).filter((id) => id !== allocation.billId), replacement.billId);
  }
  appendAuditEntry(workspace, { action: "reconciliation.correct", entityType: "allocation", entityId: allocation.id, detail: `${plan.reason}；与更正凭证 ${voucher.id} 同步生效`, before, after: transactionSettlement(transaction), sourceIds: [transaction.id, allocation.id, replacement.id, replacement.billId, voucher.id, voucher.revisionOf] }, context);
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
  const classification = effectiveBankTransactionClassification(next, refund);
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
  const resolvedDate = asOf || settlementPeriodEnd(workspace.currentPeriod);
  const allowedKinds = kind ? [kind] : [BILL_KINDS.RECEIVABLE, BILL_KINDS.PAYABLE];
  const rows = (workspace.bills || [])
    .filter((bill) => allowedKinds.includes(bill.kind) && settlementBillIsEffective(bill, resolvedDate))
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
        sourceIds: collectSourceIds(bill.id, settlement.transactionIds, settlement.allocationIds, settlement.advanceApplicationIds, settlement.advanceBillIds),
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

export function buildAdvanceBalances(workspace, { asOf } = {}) {
  const rows = (workspace.bills || [])
    .filter((bill) => [BILL_KINDS.DEPOSIT_RECEIVED, BILL_KINDS.PREPAYMENT_PAID].includes(bill.kind) && settlementBillIsEffective(bill, asOf))
    .map((bill) => {
      const balance = advanceBalance(workspace, bill, { asOf });
      const applicationHistory = (workspace.advanceApplications || []).filter((application) => application.advanceBillId === bill.id
        && (!asOf || String(application.date || application.createdAt || "").slice(0, 10) <= asOf)).map((application) => {
        const targetBill = (workspace.bills || []).find((candidate) => candidate.id === application.targetBillId);
        return {
          ...application,
          targetBillNo: targetBill?.no,
          targetCounterparty: targetBill?.counterparty,
          targetSummary: targetBill?.summary,
        };
      });
      const applications = applicationHistory.filter((application) => settlementRecordIsEffective(application, asOf, application.date || String(application.createdAt || "").slice(0, 10)));
      return {
        billId: bill.id,
        billNo: bill.no,
        kind: bill.kind,
        counterparty: bill.counterparty,
        originalAmount: balance.originalAmount,
        originalBalance: balance.originalBalance,
        fundedAmount: balance.fundedAmount,
        usedAmount: balance.usedAmount,
        remaining: balance.availableBalance,
        availableBalance: balance.availableBalance,
        pendingFunding: balance.pendingFunding,
        applications,
        applicationHistory,
        sourceIds: balance.sourceIds,
      };
    });
  return {
    depositsReceived: sumMoney(rows.filter((row) => row.kind === BILL_KINDS.DEPOSIT_RECEIVED).map((row) => row.availableBalance)),
    prepaymentsPaid: sumMoney(rows.filter((row) => row.kind === BILL_KINDS.PREPAYMENT_PAID).map((row) => row.availableBalance)),
    depositsReceivedFunded: sumMoney(rows.filter((row) => row.kind === BILL_KINDS.DEPOSIT_RECEIVED).map((row) => row.fundedAmount)),
    prepaymentsPaidFunded: sumMoney(rows.filter((row) => row.kind === BILL_KINDS.PREPAYMENT_PAID).map((row) => row.fundedAmount)),
    depositsReceivedUsed: sumMoney(rows.filter((row) => row.kind === BILL_KINDS.DEPOSIT_RECEIVED).map((row) => row.usedAmount)),
    prepaymentsPaidUsed: sumMoney(rows.filter((row) => row.kind === BILL_KINDS.PREPAYMENT_PAID).map((row) => row.usedAmount)),
    rows,
  };
}
