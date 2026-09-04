import assert from "node:assert/strict";
import test from "node:test";

import {
  accountDefinition,
  buildFinancialStatements,
  buildTaxWorkpaper,
  createAccountingFixture,
  createCustomerConfirmationPackage,
  freezeReportVersion as freezeAccountingReportVersion,
  recordCustomerConfirmation,
} from "../src/domain/accounting/index.js";
import {
  createInitialState,
  normalizeWorkspace,
} from "../src/domain/foundation.js";
import {
  createLocalFoundationRepository,
  createMemoryStorage,
} from "../src/storage/localFoundationRepository.js";
import { createFinanceDeskStore } from "../src/store/financeDeskStore.js";
import {
  applyPayrollSocialImport,
  buildPayrollSocialSummary,
  buildStructuredInvoiceVatSummary,
  preparePayrollSocialImport,
} from "../src/features/intake/documentIntake.js";
import {
  PRIMARY_NAV,
  PRODUCT_NAME,
  archivePeriod,
  attachReceipt,
  buildVatReconciliationSummary,
  buildReportSnapshot,
  confirmPayrollSocialData,
  enterNextPeriod,
  ensureWorkspace,
  exportLocalFilingPackage,
  freezeReportVersion,
  getPayrollSocialConfirmationState,
  markPackageExported,
  prepareFilingDraft,
  recordVatReconciliation,
  workflowChecks,
  workflowSourceFingerprint,
} from "../src/productWorkflow.js";

const fixedNow = () => new Date("2026-09-04T08:00:00.000Z");

function integratedStore(workspace) {
  const storage = createMemoryStorage();
  const repository = createLocalFoundationRepository({ storage, now: fixedNow });
  const state = createInitialState({ now: fixedNow });
  const normalized = normalizeWorkspace(ensureWorkspace(workspace), { now: fixedNow });
  repository.save({
    ...state,
    activeWorkspaceId: normalized.id,
    workspaces: [normalized],
  });
  return {
    repository,
    store: createFinanceDeskStore({ repository }),
  };
}

function closeableWorkspace() {
  const workspace = normalizeWorkspace(ensureWorkspace(createAccountingFixture()), { now: fixedNow });
  workspace.transactions = workspace.transactions.map((transaction) => ({ ...transaction, status: "ignored" }));
  workspace.vouchers = workspace.vouchers.map((voucher) => ({ ...voucher, status: "posted" }));
  workspace.exceptionTasks = [];
  workspace.bankImports = [];
  return workspace;
}

function withPayrollSocialData(workspace) {
  const period = workspace.currentPeriod;
  const employee = { id: "person-payroll-test", name: "陈教练", status: "active", department: "教练部" };
  let next = {
    ...workspace,
    personnelRecords: [employee, ...(workspace.personnelRecords || []).filter((person) => person.id !== employee.id && person.name !== employee.name)],
  };
  const headers = ["员工", "所属期", "应发工资", "个人社保", "企业社保", "个税", "实发工资"];
  const mapping = { employee: 0, period: 1, grossSalary: 2, personalSocial: 3, employerSocial: 4, individualIncomeTax: 5, netSalary: 6 };
  const payrollPlan = preparePayrollSocialImport(next, {
    id: "payroll-import-test",
    fileName: "工资表.csv",
    sourceKind: "payroll",
    table: [headers, ["陈教练", period, 10000, 800, 1600, 250, 8950]],
    mapping,
    defaultPeriod: period,
    importedAt: "2026-09-04T08:00:10.000Z",
  });
  next = applyPayrollSocialImport(next, payrollPlan, { actor: "测试会计", at: "2026-09-04T08:00:10.000Z" });
  const socialPlan = preparePayrollSocialImport(next, {
    id: "social-import-test",
    fileName: "社保表.xlsx",
    sourceKind: "socialSecurity",
    table: [headers, ["陈教练", period, 10000, 800, 1600, "", ""]],
    mapping,
    defaultPeriod: period,
    importedAt: "2026-09-04T08:00:20.000Z",
  });
  return applyPayrollSocialImport(next, socialPlan, { actor: "测试会计", at: "2026-09-04T08:00:20.000Z" });
}

