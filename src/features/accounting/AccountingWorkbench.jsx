import { useEffect, useMemo, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowsLeftRight,
  CheckCircle,
  FileText,
  GitBranch,
  MagicWand,
  Plus,
  SealCheck,
  WarningCircle,
} from "@phosphor-icons/react";

import {
  ACCOUNT_CATALOG,
  EVENT_TYPES,
  activeAllocations,
  allocationDirectionMatchesBill,
  applyManualClassification,
  applyReconciliation,
  assessTransactionEvidence,
  billSettlement,
  buildAttachmentPackage,
  classifyBankTransaction,
  createPostedVoucherRevision,
  createVoucherDraft,
  linkInternalTransfer,
  linkRefundToOriginal,
  postVoucher,
  recordManualConfirmation,
  recordReconciliationSuggestions,
  reviseDraftVoucher,
  reviewTransactionEvidence,
  reverseReconciliation,
  suggestReconciliations,
  transactionSettlement,
  traceVoucherSources,
  unresolvedExceptionTasks,
  vouchersForSource,
} from "../../domain/accounting/index.js";
import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import "./accounting-workbench.css";

const EVENT_LABELS = {
  customerReceipt: "客户收款",
  memberRecharge: "会员充值 / 预收",
  memberConsumption: "会员耗课",
  supplierSettlement: "供应商结算",
  supplierPrepayment: "供应商预付",
  purchaseExpense: "采购费用",
  payroll: "工资与社保",
  rentAndProperty: "房租物业",
  bankFee: "银行手续费",
  loan: "借款与还款",
  employeeAdvance: "员工代垫",
  relatedParty: "关联方往来",
  refund: "退款",
  internalTransfer: "内部转账",
  unknown: "待判断",
};

