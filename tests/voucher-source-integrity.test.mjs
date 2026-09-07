import test from "node:test";
import assert from "node:assert/strict";
import { createBlankWorkspace } from "../src/domain/foundation.js";
import { createMemberEventVoucherDraft, createVoucherDraft, postVoucher, postVoucherWithEvidence } from "../src/domain/accounting/vouchers.js";
import { assessTransactionEvidence, assessVoucherEvidence, recordManualVoucherEvidenceFailure } from "../src/features/evidence/evidenceEngine.js";
import { buildMemberRechargeSourceOptions, linkMemberRechargeSource } from "../src/features/members/memberRechargeSources.js";
import { refreshLocalFileAvailability } from "../src/features/intake/documentIntake.js";
import { withVoucherEvidence } from "./helpers/voucherEvidenceFixture.mjs";

const context = { actor: "来源复核人", at: "2026-09-07T08:00:00.000Z" };
const postInput = (voucherId) => ({ voucherId, mode: "manual", reviewNote: "已核对真实来源及原件" });

function rechargeWorkspace() {
  const workspace = createBlankWorkspace({ id: "source-integrity", name: "会员来源测试", currentPeriod: "2026-09", modules: { members: true, payroll: false } });
  workspace.bankAccounts = [{ id: "bank:main", name: "经营账户" }];
  workspace.members = [{ id: "member-1", name: "会员甲" }];
  workspace.businessEvents = [{ id: "recharge-1", kind: "recharge", type: "memberRecharge", source: "member-ledger", date: "2026-09-07", memberId: "member-1", memberName: "会员甲", amount: 100, quantity: 1, status: "confirmed", accountingStatus: "ready" }];
  workspace.transactions = [{ id: "receipt-1", date: "2026-09-07", accountId: "bank:main", counterparty: "付款人", amount: 100, status: "pending", allocations: [],
    classification: { eventType: "memberRecharge", account: "contractLiability", confidence: 100, reasons: [], riskFlags: [] } }];
  return workspace;
}

test("manual recharge cannot post without explicitly selecting its real receipt", () => {
  const workspace = rechargeWorkspace();
  assert.equal(buildMemberRechargeSourceOptions(workspace, "recharge-1")[0].transactionId, "receipt-1");
  assert.equal(workspace.businessEvents[0].transactionId, undefined, "a matching amount never selects a source automatically");
  assert.throws(() => createMemberEventVoucherDraft(workspace, { eventId: "recharge-1" }, context), (error) => error.code === "MEMBER_RECHARGE_SOURCE_REQUIRED");
  const changed = structuredClone(workspace);
  changed.transactions[0].amount = 101;
  assert.throws(() => linkMemberRechargeSource(changed, { eventId: "recharge-1", transactionId: "receipt-1" }, context), (error) => error.code === "MEMBER_RECHARGE_AMOUNT_MISMATCH");
});

for (const first of ["member", "bank"]) test(`${first} draft first: either entry reuses the same receipt voucher`, async () => {
  let workspace = rechargeWorkspace();
  if (first === "bank") workspace = createVoucherDraft(workspace, { transactionId: "receipt-1" }, context);
  workspace = linkMemberRechargeSource(workspace, { eventId: "recharge-1", transactionId: "receipt-1" }, context);
  workspace = createMemberEventVoucherDraft(workspace, { eventId: "recharge-1" }, context);
  const id = workspace.vouchers[0].id;
  workspace = createVoucherDraft(workspace, { transactionId: "receipt-1" }, context);
  assert.equal(workspace.vouchers.length, 1);
  assert.ok(workspace.vouchers[0].sourceIds.includes("receipt-1"));
  const fixture = await withVoucherEvidence(workspace);
  workspace = await postVoucherWithEvidence(fixture.workspace, postInput(id), { ...context, fileVault: fixture.fileVault });
  assert.equal(workspace.businessEvents[0].postedVoucherId, id);
  assert.equal(workspace.transactions[0].postedVoucherId, id);
  assert.equal(createVoucherDraft(workspace, { transactionId: "receipt-1" }, context).vouchers.length, 1);
});

