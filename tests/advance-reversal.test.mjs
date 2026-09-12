import assert from "node:assert/strict";
import test from "node:test";
import { createBlankWorkspace, createInitialState, getWorkspace } from "../src/domain/foundation.js";
import { activateWorkspacePeriod, isPeriodArchived } from "../src/domain/periods.js";
import { createAccountingFixture } from "../src/domain/accounting/fixtures.js";
import { cancelVoucherDraft, createAdvanceApplicationVoucherDraft, createVoucherDraft, postVoucherWithEvidence } from "../src/domain/accounting/vouchers.js";
import { advanceBalance, applyAdvanceToBill, applyReconciliation, billSettlement, buildAdvanceBalances,
  commitReconciliationCorrection, createReconciliationCorrection, reverseAdvanceApplication, reverseReconciliation,
} from "../src/features/reconciliation/reconciliationEngine.js";
import { createFinanceDeskService, reverseWorkspaceAdvanceApplication } from "../src/application/financeDeskService.js";
import { createFinanceDeskStore } from "../src/store/financeDeskStore.js";
import { createLocalFoundationRepository, createMemoryStorage } from "../src/storage/localFoundationRepository.js";
import { withVoucherEvidence } from "./helpers/voucherEvidenceFixture.mjs";

const context = { actor: "测试会计", at: "2026-09-12T08:00:00.000Z", mode: "manual" };
const asOf = "2026-08-31";

function fixture({ kind = "deposit", applied = true, splitFunding = false } = {}) {
  const blank = createBlankWorkspace({ id: "advance-target", currentPeriod: "2026-08" });
  let workspace = { ...blank, ...createAccountingFixture({ withReconciliations: false, withPostedVouchers: false }), id: blank.id, exceptionTasks: [] };
  const advanceBillId = kind === "deposit" ? "bill-deposit-1" : "bill-prepay-1";
  const transactionId = kind === "deposit" ? "txn-deposit" : "txn-prepay";
  const source = workspace.bills.find((bill) => bill.id === advanceBillId);
  workspace.bills.push({ id: "target", no: "对应账单", kind: kind === "deposit" ? "receivable" : "payable", counterparty: source.counterparty,
    amount: 1000, date: "2026-08-25", businessPeriod: "2026-08", summary: "八月应收应付", evidenceIds: source.evidenceIds });
  workspace = applyReconciliation(workspace, { transactionId, allocations: [{ billId: advanceBillId, amount: splitFunding ? 600 : source.amount }] }, context);
  if (splitFunding) {
    const original = workspace.transactions.find((transaction) => transaction.id === transactionId);
    workspace.transactions.push({ ...structuredClone(original), id: "extra-funding", amount: 1800, allocations: [], serial: "EXTRA-FUNDING", status: "pending" });
    workspace = applyReconciliation(workspace, { transactionId: "extra-funding", allocations: [{ billId: advanceBillId, amount: 1800 }] }, context);
  }
  if (applied) workspace = applyAdvanceToBill(workspace, { advanceBillId, targetBillId: "target", amount: 600 }, context);
  return { workspace, advanceBillId, transactionId, applicationId: workspace.advanceApplications?.[0]?.id };
}

