import assert from "node:assert/strict";
import { withVoucherEvidence } from "./helpers/voucherEvidenceFixture.mjs";
import test from "node:test";
import JSZip from "jszip";

import {
  accountDefinition,
  buildFinancialStatements,
  buildTaxWorkpaper,
  createAccountingFixture,
  createPostedVoucherRevision,
  freezeReportVersion as freezeAccountingReportVersion,
  postVoucher,
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
import { activateWorkspacePeriod, confirmOpeningBalances, openingBalancesReady, saveActivePeriodState } from "../src/domain/periods.js";
import {
  applyPayrollSocialImport,
  buildPayrollSocialSummary,
  buildStructuredInvoiceVatSummary,
  createDocumentMetadata,
  preparePayrollSocialImport,
  syncDocumentMissingTasks,
} from "../src/features/intake/documentIntake.js";
import { createMemoryFileVault } from "../src/features/intake/browserFileVault.js";
import { postVoucherWithEvidence } from "../src/domain/accounting/vouchers.js";
import { buildBankMonthlyReconciliation, prepareBankImport, reconcileBankAccountPeriod } from "../src/features/intake/bankStatementImport.js";
import { billSettlement, buildAdvanceBalances, buildAgeingSchedule } from "../src/features/reconciliation/reconciliationEngine.js";
import { buildMemberLedger, buildMemberServiceReconciliation } from "../src/features/members/memberLedger.js";
import { activeAccountingRuleSet } from "../src/domain/accounting/model.js";
import { createBlankWorkspace } from "../src/financeData.js";
import {
  PRIMARY_NAV,
  PRODUCT_NAME,
  archivePeriod,
  attachReceipt,
  buildArchivedPeriodExport,
  buildFinalConfirmationSnapshot,
  buildVatReconciliationSummary,
  buildReportSnapshot,
  buildPayrollAccountingSummary,
  createPayrollAccrualDraft,
  confirmPayrollSocialData,
  enterAccountingPeriod,
  enterNextPeriod,
  ensureWorkspace,
  exportLocalFilingPackage,
  freezeReportVersion,
  getPayrollSocialConfirmationState,
  markPackageExported,
  monthlyCloseStageState,
  prepareFilingDraft,
  recordFinalConfirmation,
  recordInitialConfirmationSection,
  recordVatReconciliation,
  resetTaxForPeriod,
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
  let workspace = normalizeWorkspace(ensureWorkspace(createAccountingFixture()), { now: fixedNow });
  workspace.bills = workspace.bills.map((bill) => bill.id === "bill-prepay-1" ? { ...bill, cashFlowCategory: "operating" } : bill);
  workspace.documents = workspace.documents.map((document) => ({
    ...document,
    storage: { ...(document.storage || {}), availableLocally: true },
  }));
  workspace.transactions = workspace.transactions.map((transaction) => ({ ...transaction, status: "ignored" }));
  workspace.vouchers = workspace.vouchers.map((voucher) => ({
    ...voucher,
    status: "posted",
    evidenceIds: voucher.evidenceIds?.length ? voucher.evidenceIds : ["doc-bank"],
  }));
  workspace.exceptionTasks = [];
  workspace.bankImports = [];
  for (const account of workspace.bankAccounts) {
    const periodMovement = workspace.transactions
      .filter((transaction) => transaction.accountId === account.id && String(transaction.date || "").startsWith(workspace.currentPeriod))
      .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
    workspace = {
      ...workspace,
      bankAccounts: workspace.bankAccounts.map((item) => item.id === account.id ? {
        ...item,
        statementClosing: Number(item.openingBalance || 0) + periodMovement,
      } : item),
      bankImports: [
        ...workspace.bankImports,
        {
          id: `close-import-${account.id}`,
          accountId: account.id,
          period: workspace.currentPeriod,
          importedAt: "2026-09-04T07:58:00.000Z",
          status: "completed",
          reconciliation: {
            openingBalance: Number(account.openingBalance || 0),
            statementClosing: Number(account.openingBalance || 0) + periodMovement,
          },
        },
      ],
    };
    workspace = reconcileBankAccountPeriod(workspace, {
      accountId: account.id,
      period: workspace.currentPeriod,
      actor: "测试会计",
      reconciledAt: "2026-09-04T07:59:00.000Z",
    }).workspace;
  }
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

async function importPayrollOriginal(workspace, fileVault, { id, sourceKind, table }) {
  const fileName = `${id}.csv`;
  const file = Object.assign(new Blob([table.map((row) => row.join(",")).join("\n")], { type: "text/csv" }), { name: fileName });
  const document = await createDocumentMetadata(file, { id: `document-${id}`, period: workspace.currentPeriod });
  await fileVault.put({ id: document.id, workspaceId: workspace.id, hash: document.hash, blob: file });
  const next = { ...workspace, documents: [...workspace.documents, document] };
  const plan = preparePayrollSocialImport(next, {
    id, sourceKind, fileName, table,
    mapping: { employee: 0, period: 1, grossSalary: 2, personalSocial: 3, employerSocial: 4, individualIncomeTax: 5, netSalary: 6 },
    defaultPeriod: workspace.currentPeriod,
    sourceDocumentId: document.id, sourceDocumentHash: document.hash, sourceDocumentVersion: document.version,
  });
  assert.equal(plan.canApply, true);
  return applyPayrollSocialImport(next, plan, { actor: "测试会计", at: "2026-09-04T08:00:25.000Z" });
}

// Confirmation/closing fixtures must use the same source and posting path as the UI.
// The synchronous comparison fixture above intentionally remains independent of posting.
async function withPostedPayrollSocialData(workspace, fileVault = createMemoryFileVault()) {
  let next = withPayrollSocialData(workspace);
  for (const sourceKind of ["payroll", "socialSecurity"]) {
    const rows = next.payrollRecords.filter((record) => record.sourceKind === sourceKind && record.period === next.currentPeriod);
    next = await importPayrollOriginal(next, fileVault, {
      id: `original-${sourceKind}`, sourceKind,
      table: [["员工", "所属期", "应发工资", "个人社保", "企业社保", "个税", "实发工资"],
        ...rows.map((record) => [record.employeeName, record.period, record.grossSalary, record.personalSocial, record.employerSocial, record.individualIncomeTax ?? "", record.netSalary ?? ""])],
    });
  }
  const before = buildFinancialStatements(next);
  next = await createPayrollAccrualDraft(next, {}, { actor: "测试会计", at: "2026-09-04T08:00:26.000Z", fileVault });
  const voucherId = buildPayrollAccountingSummary(next).draftVoucherId;
  assert.equal(next.vouchers.find((voucher) => voucher.id === voucherId).status, "draft");
  next = await postVoucherWithEvidence(next, { voucherId, reviewNote: "逐人核对工资社保两表、原件与应付计提分录" }, { actor: "测试会计", at: "2026-09-04T08:00:27.000Z", fileVault });
  const summary = buildPayrollAccountingSummary(next);
  assert.equal(summary.postedAndMatched, true, summary.message);
  assert.deepEqual(summary.rows.map((row) => row.posted), [10000, 1600, 8950, 2400, 250]);
  assert.equal(buildFinancialStatements(next).incomeStatement.expenses.value - before.incomeStatement.expenses.value, 11600);
  return next;
}

function explainVatDifferences(workspace) {
  let next = workspace;
  for (const item of buildVatReconciliationSummary(next).unresolvedItems) {
    next = recordVatReconciliation(next, {
      kind: item.kind,
      reason: "已复核账面与发票来源，差额在本地底稿单独调整",
      adjustmentAmount: -item.differenceBeforeAdjustment,
    }, { actor: "测试会计", at: "2026-09-04T08:00:30.000Z" });
  }
  return next;
}

function approveInitialConfirmation(workspace) {
  let next = workspace;
  const version = workflowChecks(next).version;
  const sections = ["finance", "revenue", "costExpense", "vat", "inputVat",
    ...(version.snapshot.confirmationContext.payrollEnabled ? ["payroll", "socialSecurity"] : []), "openItems"];
  for (const [index, section] of sections.entries()) {
    next = recordInitialConfirmationSection(next, {
      reportVersionId: version.id,
      section,
      decision: "approve",
      note: "已逐项复核页面中的冻结金额与来源",
      confirmationName: "客户负责人",
    }, { actor: "测试会计", at: `2026-09-04T08:${String(3 + index).padStart(2, "0")}:00.000Z` });
  }
  return next;
}

function finalConfirmationInput(workspace) {
  return {
    reportVersionId: workflowChecks(workspace).version.id,
    filingDraftCreatedAt: workspace.delivery.filing.draftCreatedAt,
    name: "客户负责人",
    selections: {
      numbersReviewed: true,
      risksAcknowledged: true,
      localOnlyAcknowledged: true,
      deductionAuthorization: "do_not_authorize",
    },
  };
}

function recordPackageAndReceipt(workspace) {
  let next = markPackageExported(workspace, {
    id: "filing-package-test",
    fileName: "申报包.zip",
    size: 1024,
    hash: "package-sha256",
    exportedAt: "2026-09-04T08:14:00.000Z",
    reportVersionId: workflowChecks(workspace).version.id,
  }, "测试会计");
  next = {
    ...next,
    documents: [...next.documents, {
      id: "receipt-document-test",
      name: "真实回执.txt",
      category: "申报回执",
      deliveryArtifact: true,
      period: next.currentPeriod,
      hash: "receipt-sha256",
      relatedObjectIds: [],
      storage: { mode: "indexeddb", blobId: "receipt-document-test", availableLocally: true },
    }],
  };
  return attachReceipt(next, {
    packageId: next.delivery.filing.exportedPackage.id,
    packageHash: next.delivery.filing.exportedPackage.hash,
    reportVersionId: next.delivery.filing.exportedPackage.reportVersionId,
    id: "receipt-test",
    name: "真实回执.txt",
    hash: "receipt-sha256",
    documentId: "receipt-document-test",
    importedAt: "2026-09-04T08:15:00.000Z",
  }, "测试会计");
}

function archiveWithoutTax(workspace = closeableWorkspace()) {
  const localClose = { ...workspace, modules: { ...workspace.modules, tax: false, payroll: false } };
  return archivePeriod(freezeReportVersion(localClose, "测试会计"), "测试会计");
}

function nonBankCarryForwardFixture() {
  const workspace = closeableWorkspace();
  workspace.members = [{ id: "carry-member", name: "跨期会员", status: "active", openingSessions: 24, openingBalance: 2400 }];
  workspace.bills.push({ id: "carry-payable", kind: "payable", recognitionBasis: "opening", counterparty: "跨期供应商", amount: 450, date: "2026-08-01", dueDate: "2026-09-10" });
  workspace.openingLedger.payable = Number(workspace.openingLedger.payable || 0) - 450;
  workspace.openingLedger.loan = -6000;
  workspace.openingLedger.equity += 6450;
  workspace.ruleSets = [{ id: "carry-industry-v7", name: "当前行业规则", version: 7, status: "active", updatedAt: fixedNow().toISOString(), confidenceThreshold: 88, amountTolerance: 0.01 }];
  return archiveWithoutTax(workspace);
}

test("关闭核销且无银行数据时银行勾稽不适用，已有银行数据不能借关闭模块绕过确认前置", () => {
  const blank = normalizeWorkspace(ensureWorkspace(createBlankWorkspace({ name: "无银行工资确认", industry: "其他服务业", taxpayerType: "小规模纳税人" })), { now: fixedNow });
  blank.modules = { ...blank.modules, reconcile: false, payroll: true, tax: true, members: false, inventory: false };
  const check = (workspace) => workflowChecks(workspace).checks.find((item) => item.id === "bank");
  assert.equal(blank.bankAccounts.length, 0);
  assert.notEqual(blank.stages?.s3?.status, "complete");
  assert.equal(check(blank).ok, true);
  assert.equal(check(blank).applicable, false);
  assert.equal(check(blank).label, "银行勾稽不适用");
  assert.equal(workflowChecks(blank).bankReconciliationSummary.passed, false);
  const confirmFinance = (workspace) => {
    const frozen = freezeReportVersion(workspace, "测试会计");
    return recordInitialConfirmationSection(frozen, {
      reportVersionId: workflowChecks(frozen).version.id, section: "finance", decision: "approve",
      note: "已核对本地财务数据", confirmationName: "实际确认人",
    }, { actor: "测试会计", at: fixedNow().toISOString() });
  };
  const confirmed = confirmFinance(blank);
  assert.equal(confirmed.confirmations.at(-1).sections.finance.status, "approved");
  const nonBankPayroll = structuredClone(blank);
  nonBankPayroll.vouchers.push({ id: "salary-accrual", date: `${blank.currentPeriod}-01`, status: "posted", lines: [
    { account: "expenseSalary", debit: 100, credit: 0 }, { account: "payable", debit: 0, credit: 100 },
  ] });
  assert.equal(check(nonBankPayroll).applicable, false);
  for (const [label, addBankData] of [
    ["账户", (workspace) => workspace.bankAccounts.push({ id: "existing-bank", name: "已有账户", openingBalance: 0 })],
    ["流水", (workspace) => workspace.transactions.push({ id: "existing-transaction", date: `${workspace.currentPeriod}-01`, amount: 5, status: "ignored" })],
    ["导入记录", (workspace) => workspace.bankImports.push({ id: "existing-import", period: workspace.currentPeriod })],
    ["银行期初余额", (workspace) => { workspace.openingLedger.bank = 100; workspace.openingLedger.equity = -100; }],
    ["银行凭证", (workspace) => workspace.vouchers.push({ id: "existing-bank-voucher", date: `${workspace.currentPeriod}-01`, status: "posted", lines: [{ account: "bank", debit: 100, credit: 0 }, { account: "equity", debit: 0, credit: 100 }] })],
    ["自定义银行科目余额", (workspace) => {
      workspace.chartOfAccounts.push({ id: "custom-settlement", name: "自定义结算资金", category: "asset", normalSide: "debit", cash: true, status: "active" });
      workspace.openingLedger["custom-settlement"] = 100;
      workspace.openingLedger.equity = -100;
    }],
  ]) {
    const workspace = structuredClone(blank);
    addBankData(workspace);
    assert.equal(check(workspace).applicable, true, label);
    assert.equal(check(workspace).ok, false, label);
    assert.throws(() => confirmFinance(workspace), /核对银行流水/, label);
  }
  assert.equal(check({ ...blank, modules: { ...blank.modules, reconcile: true } }).ok, false);
});

for (const scenario of [
  { name: "手工余额", ledger: { receivable: 100, equity: -100 }, confirmed: true },
  { name: "已确认的零余额", ledger: {}, confirmed: true },
  { name: "待确认的已有余额", ledger: { receivable: 100, equity: -100 }, confirmed: false },
]) {
  test(`切换账期反复遇到结转冲突仍保留${scenario.name}`, () => {
    const archived = archiveWithoutTax();
    const targetPeriod = enterNextPeriod(archived).currentPeriod;
    const target = activateWorkspacePeriod(archived, targetPeriod);
    let workspace = scenario.confirmed
      ? confirmOpeningBalances(target, scenario.ledger, "测试会计")
      : saveActivePeriodState({ ...target, openingLedger: scenario.ledger });
    for (let visit = 0; visit < 3; visit += 1) {
      workspace = enterAccountingPeriod(activateWorkspacePeriod(workspace, archived.currentPeriod), targetPeriod, "测试会计");
      assert.equal(workspace.currentPeriod, targetPeriod);
      assert.equal(workspace.openingStatus.status, "conflict");
      assert.equal(openingBalancesReady(workspace), false);
      assert.deepEqual(workspace.openingLedger, scenario.ledger);
      assert.deepEqual(workspace.periodStates[targetPeriod].openingLedger, scenario.ledger);
      assert.deepEqual(workspace.delivery.archives, archived.delivery.archives);
    }
    const confirmed = confirmOpeningBalances(workspace, scenario.ledger, "测试会计");
    const revisited = enterAccountingPeriod(activateWorkspacePeriod(confirmed, archived.currentPeriod), targetPeriod, "测试会计");
    assert.equal(revisited.openingStatus.status, "confirmed");
    assert.deepEqual(revisited.openingLedger, scenario.ledger);
  });
}

test("非银行跨期保留往来余额、预收预付来源、会员未履约、借款、延期事项与行业规则版本", () => {
  const archived = nonBankCarryForwardFixture();
  const history = structuredClone(archived.delivery.archives);
  const next = enterNextPeriod(archived, "测试会计");
  const statements = buildFinancialStatements(next);
  for (const accountId of ["receivable", "payable", "prepayment", "contractLiability", "loan"]) {
    const account = statements.ledger.accounts.find((item) => item.accountId === accountId);
    assert.equal(account.opening, history[0].closingLedger[accountId], accountId);
    assert.equal(account.closing, account.opening, accountId);
    assert.deepEqual(account.entries, [], accountId);
  }
  assert.equal(next.openingLedger.loan, -6000);
  assert.equal(next.openingCarryForward.archiveId, history[0].id);
  assert.equal(next.openingCarryForward.fromPeriod, archived.currentPeriod);
  const asOf = `${next.currentPeriod}-01`;
  for (const bill of archived.bills) {
    assert.deepEqual(billSettlement(next, bill.id, { asOf }), billSettlement(archived, bill.id, { asOf }));
  }
  const ageing = buildAgeingSchedule(next, { asOf });
  assert.equal(ageing.rows.find((row) => row.billId === "bill-ar-3").balance, 900);
  assert.equal(ageing.rows.find((row) => row.billId === "carry-payable").balance, 450);
  assert.ok(ageing.rows.find((row) => row.billId === "bill-ar-3").sourceIds.includes("txn-partial"));
  const advances = buildAdvanceBalances(next);
  assert.deepEqual(advances, buildAdvanceBalances(archived));
  assert.equal(advances.rows.find((row) => row.billId === "bill-deposit-1").availableBalance, 2400);
  assert.equal(advances.rows.find((row) => row.billId === "bill-prepay-1").availableBalance, 1800);
  assert.ok(advances.rows.find((row) => row.billId === "bill-deposit-1").sourceIds.includes("txn-deposit"));
  assert.equal(buildMemberLedger(next).totals.remainingSessions, 24);
  assert.equal(buildMemberLedger(next).totals.unfulfilledBalance, 2400);
  assert.equal(buildMemberServiceReconciliation(next).passed, true);
  assert.equal(activeAccountingRuleSet(next).id, "carry-industry-v7");
  assert.equal(activeAccountingRuleSet(next).version, 7);
  assert.deepEqual(next.ruleSets, archived.ruleSets);
  for (const item of history[0].carryForwardItems) {
    const notices = next.delivery.notices.filter((notice) => notice.period === next.currentPeriod && notice.sourceId === item.id);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].status, "open");
    assert.equal(notices[0].amount, item.amount);
  }
  assert.ok(history[0].carryForwardItems.length > 0);
  assert.equal(workflowChecks(next).checks.find((check) => check.id === "exceptions").ok, false);
  assert.deepEqual(next.vouchers, archived.vouchers);
  assert.deepEqual(next.businessEvents, archived.businessEvents);
  assert.deepEqual(next.delivery.archives, history);
  assert.deepEqual(archived.delivery.archives, history);
  assert.equal(enterNextPeriod(next), next);
});

