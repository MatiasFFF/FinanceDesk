import {
  AccountingRuleError,
  accountDefinition,
  appendAuditEntry,
  cloneAccountingState,
  collectSourceIds,
  nextRecordId,
  operationContext,
  periodOf,
  roundMoney,
  sumMoney,
} from "./model.js";
import { classifyBankTransaction } from "./classification.js";
import { buildAdvanceBalances, buildAgeingSchedule } from "../../features/reconciliation/reconciliationEngine.js";
import { buildMemberServiceReconciliation } from "../../features/members/memberLedger.js";

function valueWithSources(value, sourceIds = [], extra = {}) {
  return {
    value: roundMoney(value),
    sourceIds: collectSourceIds(sourceIds),
    ...extra,
  };
}

function activePostedVouchers(workspace, period) {
  return (workspace.vouchers || []).filter((voucher) => (
    voucher.status === "posted" && periodOf(voucher.date) === period
  ));
}

export function buildLedger(workspace, { period = workspace.currentPeriod } = {}) {
  const vouchers = activePostedVouchers(workspace, period);
  const accountIds = collectSourceIds(
    Object.keys(workspace.openingLedger || {}),
    vouchers.flatMap((voucher) => (voucher.lines || []).map((line) => line.account)),
  );
  const accounts = accountIds.map((accountId) => {
    const entries = vouchers.flatMap((voucher) => (voucher.lines || [])
      .filter((line) => line.account === accountId)
      .map((line, lineIndex) => ({
        voucherId: voucher.id,
        voucherNo: voucher.no,
        date: voucher.date,
        summary: voucher.summary,
        lineIndex,
        debit: roundMoney(line.debit),
        credit: roundMoney(line.credit),
        sourceIds: collectSourceIds(voucher.id, voucher.sourceIds, line.sourceIds),
      })));
    const debit = sumMoney(entries.map((entry) => entry.debit));
    const credit = sumMoney(entries.map((entry) => entry.credit));
    const opening = roundMoney(workspace.openingLedger?.[accountId] || 0);
    const closing = roundMoney(opening + debit - credit);
    return {
      accountId,
      account: accountDefinition(accountId, workspace),
      opening,
      debit,
      credit,
      closing,
      entries,
      voucherIds: [...new Set(entries.map((entry) => entry.voucherId))],
      sourceIds: collectSourceIds(entries.map((entry) => entry.sourceIds)),
    };
  });
  const debit = sumMoney(vouchers.flatMap((voucher) => voucher.lines || []).map((line) => line.debit));
  const credit = sumMoney(vouchers.flatMap((voucher) => voucher.lines || []).map((line) => line.credit));
  return {
    period,
    accounts,
    vouchers: vouchers.map((voucher) => voucher.id),
    totals: { debit, credit, difference: roundMoney(debit - credit) },
  };
}

function selectAccounts(ledger, categories) {
  return ledger.accounts.filter((item) => categories.includes(item.account.category));
}

function accountLine(item, value) {
  return {
    id: item.accountId,
    label: item.account.label,
    value: roundMoney(value),
    voucherIds: item.voucherIds,
    sourceIds: item.sourceIds,
  };
}

