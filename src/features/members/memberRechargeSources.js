import { AccountingRuleError, appendAuditEntry, cloneAccountingState, collectSourceIds, operationContext, roundMoney, sumMoney } from "../../domain/accounting/model.js";
import { resolveWorkspaceAccountDefinition } from "../../domain/accounting/classification.js";

const liveVoucher = (voucher) => ["draft", "changes_requested", "posted"].includes(voucher.status);
const idsFor = (voucher) => collectSourceIds(voucher.sourceIds, (voucher.lines || []).map((line) => line.sourceIds));
const isRecharge = (event) => event?.sourceType !== "bankTransaction" && (event?.kind === "recharge" || (!event?.kind && [event?.type, event?.eventType, event?.accountingEventType].includes("memberRecharge")));
const isLiveEvent = (event) => !["void", "voided", "cancelled", "reversed"].includes(event.status);
function fail(code, message, details) { throw new AccountingRuleError(code, message, details); }

export function memberRechargeSource(workspace, event) {
  const details = { eventId: event?.id, transactionId: event?.transactionId, allocationId: event?.allocationId };
  if (!event?.transactionId) fail("MEMBER_RECHARGE_SOURCE_REQUIRED", "充值入账前请选择对应银行流水；合并收款请选择已确认的核销分配", details);
  const transaction = (workspace.transactions || []).find((item) => item.id === event.transactionId);
  if (!transaction || Number(transaction.amount) <= 0 || ["voided", "cancelled", "reversed", "deleted"].includes(transaction.status)) {
    fail("MEMBER_RECHARGE_SOURCE_INVALID", "所选充值收款不存在、已失效或不是收入流水，请重新关联真实收款", details);
  }
  const active = (transaction.allocations || []).filter((allocation) => !["revoked", "cancelled", "reversed", "voided", "rejected"].includes(allocation.status));
  const allocation = event.allocationId ? active.find((item) => item.id === event.allocationId) : null;
  if ((event.allocationId && (!allocation || !["confirmed", "posted"].includes(allocation.status))) || (!event.allocationId && active.length)) {
    fail("MEMBER_RECHARGE_SOURCE_INVALID", "这笔收款有核销分配，请选择本次充值对应的已确认分配；不能将整笔收款重复归入充值", details);
  }
  const bill = allocation ? (workspace.bills || []).find((item) => item.id === allocation.billId) : null;
  if (allocation && (!bill || (event.billId && event.billId !== bill.id) || (bill.memberId && bill.memberId !== event.memberId))) {
    fail("MEMBER_RECHARGE_SOURCE_INVALID", "所选分配的账单不存在或属于其他会员，请核对原收款分配", details);
  }
  const amount = roundMoney(allocation?.amount ?? transaction.amount);
  if (amount !== roundMoney(event.amount)) fail("MEMBER_RECHARGE_AMOUNT_MISMATCH", `所选收款份额 ${amount.toFixed(2)} 元与充值 ${roundMoney(event.amount).toFixed(2)} 元不一致；请先按真实业务确认分配`, details);
  const otherEvent = (workspace.businessEvents || []).find((other) => isRecharge(other) && isLiveEvent(other) && other.id !== event.id
    && other.transactionId === transaction.id && (!event.allocationId || !other.allocationId || other.allocationId === event.allocationId));
  if (otherEvent) fail("MEMBER_RECHARGE_SOURCE_USED", `该收款份额已关联充值 ${otherEvent.id}，请继续办理原记录`, { ...details, conflictingEventId: otherEvent.id });
  return { transaction, allocation, bill, amount, sourceIds: collectSourceIds(event.id, transaction.id, allocation?.id, bill?.id) };
}