test("下一期收付、履约和还款仅改变剩余余额，不重复旧期分录或改写历史档案", () => {
  const archived = nonBankCarryForwardFixture();
  const history = structuredClone(archived.delivery.archives);
  const opening = enterNextPeriod(archived, "测试会计");
  const next = structuredClone(opening);
  const date = `${next.currentPeriod}-02`;
  next.transactions.push(
    { id: "carry-receipt", date, accountId: "bank:operating", amount: 200, allocations: [{ id: "carry-ar-allocation", billId: "bill-ar-3", amount: 200, status: "confirmed" }] },
    { id: "carry-payment", date, accountId: "bank:operating", amount: -150, allocations: [{ id: "carry-ap-allocation", billId: "carry-payable", amount: 150, status: "confirmed" }] },
    { id: "loan-repayment", date, accountId: "bank:operating", amount: -500, summary: "归还上期借款", allocations: [] },
  );
  next.businessEvents.push({ id: "carry-consumption", kind: "consumption", memberId: "carry-member", date, amount: 100, quantity: 1, status: "confirmed" });
  next.vouchers.push(
    { id: "carry-voucher-ar", date, status: "posted", sourceIds: ["carry-receipt", "bill-ar-3"], lines: [{ account: "bank:operating", debit: 200, credit: 0 }, { account: "receivable", debit: 0, credit: 200 }] },
    { id: "carry-voucher-ap", date, status: "posted", sourceIds: ["carry-payment", "carry-payable"], lines: [{ account: "payable", debit: 150, credit: 0 }, { account: "bank:operating", debit: 0, credit: 150 }] },
    { id: "carry-voucher-service", date, status: "posted", sourceIds: ["carry-consumption"], lines: [{ account: "contractLiability", debit: 100, credit: 0 }, { account: "revenuePrivate", debit: 0, credit: 100 }] },
    { id: "carry-voucher-loan", date, status: "posted", sourceIds: ["loan-repayment"], lines: [{ account: "loan", debit: 500, credit: 0 }, { account: "bank:operating", debit: 0, credit: 500 }] },
  );
  const statements = buildFinancialStatements(next);
  const balance = (id) => statements.ledger.accounts.find((account) => account.accountId === id).closing;
  assert.equal(balance("receivable"), opening.openingLedger.receivable - 200);
  assert.equal(balance("payable"), -300);
  assert.equal(balance("loan"), -5500);
  assert.equal(balance("contractLiability"), -2300);
  assert.equal(balance("prepayment"), 1800);
  assert.equal(statements.incomeStatement.profit.value, 100);
  assert.equal(statements.ledger.vouchers.length, 4);
  assert.equal(billSettlement(next, "bill-ar-3", { asOf: date }).remaining, 700);
  assert.equal(billSettlement(next, "carry-payable", { asOf: date }).remaining, 300);
  assert.equal(buildMemberLedger(next).totals.remainingSessions, 23);
  assert.equal(buildMemberLedger(next).totals.unfulfilledBalance, 2300);
  assert.equal(buildMemberServiceReconciliation(next).passed, true);
  assert.deepEqual(buildAdvanceBalances(next), buildAdvanceBalances(opening));
  next.ruleSets[0].version = 8;
  assert.deepEqual(next.delivery.archives, history);
  assert.deepEqual(archived.delivery.archives, history);
  assert.equal(activeAccountingRuleSet(opening).version, 7);
});

