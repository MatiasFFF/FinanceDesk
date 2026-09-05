import { roundMoney, collectSourceIds } from "./model.js";
import { buildPayrollSocialEvidence } from "../../features/intake/documentIntake.js";

// Tax parameters are retained as editable inputs, but cannot establish current-period payroll evidence.
export function buildPayrollSourceState(workspace, { period = workspace.currentPeriod } = {}) {
  const evidence = buildPayrollSocialEvidence(workspace, { period });
  const { summary } = evidence;
  const issues = [...evidence.issues];
  for (const row of summary.rows) {
    const payroll = row.payrollRecord;
    const social = row.socialSecurityRecord;
    if (payroll && social && [payroll.grossSalary, payroll.netSalary, payroll.individualIncomeTax, social.personalSocial].every((value) => value != null && Number.isFinite(Number(value)))
      && roundMoney(Number(payroll.grossSalary) - Number(payroll.netSalary) - Number(payroll.individualIncomeTax) - Number(social.personalSocial)) !== 0) {
      issues.push({ code: "payroll_net_difference", sourceId: row.key, message: `${row.employeeName}：应发与实发、个人社保及个税不一致` });
    }
  }
  const sideState = (kind, records, amount, amounts) => {
    const label = kind === "payroll" ? "工资表" : "社保表";
    const recordIds = new Set(records.map((record) => record.id));
    const otherMissing = kind === "payroll" ? "missing_social_security" : "missing_payroll";
    const ownIssues = issues.filter((issue) => recordIds.has(issue.sourceId)
      || (issue.sourceId && summary.rows.some((row) => row.key === issue.sourceId) && issue.code !== otherMissing && !issue.code.endsWith("_difference")));
    const sourceStatus = !records.length ? "missing" : ownIssues.length ? "incomplete" : issues.length ? "unreconciled" : "ready";
    const available = sourceStatus === "ready";
    const sourceMessage = sourceStatus === "missing" ? `本期${label}尚未导入`
      : sourceStatus === "incomplete" ? `本期${label}资料不完整：${[...new Set(ownIssues.map((issue) => issue.message))].join("；")}`
        : sourceStatus === "unreconciled" ? `本期${label}已导入，工资与社保仍待核对：${[...new Set(issues.map((issue) => issue.message))].join("；")}`
          : `本期${label}来源齐全且两表核对一致，${amount === 0 ? "金额明确为零" : "金额来自逐人记录"}`;
    return {
      period, sourceStatus, amountStatus: available ? (amount === 0 ? "zero" : "actual") : sourceStatus,
      sourceMessage, available, imported: records.length > 0,
      value: available ? amount : null,
      amounts: Object.fromEntries(Object.entries(amounts).map(([key, value]) => [key, available ? value : null])),
      sourceIds: collectSourceIds(records.map((record) => [record.id, record.sourceImportId, record.sourceDocumentId])),
    };
  };
  const payroll = sideState("payroll", summary.payrollRecords, summary.totals.payroll.grossSalary, summary.totals.payroll);
  const socialSecurity = sideState("socialSecurity", summary.socialSecurityRecords, summary.totals.socialSecurityPayable, { ...summary.totals.socialSecurity, total: summary.totals.socialSecurityPayable });
  return { period, payroll, socialSecurity, summary,
    fingerprint: JSON.stringify({ evidence: evidence.fingerprint, payroll, socialSecurity }),
  };
}

export function payrollSourceMetric(source, value = source.value) {
  return {
    value: source.available ? roundMoney(value) : null,
    sourceStatus: source.sourceStatus,
    amountStatus: source.available ? (Number(value) === 0 ? "zero" : "actual") : source.sourceStatus,
    sourceMessage: source.sourceMessage,
    available: source.available,
    imported: source.imported,
    sourceIds: [...source.sourceIds],
  };
}
