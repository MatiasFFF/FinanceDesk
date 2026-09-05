import test from "node:test";
import assert from "node:assert/strict";
import { createBlankWorkspace } from "../src/financeData.js";
import { createMemoryFileVault } from "../src/features/intake/browserFileVault.js";
import { createDocumentMetadata, preparePayrollSocialImport, applyPayrollSocialImport } from "../src/features/intake/documentIntake.js";
import { buildPayrollAccountingSummary, createPayrollAccrualDraft, ensureWorkspace, workflowChecks, freezeReportVersion, confirmPayrollSocialData } from "../src/productWorkflow.js";
import { buildFinancialStatements } from "../src/domain/accounting/reporting.js";
import { upsertWorkspaceAccount } from "../src/domain/accounting/model.js";
import { createManualVoucherDraft, createPostedVoucherRevision, reviseDraftVoucher, postVoucher, postVoucherWithEvidence } from "../src/domain/accounting/vouchers.js";

const context = { actor: "工资会计", at: "2026-09-30T09:00:00.000Z" };
const headers = ["员工", "所属期", "应发工资", "个人社保", "企业社保", "个人所得税", "实发工资"];
const mapping = { employee: 0, period: 1, grossSalary: 2, personalSocial: 3, employerSocial: 4, individualIncomeTax: 5, netSalary: 6 };

async function importTables(workspace, fileVault, { gross = 2000, personal = 300, employer = 400, tax = 0, net = gross - personal - tax, suffix = "" } = {}) {
  for (const sourceKind of ["payroll", "socialSecurity"]) {
    const table = [headers, ["林同事", workspace.currentPeriod, gross, personal, employer, tax, net]];
    const blob = Object.assign(new Blob([table.map((row) => row.join(",")).join("\n")], { type: "text/csv" }), { name: `${sourceKind}${suffix}.csv` });
    const document = await createDocumentMetadata(blob, { id: `doc-${sourceKind}${suffix}`, period: workspace.currentPeriod });
    await fileVault.put({ id: document.id, workspaceId: workspace.id, hash: document.hash, blob });
    workspace = { ...workspace, documents: [...workspace.documents, document] };
    const plan = preparePayrollSocialImport(workspace, { table, mapping, sourceKind, id: `import-${sourceKind}${suffix}`, fileName: blob.name,
      sourceDocumentId: document.id, sourceDocumentHash: document.hash, sourceDocumentVersion: document.version });
    workspace = applyPayrollSocialImport(workspace, plan, context);
  }
  return workspace;
}

async function fixture(options) {
  const fileVault = createMemoryFileVault();
  let workspace = ensureWorkspace(createBlankWorkspace({ id: "payroll-accounting", name: "工资账务", currentPeriod: "2026-09" }, { timestamp: context.at }));
  workspace.modules = { ...workspace.modules, payroll: true, tax: true, reconcile: false };
  workspace.personnelRecords = [{ id: "person-1", name: "林同事", status: "active", department: "运营" }];
  workspace = await importTables(workspace, fileVault, options);
  return { workspace, fileVault };
}

async function postedFixture(options) {
  const { workspace, fileVault } = await fixture(options);
  const draft = await createPayrollAccrualDraft(workspace, {}, { ...context, fileVault });
  const voucherId = buildPayrollAccountingSummary(draft).draftVoucherId;
  const posted = await postVoucherWithEvidence(draft, { voucherId, reviewNote: "已逐人核对两表、原件与计提分录" }, { ...context, fileVault });
  return { workspace: posted, fileVault, voucherId };
}

