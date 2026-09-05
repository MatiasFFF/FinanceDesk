import { AccountingRuleError, accountingRules, activeAccountingRuleSet, roundMoney } from "./model.js";
import { resolveWorkspaceAccountDefinition } from "./classification.js";
import { buildPayrollSocialEvidence } from "../../features/intake/documentIntake.js";

export const DEFAULT_PAYROLL_ACCOUNTS = Object.freeze({
  wagesExpense: "expensePayroll",
  employerSocialExpense: "expenseSocialSecurity",
  payrollPayable: "payrollPayable",
  socialSecurityPayable: "socialSecurityPayable",
  individualIncomeTaxPayable: "taxPayable:individualIncomeTax",
});

const ROLES = [
  ["wagesExpense", "工资费用", "grossSalary", "debit"],
  ["employerSocialExpense", "企业社保费用", "employerSocial", "debit"],
  ["payrollPayable", "应付实发工资", "netSalary", "credit"],
  ["socialSecurityPayable", "应付社保", "socialSecurityPayable", "credit"],
  ["individualIncomeTaxPayable", "应付代扣个税", "individualIncomeTax", "credit"],
];
const periodOf = (voucher) => voucher.period || String(voucher.date || "").slice(0, 7);
const total = (items) => roundMoney(items.reduce((sum, value) => sum + Number(value || 0), 0));
const differs = (a, b) => roundMoney(a - b) !== 0;
const idsEqual = (a = [], b = []) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

export function payrollAccrualLines(summary) {
  return ROLES.filter(([, , amount]) => summary.expected[amount] > 0).map(([role, label, amount, side]) => ({
    account: summary.accounts[role],
    debit: side === "debit" ? summary.expected[amount] : 0,
    credit: side === "credit" ? summary.expected[amount] : 0,
    summary: `${summary.period} ${label}`,
    sourceIds: [...summary.sourceIds],
  }));
}

function linesMatch(voucher, summary) {
  const expected = payrollAccrualLines(summary);
  if ((voucher.lines || []).length !== expected.length) return false;
  return expected.every((line) => {
    const actual = voucher.lines.find((item) => item.account === line.account);
    return actual && !differs(Number(actual.debit || 0), line.debit) && !differs(Number(actual.credit || 0), line.credit)
      && idsEqual(actual.sourceIds, line.sourceIds);
  }) && idsEqual(voucher.sourceIds, summary.sourceIds) && idsEqual(voucher.evidenceIds, summary.documentIds);
}

