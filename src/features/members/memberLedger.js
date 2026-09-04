import { createId } from "../../domain/foundation.js";

export const MEMBER_EVENT_KINDS = Object.freeze({
  RECHARGE: "recharge",
  CONSUMPTION: "consumption",
  REFUND: "refund",
  COMMISSION: "commission",
  COMMISSION_PAYMENT: "commissionPayment",
});

export const MEMBER_EVENT_DEFINITIONS = Object.freeze({
  [MEMBER_EVENT_KINDS.RECHARGE]: {
    label: "会员充值",
    accountingEventType: "memberRecharge",
    account: "contractLiability",
    accountingLabel: "会员充值 / 预收",
    suggestedEntry: "借：银行存款 / 贷：合同负债",
  },
  [MEMBER_EVENT_KINDS.CONSUMPTION]: {
    label: "会员耗课",
    accountingEventType: "memberConsumption",
    account: "revenuePrivate",
    accountingLabel: "会员耗课 / 履约确认",
    suggestedEntry: "借：合同负债 / 贷：主营业务收入 · 私教课",
  },
  [MEMBER_EVENT_KINDS.REFUND]: {
    label: "会员退款",
    accountingEventType: "refund",
    account: "contractLiability",
    accountingLabel: "未履约余额退款",
    suggestedEntry: "借：合同负债 / 贷：银行存款",
  },
  [MEMBER_EVENT_KINDS.COMMISSION]: {
    label: "教练提成",
    accountingEventType: "payroll",
    accountingSubtype: "coachCommission",
    account: "expenseCommission",
    accountingLabel: "教练提成计提",
    suggestedEntry: "借：销售费用 · 教练提成 / 贷：应付职工薪酬",
  },
  [MEMBER_EVENT_KINDS.COMMISSION_PAYMENT]: {
    label: "教练提成付款",
    creatable: false,
    accountingEventType: "payroll",
    accountingSubtype: "coachCommissionPayment",
    account: "payrollPayable",
    accountingLabel: "教练提成付款",
    suggestedEntry: "借：应付职工薪酬 / 贷：银行存款",
  },
});

export const COMMISSION_RULE_BASES = Object.freeze({
  SALES_RECHARGE: "salesRecharge",
  ACTUAL_COLLECTION: "actualCollection",
  MEMBER_CONSUMPTION: "memberConsumption",
});

export const COMMISSION_RULE_METHODS = Object.freeze({
  PERCENTAGE: "percentage",
  FIXED: "fixed",
});

export const COMMISSION_RULE_BASE_DEFINITIONS = Object.freeze({
  [COMMISSION_RULE_BASES.SALES_RECHARGE]: {
    label: "销售充值",
    description: "按本期已确认的会员充值计算",
    fixedUnit: "笔",
  },
  [COMMISSION_RULE_BASES.ACTUAL_COLLECTION]: {
    label: "实际收款",
    description: "按本期已入银行流水且可明确归属教练的收款计算",
    fixedUnit: "笔",
  },
  [COMMISSION_RULE_BASES.MEMBER_CONSUMPTION]: {
    label: "会员耗课",
    description: "按本期已确认的会员耗课计算",
    fixedUnit: "节",
  },
});

export const MEMBERSHIP_PACKAGE_DISCOUNT_TYPES = Object.freeze({
  NONE: "none",
  PERCENTAGE: "percentage",
  FIXED: "fixed",
});

export const MEMBERSHIP_PACKAGE_DISCOUNT_DEFINITIONS = Object.freeze({
  [MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.NONE]: { label: "无折扣" },
  [MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.PERCENTAGE]: { label: "按比例减免" },
  [MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.FIXED]: { label: "固定金额减免" },
});

export const MEMBER_STATUS_OPTIONS = Object.freeze([
  { value: "active", label: "在籍" },
  { value: "paused", label: "暂停" },
  { value: "refunding", label: "退款中" },
  { value: "closed", label: "已结束" },
]);

const STATUS_ACTIONS = Object.freeze({
  [MEMBER_EVENT_KINDS.RECHARGE]: {
    pending: [{ status: "confirmed", label: "确认到账" }, { status: "void", label: "作废" }],
    confirmed: [{ status: "void", label: "作废" }],
  },
  [MEMBER_EVENT_KINDS.CONSUMPTION]: {
    pending: [{ status: "confirmed", label: "确认耗课" }, { status: "void", label: "作废" }],
    confirmed: [{ status: "void", label: "作废" }],
  },
  [MEMBER_EVENT_KINDS.REFUND]: {
    pending: [{ status: "completed", label: "确认退款" }, { status: "void", label: "作废" }],
    completed: [{ status: "void", label: "作废" }],
  },
  [MEMBER_EVENT_KINDS.COMMISSION]: {
    pending: [{ status: "accrued", label: "确认计提" }, { status: "void", label: "作废" }],
    accrued: [{ status: "paid", label: "登记付款" }, { status: "void", label: "作废" }],
    paid: [{ status: "void", label: "作废" }],
  },
  [MEMBER_EVENT_KINDS.COMMISSION_PAYMENT]: {},
});

const RECOGNIZED_STATUSES = Object.freeze({
  [MEMBER_EVENT_KINDS.RECHARGE]: new Set(["confirmed", "completed", "posted"]),
  [MEMBER_EVENT_KINDS.CONSUMPTION]: new Set(["confirmed", "completed", "posted"]),
  [MEMBER_EVENT_KINDS.REFUND]: new Set(["confirmed", "completed", "paid", "posted"]),
  [MEMBER_EVENT_KINDS.COMMISSION]: new Set(["confirmed", "accrued", "paid", "posted"]),
  [MEMBER_EVENT_KINDS.COMMISSION_PAYMENT]: new Set(["confirmed", "posted"]),
});

const STATUS_LABELS = Object.freeze({
  pending: "待确认",
  confirmed: "已确认",
  completed: "已退款",
  accrued: "已计提",
  paid: "已支付",
  posted: "已入账",
  void: "已作废",
});

