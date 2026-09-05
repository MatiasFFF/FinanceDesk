import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMISSION_RULE_BASES,
  COMMISSION_RULE_METHODS,
  MEMBERSHIP_PACKAGE_DISCOUNT_TYPES,
  addMember,
  addMemberBusinessEvent,
  buildCommissionRuleCalculation,
  buildMemberLedger,
  buildMemberPackageBalances,
  buildMemberServiceReconciliation,
  buildRechargeRefundOptions,
  confirmCommissionAccrual,
  saveCommissionRule,
  saveMembershipPackage,
  updateMemberBusinessEventStatus,
} from "../src/features/members/memberLedger.js";
import {
  buildFinancialStatements,
  buildStoreManagementReport,
  createMemberEventVoucherDraft,
  createPostedVoucherRevision,
  freezeReportVersion,
  postVoucher,
  reviseDraftVoucher,
  validateVoucherBalance,
} from "../src/domain/accounting/index.js";

const context = { actor: "测试会计", at: "2026-09-04T08:00:00.000Z" };

function baseWorkspace() {
  return { members: [], membershipPackages: [], businessEvents: [] };
}

function addEvent(workspace, id, kind, values = {}) {
  let current = workspace;
  let packageId = values.packageId;
  if (kind === "recharge" && !packageId) {
    packageId = `package-${id}`;
    current = saveMembershipPackage(current, {
      name: `测试套餐 ${id}`,
      listPrice: values.amount,
      totalSessions: values.quantity,
      validityDays: values.validityDays || 365,
      discountType: MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.NONE,
    }, { ...context, packageId });
  }
  const packageRechargeId = values.packageRechargeId || (kind === "consumption"
    ? [...(current.businessEvents || [])].reverse().find((event) => (
      event.memberId === values.memberId && event.kind === "recharge" && event.status === "confirmed"
    ))?.id
    : null);
  return addMemberBusinessEvent(current, {
    id,
    kind,
    memberId: values.memberId,
    packageId,
    packageRechargeId,
    date: values.date || "2026-09-04",
    amount: values.amount,
    quantity: values.quantity,
    coach: values.coach,
    storeId: values.storeId,
    department: values.department,
    project: values.project,
    originalRechargeId: values.originalRechargeId,
    note: values.note || "",
  }, context);
}

test("会员充值、耗课、退款与教练提成会更新台账并形成会计事件", () => {
  let workspace = addMember(baseWorkspace(), { id: "member-1", name: "李女士", coach: "陈教练" }, context);

  workspace = addEvent(workspace, "event-recharge", "recharge", { memberId: "member-1", amount: 2400, quantity: 10 });
  assert.equal(buildMemberLedger(workspace).members[0].remainingSessions, 0);
  workspace = updateMemberBusinessEventStatus(workspace, "event-recharge", "confirmed", context);

  workspace = addEvent(workspace, "event-consumption", "consumption", { memberId: "member-1", amount: 480, quantity: 2 });
  workspace = updateMemberBusinessEventStatus(workspace, "event-consumption", "confirmed", context);

  workspace = addEvent(workspace, "event-refund", "refund", { memberId: "member-1", originalRechargeId: "event-recharge", amount: 240, quantity: 1 });
  workspace = updateMemberBusinessEventStatus(workspace, "event-refund", "completed", context);

  workspace = addEvent(workspace, "event-commission", "commission", { amount: 300, quantity: 2, coach: "陈教练" });
  workspace = updateMemberBusinessEventStatus(workspace, "event-commission", "accrued", context);

  let ledger = buildMemberLedger(workspace);
  assert.equal(ledger.members[0].remainingSessions, 7);
  assert.equal(ledger.members[0].unfulfilledBalance, 1680);
  assert.equal(ledger.members[0].recognizedRevenue, 480);
  assert.equal(ledger.members[0].refunded, 240);
  assert.equal(ledger.totals.commissionPayable, 300);
  assert.equal(workspace.businessEvents.find((item) => item.id === "event-recharge").type, "memberRecharge");
  assert.equal(workspace.businessEvents.find((item) => item.id === "event-consumption").accountingStatus, "ready");
  assert.equal(workspace.businessEvents.find((item) => item.id === "event-commission").account, "expenseCommission");

  assert.throws(
    () => updateMemberBusinessEventStatus(workspace, "event-commission", "paid", context),
    /计提凭证必须先入账/,
  );
});