test("product identity and the complete local foundation remain reachable from primary navigation", () => {
  assert.equal(PRODUCT_NAME, "财务工作台");
  assert.equal(PRIMARY_NAV.some((item) => item.id === "setup" && item.label === "基础资料"), true);
});

test("one repository preserves product workflow and accounting-engine fields across reloads", () => {
  const fixture = createAccountingFixture();
  fixture.id = "workspace-integrated";
  fixture.name = "集成测试工作台";
  const { repository, store } = integratedStore(fixture);
  const current = store.getActiveWorkspace();

  store.actions.replaceWorkspace(current.id, {
    ...current,
    delivery: {
      reportVersions: [{ id: "delivery-v1", period: current.currentPeriod, label: "V1" }],
      filing: { period: current.currentPeriod, draftCreatedAt: "2026-09-04T08:01:00.000Z" },
      archives: [],
      notices: [],
    },
    reportVersions: [{ id: "engine-report-1", period: current.currentPeriod, status: "frozen" }],
    confirmations: [{ id: "confirmation-1", period: current.currentPeriod, status: "approved" }],
    exceptionTasks: [{ id: "exception-1", sourceId: current.transactions[0].id, status: "resolved" }],
  });

  const reloaded = createFinanceDeskStore({ repository }).getActiveWorkspace();
  assert.equal(reloaded.delivery.reportVersions[0].id, "delivery-v1");
  assert.equal(reloaded.reportVersions[0].id, "engine-report-1");
  assert.equal(reloaded.confirmations[0].status, "approved");
  assert.equal(reloaded.exceptionTasks[0].status, "resolved");
});

test("whole-workspace updates remain isolated when another workspace is created", () => {
  const fixture = createAccountingFixture();
  fixture.id = "workspace-one";
  fixture.name = "第一工作台";
  const { store } = integratedStore(fixture);
  const first = store.getActiveWorkspace();
  const second = store.actions.createWorkspace({ name: "第二工作台" });

  store.actions.replaceWorkspace(second.id, {
    ...second,
    tax: { ...second.tax, note: "只属于第二工作台" },
    delivery: { ...ensureWorkspace(second).delivery, notices: [{ id: "notice-second" }] },
  });

  const state = store.getState();
  assert.equal(state.workspaces.find((item) => item.id === first.id).tax.note || "", "");
  assert.equal(state.workspaces.find((item) => item.id === second.id).tax.note, "只属于第二工作台");
  assert.equal(state.workspaces.find((item) => item.id === second.id).delivery.notices[0].id, "notice-second");
});

test("the visible report snapshot uses the accounting engine for statements and tax workpaper", () => {
  const workspace = ensureWorkspace(createAccountingFixture());
  const snapshot = buildReportSnapshot(workspace);
  const statements = buildFinancialStatements(workspace, { period: workspace.currentPeriod });
  const tax = buildTaxWorkpaper(workspace, { period: workspace.currentPeriod });

  assert.equal(snapshot.summary.revenue, statements.incomeStatement.netRevenue.value);
  assert.equal(snapshot.summary.profit, statements.incomeStatement.profit.value);
  assert.equal(snapshot.summary.assets, statements.balanceSheet.assets.value);
  assert.equal(snapshot.summary.difference, statements.balanceSheet.difference.value);
  assert.equal(
    snapshot.taxWorkpaper.rows.find((row) => row.id === "vatPayable").value,
    tax.vatPayable.value,
  );
  assert.equal(Object.values(snapshot.summary.engineChecks).every((check) => typeof check.passed === "boolean"), true);
  assert.equal(snapshot.sections.cashflow.rows.find((row) => row.id === "netCash").value, statements.cashFlow.netChange.value);
});

