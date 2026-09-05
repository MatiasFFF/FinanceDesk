import {
  accountDefinition,
  buildAttachmentPackage,
  buildCustomerConfirmationSections,
  buildFinancialStatements,
  buildManagementMetrics,
  buildPeriodCarryForward,
  buildTaxWorkpaper,
  customerConfirmationMatchesVersion,
  createCustomerConfirmationPackage,
  recordCustomerConfirmation,
} from "./domain/accounting/index.js";
import { buildPayrollSocialSummary, buildStructuredInvoiceVatSummary, verifyPayrollSocialEvidence } from "./features/intake/documentIntake.js";
import { buildPayrollAccountingSummary, payrollAccrualLines } from "./domain/accounting/payrollAccounting.js";
import { assertAccountingPeriodWritable, createManualVoucherDraft, createPostedVoucherRevision, reviseDraftVoucher } from "./domain/accounting/vouchers.js";
import { AccountingRuleError, appendAuditEntry, operationContext } from "./domain/accounting/model.js";
import { buildPayrollSourceState, payrollSourceMetric } from "./domain/accounting/payrollSource.js";
export { buildPayrollAccountingSummary } from "./domain/accounting/payrollAccounting.js";
import { buildBankAccountReconciliationSummary, buildBankMonthlyReconciliation } from "./features/intake/bankStatementImport.js";
import { buildInventorySummary } from "./features/inventory/inventoryLedger.js";
import {
  FITNESS_WORKSPACE_MODULE_DEFAULTS,
  WORKSPACE_MODULE_DEFAULTS,
  applyManagementReportConfig,
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

export async function createPayrollAccrualDraft(workspace, { reason = "", accounts } = {}, context = {}) {
  assertAccountingPeriodWritable(workspace);
  const originalFingerprint = buildPayrollAccountingSummary(workspace).sourceFingerprint;
  let next = structuredClone(workspace);
  if (accounts) next.rules = { ...next.rules, payrollAccounts: { ...next.rules?.payrollAccounts, ...accounts } };
  const summary = buildPayrollAccountingSummary(next);
  if (!summary.applicable || summary.createBlockers.length) throw new AccountingRuleError("PAYROLL_NOT_READY", summary.message, summary);
  const evidence = await verifyPayrollSocialEvidence(next, { period: next.currentPeriod, fileVault: context.fileVault });
  if (buildPayrollAccountingSummary(workspace).sourceFingerprint !== originalFingerprint) throw new AccountingRuleError("PAYROLL_SOURCE_CHANGED", "核验期间工资社保数据已变化，请重新生成草稿");
  if (!evidence.verified || !evidence.canGenerate) throw new AccountingRuleError("PAYROLL_ORIGINAL_REQUIRED", evidence.issues.map((issue) => issue.message).join("；"), evidence);
  if (evidence.fingerprint !== summary.evidence.fingerprint) throw new AccountingRuleError("PAYROLL_SOURCE_CHANGED", "工资社保原件已变化，请重新载入当前数据");
  if (summary.postedAndMatched || (!summary.readyToDraft && summary.draftVoucherId)) return next;
  const resolvedContext = operationContext({ ...context, mode: "manual" });
  const note = String(reason || "").trim();
  if (summary.postedVoucherId && !note) throw new AccountingRuleError("REVISION_REASON_REQUIRED", "已入账工资计提发生变化，请填写更正原因；原凭证将保留历史");
  const basis = {
    kind: "business",
    description: "按当前工资表应发、实发、代扣个税和社保表个人、企业社保计提；不计算新税率。应发＝实发＋个人社保＋个税。",
    payrollSourceFingerprint: summary.sourceFingerprint,
    payrollRuleSnapshot: structuredClone(summary.ruleSnapshot),
    voucherIds: summary.postedVoucherId ? [summary.postedVoucherId] : [],
  };
  let voucherId = summary.draftVoucherId;
  if (!voucherId && summary.postedVoucherId) {
    next = createPostedVoucherRevision(next, { voucherId: summary.postedVoucherId, reason: note }, resolvedContext);
    voucherId = next.vouchers.find((voucher) => voucher.revisionOf === summary.postedVoucherId && voucher.status === "draft").id;
  }
  const payload = {
    summary: `${summary.period} 工资与企业社保计提`,
    lines: payrollAccrualLines(summary), evidenceIds: evidence.documentIds, basis,
  };
  if (voucherId) {
    next = reviseDraftVoucher(next, { ...payload, voucherId, reason: note || "依据当前两表及科目规则更新未入账工资计提草稿" }, resolvedContext);
  } else {
    const [year, month] = summary.period.split("-").map(Number);
    const date = `${summary.period}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`;
    next = createManualVoucherDraft(next, { ...payload, date, note: note || basis.description }, resolvedContext);
    voucherId = next.vouchers.at(-1).id;
  }
  const voucher = next.vouchers.find((item) => item.id === voucherId);
  voucher.payrollAccrual = {
    period: summary.period, sourceFingerprint: summary.sourceFingerprint,
    accounts: structuredClone(summary.accounts), expected: structuredClone(summary.expected),
    sourceIds: [...summary.sourceIds], sourceDocumentIds: [...summary.documentIds],
    ruleSnapshot: structuredClone(summary.ruleSnapshot), originalVerification: { at: resolvedContext.at, documents: evidence.documents },
  };
  voucher.accountingAttributes = { ...voucher.accountingAttributes, payrollAccrual: true };
  voucher.versions.at(-1).payrollAccrual = structuredClone(voucher.payrollAccrual);
  appendAuditEntry(next, {
    action: "payroll.create_accrual_draft", entityType: "voucher", entityId: voucherId,
    detail: `${payload.summary}；费用 ${summary.expected.expenseTotal}，实发应付 ${summary.expected.netSalary}，社保应付 ${summary.expected.socialSecurityPayable}，个税应付 ${summary.expected.individualIncomeTax}；${note || "待财务复核入账"}`,
    sourceIds: [...summary.sourceIds, ...summary.documentIds], after: structuredClone(voucher.payrollAccrual),
  }, resolvedContext);
  return next;
}

export const DEFAULT_WORKSPACE_TERMINOLOGY = Object.freeze({
  customer: "客户",
  supplier: "供应商",
  personnel: "员工",
  location: "门店",
  member: "会员",
  coach: "教练",
  service: "服务",
});

const DEFAULT_TERMINOLOGY_KEYS = Object.freeze({
  客户: "customer",
  供应商: "supplier",
  员工: "personnel",
  门店: "location",
  会员: "member",
  教练: "coach",
  服务: "service",
});

export function workspaceTerminology(workspace) {
  return Object.fromEntries(Object.entries(DEFAULT_WORKSPACE_TERMINOLOGY).map(([key, fallback]) => {
    const configured = String(workspace?.terminology?.[key] || "").trim();
    return [key, configured || fallback];
  }));
}

export function applyWorkspaceTerminology(value, workspace) {
  if (typeof value !== "string") return value;
  const terminology = workspaceTerminology(workspace);
  return value.replace(/客户|供应商|员工|门店|会员|教练|服务/g, (fallback) => (
    terminology[DEFAULT_TERMINOLOGY_KEYS[fallback]] || fallback
  ));
}

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
  { id: "inventory", moduleId: "inventory", label: "库存与损耗", shortLabel: "库存" },
  { id: "reconcile", moduleId: "reconcile", label: "批量核销", shortLabel: "核销" },
  { id: "reports", moduleId: "reports", label: "报表中心", shortLabel: "报表" },
  { id: "tax", moduleId: "tax", label: "确认与申报", shortLabel: "确认" },
  { id: "archive", moduleId: "archive", label: "资料归档", shortLabel: "归档" },
  { id: "setup", moduleId: "setup", label: "基础资料", shortLabel: "基础" },
];

export const WORKSPACE_MODULE_OPTIONS = Object.freeze([
  { id: "members", label: "会员业务", description: "会员台账、履约、退款与业务提成" },
  { id: "payroll", label: "工资与社保", description: "工资表、社保表、逐人核对与独立确认" },
  { id: "inventory", label: "库存与损耗", description: "库存商品、出入库、盘点与损耗记录" },
  { id: "reconcile", label: "流水核销", description: "银行流水、往来账单与会计处理" },
  { id: "tax", label: "确认与申报", description: "客户确认、申报底稿与本地申报包" },
]);

export function defaultWorkspaceModules(mode = "blank") {
  return { ...(mode === "fitness" ? FITNESS_WORKSPACE_MODULE_DEFAULTS : WORKSPACE_MODULE_DEFAULTS) };
}

export function workspaceModuleEnabled(workspace, moduleId) {
  const fitnessTemplate = workspace?.templateId === "fitness-studio" || Boolean(workspace?.isDemo);
  const hasMemberBusiness = workspace?.templateId === "fitness-studio"
    || workspace?.isDemo
    || (workspace?.members || []).length > 0
    || (workspace?.businessEvents || []).some((event) => event.memberId || event.memberName || event.coach);
  return normalizeWorkspaceModules(workspace?.modules, {
    fitnessTemplate: hasMemberBusiness,
    payrollDefault: fitnessTemplate,
  })[moduleId] !== false;
}

