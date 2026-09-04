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
  MEMBERSHIP_PACKAGE_DISCOUNT_DEFINITIONS,
  MEMBERSHIP_PACKAGE_DISCOUNT_TYPES,
  MEMBER_EVENT_DEFINITIONS,
  MEMBER_EVENT_KINDS,
  MEMBER_STATUS_OPTIONS,
  buildCommissionRuleCalculation,
  buildMemberLedger,
  buildMemberPackageBalances,
  buildMemberServiceReconciliation,
  buildRechargeRefundOptions,
  confirmCommissionAccrual,
  calculateMembershipConsumptionAmount,
  memberEventActions,
  memberEventKind,
  memberEventStatusLabel,
  membershipPackagePrice,
  normalizedEventStatus,
  normalizedMemberStatus,
  saveCommissionRule,
  saveMembershipPackage,
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

const DEFAULT_TERMINOLOGY = Object.freeze({
  customer: "客户",
  supplier: "供应商",
  personnel: "员工",
  location: "门店",
  member: "会员",
  coach: "教练",
  service: "服务",
});

function workspaceTerminology(workspace) {
  return Object.fromEntries(Object.entries(DEFAULT_TERMINOLOGY).map(([key, fallback]) => [
    key,
    String(workspace?.terminology?.[key] || "").trim() || fallback,
  ]));
}

