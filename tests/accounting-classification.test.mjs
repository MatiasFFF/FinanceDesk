import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyBankTransaction,
  classifyWorkspaceTransactions,
  recognizeBusinessEvent,
} from "../src/domain/accounting/classification.js";
import { createAccountingFixture } from "../src/domain/accounting/fixtures.js";
import { EVENT_TYPES } from "../src/domain/accounting/model.js";
import { withVoucherEvidence } from "./helpers/voucherEvidenceFixture.mjs";
import {
  assessTransactionEvidence,
  attachEvidenceDocument,
  recordManualConfirmation,
  reviewTransactionEvidence,
  unresolvedExceptionTasks,
} from "../src/features/evidence/evidenceEngine.js";

const context = { actor: "测试会计", at: "2026-09-06T11:00:00.000Z" };

test("local rules recognize bill collection, deposit, refund, transfer and unknown business", () => {
  const workspace = createAccountingFixture({ withReconciliations: false, withPostedVouchers: false });
  const byId = Object.fromEntries(workspace.transactions.map((item) => [item.id, item]));

  assert.equal(classifyBankTransaction(workspace, byId["txn-split"]).eventType, EVENT_TYPES.CUSTOMER_RECEIPT);
  assert.equal(classifyBankTransaction(workspace, byId["txn-deposit"]).eventType, EVENT_TYPES.MEMBER_RECHARGE);
  assert.equal(classifyBankTransaction(workspace, byId["txn-refund"]).eventType, EVENT_TYPES.REFUND);
  assert.equal(classifyBankTransaction(workspace, byId["txn-transfer-out"]).eventType, EVENT_TYPES.INTERNAL_TRANSFER);
  assert.equal(classifyBankTransaction(workspace, byId["txn-low"]).eventType, EVENT_TYPES.UNKNOWN);

  const event = recognizeBusinessEvent(workspace, byId["txn-followup"]);
  assert.equal(event.businessPeriod, "2026-08");
  assert.equal(event.fundingPeriod, "2026-09");
  assert.ok(event.sourceIds.includes("bill-ar-2"));
  assert.equal(classifyWorkspaceTransactions(workspace).length, workspace.transactions.length);
});

test("evidence assessment blocks low-confidence and incomplete transactions", () => {
  const workspace = createAccountingFixture({ withReconciliations: false, withPostedVouchers: false });
  const low = workspace.transactions.find((item) => item.id === "txn-low");
  const lowAssessment = assessTransactionEvidence(workspace, low);
  assert.deepEqual(lowAssessment.issues.map((item) => item.code).sort(), ["low_confidence", "unknown_business"]);
  assert.equal(lowAssessment.canAutomaticallyPost, false);

  const reviewed = reviewTransactionEvidence(workspace, "txn-low", context);
  assert.equal(reviewed.transactions.find((item) => item.id === "txn-low").status, "exception");
  assert.deepEqual(unresolvedExceptionTasks(reviewed, "txn-low").map((item) => item.code).sort(), ["low_confidence", "unknown_business"]);
  assert.equal(reviewed.auditLog.at(-1).action, "evidence.review");
});

test("the active S1 rule set changes the real review threshold", () => {
  const workspace = createAccountingFixture({ withReconciliations: false, withPostedVouchers: false });
  workspace.rules.confidenceThreshold = 85;
  workspace.ruleSets = [{
    id: "rule-set-live",
    name: "当前本地规则",
    status: "active",
    confidenceThreshold: 95,
    updatedAt: "2026-09-06T12:00:00.000Z",
  }];
  const transaction = workspace.transactions.find((item) => item.id === "txn-refund");

  const strictAssessment = assessTransactionEvidence(workspace, transaction);
  assert.equal(strictAssessment.issues.some((item) => item.code === "low_confidence"), true);

  workspace.ruleSets[0].confidenceThreshold = 90;
  const relaxedAssessment = assessTransactionEvidence(workspace, transaction);
  assert.equal(relaxedAssessment.issues.some((item) => item.code === "low_confidence"), false);
});

test("supplemented evidence returns to explicit human review instead of silently posting", async () => {
  const { workspace } = await withVoucherEvidence(createAccountingFixture({ withReconciliations: false, withPostedVouchers: false }));
  const deposit = workspace.transactions.find((item) => item.id === "txn-deposit");
  deposit.sourceDocumentId = "doc-bank";
  deposit.evidenceIds = [];

  const reviewed = reviewTransactionEvidence(workspace, "txn-deposit", context);
  const open = unresolvedExceptionTasks(reviewed, "txn-deposit");
  assert.equal(open.some((task) => task.code === "missing_evidence" && task.status === "open"), true);

  const attached = attachEvidenceDocument(reviewed, {
    transactionId: "txn-deposit",
    documentId: "doc-member-contract",
  }, { ...context, at: "2026-09-06T11:05:00.000Z" });
  const ready = unresolvedExceptionTasks(attached, "txn-deposit");
  assert.equal(ready.some((task) => task.code === "missing_evidence" && task.status === "ready_for_review"), true);
  assert.notEqual(attached.transactions.find((item) => item.id === "txn-deposit").status, "posted");

  const confirmed = recordManualConfirmation(attached, {
    transactionId: "txn-deposit",
    decision: "approve",
    reason: "已核对会员协议与充值订单，允许回到待核销队列",
  }, { ...context, at: "2026-09-06T11:10:00.000Z" });
  assert.equal(unresolvedExceptionTasks(confirmed, "txn-deposit").length, 0);
  assert.equal(confirmed.transactions.find((item) => item.id === "txn-deposit").status, "pending");
  assert.equal(confirmed.auditLog.at(-1).action, "evidence.manual_approve");
});

test("complete high-confidence supplier payment is eligible for automatic posting review", async () => {
  const { workspace } = await withVoucherEvidence(createAccountingFixture({ withReconciliations: false, withPostedVouchers: false }));
  const transaction = workspace.transactions.find((item) => item.id === "txn-payable");
  const classification = classifyBankTransaction(workspace, transaction);
  const assessment = assessTransactionEvidence(workspace, transaction, classification);
  assert.equal(classification.eventType, EVENT_TYPES.SUPPLIER_SETTLEMENT);
  assert.equal(assessment.completeness, 100);
  assert.equal(assessment.canAutomaticallyPost, true);
});