export function primaryNavigationForWorkspace(workspace) {
  const terminology = workspaceTerminology(workspace);
  return PRIMARY_NAV
    .filter((item) => workspaceModuleEnabled(workspace, item.moduleId))
    .map((item) => item.id === "members" ? {
      ...item,
      label: `${terminology.member}台账`,
      shortLabel: terminology.member,
    } : item);
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

function uniqueSourceIds(...groups) {
  return [...new Set(groups.flat(Infinity).filter((value) => value !== null && value !== undefined && value !== ""))];
}

function replaceGeneratedAccountLabels(value, workspace) {
  if (typeof value !== "string") return value;
  const replacements = [
    ["主营业务收入 · 私教课", accountDefinition("revenuePrivate", workspace).label],
    ["主营业务收入 · 团课", accountDefinition("revenueGroup", workspace).label],
    ["销售费用 · 教练提成", accountDefinition("expenseCommission", workspace).label],
  ];
  const replaced = replacements.reduce((current, [legacyLabel, currentLabel]) => (
    legacyLabel === currentLabel || current.includes(currentLabel)
      ? current
      : current.replaceAll(legacyLabel, currentLabel)
  ), value);
  return applyWorkspaceTerminology(replaced, workspace);
}

function neutralGeneratedReportLabel(value, workspace) {
  const exactLabels = {
    私教课收入: accountDefinition("revenuePrivate", workspace).label,
    团课收入: accountDefinition("revenueGroup", workspace).label,
    教练提成: accountDefinition("expenseCommission", workspace).label,
    "会员预收 / 未履约服务": "客户预收 / 未履约服务",
    会员退款: "业务退款",
    会员业务: "业务事件",
  };
  return Object.hasOwn(exactLabels, value)
    ? applyWorkspaceTerminology(exactLabels[value], workspace)
    : replaceGeneratedAccountLabels(value, workspace);
}

function neutralGeneratedReportFormula(value, workspace) {
  if (typeof value !== "string") return value;
  const localizedCommissionLabel = applyWorkspaceTerminology(accountDefinition("expenseCommission", workspace).label, workspace);
  const localizedFormula = replaceGeneratedAccountLabels(value, workspace);
  const localizedLegacyFormula = applyWorkspaceTerminology("确认收入 − 教练提成", workspace);
  return localizedFormula.replace(localizedLegacyFormula, `确认收入 − ${localizedCommissionLabel}`);
}

function localizeReportSnapshot(snapshot, workspace, options = {}) {
  if (!snapshot) return snapshot;
  const memberEnabled = workspaceModuleEnabled(workspace, "members");
  const vouchers = safeArray(workspace.vouchers);
  const voucherForDetail = (detail) => vouchers.find((voucher) => (
    detail?.voucherId === voucher.id
    || detail?.id === voucher.id
    || String(detail?.id || "").startsWith(`${voucher.id}-`)
  ));
  const displayLabel = (value) => memberEnabled
    ? replaceGeneratedAccountLabels(value, workspace)
    : neutralGeneratedReportLabel(value, workspace);
  const displayFormula = (value) => memberEnabled
    ? replaceGeneratedAccountLabels(value, workspace)
    : neutralGeneratedReportFormula(value, workspace);
  const localizeDetail = (detail) => {
    const voucher = options.attachVoucherTrace ? voucherForDetail(detail) : null;
    return {
      ...detail,
      title: replaceGeneratedAccountLabels(detail?.title, workspace),
      reference: displayLabel(detail?.reference),
      description: replaceGeneratedAccountLabels(detail?.description, workspace),
      ...(voucher ? {
        voucherId: voucher.id,
        sourceIds: uniqueSourceIds(detail?.sourceIds, voucher.id),
      } : {}),
    };
  };
  const localizeRow = (row) => ({
    ...row,
    label: displayLabel(row?.label),
    formula: displayFormula(row?.formula),
    details: safeArray(row?.details).map(localizeDetail),
  });
  return {
    ...snapshot,
    sections: Object.fromEntries(Object.entries(snapshot.sections || {}).map(([sectionId, section]) => [sectionId, {
      ...section,
      label: applyWorkspaceTerminology(section?.label, workspace),
      rows: safeArray(section?.rows).map(localizeRow),
    }])),
    taxWorkpaper: snapshot.taxWorkpaper ? {
      ...snapshot.taxWorkpaper,
      disclaimer: applyWorkspaceTerminology(snapshot.taxWorkpaper.disclaimer, workspace),
      rows: safeArray(snapshot.taxWorkpaper.rows).map(localizeRow),
    } : snapshot.taxWorkpaper,
  };
}

function normalizeFrozenReportVersionTerminology(version, workspace) {
  if (!version?.snapshot) return version;
  return {
    ...version,
    snapshot: localizeReportSnapshot(version.snapshot, workspace, {
      attachVoucherTrace: !workspaceModuleEnabled(workspace, "members"),
    }),
  };
}

export function ensureWorkspace(workspace) {
  const period = workspace.currentPeriod || new Date().toISOString().slice(0, 7);
  const delivery = workspace.delivery || emptyDelivery(period);
  const modules = normalizeWorkspaceModules(workspace.modules, {
    fitnessTemplate: workspace.templateId === "fitness-studio" || workspace.isDemo,
  });
  const terminologyWorkspace = {
    ...workspace,
    modules,
    vouchers: safeArray(workspace.vouchers),
  };
  return {
    ...workspace,
    name: workspace.name || "未命名工作台",
    modules,
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
    inventoryItems: safeArray(workspace.inventoryItems),
    inventoryMovements: safeArray(workspace.inventoryMovements),
    auditLog: safeArray(workspace.auditLog),
    tax: {
      period,
      vatRate: 0.03,
      surtaxRate: 0.12,
      incomeTaxRate: 0.05,
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
      reportVersions: safeArray(delivery.reportVersions)
        .map((version) => normalizeFrozenReportVersionTerminology(version, terminologyWorkspace)),
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

function accountRows(workspace, accountNames, multiplier = 1) {
  const periodVouchers = safeArray(workspace.vouchers).filter(
    (voucher) => voucher.status === "posted" && String(voucher.date || "").startsWith(workspace.currentPeriod),
  );
  return periodVouchers
    .flatMap((voucher) => safeArray(voucher.lines)
      .map((line, lineIndex) => ({ line, lineIndex }))
      .filter(({ line }) => accountNames.includes(String(line.account).split(":")[0]) || (accountNames.some((account) => ["bank", "cash"].includes(account)) && accountDefinition(line.account, workspace).cash))
      .map(({ line, lineIndex }) => ({
        id: `${voucher.id}-${line.account}-${lineIndex}`,
        date: voucher.date,
        title: `${voucher.summary || voucher.no || voucher.id} · ${accountDefinition(line.account, workspace).label}`,
        reference: voucher.no || voucher.id,
        description: `${uniqueSourceIds(voucher.id, voucher.sourceIds, line.sourceIds).length} 个来源 · ${safeArray(voucher.evidenceIds).length} 份本地附件`,
        amount: roundMoney((Number(line.debit || 0) - Number(line.credit || 0)) * multiplier),
        voucherId: voucher.id,
        sourceIds: uniqueSourceIds(voucher.id, voucher.sourceIds, line.sourceIds),
        evidenceIds: safeArray(voucher.evidenceIds),
      })))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function detailTotal(details) {
  return roundMoney(safeArray(details).reduce((sum, detail) => sum + Number(detail.amount || 0), 0));
}

function cashMovementDetails(workspace, movements) {
  const voucherById = new Map(safeArray(workspace.vouchers).map((voucher) => [voucher.id, voucher]));
  return safeArray(movements).map((movement) => ({
    id: movement.voucherId,
    voucherId: movement.voucherId,
    date: movement.date,
    title: movement.summary,
    reference: "已入账凭证",
    amount: movement.amount,
    sourceIds: uniqueSourceIds(movement.voucherId, movement.sourceIds),
    evidenceIds: safeArray(voucherById.get(movement.voucherId)?.evidenceIds),
  }));
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
  const inventoryEnabled = workspaceModuleEnabled(workspace, "inventory");
  const statements = calculatePeriodLedger(workspace);
  const engine = statements.engine;
  const management = buildManagementMetrics(workspace, { period: workspace.currentPeriod });
  const managementById = Object.fromEntries(management.metrics.map((metric) => [metric.id, metric]));
  const inventorySummary = inventoryEnabled ? buildInventorySummary(workspace, { period: workspace.currentPeriod }) : null;
  const inventoryValue = roundMoney(inventorySummary?.inventoryValue ?? inventorySummary?.totals?.inventoryValue ?? inventorySummary?.totalValue ?? 0);
  const inventoryLoss = roundMoney(inventorySummary?.lossAmount ?? inventorySummary?.totals?.lossAmount ?? inventorySummary?.periodLossAmount ?? 0);
  const inventorySourceIds = uniqueSourceIds(safeArray(inventorySummary?.sourceIds), safeArray(inventorySummary?.inventorySourceIds));
  const inventoryLossSourceIds = uniqueSourceIds(safeArray(inventorySummary?.lossSourceIds), inventorySourceIds);
  const inventoryValueDetails = inventorySourceIds.length ? [{
    id: `inventory-value-${workspace.currentPeriod}`,
    date: `${workspace.currentPeriod}-01`,
    title: "库存商品期末金额",
    reference: "库存台账",
    description: `${inventorySourceIds.length} 条库存来源`,
    amount: inventoryValue,
    sourceIds: inventorySourceIds,
  }] : [];
  const inventoryLossDetails = inventoryLossSourceIds.length ? [{
    id: `inventory-loss-${workspace.currentPeriod}`,
    date: `${workspace.currentPeriod}-01`,
    title: "本期库存损耗",
    reference: "库存变动记录",
    description: `${inventoryLossSourceIds.length} 条库存来源`,
    amount: inventoryLoss,
    sourceIds: inventoryLossSourceIds,
  }] : [];
  const engineTax = buildTaxWorkpaper(workspace, { period: workspace.currentPeriod });
  const invoiceVatSummary = buildStructuredInvoiceVatSummary(workspace, { period: workspace.currentPeriod });
  const vatReconciliation = buildVatReconciliationSummary(workspace, {
    period: workspace.currentPeriod,
    statements,
    engineTax,
    invoiceVatSummary,
  });
  const payrollSourceState = engineTax.payrollSourceState;
  const payrollSocialSummary = payrollSourceState.summary;
  const payrollRow = (id, label, source, amount, details, formula) => ({
    ...makeTraceableRow(id, label, amount, details, formula),
    ...payrollSourceMetric(source, amount),
  });
  const usesStructuredInvoiceVat = invoiceVatSummary.usesStructuredInvoices;
  const cashMovements = statements.cashFlow.movements || [];
  const cashIn = roundMoney(cashMovements.filter((item) => item.amount > 0).reduce((sum, item) => sum + item.amount, 0));
  const cashOut = roundMoney(cashMovements.filter((item) => item.amount < 0).reduce((sum, item) => sum + Math.abs(item.amount), 0));
  const receivable = roundMoney(Math.max(0, amountForAccount(statements.ledger, "receivable")));
  const payable = roundMoney(Math.max(0, -amountForAccount(statements.ledger, "payable")));
  const prepayment = roundMoney(Math.max(0, amountForAccount(statements.ledger, "prepayment")));
  const contractLiability = roundMoney(Math.max(0, -amountForAccount(statements.ledger, "contractLiability")));
  const estimatedOutputVat = usesStructuredInvoiceVat ? invoiceVatSummary.outputVat : engineTax.outputVat.value;
  const deductibleInputVat = usesStructuredInvoiceVat ? invoiceVatSummary.deductibleInputVat : engineTax.inputVat.value;
  const nonDeductibleInputVat = usesStructuredInvoiceVat ? invoiceVatSummary.nonDeductibleInputVat : 0;
  const estimatedVat = usesStructuredInvoiceVat ? invoiceVatSummary.vatPayable : engineTax.vatPayable.value;
  const vatRate = Number(workspace.tax?.vatRate ?? 0.03);
  const surtaxRate = Number(workspace.tax?.surtaxRate ?? 0.12);
  const incomeTaxRate = Number(workspace.tax?.incomeTaxRate ?? 0.05);
  const vatRatePercent = `${(vatRate * 100).toFixed(2)}%`;
  const surtaxRatePercent = `${(surtaxRate * 100).toFixed(2)}%`;
  const incomeTaxRatePercent = `${(incomeTaxRate * 100).toFixed(2)}%`;
  const estimatedSurtax = roundMoney(estimatedVat * surtaxRate);
  const estimatedIncomeTax = roundMoney(Math.max(0, statements.profit) * incomeTaxRate);
  const estimatedTax = roundMoney(estimatedVat + estimatedSurtax + estimatedIncomeTax);
  const cashBalance = statements.cashFlow.closingCash.value;
  const assetDetails = ledgerDetails(workspace, engine, (item) => item.account.category === "asset", (amount) => amount);
  const liabilityDetails = ledgerDetails(workspace, engine, (item) => item.account.category === "liability", (amount) => -amount);
  const equityAccountDetails = ledgerDetails(workspace, engine, (item) => item.account.category === "equity", (amount) => -amount);
  const revenueDetails = ledgerDetails(workspace, engine, (item) => ["revenue", "contraRevenue"].includes(item.account.category), (amount) => -amount)
    .filter((detail) => detail.voucherId);
  const expenseDetails = ledgerDetails(workspace, engine, (item) => item.account.category === "expense", (amount) => amount)
    .filter((detail) => detail.voucherId);
  const costDetails = ledgerDetails(workspace, engine, (item) => item.account.category === "cost", (amount) => amount)
    .filter((detail) => detail.voucherId);
  const profitDetails = ledgerDetails(workspace, engine, (item) => ["revenue", "contraRevenue", "cost", "expense"].includes(item.account.category), (amount) => -amount)
    .filter((detail) => detail.voucherId);
  const cashDetails = ledgerDetails(workspace, engine, (item) => item.account.cash, (amount) => amount);
  const receivableDetails = ledgerDetails(workspace, engine, (item) => item.accountId === "receivable", (amount) => amount);
  const prepaymentDetails = ledgerDetails(workspace, engine, (item) => item.accountId === "prepayment", (amount) => amount);
  const equipmentDetails = ledgerDetails(workspace, engine, (item) => item.accountId === "equipment", (amount) => amount);
  const payableDetails = ledgerDetails(workspace, engine, (item) => item.accountId === "payable", (amount) => -amount);
  const contractLiabilityDetails = ledgerDetails(workspace, engine, (item) => item.accountId === "contractLiability", (amount) => -amount);
  const privateRevenueDetails = accountRows(workspace, ["revenuePrivate"], -1);
  const groupRevenueDetails = accountRows(workspace, ["revenueGroup"], -1);
  const combinedRevenueDetails = [...privateRevenueDetails, ...groupRevenueDetails]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const refundDetails = ledgerDetails(
    workspace,
    engine,
    (item) => item.account.category === "contraRevenue",
    (amount) => amount,
  ).filter((detail) => detail.voucherId);
  const commissionDetails = accountRows(workspace, ["expenseCommission"]);
  const rentDetails = accountRows(workspace, ["expenseRent"]);
  const utilityDetails = accountRows(workspace, ["expenseUtility"]);
  const feeDetails = accountRows(workspace, ["expenseFee"]);
  const cashFlowDetails = cashMovementDetails(workspace, cashMovements);
  const primaryRevenueLabel = accountDefinition("revenuePrivate", workspace).label;
  const otherRevenueLabel = accountDefinition("revenueGroup", workspace).label;
  const combinedRevenueLabel = [...new Set([primaryRevenueLabel, otherRevenueLabel])].join(" / ");
  const commissionLabel = accountDefinition("expenseCommission", workspace).label;
  const rentLabel = accountDefinition("expenseRent", workspace).label;
  const utilityLabel = accountDefinition("expenseUtility", workspace).label;
  const feeLabel = accountDefinition("expenseFee", workspace).label;
  const receivableLabel = accountDefinition("receivable", workspace).label;
  const prepaymentLabel = accountDefinition("prepayment", workspace).label;
  const equipmentLabel = accountDefinition("equipment", workspace).label;
  const payableLabel = accountDefinition("payable", workspace).label;
  const contractLiabilityLabel = accountDefinition("contractLiability", workspace).label;
  const salesReturnsLabel = accountDefinition("salesReturns", workspace).label;
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
  const vatPayableDetails = usesStructuredInvoiceVat
    ? structuredVatPayableDetails
    : [{ ...formulaDetail("estimated-vat", "增值税估算", estimatedVat, `销项估算减进项税额，税率 ${vatRatePercent}`), sourceIds: engineTax.vatPayable.sourceIds }];
  const surtaxDetails = [{
    ...formulaDetail("estimated-surtax", "附加税费估算", estimatedSurtax, `按增值税估算额的 ${surtaxRatePercent} 本地估算`),
    sourceIds: uniqueSourceIds(vatPayableDetails.flatMap((detail) => detail.sourceIds || [])),
  }];
  const incomeTaxDetails = [{
    ...formulaDetail("estimated-income-tax", "所得税估算", estimatedIncomeTax, `按正数会计利润的 ${incomeTaxRatePercent} 本地估算`),
    sourceIds: engine.incomeStatement.profit.sourceIds,
  }];
  const taxEstimateDetails = [...vatPayableDetails, ...surtaxDetails, ...incomeTaxDetails];
  const cashGapValue = Math.abs(Math.min(0, managementById.cashGap?.value ?? (cashBalance - payable - estimatedTax)));
  const cashGapDetails = [
    formulaDetail("gap-cash", "可用现金余额", cashBalance, "来自已入账凭证与期初结转"),
    formulaDetail("gap-payable", "减：供应商应付", -payable, "来自未结清应付账单"),
    formulaDetail("gap-tax", "减：预计税费", -estimatedTax, "本地估算，不代表正式申报额"),
  ];

  const report = {
    period: workspace.currentPeriod,
    generatedAt: new Date().toISOString(),
    ledger: statements.ledger,
    confirmationContext: {
      payrollEnabled: workspaceModuleEnabled(workspace, "payroll"),
      costSourceIds: engine.incomeStatement.cost.sourceIds,
      costExpense: makeTraceableRow("costExpense", "成本费用", engine.incomeStatement.cost.value + statements.expenses, [...costDetails, ...expenseDetails], "本期成本 + 期间费用"),
      openItems: [
        ...(workspace.exceptionTasks || []).filter((item) => item.status !== "resolved").map((item) => ({ id: item.id, type: "异常任务", label: item.message || item.code || item.id, detail: item.sourceId || "S7 异常处理", sourceIds: uniqueSourceIds(item.id, item.sourceId, item.sourceIds) })),
        ...(workspace.transactions || []).filter((item) => String(item.date || "").startsWith(workspace.currentPeriod) && !["posted", "ignored"].includes(item.status)).map((item) => ({ id: item.id, type: "未决流水", label: item.summary || item.counterparty || item.id, detail: item.serial || item.date, sourceIds: uniqueSourceIds(item.id, item.sourceIds) })),
        ...(workspace.delivery?.notices || []).filter((item) => item.period === workspace.currentPeriod && item.status !== "resolved").map((item) => ({ id: item.id, type: "跨期事项", label: item.message || item.id, detail: item.sourceId || "待处理", sourceIds: uniqueSourceIds(item.id, item.sourceId) })),
      ],
    },
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
          makeTraceableRow("receivable", receivableLabel, amountForAccount(statements.ledger, "receivable"), receivableDetails, `${receivableLabel}期初余额 + 借方发生额 − 贷方发生额`),
          makeTraceableRow("prepayment", prepaymentLabel, amountForAccount(statements.ledger, "prepayment"), prepaymentDetails, `${prepaymentLabel}期初余额 + 借方发生额 − 贷方发生额`),
          makeTraceableRow("equipment", equipmentLabel, amountForAccount(statements.ledger, "equipment"), equipmentDetails, `${equipmentLabel}期初余额 + 本期净增加`),
          makeTraceableRow("assets", "资产合计", statements.assets, assetDetails, "所有资产类科目期末余额合计"),
          makeTraceableRow("payable", payableLabel, -amountForAccount(statements.ledger, "payable"), payableDetails, `${payableLabel}期初余额 + 贷方发生额 − 借方发生额`),
          makeTraceableRow("contractLiability", contractLiabilityLabel, contractLiability, contractLiabilityDetails, `${contractLiabilityLabel}期初余额 + 预收 − 履约确认`),
          makeTraceableRow("liabilities", "负债合计", statements.liabilities, liabilityDetails, "所有负债类科目期末余额合计"),
          makeTraceableRow("equity", "所有者权益", statements.equity, [...equityAccountDetails, ...profitDetails], "权益类科目期末余额 + 本期利润"),
          makeTraceableRow("liabilitiesEquity", "负债和所有者权益合计", statements.liabilities + statements.equity, [...liabilityDetails, ...equityAccountDetails, ...profitDetails], "负债合计 + 所有者权益"),
        ],
      },
      income: {
        label: "利润表",
        rows: [
          ...(memberBusinessEnabled ? [
            makeRow("privateRevenue", primaryRevenueLabel, detailTotal(privateRevenueDetails), privateRevenueDetails),
            makeRow("groupRevenue", otherRevenueLabel, detailTotal(groupRevenueDetails), groupRevenueDetails),
          ] : [
            makeRow("serviceRevenue", combinedRevenueLabel, detailTotal(combinedRevenueDetails), combinedRevenueDetails),
          ]),
          makeTraceableRow("revenue", "营业收入", statements.revenue, revenueDetails, "收入类发生额 − 销售退回与折让"),
          makeRow("rent", rentLabel, detailTotal(rentDetails), rentDetails),
          makeRow("utility", utilityLabel, detailTotal(utilityDetails), utilityDetails),
          makeRow("fees", feeLabel, detailTotal(feeDetails), feeDetails),
          makeRow("commission", commissionLabel, detailTotal(commissionDetails), commissionDetails),
          makeTraceableRow("expenses", "期间费用", statements.expenses, expenseDetails, "本期各费用类科目借方净发生额"),
          makeTraceableRow("profit", "本月利润", statements.profit, profitDetails, "营业收入 − 销售退回 − 成本 − 期间费用"),
        ],
      },
      cashflow: {
        label: "现金流量表",
        rows: [
          makeRow("operating", "经营活动现金流量净额", statements.cashFlow.operating.value, cashMovementDetails(workspace, statements.cashFlow.operating.rows)),
          makeRow("investing", "投资活动现金流量净额", statements.cashFlow.investing.value, cashMovementDetails(workspace, statements.cashFlow.investing.rows)),
          makeRow("financing", "筹资活动现金流量净额", statements.cashFlow.financing.value, cashMovementDetails(workspace, statements.cashFlow.financing.rows)),
          makeRow("netCash", "现金净增加额", statements.cashFlow.netChange.value, cashFlowDetails),
          makeTraceableRow("closingCash", "期末现金余额", cashBalance, cashDetails, "期初现金 + 本期现金净增加额"),
        ],
      },
      owner: {
        label: "老板报表",
        rows: applyManagementReportConfig([
          makeTraceableRow("ownerCash", "现金余额", cashBalance, cashDetails, "期初现金 + 本期已入账现金变动"),
          makeTraceableRow("ownerCashIn", "本月收款", cashIn, cashFlowDetails.filter((item) => item.amount > 0), "本期已入账现金流入合计"),
          makeTraceableRow("ownerRevenue", "本月收入", statements.revenue, revenueDetails, "收入类发生额 − 销售退回与折让"),
          makeTraceableRow("ownerGrossProfit", "本月毛利", engine.incomeStatement.grossProfit.value, [...revenueDetails, ...costDetails.map((item) => ({ ...item, amount: -item.amount }))], "营业收入 − 销售退回 − 营业成本"),
          makeTraceableRow("ownerProfit", "本月利润", statements.profit, profitDetails, "营业收入 − 销售退回 − 成本 − 期间费用"),
          makeTraceableRow("ownerPrepaid", memberBusinessEnabled ? "会员预收 / 未履约服务" : "客户预收 / 未履约服务", contractLiability, contractLiabilityDetails, "合同负债科目期末贷方余额"),
          makeTraceableRow("ownerReceivable", "应收账款", receivable, receivableDetails, "应收账款科目期末借方余额"),
          makeTraceableRow("ownerPayable", "供应商应付", payable, payableDetails, "应付账款科目期末贷方余额"),
          makeTraceableRow("ownerPrepayment", "供应商预付", prepayment, prepaymentDetails, "预付款项科目期末借方余额"),
          makeTraceableRow("ownerRefund", "本月退款", engine.incomeStatement.salesReturns.value, refundDetails, `${salesReturnsLabel}本期借方净发生额`),
          makeTraceableRow("ownerCommission", commissionLabel, detailTotal(commissionDetails), commissionDetails, `${commissionLabel}本期借方净发生额`),
          ...(inventoryEnabled ? [
            { ...makeTraceableRow("ownerInventory", "库存金额", inventoryValue, inventoryValueDetails, "来自库存台账的期末库存金额"), sourceIds: inventorySourceIds },
            { ...makeTraceableRow("ownerInventoryLoss", "本期库存损耗", inventoryLoss, inventoryLossDetails, "来自本期库存损耗变动"), sourceIds: inventoryLossSourceIds },
          ] : []),
          makeTraceableRow("ownerTax", "预计税款（本地估算）", estimatedTax, taxEstimateDetails, "增值税估算 + 附加税费估算 + 所得税估算"),
          makeTraceableRow("ownerGap", "未来现金缺口", cashGapValue, cashGapDetails, "max(0，应付与预计税费 − 可用现金)"),
        ], workspace.managementReport),
      },
    },
    taxWorkpaper: {
      sourceMode: usesStructuredInvoiceVat ? "structured_invoices" : "legacy_estimate",
      invoiceVatSummary,
      vatReconciliation,
      payrollSocialSummary,
      payrollSourceState,
      disclaimer: usesStructuredInvoiceVat
        ? "增值税数据来自本地人工录入并关联的结构化发票；查验状态不代表已联网查验，附加税费与所得税仍为本地估算。"
        : "本期没有已人工分类且关联业务的结构化发票，增值税仍采用本地估算；未连接税务平台。",
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
          usesStructuredInvoiceVat ? outputInvoiceVatDetails : [formulaDetail("output-vat", "销项税额估算", estimatedOutputVat, `计税基础 × 本地配置税率 ${vatRatePercent}`)],
          usesStructuredInvoiceVat ? "有效销项发票税额汇总；已开红字按负数，作废不计入" : `计税基础 × 本地配置税率 ${vatRatePercent}`,
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
          vatPayableDetails,
          usesStructuredInvoiceVat ? "max(0，销项税额 − 可抵扣进项税额)" : "max(0，销项税额估算 − 进项税额)",
        ),
        makeTraceableRow("surtax", "附加税费估算", estimatedSurtax, surtaxDetails, `增值税估算额 × ${surtaxRatePercent}`),
        makeTraceableRow("incomeTax", "所得税估算", estimatedIncomeTax, incomeTaxDetails, `max(0，本月利润) × ${incomeTaxRatePercent}`),
        payrollRow("payroll", "应发工资", payrollSourceState.payroll, payrollSourceState.payroll.value, grossSalaryDetails, "当前期间工资表逐人应发工资合计；来源与两表核对通过后供客户单独确认"),
        payrollRow("personalSocialSecurity", "个人社保", payrollSourceState.socialSecurity, payrollSourceState.socialSecurity.amounts.personalSocial, personalSocialDetails, "当前期间社保表逐人个人承担社保合计"),
        payrollRow("employerSocialSecurity", "企业社保", payrollSourceState.socialSecurity, payrollSourceState.socialSecurity.amounts.employerSocial, employerSocialDetails, "当前期间社保表逐人企业承担社保合计"),
        payrollRow("socialSecurity", "社保合计", payrollSourceState.socialSecurity, payrollSourceState.socialSecurity.value, socialSecurityDetails, "当前期间个人社保 + 企业社保；来源与两表核对通过后供客户单独确认"),
        payrollRow("individualIncomeTax", "代扣个税", payrollSourceState.payroll, payrollSourceState.payroll.amounts.individualIncomeTax, individualIncomeTaxDetails, "当前期间工资表逐人个税合计"),
        payrollRow("netSalary", "实发工资", payrollSourceState.payroll, payrollSourceState.payroll.amounts.netSalary, netSalaryDetails, "当前期间工资表逐人实发工资合计"),
        makeTraceableRow("taxTotal", "预计税费合计", estimatedTax, taxEstimateDetails, "增值税估算 + 附加税费估算 + 所得税估算"),
      ],
    },
  };
  return localizeReportSnapshot(report, workspace);
}