function memberRoleCopy(value, terminology) {
  return String(value || "")
    .replaceAll("会员", terminology.member)
    .replaceAll("教练", terminology.coach)
    .replaceAll("门店", terminology.location);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function defaultDimensions(workspace, member = null) {
  const defaultStore = (workspace.stores || []).find((store) => store.status !== "inactive") || workspace.stores?.[0];
  return {
    storeId: member?.storeId || defaultStore?.id || "",
    coach: member?.coach || "",
    department: member?.department || "",
    project: member?.project || "",
  };
}

function Metric({ label, value, note, icon: Icon }) {
  return <article className="member-metric"><span><Icon size={20} /></span><div><small>{label}</small><strong>{value}</strong><p>{note}</p></div></article>;
}

function emptyMembershipPackage() {
  return {
    id: "",
    name: "",
    listPrice: "",
    totalSessions: "",
    validityDays: "",
    discountType: MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.NONE,
    discountValue: "",
  };
}

function membershipPackageDiscountLabel(packageRule) {
  if (packageRule.discountType === MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.PERCENTAGE) {
    return "优惠 " + packageRule.discountValue + "%";
  }
  if (packageRule.discountType === MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.FIXED) {
    return "减免 " + formatCurrency(packageRule.discountValue);
  }
  return "无折扣";
}

function MembershipPackagesPanel({ workspace }) {
  const { actions, state, store } = useFinanceDesk();
  const terminology = workspaceTerminology(workspace);
  const [form, setForm] = useState(emptyMembershipPackage);
  const [feedback, setFeedback] = useState(null);
  const packages = workspace.membershipPackages || [];
  const actor = workspace.users?.find((user) => user.id === state.activeUserId)?.name || "本地用户";
  const previewPrice = membershipPackagePrice(form);

  useEffect(() => {
    setForm(emptyMembershipPackage());
    setFeedback(null);
  }, [workspace.id]);

  function run(change, successMessage) {
    setFeedback(null);
    try {
      const current = store.getActiveWorkspace();
      const next = change(current);
      actions.replaceWorkspace(current.id, next);
      setFeedback({ tone: "success", message: successMessage });
      return true;
    } catch (error) {
      setFeedback({ tone: "danger", message: memberRoleCopy(error.message || `${terminology.member}套餐处理失败`, terminology) });
      return false;
    }
  }

  function submitPackage(event) {
    event.preventDefault();
    if (run(
      (current) => saveMembershipPackage(current, form, { actor }),
      form.id ? `${terminology.member}套餐已更新；既往充值仍保留原套餐快照` : `${terminology.member}套餐已保存到当前工作台`,
    )) setForm(emptyMembershipPackage());
  }

  function editPackage(packageRule) {
    setFeedback(null);
    setForm({
      id: packageRule.id,
      name: packageRule.name,
      listPrice: packageRule.listPrice,
      totalSessions: packageRule.totalSessions,
      validityDays: packageRule.validityDays,
      discountType: packageRule.discountType,
      discountValue: packageRule.discountValue || "",
    });
  }

  function togglePackage(packageRule) {
    run(
      (current) => saveMembershipPackage(current, {
        ...packageRule,
        enabled: packageRule.enabled === false,
      }, { actor }),
      packageRule.enabled === false ? `${terminology.member}套餐已启用` : `${terminology.member}套餐已停用`,
    );
  }

  return (
    <section className="panel membership-packages-panel">
      <div className="panel-heading"><div><p className="eyebrow">{terminology.member}套餐与价格</p><h2>建立可复用的充值规则</h2><p>套餐修改只影响以后充值；每笔{terminology.member}充值都会保留当时的价格、课时、折扣和有效期快照。</p></div><span>{packages.length} 个套餐</span></div>
      <form className="member-entry-form membership-package-form" onSubmit={submitPackage}>
        <label><span>套餐名称</span><input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required placeholder={`例如：${terminology.service}标准套餐`} /></label>
        <label><span>挂牌售价</span><input type="number" min="0.01" step="0.01" value={form.listPrice} onChange={(event) => setForm((current) => ({ ...current, listPrice: event.target.value }))} required /></label>
        <label><span>总课时</span><input type="number" min="0.01" step="0.01" value={form.totalSessions} onChange={(event) => setForm((current) => ({ ...current, totalSessions: event.target.value }))} required /></label>
        <label><span>有效期（天）</span><input type="number" min="1" step="1" value={form.validityDays} onChange={(event) => setForm((current) => ({ ...current, validityDays: event.target.value }))} required /></label>
        <label><span>折扣规则</span><select value={form.discountType} onChange={(event) => setForm((current) => ({ ...current, discountType: event.target.value, discountValue: "" }))}>{Object.entries(MEMBERSHIP_PACKAGE_DISCOUNT_DEFINITIONS).map(([value, definition]) => <option value={value} key={value}>{definition.label}</option>)}</select></label>
        {form.discountType !== MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.NONE && <label><span>{form.discountType === MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.PERCENTAGE ? "优惠比例（%）" : "固定减免金额"}</span><input type="number" min="0.01" max={form.discountType === MEMBERSHIP_PACKAGE_DISCOUNT_TYPES.PERCENTAGE ? "99.99" : undefined} step="0.01" value={form.discountValue} onChange={(event) => setForm((current) => ({ ...current, discountValue: event.target.value }))} required /></label>}
        <div className="membership-package-preview"><span><small>本次规则售价</small><strong>{formatCurrency(previewPrice)}</strong></span><span><small>单课参考价</small><strong>{formatCurrency(Number(form.totalSessions) > 0 ? previewPrice / Number(form.totalSessions) : 0)}</strong></span></div>
        <div className="commission-rule-form-actions"><button className="primary-button" type="submit">{form.id ? "保存套餐修改" : "保存套餐"}</button>{form.id && <button className="soft-button" type="button" onClick={() => setForm(emptyMembershipPackage())}>取消编辑</button>}</div>
      </form>
      <div className="membership-package-rule-list">
        {packages.length ? packages.map((packageRule) => <article className={packageRule.enabled === false ? "disabled" : ""} key={packageRule.id}><div><span>{packageRule.enabled === false ? "已停用" : "可充值"}</span><strong>{packageRule.name}</strong><small>{membershipPackageDiscountLabel(packageRule)} · 有效 {packageRule.validityDays} 天</small></div><div><span><small>挂牌售价</small><strong>{formatCurrency(packageRule.listPrice)}</strong></span><span><small>实际售价</small><strong>{formatCurrency(packageRule.salePrice)}</strong></span><span><small>总课时</small><strong>{packageRule.totalSessions} 节</strong></span></div><footer><button className="soft-button" type="button" onClick={() => editPackage(packageRule)}>编辑</button><button className="soft-button" type="button" onClick={() => togglePackage(packageRule)}>{packageRule.enabled === false ? "启用" : "停用"}</button></footer></article>) : <p className="membership-package-empty">还没有{terminology.member}套餐。先保存套餐，才能新增{terminology.member}充值。</p>}
      </div>
      {feedback && <p className={"commission-rule-feedback " + feedback.tone}>{feedback.message}</p>}
    </section>
  );
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
  const terminology = workspaceTerminology(workspace);
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

  useEffect(() => {
    setForm(emptyCommissionRule(coaches[0] || ""));
    setFeedback(null);
  }, [workspace.id, workspace.currentPeriod]);

  function run(change, successMessage) {
    setFeedback(null);
    try {
      const current = store.getActiveWorkspace();
      const next = change(current);
      actions.replaceWorkspace(current.id, next);
      setFeedback({ tone: "success", message: successMessage });
      return true;
    } catch (error) {
      setFeedback({ tone: "danger", message: memberRoleCopy(error.message || "提成规则处理失败", terminology) });
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
      <div className="panel-heading"><div><p className="eyebrow">{terminology.coach}提成规则</p><h2>按真实业务来源计算本期应计</h2><p>规则和计提结果保存在当前工作台；同一来源一经确认，不会再次进入待计提金额。</p></div><span>{workspace.currentPeriod}</span></div>
      <div className="commission-rule-layout">
        <form className="member-entry-form commission-rule-form" onSubmit={submitRule}>
          <label><span>{terminology.coach}</span><input list="commission-coaches" value={form.coach} onChange={(event) => setForm((current) => ({ ...current, coach: event.target.value }))} required placeholder={`填写${terminology.coach}姓名或标识`} /><datalist id="commission-coaches">{coaches.map((coach) => <option value={coach} key={coach} />)}</datalist></label>
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
                <div className="commission-calculation-list">{calculation.lines.length ? calculation.lines.map((line) => <div key={line.sourceId}><span><strong>{line.date} · {memberRoleCopy(line.label, terminology)}</strong><small>{commissionLineFormula(rule, line)}</small></span><span><strong>{formatCurrency(line.commissionAmount)}</strong><small>{line.alreadyAccrued ? "已计提" : "待确认"}</small></span></div>) : <p>本期暂无可归属到该{terminology.coach}的真实来源。</p>}</div>
              </details>
              <button className="primary-button wide" type="button" disabled={rule.enabled === false || !calculation.pendingLines.length} onClick={() => accrueRule(rule, calculation)}>确认计提 {formatCurrency(calculation.commissionAmount)}</button>
            </article>;
          }) : <div className="member-empty"><CurrencyCircleDollar size={26} /><strong>还没有提成规则</strong><span>先设置{terminology.coach}、计提口径与比例或固定金额。</span></div>}
        </div>
      </div>
      {feedback && <p className={`commission-rule-feedback ${feedback.tone}`}>{feedback.message}</p>}
    </section>
  );
}