export function buildIncomeStatement(workspace, { period = workspace.currentPeriod, ledger = buildLedger(workspace, { period }) } = {}) {
  const revenueLines = selectAccounts(ledger, ["revenue"]).map((item) => accountLine(item, item.credit - item.debit));
  const returnLines = selectAccounts(ledger, ["contraRevenue"]).map((item) => accountLine(item, item.debit - item.credit));
  const costLines = selectAccounts(ledger, ["cost"]).map((item) => accountLine(item, item.debit - item.credit));
  const expenseLines = selectAccounts(ledger, ["expense"]).map((item) => accountLine(item, item.debit - item.credit));
  const grossRevenue = sumMoney(revenueLines.map((line) => line.value));
  const salesReturns = sumMoney(returnLines.map((line) => line.value));
  const netRevenue = roundMoney(grossRevenue - salesReturns);
  const cost = sumMoney(costLines.map((line) => line.value));
  const grossProfit = roundMoney(netRevenue - cost);
  const expenses = sumMoney(expenseLines.map((line) => line.value));
  const profit = roundMoney(grossProfit - expenses);
  return {
    period,
    lines: { revenue: revenueLines, salesReturns: returnLines, cost: costLines, expenses: expenseLines },
    grossRevenue: valueWithSources(grossRevenue, revenueLines.map((line) => line.sourceIds), { voucherIds: collectSourceIds(revenueLines.map((line) => line.voucherIds)) }),
    salesReturns: valueWithSources(salesReturns, returnLines.map((line) => line.sourceIds), { voucherIds: collectSourceIds(returnLines.map((line) => line.voucherIds)) }),
    netRevenue: valueWithSources(netRevenue, [revenueLines, returnLines].flatMap((group) => group.map((line) => line.sourceIds))),
    cost: valueWithSources(cost, costLines.map((line) => line.sourceIds)),
    grossProfit: valueWithSources(grossProfit, [revenueLines, returnLines, costLines].flatMap((group) => group.map((line) => line.sourceIds))),
    expenses: valueWithSources(expenses, expenseLines.map((line) => line.sourceIds)),
    profit: valueWithSources(profit, [revenueLines, returnLines, costLines, expenseLines].flatMap((group) => group.map((line) => line.sourceIds))),
  };
}

export function buildBalanceSheet(workspace, {
  period = workspace.currentPeriod,
  ledger = buildLedger(workspace, { period }),
  incomeStatement = buildIncomeStatement(workspace, { period, ledger }),
} = {}) {
  const assetLines = selectAccounts(ledger, ["asset"]).map((item) => accountLine(item, item.closing));
  const liabilityLines = selectAccounts(ledger, ["liability"]).map((item) => accountLine(item, -item.closing));
  const equityLines = selectAccounts(ledger, ["equity"]).map((item) => accountLine(item, -item.closing));
  const assets = sumMoney(assetLines.map((line) => line.value));
  const liabilities = sumMoney(liabilityLines.map((line) => line.value));
  const openingEquity = sumMoney(equityLines.map((line) => line.value));
  const equity = roundMoney(openingEquity + incomeStatement.profit.value);
  const difference = roundMoney(assets - liabilities - equity);
  return {
    period,
    lines: { assets: assetLines, liabilities: liabilityLines, equity: equityLines },
    assets: valueWithSources(assets, assetLines.map((line) => line.sourceIds)),
    liabilities: valueWithSources(liabilities, liabilityLines.map((line) => line.sourceIds)),
    openingEquity: valueWithSources(openingEquity, equityLines.map((line) => line.sourceIds)),
    currentProfit: incomeStatement.profit,
    equity: valueWithSources(equity, collectSourceIds(equityLines.map((line) => line.sourceIds), incomeStatement.profit.sourceIds)),
    difference: valueWithSources(difference, collectSourceIds(assetLines.map((line) => line.sourceIds), liabilityLines.map((line) => line.sourceIds), equityLines.map((line) => line.sourceIds), incomeStatement.profit.sourceIds)),
    balanced: Math.abs(difference) <= 0.01,
  };
}

function cashFlowCategory(workspace, voucher) {
  const counterpart = (voucher.lines || []).filter((line) => !accountDefinition(line.account, workspace).cash);
  const categories = new Set(counterpart.map((line) => accountDefinition(line.account, workspace).category));
  if (categories.has("asset") && counterpart.some((line) => !["receivable", "prepayment"].includes(String(line.account).split(":")[0]))) return "investing";
  if (categories.has("equity") || counterpart.some((line) => ["loan", "relatedParty"].includes(String(line.account).split(":")[0]))) return "financing";
  return "operating";
}

