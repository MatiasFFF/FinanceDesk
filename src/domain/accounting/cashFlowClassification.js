import { AccountingRuleError, accountDefinition, appendAuditEntry, collectSourceIds, operationContext, roundMoney, sumMoney } from "./model.js";
import { isPeriodArchived } from "../periods.js";
import { settlementAccountRole, settlementLineShares, settlementSourceBillIds } from "../../features/reconciliation/settlementRecognition.js";

export const CASH_FLOW_CATEGORIES = [
  { id: "operating", label: "经营活动" }, { id: "investing", label: "投资活动" }, { id: "financing", label: "筹资活动" },
];
const validCategory = (value) => CASH_FLOW_CATEGORIES.some((category) => category.id === value);
const amountOf = (line) => roundMoney(Number(line.credit || 0) - Number(line.debit || 0));
const baseId = (line) => String(line.account || "").split(":")[0];

function accountPurpose(workspace, line) {
  const account = accountDefinition(line.account, workspace);
  if (validCategory(account.cashFlowCategory)) return account.cashFlowCategory;
  if (account.cashFlowCategory === "pending") return "pending";
  if (baseId(line) === "inventory") return "operating";
  if (baseId(line) === "equipment") return "investing";
  if (["loan", "relatedParty"].includes(baseId(line)) || account.category === "equity") return "financing";
  if (["revenue", "contraRevenue", "cost", "expense"].includes(account.category)
    || ["contractLiability", "taxPayable", "payrollPayable", "socialSecurityPayable"].includes(baseId(line))) return "operating";
  return "pending";
}

function billPurposes(workspace, billId, asOf) {
  const bill = (workspace.bills || []).find((item) => item.id === billId);
  if (!bill) return [];
  if (validCategory(bill.cashFlowCategory)) return [{ category: bill.cashFlowCategory, amount: roundMoney(bill.amount), sourceIds: [bill.id] }];
  if (bill.kind === "depositReceived" && bill.cashFlowCategory !== "pending") return [{ category: "operating", amount: roundMoney(bill.amount), sourceIds: [bill.id] }];
  const purposes = [];
  for (const original of workspace.vouchers || []) {
    if (original.status !== "posted" || original.date > asOf || (original.lines || []).some((line) => accountDefinition(line.account, workspace).cash)) continue;
    const confirms = (original.lines || []).filter((line) => settlementAccountRole(workspace, line.account) === bill.kind
      && amountOf(line) * (bill.kind === "payable" ? 1 : -1) > 0.01)
      .flatMap((line) => settlementLineShares(workspace, original, line)).filter((share) => share.billId === billId && share.amount != null);
    const confirmedAmount = sumMoney(confirms.map((share) => share.amount));
    if (confirmedAmount <= 0.01) continue;
    const counterparts = (original.lines || []).filter((line) => !settlementAccountRole(workspace, line.account)
      && Math.abs(amountOf(line)) > 0.01
      && (!settlementSourceBillIds(workspace, line.sourceIds).length || settlementSourceBillIds(workspace, line.sourceIds).includes(billId)));
    const nonTax = counterparts.filter((line) => baseId(line) !== "taxPayable");
    const categories = collectSourceIds(nonTax.map((line) => accountPurpose(workspace, line)));
    if (categories.length === 1 && categories[0] !== "pending") {
      purposes.push({ category: categories[0], amount: confirmedAmount, sourceIds: [billId, original.id] });
    } else if (counterparts.length && counterparts.every((line) => accountPurpose(workspace, line) !== "pending")
      && Math.abs(sumMoney(counterparts.map((line) => Math.abs(amountOf(line)))) - confirmedAmount) <= 0.01) {
      purposes.push(...counterparts.map((line) => ({ category: accountPurpose(workspace, line), amount: Math.abs(amountOf(line)), sourceIds: collectSourceIds(billId, original.id, line.sourceIds) })));
    } else purposes.push({ category: "pending", amount: confirmedAmount, sourceIds: [billId, original.id] });
  }
  return purposes;
}