test("跨期按银行账户承接已核实结存，新期对账单余额仍待提供", () => {
  const workspace = closeableWorkspace();
  workspace.bankAccounts.push(
    { id: "carry-bank-two", name: "第二个账户", status: "active", openingBalance: 200, statementClosing: 200 },
    { id: "carry-bank-unverified", name: "未核实账户", status: "inactive", openingBalance: 0, statementClosing: 999 },
  );
  workspace.bankImports.push({
    id: "carry-bank-two-statement", accountId: "carry-bank-two", period: workspace.currentPeriod,
    importedAt: "2026-09-04T07:58:00.000Z", sourceDocumentId: "carry-bank-two-document",
    reconciliation: { openingBalance: 200, statementClosing: 200, passed: true },
  });
  const prior = workspace.bankAccounts.map((account) => buildBankMonthlyReconciliation(workspace, { accountId: account.id, period: workspace.currentPeriod }));
  assert.ok(prior.filter((row) => row.passed).length >= 2);
  const archived = archiveWithoutTax(workspace);
  const archiveBefore = structuredClone(archived.delivery.archives);
  const accountsBefore = structuredClone(archived.bankAccounts);
  const next = enterNextPeriod(archived, "测试会计");
  for (const previous of prior) {
    const monthly = buildBankMonthlyReconciliation(next, { accountId: previous.accountId, period: next.currentPeriod });
    assert.equal(monthly.openingBalance, previous.passed ? previous.statementClosing : null);
    assert.equal(monthly.statementClosing, null);
    assert.equal(monthly.difference, null);
    assert.equal(monthly.status, "not_started");
    assert.equal(monthly.passed, false);
    assert.equal(monthly.openingCarryForward.verified, previous.passed);
    assert.equal(monthly.openingCarryForward.fromPeriod, archived.currentPeriod);
    assert.equal(monthly.openingCarryForward.archiveId, archiveBefore[0].id);
    assert.deepEqual(monthly.openingCarryForward.sourceImportIds, previous.imports.map((record) => record.id));
    if (previous.imports.length) assert.deepEqual(buildBankMonthlyReconciliation(next, { accountId: previous.accountId, period: archived.currentPeriod }), previous);
  }
  assert.equal(next.bankAccounts.find((account) => account.id === "carry-bank-two").openingBalance, 200);
  assert.equal(next.bankAccounts.find((account) => account.id === "carry-bank-unverified").openingBalance, null);
  assert.deepEqual(archived.delivery.archives, archiveBefore);
  assert.deepEqual(next.delivery.archives, archiveBefore);
  assert.deepEqual(archived.bankAccounts, accountsBefore);
  const plan = prepareBankImport(next, {
    accountId: "carry-bank-two", period: next.currentPeriod, fileName: "次月流水.csv",
    table: [["交易日期", "金额", "余额"], [`${next.currentPeriod}-01`, 10, 210]],
    mapping: { date: 0, amount: 1, balance: 2 },
  });
  assert.equal(plan.reconciliation.openingBalance, 200);
  assert.equal(plan.reconciliation.statementClosing, 210);
  assert.equal(plan.reconciliation.passed, true);
  const normalized = normalizeWorkspace(next, { now: fixedNow });
  assert.deepEqual(normalized.bankAccounts.find((account) => account.id === "carry-bank-two").balanceCarryForwards, next.bankAccounts.find((account) => account.id === "carry-bank-two").balanceCarryForwards);
});