export function buildCashFlowStatement(workspace, { period = workspace.currentPeriod } = {}) {
  const vouchers = activePostedVouchers(workspace, period);
  const movements = vouchers.map((voucher) => {
    const cashLines = (voucher.lines || []).filter((line) => accountDefinition(line.account, workspace).cash);
    const amount = sumMoney(cashLines.map((line) => Number(line.debit || 0) - Number(line.credit || 0)));
    return {
      voucherId: voucher.id,
      date: voucher.date,
      summary: voucher.summary,
      category: cashFlowCategory(workspace, voucher),
      amount,
      sourceIds: collectSourceIds(voucher.id, voucher.sourceIds, cashLines.map((line) => line.sourceIds)),
    };
  }).filter((movement) => Math.abs(movement.amount) > 0.01);
  const section = (category) => {
    const rows = movements.filter((movement) => movement.category === category);
    return valueWithSources(sumMoney(rows.map((row) => row.amount)), rows.map((row) => row.sourceIds), { rows });
  };
  const operating = section("operating");
  const investing = section("investing");
  const financing = section("financing");
  const netChange = valueWithSources(roundMoney(operating.value + investing.value + financing.value), movements.map((row) => row.sourceIds));
  const openingRows = Object.entries(workspace.openingLedger || {}).filter(([accountId]) => accountDefinition(accountId, workspace).cash);
  const openingCash = valueWithSources(sumMoney(openingRows.map(([, value]) => value)), openingRows.map(([accountId]) => accountId));
  const closingCash = valueWithSources(roundMoney(openingCash.value + netChange.value), collectSourceIds(openingCash.sourceIds, netChange.sourceIds));
  return { period, operating, investing, financing, netChange, openingCash, closingCash, movements };
}

export function buildFinancialStatements(workspace, { period = workspace.currentPeriod } = {}) {
  const ledger = buildLedger(workspace, { period });
  const incomeStatement = buildIncomeStatement(workspace, { period, ledger });
  const balanceSheet = buildBalanceSheet(workspace, { period, ledger, incomeStatement });
  const cashFlow = buildCashFlowStatement(workspace, { period });
  const memberServiceReconciliation = buildMemberServiceReconciliation(workspace, { period });
  const ledgerCash = sumMoney(ledger.accounts.filter((item) => item.account.cash).map((item) => item.closing));
  return {
    period,
    ledger,
    balanceSheet,
    incomeStatement,
    cashFlow,
    memberServiceReconciliation,
    checks: {
      trialBalance: { passed: Math.abs(ledger.totals.difference) <= 0.01, difference: ledger.totals.difference, sourceIds: ledger.vouchers },
      balanceSheet: { passed: balanceSheet.balanced, difference: balanceSheet.difference.value, sourceIds: balanceSheet.difference.sourceIds },
      cashMovement: { passed: Math.abs(roundMoney(ledgerCash - cashFlow.closingCash.value)) <= 0.01, difference: roundMoney(ledgerCash - cashFlow.closingCash.value), sourceIds: cashFlow.closingCash.sourceIds },
      memberService: {
        passed: memberServiceReconciliation.passed,
        applicable: memberServiceReconciliation.applicable,
        difference: memberServiceReconciliation.difference,
        memberBalance: memberServiceReconciliation.memberBalance,
        contractLiabilityBalance: memberServiceReconciliation.contractLiabilityBalance,
        detail: memberServiceReconciliation.message,
        sourceIds: memberServiceReconciliation.sourceIds,
      },
    },
  };
}