test("退款必须关联原充值，并按耗课与既往退款阻止超退", () => {
  let workspace = addMember(baseWorkspace(), { id: "member-1", name: "周女士" }, context);
  workspace = addEvent(workspace, "recharge-1", "recharge", { memberId: "member-1", date: "2026-09-01", amount: 1000, quantity: 10 });
  workspace = updateMemberBusinessEventStatus(workspace, "recharge-1", "confirmed", context);
  workspace = addEvent(workspace, "recharge-2", "recharge", { memberId: "member-1", date: "2026-09-02", amount: 600, quantity: 6 });
  workspace = updateMemberBusinessEventStatus(workspace, "recharge-2", "confirmed", context);
  workspace = addEvent(workspace, "consumption-1", "consumption", { memberId: "member-1", packageRechargeId: "recharge-1", date: "2026-09-03", amount: 800, quantity: 8 });
  workspace = updateMemberBusinessEventStatus(workspace, "consumption-1", "confirmed", context);

  const options = buildRechargeRefundOptions(workspace, "member-1");
  assert.deepEqual(options.map((option) => [option.rechargeId, option.refundableAmount, option.refundableSessions]), [
    ["recharge-1", 200, 2],
    ["recharge-2", 600, 6],
  ]);
  assert.throws(
    () => addEvent(workspace, "refund-unlinked", "refund", { memberId: "member-1", amount: 100, quantity: 1 }),
    /请选择本次退款对应的原充值/,
  );
  assert.throws(
    () => addEvent(workspace, "refund-over-amount", "refund", { memberId: "member-1", originalRechargeId: "recharge-1", amount: 201, quantity: 2 }),
    /退款金额超过.*200\.00/,
  );

  workspace = addEvent(workspace, "refund-1", "refund", { memberId: "member-1", originalRechargeId: "recharge-1", amount: 200, quantity: 2 });
  assert.equal(workspace.businessEvents.find((event) => event.id === "refund-1").originalRechargeId, "recharge-1");
  assert.throws(
    () => addEvent(workspace, "refund-over-reserved", "refund", { memberId: "member-1", originalRechargeId: "recharge-1", amount: 1, quantity: 1 }),
    /退款金额超过.*0\.00/,
  );
  workspace = updateMemberBusinessEventStatus(workspace, "refund-1", "completed", context);
  assert.equal(buildMemberLedger(workspace).members[0].unfulfilledBalance, 600);
});

test("会员套餐保存价格快照，耗课按指定有效套餐扣减并阻止过期或不足", () => {
  let workspace = { ...baseWorkspace(), currentPeriod: "2026-09" };
  workspace = saveMembershipPackage(workspace, {
    name: "私教 10 节包",
    listPrice: 2000,
    totalSessions: 10,
    validityDays: 30,
    discountType: MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.PERCENTAGE,
    discountValue: 10,
  }, { ...context, packageId: "package-private-10" });
  assert.equal(workspace.membershipPackages[0].salePrice, 1800);
  workspace = addMember(workspace, { id: "member-1", name: "李女士", coach: "陈教练" }, context);

  assert.throws(
    () => addMemberBusinessEvent(workspace, {
      id: "recharge-without-package",
      kind: "recharge",
      memberId: "member-1",
      date: "2026-09-01",
    }, context),
    /请选择会员充值套餐/,
  );
  workspace = addMemberBusinessEvent(workspace, {
    id: "package-recharge",
    kind: "recharge",
    memberId: "member-1",
    packageId: "package-private-10",
    date: "2026-09-01",
    amount: 9999,
    quantity: 99,
  }, context);
  let recharge = workspace.businessEvents.find((event) => event.id === "package-recharge");
  assert.equal(recharge.amount, 1800);
  assert.equal(recharge.quantity, 10);
  assert.equal(recharge.packageExpiresAt, "2026-10-01");
  assert.equal(recharge.packageSnapshot.salePrice, 1800);
  workspace = updateMemberBusinessEventStatus(workspace, "package-recharge", "confirmed", context);

  workspace = saveMembershipPackage(workspace, {
    ...workspace.membershipPackages[0],
    listPrice: 2200,
    discountValue: 10,
  }, context);
  recharge = workspace.businessEvents.find((event) => event.id === "package-recharge");
  assert.equal(workspace.membershipPackages[0].salePrice, 1980);
  assert.equal(recharge.packageSnapshot.salePrice, 1800);

  assert.throws(
    () => addMemberBusinessEvent(workspace, {
      id: "consumption-before-purchase",
      kind: "consumption",
      memberId: "member-1",
      packageRechargeId: "package-recharge",
      date: "2026-08-31",
      quantity: 1,
    }, context),
    /不存在、尚未确认或不属于当前会员/,
  );

  assert.throws(
    () => addMemberBusinessEvent(workspace, {
      id: "consumption-without-package",
      kind: "consumption",
      memberId: "member-1",
      date: "2026-09-10",
      quantity: 1,
    }, context),
    /请选择本次耗课使用的有效套餐/,
  );
  workspace = addMemberBusinessEvent(workspace, {
    id: "package-consumption-1",
    kind: "consumption",
    memberId: "member-1",
    packageRechargeId: "package-recharge",
    date: "2026-09-10",
    quantity: 3,
  }, context);
  workspace = updateMemberBusinessEventStatus(workspace, "package-consumption-1", "confirmed", context);
  let balances = buildMemberPackageBalances(workspace, "member-1", { asOfDate: "2026-09-10" });
  assert.deepEqual({
    originalSessions: balances[0].originalSessions,
    consumedSessions: balances[0].consumedSessions,
    remainingSessions: balances[0].remainingSessions,
    expiresAt: balances[0].expiresAt,
    unfulfilledBalance: balances[0].unfulfilledBalance,
  }, {
    originalSessions: 10,
    consumedSessions: 3,
    remainingSessions: 7,
    expiresAt: "2026-10-01",
    unfulfilledBalance: 1260,
  });
  assert.equal(workspace.businessEvents.find((event) => event.id === "package-consumption-1").amount, 540);

  workspace = addMemberBusinessEvent(workspace, {
    id: "package-consumption-2",
    kind: "consumption",
    memberId: "member-1",
    packageRechargeId: "package-recharge",
    date: "2026-09-11",
    quantity: 5,
  }, context);
  workspace = addMemberBusinessEvent(workspace, {
    id: "package-consumption-over",
    kind: "consumption",
    memberId: "member-1",
    packageRechargeId: "package-recharge",
    date: "2026-09-12",
    quantity: 3,
  }, context);
  workspace = updateMemberBusinessEventStatus(workspace, "package-consumption-2", "confirmed", context);
  assert.throws(
    () => updateMemberBusinessEventStatus(workspace, "package-consumption-over", "confirmed", context),
    /剩余 2 节.*课时不足/,
  );
  assert.throws(
    () => addMemberBusinessEvent(workspace, {
      id: "package-consumption-expired",
      kind: "consumption",
      memberId: "member-1",
      packageRechargeId: "package-recharge",
      date: "2026-10-02",
      quantity: 1,
    }, context),
    /已于 2026-10-01 到期/,
  );
});