for (const kind of ["deposit", "prepayment"]) test(`${kind}: September cancellation restores August balances, preserves history and only cancels owned drafts/tasks`, () => {
  let { workspace, advanceBillId, applicationId } = fixture({ kind });
  workspace = createAdvanceApplicationVoucherDraft(workspace, { applicationId }, context);
  const draft = workspace.vouchers[0];
  workspace = applyAdvanceToBill(workspace, { advanceBillId, targetBillId: "target", amount: 100 }, context);
  const otherApplication = structuredClone(workspace.advanceApplications[1]);
  workspace.vouchers.push({ id: "other-draft", period: "2026-08", status: "draft", sourceIds: [otherApplication.id], lines: [] });
  workspace.exceptionTasks = [
    { id: "draft-task", sourceId: draft.id, status: "open" }, { id: "application-task", sourceId: applicationId, status: "open" },
    { id: "business-task", sourceId: advanceBillId, sourceIds: [applicationId, draft.id], status: "open" },
    { id: "other-task", sourceId: "other-draft", status: "open" },
  ];
  const original = structuredClone(workspace);
  const next = reverseAdvanceApplication(workspace, { applicationId, reason: "选择了错误账单" }, context);
  assert.deepEqual(workspace, original, "the domain operation does not mutate the input");
  assert.equal(advanceBalance(next, advanceBillId, { asOf }).usedAmount, 100);
  assert.equal(advanceBalance(next, advanceBillId, { asOf }).availableBalance, kind === "deposit" ? 2300 : 1700);
  assert.equal(billSettlement(next, "target", { asOf }).remaining, 900);
  assert.deepEqual(next.transactions, original.transactions, "original cash funding stays intact");
  assert.deepEqual(next.bills, original.bills, "bill face amounts stay intact");
  assert.deepEqual(next.advanceApplications[1], otherApplication);
  assert.equal(next.vouchers[0].status, "invalidated");
  assert.equal(next.vouchers[1].status, "draft");
  assert.deepEqual(next.exceptionTasks.map((task) => task.status), ["resolved", "resolved", "open", "open"]);
  const application = next.advanceApplications[0];
  assert.equal(application.status, "cancelled");
  assert.equal(application.cancelledAt, context.at);
  assert.equal(application.cancellationReason, "选择了错误账单");
  assert.equal(application.draftVoucherId, null);
  const row = buildAdvanceBalances(next, { asOf }).rows.find((item) => item.billId === advanceBillId);
  assert.equal(row.applications.length, 1);
  assert.equal(row.applicationHistory.length, 2);
  assert.equal(row.applicationHistory[0].cancellationReason, application.cancellationReason);
  assert.throws(() => reverseAdvanceApplication(next, { applicationId, reason: "再次点击" }, context), (error) => error.code === "ADVANCE_APPLICATION_NOT_ACTIVE");
  assert.throws(() => createAdvanceApplicationVoucherDraft(next, { applicationId }, context), (error) => error.code === "ADVANCE_APPLICATION_NOT_CONFIRMED");
});

test("cancelling just the advance draft keeps the application effective and allows a new draft, including persisted stale pointers", () => {
  let { workspace, applicationId, advanceBillId } = fixture();
  workspace = createAdvanceApplicationVoucherDraft(workspace, { applicationId }, context);
  const oldDraft = workspace.vouchers[0].id;
  const cancelled = cancelVoucherDraft(workspace, { voucherId: oldDraft, reason: "重新填写摘要" }, context);
  assert.equal(cancelled.advanceApplications[0].accountingStatus, "unprocessed");
  assert.equal(cancelled.advanceApplications[0].draftVoucherId, null);
  assert.equal(advanceBalance(cancelled, advanceBillId, { asOf }).usedAmount, 600);
  for (const stalePointer of [false, true]) {
    const stored = structuredClone(cancelled);
    if (stalePointer) Object.assign(stored.advanceApplications[0], { accountingStatus: "voucher_draft", draftVoucherId: oldDraft });
    const rebuilt = createAdvanceApplicationVoucherDraft(stored, { applicationId }, context);
    assert.equal(rebuilt.vouchers[0].status, "invalidated");
    assert.equal(rebuilt.vouchers[1].status, "draft");
    assert.equal(rebuilt.advanceApplications[0].draftVoucherId, rebuilt.vouchers[1].id);
  }
});

test("advance reversal rejects indirect posted sources, archived/wrong periods and missing reasons without mutation", () => {
  const { workspace, applicationId } = fixture();
  for (const link of [{ advanceApplicationId: applicationId }, { sourceIds: [applicationId] }, { lines: [{ sourceIds: [applicationId] }] }]) {
    const posted = structuredClone(workspace);
    posted.vouchers.push({ id: "posted-indirect", period: "2026-08", status: "posted", ...link });
    const before = structuredClone(posted);
    assert.throws(() => reverseAdvanceApplication(posted, { applicationId, reason: "误操作" }, context), (error) => error.code === "POSTED_ADVANCE_CORRECTION_REQUIRED");
    assert.deepEqual(posted, before);
  }
  const archived = structuredClone(workspace);
  archived.delivery.archives = [{ period: "2026-08" }];
  assert.throws(() => reverseAdvanceApplication(archived, { applicationId, reason: "误操作" }, context), (error) => error.code === "PERIOD_ARCHIVED");
  assert.throws(() => reverseAdvanceApplication(activateWorkspacePeriod(workspace, "2026-09"), { applicationId, reason: "误操作" }, context), (error) => error.code === "HISTORICAL_PERIOD_IMMUTABLE");
  assert.throws(() => reverseAdvanceApplication(workspace, { applicationId, reason: " " }, context), (error) => error.code === "ADVANCE_REVERSAL_REASON_REQUIRED");
});

