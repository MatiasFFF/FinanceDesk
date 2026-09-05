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
  workspaceUsesMemberBusinessTerms,
} from "./model.js";
import * as XLSX from "xlsx";
import { buildAdvanceBalances, buildAgeingSchedule } from "../../features/reconciliation/reconciliationEngine.js";
import {
  MEMBER_EVENT_DEFINITIONS,
  MEMBER_EVENT_KINDS,
  buildMemberServiceReconciliation,
  isRecognizedMemberEvent,
  memberEventKind,
} from "../../features/members/memberLedger.js";

function valueWithSources(value, sourceIds = [], extra = {}) {
  return {
    value: roundMoney(value),
    sourceIds: collectSourceIds(sourceIds),
    ...extra,
  };
}

function reportMemberBusinessEnabled(workspace) {
  return workspaceUsesMemberBusinessTerms(workspace);
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
  const memberServiceReconciliation = reportMemberBusinessEnabled(workspace)
    ? buildMemberServiceReconciliation(workspace, { period })
    : {
        passed: true,
        applicable: false,
        difference: 0,
        memberBalance: 0,
        contractLiabilityBalance: 0,
        message: "可选业务履约模块未启用，不参与本期报表勾稽",
        sourceIds: [],
      };
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

function voucherSourceIds(voucher) {
  return collectSourceIds(
    voucher.id,
    voucher.memberEventId,
    voucher.sourceIds || [],
    voucher.relatedSourceIds || [],
    (voucher.lines || []).flatMap((line) => line.sourceIds || []),
  );
}

function directVoucherSourceIds(voucher) {
  return collectSourceIds(
    voucher.memberEventId,
    voucher.sourceIds || [],
    (voucher.lines || []).flatMap((line) => line.sourceIds || []),
  );
}

function storeReportDimensions(workspace, event, member = null) {
  const stored = event.dimensions || {};
  let storeId = String(event.storeId || stored.storeId || member?.storeId || "").trim();
  if (!storeId && (workspace.stores || []).length === 1) storeId = workspace.stores[0].id;
  const store = (workspace.stores || []).find((item) => item.id === storeId);
  return {
    storeId: storeId || "unassigned",
    storeName: String(event.storeName || stored.storeName || store?.name || member?.storeName || "未归属门店").trim(),
    coach: String(event.coach || stored.coach || member?.coach || "").trim(),
    department: String(event.department || stored.department || member?.department || "").trim(),
    project: String(event.project || stored.project || member?.project || "").trim(),
  };
}

function emptyStoreMetrics() {
  return {
    collections: 0,
    recognizedRevenue: 0,
    refunds: 0,
    coachCommission: 0,
    grossProfit: 0,
    unfulfilledBalance: 0,
  };
}

function addStoreMetric(target, key, amount) {
  target[key] = roundMoney(Number(target[key] || 0) + Number(amount || 0));
}

function postedMemberEventAmount(workspace, vouchers, kind) {
  const lines = vouchers.flatMap((voucher) => voucher.lines || []);
  let amount = 0;
  if (kind === MEMBER_EVENT_KINDS.RECHARGE) {
    amount = sumMoney(lines.filter((line) => String(line.account).split(":")[0] === "contractLiability")
      .map((line) => Number(line.credit || 0) - Number(line.debit || 0)));
  }
  if (kind === MEMBER_EVENT_KINDS.CONSUMPTION) {
    amount = sumMoney(lines.filter((line) => accountDefinition(line.account, workspace).category === "revenue")
      .map((line) => Number(line.credit || 0) - Number(line.debit || 0)));
  }
  if (kind === MEMBER_EVENT_KINDS.REFUND) {
    amount = sumMoney(lines.filter((line) => String(line.account).split(":")[0] === "contractLiability")
      .map((line) => Number(line.debit || 0) - Number(line.credit || 0)));
  }
  if (kind === MEMBER_EVENT_KINDS.COMMISSION) {
    amount = sumMoney(lines.filter((line) => String(line.account).split(":")[0] === "expenseCommission")
      .map((line) => Number(line.debit || 0) - Number(line.credit || 0)));
  }
  return roundMoney(amount);
}

export function buildStoreManagementReport(workspace, {
  period = workspace.currentPeriod,
  asOf = null,
} = {}) {
  const memberBusinessEnabled = reportMemberBusinessEnabled(workspace);
  const resolvedAsOf = validDate(asOf) || periodEndDate(period);
  const postedVouchers = (workspace.vouchers || []).filter((voucher) => voucher.status === "posted");
  const vouchersBySource = new Map();
  postedVouchers.forEach((voucher) => {
    directVoucherSourceIds(voucher).forEach((sourceId) => {
      vouchersBySource.set(sourceId, [...(vouchersBySource.get(sourceId) || []), voucher]);
    });
  });
  const membersById = new Map((workspace.members || []).map((member) => [member.id, member]));
  const stores = new Map();
  const ensureStore = (dimensions) => {
    if (!stores.has(dimensions.storeId)) {
      stores.set(dimensions.storeId, {
        id: dimensions.storeId,
        name: dimensions.storeName,
        metrics: emptyStoreMetrics(),
        members: new Map(),
        sources: [],
        sourceIds: [],
        voucherIds: [],
      });
    }
    return stores.get(dimensions.storeId);
  };
  (workspace.stores || []).forEach((store) => ensureStore({
    storeId: store.id,
    storeName: store.name || "未命名门店",
  }));

  const ensureMember = (store, member, dimensions) => {
    const memberId = member?.id || "unassigned-member";
    if (!store.members.has(memberId)) {
      store.members.set(memberId, {
        id: memberId,
        name: member?.name || (memberBusinessEnabled ? "未关联会员" : "未关联客户"),
        storeId: dimensions.storeId,
        coach: dimensions.coach,
        department: dimensions.department,
        project: dimensions.project,
        metrics: emptyStoreMetrics(),
        sourceIds: [],
        voucherIds: [],
      });
    }
    return store.members.get(memberId);
  };

  (workspace.members || []).forEach((member) => {
    const openingBalance = roundMoney(member.openingBalance || 0);
    if (!openingBalance) return;
    const dimensions = storeReportDimensions(workspace, {}, member);
    const store = ensureStore(dimensions);
    const memberRow = ensureMember(store, member, dimensions);
    addStoreMetric(store.metrics, "unfulfilledBalance", openingBalance);
    addStoreMetric(memberRow.metrics, "unfulfilledBalance", openingBalance);
    const sourceId = "opening:member:" + member.id;
    store.sourceIds.push(sourceId);
    memberRow.sourceIds.push(sourceId);
    store.sources.push({
      id: sourceId,
      eventId: null,
      kind: "opening",
      label: memberBusinessEnabled ? "会员期初未履约余额" : "客户期初未履约余额",
      date: "",
      memberId: member.id,
      memberName: member.name,
      ...dimensions,
      amount: openingBalance,
      quantity: Number(member.openingSessions || 0),
      impacts: { ...emptyStoreMetrics(), unfulfilledBalance: openingBalance },
      voucherIds: [],
      voucherSourceIds: [sourceId],
    });
  });

  const relevantKinds = new Set([
    MEMBER_EVENT_KINDS.RECHARGE,
    MEMBER_EVENT_KINDS.CONSUMPTION,
    MEMBER_EVENT_KINDS.REFUND,
    MEMBER_EVENT_KINDS.COMMISSION,
  ]);
  const recognizedEvents = (workspace.businessEvents || []).filter((event) => (
    relevantKinds.has(memberEventKind(event))
    && isRecognizedMemberEvent(event)
    && (!event.date || event.date <= resolvedAsOf)
  ));
  const postedEvents = recognizedEvents.filter((event) => (vouchersBySource.get(event.id) || []).length > 0);

  postedEvents.forEach((event) => {
    const kind = memberEventKind(event);
    const member = membersById.get(event.memberId) || null;
    const dimensions = storeReportDimensions(workspace, event, member);
    const store = ensureStore(dimensions);
    const memberRow = event.memberId ? ensureMember(store, member || {
      id: event.memberId,
      name: event.memberName || (memberBusinessEnabled ? "未命名会员" : "未命名客户"),
    }, dimensions) : null;
    const vouchers = vouchersBySource.get(event.id) || [];
    const amount = postedMemberEventAmount(workspace, vouchers, kind);
    const inPeriod = periodOf(event.date) === period;
    const impacts = emptyStoreMetrics();
    if (inPeriod && kind === MEMBER_EVENT_KINDS.RECHARGE) impacts.collections = amount;
    if (inPeriod && kind === MEMBER_EVENT_KINDS.CONSUMPTION) impacts.recognizedRevenue = amount;
    if (inPeriod && kind === MEMBER_EVENT_KINDS.REFUND) impacts.refunds = amount;
    if (inPeriod && kind === MEMBER_EVENT_KINDS.COMMISSION) impacts.coachCommission = amount;
    if (kind === MEMBER_EVENT_KINDS.RECHARGE) impacts.unfulfilledBalance = amount;
    if ([MEMBER_EVENT_KINDS.CONSUMPTION, MEMBER_EVENT_KINDS.REFUND].includes(kind)) impacts.unfulfilledBalance = -amount;
    impacts.grossProfit = roundMoney(impacts.recognizedRevenue - impacts.coachCommission);
    Object.entries(impacts).forEach(([key, value]) => {
      addStoreMetric(store.metrics, key, value);
      if (memberRow) addStoreMetric(memberRow.metrics, key, value);
    });
    const voucherIds = vouchers.map((voucher) => voucher.id);
    const sourceIds = collectSourceIds(event.id, event.sourceIds || [], voucherIds);
    store.sourceIds.push(...sourceIds);
    store.voucherIds.push(...voucherIds);
    if (memberRow) {
      memberRow.sourceIds.push(...sourceIds);
      memberRow.voucherIds.push(...voucherIds);
    }
    store.sources.push({
      id: event.id,
      eventId: event.id,
      kind,
      label: memberBusinessEnabled
        ? MEMBER_EVENT_DEFINITIONS[kind]?.label || "会员业务"
        : event.summary || event.counterparty || "业务事件",
      date: event.date,
      memberId: event.memberId || null,
      memberName: event.memberName || member?.name || "",
      ...dimensions,
      amount,
      quantity: roundMoney(event.quantity || 0),
      note: event.note || "",
      impacts,
      voucherIds,
      voucherSourceIds: collectSourceIds(vouchers.map((voucher) => voucherSourceIds(voucher))),
    });
  });

  const rows = [...stores.values()].map((store) => ({
    ...store,
    metrics: Object.fromEntries(Object.entries(store.metrics).map(([key, value]) => [key, roundMoney(value)])),
    members: [...store.members.values()].map((member) => ({
      ...member,
      metrics: Object.fromEntries(Object.entries(member.metrics).map(([key, value]) => [key, roundMoney(value)])),
      sourceIds: collectSourceIds(member.sourceIds),
      voucherIds: collectSourceIds(member.voucherIds),
    })).sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
    sources: [...store.sources].sort((left, right) => String(right.date || "").localeCompare(String(left.date || ""))),
    sourceIds: collectSourceIds(store.sourceIds),
    voucherIds: collectSourceIds(store.voucherIds),
  })).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const totals = rows.reduce((current, store) => {
    Object.entries(store.metrics).forEach(([key, value]) => addStoreMetric(current, key, value));
    return current;
  }, emptyStoreMetrics());
  const periodRecognized = recognizedEvents.filter((event) => periodOf(event.date) === period);
  const periodPosted = postedEvents.filter((event) => periodOf(event.date) === period);
  return {
    period,
    asOf: resolvedAsOf,
    stores: rows,
    totals,
    sourceIds: collectSourceIds(rows.map((store) => store.sourceIds)),
    voucherIds: collectSourceIds(rows.map((store) => store.voucherIds)),
    postingCoverage: {
      recognizedEventCount: periodRecognized.length,
      postedEventCount: periodPosted.length,
      unpostedEventCount: periodRecognized.length - periodPosted.length,
    },
    grossProfitFormula: memberBusinessEnabled ? "确认收入 − 教练提成" : "确认收入 − 业务提成",
  };
}

export const AGEING_BUCKET_DEFINITIONS = Object.freeze([
  { id: "notDue", label: "未到期" },
  { id: "days1To30", label: "1–30 天" },
  { id: "days31To60", label: "31–60 天" },
  { id: "days61To90", label: "61–90 天" },
  { id: "daysOver90", label: "90 天以上" },
]);

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const parsed = Date.parse(String(value) + "T00:00:00Z");
  return Number.isFinite(parsed) ? String(value) : null;
}

