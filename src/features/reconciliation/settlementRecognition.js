import {
  AccountingRuleError, accountDefinition, appendAuditEntry, collectSourceIds, operationContext, roundMoney, sumMoney, workspaceAccountDefinitions,
} from "../../domain/accounting/model.js";
import { activateWorkspacePeriod, isPeriodArchived, openingBalancesReady } from "../../domain/periods.js";

const ordinaryKinds = ["receivable", "payable"];
export function settlementPeriodEnd(period) {
  const [year, month] = String(period).split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function settlementBillIsEffective(bill, asOf) {
  return !["inactive", "cancelled", "canceled", "void", "voided", "invalidated", "rejected", "deleted"].includes(bill.status)
    && Boolean(bill.date) && (!asOf || String(bill.date).slice(0, 10) <= asOf);
}

export function settlementRecordIsEffective(record, asOf, date) {
  const reversalDate = record.reversalEffectiveDate || record.reversedAt;
  const reversedLater = record.status === "reversed" && asOf && reversalDate && reversalDate.slice(0, 10) > asOf;
  if (!["confirmed", "posted"].includes(record.status) && !reversedLater) return false;
  return !asOf || Boolean(date && String(date).slice(0, 10) <= asOf);
}

export function settlementTransactionIsEffective(transaction, asOf) {
  return !["void", "voided", "invalidated", "rejected", "cancelled", "canceled", "deleted"].includes(transaction.status)
    && (!asOf || Boolean(transaction.date && transaction.date <= asOf));
}

export function settlementAccountRole(workspace, accountId) {
  const account = accountDefinition(accountId, workspace);
  if (account.cash) return null;
  const role = account.settlementRole || account.systemKey || String(accountId || "").split(":")[0];
  return ordinaryKinds.includes(role) ? role : null;
}

// Resolve explicit IDs only. A shared counterparty or contract never proves which
// instalment a voucher confirms.
export function settlementSourceBillIds(workspace, ids) {
  const knownBills = new Set((workspace.bills || []).map((bill) => bill.id));
  const sources = collectSourceIds(ids);
  const billIds = sources.filter((id) => knownBills.has(id));
  const related = [
    ...(workspace.businessEvents || []), ...(workspace.invoices || []),
    ...(workspace.advanceApplications || []),
    ...(workspace.transactions || []).flatMap((transaction) => transaction.allocations || []),
  ];
  for (const record of related) if (sources.includes(record.id)) {
    billIds.push(...[record.billId, record.relatedBillId, record.targetBillId].filter((id) => knownBills.has(id)));
  }
  return collectSourceIds(billIds);
}

export function settlementLineShares(workspace, voucher, line) {
  const role = settlementAccountRole(workspace, line.account);
  const linked = (workspace.billRecognitionLinks || []).filter((link) => link.voucherId === voucher.id && link.lineIndex === (voucher.lines || []).indexOf(line));
  if (linked.length) return linked.map(({ billId, amount }) => ({ billId, amount }));
  const lineIds = collectSourceIds(line.sourceIds, line.billId);
  let billIds = settlementSourceBillIds(workspace, lineIds);
  if (!billIds.length) billIds = settlementSourceBillIds(workspace, collectSourceIds(
    voucher.sourceIds, voucher.relatedSourceIds, voucher.relatedSources?.map((source) => source.id),
    voucher.sourceReferences?.map((source) => source.id), voucher.memberEventId, voucher.bankBusinessEventId, voucher.advanceApplicationId,
  ));
  const bills = (workspace.bills || []).filter((bill) => billIds.includes(bill.id) && (!role || bill.kind === role));
  const amount = Math.abs(roundMoney(Number(line.debit || 0) - Number(line.credit || 0)));
  if (!bills.length || amount <= 0.01) return [];
  if (bills.length === 1) return [{ billId: bills[0].id, amount }];
  const allocations = (voucher.reconciliationSources || []).length ? voucher.reconciliationSources
    : (workspace.transactions || []).flatMap((transaction) => (transaction.allocations || [])
      .filter((allocation) => collectSourceIds(lineIds, voucher.sourceIds).includes(allocation.id)));
  const shares = bills.map((bill) => ({ billId: bill.id, amount: sumMoney(allocations.filter((allocation) => allocation.billId === bill.id).map((allocation) => allocation.amount)) }));
  if (Math.abs(sumMoney(shares.map((share) => share.amount)) - amount) <= 0.01) return shares;
  if (Math.abs(sumMoney(bills.map((bill) => bill.amount)) - amount) <= 0.01) return bills.map((bill) => ({ billId: bill.id, amount: roundMoney(bill.amount) }));
  return bills.map((bill) => ({ billId: bill.id, amount: null }));
}

function settledBefore(workspace, billId, date) {
  const cutoff = new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const cash = (workspace.transactions || []).flatMap((transaction) => (transaction.allocations || [])
    .filter((allocation) => allocation.billId === billId && transaction.date < date
      && settlementTransactionIsEffective(transaction, cutoff)
      && settlementRecordIsEffective(allocation, cutoff, allocation.date || transaction.date)));
  const advance = (workspace.advanceApplications || []).filter((application) => application.targetBillId === billId
    && (application.date || application.createdAt?.slice(0, 10)) < date
    && settlementRecordIsEffective(application, cutoff, application.date || application.createdAt?.slice(0, 10)));
  return sumMoney([...cash, ...advance].map((record) => record.amount));
}

export function buildSettlementLedgerCheck(workspace, { period = workspace.currentPeriod, asOf = settlementPeriodEnd(period) } = {}) {
  if (workspace.currentPeriod !== period) workspace = activateWorkspacePeriod(workspace, period);
  const recognition = buildSettlementRecognition(workspace, { asOf });
  const nextDay = new Date(Date.parse(`${asOf}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const rows = ordinaryKinds.map((kind) => {
    const bills = (workspace.bills || []).filter((bill) => bill.kind === kind && settlementBillIsEffective(bill, asOf));
    const detailAmount = sumMoney(bills.map((bill) => Math.max(0, roundMoney(bill.amount - settledBefore(workspace, bill.id, nextDay)))));
    const sign = kind === "payable" ? -1 : 1;
    const opening = sumMoney(Object.entries(workspace.openingLedger || {}).filter(([account]) => settlementAccountRole(workspace, account) === kind).map(([, amount]) => amount * sign));
    const vouchers = (workspace.vouchers || []).filter((voucher) => voucher.status === "posted" && voucher.date >= `${period}-01` && voucher.date <= asOf);
    const ledgerAmount = roundMoney(opening + sumMoney(vouchers.flatMap((voucher) => (voucher.lines || []).filter((line) => settlementAccountRole(workspace, line.account) === kind)
      .map((line) => (Number(line.debit || 0) - Number(line.credit || 0)) * sign))));
    const difference = roundMoney(ledgerAmount - detailAmount);
    return { kind, ledgerAmount, detailAmount, difference, passed: Math.abs(difference) <= 0.01,
      sourceIds: collectSourceIds(bills.map((bill) => bill.id), vouchers.filter((voucher) => (voucher.lines || []).some((line) => settlementAccountRole(workspace, line.account) === kind)).map((voucher) => voucher.id)) };
  });
  const unrecognized = recognition.rows.filter((row) => row.unrecognizedAmount > 0.01 || row.ambiguous);
  const passed = rows.every((row) => row.passed) && !unrecognized.length;
  return { passed, applicable: rows.some((row) => row.sourceIds.length || row.ledgerAmount), asOf, rows, unrecognized,
    difference: sumMoney(rows.map((row) => Math.abs(row.difference))),
    detail: passed ? "应收应付明细与总账一致" : "应收应付明细与总账待核对，请到往来账单关联原确认凭证或核对期初余额；核销只结转往来，不确认收入费用。",
    sourceIds: collectSourceIds(rows.map((row) => row.sourceIds)) };
}

export function buildSettlementRecognition(workspace, { asOf = settlementPeriodEnd(workspace.currentPeriod), excludeVoucherIds = [] } = {}) {
  const period = asOf.slice(0, 7);
  if (workspace.currentPeriod !== period) workspace = activateWorkspacePeriod(workspace, period);
  const start = `${period}-01`;
  const bills = (workspace.bills || []).filter((bill) => ordinaryKinds.includes(bill.kind) && settlementBillIsEffective(bill, asOf))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));
  const rows = bills.map((bill) => ({
    billId: bill.id, kind: bill.kind, amount: roundMoney(bill.amount), openingAmount: 0,
    recognizedAmount: 0, postedSettlementAmount: 0, sourceIds: [bill.id], ambiguous: false,
  }));
  const byId = new Map(rows.map((row) => [row.billId, row]));
  const posted = (workspace.vouchers || []).filter((voucher) => voucher.status === "posted"
    && voucher.date >= start && voucher.date <= asOf && !excludeVoucherIds.includes(voucher.id));
  for (const voucher of posted) for (const line of voucher.lines || []) {
    const role = settlementAccountRole(workspace, line.account);
    if (!role) continue;
    const net = roundMoney((Number(line.debit || 0) - Number(line.credit || 0)) * (role === "payable" ? -1 : 1));
    for (const share of settlementLineShares(workspace, voucher, line)) {
      const row = byId.get(share.billId);
      if (!row) continue;
      row.sourceIds = collectSourceIds(row.sourceIds, voucher.id, line.sourceIds);
      if (share.amount == null) { row.ambiguous = true; continue; }
      if (net > 0) row.recognizedAmount = roundMoney(row.recognizedAmount + share.amount);
      else row.postedSettlementAmount = roundMoney(row.postedSettlementAmount + share.amount);
    }
  }
  // Opening balances are one shared pool, never a full allowance per bill.
  for (const kind of ordinaryKinds) {
    let pool = openingBalancesReady(workspace) ? Math.max(0, sumMoney(Object.entries(workspace.openingLedger || {})
      .filter(([account]) => settlementAccountRole(workspace, account) === kind)
      .map(([, amount]) => Number(amount) * (kind === "payable" ? -1 : 1)))) : 0;
    for (const bill of bills.filter((item) => item.kind === kind && (item.date < start || item.recognitionBasis === "opening"))) {
      const row = byId.get(bill.id);
      const need = Math.max(0, roundMoney(bill.amount - settledBefore(workspace, bill.id, start) - row.recognizedAmount));
      row.openingAmount = Math.min(pool, need);
      pool = roundMoney(pool - row.openingAmount);
      row.recognizedAmount = roundMoney(row.recognizedAmount + row.openingAmount);
      if (row.openingAmount) row.sourceIds.push(`opening:${period}:${kind}`);
    }
  }
  for (const row of rows) {
    row.availableAmount = Math.max(0, roundMoney(row.recognizedAmount - row.postedSettlementAmount));
    const bill = bills.find((item) => item.id === row.billId);
    const alreadyBefore = settledBefore(workspace, bill.id, start);
    row.unrecognizedAmount = Math.max(0, roundMoney(row.amount - alreadyBefore - row.recognizedAmount));
  }
  return { asOf, rows, sourceIds: collectSourceIds(rows.map((row) => row.sourceIds)) };
}

export function assessSettlementRecognition(workspace, voucher, { asOf = voucher.date } = {}) {
  const recognition = buildSettlementRecognition(workspace, { asOf, excludeVoucherIds: collectSourceIds(voucher.id, voucher.revisionOf) });
  const requested = new Map();
  const issues = [];
  for (const line of voucher.lines || []) {
    const kind = settlementAccountRole(workspace, line.account);
    const amount = kind === "receivable" ? Number(line.credit || 0) - Number(line.debit || 0)
      : kind === "payable" ? Number(line.debit || 0) - Number(line.credit || 0) : 0;
    if (amount <= 0.01) continue;
    for (const share of settlementLineShares(workspace, voucher, line)) {
      if (share.amount == null) issues.push({ code: "BILL_SHARE_REQUIRED", billId: share.billId, message: "合并往来分录缺少各账单金额，请按账单拆分分录或关联准确的核销来源", sourceIds: [share.billId] });
      else requested.set(share.billId, roundMoney((requested.get(share.billId) || 0) + share.amount));
    }
  }
  const rows = [...requested].map(([billId, requiredAmount]) => {
    const row = recognition.rows.find((item) => item.billId === billId) || { billId, recognizedAmount: 0, postedSettlementAmount: 0, availableAmount: 0, sourceIds: [billId] };
    const ownConfirmation = sumMoney((voucher.lines || []).filter((line) => {
      const role = settlementAccountRole(workspace, line.account);
      return role && (Number(line.debit || 0) - Number(line.credit || 0)) * (role === "payable" ? -1 : 1) > 0.01;
    }).flatMap((line) => settlementLineShares(workspace, voucher, line)).filter((share) => share.billId === billId && share.amount != null).map((share) => share.amount));
    const shortfall = Math.max(0, roundMoney(requiredAmount - row.availableAmount - ownConfirmation));
    if (shortfall > 0.01 || row.ambiguous) issues.push({ code: "BILL_RECOGNITION_REQUIRED", billId, message: `账单 ${billId} 的往来确认尚有 ¥${shortfall.toFixed(2)} 待核对。请在往来账单中关联原确认凭证，或按真实业务补确认；期初往来请核对本期期初余额。`, sourceIds: row.sourceIds });
    return { ...row, requiredAmount, shortfall };
  });
  return { passed: !issues.length, applicable: Boolean(rows.length || issues.length), asOf, rows, issues, sourceIds: collectSourceIds(rows.map((row) => row.sourceIds), issues.map((issue) => issue.sourceIds)) };
}

export function buildBillRecognitionOptions(workspace, billId) {
  const bill = (workspace.bills || []).find((item) => item.id === billId);
  if (!bill || !ordinaryKinds.includes(bill.kind)) return [];
  return (workspace.vouchers || []).filter((voucher) => voucher.status === "posted" && voucher.date?.startsWith(workspace.currentPeriod))
    .flatMap((voucher) => (voucher.lines || []).flatMap((line, lineIndex) => {
      if (settlementAccountRole(workspace, line.account) !== bill.kind) return [];
      const amount = roundMoney((Number(line.debit || 0) - Number(line.credit || 0)) * (bill.kind === "payable" ? -1 : 1));
      if (amount <= 0.01) return [];
      const direct = settlementSourceBillIds(workspace, collectSourceIds(line.sourceIds, voucher.sourceIds, voucher.relatedSourceIds));
      if (direct.length) return [];
      const used = sumMoney((workspace.billRecognitionLinks || []).filter((link) => link.voucherId === voucher.id && link.lineIndex === lineIndex).map((link) => link.amount));
      const availableAmount = roundMoney(amount - used);
      return availableAmount > 0.01 ? [{ id: `${voucher.id}:${lineIndex}`, voucherId: voucher.id, lineIndex, availableAmount, label: `${voucher.date} · ${voucher.no || voucher.id} · ${voucher.summary} · 可关联 ¥${availableAmount.toFixed(2)}` }] : [];
    }));
}

export function linkBillRecognitionVoucher(workspace, { billId, voucherId, lineIndex, amount }, context = {}) {
  if (isPeriodArchived(workspace)) throw new AccountingRuleError("PERIOD_ARCHIVED", "已归档账期只能查看");
  const bill = (workspace.bills || []).find((item) => item.id === billId);
  if (!bill || !settlementBillIsEffective(bill, settlementPeriodEnd(workspace.currentPeriod))) throw new AccountingRuleError("BILL_NOT_EFFECTIVE", "请选择已经发生的有效账单");
  const option = buildBillRecognitionOptions(workspace, billId).find((item) => item.voucherId === voucherId && item.lineIndex === Number(lineIndex));
  const unrecognized = buildSettlementRecognition(workspace).rows.find((row) => row.billId === billId)?.unrecognizedAmount || 0;
  const value = roundMoney(amount);
  if (!option || !Number.isFinite(Number(amount)) || value <= 0 || value > Math.min(option.availableAmount, unrecognized) + 0.01) throw new AccountingRuleError("BILL_RECOGNITION_LINK_AMOUNT", "关联金额须大于零，且不超过凭证可关联额度与账单待确认金额");
  const next = structuredClone(workspace);
  const resolved = operationContext({ ...context, mode: "manual" });
  const link = { billId, voucherId, lineIndex: Number(lineIndex), amount: value, confirmedAt: resolved.at, confirmedBy: resolved.actor };
  next.billRecognitionLinks = [...(next.billRecognitionLinks || []), link];
  appendAuditEntry(next, { action: "bill.recognition_link", entityType: "bill", entityId: billId, detail: `关联已入账凭证 ${voucherId} 第 ${Number(lineIndex) + 1} 行，¥${value.toFixed(2)}`, after: link, sourceIds: [billId, voucherId] }, resolved);
  return next;
}

export function assertSettlementRecognition(workspace, voucher, options = {}) {
  const assessment = assessSettlementRecognition(workspace, voucher, options);
  if (!assessment.passed) throw new AccountingRuleError("SETTLEMENT_RECOGNITION_REQUIRED", assessment.issues.map((issue) => issue.message).join("；"), assessment);
  return assessment;
}

export function buildSettlementRecognitionDraft(workspace, billId) {
  const bill = (workspace.bills || []).find((item) => item.id === billId);
  if (!bill || !ordinaryKinds.includes(bill.kind)) throw new AccountingRuleError("BILL_NOT_FOUND", "请选择有效的应收或应付账单");
  const recognition = buildSettlementRecognition(workspace);
  const row = recognition.rows.find((item) => item.billId === billId);
  if (!row) throw new AccountingRuleError("BILL_NOT_EFFECTIVE", "账单尚未发生或已失效，请先核对账单日期与状态");
  const amount = row.unrecognizedAmount;
  const account = workspaceAccountDefinitions(workspace).find((item) => item.status !== "inactive" && item.id === bill.kind)?.id
    || workspaceAccountDefinitions(workspace).find((item) => item.status !== "inactive" && settlementAccountRole(workspace, item.id) === bill.kind)?.id || bill.kind;
  const payable = bill.kind === "payable";
  const today = new Date().toISOString().slice(0, 10);
  const date = bill.date.startsWith(workspace.currentPeriod) ? bill.date : today.startsWith(workspace.currentPeriod) ? today : `${workspace.currentPeriod}-01`;
  return {
    billId, date, summary: `确认${payable ? "应付" : "应收"} · ${bill.no || bill.id} · ${bill.summary || bill.counterparty}`,
    evidenceIds: collectSourceIds(bill.evidenceIds), relatedSourceIds: [billId],
    lines: [
      { account, debit: payable ? 0 : amount, credit: payable ? amount : 0, auxiliaryId: bill.counterparty, sourceIds: [billId] },
      { account: "", debit: payable ? amount : 0, credit: payable ? 0 : amount, sourceIds: [billId] },
    ],
    guidance: "按真实业务选择对方科目（收入、费用、资产或其他往来）。已确认业务请关联原凭证；期初往来核对期初余额，分期账单只确认实际发生部分，不能重复计收入或费用。",
  };
}