function classifyBillAmount(workspace, billId, amount, asOf) {
  const purposes = billPurposes(workspace, billId, asOf);
  const categories = collectSourceIds(purposes.map((purpose) => purpose.category));
  if (categories.length === 1 && categories[0] !== "pending") return [{ category: categories[0], amount, sourceIds: collectSourceIds(billId, purposes.map((purpose) => purpose.sourceIds)) }];
  // A partial payment on a mixed-purpose bill has no implied allocation order.
  if (purposes.length && !categories.includes("pending") && Math.abs(sumMoney(purposes.map((purpose) => purpose.amount)) - Math.abs(amount)) <= 0.01) {
    return purposes.map((purpose) => ({ ...purpose, amount: roundMoney(purpose.amount * Math.sign(amount)) }));
  }
  return [{ category: "pending", amount, sourceIds: [billId], reason: "往来款缺少可追溯用途或混合用途付款份额，请确认本次现金流分类" }];
}

export function cashFlowVoucherFingerprint(voucher) {
  return JSON.stringify({ date: voucher.date, status: voucher.status, lines: voucher.lines, sourceIds: voucher.sourceIds, reconciliationSources: voucher.reconciliationSources });
}

export function voucherCashFlowMovements(workspace, voucher) {
  const cashLines = (voucher.lines || []).filter((line) => accountDefinition(line.account, workspace).cash);
  const total = -sumMoney(cashLines.map(amountOf));
  const counterparts = (voucher.lines || []).filter((line) => !accountDefinition(line.account, workspace).cash && Math.abs(amountOf(line)) > 0.01);
  if (!cashLines.length || (Math.abs(total) <= 0.01 && !counterparts.length)) return [];
  const cashIn = sumMoney(cashLines.map((line) => Math.max(0, -amountOf(line))));
  const cashOut = sumMoney(cashLines.map((line) => Math.max(0, amountOf(line))));
  const common = { voucherId: voucher.id, date: voucher.date, summary: voucher.summary };
  const sources = collectSourceIds(voucher.id, voucher.sourceIds, cashLines.map((line) => line.sourceIds));
  const saved = workspace.cashFlowClassifications?.[voucher.id];
  if (saved?.fingerprint === cashFlowVoucherFingerprint(voucher)
    && saved.rows?.length && saved.rows.every((row) => validCategory(row.category))
    && Math.abs(sumMoney(saved.rows.map((row) => row.amount)) - total) <= 0.01) {
    return saved.rows.map((row, index) => ({ ...common, ...row, id: `${voucher.id}:cash:${index}`, confirmed: true, confirmationNote: saved.note, confirmedBy: saved.confirmedBy, confirmedAt: saved.confirmedAt, sourceIds: sources }));
  }
  const grossMatched = Math.abs(sumMoney(counterparts.map((line) => Math.max(0, amountOf(line)))) - cashIn) <= 0.01
    && Math.abs(sumMoney(counterparts.map((line) => Math.max(0, -amountOf(line)))) - cashOut) <= 0.01;
  if (!counterparts.length || (!grossMatched && counterparts.some((line) => Math.sign(amountOf(line)) !== Math.sign(total)))) {
    return (Math.abs(total) > 0.01 ? [total] : [cashIn, -cashOut]).filter((amount) => Math.abs(amount) > 0.01)
      .map((amount, index) => ({ ...common, id: `${voucher.id}:cash:pending:${index}`, category: "pending", amount, sourceIds: sources, reason: "凭证混合现金与非现金结转，请按本次资金用途确认分类金额" }));
  }
  const rows = counterparts.flatMap((line) => {
    const amount = amountOf(line);
    const definition = accountDefinition(line.account, workspace);
    if (validCategory(definition.cashFlowCategory)) return [{ category: definition.cashFlowCategory, amount, sourceIds: collectSourceIds(line.sourceIds) }];
    const isSettlement = settlementAccountRole(workspace, line.account) || ["prepayment", "contractLiability"].includes(baseId(line));
    const shares = isSettlement ? settlementLineShares(workspace, voucher, line) : [];
    if (shares.length) {
      if (shares.some((share) => share.amount == null)) return [{ category: "pending", amount, sourceIds: collectSourceIds(line.sourceIds), reason: "往来分录缺少各账单的真实份额，请确认现金流分类金额" }];
      return shares.flatMap((share) => classifyBillAmount(workspace, share.billId, roundMoney(share.amount * Math.sign(amount)), voucher.date));
    }
    return [{ category: accountPurpose(workspace, line), amount, sourceIds: collectSourceIds(line.sourceIds), reason: "科目用途尚未明确，请在会计科目或本次现金流中确认" }];
  });
  if (Math.abs(sumMoney(rows.map((row) => row.amount)) - total) > 0.01) return [{ ...common, id: `${voucher.id}:cash:pending`, category: "pending", amount: total, sourceIds: sources, reason: "来源金额不能完整对应本次现金流，请人工确认" }];
  return rows.map((row, index) => ({ ...common, ...row, id: `${voucher.id}:cash:${index}`, sourceIds: collectSourceIds(sources, row.sourceIds) }));
}