function addDays(date, days) {
  const parsed = Date.parse(String(date) + "T00:00:00Z");
  return new Date(parsed + Number(days) * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(later, earlier) {
  return Math.floor((Date.parse(String(later) + "T00:00:00Z") - Date.parse(String(earlier) + "T00:00:00Z")) / 86_400_000);
}

function periodEndDate(period) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period || ""));
  if (!match) return new Date().toISOString().slice(0, 10);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).toISOString().slice(0, 10);
}

function ageingBucketForDate(asOf, dueDate) {
  const days = Math.max(0, daysBetween(asOf, dueDate));
  if (dueDate >= asOf || days === 0) return "notDue";
  if (days <= 30) return "days1To30";
  if (days <= 60) return "days31To60";
  if (days <= 90) return "days61To90";
  return "daysOver90";
}

export function buildReceivablePayableAgeing(workspace, {
  asOf = periodEndDate(workspace.currentPeriod),
} = {}) {
  const resolvedAsOf = validDate(asOf) || periodEndDate(workspace.currentPeriod);
  const raw = buildAgeingSchedule(workspace, { asOf: resolvedAsOf });
  const billsById = new Map((workspace.bills || []).map((bill) => [bill.id, bill]));
  const rows = raw.rows.map((row) => {
    const bill = billsById.get(row.billId) || {};
    const dueDate = validDate(bill.dueDate);
    const missingDueDate = !dueDate;
    return {
      ...row,
      summary: bill.summary || "",
      dueDate,
      missingDueDate,
      daysOverdue: dueDate ? Math.max(0, daysBetween(resolvedAsOf, dueDate)) : null,
      bucket: dueDate ? ageingBucketForDate(resolvedAsOf, dueDate) : "missingDueDate",
      evidenceIds: collectSourceIds(bill.evidenceIds || []),
      sourceIds: collectSourceIds(row.sourceIds || [], bill.id, bill.evidenceIds || []),
    };
  });
  const datedRows = rows.filter((row) => !row.missingDueDate);
  const missingRows = rows.filter((row) => row.missingDueDate);
  const buckets = AGEING_BUCKET_DEFINITIONS.map((definition) => {
    const bucketRows = datedRows.filter((row) => row.bucket === definition.id);
    const receivables = bucketRows.filter((row) => row.kind === "receivable");
    const payables = bucketRows.filter((row) => row.kind === "payable");
    return {
      ...definition,
      bucket: definition.id,
      amount: sumMoney(bucketRows.map((row) => row.balance)),
      receivable: valueWithSources(sumMoney(receivables.map((row) => row.balance)), receivables.map((row) => row.sourceIds), { rows: receivables }),
      payable: valueWithSources(sumMoney(payables.map((row) => row.balance)), payables.map((row) => row.sourceIds), { rows: payables }),
      rows: bucketRows,
      sourceIds: collectSourceIds(bucketRows.map((row) => row.sourceIds)),
    };
  });
  const receivableRows = rows.filter((row) => row.kind === "receivable");
  const payableRows = rows.filter((row) => row.kind === "payable");
  const missingReceivables = missingRows.filter((row) => row.kind === "receivable");
  const missingPayables = missingRows.filter((row) => row.kind === "payable");
  const advances = buildAdvanceBalances(workspace);
  const depositRows = advances.rows.filter((row) => row.kind === "depositReceived" && row.availableBalance > 0.01);
  const prepaymentRows = advances.rows.filter((row) => row.kind === "prepaymentPaid" && row.availableBalance > 0.01);
  return {
    asOf: resolvedAsOf,
    kind: "receivableAndPayable",
    total: sumMoney(rows.map((row) => row.balance)),
    rows,
    buckets,
    receivable: valueWithSources(sumMoney(receivableRows.map((row) => row.balance)), receivableRows.map((row) => row.sourceIds), { rows: receivableRows }),
    payable: valueWithSources(sumMoney(payableRows.map((row) => row.balance)), payableRows.map((row) => row.sourceIds), { rows: payableRows }),
    missingDueDate: {
      rows: missingRows,
      receivable: valueWithSources(sumMoney(missingReceivables.map((row) => row.balance)), missingReceivables.map((row) => row.sourceIds), { rows: missingReceivables }),
      payable: valueWithSources(sumMoney(missingPayables.map((row) => row.balance)), missingPayables.map((row) => row.sourceIds), { rows: missingPayables }),
      sourceIds: collectSourceIds(missingRows.map((row) => row.sourceIds)),
    },
    excludedAdvances: {
      customerDeposits: valueWithSources(sumMoney(depositRows.map((row) => row.availableBalance)), depositRows.map((row) => row.sourceIds), { rows: depositRows }),
      supplierPrepayments: valueWithSources(sumMoney(prepaymentRows.map((row) => row.availableBalance)), prepaymentRows.map((row) => row.sourceIds), { rows: prepaymentRows }),
      reason: "客户预收和供应商预付单独管理，不进入普通应收应付账龄。",
    },
    excludedKinds: ["depositReceived", "prepaymentPaid"],
  };
}