for (const scenario of [
  { name: "profit", cost: 500, profit: 2080, equityAccountId: "equity", openingEquity: -25000, nextEquity: -27080 },
  { name: "loss", cost: 3080, profit: -500, equityAccountId: "equity", openingEquity: -25000, nextEquity: -24500 },
  { name: "zero profit", cost: 2580, profit: 0, equityAccountId: "equity", openingEquity: -25000, nextEquity: -25000 },
  { name: "custom retained earnings", cost: 500, profit: 2080, equityAccountId: "retainedEarnings", openingEquity: -1000, nextEquity: -3080 },
]) {
  test(`period carry-forward clears income accounts and carries ${scenario.name} into equity exactly once`, () => {
    const workspace = closeableWorkspace();
    if (scenario.equityAccountId !== "equity") {
      workspace.chartOfAccounts = [...workspace.chartOfAccounts, {
        id: scenario.equityAccountId, label: "本工作台未分配利润", category: "equity", normalSide: "credit", status: "active",
      }];
      workspace.openingLedger = { ...workspace.openingLedger, equity: -24000, [scenario.equityAccountId]: scenario.openingEquity };
    }
    workspace.bills.push({ id: "bill-carry-forward-cost", kind: "payable", counterparty: "成本供应商", amount: scenario.cost, date: `${workspace.currentPeriod}-31`, dueDate: "2026-09-15", status: "active" });
    workspace.vouchers.push({
      id: "carry-forward-cost", no: "记-012", period: workspace.currentPeriod, date: `${workspace.currentPeriod}-31`,
      summary: "确认本期主营业务成本", status: "posted", version: 1, sourceIds: ["bill-carry-forward-cost"], evidenceIds: ["doc-purchase"],
      lines: [
        { account: "costOfSales", debit: scenario.cost, credit: 0, sourceIds: ["bill-carry-forward-cost"] },
        { account: "payable", debit: 0, credit: scenario.cost, sourceIds: ["bill-carry-forward-cost"] },
      ],
    });
    const archived = archiveWithoutTax(workspace);
    const archive = structuredClone(archived.delivery.archives[0]);
    assert.equal(archive.summary.profit, scenario.profit);
    assert.equal(archive.closingLedger.revenueGroup, -3200);
    assert.equal(archive.closingLedger.salesReturns, 600);
    assert.equal(archive.closingLedger.costOfSales, scenario.cost);
    assert.equal(archive.closingLedger.expenseFee, 20);
    if (scenario.profit !== 0) {
      assert.throws(() => enterNextPeriod(archived, "测试会计", { equityAccountId: "expenseFee" }), /有效的权益科目/);
    }

    const next = enterNextPeriod(archived, "测试会计", { equityAccountId: scenario.equityAccountId });
    assert.equal(next.currentPeriod, "2026-09");
    for (const account of ["revenueGroup", "salesReturns", "costOfSales", "expenseFee"]) assert.equal(next.openingLedger[account], 0, account);
    assert.equal(next.openingLedger[scenario.equityAccountId], scenario.nextEquity);
    for (const [account, balance] of Object.entries(archive.closingLedger)) {
      if (["asset", "contraAsset", "liability", "equity"].includes(accountDefinition(account, archived).category) && account !== scenario.equityAccountId) {
        assert.equal(next.openingLedger[account], balance, `${account} retains its archived balance`);
      }
    }
    assert.equal(Math.round(Object.values(next.openingLedger).reduce((sum, value) => sum + value, 0) * 100), 0);
    assert.equal(buildReportSnapshot(next).summary.profit, 0);
    assert.equal(next.openingCarryForward.profit, scenario.profit);
    assert.equal(next.openingCarryForward.archiveId, archive.id);
    assert.equal(next.openingCarryForward.equityAccountId, scenario.profit === 0 ? null : scenario.equityAccountId);
    assert.deepEqual(next.delivery.archives[0], archive);
    assert.deepEqual(archived.delivery.archives[0], archive);
    assert.equal(enterNextPeriod(next, "测试会计"), next);
    assert.deepEqual(enterNextPeriod(archived, "测试会计", { equityAccountId: scenario.equityAccountId }).openingLedger, next.openingLedger);
  });
}