export function buildPayrollAccountingSummary(workspace, { period = workspace.currentPeriod } = {}) {
  const evidence = buildPayrollSocialEvidence(workspace, { period });
  const data = evidence.summary;
  const rules = accountingRules(workspace);
  const accounts = { ...DEFAULT_PAYROLL_ACCOUNTS, ...rules.payrollAccounts };
  const applicable = workspace.modules?.payroll !== false && Boolean(data.rows.length);
  const sourceIds = evidence.sourceIds || [];
  const documentIds = evidence.documentIds || evidence.sourceDocumentIds || [];
  const createBlockers = [];
  const add = (code, message, voucherIds = []) => createBlockers.push({ code, message, voucherIds });
  const payroll = data.totals.payroll;
  const social = data.totals.socialSecurity;
  const expected = {
    grossSalary: payroll.grossSalary,
    employerSocial: social.employerSocial,
    expenseTotal: roundMoney(payroll.grossSalary + social.employerSocial),
    personalSocial: social.personalSocial,
    netSalary: payroll.netSalary,
    socialSecurityPayable: roundMoney(social.personalSocial + social.employerSocial),
    individualIncomeTax: payroll.individualIncomeTax,
  };
  if (applicable) {
    for (const row of data.rows) {
      if (!row.payrollRecord || !row.socialSecurityRecord) continue;
      const wage = row.payrollRecord;
      if (differs(Number(wage.grossSalary || 0), Number(wage.netSalary || 0) + Number(row.socialSecurityRecord.personalSocial || 0) + Number(wage.individualIncomeTax || 0))) {
        add("payroll_net_difference", `${row.employeeName}：应发工资与实发工资＋个人社保＋代扣个税不一致，请更正来源表`);
      }
    }
    for (const issue of evidence.issues || []) add(issue.code || "payroll_evidence_missing", issue.message || "工资社保原件依据不完整");
    for (const [role, label, , side] of ROLES) {
      const account = resolveWorkspaceAccountDefinition(workspace, accounts[role], { allowInactive: false });
      if (!account || !(side === "debit" ? ["cost", "expense"] : ["liability"]).includes(account.category)) {
        add("payroll_account_invalid", `${label}科目已停用或类别不符，请在本工作台科目规则中调整`);
      }
    }
    if (new Set(Object.values(accounts)).size !== ROLES.length) add("payroll_account_duplicate", "工资、企业社保费用及三项应付款需分别选择独立科目");
  }
  const ruleSet = activeAccountingRuleSet(workspace);
  const ruleSnapshot = {
    id: ruleSet?.id || null, version: ruleSet?.version || null,
    rules,
    accounts: ROLES.map(([role]) => ({ role, ...resolveWorkspaceAccountDefinition(workspace, accounts[role]) })),
  };
  const sourceFingerprint = JSON.stringify({ period, evidence: evidence.fingerprint, tables: data.fingerprints, ruleSnapshot, accounts });
  const related = (workspace.vouchers || []).filter((voucher) => voucher.payrollAccrual && periodOf(voucher) === period);
  const posted = related.filter((voucher) => voucher.status === "posted");
  const drafts = related.filter((voucher) => ["draft", "changes_requested"].includes(voucher.status));
  const periodPosted = (workspace.vouchers || []).filter((voucher) => voucher.status === "posted" && periodOf(voucher) === period);
  const expenseAccounts = new Set([accounts.wagesExpense, accounts.employerSocialExpense, "expensePayroll", "expenseSocialSecurity", ...related.flatMap((voucher) => [voucher.payrollAccrual.accounts?.wagesExpense, voucher.payrollAccrual.accounts?.employerSocialExpense])].filter(Boolean));
  const conflicts = periodPosted.filter((voucher) => !voucher.payrollAccrual && (voucher.lines || []).some((line) => expenseAccounts.has(line.account) && (Number(line.debit || 0) !== 0 || Number(line.credit || 0) !== 0)));
  if (applicable && conflicts.length) add("payroll_existing_expense", "已有工资或企业社保凭证直接计入费用。请打开所列凭证的“创建更正”，将已付款的费用借方改为对应应付款并复核入账，再生成计提；不要重复记费用。", conflicts.map((voucher) => voucher.id));
  if (posted.length > 1) add("payroll_duplicate_posted", "本期存在多张有效工资计提凭证，请先处理重复入账", posted.map((voucher) => voucher.id));
  if (drafts.length > 1) add("payroll_duplicate_drafts", "本期存在多张工资计提草稿，请先处理重复草稿", drafts.map((voucher) => voucher.id));
  const result = { period, applicable, accounts, expected, sourceIds, documentIds, sourceFingerprint, ruleSnapshot, evidence,
    draftVoucherId: drafts[0]?.id || null, postedVoucherId: posted[0]?.id || null,
    voucherIds: [...new Set([...related.map((voucher) => voucher.id), ...conflicts.map((voucher) => voucher.id)])],
  };
  const matches = (voucher) => voucher.payrollAccrual.sourceFingerprint === sourceFingerprint && linesMatch(voucher, result);
  const rows = ROLES.map(([key, label, amount, side]) => {
    const lines = periodPosted.flatMap((voucher) => voucher.lines || []).filter((line) => line.account === accounts[key]);
    const debit = total(lines.map((line) => line.debit));
    const credit = total(lines.map((line) => line.credit));
    const postedAmount = side === "debit" ? roundMoney(debit - credit) : credit;
    return { key, label, accountId: accounts[key], expected: expected[amount], posted: postedAmount, difference: roundMoney(postedAmount - expected[amount]),
      opening: (side === "credit" ? -1 : 1) * Number(workspace.openingLedger?.[accounts[key]] || 0), payments: side === "credit" ? debit : 0,
      closing: roundMoney((side === "credit" ? -1 : 1) * Number(workspace.openingLedger?.[accounts[key]] || 0) + (side === "credit" ? credit - debit : debit - credit)),
    };
  });
  const noAccrualNeeded = expected.expenseTotal === 0 && !posted.length && !drafts.length;
  const postedAndMatched = applicable && !createBlockers.length && (noAccrualNeeded || (posted.length === 1 && matches(posted[0]))) && rows.every((row) => !differs(row.difference, 0)) && !drafts.length;
  const issues = [...createBlockers];
  if (applicable && !postedAndMatched && !createBlockers.length) {
    issues.push({ code: posted.length ? "payroll_posted_stale" : drafts.length ? "payroll_draft_unposted" : "payroll_accrual_missing",
      message: posted.length ? "两表、规则或账面已变化，请填写更正原因，生成修订草稿并重新复核入账" : drafts.length ? (matches(drafts[0]) ? "工资计提草稿待财务复核入账" : "工资计提草稿的来源或分录已变化，请更新草稿再复核") : "两表已核对，尚未生成工资与企业社保计提草稿",
      voucherIds: related.map((voucher) => voucher.id),
    });
  }
  // A new revision can fix changed source data; unrelated ledger entries require their own correction.
  const ledgerDifferences = posted.length === 1 && matches(posted[0]) && rows.some((row) => differs(row.difference, 0));
  if (ledgerDifferences && !createBlockers.length) {
    const issue = { code: "payroll_ledger_difference", message: "计提与两表一致，但相关科目存在额外入账金额，请更正相关凭证后再确认", voucherIds: periodPosted.filter((voucher) => !voucher.payrollAccrual && voucher.lines?.some((line) => Object.values(accounts).includes(line.account))).map((voucher) => voucher.id) };
    createBlockers.push(issue); issues.push(issue); result.voucherIds = [...new Set([...result.voucherIds, ...issue.voucherIds])];
  }
  const readyToDraft = applicable && !createBlockers.length && !postedAndMatched && !(drafts.length === 1 && matches(drafts[0]));
  return { ...result, rows, issues, createBlockers, readyToDraft, canCreate: readyToDraft, postedAndMatched, noAccrualNeeded,
    status: !applicable ? "not_applicable" : postedAndMatched ? "matched" : createBlockers.length ? "blocked" : posted.length ? "needs_revision" : drafts.length ? "draft" : "ready",
    message: !applicable ? "本期无适用工资社保记录" : postedAndMatched ? (noAccrualNeeded ? "两表金额均为零，本期无需计提" : "两表与已入账工资、企业社保费用及应付款一致") : issues.map((issue) => issue.message).join("；"),
  };
}