function latestTaxConfirmation(workspace, period) {
  return [...(workspace.confirmations || [])]
    .filter((item) => item.period === period && item.kind === "tax")
    .sort((left, right) => String(left.updatedAt || left.createdAt || "").localeCompare(String(right.updatedAt || right.createdAt || "")))
    .at(-1) || null;
}

function explicitDueDate(tax, key) {
  return validDate(
    tax?.[key + "DueDate"]
    || tax?.dueDates?.[key]
    || tax?.paymentDueDates?.[key],
  );
}

function confirmedObligations(workspace, period, taxWorkpaper) {
  const tax = workspace.tax || {};
  const confirmation = latestTaxConfirmation(workspace, period);
  const approved = (section) => confirmation?.sections?.[section]?.status === "approved";
  const payrollConfirmed = Boolean(tax.payrollConfirmedAt || approved("payroll"));
  const socialSecurityConfirmed = Boolean(tax.socialSecurityConfirmedAt || approved("socialSecurity"));
  const taxConfirmed = Boolean(tax.taxConfirmedAt || tax.ownerConfirmedAt || approved("vat"));
  const payrollRecords = (workspace.payrollRecords || []).filter((record) => record.period === period && record.sourceKind === "payroll");
  const socialSecurityRecords = (workspace.payrollRecords || []).filter((record) => record.period === period && record.sourceKind === "socialSecurity");
  const hasCompleteNetSalary = payrollRecords.length > 0 && payrollRecords.every((record) => record.netSalary !== "" && record.netSalary != null && Number.isFinite(Number(record.netSalary)));
  const payrollCashAmount = hasCompleteNetSalary
    ? sumMoney(payrollRecords.map((record) => record.netSalary))
    : taxWorkpaper.payroll.value;
  const items = [
    {
      id: "confirmed-payroll",
      type: "payroll",
      label: "已确认工资",
      amount: roundMoney(tax.confirmedPayrollAmount ?? payrollCashAmount),
      dueDate: explicitDueDate(tax, "payroll"),
      confirmed: payrollConfirmed,
      sourceIds: collectSourceIds(taxWorkpaper.payroll.sourceIds, payrollRecords.map((record) => record.id), confirmation?.id, confirmation?.sections?.payroll?.sourceIds),
      basis: tax.confirmedPayrollAmount != null ? "已确认工资现金金额" : (hasCompleteNetSalary ? "结构化工资表实发工资" : "已确认工资金额"),
    },
    {
      id: "confirmed-social-security",
      type: "socialSecurity",
      label: "已确认社保",
      amount: roundMoney(tax.confirmedSocialSecurityAmount ?? taxWorkpaper.socialSecurity.value),
      dueDate: explicitDueDate(tax, "socialSecurity"),
      confirmed: socialSecurityConfirmed,
      sourceIds: collectSourceIds(taxWorkpaper.socialSecurity.sourceIds, socialSecurityRecords.map((record) => record.id), confirmation?.id, confirmation?.sections?.socialSecurity?.sourceIds),
      basis: tax.confirmedSocialSecurityAmount != null ? "已确认社保现金金额" : "已确认社保金额",
    },
    {
      id: "confirmed-tax",
      type: "tax",
      label: "已确认税款",
      amount: roundMoney(tax.confirmedTaxAmount ?? tax.taxPayable ?? taxWorkpaper.vatPayable.value),
      dueDate: explicitDueDate(tax, "tax"),
      confirmed: taxConfirmed,
      sourceIds: collectSourceIds(tax.confirmedTaxSourceIds || [], taxWorkpaper.vatPayable.sourceIds, confirmation?.id, confirmation?.sections?.vat?.sourceIds),
      basis: tax.confirmedTaxAmount != null ? "已确认税款金额" : (tax.taxPayable != null ? "税款应付金额" : "已确认增值税应交额"),
    },
  ];
  return items.filter((item) => item.confirmed && item.amount > 0.01);
}