export function buildMemberRechargeSourceOptions(workspace, eventOrId) {
  const event = typeof eventOrId === "string" ? (workspace.businessEvents || []).find((item) => item.id === eventOrId) : eventOrId;
  return (workspace.transactions || []).filter((transaction) => Number(transaction.amount) > 0
    && String(transaction.date || "").slice(0, 7) === (String(event?.date || "").slice(0, 7) || workspace.currentPeriod)
    && !["voided", "cancelled", "reversed", "deleted"].includes(transaction.status)).flatMap((transaction) => {
    const active = (transaction.allocations || []).filter((allocation) => !["revoked", "cancelled", "reversed", "voided", "rejected"].includes(allocation.status));
    const scopes = active.length ? active.filter((allocation) => ["confirmed", "posted"].includes(allocation.status)) : [null];
    return scopes.filter((allocation) => !(workspace.businessEvents || []).some((other) => isRecharge(other) && isLiveEvent(other)
      && other.id !== event?.id && other.transactionId === transaction.id && (!other.allocationId || !allocation || other.allocationId === allocation.id)))
      .map((allocation) => ({
        id: allocation?.id || transaction.id,
        transactionId: transaction.id,
        allocationId: allocation?.id || null,
        billId: allocation?.billId || null,
        amount: roundMoney(allocation?.amount ?? transaction.amount),
        label: `${transaction.date} · ${transaction.counterparty || transaction.id} · ${roundMoney(allocation?.amount ?? transaction.amount).toFixed(2)} 元 · ${transaction.id}${allocation ? ` / ${allocation.id} / ${allocation.billId}` : ""}`,
      }));
  });
}

export function memberRechargeVouchers(workspace, event) {
  return (workspace.vouchers || []).filter((voucher) => {
    if (!liveVoucher(voucher) || voucher.advanceApplicationId) return false;
    const ids = idsFor(voucher);
    if (voucher.memberEventId === event.id || ids.includes(event.id)) return true;
    if (!event.transactionId) return false;
    if (event.allocationId) {
      const ownsAllocation = ids.includes(event.allocationId);
      const hasAnyAllocation = (workspace.transactions || []).some((transaction) => (transaction.allocations || []).some((allocation) => ids.includes(allocation.id)));
      return ownsAllocation || (ids.includes(event.transactionId) && !hasAnyAllocation);
    }
    return ids.includes(event.transactionId);
  });
}

export function assertMemberRechargeVoucher(workspace, event, voucher) {
  const source = memberRechargeSource(workspace, event);
  const semanticAccount = (account) => {
    const definition = resolveWorkspaceAccountDefinition(workspace, account);
    return definition?.systemKey || definition?.id || account;
  };
  const voucherIds = idsFor(voucher);
  const credits = (voucher.lines || []).filter((line) => semanticAccount(line.account) === "contractLiability");
  let invalidAllocationLine = false;
  const amount = sumMoney(credits.map((line) => {
    const net = roundMoney(Number(line.credit || 0) - Number(line.debit || 0));
    if (!event.allocationId) return net;
    const allocations = (source.transaction.allocations || []).filter((allocation) => line.sourceIds?.includes(allocation.id)
      || (voucherIds.includes(allocation.id) && line.sourceIds?.includes(allocation.billId)));
    if (allocations.some((allocation) => allocation.id === event.allocationId)) {
      if (sumMoney(allocations.map((allocation) => allocation.amount)) !== net) invalidAllocationLine = true;
      return source.amount;
    }
    return line.sourceIds?.includes(event.id) ? net : 0;
  }));
  const bankId = source.transaction.accountId || event.bankAccountId || "bank";
  const bankAmount = sumMoney((voucher.lines || []).filter((line) => line.account === bankId || (bankId === "bank" && semanticAccount(line.account) === "bank"))
    .map((line) => Number(line.debit || 0) - Number(line.credit || 0)));
  if (invalidAllocationLine || amount !== source.amount || bankAmount < source.amount || bankAmount > roundMoney(source.transaction.amount) || (!event.allocationId && bankAmount !== source.amount)) {
    fail("MEMBER_RECHARGE_VOUCHER_MISMATCH", `来源凭证 ${voucher.no || voucher.id} 与本次充值的银行收款、合同负债份额不一致；请对该凭证创建更正后继续关联`, { eventId: event.id, transactionId: source.transaction.id, voucherId: voucher.id });
  }
  return source;
}