test("structured invoices drive traceable output VAT, deductible input VAT, and non-deductible input VAT", () => {
  const workspace = ensureWorkspace(createAccountingFixture());
  const period = workspace.currentPeriod;
  const transactionId = workspace.transactions[0].id;
  const invoice = (id, values, relatedObjectIds = [transactionId]) => ({
    id,
    name: `${id}.pdf`,
    category: "发票",
    period,
    relatedObjectIds,
    structuredData: {
      kind: "invoice",
      invoiceNumber: id.toUpperCase(),
      invoiceDate: `${period}-04`,
      taxDirection: "output",
      amount: 113,
      taxAmount: 13,
      taxRate: 13,
      verificationStatus: "unverified",
      redLetterStatus: "normal",
      voidStatus: "valid",
      certificationStatus: "not_required",
      ...values,
    },
  });
  workspace.documents = [
    ...workspace.documents,
    invoice("invoice-output", {}),
    invoice("invoice-output-red", { amount: 56.5, taxAmount: 6.5, redLetterStatus: "red_issued" }),
    invoice("invoice-output-derived", { amount: 106, taxAmount: null, taxRate: 6 }),
    invoice("invoice-output-void", { amount: 1130, taxAmount: 130, voidStatus: "voided" }),
    invoice("invoice-input-certified", { taxDirection: "input", amount: 106, taxAmount: 6, taxRate: 6, certificationStatus: "certified" }),
    invoice("invoice-input-pending", { taxDirection: "input", amount: 53, taxAmount: 3, taxRate: 6, certificationStatus: "pending" }),
    invoice("invoice-unlinked", {}, []),
  ];

  const summary = buildStructuredInvoiceVatSummary(workspace, { period });
  assert.equal(summary.sourceMode, "structured_invoices");
  assert.equal(summary.outputGrossAmount, 162.5);
  assert.equal(summary.outputNetAmount, 150);
  assert.equal(summary.outputVat, 12.5);
  assert.equal(summary.inputVat, 9);
  assert.equal(summary.deductibleInputVat, 6);
  assert.equal(summary.nonDeductibleInputVat, 3);
  assert.equal(summary.vatPayable, 6.5);
  assert.equal(summary.rows.find((row) => row.documentId === "invoice-output-red").taxAmount, -6.5);
  assert.equal(summary.rows.find((row) => row.documentId === "invoice-output-derived").taxAmountSource, "derived_from_gross_and_rate");
  assert.equal(summary.rows.find((row) => row.documentId === "invoice-output-void").bucket, "excluded");
  assert.equal(summary.rows.find((row) => row.documentId === "invoice-unlinked").bucket, "excluded");

  const snapshot = buildReportSnapshot(workspace);
  const row = (id) => snapshot.taxWorkpaper.rows.find((item) => item.id === id);
  assert.equal(snapshot.taxWorkpaper.sourceMode, "structured_invoices");
  assert.equal(row("outputInvoiceGross").value, 162.5);
  assert.equal(row("vat").value, 12.5);
  assert.equal(row("inputVat").value, 6);
  assert.equal(row("nonDeductibleInputVat").value, 3);
  assert.equal(row("vatPayable").value, 6.5);
  assert.deepEqual(new Set(row("vat").details.map((item) => item.documentId)), new Set(["invoice-output", "invoice-output-red", "invoice-output-derived"]));
  assert.deepEqual(row("nonDeductibleInputVat").details.map((item) => item.documentId), ["invoice-input-pending"]);
  assert.match(snapshot.taxWorkpaper.disclaimer, /不代表已联网查验/);

  const changed = structuredClone(workspace);
  changed.documents.find((document) => document.id === "invoice-output").structuredData.taxAmount = 14;
  assert.notEqual(workflowSourceFingerprint(changed), workflowSourceFingerprint(workspace));
});