export function buildManagementMetrics(workspace, { period = workspace.currentPeriod, asOf = `${period}-31` } = {}) {
  const statements = buildFinancialStatements(workspace, { period });
  const ageing = buildAgeingSchedule(workspace, { asOf });
  const advances = buildAdvanceBalances(workspace);
  const incoming = (workspace.transactions || []).filter((transaction) => {
    const eventType = (transaction.classification || classifyBankTransaction(workspace, transaction)).eventType;
    return periodOf(transaction.date) === period && Number(transaction.amount) > 0 &&
      !["internalTransfer", "unknown"].includes(eventType) && !transaction.internalTransferLink;
  });
  const collections = valueWithSources(sumMoney(incoming.map((transaction) => transaction.amount)), incoming.map((transaction) => transaction.id));
  const cashLine = valueWithSources(statements.cashFlow.closingCash.value, statements.cashFlow.closingCash.sourceIds);
  const receivableRows = ageing.rows.filter((row) => row.kind === "receivable");
  const payableRows = ageing.rows.filter((row) => row.kind === "payable");
  const duePayables = sumMoney(payableRows.map((row) => row.balance));
  const cashGap = Math.min(0, roundMoney(cashLine.value - duePayables));
  const contractLiabilityAccount = statements.ledger.accounts.find((item) => item.accountId === "contractLiability");
  const prepaymentAccount = statements.ledger.accounts.find((item) => item.accountId === "prepayment");
  const depositBalance = valueWithSources(
    Math.max(0, roundMoney(-(contractLiabilityAccount?.closing || 0))),
    contractLiabilityAccount?.sourceIds || [],
  );
  const prepaymentBalance = valueWithSources(
    Math.max(0, roundMoney(prepaymentAccount?.closing || 0)),
    prepaymentAccount?.sourceIds || [],
  );
  return {
    period,
    metrics: [
      { id: "cash", label: "现金余额", ...cashLine },
      { id: "collections", label: "本月收款", ...collections },
      { id: "revenue", label: "本月收入", ...statements.incomeStatement.netRevenue },
      { id: "grossProfit", label: "本月毛利", ...statements.incomeStatement.grossProfit },
      { id: "profit", label: "本月利润", ...statements.incomeStatement.profit },
      { id: "receivable", label: "应收账款", ...valueWithSources(sumMoney(receivableRows.map((row) => row.balance)), receivableRows.map((row) => row.sourceIds)) },
      { id: "payable", label: "供应商应付", ...valueWithSources(duePayables, payableRows.map((row) => row.sourceIds)) },
      { id: "deposit", label: "客户预收", ...depositBalance },
      { id: "prepayment", label: "供应商预付", ...prepaymentBalance },
      { id: "refund", label: "本月退款", ...statements.incomeStatement.salesReturns },
      { id: "cashGap", label: "未来现金缺口", ...valueWithSources(cashGap, collectSourceIds(cashLine.sourceIds, payableRows.map((row) => row.sourceIds))) },
    ],
    statements,
    ageing,
    advances,
  };
}

