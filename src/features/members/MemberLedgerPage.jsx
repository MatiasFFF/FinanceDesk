import { useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle,
  Clock,
  CurrencyCircleDollar,
  Plus,
  UserPlus,
  UsersThree,
} from "@phosphor-icons/react";

import { formatCurrency } from "../../productWorkflow.js";
import {
  MEMBER_EVENT_DEFINITIONS,
  MEMBER_EVENT_KINDS,
  MEMBER_STATUS_OPTIONS,
  buildMemberLedger,
  memberEventActions,
  memberEventKind,
  memberEventStatusLabel,
  normalizedEventStatus,
  normalizedMemberStatus,
} from "./memberLedger.js";
import "./member-ledger.css";

const EVENT_STATUS_TONES = {
  pending: "warning",
  confirmed: "success",
  completed: "success",
  accrued: "success",
  paid: "success",
  posted: "success",
  void: "neutral",
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function Metric({ label, value, note, icon: Icon }) {
  return <article className="member-metric"><span><Icon size={20} /></span><div><small>{label}</small><strong>{value}</strong><p>{note}</p></div></article>;
}

function EventForm({ members, onSubmit }) {
  const [form, setForm] = useState({ kind: MEMBER_EVENT_KINDS.RECHARGE, memberId: members[0]?.id || "", date: today(), amount: "", quantity: "", coach: members[0]?.coach || "", note: "" });
  const definition = MEMBER_EVENT_DEFINITIONS[form.kind];
  const needsMember = form.kind !== MEMBER_EVENT_KINDS.COMMISSION;

  function changeMember(memberId) {
    const member = members.find((item) => item.id === memberId);
    setForm((current) => ({ ...current, memberId, coach: member?.coach || current.coach }));
  }

  function changeKind(kind) {
    const member = members.find((item) => item.id === form.memberId) || members[0];
    setForm((current) => ({ ...current, kind, memberId: member?.id || "", coach: kind === MEMBER_EVENT_KINDS.COMMISSION ? current.coach : (member?.coach || "") }));
  }

  function submit(event) {
    event.preventDefault();
    const saved = onSubmit(form);
    if (saved === false) return;
    setForm((current) => ({ ...current, amount: "", quantity: "", note: "" }));
  }

  return (
    <section className="panel member-entry-panel">
      <div className="panel-heading"><div><p className="eyebrow">新增业务</p><h2>记录会员动作</h2></div><Plus size={21} /></div>
      <form className="member-entry-form" onSubmit={submit}>
        <label><span>业务类型</span><select value={form.kind} onChange={(event) => changeKind(event.target.value)}>{Object.entries(MEMBER_EVENT_DEFINITIONS).map(([value, item]) => <option value={value} key={value}>{item.label}</option>)}</select></label>
        {needsMember && <label><span>会员</span><select value={form.memberId} onChange={(event) => changeMember(event.target.value)} required><option value="">请选择会员</option>{members.map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}</select></label>}
        <label><span>业务日期</span><input type="date" value={form.date} onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))} required /></label>
        <label><span>{form.kind === MEMBER_EVENT_KINDS.COMMISSION ? "涉及耗课数（选填）" : "课时"}</span><input type="number" min={form.kind === MEMBER_EVENT_KINDS.COMMISSION ? "0" : "0.01"} step="0.01" value={form.quantity} onChange={(event) => setForm((current) => ({ ...current, quantity: event.target.value }))} required={form.kind !== MEMBER_EVENT_KINDS.COMMISSION} /></label>
        <label><span>{form.kind === MEMBER_EVENT_KINDS.COMMISSION ? "提成金额" : "金额"}</span><input type="number" min="0.01" step="0.01" value={form.amount} onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))} required /></label>
        <label><span>教练</span><input value={form.coach} onChange={(event) => setForm((current) => ({ ...current, coach: event.target.value }))} required={form.kind === MEMBER_EVENT_KINDS.COMMISSION} placeholder="例如：陈教练" /></label>
        <label className="full"><span>备注</span><textarea value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} placeholder={definition.suggestedEntry} /></label>
        <div className="member-accounting-hint"><CurrencyCircleDollar size={18} /><span><strong>{definition.accountingLabel}</strong><small>{definition.suggestedEntry}；确认业务后进入待会计处理状态。</small></span></div>
        <button className="primary-button wide" type="submit" disabled={needsMember && members.length === 0}>新增待确认记录<ArrowRight size={16} /></button>
        {needsMember && members.length === 0 && <p className="form-help">请先在右侧新增会员。</p>}
      </form>
    </section>
  );
}

function MemberForm({ onSubmit }) {
  const [form, setForm] = useState({ name: "", phone: "", coach: "" });
  function submit(event) {
    event.preventDefault();
    const saved = onSubmit(form);
    if (saved === false) return;
    setForm({ name: "", phone: "", coach: "" });
  }
  return (
    <section className="panel member-create-panel">
      <div className="panel-heading"><div><p className="eyebrow">会员资料</p><h2>新增会员</h2></div><UserPlus size={21} /></div>
      <form className="member-entry-form compact" onSubmit={submit}>
        <label><span>会员姓名</span><input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required placeholder="例如：李女士" /></label>
        <label><span>手机 / 联系方式</span><input value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} placeholder="选填" /></label>
        <label><span>负责教练</span><input value={form.coach} onChange={(event) => setForm((current) => ({ ...current, coach: event.target.value }))} placeholder="选填" /></label>
        <button className="secondary-button wide" type="submit"><UserPlus size={16} />保存会员</button>
      </form>
    </section>
  );
}