test("bank posted first: explicit recharge association preserves the posted journal", async () => {
  let workspace = createVoucherDraft(rechargeWorkspace(), { transactionId: "receipt-1" }, context);
  const fixture = await withVoucherEvidence(workspace);
  workspace = await postVoucherWithEvidence(fixture.workspace, postInput(workspace.vouchers[0].id), { ...context, fileVault: fixture.fileVault });
  const before = structuredClone(workspace.vouchers);
  workspace = linkMemberRechargeSource(workspace, { eventId: "recharge-1", transactionId: "receipt-1" }, context);
  workspace = createMemberEventVoucherDraft(workspace, { eventId: "recharge-1" }, context);
  assert.deepEqual(workspace.vouchers, before);
  assert.equal(workspace.businessEvents[0].accountingStatus, "posted");
});

for (const merged of [false, true]) test(`confirmed split allocations ${merged ? "with a merged liability line" : "for separate members"} preserve both real shares`, async () => {
  let workspace = rechargeWorkspace();
  workspace.members.push({ id: "member-2", name: "会员乙" });
  workspace.businessEvents[0].amount = 600;
  workspace.businessEvents.push({ ...workspace.businessEvents[0], id: "recharge-2", memberId: "member-2", memberName: "会员乙", amount: 400 });
  workspace.transactions[0].amount = 1000;
  workspace.bills = [
    { id: "bill-1", kind: "depositReceived", memberId: "member-1", counterparty: "会员甲", amount: 600, date: "2026-09-07", status: "active" },
    { id: "bill-2", kind: "depositReceived", memberId: "member-2", counterparty: "会员乙", amount: 400, date: "2026-09-07", status: "active" },
  ];
  if (merged) {
    Object.assign(workspace.businessEvents[1], { memberId: "member-1", memberName: "会员甲" });
    Object.assign(workspace.bills[1], { memberId: "member-1", counterparty: "会员甲" });
  }
  workspace.transactions[0].allocations = workspace.bills.map((bill, index) => ({ id: `allocation-${index + 1}`, transactionId: "receipt-1", billId: bill.id, amount: bill.amount, status: "confirmed" }));
  assert.throws(() => linkMemberRechargeSource(workspace, { eventId: "recharge-1", transactionId: "receipt-1" }, context), (error) => error.code === "MEMBER_RECHARGE_SOURCE_INVALID");
  workspace = linkMemberRechargeSource(workspace, { eventId: "recharge-1", transactionId: "receipt-1", allocationId: "allocation-1", billId: "bill-1" }, context);
  workspace = linkMemberRechargeSource(workspace, { eventId: "recharge-2", transactionId: "receipt-1", allocationId: "allocation-2", billId: "bill-2" }, context);
  workspace = createMemberEventVoucherDraft(workspace, { eventId: "recharge-1" }, context);
  workspace = createMemberEventVoucherDraft(workspace, { eventId: "recharge-2" }, context);
  assert.equal(workspace.vouchers.length, 1);
  assert.deepEqual(workspace.vouchers[0].lines.filter((line) => line.account === "contractLiability").map((line) => line.credit).sort(), merged ? [1000] : [400, 600]);
  const fixture = await withVoucherEvidence(workspace);
  workspace = await postVoucherWithEvidence(fixture.workspace, postInput(workspace.vouchers[0].id), { ...context, fileVault: fixture.fileVault });
  assert.ok(workspace.businessEvents.every((event) => event.accountingStatus === "posted"));
  assert.equal(workspace.vouchers.filter((voucher) => voucher.status === "posted").length, 1);
});

async function ordinaryDraft() {
  const workspace = rechargeWorkspace();
  workspace.businessEvents = [];
  workspace.transactions[0].amount = -20;
  workspace.transactions[0].classification = { eventType: "bankFee", account: "expenseFee", confidence: 100, reasons: [], riskFlags: [] };
  return withVoucherEvidence(createVoucherDraft(workspace, { transactionId: "receipt-1" }, context));
}

test("ordinary voucher requires current original proof; saved metadata and manual approval are insufficient", async () => {
  const { workspace, fileVault } = await ordinaryDraft();
  const voucher = workspace.vouchers[0];
  workspace.transactions[0].manualConfirmation = { decision: "approve", reason: "已确认业务" };
  assert.equal(assessVoucherEvidence(workspace, voucher).complete, true);
  assert.throws(() => postVoucher(workspace, postInput(voucher.id), context), (error) => error.code === "VOUCHER_ORIGINAL_REQUIRED");
  await fileVault.delete("fixture-original-bankStatement");
  await assert.rejects(postVoucherWithEvidence(workspace, postInput(voucher.id), { ...context, fileVault }), (error) => error.code === "VOUCHER_ORIGINAL_REQUIRED");
  const failed = recordManualVoucherEvidenceFailure(workspace, voucher.id, "银行原件丢失", context);
  assert.equal(failed.exceptionTasks.find((task) => task.sourceId === voucher.id).status, "open");
  assert.equal(failed.vouchers[0].status, "draft");
});