function money(value) {
  return Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function statusLabel(status) {
  return {
    pending: "待核销",
    partial: "部分核销",
    fully_reconciled: "已全额核销",
    suspected: "疑似核销",
    exception: "异常待处理",
    refund_matched: "退款已关联",
    internal_transfer: "内部转账已关联",
  }[status] || status;
}

export function AccountingWorkbench({ transactionId, onToast }) {
  const { activeWorkspace, actions, store } = useFinanceDesk();
  const transaction = activeWorkspace.transactions.find((item) => item.id === transactionId);
  const [allocationAmounts, setAllocationAmounts] = useState({});
  const [judgement, setJudgement] = useState({ eventType: EVENT_TYPES.UNKNOWN, account: "expenseOther", reason: "" });
  const [reviewReason, setReviewReason] = useState("");
  const [reversalReason, setReversalReason] = useState("");
  const [voucherNote, setVoucherNote] = useState("");
  const [voucherSummaries, setVoucherSummaries] = useState({});
  const [refundSourceId, setRefundSourceId] = useState("");
  const [transferSourceId, setTransferSourceId] = useState("");
  const [error, setError] = useState("");

  const classification = useMemo(
    () => transaction ? classifyBankTransaction(activeWorkspace, transaction) : null,
    [activeWorkspace, transaction],
  );
  const assessment = useMemo(
    () => transaction ? assessTransactionEvidence(activeWorkspace, transaction, classification) : null,
    [activeWorkspace, transaction, classification],
  );
  const settlement = transaction ? transactionSettlement(transaction) : null;
  const suggestions = transaction ? suggestReconciliations(activeWorkspace, transaction.id) : [];
  const exceptions = transaction ? unresolvedExceptionTasks(activeWorkspace, transaction.id) : [];
  const allocations = transaction ? activeAllocations(transaction) : [];
  const vouchers = transaction ? vouchersForSource(activeWorkspace, transaction.id) : [];
  const eligibleBills = transaction
    ? activeWorkspace.bills.filter((bill) => allocationDirectionMatchesBill(transaction, bill) && billSettlement(activeWorkspace, bill).remaining > 0.01)
    : [];
  const refundSources = transaction
    ? activeWorkspace.transactions.filter((item) => item.id !== transaction.id && Number(item.amount) > 0)
    : [];
  const transferSources = transaction
    ? activeWorkspace.transactions.filter((item) => (
      item.id !== transaction.id
      && Math.sign(Number(item.amount)) === -Math.sign(Number(transaction.amount))
      && Math.abs(Math.abs(Number(item.amount)) - Math.abs(Number(transaction.amount))) <= 0.01
    ))
    : [];

  useEffect(() => {
    setAllocationAmounts({});
    setReviewReason("");
    setReversalReason("");
    setVoucherNote("");
    setVoucherSummaries({});
    setRefundSourceId("");
    setTransferSourceId("");
    setError("");
    if (classification) {
      setJudgement({
        eventType: classification.eventType,
        account: classification.account,
        reason: "",
      });
    }
  }, [transactionId]);

  if (!transaction || !classification || !assessment) return null;

  function run(action, successMessage) {
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const next = action(current);
      actions.replaceWorkspace(current.id, next);
      onToast?.(successMessage);
      return true;
    } catch (caught) {
      setError(caught.message || "会计处理失败");
      return false;
    }
  }

  function inspect() {
    run(
      (workspace) => recordReconciliationSuggestions(
        reviewTransactionEvidence(workspace, transaction.id, { actor: "周会计", mode: "local-rule" }),
        transaction.id,
        { actor: "周会计", mode: "local-rule" },
      ),
      "已完成本地分类、证据检查和疑似匹配；未自动入账",
    );
  }

  function manualClassify(event) {
    event.preventDefault();
    run(
      (workspace) => applyManualClassification(workspace, {
        transactionId,
        eventType: judgement.eventType,
        account: judgement.account,
        reason: judgement.reason,
      }, { actor: "周会计" }),
      "人工会计判断已记录，并保留了修改前后依据",
    );
  }

  function confirmEvidence(decision) {
    run(
      (workspace) => recordManualConfirmation(workspace, {
        transactionId,
        decision,
        reason: reviewReason,
      }, { actor: "周会计" }),
      decision === "approve" ? "人工复核已通过，流水回到待核销队列" : "已保留为异常事项",
    );
  }

  function applyAllocations() {
    const selected = Object.entries(allocationAmounts)
      .map(([billId, amount]) => ({ billId, amount: Number(amount) }))
      .filter((item) => item.amount > 0);
    if (!selected.length) {
      setError("请至少填写一笔本次核销金额");
      return;
    }
    if (run(
      (workspace) => applyReconciliation(workspace, {
        transactionId,
        allocations: selected,
        note: reviewReason || "财务人员在单笔工作台确认",
      }, { actor: "周会计", mode: "manual" }),
      "核销已保存；流水余额与账单余额已同步更新",
    )) setAllocationAmounts({});
  }

  function reverse(allocationId) {
    run(
      (workspace) => reverseReconciliation(workspace, {
        allocationId,
        reason: reversalReason,
      }, { actor: "周会计" }),
      "核销已撤销，原记录仍保留在审计链中",
    );
  }

  function linkRefund() {
    run(
      (workspace) => linkRefundToOriginal(workspace, {
        refundTransactionId: transactionId,
        originalSourceId: refundSourceId,
        amount: Math.abs(Number(transaction.amount)),
        reason: reviewReason,
      }, { actor: "周会计" }),
      "退款已与原收款建立可追溯关联",
    );
  }

  function linkTransfer() {
    const outgoing = Number(transaction.amount) < 0 ? transactionId : transferSourceId;
    const incoming = Number(transaction.amount) > 0 ? transactionId : transferSourceId;
    run(
      (workspace) => linkInternalTransfer(workspace, {
        outgoingTransactionId: outgoing,
        incomingTransactionId: incoming,
      }, { actor: "周会计" }),
      "两端银行流水已确认为内部转账，避免重复计入收支",
    );
  }

  function createDraft() {
    run(
      (workspace) => createVoucherDraft(workspace, {
        transactionId,
        note: voucherNote,
      }, { actor: "周会计" }),
      "已生成借贷平衡的凭证草稿与来源链",
    );
  }

  function postDraft(voucherId) {
    run(
      (workspace) => {
        return postVoucher(workspace, {
          voucherId,
          mode: "manual",
          reviewNote: voucherNote,
        }, { actor: "周会计" });
      },
      "凭证已人工复核入账，编号和附件来源已锁定",
    );
  }

  function reviseVoucher(voucher) {
    run(
      (workspace) => reviseDraftVoucher(workspace, {
        voucherId: voucher.id,
        summary: voucherSummaries[voucher.id] ?? voucher.summary,
        reason: voucherNote,
      }, { actor: "周会计" }),
      "凭证草稿已形成新版本，旧版本仍保留",
    );
  }

  function createRevision(voucherId) {
    run(
      (workspace) => createPostedVoucherRevision(workspace, {
        voucherId,
        reason: voucherNote,
      }, { actor: "周会计" }),
      "已入账凭证未被覆盖，已创建独立更正草稿",
    );
  }

  return (
    <section className="accounting-workbench">
      <div className="accounting-heading">
        <div><small>S5–S8 · 真实会计引擎</small><strong>分类、核销与凭证</strong></div>
        <span className={assessment.issues.length ? "engine-badge warning" : "engine-badge"}>{assessment.completeness}% 证据</span>
      </div>

      {error && <div className="engine-error"><WarningCircle size={16} />{error}</div>}

      <div className="engine-summary">
        <span><small>业务判断</small><strong>{EVENT_LABELS[classification.eventType]}</strong></span>
        <span><small>置信度</small><strong>{classification.confidence}%</strong></span>
        <span><small>核销状态</small><strong>{statusLabel(settlement.status)}</strong></span>
        <span><small>未核销</small><strong>¥{money(settlement.remaining)}</strong></span>
      </div>
      <ul className="engine-reasons">{classification.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <button className="secondary-button wide" type="button" onClick={inspect}><MagicWand size={16} />运行本地分类、证据检查与匹配建议</button>

      {(classification.requiresManualReview || exceptions.length > 0) && (
        <form className="engine-form" onSubmit={manualClassify}>
          <label><span>人工业务类型</span><select value={judgement.eventType} onChange={(event) => setJudgement((current) => ({ ...current, eventType: event.target.value }))}>{Object.values(EVENT_TYPES).map((value) => <option value={value} key={value}>{EVENT_LABELS[value]}</option>)}</select></label>
          <label><span>会计科目</span><select value={judgement.account} onChange={(event) => setJudgement((current) => ({ ...current, account: event.target.value }))}>{Object.entries(ACCOUNT_CATALOG).map(([id, account]) => <option value={id} key={id}>{account.label}</option>)}</select></label>
          <label className="full"><span>人工判断依据 *</span><textarea value={judgement.reason} onChange={(event) => setJudgement((current) => ({ ...current, reason: event.target.value }))} placeholder="例如：已核对合同、银行回单和审批单" /></label>
          <button className="secondary-button wide" type="submit">保存人工分类</button>
        </form>
      )}

      {exceptions.length > 0 && (
        <div className="engine-exceptions">
          {exceptions.map((item) => <div key={item.id}><WarningCircle size={15} /><span><strong>{item.message || item.code}</strong><small>{item.status === "ready_for_review" ? "资料已补齐，等待复核" : "仍阻塞入账"}</small></span></div>)}
          <label><span>复核依据 *</span><textarea value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} placeholder="说明核对了哪些资料以及结论" /></label>
          <div className="engine-inline"><button className="secondary-button" type="button" onClick={() => confirmEvidence("reject")}>保留异常</button><button className="primary-button" type="button" onClick={() => confirmEvidence("approve")}>人工确认通过</button></div>
        </div>
      )}

      {suggestions.length > 0 && <div className="engine-suggestions">{suggestions.map((item) => <button key={item.id} type="button" onClick={() => setAllocationAmounts((current) => ({ ...current, [item.billId]: item.suggestedAmount }))}><GitBranch size={15} /><span><strong>{item.billNo || item.billId}</strong><small>{item.reasons.join(" · ")}</small></span><b>¥{money(item.suggestedAmount)}</b></button>)}</div>}

      {eligibleBills.length > 0 && ![EVENT_TYPES.REFUND, EVENT_TYPES.INTERNAL_TRANSFER, EVENT_TYPES.UNKNOWN].includes(classification.eventType) && (
        <div className="engine-allocation">
          <div className="engine-subheading"><strong>拆分 / 部分核销</strong><small>可一次填写多张账单</small></div>
          {eligibleBills.map((bill) => {
            const remaining = billSettlement(activeWorkspace, bill).remaining;
            return <label key={bill.id}><span><strong>{bill.no || bill.id}</strong><small>{bill.counterparty || bill.summary || "本地账单"} · 剩余 ¥{money(remaining)}</small></span><input type="number" min="0" max={remaining} step="0.01" value={allocationAmounts[bill.id] || ""} onChange={(event) => setAllocationAmounts((current) => ({ ...current, [bill.id]: event.target.value }))} placeholder="本次金额" /></label>;
          })}
          <button className="primary-button wide" type="button" onClick={applyAllocations}><SealCheck size={16} />确认本次核销</button>
        </div>
      )}

      {allocations.length > 0 && (
        <div className="engine-allocation-history">
          <div className="engine-subheading"><strong>有效核销记录</strong><small>{allocations.length} 条</small></div>
          <label><span>撤销原因 *</span><input value={reversalReason} onChange={(event) => setReversalReason(event.target.value)} placeholder="撤销前必须填写" /></label>
          {allocations.map((allocation) => <div key={allocation.id}><span><strong>{allocation.billId}</strong><small>{allocation.businessPeriod || "未分期"} · {allocation.status}</small></span><b>¥{money(allocation.amount)}</b><button type="button" aria-label="撤销核销" onClick={() => reverse(allocation.id)}><ArrowCounterClockwise size={15} /></button></div>)}
        </div>
      )}

      {classification.eventType === EVENT_TYPES.REFUND && (
        <div className="engine-special">
          <div className="engine-subheading"><strong>退款关联</strong><small>必须追溯原收款</small></div>
          <select value={refundSourceId} onChange={(event) => setRefundSourceId(event.target.value)}><option value="">选择原收款流水</option>{refundSources.map((item) => <option value={item.id} key={item.id}>{item.date} · {item.counterparty} · ¥{money(item.amount)}</option>)}</select>
          <textarea value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} placeholder="退款判断依据" />
          <button className="primary-button wide" disabled={!refundSourceId || !reviewReason.trim()} type="button" onClick={linkRefund}>关联原收款</button>
        </div>
      )}

      {classification.eventType === EVENT_TYPES.INTERNAL_TRANSFER && (
        <div className="engine-special">
          <div className="engine-subheading"><strong>内部转账配对</strong><small>两端流水只入账一次</small></div>
          <select value={transferSourceId} onChange={(event) => setTransferSourceId(event.target.value)}><option value="">选择另一端流水</option>{transferSources.map((item) => <option value={item.id} key={item.id}>{item.date} · {item.counterparty} · {Number(item.amount) > 0 ? "+" : "−"}¥{money(item.amount)}</option>)}</select>
          <button className="primary-button wide" disabled={!transferSourceId} type="button" onClick={linkTransfer}><ArrowsLeftRight size={16} />确认内部转账</button>
        </div>
      )}

      <div className="engine-vouchers">
        <div className="engine-subheading"><strong>凭证与附件包</strong><small>{vouchers.length} 张关联凭证</small></div>
        <label><span>复核意见 *</span><textarea value={voucherNote} onChange={(event) => setVoucherNote(event.target.value)} placeholder="说明业务性质、科目与金额的复核结论" /></label>
        {!vouchers.length && <button className="secondary-button wide" type="button" onClick={createDraft}><Plus size={16} />生成凭证草稿</button>}
        {vouchers.map((voucher) => {
          const attachments = buildAttachmentPackage(activeWorkspace, voucher.id);
          const trace = traceVoucherSources(activeWorkspace, voucher.id);
          return (
            <article className="engine-voucher-card" key={voucher.id}>
              <div className="engine-voucher-row"><FileText size={17} /><span><strong>{voucher.no || "草稿"} · {voucher.summary}</strong><small>借贷 ¥{money(voucher.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0))} · 附件包 {attachments.status === "complete" ? "完整" : "待补"} · V{voucher.version}</small></span><em>{voucher.status}</em></div>
              {voucher.status !== "posted" && voucher.status !== "superseded" && <input value={voucherSummaries[voucher.id] ?? voucher.summary} onChange={(event) => setVoucherSummaries((current) => ({ ...current, [voucher.id]: event.target.value }))} aria-label="凭证摘要" />}
              <div className="engine-inline">
                {voucher.status !== "posted" && voucher.status !== "superseded" && <button className="secondary-button" type="button" onClick={() => reviseVoucher(voucher)}>保存修订</button>}
                {voucher.status !== "posted" && voucher.status !== "superseded" && <button className="primary-button" type="button" onClick={() => postDraft(voucher.id)}><CheckCircle size={16} />复核入账</button>}
                {voucher.status === "posted" && <button className="secondary-button" type="button" onClick={() => createRevision(voucher.id)}><Plus size={16} />创建更正草稿</button>}
              </div>
              <details>
                <summary>查看来源与附件清单</summary>
                <p>流水 {trace.transactions.length} · 账单 {trace.bills.length} · 资料 {trace.documents.length} · 历史版本 {trace.versions.length} · 审计 {trace.audit.length}</p>
                <ul className="engine-trace-list">
                  {attachments.manifest.map((item) => <li key={item.id}><strong>{item.kind}</strong><span>{item.name}</span></li>)}
                  {trace.versions.map((version, index) => <li key={`${version.version || "history"}-${index}`}><strong>历史版本 V{version.version || index + 1}</strong><span>{version.summary || version.reason || "凭证修订记录"}</span></li>)}
                </ul>
                {attachments.missing.length > 0 && <div className="engine-missing">{attachments.missing.map((item) => <span key={item.id}>待补：{item.label || item.id}</span>)}</div>}
              </details>
            </article>
          );
        })}
      </div>
    </section>
  );
}