test("不能确认超过会员剩余课时或未履约余额的业务", () => {
  let workspace = addMember(baseWorkspace(), { id: "member-1", name: "王先生" }, context);
  workspace = addEvent(workspace, "event-recharge", "recharge", { memberId: "member-1", amount: 1000, quantity: 5 });
  workspace = updateMemberBusinessEventStatus(workspace, "event-recharge", "confirmed", context);
  workspace = addEvent(workspace, "event-consumption", "consumption", { memberId: "member-1", amount: 1200, quantity: 6 });

  assert.throws(
    () => updateMemberBusinessEventStatus(workspace, "event-consumption", "confirmed", context),
    /课时不足/,
  );
});

test("三种教练提成口径会保存规则、展示明细并阻止来源重复计提", () => {
  let workspace = {
    ...baseWorkspace(),
    currentPeriod: "2026-09",
    bills: [
      { id: "collection-bill-500", kind: "receivable", counterparty: "李女士", amount: 500, status: "active" },
      { id: "collection-bill-200", kind: "receivable", counterparty: "李女士", amount: 200, status: "active" },
    ],
    transactions: [
      { id: "txn-linked", date: "2026-09-06", amount: 500, memberId: "member-1", status: "reconciled", allocations: [{ id: "collection-allocation-500", transactionId: "txn-linked", billId: "collection-bill-500", amount: 500, status: "confirmed" }] },
      { id: "txn-name", date: "2026-09-07", amount: 200, counterparty: "会员李女士", status: "reconciled", allocations: [{ id: "collection-allocation-200", transactionId: "txn-name", billId: "collection-bill-200", amount: 200, status: "confirmed" }] },
      { id: "txn-ignored", date: "2026-09-08", amount: 300, memberId: "member-1", status: "ignored" },
      { id: "txn-unattributed", date: "2026-09-09", amount: 900, counterparty: "聚合收款", status: "reconciled" },
    ],
  };
  workspace = addMember(workspace, { id: "member-1", name: "李女士", coach: "陈教练" }, context);
  workspace = addEvent(workspace, "recharge-source", "recharge", { memberId: "member-1", date: "2026-09-01", amount: 1000, quantity: 10 });
  workspace = updateMemberBusinessEventStatus(workspace, "recharge-source", "confirmed", context);
  workspace = addEvent(workspace, "consumption-source", "consumption", { memberId: "member-1", date: "2026-09-05", amount: 200, quantity: 2 });
  workspace = updateMemberBusinessEventStatus(workspace, "consumption-source", "confirmed", context);

  workspace = saveCommissionRule(workspace, {
    coach: "陈教练",
    basis: COMMISSION_RULE_BASES.SALES_RECHARGE,
    method: COMMISSION_RULE_METHODS.PERCENTAGE,
    rate: 10,
  }, { ...context, ruleId: "rule-sales" });
  workspace = saveCommissionRule(workspace, {
    coach: "陈教练",
    basis: COMMISSION_RULE_BASES.ACTUAL_COLLECTION,
    method: COMMISSION_RULE_METHODS.FIXED,
    fixedAmount: 50,
  }, { ...context, ruleId: "rule-collection" });
  workspace = saveCommissionRule(workspace, {
    coach: "陈教练",
    basis: COMMISSION_RULE_BASES.MEMBER_CONSUMPTION,
    method: COMMISSION_RULE_METHODS.FIXED,
    fixedAmount: 30,
  }, { ...context, ruleId: "rule-consumption" });

  const sales = buildCommissionRuleCalculation(workspace, "rule-sales");
  const collections = buildCommissionRuleCalculation(workspace, "rule-collection");
  const consumptions = buildCommissionRuleCalculation(workspace, "rule-consumption");
  assert.deepEqual([sales.sourceCount, sales.baseAmount, sales.commissionAmount], [1, 1000, 100]);
  assert.deepEqual([collections.sourceCount, collections.baseAmount, collections.commissionAmount], [2, 700, 100]);
  assert.deepEqual([consumptions.sourceCount, consumptions.units, consumptions.commissionAmount], [1, 2, 60]);
  assert.equal(workspace.commissionRules.length, 3);
  assert.throws(
    () => saveCommissionRule(workspace, {
      coach: "陈教练",
      basis: COMMISSION_RULE_BASES.SALES_RECHARGE,
      method: COMMISSION_RULE_METHODS.PERCENTAGE,
      rate: 12,
    }, context),
    /已有“销售充值”规则/,
  );

  workspace = confirmCommissionAccrual(workspace, {
    ruleId: "rule-sales",
    period: "2026-09",
  }, { ...context, eventId: "commission-sales" });
  const accrual = workspace.businessEvents.find((event) => event.id === "commission-sales");
  assert.equal(accrual.amount, 100);
  assert.equal(accrual.accountingStatus, "ready");
  assert.deepEqual(accrual.commissionSourceIds, ["recharge-source"]);
  assert.equal(accrual.commissionCalculationLines[0].commissionAmount, 100);
  const afterAccrual = buildCommissionRuleCalculation(workspace, "rule-sales");
  assert.equal(afterAccrual.sourceCount, 0);
  assert.equal(afterAccrual.alreadyAccruedSourceCount, 1);
  assert.equal(afterAccrual.accruedAmount, 100);
  assert.throws(
    () => confirmCommissionAccrual(workspace, {
      ruleId: "rule-sales",
      period: "2026-09",
      sourceIds: ["recharge-source"],
    }, context),
    /已经计提，不能重复计提/,
  );
});