test("VAT reconciliation preserves book and invoice sources, adjustments, history, and source-change invalidation", () => {
  let workspace = ensureWorkspace(createAccountingFixture());
  const period = workspace.currentPeriod;
  const sourceId = workspace.transactions[0].id;
  const statements = buildFinancialStatements(workspace, { period });
  const tax = buildTaxWorkpaper(workspace, { period });
  const bookRevenue = statements.incomeStatement.netRevenue.value;
  const bookInputVat = tax.inputVat.value;
  workspace.documents = [
    ...workspace.documents,
    {
      id: "vat-reconciliation-output",
      name: "销项差异发票.pdf",
      category: "发票",
      period,
      relatedObjectIds: [sourceId],
      structuredData: {
        kind: "invoice",
        invoiceNumber: "OUTPUT-DIFF",
        invoiceDate: `${period}-08`,
        taxDirection: "output",
        amount: bookRevenue + 38,
        taxAmount: 13,
        taxRate: 13,
        verificationStatus: "unverified",
        redLetterStatus: "normal",
        voidStatus: "valid",
        certificationStatus: "not_required",
      },
    },
    {
      id: "vat-reconciliation-input",
      name: "进项差异发票.pdf",
      category: "发票",
      period,
      relatedObjectIds: [sourceId],
      structuredData: {
        kind: "invoice",
        invoiceNumber: "INPUT-DIFF",
        invoiceDate: `${period}-09`,
        taxDirection: "input",
        amount: bookInputVat + 107,
        taxAmount: bookInputVat + 7,
        taxRate: 6,
        verificationStatus: "unverified",
        redLetterStatus: "normal",
        voidStatus: "valid",
        certificationStatus: "certified",
      },
    },
  ];

  const before = buildVatReconciliationSummary(workspace);
  const output = before.items.find((item) => item.kind === "outputRevenue");
  const input = before.items.find((item) => item.kind === "deductibleInputVat");
  assert.equal(output.bookAmount, bookRevenue);
  assert.equal(output.invoiceAmount, bookRevenue + 25);
  assert.equal(output.differenceBeforeAdjustment, 25);
  assert.equal(output.bookSources.length > 0, true);
  assert.deepEqual(output.invoiceSources.map((source) => source.documentId), ["vat-reconciliation-output"]);
  assert.equal(input.bookAmount, bookInputVat);
  assert.equal(input.differenceBeforeAdjustment, 7);
  assert.deepEqual(input.invoiceSources.map((source) => source.documentId), ["vat-reconciliation-input"]);
  assert.equal(before.hasUnexplainedDifferences, true);

  workspace = recordVatReconciliation(workspace, {
    kind: "outputRevenue",
    reason: "存在已开票但尚未入账收入，本地调整回账面口径",
    adjustmentAmount: -25,
  }, { actor: "测试会计", at: "2026-09-04T08:20:00.000Z" });
  workspace = recordVatReconciliation(workspace, {
    kind: "deductibleInputVat",
    reason: "认证时点早于会计入账，本地调整回账面口径",
    adjustmentAmount: -7,
  }, { actor: "测试会计", at: "2026-09-04T08:21:00.000Z" });

  const reconciled = buildVatReconciliationSummary(workspace);
  assert.equal(reconciled.hasUnexplainedDifferences, false);
  assert.deepEqual(reconciled.items.map((item) => item.differenceAfterAdjustment), [0, 0]);
  assert.equal(reconciled.items[0].storedRecord.before.difference, 25);
  assert.equal(reconciled.items[0].storedRecord.after.difference, 0);
  assert.equal(reconciled.items[0].storedRecord.history.length, 1);
  assert.equal(workflowChecks(workspace).checks.find((check) => check.id === "vatReconciliation").ok, true);

  const changed = structuredClone(workspace);
  changed.documents.find((document) => document.id === "vat-reconciliation-output").structuredData.amount += 1;
  const stale = buildVatReconciliationSummary(changed).items.find((item) => item.kind === "outputRevenue");
  assert.equal(stale.status, "source_changed");
  assert.equal(stale.resolved, false);
  assert.equal(stale.storedRecord.history.length, 1);
});

test("an unexplained VAT difference blocks the final local filing package", async () => {
  const workspace = closeableWorkspace();
  const period = workspace.currentPeriod;
  const bookRevenue = buildFinancialStatements(workspace, { period }).incomeStatement.netRevenue.value;
  workspace.documents.push({
    id: "vat-unexplained-output",
    name: "待解释销项发票.pdf",
    category: "发票",
    period,
    relatedObjectIds: [workspace.transactions[0].id],
    structuredData: {
      kind: "invoice",
      invoiceNumber: "VAT-UNEXPLAINED",
      invoiceDate: `${period}-10`,
      taxDirection: "output",
      amount: bookRevenue + 23,
      taxAmount: 13,
      taxRate: 13,
      verificationStatus: "unverified",
      redLetterStatus: "normal",
      voidStatus: "valid",
      certificationStatus: "not_required",
    },
  });

  const check = workflowChecks(workspace).checks.find((item) => item.id === "vatReconciliation");
  assert.equal(check.ok, false);
  assert.match(check.detail, /差额 10.00/);
  await assert.rejects(() => exportLocalFilingPackage(workspace), /增值税差异均已解释/);
});