test("两表核对后只生成草稿，人工核验入账得到2400费用、1700工资应付和700社保应付", async () => {
  const { workspace, fileVault } = await fixture();
  assert.equal(buildPayrollAccountingSummary(workspace).readyToDraft, true);
  assert.equal(workflowChecks(workspace).checks.find((item) => item.id === "exceptions").ok, false);
  assert.throws(() => freezeReportVersion(workspace), (error) => error.code === "PAYROLL_CLOSE_BLOCKED");
  let draft = await createPayrollAccrualDraft(workspace, {}, { ...context, fileVault });
  const voucherId = buildPayrollAccountingSummary(draft).draftVoucherId;
  assert.equal(draft.vouchers.find((item) => item.id === voucherId).status, "draft");
  assert.equal(buildFinancialStatements(draft).incomeStatement.expenses.value, 0);
  const duplicate = await createPayrollAccrualDraft(draft, {}, { ...context, fileVault });
  assert.equal(duplicate.vouchers.length, draft.vouchers.length);
  assert.throws(() => postVoucher(draft, { voucherId, reviewNote: "不能跳过原件" }, context), (error) => error.code === "VOUCHER_ORIGINAL_REQUIRED");
  draft = await postVoucherWithEvidence(draft, { voucherId, reviewNote: "核对无误" }, { ...context, fileVault });
  const summary = buildPayrollAccountingSummary(draft);
  assert.equal(summary.postedAndMatched, true, summary.message);
  assert.deepEqual(summary.rows.map((row) => [row.key, row.posted, row.closing]), [
    ["wagesExpense", 2000, 2000], ["employerSocialExpense", 400, 400], ["payrollPayable", 1700, 1700], ["socialSecurityPayable", 700, 700], ["individualIncomeTaxPayable", 0, 0],
  ]);
  const statements = buildFinancialStatements(draft);
  assert.equal(statements.incomeStatement.expenses.value, 2400);
  assert.equal(statements.balanceSheet.liabilities.value, 2400);
  assert.equal(statements.cashFlow.netChange.value, 0);
  assert.equal(workflowChecks(draft).bankReconciliationApplicable, false);
  assert.equal(workflowChecks(draft).checks.find((item) => item.id === "exceptions").ok, true);
  const frozen = freezeReportVersion(draft);
  assert.ok(confirmPayrollSocialData(frozen, { section: "payroll" }, context).tax.payrollConfirmedAt);
  const repeated = await createPayrollAccrualDraft(draft, {}, { ...context, fileVault });
  assert.equal(repeated.vouchers.length, draft.vouchers.length);
  assert.ok(draft.auditLog.some((item) => item.action === "payroll.create_accrual_draft"));
});

test("在职员工缺表、缺个税、两表差额和应发实发不平都阻塞计提与冻结", async (t) => {
  const { workspace, fileVault } = await fixture();
  for (const [name, change] of [
    ["缺两表", (next) => { next.payrollRecords = []; }],
    ["缺社保", (next) => { next.payrollRecords = next.payrollRecords.filter((row) => row.sourceKind === "payroll"); }],
    ["个税为空", (next) => { next.payrollRecords[0].individualIncomeTax = null; }],
    ["两表差一分", (next) => { next.payrollRecords[1].personalSocial += 0.01; }],
    ["实发差一分", (next) => { next.payrollRecords[0].netSalary -= 0.01; }],
  ]) await t.test(name, async () => {
    const next = structuredClone(workspace); change(next);
    assert.equal(buildPayrollAccountingSummary(next).readyToDraft, false);
    assert.throws(() => freezeReportVersion(next), (error) => error.code === "PAYROLL_CLOSE_BLOCKED");
    await assert.rejects(createPayrollAccrualDraft(next, {}, { ...context, fileVault }), (error) => error.code === "PAYROLL_NOT_READY");
  });
});

test("原件丢失在生成和入账时分别阻塞，不能复用保存的核验标记", async () => {
  const { workspace, fileVault } = await fixture();
  const draft = await createPayrollAccrualDraft(workspace, {}, { ...context, fileVault });
  await fileVault.delete("doc-payroll");
  await assert.rejects(createPayrollAccrualDraft(workspace, {}, { ...context, fileVault }), (error) => error.code === "PAYROLL_ORIGINAL_REQUIRED");
  await assert.rejects(postVoucherWithEvidence(draft, { voucherId: buildPayrollAccountingSummary(draft).draftVoucherId, reviewNote: "重新核验" }, { ...context, fileVault }), (error) => error.code === "PAYROLL_ORIGINAL_REQUIRED");
});

