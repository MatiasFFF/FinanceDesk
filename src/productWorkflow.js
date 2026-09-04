import {
  accountDefinition,
  buildAttachmentPackage,
  buildFinancialStatements,
  buildManagementMetrics,
  buildTaxWorkpaper,
} from "./domain/accounting/index.js";
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
  { id: "overview", label: "月结总览", shortLabel: "总览" },
  { id: "members", label: "会员台账", shortLabel: "会员" },
  { id: "reconcile", label: "批量核销", shortLabel: "核销" },
  { id: "reports", label: "报表中心", shortLabel: "报表" },
  { id: "tax", label: "确认与申报", shortLabel: "确认" },
  { id: "archive", label: "资料归档", shortLabel: "归档" },
  { id: "setup", label: "基础资料", shortLabel: "基础" },
];

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
    periods: [...new Set([period, ...safeArray(workspace.periods)])],
    accounts: safeArray(workspace.accounts),
    members: safeArray(workspace.members),
    businessEvents: safeArray(workspace.businessEvents),
    bills: safeArray(workspace.bills),
    transactions: safeArray(workspace.transactions),
    documents: safeArray(workspace.documents),
    vouchers: safeArray(workspace.vouchers),
    auditLog: safeArray(workspace.auditLog),
    tax: {
      period,
      adjustments: 0,
      payroll: 0,
      socialSecurity: 0,
      note: "",
      frozenAt: null,
      financeConfirmedAt: null,
      payrollConfirmedAt: null,
      ownerConfirmedAt: null,
      confirmedBy: "",
      financeConfirmedVersionId: null,
      payrollConfirmedVersionId: null,
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

export function audit(workspace, action, detail, actor = "周会计") {
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

export function buildReportSnapshot(workspace) {
  const statements = calculatePeriodLedger(workspace);
  const engine = statements.engine;
  const management = buildManagementMetrics(workspace, { period: workspace.currentPeriod });
  const managementById = Object.fromEntries(management.metrics.map((metric) => [metric.id, metric]));
  const engineTax = buildTaxWorkpaper(workspace, { period: workspace.currentPeriod });
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
  const estimatedOutputVat = engineTax.outputVat.value;
  const estimatedVat = engineTax.vatPayable.value;
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
  const taxEstimateDetails = [
    formulaDetail("estimated-vat", "增值税估算", estimatedVat, `销项估算减进项税额，税率 ${(Number(workspace.tax.vatRate ?? 0.03) * 100).toFixed(2)}%`),
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
          makeRow("privateRevenue", "私教课收入", -amountForAccount(statements.ledger, "revenuePrivate"), accountRows(workspace, ["revenuePrivate"])),
          makeRow("groupRevenue", "团课收入", -amountForAccount(statements.ledger, "revenueGroup"), accountRows(workspace, ["revenueGroup"])),
          makeTraceableRow("revenue", "营业收入", statements.revenue, revenueDetails, "收入类发生额 − 销售退回与折让"),
          makeRow("rent", "房租费用", amountForAccount(statements.ledger, "expenseRent"), accountRows(workspace, ["expenseRent"])),
          makeRow("utility", "水电费用", amountForAccount(statements.ledger, "expenseUtility"), accountRows(workspace, ["expenseUtility"])),
          makeRow("fees", "手续费", amountForAccount(statements.ledger, "expenseFee"), accountRows(workspace, ["expenseFee"])),
          makeRow("commission", "教练提成", amountForAccount(statements.ledger, "expenseCommission"), accountRows(workspace, ["expenseCommission"])),
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
          makeTraceableRow("ownerPrepaid", "会员预收 / 未履约服务", contractLiability, contractLiabilityDetails, "合同负债科目期末贷方余额"),
          makeTraceableRow("ownerReceivable", "应收账款", receivable, receivableDetails, "应收账款科目期末借方余额"),
          makeTraceableRow("ownerPayable", "供应商应付", payable, payableDetails, "应付账款科目期末贷方余额"),
          makeTraceableRow("ownerPrepayment", "供应商预付", prepayment, prepaymentDetails, "预付款项科目期末借方余额"),
          makeRow("ownerRefund", "待处理退款", refunds.reduce((sum, item) => sum + Number(item.amount || 0), 0), refunds.map((item) => ({ id: item.id, date: item.date, title: item.memberName, reference: "会员退款", description: item.note, amount: item.amount }))),
          makeRow("ownerCommission", "教练提成", commissions.reduce((sum, item) => sum + Number(item.amount || 0), 0), commissions.map((item) => ({ id: item.id, date: item.date, title: item.coach || item.memberName, reference: "提成", description: item.note, amount: item.amount }))),
          makeTraceableRow("ownerTax", "预计税款（演示估算）", estimatedTax, taxEstimateDetails, "增值税估算 + 附加税费估算 + 所得税估算"),
          makeTraceableRow("ownerGap", "未来现金缺口", cashGapValue, cashGapDetails, "max(0，应付与预计税费 − 可用现金)"),
        ],
      },
    },
    taxWorkpaper: {
      disclaimer: "本地演示估算口径，不是正式申报结果；税务局连接将在后续阶段提供。",
      rows: [
        makeTraceableRow("taxRevenue", "账面营业收入", statements.revenue, revenueDetails, "收入类发生额 − 销售退回与折让"),
        makeTraceableRow("taxAdjustments", "增值税计税基础调整", engineTax.adjustments.value, [], "客户或财务人员在本地底稿中录入"),
        makeTraceableRow("taxBase", "增值税估算计税基础", engineTax.taxableBase.value, revenueDetails, "max(0，账面营业收入 + 增值税计税基础调整)"),
        makeTraceableRow("vat", "销项税额估算", estimatedOutputVat, [formulaDetail("output-vat", "销项税额估算", estimatedOutputVat, "计税基础 × 本地配置税率")], "计税基础 × 本地配置税率"),
        makeTraceableRow("inputVat", "进项税额", engineTax.inputVat.value, ledgerDetails(workspace, engine, (item) => String(item.accountId).startsWith("taxInput"), (amount) => amount), "进项税额科目借方净发生额"),
        makeTraceableRow("vatPayable", "应交增值税", engineTax.vatPayable.value, taxEstimateDetails.slice(0, 1), "max(0，销项税额估算 − 进项税额)"),
        makeTraceableRow("surtax", "附加税费估算", estimatedSurtax, taxEstimateDetails.slice(1, 2), "增值税估算额 × 12%"),
        makeTraceableRow("incomeTax", "所得税估算", estimatedIncomeTax, taxEstimateDetails.slice(2, 3), "max(0，本月利润) × 5%"),
        makeTraceableRow("payroll", "工资薪金", Number(workspace.tax.payroll || 0), [], "财务人员在本地底稿中单独录入并由客户确认"),
        makeTraceableRow("socialSecurity", "社保数据", Number(workspace.tax.socialSecurity || 0), [], "财务人员在本地底稿中单独录入并由客户确认"),
        makeTraceableRow("taxTotal", "预计税费合计", estimatedTax, taxEstimateDetails, "增值税估算 + 附加税费估算 + 所得税估算"),
      ],
    },
  };
}