function MemberServiceReconciliationPanel({ reconciliation, terminology }) {
  const statusLabel = !reconciliation.applicable
    ? "不适用"
    : reconciliation.passed ? "勾稽通过" : "存在差额";
  return (
    <section className="panel member-reconciliation-panel">
      <div className="panel-heading"><div><p className="eyebrow">{terminology.member}未履约{terminology.service}勾稽</p><h2>{terminology.member}台账与合同负债</h2><p>结果完全由{terminology.member}业务和已入账凭证计算；异常项不能手工改成通过。</p></div><span className={`tone-pill ${reconciliation.passed ? "success" : "warning"}`}>{statusLabel}</span></div>
      <div className="member-reconciliation-metrics">
        <span><small>{terminology.member}未履约余额</small><strong>{formatCurrency(reconciliation.memberBalance)}</strong></span>
        <span><small>已入账合同负债</small><strong>{formatCurrency(reconciliation.contractLiabilityBalance)}</strong></span>
        <span><small>勾稽差额</small><strong>{formatCurrency(reconciliation.difference)}</strong></span>
        <span><small>系统结果</small><strong>{statusLabel}</strong></span>
      </div>
      <div className={`member-reconciliation-result ${reconciliation.passed ? "success" : "danger"}`}>
        {reconciliation.passed ? <CheckCircle size={18} weight="fill" /> : <WarningCircle size={18} weight="fill" />}
        <span><strong>{memberRoleCopy(reconciliation.message, terminology)}</strong><small>{reconciliation.passed ? "来源或凭证变化后会自动重新计算。" : "已生成系统派生异常；补做或修订凭证并入账后，差额归零才会自动恢复通过。"}</small></span>
      </div>
      <div className="member-reconciliation-table">
        <div className="member-reconciliation-row heading"><span>{terminology.member}</span><span>累计充值</span><span>已确认收入</span><span>已退款</span><span>剩余课时</span><span>未履约余额</span></div>
        {reconciliation.members.length ? reconciliation.members.map((member) => <div className="member-reconciliation-row" key={member.id}><span><strong>{member.name}</strong><small>{member.sourceIds.length} 项已确认来源</small></span><span>{formatCurrency(member.recharged)}</span><span>{formatCurrency(member.recognizedRevenue)}</span><span>{formatCurrency(member.refunded)}</span><span>{member.remainingSessions} 节</span><span><strong>{formatCurrency(member.unfulfilledBalance)}</strong></span></div>) : <p className="member-reconciliation-empty">当前没有{terminology.member}台账数据。</p>}
      </div>
      <details open={!reconciliation.passed} className="member-reconciliation-sources">
        <summary>查看两侧来源明细 · {terminology.member} {reconciliation.memberSources.length} 项 / 凭证 {reconciliation.accountingSources.length} 项</summary>
        <div>
          <section><h3>{terminology.member}业务来源</h3>{reconciliation.memberSources.length ? reconciliation.memberSources.map((source) => <div key={source.id}><span><strong>{source.date} · {source.memberName}</strong><small>{memberRoleCopy(source.label, terminology)} · {source.id}</small></span><strong>{source.balanceEffect >= 0 ? "+" : ""}{formatCurrency(source.balanceEffect)}</strong></div>) : <p>暂无已确认的充值、耗课或退款。</p>}</section>
          <section><h3>合同负债来源</h3>{reconciliation.accountingSources.length ? reconciliation.accountingSources.map((source) => <div key={source.id}><span><strong>{source.date || "期初"} · {source.label}</strong><small>{source.reference}</small></span><strong>{source.balanceEffect >= 0 ? "+" : ""}{formatCurrency(source.balanceEffect)}</strong></div>) : <p>暂无已入账合同负债来源。</p>}</section>
        </div>
      </details>
    </section>
  );
}