test("funding withdrawal rejects uncovered usage and succeeds after reversal, including August asOf balances", () => {
  const { workspace, applicationId, advanceBillId, transactionId } = fixture();
  const allocationId = workspace.transactions.find((transaction) => transaction.id === transactionId).allocations[0].id;
  const original = structuredClone(workspace);
  assert.throws(() => reverseReconciliation(workspace, { allocationId, reason: "撤原收款" }, context), (error) => error.code === "ADVANCE_FUNDING_IN_USE" && error.message.includes("先撤回") && error.message.includes("对应账单"));
  assert.deepEqual(workspace, original);
  let next = reverseAdvanceApplication(workspace, { applicationId, reason: "先撤回误用" }, context);
  next = reverseReconciliation(next, { allocationId, reason: "撤原收款" }, context);
  assert.equal(advanceBalance(next, advanceBillId, { asOf }).fundedAmount, 0);
  assert.equal(advanceBalance(next, advanceBillId, { asOf }).usedAmount, 0);
  assert.equal(billSettlement(next, "target", { asOf }).remaining, 1000);
  const allocation = next.transactions.find((transaction) => transaction.id === transactionId).allocations[0];
  assert.equal(allocation.reversedAt, context.at);
  assert.equal(allocation.reversalEffectiveDate, "2026-08-18");
});

test("surplus funding can be withdrawn while the other funding still covers the application", () => {
  const { workspace, advanceBillId } = fixture({ splitFunding: true });
  const allocationId = workspace.transactions.find((transaction) => transaction.id === "extra-funding").allocations[0].id;
  const next = reverseReconciliation(workspace, { allocationId, reason: "撤销多余资金关联" }, context);
  assert.equal(advanceBalance(next, advanceBillId, { asOf }).fundedAmount, 600);
  assert.equal(advanceBalance(next, advanceBillId, { asOf }).usedAmount, 600);
  assert.equal(billSettlement(next, "target", { asOf }).remaining, 400);
  assert.equal(next.advanceApplications[0].status, "confirmed");
});

test("September funding cannot cover an August application when earlier funding is withdrawn", () => {
  let { workspace, advanceBillId, transactionId } = fixture({ splitFunding: true });
  workspace.transactions.push({ id: "future-funding", date: "2026-09-10", amount: 1000, status: "confirmed", allocations: [
    { id: "future-allocation", transactionId: "future-funding", billId: advanceBillId, status: "confirmed", amount: 1000 },
  ] });
  const originalAllocationId = workspace.transactions.find((transaction) => transaction.id === transactionId).allocations[0].id;
  const extraAllocationId = workspace.transactions.find((transaction) => transaction.id === "extra-funding").allocations[0].id;
  workspace = reverseReconciliation(workspace, { allocationId: originalAllocationId, reason: "先撤600" }, context);
  assert.equal(advanceBalance(workspace, advanceBillId, { asOf }).fundedAmount, 1800);
  assert.throws(() => reverseReconciliation(workspace, { allocationId: extraAllocationId, reason: "再撤1800" }, context),
    (error) => error.code === "ADVANCE_FUNDING_IN_USE" && error.details.period === "2026-08");
  assert.equal(advanceBalance(workspace, advanceBillId, { asOf }).usedAmount, 600);
});