function forecastEventFromBill(row, startDate) {
  const effectiveDate = row.dueDate < startDate ? startDate : row.dueDate;
  const isReceipt = row.kind === "receivable";
  return {
    id: "forecast-bill:" + row.billId,
    type: isReceipt ? "receivable" : "payable",
    label: (isReceipt ? "预计应收回款 · " : "到期应付 · ") + (row.counterparty || row.billNo || row.billId),
    date: effectiveDate,
    dueDate: row.dueDate,
    overdueAtStart: row.dueDate < startDate,
    amount: roundMoney(row.balance),
    cashEffect: isReceipt ? roundMoney(row.balance) : -roundMoney(row.balance),
    reference: row.billNo || row.billId,
    sourceIds: row.sourceIds,
  };
}

export function buildThirtyDayCashForecast(workspace, {
  period = workspace.currentPeriod,
  asOf = periodEndDate(period),
  startDate,
  days = 30,
  statements = buildFinancialStatements(workspace, { period }),
} = {}) {
  const resolvedAsOf = validDate(asOf) || periodEndDate(period);
  const resolvedStartDate = validDate(startDate) || addDays(resolvedAsOf, 1);
  const horizonDays = Math.max(1, Math.round(Number(days) || 30));
  const endDate = addDays(resolvedStartDate, horizonDays - 1);
  const ageing = buildReceivablePayableAgeing(workspace, { asOf: resolvedAsOf });
  const taxWorkpaper = buildTaxWorkpaper(workspace, { period });
  const bankAccounts = statements.ledger.accounts
    .filter((account) => account.account.cash)
    .map((account) => ({
      id: account.accountId,
      label: account.account.label,
      value: roundMoney(account.closing),
      sourceIds: collectSourceIds(account.accountId, account.sourceIds),
    }));
  const currentBalance = valueWithSources(
    sumMoney(bankAccounts.map((account) => account.value)),
    bankAccounts.map((account) => account.sourceIds),
    { accounts: bankAccounts, asOf: resolvedAsOf },
  );
  const billEvents = ageing.rows
    .filter((row) => row.dueDate && row.dueDate <= endDate)
    .map((row) => forecastEventFromBill(row, resolvedStartDate));
  const obligations = confirmedObligations(workspace, period, taxWorkpaper);
  const obligationEvents = obligations
    .filter((item) => item.dueDate && item.dueDate <= endDate)
    .map((item) => ({
      ...item,
      date: item.dueDate < resolvedStartDate ? resolvedStartDate : item.dueDate,
      overdueAtStart: item.dueDate < resolvedStartDate,
      cashEffect: -roundMoney(item.amount),
      reference: item.sourceIds.join("、") || "客户确认记录",
    }));
  const events = [...billEvents, ...obligationEvents].sort((left, right) => {
    const dateOrder = left.date.localeCompare(right.date);
    return dateOrder || left.id.localeCompare(right.id);
  });
  const missingSchedule = [
    ...ageing.missingDueDate.rows.map((row) => ({
      id: "forecast-missing-bill:" + row.billId,
      type: row.kind,
      label: (row.kind === "receivable" ? "应收缺少到期日 · " : "应付缺少到期日 · ") + (row.counterparty || row.billNo || row.billId),
      amount: roundMoney(row.balance),
      dueDate: null,
      sourceIds: row.sourceIds,
      reference: row.billNo || row.billId,
    })),
    ...obligations.filter((item) => !item.dueDate).map((item) => ({
      ...item,
      label: item.label + "缺少支付日期",
      reference: item.sourceIds.join("、") || "客户确认记录",
    })),
  ];
  const outsideHorizon = [
    ...ageing.rows.filter((row) => row.dueDate && row.dueDate > endDate).map((row) => ({
      id: "forecast-later-bill:" + row.billId,
      type: row.kind,
      label: (row.kind === "receivable" ? "远期应收 · " : "远期应付 · ") + (row.counterparty || row.billNo || row.billId),
      amount: roundMoney(row.balance),
      dueDate: row.dueDate,
      sourceIds: row.sourceIds,
      reference: row.billNo || row.billId,
    })),
    ...obligations.filter((item) => item.dueDate && item.dueDate > endDate),
  ];
  let balance = currentBalance.value;
  const runningSourceIds = [...currentBalance.sourceIds];
  const daily = Array.from({ length: horizonDays }, (_, index) => {
    const date = addDays(resolvedStartDate, index);
    const dayEvents = events.filter((event) => event.date === date);
    const openingBalance = balance;
    const receipts = sumMoney(dayEvents.filter((event) => event.cashEffect > 0).map((event) => event.cashEffect));
    const payments = sumMoney(dayEvents.filter((event) => event.cashEffect < 0).map((event) => Math.abs(event.cashEffect)));
    const netMovement = roundMoney(receipts - payments);
    balance = roundMoney(balance + netMovement);
    runningSourceIds.push(...dayEvents.flatMap((event) => event.sourceIds || []));
    return {
      date,
      openingBalance,
      receipts,
      payments,
      netMovement,
      closingBalance: balance,
      events: dayEvents,
      sourceIds: collectSourceIds(runningSourceIds),
    };
  });
  const weeks = [];
  for (let index = 0; index < daily.length; index += 7) {
    const rows = daily.slice(index, index + 7);
    const weekEvents = rows.flatMap((row) => row.events);
    weeks.push({
      id: "week-" + (weeks.length + 1),
      label: "第 " + (weeks.length + 1) + " 周",
      startDate: rows[0].date,
      endDate: rows.at(-1).date,
      openingBalance: rows[0].openingBalance,
      receipts: sumMoney(rows.map((row) => row.receipts)),
      payments: sumMoney(rows.map((row) => row.payments)),
      closingBalance: rows.at(-1).closingBalance,
      minimumBalance: Math.min(...rows.map((row) => row.closingBalance)),
      rows,
      events: weekEvents,
      sourceIds: collectSourceIds(rows.map((row) => row.sourceIds)),
    });
  }
  let minimumBalance = currentBalance.value;
  let minimumBalanceDate = resolvedAsOf;
  let minimumDayIndex = -1;
  daily.forEach((day, index) => {
    if (day.closingBalance < minimumBalance) {
      minimumBalance = day.closingBalance;
      minimumBalanceDate = day.date;
      minimumDayIndex = index;
    }
  });
  const deficitDay = currentBalance.value < 0
    ? { date: resolvedAsOf }
    : daily.find((day) => day.closingBalance < 0) || null;
  const eventsThroughMinimum = minimumDayIndex < 0
    ? []
    : daily.slice(0, minimumDayIndex + 1).flatMap((day) => day.events);
  const totalsForType = (type) => {
    const matching = events.filter((event) => event.type === type);
    return valueWithSources(sumMoney(matching.map((event) => event.amount)), matching.map((event) => event.sourceIds), { events: matching });
  };
  return {
    period,
    asOf: resolvedAsOf,
    startDate: resolvedStartDate,
    endDate,
    days: daily,
    weeks,
    events,
    currentBalance,
    minimumBalance: valueWithSources(minimumBalance, collectSourceIds(currentBalance.sourceIds, eventsThroughMinimum.map((event) => event.sourceIds)), {
      date: minimumBalanceDate,
      events: eventsThroughMinimum,
    }),
    cashShortfall: valueWithSources(Math.max(0, -minimumBalance), collectSourceIds(currentBalance.sourceIds, eventsThroughMinimum.map((event) => event.sourceIds)), {
      date: deficitDay?.date || null,
      events: eventsThroughMinimum,
    }),
    deficitDate: deficitDay?.date || null,
    totals: {
      receivable: totalsForType("receivable"),
      payable: totalsForType("payable"),
      payroll: totalsForType("payroll"),
      socialSecurity: totalsForType("socialSecurity"),
      tax: totalsForType("tax"),
    },
    missingSchedule,
    outsideHorizon,
    excludedAdvances: ageing.excludedAdvances,
    complete: missingSchedule.length === 0,
    formula: "当前银行余额 + 预计应收回款 − 到期应付 − 已确认工资 − 已确认社保 − 已确认税款",
  };
}