function MemberPackageBalancesPanel({ packageBalances, terminology }) {
  return (
    <section className="panel member-package-balances-panel">
      <div className="panel-heading"><div><p className="eyebrow">{terminology.member}已购套餐</p><h2>逐笔查看课时、有效期与未履约余额</h2></div><span>{packageBalances.length} 个</span></div>
      {packageBalances.length ? <div className="member-package-balance-table">
        <div className="member-package-balance-row heading"><span>{terminology.member} / 套餐</span><span>原始课时</span><span>已耗</span><span>剩余</span><span>到期日</span><span>未履约余额</span></div>
        {packageBalances.map((packageBalance) => <div className="member-package-balance-row" key={packageBalance.rechargeEventId}>
          <span><strong>{packageBalance.memberName} · {packageBalance.packageName}</strong><small>{packageBalance.purchasedAt} 充值 · {packageBalance.rechargeEventId}</small></span>
          <span>{packageBalance.originalSessions} 节</span>
          <span>{packageBalance.consumedSessions} 节</span>
          <span><strong>{packageBalance.remainingSessions} 节</strong>{packageBalance.refundedSessions > 0 && <small>另退款 {packageBalance.refundedSessions} 节</small>}</span>
          <span><strong>{packageBalance.expiresAt}</strong><small>{packageBalance.expired ? "已过期，不可耗课" : "有效"}</small></span>
          <span><strong>{formatCurrency(packageBalance.unfulfilledBalance)}</strong></span>
        </div>)}
      </div> : <div className="member-empty"><Clock size={26} /><strong>还没有已确认的套餐充值</strong><span>{terminology.member}充值确认后会在这里形成独立套餐余额。</span></div>}
    </section>
  );
}

