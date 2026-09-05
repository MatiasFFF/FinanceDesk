import test from "node:test";
import assert from "node:assert/strict";
import { buildCommissionCollectionSources } from "../src/features/members/commissionCollectionSources.js";

function fixture() {
  return {
    currentPeriod: "2026-09",
    members: [{ id: "li", name: "李女士", coach: "陈教练" }, { id: "zhao", name: "赵女士", coach: "林教练" }],
    bills: [{ id: "bill-li", kind: "receivable", counterparty: " 李 女士 ", amount: 600, status: "active" },
      { id: "bill-zhao", kind: "receivable", counterparty: "赵女士", amount: 400, status: "active" }],
    businessEvents: [],
    transactions: [{ id: "receipt", date: "2026-09-06", amount: 1000, status: "pending", classification: { eventType: "customerReceipt" },
      allocations: [{ id: "a-li", transactionId: "receipt", billId: "bill-li", amount: 600, status: "confirmed" },
        { id: "a-zhao", transactionId: "receipt", billId: "bill-zhao", amount: 400, status: "confirmed" }] }],
  };
}

test("真实界面姓名账单的600和400已核销份额分别归属，稳定key不按整笔或教练去重", () => {
  const workspace = fixture();
  const before = structuredClone(workspace);
  const result = buildCommissionCollectionSources(workspace);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map((row) => [row.memberId, row.coach, row.baseAmount]), [["li", "陈教练", 600], ["zhao", "林教练", 400]]);
  assert.equal(new Set(result.rows.map((row) => row.sourceKey)).size, 2);
  assert.equal(result.rows[0].identityBasis.kind, "confirmed_bill_counterparty");
  assert.ok(result.rows[0].sourceIds.includes("receipt"));
  assert.ok(result.rows[0].sourceIds.includes("bill-li"));
  assert.ok(result.rows[0].sourceIds.includes("a-li"));
  workspace.transactions[0].status = "posted";
  workspace.transactions[0].allocations.forEach((item) => { item.status = "posted"; });
  assert.deepEqual(buildCommissionCollectionSources(workspace).rows.map((row) => row.fingerprint), result.rows.map((row) => row.fingerprint));
  workspace.members[0].coach = "新教练";
  const changed = buildCommissionCollectionSources(workspace).rows[0];
  assert.equal(changed.sourceKey, result.rows[0].sourceKey);
  assert.notEqual(changed.fingerprint, result.rows[0].fingerprint);
  assert.deepEqual(before.transactions[0].allocations.map((item) => item.amount), [600, 400]);
});

test("借款资本退款流入排除；同名、子串和未核销流水不猜会员；反核销不回退整笔", () => {
  for (const eventType of ["loan", "capitalContribution", "internalTransfer", "refund"]) {
    const workspace = fixture();
    workspace.transactions[0].classification.eventType = eventType;
    const result = buildCommissionCollectionSources(workspace);
    assert.equal(result.rows.length, 0, eventType);
    assert.equal(result.excluded[0].actionable, false);
  }
  for (const change of [
    (workspace) => { workspace.members.push({ id: "li-2", name: "李女士", coach: "王教练" }); },
    (workspace) => { workspace.bills[0].counterparty = "会员李女士"; },
  ]) {
    const workspace = fixture();
    change(workspace);
    const result = buildCommissionCollectionSources(workspace);
    assert.deepEqual(result.rows.map((row) => row.memberId), ["zhao"]);
    assert.ok(result.pending.some((item) => item.code === "collection_attribution_missing" && item.actionable));
  }
  const workspace = fixture();
  workspace.transactions.push({ id: "guessed", date: "2026-09-07", amount: 900, memberId: "li", summary: "李女士充值", counterparty: "李女士", status: "reconciled" });
  workspace.transactions[0].allocations[0].status = "reversed";
  const result = buildCommissionCollectionSources(workspace);
  assert.deepEqual(result.rows.map((row) => row.baseAmount), [400]);
  assert.ok(result.excluded.some((item) => item.code === "collection_allocation_reversed" && !item.actionable));
  assert.ok(result.pending.some((item) => item.transactionId === "guessed" && item.actionable));
});

test("直接收款只取唯一已确认关联业务的金额，不拿银行整笔替代也不要求凭证过账", () => {
  const workspace = fixture();
  workspace.transactions[0].allocations = [];
  workspace.businessEvents = [{ id: "receipt-event", source: "bank-transaction-manual-confirmation", kind: "bankTransaction", businessType: "memberRecharge",
    transactionId: "receipt", memberId: "li", amount: 600, direction: "in", status: "confirmed", accountingStatus: "unprocessed" }];
  let result = buildCommissionCollectionSources(workspace);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].baseAmount, 600);
  assert.equal(result.rows[0].sourceKey, "collection:event:receipt-event");
  assert.ok(result.pending.some((item) => item.amount === 400));
  const fingerprint = result.rows[0].fingerprint;
  workspace.businessEvents[0].status = "posted";
  assert.equal(buildCommissionCollectionSources(workspace).rows[0].fingerprint, fingerprint);
  workspace.businessEvents[0].status = "needs_review";
  assert.equal(buildCommissionCollectionSources(workspace).rows.length, 0);
  workspace.businessEvents[0].status = "confirmed";
  workspace.transactions.push({ id: "another-receipt", date: "2026-09-08", amount: 600, businessEventId: "receipt-event" });
  result = buildCommissionCollectionSources(workspace);
  assert.equal(result.rows.length, 0, "同一业务金额不能在两笔流水中重复计入");
});

test("明确退款扣对应份额并改变来源指纹，跨份额退款不猜分摊", () => {
  const workspace = fixture();
  const baseline = buildCommissionCollectionSources(workspace);
  workspace.transactions.push({ id: "refund", date: "2026-10-02", amount: -100, classification: { eventType: "refund" },
    refundLinks: [{ id: "refund-link", originalSourceId: "bill-li", amount: 100, status: "confirmed" }] });
  let result = buildCommissionCollectionSources(workspace);
  assert.deepEqual(result.rows.map((row) => row.baseAmount), [500, 400]);
  assert.notEqual(result.rows[0].fingerprint, baseline.rows[0].fingerprint);
  assert.equal(result.rows[1].fingerprint, baseline.rows[1].fingerprint);
  assert.equal(result.adjustments[0].amount, -100);
  assert.equal(result.adjustments[0].period, "2026-10");
  assert.equal(result.adjustments[0].targetSourceKey, baseline.rows[0].sourceKey);
  workspace.transactions[1].refundLinks[0].originalSourceId = "receipt";
  result = buildCommissionCollectionSources(workspace);
  assert.equal(result.rows.length, 0);
  assert.equal(result.pending.find((item) => item.code === "collection_refund_ambiguous").sourceKeys.length, 2);
  workspace.transactions[1].refundLinks[0].status = "reversed";
  assert.deepEqual(buildCommissionCollectionSources(workspace).rows.map((row) => row.baseAmount), [600, 400]);
});
