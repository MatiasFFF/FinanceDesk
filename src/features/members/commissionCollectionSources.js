// Current, explicitly linked collection evidence only. This selector never posts or confirms anything.
const RECEIPTS = new Set(["customerReceipt", "memberRecharge"]);
const MEMBER_SALES = new Set(["recharge", "memberRecharge", "consumption", "memberConsumption"]);
const CONFIRMED = new Set(["confirmed", "completed", "posted"]);
const INACTIVE = new Set(["ignored", "void", "voided", "reversed", "cancelled", "canceled"]);
const cents = (value) => value !== "" && value != null && Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) : NaN;
const money = (value) => value / 100;
const ids = (...values) => [...new Set(values.flat(Infinity).filter((value) => typeof value === "string" && value))].sort();
const refs = (item) => ids(item?.sourceIds || [], item?.businessEventId, item?.memberEventId);
const inactive = (item) => !item || INACTIVE.has(item.status) || Boolean(item.voidedAt || item.reversedAt || item.cancelledAt);
const eventType = (event) => event?.businessType || event?.eventType || event?.accountingEventType || event?.type || event?.kind;
const allocationKey = (transactionId, allocationId) => `collection:allocation:${encodeURIComponent(transactionId)}:${encodeURIComponent(allocationId)}`;
const eventKey = (id) => `collection:event:${encodeURIComponent(id)}`;