function EventForm({ workspace, members, onSubmit }) {
  const terminology = workspaceTerminology(workspace);
  const [form, setForm] = useState({ kind: MEMBER_EVENT_KINDS.RECHARGE, memberId: members[0]?.id || "", packageId: "", packageRechargeId: "", originalRechargeId: "", date: today(), amount: "", quantity: "", ...defaultDimensions(workspace, members[0]), note: "" });
  const definition = MEMBER_EVENT_DEFINITIONS[form.kind];
  const needsMember = form.kind !== MEMBER_EVENT_KINDS.COMMISSION;
  const enabledPackages = (workspace.membershipPackages || []).filter((packageRule) => packageRule.enabled !== false);
  const selectedPackage = enabledPackages.find((packageRule) => packageRule.id === form.packageId);
  const availableMemberPackages = useMemo(() => buildMemberPackageBalances(workspace, form.memberId, {
    asOfDate: form.date,
  }).filter((packageBalance) => !packageBalance.expired && packageBalance.remainingSessions > 0 && packageBalance.unfulfilledBalance > 0), [workspace, form.memberId, form.date]);
  const selectedMemberPackage = availableMemberPackages.find((packageBalance) => packageBalance.rechargeEventId === form.packageRechargeId);
  const consumptionPreviewAmount = selectedMemberPackage && Number(form.quantity) > 0
    ? calculateMembershipConsumptionAmount(selectedMemberPackage, form.quantity)
    : 0;
  const refundOptions = useMemo(() => buildRechargeRefundOptions(workspace, form.memberId)
    .filter((option) => option.refundableAmount > 0 && option.refundableSessions > 0), [workspace, form.memberId]);
  const selectedRecharge = refundOptions.find((option) => option.rechargeId === form.originalRechargeId);

  useEffect(() => {
    setForm({ kind: MEMBER_EVENT_KINDS.RECHARGE, memberId: members[0]?.id || "", packageId: "", packageRechargeId: "", originalRechargeId: "", date: today(), amount: "", quantity: "", ...defaultDimensions(workspace, members[0]), note: "" });
  }, [workspace.id, workspace.currentPeriod]);

  function changeMember(memberId) {
    const member = members.find((item) => item.id === memberId);
    setForm((current) => ({ ...current, memberId, packageRechargeId: "", originalRechargeId: "", ...defaultDimensions(workspace, member) }));
  }

  function changeKind(kind) {
    const member = members.find((item) => item.id === form.memberId) || members[0];
    setForm((current) => ({ ...current, kind, memberId: member?.id || "", packageId: "", packageRechargeId: "", originalRechargeId: "", amount: "", quantity: "", ...(kind === MEMBER_EVENT_KINDS.COMMISSION ? {} : defaultDimensions(workspace, member)) }));
  }

  function submit(event) {
    event.preventDefault();
    const saved = onSubmit(form);
    if (saved === false) return;
    setForm((current) => ({ ...current, packageId: "", packageRechargeId: "", originalRechargeId: "", amount: "", quantity: "", note: "" }));
  }

  return (
    <section className="panel member-entry-panel">
      <div className="panel-heading"><div><p className="eyebrow">新增业务</p><h2>记录{terminology.member}动作</h2></div><Plus size={21} /></div>
      <form className="member-entry-form" onSubmit={submit}>
        <label><span>业务类型</span><select value={form.kind} onChange={(event) => changeKind(event.target.value)}>{Object.entries(MEMBER_EVENT_DEFINITIONS).filter(([, item]) => item.creatable !== false).map(([value, item]) => <option value={value} key={value}>{memberRoleCopy(item.label, terminology)}</option>)}</select></label>
        {needsMember && <label><span>{terminology.member}</span><select value={form.memberId} onChange={(event) => changeMember(event.target.value)} required><option value="">请选择{terminology.member}</option>{members.map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}</select></label>}
        {form.kind === MEMBER_EVENT_KINDS.RECHARGE && (
          <label className="full">
            <span>充值套餐</span>
            <select value={form.packageId} onChange={(event) => setForm((current) => ({ ...current, packageId: event.target.value }))} required>
              <option value="">请选择{terminology.member}套餐</option>
              {enabledPackages.map((packageRule) => <option value={packageRule.id} key={packageRule.id}>{packageRule.name} · {packageRule.totalSessions} 节 · {formatCurrency(packageRule.salePrice)} · {packageRule.validityDays} 天</option>)}
            </select>
            {!enabledPackages.length && <small>请先在上方建立并启用{terminology.member}套餐。</small>}
          </label>
        )}
        {form.kind === MEMBER_EVENT_KINDS.CONSUMPTION && (
          <label className="full">
            <span>使用套餐</span>
            <select value={form.packageRechargeId} onChange={(event) => setForm((current) => ({ ...current, packageRechargeId: event.target.value }))} required>
              <option value="">请选择本次耗课使用的有效套餐</option>
              {availableMemberPackages.map((packageBalance) => <option value={packageBalance.rechargeEventId} key={packageBalance.rechargeEventId}>{packageBalance.packageName} · 剩余 {packageBalance.remainingSessions} 节 / {formatCurrency(packageBalance.unfulfilledBalance)} · {packageBalance.expiresAt} 到期</option>)}
            </select>
            {selectedMemberPackage && <small>本次收入按该套餐当前未履约余额与剩余课时同比计算。</small>}
            {!availableMemberPackages.length && <small>该{terminology.member}在所选日期没有可用且未过期的套餐。</small>}
          </label>
        )}
        {form.kind === MEMBER_EVENT_KINDS.REFUND && <label className="full"><span>原充值</span><select value={form.originalRechargeId} onChange={(event) => setForm((current) => ({ ...current, originalRechargeId: event.target.value }))} required><option value="">请选择本次退款对应的原充值</option>{refundOptions.map((option) => <option value={option.rechargeId} key={option.rechargeId}>{option.date} · 原充值 {formatCurrency(option.amount)} / {option.sessions} 节 · 可退 {formatCurrency(option.refundableAmount)} / {option.refundableSessions} 节</option>)}</select>{selectedRecharge && <small>按充值日期先进先出分摊已耗课；本笔最多可退 {formatCurrency(selectedRecharge.refundableAmount)}、{selectedRecharge.refundableSessions} 节。</small>}{!refundOptions.length && <small>该{terminology.member}暂无同时具备可退金额和课时的已确认充值。</small>}</label>}
        <label><span>业务日期</span><input type="date" value={form.date} onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))} required /></label>
        <label><span>{form.kind === MEMBER_EVENT_KINDS.COMMISSION ? "涉及耗课数（选填）" : form.kind === MEMBER_EVENT_KINDS.RECHARGE ? "套餐课时" : "课时"}</span><input type="number" min={form.kind === MEMBER_EVENT_KINDS.COMMISSION ? "0" : "0.01"} max={form.kind === MEMBER_EVENT_KINDS.REFUND ? selectedRecharge?.refundableSessions : form.kind === MEMBER_EVENT_KINDS.CONSUMPTION ? selectedMemberPackage?.remainingSessions : undefined} step="0.01" value={form.kind === MEMBER_EVENT_KINDS.RECHARGE ? selectedPackage?.totalSessions || "" : form.quantity} onChange={(event) => setForm((current) => ({ ...current, quantity: event.target.value }))} readOnly={form.kind === MEMBER_EVENT_KINDS.RECHARGE} required={form.kind !== MEMBER_EVENT_KINDS.COMMISSION} /></label>
        <label><span>{form.kind === MEMBER_EVENT_KINDS.COMMISSION ? "提成金额" : form.kind === MEMBER_EVENT_KINDS.RECHARGE ? "套餐售价" : form.kind === MEMBER_EVENT_KINDS.CONSUMPTION ? "本次确认收入" : "金额"}</span><input type="number" min="0.01" max={form.kind === MEMBER_EVENT_KINDS.REFUND ? selectedRecharge?.refundableAmount : undefined} step="0.01" value={form.kind === MEMBER_EVENT_KINDS.RECHARGE ? selectedPackage?.salePrice || "" : form.kind === MEMBER_EVENT_KINDS.CONSUMPTION ? consumptionPreviewAmount || "" : form.amount} onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))} readOnly={[MEMBER_EVENT_KINDS.RECHARGE, MEMBER_EVENT_KINDS.CONSUMPTION].includes(form.kind)} required /></label>
        <label><span>{terminology.coach}</span><input value={form.coach} onChange={(event) => setForm((current) => ({ ...current, coach: event.target.value }))} required={form.kind === MEMBER_EVENT_KINDS.COMMISSION} placeholder={`填写${terminology.coach}姓名或标识`} /></label>
        <label><span>归属{terminology.location}</span><select value={form.storeId} onChange={(event) => setForm((current) => ({ ...current, storeId: event.target.value }))}><option value="">未归属{terminology.location}</option>{(workspace.stores || []).map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label>
        <label><span>部门</span><input value={form.department} onChange={(event) => setForm((current) => ({ ...current, department: event.target.value }))} placeholder={`例如：${terminology.location}运营组`} /></label>
        <label><span>项目</span><input value={form.project} onChange={(event) => setForm((current) => ({ ...current, project: event.target.value }))} placeholder={`例如：${terminology.service}项目`} /></label>
        <p className="form-help dimension-help">{terminology.location}、{terminology.coach}、部门和项目默认带入{terminology.member}资料，本笔业务可单独调整并随事件保存。</p>
        <label className="full"><span>备注</span><textarea value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} placeholder={memberRoleCopy(definition.suggestedEntry, terminology)} /></label>
        <div className="member-accounting-hint"><CurrencyCircleDollar size={18} /><span><strong>{memberRoleCopy(definition.accountingLabel, terminology)}</strong><small>{memberRoleCopy(definition.suggestedEntry, terminology)}；确认业务后进入待会计处理状态。</small></span></div>
        <button className="primary-button wide" type="submit" disabled={(needsMember && members.length === 0) || (form.kind === MEMBER_EVENT_KINDS.RECHARGE && !selectedPackage) || (form.kind === MEMBER_EVENT_KINDS.CONSUMPTION && !selectedMemberPackage)}>新增待确认记录<ArrowRight size={16} /></button>
        {needsMember && members.length === 0 && <p className="form-help">请先在右侧新增{terminology.member}。</p>}
      </form>
    </section>
  );
}