test("资料变化更新原草稿；入账后变化生成修订并保留旧posted历史直到新凭证入账", async () => {
  const { workspace, fileVault } = await fixture();
  const draft = await createPayrollAccrualDraft(workspace, {}, { ...context, fileVault });
  const voucherId = buildPayrollAccountingSummary(draft).draftVoucherId;
  const changed = await importTables(draft, fileVault, { gross: 2200, suffix: "-2" });
  await assert.rejects(postVoucherWithEvidence(changed, { voucherId, reviewNote: "旧草稿" }, { ...context, fileVault }), (error) => error.code === "PAYROLL_DRAFT_STALE");
  let next = await createPayrollAccrualDraft(changed, {}, { ...context, fileVault });
  assert.equal(buildPayrollAccountingSummary(next).draftVoucherId, voucherId);
  assert.equal(next.vouchers.length, 1);
  next = await postVoucherWithEvidence(next, { voucherId, reviewNote: "已更新来源" }, { ...context, fileVault });
  const original = structuredClone(next.vouchers[0]);
  const changedAgain = await importTables(next, fileVault, { gross: 2300, suffix: "-3" });
  await assert.rejects(createPayrollAccrualDraft(changedAgain, {}, { ...context, fileVault }), (error) => error.code === "REVISION_REASON_REQUIRED");
  const revision = await createPayrollAccrualDraft(changedAgain, { reason: "更正遗漏工资100元" }, { ...context, fileVault });
  assert.deepEqual(revision.vouchers.find((item) => item.id === voucherId), original);
  const revisionId = buildPayrollAccountingSummary(revision).draftVoucherId;
  assert.equal(revision.vouchers.find((item) => item.id === revisionId).revisionOf, voucherId);
  const posted = await postVoucherWithEvidence(revision, { voucherId: revisionId, reviewNote: "新原件、金额与更正原因一致" }, { ...context, fileVault });
  assert.equal(posted.vouchers.find((item) => item.id === voucherId).status, "superseded");
  assert.equal(buildPayrollAccountingSummary(posted).postedAndMatched, true);
  assert.equal(buildFinancialStatements(posted).incomeStatement.expenses.value, 2700);
});

test("本工作台可改用自定义费用和应付款科目，规则或分录变化后旧草稿不可入账", async () => {
  let { workspace, fileVault } = await fixture({ tax: 50 });
  workspace = upsertWorkspaceAccount(workspace, { id: "wages-custom", name: "项目人工费", category: "cost", normalSide: "debit", status: "active" }, context);
  workspace = upsertWorkspaceAccount(workspace, { id: "payroll-custom", name: "项目工资应付", category: "liability", normalSide: "credit", status: "active" }, context);
  assert.equal(workspace.chartOfAccounts.find((account) => account.id === "wages-custom").name, "项目人工费");
  assert.equal(workspace.chartOfAccounts.find((account) => account.id === "payroll-custom").category, "liability");
  let draft = await createPayrollAccrualDraft(workspace, { accounts: { wagesExpense: "wages-custom", payrollPayable: "payroll-custom" } }, { ...context, fileVault });
  const voucherId = buildPayrollAccountingSummary(draft).draftVoucherId;
  assert.equal(draft.vouchers[0].lines[0].account, "wages-custom");
  assert.equal(draft.vouchers[0].lines.find((line) => line.account === "payroll-custom").credit, 1650);
  assert.equal(buildPayrollAccountingSummary(draft).expected.individualIncomeTax, 50);
  const altered = structuredClone(draft);
  altered.vouchers[0].lines[0].debit -= 1;
  altered.vouchers[0].lines.find((line) => line.account === "payroll-custom").credit -= 1;
  await assert.rejects(postVoucherWithEvidence(altered, { voucherId, reviewNote: "金额被改" }, { ...context, fileVault }), (error) => error.code === "PAYROLL_DRAFT_STALE");
  draft.rules.confidenceThreshold = 90;
  await assert.rejects(postVoucherWithEvidence(draft, { voucherId, reviewNote: "规则变更" }, { ...context, fileVault }), (error) => error.code === "PAYROLL_DRAFT_STALE");
});