export function buildCommissionCollectionSources(workspace = {}, options = {}) {
  const period = String(options.period || workspace.currentPeriod || "");
  const transactions = workspace.transactions || [];
  const events = workspace.businessEvents || [];
  const bills = workspace.bills || [];
  const members = workspace.members || [];
  const rows = [], pending = [], excluded = [], adjustments = [];
  const blocked = new Set();
  const addIssue = (target, transaction, code, message, extra = {}) => target.push({
    code, message, actionable: target === pending, transactionId: transaction?.id || null, date: transaction?.date || "", ...extra,
  });
  const knownNonReceipt = (item) => {
    const type = item?.classification?.eventType || item?.eventType || item?.businessType;
    return type && type !== "unknown" && !RECEIPTS.has(type);
  };
  const linkedMemberEvents = (objects, billId) => {
    const references = ids(objects.flatMap(refs));
    return events.filter((event) => !inactive(event) && CONFIRMED.has(event.status)
      && MEMBER_SALES.has(eventType(event))
      && (references.includes(event.id) || (billId && [event.billId, event.relatedBillId].includes(billId))));
  };
  const attribution = (objects, confirmedBill = null) => {
    const explicitIds = ids(objects.map((item) => item?.memberId || item?.dimensions?.memberId));
    const linkedIds = ids(objects.flatMap((item) => ids(item?.counterpartyObjectId, refs(item))).filter((id) => members.some((member) => member.id === id)));
    let memberIds = ids(explicitIds, linkedIds);
    let identityBasis = { kind: "explicit_id" };
    if (!memberIds.length && confirmedBill) {
      const normalizeName = (name) => String(name || "").normalize("NFKC").replace(/\s+/g, "");
      const billName = normalizeName(confirmedBill.counterparty);
      const matches = billName ? members.filter((member) => normalizeName(member.name) === billName) : [];
      if (matches.length !== 1) return { problem: "已确认账单对方无法唯一完全匹配会员，同名、前后缀或子串不能用于归属" };
      memberIds = [matches[0].id];
      identityBasis = { kind: "confirmed_bill_counterparty", billId: confirmedBill.id, counterparty: confirmedBill.counterparty };
    }
    if (memberIds.length !== 1 || !members.some((member) => member.id === memberIds[0])) return { problem: "缺少唯一的会员 ID 关联，不能按姓名或摘要猜测" };
    const member = members.find((item) => item.id === memberIds[0]);
    const coaches = ids(objects.map((item) => String(item?.coach || item?.dimensions?.coach || "").trim()));
    if (coaches.length > 1) return { problem: "收款来源的教练归属不一致，请明确对应教练", memberId: member.id };
    const coach = coaches[0] || String(member.coach || "").trim();
    if (!coach) return { problem: "已关联会员，但缺少明确教练归属", memberId: member.id };
    const dimension = (key) => objects.map((item) => item?.[key] ?? item?.dimensions?.[key]).find((value) => value != null && value !== "") ?? member[key] ?? "";
    const storeId = dimension("storeId");
    return { memberId: member.id, memberName: member.name || member.id, identityBasis, coach, storeId,
      storeName: dimension("storeName") || workspace.stores?.find((item) => item.id === storeId)?.name || "",
      department: dimension("department"), project: dimension("project") };
  };
  const append = (transaction, { allocation, event, bill, linkedEvents = [], amount, objects }) => {
    const sourceKey = allocation ? allocationKey(transaction.id, allocation.id) : eventKey(event.id);
    const identity = attribution(objects, allocation ? bill : null);
    if (identity.problem) {
      addIssue(pending, transaction, "collection_attribution_missing", identity.problem, { sourceKey, sourceKeys: [sourceKey], billId: bill?.id || null, memberId: identity.memberId || null });
      return;
    }
    const eventIds = ids(event?.id, linkedEvents.map((item) => item.id));
    rows.push({ sourceKey, sourceId: sourceKey, sourceType: allocation ? "bankAllocation" : "bankBusinessEvent",
      transactionId: transaction.id, allocationId: allocation?.id || null, eventId: event?.id || eventIds[0] || null, eventIds,
      billId: bill?.id || null, sourceIds: ids(transaction.id, allocation?.id, bill?.id, eventIds, identity.memberId),
      date: transaction.date, ...identity, label: `${identity.memberName}收款`,
      grossAmount: money(amount), refundAmount: 0, amount: money(amount), baseAmount: money(amount), units: 1, sourceQuantity: 1,
      basis: { transactionAmount: money(cents(transaction.amount)), billAmount: bill ? money(cents(bill.amount)) : null,
        eventAmount: event ? money(cents(event.amount)) : null },
    });
  };

  for (const transaction of transactions) {
    const total = cents(transaction.amount);
    if (!(total > 0)) continue;
    if (!transaction.id || inactive(transaction) || transaction.internalTransferLink || knownNonReceipt(transaction)) {
      addIssue(excluded, transaction, "collection_not_member_receipt", "流水已撤销或属于非会员销售收款（含借款、资本金、内部转账和退款流入）");
      continue;
    }
    const allocations = transaction.allocations || [];
    if (allocations.length) {
      const confirmed = allocations.filter((item) => !inactive(item) && ["confirmed", "posted"].includes(item.status));
      const allocated = confirmed.reduce((sum, item) => sum + cents(item.amount), 0);
      if (!Number.isFinite(allocated) || allocated > total || confirmed.some((item) => !(cents(item.amount) > 0))) {
        addIssue(pending, transaction, "collection_overallocated", "有效核销金额无效或超过真实收款，不能形成提成基数",
          { sourceKeys: confirmed.filter((item) => item.id).map((item) => allocationKey(transaction.id, item.id)) });
        continue;
      }
      for (const allocation of allocations) {
        const sourceKey = allocation.id ? allocationKey(transaction.id, allocation.id) : null;
        if (inactive(allocation)) {
          addIssue(excluded, transaction, "collection_allocation_reversed", "核销已撤回或作废，不再参与实际到账提成", { sourceKey, sourceKeys: sourceKey ? [sourceKey] : [] });
          continue;
        }
        if (!allocation.id || !["confirmed", "posted"].includes(allocation.status) || (allocation.transactionId && allocation.transactionId !== transaction.id)) {
          addIssue(pending, transaction, "collection_allocation_unconfirmed", "核销尚未确认或流水关联不一致", { sourceKey, sourceKeys: sourceKey ? [sourceKey] : [] });
          continue;
        }
        const bill = bills.find((item) => item.id === allocation.billId);
        if (!bill || inactive(bill)) {
          addIssue(pending, transaction, "collection_bill_missing", "核销账单缺失或已作废", { sourceKey, sourceKeys: [sourceKey], billId: allocation.billId });
          continue;
        }
        if (!["receivable", "depositReceived"].includes(bill.kind) || knownNonReceipt(bill)) {
          addIssue(excluded, transaction, "collection_bill_not_sale", "该份核销不是会员销售应收或预收款", { sourceKey, sourceKeys: [sourceKey], billId: bill.id });
          continue;
        }
        const billAllocated = transactions.filter((item) => !inactive(item)).flatMap((item) => item.allocations || [])
          .filter((item) => item.billId === bill.id && !inactive(item) && ["confirmed", "posted"].includes(item.status))
          .reduce((sum, item) => sum + cents(item.amount), 0);
        if (!(cents(bill.amount) > 0) || !Number.isFinite(billAllocated) || billAllocated > cents(bill.amount)) {
          addIssue(pending, transaction, "collection_bill_overallocated", "账单核销合计超过有效账单金额或金额不明确", { sourceKey, sourceKeys: [sourceKey], billId: bill.id });
          continue;
        }
        const eventReferences = ids(refs(allocation), refs(bill));
        const invalidEvent = events.find((event) => eventReferences.includes(event.id) && MEMBER_SALES.has(eventType(event))
          && (inactive(event) || !CONFIRMED.has(event.status)));
        if (invalidEvent) {
          addIssue(inactive(invalidEvent) ? excluded : pending, transaction, "collection_member_event_inactive", "核销关联的会员业务已作废或尚未确认", { sourceKey, sourceKeys: [sourceKey], eventId: invalidEvent.id });
          continue;
        }
        const linkedEvents = linkedMemberEvents([allocation, bill], bill.id);
        const objects = [allocation, bill, ...linkedEvents];
        append(transaction, { allocation, bill, linkedEvents, amount: cents(allocation.amount), objects });
      }
      if (allocated < total) addIssue(pending, transaction, "collection_unallocated_remainder", "尚未确认的剩余收款不参与提成，不能用整笔流水替代", { amount: money(total - allocated) });
      continue; // Even reversed allocations must not fall back to a whole-transaction event.
    }

    const directEvents = events.filter((event) => event.transactionId === transaction.id
      || [transaction.bankBusinessEventId, transaction.businessEventId].includes(event.id)
      || (refs(event).includes(transaction.id) && MEMBER_SALES.has(eventType(event))));
    const confirmed = directEvents.filter((event) => !inactive(event) && CONFIRMED.has(event.status)
      && (RECEIPTS.has(eventType(event)) || eventType(event) === "recharge") && event.direction !== "out");
    if (confirmed.length !== 1) {
      addIssue(pending, transaction, "collection_direct_unconfirmed", "缺少唯一、已确认且明确关联此流水的会员收款业务金额");
      continue;
    }
    const event = confirmed[0];
    const eventTransactions = transactions.filter((item) => item.id === event.transactionId || [item.bankBusinessEventId, item.businessEventId].includes(event.id) || refs(event).includes(item.id));
    const amount = cents(event.amount);
    if (eventTransactions.length !== 1 || !(amount > 0) || amount > total) {
      addIssue(pending, transaction, "collection_direct_amount_ambiguous", "收款业务跨多笔流水或金额超过当前流水，需明确拆分金额", { sourceKey: eventKey(event.id), sourceKeys: [eventKey(event.id)], eventId: event.id });
      continue;
    }
    const billId = event.billId || event.relatedBillId;
    const bill = billId ? bills.find((item) => item.id === billId) : null;
    if (billId && (!bill || inactive(bill) || !["receivable", "depositReceived"].includes(bill.kind) || knownNonReceipt(bill))) {
      addIssue(pending, transaction, "collection_direct_bill_invalid", "收款业务关联账单不存在或不是有效销售账单", { sourceKey: eventKey(event.id), sourceKeys: [eventKey(event.id)], billId });
      continue;
    }
    const linkedEvents = linkedMemberEvents([event, bill].filter(Boolean), billId).filter((item) => item.id !== event.id);
    append(transaction, { event, bill, linkedEvents, amount, objects: [event, ...linkedEvents, bill, transaction].filter(Boolean) });
    if (amount < total) addIssue(pending, transaction, "collection_unconfirmed_remainder", "仅取已确认业务金额，其余流水金额待明确归属", { amount: money(total - amount) });
  }

  const block = (transaction, code, message, affected, extra = {}) => {
    affected.forEach((row) => blocked.add(row.sourceKey));
    const coaches = ids(affected.map((row) => row.coach));
    addIssue(pending, transaction, code, message, { sourceKeys: affected.map((row) => row.sourceKey), coaches, coach: coaches.length === 1 ? coaches[0] : null, ...extra });
  };
  for (const refund of transactions.filter((item) => cents(item.amount) < 0 && !inactive(item))) {
    const links = (refund.refundLinks || []).filter((item) => !inactive(item) && item.status === "confirmed");
    if (!links.length) continue;
    const totalLinked = links.reduce((sum, item) => sum + cents(item.amount), 0);
    for (const link of links) {
      const affected = rows.filter((row) => row.transactionId === link.originalSourceId || row.billId === link.originalSourceId);
      const originalTransaction = transactions.find((item) => item.id === link.originalSourceId);
      const allocationCount = originalTransaction ? (originalTransaction.allocations || []).filter((item) => !inactive(item) && ["confirmed", "posted"].includes(item.status)).length
        : transactions.filter((item) => !inactive(item)).flatMap((item) => item.allocations || []).filter((item) => item.billId === link.originalSourceId && !inactive(item) && ["confirmed", "posted"].includes(item.status)).length;
      if (refund.classification?.eventType !== "refund" || !link.id || !(cents(link.amount) > 0) || !Number.isFinite(totalLinked) || totalLinked > -cents(refund.amount)) {
        block(refund, "collection_refund_invalid", "退款关联或金额无效，需要核对后再计提", affected, { refundLinkId: link.id });
      } else if (affected.length !== 1 || allocationCount > 1 || (originalTransaction && affected[0]?.grossAmount !== money(cents(originalTransaction.amount)))) {
        block(refund, "collection_refund_ambiguous", "退款无法唯一分配到会员收款份额，不能擅自按比例或整笔扣减", affected, { refundLinkId: link.id, originalSourceId: link.originalSourceId });
      } else {
        const row = affected[0];
        adjustments.push({ sourceKey: `collection:refund:${encodeURIComponent(refund.id)}:${encodeURIComponent(link.id)}`,
          targetSourceKey: row.sourceKey, transactionId: refund.id, refundLinkId: link.id, originalSourceId: link.originalSourceId,
          date: refund.date, period: String(refund.date || "").slice(0, 7), amount: -money(cents(link.amount)),
          sourceIds: ids(refund.id, link.id, link.originalSourceId), memberId: row.memberId, coach: row.coach });
      }
    }
  }
  // Member-ledger refund confirmation alone does not prove a bank refund was paid.
  for (const refund of events.filter((item) => eventType(item) === "refund" && !inactive(item) && ["confirmed", "completed", "paid", "posted"].includes(item.status) && item.originalRechargeId)) {
    const affected = rows.filter((row) => row.eventIds.includes(refund.originalRechargeId));
    if (!affected.length) continue;
    const bankRefundIds = transactions.filter((item) => item.id === refund.transactionId || refs(refund).includes(item.id) || [item.businessEventId, item.bankBusinessEventId].includes(refund.id)).map((item) => item.id);
    if (!adjustments.some((item) => bankRefundIds.includes(item.transactionId) && affected.some((row) => row.sourceKey === item.targetSourceKey))) {
      block(refund, "collection_member_refund_unverified", "原充值已有退款业务，但尚不能与明确的银行退款影响对应，请核对以免漏扣或重复扣减", affected, { eventId: refund.id, transactionId: null });
    }
  }
  for (const row of rows) {
    const refunds = adjustments.filter((item) => item.targetSourceKey === row.sourceKey).sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
    const refunded = -refunds.reduce((sum, item) => sum + cents(item.amount), 0);
    if (refunded > cents(row.grossAmount)) block(transactions.find((item) => item.id === row.transactionId), "collection_over_refunded", "已关联退款超过该会员收款份额，请核对", [row]);
    row.refundAmount = money(refunded);
    row.amount = row.baseAmount = money(cents(row.grossAmount) - refunded);
    row.sourceIds = ids(row.sourceIds, refunds.flatMap((item) => item.sourceIds));
    row.fingerprint = JSON.stringify({ ...row, refunds });
  }
  const inPeriod = (date) => !period || String(date || "").startsWith(period);
  const relevant = (item) => inPeriod(item.date) || (item.sourceKeys || []).some((key) => rows.some((row) => row.sourceKey === key && inPeriod(row.date)));
  return {
    period,
    rows: rows.filter((row) => inPeriod(row.date) && !blocked.has(row.sourceKey)).sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)),
    pending: pending.filter(relevant), excluded: excluded.filter(relevant),
    adjustments: adjustments.filter((item) => inPeriod(item.date) || rows.some((row) => row.sourceKey === item.targetSourceKey && inPeriod(row.date))),
  };
}