export function buildManagementMetrics(workspace, { period = workspace.currentPeriod, asOf = null } = {}) {
  const resolvedAsOf = validDate(asOf) || periodEndDate(period);
  const statements = buildFinancialStatements(workspace, { period });
  const ageing = buildReceivablePayableAgeing(workspace, { asOf: resolvedAsOf });
  const advances = buildAdvanceBalances(workspace);
  const storeReport = buildStoreManagementReport(workspace, { period, asOf: resolvedAsOf });
  const cashForecast = buildThirtyDayCashForecast(workspace, {
    period,
    asOf: resolvedAsOf,
    statements,
  });
  const postedCashReceipts = (statements.cashFlow.movements || []).filter((movement) => movement.amount > 0);
  const collections = valueWithSources(
    sumMoney(postedCashReceipts.map((movement) => movement.amount)),
    postedCashReceipts.map((movement) => movement.sourceIds),
    { voucherIds: collectSourceIds(postedCashReceipts.map((movement) => movement.voucherId)) },
  );
  const cashLine = valueWithSources(statements.cashFlow.closingCash.value, statements.cashFlow.closingCash.sourceIds);
  const receivableRows = ageing.rows.filter((row) => row.kind === "receivable");
  const payableRows = ageing.rows.filter((row) => row.kind === "payable");
  const duePayables = sumMoney(payableRows.map((row) => row.balance));
  const cashGap = Math.min(0, cashForecast.minimumBalance.value);
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
      { id: "cashGap", label: "未来现金缺口", ...valueWithSources(cashGap, cashForecast.cashShortfall.sourceIds, { date: cashForecast.deficitDate }) },
    ],
    statements,
    ageing,
    advances,
    storeReport,
    cashForecast,
  };
}

export const FROZEN_REPORT_EXCEL_SHEETS = Object.freeze([
  "资产负债表",
  "利润表",
  "现金流量表",
  "老板管理报表",
  "应收应付账龄",
  "30天现金预测",
  "来源明细",
]);

function frozenSnapshotRowSourceIds(row) {
  return collectSourceIds(
    row?.sourceIds || [],
    (row?.details || []).map((detail) => detail.sourceIds || []),
    (row?.details || []).map((detail) => detail.voucherId),
    (row?.details || []).map((detail) => detail.documentId),
  );
}

function sourceDescriptionIndex(workspace, { memberBusinessEnabled = true } = {}) {
  const index = new Map();
  const add = (items, type, summary) => (items || []).forEach((item) => {
    if (!item?.id) return;
    index.set(item.id, {
      type,
      summary: summary(item),
      date: item.date || item.createdAt || item.importedAt || "",
      amount: Number.isFinite(Number(item.amount)) ? Number(item.amount) : null,
    });
  });
  add(workspace.transactions, "银行流水", (item) => item.summary || item.counterparty || item.serial || item.id);
  add(workspace.vouchers, "会计凭证", (item) => `${item.no || item.id} ${item.summary || ""}`.trim());
  add(workspace.bills, "应收应付", (item) => `${item.no || item.billNo || item.id} ${item.counterparty || ""}`.trim());
  add(workspace.documents, "本地资料", (item) => item.name || item.id);
  add(
    workspace.businessEvents,
    memberBusinessEnabled ? "会员业务" : "业务事件",
    (item) => memberBusinessEnabled
      ? item.accountingLabel || item.memberName || item.summary || item.id
      : item.summary || item.counterparty || item.id,
  );
  add(workspace.payrollRecords, "工资社保记录", (item) => `${item.employeeName || "员工"} ${item.sourceFileName || item.sourceKind || ""}`.trim());
  add(workspace.invoices, "发票", (item) => item.invoiceNumber || item.name || item.id);
  add(workspace.confirmations, "客户确认", (item) => `${item.period || ""} ${item.kind || "确认"}`.trim());
  add(workspace.bankImports, "银行导入", (item) => item.fileName || item.accountName || item.id);
  add(workspace.bankAccounts, "银行账户", (item) => item.name || item.label || item.accountName || item.id);
  add(workspace.accounts, "银行账户", (item) => item.name || item.label || item.id);
  Object.keys(workspace.openingLedger || {}).forEach((accountId) => {
    index.set(accountId, { type: "期初余额", summary: accountDefinition(accountId, workspace).label, date: `${workspace.currentPeriod}-01`, amount: Number(workspace.openingLedger[accountId] || 0) });
  });
  return index;
}

