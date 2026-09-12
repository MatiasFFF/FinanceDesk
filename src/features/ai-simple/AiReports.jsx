import { useMemo } from "react";
import { buildFinancialStatements } from "../../domain/accounting/reporting.js";

const money = (value) => Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const checkNames = { trialBalance: "试算平衡", balanceSheet: "资产负债平衡", cashMovement: "现金余额", cashFlowClassification: "现金流用途", settlementLedger: "往来账款", inventoryIntegrity: "库存凭证", memberService: "业务履约" };

function ReportTable({ title, rows }) {
  return <section className="ai-report-section"><h3>{title}</h3><table><thead><tr><th scope="col">项目</th><th scope="col">金额（元）</th></tr></thead><tbody>{rows.map(([label, amount], index) => <tr key={`${label}-${index}`}><th scope="row">{label}</th><td>{money(amount?.value ?? amount)}</td></tr>)}</tbody></table></section>;
}

export default function AiReports({ workspace, onVouchers }) {
  const reports = useMemo(() => buildFinancialStatements(workspace), [workspace]);
  const { incomeStatement: income, balanceSheet: balance, cashFlow: cash } = reports;
  const pending = (workspace.vouchers || []).filter((voucher) => voucher.period === workspace.currentPeriod && ["draft", "changes_requested"].includes(voucher.status)).length;
  const failures = Object.entries(reports.checks).filter(([, check]) => check.applicable !== false && !check.passed);
  return <div className="ai-reports">
    <p className="ai-helper">{workspace.currentPeriod} · 按期初余额与已入账凭证计算{pending ? `，另有 ${pending} 张凭证待复核。` : "。"}<button className="ai-inline-button" type="button" onClick={onVouchers}>查看凭证</button></p>
    {!!failures.length && <div className="ai-notice" role="status">待核对：{failures.map(([key]) => checkNames[key] || "报表关系").join("、")}。当前金额可供核对，尚未完成本期确认。</div>}
    <ReportTable title="利润表" rows={[["营业收入", income.grossRevenue], ["销售退回", income.salesReturns], ["净收入", income.netRevenue], ["营业成本", income.cost], ["毛利润", income.grossProfit], ["期间费用", income.expenses], ["本期利润", income.profit]]} />
    <ReportTable title="资产负债表" rows={[["资产合计", balance.assets], ["负债合计", balance.liabilities], ["所有者权益", balance.equity], ["其中：本期利润", balance.currentProfit], ["平衡差额", balance.difference]]} />
    <ReportTable title="现金流量表" rows={[["经营活动现金净额", cash.operating], ["投资活动现金净额", cash.investing], ["筹资活动现金净额", cash.financing], ["用途待确认", cash.pending], ["现金净变动", cash.netChange], ["期初现金", cash.openingCash], ["期末现金", cash.closingCash]]} />
    <details className="ai-report-detail"><summary>查看报表科目明细</summary>{Object.entries({ ...income.lines, ...balance.lines }).map(([key, lines]) => lines?.length ? <ReportTable key={key} title={{ revenue: "收入", salesReturns: "退回", cost: "成本", expenses: "费用", assets: "资产", liabilities: "负债", equity: "权益" }[key]} rows={lines.map((line) => [line.name || line.label || line.account?.name || "科目", line.value])} /> : null)}</details>
  </div>;
}
