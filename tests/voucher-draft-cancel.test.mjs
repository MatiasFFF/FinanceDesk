import assert from "node:assert/strict";
import test from "node:test";
import { createBlankWorkspace } from "../src/domain/foundation.js";
import { cancelVoucherDraft } from "../src/domain/accounting/vouchers.js";
import { cancelReconciliationCorrection } from "../src/features/reconciliation/reconciliationEngine.js";

test("cancelling a draft records reason and resolves only its own evidence tasks", () => {
  const workspace = createBlankWorkspace({ id: "cancel", currentPeriod: "2026-09" });
  workspace.vouchers = [{ id: "draft", period: "2026-09", status: "changes_requested" }, { id: "other", period: "2026-09", status: "draft" }];
  workspace.exceptionTasks = [{ id: "mine", sourceId: "draft", status: "open" }, { id: "theirs", sourceId: "other", status: "open" }];
  assert.throws(() => cancelVoucherDraft(workspace, { voucherId: "draft", reason: "" }), (error) => error.code === "VOUCHER_CANCEL_REASON_REQUIRED");
  const next = cancelVoucherDraft(workspace, { voucherId: "draft", reason: "重复录入" }, { actor: "会计" });
  assert.equal(next.vouchers[0].status, "invalidated");
  assert.equal(next.vouchers[0].versions.at(-1).reason, "重复录入");
  assert.equal(next.exceptionTasks[0].status, "resolved");
  assert.equal(next.exceptionTasks[0].history.at(-1).note, "重复录入");
  assert.equal(next.exceptionTasks[1].status, "open");
  assert.equal(workspace.vouchers[0].status, "changes_requested");
});

test("revision cancellation preserves original voucher and allocation; posted and archived drafts reject cancellation", () => {
  const workspace = createBlankWorkspace({ id: "cancel", currentPeriod: "2026-09" });
  workspace.vouchers = [{ id: "original", period: "2026-09", status: "posted" }, { id: "revision", period: "2026-09", status: "draft", revisionOf: "original" }];
  workspace.transactions = [{ id: "tx", allocations: [{ id: "a", status: "confirmed", amount: 100 }] }];
  const next = cancelReconciliationCorrection(workspace, { voucherId: "revision", reason: "保留原核销" });
  assert.deepEqual(next.vouchers[0], workspace.vouchers[0]);
  assert.deepEqual(next.transactions, workspace.transactions);
  assert.throws(() => cancelVoucherDraft(workspace, { voucherId: "original", reason: "不能直接取消" }), (error) => error.code === "VOUCHER_DRAFT_REQUIRED");
  workspace.delivery.archives = [{ period: "2026-09" }];
  assert.throws(() => cancelVoucherDraft(workspace, { voucherId: "revision", reason: "已归档" }), (error) => error.code === "PERIOD_ARCHIVED");
});