for (const corruption of ["hash", "size", "workspace"]) test(`ordinary voucher rejects ${corruption} mismatch`, async () => {
  const { workspace, fileVault } = await ordinaryDraft();
  const id = "fixture-original-bankStatement";
  const record = await fileVault.get(id);
  if (corruption === "hash") record.blob = new Blob(["x".repeat(record.blob.size)]);
  if (corruption === "size") workspace.documents.find((document) => document.id === id).size += 1;
  if (corruption === "workspace") record.workspaceId = "another-workspace";
  await fileVault.put(record);
  await assert.rejects(postVoucherWithEvidence(workspace, postInput(workspace.vouchers[0].id), { ...context, fileVault }), (error) => error.code === "VOUCHER_ORIGINAL_REQUIRED");
  assert.equal(workspace.vouchers[0].status, "draft");
});

test("an indexed bank row does not stand in for its missing statement file", () => {
  const workspace = rechargeWorkspace();
  const assessment = assessTransactionEvidence(workspace, workspace.transactions[0]);
  assert.ok(assessment.missing.some((group) => group.id === "bank"));
});

test("line-only sources participate in source validity and unresolved-task checks", async () => {
  const { workspace, fileVault } = await ordinaryDraft();
  workspace.approvals = [{ id: "approval-1", status: "approved" }];
  workspace.vouchers[0].lines[0].sourceIds.push("approval-1");
  workspace.exceptionTasks = [{ id: "approval-task", sourceId: "approval-1", status: "open", code: "approval_review", message: "审批待复核" }];
  await assert.rejects(postVoucherWithEvidence(workspace, postInput(workspace.vouchers[0].id), { ...context, fileVault }), (error) => error.code === "UNRESOLVED_EXCEPTION");
  workspace.exceptionTasks = [];
  workspace.approvals[0].status = "withdrawn";
  await assert.rejects(postVoucherWithEvidence(workspace, postInput(workspace.vouchers[0].id), { ...context, fileVault }), (error) => error.code === "VOUCHER_EVIDENCE_REQUIRED");
});

function refreshStore() {
  let workspace = { id: "refresh-workspace", bills: [], documents: [{ id: "doc-1", hash: "hash-1", name: "原件", storage: { mode: "indexeddb", blobId: "blob-1", availableLocally: true } }] };
  let writable = true;
  const writes = [];
  return { writes, getState: () => ({ workspaces: [workspace] }), getPersistenceStatus: () => ({ canWrite: writable }),
    setWritable(value) { writable = value; }, change(update) { workspace = update(workspace); },
    actions: { replaceWorkspace(id, next) { writes.push(next); workspace = next; } } };
}

test("file availability merges only unchanged storage into the latest workspace", async () => {
  const store = refreshStore();
  let finish;
  const pending = refreshLocalFileAvailability({ store, fileVault: { get: () => new Promise((resolve) => { finish = resolve; }) } });
  store.change((workspace) => ({ ...workspace, bills: [{ id: "new-bill" }], documents: [...workspace.documents, { id: "new-doc", name: "新增资料" }] }));
  finish(null);
  await pending;
  assert.deepEqual(store.getState().workspaces[0].bills, [{ id: "new-bill" }]);
  assert.equal(store.getState().workspaces[0].documents[1].id, "new-doc");
  assert.equal(store.getState().workspaces[0].documents[0].storage.availableLocally, false);
});

test("file availability never overwrites edited documents or writes after losing ownership", async () => {
  for (const stop of ["edited", "readonly"]) {
    const store = refreshStore();
    let finish;
    const pending = refreshLocalFileAvailability({ store, fileVault: { get: () => new Promise((resolve) => { finish = resolve; }) } });
    if (stop === "edited") store.change((workspace) => ({ ...workspace, documents: [{ ...workspace.documents[0], name: "异步期间已编辑" }] }));
    else store.setWritable(false);
    finish(null);
    await pending;
    assert.equal(store.writes.length, 0);
  }
  const store = refreshStore();
  store.setWritable(false);
  await refreshLocalFileAvailability({ store, fileVault: { get() { throw new Error("readonly scan should not start"); } } });
  assert.equal(store.writes.length, 0);
});