function MemberForm({ workspace, onSubmit }) {
  const terminology = workspaceTerminology(workspace);
  const [form, setForm] = useState({ name: "", phone: "", ...defaultDimensions(workspace) });
  useEffect(() => {
    setForm({ name: "", phone: "", ...defaultDimensions(workspace) });
  }, [workspace.id]);
  function submit(event) {
    event.preventDefault();
    const saved = onSubmit(form);
    if (saved === false) return;
    setForm({ name: "", phone: "", ...defaultDimensions(workspace) });
  }
  return (
    <section className="panel member-create-panel">
      <div className="panel-heading"><div><p className="eyebrow">{terminology.member}资料</p><h2>新增{terminology.member}</h2></div><UserPlus size={21} /></div>
      <form className="member-entry-form compact" onSubmit={submit}>
        <label><span>{terminology.member}姓名</span><input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required placeholder={`填写${terminology.member}姓名或称呼`} /></label>
        <label><span>手机 / 联系方式</span><input value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} placeholder="选填" /></label>
        <label><span>负责{terminology.coach}</span><input value={form.coach} onChange={(event) => setForm((current) => ({ ...current, coach: event.target.value }))} placeholder={`填写负责${terminology.coach}（选填）`} /></label>
        <label><span>默认{terminology.location}</span><select value={form.storeId} onChange={(event) => setForm((current) => ({ ...current, storeId: event.target.value }))}><option value="">未归属{terminology.location}</option>{(workspace.stores || []).map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label>
        <label><span>默认部门</span><input value={form.department} onChange={(event) => setForm((current) => ({ ...current, department: event.target.value }))} placeholder={`例如：${terminology.location}运营组`} /></label>
        <label><span>默认项目</span><input value={form.project} onChange={(event) => setForm((current) => ({ ...current, project: event.target.value }))} placeholder={`例如：${terminology.service}项目`} /></label>
        <button className="secondary-button wide" type="submit"><UserPlus size={16} />保存{terminology.member}</button>
      </form>
    </section>
  );
}