test("payroll and social records enter the tax workpaper, compare by employee, and require separate current confirmations", () => {
  let workspace = withPayrollSocialData(closeableWorkspace());
  const summary = buildPayrollSocialSummary(workspace);
  assert.equal(summary.counts.payroll, 1);
  assert.equal(summary.counts.socialSecurity, 1);
  assert.equal(summary.rows[0].matched, true);
  assert.equal(summary.totals.payroll.grossSalary, 10000);
  assert.equal(summary.totals.socialSecurityPayable, 2400);

  const snapshot = buildReportSnapshot(workspace);
  const row = (id) => snapshot.taxWorkpaper.rows.find((item) => item.id === id);
  assert.equal(row("payroll").value, 10000);
  assert.equal(row("personalSocialSecurity").value, 800);
  assert.equal(row("employerSocialSecurity").value, 1600);
  assert.equal(row("socialSecurity").value, 2400);
  assert.equal(row("individualIncomeTax").value, 250);
  assert.equal(row("netSalary").value, 8950);
  assert.equal(row("payroll").details[0].title, "陈教练");

  workspace = freezeReportVersion(workspace, "测试会计");
  workspace = confirmPayrollSocialData(workspace, { section: "payroll", confirmed: true }, { actor: "客户负责人", at: "2026-09-04T08:30:00.000Z" });
  let confirmations = getPayrollSocialConfirmationState(workspace);
  assert.equal(confirmations.payroll.confirmed, true);
  assert.equal(confirmations.socialSecurity.confirmed, false);
  assert.equal(workflowChecks(workspace).checks.find((check) => check.id === "socialSecurity").ok, false);

  workspace = confirmPayrollSocialData(workspace, { section: "socialSecurity", confirmed: true }, { actor: "客户负责人", at: "2026-09-04T08:31:00.000Z" });
  confirmations = getPayrollSocialConfirmationState(workspace);
  assert.equal(confirmations.payroll.confirmed, true);
  assert.equal(confirmations.socialSecurity.confirmed, true);
  assert.equal(workflowChecks(workspace).checks.find((check) => check.id === "payroll").ok, true);
  assert.equal(workflowChecks(workspace).checks.find((check) => check.id === "socialSecurity").ok, true);

  const changedPayrollPlan = preparePayrollSocialImport(workspace, {
    id: "payroll-import-changed",
    fileName: "工资表-更正.csv",
    sourceKind: "payroll",
    table: [["员工", "所属期", "应发工资", "个人社保", "企业社保", "个税", "实发工资"], ["陈教练", workspace.currentPeriod, 10100, 800, 1600, 250, 9050]],
    mapping: { employee: 0, period: 1, grossSalary: 2, personalSocial: 3, employerSocial: 4, individualIncomeTax: 5, netSalary: 6 },
    defaultPeriod: workspace.currentPeriod,
  });
  workspace = applyPayrollSocialImport(workspace, changedPayrollPlan, { actor: "测试会计", at: "2026-09-04T08:32:00.000Z" });
  assert.equal(workspace.payrollRecords.filter((record) => record.sourceKind === "payroll").length, 1);
  assert.equal(workspace.tax.payrollConfirmedAt, null);
  assert.equal(workspace.tax.socialSecurityConfirmedAt, null);
  assert.equal(getPayrollSocialConfirmationState(workspace).version, null);
});

test("payroll comparison explicitly lists departed, missing-personnel, and missing-side records", () => {
  const workspace = withPayrollSocialData(closeableWorkspace());
  workspace.personnelRecords.find((person) => person.id === "person-payroll-test").status = "departed";
  workspace.payrollRecords.push({
    id: "payroll-record-missing-person",
    sourceKind: "payroll",
    period: workspace.currentPeriod,
    employeeName: "无档案员工",
    personnelId: null,
    grossSalary: 6000,
    personalSocial: 400,
    employerSocial: 800,
    individualIncomeTax: 50,
    netSalary: 5550,
    sourceImportId: "payroll-import-missing-person",
  });
  const summary = buildPayrollSocialSummary(workspace);
  const departed = summary.rows.find((row) => row.employeeName === "陈教练");
  const missing = summary.rows.find((row) => row.employeeName === "无档案员工");
  assert.equal(departed.issues.some((issue) => issue.code === "departed_personnel"), true);
  assert.equal(missing.issues.some((issue) => issue.code === "missing_personnel"), true);
  assert.equal(missing.issues.some((issue) => issue.code === "missing_social_security"), true);
});