test("attachment exports keep fingerprints stable and archived carry-forward ignores later financial or evidence edits", () => {
  const workspace = closeableWorkspace();
  workspace.documents.find((document) => document.id === "doc-settlement").hash = "settlement-original-hash";
  const archived = archiveWithoutTax(workspace);
  const archive = structuredClone(archived.delivery.archives[0]);
  const exported = structuredClone(archived);
  const voucher = exported.vouchers.find((item) => item.id === "voucher-0003");
  voucher.attachmentPackages = [...(voucher.attachmentPackages || []), {
    id: "attachment-export-after-close", exportedAt: "2026-09-05T09:00:00.000Z", fileName: "记-003-附件.zip", hash: "attachment-package-hash",
  }];
  voucher.updatedAt = "2026-09-05T09:00:00.000Z";
  assert.equal(workflowSourceFingerprint(exported), workflowSourceFingerprint(archived));
  assert.equal(workflowChecks(exported).version.id, archive.reportVersionId);
  const next = enterNextPeriod(exported, "测试会计");
  assert.equal(next.currentPeriod, "2026-09");
  assert.deepEqual(next.vouchers.find((item) => item.id === voucher.id).attachmentPackages, voucher.attachmentPackages);
  assert.equal(next.vouchers.find((item) => item.id === voucher.id).updatedAt, voucher.updatedAt);
  assert.deepEqual(next.delivery.archives[0], archive);

  for (const [label, change] of [
    ["balanced entry amounts", (changed) => {
      const entry = changed.vouchers.find((item) => item.id === "voucher-0003");
      entry.lines[0].debit += 1;
      entry.lines[1].credit += 1;
    }],
    ["source relationship", (changed) => changed.vouchers.find((item) => item.id === "voucher-0003").sourceIds.push("new-source")],
    ["original evidence hash", (changed) => { changed.documents.find((document) => document.id === "doc-settlement").hash = "changed-original-hash"; }],
  ]) {
    const changed = structuredClone(exported);
    change(changed);
    assert.notEqual(workflowSourceFingerprint(changed), workflowSourceFingerprint(archived), label);
    assert.equal(workflowChecks(changed).version.id, archive.reportVersionId, `${label}: archived views retain their frozen version`);
    assert.deepEqual(workflowChecks(changed).version.snapshot, archive.reportSnapshot, label);
    const changedNext = enterNextPeriod(changed, "测试会计");
    assert.deepEqual(changedNext.openingLedger, next.openingLedger, `${label}: opening ledger comes from the archived closing ledger`);
    assert.deepEqual(changedNext.openingCarryForward, next.openingCarryForward, `${label}: profit carry-forward retains its archived source`);
    assert.deepEqual(changedNext.bankAccounts.map((account) => [account.id, account.openingBalance, account.balanceCarryForwards?.[changedNext.currentPeriod]]), next.bankAccounts.map((account) => [account.id, account.openingBalance, account.balanceCarryForwards?.[next.currentPeriod]]), `${label}: bank openings retain frozen reconciliation values`);
    assert.deepEqual(changedNext.delivery.archives[0], archive, label);
    assert.deepEqual(changed.delivery.archives[0], archive);
  }
});

test("initial and final confirmations retain signatures, reject stale views and cannot be replaced by timestamp flags", async () => {
  const base = closeableWorkspace();
  base.modules.payroll = false;
  const frozen = freezeReportVersion(explainVatDifferences(base), "测试会计");
  const versionId = workflowChecks(frozen).version.id;
  const decision = { reportVersionId: versionId, section: "finance", decision: "approve", note: "已核对冻结报表", confirmationName: "客户负责人" };
  assert.throws(() => recordInitialConfirmationSection(frozen, { ...decision, note: " " }), /必须填写说明/);
  assert.throws(() => recordInitialConfirmationSection(frozen, { ...decision, confirmationName: " " }), /真实姓名/);
  assert.throws(() => recordInitialConfirmationSection(frozen, { ...decision, isMajor: true, responsibleName: " " }), /负责人签字姓名/);
  assert.throws(() => recordInitialConfirmationSection(frozen, { ...decision, reportVersionId: "stale-version" }), /报表版本已变化/);

  const major = recordInitialConfirmationSection(frozen, { ...decision, isMajor: true, responsibleName: "重大事项负责人" }, { actor: "测试会计", at: "2026-09-04T08:01:00.000Z" });
  assert.equal(major.confirmations.at(-1).decisions.at(-1).actor, "重大事项负责人");
  assert.match(major.confirmations.at(-1).decisions.at(-1).note, /^重大事项：/);
  assert.equal(major.confirmations.at(-1).decisions.at(-1).reportVersionId, versionId);
  assert.throws(() => recordInitialConfirmationSection(major, decision), /不能重复覆盖/);
  const disputed = recordInitialConfirmationSection(frozen, { ...decision, decision: "reject", note: "费用来源存在异议" }, { actor: "测试会计" });
  assert.equal(disputed.confirmations.at(-1).status, "disputed");
  assert.equal(disputed.exceptionTasks.some((task) => task.code === "customer_dispute" && task.status === "open" && task.message === "费用来源存在异议"), true);
  assert.equal(disputed.tax.financeConfirmedAt, null);
  assert.throws(() => prepareFilingDraft(disputed), /生成申报底稿前仍需完成/);

  const forgedInitial = { ...frozen, tax: { ...frozen.tax, financeConfirmedAt: fixedNow().toISOString(), financeConfirmedVersionId: versionId } };
  assert.equal(workflowChecks(forgedInitial).checks.find((check) => check.id === "finance").ok, false);
  assert.throws(() => prepareFilingDraft(forgedInitial), /完成首次确认/);
  const approved = approveInitialConfirmation(frozen);
  assert.equal(approved.confirmations.at(-1).status, "approved");
  assert.equal(approved.confirmations.at(-1).decisions.every((decision) => decision.actor === "客户负责人"), true);
  assert.equal(approved.delivery.filing.initialConfirmationId, approved.confirmations.at(-1).id);
  assert.equal(workflowChecks(approved).checks.find((check) => check.id === "finance").ok, true);
  assert.equal("payroll" in approved.confirmations.at(-1).sections, false);
  const draft = prepareFilingDraft(approved, "测试会计");
  const input = finalConfirmationInput(draft);
  assert.throws(() => recordFinalConfirmation(draft, { ...input, name: " " }), /最终负责人姓名/);
  assert.throws(() => recordFinalConfirmation(draft, { ...input, selections: { ...input.selections, risksAcknowledged: false } }), /三项最终确认声明/);
  assert.throws(() => recordFinalConfirmation(draft, { ...input, selections: { ...input.selections, deductionAuthorization: "" } }), /是否授权外部扣款/);
  assert.throws(() => recordFinalConfirmation(draft, { ...input, reportVersionId: "stale-version" }), /冻结版本或底稿已变化/);
  assert.throws(() => recordFinalConfirmation(draft, { ...input, filingDraftCreatedAt: "old-draft-time" }), /冻结版本或底稿已变化/);
  const mismatchedDraft = { ...draft, delivery: { ...draft.delivery, filing: { ...draft.delivery.filing, draftVersionId: "other-version" } } };
  assert.throws(() => recordFinalConfirmation(mismatchedDraft, input), /底稿与报表版本不一致/);
  const forgedFinal = {
    ...draft,
    tax: { ...draft.tax, ownerConfirmedAt: fixedNow().toISOString(), ownerConfirmedVersionId: versionId },
    delivery: { ...draft.delivery, filing: { ...draft.delivery.filing, finalConfirmedVersionId: versionId } },
  };
  assert.equal(workflowChecks(forgedFinal).checks.find((check) => check.id === "owner").ok, false);
  await assert.rejects(() => exportLocalFilingPackage(forgedFinal), /完成最终确认/);

  const final = recordFinalConfirmation(draft, input, { actor: "测试会计", at: "2026-09-04T08:13:00.000Z" });
  assert.equal(workflowChecks(final).checks.find((check) => check.id === "owner").ok, true);
  assert.deepEqual(final.confirmations.slice(0, -1), draft.confirmations);
  assert.deepEqual(final.confirmations.at(-1).signature, { name: "客户负责人", signedAt: "2026-09-04T08:13:00.000Z" });
  assert.equal(final.confirmations.at(-1).selections.deductionAuthorization, "do_not_authorize");
  assert.equal(final.confirmations.at(-1).snapshot.payrollSocial.applicable, false);
  assert.equal(final.auditLog.some((item) => item.action === "客户第二次最终确认"), true);
  assert.match(final.auditLog.find((item) => item.action === "客户第二次最终确认").detail, /仅保存本地记录，未提交税务局、未执行扣款/);
});

