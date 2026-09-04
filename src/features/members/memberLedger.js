import { createId } from "../../domain/foundation.js";

export const MEMBER_EVENT_KINDS = Object.freeze({
  RECHARGE: "recharge",
  CONSUMPTION: "consumption",
  REFUND: "refund",
  COMMISSION: "commission",
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
    accrued: [{ status: "paid", label: "标记已付" }, { status: "void", label: "作废" }],
    paid: [{ status: "void", label: "作废" }],
  },
});

const RECOGNIZED_STATUSES = Object.freeze({
  [MEMBER_EVENT_KINDS.RECHARGE]: new Set(["confirmed", "completed", "posted"]),
  [MEMBER_EVENT_KINDS.CONSUMPTION]: new Set(["confirmed", "completed", "posted"]),
  [MEMBER_EVENT_KINDS.REFUND]: new Set(["confirmed", "completed", "paid", "posted"]),
  [MEMBER_EVENT_KINDS.COMMISSION]: new Set(["confirmed", "accrued", "paid", "posted"]),
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

export function memberEventKind(event = {}) {
  if (MEMBER_EVENT_DEFINITIONS[event.kind]) return event.kind;
  if (["recharge", "memberRecharge"].includes(event.type)) return MEMBER_EVENT_KINDS.RECHARGE;
  if (["consume", "consumption", "memberConsumption"].includes(event.type)) return MEMBER_EVENT_KINDS.CONSUMPTION;
  if (event.type === "refund") return MEMBER_EVENT_KINDS.REFUND;
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
  return memberEventKind(event) ? "confirmed" : "pending";
}

export function memberEventStatusLabel(event = {}) {
  return STATUS_LABELS[normalizedEventStatus(event)] || normalizedEventStatus(event);
}

export function memberEventActions(event = {}) {
  const kind = memberEventKind(event);
  return STATUS_ACTIONS[kind]?.[normalizedEventStatus(event)] || [];
}

export function isRecognizedMemberEvent(event = {}) {
  const kind = memberEventKind(event);
  if (!kind || normalizedEventStatus(event) === "void") return false;
  return RECOGNIZED_STATUSES[kind]?.has(normalizedEventStatus(event)) || false;
}

export function buildMemberLedger(workspace = {}) {
  const events = (workspace.businessEvents || []).filter((event) => memberEventKind(event));
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

function assertNonNegativeMemberBalances(workspace) {
  const invalid = buildMemberLedger(workspace).members.find((member) => member.remainingSessions < 0 || member.unfulfilledBalance < 0);
  if (!invalid) return;
  if (invalid.remainingSessions < 0) throw new Error(`${invalid.name} 的剩余课时不足，不能确认这笔业务`);
  throw new Error(`${invalid.name} 的未履约余额不足，不能确认这笔业务`);
}

export function addMember(workspace, values, context = {}) {
  const at = timestamp(context);
  const name = requiredText(values.name, "请填写会员姓名");
  const member = {
    id: values.id || createId("member"),
    name,
    phone: String(values.phone || "").trim(),
    coach: String(values.coach || "").trim(),
    status: normalizedMemberStatus(values.status || "active"),
    openingSessions: round(values.openingSessions || 0),
    openingBalance: round(values.openingBalance || 0),
    createdAt: at,
    updatedAt: at,
  };
  return { ...workspace, members: [...(workspace.members || []), member] };
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
  if (!definition) throw new Error("请选择业务类型");
  const member = kind === MEMBER_EVENT_KINDS.COMMISSION
    ? null
    : (workspace.members || []).find((item) => item.id === values.memberId);
  if (kind !== MEMBER_EVENT_KINDS.COMMISSION && !member) throw new Error("请选择会员");
  const coach = String(values.coach || member?.coach || "").trim();
  if (kind === MEMBER_EVENT_KINDS.COMMISSION && !coach) throw new Error("请填写教练姓名");
  const at = timestamp(context);
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
    date: requiredText(values.date, "请选择业务日期"),
    memberId: member?.id || null,
    memberName: member?.name || "",
    coach,
    amount: positiveNumber(values.amount, "金额必须大于 0"),
    quantity: kind === MEMBER_EVENT_KINDS.COMMISSION ? round(values.quantity || 0) : positiveNumber(values.quantity, "课时必须大于 0"),
    note: String(values.note || "").trim(),
    status: "pending",
    source: "member-ledger",
    sourceIds: member ? [member.id] : [],
    history: [{ at, actor: context.actor || "本地用户", from: null, to: "pending" }],
    createdAt: at,
    updatedAt: at,
  };
  return { ...workspace, businessEvents: [...(workspace.businessEvents || []), event] };
}

export function updateMemberBusinessEventStatus(workspace, eventId, nextStatus, context = {}) {
  const event = (workspace.businessEvents || []).find((item) => item.id === eventId);
  if (!event) throw new Error("找不到要更新的会员业务");
  const allowed = memberEventActions(event).some((action) => action.status === nextStatus);
  if (!allowed) throw new Error(`不能从“${memberEventStatusLabel(event)}”变更为该状态`);
  const at = timestamp(context);
  const accountingStatus = nextStatus === "void"
    ? "void"
    : nextStatus === "pending" ? "draft" : "ready";
  const next = {
    ...workspace,
    businessEvents: workspace.businessEvents.map((item) => item.id === eventId ? {
      ...item,
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
  assertNonNegativeMemberBalances(next);
  return next;
}
