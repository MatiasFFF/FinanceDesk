import { buildFinancialStatements } from "../../domain/accounting/reporting.js";
import { collectSourceIds, roundMoney, sumMoney } from "../../domain/accounting/model.js";
import { isPeriodArchived, openingBalancesReady } from "../../domain/periods.js";

export const AI_REPORT_BASIS = "按本期期初余额与已入账凭证计算；草稿、退回修订、已取消及其他账期凭证不计入金额。";
export const AI_REPORT_COPY_STATUS = "本期核对稿（非冻结确认版本）";
export const aiReportMoney = (value) => Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const checkLabels = {
  trialBalance: "凭证借贷不平", balanceSheet: "资产负债不平", cashMovement: "现金余额不一致",
  cashFlowClassification: "现金流用途待确认", settlementLedger: "往来账款待核对",
  inventoryIntegrity: "库存凭证待核对", memberService: "业务履约待核对",
};
const checkNames = { trialBalance: "凭证借贷", balanceSheet: "资产负债平衡", cashMovement: "现金余额", cashFlowClassification: "现金流用途", settlementLedger: "往来账款", inventoryIntegrity: "库存凭证", memberService: "业务履约" };
const openingReference = (period, accountId) => `opening:${period}:${accountId}`;

// The same model feeds the visible tables and the exported working copy.
// Financial amounts and classifications always come from the shared accounting domain.
export function buildAiReportModel(workspace) {
  const reports = buildFinancialStatements(workspace);
  const { ledger, incomeStatement: income, balanceSheet: balance, cashFlow: cash } = reports;
  const period = reports.period;
  const postedIds = new Set(ledger.vouchers);
  const posted = (workspace.vouchers || []).filter((voucher) => postedIds.has(voucher.id));
  const voucherIndex = new Map(posted.map((voucher) => [voucher.id, voucher]));
  const pending = (workspace.vouchers || []).filter((voucher) =>
    (voucher.date?.slice(0, 7) || voucher.period) === period && ["draft", "changes_requested"].includes(voucher.status));
  const accounts = new Map(ledger.accounts.map((account) => [account.accountId, account]));
  const accountGroups = (groups) => groups.flatMap(([label, lines]) => lines.map((line) => {
    const account = accounts.get(line.id);
    return { ...line, group: label, account, entries: account.entries.map((entry) => ({
      ...entry, evidenceIds: collectSourceIds(voucherIndex.get(entry.voucherId)?.evidenceIds),
    })) };
  }));
  const incomeDetails = accountGroups([["收入", income.lines.revenue], ["销售退回", income.lines.salesReturns], ["成本", income.lines.cost], ["费用", income.lines.expenses]]);
  const balanceDetails = accountGroups([["资产", balance.lines.assets], ["负债", balance.lines.liabilities], ["权益", balance.lines.equity]]);
  const metric = (id, label, item, { total = false, warning = false, openingAccounts = [] } = {}) => ({
    id, label, value: item.value, total, warning,
    sourceIds: collectSourceIds(item.sourceIds, openingAccounts.filter((account) => account.opening !== 0).map((account) => openingReference(period, account.accountId))),
    voucherIds: collectSourceIds(item.voucherIds, item.sourceIds).filter((sourceId) => postedIds.has(sourceId)),
  });
  const assets = ledger.accounts.filter((account) => account.account.category === "asset");
  const liabilities = ledger.accounts.filter((account) => account.account.category === "liability");
  const equity = ledger.accounts.filter((account) => account.account.category === "equity");
  const cashAccounts = ledger.accounts.filter((account) => account.account.cash);
  const cashGroups = [["operating", "经营活动"], ["investing", "投资活动"], ["financing", "筹资活动"], ["pending", "用途待确认"]]
    .map(([id, label]) => ({ id, label, value: cash[id].value, entries: cash[id].rows }));
  const sections = [
    { id: "income", title: "利润表", details: incomeDetails, rows: [
      metric("grossRevenue", "营业收入", income.grossRevenue), metric("salesReturns", "销售退回", income.salesReturns),
      metric("netRevenue", "净收入", income.netRevenue), metric("cost", "营业成本", income.cost),
      metric("grossProfit", "毛利润", income.grossProfit), metric("expenses", "期间费用", income.expenses),
      metric("profit", "本期利润", income.profit, { total: true }),
    ] },
    { id: "balance", title: "资产负债表", details: balanceDetails, rows: [
      metric("assets", "资产合计", balance.assets, { total: true, openingAccounts: assets }),
      metric("liabilities", "负债合计", balance.liabilities, { total: true, openingAccounts: liabilities }),
      metric("equity", "所有者权益", balance.equity, { total: true, openingAccounts: equity }),
      metric("currentProfit", "其中：本期利润", balance.currentProfit),
      metric("difference", "平衡差额", balance.difference, { warning: !balance.balanced, openingAccounts: [...assets, ...liabilities, ...equity] }),
    ] },
    { id: "cashflow", title: "现金流量表", cashGroups, details: [], rows: [
      metric("operating", "经营活动现金净额", cash.operating), metric("investing", "投资活动现金净额", cash.investing),
      metric("financing", "筹资活动现金净额", cash.financing), metric("pending", "用途待确认", cash.pending, { warning: !cash.classificationComplete }),
      metric("netChange", "现金净变动", cash.netChange, { total: true }),
      metric("openingCash", "期初现金", cash.openingCash, { openingAccounts: cashAccounts }),
      metric("closingCash", "期末现金", cash.closingCash, { total: true, openingAccounts: cashAccounts }),
    ] },
  ];
  const openingDifference = sumMoney(ledger.accounts.map((account) => account.opening));
  const notes = [];
  if (pending.length) notes.push({ id: "pendingVouchers", title: `${pending.length} 张凭证待入账`,
    detail: "这些凭证尚未计入报表，复核入账后金额会更新。", voucherIds: pending.map((voucher) => voucher.id) });
  if (!openingBalancesReady(workspace)) notes.push({ id: "opening", title: "期初余额待确认",
    detail: workspace.openingStatus?.status === "conflict" ? "期初余额与结转来源存在冲突，当前保留的余额仍用于计算，请在原版报表中心核对。" : "当前期初余额尚未确认，资产负债和现金余额可能不完整，请在原版报表中心核对。", voucherIds: [] });
  const checkResults = Object.entries(reports.checks).filter(([, check]) => check.applicable !== false).map(([id, check]) => {
    let detail = check.detail || check.message || "";
    if (id === "trialBalance") detail = `本期已入账凭证借方 ${aiReportMoney(ledger.totals.debit)} 元，贷方 ${aiReportMoney(ledger.totals.credit)} 元，差额 ${aiReportMoney(check.difference)} 元。`;
    if (id === "balanceSheet") detail = `资产减去负债与权益，差额 ${aiReportMoney(check.difference)} 元。${Math.abs(openingDifference) > 0.01 ? `期初借贷差额为 ${aiReportMoney(openingDifference)} 元。` : "请核对本期凭证及科目归类。"}`;
    if (id === "cashMovement") detail = `现金总账与现金流量表期末余额相差 ${aiReportMoney(check.difference)} 元，请核对现金科目及凭证。`;
    if (id === "cashFlowClassification") detail = `${cash.pending.rows.length} 笔现金流尚未明确用途，净额 ${aiReportMoney(cash.pending.value)} 元；已计入现金净变动，尚未分配至经营、投资或筹资活动。`;
    if (check.passed) detail = "当前已入账数据的此项报表关系核对通过。";
    return { id, label: checkNames[id] || "报表关系", title: checkLabels[id] || "报表关系待核对", passed: check.passed, difference: roundMoney(check.difference), detail,
      sourceIds: collectSourceIds(check.sourceIds), voucherIds: collectSourceIds(check.sourceIds).filter((sourceId) => postedIds.has(sourceId)) };
  });
  notes.push(...checkResults.filter((check) => !check.passed));
  return {
    workspaceId: workspace.id, workspaceName: workspace.name || workspace.legalName || "财务工作台", period,
    basis: AI_REPORT_BASIS, copyStatus: AI_REPORT_COPY_STATUS, archived: isPeriodArchived(workspace),
    postedCount: posted.length, pendingCount: pending.length, pending: pending.map((voucher) => ({ id: voucher.id, no: voucher.no, date: voucher.date, summary: voucher.summary, status: voucher.status })),
    hasOpeningBalances: ledger.accounts.some((account) => account.opening !== 0),
    sections, notes, checkResults,
    sources: ledger.accounts.flatMap((account) => [
      ...(account.opening !== 0 ? [{ type: "opening", sourceId: openingReference(period, account.accountId), accountId: account.accountId, accountLabel: account.account.label, opening: account.opening, date: `${period}-01`, sourceIds: [] }] : []),
      ...account.entries.map((entry) => ({ ...entry, type: "voucher", accountId: account.accountId, accountLabel: account.account.label,
        sourceIds: collectSourceIds(entry.sourceIds), evidenceIds: collectSourceIds(voucherIndex.get(entry.voucherId)?.evidenceIds) })),
    ]),
  };
}