test("同一教练跨门店的规则提成会按业务维度拆分保存", () => {
  let workspace = {
    ...baseWorkspace(),
    currentPeriod: "2026-09",
    stores: [
      { id: "store-east", name: "东馆", status: "active" },
      { id: "store-west", name: "西馆", status: "active" },
    ],
  };
  workspace = addMember(workspace, { id: "member-east", name: "李女士", storeId: "store-east", coach: "陈教练", department: "私教部", project: "塑形课" }, context);
  workspace = addMember(workspace, { id: "member-west", name: "王先生", storeId: "store-west", coach: "陈教练", department: "私教部", project: "康复课" }, context);
  workspace = addEvent(workspace, "source-east", "recharge", { memberId: "member-east", date: "2026-09-01", amount: 1000, quantity: 10 });
  workspace = updateMemberBusinessEventStatus(workspace, "source-east", "confirmed", context);
  workspace = addEvent(workspace, "source-west", "recharge", { memberId: "member-west", date: "2026-09-02", amount: 600, quantity: 6 });
  workspace = updateMemberBusinessEventStatus(workspace, "source-west", "confirmed", context);
  workspace = saveCommissionRule(workspace, {
    coach: "陈教练",
    basis: COMMISSION_RULE_BASES.SALES_RECHARGE,
    method: COMMISSION_RULE_METHODS.PERCENTAGE,
    rate: 10,
  }, { ...context, ruleId: "rule-cross-store" });
  workspace = confirmCommissionAccrual(workspace, {
    ruleId: "rule-cross-store",
    period: "2026-09",
  }, { ...context, eventId: "commission-cross-store" });

  const accruals = workspace.businessEvents
    .filter((event) => event.commissionRuleId === "rule-cross-store")
    .sort((left, right) => left.storeId.localeCompare(right.storeId));
  assert.equal(accruals.length, 2);
  assert.deepEqual(accruals.map((event) => ({
    storeId: event.storeId,
    storeName: event.storeName,
    project: event.project,
    amount: event.amount,
    sourceIds: event.commissionSourceIds,
  })), [
    { storeId: "store-east", storeName: "东馆", project: "塑形课", amount: 100, sourceIds: ["source-east"] },
    { storeId: "store-west", storeName: "西馆", project: "康复课", amount: 60, sourceIds: ["source-west"] },
  ]);
});