export function buildTaxWorkpaper(workspace, { period = workspace.currentPeriod } = {}) {
  const statements = buildFinancialStatements(workspace, { period });
  const rate = Number(workspace.tax?.vatRate ?? 0.03);
  const taxableRevenue = statements.incomeStatement.netRevenue;
  const adjustments = valueWithSources(Number(workspace.tax?.adjustments || 0), workspace.tax?.adjustmentSourceIds || []);
  const taxableBase = valueWithSources(
    Math.max(0, roundMoney(taxableRevenue.value + adjustments.value)),
    collectSourceIds(taxableRevenue.sourceIds, adjustments.sourceIds),
  );
  const outputVat = valueWithSources(roundMoney(taxableBase.value * rate), taxableBase.sourceIds);
  const taxInputAccounts = statements.ledger.accounts.filter((item) => String(item.accountId).startsWith("taxInput"));
  const inputVat = valueWithSources(sumMoney(taxInputAccounts.map((item) => item.debit - item.credit)), taxInputAccounts.map((item) => item.sourceIds));
  const vatPayable = valueWithSources(Math.max(0, roundMoney(outputVat.value - inputVat.value)), collectSourceIds(outputVat.sourceIds, inputVat.sourceIds));
  const payroll = valueWithSources(workspace.tax?.payroll || 0, workspace.tax?.payrollSourceIds || workspace.tax?.sourceIds || []);
  const socialSecurity = valueWithSources(workspace.tax?.socialSecurity || 0, workspace.tax?.socialSecuritySourceIds || workspace.tax?.sourceIds || []);
  const unresolved = (workspace.exceptionTasks || []).filter((task) => task.status !== "resolved");
  const confirmation = [...(workspace.confirmations || [])]
    .filter((item) => item.period === period && item.kind === "tax")
    .sort((left, right) => String(left.updatedAt || left.createdAt || "").localeCompare(String(right.updatedAt || right.createdAt || "")))
    .at(-1);
  return {
    period,
    status: unresolved.length ? "blocked_by_exceptions" : (confirmation?.status === "approved" ? "customer_confirmed" : "awaiting_customer_confirmation"),
    taxableRevenue,
    adjustments,
    taxableBase,
    vatRate: rate,
    outputVat,
    inputVat,
    vatPayable,
    payroll,
    socialSecurity,
    financialStatementSourceIds: collectSourceIds(
      statements.balanceSheet.assets.sourceIds,
      statements.balanceSheet.liabilities.sourceIds,
      statements.incomeStatement.profit.sourceIds,
    ),
    unresolvedExceptionIds: unresolved.map((task) => task.id),
    confirmationId: confirmation?.id || null,
    checks: statements.checks,
  };
}

export function freezeReportVersion(workspace, { period = workspace.currentPeriod, label = "月度财务报表" } = {}, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const statements = buildFinancialStatements(next, { period });
  if (!Object.values(statements.checks).every((check) => check.passed)) {
    throw new AccountingRuleError("REPORT_CHECK_FAILED", "报表勾稽未通过，不能冻结版本", statements.checks);
  }
  const versions = next.reportVersions || (next.reportVersions = []);
  const version = {
    id: nextRecordId(versions, "report"),
    version: versions.filter((item) => item.period === period).length + 1,
    period,
    label,
    status: "frozen",
    createdAt: resolvedContext.at,
    createdBy: resolvedContext.actor,
    statements,
    sourceIds: collectSourceIds(statements.ledger.vouchers),
  };
  versions.push(version);
  appendAuditEntry(next, {
    action: "report.freeze",
    entityType: "reportVersion",
    entityId: version.id,
    detail: `${label} ${period} v${version.version}`,
    after: { period, version: version.version, status: version.status },
    sourceIds: collectSourceIds(version.id, version.sourceIds),
  }, resolvedContext);
  return next;
}

export function createCustomerConfirmationPackage(workspace, { period = workspace.currentPeriod, reportVersionId = null } = {}, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const tax = buildTaxWorkpaper(next, { period });
  const statements = buildFinancialStatements(next, { period });
  const confirmations = next.confirmations || (next.confirmations = []);
  const confirmation = {
    id: nextRecordId(confirmations, "confirmation-package"),
    kind: "tax",
    period,
    reportVersionId,
    version: confirmations.filter((item) => item.kind === "tax" && item.period === period).length + 1,
    status: "pending",
    createdAt: resolvedContext.at,
    createdBy: resolvedContext.actor,
    sections: {
      finance: { status: "pending", value: statements.incomeStatement.profit.value, sourceIds: statements.incomeStatement.profit.sourceIds },
      revenue: { status: "pending", value: tax.taxableRevenue.value, sourceIds: tax.taxableRevenue.sourceIds },
      costExpense: { status: "pending", value: roundMoney(statements.incomeStatement.cost.value + statements.incomeStatement.expenses.value), sourceIds: collectSourceIds(statements.incomeStatement.cost.sourceIds, statements.incomeStatement.expenses.sourceIds) },
      vat: { status: "pending", value: tax.vatPayable.value, sourceIds: tax.vatPayable.sourceIds },
      inputVat: { status: "pending", value: tax.inputVat.value, sourceIds: tax.inputVat.sourceIds },
      payroll: { status: "pending", value: tax.payroll.value, sourceIds: tax.payroll.sourceIds },
      socialSecurity: { status: "pending", value: tax.socialSecurity.value, sourceIds: tax.socialSecurity.sourceIds },
      openItems: { status: "pending", value: tax.unresolvedExceptionIds.length, sourceIds: tax.unresolvedExceptionIds },
    },
    unresolvedExceptionIds: tax.unresolvedExceptionIds,
    decisions: [],
    sourceIds: collectSourceIds(tax.financialStatementSourceIds, tax.payroll.sourceIds, tax.socialSecurity.sourceIds),
  };
  confirmations.push(confirmation);
  appendAuditEntry(next, {
    action: "confirmation.create",
    entityType: "customerConfirmation",
    entityId: confirmation.id,
    detail: `生成 ${period} 客户确认包 v${confirmation.version}`,
    after: { status: confirmation.status, sections: Object.keys(confirmation.sections) },
    sourceIds: collectSourceIds(confirmation.id, confirmation.sourceIds),
  }, resolvedContext);
  return next;
}