function exportSheet(workspace, reportVersion, title, entries, widths, generatedAt) {
  const prefix = [
    { kind: "blank", values: [] },
    { kind: "title", values: [title] },
    { kind: "metadata", values: ["工作台", workspace.name || workspace.legalName || workspace.id || "未命名工作台"] },
    { kind: "metadata", values: ["期间", reportVersion.period] },
    { kind: "metadata", values: ["报表版本", reportVersion.label || reportVersion.id] },
    { kind: "metadata", values: ["生成时间", generatedAt] },
    { kind: "metadata", values: ["导出方式", "本地导出（未上传网络）"] },
    { kind: "blank", values: [] },
  ];
  const rows = [...prefix, ...entries];
  const sheet = XLSX.utils.aoa_to_sheet(rows.map((row) => row.values));
  sheet["!cols"] = widths.map((width) => ({ wch: width }));
  sheet["!rows"] = rows.map((row) => ({ hpt: row.kind === "title" ? 24 : row.kind === "blank" ? 8 : 18 }));
  sheet["!freeze"] = { xSplit: 0, ySplit: 8, topLeftCell: "A9", activePane: "bottomLeft", state: "frozen" };
  let activeHeaders = [];
  rows.forEach((row, rowIndex) => {
    if (row.kind === "header") activeHeaders = row.values;
    row.values.forEach((value, columnIndex) => {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = sheet[address];
      if (!cell) return;
      cell.s = {
        font: { name: "Arial", sz: 10, color: { rgb: "332720" } },
        alignment: { vertical: "center", wrapText: row.kind === "note" },
      };
      if (row.kind === "title") cell.s = { ...cell.s, font: { name: "Arial", sz: 15, bold: true, color: { rgb: "332720" } }, border: { bottom: { style: "thin", color: { rgb: "BDAF9D" } } } };
      if (row.kind === "metadata" && columnIndex === 0) cell.s.font = { name: "Arial", sz: 10, bold: true, color: { rgb: "6B5A4C" } };
      if (row.kind === "header") cell.s = { ...cell.s, font: { name: "Arial", sz: 10, bold: true, color: { rgb: "FFFFFF" } }, fill: { patternType: "solid", fgColor: { rgb: "5A3D32" } }, alignment: { horizontal: "center", vertical: "center", wrapText: true } };
      if (row.kind === "section") cell.s = { ...cell.s, font: { name: "Arial", sz: 10, bold: true, color: { rgb: "43533F" } }, fill: { patternType: "solid", fgColor: { rgb: "E6EEE1" } } };
      if (row.kind === "total") cell.s.font = { name: "Arial", sz: 10, bold: true, color: { rgb: "332720" } };
      if (typeof value === "number") {
        const header = String(activeHeaders[columnIndex] || "");
        cell.z = /数量|笔数|天数|来源数/.test(header) ? "#,##0" : "¥#,##0.00;(¥#,##0.00);-";
        cell.s.alignment = { ...cell.s.alignment, horizontal: "right" };
      }
    });
  });
  return sheet;
}

function safeWorkbookFileName(value) {
  return String(value || "财务工作台").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
}

function validateFrozenReportExcelRequest(workspace, { reportVersion, currentSourceFingerprint } = {}) {
  if (!reportVersion?.id || !reportVersion.snapshot) throw new AccountingRuleError("FROZEN_REPORT_REQUIRED", "请先冻结当前报表版本，再导出 Excel");
  if (reportVersion.period !== workspace.currentPeriod) throw new AccountingRuleError("REPORT_PERIOD_MISMATCH", "只能导出当前期间的冻结报表");
  const latestVersion = (workspace.delivery?.reportVersions || []).find((item) => item.period === workspace.currentPeriod);
  if (!latestVersion || latestVersion.id !== reportVersion.id) throw new AccountingRuleError("REPORT_VERSION_NOT_CURRENT", "只能导出当前最新冻结报表版本");
  if (!reportVersion.sourceFingerprint || currentSourceFingerprint !== reportVersion.sourceFingerprint) {
    throw new AccountingRuleError("REPORT_VERSION_STALE", "当前数据已变化，请重新冻结报表后再导出 Excel");
  }
  return reportVersion;
}