test("会员未履约余额与合同负债自动勾稽，差额只能随入账凭证修复", () => {
  let workspace = {
    ...baseWorkspace(),
    id: "workspace-member-reconciliation",
    currentPeriod: "2026-09",
    accounts: [{ id: "bank:operating", name: "经营账户" }],
    bankAccounts: [{ id: "bank:operating", name: "经营账户" }],
    vouchers: [],
    bills: [],
    documents: [],
    openingLedger: {},
    auditLog: [],
    exceptionTasks: [],
  };
  workspace = addMember(workspace, { id: "member-1", name: "李女士", coach: "陈教练" }, context);
  workspace = addEvent(workspace, "event-recharge", "recharge", {
    memberId: "member-1",
    amount: 1000,
    quantity: 10,
  });
  workspace = updateMemberBusinessEventStatus(workspace, "event-recharge", "confirmed", context);

  let reconciliation = buildMemberServiceReconciliation(workspace, { period: "2026-09" });
  assert.deepEqual({
    recharged: reconciliation.members[0].recharged,
    recognizedRevenue: reconciliation.members[0].recognizedRevenue,
    refunded: reconciliation.members[0].refunded,
    remainingSessions: reconciliation.members[0].remainingSessions,
    unfulfilledBalance: reconciliation.members[0].unfulfilledBalance,
  }, {
    recharged: 1000,
    recognizedRevenue: 0,
    refunded: 0,
    remainingSessions: 10,
    unfulfilledBalance: 1000,
  });
  assert.equal(reconciliation.contractLiabilityBalance, 0);
  assert.equal(reconciliation.difference, 1000);
  assert.equal(reconciliation.passed, false);
  let exception = workspace.exceptionTasks.find((task) => task.code === "member_service_reconciliation");
  assert.equal(exception.status, "open");
  assert.equal(exception.autoManaged, true);
  assert.equal(exception.manualResolutionAllowed, false);

  workspace = createMemberEventVoucherDraft(workspace, { eventId: "event-recharge" }, context);
  let voucher = workspace.vouchers.at(-1);
  workspace = reviseDraftVoucher(workspace, {
    voucherId: voucher.id,
    reason: "模拟金额录入错误",
    lines: [
      { account: "bank:operating", debit: 900, credit: 0, sourceIds: ["event-recharge"] },
      { account: "contractLiability", debit: 0, credit: 900, sourceIds: ["event-recharge"] },
    ],
  }, context);
  workspace = postVoucher(workspace, {
    voucherId: voucher.id,
    mode: "manual",
    reviewNote: "测试错误金额入账后的自动勾稽",
  }, context);
  reconciliation = buildMemberServiceReconciliation(workspace, { period: "2026-09" });
  assert.equal(reconciliation.difference, 100);
  assert.equal(reconciliation.accountingSources[0].balanceEffect, 900);
  exception = workspace.exceptionTasks.find((task) => task.code === "member_service_reconciliation");
  assert.equal(exception.status, "open");
  assert.equal(exception.difference, 100);

  workspace = {
    ...workspace,
    exceptionTasks: workspace.exceptionTasks.map((task) => task.id === exception.id ? { ...task, status: "resolved" } : task),
  };
  const manuallyResolvedStatements = buildFinancialStatements(workspace, { period: "2026-09" });
  assert.equal(manuallyResolvedStatements.checks.memberService.passed, false);
  assert.throws(
    () => freezeReportVersion(workspace, { period: "2026-09" }, context),
    /报表勾稽未通过/,
  );

  workspace = createPostedVoucherRevision(workspace, {
    voucherId: voucher.id,
    reason: "把会员充值恢复为实际 1000 元",
  }, context);
  voucher = workspace.vouchers.find((item) => item.revisionOf === voucher.id);
  workspace = reviseDraftVoucher(workspace, {
    voucherId: voucher.id,
    reason: "修正合同负债与银行存款金额",
    lines: [
      { account: "bank:operating", debit: 1000, credit: 0, sourceIds: ["event-recharge"] },
      { account: "contractLiability", debit: 0, credit: 1000, sourceIds: ["event-recharge"] },
    ],
  }, context);
  workspace = postVoucher(workspace, {
    voucherId: voucher.id,
    mode: "manual",
    reviewNote: "已核对会员充值和合同负债余额",
  }, context);
  reconciliation = buildMemberServiceReconciliation(workspace, { period: "2026-09" });
  assert.equal(reconciliation.passed, true);
  assert.equal(reconciliation.difference, 0);
  exception = workspace.exceptionTasks.find((task) => task.code === "member_service_reconciliation");
  assert.equal(exception.status, "resolved");
  assert.equal(buildFinancialStatements(workspace, { period: "2026-09" }).checks.memberService.passed, true);
  workspace = freezeReportVersion(workspace, { period: "2026-09" }, context);
  assert.equal(workspace.reportVersions.at(-1).statements.memberServiceReconciliation.passed, true);
});