export function assertPayrollVoucherPosting(workspace, voucher) {
  const tagged = Boolean(voucher.payrollAccrual);
  const summary = buildPayrollAccountingSummary(workspace, { period: periodOf(voucher) });
  if (!tagged) {
    if (summary.postedVoucherId && (voucher.lines || []).some((line) => [summary.accounts.wagesExpense, summary.accounts.employerSocialExpense].includes(line.account) && Number(line.debit || 0) !== 0)) {
      throw new AccountingRuleError("PAYROLL_DUPLICATE_EXPENSE", "本期已计提工资与企业社保，付款请冲减对应应付款；计提金额变化请从工资区创建更正");
    }
    return;
  }
  if (!summary.applicable || summary.createBlockers.length) throw new AccountingRuleError("PAYROLL_NOT_READY", summary.message, summary);
  if (voucher.payrollAccrual.sourceFingerprint !== summary.sourceFingerprint || !linesMatch(voucher, summary)) {
    throw new AccountingRuleError("PAYROLL_DRAFT_STALE", "工资社保来源、科目规则或分录已变化，请在工资区更新计提草稿后重新复核");
  }
  if (summary.postedVoucherId && summary.postedVoucherId !== voucher.revisionOf) {
    throw new AccountingRuleError("PAYROLL_ALREADY_POSTED", "本期工资计提已入账，请使用原凭证更正流程");
  }
}