export function MemberLedgerPage({ workspace, onAddMember, onMemberStatus, onAddEvent, onEventStatus }) {
  const ledger = useMemo(() => buildMemberLedger(workspace), [workspace]);
  return (
    <div className="page-content member-ledger-page">
      <section className="member-ledger-hero">
        <div><p className="eyebrow">本地会员业务台账</p><h2>从充值到耗课、退款与提成</h2><p>先记录业务，再确认状态。确认后的记录会更新课时与未履约余额，并成为待处理会计业务事件。</p></div>
        <span><CheckCircle size={22} weight="fill" />数据保存在当前工作台</span>
      </section>

      <section className="member-metric-grid">
        <Metric label="在籍会员" value={`${ledger.totals.activeMembers} 人`} note={`共 ${ledger.members.length} 名会员`} icon={UsersThree} />
        <Metric label="剩余课时" value={`${ledger.totals.remainingSessions} 节`} note="已确认充值 − 耗课 − 退款" icon={Clock} />
        <Metric label="未履约余额" value={formatCurrency(ledger.totals.unfulfilledBalance)} note="会员维度实时汇总" icon={CurrencyCircleDollar} />
        <Metric label="待确认 / 待付提成" value={`${ledger.totals.pendingEvents} 笔`} note={`提成 ${formatCurrency(ledger.totals.commissionPayable)}`} icon={CheckCircle} />
      </section>

      <div className="member-entry-layout">
        <EventForm members={ledger.members} onSubmit={onAddEvent} />
        <MemberForm onSubmit={onAddMember} />
      </div>

      <section className="panel member-balance-panel">
        <div className="panel-heading"><div><p className="eyebrow">会员余额</p><h2>剩余课时与未履约金额</h2></div><span>{ledger.members.length} 名</span></div>
        {ledger.members.length ? <div className="member-card-grid">{ledger.members.map((member) => <article className="member-balance-card" key={member.id}>
          <div className="member-card-head"><span className="member-avatar">{member.name.slice(0, 1)}</span><div><strong>{member.name}</strong><small>{member.phone || "未留联系方式"} · {member.coach || "未分配教练"}</small></div></div>
          <div className="member-balance-values"><span><small>剩余课时</small><strong>{member.remainingSessions} 节</strong></span><span><small>未履约余额</small><strong>{formatCurrency(member.unfulfilledBalance)}</strong></span></div>
          <div className="member-card-foot"><span>已耗 {member.consumedSessions} 节 · 已退 {formatCurrency(member.refunded)}</span><label><span>状态</span><select value={normalizedMemberStatus(member.status)} onChange={(event) => onMemberStatus(member.id, event.target.value)}>{MEMBER_STATUS_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label></div>
        </article>)}</div> : <div className="member-empty"><UsersThree size={26} /><strong>还没有会员</strong><span>先新增会员，再记录充值或耗课。</span></div>}
      </section>

      <section className="panel member-events-panel">
        <div className="panel-heading"><div><p className="eyebrow">业务流水</p><h2>会员与教练事件</h2></div><span>{ledger.events.length} 笔</span></div>
        {ledger.events.length ? <div className="member-event-list">{ledger.events.map((event) => {
          const kind = memberEventKind(event);
          const definition = MEMBER_EVENT_DEFINITIONS[kind];
          const status = normalizedEventStatus(event);
          return <article className={status === "void" ? "void" : ""} key={event.id}>
            <div className="member-event-main"><span className={`member-event-mark ${kind}`} /><span><strong>{definition.label} · {event.memberName || event.coach}</strong><small>{event.date} · {event.coach || "未记录教练"}{event.note ? ` · ${event.note}` : ""}</small></span></div>
            <span className="member-event-quantity"><small>课时</small><strong>{Number(event.quantity || 0)} 节</strong></span>
            <span className="member-event-amount"><small>金额</small><strong>{formatCurrency(event.amount)}</strong></span>
            <span className="member-event-accounting"><small>会计事件</small><strong>{event.accountingLabel || definition.accountingLabel}</strong><em>{event.accountingStatus === "ready" ? "待会计处理" : event.accountingStatus === "void" ? "已作废" : "随业务状态生成"}</em></span>
            <div className="member-event-status"><span className={`tone-pill ${EVENT_STATUS_TONES[status] || "neutral"}`}>{memberEventStatusLabel(event)}</span><div>{memberEventActions(event).map((action) => <button className={action.status === "void" ? "soft-button" : "secondary-button"} type="button" key={action.status} onClick={() => onEventStatus(event.id, action.status)}>{action.label}</button>)}</div></div>
          </article>;
        })}</div> : <div className="member-empty"><Clock size={26} /><strong>还没有业务记录</strong><span>新增的业务先进入待确认状态。</span></div>}
      </section>
    </div>
  );
}