export function linkMemberRechargeSource(workspace, { eventId, transactionId, allocationId = null, billId = null }, context = {}) {
  const next = cloneAccountingState(workspace);
  const event = (next.businessEvents || []).find((item) => item.id === eventId);
  if (!isRecharge(event) || !isLiveEvent(event)) fail("MEMBER_RECHARGE_NOT_FOUND", "请选择有效的会员充值记录", { eventId });
  const period = String(event.date || "").slice(0, 7);
  if (period !== next.currentPeriod || next.delivery?.archives?.some((archive) => archive.period === period) || next.delivery?.filing?.archivedAt) {
    fail("PERIOD_ARCHIVED", "请在充值所属未归档账期关联来源；已归档记录通过当前期更正处理", { eventId });
  }
  if (event.transactionId && (event.transactionId !== transactionId || (event.allocationId || null) !== allocationId)
    && memberRechargeVouchers(next, event).some((voucher) => voucher.status === "posted")) {
    fail("MEMBER_RECHARGE_POSTED_SOURCE_LOCKED", "已入账充值不能直接更换收款来源，请先更正原凭证", { eventId, transactionId });
  }
  const before = { transactionId: event.transactionId, allocationId: event.allocationId, billId: event.billId };
  Object.assign(event, { transactionId, allocationId, billId });
  const source = memberRechargeSource(next, event);
  if (String(source.transaction.date || "").slice(0, 7) !== period) fail("MEMBER_RECHARGE_PERIOD_MISMATCH", "充值与银行收款账期不同，请切换到收款所属账期登记或通过更正处理", { eventId, transactionId });
  event.billId = source.bill?.id || null;
  event.bankAccountId = source.transaction.accountId || event.bankAccountId || null;
  const candidates = memberRechargeVouchers(next, event);
  const posted = candidates.filter((voucher) => voucher.status === "posted");
  if (posted.length > 1) fail("MEMBER_RECHARGE_DUPLICATE_POSTED", "该充值与银行来源已有两张入账凭证，请先更正重复凭证后关联", { eventId, transactionId, voucherIds: posted.map((voucher) => voucher.id) });
  const keep = posted[0] || candidates.find((voucher) => voucher.memberEventId !== event.id) || candidates[0];
  if (keep) assertMemberRechargeVoucher(next, event, keep);
  const resolved = operationContext(context);
  // Only drafts may gain missing source links; posted journal lines remain immutable.
  if (keep && keep.status !== "posted") {
    keep.sourceIds = collectSourceIds(keep.sourceIds, source.sourceIds);
    keep.lines.forEach((line) => { if (!allocationId || line.sourceIds?.includes(allocationId) || line.sourceIds?.includes(event.id)) line.sourceIds = collectSourceIds(line.sourceIds, source.sourceIds); });
    keep.evidenceIds = collectSourceIds(keep.evidenceIds, event.evidenceIds, source.transaction.evidenceIds, source.bill?.evidenceIds);
    if (allocationId && !(keep.reconciliationSources || []).some((item) => item.id === allocationId)) {
      keep.reconciliationSources = [...(keep.reconciliationSources || []), { id: allocationId, billId: source.bill.id, amount: source.amount }];
    }
  }
  candidates.filter((voucher) => voucher.id !== keep?.id && voucher.status !== "posted").forEach((voucher) => {
    voucher.status = "invalidated";
    voucher.invalidationReason = `已合并到相同收款来源凭证 ${keep.id}`;
    voucher.invalidatedAt = resolved.at;
    (next.exceptionTasks || []).filter((task) => task.sourceId === voucher.id && task.status !== "resolved").forEach((task) => { task.status = "resolved"; task.resolution = "source_merged"; task.resolvedAt = resolved.at; });
  });
  event.sourceIds = collectSourceIds((event.sourceIds || []).filter((id) => !collectSourceIds(before.transactionId, before.allocationId, before.billId).includes(id)), source.sourceIds);
  event.evidenceIds = collectSourceIds(event.evidenceIds, source.transaction.evidenceIds, source.bill?.evidenceIds);
  event.accountingStatus = keep?.status === "posted" ? "posted" : keep ? "voucher_draft" : event.status === "pending" ? "draft" : "ready";
  event.postedVoucherId = keep?.status === "posted" ? keep.id : null;
  event.draftVoucherId = keep && keep.status !== "posted" ? keep.id : null;
  event.updatedAt = resolved.at;
  event.sourceLinkedAt = resolved.at;
  event.sourceLinkedBy = resolved.actor;
  appendAuditEntry(next, { action: "member.recharge_source_link", entityType: "businessEvent", entityId: event.id, detail: `明确关联收款 ${transactionId}${allocationId ? ` / ${allocationId}` : ""}${keep ? `，继续凭证 ${keep.no || keep.id}` : ""}`, before, after: { transactionId, allocationId, billId: event.billId, voucherId: keep?.id }, sourceIds: source.sourceIds }, resolved);
  return next;
}