export function confirmCashFlowClassification(workspace, { voucherId, rows, note }, context = {}) {
  const voucher = (workspace.vouchers || []).find((item) => item.id === voucherId && item.status === "posted");
  if (!voucher || voucher.date?.slice(0, 7) !== workspace.currentPeriod) throw new AccountingRuleError("CASH_FLOW_VOUCHER_REQUIRED", "请选择当前账期的已入账凭证");
  if (isPeriodArchived(workspace)) throw new AccountingRuleError("PERIOD_ARCHIVED", "已归档账期只能查看");
  const cashLines = (voucher.lines || []).filter((line) => accountDefinition(line.account, workspace).cash);
  const amount = -sumMoney(cashLines.map(amountOf));
  const cashIn = sumMoney(cashLines.map((line) => Math.max(0, -amountOf(line))));
  const cashOut = sumMoney(cashLines.map((line) => Math.max(0, amountOf(line))));
  const normalized = (rows || []).map((row) => ({ category: row.category, amount: roundMoney(row.amount) })).filter((row) => Math.abs(row.amount) > 0.01);
  if (!String(note || "").trim()) throw new AccountingRuleError("CASH_FLOW_NOTE_REQUIRED", "请说明这笔现金流的真实用途");
  if (!normalized.length || normalized.some((row) => !validCategory(row.category) || !Number.isFinite(row.amount))
    || sumMoney(normalized.map((row) => Math.max(0, row.amount))) > cashIn + 0.01
    || sumMoney(normalized.map((row) => Math.max(0, -row.amount))) > cashOut + 0.01
    || Math.abs(sumMoney(normalized.map((row) => row.amount)) - amount) > 0.01) throw new AccountingRuleError("CASH_FLOW_AMOUNT_MISMATCH", "三类金额合计须等于本次现金净额，方向须与本次收付款一致");
  const next = structuredClone(workspace);
  const resolved = operationContext({ ...context, mode: "manual" });
  const before = next.cashFlowClassifications?.[voucherId] || null;
  const record = { fingerprint: cashFlowVoucherFingerprint(voucher), rows: normalized, note: String(note).trim(), confirmedAt: resolved.at, confirmedBy: resolved.actor };
  next.cashFlowClassifications = { ...next.cashFlowClassifications, [voucherId]: record };
  appendAuditEntry(next, { action: "cashflow.classify", entityType: "voucher", entityId: voucherId, detail: record.note, before, after: record, sourceIds: [voucherId] }, resolved);
  return next;
}