export function recordCustomerConfirmation(workspace, {
  confirmationId,
  section,
  decision,
  note = "",
}, context = {}) {
  if (!["approve", "reject"].includes(decision)) throw new AccountingRuleError("INVALID_CONFIRMATION_DECISION", "客户确认结果只能是 approve 或 reject");
  if (decision === "reject" && !note.trim()) throw new AccountingRuleError("REJECTION_REASON_REQUIRED", "客户提出异议时必须填写原因");
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const confirmation = (next.confirmations || []).find((item) => item.id === confirmationId);
  if (!confirmation) throw new AccountingRuleError("CONFIRMATION_NOT_FOUND", `找不到客户确认包：${confirmationId}`);
  if (!confirmation.sections[section]) throw new AccountingRuleError("CONFIRMATION_SECTION_NOT_FOUND", `找不到确认项目：${section}`);
  const before = { ...confirmation.sections[section] };
  const record = {
    id: nextRecordId(confirmation.decisions || [], "decision"),
    section,
    decision,
    note: note.trim(),
    at: resolvedContext.at,
    actor: resolvedContext.actor,
  };
  confirmation.decisions.push(record);
  confirmation.sections[section].status = decision === "approve" ? "approved" : "rejected";
  confirmation.sections[section].confirmedAt = resolvedContext.at;
  confirmation.sections[section].confirmedBy = resolvedContext.actor;
  const statuses = Object.values(confirmation.sections).map((item) => item.status);
  confirmation.status = statuses.includes("rejected") ? "disputed" : (statuses.every((status) => status === "approved") ? "approved" : "partial");
  confirmation.updatedAt = resolvedContext.at;
  if (decision === "reject") {
    const tasks = next.exceptionTasks || (next.exceptionTasks = []);
    tasks.push({
      id: nextRecordId(tasks, "exception"),
      identity: `${confirmation.id}:${section}:${record.id}`,
      code: "customer_dispute",
      sourceType: "customerConfirmation",
      sourceId: confirmation.id,
      message: note.trim(),
      status: "open",
      createdAt: resolvedContext.at,
      updatedAt: resolvedContext.at,
      sourceIds: collectSourceIds(confirmation.id, confirmation.sections[section].sourceIds),
      history: [{ at: resolvedContext.at, actor: resolvedContext.actor, action: "created", note: note.trim() }],
    });
  }
  appendAuditEntry(next, {
    action: `confirmation.${decision}`,
    entityType: "customerConfirmation",
    entityId: confirmation.id,
    detail: `${section}：${note.trim() || "确认无误"}`,
    before,
    after: { ...confirmation.sections[section], packageStatus: confirmation.status },
    sourceIds: collectSourceIds(confirmation.id, confirmation.sections[section].sourceIds),
  }, resolvedContext);
  return next;
}