test("report totals retain formulas and voucher-level detail whose amounts reconcile to the visible number", () => {
  const workspace = ensureWorkspace(createAccountingFixture());
  const snapshot = buildReportSnapshot(workspace);
  const sumDetails = (row) => Math.round(row.details.reduce((sum, item) => sum + Number(item.amount || 0), 0) * 100) / 100;
  const assets = snapshot.sections.balance.rows.find((row) => row.id === "assets");
  const profit = snapshot.sections.income.rows.find((row) => row.id === "profit");
  const ownerGrossProfit = snapshot.sections.owner.rows.find((row) => row.id === "ownerGrossProfit");

  assert.match(assets.formula, /资产类科目/);
  assert.equal(sumDetails(assets), assets.value);
  assert.match(profit.formula, /营业收入/);
  assert.equal(sumDetails(profit), profit.value);
  assert.equal(ownerGrossProfit.details.length > 0, true);
});

test("a real product bank account id is treated as cash and enters the statements", () => {
  const workspace = createInitialState({ now: fixedNow }).workspaces[0];
  const account = workspace.bankAccounts[0];
  const definition = accountDefinition(account.id, workspace);
  assert.equal(definition.category, "asset");
  assert.equal(definition.cash, true);
});

test("only posted and explicitly ignored items stop blocking the product close workflow", () => {
  const workspace = ensureWorkspace(createAccountingFixture());
  workspace.transactions = workspace.transactions.slice(0, 4).map((transaction, index) => ({
    ...transaction,
    date: workspace.currentPeriod + "-15",
    status: ["posted", "ignored", "pending", "reconciled"][index],
  }));

  const flow = workflowChecks(workspace);
  assert.deepEqual(flow.unresolved.map((item) => item.status), ["pending", "reconciled"]);
});

test("an inherited open notice is visible to the workflow and blocks a new close until resolved", () => {
  const workspace = ensureWorkspace(createAccountingFixture());
  workspace.transactions = workspace.transactions.map((transaction) => ({ ...transaction, status: "ignored" }));
  workspace.exceptionTasks = [];
  workspace.delivery.notices = [{
    id: "carry-2026-08-txn-old",
    period: workspace.currentPeriod,
    sourceId: "txn-old",
    status: "open",
    message: "上期待处理事项",
    amount: 88,
  }];

  const blocked = workflowChecks(workspace);
  assert.equal(blocked.openNotices.length, 1);
  assert.equal(blocked.checks.find((item) => item.id === "exceptions").ok, false);

  workspace.delivery.notices[0].status = "resolved";
  const resolved = workflowChecks(workspace);
  assert.equal(resolved.openNotices.length, 0);
  assert.equal(resolved.checks.find((item) => item.id === "exceptions").ok, true);
});

test("a frozen report becomes stale after its financial source data changes", () => {
  const base = ensureWorkspace(createAccountingFixture());
  base.transactions = base.transactions.map((transaction) => ({ ...transaction, status: "ignored" }));
  base.vouchers = base.vouchers.map((voucher) => ({ ...voucher, status: "posted" }));
  const frozen = freezeReportVersion(base, "测试会计");
  assert.equal(workflowChecks(frozen).version?.label, "V1");

  const changed = {
    ...frozen,
    tax: { ...frozen.tax, adjustments: Number(frozen.tax.adjustments || 0) + 100 },
  };
  const flow = workflowChecks(changed);
  assert.equal(flow.version, null);
  assert.equal(flow.checks.find((item) => item.id === "frozen").ok, false);
  assert.match(flow.checks.find((item) => item.id === "frozen").detail, /重新冻结/);
});

test("a frozen report also becomes stale when the company identity changes", () => {
  const base = closeableWorkspace();
  const frozen = freezeReportVersion(base, "测试会计");
  const changed = { ...frozen, company: { ...frozen.company, legalName: "更名后的企业" } };
  assert.equal(workflowChecks(changed).version, null);
});

test("VAT adjustments change the taxable base, output VAT and payable VAT", () => {
  const base = closeableWorkspace();
  const before = buildTaxWorkpaper(base, { period: base.currentPeriod });
  const changed = { ...base, tax: { ...base.tax, adjustments: Number(base.tax.adjustments || 0) + 100 } };
  const after = buildTaxWorkpaper(changed, { period: changed.currentPeriod });
  assert.equal(after.taxableBase.value, before.taxableBase.value + 100);
  assert.equal(after.outputVat.value, before.outputVat.value + 3);
  assert.equal(after.vatPayable.value, before.vatPayable.value + 3);
});

