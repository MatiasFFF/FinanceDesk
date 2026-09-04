import test from "node:test";
import assert from "node:assert/strict";

import {
  addMember,
  addMemberBusinessEvent,
  buildMemberLedger,
  updateMemberBusinessEventStatus,
} from "../src/features/members/memberLedger.js";

const context = { actor: "测试会计", at: "2026-09-04T08:00:00.000Z" };

function baseWorkspace() {
  return { members: [], businessEvents: [] };
}

function addEvent(workspace, id, kind, values = {}) {
  return addMemberBusinessEvent(workspace, {
    id,
    kind,
    memberId: values.memberId,
    date: values.date || "2026-09-04",
    amount: values.amount,
    quantity: values.quantity,
    coach: values.coach,
    note: values.note || "",
  }, context);
}

test("会员充值、耗课、退款与教练提成会更新台账并形成会计事件", () => {
  let workspace = addMember(baseWorkspace(), { id: "member-1", name: "李女士", coach: "陈教练" }, context);

  workspace = addEvent(workspace, "event-recharge", "recharge", { memberId: "member-1", amount: 2400, quantity: 10 });
  assert.equal(buildMemberLedger(workspace).members[0].remainingSessions, 0);
  workspace = updateMemberBusinessEventStatus(workspace, "event-recharge", "confirmed", context);

  workspace = addEvent(workspace, "event-consumption", "consumption", { memberId: "member-1", amount: 480, quantity: 2 });
  workspace = updateMemberBusinessEventStatus(workspace, "event-consumption", "confirmed", context);

  workspace = addEvent(workspace, "event-refund", "refund", { memberId: "member-1", amount: 240, quantity: 1 });
  workspace = updateMemberBusinessEventStatus(workspace, "event-refund", "completed", context);

  workspace = addEvent(workspace, "event-commission", "commission", { amount: 300, quantity: 2, coach: "陈教练" });
  workspace = updateMemberBusinessEventStatus(workspace, "event-commission", "accrued", context);

  let ledger = buildMemberLedger(workspace);
  assert.equal(ledger.members[0].remainingSessions, 7);
  assert.equal(ledger.members[0].unfulfilledBalance, 1680);
  assert.equal(ledger.members[0].recognizedRevenue, 480);
  assert.equal(ledger.members[0].refunded, 240);
  assert.equal(ledger.totals.commissionPayable, 300);
  assert.equal(workspace.businessEvents.find((item) => item.id === "event-recharge").type, "memberRecharge");
  assert.equal(workspace.businessEvents.find((item) => item.id === "event-consumption").accountingStatus, "ready");
  assert.equal(workspace.businessEvents.find((item) => item.id === "event-commission").account, "expenseCommission");

  workspace = updateMemberBusinessEventStatus(workspace, "event-commission", "paid", context);
  ledger = buildMemberLedger(workspace);
  assert.equal(ledger.totals.commissionPayable, 0);
});

test("不能确认超过会员剩余课时或未履约余额的业务", () => {
  let workspace = addMember(baseWorkspace(), { id: "member-1", name: "王先生" }, context);
  workspace = addEvent(workspace, "event-recharge", "recharge", { memberId: "member-1", amount: 1000, quantity: 5 });
  workspace = updateMemberBusinessEventStatus(workspace, "event-recharge", "confirmed", context);
  workspace = addEvent(workspace, "event-consumption", "consumption", { memberId: "member-1", amount: 1200, quantity: 6 });

  assert.throws(
    () => updateMemberBusinessEventStatus(workspace, "event-consumption", "confirmed", context),
    /剩余课时不足/,
  );
});