test("withdrawing surplus funding rebuilds the advance draft from current sources and posts with originals, retaining historical source IDs", async () => {
  let { workspace, advanceBillId, applicationId, transactionId } = fixture({ splitFunding: true });
  workspace.vouchers.push({ id: "target-recognition", no: "记-确认", date: "2026-08-25", period: "2026-08", status: "posted", sourceIds: ["target"], lines: [
    { account: "receivable", debit: 1000, credit: 0, sourceIds: ["target"] },
    { account: "revenuePrivate", debit: 0, credit: 1000, sourceIds: ["target"] },
  ] });
  workspace = createAdvanceApplicationVoucherDraft(workspace, { applicationId }, context);
  const oldVoucher = structuredClone(workspace.vouchers.at(-1));
  const historicalSources = structuredClone(workspace.advanceApplications[0].sourceIds);
  const allocationId = workspace.transactions.find((transaction) => transaction.id === transactionId).allocations[0].id;
  workspace = reverseReconciliation(workspace, { allocationId, reason: "撤销多余600元关联" }, context);
  assert.equal(workspace.vouchers.find((voucher) => voucher.id === oldVoucher.id).status, "invalidated");
  assert.equal(workspace.advanceApplications[0].accountingStatus, "unprocessed");
  workspace = createAdvanceApplicationVoucherDraft(workspace, { applicationId }, context);
  const draft = workspace.vouchers.at(-1);
  assert.ok(!draft.sourceIds.includes(allocationId));
  assert.deepEqual(workspace.advanceApplications[0].sourceIds, historicalSources);
  assert.deepEqual(workspace.vouchers.find((voucher) => voucher.id === oldVoucher.id).sourceIds, oldVoucher.sourceIds);
  const evidence = await withVoucherEvidence(workspace);
  const input = { voucherId: draft.id, mode: "manual", reviewNote: "核对剩余1800资金及原件，冲销600" };
  const invalid = structuredClone(evidence.workspace);
  invalid.vouchers.at(-1).sourceIds.push(allocationId);
  await assert.rejects(postVoucherWithEvidence(invalid, input, { ...context, fileVault: evidence.fileVault }), (error) => error.code === "VOUCHER_EVIDENCE_REQUIRED");
  await assert.rejects(postVoucherWithEvidence(evidence.workspace, input, context), (error) => ["VOUCHER_EVIDENCE_REQUIRED", "VOUCHER_ORIGINAL_REQUIRED"].includes(error.code));
  const posted = await postVoucherWithEvidence(evidence.workspace, input, { ...context, fileVault: evidence.fileVault });
  assert.equal(posted.vouchers.filter((voucher) => voucher.advanceApplicationId === applicationId && voucher.status === "posted").length, 1);
  assert.equal(posted.advanceApplications[0].accountingStatus, "posted");
  assert.equal(advanceBalance(posted, advanceBillId, { asOf }).fundedAmount, 1800);
  assert.equal(billSettlement(posted, "target", { asOf }).remaining, 400);
});

function postedFunding({ applied, splitFunding = false }) {
  let { workspace, advanceBillId, transactionId } = fixture({ applied, splitFunding });
  transactionId = splitFunding ? "extra-funding" : transactionId;
  workspace = createVoucherDraft(workspace, { transactionId }, context);
  const voucher = workspace.vouchers.at(-1);
  Object.assign(voucher, { status: "posted", no: "记-资金" });
  workspace.bills.push({ ...structuredClone(workspace.bills.find((bill) => bill.id === advanceBillId)), id: "replacement-bill", no: "新的资金归属" });
  const allocationId = workspace.transactions.find((transaction) => transaction.id === transactionId).allocations[0].id;
  return { workspace, advanceBillId, allocationId };
}

test("funding correction checks coverage both when prepared and when committed against latest applications", () => {
  const used = postedFunding({ applied: true });
  used.workspace.transactions.push({ id: "future-funding", date: "2026-09-10", amount: 2400, status: "confirmed", allocations: [
    { id: "future-allocation", transactionId: "future-funding", billId: used.advanceBillId, status: "confirmed", amount: 2400 },
  ] });
  assert.throws(() => createReconciliationCorrection(used.workspace, { allocationId: used.allocationId, billId: "replacement-bill", reason: "换错目标" }, context), (error) => error.code === "ADVANCE_FUNDING_IN_USE");
  const unused = postedFunding({ applied: false });
  let planned = createReconciliationCorrection(unused.workspace, { allocationId: unused.allocationId, billId: "replacement-bill", reason: "准备更正" }, context);
  planned = applyAdvanceToBill(planned, { advanceBillId: unused.advanceBillId, targetBillId: "target", amount: 600 }, context);
  planned.transactions.push({ id: "future-funding", date: "2026-09-10", amount: 2400, status: "confirmed", allocations: [
    { id: "future-allocation", transactionId: "future-funding", billId: unused.advanceBillId, status: "confirmed", amount: 2400 },
  ] });
  const before = structuredClone(planned);
  assert.throws(() => commitReconciliationCorrection(planned, planned.vouchers.at(-1), context), (error) => error.code === "ADVANCE_FUNDING_IN_USE");
  assert.deepEqual(planned, before, "a stale correction plan must not replace funding before rejection");
  const surplus = postedFunding({ applied: true, splitFunding: true });
  const allowed = createReconciliationCorrection(surplus.workspace, { allocationId: surplus.allocationId, billId: "replacement-bill", reason: "只转移多余资金" }, context);
  commitReconciliationCorrection(allowed, allowed.vouchers.at(-1), context);
  assert.equal(advanceBalance(allowed, surplus.advanceBillId, { asOf }).fundedAmount, 600);
  assert.equal(advanceBalance(allowed, surplus.advanceBillId, { asOf }).usedAmount, 600);
});

