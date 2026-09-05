import test from "node:test";
import assert from "node:assert/strict";
import { buildCommissionRuleCalculation, confirmCommissionAccrual } from "../src/features/members/memberLedger.js";
import { createMemberEventVoucherDraft, postVoucher } from "../src/domain/accounting/vouchers.js";

const context = { actor: "提成确认人", at: "2026-09-05T08:00:00.000Z" };
function fixture(first = 600, second = 400) {
  const transactionId = "receipt-1000";
  return {
    id: "commission-workspace", currentPeriod: "2026-09", modules: { members: true, payroll: false },
    members: [{ id: "member-li", name: "李女士", coach: "陈教练", status: "active" }, { id: "member-zhao", name: "赵女士", coach: "宋教练", status: "active" }],
    membershipPackages: [], businessEvents: [], vouchers: [], documents: [], exceptionTasks: [], auditLog: [], openingLedger: {},
    bankAccounts: [{ id: "bank-main", name: "经营账户" }],
    bills: [{ id: "bill-li", kind: "receivable", counterparty: "李女士", amount: first, status: "active" }, { id: "bill-zhao", kind: "receivable", counterparty: "赵女士", amount: second, status: "active" }],
    transactions: [{ id: transactionId, accountId: "bank-main", date: "2026-09-04", amount: 1000, status: "pending",
      classification: { eventType: "customerReceipt", account: "receivable" },
      allocations: [
        ...(first ? [{ id: "allocation-li", transactionId, billId: "bill-li", amount: first, status: "confirmed", sourceIds: [transactionId, "bill-li"] }] : []),
        ...(second ? [{ id: "allocation-zhao", transactionId, billId: "bill-zhao", amount: second, status: "confirmed", sourceIds: [transactionId, "bill-zhao"] }] : []),
      ],
    }],
    commissionRules: [
      { id: "rule-chen", coach: "陈教练", basis: "actualCollection", method: "percentage", rate: 10, enabled: true },
      { id: "rule-song", coach: "宋教练", basis: "actualCollection", method: "percentage", rate: 10, enabled: true },
    ],
  };
}

function accrue(workspace, ruleId, eventId) {
  return confirmCommissionAccrual(workspace, { ruleId, period: "2026-09" }, { ...context, eventId });
}

function postAccrual(workspace, eventId) {
  const drafted = createMemberEventVoucherDraft(workspace, { eventId }, context);
  return postVoucher(drafted, { voucherId: drafted.vouchers.at(-1).id, reviewNote: "已核对明确收款份额与提成依据" }, context);
}

test("真实到账提成：明确已核销会员收款不要求流水过账，份额计提可正常生成并入账凭证", () => {
  const workspace = fixture(1000, 0);
  const calculation = buildCommissionRuleCalculation(workspace, "rule-chen");
  assert.deepEqual([calculation.sourceCount, calculation.baseAmount, calculation.commissionAmount], [1, 1000, 100]);
  assert.equal(calculation.lines[0].memberId, "member-li", "使用用户已确认账单的唯一全名关联，无需UI注入memberId");
  assert.notEqual(calculation.lines[0].sourceId, "receipt-1000");
  const accrued = accrue(workspace, "rule-chen", "accrual-chen");
  const event = accrued.businessEvents[0];
  assert.deepEqual(event.commissionSourceIds, ["receipt-1000"]);
  assert.equal(event.commissionSourceKeys[0], calculation.lines[0].sourceId);
  assert.ok(event.sourceIds.includes("allocation-li") && event.sourceIds.includes("bill-li"));
  assert.ok(event.sourceIds.every((id) => !id.startsWith("collection:")));
  const posted = postAccrual(accrued, event.id);
  const voucher = posted.vouchers[0];
  assert.equal(voucher.status, "posted");
  assert.ok(voucher.sourceIds.includes(event.id));
  assert.ok(voucher.relatedSourceIds.includes("receipt-1000"));
  assert.ok(voucher.relatedSourceIds.includes("allocation-li"));
  assert.ok(voucher.relatedSourceIds.includes("bill-li"));
  assert.ok(voucher.relatedSourceIds.every((id) => !id.startsWith("collection:")));
  assert.equal(workspace.transactions[0].status, "pending");
});