test("已付款直接记工资费用时给出原凭证，并可走更正应付款再计提的真实路径", async () => {
  let { workspace, fileVault } = await fixture();
  workspace.openingLedger = { cash: 3000, equity: -3000 };
  const source = buildPayrollAccountingSummary(workspace);
  workspace = createManualVoucherDraft(workspace, { date: "2026-09-20", summary: "已付工资旧直接费用处理", evidenceIds: source.documentIds,
    lines: [{ account: "expensePayroll", debit: 1700, credit: 0, sourceIds: source.sourceIds }, { account: "cash", debit: 0, credit: 1700, sourceIds: source.sourceIds }] }, context);
  const originalId = workspace.vouchers.at(-1).id;
  workspace = await postVoucherWithEvidence(workspace, { voucherId: originalId, reviewNote: "既有付款处理" }, { ...context, fileVault });
  const blocked = buildPayrollAccountingSummary(workspace);
  assert.ok(blocked.issues.some((issue) => issue.code === "payroll_existing_expense" && issue.voucherIds.includes(originalId)));
  await assert.rejects(createPayrollAccrualDraft(workspace, {}, { ...context, fileVault }), (error) => error.code === "PAYROLL_NOT_READY");
  workspace = createPostedVoucherRevision(workspace, { voucherId: originalId, reason: "已付工资改冲应付款，避免再计提重复费用" }, context);
  const correctionId = workspace.vouchers.at(-1).id;
  workspace = reviseDraftVoucher(workspace, { voucherId: correctionId, reason: "付款借方改为应付工资", lines: workspace.vouchers.at(-1).lines.map((line) => line.account === "expensePayroll" ? { ...line, account: "payrollPayable" } : line) }, context);
  workspace = await postVoucherWithEvidence(workspace, { voucherId: correctionId, reviewNote: "已改正付款科目" }, { ...context, fileVault });
  workspace = await createPayrollAccrualDraft(workspace, {}, { ...context, fileVault });
  workspace = await postVoucherWithEvidence(workspace, { voucherId: buildPayrollAccountingSummary(workspace).draftVoucherId, reviewNote: "付款更正后计提" }, { ...context, fileVault });
  const summary = buildPayrollAccountingSummary(workspace);
  assert.equal(summary.postedAndMatched, true, summary.message);
  assert.equal(summary.rows.find((row) => row.key === "payrollPayable").payments, 1700);
  assert.equal(summary.rows.find((row) => row.key === "payrollPayable").closing, 0);
  assert.equal(buildFinancialStatements(workspace).incomeStatement.expenses.value, 2400);
});

test("计提后新的直接工资费用付款被拒绝，正常冲减应付款只改变余额", async () => {
  let { workspace, fileVault } = await postedFixture();
  workspace.openingLedger = { cash: 3000, equity: -3000, payrollPayable: -100 };
  const sources = buildPayrollAccountingSummary(workspace);
  const payment = (account) => createManualVoucherDraft(workspace, { date: "2026-09-30", summary: "付工资500", evidenceIds: sources.documentIds,
    lines: [{ account, debit: 500, credit: 0, sourceIds: sources.sourceIds }, { account: "cash", debit: 0, credit: 500, sourceIds: sources.sourceIds }] }, context);
  const wrong = payment("expensePayroll");
  await assert.rejects(postVoucherWithEvidence(wrong, { voucherId: wrong.vouchers.at(-1).id, reviewNote: "重复费用" }, { ...context, fileVault }), (error) => error.code === "PAYROLL_DUPLICATE_EXPENSE");
  const draft = payment("payrollPayable");
  const paid = await postVoucherWithEvidence(draft, { voucherId: draft.vouchers.at(-1).id, reviewNote: "冲减工资应付款" }, { ...context, fileVault });
  const summary = buildPayrollAccountingSummary(paid);
  assert.equal(summary.postedAndMatched, true);
  assert.equal(summary.rows.find((row) => row.key === "payrollPayable").closing, 1300);
  assert.equal(buildFinancialStatements(paid).incomeStatement.expenses.value, 2400);
});
