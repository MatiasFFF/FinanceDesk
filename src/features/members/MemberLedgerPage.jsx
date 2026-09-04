import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle,
  Clock,
  CurrencyCircleDollar,
  Plus,
  UserPlus,
  UsersThree,
  WarningCircle,
} from "@phosphor-icons/react";

import { formatCurrency } from "../../productWorkflow.js";
import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import {
  COMMISSION_RULE_BASES,
  COMMISSION_RULE_BASE_DEFINITIONS,
  COMMISSION_RULE_METHODS,
  MEMBER_EVENT_DEFINITIONS,
  MEMBER_EVENT_KINDS,
  MEMBER_STATUS_OPTIONS,
  buildCommissionRuleCalculation,
  buildMemberLedger,
  buildMemberServiceReconciliation,
  buildRechargeRefundOptions,
  confirmCommissionAccrual,
  memberEventActions,
  memberEventKind,
  memberEventStatusLabel,
  normalizedEventStatus,
  normalizedMemberStatus,
  saveCommissionRule,
  synchronizeMemberServiceException,
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

function emptyCommissionRule(coach = "") {
  return {
    id: "",
    coach,
    basis: COMMISSION_RULE_BASES.SALES_RECHARGE,
    method: COMMISSION_RULE_METHODS.PERCENTAGE,
    rate: "",
    fixedAmount: "",
  };
}

function commissionRuleSummary(rule) {
  const basis = COMMISSION_RULE_BASE_DEFINITIONS[rule.basis];
  return rule.method === COMMISSION_RULE_METHODS.PERCENTAGE
    ? `${rule.rate}% × 来源金额`
    : `${formatCurrency(rule.fixedAmount)} / ${basis.fixedUnit}`;
}

function commissionLineFormula(rule, line) {
  if (rule.method === COMMISSION_RULE_METHODS.PERCENTAGE) {
    return `${formatCurrency(line.baseAmount)} × ${rule.rate}%`;
  }
  return `${line.units} ${COMMISSION_RULE_BASE_DEFINITIONS[rule.basis].fixedUnit} × ${formatCurrency(rule.fixedAmount)}`;
}

function CommissionRulesPanel({ workspace }) {
  const { actions, state, store } = useFinanceDesk();
  const coaches = useMemo(() => [...new Set([
    ...(workspace.members || []).map((member) => member.coach),
    ...(workspace.commissionRules || []).map((rule) => rule.coach),
    ...(workspace.businessEvents || []).map((event) => event.coach),
  ].map((coach) => String(coach || "").trim()).filter(Boolean))].sort(), [workspace]);
  const [form, setForm] = useState(() => emptyCommissionRule(coaches[0] || ""));
  const [feedback, setFeedback] = useState(null);
  const rules = workspace.commissionRules || [];
  const calculations = useMemo(() => rules.map((rule) => buildCommissionRuleCalculation(workspace, rule, {
    period: workspace.currentPeriod,
  })), [rules, workspace]);
  const actor = workspace.users?.find((user) => user.id === state.activeUserId)?.name || "本地用户";

  function run(change, successMessage) {
    setFeedback(null);
    try {
      const current = store.getActiveWorkspace();
      const next = change(current);
      actions.replaceWorkspace(current.id, next);
      setFeedback({ tone: "success", message: successMessage });
      return true;
    } catch (error) {
      setFeedback({ tone: "danger", message: error.message || "提成规则处理失败" });
      return false;
    }
  }

  function submitRule(event) {
    event.preventDefault();
    if (run(
      (current) => saveCommissionRule(current, form, { actor }),
      form.id ? "提成规则已更新" : "提成规则已保存到当前工作台",
    )) setForm(emptyCommissionRule(form.coach));
  }

  function editRule(rule) {
    setFeedback(null);
    setForm({
      id: rule.id,
      coach: rule.coach,
      basis: rule.basis,
      method: rule.method,
      rate: rule.rate || "",
      fixedAmount: rule.fixedAmount || "",
    });
  }

  function toggleRule(rule) {
    run(
      (current) => saveCommissionRule(current, { ...rule, enabled: rule.enabled === false }, { actor }),
      rule.enabled === false ? "提成规则已启用" : "提成规则已停用",
    );
  }

  function accrueRule(rule, calculation) {
    run(
      (current) => confirmCommissionAccrual(current, {
        ruleId: rule.id,
        period: current.currentPeriod,
        sourceIds: calculation.pendingLines.map((line) => line.sourceId),
      }, { actor }),
      `已确认计提 ${formatCurrency(calculation.commissionAmount)}，可继续生成计提凭证`,
    );
  }

  return (
    <section className="panel commission-rules-panel">
      <div className="panel-heading"><div><p className="eyebrow">教练提成规则</p><h2>按真实业务来源计算本期应计</h2><p>规则和计提结果保存在当前工作台；同一来源一经确认，不会再次进入待计提金额。</p></div><span>{workspace.currentPeriod}</span></div>
      <div className="commission-rule-layout">
        <form className="member-entry-form commission-rule-form" onSubmit={submitRule}>
          <label><span>教练</span><input list="commission-coaches" value={form.coach} onChange={(event) => setForm((current) => ({ ...current, coach: event.target.value }))} required placeholder="例如：陈教练" /><datalist id="commission-coaches">{coaches.map((coach) => <option value={coach} key={coach} />)}</datalist></label>
          <label><span>计提口径</span><select value={form.basis} onChange={(event) => setForm((current) => ({ ...current, basis: event.target.value }))}>{Object.entries(COMMISSION_RULE_BASE_DEFINITIONS).map(([value, definition]) => <option value={value} key={value}>{definition.label}</option>)}</select></label>
          <label><span>计算方式</span><select value={form.method} onChange={(event) => setForm((current) => ({ ...current, method: event.target.value }))}><option value={COMMISSION_RULE_METHODS.PERCENTAGE}>按金额比例</option><option value={COMMISSION_RULE_METHODS.FIXED}>固定金额</option></select></label>
          {form.method === COMMISSION_RULE_METHODS.PERCENTAGE
            ? <label><span>提成比例（%）</span><input type="number" min="0.01" max="100" step="0.01" value={form.rate} onChange={(event) => setForm((current) => ({ ...current, rate: event.target.value }))} required /></label>
            : <label><span>固定金额 / {COMMISSION_RULE_BASE_DEFINITIONS[form.basis].fixedUnit}</span><input type="number" min="0.01" step="0.01" value={form.fixedAmount} onChange={(event) => setForm((current) => ({ ...current, fixedAmount: event.target.value }))} required /></label>}
          <div className="commission-rule-explanation"><strong>{COMMISSION_RULE_BASE_DEFINITIONS[form.basis].label}</strong><small>{COMMISSION_RULE_BASE_DEFINITIONS[form.basis].description}；固定金额按每{COMMISSION_RULE_BASE_DEFINITIONS[form.basis].fixedUnit}计算。</small></div>
          <div className="commission-rule-form-actions"><button className="primary-button" type="submit">{form.id ? "保存修改" : "保存规则"}</button>{form.id && <button className="soft-button" type="button" onClick={() => setForm(emptyCommissionRule(form.coach))}>取消编辑</button>}</div>
        </form>

        <div className="commission-rule-list">
          {calculations.length ? calculations.map((calculation) => {
            const { rule } = calculation;
            const basis = COMMISSION_RULE_BASE_DEFINITIONS[rule.basis];
            return <article className={rule.enabled === false ? "disabled" : ""} key={rule.id}>
              <div className="commission-rule-head"><div><span>{basis.label}</span><strong>{rule.coach}</strong><small>{commissionRuleSummary(rule)}</small></div><div><button className="soft-button" type="button" onClick={() => editRule(rule)}>编辑</button><button className="soft-button" type="button" onClick={() => toggleRule(rule)}>{rule.enabled === false ? "启用" : "停用"}</button></div></div>
              <div className="commission-rule-metrics"><span><small>待计提来源</small><strong>{calculation.sourceCount} 项</strong></span><span><small>计提基数</small><strong>{formatCurrency(calculation.baseAmount)}</strong></span><span><small>本期应计</small><strong>{formatCurrency(calculation.commissionAmount)}</strong></span><span><small>本期已计提</small><strong>{formatCurrency(calculation.accruedAmount)}</strong></span></div>
              <details open={calculation.pendingLines.length > 0}>
                <summary>查看本期计算明细 · {calculation.lines.length} 项</summary>
                <div className="commission-calculation-list">{calculation.lines.length ? calculation.lines.map((line) => <div key={line.sourceId}><span><strong>{line.date} · {line.label}</strong><small>{commissionLineFormula(rule, line)}</small></span><span><strong>{formatCurrency(line.commissionAmount)}</strong><small>{line.alreadyAccrued ? "已计提" : "待确认"}</small></span></div>) : <p>本期暂无可归属到该教练的真实来源。</p>}</div>
              </details>
              <button className="primary-button wide" type="button" disabled={rule.enabled === false || !calculation.pendingLines.length} onClick={() => accrueRule(rule, calculation)}>确认计提 {formatCurrency(calculation.commissionAmount)}</button>
            </article>;
          }) : <div className="member-empty"><CurrencyCircleDollar size={26} /><strong>还没有提成规则</strong><span>先设置教练、计提口径与比例或固定金额。</span></div>}
        </div>
      </div>
      {feedback && <p className={`commission-rule-feedback ${feedback.tone}`}>{feedback.message}</p>}
    </section>
  );
}

function MemberServiceReconciliationPanel({ reconciliation }) {
  const statusLabel = !reconciliation.applicable
    ? "不适用"
    : reconciliation.passed ? "勾稽通过" : "存在差额";
  return (
    <section className="panel member-reconciliation-panel">
      <div className="panel-heading"><div><p className="eyebrow">会员未履约服务勾稽</p><h2>会员台账与合同负债</h2><p>结果完全由会员业务和已入账凭证计算；异常项不能手工改成通过。</p></div><span className={`tone-pill ${reconciliation.passed ? "success" : "warning"}`}>{statusLabel}</span></div>
      <div className="member-reconciliation-metrics">
        <span><small>会员未履约余额</small><strong>{formatCurrency(reconciliation.memberBalance)}</strong></span>
        <span><small>已入账合同负债</small><strong>{formatCurrency(reconciliation.contractLiabilityBalance)}</strong></span>
        <span><small>勾稽差额</small><strong>{formatCurrency(reconciliation.difference)}</strong></span>
        <span><small>系统结果</small><strong>{statusLabel}</strong></span>
      </div>
      <div className={`member-reconciliation-result ${reconciliation.passed ? "success" : "danger"}`}>
        {reconciliation.passed ? <CheckCircle size={18} weight="fill" /> : <WarningCircle size={18} weight="fill" />}
        <span><strong>{reconciliation.message}</strong><small>{reconciliation.passed ? "来源或凭证变化后会自动重新计算。" : "已生成系统派生异常；补做或修订凭证并入账后，差额归零才会自动恢复通过。"}</small></span>
      </div>
      <div className="member-reconciliation-table">
        <div className="member-reconciliation-row heading"><span>会员</span><span>累计充值</span><span>已确认收入</span><span>已退款</span><span>剩余课时</span><span>未履约余额</span></div>
        {reconciliation.members.length ? reconciliation.members.map((member) => <div className="member-reconciliation-row" key={member.id}><span><strong>{member.name}</strong><small>{member.sourceIds.length} 项已确认来源</small></span><span>{formatCurrency(member.recharged)}</span><span>{formatCurrency(member.recognizedRevenue)}</span><span>{formatCurrency(member.refunded)}</span><span>{member.remainingSessions} 节</span><span><strong>{formatCurrency(member.unfulfilledBalance)}</strong></span></div>) : <p className="member-reconciliation-empty">当前没有会员台账数据。</p>}
      </div>
      <details open={!reconciliation.passed} className="member-reconciliation-sources">
        <summary>查看两侧来源明细 · 会员 {reconciliation.memberSources.length} 项 / 凭证 {reconciliation.accountingSources.length} 项</summary>
        <div>
          <section><h3>会员业务来源</h3>{reconciliation.memberSources.length ? reconciliation.memberSources.map((source) => <div key={source.id}><span><strong>{source.date} · {source.memberName}</strong><small>{source.label} · {source.id}</small></span><strong>{source.balanceEffect >= 0 ? "+" : ""}{formatCurrency(source.balanceEffect)}</strong></div>) : <p>暂无已确认的充值、耗课或退款。</p>}</section>
          <section><h3>合同负债来源</h3>{reconciliation.accountingSources.length ? reconciliation.accountingSources.map((source) => <div key={source.id}><span><strong>{source.date || "期初"} · {source.label}</strong><small>{source.reference}</small></span><strong>{source.balanceEffect >= 0 ? "+" : ""}{formatCurrency(source.balanceEffect)}</strong></div>) : <p>暂无已入账合同负债来源。</p>}</section>
        </div>
      </details>
    </section>
  );
}

function EventForm({ workspace, members, onSubmit }) {
  const [form, setForm] = useState({ kind: MEMBER_EVENT_KINDS.RECHARGE, memberId: members[0]?.id || "", originalRechargeId: "", date: today(), amount: "", quantity: "", coach: members[0]?.coach || "", note: "" });
  const definition = MEMBER_EVENT_DEFINITIONS[form.kind];
  const needsMember = form.kind !== MEMBER_EVENT_KINDS.COMMISSION;
  const refundOptions = useMemo(() => buildRechargeRefundOptions(workspace, form.memberId)
    .filter((option) => option.refundableAmount > 0 && option.refundableSessions > 0), [workspace, form.memberId]);
  const selectedRecharge = refundOptions.find((option) => option.rechargeId === form.originalRechargeId);

  function changeMember(memberId) {
    const member = members.find((item) => item.id === memberId);
    setForm((current) => ({ ...current, memberId, originalRechargeId: "", coach: member?.coach || current.coach }));
  }

  function changeKind(kind) {
    const member = members.find((item) => item.id === form.memberId) || members[0];
    setForm((current) => ({ ...current, kind, memberId: member?.id || "", originalRechargeId: "", coach: kind === MEMBER_EVENT_KINDS.COMMISSION ? current.coach : (member?.coach || "") }));
  }

  function submit(event) {
    event.preventDefault();
    const saved = onSubmit(form);
    if (saved === false) return;
    setForm((current) => ({ ...current, originalRechargeId: "", amount: "", quantity: "", note: "" }));
  }

  return (
    <section className="panel member-entry-panel">
      <div className="panel-heading"><div><p className="eyebrow">新增业务</p><h2>记录会员动作</h2></div><Plus size={21} /></div>
      <form className="member-entry-form" onSubmit={submit}>
        <label><span>业务类型</span><select value={form.kind} onChange={(event) => changeKind(event.target.value)}>{Object.entries(MEMBER_EVENT_DEFINITIONS).filter(([, item]) => item.creatable !== false).map(([value, item]) => <option value={value} key={value}>{item.label}</option>)}</select></label>
        {needsMember && <label><span>会员</span><select value={form.memberId} onChange={(event) => changeMember(event.target.value)} required><option value="">请选择会员</option>{members.map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}</select></label>}
        {form.kind === MEMBER_EVENT_KINDS.REFUND && <label className="full"><span>原充值</span><select value={form.originalRechargeId} onChange={(event) => setForm((current) => ({ ...current, originalRechargeId: event.target.value }))} required><option value="">请选择本次退款对应的原充值</option>{refundOptions.map((option) => <option value={option.rechargeId} key={option.rechargeId}>{option.date} · 原充值 {formatCurrency(option.amount)} / {option.sessions} 节 · 可退 {formatCurrency(option.refundableAmount)} / {option.refundableSessions} 节</option>)}</select>{selectedRecharge && <small>按充值日期先进先出分摊已耗课；本笔最多可退 {formatCurrency(selectedRecharge.refundableAmount)}、{selectedRecharge.refundableSessions} 节。</small>}{!refundOptions.length && <small>该会员暂无同时具备可退金额和课时的已确认充值。</small>}</label>}
        <label><span>业务日期</span><input type="date" value={form.date} onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))} required /></label>
        <label><span>{form.kind === MEMBER_EVENT_KINDS.COMMISSION ? "涉及耗课数（选填）" : "课时"}</span><input type="number" min={form.kind === MEMBER_EVENT_KINDS.COMMISSION ? "0" : "0.01"} max={form.kind === MEMBER_EVENT_KINDS.REFUND ? selectedRecharge?.refundableSessions : undefined} step="0.01" value={form.quantity} onChange={(event) => setForm((current) => ({ ...current, quantity: event.target.value }))} required={form.kind !== MEMBER_EVENT_KINDS.COMMISSION} /></label>
        <label><span>{form.kind === MEMBER_EVENT_KINDS.COMMISSION ? "提成金额" : "金额"}</span><input type="number" min="0.01" max={form.kind === MEMBER_EVENT_KINDS.REFUND ? selectedRecharge?.refundableAmount : undefined} step="0.01" value={form.amount} onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))} required /></label>
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
  const { actions, store } = useFinanceDesk();
  const ledger = useMemo(() => buildMemberLedger(workspace, { period: workspace.currentPeriod }), [workspace]);
  const reconciliation = useMemo(() => buildMemberServiceReconciliation(workspace, {
    period: workspace.currentPeriod,
  }), [workspace]);
  useEffect(() => {
    const current = store.getActiveWorkspace();
    const next = synchronizeMemberServiceException(current, { period: current.currentPeriod });
    if (next !== current) actions.replaceWorkspace(current.id, next);
  }, [actions, store, workspace]);
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

      <CommissionRulesPanel workspace={workspace} />

      <div className="member-entry-layout">
        <EventForm workspace={workspace} members={ledger.members} onSubmit={onAddEvent} />
        <MemberForm onSubmit={onAddMember} />
      </div>

      <section className="panel member-balance-panel">
        <div className="panel-heading"><div><p className="eyebrow">会员余额</p><h2>剩余课时与未履约金额</h2></div><span>{ledger.members.length} 名</span></div>
        {ledger.members.length ? <div className="member-card-grid">{ledger.members.map((member) => <article className="member-balance-card" key={member.id}>
          <div className="member-card-head"><span className="member-avatar">{member.name.slice(0, 1)}</span><div><strong>{member.name}</strong><small>{member.phone || "未留联系方式"} · {member.coach || "未分配教练"}</small></div></div>
          <div className="member-balance-values"><span><small>累计充值</small><strong>{formatCurrency(member.recharged)}</strong></span><span><small>已确认收入</small><strong>{formatCurrency(member.recognizedRevenue)}</strong></span><span><small>已退款</small><strong>{formatCurrency(member.refunded)}</strong></span><span><small>剩余课时</small><strong>{member.remainingSessions} 节</strong></span><span className="primary"><small>未履约余额</small><strong>{formatCurrency(member.unfulfilledBalance)}</strong></span></div>
          <div className="member-card-foot"><span>已耗 {member.consumedSessions} 节 · 已退 {formatCurrency(member.refunded)}</span><label><span>状态</span><select value={normalizedMemberStatus(member.status)} onChange={(event) => onMemberStatus(member.id, event.target.value)}>{MEMBER_STATUS_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label></div>
        </article>)}</div> : <div className="member-empty"><UsersThree size={26} /><strong>还没有会员</strong><span>先新增会员，再记录充值或耗课。</span></div>}
      </section>

      <MemberServiceReconciliationPanel reconciliation={reconciliation} />

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