test("会员业务及提成付款可以生成平衡凭证、复核入账并进入财务报表", () => {
  let workspace = {
    ...baseWorkspace(),
    id: "workspace-member-flow",
    currentPeriod: "2026-09",
    accounts: [{ id: "bank:operating", name: "经营账户" }],
    bankAccounts: [{ id: "bank:operating", name: "经营账户" }],
    vouchers: [],
    bills: [],
    documents: [],
    openingLedger: {},
    auditLog: [],
  };
  workspace = addMember(workspace, { id: "member-1", name: "李女士", coach: "陈教练" }, context);
  workspace = addEvent(workspace, "event-recharge", "recharge", { memberId: "member-1", date: "2026-09-04", amount: 2400, quantity: 10 });
  workspace = updateMemberBusinessEventStatus(workspace, "event-recharge", "confirmed", context);
  workspace = addEvent(workspace, "event-consumption", "consumption", { memberId: "member-1", date: "2026-09-05", amount: 480, quantity: 2 });
  workspace = updateMemberBusinessEventStatus(workspace, "event-consumption", "confirmed", context);
  workspace = addEvent(workspace, "event-refund", "refund", { memberId: "member-1", originalRechargeId: "event-recharge", date: "2026-09-06", amount: 240, quantity: 1 });
  workspace = updateMemberBusinessEventStatus(workspace, "event-refund", "completed", context);
  workspace = saveCommissionRule(workspace, {
    coach: "陈教练",
    basis: COMMISSION_RULE_BASES.MEMBER_CONSUMPTION,
    method: COMMISSION_RULE_METHODS.FIXED,
    fixedAmount: 150,
  }, { ...context, ruleId: "rule-consumption" });
  workspace = confirmCommissionAccrual(workspace, {
    ruleId: "rule-consumption",
    period: "2026-09",
  }, { ...context, date: "2026-09-07", eventId: "event-commission" });

  for (const eventId of ["event-recharge", "event-consumption", "event-refund", "event-commission"]) {
    workspace = createMemberEventVoucherDraft(workspace, { eventId }, context);
    const voucher = workspace.vouchers.at(-1);
    assert.equal(validateVoucherBalance(voucher).balanced, true);
    assert.ok(voucher.sourceIds.includes(eventId));
    workspace = postVoucher(workspace, {
      voucherId: voucher.id,
      mode: "manual",
      reviewNote: "已核对会员台账、金额和会计科目",
    }, context);
  }

  workspace = updateMemberBusinessEventStatus(workspace, "event-commission", "paid", {
    ...context,
    at: "2026-09-08T08:00:00.000Z",
    paymentDate: "2026-09-08",
    paymentEventId: "event-commission-payment",
  });
  const paymentEvent = workspace.businessEvents.find((event) => event.id === "event-commission-payment");
  assert.equal(paymentEvent.commissionEventId, "event-commission");
  assert.equal(paymentEvent.accountingStatus, "ready");
  workspace = createMemberEventVoucherDraft(workspace, { eventId: paymentEvent.id }, context);
  const paymentVoucher = workspace.vouchers.at(-1);
  assert.deepEqual(paymentVoucher.lines.map((line) => [line.account, line.debit, line.credit]), [
    ["payrollPayable", 300, 0],
    ["bank:operating", 0, 300],
  ]);
  workspace = postVoucher(workspace, {
    voucherId: paymentVoucher.id,
    mode: "manual",
    reviewNote: "已核对教练提成付款和银行账户",
  }, context);

  assert.equal(workspace.vouchers.length, 5);
  assert.equal(workspace.businessEvents.every((event) => event.accountingStatus === "posted"), true);
  assert.throws(
    () => updateMemberBusinessEventStatus(workspace, "event-refund", "void", context),
    /已生成会计凭证/,
  );

  const statements = buildFinancialStatements(workspace, { period: "2026-09" });
  assert.equal(statements.incomeStatement.netRevenue.value, 480);
  assert.equal(statements.incomeStatement.expenses.value, 300);
  assert.equal(statements.incomeStatement.profit.value, 180);
  assert.equal(statements.cashFlow.netChange.value, 1860);
  assert.equal(statements.balanceSheet.liabilities.value, 1680);
  assert.equal(statements.ledger.accounts.find((account) => account.accountId === "payrollPayable").closing, 0);
  assert.equal(statements.memberServiceReconciliation.memberBalance, 1680);
  assert.equal(statements.memberServiceReconciliation.contractLiabilityBalance, 1680);
  assert.equal(statements.checks.memberService.passed, true);
  assert.equal(workspace.exceptionTasks.find((task) => task.code === "member_service_reconciliation").status, "resolved");
  assert.equal(Object.values(statements.checks).every((check) => check.passed), true);
});