test("structured invoice VAT, first confirmation, final confirmation and actual filing ZIP share one frozen snapshot", async (t) => {
  let workspace = await withPostedPayrollSocialData(closeableWorkspace());
  const period = workspace.currentPeriod;
  const invoice = (id, taxDirection, amount, taxAmount) => ({
    id, name: `${id}.pdf`, category: "发票", period, hash: `${id}-original-hash`, relatedObjectIds: ["txn-split"],
    storage: { mode: "indexeddb", blobId: id, availableLocally: true },
    structuredData: {
      kind: "invoice", invoiceNumber: id, invoiceDate: `${period}-04`, taxDirection, amount, taxAmount,
      taxRate: taxDirection === "output" ? 13 : 6, verificationStatus: "unverified", redLetterStatus: "normal", voidStatus: "valid",
      certificationStatus: taxDirection === "input" ? "certified" : "not_required",
    },
  });
  workspace.documents.push(invoice("confirmation-output-invoice", "output", 113, 13), invoice("confirmation-input-invoice", "input", 106, 6));
  const revenueBasedVat = buildTaxWorkpaper(workspace, { period }).vatPayable.value;
  assert.notEqual(revenueBasedVat, 7);
  workspace = freezeReportVersion(explainVatDifferences(workspace), "测试会计");
  const version = structuredClone(workflowChecks(workspace).version);
  assert.equal(version.snapshot.taxWorkpaper.sourceMode, "structured_invoices");
  assert.equal(version.snapshot.taxWorkpaper.rows.find((row) => row.id === "vatPayable").value, 7);
  workspace = approveInitialConfirmation(workspace);
  const initial = structuredClone(workspace.confirmations.at(-1));
  assert.equal(initial.sections.vat.value, 7);
  assert.equal(initial.sections.inputVat.value, 6);
  assert.equal(initial.sections.payroll.value, 10000);
  assert.equal(initial.sections.socialSecurity.value, 2400);
  assert.equal(initial.sections.vat.sourceIds.includes("confirmation-output-invoice"), true);
  assert.equal(initial.sections.vat.sourceIds.includes("confirmation-input-invoice"), true);
  assert.deepEqual(initial.snapshot, version.snapshot);
  assert.equal(initial.reportSourceFingerprint, version.sourceFingerprint);

  workspace = prepareFilingDraft(workspace, "测试会计");
  const displayedFinal = buildFinalConfirmationSnapshot(workspace);
  workspace = recordFinalConfirmation(workspace, finalConfirmationInput(workspace), { actor: "测试会计" });
  const final = structuredClone(workspace.confirmations.at(-1));
  assert.deepEqual(final.snapshot, displayedFinal);
  assert.equal(final.snapshot.taxes.vat.value, 7);
  assert.deepEqual(new Set(final.snapshot.taxes.vat.sourceIds), new Set(initial.sections.vat.sourceIds));
  for (const [id, section] of Object.entries(initial.sections)) {
    assert.equal(final.snapshot.confirmationSections[id].value, section.value, id);
    assert.deepEqual(final.snapshot.confirmationSections[id].sourceIds, section.sourceIds, id);
  }
  assert.deepEqual(final.snapshot.confirmationSections.finance.metrics, initial.sections.finance.metrics);
  assert.equal(final.filingDraftCreatedAt, workspace.delivery.filing.draftCreatedAt);
  assert.equal(final.reportVersionId, initial.reportVersionId);
  assert.equal(final.reportSourceFingerprint, version.sourceFingerprint);

  let downloadedBlob;
  let clicked = false;
  const anchor = { click() { clicked = true; } };
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete globalThis.document;
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else delete globalThis.window;
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: { createElement: (tag) => { assert.equal(tag, "a"); return anchor; } } },
    window: { configurable: true, value: { setTimeout: (callback) => callback() } },
  });
  t.mock.method(URL, "createObjectURL", (blob) => { downloadedBlob = blob; return "blob:filing-package-test"; });
  t.mock.method(URL, "revokeObjectURL", () => {});
  const metadata = await exportLocalFilingPackage(workspace);
  assert.equal(clicked, true);
  assert.equal(anchor.download, metadata.fileName);
  assert.equal(metadata.size, downloadedBlob.size);
  assert.match(metadata.hash, /^[a-f0-9]{64}$/);
  assert.equal(metadata.reportVersionId, version.id);
  const zip = await JSZip.loadAsync(await downloadedBlob.arrayBuffer());
  const folder = `${PRODUCT_NAME}-${period}-本地申报包/`;
  const readJson = async (name) => JSON.parse(await zip.file(folder + name).async("string"));
  const serialized = (value) => JSON.parse(JSON.stringify(value));
  const report = await readJson("报表快照.json");
  const workpaper = await readJson("税务申报底稿.json");
  const confirmations = await readJson("客户确认记录.json");
  const payroll = await readJson("工资与社保明细.json");
  assert.deepEqual(report, serialized(version.snapshot));
  assert.deepEqual(workpaper.workpaper, serialized(version.snapshot.taxWorkpaper));
  assert.equal(workpaper.reportSourceFingerprint, version.sourceFingerprint);
  assert.deepEqual(confirmations.initialConfirmation, serialized(initial));
  assert.deepEqual(confirmations.finalConfirmation, serialized(final));
  assert.equal(confirmations.reportVersionId, version.id);
  assert.equal(payroll.totals.payroll.grossSalary, initial.sections.payroll.value);
  assert.equal(payroll.totals.socialSecurityPayable, initial.sections.socialSecurity.value);
  assert.equal(payroll.reportSourceFingerprint, version.sourceFingerprint);
  assert.deepEqual((await readJson("异常与确认记录.json")).confirmations, serialized([initial, final]));
  assert.deepEqual(workspace.delivery.reportVersions[0], version);

  const changed = structuredClone(workspace);
  changed.documents.find((document) => document.id === "confirmation-output-invoice").hash = "changed-original";
  assert.equal(workflowChecks(changed).version, null);
  await assert.rejects(() => exportLocalFilingPackage(changed), /冻结本期报表/);
  assert.deepEqual(changed.confirmations, workspace.confirmations);
});

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

