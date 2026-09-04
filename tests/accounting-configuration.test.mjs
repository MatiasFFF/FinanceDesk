import assert from "node:assert/strict";
import test from "node:test";

import { createAccountingFixture } from "../src/domain/accounting/fixtures.js";
import { buildJournalLedger } from "../src/domain/accounting/ledger.js";
import {
  accountDefinition,
  accountingRules,
  saveActiveAccountingRuleSet,
  setWorkspaceAccountStatus,
  upsertWorkspaceAccount,
  workspaceAccountDefinitions,
} from "../src/domain/accounting/model.js";
import { buildLedger } from "../src/domain/accounting/reporting.js";

const context = {
  actor: "测试会计",
  at: "2026-09-07T09:00:00.000Z",
  mode: "manual",
};

test("基础科目可直接改名并贯穿凭证账簿与报表明细", () => {
  const workspace = createAccountingFixture();
  const next = upsertWorkspaceAccount(workspace, {
    id: "revenueGroup",
    name: "企业课程服务收入",
    category: "revenue",
    normalSide: "credit",
    cash: false,
  }, context);

  assert.equal(workspace.chartOfAccounts, undefined, "原工作台不应被原地修改");
  assert.equal(accountDefinition("revenueGroup", next).label, "企业课程服务收入");
  assert.equal(next.chartOfAccounts.find((account) => account.id === "revenueGroup").builtInOverride, true);
  assert.equal(next.auditLog.at(-1).action, "account.update");
  assert.equal(next.auditLog.at(-1).entityId, "revenueGroup");

  const journalLine = buildJournalLedger(next, { period: "2026-08", account: "revenueGroup" }).rows[0];
  const reportAccount = buildLedger(next, { period: "2026-08" }).accounts
    .find((account) => account.accountId === "revenueGroup");
  assert.equal(journalLine.accountLabel, "企业课程服务收入");
  assert.equal(reportAccount.account.label, "企业课程服务收入");
});

test("可新增科目并停用科目，历史名称仍可解析", () => {
  const workspace = createAccountingFixture();
  const created = upsertWorkspaceAccount(workspace, {
    name: "渠道服务费",
    category: "expense",
    normalSide: "debit",
    cash: false,
  }, context);
  const account = created.chartOfAccounts.find((item) => item.name === "渠道服务费");

  assert.equal(account.id, "account-0001");
  assert.equal(account.status, "active");
  assert.equal(created.auditLog.at(-1).action, "account.create");
  assert.equal(accountDefinition(account.id, created).label, "渠道服务费");

  const inactive = setWorkspaceAccountStatus(created, { accountId: account.id, status: "inactive" }, {
    ...context,
    at: "2026-09-07T09:05:00.000Z",
  });
  assert.equal(workspaceAccountDefinitions(inactive).find((item) => item.id === account.id).status, "inactive");
  assert.equal(accountDefinition(account.id, inactive).label, "渠道服务费");
  assert.equal(inactive.auditLog.at(-1).action, "account.deactivate");
});

test("当前有效规则集保存全部五项规则并被 accountingRules 消费", () => {
  const workspace = createAccountingFixture();
  workspace.ruleSets = [{
    id: "rule-set-live",
    name: "原规则",
    status: "active",
    confidenceThreshold: 85,
    updatedAt: "2026-09-06T08:00:00.000Z",
  }];
  const next = saveActiveAccountingRuleSet(workspace, {
    name: "严格复核规则",
    confidenceThreshold: 88,
    automaticPostingThreshold: 97,
    amountTolerance: 0.05,
    requireEvidenceForExpenses: true,
    allowOverAllocation: true,
  }, context);

  assert.equal(next.ruleSets.length, 1);
  assert.equal(next.ruleSets[0].id, "rule-set-live");
  assert.equal(next.ruleSets[0].name, "严格复核规则");
  assert.deepEqual(
    {
      confidenceThreshold: accountingRules(next).confidenceThreshold,
      automaticPostingThreshold: accountingRules(next).automaticPostingThreshold,
      amountTolerance: accountingRules(next).amountTolerance,
      requireEvidenceForExpenses: accountingRules(next).requireEvidenceForExpenses,
      allowOverAllocation: accountingRules(next).allowOverAllocation,
    },
    {
      confidenceThreshold: 88,
      automaticPostingThreshold: 97,
      amountTolerance: 0.05,
      requireEvidenceForExpenses: true,
      allowOverAllocation: true,
    },
  );
  assert.equal(next.auditLog.at(-1).action, "accounting_rules.update");
  assert.equal(next.auditLog.at(-1).entityId, "rule-set-live");
});

test("缺少有效规则集时创建一个当前有效规则集", () => {
  const workspace = createAccountingFixture();
  workspace.ruleSets = [{ id: "rule-set-old", name: "旧规则", status: "inactive" }];
  const next = saveActiveAccountingRuleSet(workspace, {
    name: "当前规则",
    confidenceThreshold: 80,
    automaticPostingThreshold: 95,
    amountTolerance: 0.01,
    requireEvidenceForExpenses: false,
    allowOverAllocation: false,
  }, context);

  const active = next.ruleSets.find((ruleSet) => ruleSet.status === "active");
  assert.equal(active.id, "rule-set-0001");
  assert.equal(accountingRules(next).requireEvidenceForExpenses, false);
  assert.equal(accountingRules(next).allowOverAllocation, false);
  assert.equal(next.auditLog.at(-1).action, "accounting_rules.create");
});