test("the shared reversal service saves the explicit workspace and August period without changing the displayed workspace or month", async () => {
  const { workspace, applicationId, advanceBillId } = fixture();
  const view = createBlankWorkspace({ id: "view", currentPeriod: "2026-09" });
  const target = activateWorkspacePeriod(workspace, "2026-09");
  const repository = createLocalFoundationRepository({ storage: createMemoryStorage() });
  repository.save({ ...createInitialState(), workspaces: [view, target], activeWorkspaceId: view.id, activeUserId: null });
  const store = createFinanceDeskStore({ repository });
  const beforeView = structuredClone(getWorkspace(store.getState(), view.id));
  const service = createFinanceDeskService({ store });
  const input = { workspaceId: target.id, period: "2026-08", applicationId, reason: "八月误用" };
  assert.equal((await service.invoke("reverseAdvanceApplication", { ...input, actor: "伪造负责人" })).error.code, "INVALID_OPERATION_INPUT");
  assert.equal((await service.invoke("reverseAdvanceApplication", { ...input, period: "2026-09" })).ok, false);
  assert.equal((await service.invoke("reverseAdvanceApplication", { ...input, workspaceId: view.id })).ok, false);
  const result = reverseWorkspaceAdvanceApplication({ store }, input);
  assert.equal(result.application.status, "cancelled");
  assert.equal(result.advance.availableBalance, 2400);
  assert.equal(result.target.remaining, 1000);
  assert.equal(store.getState().activeWorkspaceId, view.id);
  assert.deepEqual(getWorkspace(store.getState(), view.id), beforeView);
  assert.equal(getWorkspace(store.getState(), target.id).currentPeriod, "2026-09");
  const reloaded = createFinanceDeskStore({ repository });
  assert.equal(advanceBalance(getWorkspace(reloaded.getState(), target.id), advanceBillId, { asOf }).availableBalance, 2400);
  assert.equal((await service.invoke("reverseAdvanceApplication", input)).error.code, "ADVANCE_APPLICATION_NOT_ACTIVE");
});

for (const scenario of ["archived", "read-only"]) test(`the shared reversal service rejects ${scenario} workspaces without committing`, () => {
    const { workspace, applicationId } = fixture();
    if (scenario === "archived") workspace.delivery.archives = [{ id: "archive-august", period: "2026-08" }];
    else workspace.users = [{ id: "reader", name: "资料协作者", roleId: "role-staff", status: "active" }];
    const repository = createLocalFoundationRepository({ storage: createMemoryStorage() });
    repository.save({ ...createInitialState(), workspaces: [workspace], activeWorkspaceId: workspace.id, activeUserId: scenario === "read-only" ? "reader" : null });
    const store = createFinanceDeskStore({ repository });
    const before = structuredClone(store.getState());
    if (scenario === "archived") assert.equal(isPeriodArchived(store.getActiveWorkspace(), "2026-08"), true, "the persisted archive must survive repository normalization");
    else {
      assert.equal(store.getState().activeUserId, "reader");
      assert.equal(store.getActiveWorkspace().roles.find((role) => role.id === "role-staff").permissions.includes("data.write"), false);
    }
    assert.throws(() => reverseWorkspaceAdvanceApplication({ store }, { workspaceId: workspace.id, period: "2026-08", applicationId, reason: "不能撤回" }),
      scenario === "archived" ? /归档/ : /缺少权限 data.write/);
    assert.deepEqual(store.getState(), before);
});