export function MemberLedgerPage({ workspace, onAddMember, onMemberStatus, onAddEvent, onEventStatus }) {
  const { actions, store } = useFinanceDesk();
  const terminology = workspaceTerminology(workspace);
  const ledger = useMemo(() => buildMemberLedger(workspace, { period: workspace.currentPeriod }), [workspace]);
  const packageBalances = useMemo(() => buildMemberPackageBalances(workspace, null, {
    asOfDate: today(),
    period: workspace.currentPeriod,
  }), [workspace]);
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
        <div><p className="eyebrow">本地{terminology.member}业务台账</p><h2>从充值到耗课、退款与提成</h2><p>先记录业务，再确认状态。确认后的记录会更新课时与未履约余额，并成为待处理会计业务事件。</p></div>
        <span><CheckCircle size={22} weight="fill" />数据保存在当前工作台</span>
      </section>

      <section className="member-metric-grid">
        <Metric label={`在籍${terminology.member}`} value={`${ledger.totals.activeMembers} 人`} note={`共 ${ledger.members.length} 名${terminology.member}`} icon={UsersThree} />
        <Metric label="剩余课时" value={`${ledger.totals.remainingSessions} 节`} note="已确认充值 − 耗课 − 退款" icon={Clock} />
        <Metric label="未履约余额" value={formatCurrency(ledger.totals.unfulfilledBalance)} note={`${terminology.member}维度实时汇总`} icon={CurrencyCircleDollar} />
        <Metric label="待确认 / 待付提成" value={`${ledger.totals.pendingEvents} 笔`} note={`提成 ${formatCurrency(ledger.totals.commissionPayable)}`} icon={CheckCircle} />
      </section>

      <MembershipPackagesPanel workspace={workspace} />

      <CommissionRulesPanel workspace={workspace} />

      <div className="member-entry-layout">
        <EventForm workspace={workspace} members={ledger.members} onSubmit={onAddEvent} />
        <MemberForm workspace={workspace} onSubmit={onAddMember} />
      </div>

      <section className="panel member-balance-panel">
        <div className="panel-heading"><div><p className="eyebrow">{terminology.member}余额</p><h2>剩余课时与未履约金额</h2></div><span>{ledger.members.length} 名</span></div>
        {ledger.members.length ? <div className="member-card-grid">{ledger.members.map((member) => <article className="member-balance-card" key={member.id}>
          <div className="member-card-head"><span className="member-avatar">{member.name.slice(0, 1)}</span><div><strong>{member.name}</strong><small>{member.phone || "未留联系方式"} · {member.storeName || workspace.stores?.find((store) => store.id === member.storeId)?.name || `未归属${terminology.location}`} · {member.coach || `未分配${terminology.coach}`}</small><small>{[member.department, member.project].filter(Boolean).join(" · ") || "未设置部门 / 项目"}</small></div></div>
          <div className="member-balance-values"><span><small>累计充值</small><strong>{formatCurrency(member.recharged)}</strong></span><span><small>已确认收入</small><strong>{formatCurrency(member.recognizedRevenue)}</strong></span><span><small>已退款</small><strong>{formatCurrency(member.refunded)}</strong></span><span><small>剩余课时</small><strong>{member.remainingSessions} 节</strong></span><span className="primary"><small>未履约余额</small><strong>{formatCurrency(member.unfulfilledBalance)}</strong></span></div>
          <div className="member-card-foot"><span>已耗 {member.consumedSessions} 节 · 已退 {formatCurrency(member.refunded)}</span><label><span>状态</span><select value={normalizedMemberStatus(member.status)} onChange={(event) => onMemberStatus(member.id, event.target.value)}>{MEMBER_STATUS_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label></div>
        </article>)}</div> : <div className="member-empty"><UsersThree size={26} /><strong>还没有{terminology.member}</strong><span>先新增{terminology.member}，再记录充值或耗课。</span></div>}
      </section>

      <MemberPackageBalancesPanel packageBalances={packageBalances} terminology={terminology} />

      <MemberServiceReconciliationPanel reconciliation={reconciliation} terminology={terminology} />

      <section className="panel member-events-panel">
        <div className="panel-heading"><div><p className="eyebrow">业务流水</p><h2>{terminology.member}与{terminology.coach}事件</h2></div><span>{ledger.events.length} 笔</span></div>
        {ledger.events.length ? <div className="member-event-list">{ledger.events.map((event) => {
          const kind = memberEventKind(event);
          const definition = MEMBER_EVENT_DEFINITIONS[kind];
          const status = normalizedEventStatus(event);
          return <article className={status === "void" ? "void" : ""} key={event.id}>
            <div className="member-event-main"><span className={`member-event-mark ${kind}`} /><span><strong>{memberRoleCopy(definition.label, terminology)} · {event.memberName || event.coach}</strong><small>{event.date} · {event.storeName || workspace.stores?.find((store) => store.id === event.storeId)?.name || `未归属${terminology.location}`} · {event.coach || `未记录${terminology.coach}`}</small><small>{[event.department, event.project, event.note].filter(Boolean).join(" · ") || "未记录部门 / 项目"}</small></span></div>
            <span className="member-event-quantity"><small>课时</small><strong>{Number(event.quantity || 0)} 节</strong></span>
            <span className="member-event-amount"><small>金额</small><strong>{formatCurrency(event.amount)}</strong></span>
            <span className="member-event-accounting"><small>会计事件</small><strong>{memberRoleCopy(event.accountingLabel || definition.accountingLabel, terminology)}</strong><em>{event.accountingStatus === "ready" ? "待会计处理" : event.accountingStatus === "void" ? "已作废" : "随业务状态生成"}</em></span>
            <div className="member-event-status"><span className={`tone-pill ${EVENT_STATUS_TONES[status] || "neutral"}`}>{memberEventStatusLabel(event)}</span><div>{memberEventActions(event).map((action) => <button className={action.status === "void" ? "soft-button" : "secondary-button"} type="button" key={action.status} onClick={() => onEventStatus(event.id, action.status)}>{action.label}</button>)}</div></div>
          </article>;
        })}</div> : <div className="member-empty"><Clock size={26} /><strong>还没有业务记录</strong><span>新增的业务先进入待确认状态。</span></div>}
      </section>
    </div>
  );
}