test("a pending correction voucher blocks confirmation even when its source transaction is already posted", () => {
  const workspace = ensureWorkspace(createAccountingFixture());
  workspace.transactions = workspace.transactions.map((transaction) => ({ ...transaction, status: "posted" }));
  workspace.vouchers.push({
    id: "voucher-correction-draft",
    period: workspace.currentPeriod,
    status: "draft",
    version: 2,
    lines: [],
  });

  const flow = workflowChecks(workspace);
  assert.equal(flow.pendingVouchers.length, 1);
  assert.equal(flow.checks.find((item) => item.id === "vouchers").ok, false);
});

test("a failed bank reconciliation blocks report freezing and confirmation", () => {
  const workspace = ensureWorkspace(createAccountingFixture());
  workspace.transactions = workspace.transactions.map((transaction) => ({ ...transaction, status: "ignored" }));
  workspace.vouchers = workspace.vouchers.map((voucher) => ({ ...voucher, status: "posted" }));
  workspace.bankImports = [{
    id: "bank-import-failed",
    period: workspace.currentPeriod,
    status: "reconciliation_failed",
    reconciliation: { passed: false, difference: 125 },
  }];
  const flow = workflowChecks(workspace);
  assert.equal(flow.bankReconciliationIssues.length, 1);
  assert.equal(flow.checks.find((item) => item.id === "bank").ok, false);
});

test("freezing V2 clears every confirmation and delivery artifact bound to V1", () => {
  const base = ensureWorkspace(createAccountingFixture());
  base.transactions = base.transactions.map((transaction) => ({ ...transaction, status: "ignored" }));
  base.vouchers = base.vouchers.map((voucher) => ({ ...voucher, status: "posted" }));
  const v1 = freezeReportVersion(base, "测试会计");
  const v1Id = v1.delivery.reportVersions[0].id;
  v1.tax = {
    ...v1.tax,
    financeConfirmedAt: fixedNow().toISOString(),
    payrollConfirmedAt: fixedNow().toISOString(),
    socialSecurityConfirmedAt: fixedNow().toISOString(),
    ownerConfirmedAt: fixedNow().toISOString(),
    financeConfirmedVersionId: v1Id,
    payrollConfirmedVersionId: v1Id,
    socialSecurityConfirmedVersionId: v1Id,
    ownerConfirmedVersionId: v1Id,
  };
  v1.delivery.filing = {
    ...v1.delivery.filing,
    draftCreatedAt: fixedNow().toISOString(),
    draftVersionId: v1Id,
    finalConfirmedVersionId: v1Id,
    exportedAt: fixedNow().toISOString(),
    exportedPackage: { reportVersionId: v1Id },
    receipt: { id: "receipt-v1", reportVersionId: v1Id },
  };

  const v2 = freezeReportVersion(v1, "测试会计");
  assert.equal(v2.delivery.reportVersions[0].label, "V2");
  assert.equal(v2.tax.financeConfirmedAt, null);
  assert.equal(v2.tax.socialSecurityConfirmedAt, null);
  assert.equal(v2.tax.ownerConfirmedVersionId, null);
  assert.equal(v2.delivery.filing.draftVersionId, null);
  assert.equal(v2.delivery.filing.exportedPackage, null);
  assert.equal(v2.delivery.filing.receipt, null);
});

