import assert from "node:assert/strict";
import test from "node:test";
import { createBlankWorkspace } from "../src/domain/foundation.js";
import { bankBusinessEventDraftStateAllowsCreation, cancelVoucherDraft, createBankBusinessEventVoucherDraft, createMemberEventVoucherDraft, createVoucherDraft, postVoucherWithEvidence } from "../src/domain/accounting/vouchers.js";
import { cancelReconciliationCorrection, confirmBankTransactionBusinessEvent } from "../src/features/reconciliation/reconciliationEngine.js";
import { createAccountingFixture } from "../src/domain/accounting/fixtures.js";
import { effectivePostedVouchers } from "../src/domain/accounting/ledger.js";
import { withVoucherEvidence } from "./helpers/voucherEvidenceFixture.mjs";

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

const context = { actor: "测试会计", at: "2026-09-12T08:00:00.000Z", mode: "manual" };

async function bankDraftFixture() {
  const evidence = await withVoucherEvidence(createAccountingFixture({ withReconciliations: false, withPostedVouchers: false }));
  let workspace = confirmBankTransactionBusinessEvent(evidence.workspace, { transactionId: "txn-fee", businessType: "bankFee", account: "expenseFee",
    businessPeriod: "2026-08", taxTreatment: "input_non_deductible", invoiceStatus: "not_applicable", evidenceIds: ["doc-bank"], confidence: 100, reason: "已核对银行收费原件" }, context);
  const eventId = workspace.transactions.find((item) => item.id === "txn-fee").bankBusinessEventId;
  workspace = createBankBusinessEventVoucherDraft(workspace, { eventId }, context);
  return { workspace, eventId, fileVault: evidence.fileVault, voucherId: workspace.vouchers[0].id };
}

test("bank draft cancellation releases its source and can rebuild, verify originals and post exactly once", async () => {
  const { workspace, eventId, voucherId, fileVault } = await bankDraftFixture();
  const cancelled = cancelVoucherDraft(workspace, { voucherId, reason: "摘要填写错误" }, context);
  const event = cancelled.businessEvents.find((item) => item.id === eventId);
  assert.equal(event.status, "confirmed");
  assert.equal(event.accountingStatus, "pending");
  assert.equal(event.accountingAttributes.postingStatus, "pending");
  assert.equal(event.draftVoucherId, null);
  assert.equal(bankBusinessEventDraftStateAllowsCreation(cancelled, event), true);
  let rebuilt = createVoucherDraft(cancelled, { transactionId: "txn-fee" }, context);
  const newId = rebuilt.vouchers.at(-1).id;
  rebuilt = await postVoucherWithEvidence(rebuilt, { voucherId: newId, mode: "manual", reviewNote: "已核对收费回单原件" }, { ...context, fileVault });
  assert.equal(rebuilt.vouchers.find((item) => item.id === voucherId).status, "invalidated");
  assert.equal(rebuilt.businessEvents.find((item) => item.id === eventId).accountingStatus, "posted");
  const posted = effectivePostedVouchers(rebuilt);
  assert.equal(posted.length, 1);
  assert.equal(posted.flatMap((voucher) => voucher.lines).filter((line) => line.account === "expenseFee").reduce((total, line) => total + line.debit - line.credit, 0), 20);
  assert.throws(() => createVoucherDraft(rebuilt, { transactionId: "txn-fee" }, context), (error) => error.code === "SOURCE_ALREADY_VOUCHERED");
});

test("persisted bank draft pointers recover only from known closed vouchers and keep missing, unknown and posted sources blocked", async () => {
  const { workspace, eventId, voucherId } = await bankDraftFixture();
  for (const status of ["invalidated", "superseded", "cancelled"]) {
    const stored = structuredClone(workspace);
    stored.vouchers[0].status = status;
    assert.equal(bankBusinessEventDraftStateAllowsCreation(stored, stored.businessEvents.find((item) => item.id === eventId)), true);
    const next = createBankBusinessEventVoucherDraft(stored, { eventId }, context);
    assert.notEqual(next.businessEvents.find((item) => item.id === eventId).draftVoucherId, voucherId);
  }
  for (const status of ["missing", "unrecognized", "posted"]) {
    const stored = structuredClone(workspace);
    if (status === "missing") stored.vouchers = [];
    else stored.vouchers[0].status = status;
    assert.equal(bankBusinessEventDraftStateAllowsCreation(stored, stored.businessEvents.find((item) => item.id === eventId)), false);
    assert.throws(() => createBankBusinessEventVoucherDraft(stored, { eventId }, context), (error) => ["SOURCE_ALREADY_VOUCHERED", "BUSINESS_EVENT_DRAFT_STATE_UNRESOLVED"].includes(error.code));
  }
});

test("member cancellation restores ready state, rebuilds after a stale invalidated pointer, and leaves other posted sources intact", () => {
  let workspace = createBlankWorkspace({ id: "member-cancel", currentPeriod: "2026-08", modules: { members: true } });
  workspace.businessEvents = [{ id: "consumption", kind: "consumption", type: "memberConsumption", memberName: "会员甲", amount: 100,
    date: "2026-08-20", status: "confirmed", accountingStatus: "ready", source: "member-ledger" }];
  workspace = createMemberEventVoucherDraft(workspace, { eventId: "consumption" }, context);
  const voucherId = workspace.vouchers[0].id;
  const cancelled = cancelVoucherDraft(workspace, { voucherId, reason: "重新填写" }, context);
  assert.equal(cancelled.businessEvents[0].accountingStatus, "ready");
  Object.assign(cancelled.businessEvents[0], { draftVoucherId: voucherId, accountingStatus: "voucher_draft" });
  const rebuilt = createMemberEventVoucherDraft(cancelled, { eventId: "consumption" }, context);
  assert.equal(rebuilt.vouchers.filter((voucher) => voucher.status === "draft").length, 1);
  const posted = structuredClone(workspace);
  posted.vouchers[0].status = "posted";
  posted.vouchers.push({ id: "revision", period: "2026-08", status: "draft", revisionOf: voucherId, sourceIds: ["consumption"] });
  Object.assign(posted.businessEvents[0], { accountingStatus: "posted", postedVoucherId: voucherId, draftVoucherId: null });
  const after = cancelVoucherDraft(posted, { voucherId: "revision", reason: "保留原凭证" }, context);
  assert.deepEqual(after.businessEvents[0], posted.businessEvents[0]);
  assert.deepEqual(after.vouchers[0], posted.vouchers[0]);
});

test("an ordinary bank transaction draft can be rebuilt after cancellation without changing the cash transaction", () => {
  let workspace = createAccountingFixture({ withReconciliations: false, withPostedVouchers: false });
  workspace = createVoucherDraft(workspace, { transactionId: "txn-fee" }, context);
  const transactions = structuredClone(workspace.transactions);
  const oldId = workspace.vouchers[0].id;
  workspace = cancelVoucherDraft(workspace, { voucherId: oldId, reason: "重建草稿" }, context);
  workspace = createVoucherDraft(workspace, { transactionId: "txn-fee" }, context);
  assert.deepEqual(workspace.transactions, transactions);
  assert.equal(workspace.vouchers[0].status, "invalidated");
  assert.equal(workspace.vouchers[1].status, "draft");
});
