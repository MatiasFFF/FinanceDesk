import {
  accountDefinition,
  buildAttachmentPackage,
  buildFinancialStatements,
  buildManagementMetrics,
  buildTaxWorkpaper,
} from "./domain/accounting/index.js";
import { buildPayrollSocialSummary, buildStructuredInvoiceVatSummary } from "./features/intake/documentIntake.js";
import {
  FITNESS_WORKSPACE_MODULE_DEFAULTS,
  WORKSPACE_MODULE_DEFAULTS,
  normalizeWorkspaceModules,
} from "./domain/foundation.js";
import {
  ACCOUNT_LABELS,
  APP_STORAGE_KEY,
  allocatedForBill,
  createBlankWorkspace,
  initialAppState,
  roundMoney,
  uid,
} from "./financeData.js";

export const PRODUCT_NAME = "财务工作台";
export const PRODUCT_STATE_VERSION = 4;

export const CLOSE_STAGES = [
  { id: "documents", label: "资料", page: "overview" },
  { id: "match", label: "匹配", page: "reconcile" },
  { id: "reconcile", label: "核销", page: "reconcile" },
  { id: "vouchers", label: "凭证", page: "reconcile" },
  { id: "reports", label: "报表", page: "reports" },
  { id: "confirm", label: "确认", page: "tax" },
];

export const PRIMARY_NAV = [
  { id: "overview", moduleId: "overview", label: "月结总览", shortLabel: "总览" },
  { id: "members", moduleId: "members", label: "会员台账", shortLabel: "会员" },
  { id: "reconcile", moduleId: "reconcile", label: "批量核销", shortLabel: "核销" },
  { id: "reports", moduleId: "reports", label: "报表中心", shortLabel: "报表" },
  { id: "tax", moduleId: "tax", label: "确认与申报", shortLabel: "确认" },
  { id: "archive", moduleId: "archive", label: "资料归档", shortLabel: "归档" },
  { id: "setup", moduleId: "setup", label: "基础资料", shortLabel: "基础" },
];

export const WORKSPACE_MODULE_OPTIONS = Object.freeze([
  { id: "members", label: "会员业务", description: "会员台账、履约、退款与业务提成" },
  { id: "reconcile", label: "流水核销", description: "银行流水、往来账单与会计处理" },
  { id: "tax", label: "确认与申报", description: "客户确认、申报底稿与本地申报包" },
]);

export function defaultWorkspaceModules(mode = "blank") {
  return { ...(mode === "fitness" ? FITNESS_WORKSPACE_MODULE_DEFAULTS : WORKSPACE_MODULE_DEFAULTS) };
}

export function workspaceModuleEnabled(workspace, moduleId) {
  const hasMemberBusiness = workspace?.templateId === "fitness-studio"
    || workspace?.isDemo
    || (workspace?.members || []).length > 0
    || (workspace?.businessEvents || []).some((event) => event.memberId || event.memberName || event.coach);
  return normalizeWorkspaceModules(workspace?.modules, {
    fitnessTemplate: hasMemberBusiness,
  })[moduleId] !== false;
}

export function primaryNavigationForWorkspace(workspace) {
  return PRIMARY_NAV.filter((item) => workspaceModuleEnabled(workspace, item.moduleId));
}

const emptyFiling = (period) => ({
  period,
  draftCreatedAt: null,
  draftVersionId: null,
  initialConfirmationId: null,
  finalConfirmedVersionId: null,
  exportedAt: null,
  exportedPackage: null,
  receipt: null,
  archivedAt: null,
});

const emptyDelivery = (period) => ({
  reportVersions: [],
  filing: emptyFiling(period),
  archives: [],
  notices: [],
});

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function ensureWorkspace(workspace) {
  const period = workspace.currentPeriod || new Date().toISOString().slice(0, 7);
  const delivery = workspace.delivery || emptyDelivery(period);
  return {
    ...workspace,
    name: workspace.name || "未命名工作台",
    modules: normalizeWorkspaceModules(workspace.modules, {
      fitnessTemplate: workspace.templateId === "fitness-studio" || workspace.isDemo,
    }),
    periods: [...new Set([period, ...safeArray(workspace.periods)])],
    accounts: safeArray(workspace.accounts),
    members: safeArray(workspace.members),
    businessEvents: safeArray(workspace.businessEvents),
    bills: safeArray(workspace.bills),
    transactions: safeArray(workspace.transactions),
    documents: safeArray(workspace.documents),
    vouchers: safeArray(workspace.vouchers),
    payrollImports: safeArray(workspace.payrollImports),
    payrollRecords: safeArray(workspace.payrollRecords),
    auditLog: safeArray(workspace.auditLog),
    tax: {
      period,
      adjustments: 0,
      payroll: 0,
      socialSecurity: 0,
      note: "",
      invoiceVatSummary: null,
      vatReconciliations: [],
      frozenAt: null,
      financeConfirmedAt: null,
      payrollConfirmedAt: null,
      socialSecurityConfirmedAt: null,
      ownerConfirmedAt: null,
      confirmedBy: "",
      financeConfirmedVersionId: null,
      payrollConfirmedVersionId: null,
      socialSecurityConfirmedVersionId: null,
      payrollConfirmedFingerprint: null,
      socialSecurityConfirmedFingerprint: null,
      ownerConfirmedVersionId: null,
      ...(workspace.tax || {}),
    },
    delivery: {
      ...emptyDelivery(period),
      ...delivery,
      reportVersions: safeArray(delivery.reportVersions),
      archives: safeArray(delivery.archives),
      notices: safeArray(delivery.notices),
      filing: {
        ...emptyFiling(period),
        ...(delivery.filing || {}),
      },
    },
  };
}

export function normalizeAppState(rawState) {
  const fallback = initialAppState();
  const state = rawState && typeof rawState === "object" ? rawState : fallback;
  const workspaces = safeArray(state.workspaces).map(ensureWorkspace);
  const activeExists = workspaces.some((item) => item.id === state.activeWorkspaceId);
  return {
    ...state,
    version: PRODUCT_STATE_VERSION,
    workspaces,
    activeWorkspaceId: activeExists ? state.activeWorkspaceId : workspaces[0]?.id || null,
  };
}

export function loadProductState() {
  try {
    const stored = window.localStorage.getItem(APP_STORAGE_KEY);
    return normalizeAppState(stored ? JSON.parse(stored) : initialAppState());
  } catch {
    return normalizeAppState(initialAppState());
  }
}

export function persistProductState(state) {
  window.localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(normalizeAppState(state)));
}

export function makeWorkspace(fields) {
  return ensureWorkspace(createBlankWorkspace(fields));
}

export function audit(workspace, action, detail, actor = "本地用户") {
  return {
    ...workspace,
    auditLog: [
      {
        id: uid("log"),
        at: new Date().toISOString(),
        actor,
        action,
        detail,
      },
      ...safeArray(workspace.auditLog),
    ],
  };
}

function amountForAccount(ledger, account) {
  return roundMoney(Number(ledger[account] || 0));
}