test("the full frozen-version confirmation, package, receipt, archive and next-period chain remains bound", () => {
  let workspace = withPayrollSocialData(closeableWorkspace());
  for (const item of buildVatReconciliationSummary(workspace).unresolvedItems) {
    workspace = recordVatReconciliation(workspace, {
      kind: item.kind,
      reason: "完整流程测试已人工核对该差额",
      adjustmentAmount: -item.differenceBeforeAdjustment,
    }, { actor: "测试会计", at: "2026-09-04T08:00:30.000Z" });
  }
  workspace = freezeAccountingReportVersion(
    workspace,
    { period: workspace.currentPeriod, label: "月度财务报表" },
    { actor: "测试会计", at: "2026-09-04T08:01:00.000Z" },
  );
  workspace = freezeReportVersion(workspace, "测试会计");
  const versionId = workflowChecks(workspace).version.id;
  workspace = createCustomerConfirmationPackage(
    workspace,
    { period: workspace.currentPeriod, reportVersionId: versionId },
    { actor: "测试会计", at: "2026-09-04T08:02:00.000Z" },
  );
  const confirmationId = workspace.confirmations.at(-1).id;
  for (const [index, section] of ["finance", "revenue", "costExpense", "vat", "inputVat", "payroll", "socialSecurity", "openItems"].entries()) {
    workspace = recordCustomerConfirmation(workspace, {
      confirmationId,
      section,
      decision: "approve",
      note: "本地逐项确认",
    }, { actor: "客户负责人", at: `2026-09-04T08:${String(3 + index).padStart(2, "0")}:00.000Z` });
  }
  workspace = {
    ...workspace,
    tax: {
      ...workspace.tax,
      financeConfirmedAt: "2026-09-04T08:12:00.000Z",
      financeConfirmedVersionId: versionId,
    },
    delivery: {
      ...workspace.delivery,
      filing: { ...workspace.delivery.filing, initialConfirmationId: confirmationId },
    },
  };
  workspace = confirmPayrollSocialData(workspace, { section: "payroll", confirmed: true }, { actor: "客户负责人", at: "2026-09-04T08:12:10.000Z" });
  workspace = confirmPayrollSocialData(workspace, { section: "socialSecurity", confirmed: true }, { actor: "客户负责人", at: "2026-09-04T08:12:20.000Z" });
  workspace = prepareFilingDraft(workspace, "测试会计");
  workspace = {
    ...workspace,
    tax: {
      ...workspace.tax,
      ownerConfirmedAt: "2026-09-04T08:13:00.000Z",
      ownerConfirmedVersionId: versionId,
      confirmedBy: "客户负责人",
    },
    delivery: {
      ...workspace.delivery,
      filing: { ...workspace.delivery.filing, finalConfirmedVersionId: versionId },
    },
  };
  workspace = markPackageExported(workspace, {
    id: "filing-package-test",
    fileName: "申报包.zip",
    size: 1024,
    hash: "package-sha256",
    exportedAt: "2026-09-04T08:14:00.000Z",
    reportVersionId: versionId,
  }, "测试会计");
  workspace = {
    ...workspace,
    documents: [...workspace.documents, {
      id: "receipt-document-test",
      name: "真实回执.txt",
      category: "申报回执",
      deliveryArtifact: true,
      period: workspace.currentPeriod,
      hash: "receipt-sha256",
      relatedObjectIds: [],
      storage: { mode: "indexeddb", blobId: "receipt-document-test", availableLocally: true },
    }],
  };
  workspace = attachReceipt(workspace, {
    id: "receipt-test",
    name: "真实回执.txt",
    hash: "receipt-sha256",
    documentId: "receipt-document-test",
    importedAt: "2026-09-04T08:15:00.000Z",
  }, "测试会计");
  assert.equal(workflowChecks(workspace).archive.every((check) => check.ok), true);

  const fingerprint = workflowSourceFingerprint(workspace);
  const archived = archivePeriod(workspace, "测试会计");
  assert.equal(archived.delivery.archives[0].sourceFingerprint, fingerprint);
  assert.equal(archived.documents.find((document) => document.id === "receipt-document-test").archiveStatus, "archived");

  const { store } = integratedStore(archived);
  assert.throws(() => store.actions.replaceWorkspace(archived.id, { ...store.getActiveWorkspace(), tax: { ...archived.tax, payroll: 1 } }), /已经归档/);
  assert.doesNotThrow(() => store.actions.replaceWorkspace(archived.id, store.getActiveWorkspace(), { allowArchivedTransition: true, requiredPermission: "data.read" }));

  const next = enterNextPeriod(archived, "测试会计");
  assert.notEqual(next.currentPeriod, archived.currentPeriod);
  assert.equal(next.tax.payroll, 0);
  assert.equal(next.tax.socialSecurity, 0);
  assert.deepEqual(next.tax.sourceIds, []);
  assert.deepEqual(next.tax.payrollSourceIds, []);
  assert.deepEqual(next.tax.socialSecuritySourceIds, []);
});