export function buildFrozenReportExcelWorkbook(workspace, {
  reportVersion,
  currentSourceFingerprint,
  generatedAt = new Date().toISOString(),
} = {}) {
  const version = validateFrozenReportExcelRequest(workspace, { reportVersion, currentSourceFingerprint });
  const memberBusinessEnabled = reportMemberBusinessEnabled(workspace);
  const snapshot = version.snapshot;
  const management = buildManagementMetrics(workspace, { period: workspace.currentPeriod });
  const sourceIndex = sourceDescriptionIndex(workspace, { memberBusinessEnabled });
  const metricSources = [];
  const addMetric = (sheetName, metricId, label, value, sourceIds, unit = "CNY") => {
    const ids = collectSourceIds(sourceIds);
    metricSources.push({ sheetName, metricId, label, value: Number(value || 0), unit, sourceIds: ids.length ? ids : [version.id] });
    return Number(value || 0);
  };
  const workbook = XLSX.utils.book_new();
  workbook.Props = {
    Title: `${workspace.name || "财务工作台"} ${version.period} 本地财务报表`,
    Subject: `${version.label || version.id} 冻结版本，本地导出，未上传网络`,
    Author: "FinanceDesk",
    CreatedDate: new Date(generatedAt),
  };

  [
    ["资产负债表", snapshot.sections.balance],
    ["利润表", snapshot.sections.income],
    ["现金流量表", snapshot.sections.cashflow],
  ].forEach(([sheetName, section]) => {
    const entries = [
      { kind: "header", values: ["项目", "金额", "计算口径", "来源数"] },
      ...(section?.rows || []).map((row) => {
        const sourceIds = frozenSnapshotRowSourceIds(row);
        const isTotal = /(合计|利润|净增加|期末)/.test(row.label);
        return {
          kind: isTotal ? "total" : "data",
          values: [row.label, addMetric(sheetName, row.id, row.label, row.value, sourceIds), row.formula || "冻结报表明细汇总", sourceIds.length || 1],
        };
      }),
    ];
    XLSX.utils.book_append_sheet(workbook, exportSheet(workspace, version, sheetName, entries, [26, 18, 42, 11], generatedAt), sheetName);
  });

  const storeMetrics = [
    ["collections", "本期收款"],
    ["recognizedRevenue", "确认收入"],
    ["refunds", "退款"],
    ["coachCommission", memberBusinessEnabled ? "教练提成" : "业务提成"],
    ["grossProfit", "毛利"],
    ["unfulfilledBalance", "预收 / 未履约"],
  ];
  const ownerEntries = [
    { kind: "section", values: ["冻结老板报表"] },
    { kind: "header", values: ["项目", "金额", "计算口径", "来源数"] },
    ...(snapshot.sections.owner?.rows || []).map((row) => {
      const sourceIds = frozenSnapshotRowSourceIds(row);
      return { kind: /(利润|余额|缺口)/.test(row.label) ? "total" : "data", values: [row.label, addMetric("老板管理报表", `owner:${row.id}`, row.label, row.value, sourceIds), row.formula || "冻结管理报表汇总", sourceIds.length || 1] };
    }),
    ...(memberBusinessEnabled ? [
      { kind: "blank", values: [] },
      { kind: "section", values: ["门店经营汇总"] },
      { kind: "header", values: ["门店", ...storeMetrics.map(([, label]) => label), "来源数"] },
      { kind: "total", values: ["全部门店", ...storeMetrics.map(([id, label]) => addMetric("老板管理报表", `store-total:${id}`, `全部门店 ${label}`, management.storeReport.totals[id], management.storeReport.sourceIds)), management.storeReport.sourceIds.length] },
      ...management.storeReport.stores.map((store) => ({
        kind: "data",
        values: [store.name, ...storeMetrics.map(([id, label]) => addMetric("老板管理报表", `store:${store.id}:${id}`, `${store.name} ${label}`, store.metrics[id], store.sourceIds)), store.sourceIds.length],
      })),
      { kind: "note", values: ["入账覆盖", `本期已入账 ${management.storeReport.postingCoverage.postedEventCount} / 已确认 ${management.storeReport.postingCoverage.recognizedEventCount} 笔业务；未入账业务不进入本表。`] },
    ] : []),
  ];
  XLSX.utils.book_append_sheet(workbook, exportSheet(workspace, version, "老板管理报表", ownerEntries, [25, 16, 16, 16, 16, 16, 18, 11], generatedAt), "老板管理报表");

  const ageing = management.ageing;
  const ageingEntries = [
    { kind: "section", values: [`截至 ${ageing.asOf} 的账龄汇总`] },
    { kind: "header", values: ["账龄", "应收", "应付", "笔数", "全部 sourceIds"] },
    ...ageing.buckets.map((bucket) => ({
      kind: "data",
      values: [bucket.label, addMetric("应收应付账龄", `bucket:${bucket.id}:receivable`, `${bucket.label} 应收`, bucket.receivable.value, bucket.receivable.sourceIds), addMetric("应收应付账龄", `bucket:${bucket.id}:payable`, `${bucket.label} 应付`, bucket.payable.value, bucket.payable.sourceIds), bucket.rows.length, JSON.stringify(bucket.sourceIds || [])],
    })),
    { kind: "total", values: ["账龄合计", addMetric("应收应付账龄", "ageing:receivable", "应收合计", ageing.receivable.value, ageing.receivable.sourceIds), addMetric("应收应付账龄", "ageing:payable", "应付合计", ageing.payable.value, ageing.payable.sourceIds), ageing.rows.length, JSON.stringify(collectSourceIds(ageing.receivable.sourceIds, ageing.payable.sourceIds))] },
    { kind: "data", values: ["缺少到期日", addMetric("应收应付账龄", "missing:receivable", "缺少到期日应收", ageing.missingDueDate.receivable.value, ageing.missingDueDate.receivable.sourceIds), addMetric("应收应付账龄", "missing:payable", "缺少到期日应付", ageing.missingDueDate.payable.value, ageing.missingDueDate.payable.sourceIds), ageing.missingDueDate.rows.length, JSON.stringify(ageing.missingDueDate.sourceIds || [])] },
    { kind: "blank", values: [] },
    { kind: "section", values: ["普通应收应付明细"] },
    { kind: "header", values: ["类型", "对方", "单据号", "到期日", "逾期天数", "余额", "全部 sourceIds"] },
    ...ageing.rows.map((row) => ({ kind: "data", values: [row.kind === "receivable" ? "应收" : "应付", row.counterparty || "", row.billNo || row.billId, row.dueDate || "缺少到期日", row.daysOverdue ?? "", row.balance, JSON.stringify(row.sourceIds || [])] })),
    { kind: "blank", values: [] },
    { kind: "section", values: ["预收预付单列"] },
    { kind: "header", values: ["项目", "金额", "说明", "全部 sourceIds"] },
    { kind: "data", values: ["客户预收", addMetric("应收应付账龄", "advance:deposits", "客户预收", ageing.excludedAdvances.customerDeposits.value, ageing.excludedAdvances.customerDeposits.sourceIds), ageing.excludedAdvances.reason, JSON.stringify(ageing.excludedAdvances.customerDeposits.sourceIds || [])] },
    { kind: "data", values: ["供应商预付", addMetric("应收应付账龄", "advance:prepayments", "供应商预付", ageing.excludedAdvances.supplierPrepayments.value, ageing.excludedAdvances.supplierPrepayments.sourceIds), ageing.excludedAdvances.reason, JSON.stringify(ageing.excludedAdvances.supplierPrepayments.sourceIds || [])] },
  ];
  XLSX.utils.book_append_sheet(workbook, exportSheet(workspace, version, "应收应付账龄", ageingEntries, [18, 22, 22, 16, 12, 18, 54], generatedAt), "应收应付账龄");

  const forecast = management.cashForecast;
  const forecastEntries = [
    { kind: "section", values: [`${forecast.startDate} 至 ${forecast.endDate}`] },
    { kind: "header", values: ["项目", "金额", "日期 / 口径", "全部 sourceIds"] },
    { kind: "data", values: ["当前银行余额", addMetric("30天现金预测", "forecast:current", "当前银行余额", forecast.currentBalance.value, forecast.currentBalance.sourceIds), forecast.asOf, JSON.stringify(forecast.currentBalance.sourceIds || [])] },
    { kind: "data", values: ["最低预测余额", addMetric("30天现金预测", "forecast:minimum", "最低预测余额", forecast.minimumBalance.value, forecast.minimumBalance.sourceIds), forecast.minimumBalance.date, JSON.stringify(forecast.minimumBalance.sourceIds || [])] },
    { kind: "total", values: ["现金缺口", addMetric("30天现金预测", "forecast:shortfall", "现金缺口", forecast.cashShortfall.value, forecast.cashShortfall.sourceIds), forecast.deficitDate || "预测期内无缺口", JSON.stringify(forecast.cashShortfall.sourceIds || [])] },
    { kind: "note", values: ["计算口径", forecast.formula] },
    { kind: "blank", values: [] },
    { kind: "section", values: ["预计收支汇总"] },
    { kind: "header", values: ["项目", "金额", "来源数", "全部 sourceIds"] },
    ...Object.entries({ receivable: "预计应收回款", payable: "到期应付", payroll: "已确认工资", socialSecurity: "已确认社保", tax: "已确认税款" }).map(([id, label]) => ({ kind: "data", values: [label, addMetric("30天现金预测", `forecast-total:${id}`, label, forecast.totals[id].value, forecast.totals[id].sourceIds), forecast.totals[id].sourceIds.length, JSON.stringify(forecast.totals[id].sourceIds || [])] })),
    { kind: "blank", values: [] },
    { kind: "section", values: ["周度预测"] },
    { kind: "header", values: ["周期", "开始日", "结束日", "预计流入", "预计流出", "最低余额", "期末余额", "全部 sourceIds"] },
    ...forecast.weeks.map((week) => ({ kind: "data", values: [week.label, week.startDate, week.endDate, addMetric("30天现金预测", `${week.id}:receipts`, `${week.label} 预计流入`, week.receipts, week.sourceIds), addMetric("30天现金预测", `${week.id}:payments`, `${week.label} 预计流出`, week.payments, week.sourceIds), addMetric("30天现金预测", `${week.id}:minimum`, `${week.label} 最低余额`, week.minimumBalance, week.sourceIds), addMetric("30天现金预测", `${week.id}:closing`, `${week.label} 期末余额`, week.closingBalance, week.sourceIds), JSON.stringify(week.sourceIds || [])] })),
    { kind: "blank", values: [] },
    { kind: "section", values: ["每日预测"] },
    { kind: "header", values: ["日期", "期初余额", "预计流入", "预计流出", "净变动", "期末余额", "全部 sourceIds"] },
    ...forecast.days.map((day) => ({ kind: "data", values: [day.date, day.openingBalance, day.receipts, day.payments, day.netMovement, day.closingBalance, JSON.stringify(day.sourceIds || [])] })),
    ...(forecast.missingSchedule.length ? [
      { kind: "blank", values: [] },
      { kind: "section", values: ["缺少预测日期"] },
      { kind: "header", values: ["项目", "类型", "金额", "参考", "全部 sourceIds"] },
      ...forecast.missingSchedule.map((item) => ({ kind: "data", values: [item.label, item.type, item.amount, item.reference || "", JSON.stringify(item.sourceIds || [])] })),
    ] : []),
  ];
  XLSX.utils.book_append_sheet(workbook, exportSheet(workspace, version, "30天现金预测", forecastEntries, [20, 16, 16, 16, 16, 16, 18, 54], generatedAt), "30天现金预测");

  const sourceEntries = [
    { kind: "note", values: ["说明", "每个汇总数字至少保留一行，并在“全部 sourceIds”列保存完整 JSON 数组；没有直接业务来源时绑定当前冻结报表版本。"] },
    { kind: "header", values: ["工作表", "指标 ID", "汇总项目", "汇总值", "单位", "全部 sourceIds", "单一 sourceId", "来源类型", "来源摘要", "来源日期", "来源金额"] },
    ...metricSources.flatMap((metric) => metric.sourceIds.map((sourceId) => {
      const source = sourceIndex.get(sourceId) || { type: sourceId === version.id ? "冻结报表版本" : "本地来源引用", summary: sourceId === version.id ? `${version.label || version.id} 冻结版本` : sourceId, date: "", amount: null };
      return { kind: "data", values: [metric.sheetName, metric.metricId, metric.label, metric.value, metric.unit, JSON.stringify(metric.sourceIds), sourceId, source.type, source.summary, source.date, source.amount ?? ""] };
    })),
  ];
  XLSX.utils.book_append_sheet(workbook, exportSheet(workspace, version, "来源明细", sourceEntries, [18, 30, 28, 18, 10, 58, 30, 16, 42, 16, 18], generatedAt), "来源明细");

  const fileName = `${safeWorkbookFileName(workspace.name || "财务工作台")}-${version.period}-${safeWorkbookFileName(version.label || version.id)}-本地财务报表.xlsx`;
  return {
    workbook,
    metadata: {
      fileName,
      generatedAt,
      reportVersionId: version.id,
      reportVersionLabel: version.label || version.id,
      period: version.period,
      sourceFingerprint: version.sourceFingerprint,
      sheetNames: [...workbook.SheetNames],
      metricCount: metricSources.length,
      localOnly: true,
      uploaded: false,
    },
  };
}