test("会员默认维度会带入业务，业务可单独调整且提成付款保留原维度", () => {
  let workspace = {
    ...baseWorkspace(),
    currentPeriod: "2026-09",
    stores: [
      { id: "store-east", name: "东馆", status: "active" },
      { id: "store-west", name: "西馆", status: "active" },
    ],
    accounts: [{ id: "bank:operating", name: "经营账户" }],
    bankAccounts: [{ id: "bank:operating", name: "经营账户" }],
    vouchers: [],
    bills: [],
    documents: [],
    openingLedger: {},
    auditLog: [],
  };
  workspace = addMember(workspace, {
    id: "member-dimensional",
    name: "林女士",
    storeId: "store-east",
    coach: "陈教练",
    department: "私教部",
    project: "塑形课",
  }, context);
  const member = workspace.members[0];
  assert.deepEqual({
    storeId: member.storeId,
    storeName: member.storeName,
    coach: member.coach,
    department: member.department,
    project: member.project,
  }, {
    storeId: "store-east",
    storeName: "东馆",
    coach: "陈教练",
    department: "私教部",
    project: "塑形课",
  });

  workspace = addEvent(workspace, "dimension-recharge", "recharge", {
    memberId: member.id,
    date: "2026-09-01",
    amount: 1000,
    quantity: 10,
  });
  let event = workspace.businessEvents.find((item) => item.id === "dimension-recharge");
  assert.equal(event.dimensionSource, "member-default");
  assert.deepEqual(event.dimensions, {
    storeId: "store-east",
    storeName: "东馆",
    coach: "陈教练",
    department: "私教部",
    project: "塑形课",
    memberId: member.id,
  });
  assert.ok(event.sourceIds.includes("store-east"));
  workspace = updateMemberBusinessEventStatus(workspace, event.id, "confirmed", context);

  workspace = addEvent(workspace, "dimension-consumption", "consumption", {
    memberId: member.id,
    packageRechargeId: event.id,
    date: "2026-09-02",
    quantity: 1,
    storeId: "store-west",
    coach: "宋教练",
    department: "团课部",
    project: "跨店体验课",
  });
  event = workspace.businessEvents.find((item) => item.id === "dimension-consumption");
  assert.equal(event.dimensionSource, "business-adjustment");
  assert.deepEqual({
    storeId: event.storeId,
    storeName: event.storeName,
    coach: event.coach,
    department: event.department,
    project: event.project,
  }, {
    storeId: "store-west",
    storeName: "西馆",
    coach: "宋教练",
    department: "团课部",
    project: "跨店体验课",
  });

  workspace = addEvent(workspace, "dimension-commission", "commission", {
    date: "2026-09-03",
    amount: 80,
    quantity: 1,
    storeId: "store-west",
    coach: "宋教练",
    department: "团课部",
    project: "跨店体验课",
  });
  workspace = updateMemberBusinessEventStatus(workspace, "dimension-commission", "accrued", context);
  workspace = createMemberEventVoucherDraft(workspace, { eventId: "dimension-commission" }, context);
  workspace = postVoucher(workspace, {
    voucherId: workspace.vouchers.at(-1).id,
    mode: "manual",
    reviewNote: "已核对提成归属维度",
  }, context);
  workspace = updateMemberBusinessEventStatus(workspace, "dimension-commission", "paid", {
    ...context,
    at: "2026-09-04T09:00:00.000Z",
    paymentDate: "2026-09-04",
    paymentEventId: "dimension-commission-payment",
  });
  const payment = workspace.businessEvents.find((item) => item.id === "dimension-commission-payment");
  assert.deepEqual(payment.dimensions, {
    storeId: "store-west",
    storeName: "西馆",
    coach: "宋教练",
    department: "团课部",
    project: "跨店体验课",
    memberId: null,
  });
  assert.deepEqual(payment.dimensionSourceIds, ["store-west"]);
});