test("workspace tax rates drive both accounting workpaper and visible local estimates", () => {
  const workspace = ensureWorkspace(createAccountingFixture());
  workspace.tax = {
    ...workspace.tax,
    vatRate: 0.06,
    surtaxRate: 0.08,
    incomeTaxRate: 0.1,
  };
  const tax = buildTaxWorkpaper(workspace, { period: workspace.currentPeriod });
  const snapshot = buildReportSnapshot(workspace);
  const row = (id) => snapshot.taxWorkpaper.rows.find((item) => item.id === id);

  assert.equal(tax.vatRate, 0.06);
  assert.equal(tax.surtaxRate, 0.08);
  assert.equal(tax.incomeTaxRate, 0.1);
  assert.equal(tax.estimatedSurtax.value, Number((tax.vatPayable.value * 0.08).toFixed(2)));
  assert.equal(tax.estimatedIncomeTax.value, Number((Math.max(0, snapshot.summary.profit) * 0.1).toFixed(2)));
  assert.equal(row("surtax").value, Number((row("vatPayable").value * 0.08).toFixed(2)));
  assert.equal(row("incomeTax").value, Number((Math.max(0, snapshot.summary.profit) * 0.1).toFixed(2)));
  assert.match(row("surtax").formula, /8\.00%/);
  assert.match(row("incomeTax").formula, /10\.00%/);

  const nextTax = resetTaxForPeriod(workspace.tax, "2026-09");
  assert.deepEqual(
    { vatRate: nextTax.vatRate, surtaxRate: nextTax.surtaxRate, incomeTaxRate: nextTax.incomeTaxRate },
    { vatRate: 0.06, surtaxRate: 0.08, incomeTaxRate: 0.1 },
  );
  assert.notEqual(
    workflowSourceFingerprint(workspace),
    workflowSourceFingerprint({ ...workspace, tax: { ...workspace.tax, incomeTaxRate: 0.12 } }),
  );
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
  await assert.rejects(() => exportLocalFilingPackage(workspace), /解释增值税差异/);
});