export function freezeReportVersion(workspace, actor = "周会计") {
  const snapshot = buildReportSnapshot(workspace);
  const periodVersions = workspace.delivery.reportVersions.filter((item) => item.period === workspace.currentPeriod);
  const version = {
    id: uid("report-version"),
    period: workspace.currentPeriod,
    label: `V${periodVersions.length + 1}`,
    createdAt: new Date().toISOString(),
    actor,
    frozen: true,
    snapshot,
    sourceFingerprint: workflowSourceFingerprint(workspace),
  };
  const next = {
    ...workspace,
    tax: {
      ...workspace.tax,
      frozenAt: version.createdAt,
      financeConfirmedAt: null,
      payrollConfirmedAt: null,
      ownerConfirmedAt: null,
      confirmedBy: "",
      financeConfirmedVersionId: null,
      payrollConfirmedVersionId: null,
      ownerConfirmedVersionId: null,
    },
    delivery: {
      ...workspace.delivery,
      reportVersions: [version, ...workspace.delivery.reportVersions],
      filing: emptyFiling(workspace.currentPeriod),
    },
  };
  return audit(next, "冻结报表版本", `${workspace.currentPeriod} ${version.label}，差异 ${snapshot.summary.difference.toFixed(2)}`, actor);
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
  "accounts",
  "bankAccounts",
  "transactions",
  "businessEvents",
  "bills",
  "documents",
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
        relatedObjectIds: document.relatedObjectIds || [],
      }));
  }
  return workspace[key] || (key === "company" || key === "openingLedger" || key === "rules" ? {} : []);
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
    },
  });
}