test("真实到账提成：未明确、借款和出资资金不计提，不从流水姓名substring猜会员", () => {
  for (const [eventType, account] of [["loan", "loan"], ["capitalContribution", "equity"]]) {
    const workspace = fixture(1000, 0);
    workspace.transactions[0].classification = { eventType, account };
    assert.equal(buildCommissionRuleCalculation(workspace, "rule-chen").commissionAmount, 0);
  }
  const unclear = fixture(0, 0);
  unclear.transactions[0].counterparty = "会员李女士转账";
  unclear.transactions[0].summary = "李女士购买或借款待确认";
  unclear.transactions[0].classification = { eventType: "unknown" };
  const calculation = buildCommissionRuleCalculation(unclear, "rule-chen");
  assert.equal(calculation.commissionAmount, 0);
  assert.equal(calculation.sourceCount, 0);
  assert.ok(calculation.excludedSources.length);
  assert.throws(() => accrue(unclear, "rule-chen", "invalid"), /没有尚未计提/);
});

test("真实到账提成：1000拆600和400两教练分别计提，稳定份额去重不吞另一教练", () => {
  let workspace = fixture();
  const first = buildCommissionRuleCalculation(workspace, "rule-chen");
  const second = buildCommissionRuleCalculation(workspace, "rule-song");
  assert.deepEqual([first.baseAmount, first.commissionAmount, second.baseAmount, second.commissionAmount], [600, 60, 400, 40]);
  assert.notEqual(first.lines[0].sourceId, second.lines[0].sourceId);
  workspace = accrue(workspace, "rule-chen", "accrual-chen");
  assert.equal(buildCommissionRuleCalculation(workspace, "rule-song").commissionAmount, 40);
  workspace = accrue(workspace, "rule-song", "accrual-song");
  assert.deepEqual(workspace.businessEvents.map((event) => event.amount), [60, 40]);
  assert.equal(buildCommissionRuleCalculation(workspace, "rule-chen").commissionAmount, 0);
  assert.equal(buildCommissionRuleCalculation(workspace, "rule-song").commissionAmount, 0);
  assert.throws(() => confirmCommissionAccrual(workspace, { ruleId: "rule-chen", sourceIds: [first.lines[0].sourceId] }, context), /已经计提/);
});

test("真实到账提成：只分配600时仅按600计算，剩余400待明确不按整笔1000计提", () => {
  const calculation = buildCommissionRuleCalculation(fixture(600, 0), "rule-chen");
  assert.deepEqual([calculation.baseAmount, calculation.commissionAmount], [600, 60]);
  assert.ok(calculation.excludedSources.some((source) => source.actionable === true));
});

test("真实到账提成：尚未计提的金额改变或核销撤回按当前明确来源重算", () => {
  const workspace = fixture(600, 0);
  workspace.transactions[0].allocations[0].amount = 500;
  assert.equal(buildCommissionRuleCalculation(workspace, "rule-chen").commissionAmount, 50);
  workspace.transactions[0].allocations[0].status = "reversed";
  assert.equal(buildCommissionRuleCalculation(workspace, "rule-chen").commissionAmount, 0);
  assert.deepEqual(workspace.businessEvents, []);
});

test("真实到账提成：已计提后的变更和撤回保留历史凭证，提示待处理且不挡其他已明确份额", () => {
  let workspace = accrue(fixture(), "rule-chen", "accrual-chen");
  workspace = postAccrual(workspace, "accrual-chen");
  const history = structuredClone(workspace.businessEvents);
  const vouchers = structuredClone(workspace.vouchers);
  workspace.transactions[0].allocations[0].amount = 500;
  let calculation = buildCommissionRuleCalculation(workspace, "rule-chen");
  assert.equal(calculation.commissionAmount, 0);
  assert.equal(calculation.lines[0].status, "source_changed");
  assert.equal(calculation.sourceChanges[0].eventId, "accrual-chen");
  assert.ok(calculation.sourceChanges[0].voucherIds.includes(vouchers[0].id));
  assert.equal(buildCommissionRuleCalculation(workspace, "rule-song").commissionAmount, 40);
  assert.deepEqual(workspace.businessEvents, history);
  assert.deepEqual(workspace.vouchers, vouchers);
  workspace.transactions[0].allocations[0].status = "reversed";
  calculation = buildCommissionRuleCalculation(workspace, "rule-chen");
  assert.equal(calculation.pendingLines.length, 0);
  assert.equal(calculation.sourceChanges[0].code, "commission_source_missing");
  assert.equal(buildCommissionRuleCalculation(workspace, "rule-song").commissionAmount, 40);
  assert.deepEqual(workspace.businessEvents, history);
  assert.deepEqual(workspace.vouchers, vouchers);
});