test("payroll and social records enter the tax workpaper, compare by employee, and require separate current confirmations", async () => {
  const fileVault = createMemoryFileVault();
  let workspace = await withPostedPayrollSocialData(closeableWorkspace(), fileVault);
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

  workspace = await importPayrollOriginal(workspace, fileVault, {
    id: "payroll-import-changed",
    sourceKind: "payroll",
    table: [["员工", "所属期", "应发工资", "个人社保", "企业社保", "个税", "实发工资"], ["陈教练", workspace.currentPeriod, 10100, 800, 1600, 250, 9050]],
  });
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
  const workspace = closeableWorkspace();
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
  base.bills = base.bills.map((bill) => bill.id === "bill-prepay-1" ? { ...bill, cashFlowCategory: "operating" } : bill);
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

test("current-period live document gaps stay visible without invalidating a compatible frozen report", () => {
  const workspace = closeableWorkspace();
  const pending = workspace.transactions.find((item) => String(item.date || "").startsWith(workspace.currentPeriod));
  pending.status = "pending";
  pending.evidenceIds = [];
  pending.documentIds = [];

  const beforeSync = workflowChecks(workspace);
  assert.ok(beforeSync.liveDocumentTasks.some((task) => task.sourceId === pending.id));
  assert.equal(beforeSync.liveDocumentTasks.every((task) => ["bankTransaction", "businessEvent"].includes(task.sourceType)), true);

  const synced = syncDocumentMissingTasks(workspace, { actor: "测试会计", at: "2026-09-04T08:00:40.000Z" }).workspace;
  const afterSync = workflowChecks(synced);
  assert.deepEqual(afterSync.openExceptionTasks.map((task) => task.identity), beforeSync.openExceptionTasks.map((task) => task.identity));
  assert.deepEqual(afterSync.archive.map((check) => [check.id, check.ok]), beforeSync.archive.map((check) => [check.id, check.ok]));
  assert.deepEqual(monthlyCloseStageState(synced, afterSync), monthlyCloseStageState(workspace, beforeSync));

  const frozen = freezeReportVersion(closeableWorkspace(), "测试会计");
  const frozenFlow = workflowChecks(frozen);
  assert.deepEqual(frozenFlow.liveDocumentTasks, []);
  assert.equal(frozenFlow.version?.id, frozen.delivery.reportVersions.at(-1).id);
});

test("a current valid voucher with a missing original still blocks the close workflow", () => {
  const workspace = closeableWorkspace();
  const voucher = workspace.vouchers.find((item) => item.id === "voucher-0011");
  voucher.evidenceIds = [];

  const unlinked = workflowChecks(workspace);
  assert.ok(unlinked.liveDocumentTasks.some((task) => (
    task.sourceType === "voucher"
    && task.sourceId === voucher.id
    && task.missingEvidence.some((item) => item.id.startsWith("voucher-original:"))
  )));
  assert.equal(unlinked.checks.find((check) => check.id === "exceptions").ok, false);

  voucher.evidenceIds = ["doc-bank"];
  workspace.documents = workspace.documents.map((document) => document.id === "doc-bank"
    ? { ...document, storage: { ...(document.storage || {}), availableLocally: false } }
    : document);
  const unavailable = workflowChecks(workspace);
  assert.ok(unavailable.liveDocumentTasks.some((task) => (
    task.sourceType === "voucher"
    && task.sourceId === voucher.id
    && task.missingEvidence.some((item) => item.id.startsWith("document:"))
  )));
  assert.equal(unavailable.checks.find((check) => check.id === "exceptions").ok, false);
});

test("the voucher stage waits for every current transaction and applicable payroll accrual", () => {
  const workspace = {
    currentPeriod: "2026-09",
    documents: [],
    transactions: [
      { id: "transaction-posted", date: "2026-09-01", status: "posted", postedVoucherId: "voucher-posted" },
      { id: "transaction-pending", date: "2026-09-02", status: "pending" },
    ],
    vouchers: [{ id: "voucher-posted", date: "2026-09-01", status: "posted", sourceIds: ["transaction-posted"], lines: [] }],
  };
  const flow = {
    checks: [],
    liveDocumentTasks: [],
    openExceptionTasks: [],
    pendingVouchers: [],
    unresolved: [workspace.transactions[1]],
    payrollAccounting: { applicable: false, postedAndMatched: false },
    version: null,
  };

  assert.equal(monthlyCloseStageState(workspace, flow).vouchers, false);

  workspace.transactions[1] = { ...workspace.transactions[1], status: "posted", postedVoucherId: "voucher-second" };
  workspace.vouchers.push({ id: "voucher-second", date: "2026-09-02", status: "posted", sourceIds: ["transaction-pending"], lines: [] });
  flow.unresolved = [];
  assert.equal(monthlyCloseStageState(workspace, flow).vouchers, true);

  flow.payrollAccounting = { applicable: true, postedAndMatched: false };
  assert.equal(monthlyCloseStageState(workspace, flow).vouchers, false);
  flow.payrollAccounting.postedAndMatched = true;
  assert.equal(monthlyCloseStageState(workspace, flow).vouchers, true);
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

test("posting a date-only correction keeps the superseded voucher in history and allows the close to continue", async () => {
  let workspace = closeableWorkspace();
  delete workspace.vouchers.find((voucher) => voucher.id === "voucher-0001").period;
  const before = buildReportSnapshot(workspace).summary;
  workspace = createPostedVoucherRevision(workspace, {
    voucherId: "voucher-0001", reason: "更正已入账凭证并保留原记录",
  }, { actor: "测试会计", at: "2026-09-04T08:01:00.000Z" });
  const revision = workspace.vouchers.find((voucher) => voucher.revisionOf === "voucher-0001");
  assert.deepEqual(workflowChecks(workspace).pendingVouchers.map((voucher) => voucher.id), [revision.id]);
  const originalFiles = await withVoucherEvidence(workspace);
  workspace = await postVoucherWithEvidence(originalFiles.workspace, {
    voucherId: revision.id, reviewNote: "已复核更正凭证及来源，原凭证由本次入账替代", mode: "manual",
  }, { actor: "测试会计", at: "2026-09-04T08:02:00.000Z", fileVault: originalFiles.fileVault });
  assert.equal(workspace.vouchers.find((voucher) => voucher.id === "voucher-0001").status, "superseded");
  assert.equal(workspace.vouchers.find((voucher) => voucher.id === revision.id).status, "posted");
  assert.deepEqual(workflowChecks(workspace).pendingVouchers, []);
  assert.equal(buildReportSnapshot(workspace).summary.revenue, before.revenue);
  assert.equal(buildReportSnapshot(workspace).summary.profit, before.profit);
  const archived = archiveWithoutTax(workspace);
  const archive = archived.delivery.archives[0];
  assert.equal(archive.vouchers.find((voucher) => voucher.id === "voucher-0001").status, "superseded");
  assert.equal(archive.vouchers.find((voucher) => voucher.id === revision.id).status, "posted");
  assert.equal(archive.attachmentPackages.some((item) => item.voucherId === "voucher-0001"), true);
  assert.equal(enterNextPeriod(archived, "测试会计").currentPeriod, "2026-09");
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
  assert.equal(flow.checks.find((item) => item.id === "bank").label, "核对银行流水");
});

test("freezing V2 clears effective confirmations and delivery artifacts while preserving V1 history", async () => {
  let v1 = freezeReportVersion(explainVatDifferences(await withPostedPayrollSocialData(closeableWorkspace())), "测试会计");
  v1 = approveInitialConfirmation(v1);
  v1 = prepareFilingDraft(v1, "测试会计");
  v1 = recordFinalConfirmation(v1, finalConfirmationInput(v1), { actor: "测试会计" });
  v1 = recordPackageAndReceipt(v1);
  assert.equal(workflowChecks(v1).archive.every((check) => check.ok), true);
  const v1Confirmations = structuredClone(v1.confirmations);

  const v2 = freezeReportVersion(v1, "测试会计");
  assert.equal(v2.delivery.reportVersions[0].label, "V2");
  assert.equal(v2.tax.financeConfirmedAt, null);
  assert.equal(v2.tax.payrollConfirmedAt, null);
  assert.equal(v2.tax.socialSecurityConfirmedAt, null);
  assert.equal(v2.tax.ownerConfirmedVersionId, null);
  assert.equal(v2.delivery.filing.initialConfirmationId, null);
  assert.equal(v2.delivery.filing.draftVersionId, null);
  assert.equal(v2.delivery.filing.finalConfirmedVersionId, null);
  assert.equal(v2.delivery.filing.exportedPackage, null);
  assert.equal(v2.delivery.filing.receipt, null);
  assert.deepEqual(v2.confirmations, v1Confirmations);
  assert.equal(workflowChecks(v2).checks.find((check) => check.id === "finance").ok, false);
  assert.equal(workflowChecks(v2).checks.find((check) => check.id === "owner").ok, false);
  assert.throws(() => prepareFilingDraft(v2, "测试会计"), /完成首次确认/);
});

test("the full frozen-version confirmation, package, receipt, archive and next-period chain remains bound", async () => {
  let workspace = explainVatDifferences(await withPostedPayrollSocialData(closeableWorkspace()));
  workspace = freezeAccountingReportVersion(
    workspace,
    { period: workspace.currentPeriod, label: "月度财务报表" },
    { actor: "测试会计", at: "2026-09-04T08:01:00.000Z" },
  );
  workspace = freezeReportVersion(workspace, "测试会计");
  const versionId = workflowChecks(workspace).version.id;
  workspace = approveInitialConfirmation(workspace);
  workspace = prepareFilingDraft(workspace, "测试会计");
  workspace = recordFinalConfirmation(workspace, finalConfirmationInput(workspace), { actor: "测试会计", at: "2026-09-04T08:13:00.000Z" });
  workspace = recordPackageAndReceipt(workspace);
  assert.equal(workflowChecks(workspace).archive.every((check) => check.ok), true);
  assert.equal(workflowChecks(workspace).checks.find((check) => check.id === "bank").label, "本期银行流水余额勾稽通过");

  const fingerprint = workflowSourceFingerprint(workspace);
  const archived = archivePeriod(workspace, "测试会计");
  assert.equal(archived.delivery.archives[0].sourceFingerprint, fingerprint);
  assert.equal(archived.documents.find((document) => document.id === "receipt-document-test").archiveStatus, "archived");

  const archivedPeriodExport = buildArchivedPeriodExport(
    archived,
    archived.delivery.archives[0].id,
    "2026-09-04T08:16:00.000Z",
  );
  assert.equal(archivedPeriodExport.localOnly, true);
  assert.equal(archivedPeriodExport.indexedDbFilesIncluded, false);
  assert.equal(archivedPeriodExport.workspace.id, archived.id);
  assert.equal(archivedPeriodExport.archive.reportVersionId, versionId);
  assert.equal(archivedPeriodExport.exportedAt, "2026-09-04T08:16:00.000Z");
  archivedPeriodExport.archive.summary.profit = 999999;
  assert.notEqual(archived.delivery.archives[0].summary.profit, 999999);
  assert.throws(() => buildArchivedPeriodExport(archived, "missing-archive"), /归档记录不存在/);

  const { store } = integratedStore(archived);
  assert.throws(() => store.actions.replaceWorkspace(archived.id, { ...store.getActiveWorkspace(), tax: { ...archived.tax, payroll: 1 } }), /已经归档/);
  assert.doesNotThrow(() => store.actions.replaceWorkspace(archived.id, store.getActiveWorkspace(), { allowArchivedTransition: true, requiredPermission: "data.read" }));

  const next = enterNextPeriod(archived, "测试会计");
  assert.notEqual(next.currentPeriod, archived.currentPeriod);
  assert.equal(next.tax.payroll, undefined);
  assert.equal(next.tax.socialSecurity, undefined);
  assert.deepEqual(next.tax.sourceIds || [], []);
  assert.deepEqual(next.tax.payrollSourceIds || [], []);
  assert.deepEqual(next.tax.socialSecuritySourceIds || [], []);
  assert.equal(buildPayrollSocialSummary(next).payrollRecords.length, 0);
  assert.equal(buildPayrollSocialSummary(next).socialSecurityRecords.length, 0);
});