function round(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function timestamp(context = {}) {
  return context.at || new Date().toISOString();
}

function requiredText(value, message) {
  const resolved = String(value || "").trim();
  if (!resolved) throw new Error(message);
  return resolved;
}

function positiveNumber(value, message) {
  const resolved = Number(value);
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(message);
  return round(resolved);
}

function textDimension(values, key, fallback = "") {
  const value = values?.[key];
  return String(value == null ? fallback : value).trim();
}

function businessDimensions(workspace, values = {}, member = null) {
  const defaultStore = (workspace.stores || []).find((store) => store.status !== "inactive") || workspace.stores?.[0];
  const storeId = textDimension(values, "storeId", member?.storeId || defaultStore?.id || "");
  const store = (workspace.stores || []).find((item) => item.id === storeId);
  const storeName = textDimension(values, "storeName", store?.name || member?.storeName || "");
  return {
    storeId,
    storeName,
    coach: textDimension(values, "coach", member?.coach || ""),
    department: textDimension(values, "department", member?.department || ""),
    project: textDimension(values, "project", member?.project || ""),
  };
}

function dimensionSnapshot(dimensions, memberId = null) {
  return {
    ...dimensions,
    memberId,
  };
}

export function memberEventKind(event = {}) {
  if (MEMBER_EVENT_DEFINITIONS[event.kind]) return event.kind;
  if (["recharge", "memberRecharge"].includes(event.type)) return MEMBER_EVENT_KINDS.RECHARGE;
  if (["consume", "consumption", "memberConsumption"].includes(event.type)) return MEMBER_EVENT_KINDS.CONSUMPTION;
  if (event.type === "refund") return MEMBER_EVENT_KINDS.REFUND;
  if (event.accountingSubtype === "coachCommissionPayment") return MEMBER_EVENT_KINDS.COMMISSION_PAYMENT;
  if (["commission", "coachCommission"].includes(event.type) || event.accountingSubtype === "coachCommission") return MEMBER_EVENT_KINDS.COMMISSION;
  return null;
}

export function normalizedMemberStatus(status) {
  const aliases = { "在籍": "active", "暂停": "paused", "退款中": "refunding", "已结束": "closed" };
  const resolved = aliases[status] || status;
  return MEMBER_STATUS_OPTIONS.some((item) => item.value === resolved) ? resolved : "active";
}

export function normalizedEventStatus(event = {}) {
  if (event.status) return event.status;
  const kind = memberEventKind(event);
  if (kind === MEMBER_EVENT_KINDS.REFUND) return "completed";
  if (kind === MEMBER_EVENT_KINDS.COMMISSION) return "accrued";
  return kind ? "confirmed" : "pending";
}

export function memberEventStatusLabel(event = {}) {
  return STATUS_LABELS[normalizedEventStatus(event)] || normalizedEventStatus(event);
}

export function memberEventActions(event = {}) {
  const kind = memberEventKind(event);
  const actions = STATUS_ACTIONS[kind]?.[normalizedEventStatus(event)] || [];
  if (kind === MEMBER_EVENT_KINDS.COMMISSION && event.accountingStatus !== "posted") {
    return actions.filter((action) => action.status !== "paid");
  }
  return actions;
}

export function isRecognizedMemberEvent(event = {}) {
  const kind = memberEventKind(event);
  if (!kind || normalizedEventStatus(event) === "void") return false;
  return RECOGNIZED_STATUSES[kind]?.has(normalizedEventStatus(event)) || false;
}

function eventOrder(left, right) {
  return `${left.date || ""}|${left.createdAt || ""}|${left.id || ""}`
    .localeCompare(`${right.date || ""}|${right.createdAt || ""}|${right.id || ""}`);
}

function allocateAcrossRechargeLots(lots, amount, quantity, fields) {
  let remainingAmount = Number(amount || 0);
  let remainingSessions = Number(quantity || 0);
  lots.forEach((lot) => {
    if (remainingAmount > 0) {
      const allocatedAmount = Math.min(lot.refundableAmount, remainingAmount);
      lot.refundableAmount = round(lot.refundableAmount - allocatedAmount);
      lot[fields.amount] = round(lot[fields.amount] + allocatedAmount);
      remainingAmount = round(remainingAmount - allocatedAmount);
    }
    if (remainingSessions > 0) {
      const allocatedSessions = Math.min(lot.refundableSessions, remainingSessions);
      lot.refundableSessions = round(lot.refundableSessions - allocatedSessions);
      lot[fields.sessions] = round(lot[fields.sessions] + allocatedSessions);
      remainingSessions = round(remainingSessions - allocatedSessions);
    }
  });
}

export function buildRechargeRefundOptions(workspace = {}, memberId, { excludeRefundId = null } = {}) {
  const memberEvents = (workspace.businessEvents || []).filter((event) => event.memberId === memberId);
  const lots = memberEvents
    .filter((event) => memberEventKind(event) === MEMBER_EVENT_KINDS.RECHARGE && isRecognizedMemberEvent(event))
    .sort(eventOrder)
    .map((event) => ({
      rechargeId: event.id,
      event,
      date: event.date,
      amount: round(event.amount),
      sessions: round(event.quantity),
      consumedAmount: 0,
      consumedSessions: 0,
      refundedAmount: 0,
      refundedSessions: 0,
      refundableAmount: round(event.amount),
      refundableSessions: round(event.quantity),
    }));

  memberEvents
    .filter((event) => memberEventKind(event) === MEMBER_EVENT_KINDS.CONSUMPTION && isRecognizedMemberEvent(event))
    .sort(eventOrder)
    .forEach((event) => allocateAcrossRechargeLots(lots, event.amount, event.quantity, {
      amount: "consumedAmount",
      sessions: "consumedSessions",
    }));

  memberEvents
    .filter((event) => (
      event.id !== excludeRefundId
      && memberEventKind(event) === MEMBER_EVENT_KINDS.REFUND
      && normalizedEventStatus(event) !== "void"
    ))
    .sort(eventOrder)
    .forEach((event) => {
      const linkedLot = lots.find((lot) => lot.rechargeId === event.originalRechargeId);
      allocateAcrossRechargeLots(linkedLot ? [linkedLot] : lots, event.amount, event.quantity, {
        amount: "refundedAmount",
        sessions: "refundedSessions",
      });
    });

  return lots.map((lot) => ({
    ...lot,
    refundableAmount: Math.max(0, round(lot.refundableAmount)),
    refundableSessions: Math.max(0, round(lot.refundableSessions)),
  }));
}

function assertRefundWithinOriginalRecharge(workspace, event, { excludeRefundId = null } = {}) {
  const originalRechargeId = requiredText(event.originalRechargeId, "请选择本次退款对应的原充值");
  const originalRecharge = (workspace.businessEvents || []).find((item) => item.id === originalRechargeId);
  if (
    !originalRecharge
    || memberEventKind(originalRecharge) !== MEMBER_EVENT_KINDS.RECHARGE
    || originalRecharge.memberId !== event.memberId
    || !isRecognizedMemberEvent(originalRecharge)
  ) {
    throw new Error("所选原充值尚未确认，或不属于当前会员");
  }
  const available = buildRechargeRefundOptions(workspace, event.memberId, { excludeRefundId })
    .find((option) => option.rechargeId === originalRechargeId);
  if (!available) throw new Error("找不到可退款的原充值");
  if (Number(event.amount || 0) > available.refundableAmount + 0.001) {
    throw new Error(`本次退款金额超过所选原充值的可退余额 ${available.refundableAmount.toFixed(2)} 元`);
  }
  if (Number(event.quantity || 0) > available.refundableSessions + 0.001) {
    throw new Error(`本次退款课时超过所选原充值的可退课时 ${available.refundableSessions} 节`);
  }
  return originalRechargeId;
}

export function membershipPackagePrice(packageRule = {}) {
  const listPrice = round(packageRule.listPrice ?? packageRule.price);
  if (packageRule.discountType === MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.PERCENTAGE) {
    return round(listPrice * (1 - Number(packageRule.discountValue || 0) / 100));
  }
  if (packageRule.discountType === MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.FIXED) {
    return round(listPrice - Number(packageRule.discountValue || 0));
  }
  return listPrice;
}

function packageExpirationDate(startDate, validityDays) {
  const time = Date.parse(String(startDate) + "T00:00:00Z");
  if (!Number.isFinite(time)) throw new Error("套餐充值日期无效");
  return new Date(time + Number(validityDays) * 86_400_000).toISOString().slice(0, 10);
}

export function saveMembershipPackage(workspace, values, context = {}) {
  const at = timestamp(context);
  const name = requiredText(values.name, "请填写套餐名称");
  const listPrice = positiveNumber(values.listPrice ?? values.price, "套餐售价必须大于 0");
  const totalSessions = positiveNumber(values.totalSessions, "套餐总课时必须大于 0");
  const validityDays = Math.round(positiveNumber(values.validityDays, "套餐有效期必须大于 0"));
  const discountType = values.discountType || MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.NONE;
  if (!MEMBERSHIP_PACKAGE_DISCOUNT_DEFINITIONS[discountType]) throw new Error("请选择套餐折扣规则");
  let discountValue = 0;
  if (discountType !== MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.NONE) {
    discountValue = positiveNumber(values.discountValue, "折扣值必须大于 0");
  }
  if (discountType === MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.PERCENTAGE && discountValue >= 100) {
    throw new Error("优惠比例必须小于 100%");
  }
  if (discountType === MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.FIXED && discountValue >= listPrice) {
    throw new Error("固定减免金额必须小于套餐售价");
  }

  const packages = workspace.membershipPackages || [];
  const existing = values.id ? packages.find((item) => item.id === values.id) : null;
  if (values.id && !existing) throw new Error("找不到要修改的会员套餐");
  const duplicate = packages.find((item) => item.id !== values.id && item.name === name);
  if (duplicate) throw new Error("已存在名为“" + name + "”的会员套餐");
  const packageRule = {
    id: existing?.id || context.packageId || createId("membership-package"),
    name,
    listPrice,
    price: listPrice,
    salePrice: membershipPackagePrice({ listPrice, discountType, discountValue }),
    totalSessions,
    validityDays,
    discountType,
    discountValue,
    enabled: values.enabled == null ? existing?.enabled !== false : Boolean(values.enabled),
    createdAt: existing?.createdAt || at,
    updatedAt: at,
  };
  return {
    ...workspace,
    membershipPackages: existing
      ? packages.map((item) => item.id === packageRule.id ? packageRule : item)
      : [...packages, packageRule],
  };
}

function allocatePackageEvent(lots, event, linkedRechargeId, fields) {
  const targets = linkedRechargeId
    ? lots.filter((lot) => lot.rechargeEventId === linkedRechargeId)
    : lots;
  let amount = Number(event.amount || 0);
  let sessions = Number(event.quantity || 0);
  targets.forEach((lot) => {
    if (amount > 0) {
      const allocated = Math.min(lot.unfulfilledBalance, amount);
      lot.unfulfilledBalance = round(lot.unfulfilledBalance - allocated);
      lot[fields.amount] = round(lot[fields.amount] + allocated);
      amount = round(amount - allocated);
    }
    if (sessions > 0) {
      const allocated = Math.min(lot.remainingSessions, sessions);
      lot.remainingSessions = round(lot.remainingSessions - allocated);
      lot[fields.sessions] = round(lot[fields.sessions] + allocated);
      sessions = round(sessions - allocated);
    }
  });
}

export function buildMemberPackageBalances(workspace = {}, memberId = null, options = {}) {
  const asOfDate = options.asOfDate || new Date().toISOString().slice(0, 10);
  const memberEvents = (workspace.businessEvents || []).filter((event) => (
    (!memberId || event.memberId === memberId)
    && eventWithinPeriod(event, options.period || null)
    && (!event.date || event.date <= asOfDate)
  ));
  const lots = memberEvents
    .filter((event) => (
      memberEventKind(event) === MEMBER_EVENT_KINDS.RECHARGE
      && isRecognizedMemberEvent(event)
      && event.packageId
    ))
    .sort(eventOrder)
    .map((event) => {
      const snapshot = event.packageSnapshot || {};
      const expiresAt = event.packageExpiresAt || packageExpirationDate(event.date, snapshot.validityDays || 0);
      return {
        rechargeEventId: event.id,
        memberId: event.memberId,
        memberName: event.memberName || memberForEvent(workspace, event)?.name || "未命名会员",
        storeId: event.storeId || event.dimensions?.storeId || "",
        storeName: event.storeName || event.dimensions?.storeName || "",
        coach: event.coach || event.dimensions?.coach || "",
        department: event.department || event.dimensions?.department || "",
        project: event.project || event.dimensions?.project || "",
        packageId: event.packageId,
        packageName: event.packageName || snapshot.name || "未命名套餐",
        purchasedAt: event.date,
        expiresAt,
        expired: Boolean(expiresAt && asOfDate > expiresAt),
        originalSessions: round(event.quantity),
        consumedSessions: 0,
        refundedSessions: 0,
        remainingSessions: round(event.quantity),
        originalAmount: round(event.amount),
        recognizedRevenue: 0,
        refundedAmount: 0,
        unfulfilledBalance: round(event.amount),
        packageSnapshot: snapshot,
      };
    });

  memberEvents
    .filter((event) => memberEventKind(event) === MEMBER_EVENT_KINDS.CONSUMPTION && isRecognizedMemberEvent(event))
    .sort(eventOrder)
    .forEach((event) => allocatePackageEvent(lots, event, event.packageRechargeId, {
      amount: "recognizedRevenue",
      sessions: "consumedSessions",
    }));
  memberEvents
    .filter((event) => memberEventKind(event) === MEMBER_EVENT_KINDS.REFUND && isRecognizedMemberEvent(event))
    .sort(eventOrder)
    .forEach((event) => allocatePackageEvent(lots, event, event.originalRechargeId, {
      amount: "refundedAmount",
      sessions: "refundedSessions",
    }));
  return lots.map((lot) => ({
    ...lot,
    remainingSessions: Math.max(0, round(lot.remainingSessions)),
    unfulfilledBalance: Math.max(0, round(lot.unfulfilledBalance)),
  }));
}

function findValidPackagePurchase(workspace, event) {
  const packageRechargeId = requiredText(event.packageRechargeId, "请选择本次耗课使用的有效套餐");
  const packageBalance = buildMemberPackageBalances(workspace, event.memberId, { asOfDate: event.date })
    .find((item) => item.rechargeEventId === packageRechargeId);
  if (!packageBalance) throw new Error("所选套餐不存在、尚未确认或不属于当前会员");
  if (packageBalance.expired) throw new Error("所选套餐已于 " + packageBalance.expiresAt + " 到期，不能确认耗课");
  return packageBalance;
}

function assertValidPackagePurchase(workspace, event) {
  const packageBalance = findValidPackagePurchase(workspace, event);
  if (Number(event.quantity || 0) > packageBalance.remainingSessions + 0.001) {
    throw new Error("所选套餐剩余 " + packageBalance.remainingSessions + " 节，本次耗课课时不足");
  }
  if (packageBalance.unfulfilledBalance <= 0) throw new Error("所选套餐未履约余额不足，不能确认耗课");
  return packageBalance;
}

export function calculateMembershipConsumptionAmount(packageBalance, quantity) {
  if (Number(quantity) >= packageBalance.remainingSessions - 0.001) return packageBalance.unfulfilledBalance;
  return round(packageBalance.unfulfilledBalance / packageBalance.remainingSessions * Number(quantity));
}

function memberForEvent(workspace, event) {
  return (workspace.members || []).find((member) => member.id === event.memberId)
    || (workspace.members || []).find((member) => member.name && member.name === event.memberName)
    || null;
}

function memberForTransaction(workspace, transaction) {
  const linkedEvent = (workspace.businessEvents || []).find((event) => (
    event.id === transaction.businessEventId || (event.sourceIds || []).includes(transaction.id)
  ));
  const directMemberId = transaction.memberId || linkedEvent?.memberId;
  const byId = (workspace.members || []).find((member) => member.id === directMemberId);
  if (byId) return byId;

  const allocationBillIds = new Set((transaction.allocations || [])
    .filter((allocation) => allocation.status !== "reversed")
    .map((allocation) => allocation.billId));
  const billNames = (workspace.bills || [])
    .filter((bill) => allocationBillIds.has(bill.id))
    .map((bill) => bill.counterparty || "");
  const sourceText = [
    transaction.memberName,
    linkedEvent?.memberName,
    transaction.counterparty,
    transaction.summary,
    transaction.memo,
    ...billNames,
  ].filter(Boolean).join(" ");
  return (workspace.members || []).find((member) => member.name && sourceText.includes(member.name)) || null;
}

function commissionSourceRecords(workspace, rule, period) {
  if (rule.basis === COMMISSION_RULE_BASES.SALES_RECHARGE || rule.basis === COMMISSION_RULE_BASES.MEMBER_CONSUMPTION) {
    const expectedKind = rule.basis === COMMISSION_RULE_BASES.SALES_RECHARGE
      ? MEMBER_EVENT_KINDS.RECHARGE
      : MEMBER_EVENT_KINDS.CONSUMPTION;
    return (workspace.businessEvents || [])
      .filter((event) => (
        memberEventKind(event) === expectedKind
        && isRecognizedMemberEvent(event)
        && String(event.date || "").startsWith(period)
      ))
      .map((event) => {
        const member = memberForEvent(workspace, event);
        const dimensions = businessDimensions(workspace, event, member);
        const coach = dimensions.coach;
        return {
          sourceId: event.id,
          sourceType: "memberEvent",
          date: event.date,
          ...dimensions,
          memberId: event.memberId || member?.id || null,
          memberName: event.memberName || member?.name || "未命名会员",
          label: `${event.memberName || member?.name || "会员"}${expectedKind === MEMBER_EVENT_KINDS.RECHARGE ? "充值" : "耗课"}`,
          baseAmount: round(event.amount),
          units: expectedKind === MEMBER_EVENT_KINDS.CONSUMPTION ? round(event.quantity) : 1,
          sourceQuantity: round(event.quantity),
        };
      })
      .filter((source) => source.coach === rule.coach);
  }

  if (rule.basis === COMMISSION_RULE_BASES.ACTUAL_COLLECTION) {
    return (workspace.transactions || [])
      .filter((transaction) => (
        Number(transaction.amount || 0) > 0
        && String(transaction.date || "").startsWith(period)
        && !["ignored", "void", "reversed"].includes(transaction.status)
        && !transaction.internalTransferLink
        && transaction.classification?.eventType !== "internalTransfer"
      ))
      .map((transaction) => {
        const member = memberForTransaction(workspace, transaction);
        const linkedEvent = (workspace.businessEvents || []).find((event) => (
          event.id === transaction.businessEventId || (event.sourceIds || []).includes(transaction.id)
        ));
        const dimensions = businessDimensions(workspace, {
          storeId: transaction.storeId ?? linkedEvent?.storeId,
          storeName: transaction.storeName ?? linkedEvent?.storeName,
          coach: transaction.coach ?? linkedEvent?.coach,
          department: transaction.department ?? linkedEvent?.department,
          project: transaction.project ?? linkedEvent?.project,
        }, member);
        const coach = dimensions.coach;
        return {
          sourceId: transaction.id,
          sourceType: "bankTransaction",
          date: transaction.date,
          ...dimensions,
          memberId: member?.id || transaction.memberId || null,
          memberName: member?.name || transaction.memberName || transaction.counterparty || "未识别收款方",
          label: `${member?.name || transaction.memberName || transaction.counterparty || "银行"}收款`,
          baseAmount: round(transaction.amount),
          units: 1,
          sourceQuantity: 1,
        };
      })
      .filter((source) => source.coach === rule.coach);
  }

  return [];
}

function claimedCommissionSourceIds(workspace) {
  return new Set((workspace.businessEvents || [])
    .filter((event) => (
      memberEventKind(event) === MEMBER_EVENT_KINDS.COMMISSION
      && normalizedEventStatus(event) !== "void"
    ))
    .flatMap((event) => event.commissionSourceIds || []));
}

export function saveCommissionRule(workspace, values, context = {}) {
  const at = timestamp(context);
  const coach = requiredText(values.coach, "请填写教练姓名");
  const basis = values.basis;
  const method = values.method;
  if (!COMMISSION_RULE_BASE_DEFINITIONS[basis]) throw new Error("请选择提成口径");
  if (!Object.values(COMMISSION_RULE_METHODS).includes(method)) throw new Error("请选择提成计算方式");
  const currentRules = workspace.commissionRules || [];
  const existing = values.id ? currentRules.find((rule) => rule.id === values.id) : null;
  if (values.id && !existing) throw new Error("找不到要修改的提成规则");
  const duplicate = currentRules.find((rule) => rule.id !== values.id && rule.coach === coach && rule.basis === basis);
  if (duplicate) throw new Error(`${coach} 已有“${COMMISSION_RULE_BASE_DEFINITIONS[basis].label}”规则，请编辑现有规则`);

  let rate = 0;
  let fixedAmount = 0;
  if (method === COMMISSION_RULE_METHODS.PERCENTAGE) {
    rate = positiveNumber(values.rate, "提成比例必须大于 0");
    if (rate > 100) throw new Error("提成比例不能超过 100%");
  } else {
    fixedAmount = positiveNumber(values.fixedAmount, "固定提成金额必须大于 0");
  }

  const rule = {
    id: existing?.id || context.ruleId || createId("commission-rule"),
    coach,
    basis,
    method,
    rate,
    fixedAmount,
    enabled: values.enabled == null ? existing?.enabled !== false : Boolean(values.enabled),
    createdAt: existing?.createdAt || at,
    updatedAt: at,
  };
  return {
    ...workspace,
    commissionRules: existing
      ? currentRules.map((item) => item.id === rule.id ? rule : item)
      : [...currentRules, rule],
  };
}

export function buildCommissionRuleCalculation(workspace = {}, ruleOrId, options = {}) {
  const rule = typeof ruleOrId === "string"
    ? (workspace.commissionRules || []).find((item) => item.id === ruleOrId)
    : ruleOrId;
  if (!rule) throw new Error("找不到提成规则");
  const period = String(options.period || workspace.currentPeriod || "").trim();
  if (!period) throw new Error("当前工作台没有可计算的账期");
  const claimedSourceIds = claimedCommissionSourceIds(workspace);
  const lines = commissionSourceRecords(workspace, rule, period)
    .map((source) => {
      const commissionAmount = rule.method === COMMISSION_RULE_METHODS.PERCENTAGE
        ? round(source.baseAmount * Number(rule.rate || 0) / 100)
        : round(Number(rule.fixedAmount || 0) * Number(source.units || 0));
      return {
        ...source,
        commissionAmount,
        alreadyAccrued: claimedSourceIds.has(source.sourceId),
      };
    })
    .filter((line) => line.commissionAmount > 0)
    .sort(eventOrder);
  const pendingLines = lines.filter((line) => !line.alreadyAccrued);
  const accruedEvents = (workspace.businessEvents || []).filter((event) => (
    memberEventKind(event) === MEMBER_EVENT_KINDS.COMMISSION
    && event.commissionRuleId === rule.id
    && event.calculationPeriod === period
    && isRecognizedMemberEvent(event)
  ));
  return {
    rule,
    period,
    lines,
    pendingLines,
    sourceCount: pendingLines.length,
    alreadyAccruedSourceCount: lines.length - pendingLines.length,
    baseAmount: round(pendingLines.reduce((sum, line) => sum + line.baseAmount, 0)),
    units: round(pendingLines.reduce((sum, line) => sum + line.units, 0)),
    commissionAmount: round(pendingLines.reduce((sum, line) => sum + line.commissionAmount, 0)),
    accruedAmount: round(accruedEvents.reduce((sum, event) => sum + Number(event.amount || 0), 0)),
  };
}

export function confirmCommissionAccrual(workspace, values, context = {}) {
  const calculation = buildCommissionRuleCalculation(workspace, values.ruleId, { period: values.period });
  if (calculation.rule.enabled === false) throw new Error("该提成规则已停用，不能确认计提");
  const requestedIds = values.sourceIds?.length ? [...new Set(values.sourceIds)] : calculation.pendingLines.map((line) => line.sourceId);
  const requestedSet = new Set(requestedIds);
  const missing = requestedIds.find((sourceId) => !calculation.lines.some((line) => line.sourceId === sourceId));
  if (missing) throw new Error(`找不到提成来源：${missing}`);
  const repeated = calculation.lines.find((line) => requestedSet.has(line.sourceId) && line.alreadyAccrued);
  if (repeated) throw new Error(`${repeated.label}已经计提，不能重复计提`);
  const selectedLines = calculation.pendingLines.filter((line) => requestedSet.has(line.sourceId));
  if (!selectedLines.length) throw new Error("本期没有尚未计提的来源");
  const at = timestamp(context);
  const definition = MEMBER_EVENT_DEFINITIONS[MEMBER_EVENT_KINDS.COMMISSION];
  const basisDefinition = COMMISSION_RULE_BASE_DEFINITIONS[calculation.rule.basis];
  const groupedLines = new Map();
  selectedLines.forEach((line) => {
    const key = [line.storeId || "", line.storeName || "", line.department || "", line.project || ""].join("|");
    groupedLines.set(key, [...(groupedLines.get(key) || []), line]);
  });
  const groups = [...groupedLines.values()];
  const events = groups.map((lines, index) => {
    const dimensions = businessDimensions(workspace, lines[0]);
    const amount = round(lines.reduce((sum, line) => sum + line.commissionAmount, 0));
    const quantity = calculation.rule.basis === COMMISSION_RULE_BASES.MEMBER_CONSUMPTION
      ? round(lines.reduce((sum, line) => sum + line.units, 0))
      : lines.length;
    const date = context.date || [...lines].sort(eventOrder).at(-1)?.date || `${calculation.period}-01`;
    const eventId = context.eventId
      ? (groups.length === 1 || index === 0 ? context.eventId : `${context.eventId}-${index + 1}`)
      : createId("member-event");
    return {
      id: eventId,
      kind: MEMBER_EVENT_KINDS.COMMISSION,
      type: definition.accountingEventType,
      accountingEventType: definition.accountingEventType,
      accountingSubtype: definition.accountingSubtype,
      account: definition.account,
      accountingLabel: definition.accountingLabel,
      suggestedEntry: definition.suggestedEntry,
      accountingStatus: "ready",
      date,
      memberId: null,
      memberName: "",
      ...dimensions,
      dimensions: dimensionSnapshot(dimensions),
      dimensionSource: "commission-sources",
      amount,
      quantity,
      note: `${calculation.period} ${basisDefinition.label}提成 · ${lines.length} 项来源`,
      status: "accrued",
      source: "commission-rule",
      sourceIds: [...new Set([...(dimensions.storeId ? [dimensions.storeId] : []), ...lines.map((line) => line.sourceId)])],
      dimensionSourceIds: dimensions.storeId ? [dimensions.storeId] : [],
      commissionSourceIds: lines.map((line) => line.sourceId),
      commissionRuleId: calculation.rule.id,
      commissionBasis: calculation.rule.basis,
      commissionMethod: calculation.rule.method,
      calculationPeriod: calculation.period,
      commissionRuleSnapshot: { ...calculation.rule },
      commissionCalculationLines: lines.map((line) => ({ ...line })),
      history: [{ at, actor: context.actor || "本地用户", from: null, to: "accrued" }],
      createdAt: at,
      updatedAt: at,
    };
  });
  return { ...workspace, businessEvents: [...(workspace.businessEvents || []), ...events] };
}

function reconciliationPeriod(workspace, requestedPeriod) {
  if (requestedPeriod) return String(requestedPeriod);
  if (workspace.currentPeriod) return String(workspace.currentPeriod);
  const periods = [
    ...(workspace.businessEvents || []).map((event) => String(event.date || "").slice(0, 7)),
    ...(workspace.vouchers || []).map((voucher) => String(voucher.date || "").slice(0, 7)),
  ].filter((period) => /^\d{4}-\d{2}$/.test(period)).sort();
  return periods.at(-1) || "all";
}

function eventWithinPeriod(event, period) {
  if (!period || period === "all" || !event.date) return true;
  return String(event.date).slice(0, 7) <= period;
}

export function buildMemberLedger(workspace = {}, { period = null } = {}) {
  const events = (workspace.businessEvents || []).filter((event) => (
    memberEventKind(event) && eventWithinPeriod(event, period)
  ));
  const members = (workspace.members || []).map((member) => {
    const memberEvents = events.filter((event) => event.memberId === member.id && isRecognizedMemberEvent(event));
    const balances = memberEvents.reduce((current, event) => {
      const kind = memberEventKind(event);
      const quantity = Number(event.quantity || 0);
      const amount = Number(event.amount || 0);
      if (kind === MEMBER_EVENT_KINDS.RECHARGE) {
        current.remainingSessions += quantity;
        current.unfulfilledBalance += amount;
        current.recharged += amount;
      }
      if (kind === MEMBER_EVENT_KINDS.CONSUMPTION) {
        current.remainingSessions -= quantity;
        current.unfulfilledBalance -= amount;
        current.consumedSessions += quantity;
        current.recognizedRevenue += amount;
      }
      if (kind === MEMBER_EVENT_KINDS.REFUND) {
        current.remainingSessions -= quantity;
        current.unfulfilledBalance -= amount;
        current.refunded += amount;
      }
      return current;
    }, {
      remainingSessions: Number(member.openingSessions || 0),
      unfulfilledBalance: Number(member.openingBalance || 0),
      recharged: 0,
      consumedSessions: 0,
      recognizedRevenue: 0,
      refunded: 0,
    });
    return {
      ...member,
      ...Object.fromEntries(Object.entries(balances).map(([key, value]) => [key, round(value)])),
    };
  });
  const commissionEvents = events.filter((event) => memberEventKind(event) === MEMBER_EVENT_KINDS.COMMISSION && isRecognizedMemberEvent(event));
  const pendingEvents = events.filter((event) => normalizedEventStatus(event) === "pending");
  return {
    members,
    events: [...events].sort((left, right) => `${right.date || ""}${right.createdAt || ""}`.localeCompare(`${left.date || ""}${left.createdAt || ""}`)),
    totals: {
      activeMembers: members.filter((member) => normalizedMemberStatus(member.status) === "active").length,
      remainingSessions: round(members.reduce((sum, member) => sum + member.remainingSessions, 0)),
      unfulfilledBalance: round(members.reduce((sum, member) => sum + member.unfulfilledBalance, 0)),
      pendingEvents: pendingEvents.length,
      commissionPayable: round(commissionEvents.filter((event) => normalizedEventStatus(event) !== "paid").reduce((sum, event) => sum + Number(event.amount || 0), 0)),
    },
  };
}

export function buildMemberServiceReconciliation(workspace = {}, options = {}) {
  const period = reconciliationPeriod(workspace, options.period);
  const ledger = buildMemberLedger(workspace, { period: period === "all" ? null : period });
  const relevantKinds = new Set([
    MEMBER_EVENT_KINDS.RECHARGE,
    MEMBER_EVENT_KINDS.CONSUMPTION,
    MEMBER_EVENT_KINDS.REFUND,
  ]);
  const relevantEvents = (workspace.businessEvents || []).filter((event) => (
    relevantKinds.has(memberEventKind(event))
    && isRecognizedMemberEvent(event)
    && eventWithinPeriod(event, period)
  ));
  const memberEventSources = relevantEvents.map((event) => {
    const kind = memberEventKind(event);
    return {
      id: event.id,
      memberId: event.memberId,
      memberName: event.memberName || memberForEvent(workspace, event)?.name || "未命名会员",
      date: event.date,
      kind,
      label: MEMBER_EVENT_DEFINITIONS[kind].label,
      amount: round(event.amount),
      balanceEffect: kind === MEMBER_EVENT_KINDS.RECHARGE ? round(event.amount) : -round(event.amount),
    };
  });
  const memberOpeningSources = ledger.members
    .filter((member) => Number(member.openingBalance || 0) || Number(member.openingSessions || 0))
    .map((member) => ({
      id: `opening:member:${member.id}`,
      memberId: member.id,
      memberName: member.name,
      date: period === "all" ? "" : `${period}-01`,
      kind: "opening",
      label: "会员期初未履约余额",
      amount: round(member.openingBalance),
      balanceEffect: round(member.openingBalance),
    }));
  const memberSources = [...memberOpeningSources, ...memberEventSources];
  const members = ledger.members.map((member) => ({
    id: member.id,
    name: member.name,
    recharged: member.recharged,
    recognizedRevenue: member.recognizedRevenue,
    refunded: member.refunded,
    remainingSessions: member.remainingSessions,
    unfulfilledBalance: member.unfulfilledBalance,
    openingBalance: round(member.openingBalance),
    sourceIds: memberSources.filter((source) => source.memberId === member.id).map((source) => source.id),
  }));

  const openingSources = Object.entries(workspace.openingLedger || {})
    .filter(([accountId]) => String(accountId).split(":")[0] === "contractLiability")
    .map(([accountId, value]) => ({
      id: `opening:${accountId}`,
      type: "opening",
      date: period === "all" ? "" : `${period}-01`,
      label: "合同负债期初余额",
      reference: accountId,
      debit: 0,
      credit: 0,
      balanceEffect: round(-Number(value || 0)),
      sourceIds: [accountId],
    }));
  const voucherSources = (workspace.vouchers || [])
    .filter((voucher) => (
      voucher.status === "posted"
      && (period === "all" || String(voucher.date || "").startsWith(period))
    ))
    .flatMap((voucher) => (voucher.lines || [])
      .filter((line) => String(line.account || "").split(":")[0] === "contractLiability")
      .map((line, lineIndex) => ({
        id: `${voucher.id}:${lineIndex}`,
        type: "voucher",
        voucherId: voucher.id,
        voucherNo: voucher.no,
        date: voucher.date,
        label: voucher.summary || "合同负债凭证",
        reference: voucher.no || voucher.id,
        debit: round(line.debit),
        credit: round(line.credit),
        balanceEffect: round(Number(line.credit || 0) - Number(line.debit || 0)),
        sourceIds: [...new Set([voucher.id, ...(voucher.sourceIds || []), ...(line.sourceIds || [])])],
      })));
  const accountingSources = [...openingSources, ...voucherSources];
  const memberBalance = round(ledger.totals.unfulfilledBalance);
  const contractLiabilityBalance = round(accountingSources.reduce((sum, source) => sum + source.balanceEffect, 0));
  const difference = round(memberBalance - contractLiabilityBalance);
  const applicable = members.length > 0 || relevantEvents.length > 0;
  const passed = !applicable || Math.abs(difference) <= 0.01;
  const sourceIds = [...new Set([
    ...members.flatMap((member) => [member.id, ...member.sourceIds]),
    ...accountingSources.flatMap((source) => source.sourceIds),
  ])];
  const message = !applicable
    ? "当前工作台没有会员未履约服务数据，本项不适用"
    : passed
      ? `会员未履约余额与合同负债一致，均为 ${memberBalance.toFixed(2)} 元`
      : `会员未履约余额 ${memberBalance.toFixed(2)} 元，已入账合同负债 ${contractLiabilityBalance.toFixed(2)} 元，差额 ${difference.toFixed(2)} 元`;
  return {
    period,
    applicable,
    passed,
    status: !applicable ? "not_applicable" : passed ? "passed" : "mismatch",
    memberBalance,
    contractLiabilityBalance,
    difference,
    members,
    memberSources,
    accountingSources,
    sourceIds,
    message,
  };
}

export function synchronizeMemberServiceException(workspace, options = {}, context = {}) {
  const reconciliation = buildMemberServiceReconciliation(workspace, options);
  const identity = `member-service-reconciliation:${reconciliation.period}`;
  const tasks = workspace.exceptionTasks || [];
  const existing = tasks.find((task) => task.identity === identity || (
    task.code === "member_service_reconciliation" && task.period === reconciliation.period
  ));
  if (reconciliation.passed && !existing) return workspace;

  const status = reconciliation.passed ? "resolved" : "open";
  const nextFields = {
    identity,
    code: "member_service_reconciliation",
    sourceType: "memberServiceReconciliation",
    sourceId: reconciliation.period,
    period: reconciliation.period,
    message: reconciliation.message,
    status,
    amount: Math.abs(reconciliation.difference),
    difference: reconciliation.difference,
    memberBalance: reconciliation.memberBalance,
    contractLiabilityBalance: reconciliation.contractLiabilityBalance,
    autoManaged: true,
    manualResolutionAllowed: false,
    sourceIds: reconciliation.sourceIds,
  };
  const unchanged = existing
    && existing.status === nextFields.status
    && existing.message === nextFields.message
    && Number(existing.difference || 0) === nextFields.difference
    && JSON.stringify(existing.sourceIds || []) === JSON.stringify(nextFields.sourceIds);
  if (unchanged) return workspace;

  const at = timestamp(context);
  const actor = context.actor || "本地勾稽引擎";
  const task = {
    ...(existing || {}),
    id: existing?.id || identity,
    ...nextFields,
    createdAt: existing?.createdAt || at,
    updatedAt: at,
    resolvedAt: status === "resolved" ? at : null,
    history: [
      ...(existing?.history || []),
      {
        at,
        actor,
        action: status === "resolved" ? "auto_resolved" : (existing ? "auto_refreshed" : "auto_created"),
        note: reconciliation.message,
      },
    ],
  };
  return {
    ...workspace,
    exceptionTasks: existing
      ? tasks.map((item) => item.id === existing.id ? task : item)
      : [...tasks, task],
  };
}

function assertNonNegativeMemberBalances(workspace) {
  const invalid = buildMemberLedger(workspace).members.find((member) => member.remainingSessions < 0 || member.unfulfilledBalance < 0);
  if (!invalid) return;
  if (invalid.remainingSessions < 0) throw new Error(`${invalid.name} 的剩余课时不足，不能确认这笔业务`);
  throw new Error(`${invalid.name} 的未履约余额不足，不能确认这笔业务`);
}

export function addMember(workspace, values, context = {}) {
  const at = timestamp(context);
  const name = requiredText(values.name, "请填写会员姓名");
  const dimensions = businessDimensions(workspace, values);
  const member = {
    id: values.id || createId("member"),
    name,
    phone: String(values.phone || "").trim(),
    ...dimensions,
    status: normalizedMemberStatus(values.status || "active"),
    openingSessions: round(values.openingSessions || 0),
    openingBalance: round(values.openingBalance || 0),
    createdAt: at,
    updatedAt: at,
  };
  return synchronizeMemberServiceException({
    ...workspace,
    members: [...(workspace.members || []), member],
  }, { period: workspace.currentPeriod }, context);
}

export function updateMemberStatus(workspace, memberId, status, context = {}) {
  const member = (workspace.members || []).find((item) => item.id === memberId);
  if (!member) throw new Error("找不到要更新的会员");
  const at = timestamp(context);
  return {
    ...workspace,
    members: workspace.members.map((item) => item.id === memberId ? { ...item, status: normalizedMemberStatus(status), updatedAt: at } : item),
  };
}

export function addMemberBusinessEvent(workspace, values, context = {}) {
  const kind = values.kind;
  const definition = MEMBER_EVENT_DEFINITIONS[kind];
  if (!definition || definition.creatable === false) throw new Error("请选择业务类型");
  const member = kind === MEMBER_EVENT_KINDS.COMMISSION
    ? null
    : (workspace.members || []).find((item) => item.id === values.memberId);
  if (kind !== MEMBER_EVENT_KINDS.COMMISSION && !member) throw new Error("请选择会员");
  const dimensions = businessDimensions(workspace, values, member);
  const coach = dimensions.coach;
  if (kind === MEMBER_EVENT_KINDS.COMMISSION && !coach) throw new Error("请填写教练姓名");
  const at = timestamp(context);
  const date = requiredText(values.date, "请选择业务日期");
  let amount;
  let quantity;
  let packageRule = null;
  let packageBalance = null;
  if (kind === MEMBER_EVENT_KINDS.RECHARGE) {
    const packageId = requiredText(values.packageId, "请选择会员充值套餐");
    packageRule = (workspace.membershipPackages || []).find((item) => item.id === packageId);
    if (!packageRule || packageRule.enabled === false) throw new Error("所选会员套餐不存在或已停用");
    amount = positiveNumber(packageRule.salePrice ?? membershipPackagePrice(packageRule), "套餐实收金额必须大于 0");
    quantity = positiveNumber(packageRule.totalSessions, "套餐总课时必须大于 0");
  } else if (kind === MEMBER_EVENT_KINDS.CONSUMPTION) {
    quantity = positiveNumber(values.quantity, "课时必须大于 0");
    packageBalance = findValidPackagePurchase(workspace, {
      memberId: member.id,
      date,
      quantity,
      packageRechargeId: values.packageRechargeId,
    });
    amount = calculateMembershipConsumptionAmount(packageBalance, quantity);
  } else {
    amount = positiveNumber(values.amount, "金额必须大于 0");
    quantity = kind === MEMBER_EVENT_KINDS.COMMISSION
      ? round(values.quantity || 0)
      : positiveNumber(values.quantity, "课时必须大于 0");
  }
  const packageSnapshot = packageRule ? {
    id: packageRule.id,
    name: packageRule.name,
    listPrice: packageRule.listPrice,
    salePrice: packageRule.salePrice ?? membershipPackagePrice(packageRule),
    totalSessions: packageRule.totalSessions,
    validityDays: packageRule.validityDays,
    discountType: packageRule.discountType,
    discountValue: packageRule.discountValue,
  } : packageBalance?.packageSnapshot || null;
  const event = {
    id: values.id || createId("member-event"),
    kind,
    type: definition.accountingEventType,
    accountingEventType: definition.accountingEventType,
    accountingSubtype: definition.accountingSubtype || null,
    account: definition.account,
    accountingLabel: definition.accountingLabel,
    suggestedEntry: definition.suggestedEntry,
    accountingStatus: "draft",
    date,
    memberId: member?.id || null,
    memberName: member?.name || "",
    ...dimensions,
    dimensions: dimensionSnapshot(dimensions, member?.id || null),
    dimensionSource: member && ["storeId", "storeName", "coach", "department", "project"]
      .every((key) => values[key] == null || String(values[key]).trim() === String(member[key] || "").trim())
      ? "member-default"
      : "business-adjustment",
    amount,
    quantity,
    note: String(values.note || "").trim(),
    status: "pending",
    source: "member-ledger",
    originalRechargeId: kind === MEMBER_EVENT_KINDS.REFUND ? String(values.originalRechargeId || "").trim() : null,
    packageId: packageRule?.id || packageBalance?.packageId || null,
    packageName: packageRule?.name || packageBalance?.packageName || "",
    packageRechargeId: kind === MEMBER_EVENT_KINDS.CONSUMPTION ? packageBalance.rechargeEventId : null,
    packageExpiresAt: packageRule
      ? packageExpirationDate(date, packageRule.validityDays)
      : packageBalance?.expiresAt || null,
    packageSnapshot,
    sourceIds: member ? [
      member.id,
      ...(dimensions.storeId ? [dimensions.storeId] : []),
      ...(packageRule ? [packageRule.id] : []),
      ...(packageBalance ? [packageBalance.rechargeEventId] : []),
    ] : (dimensions.storeId ? [dimensions.storeId] : []),
    dimensionSourceIds: dimensions.storeId ? [dimensions.storeId] : [],
    history: [{ at, actor: context.actor || "本地用户", from: null, to: "pending" }],
    createdAt: at,
    updatedAt: at,
  };
  if (kind === MEMBER_EVENT_KINDS.REFUND) {
    const originalRechargeId = assertRefundWithinOriginalRecharge(workspace, event);
    event.originalRechargeId = originalRechargeId;
    event.sourceIds = [member.id, ...(dimensions.storeId ? [dimensions.storeId] : []), originalRechargeId];
  }
  return { ...workspace, businessEvents: [...(workspace.businessEvents || []), event] };
}

export function updateMemberBusinessEventStatus(workspace, eventId, nextStatus, context = {}) {
  const event = (workspace.businessEvents || []).find((item) => item.id === eventId);
  if (!event) throw new Error("找不到要更新的会员业务");
  const kind = memberEventKind(event);
  if (kind === MEMBER_EVENT_KINDS.COMMISSION && nextStatus === "paid" && event.accountingStatus !== "posted") {
    throw new Error("教练提成计提凭证必须先入账，才能登记付款");
  }
  const allowed = memberEventActions(event).some((action) => action.status === nextStatus);
  if (!allowed) throw new Error(`不能从“${memberEventStatusLabel(event)}”变更为该状态`);
  if (nextStatus === "void" && ["voucher_draft", "posted"].includes(event.accountingStatus)) {
    throw new Error("该业务已生成会计凭证，不能直接作废；请先在会计处理中完成更正");
  }
  if (kind === MEMBER_EVENT_KINDS.REFUND && nextStatus === "completed") {
    assertRefundWithinOriginalRecharge(workspace, event, { excludeRefundId: event.id });
  }
  const confirmedPackageBalance = kind === MEMBER_EVENT_KINDS.CONSUMPTION && nextStatus === "confirmed"
    ? assertValidPackagePurchase(workspace, event)
    : null;
  const confirmedConsumptionAmount = confirmedPackageBalance
    ? calculateMembershipConsumptionAmount(confirmedPackageBalance, event.quantity)
    : null;
  const at = timestamp(context);
  const accountingStatus = event.accountingStatus === "posted" && nextStatus !== "void"
    ? "posted"
    : nextStatus === "void"
    ? "void"
    : nextStatus === "pending" ? "draft" : "ready";
  const next = {
    ...workspace,
    businessEvents: workspace.businessEvents.map((item) => item.id === eventId ? {
      ...item,
      amount: confirmedConsumptionAmount ?? item.amount,
      status: nextStatus,
      accountingStatus,
      updatedAt: at,
      history: [...(item.history || []), {
        at,
        actor: context.actor || "本地用户",
        from: normalizedEventStatus(item),
        to: nextStatus,
      }],
    } : item),
  };
  if (kind === MEMBER_EVENT_KINDS.COMMISSION && nextStatus === "paid") {
    const existingPayment = (workspace.businessEvents || []).find((item) => (
      memberEventKind(item) === MEMBER_EVENT_KINDS.COMMISSION_PAYMENT
      && item.commissionEventId === event.id
      && normalizedEventStatus(item) !== "void"
    ));
    if (existingPayment) throw new Error("这笔教练提成已经登记付款");
    const definition = MEMBER_EVENT_DEFINITIONS[MEMBER_EVENT_KINDS.COMMISSION_PAYMENT];
    const paymentEvent = {
      id: context.paymentEventId || createId("member-event"),
      kind: MEMBER_EVENT_KINDS.COMMISSION_PAYMENT,
      type: definition.accountingEventType,
      accountingEventType: definition.accountingEventType,
      accountingSubtype: definition.accountingSubtype,
      account: definition.account,
      accountingLabel: definition.accountingLabel,
      suggestedEntry: definition.suggestedEntry,
      accountingStatus: "ready",
      date: context.paymentDate || String(at).slice(0, 10),
      memberId: null,
      memberName: "",
      coach: event.coach,
      storeId: event.storeId || event.dimensions?.storeId || "",
      storeName: event.storeName || event.dimensions?.storeName || "",
      department: event.department || event.dimensions?.department || "",
      project: event.project || event.dimensions?.project || "",
      dimensions: dimensionSnapshot({
        storeId: event.storeId || event.dimensions?.storeId || "",
        storeName: event.storeName || event.dimensions?.storeName || "",
        coach: event.coach || event.dimensions?.coach || "",
        department: event.department || event.dimensions?.department || "",
        project: event.project || event.dimensions?.project || "",
      }),
      dimensionSource: "commission-accrual",
      amount: round(event.amount),
      quantity: round(event.quantity),
      note: `支付${event.date || ""}计提的教练提成`,
      status: "confirmed",
      source: "member-ledger",
      sourceIds: [event.id, ...(event.storeId ? [event.storeId] : [])],
      dimensionSourceIds: event.storeId ? [event.storeId] : [],
      commissionEventId: event.id,
      bankAccountId: event.bankAccountId || null,
      history: [{ at, actor: context.actor || "本地用户", from: null, to: "confirmed" }],
      createdAt: at,
      updatedAt: at,
    };
    next.businessEvents = next.businessEvents.map((item) => item.id === event.id
      ? { ...item, paymentEventId: paymentEvent.id }
      : item);
    next.businessEvents.push(paymentEvent);
  }
  assertNonNegativeMemberBalances(next);
  return synchronizeMemberServiceException(next, { period: next.currentPeriod }, context);
}
