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
  { id: "reconcile", label: "批量核销", shortLabel: "核销" },
  { id: "reports", label: "报表中心", shortLabel: "报表" },
  { id: "tax", label: "确认与申报", shortLabel: "确认" },
  { id: "archive", label: "资料归档", shortLabel: "归档" },
];

const emptyFiling = (period) => ({
  period,
  draftCreatedAt: null,
  draftVersionId: null,
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
      .filter((line) => accountNames.includes(line.account))
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
  const ledger = { ...(workspace.openingLedger || {}) };
  Object.keys(ACCOUNT_LABELS).forEach((account) => {
    if (ledger[account] == null) ledger[account] = 0;
  });

  workspace.vouchers
    .filter((voucher) => voucher.status === "posted" && String(voucher.date || "").startsWith(workspace.currentPeriod))
    .forEach((voucher) => voucher.lines.forEach((line) => {
      ledger[line.account] = roundMoney(
        Number(ledger[line.account] || 0) + Number(line.debit || 0) - Number(line.credit || 0),
      );
    }));

  const revenue = roundMoney(-(amountForAccount(ledger, "revenuePrivate") + amountForAccount(ledger, "revenueGroup")));
  const expenses = roundMoney([
    "expenseRent",
    "expenseUtility",
    "expenseFee",
    "expenseCommission",
    "expenseOther",
  ].reduce((sum, account) => sum + amountForAccount(ledger, account), 0));
  const profit = roundMoney(revenue - expenses);
  const assets = roundMoney([
    "bank",
    "cash",
    "receivable",
    "prepayment",
    "equipment",
  ].reduce((sum, account) => sum + amountForAccount(ledger, account), 0));
  const liabilities = roundMoney(-(amountForAccount(ledger, "payable") + amountForAccount(ledger, "contractLiability")));
  const equity = roundMoney(-amountForAccount(ledger, "equity") + profit);
  return {
    ledger,
    revenue,
    expenses,
    profit,
    assets,
    liabilities,
    equity,
    difference: roundMoney(assets - liabilities - equity),
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

export function buildReportSnapshot(workspace) {
  const statements = calculatePeriodLedger(workspace);
  const periodTransactions = workspace.transactions.filter((item) => String(item.date || "").startsWith(workspace.currentPeriod));
  const inflows = periodTransactions.filter((item) => Number(item.amount) > 0);
  const outflows = periodTransactions.filter((item) => Number(item.amount) < 0);
  const cashIn = roundMoney(inflows.reduce((sum, item) => sum + Number(item.amount || 0), 0));
  const cashOut = roundMoney(outflows.reduce((sum, item) => sum + Math.abs(Number(item.amount || 0)), 0));
  const receivable = billOutstanding(workspace, "receivable");
  const payable = billOutstanding(workspace, "payable");
  const prepayment = billOutstanding(workspace, "prepaymentPaid");
  const contractLiability = roundMoney(Math.max(0, -amountForAccount(statements.ledger, "contractLiability")));
  const refunds = workspace.businessEvents.filter((item) => item.type === "refund" && String(item.date || "").startsWith(workspace.currentPeriod));
  const commissions = workspace.businessEvents.filter((item) => item.type === "commission" && String(item.date || "").startsWith(workspace.currentPeriod));
  const estimatedVat = roundMoney(Math.max(0, statements.revenue + Number(workspace.tax.adjustments || 0)) * 0.03);
  const estimatedSurtax = roundMoney(estimatedVat * 0.12);
  const estimatedIncomeTax = roundMoney(Math.max(0, statements.profit) * 0.05);
  const estimatedTax = roundMoney(estimatedVat + estimatedSurtax + estimatedIncomeTax);
  const cashBalance = roundMoney(amountForAccount(statements.ledger, "bank") + amountForAccount(statements.ledger, "cash"));

  return {
    period: workspace.currentPeriod,
    generatedAt: new Date().toISOString(),
    ledger: statements.ledger,
    summary: {
      revenue: statements.revenue,
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
    },
    sections: {
      balance: {
        label: "资产负债表",
        rows: [
          makeRow("cash", "货币资金", cashBalance, accountRows(workspace, ["bank", "cash"])),
          makeRow("receivable", "应收账款", amountForAccount(statements.ledger, "receivable"), detailsFromBills(workspace, "receivable")),
          makeRow("prepayment", "预付款项", amountForAccount(statements.ledger, "prepayment"), detailsFromBills(workspace, "prepaymentPaid")),
          makeRow("equipment", "固定资产", amountForAccount(statements.ledger, "equipment"), accountRows(workspace, ["equipment"])),
          makeRow("assets", "资产合计", statements.assets),
          makeRow("payable", "应付账款", -amountForAccount(statements.ledger, "payable"), detailsFromBills(workspace, "payable")),
          makeRow("contractLiability", "合同负债", contractLiability, detailsFromBills(workspace, "depositReceived")),
          makeRow("liabilities", "负债合计", statements.liabilities),
          makeRow("equity", "所有者权益", statements.equity),
          makeRow("liabilitiesEquity", "负债和所有者权益合计", statements.liabilities + statements.equity),
        ],
      },
      income: {
        label: "利润表",
        rows: [
          makeRow("privateRevenue", "私教课收入", -amountForAccount(statements.ledger, "revenuePrivate"), accountRows(workspace, ["revenuePrivate"])),
          makeRow("groupRevenue", "团课收入", -amountForAccount(statements.ledger, "revenueGroup"), accountRows(workspace, ["revenueGroup"])),
          makeRow("revenue", "营业收入", statements.revenue),
          makeRow("rent", "房租费用", amountForAccount(statements.ledger, "expenseRent"), accountRows(workspace, ["expenseRent"])),
          makeRow("utility", "水电费用", amountForAccount(statements.ledger, "expenseUtility"), accountRows(workspace, ["expenseUtility"])),
          makeRow("fees", "手续费", amountForAccount(statements.ledger, "expenseFee"), accountRows(workspace, ["expenseFee"])),
          makeRow("commission", "教练提成", amountForAccount(statements.ledger, "expenseCommission"), accountRows(workspace, ["expenseCommission"])),
          makeRow("expenses", "期间费用", statements.expenses),
          makeRow("profit", "本月利润", statements.profit),
        ],
      },
      cashflow: {
        label: "现金流量表",
        rows: [
          makeRow("cashIn", "经营活动现金流入", cashIn, detailsFromTransactions(inflows)),
          makeRow("cashOut", "经营活动现金流出", cashOut, detailsFromTransactions(outflows)),
          makeRow("netCash", "现金净增加额", cashIn - cashOut, detailsFromTransactions(periodTransactions)),
          makeRow("closingCash", "期末现金余额", cashBalance, accountRows(workspace, ["bank", "cash"])),
        ],
      },
      owner: {
        label: "老板报表",
        rows: [
          makeRow("ownerCash", "现金余额", cashBalance, accountRows(workspace, ["bank", "cash"])),
          makeRow("ownerCashIn", "本月收款", cashIn, detailsFromTransactions(inflows)),
          makeRow("ownerRevenue", "本月收入", statements.revenue, accountRows(workspace, ["revenuePrivate", "revenueGroup"])),
          makeRow("ownerProfit", "本月利润", statements.profit),
          makeRow("ownerPrepaid", "会员预收 / 未履约服务", contractLiability, detailsFromBills(workspace, "depositReceived")),
          makeRow("ownerReceivable", "应收账款", receivable, detailsFromBills(workspace, "receivable")),
          makeRow("ownerPayable", "供应商应付", payable, detailsFromBills(workspace, "payable")),
          makeRow("ownerPrepayment", "供应商预付", prepayment, detailsFromBills(workspace, "prepaymentPaid")),
          makeRow("ownerRefund", "待处理退款", refunds.reduce((sum, item) => sum + Number(item.amount || 0), 0), refunds.map((item) => ({ id: item.id, date: item.date, title: item.memberName, reference: "会员退款", description: item.note, amount: item.amount }))),
          makeRow("ownerCommission", "教练提成", commissions.reduce((sum, item) => sum + Number(item.amount || 0), 0), commissions.map((item) => ({ id: item.id, date: item.date, title: item.memberName, reference: "提成", description: item.note, amount: item.amount }))),
          makeRow("ownerTax", "预计税款（演示估算）", estimatedTax),
          makeRow("ownerGap", "未来现金缺口", Math.max(0, payable + estimatedTax - cashBalance)),
        ],
      },
    },
    taxWorkpaper: {
      disclaimer: "本地演示估算口径，不是正式申报结果；税务局连接将在后续阶段提供。",
      rows: [
        makeRow("taxRevenue", "账面营业收入", statements.revenue),
        makeRow("taxAdjustments", "税会调整", Number(workspace.tax.adjustments || 0)),
        makeRow("taxBase", "增值税估算计税基础", Math.max(0, statements.revenue + Number(workspace.tax.adjustments || 0))),
        makeRow("vat", "增值税估算", estimatedVat),
        makeRow("surtax", "附加税费估算", estimatedSurtax),
        makeRow("incomeTax", "所得税估算", estimatedIncomeTax),
        makeRow("payroll", "工资薪金", Number(workspace.tax.payroll || 0)),
        makeRow("socialSecurity", "社保数据", Number(workspace.tax.socialSecurity || 0)),
        makeRow("taxTotal", "预计税费合计", estimatedTax),
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
  };
  const next = {
    ...workspace,
    tax: { ...workspace.tax, frozenAt: version.createdAt },
    delivery: {
      ...workspace.delivery,
      reportVersions: [version, ...workspace.delivery.reportVersions],
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

export function workflowChecks(workspace) {
  const snapshot = buildReportSnapshot(workspace);
  const currentTransactions = workspace.transactions.filter((item) => String(item.date || "").startsWith(workspace.currentPeriod));
  const unresolved = currentTransactions.filter((item) => item.status !== "reconciled");
  const version = getLatestReportVersion(workspace);
  const filing = workspace.delivery.filing;
  const checks = [
    { id: "balanced", label: "三表勾稽差异为 0", ok: Math.abs(snapshot.summary.difference) < 0.01, page: "reports" },
    { id: "exceptions", label: "流水与异常事项已完成复核", ok: unresolved.length === 0, page: "reconcile", detail: unresolved.length ? `${unresolved.length} 笔未完成` : "已完成" },
    { id: "frozen", label: "本期报表版本已冻结", ok: Boolean(version), page: "reports" },
    { id: "finance", label: "客户已完成首次财务确认", ok: Boolean(workspace.tax.financeConfirmedAt), page: "tax" },
    { id: "payroll", label: "工资与社保数据已确认", ok: Boolean(workspace.tax.payrollConfirmedAt), page: "tax" },
    { id: "owner", label: "客户已完成最终责任确认", ok: Boolean(workspace.tax.ownerConfirmedAt), page: "tax" },
    { id: "exported", label: "本地申报包已导出", ok: Boolean(filing.exportedAt), page: "tax" },
    { id: "receipt", label: "外部办理回执已本地导入", ok: Boolean(filing.receipt), page: "archive" },
  ];
  return {
    checks,
    prepare: checks.slice(0, 5),
    export: checks.slice(0, 6),
    archive: checks,
    snapshot,
    unresolved,
    version,
  };
}

export function prepareFilingDraft(workspace, actor = "周会计") {
  const flow = workflowChecks(workspace);
  const ready = flow.prepare.every((item) => item.ok);
  if (!ready || !flow.version) return workspace;
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
  folder.file("操作日志.csv", auditCsv(workspace));
  const blob = await zip.generateAsync({ type: "blob" });
  const fileName = `${PRODUCT_NAME}-${workspace.name}-${workspace.currentPeriod}-本地申报包.zip`;
  downloadBlob(blob, fileName);
  return { fileName, size: blob.size, exportedAt: new Date().toISOString(), reportVersionId: flow.version.id };
}

export async function importLocalReceipt(file) {
  const buffer = await file.arrayBuffer();
  const digest = await window.crypto.subtle.digest("SHA-256", buffer);
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
  const next = {
    ...workspace,
    delivery: {
      ...workspace.delivery,
      filing: {
        ...workspace.delivery.filing,
        receipt,
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
      },
    },
  };
  return audit(next, "导出本地申报包", `${packageMeta.fileName} · 未连接税务局`, actor);
}

export function archivePeriod(workspace, actor = "周会计") {
  const flow = workflowChecks(workspace);
  if (!flow.archive.every((item) => item.ok) || !flow.version) return workspace;
  const archivedAt = new Date().toISOString();
  const record = {
    id: uid("archive"),
    period: workspace.currentPeriod,
    archivedAt,
    reportVersionId: flow.version.id,
    reportVersionLabel: flow.version.label,
    package: workspace.delivery.filing.exportedPackage,
    receipt: workspace.delivery.filing.receipt,
    confirmations: {
      financeConfirmedAt: workspace.tax.financeConfirmedAt,
      payrollConfirmedAt: workspace.tax.payrollConfirmedAt,
      ownerConfirmedAt: workspace.tax.ownerConfirmedAt,
      confirmedBy: workspace.tax.confirmedBy,
    },
    unresolvedIds: flow.unresolved.map((item) => item.id),
    closingLedger: flow.snapshot.ledger,
    summary: flow.snapshot.summary,
  };
  const next = {
    ...workspace,
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

export function enterNextPeriod(workspace, actor = "周会计") {
  const filing = workspace.delivery.filing;
  const archive = workspace.delivery.archives.find((item) => item.period === workspace.currentPeriod);
  if (!filing.archivedAt || !archive) return workspace;
  const target = nextPeriod(workspace.currentPeriod);
  const ledger = archive.closingLedger || {};
  const openingLedger = {
    bank: amountForAccount(ledger, "bank"),
    cash: amountForAccount(ledger, "cash"),
    receivable: amountForAccount(ledger, "receivable"),
    prepayment: amountForAccount(ledger, "prepayment"),
    equipment: amountForAccount(ledger, "equipment"),
    payable: amountForAccount(ledger, "payable"),
    contractLiability: amountForAccount(ledger, "contractLiability"),
    equity: -Number(archive.summary?.equity || 0),
    revenuePrivate: 0,
    revenueGroup: 0,
    expenseRent: 0,
    expenseUtility: 0,
    expenseFee: 0,
    expenseCommission: 0,
    expenseOther: 0,
  };
  const next = {
    ...workspace,
    currentPeriod: target,
    periods: [...new Set([target, ...workspace.periods])],
    openingLedger,
    tax: {
      ...workspace.tax,
      period: target,
      adjustments: 0,
      note: "",
      frozenAt: null,
      financeConfirmedAt: null,
      payrollConfirmedAt: null,
      ownerConfirmedAt: null,
      confirmedBy: "",
    },
    delivery: {
      ...workspace.delivery,
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