export function freezeReportVersion(workspace, actor = "本地用户") {
  const current = ensureWorkspace(workspace);
  const payrollAccounting = buildPayrollAccountingSummary(current);
  if (payrollAccounting.applicable && !payrollAccounting.postedAndMatched) throw new AccountingRuleError("PAYROLL_CLOSE_BLOCKED", payrollAccounting.message, payrollAccounting);
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
  "inventoryItems",
  "inventoryMovements",
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

function financialVoucherSource(voucher) {
  // Export history remains on the voucher, but does not change its accounting or evidence.
  const { attachmentPackages: _attachmentPackages, updatedAt: _updatedAt, ...source } = voucher;
  return source;
}

function workflowSourceMatches(fingerprint, workspace) {
  if (!fingerprint) return false;
  try {
    const stored = JSON.parse(fingerprint);
    if (Array.isArray(stored.sources?.vouchers)) {
      stored.sources.vouchers = stored.sources.vouchers.map(financialVoucherSource);
    }
    return JSON.stringify(stored) === workflowSourceFingerprint(workspace);
  } catch {
    return false;
  }
}

function workflowSourceValue(workspace, key) {
  if (key === "modules") {
    const { inventory, ...modules } = workspace.modules || {};
    return inventory ? { ...modules, inventory: true } : modules;
  }
  if (["inventoryItems", "inventoryMovements"].includes(key) && !workspaceModuleEnabled(workspace, "inventory")) return [];
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
  if (key === "vouchers") return (workspace.vouchers || []).map(financialVoucherSource);
  return workspace[key] || (["company", "modules", "openingLedger", "rules"].includes(key) ? {} : []);
}

export function workflowSourceFingerprint(workspace) {
  const tax = workspace.tax || {};
  const managementReport = (workspace.managementReport?.displayItems || [])
    .filter((item) => item?.visible === false || String(item?.label || "").trim())
    .map((item) => ({ id: item.id, visible: item.visible !== false, label: String(item.label || "").trim() }));
  return JSON.stringify({
    currentPeriod: workspace.currentPeriod,
    sources: Object.fromEntries(WORKFLOW_SOURCE_KEYS.map((key) => [key, workflowSourceValue(workspace, key)])),
    ...(managementReport.length ? { managementReport } : {}),
    tax: {
      adjustments: Number(tax.adjustments || 0),
      payroll: Number(tax.payroll || 0),
      socialSecurity: Number(tax.socialSecurity || 0),
      vatRate: Number(tax.vatRate ?? 0.03),
      surtaxRate: Number(tax.surtaxRate ?? 0.12),
      incomeTaxRate: Number(tax.incomeTaxRate ?? 0.05),
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
  const payrollSources = buildPayrollSourceState(current);
  const summary = payrollSources.summary;
  const latestVersion = getLatestReportVersion(current);
  const sourceIsCurrent = payrollVersionHasCurrentSources(current, latestVersion, payrollSources) && (latestVersion?.sourceFingerprint
    ? workflowSourceMatches(latestVersion.sourceFingerprint, current)
    : Boolean(latestVersion)
      && current.tax?.frozenAt === latestVersion.createdAt
      && comparableSnapshot(latestVersion.snapshot) === comparableSnapshot(buildReportSnapshot(current)));
  const version = sourceIsCurrent ? latestVersion : null;
  const payrollConfirmed = Boolean(
    version
    && payrollSources.payroll.available
    && current.tax.payrollConfirmedAt
    && current.tax.payrollConfirmedVersionId === version.id
    && current.tax.payrollConfirmedFingerprint === summary.fingerprints.payroll
  );
  const socialSecurityConfirmed = Boolean(
    version
    && payrollSources.socialSecurity.available
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
      ...payrollSourceMetric(payrollSources.payroll),
      confirmed: payrollConfirmed,
      confirmedAt: payrollConfirmed ? current.tax.payrollConfirmedAt : null,
    },
    socialSecurity: {
      ...payrollSourceMetric(payrollSources.socialSecurity),
      confirmed: socialSecurityConfirmed,
      confirmedAt: socialSecurityConfirmed ? current.tax.socialSecurityConfirmedAt : null,
    },
  };
}

function payrollVersionHasCurrentSources(workspace, version, sources = buildPayrollSourceState(workspace)) {
  if (!workspaceModuleEnabled(workspace, "payroll")) return true;
  const workpaper = version?.snapshot?.taxWorkpaper;
  if (workpaper?.payrollSourceState) return workpaper.payrollSourceState.fingerprint === sources.fingerprint;
  // Keep a genuine earlier freeze valid; legacy tax parameters without payroll evidence are not current sources.
  if (!sources.payroll.available || !sources.socialSecurity.available || !workpaper?.payrollSocialSummary) return false;
  const saved = workpaper.payrollSocialSummary;
  const rows = Object.fromEntries((workpaper.rows || []).map((row) => [row.id, row]));
  return saved.fingerprints?.payroll === sources.summary.fingerprints.payroll
    && saved.fingerprints?.socialSecurity === sources.summary.fingerprints.socialSecurity
    && rows.payroll?.value === sources.payroll.value && rows.socialSecurity?.value === sources.socialSecurity.value;
}

export function confirmPayrollSocialData(workspace, input = {}, context = {}) {
  const current = ensureWorkspace(workspace);
  const section = input.section;
  if (!["payroll", "socialSecurity"].includes(section)) throw new Error("请选择工资表或社保表确认项");
  const confirmed = input.confirmed !== false;
  const payrollAccounting = buildPayrollAccountingSummary(current);
  if (confirmed && payrollAccounting.applicable && !payrollAccounting.postedAndMatched) throw new AccountingRuleError("PAYROLL_CLOSE_BLOCKED", payrollAccounting.message, payrollAccounting);
  const state = getPayrollSocialConfirmationState(current);
  const sectionState = state[section];
  if (confirmed && !state.version) throw new Error("请先按当前工资社保数据重新冻结报表版本");
  if (confirmed && !sectionState.available) throw new Error(sectionState.sourceMessage);
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
    confirmed ? `${workspaceTerminology(current).customer}确认${sectionLabel}` : `撤销${sectionLabel}确认`,
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
  const terminology = workspaceTerminology(workspace);
  const taxEnabled = workspaceModuleEnabled(workspace, "tax");
  const payrollEnabled = workspaceModuleEnabled(workspace, "payroll");
  const snapshot = buildReportSnapshot(workspace);
  const statementsBalanced = Object.values(snapshot.summary.engineChecks || {}).every((check) => check.passed);
  const currentTransactions = workspace.transactions.filter((item) => String(item.date || "").startsWith(workspace.currentPeriod));
  const unresolved = currentTransactions.filter((item) => !["posted", "ignored"].includes(item.status));
  const openExceptionTasks = (workspace.exceptionTasks || []).filter((task) => task.status !== "resolved");
  const payrollAccounting = buildPayrollAccountingSummary(workspace);
  const payrollAccountingIssues = payrollAccounting.applicable && !payrollAccounting.postedAndMatched ? payrollAccounting.issues : [];
  const openNotices = (workspace.delivery.notices || []).filter((notice) => (
    notice.period === workspace.currentPeriod && notice.status !== "resolved"
  ));
  const bankReconciliationSummary = buildBankAccountReconciliationSummary(workspace, {
    period: workspace.currentPeriod,
  });
  const openBankReconciliationTasks = openExceptionTasks.filter((task) => (
    task.sourceType === "bankReconciliation"
    && (!task.period || task.period === workspace.currentPeriod)
  ));
  const bankStageComplete = workspace.stages?.s3?.status === "complete";
  const isBankAccount = (accountId) => String(accountId || "").split(":")[0] === "bank"
    || (String(accountId || "").split(":")[0] !== "cash" && accountDefinition(accountId, workspace).cash);
  const hasBankData = Boolean(
    workspace.bankAccounts?.length || workspace.accounts?.length || workspace.transactions?.length || workspace.bankImports?.length
    || Object.entries(workspace.openingLedger || {}).some(([accountId, balance]) => Number(balance) !== 0 && isBankAccount(accountId))
    || (workspace.vouchers || []).some((voucher) => (voucher.lines || []).some((line) =>
      (Number(line.debit || 0) !== 0 || Number(line.credit || 0) !== 0) && isBankAccount(line.account)))
  );
  const bankReconciliationApplicable = workspaceModuleEnabled(workspace, "reconcile") || hasBankData || openBankReconciliationTasks.length > 0;
  const bankReconciliationPassed = !bankReconciliationApplicable || (bankReconciliationSummary.passed
    && openBankReconciliationTasks.length === 0
    && bankStageComplete);
  const incompleteBankAccounts = bankReconciliationSummary.accounts.filter((account) => !account.passed);
  let bankReconciliationDetail = `${bankReconciliationSummary.completedCount} 个账户已完成本期月度勾稽`;
  if (!bankReconciliationApplicable) {
    bankReconciliationDetail = "未启用流水核销，且无银行数据";
  } else if (incompleteBankAccounts.length) {
    bankReconciliationDetail = incompleteBankAccounts
      .map((account) => `${account.accountName}：${account.message}`)
      .join("；");
  } else if (!bankReconciliationSummary.accountCount) {
    bankReconciliationDetail = "本期没有可完成月度勾稽的银行账户";
  } else if (openBankReconciliationTasks.length) {
    bankReconciliationDetail = `${openBankReconciliationTasks.length} 项本期月度勾稽异常仍待处理`;
  } else if (!bankStageComplete) {
    bankReconciliationDetail = "月度余额已勾稽，但银行勾稽阶段仍有事项待复核";
  }
  const bankReconciliationIssues = bankReconciliationPassed ? [] : [{
    sourceType: "bankMonthlyReconciliation",
    period: workspace.currentPeriod,
    message: bankReconciliationDetail,
    incompleteAccountIds: incompleteBankAccounts.map((account) => account.accountId),
    exceptionTaskIds: openBankReconciliationTasks.map((task) => task.id),
  }];
  const pendingVouchers = (workspace.vouchers || []).filter((voucher) => (
    (voucher.period || String(voucher.date || "").slice(0, 7)) === workspace.currentPeriod && !["posted", "superseded", "invalidated", "replaced"].includes(voucher.status)
  ));
  const latestVersion = getLatestReportVersion(workspace);
  const sourceIsCurrent = payrollVersionHasCurrentSources(workspace, latestVersion) && (latestVersion?.sourceFingerprint
    ? workflowSourceMatches(latestVersion.sourceFingerprint, workspace)
    : Boolean(latestVersion)
      && workspace.tax?.frozenAt === latestVersion.createdAt
      && comparableSnapshot(latestVersion.snapshot) === comparableSnapshot(snapshot));
  const version = sourceIsCurrent ? latestVersion : null;
  const filing = workspace.delivery.filing;
  const initialConfirmation = (workspace.confirmations || []).find((item) => item.id === filing.initialConfirmationId);
  const initialConfirmationCurrent = customerConfirmationMatchesVersion(initialConfirmation, version)
    && Object.keys(buildCustomerConfirmationSections(version.snapshot, { payrollEnabled })).every((id) => initialConfirmation.sections?.[id]?.status === "approved");
  const finalConfirmation = (workspace.confirmations || []).find((item) => item.id === workspace.tax.finalConfirmationId);
  const finalConfirmationCurrent = Boolean(version
    && finalConfirmation?.kind === "final"
    && finalConfirmation.status === "approved"
    && finalConfirmation.snapshot
    && finalConfirmation.reportVersionId === version.id
    && finalConfirmation.reportSourceFingerprint === (version.sourceFingerprint || null)
    && finalConfirmation.filingDraftVersionId === filing.draftVersionId
    && finalConfirmation.filingDraftCreatedAt === filing.draftCreatedAt);
  const payrollSocialConfirmation = payrollEnabled ? getPayrollSocialConfirmationState(workspace) : null;
  const payrollChecks = payrollEnabled ? [
    { id: "payroll", label: `${terminology.customer}已单独确认工资表`, ok: Boolean(version && payrollSocialConfirmation.payroll.confirmed), page: "tax", detail: payrollSocialConfirmation.payroll.available ? (payrollSocialConfirmation.payroll.confirmed ? "工资表已绑定当前冻结版本" : `工资表待${terminology.customer}勾选确认`) : payrollSocialConfirmation.payroll.sourceMessage },
    { id: "socialSecurity", label: `${terminology.customer}已单独确认社保表`, ok: Boolean(version && payrollSocialConfirmation.socialSecurity.confirmed), page: "tax", detail: payrollSocialConfirmation.socialSecurity.available ? (payrollSocialConfirmation.socialSecurity.confirmed ? "社保表已绑定当前冻结版本" : `社保表待${terminology.customer}勾选确认`) : payrollSocialConfirmation.socialSecurity.sourceMessage },
  ] : [];
  const pendingLabels = {
    balanced: "核对报表勾稽",
    bank: "核对银行流水",
    exceptions: "处理待复核事项",
    vouchers: "完成凭证入账",
    frozen: "冻结本期报表",
    finance: "完成首次确认",
    payroll: "确认工资表",
    socialSecurity: "确认社保表",
    owner: "完成最终确认",
    vatReconciliation: "解释增值税差异",
    exported: "导出本地申报包",
    receipt: "导入外部办理回执",
  };
  const checks = [
    { id: "balanced", label: "试算、资产负债与现金变动勾稽通过", ok: statementsBalanced, page: "reports", detail: statementsBalanced ? "三项校验通过" : "至少一项校验存在差异" },
    { id: "bank", label: bankReconciliationApplicable ? "本期银行流水余额勾稽通过" : "银行勾稽不适用", applicable: bankReconciliationApplicable, ok: bankReconciliationPassed, page: "setup", detail: bankReconciliationDetail },
    { id: "exceptions", label: "流水、异常、工资与跨期事项已完成复核", ok: unresolved.length === 0 && openExceptionTasks.length === 0 && openNotices.length === 0 && payrollAccountingIssues.length === 0, page: payrollAccountingIssues.length ? "tax" : openNotices.length ? "overview" : "reconcile", detail: payrollAccountingIssues.length ? payrollAccounting.message : unresolved.length || openExceptionTasks.length || openNotices.length ? `${unresolved.length} 笔流水、${openExceptionTasks.length} 项异常、${openNotices.length} 项跨期待办未完成` : "已完成" },
    { id: "vouchers", label: "本期凭证已全部复核入账", ok: pendingVouchers.length === 0, page: "reconcile", detail: pendingVouchers.length ? `${pendingVouchers.length} 张草稿或更正待处理` : "已完成" },
    { id: "frozen", label: "本期当前数据已有冻结版本", ok: Boolean(version), page: "reports", detail: latestVersion && !version ? "上游数据已变化，请重新冻结" : undefined },
    { id: "finance", label: `${terminology.customer}已完成首次财务确认`, ok: Boolean(initialConfirmationCurrent && workspace.tax.financeConfirmedAt && workspace.tax.financeConfirmedVersionId === version.id), page: "tax" },
    ...payrollChecks,
    { id: "owner", label: `${terminology.customer}已完成最终责任确认`, ok: Boolean(finalConfirmationCurrent && workspace.tax.ownerConfirmedAt && workspace.tax.ownerConfirmedVersionId === version.id && filing.finalConfirmedVersionId === version.id), page: "tax" },
    { id: "vatReconciliation", label: "增值税差异均已解释", ok: !snapshot.taxWorkpaper.vatReconciliation.hasUnexplainedDifferences, page: "tax", detail: snapshot.taxWorkpaper.vatReconciliation.hasUnexplainedDifferences ? snapshot.taxWorkpaper.vatReconciliation.unresolvedItems.map((item) => `${item.label}（差额 ${item.differenceBeforeAdjustment.toFixed(2)}）`).join("、") : "两项差异均已核对" },
    { id: "exported", label: "本地申报包已导出", ok: Boolean(version && filing.exportedAt && filing.exportedPackage?.reportVersionId === version.id), page: "tax" },
    { id: "receipt", label: "外部办理回执已本地导入", ok: Boolean(version
      && filing.receipt?.reportVersionId === version.id
      && filing.receipt?.packageId === filing.exportedPackage?.id
      && filing.receipt?.packageHash === filing.exportedPackage?.hash), page: "archive" },
  ].map((check) => check.ok ? check : { ...check, label: pendingLabels[check.id] });
  const archiveChecks = taxEnabled
    ? checks
    : checks.filter((check) => !["finance", "payroll", "socialSecurity", "owner", "vatReconciliation", "exported", "receipt"].includes(check.id));
  const prepareCheckIds = new Set(["balanced", "bank", "exceptions", "vouchers", "frozen", "finance", "payroll", "socialSecurity"]);
  const exportCheckIds = new Set([...prepareCheckIds, "owner", "vatReconciliation"]);
  return {
    checks,
    prepare: checks.filter((check) => prepareCheckIds.has(check.id)),
    export: checks.filter((check) => exportCheckIds.has(check.id)),
    archive: archiveChecks,
    snapshot,
    unresolved,
    openExceptionTasks,
    payrollAccounting,
    payrollAccountingIssues,
    openNotices,
    bankReconciliationSummary,
    bankReconciliationApplicable,
    openBankReconciliationTasks,
    bankReconciliationPassed,
    bankReconciliationIssues,
    pendingVouchers,
    latestVersion,
    version,
  };
}

export function recordInitialConfirmationSection(workspace, { reportVersionId, section, decision, note, isMajor, responsibleName, confirmationName }, context = {}) {
  if (!note?.trim()) throw new Error("每一项确认都必须填写说明");
  if (!isMajor && !confirmationName?.trim()) throw new Error("普通确认或异议必须填写本次确认人真实姓名");
  if (isMajor && !responsibleName?.trim()) throw new Error("重大事项必须填写本项负责人签字姓名");
  const current = ensureWorkspace(workspace);
  const terminology = workspaceTerminology(current);
  const actorName = context.actor || "本地用户";
  const at = context.at || new Date().toISOString();
  const decisionActor = isMajor ? responsibleName.trim() : confirmationName.trim();
  const flow = workflowChecks(current);
  const missingPrerequisites = flow.checks.slice(0, 5).filter((item) => !item.ok);
  if (!flow.version || flow.version.id !== reportVersionId) throw new Error("当前报表版本已变化，请按页面更新后的冻结数字重新确认");
  if (missingPrerequisites.length) throw new Error(`首次确认前仍需完成：${missingPrerequisites.map((item) => item.label).join("、")}`);

  let next = current;
  let confirmation = [...(next.confirmations || [])].reverse().find((item) => (
    customerConfirmationMatchesVersion(item, flow.version)
    && item.status !== "disputed"
  ));
  if (!confirmation) {
    next = createCustomerConfirmationPackage(
      next,
      { period: next.currentPeriod, reportVersionId: flow.version.id },
      { actor: actorName, at },
    );
    confirmation = next.confirmations.at(-1);
  }
  if (confirmation.sections?.[section]?.status !== "pending") throw new Error("本项已保存，不能重复覆盖原确认记录");

  next = recordCustomerConfirmation(next, {
    confirmationId: confirmation.id,
    section,
    decision,
    note: isMajor ? `重大事项：${note.trim()}` : note.trim(),
  }, { actor: decisionActor, at });
  if (workspaceModuleEnabled(next, "payroll") && decision === "approve" && ["payroll", "socialSecurity"].includes(section)) {
    next = confirmPayrollSocialData(next, { section, confirmed: true }, { actor: actorName, at });
  }

  const savedConfirmation = next.confirmations.find((item) => item.id === confirmation.id);
  const allApproved = Object.values(savedConfirmation.sections).every((item) => item.status === "approved");
  const resetFiling = {
    ...next.delivery.filing,
    period: next.currentPeriod,
    draftCreatedAt: null,
    draftVersionId: null,
    initialConfirmationId: confirmation.id,
    finalConfirmedVersionId: null,
    exportedAt: null,
    exportedPackage: null,
    receipt: null,
    archivedAt: null,
  };
  if (decision === "reject") {
    return audit({
      ...next,
      tax: {
        ...next.tax,
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
      delivery: { ...next.delivery, filing: resetFiling },
    }, `${terminology.customer}异议退回 S7`, `${section}：${note.trim()}`, actorName);
  }

  const withResetDownstream = {
    ...next,
    tax: { ...next.tax, ownerConfirmedAt: null, ownerConfirmedVersionId: null, confirmedBy: "" },
    delivery: { ...next.delivery, filing: resetFiling },
  };
  if (!allApproved) return withResetDownstream;
  return audit({
    ...withResetDownstream,
    tax: {
      ...withResetDownstream.tax,
      financeConfirmedAt: savedConfirmation.updatedAt || at,
      financeConfirmedVersionId: flow.version.id,
    },
  }, `${terminology.customer}第一次确认完成`, workspaceModuleEnabled(next, "payroll") ? "收入、成本费用、应交税额、进项税、工资、社保、财务报表与待核实事项均已逐项确认" : "收入、成本费用、应交税额、进项税、财务报表与待核实事项均已逐项确认", actorName);
}

export function buildFinalConfirmationSnapshot(workspace, existingFlow = workflowChecks(workspace)) {
  const version = existingFlow.version;
  const report = version?.snapshot || existingFlow.snapshot;
  const confirmationSections = buildCustomerConfirmationSections(report, { payrollEnabled: workspaceModuleEnabled(workspace, "payroll") });
  const payrollEnabled = Boolean(confirmationSections.payroll);
  const taxRows = Object.fromEntries((report.taxWorkpaper?.rows || []).map((row) => [row.id, row]));
  const balanceRows = Object.fromEntries((report.sections?.balance?.rows || []).map((row) => [row.id, row]));
  const incomeRows = Object.fromEntries((report.sections?.income?.rows || []).map((row) => [row.id, row]));
  const cashFlowRows = Object.fromEntries((report.sections?.cashflow?.rows || []).map((row) => [row.id, row]));
  const numberValue = (value) => Number(value || 0);
  const frozenMetric = (label, row, fallback) => ({
    label,
    value: numberValue(row?.value ?? fallback),
    basis: row?.formula || "来自当前冻结报表",
    sourceIds: [...new Set([...(row?.sourceIds || []), ...(row?.details || []).flatMap((detail) => [...(detail.sourceIds || []), detail.voucherId, detail.documentId])].filter(Boolean))],
  });
  const taxes = {
    vat: frozenMetric("应交增值税", taxRows.vatPayable),
    surtax: frozenMetric("附加税费", taxRows.surtax),
    incomeTax: frozenMetric("所得税", taxRows.incomeTax),
    ...(payrollEnabled ? { individualIncomeTax: { ...frozenMetric("代扣个税", taxRows.individualIncomeTax), value: taxRows.individualIncomeTax?.value ?? null, sourceStatus: taxRows.individualIncomeTax?.sourceStatus, sourceMessage: taxRows.individualIncomeTax?.sourceMessage } } : {}),
    total: frozenMetric("预计申报税费合计", taxRows.taxTotal, report.summary?.estimatedTax),
  };
  const unresolvedItems = confirmationSections.openItems.items;
  const vatRisks = report.taxWorkpaper?.vatReconciliation?.unresolvedItems || [];
  const deductionAmount = numberValue(taxes.total.value) + (payrollEnabled ? numberValue(taxes.individualIncomeTax?.value) : 0);
  return {
    period: workspace.currentPeriod,
    reportVersionId: version?.id || null,
    reportVersionLabel: version?.label || null,
    reportSourceFingerprint: version?.sourceFingerprint || null,
    confirmationSections: Object.fromEntries(Object.entries(confirmationSections).map(([id, { status: _status, ...section }]) => [id, section])),
    filingDraftVersionId: workspace.delivery.filing.draftVersionId || null,
    filingDraftCreatedAt: workspace.delivery.filing.draftCreatedAt || null,
    taxes,
    statements: {
      balance: {
        label: "资产负债表",
        metrics: [
          frozenMetric("资产", balanceRows.assets, report.summary?.assets),
          frozenMetric("负债", balanceRows.liabilities, report.summary?.liabilities),
          frozenMetric("所有者权益", balanceRows.equity, report.summary?.equity),
        ],
      },
      income: {
        label: "利润表",
        metrics: [
          frozenMetric("收入", incomeRows.revenue, report.summary?.revenue),
          { label: "成本", value: numberValue(report.summary?.cost), sourceIds: report.confirmationContext?.costSourceIds || [] },
          frozenMetric("期间费用", incomeRows.expenses, report.summary?.expenses),
          frozenMetric("利润", incomeRows.profit, report.summary?.profit),
        ],
      },
      cashflow: {
        label: "现金流量表",
        metrics: [
          frozenMetric("经营活动净额", cashFlowRows.operating),
          frozenMetric("现金净增加额", cashFlowRows.netCash),
          frozenMetric("期末现金", cashFlowRows.closingCash, report.summary?.cashBalance),
        ],
      },
    },
    payrollSocial: payrollEnabled ? {
      applicable: true,
      payroll: taxRows.payroll?.value ?? null,
      socialSecurity: taxRows.socialSecurity?.value ?? null,
      total: taxRows.payroll?.value == null || taxRows.socialSecurity?.value == null ? null : numberValue(taxRows.payroll.value) + numberValue(taxRows.socialSecurity.value),
      payrollSourceStatus: confirmationSections.payroll.sourceStatus,
      socialSecuritySourceStatus: confirmationSections.socialSecurity.sourceStatus,
      sourceIds: [...new Set([...confirmationSections.payroll.sourceIds, ...confirmationSections.socialSecurity.sourceIds])],
    } : { applicable: false },
    deduction: {
      required: deductionAmount > 0,
      amount: deductionAmount,
      sourceIds: [...new Set([...taxes.total.sourceIds, ...(taxes.individualIncomeTax?.sourceIds || [])])],
    },
    risks: [
      { id: "local-only", level: "warning", label: "尚未提交税务局", detail: "本页只记录确认并生成本地申报包，仍需在外部完成正式申报。" },
      { id: "calculation-basis", level: "warning", label: "本地计算口径", detail: report.taxWorkpaper?.disclaimer || "税额来自当前冻结底稿，不是税务局回执。" },
      ...vatRisks.map((item) => ({ id: `vat-${item.kind || item.id}`, level: "danger", label: item.label || "增值税差异", detail: `仍有 ${formatCurrency(item.differenceAfterAdjustment ?? item.differenceBeforeAdjustment, { sign: true })} 差异待解释` })),
      ...(unresolvedItems.length ? [{ id: "open-items", level: "danger", label: "仍有未处理事项", detail: `${unresolvedItems.length} 项业务、凭证或勾稽事项尚未完成` }] : []),
    ],
    unresolvedItems,
  };
}

export function recordFinalConfirmation(workspace, { reportVersionId, filingDraftCreatedAt, name, selections }, context = {}) {
  if (!name?.trim()) throw new Error("请填写最终负责人姓名");
  if (!selections?.numbersReviewed || !selections?.risksAcknowledged || !selections?.localOnlyAcknowledged) throw new Error("请完成三项最终确认声明");
  if (!["authorize_external", "do_not_authorize"].includes(selections?.deductionAuthorization)) throw new Error("请选择是否授权外部扣款");
  const current = ensureWorkspace(workspace);
  const terminology = workspaceTerminology(current);
  const actorName = context.actor || "本地用户";
  const now = context.at || new Date().toISOString();
  const flow = workflowChecks(current);
  const requiredSections = Object.keys(buildCustomerConfirmationSections(flow.version?.snapshot || flow.snapshot, { payrollEnabled: workspaceModuleEnabled(current, "payroll") }));
  const prepareChecks = flow.prepare;
  const versionId = flow.version?.id;
  if (versionId !== reportVersionId || current.delivery.filing.draftCreatedAt !== filingDraftCreatedAt) throw new Error("页面显示的冻结版本或底稿已变化，请按更新后的数字重新确认");
  const initialConfirmation = (current.confirmations || []).find((item) => item.id === current.delivery.filing.initialConfirmationId);
  const initialConfirmationComplete = Boolean(
    customerConfirmationMatchesVersion(initialConfirmation, flow.version)
    && requiredSections.every((section) => initialConfirmation.sections?.[section]?.status === "approved"),
  );
  if (!versionId || current.delivery.filing.draftVersionId !== versionId || !current.delivery.filing.draftCreatedAt) throw new Error("当前底稿与报表版本不一致，请重新生成");
  if (!initialConfirmationComplete || !prepareChecks.every((item) => item.ok)) throw new Error(`第一次${terminology.customer}确认或前置复核已失效，请重新完成`);

  const snapshot = buildFinalConfirmationSnapshot(current, flow);
  const finalRecord = {
    id: uid("final-confirmation"),
    kind: "final",
    period: current.currentPeriod,
    version: (current.confirmations || []).filter((item) => item.kind === "final" && item.period === current.currentPeriod).length + 1,
    status: "approved",
    createdAt: now,
    confirmedAt: now,
    confirmedBy: name.trim(),
    reportVersionId: versionId,
    reportSourceFingerprint: flow.version.sourceFingerprint || null,
    filingDraftVersionId: current.delivery.filing.draftVersionId,
    filingDraftCreatedAt: current.delivery.filing.draftCreatedAt,
    selections: {
      numbersReviewed: true,
      risksAcknowledged: true,
      localOnlyAcknowledged: true,
      deductionAuthorization: selections.deductionAuthorization,
    },
    signature: { name: name.trim(), signedAt: now },
    snapshot,
    decisions: [{ id: uid("decision"), decision: "approve", actor: name.trim(), at: now, note: "最终数字、风险、本地包边界和外部扣款选择已逐项确认" }],
    sourceIds: [versionId, current.delivery.filing.initialConfirmationId].filter(Boolean),
  };
  const next = {
    ...current,
    confirmations: [...(current.confirmations || []), finalRecord],
    tax: {
      ...current.tax,
      ownerConfirmedAt: now,
      confirmedBy: name.trim(),
      ownerConfirmedVersionId: versionId,
      finalConfirmationId: finalRecord.id,
    },
    delivery: {
      ...current.delivery,
      filing: {
        ...current.delivery.filing,
        finalConfirmedVersionId: versionId,
        exportedAt: null,
        exportedPackage: null,
        receipt: null,
        archivedAt: null,
      },
    },
  };
  const deductionLabel = selections.deductionAuthorization === "authorize_external" ? "授权外部办理扣款" : "不授权外部扣款";
  return audit(next, `${terminology.customer}第二次最终确认`, `${name.trim()}确认 ${versionId} 当前数字与风险；${deductionLabel}；仅保存本地记录，未提交税务局、未执行扣款`, actorName);
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
  const terminology = workspaceTerminology(workspace);
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
    `请由${terminology.customer}或财务人员通过电子税务局/本地安全执行器完成外部办理，再把真实回执导回本工作台。`,
  ].join("\n"));
  folder.file("报表快照.json", JSON.stringify(flow.version.snapshot, null, 2));
  folder.file("税务申报底稿.json", JSON.stringify({
    workspace: workspace.name,
    company: workspace.company,
    period: workspace.currentPeriod,
    reportVersionId: flow.version.id,
    reportSourceFingerprint: flow.version.sourceFingerprint,
    workpaper: flow.version.snapshot.taxWorkpaper,
    disclaimer: "本地底稿，不是电子税务局正式申报文件。",
  }, null, 2));
  folder.file(`${terminology.customer}确认记录.json`, JSON.stringify({
    reportVersionId: flow.version.id,
    reportSourceFingerprint: flow.version.sourceFingerprint,
    initialConfirmation: (workspace.confirmations || []).find((item) => item.id === workspace.delivery.filing.initialConfirmationId),
    finalConfirmation: (workspace.confirmations || []).find((item) => item.id === workspace.tax.finalConfirmationId),
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
  if (flow.version.snapshot.confirmationContext?.payrollEnabled ?? workspaceModuleEnabled(workspace, "payroll")) folder.file("工资与社保明细.json", JSON.stringify({
    ...flow.version.snapshot.taxWorkpaper.payrollSocialSummary,
    reportVersionId: flow.version.id,
    reportSourceFingerprint: flow.version.sourceFingerprint,
    confirmations: {
      payrollConfirmedAt: workspace.tax.payrollConfirmedAt,
      socialSecurityConfirmedAt: workspace.tax.socialSecurityConfirmedAt,
      confirmedBy: workspace.tax.confirmedBy,
    },
    disclaimer: "当前浏览器本地导入与确认记录；不代表已连接社保、个税或税务平台。",
  }, null, 2));
  const periodVouchers = (workspace.vouchers || []).filter((voucher) => (voucher.period || String(voucher.date || "").slice(0, 7)) === workspace.currentPeriod && ["posted", "superseded", "invalidated", "replaced"].includes(voucher.status));
  folder.file("凭证与附件索引.json", JSON.stringify(periodVouchers.map((voucher) => ({
    voucher,
    attachmentPackage: buildAttachmentPackage(workspace, voucher.id),
  })), null, 2));
  folder.file("资料清单.json", JSON.stringify((workspace.documents || []).filter((document) => !document.period || document.period === workspace.currentPeriod), null, 2));
  folder.file("银行勾稽记录.json", JSON.stringify((workspace.bankImports || []).filter((bankImport) => bankImport.period === workspace.currentPeriod), null, 2));
  folder.file("异常与确认记录.json", JSON.stringify({
    exceptions: workspace.exceptionTasks || [],
    reportVersionId: flow.version.id,
    confirmations: (workspace.confirmations || []).filter((confirmation) => [workspace.delivery.filing.initialConfirmationId, workspace.tax.finalConfirmationId].includes(confirmation.id)),
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
  // Detach archived data from live records before later exports or edits.
  const record = structuredClone({
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
    closingLedger: flow.version.snapshot.ledger,
    openingCarryForward: workspace.openingCarryForward || null,
    summary: flow.version.snapshot.summary,
    reportSnapshot: flow.version.snapshot,
    vouchers: (workspace.vouchers || []).filter((voucher) => (voucher.period || String(voucher.date || "").slice(0, 7)) === workspace.currentPeriod && ["posted", "superseded", "invalidated", "replaced"].includes(voucher.status)),
    attachmentPackages: (workspace.vouchers || []).filter((voucher) => (voucher.period || String(voucher.date || "").slice(0, 7)) === workspace.currentPeriod && ["posted", "superseded", "invalidated", "replaced"].includes(voucher.status)).map((voucher) => buildAttachmentPackage(workspace, voucher.id)),
    documents: (workspace.documents || []).filter((document) => !document.period || document.period === workspace.currentPeriod),
    confirmationPackages: (workspace.confirmations || []).filter((confirmation) => confirmation.period === workspace.currentPeriod),
    exceptionRecords: (workspace.exceptionTasks || []).filter((task) => task.status === "resolved" || flow.unresolved.some((item) => item.id === task.sourceId)),
    auditSnapshot: workspace.auditLog || [],
  });
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

export function buildArchivedPeriodExport(workspace, archiveId, exportedAt = new Date().toISOString()) {
  if (!workspace || typeof workspace !== "object") throw new Error("工作台不存在");
  const archive = (workspace.delivery?.archives || []).find((item) => item.id === archiveId);
  if (!archive) throw new Error("归档记录不存在");
  return {
    product: "FinanceDesk",
    schemaVersion: PRODUCT_STATE_VERSION,
    localOnly: true,
    indexedDbFilesIncluded: false,
    workspace: {
      id: workspace.id,
      name: workspace.name,
      legalName: workspace.company?.legalName || "",
    },
    exportedAt,
    archive: JSON.parse(JSON.stringify(archive)),
  };
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
    surtaxRate: Number(tax.surtaxRate ?? 0.12),
    incomeTaxRate: Number(tax.incomeTaxRate ?? 0.05),
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

export function enterNextPeriod(workspace, actor = "本地用户", { equityAccountId = null } = {}) {
  const filing = workspace.delivery.filing;
  const archive = workspace.delivery.archives.find((item) => item.period === workspace.currentPeriod);
  if (!filing.archivedAt || !archive) return workspace;
  if (archive.sourceFingerprint && !workflowSourceMatches(archive.sourceFingerprint, workspace)) {
    throw new Error("本期归档后数据又发生变化，不能沿用旧期末余额；请通过更正流程重新归档");
  }
  const target = nextPeriod(workspace.currentPeriod);
  const carryForward = buildPeriodCarryForward(workspace, { closingLedger: archive.closingLedger || {}, equityAccountId });
  const bankAccounts = (workspace.bankAccounts || []).map((account) => {
    const monthly = buildBankMonthlyReconciliation(workspace, { accountId: account.id, period: archive.period });
    const openingBalance = monthly.passed ? monthly.statementClosing : null;
    return {
      ...account,
      openingBalance,
      statementClosing: null,
      balancePeriod: target,
      balanceCarryForwards: {
        ...(account.balanceCarryForwards || {}),
        [target]: {
          accountId: account.id,
          period: target,
          fromPeriod: archive.period,
          archiveId: archive.id,
          verified: monthly.passed,
          openingBalance,
          sourceImportIds: monthly.imports.map((record) => record.id),
          sourceDocumentIds: [...new Set(monthly.imports.map((record) => record.sourceDocumentId).filter(Boolean))],
          sourceBalanceReview: monthly.balanceReviewedAt,
          sourceBalanceReviewer: monthly.balanceReviewedBy,
          sourceReconciliation: {
            openingBalance: monthly.openingBalance,
            income: monthly.income,
            expense: monthly.expense,
            statementClosing: monthly.statementClosing,
            difference: monthly.difference,
            passed: monthly.passed,
          },
        },
      },
    };
  });
  const next = {
    ...workspace,
    currentPeriod: target,
    periods: [...new Set([target, ...workspace.periods])],
    bankAccounts,
    accounts: bankAccounts,
    openingLedger: carryForward.openingLedger,
    openingCarryForward: {
      archiveId: archive.id,
      fromPeriod: archive.period,
      period: target,
      profit: carryForward.profit,
      equityAccountId: carryForward.equityAccountId,
      profitAndLossBalances: carryForward.profitAndLossBalances,
    },
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
  return audit(next, "进入下一期", `${workspace.currentPeriod} → ${target}，继承归档 ${archive.id} 的期末余额；损益 ${carryForward.profit.toFixed(2)}${carryForward.equityAccountId ? ` 转入 ${accountDefinition(carryForward.equityAccountId, workspace).label}` : "，无需权益调整"}`, actor);
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