test("门店老板报表只汇总已入账业务并可追溯会员、事件和凭证", () => {
  let workspace = {
    ...baseWorkspace(),
    id: "workspace-store-report",
    currentPeriod: "2026-09",
    stores: [
      { id: "store-east", name: "东馆", status: "active" },
      { id: "store-west", name: "西馆", status: "active" },
    ],
    accounts: [{ id: "bank:operating", name: "经营账户" }],
    bankAccounts: [{ id: "bank:operating", name: "经营账户" }],
    vouchers: [],
    bills: [],
    documents: [],
    openingLedger: {},
    auditLog: [],
    exceptionTasks: [],
  };
  workspace = addMember(workspace, { id: "member-east", name: "李女士", storeId: "store-east", coach: "陈教练", department: "私教部", project: "私教课" }, context);
  workspace = addMember(workspace, { id: "member-west", name: "王先生", storeId: "store-west", coach: "宋教练", department: "私教部", project: "康复课" }, context);
  workspace = addEvent(workspace, "east-recharge", "recharge", { memberId: "member-east", date: "2026-09-01", amount: 1000, quantity: 10 });
  workspace = updateMemberBusinessEventStatus(workspace, "east-recharge", "confirmed", context);
  workspace = addEvent(workspace, "east-consumption", "consumption", { memberId: "member-east", packageRechargeId: "east-recharge", date: "2026-09-02", quantity: 2 });
  workspace = updateMemberBusinessEventStatus(workspace, "east-consumption", "confirmed", context);
  workspace = addEvent(workspace, "east-commission", "commission", { date: "2026-09-03", amount: 40, quantity: 2, storeId: "store-east", coach: "陈教练", department: "私教部", project: "私教课" });
  workspace = updateMemberBusinessEventStatus(workspace, "east-commission", "accrued", context);
  workspace = addEvent(workspace, "west-recharge", "recharge", { memberId: "member-west", date: "2026-09-01", amount: 600, quantity: 6 });
  workspace = updateMemberBusinessEventStatus(workspace, "west-recharge", "confirmed", context);
  workspace = addEvent(workspace, "west-refund", "refund", { memberId: "member-west", originalRechargeId: "west-recharge", date: "2026-09-04", amount: 100, quantity: 1 });
  workspace = updateMemberBusinessEventStatus(workspace, "west-refund", "completed", context);
  workspace = addEvent(workspace, "west-unposted", "commission", { date: "2026-09-05", amount: 999, quantity: 1, storeId: "store-west", coach: "宋教练", department: "私教部", project: "康复课" });
  workspace = updateMemberBusinessEventStatus(workspace, "west-unposted", "accrued", context);

  for (const eventId of ["east-recharge", "east-consumption", "east-commission", "west-recharge", "west-refund"]) {
    workspace = createMemberEventVoucherDraft(workspace, { eventId }, context);
    workspace = postVoucher(workspace, {
      voucherId: workspace.vouchers.at(-1).id,
      mode: "manual",
      reviewNote: "已核对门店、会员和业务来源",
    }, context);
  }

  const report = buildStoreManagementReport(workspace, { period: "2026-09", asOf: "2026-09-30" });
  const byStore = Object.fromEntries(report.stores.map((store) => [store.id, store]));
  assert.deepEqual(byStore["store-east"].metrics, {
    collections: 1000,
    recognizedRevenue: 200,
    refunds: 0,
    coachCommission: 40,
    grossProfit: 160,
    unfulfilledBalance: 800,
  });
  assert.deepEqual(byStore["store-west"].metrics, {
    collections: 600,
    recognizedRevenue: 0,
    refunds: 100,
    coachCommission: 0,
    grossProfit: 0,
    unfulfilledBalance: 500,
  });
  assert.equal(report.postingCoverage.unpostedEventCount, 1);
  assert.equal(byStore["store-east"].members[0].name, "李女士");
  const source = byStore["store-east"].sources.find((item) => item.eventId === "east-consumption");
  assert.ok(source.voucherIds.length > 0);
  assert.ok(source.voucherSourceIds.includes("east-consumption"));
  assert.equal(source.storeName, "东馆");
  assert.equal(source.project, "私教课");
  assert.equal(byStore["store-west"].sources.some((item) => item.eventId === "west-unposted"), false);
});