export async function exportFrozenReportExcel(workspace, options = {}) {
  const { workbook, metadata } = buildFrozenReportExcelWorkbook(workspace, options);
  const output = XLSX.write(workbook, { bookType: "xlsx", type: "array", cellStyles: true, compression: true });
  const bytes = output instanceof Uint8Array ? output : new Uint8Array(output);
  const digest = globalThis.crypto?.subtle ? await globalThis.crypto.subtle.digest("SHA-256", bytes) : null;
  const hash = digest ? [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") : null;
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = metadata.fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return { ...metadata, size: blob.size, hash };
}

export function recordFrozenReportExcelExport(workspace, metadata, context = {}) {
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const version = (next.delivery?.reportVersions || []).find((item) => item.period === next.currentPeriod);
  if (!version || version.id !== metadata?.reportVersionId || version.sourceFingerprint !== metadata?.sourceFingerprint) {
    throw new AccountingRuleError("REPORT_EXPORT_VERSION_MISMATCH", "报表版本已变化，不能写入旧 Excel 导出记录");
  }
  const record = {
    id: nextRecordId(next.delivery.reportExports || [], "report-excel-export"),
    kind: "xlsx",
    period: metadata.period,
    reportVersionId: metadata.reportVersionId,
    reportVersionLabel: metadata.reportVersionLabel,
    sourceFingerprint: metadata.sourceFingerprint,
    fileName: metadata.fileName,
    sheetNames: metadata.sheetNames || [],
    metricCount: Number(metadata.metricCount || 0),
    size: Number(metadata.size || 0),
    hash: metadata.hash || null,
    exportedAt: metadata.generatedAt || resolvedContext.at,
    localOnly: true,
    uploaded: false,
  };
  next.delivery.reportExports = [record, ...(next.delivery.reportExports || [])];
  appendAuditEntry(next, {
    action: "report.excel_export",
    entityType: "reportVersion",
    entityId: version.id,
    detail: `${record.fileName} · ${record.sheetNames.length} 个工作表 · 仅本地下载，未上传网络`,
    after: { exportId: record.id, fileName: record.fileName, localOnly: true, uploaded: false },
    sourceIds: collectSourceIds(version.id, version.sourceIds),
  }, resolvedContext);
  return next;
}

export function buildTaxWorkpaper(workspace, { period = workspace.currentPeriod } = {}) {
  const statements = buildFinancialStatements(workspace, { period });
  const vatRate = Number(workspace.tax?.vatRate ?? 0.03);
  const surtaxRate = Number(workspace.tax?.surtaxRate ?? 0.12);
  const incomeTaxRate = Number(workspace.tax?.incomeTaxRate ?? 0.05);
  const taxableRevenue = statements.incomeStatement.netRevenue;
  const adjustments = valueWithSources(Number(workspace.tax?.adjustments || 0), workspace.tax?.adjustmentSourceIds || []);
  const taxableBase = valueWithSources(
    Math.max(0, roundMoney(taxableRevenue.value + adjustments.value)),
    collectSourceIds(taxableRevenue.sourceIds, adjustments.sourceIds),
  );
  const outputVat = valueWithSources(roundMoney(taxableBase.value * vatRate), taxableBase.sourceIds);
  const taxInputAccounts = statements.ledger.accounts.filter((item) => String(item.accountId).startsWith("taxInput"));
  const inputVat = valueWithSources(sumMoney(taxInputAccounts.map((item) => item.debit - item.credit)), taxInputAccounts.map((item) => item.sourceIds));
  const vatPayable = valueWithSources(Math.max(0, roundMoney(outputVat.value - inputVat.value)), collectSourceIds(outputVat.sourceIds, inputVat.sourceIds));
  const estimatedSurtax = valueWithSources(roundMoney(vatPayable.value * surtaxRate), vatPayable.sourceIds);
  const estimatedIncomeTax = valueWithSources(
    roundMoney(Math.max(0, statements.incomeStatement.profit.value) * incomeTaxRate),
    statements.incomeStatement.profit.sourceIds,
  );
  const estimatedTax = valueWithSources(
    roundMoney(vatPayable.value + estimatedSurtax.value + estimatedIncomeTax.value),
    collectSourceIds(vatPayable.sourceIds, estimatedSurtax.sourceIds, estimatedIncomeTax.sourceIds),
  );
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
    vatRate,
    surtaxRate,
    incomeTaxRate,
    outputVat,
    inputVat,
    vatPayable,
    estimatedSurtax,
    estimatedIncomeTax,
    estimatedTax,
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