function accountRows(workspace, accountNames) {
  const periodVouchers = workspace.vouchers.filter(
    (voucher) => voucher.status === "posted" && String(voucher.date || "").startsWith(workspace.currentPeriod),
  );
  return periodVouchers
    .flatMap((voucher) => voucher.lines
      .filter((line) => accountNames.includes(line.account) || (accountNames.some((account) => ["bank", "cash"].includes(account)) && accountDefinition(line.account, workspace).cash))
      .map((line) => ({
        id: `${voucher.id}-${line.account}`,
        date: voucher.date,
        title: voucher.summary,
        reference: voucher.no,
        amount: roundMoney(Number(line.debit || 0) - Number(line.credit || 0)),
      })))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function calculatePeriodLedger(workspace) {
  const engine = buildFinancialStatements(workspace, { period: workspace.currentPeriod });
  const ledger = Object.fromEntries(engine.ledger.accounts.map((account) => [account.accountId, account.closing]));
  Object.keys(ACCOUNT_LABELS).forEach((account) => {
    if (ledger[account] == null) ledger[account] = 0;
  });
  return {
    ledger,
    revenue: engine.incomeStatement.netRevenue.value,
    expenses: engine.incomeStatement.expenses.value,
    profit: engine.incomeStatement.profit.value,
    assets: engine.balanceSheet.assets.value,
    liabilities: engine.balanceSheet.liabilities.value,
    equity: engine.balanceSheet.equity.value,
    difference: engine.balanceSheet.difference.value,
    engineChecks: engine.checks,
    cashFlow: engine.cashFlow,
    engine,
  };
}

function billOutstanding(workspace, kind) {
  return roundMoney(workspace.bills
    .filter((bill) => bill.kind === kind)
    .reduce((sum, bill) => sum + Math.max(0, Number(bill.amount || 0) - allocatedForBill(workspace, bill.id)), 0));
}

function detailsFromTransactions(transactions) {
  return transactions.map((item) => ({
    id: item.id,
    date: item.date,
    title: item.counterparty,
    reference: item.serial,
    description: item.summary,
    amount: Number(item.amount || 0),
  }));
}

function detailsFromBills(workspace, kind) {
  return workspace.bills
    .filter((bill) => bill.kind === kind)
    .map((bill) => ({
      id: bill.id,
      date: bill.date,
      title: bill.counterparty,
      reference: bill.no,
      description: bill.summary,
      amount: roundMoney(Math.max(0, Number(bill.amount || 0) - allocatedForBill(workspace, bill.id))),
    }));
}

function makeRow(id, label, value, details = []) {
  return { id, label, value: roundMoney(value), details };
}

function makeTraceableRow(id, label, value, details = [], formula = "") {
  return { ...makeRow(id, label, value, details), formula };
}

function ledgerDetails(workspace, engine, predicate, contribution) {
  const voucherById = new Map((workspace.vouchers || []).map((voucher) => [voucher.id, voucher]));
  return engine.ledger.accounts
    .filter(predicate)
    .flatMap((account) => {
      const rows = [];
      const openingAmount = roundMoney(contribution(account.opening, account.account));
      if (Math.abs(openingAmount) > 0.01) {
        rows.push({
          id: `opening-${account.accountId}`,
          date: `${workspace.currentPeriod}-01`,
          title: `${account.account.label}期初余额`,
          reference: "期初结转",
          description: `科目 ${account.accountId} · 由上期归档余额继承`,
          amount: openingAmount,
        });
      }
      account.entries.forEach((entry) => {
        const voucher = voucherById.get(entry.voucherId);
        const amount = roundMoney(contribution(Number(entry.debit || 0) - Number(entry.credit || 0), account.account));
        if (Math.abs(amount) <= 0.01) return;
        rows.push({
          id: `${entry.voucherId}-${account.accountId}-${entry.lineIndex}`,
          date: entry.date,
          title: `${entry.summary} · ${account.account.label}`,
          reference: entry.voucherNo || entry.voucherId,
          description: `${(entry.sourceIds || []).length} 个来源 · ${(voucher?.evidenceIds || []).length} 份本地附件`,
          amount,
          voucherId: entry.voucherId,
          sourceIds: entry.sourceIds || [],
          evidenceIds: voucher?.evidenceIds || [],
        });
      });
      return rows;
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function formulaDetail(id, title, amount, description) {
  return { id, title, reference: "计算口径", description, amount: roundMoney(amount) };
}

function structuredInvoiceDetails(summary, bucket, field, multiplier = 1) {
  return (summary.rows || []).filter((row) => row.bucket === bucket).map((row) => ({
    id: row.documentId,
    documentId: row.documentId,
    date: row.invoiceDate,
    title: row.name,
    reference: row.invoiceNumber || row.documentId,
    description: `${row.taxDirection === "output" ? "销项" : "进项"} · 税率 ${row.taxRate ?? "未填"}% · ${row.reason} · 查验状态为人工记录，未联网查验`,
    amount: roundMoney(Number(row[field] || 0) * multiplier),
    sourceIds: row.sourceIds || [row.documentId],
  }));
}

function payrollSocialDetails(records, field, sourceLabel) {
  return records.filter((record) => record[field] != null).map((record) => ({
    id: `${record.id}:${field}`,
    date: `${record.period}-01`,
    title: record.employeeName,
    reference: record.sourceFileName || record.sourceImportId || sourceLabel,
    description: `${sourceLabel} · 第 ${record.sourceRowNumber || "?"} 行 · 当前浏览器本地导入`,
    amount: roundMoney(record[field]),
    sourceIds: [record.id, record.sourceImportId].filter(Boolean),
  }));
}

function vatReconciliationFingerprint({ period, kind, bookAmount, invoiceAmount, bookSources, invoiceSources }) {
  const sourceProjection = (sources) => sources.map((source) => ({
    id: source.id,
    date: source.date || "",
    reference: source.reference || "",
    amount: roundMoney(source.amount),
    voucherId: source.voucherId || "",
    documentId: source.documentId || "",
    sourceIds: source.sourceIds || [],
  }));
  return JSON.stringify({
    period,
    kind,
    bookAmount: roundMoney(bookAmount),
    invoiceAmount: roundMoney(invoiceAmount),
    bookSources: sourceProjection(bookSources),
    invoiceSources: sourceProjection(invoiceSources),
  });
}

export function buildVatReconciliationSummary(workspace, options = {}) {
  const period = options.period || workspace.currentPeriod;
  const scopedWorkspace = period === workspace.currentPeriod ? workspace : { ...workspace, currentPeriod: period };
  const statements = options.statements || calculatePeriodLedger(scopedWorkspace);
  const engineTax = options.engineTax || buildTaxWorkpaper(scopedWorkspace, { period });
  const invoiceVatSummary = options.invoiceVatSummary || buildStructuredInvoiceVatSummary(scopedWorkspace, { period });
  const records = safeArray(workspace.tax?.vatReconciliations);
  const definitions = [
    {
      kind: "outputRevenue",
      label: "销项发票不含税收入与账面营业收入",
      bookLabel: "已入账营业收入",
      invoiceLabel: "销项发票不含税收入",
      bookAmount: statements.revenue,
      invoiceAmount: invoiceVatSummary.outputNetAmount,
      bookSources: ledgerDetails(scopedWorkspace, statements.engine, (item) => ["revenue", "contraRevenue"].includes(item.account.category), (amount) => -amount),
      invoiceSources: structuredInvoiceDetails(invoiceVatSummary, "outputVat", "netAmount"),
    },
    {
      kind: "deductibleInputVat",
      label: "已认证进项税与会计进项税",
      bookLabel: "会计进项税／可抵扣口径",
      invoiceLabel: "已认证发票进项税",
      bookAmount: engineTax.inputVat.value,
      invoiceAmount: invoiceVatSummary.deductibleInputVat,
      bookSources: ledgerDetails(scopedWorkspace, statements.engine, (item) => String(item.accountId).startsWith("taxInput"), (amount) => amount),
      invoiceSources: structuredInvoiceDetails(invoiceVatSummary, "deductibleInputVat", "taxAmount"),
    },
  ];

  const items = definitions.map((definition) => {
    const bookAmount = roundMoney(definition.bookAmount);
    const invoiceAmount = roundMoney(definition.invoiceAmount);
    const differenceBeforeAdjustment = roundMoney(invoiceAmount - bookAmount);
    const sourceFingerprint = vatReconciliationFingerprint({
      period,
      kind: definition.kind,
      bookAmount,
      invoiceAmount,
      bookSources: definition.bookSources,
      invoiceSources: definition.invoiceSources,
    });
    const storedRecord = records.find((record) => record.period === period && record.kind === definition.kind) || null;
    const activeRecord = storedRecord?.sourceFingerprint === sourceFingerprint ? storedRecord : null;
    const adjustmentAmount = roundMoney(activeRecord?.adjustmentAmount || 0);
    const adjustedInvoiceAmount = roundMoney(invoiceAmount + adjustmentAmount);
    const differenceAfterAdjustment = roundMoney(adjustedInvoiceAmount - bookAmount);
    const requiresExplanation = Math.abs(differenceBeforeAdjustment) > 0.01;
    const explained = requiresExplanation && Boolean(activeRecord?.reason?.trim());
    return {
      ...definition,
      bookAmount,
      invoiceAmount,
      differenceBeforeAdjustment,
      adjustmentAmount,
      adjustedInvoiceAmount,
      differenceAfterAdjustment,
      before: { bookAmount, invoiceAmount, difference: differenceBeforeAdjustment },
      after: { bookAmount, invoiceAmount: adjustedInvoiceAmount, adjustmentAmount, difference: differenceAfterAdjustment },
      reason: activeRecord?.reason || "",
      sourceFingerprint,
      storedRecord,
      activeRecord,
      requiresExplanation,
      resolved: !requiresExplanation || explained,
      status: !requiresExplanation ? "no_difference" : (explained ? "explained" : (storedRecord ? "source_changed" : "unexplained")),
    };
  });

  const unresolvedItems = items.filter((item) => !item.resolved);
  return {
    period,
    items,
    unresolvedItems,
    hasUnexplainedDifferences: unresolvedItems.length > 0,
    differenceConvention: "发票数 + 本地调整金额 − 账面数",
  };
}

export function recordVatReconciliation(workspace, input, context = {}) {
  const current = ensureWorkspace(workspace);
  const kind = String(input?.kind || "");
  const summary = buildVatReconciliationSummary(current);
  const item = summary.items.find((candidate) => candidate.kind === kind);
  if (!item) throw new Error("请选择销项收入或进项税差异项目");
  const numericAdjustment = input?.adjustmentAmount === "" || input?.adjustmentAmount == null
    ? 0
    : Number(input.adjustmentAmount);
  if (!Number.isFinite(numericAdjustment)) throw new Error("本地调整金额必须是有效数字");
  const adjustmentAmount = roundMoney(numericAdjustment);
  const reason = String(input?.reason || "").trim();
  if (item.requiresExplanation && !reason) throw new Error("存在差额时必须填写真实原因");

  const at = context.at || new Date().toISOString();
  const actor = context.actor || "本地用户";
  const previous = item.storedRecord;
  const before = { ...item.before };
  const after = {
    bookAmount: item.bookAmount,
    invoiceAmount: roundMoney(item.invoiceAmount + adjustmentAmount),
    adjustmentAmount,
    difference: roundMoney(item.invoiceAmount + adjustmentAmount - item.bookAmount),
  };
  const historyEntry = {
    at,
    actor,
    reason,
    adjustmentAmount,
    sourceFingerprint: item.sourceFingerprint,
    before,
    after,
  };
  const record = {
    id: previous?.id || `vat-reconciliation:${summary.period}:${kind}`,
    period: summary.period,
    kind,
    label: item.label,
    reason,
    adjustmentAmount,
    sourceFingerprint: item.sourceFingerprint,
    before,
    after,
    bookSources: item.bookSources,
    invoiceSources: item.invoiceSources,
    recordedAt: at,
    recordedBy: actor,
    history: [...safeArray(previous?.history), historyEntry],
  };
  const records = safeArray(current.tax.vatReconciliations);
  const nextRecords = records.some((candidate) => candidate.period === summary.period && candidate.kind === kind)
    ? records.map((candidate) => candidate.period === summary.period && candidate.kind === kind ? record : candidate)
    : [record, ...records];
  const next = {
    ...current,
    tax: {
      ...current.tax,
      vatReconciliations: nextRecords,
      frozenAt: null,
      financeConfirmedAt: null,
      payrollConfirmedAt: null,
      socialSecurityConfirmedAt: null,
      ownerConfirmedAt: null,
      confirmedBy: "",
      financeConfirmedVersionId: null,
      payrollConfirmedVersionId: null,
      socialSecurityConfirmedVersionId: null,
      payrollConfirmedFingerprint: null,
      socialSecurityConfirmedFingerprint: null,
      ownerConfirmedVersionId: null,
    },
    delivery: {
      ...current.delivery,
      filing: emptyFiling(summary.period),
    },
  };
  return audit(next, "记录增值税差异说明", `${summary.period} · ${item.label} · 调整前差额 ${item.differenceBeforeAdjustment.toFixed(2)} · 本地调整 ${adjustmentAmount.toFixed(2)} · 调整后差额 ${after.difference.toFixed(2)}`, actor);
}

export function buildReportSnapshot(workspace) {
  const memberBusinessEnabled = workspaceModuleEnabled(workspace, "members");
  const statements = calculatePeriodLedger(workspace);
  const engine = statements.engine;
  const management = buildManagementMetrics(workspace, { period: workspace.currentPeriod });
  const managementById = Object.fromEntries(management.metrics.map((metric) => [metric.id, metric]));
  const engineTax = buildTaxWorkpaper(workspace, { period: workspace.currentPeriod });
  const invoiceVatSummary = buildStructuredInvoiceVatSummary(workspace, { period: workspace.currentPeriod });
  const vatReconciliation = buildVatReconciliationSummary(workspace, {
    period: workspace.currentPeriod,
    statements,
    engineTax,
    invoiceVatSummary,
  });
  const payrollSocialSummary = buildPayrollSocialSummary(workspace, { period: workspace.currentPeriod });
  const payrollAmount = payrollSocialSummary.payrollRecords.length
    ? payrollSocialSummary.totals.payroll.grossSalary
    : Number(workspace.tax.payroll || 0);
  const socialSecurityAmount = payrollSocialSummary.socialSecurityRecords.length
    ? payrollSocialSummary.totals.socialSecurityPayable
    : Number(workspace.tax.socialSecurity || 0);
  const usesStructuredInvoiceVat = invoiceVatSummary.usesStructuredInvoices;
  const periodTransactions = workspace.transactions.filter((item) => String(item.date || "").startsWith(workspace.currentPeriod));
  const cashMovements = statements.cashFlow.movements || [];
  const cashIn = roundMoney(cashMovements.filter((item) => item.amount > 0).reduce((sum, item) => sum + item.amount, 0));
  const cashOut = roundMoney(cashMovements.filter((item) => item.amount < 0).reduce((sum, item) => sum + Math.abs(item.amount), 0));
  const receivable = roundMoney(Math.max(0, amountForAccount(statements.ledger, "receivable")));
  const payable = roundMoney(Math.max(0, -amountForAccount(statements.ledger, "payable")));
  const prepayment = roundMoney(Math.max(0, amountForAccount(statements.ledger, "prepayment")));
  const contractLiability = roundMoney(Math.max(0, -amountForAccount(statements.ledger, "contractLiability")));
  const currentBusinessEvents = workspace.businessEvents.filter((item) => item.status !== "void" && String(item.date || "").startsWith(workspace.currentPeriod));
  const refunds = currentBusinessEvents.filter((item) => item.kind === "refund" || item.type === "refund");
  const commissions = currentBusinessEvents.filter((item) => item.kind === "commission" || item.type === "commission" || item.accountingSubtype === "coachCommission");
  const estimatedOutputVat = usesStructuredInvoiceVat ? invoiceVatSummary.outputVat : engineTax.outputVat.value;
  const deductibleInputVat = usesStructuredInvoiceVat ? invoiceVatSummary.deductibleInputVat : engineTax.inputVat.value;
  const nonDeductibleInputVat = usesStructuredInvoiceVat ? invoiceVatSummary.nonDeductibleInputVat : 0;
  const estimatedVat = usesStructuredInvoiceVat ? invoiceVatSummary.vatPayable : engineTax.vatPayable.value;
  const estimatedSurtax = roundMoney(estimatedVat * 0.12);
  const estimatedIncomeTax = roundMoney(Math.max(0, statements.profit) * 0.05);
  const estimatedTax = roundMoney(estimatedVat + estimatedSurtax + estimatedIncomeTax);
  const cashBalance = statements.cashFlow.closingCash.value;
  const assetDetails = ledgerDetails(workspace, engine, (item) => item.account.category === "asset", (amount) => amount);
  const liabilityDetails = ledgerDetails(workspace, engine, (item) => item.account.category === "liability", (amount) => -amount);
  const equityAccountDetails = ledgerDetails(workspace, engine, (item) => item.account.category === "equity", (amount) => -amount);
  const revenueDetails = ledgerDetails(workspace, engine, (item) => ["revenue", "contraRevenue"].includes(item.account.category), (amount) => -amount);
  const expenseDetails = ledgerDetails(workspace, engine, (item) => item.account.category === "expense", (amount) => amount);
  const costDetails = ledgerDetails(workspace, engine, (item) => item.account.category === "cost", (amount) => amount);
  const profitDetails = ledgerDetails(workspace, engine, (item) => ["revenue", "contraRevenue", "cost", "expense"].includes(item.account.category), (amount) => -amount);
  const cashDetails = ledgerDetails(workspace, engine, (item) => item.account.cash, (amount) => amount);
  const receivableDetails = ledgerDetails(workspace, engine, (item) => item.accountId === "receivable", (amount) => amount);
  const prepaymentDetails = ledgerDetails(workspace, engine, (item) => item.accountId === "prepayment", (amount) => amount);
  const equipmentDetails = ledgerDetails(workspace, engine, (item) => item.accountId === "equipment", (amount) => amount);
  const payableDetails = ledgerDetails(workspace, engine, (item) => item.accountId === "payable", (amount) => -amount);
  const contractLiabilityDetails = ledgerDetails(workspace, engine, (item) => item.accountId === "contractLiability", (amount) => -amount);
  const outputInvoiceGrossDetails = structuredInvoiceDetails(invoiceVatSummary, "outputVat", "grossAmount");
  const outputInvoiceNetDetails = structuredInvoiceDetails(invoiceVatSummary, "outputVat", "netAmount");
  const outputInvoiceVatDetails = structuredInvoiceDetails(invoiceVatSummary, "outputVat", "taxAmount");
  const deductibleInputVatDetails = structuredInvoiceDetails(invoiceVatSummary, "deductibleInputVat", "taxAmount");
  const nonDeductibleInputVatDetails = structuredInvoiceDetails(invoiceVatSummary, "nonDeductibleInputVat", "taxAmount");
  const grossSalaryDetails = payrollSocialDetails(payrollSocialSummary.payrollRecords, "grossSalary", "工资表");
  const netSalaryDetails = payrollSocialDetails(payrollSocialSummary.payrollRecords, "netSalary", "工资表");
  const individualIncomeTaxDetails = payrollSocialDetails(payrollSocialSummary.payrollRecords, "individualIncomeTax", "工资表");
  const personalSocialDetails = payrollSocialDetails(payrollSocialSummary.socialSecurityRecords, "personalSocial", "社保表");
  const employerSocialDetails = payrollSocialDetails(payrollSocialSummary.socialSecurityRecords, "employerSocial", "社保表");
  const socialSecurityDetails = [...personalSocialDetails, ...employerSocialDetails];
  const inputInvoiceGrossDetails = [
    ...structuredInvoiceDetails(invoiceVatSummary, "deductibleInputVat", "grossAmount"),
    ...structuredInvoiceDetails(invoiceVatSummary, "nonDeductibleInputVat", "grossAmount"),
  ];
  const invoiceVatPayableBeforeFloor = roundMoney(estimatedOutputVat - deductibleInputVat);
  const structuredVatPayableDetails = [
    ...outputInvoiceVatDetails,
    ...structuredInvoiceDetails(invoiceVatSummary, "deductibleInputVat", "taxAmount", -1),
    ...(invoiceVatPayableBeforeFloor < 0
      ? [formulaDetail("input-credit-floor", "进项留抵转下期", Math.abs(invoiceVatPayableBeforeFloor), "本期应交增值税最低按 0 列示，多出的可抵扣进项单独留抵")]
      : []),
  ];
  const taxEstimateDetails = [
    ...(usesStructuredInvoiceVat
      ? structuredVatPayableDetails
      : [formulaDetail("estimated-vat", "增值税估算", estimatedVat, `销项估算减进项税额，税率 ${(Number(workspace.tax.vatRate ?? 0.03) * 100).toFixed(2)}%`)]),
    formulaDetail("estimated-surtax", "附加税费估算", estimatedSurtax, "按增值税估算额的 12% 演示计算"),
    formulaDetail("estimated-income-tax", "所得税估算", estimatedIncomeTax, "按正数会计利润的 5% 演示计算"),
  ];
  const cashGapValue = Math.abs(Math.min(0, managementById.cashGap?.value ?? (cashBalance - payable - estimatedTax)));
  const cashGapDetails = [
    formulaDetail("gap-cash", "可用现金余额", cashBalance, "来自已入账凭证与期初结转"),
    formulaDetail("gap-payable", "减：供应商应付", -payable, "来自未结清应付账单"),
    formulaDetail("gap-tax", "减：预计税费", -estimatedTax, "本地演示估算，不代表正式申报额"),
  ];

  return {
    period: workspace.currentPeriod,
    generatedAt: new Date().toISOString(),
    ledger: statements.ledger,
    summary: {
      revenue: statements.revenue,
      cost: engine.incomeStatement.cost.value,
      expenses: statements.expenses,
      profit: statements.profit,
      assets: statements.assets,
      liabilities: statements.liabilities,
      equity: statements.equity,
      difference: statements.difference,
      cashIn,
      cashOut,
      cashBalance,
      receivable,
      payable,
      prepayment,
      contractLiability,
      estimatedTax,
      vatSourceMode: usesStructuredInvoiceVat ? "structured_invoices" : "legacy_estimate",
      outputVat: estimatedOutputVat,
      deductibleInputVat,
      nonDeductibleInputVat,
      engineChecks: statements.engineChecks,
    },
    sections: {
      balance: {
        label: "资产负债表",
        rows: [
          makeTraceableRow("cash", "货币资金", cashBalance, cashDetails, "期初现金 + 本期已入账现金变动"),
          makeTraceableRow("receivable", "应收账款", amountForAccount(statements.ledger, "receivable"), receivableDetails, "期初应收 + 借方发生额 − 贷方发生额"),
          makeTraceableRow("prepayment", "预付款项", amountForAccount(statements.ledger, "prepayment"), prepaymentDetails, "期初预付 + 借方发生额 − 贷方发生额"),
          makeTraceableRow("equipment", "固定资产", amountForAccount(statements.ledger, "equipment"), equipmentDetails, "期初固定资产 + 本期净增加"),
          makeTraceableRow("assets", "资产合计", statements.assets, assetDetails, "所有资产类科目期末余额合计"),
          makeTraceableRow("payable", "应付账款", -amountForAccount(statements.ledger, "payable"), payableDetails, "期初应付 + 贷方发生额 − 借方发生额"),
          makeTraceableRow("contractLiability", "合同负债", contractLiability, contractLiabilityDetails, "期初合同负债 + 预收 − 履约确认"),
          makeTraceableRow("liabilities", "负债合计", statements.liabilities, liabilityDetails, "所有负债类科目期末余额合计"),
          makeTraceableRow("equity", "所有者权益", statements.equity, [...equityAccountDetails, ...profitDetails], "权益类科目期末余额 + 本期利润"),
          makeTraceableRow("liabilitiesEquity", "负债和所有者权益合计", statements.liabilities + statements.equity, [...liabilityDetails, ...equityAccountDetails, ...profitDetails], "负债合计 + 所有者权益"),
        ],
      },
      income: {
        label: "利润表",
        rows: [
          ...(memberBusinessEnabled ? [
            makeRow("privateRevenue", "私教课收入", -amountForAccount(statements.ledger, "revenuePrivate"), accountRows(workspace, ["revenuePrivate"])),
            makeRow("groupRevenue", "团课收入", -amountForAccount(statements.ledger, "revenueGroup"), accountRows(workspace, ["revenueGroup"])),
          ] : [
            makeRow("serviceRevenue", "服务收入", -amountForAccount(statements.ledger, "revenuePrivate") - amountForAccount(statements.ledger, "revenueGroup"), accountRows(workspace, ["revenuePrivate", "revenueGroup"])),
          ]),
          makeTraceableRow("revenue", "营业收入", statements.revenue, revenueDetails, "收入类发生额 − 销售退回与折让"),
          makeRow("rent", "房租费用", amountForAccount(statements.ledger, "expenseRent"), accountRows(workspace, ["expenseRent"])),
          makeRow("utility", "水电费用", amountForAccount(statements.ledger, "expenseUtility"), accountRows(workspace, ["expenseUtility"])),
          makeRow("fees", "手续费", amountForAccount(statements.ledger, "expenseFee"), accountRows(workspace, ["expenseFee"])),
          makeRow("commission", memberBusinessEnabled ? "教练提成" : "业务提成", amountForAccount(statements.ledger, "expenseCommission"), accountRows(workspace, ["expenseCommission"])),
          makeTraceableRow("expenses", "期间费用", statements.expenses, expenseDetails, "本期各费用类科目借方净发生额"),
          makeTraceableRow("profit", "本月利润", statements.profit, profitDetails, "营业收入 − 销售退回 − 成本 − 期间费用"),
        ],
      },
      cashflow: {
        label: "现金流量表",
        rows: [
          makeRow("operating", "经营活动现金流量净额", statements.cashFlow.operating.value, statements.cashFlow.operating.rows.map((item) => ({ id: item.voucherId, date: item.date, title: item.summary, reference: "已入账凭证", amount: item.amount }))),
          makeRow("investing", "投资活动现金流量净额", statements.cashFlow.investing.value, statements.cashFlow.investing.rows.map((item) => ({ id: item.voucherId, date: item.date, title: item.summary, reference: "已入账凭证", amount: item.amount }))),
          makeRow("financing", "筹资活动现金流量净额", statements.cashFlow.financing.value, statements.cashFlow.financing.rows.map((item) => ({ id: item.voucherId, date: item.date, title: item.summary, reference: "已入账凭证", amount: item.amount }))),
          makeRow("netCash", "现金净增加额", statements.cashFlow.netChange.value, cashMovements.map((item) => ({ id: item.voucherId, date: item.date, title: item.summary, reference: "已入账凭证", amount: item.amount }))),
          makeTraceableRow("closingCash", "期末现金余额", cashBalance, cashDetails, "期初现金 + 本期现金净增加额"),
        ],
      },
      owner: {
        label: "老板报表",
        rows: [
          makeTraceableRow("ownerCash", "现金余额", cashBalance, cashDetails, "期初现金 + 本期已入账现金变动"),
          makeRow("ownerCashIn", "本月收款", cashIn, cashMovements.filter((item) => item.amount > 0).map((item) => ({ id: item.voucherId, date: item.date, title: item.summary, reference: "已入账凭证", amount: item.amount }))),
          makeRow("ownerRevenue", "本月收入", statements.revenue, accountRows(workspace, ["revenuePrivate", "revenueGroup"])),
          makeTraceableRow("ownerGrossProfit", "本月毛利", engine.incomeStatement.grossProfit.value, [...revenueDetails, ...costDetails.map((item) => ({ ...item, amount: -item.amount }))], "营业收入 − 销售退回 − 营业成本"),
          makeTraceableRow("ownerProfit", "本月利润", statements.profit, profitDetails, "营业收入 − 销售退回 − 成本 − 期间费用"),
          makeTraceableRow("ownerPrepaid", memberBusinessEnabled ? "会员预收 / 未履约服务" : "客户预收 / 未履约服务", contractLiability, contractLiabilityDetails, "合同负债科目期末贷方余额"),
          makeTraceableRow("ownerReceivable", "应收账款", receivable, receivableDetails, "应收账款科目期末借方余额"),
          makeTraceableRow("ownerPayable", "供应商应付", payable, payableDetails, "应付账款科目期末贷方余额"),
          makeTraceableRow("ownerPrepayment", "供应商预付", prepayment, prepaymentDetails, "预付款项科目期末借方余额"),
          makeRow("ownerRefund", "待处理退款", refunds.reduce((sum, item) => sum + Number(item.amount || 0), 0), refunds.map((item) => ({ id: item.id, date: item.date, title: memberBusinessEnabled ? item.memberName : (item.counterparty || "本地业务"), reference: memberBusinessEnabled ? "会员退款" : "业务退款", description: item.note, amount: item.amount }))),
          makeRow("ownerCommission", memberBusinessEnabled ? "教练提成" : "业务提成", commissions.reduce((sum, item) => sum + Number(item.amount || 0), 0), commissions.map((item) => ({ id: item.id, date: item.date, title: memberBusinessEnabled ? (item.coach || item.memberName) : (item.counterparty || "本地业务"), reference: "提成", description: item.note, amount: item.amount }))),
          makeTraceableRow("ownerTax", "预计税款（演示估算）", estimatedTax, taxEstimateDetails, "增值税估算 + 附加税费估算 + 所得税估算"),
          makeTraceableRow("ownerGap", "未来现金缺口", cashGapValue, cashGapDetails, "max(0，应付与预计税费 − 可用现金)"),
        ],
      },
    },
    taxWorkpaper: {
      sourceMode: usesStructuredInvoiceVat ? "structured_invoices" : "legacy_estimate",
      invoiceVatSummary,
      vatReconciliation,
      payrollSocialSummary,
      disclaimer: usesStructuredInvoiceVat
        ? "增值税数据来自本地人工录入并关联的结构化发票；查验状态不代表已联网查验，附加税费与所得税仍为本地估算。"
        : "本期没有已人工分类且关联业务的结构化发票，增值税仍采用本地演示估算；未连接税务平台。",
      rows: [
        makeTraceableRow("taxRevenue", "账面营业收入", statements.revenue, revenueDetails, "收入类发生额 − 销售退回与折让"),
        makeTraceableRow("taxAdjustments", "增值税计税基础调整", engineTax.adjustments.value, [], "客户或财务人员在本地底稿中录入"),
        ...(usesStructuredInvoiceVat ? [
          makeTraceableRow("outputInvoiceGross", "销项发票价税合计", invoiceVatSummary.outputGrossAmount, outputInvoiceGrossDetails, "有效销项发票价税合计；已开红字按负数，作废不计入"),
          makeTraceableRow("inputInvoiceGross", "进项发票价税合计", invoiceVatSummary.inputGrossAmount, inputInvoiceGrossDetails, "有效进项发票价税合计；包含可抵扣与未认证不可抵扣部分"),
        ] : []),
        makeTraceableRow(
          "taxBase",
          usesStructuredInvoiceVat ? "销项发票不含税金额" : "增值税估算计税基础",
          usesStructuredInvoiceVat ? invoiceVatSummary.outputNetAmount : engineTax.taxableBase.value,
          usesStructuredInvoiceVat ? outputInvoiceNetDetails : revenueDetails,
          usesStructuredInvoiceVat ? "有效销项发票价税合计 − 销项税额；已开红字按负数" : "max(0，账面营业收入 + 增值税计税基础调整)",
        ),
        makeTraceableRow(
          "vat",
          usesStructuredInvoiceVat ? "销项税额" : "销项税额估算",
          estimatedOutputVat,
          usesStructuredInvoiceVat ? outputInvoiceVatDetails : [formulaDetail("output-vat", "销项税额估算", estimatedOutputVat, "计税基础 × 本地配置税率")],
          usesStructuredInvoiceVat ? "有效销项发票税额汇总；已开红字按负数，作废不计入" : "计税基础 × 本地配置税率",
        ),
        makeTraceableRow(
          "inputVat",
          usesStructuredInvoiceVat ? "可抵扣进项税额" : "进项税额",
          deductibleInputVat,
          usesStructuredInvoiceVat ? deductibleInputVatDetails : ledgerDetails(workspace, engine, (item) => String(item.accountId).startsWith("taxInput"), (amount) => amount),
          usesStructuredInvoiceVat ? "仅汇总已认证的有效进项发票；已开红字按负数" : "进项税额科目借方净发生额",
        ),
        ...(usesStructuredInvoiceVat ? [makeTraceableRow(
          "nonDeductibleInputVat",
          "未认证不可抵扣进项税额",
          nonDeductibleInputVat,
          nonDeductibleInputVatDetails,
          "未认证、认证中或认证异常的进项税额单独列示，不抵扣本期销项税额",
        )] : []),
        ...vatReconciliation.items.map((item) => makeTraceableRow(
          `vatReconciliation-${item.kind}`,
          `${item.label}差额（调整后）`,
          item.differenceAfterAdjustment,
          [
            ...item.bookSources.map((source) => ({ ...source, title: `账面：${source.title}` })),
            ...item.invoiceSources.map((source) => ({ ...source, title: `发票：${source.title}` })),
            ...(item.adjustmentAmount !== 0 ? [formulaDetail(`vat-adjustment-${item.kind}`, "本地底稿调整", item.adjustmentAmount, item.reason || "未填写原因")] : []),
          ],
          `${item.invoiceLabel} + 本地调整金额 − ${item.bookLabel}`,
        )),
        makeTraceableRow(
          "vatPayable",
          "应交增值税",
          estimatedVat,
          usesStructuredInvoiceVat ? structuredVatPayableDetails : taxEstimateDetails.slice(0, 1),
          usesStructuredInvoiceVat ? "max(0，销项税额 − 可抵扣进项税额)" : "max(0，销项税额估算 − 进项税额)",
        ),
        makeTraceableRow("surtax", "附加税费估算", estimatedSurtax, taxEstimateDetails.slice(1, 2), "增值税估算额 × 12%"),
        makeTraceableRow("incomeTax", "所得税估算", estimatedIncomeTax, taxEstimateDetails.slice(2, 3), "max(0，本月利润) × 5%"),
        makeTraceableRow("payroll", "应发工资", payrollAmount, grossSalaryDetails, payrollSocialSummary.payrollRecords.length ? "当前期间工资表逐人应发工资合计，需客户单独确认" : "财务人员在本地底稿中单独录入并由客户确认"),
        makeTraceableRow("personalSocialSecurity", "个人社保", payrollSocialSummary.totals.socialSecurity.personalSocial, personalSocialDetails, "当前期间社保表逐人个人承担社保合计"),
        makeTraceableRow("employerSocialSecurity", "企业社保", payrollSocialSummary.totals.socialSecurity.employerSocial, employerSocialDetails, "当前期间社保表逐人企业承担社保合计"),
        makeTraceableRow("socialSecurity", "社保合计", socialSecurityAmount, socialSecurityDetails, payrollSocialSummary.socialSecurityRecords.length ? "个人社保 + 企业社保，需客户单独确认" : "财务人员在本地底稿中单独录入并由客户确认"),
        makeTraceableRow("individualIncomeTax", "代扣个税", payrollSocialSummary.totals.payroll.individualIncomeTax, individualIncomeTaxDetails, "当前期间工资表逐人个税合计"),
        makeTraceableRow("netSalary", "实发工资", payrollSocialSummary.totals.payroll.netSalary, netSalaryDetails, "当前期间工资表逐人实发工资合计"),
        makeTraceableRow("taxTotal", "预计税费合计", estimatedTax, taxEstimateDetails, "增值税估算 + 附加税费估算 + 所得税估算"),
      ],
    },
  };
}

export function freezeReportVersion(workspace, actor = "本地用户") {
  const current = ensureWorkspace(workspace);
  const payrollSocialBefore = buildPayrollSocialSummary(current, { period: current.currentPeriod });
  const previousVersion = getLatestReportVersion(current);
  const invalidatedConfirmations = [
    {
      label: "工资表",
      confirmedAt: current.tax.payrollConfirmedAt,
      confirmedVersionId: current.tax.payrollConfirmedVersionId,
      storedFingerprint: current.tax.payrollConfirmedFingerprint,
      currentFingerprint: payrollSocialBefore.fingerprints.payroll,
    },
    {
      label: "社保表",
      confirmedAt: current.tax.socialSecurityConfirmedAt,
      confirmedVersionId: current.tax.socialSecurityConfirmedVersionId,
      storedFingerprint: current.tax.socialSecurityConfirmedFingerprint,
      currentFingerprint: payrollSocialBefore.fingerprints.socialSecurity,
    },
  ].filter((item) => item.confirmedAt).map((item) => ({
    ...item,
    reason: !item.storedFingerprint
      ? "原确认缺少可验证数据指纹"
      : item.storedFingerprint !== item.currentFingerprint
        ? "确认后数据已变化"
        : item.confirmedVersionId !== previousVersion?.id
          ? "原确认绑定的报表版本已变化"
          : "重新冻结生成了新报表版本",
  }));
  const snapshot = buildReportSnapshot(current);
  const periodVersions = current.delivery.reportVersions.filter((item) => item.period === current.currentPeriod);
  const version = {
    id: uid("report-version"),
    period: current.currentPeriod,
    label: `V${periodVersions.length + 1}`,
    createdAt: new Date().toISOString(),
    actor,
    frozen: true,
    snapshot,
    sourceFingerprint: workflowSourceFingerprint(current),
  };
  const next = {
    ...current,
    tax: {
      ...current.tax,
      frozenAt: version.createdAt,
      financeConfirmedAt: null,
      payrollConfirmedAt: null,
      socialSecurityConfirmedAt: null,
      ownerConfirmedAt: null,
      confirmedBy: "",
      financeConfirmedVersionId: null,
      payrollConfirmedVersionId: null,
      socialSecurityConfirmedVersionId: null,
      payrollConfirmedFingerprint: null,
      socialSecurityConfirmedFingerprint: null,
      ownerConfirmedVersionId: null,
    },
    delivery: {
      ...current.delivery,
      reportVersions: [version, ...current.delivery.reportVersions],
      filing: emptyFiling(current.currentPeriod),
    },
  };
  const frozen = audit(next, "冻结报表版本", `${current.currentPeriod} ${version.label}，差异 ${snapshot.summary.difference.toFixed(2)}`, actor);
  if (!invalidatedConfirmations.length) return frozen;
  const invalidationDetail = invalidatedConfirmations
    .map((item) => `${item.label}（${item.reason}）`)
    .join("、");
  return audit(
    frozen,
    "工资社保独立确认失效",
    `${current.currentPeriod} · ${invalidationDetail} · 已生成 ${version.label}，两项需按新版本分别重新确认`,
    actor,
  );
}

export function reportVersionDiff(currentVersion, previousVersion) {
  if (!currentVersion) return [];
  const previousSections = previousVersion?.snapshot?.sections || {};
  return Object.entries(currentVersion.snapshot.sections).flatMap(([sectionId, section]) => {
    const previousRows = previousSections[sectionId]?.rows || [];
    return section.rows.map((row) => {
      const previous = previousRows.find((item) => item.id === row.id)?.value || 0;
      return {
        id: `${sectionId}-${row.id}`,
        section: section.label,
        label: row.label,
        previous: roundMoney(previous),
        current: roundMoney(row.value),
        delta: roundMoney(row.value - previous),
      };
    });
  }).filter((row) => row.delta !== 0);
}

export function getLatestReportVersion(workspace) {
  return workspace.delivery.reportVersions.find((item) => item.period === workspace.currentPeriod) || null;
}

const WORKFLOW_SOURCE_KEYS = [
  "company",
  "modules",
  "accounts",
  "bankAccounts",
  "transactions",
  "businessEvents",
  "bills",
  "documents",
  "payrollRecords",
  "evidenceLinks",
  "vouchers",
  "exceptionTasks",
  "counterparties",
  "contracts",
  "invoices",
  "approvals",
  "personnelRecords",
  "rules",
  "ruleSets",
  "openingLedger",
];

function workflowSourceValue(workspace, key) {
  if (key === "documents") {
    return (workspace.documents || [])
      .filter((document) => document.category !== "申报回执" && document.deliveryArtifact !== true)
      .map((document) => ({
        id: document.id,
        name: document.name,
        category: document.category,
        period: document.period,
        version: document.version,
        hash: document.hash,
        structuredData: document.structuredData || null,
        relatedObjectIds: document.relatedObjectIds || [],
      }));
  }
  if (key === "payrollRecords") {
    return (workspace.payrollRecords || []).filter((record) => record.period === workspace.currentPeriod);
  }
  return workspace[key] || (["company", "modules", "openingLedger", "rules"].includes(key) ? {} : []);
}

export function workflowSourceFingerprint(workspace) {
  const tax = workspace.tax || {};
  return JSON.stringify({
    currentPeriod: workspace.currentPeriod,
    sources: Object.fromEntries(WORKFLOW_SOURCE_KEYS.map((key) => [key, workflowSourceValue(workspace, key)])),
    tax: {
      adjustments: Number(tax.adjustments || 0),
      payroll: Number(tax.payroll || 0),
      socialSecurity: Number(tax.socialSecurity || 0),
      vatRate: Number(tax.vatRate ?? 0.03),
      note: tax.note || "",
      sourceIds: tax.sourceIds || [],
      payrollSourceIds: tax.payrollSourceIds || [],
      socialSecuritySourceIds: tax.socialSecuritySourceIds || [],
      vatReconciliations: tax.vatReconciliations || [],
    },
  });
}

export function getPayrollSocialConfirmationState(workspace) {
  const current = ensureWorkspace(workspace);
  const summary = buildPayrollSocialSummary(current, { period: current.currentPeriod });
  const latestVersion = getLatestReportVersion(current);
  const sourceIsCurrent = latestVersion?.sourceFingerprint
    ? latestVersion.sourceFingerprint === workflowSourceFingerprint(current)
    : Boolean(latestVersion)
      && current.tax?.frozenAt === latestVersion.createdAt
      && comparableSnapshot(latestVersion.snapshot) === comparableSnapshot(buildReportSnapshot(current));
  const version = sourceIsCurrent ? latestVersion : null;
  const payrollConfirmed = Boolean(
    version
    && summary.payrollRecords.length
    && current.tax.payrollConfirmedAt
    && current.tax.payrollConfirmedVersionId === version.id
    && current.tax.payrollConfirmedFingerprint === summary.fingerprints.payroll
  );
  const socialSecurityConfirmed = Boolean(
    version
    && summary.socialSecurityRecords.length
    && current.tax.socialSecurityConfirmedAt
    && current.tax.socialSecurityConfirmedVersionId === version.id
    && current.tax.socialSecurityConfirmedFingerprint === summary.fingerprints.socialSecurity
  );
  return {
    version,
    latestVersion,
    sourceIsCurrent,
    summary,
    payroll: {
      available: summary.payrollRecords.length > 0,
      confirmed: payrollConfirmed,
      confirmedAt: payrollConfirmed ? current.tax.payrollConfirmedAt : null,
    },
    socialSecurity: {
      available: summary.socialSecurityRecords.length > 0,
      confirmed: socialSecurityConfirmed,
      confirmedAt: socialSecurityConfirmed ? current.tax.socialSecurityConfirmedAt : null,
    },
  };
}

export function confirmPayrollSocialData(workspace, input = {}, context = {}) {
  const current = ensureWorkspace(workspace);
  const section = input.section;
  if (!["payroll", "socialSecurity"].includes(section)) throw new Error("请选择工资表或社保表确认项");
  const confirmed = input.confirmed !== false;
  const state = getPayrollSocialConfirmationState(current);
  const sectionState = state[section];
  if (confirmed && !state.version) throw new Error("请先按当前工资社保数据重新冻结报表版本");
  if (confirmed && !sectionState.available) throw new Error(section === "payroll" ? "当前期间还没有工资表记录" : "当前期间还没有社保表记录");
  const at = context.at || new Date().toISOString();
  const actor = context.actor || "本地用户";
  const isPayroll = section === "payroll";
  const sectionLabel = isPayroll ? "工资表" : "社保表";
  const recordCount = isPayroll
    ? state.summary.payrollRecords.length
    : state.summary.socialSecurityRecords.length;
  const storedVersionId = isPayroll
    ? current.tax.payrollConfirmedVersionId
    : current.tax.socialSecurityConfirmedVersionId;
  const boundVersion = state.version
    || current.delivery.reportVersions.find((version) => version.id === storedVersionId)
    || null;
  const nextTax = {
    ...current.tax,
    ...(isPayroll ? {
      payrollConfirmedAt: confirmed ? at : null,
      payrollConfirmedVersionId: confirmed ? state.version.id : null,
      payrollConfirmedFingerprint: confirmed ? state.summary.fingerprints.payroll : null,
    } : {
      socialSecurityConfirmedAt: confirmed ? at : null,
      socialSecurityConfirmedVersionId: confirmed ? state.version.id : null,
      socialSecurityConfirmedFingerprint: confirmed ? state.summary.fingerprints.socialSecurity : null,
    }),
    ownerConfirmedAt: null,
    ownerConfirmedVersionId: null,
    confirmedBy: confirmed ? actor : current.tax.confirmedBy,
  };
  const next = {
    ...current,
    tax: nextTax,
    delivery: {
      ...current.delivery,
      filing: {
        ...current.delivery.filing,
        finalConfirmedVersionId: null,
        exportedAt: null,
        exportedPackage: null,
        receipt: null,
        archivedAt: null,
      },
    },
  };
  return audit(
    next,
    confirmed ? `客户确认${sectionLabel}` : `撤销${sectionLabel}确认`,
    `${current.currentPeriod} · ${boundVersion?.label || "当前未冻结版本"} · ${recordCount} 条数据 · 当前浏览器本地记录`,
    actor,
  );
}

function comparableSnapshot(snapshot) {
  if (!snapshot) return "";
  const { generatedAt: _generatedAt, ...stable } = snapshot;
  return JSON.stringify(stable);
}

export function workflowChecks(workspace) {
  const taxEnabled = workspaceModuleEnabled(workspace, "tax");
  const snapshot = buildReportSnapshot(workspace);
  const statementsBalanced = Object.values(snapshot.summary.engineChecks || {}).every((check) => check.passed);
  const currentTransactions = workspace.transactions.filter((item) => String(item.date || "").startsWith(workspace.currentPeriod));
  const unresolved = currentTransactions.filter((item) => !["posted", "ignored"].includes(item.status));
  const openExceptionTasks = (workspace.exceptionTasks || []).filter((task) => task.status !== "resolved");
  const openNotices = (workspace.delivery.notices || []).filter((notice) => (
    notice.period === workspace.currentPeriod && notice.status !== "resolved"
  ));
  const bankReconciliationIssues = (workspace.bankImports || []).filter((bankImport) => (
    bankImport.period === workspace.currentPeriod
    && (bankImport.status !== "completed" || !bankImport.reconciliation?.passed)
  ));
  const pendingVouchers = (workspace.vouchers || []).filter((voucher) => (
    voucher.period === workspace.currentPeriod && !["posted", "superseded"].includes(voucher.status)
  ));
  const latestVersion = getLatestReportVersion(workspace);
  const sourceIsCurrent = latestVersion?.sourceFingerprint
    ? latestVersion.sourceFingerprint === workflowSourceFingerprint(workspace)
    : Boolean(latestVersion)
      && workspace.tax?.frozenAt === latestVersion.createdAt
      && comparableSnapshot(latestVersion.snapshot) === comparableSnapshot(snapshot);
  const version = sourceIsCurrent ? latestVersion : null;
  const filing = workspace.delivery.filing;
  const payrollSocialConfirmation = getPayrollSocialConfirmationState(workspace);
  const checks = [
    { id: "balanced", label: "试算、资产负债与现金变动勾稽通过", ok: statementsBalanced, page: "reports", detail: statementsBalanced ? "三项校验通过" : "至少一项校验存在差异" },
    { id: "bank", label: "本期银行流水余额勾稽通过", ok: bankReconciliationIssues.length === 0, page: "setup", detail: bankReconciliationIssues.length ? `${bankReconciliationIssues.length} 份银行流水有差异或错误行` : "已完成" },
    { id: "exceptions", label: "流水、异常与跨期事项已完成复核", ok: unresolved.length === 0 && openExceptionTasks.length === 0 && openNotices.length === 0, page: openNotices.length ? "overview" : "reconcile", detail: unresolved.length || openExceptionTasks.length || openNotices.length ? `${unresolved.length} 笔流水、${openExceptionTasks.length} 项异常、${openNotices.length} 项跨期待办未完成` : "已完成" },
    { id: "vouchers", label: "本期凭证已全部复核入账", ok: pendingVouchers.length === 0, page: "reconcile", detail: pendingVouchers.length ? `${pendingVouchers.length} 张草稿或更正待处理` : "已完成" },
    { id: "frozen", label: "本期当前数据已有冻结版本", ok: Boolean(version), page: "reports", detail: latestVersion && !version ? "上游数据已变化，请重新冻结" : undefined },
    { id: "finance", label: "客户已完成首次财务确认", ok: Boolean(version && workspace.tax.financeConfirmedAt && workspace.tax.financeConfirmedVersionId === version.id), page: "tax" },
    { id: "payroll", label: "客户已单独确认工资表", ok: Boolean(version && payrollSocialConfirmation.payroll.confirmed), page: "tax", detail: payrollSocialConfirmation.payroll.available ? (payrollSocialConfirmation.payroll.confirmed ? "工资表已绑定当前冻结版本" : "工资表待客户勾选确认") : "当前期间尚未导入工资表" },
    { id: "socialSecurity", label: "客户已单独确认社保表", ok: Boolean(version && payrollSocialConfirmation.socialSecurity.confirmed), page: "tax", detail: payrollSocialConfirmation.socialSecurity.available ? (payrollSocialConfirmation.socialSecurity.confirmed ? "社保表已绑定当前冻结版本" : "社保表待客户勾选确认") : "当前期间尚未导入社保表" },
    { id: "owner", label: "客户已完成最终责任确认", ok: Boolean(version && workspace.tax.ownerConfirmedAt && workspace.tax.ownerConfirmedVersionId === version.id && filing.finalConfirmedVersionId === version.id), page: "tax" },
    { id: "vatReconciliation", label: "增值税差异均已解释", ok: !snapshot.taxWorkpaper.vatReconciliation.hasUnexplainedDifferences, page: "tax", detail: snapshot.taxWorkpaper.vatReconciliation.hasUnexplainedDifferences ? snapshot.taxWorkpaper.vatReconciliation.unresolvedItems.map((item) => `${item.label}（差额 ${item.differenceBeforeAdjustment.toFixed(2)}）`).join("、") : "两项差异均已核对" },
    { id: "exported", label: "本地申报包已导出", ok: Boolean(version && filing.exportedAt && filing.exportedPackage?.reportVersionId === version.id), page: "tax" },
    { id: "receipt", label: "外部办理回执已本地导入", ok: Boolean(version
      && filing.receipt?.reportVersionId === version.id
      && filing.receipt?.packageId === filing.exportedPackage?.id
      && filing.receipt?.packageHash === filing.exportedPackage?.hash), page: "archive" },
  ];
  const archiveChecks = taxEnabled
    ? checks
    : checks.filter((check) => !["finance", "payroll", "socialSecurity", "owner", "vatReconciliation", "exported", "receipt"].includes(check.id));
  return {
    checks,
    prepare: checks.slice(0, 8),
    export: checks.slice(0, 10),
    archive: archiveChecks,
    snapshot,
    unresolved,
    openExceptionTasks,
    openNotices,
    bankReconciliationIssues,
    pendingVouchers,
    latestVersion,
    version,
  };
}

export function prepareFilingDraft(workspace, actor = "本地用户") {
  const flow = workflowChecks(workspace);
  const ready = flow.prepare.every((item) => item.ok);
  if (!ready || !flow.version) {
    const missing = flow.prepare.filter((item) => !item.ok).map((item) => item.label);
    throw new Error(`生成申报底稿前仍需完成：${missing.join("、")}`);
  }
  const at = new Date().toISOString();
  const next = {
    ...workspace,
    delivery: {
      ...workspace.delivery,
      filing: {
        ...workspace.delivery.filing,
        period: workspace.currentPeriod,
        draftCreatedAt: at,
        draftVersionId: flow.version.id,
      },
    },
  };
  return audit(next, "生成申报底稿", `${workspace.currentPeriod}，基于 ${flow.version.label}，仅供本地复核`, actor);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function auditCsv(workspace) {
  const rows = [["时间", "操作者", "动作", "详情"], ...workspace.auditLog.map((item) => [item.at, item.actor, item.action, item.detail])];
  return `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\n")}`;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function exportLocalFilingPackage(workspace) {
  const flow = workflowChecks(workspace);
  if (!flow.export.every((item) => item.ok) || !flow.version) {
    const missing = flow.export.filter((item) => !item.ok).map((item) => item.label);
    throw new Error(`生成最终本地申报包前仍需完成：${missing.join("、")}`);
  }

  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const folder = zip.folder(`${PRODUCT_NAME}-${workspace.currentPeriod}-本地申报包`);
  folder.file("重要说明.txt", [
    `${PRODUCT_NAME}本地申报包`,
    `工作台：${workspace.name}`,
    `所属期：${workspace.currentPeriod}`,
    `报表版本：${flow.version.label}`,
    "",
    "此文件包由浏览器本地生成，不代表已经连接或提交至电子税务局。",
    "请由客户或财务人员通过电子税务局/本地安全执行器完成外部办理，再把真实回执导回本工作台。",
  ].join("\n"));
  folder.file("报表快照.json", JSON.stringify(flow.version.snapshot, null, 2));
  folder.file("税务申报底稿.json", JSON.stringify({
    workspace: workspace.name,
    company: workspace.company,
    period: workspace.currentPeriod,
    workpaper: flow.version.snapshot.taxWorkpaper,
    disclaimer: "本地底稿，不是电子税务局正式申报文件。",
  }, null, 2));
  folder.file("客户确认记录.json", JSON.stringify({
    financeConfirmedAt: workspace.tax.financeConfirmedAt,
    payrollConfirmedAt: workspace.tax.payrollConfirmedAt,
    socialSecurityConfirmedAt: workspace.tax.socialSecurityConfirmedAt,
    ownerConfirmedAt: workspace.tax.ownerConfirmedAt,
    confirmedBy: workspace.tax.confirmedBy,
    payrollConfirmedVersionId: workspace.tax.payrollConfirmedVersionId,
    socialSecurityConfirmedVersionId: workspace.tax.socialSecurityConfirmedVersionId,
    payrollConfirmedFingerprint: workspace.tax.payrollConfirmedFingerprint,
    socialSecurityConfirmedFingerprint: workspace.tax.socialSecurityConfirmedFingerprint,
  }, null, 2));
  folder.file("工资与社保明细.json", JSON.stringify({
    ...buildPayrollSocialSummary(workspace, { period: workspace.currentPeriod }),
    confirmations: {
      payrollConfirmedAt: workspace.tax.payrollConfirmedAt,
      socialSecurityConfirmedAt: workspace.tax.socialSecurityConfirmedAt,
      confirmedBy: workspace.tax.confirmedBy,
    },
    disclaimer: "当前浏览器本地导入与确认记录；不代表已连接社保、个税或税务平台。",
  }, null, 2));
  const periodVouchers = (workspace.vouchers || []).filter((voucher) => voucher.period === workspace.currentPeriod && ["posted", "superseded"].includes(voucher.status));
  folder.file("凭证与附件索引.json", JSON.stringify(periodVouchers.map((voucher) => ({
    voucher,
    attachmentPackage: buildAttachmentPackage(workspace, voucher.id),
  })), null, 2));
  folder.file("资料清单.json", JSON.stringify((workspace.documents || []).filter((document) => !document.period || document.period === workspace.currentPeriod), null, 2));
  folder.file("银行勾稽记录.json", JSON.stringify((workspace.bankImports || []).filter((bankImport) => bankImport.period === workspace.currentPeriod), null, 2));
  folder.file("异常与确认记录.json", JSON.stringify({
    exceptions: workspace.exceptionTasks || [],
    confirmations: (workspace.confirmations || []).filter((confirmation) => confirmation.period === workspace.currentPeriod),
  }, null, 2));
  folder.file("操作日志.csv", auditCsv(workspace));
  const blob = await zip.generateAsync({ type: "blob" });
  const fileName = `${PRODUCT_NAME}-${workspace.name}-${workspace.currentPeriod}-本地申报包.zip`;
  const buffer = await blob.arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const id = uid("filing-package");
  downloadBlob(blob, fileName);
  return { id, fileName, size: blob.size, hash, exportedAt: new Date().toISOString(), reportVersionId: flow.version.id };
}

export async function importLocalReceipt(file) {
  const buffer = await file.arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let preview = "";
  if (/text|json|xml|csv/.test(file.type) || /\.(txt|json|xml|csv)$/i.test(file.name)) {
    preview = new TextDecoder("utf-8").decode(buffer.slice(0, 1600));
  }
  return {
    id: uid("receipt"),
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    hash,
    preview,
    importedAt: new Date().toISOString(),
  };
}

export function attachReceipt(workspace, receipt, actor = "本地用户") {
  const exportedPackage = workspace.delivery.filing.exportedPackage;
  if (!exportedPackage?.id || !exportedPackage.reportVersionId) throw new Error("请先导出当前版本的本地申报包，再导入对应回执");
  const currentVersion = workflowChecks(workspace).version;
  if (!currentVersion || exportedPackage.reportVersionId !== currentVersion.id) {
    throw new Error("报表数据已变化，请重新冻结并导出新的本地申报包后再导入回执");
  }
  const next = {
    ...workspace,
    delivery: {
      ...workspace.delivery,
      filing: {
        ...workspace.delivery.filing,
        receipt: {
          ...receipt,
          reportVersionId: exportedPackage.reportVersionId,
          packageId: exportedPackage.id,
          packageHash: exportedPackage.hash,
        },
      },
    },
  };
  return audit(next, "导入外部办理回执", `${receipt.name} · SHA-256 ${receipt.hash.slice(0, 12)}…`, actor);
}

export function markPackageExported(workspace, packageMeta, actor = "本地用户") {
  const current = ensureWorkspace(workspace);
  const flow = workflowChecks(current);
  const missing = flow.export.filter((item) => !item.ok).map((item) => item.label);
  if (missing.length || !flow.version) {
    throw new Error(`登记本地申报包前仍需完成：${missing.join("、")}`);
  }
  if (
    !packageMeta?.id
    || !packageMeta.fileName
    || !packageMeta.hash
    || !packageMeta.exportedAt
    || packageMeta.reportVersionId !== flow.version.id
  ) {
    throw new Error("申报包与当前已确认报表版本不一致，请重新生成本地申报包");
  }
  const next = {
    ...current,
    delivery: {
      ...current.delivery,
      filing: {
        ...current.delivery.filing,
        exportedAt: packageMeta.exportedAt,
        exportedPackage: packageMeta,
        receipt: null,
        archivedAt: null,
      },
    },
  };
  return audit(next, "导出本地申报包", `${packageMeta.fileName} · ${flow.version.label} · 未连接税务局`, actor);
}

export function archivePeriod(workspace, actor = "本地用户") {
  const flow = workflowChecks(workspace);
  if (!flow.archive.every((item) => item.ok) || !flow.version) {
    const missing = flow.archive.filter((item) => !item.ok).map((item) => item.label);
    throw new Error(`期间归档前仍需完成：${missing.join("、")}`);
  }
  const archivedAt = new Date().toISOString();
  const record = {
    id: uid("archive"),
    period: workspace.currentPeriod,
    archivedAt,
    reportVersionId: flow.version.id,
    reportVersionLabel: flow.version.label,
    sourceFingerprint: workflowSourceFingerprint(workspace),
    package: workspace.delivery.filing.exportedPackage,
    receipt: workspace.delivery.filing.receipt,
    confirmations: {
      financeConfirmedAt: workspace.tax.financeConfirmedAt,
      payrollConfirmedAt: workspace.tax.payrollConfirmedAt,
      socialSecurityConfirmedAt: workspace.tax.socialSecurityConfirmedAt,
      ownerConfirmedAt: workspace.tax.ownerConfirmedAt,
      confirmedBy: workspace.tax.confirmedBy,
      financeConfirmedVersionId: workspace.tax.financeConfirmedVersionId,
      payrollConfirmedVersionId: workspace.tax.payrollConfirmedVersionId,
      socialSecurityConfirmedVersionId: workspace.tax.socialSecurityConfirmedVersionId,
      payrollConfirmedFingerprint: workspace.tax.payrollConfirmedFingerprint,
      socialSecurityConfirmedFingerprint: workspace.tax.socialSecurityConfirmedFingerprint,
      ownerConfirmedVersionId: workspace.tax.ownerConfirmedVersionId,
      finalConfirmedVersionId: workspace.delivery.filing.finalConfirmedVersionId,
      initialConfirmationId: workspace.delivery.filing.initialConfirmationId,
    },
    filing: { ...workspace.delivery.filing },
    unresolvedIds: flow.unresolved.map((item) => item.id),
    carryForwardItems: workspace.transactions
      .filter((item) => String(item.date || "").startsWith(workspace.currentPeriod) && item.status === "ignored")
      .map((item) => ({ id: item.id, counterparty: item.counterparty, summary: item.summary, amount: item.amount, fromPeriod: workspace.currentPeriod })),
    closingLedger: flow.snapshot.ledger,
    summary: flow.snapshot.summary,
    reportSnapshot: flow.version.snapshot,
    vouchers: (workspace.vouchers || []).filter((voucher) => voucher.period === workspace.currentPeriod && ["posted", "superseded"].includes(voucher.status)),
    attachmentPackages: (workspace.vouchers || []).filter((voucher) => voucher.period === workspace.currentPeriod && ["posted", "superseded"].includes(voucher.status)).map((voucher) => buildAttachmentPackage(workspace, voucher.id)),
    documents: (workspace.documents || []).filter((document) => !document.period || document.period === workspace.currentPeriod),
    confirmationPackages: (workspace.confirmations || []).filter((confirmation) => confirmation.period === workspace.currentPeriod),
    exceptionRecords: (workspace.exceptionTasks || []).filter((task) => task.status === "resolved" || flow.unresolved.some((item) => item.id === task.sourceId)),
    auditSnapshot: workspace.auditLog || [],
  };
  const archivedDocumentIds = new Set(record.documents.map((document) => document.id));
  const next = {
    ...workspace,
    documents: (workspace.documents || []).map((document) => archivedDocumentIds.has(document.id)
      ? { ...document, lifecycleStatus: "已归档", archiveStatus: "archived", archivedAt }
      : document),
    delivery: {
      ...workspace.delivery,
      archives: [record, ...workspace.delivery.archives],
      filing: { ...workspace.delivery.filing, archivedAt },
    },
  };
  return audit(next, "完成期间归档", `${workspace.currentPeriod} · ${flow.version.label}`, actor);
}

export function nextPeriod(period) {
  const [year, month] = String(period).split("-").map(Number);
  const date = new Date(Date.UTC(year, month, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function resetTaxForPeriod(tax = {}, period) {
  return {
    period,
    vatRate: Number(tax.vatRate ?? 0.03),
    adjustments: 0,
    adjustmentSourceIds: [],
    payroll: 0,
    socialSecurity: 0,
    sourceIds: [],
    payrollSourceIds: [],
    socialSecuritySourceIds: [],
    invoiceVatSummary: null,
    vatReconciliations: [],
    note: "",
    frozenAt: null,
    financeConfirmedAt: null,
    payrollConfirmedAt: null,
    socialSecurityConfirmedAt: null,
    ownerConfirmedAt: null,
    confirmedBy: "",
    financeConfirmedVersionId: null,
    payrollConfirmedVersionId: null,
    socialSecurityConfirmedVersionId: null,
    payrollConfirmedFingerprint: null,
    socialSecurityConfirmedFingerprint: null,
    ownerConfirmedVersionId: null,
  };
}

export function enterNextPeriod(workspace, actor = "本地用户") {
  const filing = workspace.delivery.filing;
  const archive = workspace.delivery.archives.find((item) => item.period === workspace.currentPeriod);
  if (!filing.archivedAt || !archive) return workspace;
  if (archive.sourceFingerprint && archive.sourceFingerprint !== workflowSourceFingerprint(workspace)) {
    throw new Error("本期归档后数据又发生变化，不能沿用旧期末余额；请通过更正流程重新归档");
  }
  const target = nextPeriod(workspace.currentPeriod);
  const ledger = archive.closingLedger || {};
  const openingLedger = Object.fromEntries(Object.entries(ledger).map(([accountId, value]) => {
    const category = accountDefinition(accountId, workspace).category;
    const carriesForward = ["asset", "contraAsset", "liability", "equity"].includes(category);
    return [accountId, carriesForward ? Number(value || 0) : 0];
  }));
  const next = {
    ...workspace,
    currentPeriod: target,
    periods: [...new Set([target, ...workspace.periods])],
    openingLedger,
    tax: resetTaxForPeriod(workspace.tax, target),
    delivery: {
      ...workspace.delivery,
      notices: [
        ...(archive.carryForwardItems || []).map((item) => ({
          id: `carry-${target}-${item.id}`,
          period: target,
          sourceId: item.id,
          status: "open",
          message: `${item.fromPeriod} 延期事项：${item.counterparty || "未命名对象"} · ${item.summary || "待处理"}`,
          amount: item.amount,
        })),
        ...(workspace.delivery.notices || []),
      ],
      filing: emptyFiling(target),
    },
  };
  return audit(next, "进入下一期", `${workspace.currentPeriod} → ${target}，继承已归档期末余额`, actor);
}

export function formatCurrency(value, { sign = false } = {}) {
  const amount = Number(value || 0);
  const formatted = Math.abs(amount).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!sign) return `${amount < 0 ? "−" : ""}¥${formatted}`;
  return `${amount > 0 ? "+" : amount < 0 ? "−" : ""}¥${formatted}`;
}

export function formatPeriod(period) {
  const [year, month] = String(period).split("-");
  return `${year} 年 ${Number(month)} 月`;
}

export function formatDateTime(value) {
  if (!value) return "未完成";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