function comparableSnapshot(snapshot) {
  if (!snapshot) return "";
  const { generatedAt: _generatedAt, ...stable } = snapshot;
  return JSON.stringify(stable);
}

export function workflowChecks(workspace) {
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
  const checks = [
    { id: "balanced", label: "试算、资产负债与现金变动勾稽通过", ok: statementsBalanced, page: "reports", detail: statementsBalanced ? "三项校验通过" : "至少一项校验存在差异" },
    { id: "bank", label: "本期银行流水余额勾稽通过", ok: bankReconciliationIssues.length === 0, page: "setup", detail: bankReconciliationIssues.length ? `${bankReconciliationIssues.length} 份银行流水有差异或错误行` : "已完成" },
    { id: "exceptions", label: "流水、异常与跨期事项已完成复核", ok: unresolved.length === 0 && openExceptionTasks.length === 0 && openNotices.length === 0, page: openNotices.length ? "overview" : "reconcile", detail: unresolved.length || openExceptionTasks.length || openNotices.length ? `${unresolved.length} 笔流水、${openExceptionTasks.length} 项异常、${openNotices.length} 项跨期待办未完成` : "已完成" },
    { id: "vouchers", label: "本期凭证已全部复核入账", ok: pendingVouchers.length === 0, page: "reconcile", detail: pendingVouchers.length ? `${pendingVouchers.length} 张草稿或更正待处理` : "已完成" },
    { id: "frozen", label: "本期当前数据已有冻结版本", ok: Boolean(version), page: "reports", detail: latestVersion && !version ? "上游数据已变化，请重新冻结" : undefined },
    { id: "finance", label: "客户已完成首次财务确认", ok: Boolean(version && workspace.tax.financeConfirmedAt && workspace.tax.financeConfirmedVersionId === version.id), page: "tax" },
    { id: "payroll", label: "工资与社保数据已确认", ok: Boolean(version && workspace.tax.payrollConfirmedAt && workspace.tax.payrollConfirmedVersionId === version.id), page: "tax" },
    { id: "owner", label: "客户已完成最终责任确认", ok: Boolean(version && workspace.tax.ownerConfirmedAt && workspace.tax.ownerConfirmedVersionId === version.id && filing.finalConfirmedVersionId === version.id), page: "tax" },
    { id: "exported", label: "本地申报包已导出", ok: Boolean(version && filing.exportedAt && filing.exportedPackage?.reportVersionId === version.id), page: "tax" },
    { id: "receipt", label: "外部办理回执已本地导入", ok: Boolean(version
      && filing.receipt?.reportVersionId === version.id
      && filing.receipt?.packageId === filing.exportedPackage?.id
      && filing.receipt?.packageHash === filing.exportedPackage?.hash), page: "archive" },
  ];
  return {
    checks,
    prepare: checks.slice(0, 7),
    export: checks.slice(0, 8),
    archive: checks,
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

export function prepareFilingDraft(workspace, actor = "周会计") {
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
    throw new Error("提交前校验尚未全部通过");
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
    ownerConfirmedAt: workspace.tax.ownerConfirmedAt,
    confirmedBy: workspace.tax.confirmedBy,
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

export function attachReceipt(workspace, receipt, actor = "周会计") {
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

export function markPackageExported(workspace, packageMeta, actor = "周会计") {
  const next = {
    ...workspace,
    delivery: {
      ...workspace.delivery,
      filing: {
        ...workspace.delivery.filing,
        exportedAt: packageMeta.exportedAt,
        exportedPackage: packageMeta,
        receipt: null,
        archivedAt: null,
      },
    },
  };
  return audit(next, "导出本地申报包", `${packageMeta.fileName} · 未连接税务局`, actor);
}

export function archivePeriod(workspace, actor = "周会计") {
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
      ownerConfirmedAt: workspace.tax.ownerConfirmedAt,
      confirmedBy: workspace.tax.confirmedBy,
      financeConfirmedVersionId: workspace.tax.financeConfirmedVersionId,
      payrollConfirmedVersionId: workspace.tax.payrollConfirmedVersionId,
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
    note: "",
    frozenAt: null,
    financeConfirmedAt: null,
    payrollConfirmedAt: null,
    ownerConfirmedAt: null,
    confirmedBy: "",
    financeConfirmedVersionId: null,
    payrollConfirmedVersionId: null,
    ownerConfirmedVersionId: null,
  };
}

export function enterNextPeriod(workspace, actor = "周会计") {
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
