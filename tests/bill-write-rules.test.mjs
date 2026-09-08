import assert from "node:assert/strict";
import test from "node:test";
import { createBlankWorkspace, createInitialState, upsertWorkspaceEntity, setWorkspaceEntityStatus, removeWorkspaceEntity } from "../src/domain/foundation.js";
import { assertBillWrite } from "../src/domain/accounting/billWriteRules.js";

function fixture() {
  const workspace = createBlankWorkspace({ id: "bills", name: "账单", currentPeriod: "2026-09" });
  const bill = { id: "bill-1", no: "AUG-1000", kind: "receivable", amount: 1000, counterparty: "客户", date: "2026-08-01", dueDate: "2026-09-01", businessPeriod: "2026-08", status: "active" };
  workspace.bills = [bill];
  return { workspace, bill, state: { ...createInitialState(), workspaces: [workspace], activeWorkspaceId: workspace.id, activeUserId: null } };
}

test("archived bill cannot be changed, deactivated or deleted from another displayed period", () => {
  const { workspace, bill, state } = fixture();
  workspace.delivery.archives = [{ period: "2026-08" }];
  for (const change of [() => upsertWorkspaceEntity(state, workspace.id, "bills", { ...bill, amount: 500 }),
    () => setWorkspaceEntityStatus(state, workspace.id, "bills", bill.id, "inactive"),
    () => removeWorkspaceEntity(state, workspace.id, "bills", bill.id),
    () => assertBillWrite(workspace, bill, { ...bill, amount: 500 }, { operation: "red-invoice" })]) {
    assert.throws(change, (error) => error.code === "BILL_PERIOD_ARCHIVED");
  }
  assert.equal(workspace.bills[0].amount, 1000);
});

test("unused open bill remains editable; actual settlements lock financial fields but allow notes", () => {
  const { workspace, bill, state } = fixture();
  assert.equal(upsertWorkspaceEntity(state, workspace.id, "bills", { ...bill, amount: 500 }).item.amount, 500);
  workspace.transactions = [{ id: "tx-1", date: "2026-09-01", amount: 600, allocations: [{ id: "allocation-1", billId: bill.id, amount: 600, status: "confirmed" }] }];
  assert.throws(() => assertBillWrite(workspace, bill, { ...bill, amount: 500 }), (error) => error.code === "BILL_BELOW_SETTLED");
  assert.throws(() => assertBillWrite(workspace, bill, { ...bill, counterparty: "其他客户" }), (error) => error.code === "BILL_FINANCIAL_RELATIONS" && error.message.includes("allocation-1"));
  assert.doesNotThrow(() => assertBillWrite(workspace, bill, { ...bill, note: "电话补充说明" }));
  assert.doesNotThrow(() => assertBillWrite(workspace, bill, { ...bill, dueDate: "2026-10-15" }));
  assert.throws(() => assertBillWrite(workspace, bill, { ...bill, dueDate: "2026-02-30" }), (error) => error.code === "INVALID_BILL_DUE_DATE");
  assert.doesNotThrow(() => assertBillWrite(workspace, bill, { ...bill, amount: 800 }, { operation: "red-invoice" }));
  workspace.vouchers = [{ id: "posted", status: "posted", sourceIds: [bill.id] }];
  assert.throws(() => assertBillWrite(workspace, bill, { ...bill, amount: 800 }, { operation: "red-invoice" }), (error) => error.code === "BILL_FINANCIAL_RELATIONS");
});

test("financial input validates calendar, amount and ownership while legacy notes and member IDs remain usable", () => {
  const { workspace, bill } = fixture();
  workspace.members = [{ id: "member-1", status: "inactive" }];
  assert.doesNotThrow(() => assertBillWrite(workspace, null, { ...bill, counterpartyObjectId: "member-1" }));
  const legacy = { id: "legacy", summary: "旧账单" };
  assert.doesNotThrow(() => assertBillWrite(workspace, legacy, { ...legacy, note: "补说明" }));
  for (const patch of [{ date: "2026-02-30" }, { amount: Infinity }, { amount: "" }, { kind: "unknown" }, { counterpartyObjectId: "foreign" }]) {
    assert.throws(() => assertBillWrite(workspace, null, { ...bill, ...patch }));
  }
});
