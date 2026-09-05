import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowsLeftRight,
  CheckCircle,
  FileText,
  GitBranch,
  Plus,
  SealCheck,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { assertWorkspacePermission } from "../../domain/foundation.js";

import {
  BILL_KINDS,
  BUSINESS_EVENT_INVOICE_STATUSES,
  BUSINESS_EVENT_TAX_TREATMENTS,
  EVENT_TYPES,
  accountDefinition,
  accountingRules,
  activeAllocations,
  advanceApplicationTargets,
  allocationDirectionMatchesBill,
  applyManualClassification,
  applyAdvanceToBill,
  applyReconciliation,
  assessTransactionEvidence,
  billSettlement,
  buildAdvanceBalances,
  buildAttachmentPackage,
  buildAccountingLedgers,
  buildLedgerFilterOptions,
  buildReconciliationAllocationDraft,
  buildReconciliationExceptionCases,
  confirmBankTransactionBusinessEvent,
  confirmReconciliationSuggestion,
  confirmedAdvanceApplications,
  confirmedAllocationsForBill,
  cancelReconciliationCorrection,
  createAdvanceApplicationVoucherDraft,
  createBankBusinessEventVoucherDraft,
  createMemberEventVoucherDraft,
  createSettlementBill,
  createPostedVoucherRevision,
  createReconciliationCorrection,
  createVoucherDraft,
  effectiveBankTransactionClassification,
  effectivePostedVouchers,
  handleReconciliationException,
  linkInternalTransfer,
  linkRefundToOriginal,
  ledgerToCsv,
  manualBusinessEventDefinition,
  manualBusinessEventTypesForWorkspace,
  memberBusinessEnabled,
  postVoucher,
  postVoucherWithEvidence,
  recordManualVoucherEvidenceFailure,
  recordReconciliationSuggestions,
  reviseDraftVoucher,
  reviewVoucher,
  reviewTransactionEvidence,
  reverseReconciliation,
  setBankTransactionBusinessEventDimensions,
  suggestReconciliations,
  transactionSettlement,
  traceVoucherSources,
  unresolvedExceptionTasks,
  validateVoucherBalance,
  vouchersForMemberEvent,
  vouchersForReconciliation,
  vouchersForSource,
  workspaceAccountDefinitions,
} from "../../domain/accounting/index.js";
import {
  MEMBER_EVENT_DEFINITIONS,
  isRecognizedMemberEvent,
  memberEventKind,
  memberEventStatusLabel,
} from "../members/memberLedger.js";
import { applyWorkspaceTerminology, workspaceTerminology } from "../../productWorkflow.js";
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

const REVIEW_REQUIRED_BANK_BUSINESS_TYPES = new Set([
  "loanBorrowing",
  "loanRepayment",
  "employeeAdvance",
  "relatedParty",
  "refund",
  "internalTransfer",
]);

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

function reconciliationSuggestionLabel(type) {
  return {
    one_to_one: "一对一",
    one_to_many: "一款多单",
    many_to_one: "一单多款",
  }[type] || "组合匹配";
}

function exceptionWorkflowLabel(state) {
  return {
    awaiting_verification: "待核实",
    awaiting_evidence: "待补件",
    ready_for_review: "待人工确认",
    recalculated_ready_for_review: "重算完成，待人工确认",
    returned_to_matching: "已返回匹配",
    treatment_adopted: "已采用处理",
    deferred: "暂不处理",
  }[state] || state;
}

const BILL_KIND_META = {
  receivable: { label: "客户应收", counterparty: "客户", balance: "未收余额" },
  payable: { label: "供应商应付", counterparty: "供应商", balance: "未付余额" },
  depositReceived: { label: "客户预收", counterparty: "客户", balance: "待到账" },
  prepaymentPaid: { label: "供应商预付", counterparty: "供应商", balance: "待支付" },
};

const MEMBER_REPORT_EFFECTS = {
  recharge: "货币资金、合同负债与经营现金流",
  consumption: "营业收入、合同负债与本月利润",
  refund: "货币资金、合同负债与经营现金流",
  commission: "教练提成费用、应付职工薪酬与本月利润",
  commissionPayment: "货币资金、应付职工薪酬与经营现金流",
};

function localizedEventLabel(eventType, workspace) {
  return applyWorkspaceTerminology(EVENT_LABELS[eventType] || eventType, workspace);
}

function localizedBillKindMeta(kind, workspace) {
  const meta = BILL_KIND_META[kind] || { label: kind, counterparty: "交易对手", balance: "未核销" };
  return Object.fromEntries(Object.entries(meta).map(([key, value]) => [
    key,
    applyWorkspaceTerminology(value, workspace),
  ]));
}

function localizedMemberReportEffect(kind, workspace) {
  return applyWorkspaceTerminology(MEMBER_REPORT_EFFECTS[kind] || "对应财务报表", workspace);
}

function emptyBillForm(period) {
  const date = `${period}-01`;
  return { kind: BILL_KINDS.RECEIVABLE, counterparty: "", summary: "", amount: "", date, dueDate: date, no: "" };
}

const LEDGER_VIEW_LABELS = Object.freeze({
  journal: "序时账",
  general: "总账",
  detail: "明细账",
});

function balanceText(direction, balance) {
  return direction === "平" ? "平" : `${direction} ¥${money(balance)}`;
}

function currentActorName(state, workspace) {
  const user = workspace?.users?.find((candidate) => (
    candidate.id === state.activeUserId && candidate.status === "active"
  ));
  return user?.name?.trim() || "本地用户";
}

function workspaceAccountOptions(workspace) {
  const byId = new Map();
  workspaceAccountDefinitions(workspace).forEach((account) => byId.set(account.id, account));
  [...(workspace?.bankAccounts || []), ...(workspace?.accounts || [])].forEach((account) => {
    if (!account?.id || byId.has(account.id)) return;
    const definition = accountDefinition(account.id, workspace);
    byId.set(account.id, {
      ...definition,
      id: account.id,
      label: account.label || account.name || account.accountName || definition.label || account.id,
      status: account.status || "active",
    });
  });
  return [...byId.values()].sort((left, right) => (
    applyWorkspaceTerminology(left.label, workspace)
      .localeCompare(applyWorkspaceTerminology(right.label, workspace), "zh-CN")
  ));
}

function accountIsActive(accounts, accountId) {
  return accounts.some((account) => account.id === accountId && account.status !== "inactive");
}

function activeAccountOrEmpty(accounts, accountId) {
  return accountIsActive(accounts, accountId) ? accountId : "";
}

function workspaceAccountLabel(workspace, accounts, accountId) {
  if (!accountId) return "待选择";
  return applyWorkspaceTerminology(accounts.find((account) => account.id === accountId)?.label
    || accountDefinition(accountId, workspace).label
    || accountId, workspace);
}

function WorkspaceAccountSelect({ workspace, accounts, value, onChange, required = false, ariaLabel }) {
  const activeAccounts = accounts.filter((account) => account.status !== "inactive");
  const selectedAccount = accounts.find((account) => account.id === value);
  const historicalSelection = Boolean(value && !accountIsActive(accounts, value));
  const historicalLabel = selectedAccount
    ? applyWorkspaceTerminology(selectedAccount.label, workspace)
    : workspaceAccountLabel(workspace, accounts, value);
  return (
    <select required={required} value={value || ""} onChange={(event) => onChange(event.target.value)} aria-label={ariaLabel}>
      {!value && <option value="">请选择有效科目</option>}
      {historicalSelection && <option value={value} disabled>{historicalLabel}（已停用，仅保留历史）</option>}
      {activeAccounts.map((account) => <option value={account.id} key={account.id}>{applyWorkspaceTerminology(account.label, workspace)}</option>)}
    </select>
  );
}

function updateVoucherLineDraft(setDrafts, voucher, transform) {
  setDrafts((current) => {
    const lines = current[voucher.id] || voucher.lines || [];
    return { ...current, [voucher.id]: transform(lines) };
  });
}

function blankVoucherLine(voucher) {
  return {
    account: "",
    auxiliaryId: null,
    auxiliaryLabel: null,
    auxiliaryType: null,
    storeId: null,
    storeName: null,
    department: null,
    project: null,
    debit: "",
    credit: "",
    taxAmount: "",
    sourceIds: [...new Set(voucher.sourceIds || [])],
  };
}

function voucherLineSourceIds(line) {
  return [...new Set((Array.isArray(line?.sourceIds) ? line.sourceIds : [])
    .map((sourceId) => String(sourceId || "").trim())
    .filter(Boolean))];
}

function voucherLineSourceInput(line) {
  return line?.sourceIdsText ?? voucherLineSourceIds(line).join("，");
}

function voucherLineAuxiliaryInput(line) {
  return line?.auxiliaryIdText ?? line?.auxiliaryLabel ?? line?.auxiliaryId ?? "";
}

function voucherLineDimensionInput(line, ...names) {
  for (const name of names) {
    const value = line?.[name] ?? line?.dimensions?.[name];
    if (value != null && String(value).trim()) return String(value);
  }
  return "";
}

function uniqueTextOptions(values) {
  return [...new Set(values.flat(Infinity).map((value) => String(value || "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function voucherAuxiliaryOptions(workspace) {
  const terminology = workspaceTerminology(workspace);
  const options = [];
  (workspace.counterparties || [])
    .filter((item) => item.status !== "inactive" && ["customer", "supplier"].includes(item.kind))
    .forEach((item) => options.push({
      id: item.id,
      label: item.name || item.id,
      type: item.kind,
      typeLabel: item.kind === "supplier" ? terminology.supplier : terminology.customer,
    }));
  (workspace.personnelRecords || [])
    .filter((item) => item.status !== "inactive")
    .forEach((item) => options.push({
      id: item.id,
      label: item.name || item.employeeName || item.id,
      type: "employee",
      typeLabel: terminology.personnel,
    }));
  return options;
}

function voucherDimensionOptions(workspace) {
  const records = [
    ...(workspace.businessEvents || []),
    ...(workspace.bills || []),
    ...(workspace.transactions || []),
    ...(workspace.vouchers || []).flatMap((voucher) => voucher.lines || []),
  ];
  return {
    stores: (workspace.stores || []).filter((item) => item.status !== "inactive"),
    departments: uniqueTextOptions([
      (workspace.personnelRecords || []).map((item) => item.department),
      records.map((item) => voucherLineDimensionInput(item, "department", "departmentName")),
    ]),
    projects: uniqueTextOptions(records.map((item) => voucherLineDimensionInput(item, "project", "projectName"))),
  };
}

function parseVoucherLineSourceIds(value) {
  return [...new Set(String(value || "")
    .split(/[,，;；\n]+/)
    .map((sourceId) => sourceId.trim())
    .filter(Boolean))];
}

function voucherDraftValidation(workspace, lines) {
  return validateVoucherBalance(
    { lines },
    accountingRules(workspace).amountTolerance,
    workspace,
  );
}

function voucherLineAccountPresentation(workspace, accounts, lines = []) {
  const seen = new Set();
  const lineAccounts = [];
  lines.forEach((line) => {
    const accountId = String(line.account || "").trim();
    if (!accountId || seen.has(accountId)) return;
    seen.add(accountId);
    const definition = accounts.find((account) => account.id === accountId)
      || accountDefinition(accountId, workspace);
    lineAccounts.push({
      account: accountId,
      accountLabel: definition?.label || accountId,
      cash: Boolean(definition?.cash),
    });
  });
  const businessAccounts = lineAccounts.filter((account) => !account.cash);
  const primaryText = businessAccounts.length === 1
    ? businessAccounts[0].accountLabel
    : businessAccounts.length > 1
      ? `多科目（${businessAccounts.length} 项），不指定单一主科目`
      : lineAccounts.length
        ? "资金类分录，不指定业务主科目"
        : "无有效分录科目";
  return {
    lineAccounts,
    accountText: lineAccounts.map((account) => account.accountLabel).join("、") || "无有效分录科目",
    primaryText,
  };
}

function VoucherAccountJudgement({ workspace, accounts, voucher, lines, pending = false }) {
  const current = voucherLineAccountPresentation(workspace, accounts, lines);
  const judgement = voucher.judgement || {};
  const original = judgement.originalAccountJudgement || (
    judgement.account || judgement.accountLabel || judgement.accountingAttributes?.primaryAccount
      ? {
        account: judgement.account || judgement.accountingAttributes?.primaryAccount,
        accountLabel: judgement.accountLabel || judgement.accountingAttributes?.primaryAccountLabel,
      }
      : null
  );
  const originalLabel = original?.accountLabel
    ? applyWorkspaceTerminology(original.accountLabel, workspace)
    : original?.account
      ? workspaceAccountLabel(workspace, accounts, original.account)
      : null;
  const sync = judgement.accountSync;
  const syncText = pending
    ? "保存后写入新版本"
    : sync
      ? `V${sync.version} · ${sync.actor || "系统"}`
      : "历史凭证，待下次修订同步";
  return (
    <div className="engine-summary">
      <span><small>{pending ? "待保存分录科目" : "当前分录科目"}</small><strong>{current.accountText}</strong></span>
      <span><small>当前主科目口径</small><strong>{current.primaryText}</strong></span>
      {originalLabel && <span><small>原始业务判断（仅追溯）</small><strong>{originalLabel}</strong></span>}
      <span><small>判断同步</small><strong>{syncText}</strong></span>
    </div>
  );
}

function VoucherLineValidation({ validation }) {
  return (
    <>
      <div className={`engine-voucher-balance ${validation.balanced ? "is-balanced" : "is-invalid"}`}>
        <span>借方 ¥{money(validation.debit)}</span>
        <span>贷方 ¥{money(validation.credit)}</span>
        <span className="engine-voucher-tax-total">税额合计 ¥{money(validation.taxTotal)} · 仅信息</span>
        <strong>{validation.balanced ? "借贷平衡，可以保存" : validation.amountsBalanced ? "借贷平衡，但分录有误" : `差额 ¥${money(Math.abs(validation.difference))}`}</strong>
      </div>
      {!validation.balanced && <div className="engine-missing">{validation.errors.map((message) => <span key={message}>{message}</span>)}</div>}
    </>
  );
}

function VoucherLineAccountEditor({ workspace, accounts, lines, editable, onChange, onAdd, onRemove }) {
  const terminology = workspaceTerminology(workspace);
  const auxiliaryListId = useId();
  const departmentListId = useId();
  const projectListId = useId();
  const auxiliaryOptions = useMemo(() => voucherAuxiliaryOptions(workspace), [workspace]);
  const dimensionOptions = useMemo(() => voucherDimensionOptions(workspace), [workspace]);
  return (
    <div className="engine-voucher-lines">
      {(lines || []).map((line, index) => {
        const debit = Number(line.debit || 0);
        const credit = Number(line.credit || 0);
        const unavailable = !accountIsActive(accounts, line.account);
        const sourceIds = voucherLineSourceIds(line);
        const selectedAuxiliary = auxiliaryOptions.find((item) => (
          item.id === line.auxiliaryId && (!line.auxiliaryType || item.type === line.auxiliaryType)
        ));
        if (editable) {
          return (
            <div className="engine-voucher-line is-editable" key={line.id || `voucher-line-${index}`}>
              <span className="engine-voucher-line-index">#{index + 1}</span>
              <label className="engine-voucher-line-field engine-voucher-line-account-field">
                <span>会计科目</span>
                <WorkspaceAccountSelect
                  workspace={workspace}
                  accounts={accounts}
                  value={line.account}
                  onChange={(account) => onChange(index, { account })}
                  ariaLabel={`第 ${index + 1} 行科目`}
                  required
                />
                <small>{unavailable ? "请选择当前有效科目" : line.account}</small>
              </label>
              <label className="engine-voucher-line-field engine-voucher-line-auxiliary-field">
                <span>辅助核算</span>
                <input list={`${auxiliaryListId}-${index}`} value={voucherLineAuxiliaryInput(line)} onChange={(event) => {
                  const auxiliaryIdText = event.target.value;
                  const normalized = auxiliaryIdText.trim();
                  const selected = auxiliaryOptions.find((item) => item.id === normalized || item.label === normalized);
                  onChange(index, {
                    auxiliaryIdText,
                    auxiliaryId: selected?.id || normalized || null,
                    auxiliaryLabel: selected?.label || normalized || null,
                    auxiliaryType: selected?.type || (normalized ? "counterparty" : null),
                  });
                }} aria-label={`第 ${index + 1} 行辅助核算`} placeholder={`选择${terminology.customer}、${terminology.supplier}、${terminology.personnel}或手填`} />
                <datalist id={`${auxiliaryListId}-${index}`}>{auxiliaryOptions.map((item) => <option value={item.label} label={`${item.typeLabel} · ${item.id}`} key={`${item.type}-${item.id}`} />)}</datalist>
                <small>{line.auxiliaryId ? `${selectedAuxiliary?.typeLabel || "手工标识"} · ${line.auxiliaryId}` : "未设置"}</small>
              </label>
              <label className="engine-voucher-line-field engine-voucher-line-store-field">
                <span>{terminology.location}</span>
                <select value={voucherLineDimensionInput(line, "storeId", "locationId")} onChange={(event) => {
                  const store = dimensionOptions.stores.find((item) => item.id === event.target.value);
                  onChange(index, { storeId: store?.id || null, storeName: store?.name || null });
                }} aria-label={`第 ${index + 1} 行${terminology.location}`}>
                  <option value="">不设置</option>
                  {voucherLineDimensionInput(line, "storeId", "locationId") && !dimensionOptions.stores.some((item) => item.id === voucherLineDimensionInput(line, "storeId", "locationId")) && <option value={voucherLineDimensionInput(line, "storeId", "locationId")}>{voucherLineDimensionInput(line, "storeName", "store", "locationName") || voucherLineDimensionInput(line, "storeId", "locationId")}（历史）</option>}
                  {dimensionOptions.stores.map((item) => <option value={item.id} key={item.id}>{item.name || item.id}</option>)}
                </select>
                <small>{voucherLineDimensionInput(line, "storeName", "store", "locationName") || "未设置"}</small>
              </label>
              <label className="engine-voucher-line-field engine-voucher-line-department-field">
                <span>部门</span>
                <input list={`${departmentListId}-${index}`} value={voucherLineDimensionInput(line, "department", "departmentName")} onChange={(event) => onChange(index, { department: event.target.value })} aria-label={`第 ${index + 1} 行部门`} placeholder="选择已有部门或手填" />
                <datalist id={`${departmentListId}-${index}`}>{dimensionOptions.departments.map((item) => <option value={item} key={item} />)}</datalist>
                <small>{voucherLineDimensionInput(line, "department", "departmentName") || "未设置"}</small>
              </label>
              <label className="engine-voucher-line-field engine-voucher-line-project-field">
                <span>项目</span>
                <input list={`${projectListId}-${index}`} value={voucherLineDimensionInput(line, "project", "projectName")} onChange={(event) => onChange(index, { project: event.target.value })} aria-label={`第 ${index + 1} 行项目`} placeholder="选择已有项目或手填" />
                <datalist id={`${projectListId}-${index}`}>{dimensionOptions.projects.map((item) => <option value={item} key={item} />)}</datalist>
                <small>{voucherLineDimensionInput(line, "project", "projectName") || "未设置"}</small>
              </label>
              <label className="engine-voucher-line-field engine-voucher-line-tax-field">
                <span>税额（可选）</span>
                <input type="number" min="0" step="0.01" inputMode="decimal" value={line.taxAmount ?? ""} onChange={(event) => onChange(index, { taxAmount: event.target.value })} aria-label={`第 ${index + 1} 行税额`} placeholder="0.00" />
                <small>不参与借贷平衡</small>
              </label>
              <label className="engine-voucher-line-field engine-voucher-line-source-field">
                <span>来源记录</span>
                <input value={voucherLineSourceInput(line)} onChange={(event) => {
                  const sourceIdsText = event.target.value;
                  onChange(index, { sourceIdsText, sourceIds: parseVoucherLineSourceIds(sourceIdsText) });
                }} aria-label={`第 ${index + 1} 行来源说明`} placeholder="用逗号或分号分隔来源标识" />
                <small>{sourceIds.length ? `${sourceIds.length} 个来源标识，保存后进入追溯链` : "未设置分录来源"}</small>
              </label>
              <label className="engine-voucher-line-field engine-voucher-line-debit-field">
                <span>借方金额</span>
                <input type="number" min="0" step="0.01" inputMode="decimal" value={line.debit || ""} onChange={(event) => onChange(index, { debit: event.target.value })} aria-label={`第 ${index + 1} 行借方金额`} placeholder="0.00" />
              </label>
              <label className="engine-voucher-line-field engine-voucher-line-credit-field">
                <span>贷方金额</span>
                <input type="number" min="0" step="0.01" inputMode="decimal" value={line.credit || ""} onChange={(event) => onChange(index, { credit: event.target.value })} aria-label={`第 ${index + 1} 行贷方金额`} placeholder="0.00" />
              </label>
              <button className="engine-voucher-line-remove" type="button" disabled={lines.length <= 2} onClick={() => onRemove(index)} aria-label={`删除第 ${index + 1} 行分录`}><Trash size={15} />删除</button>
            </div>
          );
        }
        return (
          <div className="engine-voucher-line" key={line.id || `voucher-line-${index}`}>
            <span className="engine-voucher-line-amount">
              <small>{debit ? "借方" : "贷方"}</small>
              <strong>¥{money(debit || credit)}</strong>
            </span>
            <span className="engine-voucher-line-account">
              <small>科目</small>
              <strong>{workspaceAccountLabel(workspace, accounts, line.account)}</strong>
              <small>{line.account}{unavailable ? " · 当前已停用" : ""}</small>
            </span>
            <span className="engine-voucher-line-details">
              <span><small>辅助核算</small><strong>{line.auxiliaryLabel || line.auxiliaryId || "未设置"}</strong></span>
              <span><small>{terminology.location} / 部门 / 项目</small><strong>{[
                voucherLineDimensionInput(line, "storeName", "store", "locationName", "storeId", "locationId"),
                voucherLineDimensionInput(line, "department", "departmentName"),
                voucherLineDimensionInput(line, "project", "projectName"),
              ].filter(Boolean).join(" · ") || "未设置"}</strong></span>
              <span><small>税额</small><strong>{line.taxAmount == null || line.taxAmount === "" ? "—" : `¥${money(line.taxAmount)}`}</strong></span>
              <span><small>来源记录</small><strong>{sourceIds.join("、") || "无分录来源"}</strong></span>
            </span>
          </div>
        );
      })}
      {editable && <button className="secondary-button engine-voucher-line-add" type="button" onClick={onAdd}><Plus size={15} />新增分录行</button>}
    </div>
  );
}

function LedgerTrace({ voucherId, voucherIds = [], sourceIds = [], taxAmount = null }) {
  const vouchers = voucherId ? [voucherId] : voucherIds;
  return (
    <details className="ledger-trace">
      <summary>查看追溯</summary>
      <span><b>凭证</b>{vouchers.join("、") || "期初余额"}</span>
      <span><b>税额</b>{taxAmount == null ? "—" : `¥${money(taxAmount)}`}</span>
      <span><b>原始来源</b>{sourceIds.join("、") || "无原始来源"}</span>
    </details>
  );
}

function AccountingLedgerPanel({ workspace, onToast }) {
  const terminology = workspaceTerminology(workspace);
  const displayText = (value) => applyWorkspaceTerminology(value, workspace);
  const [view, setView] = useState("journal");
  const [filters, setFilters] = useState(() => ({
    periodFrom: workspace.currentPeriod || "",
    periodTo: workspace.currentPeriod || "",
    account: "",
    auxiliaryType: "",
    auxiliaryId: "",
    storeId: "",
    department: "",
    project: "",
  }));
  const options = useMemo(() => buildLedgerFilterOptions(workspace), [workspace]);
  const ledgers = useMemo(() => buildAccountingLedgers(workspace, filters), [workspace, filters]);
  const ledger = ledgers[view];
  const auxiliaryOptions = options.auxiliaries.filter((item) => (
    !filters.auxiliaryType || item.type === filters.auxiliaryType
  ));

  function setFilter(name, value) {
    setFilters((current) => ({ ...current, [name]: value }));
  }

  function changeAuxiliaryType(value) {
    setFilters((current) => ({ ...current, auxiliaryType: value, auxiliaryId: "" }));
  }

  function resetFilters() {
    setFilters({
      periodFrom: workspace.currentPeriod || "",
      periodTo: workspace.currentPeriod || "",
      account: "",
      auxiliaryType: "",
      auxiliaryId: "",
      storeId: "",
      department: "",
      project: "",
    });
  }

  function exportCsv() {
    const csv = ledgerToCsv(view, {
      ...ledger,
      rows: ledger.rows.map((row) => ({
        ...row,
        accountLabel: displayText(row.accountLabel),
        auxiliaryTypeLabel: displayText(row.auxiliaryTypeLabel),
      })),
    });
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    const periodName = [filters.periodFrom, filters.periodTo].filter(Boolean).join("_") || "全部期间";
    link.href = url;
    link.download = `${LEDGER_VIEW_LABELS[view]}-${periodName}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    onToast?.(`${LEDGER_VIEW_LABELS[view]}已导出为本地 CSV`);
  }

  return (
    <div className="accounting-ledger-panel">
      <div className="ledger-heading">
        <div><h2>序时账、总账与明细账</h2><p>仅统计当前有效的已入账凭证，可追溯原始资料。</p></div>
        <button className="secondary-button" type="button" onClick={exportCsv} disabled={!ledger.rows.length}><FileText size={16} />导出 CSV</button>
      </div>

      <div className="ledger-tabs" role="tablist" aria-label="账簿类型">
        {Object.entries(LEDGER_VIEW_LABELS).map(([id, label]) => (
          <button className={view === id ? "active" : ""} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)} key={id}>{label}</button>
        ))}
      </div>

      <div className="ledger-filters">
        <label><span>期间起</span><input type="month" value={filters.periodFrom} onChange={(event) => setFilter("periodFrom", event.target.value)} /></label>
        <label><span>期间止</span><input type="month" value={filters.periodTo} onChange={(event) => setFilter("periodTo", event.target.value)} /></label>
        <label><span>科目</span><select value={filters.account} onChange={(event) => setFilter("account", event.target.value)}><option value="">全部科目</option>{options.accounts.map((item) => <option value={item.id} key={item.id}>{displayText(item.label)}</option>)}</select></label>
        <label><span>往来类型</span><select value={filters.auxiliaryType} onChange={(event) => changeAuxiliaryType(event.target.value)}><option value="">{terminology.customer} / {terminology.supplier} / {terminology.personnel}</option>{options.auxiliaryTypes.map((item) => <option value={item.id} key={item.id}>{displayText(item.label)}</option>)}</select></label>
        <label><span>往来对象</span><select value={filters.auxiliaryId} onChange={(event) => setFilter("auxiliaryId", event.target.value)}><option value="">全部对象</option>{auxiliaryOptions.map((item) => <option value={item.id} key={`${item.type}-${item.id}`}>{displayText(item.typeLabel)} · {item.label}</option>)}</select></label>
        <label><span>{terminology.location}</span><select value={filters.storeId} onChange={(event) => setFilter("storeId", event.target.value)}><option value="">全部{terminology.location}</option>{options.stores.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
        <label><span>部门</span><select value={filters.department} onChange={(event) => setFilter("department", event.target.value)}><option value="">全部部门</option>{options.departments.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        <label><span>项目</span><select value={filters.project} onChange={(event) => setFilter("project", event.target.value)}><option value="">全部项目</option>{options.projects.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        <button className="ledger-reset" type="button" onClick={resetFilters}>重置筛选</button>
      </div>

      <div className="ledger-result-summary">
        <span>{LEDGER_VIEW_LABELS[view]}</span>
        <strong>{ledger.rows.length} 行</strong>
        <small>{ledger.sourceVoucherIds.length} 张当前有效凭证</small>
      </div>

      <div className="ledger-table-wrap">
        {view === "journal" && <table className="ledger-table">
          <thead><tr><th>日期 / 凭证</th><th>摘要 / 科目</th><th>辅助维度</th><th className="number">借方</th><th className="number">贷方</th></tr></thead>
          <tbody>{ledger.rows.map((row) => <tr key={row.id}>
            <td><strong>{row.date}</strong><small>{row.voucherNo} · V{row.voucherVersion}</small><LedgerTrace voucherId={row.voucherId} sourceIds={row.originalSourceIds} taxAmount={row.taxAmount} /></td>
            <td><strong>{row.voucherSummary}</strong><small>{displayText(row.accountLabel)} · {row.account}</small></td>
            <td><span>{row.auxiliaryLabels.join("、") || "—"}</span><small>{[row.storeNames.join("、"), row.departments.join("、"), row.projects.join("、")].filter(Boolean).join(" · ") || `无${terminology.location} / 部门 / 项目`}</small></td>
            <td className="number">{row.debit ? money(row.debit) : "—"}</td>
            <td className="number">{row.credit ? money(row.credit) : "—"}</td>
          </tr>)}</tbody>
          <tfoot><tr><td colSpan="3">本期合计</td><td className="number">{money(ledger.totals.debit)}</td><td className="number">{money(ledger.totals.credit)}</td></tr></tfoot>
        </table>}

        {view === "general" && <table className="ledger-table">
          <thead><tr><th>科目</th><th className="number">期初</th><th className="number">借方发生</th><th className="number">贷方发生</th><th className="number">期末</th></tr></thead>
          <tbody>{ledger.rows.map((row) => <tr key={row.account}>
            <td><strong>{displayText(row.accountLabel)}</strong><small>{row.account}</small><LedgerTrace voucherIds={row.voucherIds} sourceIds={row.originalSourceIds} taxAmount={row.taxAmount} /></td>
            <td className="number">{balanceText(row.openingDirection, row.openingBalance)}</td>
            <td className="number">{money(row.debit)}</td>
            <td className="number">{money(row.credit)}</td>
            <td className="number"><strong>{balanceText(row.closingDirection, row.closingBalance)}</strong></td>
          </tr>)}</tbody>
        </table>}

        {view === "detail" && <table className="ledger-table">
          <thead><tr><th>日期 / 凭证</th><th>科目 / 摘要</th><th className="number">借方</th><th className="number">贷方</th><th className="number">运行余额</th></tr></thead>
          <tbody>{ledger.rows.map((row) => <tr key={row.id}>
            <td><strong>{row.date}</strong><small>{row.voucherNo} · V{row.voucherVersion}</small><LedgerTrace voucherId={row.voucherId} sourceIds={row.originalSourceIds} taxAmount={row.taxAmount} /></td>
            <td><strong>{displayText(row.accountLabel)}</strong><small>{row.voucherSummary}</small></td>
            <td className="number">{row.debit ? money(row.debit) : "—"}</td>
            <td className="number">{row.credit ? money(row.credit) : "—"}</td>
            <td className="number"><strong>{balanceText(row.runningDirection, row.runningBalance)}</strong></td>
          </tr>)}</tbody>
        </table>}

        {!ledger.rows.length && <p className="ledger-empty">当前筛选下没有有效的已入账凭证分录。</p>}
      </div>
    </div>
  );
}

export function MemberBusinessAccountingQueue({ onToast }) {
  const { activeWorkspace, actions, state, store } = useFinanceDesk();
  const terminology = workspaceTerminology(activeWorkspace);
  const displayText = (value) => applyWorkspaceTerminology(value, activeWorkspace);
  const [reviewNotes, setReviewNotes] = useState({});
  const [voucherLineDrafts, setVoucherLineDrafts] = useState({});
  const [error, setError] = useState("");
  const actor = currentActorName(state, activeWorkspace);
  const accountOptions = useMemo(() => workspaceAccountOptions(activeWorkspace), [activeWorkspace]);
  const rows = useMemo(() => {
    if (!activeWorkspace) return [];
    return (activeWorkspace.businessEvents || [])
      .filter((event) => String(event.date || "").startsWith(activeWorkspace.currentPeriod) && isRecognizedMemberEvent(event))
      .map((event) => {
        const related = vouchersForMemberEvent(activeWorkspace, event);
        const voucher = related.find((item) => !["posted", "superseded"].includes(item.status))
          || [...related].reverse().find((item) => item.status === "posted")
          || null;
        return { event, voucher };
      })
      .sort((left, right) => String(right.event.date || "").localeCompare(String(left.event.date || "")));
  }, [activeWorkspace]);

  if (!activeWorkspace) return null;

  const readyCount = rows.filter((row) => !row.voucher).length;
  const draftCount = rows.filter((row) => row.voucher && row.voucher.status !== "posted").length;
  const postedCount = rows.filter((row) => row.voucher?.status === "posted").length;

  function run(action, successMessage) {
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const next = action(current);
      actions.replaceWorkspace(current.id, next);
      onToast?.(displayText(successMessage));
      return true;
    } catch (caught) {
      setError(displayText(caught.message || "会员业务会计处理失败"));
      return false;
    }
  }

  function createDraft(eventId) {
    run(
      (workspace) => createMemberEventVoucherDraft(workspace, { eventId }, { actor }),
      `已由${terminology.member}台账生成借贷平衡的凭证草稿`,
    );
  }

  function changeVoucherLine(voucher, lineIndex, changes) {
    updateVoucherLineDraft(setVoucherLineDrafts, voucher, (lines) => lines.map((line, index) => (
      index === lineIndex ? { ...line, ...changes } : line
    )));
  }

  function addVoucherLine(voucher) {
    updateVoucherLineDraft(setVoucherLineDrafts, voucher, (lines) => [...lines, blankVoucherLine(voucher)]);
  }

  function removeVoucherLine(voucher, lineIndex) {
    updateVoucherLineDraft(setVoucherLineDrafts, voucher, (lines) => (
      lines.length > 2 ? lines.filter((_, index) => index !== lineIndex) : lines
    ));
  }

  function validateDraft(voucher) {
    const lines = voucherLineDrafts[voucher.id] || voucher.lines;
    const validation = voucherDraftValidation(activeWorkspace, lines);
    if (!validation.balanced) setError(validation.errors.join("；"));
    return { lines, validation };
  }

  function reviseDraft(event, voucher) {
    const reviewNote = String(reviewNotes[event.id] || "").trim();
    if (!reviewNote) {
      setError(`保存修订前，请填写这笔${terminology.member}业务的复核意见`);
      return;
    }
    const { lines, validation } = validateDraft(voucher);
    if (!validation.balanced) return;
    if (run(
      (workspace) => reviseDraftVoucher(workspace, {
        voucherId: voucher.id,
        summary: voucher.summary,
        lines,
        reason: reviewNote,
      }, { actor }),
      `${terminology.member}业务凭证草稿已保存为新版本`,
    )) {
      setVoucherLineDrafts((current) => {
        const next = { ...current };
        delete next[voucher.id];
        return next;
      });
    }
  }

  function postDraft(event, voucher) {
    const reviewNote = String(reviewNotes[event.id] || "").trim();
    if (!reviewNote) {
      setError(`复核入账前，请填写这笔${terminology.member}业务的复核意见`);
      return;
    }
    const { lines: editedLines, validation } = validateDraft(voucher);
    if (!validation.balanced) return;
    if (run(
      (workspace) => {
        const prepared = voucherLineDrafts[voucher.id]
          ? reviseDraftVoucher(workspace, {
            voucherId: voucher.id,
            summary: voucher.summary,
            lines: editedLines,
            reason: reviewNote,
          }, { actor })
          : workspace;
        return postVoucher(prepared, {
          voucherId: voucher.id,
          mode: "manual",
          reviewNote,
        }, { actor });
      },
      `${terminology.member}业务凭证已复核入账，对应报表已实时更新`,
    )) {
      setReviewNotes((current) => ({ ...current, [event.id]: "" }));
      setVoucherLineDrafts((current) => {
        const next = { ...current };
        delete next[voucher.id];
        return next;
      });
    }
  }

  return (
    <section className="panel settlement-panel">
      <div className="settlement-heading">
        <div><h2>{terminology.member}业务凭证</h2><p>本期 {rows.length} 笔已确认业务，复核入账后进入报表。</p></div>
      </div>
      <div className="settlement-metrics">
        <span><small>待生成凭证</small><strong>{readyCount} 笔</strong></span>
        <span><small>待复核入账</small><strong>{draftCount} 笔</strong></span>
        <span><small>已进入报表</small><strong>{postedCount} 笔</strong></span>
      </div>
      {error && <div className="engine-error"><WarningCircle size={16} />{error}</div>}
      <div className="settlement-bill-list">
        {rows.length ? rows.map(({ event, voucher }) => {
          const kind = memberEventKind(event);
          const definition = MEMBER_EVENT_DEFINITIONS[kind];
          const voucherLabel = !voucher ? "待生成" : voucher.status === "posted" ? `${voucher.no || "已编号"} · 已入账` : "凭证草稿";
          const editableLines = voucher ? voucherLineDrafts[voucher.id] || voucher.lines : [];
          const editable = Boolean(voucher && ["draft", "changes_requested"].includes(voucher.status));
          const validation = voucher ? validateVoucherBalance(
            { lines: editableLines },
            accountingRules(activeWorkspace).amountTolerance,
            editable ? activeWorkspace : null,
          ) : null;
          return (
            <article className="settlement-bill-row member-accounting-row" key={event.id}>
              <div className="settlement-bill-overview">
                <div className="settlement-bill-main"><span className="settlement-kind">{displayText(definition.label)}</span><strong>{event.memberName || event.coach}</strong><small>{event.date} · {memberEventStatusLabel(event)} · {event.note || displayText(definition.accountingLabel)}</small></div>
                <div className="settlement-bill-amounts"><span><small>业务金额</small><strong>¥{money(event.amount)}</strong></span><span><small>会计状态</small><strong>{voucherLabel}</strong></span></div>
              </div>
              <details className="settlement-bill-details">
                <summary>{voucher ? voucher.status === "posted" ? "查看已入账凭证" : "复核凭证" : "生成凭证"}</summary>
                <p>报表影响：{localizedMemberReportEffect(kind, activeWorkspace)}</p>
                {voucher ? <div className="engine-voucher-card">
                  <div className="engine-voucher-row"><FileText size={17} /><span><strong>{voucher.no || "草稿"} · {voucher.summary}</strong><small>借方 ¥{money(validation?.debit)} · 贷方 ¥{money(validation?.credit)} · {validation?.amountsBalanced ? "借贷平衡" : "借贷不平"}{validation?.balanced ? "" : " · 分录待修正"}</small><small className="engine-voucher-tax-total">税额合计 ¥{money(validation?.taxTotal)} · 仅作信息，不参与借贷平衡</small></span><em>{voucherStatusLabel(voucher.status)}</em></div>
                  <VoucherAccountJudgement
                    workspace={activeWorkspace}
                    accounts={accountOptions}
                    voucher={voucher}
                    lines={editableLines}
                    pending={Boolean(voucherLineDrafts[voucher.id])}
                  />
                  <VoucherLineAccountEditor
                    workspace={activeWorkspace}
                    accounts={accountOptions}
                    lines={editableLines}
                    editable={editable}
                    onChange={(lineIndex, changes) => changeVoucherLine(voucher, lineIndex, changes)}
                    onAdd={() => addVoucherLine(voucher)}
                    onRemove={(lineIndex) => removeVoucherLine(voucher, lineIndex)}
                  />
                  {editable && <VoucherLineValidation validation={validation} />}
                  {voucher.status === "posted" ? <div className="engine-inline"><span className="engine-badge"><CheckCircle size={14} weight="fill" />已进入 {localizedMemberReportEffect(kind, activeWorkspace)}</span></div> : <form className="engine-form" onSubmit={(submitEvent) => { submitEvent.preventDefault(); postDraft(event, voucher); }}>
                    <label className="full"><span>复核意见 *</span><textarea value={reviewNotes[event.id] || ""} onChange={(changeEvent) => setReviewNotes((current) => ({ ...current, [event.id]: changeEvent.target.value }))} placeholder={`例如：已核对${terminology.member}台账、金额和会计科目`} /></label>
                    <div className="engine-voucher-form-actions"><button className="secondary-button" disabled={!validation?.balanced || !voucherLineDrafts[voucher.id]} type="button" onClick={() => reviseDraft(event, voucher)}>保存修订</button><button className="primary-button" disabled={!validation?.balanced} type="submit"><CheckCircle size={16} />复核入账并更新报表</button></div>
                  </form>}
                </div> : <div className="engine-inline"><span><strong>{displayText(definition.accountingLabel)}</strong><small>{displayText(definition.suggestedEntry)}</small></span><button className="secondary-button" type="button" onClick={() => createDraft(event.id)}><Plus size={16} />生成平衡凭证</button></div>}
              </details>
            </article>
          );
        }) : <p className="settlement-empty">本期还没有已确认的{terminology.member}业务。请先到{terminology.member}台账记录并确认业务状态。</p>}
      </div>
    </section>
  );
}

export function ReceivablesPayablesPanel({ onToast, showMemberBusiness = true }) {
  const { activeWorkspace, actions, state, store } = useFinanceDesk();
  const terminology = workspaceTerminology(activeWorkspace);
  const displayText = (value) => applyWorkspaceTerminology(value, activeWorkspace);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(() => emptyBillForm(activeWorkspace?.currentPeriod || new Date().toISOString().slice(0, 7)));
  const [advanceUsage, setAdvanceUsage] = useState({});
  const [advanceVoucherNotes, setAdvanceVoucherNotes] = useState({});
  const [error, setError] = useState("");
  const actor = currentActorName(state, activeWorkspace);
  const billRows = useMemo(() => {
    if (!activeWorkspace) return [];
    const transactionById = new Map((activeWorkspace.transactions || []).map((transaction) => [transaction.id, transaction]));
    const billById = new Map((activeWorkspace.bills || []).map((bill) => [bill.id, bill]));
    return [...(activeWorkspace.bills || [])]
      .map((bill) => ({
        bill,
        settlement: billSettlement(activeWorkspace, bill),
        allocations: confirmedAllocationsForBill(activeWorkspace, bill.id).map((allocation) => ({
          ...allocation,
          transaction: transactionById.get(allocation.transactionId),
        })),
        advanceApplications: confirmedAdvanceApplications(activeWorkspace, { targetBillId: bill.id }).map((application) => ({
          ...application,
          advanceBill: billById.get(application.advanceBillId),
        })),
      }))
      .sort((left, right) => String(right.bill.date || "").localeCompare(String(left.bill.date || "")) || String(right.bill.no || "").localeCompare(String(left.bill.no || "")));
  }, [activeWorkspace]);
  const advanceSummary = useMemo(
    () => activeWorkspace ? buildAdvanceBalances(activeWorkspace) : { depositsReceived: 0, prepaymentsPaid: 0, rows: [] },
    [activeWorkspace],
  );

  useEffect(() => {
    setForm(emptyBillForm(activeWorkspace?.currentPeriod || new Date().toISOString().slice(0, 7)));
    setShowForm(false);
    setAdvanceUsage({});
    setAdvanceVoucherNotes({});
    setError("");
  }, [activeWorkspace?.id, activeWorkspace?.currentPeriod]);

  if (!activeWorkspace) return null;

  const currentBillMeta = localizedBillKindMeta(form.kind, activeWorkspace);
  const totalFor = (kind, field) => billRows
    .filter((row) => row.bill.kind === kind)
    .reduce((sum, row) => sum + Number(row.settlement[field] || 0), 0);
  const metrics = [
    { label: "应收未核销", value: totalFor(BILL_KINDS.RECEIVABLE, "remaining") },
    { label: "应付未核销", value: totalFor(BILL_KINDS.PAYABLE, "remaining") },
    { label: `${terminology.customer}预收可用`, value: advanceSummary.depositsReceived },
    { label: `${terminology.supplier}预付可用`, value: advanceSummary.prepaymentsPaid },
  ];
  const ordinaryBillRows = billRows.filter(({ bill }) => ![BILL_KINDS.DEPOSIT_RECEIVED, BILL_KINDS.PREPAYMENT_PAID].includes(bill.kind));
  const advanceRowByBillId = new Map(advanceSummary.rows.map((row) => [row.billId, row]));
  const advanceBillRows = billRows
    .filter(({ bill }) => [BILL_KINDS.DEPOSIT_RECEIVED, BILL_KINDS.PREPAYMENT_PAID].includes(bill.kind))
    .map((row) => ({ ...row, advance: advanceRowByBillId.get(row.bill.id) }));

  function submitBill(event) {
    event.preventDefault();
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const next = createSettlementBill(current, { ...form, amount: Number(form.amount) }, { actor });
      actions.replaceWorkspace(current.id, next);
      setForm(emptyBillForm(current.currentPeriod));
      setShowForm(false);
      onToast?.("往来账单已保存，可在流水详情中做拆分或分次核销");
    } catch (caught) {
      setError(displayText(caught.message || "账单保存失败"));
    }
  }

  function confirmAdvanceUse(advanceBillId) {
    const usage = advanceUsage[advanceBillId] || {};
    const amount = Number(usage.amount);
    if (!usage.targetBillId || !Number.isFinite(amount) || amount <= 0) {
      setError("请选择对应账单并填写本次使用金额");
      return;
    }
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const next = applyAdvanceToBill(current, {
        advanceBillId,
        targetBillId: usage.targetBillId,
        amount,
        note: "财务人员在预收/预付余额页人工确认",
      }, { actor, mode: "manual" });
      actions.replaceWorkspace(current.id, next);
      setAdvanceUsage((currentUsage) => ({ ...currentUsage, [advanceBillId]: { targetBillId: "", amount: "" } }));
      onToast?.("余额使用已确认；对应账单与凭证来源关系已更新");
    } catch (caught) {
      setError(displayText(caught.message || "预收/预付余额使用失败"));
    }
  }

  function createAdvanceVoucherDraft(applicationId) {
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const next = createAdvanceApplicationVoucherDraft(current, {
        applicationId,
        note: "由已确认预收/预付冲销关系生成",
      }, { actor });
      actions.replaceWorkspace(current.id, next);
      onToast?.("已生成平衡凭证草稿，等待人工复核入账");
    } catch (caught) {
      setError(displayText(caught.message || "冲销凭证草稿生成失败"));
    }
  }

  function postAdvanceVoucher(applicationId, voucherId) {
    const reviewNote = advanceVoucherNotes[applicationId] || "";
    if (!reviewNote.trim()) {
      setError("人工入账前必须填写复核意见");
      return;
    }
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const next = postVoucher(current, {
        voucherId,
        mode: "manual",
        reviewNote,
      }, { actor });
      actions.replaceWorkspace(current.id, next);
      setAdvanceVoucherNotes((notes) => ({ ...notes, [applicationId]: "" }));
      onToast?.("冲销凭证已人工复核入账，来源关系状态已回写");
    } catch (caught) {
      setError(displayText(caught.message || "冲销凭证入账失败"));
    }
  }

  return (
    <>
      {showMemberBusiness && memberBusinessEnabled(activeWorkspace) && <MemberBusinessAccountingQueue onToast={onToast} />}
      <section className="panel settlement-panel">
      <div className="settlement-heading">
        <div><h2>往来账单</h2><p>到账后在银行交易中核销，支持多单拆分和分次结清。</p></div>
        <button className="secondary-button" type="button" aria-expanded={showForm} onClick={() => { setShowForm((current) => !current); setError(""); }}><Plus size={16} />{showForm ? "收起表单" : form.counterparty || form.amount ? "继续填写账单" : "新增账单"}</button>
      </div>

      <div className="settlement-metrics">
        {metrics.map((item) => <span key={item.label}><small>{item.label}</small><strong>¥{money(item.value)}</strong></span>)}
      </div>

      {showForm && (
        <form className="settlement-form" onSubmit={submitBill}>
          <label><span>账单类型 *</span><select value={form.kind} onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value }))}>{Object.keys(BILL_KIND_META).map((kind) => <option key={kind} value={kind}>{localizedBillKindMeta(kind, activeWorkspace).label}</option>)}</select></label>
          <label><span>{currentBillMeta.counterparty}名称 *</span><input autoFocus value={form.counterparty} onChange={(event) => setForm((current) => ({ ...current, counterparty: event.target.value }))} placeholder={`填写${currentBillMeta.counterparty}名称`} /></label>
          <label><span>账单金额 *</span><input type="number" min="0.01" step="0.01" value={form.amount} onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))} placeholder="0.00" /></label>
          <label><span>账单编号</span><input value={form.no} onChange={(event) => setForm((current) => ({ ...current, no: event.target.value }))} placeholder="留空自动编号" /></label>
          <label><span>账单日期 *</span><input type="date" value={form.date} onChange={(event) => setForm((current) => ({ ...current, date: event.target.value, dueDate: !current.dueDate || current.dueDate === current.date ? event.target.value : current.dueDate }))} /></label>
          <label><span>到期日期 *</span><input type="date" value={form.dueDate} onChange={(event) => setForm((current) => ({ ...current, dueDate: event.target.value }))} /></label>
          <label className="full"><span>业务摘要</span><input value={form.summary} onChange={(event) => setForm((current) => ({ ...current, summary: event.target.value }))} placeholder={`例如：9 月设计${terminology.service}费`} /></label>
          {error && <div className="engine-error full"><WarningCircle size={16} />{error}</div>}
          <div className="engine-inline full"><button className="secondary-button" type="button" onClick={() => { setShowForm(false); setError(""); }}>收起并保留输入</button><button className="primary-button" type="submit"><SealCheck size={16} />保存账单</button></div>
        </form>
      )}

      <div className="settlement-bill-list">
        <div className="engine-subheading"><strong>月结应收 / 应付</strong><small>银行收付款与预收预付使用共同更新未核销余额</small></div>
        {ordinaryBillRows.length ? ordinaryBillRows.map(({ bill, settlement, allocations, advanceApplications }) => {
          const meta = localizedBillKindMeta(bill.kind, activeWorkspace);
          const sourceCount = allocations.length + advanceApplications.length;
          return (
            <article className="settlement-bill-row" key={bill.id}>
              <div className="settlement-bill-main"><span className="settlement-kind">{meta.label}</span><strong>{bill.no || bill.id} · {bill.counterparty}</strong><small>{bill.summary} · {bill.date} 到期 {bill.dueDate || bill.date}</small></div>
              <div className="settlement-bill-amounts"><span><small>账单金额</small><strong>¥{money(bill.amount)}</strong></span><span><small>累计核销</small><strong>¥{money(settlement.allocated)}</strong></span><span><small>{meta.balance}</small><strong>¥{money(settlement.remaining)}</strong></span></div>
              <details>
                <summary>{sourceCount ? `${sourceCount} 条核销来源 · 查看明细` : "尚无核销来源"}</summary>
                {sourceCount > 0 && <div className="settlement-source-list">
                  {allocations.map((allocation) => <div key={allocation.id || `${bill.id}-${allocation.transactionId}`}><span><strong>{allocation.transaction?.date || "—"} · {allocation.transaction?.counterparty || "银行流水"}</strong><small>{allocation.transaction?.serial || allocation.transactionId} · 银行核销 {allocation.id || "历史记录"}</small></span><b>¥{money(allocation.amount)}</b></div>)}
                  {advanceApplications.map((application) => <div key={application.id}><span><strong>{application.advanceBill?.no || application.advanceBillId} · {application.advanceBill?.counterparty || "预收/预付余额"}</strong><small>{application.date} · 凭证来源 {application.id}</small></span><b>¥{money(application.amount)}</b></div>)}
                </div>}
              </details>
            </article>
          );
        }) : <p className="settlement-empty">还没有月结应收或应付账单。</p>}
      </div>

      <div className="settlement-bill-list">
        <div className="engine-subheading"><strong>{terminology.customer}预收 / {terminology.supplier}预付</strong><small>与月结账单独立显示，只能人工选择对应账单使用</small></div>
        {advanceBillRows.length ? advanceBillRows.map(({ bill, allocations, advance }) => {
          const meta = localizedBillKindMeta(bill.kind, activeWorkspace);
          const usage = advanceUsage[bill.id] || { targetBillId: "", amount: "" };
          const targets = advanceApplicationTargets(activeWorkspace, bill.id);
          const selectedTarget = targets.find((target) => target.billId === usage.targetBillId);
          const maximumUse = Math.min(advance?.availableBalance || 0, selectedTarget?.remaining || Number.POSITIVE_INFINITY);
          return (
            <article className="settlement-bill-row" key={bill.id}>
              <div className="settlement-bill-main"><span className="settlement-kind">{meta.label}</span><strong>{bill.no || bill.id} · {bill.counterparty}</strong><small>{bill.summary} · 计划 ¥{money(advance?.originalAmount)} · 待到账 ¥{money(advance?.pendingFunding)}</small></div>
              <div className="settlement-bill-amounts"><span><small>原余额</small><strong>¥{money(advance?.originalBalance)}</strong></span><span><small>累计使用</small><strong>¥{money(advance?.usedAmount)}</strong></span><span><small>剩余余额</small><strong>¥{money(advance?.availableBalance)}</strong></span></div>
              <details>
                <summary>{advance?.applications.length ? `${advance.applications.length} 次使用 · 继续分次冲销` : "选择对应账单使用余额"}</summary>
                {advance?.applications.length > 0 && <div className="settlement-source-list">{advance.applications.map((application) => {
                  const relatedVouchers = (activeWorkspace.vouchers || []).filter((voucher) => voucher.advanceApplicationId === application.id && ["posted", "draft", "changes_requested"].includes(voucher.status));
                  const voucher = relatedVouchers.find((item) => item.id === application.voucherId || item.id === application.draftVoucherId) || relatedVouchers.at(-1);
                  return <div key={application.id}>
                    <span>
                      <strong>{application.targetBillNo || application.targetBillId} · {application.targetSummary || "对应账单"} · ¥{money(application.amount)}</strong>
                      <small>{application.date} · 来源 {application.id} · {voucher ? `${voucher.no || "草稿"} / ${voucher.status}` : "待生成凭证"}</small>
                      {voucher && ["draft", "changes_requested"].includes(voucher.status) && <input value={advanceVoucherNotes[application.id] || ""} onChange={(event) => setAdvanceVoucherNotes((notes) => ({ ...notes, [application.id]: event.target.value }))} placeholder="填写人工复核意见后入账" />}
                    </span>
                    {!voucher && <button className="secondary-button" type="button" onClick={() => createAdvanceVoucherDraft(application.id)}><Plus size={15} />生成凭证草稿</button>}
                    {voucher && ["draft", "changes_requested"].includes(voucher.status) && <button className="primary-button" type="button" disabled={!advanceVoucherNotes[application.id]?.trim()} onClick={() => postAdvanceVoucher(application.id, voucher.id)}><CheckCircle size={15} />人工复核入账</button>}
                    {voucher?.status === "posted" && <b>{voucher.no} · 已入账</b>}
                  </div>;
                })}</div>}
                {allocations.length > 0 && <div className="settlement-source-list">{allocations.map((allocation) => <div key={allocation.id}><span><strong>{allocation.transaction?.date || "—"} · 原资金流水</strong><small>{allocation.transaction?.serial || allocation.transactionId} · {allocation.id}</small></span><b>¥{money(allocation.amount)}</b></div>)}</div>}
                {advance?.availableBalance > 0 && targets.length > 0 ? <div className="engine-form">
                  <label><span>对应账单 *</span><select value={usage.targetBillId} onChange={(event) => setAdvanceUsage((current) => ({ ...current, [bill.id]: { ...usage, targetBillId: event.target.value } }))}><option value="">选择同一交易对手的后续{bill.kind === BILL_KINDS.DEPOSIT_RECEIVED ? "应收" : "应付"}</option>{targets.map((target) => <option key={target.billId} value={target.billId}>{target.billNo || target.billId} · 未核销 ¥{money(target.remaining)}</option>)}</select></label>
                  <label><span>本次使用 *</span><input type="number" min="0.01" max={Number.isFinite(maximumUse) ? maximumUse : undefined} step="0.01" value={usage.amount} onChange={(event) => setAdvanceUsage((current) => ({ ...current, [bill.id]: { ...usage, amount: event.target.value } }))} placeholder="0.00" /></label>
                  <button className="primary-button wide" type="button" disabled={!usage.targetBillId || !(Number(usage.amount) > 0)} onClick={() => confirmAdvanceUse(bill.id)}><SealCheck size={16} />人工确认本次使用</button>
                </div> : <div className="engine-inline"><span><strong>{advance?.availableBalance > 0 ? "暂无可对应的后续账单" : "余额已全部使用"}</strong><small>预收与应收、预付与应付不会自动混用</small></span></div>}
              </details>
            </article>
          );
        }) : <p className="settlement-empty">还没有已形成资金余额的{terminology.customer}预收或{terminology.supplier}预付。</p>}
      </div>
      </section>
    </>
  );
}

function voucherStatusLabel(status) {
  return { unprocessed: "待处理", draft: "待复核", changes_requested: "待修订", posted: "已入账", superseded: "历史版本", invalidated: "已失效" }[status] || status;
}

function WorkspaceVoucherPanel({ onToast, voucherIds, showLedger = true, title = "本期凭证", actionBlockedReason = "" }) {
  const { activeWorkspace, actions, state, store, fileVault } = useFinanceDesk();
  const [filter, setFilter] = useState("current");
  const [notes, setNotes] = useState({});
  const [lineDrafts, setLineDrafts] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const accounts = useMemo(() => workspaceAccountOptions(activeWorkspace), [activeWorkspace]);
  const actor = currentActorName(state, activeWorkspace);
  const vouchers = (activeWorkspace.vouchers || []).filter((voucher) => voucher.period === activeWorkspace.currentPeriod && (!voucherIds || voucherIds.includes(voucher.id)));
  const pending = vouchers.filter((voucher) => ["draft", "changes_requested"].includes(voucher.status));
  const posted = vouchers.filter((voucher) => voucher.status === "posted");
  const visible = vouchers.filter((voucher) => filter === "all" || (filter === "pending" ? pending.includes(voucher) : ["posted", "draft", "changes_requested"].includes(voucher.status)));

  useEffect(() => { setNotes({}); setLineDrafts({}); setError(""); }, [activeWorkspace.id, activeWorkspace.currentPeriod]);

  async function changeVoucher(voucher, action) {
    if (busy || actionBlockedReason) return;
    setBusy(true);
    setError("");
    const current = store.getActiveWorkspace();
    const activeUserId = store.getState().activeUserId;
    const reason = notes[voucher.id] || "";
    try {
      if (voucher.payrollAccrual && action === "post") assertWorkspacePermission(store.getState(), current.id, "confirm.finance");
      let next = current;
      if (action === "revision") next = createPostedVoucherRevision(current, { voucherId: voucher.id, reason }, { actor });
      else if (action === "cancel") next = cancelReconciliationCorrection(current, { voucherId: voucher.id, reason }, { actor });
      else {
        if (lineDrafts[voucher.id]) next = reviseDraftVoucher(next, { voucherId: voucher.id, lines: lineDrafts[voucher.id], reason }, { actor });
        if (action === "post") next = await postVoucherWithEvidence(next, { voucherId: voucher.id, reviewNote: reason, mode: "manual" }, { actor, fileVault });
      }
      if (store.getActiveWorkspace() !== current) throw new Error("复核期间数据已变化，请重新操作");
      if (voucher.payrollAccrual && store.getState().activeUserId !== activeUserId) throw new Error("复核期间操作身份已变化，请重新复核");
      actions.replaceWorkspace(current.id, next, voucher.payrollAccrual && action === "post" ? { requiredPermission: "confirm.finance" } : undefined);
      setLineDrafts((drafts) => { const updated = { ...drafts }; delete updated[voucher.id]; return updated; });
      setNotes((currentNotes) => ({ ...currentNotes, [voucher.id]: "" }));
      onToast?.({ revision: "更正草稿已创建，原凭证继续有效", cancel: "更正草稿已取消，原记录继续有效", post: "凭证已复核入账", revise: "分录修订已保存" }[action]);
    } catch (caught) {
      setError(caught.message || "凭证处理失败");
      if (["VOUCHER_EVIDENCE_REQUIRED", "VOUCHER_ORIGINAL_REQUIRED"].includes(caught.code) && store.getActiveWorkspace() === current) {
        try { actions.replaceWorkspace(current.id, recordManualVoucherEvidenceFailure(current, voucher.id, caught.message, { actor })); }
        catch (recordError) { setError(`${caught.message}；补件任务未保存：${recordError.message}`); }
      }
    } finally { setBusy(false); }
  }

  return <div className="workspace-accounting-view">
    <section className="workspace-voucher-panel">
      <header className="settlement-heading"><div><h2>{title}</h2><p>{activeWorkspace.currentPeriod} · {pending.length} 张待复核 · {posted.length} 张已入账</p></div><label><span className="sr-only">凭证范围</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="current">当前有效记录</option><option value="pending">待复核</option><option value="all">包含历史与失效记录</option></select></label></header>
      {error && <div className="engine-error" role="alert"><WarningCircle size={16} />{error}</div>}
      {actionBlockedReason && <p className="engine-next-note">{actionBlockedReason}</p>}
      <div className="workspace-voucher-list">{visible.length ? visible.map((voucher) => {
        const draft = ["draft", "changes_requested"].includes(voucher.status);
        const manual = voucher.sourceType === "manual" || voucher.judgement?.eventType === "manualVoucher";
        const editable = draft && !manual && !voucher.reconciliationCorrection && !actionBlockedReason;
        const lines = lineDrafts[voucher.id] || voucher.lines;
        const validation = validateVoucherBalance({ lines }, accountingRules(activeWorkspace).amountTolerance, draft ? activeWorkspace : null);
        const attachments = buildAttachmentPackage(activeWorkspace, voucher.id);
        return <details className="workspace-voucher-record" key={voucher.id}>
          <summary><span><strong>{voucher.no || "草稿"} · {voucher.summary}</strong><small>{voucher.date} · {voucher.lines?.length || 0} 行分录</small></span><b>¥{money(validation.debit)}</b><em className={draft ? "engine-badge warning" : "engine-badge"}>{voucherStatusLabel(voucher.status)}</em></summary>
          <div className="workspace-voucher-content">
            {voucher.status === "invalidated" && <p className="engine-next-note">{voucher.invalidationReason}</p>}
            {voucher.reconciliationCorrection?.status === "pending" && <p className="engine-next-note">核销更正将在本张凭证入账时同步生效，原核销与原凭证目前仍然有效。</p>}
            {manual && draft && !voucher.payrollAccrual && <p className="engine-next-note">需要补充来源、附件或修改分录时，请进入“手工凭证”载入本张草稿。</p>}
            <VoucherAccountJudgement workspace={activeWorkspace} accounts={accounts} voucher={voucher} lines={lines} pending={Boolean(lineDrafts[voucher.id])} />
            <VoucherLineAccountEditor workspace={activeWorkspace} accounts={accounts} lines={lines} editable={editable}
              onChange={(index, patch) => updateVoucherLineDraft(setLineDrafts, voucher, (current) => current.map((line, position) => position === index ? { ...line, ...patch } : line))}
              onAdd={() => updateVoucherLineDraft(setLineDrafts, voucher, (current) => [...current, blankVoucherLine(voucher)])}
              onRemove={(index) => updateVoucherLineDraft(setLineDrafts, voucher, (current) => current.length > 2 ? current.filter((_, position) => position !== index) : current)} />
            {draft && <VoucherLineValidation validation={validation} />}
            {attachments.missing.length > 0 && <div className="engine-missing">{attachments.missing.map((item) => <span key={item.id}>待补：{item.label || item.id}</span>)}</div>}
            {(draft || voucher.status === "posted") && <div className="engine-form"><label className="full"><span>{draft ? "复核 / 修改意见" : "更正原因"}</span><textarea value={notes[voucher.id] || ""} onChange={(event) => setNotes((current) => ({ ...current, [voucher.id]: event.target.value }))} /></label><div className="engine-voucher-form-actions">
              {editable && <button className="secondary-button" type="button" disabled={busy || !notes[voucher.id]?.trim() || !lineDrafts[voucher.id] || !validation.balanced} onClick={() => changeVoucher(voucher, "revise")}>保存分录修订</button>}
              {draft && <button className="primary-button" type="button" disabled={busy || Boolean(actionBlockedReason) || !notes[voucher.id]?.trim() || !validation.balanced} onClick={() => changeVoucher(voucher, "post")}>{busy ? "正在复核…" : "复核入账"}</button>}
              {draft && voucher.revisionOf && <button className="secondary-button" type="button" disabled={busy || Boolean(actionBlockedReason) || !notes[voucher.id]?.trim()} onClick={() => changeVoucher(voucher, "cancel")}>取消更正</button>}
              {voucher.status === "posted" && !voucher.payrollAccrual && <button className="secondary-button" type="button" disabled={busy || Boolean(actionBlockedReason) || !notes[voucher.id]?.trim()} onClick={() => changeVoucher(voucher, "revision")}>创建更正草稿</button>}
            </div></div>}
            <details className="engine-section"><summary>来源、附件与历史 · {attachments.manifest.length} 项</summary><ul className="engine-trace-list">{attachments.manifest.map((item) => <li key={`${item.kind}-${item.id}`}><strong>{item.kind}</strong><span>{item.name}</span></li>)}</ul><p>{voucher.versions?.length || 0} 条版本记录 · {voucher.reviews?.length || 0} 条复核记录</p>{(voucher.versions || []).map((version, index) => <p key={index}>{version.at} · {version.actor} · {version.reason}</p>)}</details>
          </div>
        </details>;
      }) : <p className="settlement-empty">{voucherIds ? "当前范围没有计提凭证。" : "当前范围没有凭证；可从银行交易生成，或在手工凭证入口录入。"}</p>}</div>
    </section>
    {showLedger && <AccountingLedgerPanel workspace={activeWorkspace} onToast={onToast} />}
  </div>;
}

export function AccountingWorkbench(props) {
  return props.transactionId ? <TransactionAccountingWorkbench {...props} /> : <WorkspaceVoucherPanel {...props} />;
}

function TransactionAccountingWorkbench({ transactionId, onToast }) {
  const { activeWorkspace, actions, state, store, fileVault } = useFinanceDesk();
  const terminology = workspaceTerminology(activeWorkspace);
  const displayText = (value) => applyWorkspaceTerminology(value, activeWorkspace);
  const actor = currentActorName(state, activeWorkspace);
  const transaction = activeWorkspace.transactions.find((item) => item.id === transactionId);
  const [allocationAmounts, setAllocationAmounts] = useState({});
  const [judgement, setJudgement] = useState({
    businessType: "",
    account: "expenseOther",
    counterparty: "",
    relatedBillId: "",
    referenceNo: "",
    relatedTransactionId: "",
    businessPeriod: "",
    storeId: "",
    department: "",
    project: "",
    taxTreatment: "",
    invoiceStatus: "",
    evidenceIds: [],
    confidence: "",
    reason: "",
  });
  const [reviewReason, setReviewReason] = useState("");
  const [reversalReason, setReversalReason] = useState("");
  const [correctionTargets, setCorrectionTargets] = useState({});
  const [posting, setPosting] = useState(false);
  const stepRefs = useRef({});
  const [voucherNote, setVoucherNote] = useState("");
  const [voucherSummaries, setVoucherSummaries] = useState({});
  const [voucherLineDrafts, setVoucherLineDrafts] = useState({});
  const [exceptionNotes, setExceptionNotes] = useState({});
  const [exceptionTreatments, setExceptionTreatments] = useState({});
  const [exceptionAccounts, setExceptionAccounts] = useState({});
  const [refundSourceId, setRefundSourceId] = useState("");
  const [transferSourceId, setTransferSourceId] = useState("");
  const [error, setError] = useState("");
  const businessDepartmentListId = useId();
  const businessProjectListId = useId();

  const classification = useMemo(
    () => transaction ? effectiveBankTransactionClassification(activeWorkspace, transaction) : null,
    [activeWorkspace, transaction],
  );
  const accountingPolicy = useMemo(() => accountingRules(activeWorkspace), [activeWorkspace]);
  const availableBusinessTypes = useMemo(
    () => manualBusinessEventTypesForWorkspace(activeWorkspace),
    [activeWorkspace],
  );
  const accountOptions = useMemo(() => workspaceAccountOptions(activeWorkspace), [activeWorkspace]);
  const businessDimensionOptions = useMemo(() => voucherDimensionOptions(activeWorkspace), [activeWorkspace]);
  const memberModuleEnabled = memberBusinessEnabled(activeWorkspace);
  const assessment = useMemo(
    () => transaction
      ? (transaction.evidenceAssessment && transaction.classification === classification
        ? transaction.evidenceAssessment
        : assessTransactionEvidence(activeWorkspace, transaction, classification))
      : null,
    [activeWorkspace, transaction, classification],
  );
  const businessEvent = transaction
    ? (activeWorkspace.businessEvents || []).find((event) => (
      event.id === transaction.bankBusinessEventId
      || (event.sourceType === "bankTransaction" && event.transactionId === transaction.id)
    ))
    : null;
  const memberBusinessEventBlocked = Boolean(
    businessEvent
    && !memberModuleEnabled
    && (businessEvent.businessType === "memberRecharge" || businessEvent.eventType === EVENT_TYPES.MEMBER_RECHARGE),
  );
  const selectedBusinessDefinition = manualBusinessEventDefinition(judgement.businessType, activeWorkspace);
  const requiresBusinessEventConfirmation = Boolean(transaction && !businessEvent && (
    classification?.eventType === EVENT_TYPES.UNKNOWN
    || classification?.requiresManualReview
    || [
      EVENT_TYPES.LOAN,
      EVENT_TYPES.EMPLOYEE_ADVANCE,
      EVENT_TYPES.RELATED_PARTY,
      EVENT_TYPES.REFUND,
      EVENT_TYPES.INTERNAL_TRANSFER,
    ].includes(classification?.eventType)
    || (transaction.businessPeriod && transaction.businessPeriod !== String(transaction.date || "").slice(0, 7))
  ));
  const settlement = transaction ? transactionSettlement(transaction) : null;
  const suggestions = transaction ? suggestReconciliations(activeWorkspace, transaction.id) : [];
  const exceptions = transaction ? unresolvedExceptionTasks(activeWorkspace, transaction.id) : [];
  const exceptionCases = transaction ? buildReconciliationExceptionCases(activeWorkspace, transaction.id) : [];
  const allocations = transaction ? activeAllocations(transaction) : [];
  const vouchers = transaction ? vouchersForSource(activeWorkspace, transaction.id) : [];
  const activeVouchers = vouchers.filter((voucher) => ["posted", "draft", "changes_requested"].includes(voucher.status));
  const directlyPosted = Boolean(businessEvent?.status === "confirmed"
    && businessEvent.accountingStatus === "posted"
    && ["customerReceipt", "supplierPayment", "purchaseExpense", "payroll", "rentAndProperty", "bankFee"].includes(businessEvent.businessType)
    && !businessEvent.relatedBillId
    && allocations.length === 0
    && effectivePostedVouchers(activeWorkspace).some((voucher) => {
      if (voucher.bankBusinessEventId !== businessEvent.id) return false;
      const lines = (voucher.lines || []).filter((line) => Number(line.debit) || Number(line.credit));
      const businessLines = lines.filter((line) => !accountDefinition(line.account, activeWorkspace).cash);
      const cashMovement = lines.filter((line) => accountDefinition(line.account, activeWorkspace).cash)
        .reduce((total, line) => total + Number(line.debit || 0) - Number(line.credit || 0), 0);
      const categories = Number(transaction.amount) > 0 ? ["revenue"] : ["expense", "cost"];
      return businessLines.length > 0
        && businessLines.every((line) => categories.includes(accountDefinition(line.account, activeWorkspace).category))
        && Math.abs(cashMovement - Number(transaction.amount)) <= accountingPolicy.amountTolerance;
    }));
  const periodWritable = transaction && String(transaction.date).slice(0, 7) === activeWorkspace.currentPeriod
    && !activeWorkspace.delivery?.archives?.some((archive) => archive.period === activeWorkspace.currentPeriod)
    && !activeWorkspace.delivery?.filing?.archivedAt;
  const voucheredSourceIds = new Set(vouchers
    .filter((voucher) => ["posted", "draft", "changes_requested"].includes(voucher.status))
    .flatMap((voucher) => [...(voucher.sourceIds || []), ...(voucher.lines || []).flatMap((line) => line.sourceIds || [])]));
  const unvoucheredAllocations = allocations.filter((allocation) => (
    !voucheredSourceIds.has(allocation.id) && (allocation.id || !voucheredSourceIds.has(allocation.billId))
  ));
  const businessEventReadyForDraft = !businessEvent || (!memberBusinessEventBlocked && (
    businessEvent.status === "confirmed"
    && Number(businessEvent.evidenceCompleteness) === 100
    && businessEvent.taxAttributes?.status === "confirmed"
    && businessEvent.taxAttributes?.treatment !== "tax_pending"
    && !businessEvent.review?.required
    && (!(businessEvent.crossPeriod || REVIEW_REQUIRED_BANK_BUSINESS_TYPES.has(businessEvent.businessType)) || businessEvent.review?.status === "approved")
    && !["voucher_draft", "posted"].includes(businessEvent.accountingStatus)
  ));
  const canCreateDraft = periodWritable && !requiresBusinessEventConfirmation
    && classification?.eventType !== EVENT_TYPES.UNKNOWN
    && exceptions.length === 0
    && businessEventReadyForDraft
    && (allocations.length ? unvoucheredAllocations.length > 0 : activeVouchers.length === 0);
  const eligibleBills = transaction
    ? activeWorkspace.bills.filter((bill) => allocationDirectionMatchesBill(transaction, bill) && billSettlement(activeWorkspace, bill).remaining > 0.01)
    : [];
  const allocationInputs = transaction
    ? Object.entries(allocationAmounts)
      .filter(([, amount]) => String(amount).trim() !== "")
      .map(([billId, amount]) => ({ billId, amount }))
    : [];
  const allocationDraft = transaction
    ? buildReconciliationAllocationDraft(activeWorkspace, { transactionId, allocations: allocationInputs })
    : null;
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
  const businessEventBills = selectedBusinessDefinition && transaction
    ? activeWorkspace.bills.filter((bill) => (
      selectedBusinessDefinition.billKinds.includes(bill.kind)
      && allocationDirectionMatchesBill(transaction, bill)
    ))
    : [];
  const businessEventRelatedTransactions = selectedBusinessDefinition?.relatedTransactionRole && transaction
    ? activeWorkspace.transactions.filter((item) => {
      if (item.id === transaction.id || Math.sign(Number(item.amount)) === Math.sign(Number(transaction.amount))) return false;
      if (selectedBusinessDefinition.relatedTransactionRole !== "counterpart_transaction") return true;
      return item.accountId !== transaction.accountId
        && Math.abs(Math.abs(Number(item.amount)) - Math.abs(Number(transaction.amount))) <= 0.01;
    })
    : [];

  useEffect(() => {
    setAllocationAmounts({});
    setReviewReason("");
    setReversalReason("");
    setCorrectionTargets({});
    setVoucherNote("");
    setVoucherSummaries({});
    setVoucherLineDrafts({});
    setExceptionNotes({});
    setExceptionTreatments({});
    setExceptionAccounts({});
    setRefundSourceId("");
    setTransferSourceId("");
    setError("");
    if (classification) {
      const direction = Number(transaction?.amount || 0) >= 0 ? "in" : "out";
      const suggestedDefinition = classification.eventType === EVENT_TYPES.UNKNOWN
        ? null
        : availableBusinessTypes.find((definition) => (
          definition.eventType === classification.eventType && definition.allowedDirections.includes(direction)
        ));
      setJudgement({
        businessType: suggestedDefinition?.id || "",
        account: activeAccountOrEmpty(
          accountOptions,
          suggestedDefinition?.account || classification.account || "expenseOther",
        ),
        counterparty: transaction?.counterparty || "",
        relatedBillId: "",
        referenceNo: "",
        relatedTransactionId: transaction?.counterpartTransactionId || "",
        businessPeriod: transaction?.businessPeriod || String(transaction?.date || "").slice(0, 7),
        storeId: voucherLineDimensionInput(transaction, "storeId", "locationId"),
        department: voucherLineDimensionInput(transaction, "department", "departmentName"),
        project: voucherLineDimensionInput(transaction, "project", "projectName"),
        taxTreatment: suggestedDefinition?.fixedTaxTreatment || "",
        invoiceStatus: suggestedDefinition?.invoiceRequired ? "" : "not_applicable",
        evidenceIds: [...(transaction?.evidenceIds || [])],
        confidence: classification.confidence,
        reason: "",
      });
    }
  }, [transactionId, activeWorkspace.modules?.members, accountOptions]);

  if (!transaction || !classification || !assessment) return null;

  function run(action, successMessage) {
    setError("");
    try {
      const current = store.getActiveWorkspace();
      const next = action(current);
      actions.replaceWorkspace(current.id, next);
      onToast?.(displayText(successMessage));
      return true;
    } catch (caught) {
      setError(displayText(caught.message || "会计处理失败"));
      return false;
    }
  }

  function confirmBusinessEvent(workspace, input) {
    const context = { actor, mode: "manual" };
    const confirmed = confirmBankTransactionBusinessEvent(workspace, input, context);
    return setBankTransactionBusinessEventDimensions(confirmed, input, context);
  }

  function inspect() {
    run(
      (workspace) => recordReconciliationSuggestions(
        reviewTransactionEvidence(workspace, transaction.id, { actor, mode: "local-rule" }),
        transaction.id,
        { actor, mode: "local-rule" },
      ),
      "已完成本地分类、证据检查和疑似匹配；未自动入账",
    );
  }

  function manualClassify(event) {
    event.preventDefault();
    const needsExplicitReview = Number(judgement.confidence) < accountingPolicy.confidenceThreshold;
    run(
      (workspace) => confirmBusinessEvent(workspace, {
        transactionId,
        businessType: judgement.businessType,
        account: judgement.account,
        counterparty: judgement.counterparty,
        relatedBillId: judgement.relatedBillId,
        referenceNo: judgement.referenceNo,
        relatedTransactionId: judgement.relatedTransactionId,
        businessPeriod: judgement.businessPeriod,
        storeId: judgement.storeId,
        department: judgement.department,
        project: judgement.project,
        taxTreatment: judgement.taxTreatment,
        invoiceStatus: judgement.invoiceStatus,
        evidenceIds: judgement.evidenceIds,
        confidence: judgement.confidence,
        reason: judgement.reason,
      }),
      needsExplicitReview
        ? "业务判断已保存，低置信度事项仍需人工复核"
        : "业务事件已人工确认；仅完成分类与留痕，未生成或入账凭证",
    );
  }

  function selectBusinessType(businessType) {
    const definition = manualBusinessEventDefinition(businessType, activeWorkspace);
    setJudgement((current) => ({
      ...current,
      businessType,
      account: activeAccountOrEmpty(accountOptions, definition?.account || current.account),
      relatedBillId: "",
      referenceNo: "",
      relatedTransactionId: "",
      taxTreatment: definition?.fixedTaxTreatment || "",
      invoiceStatus: definition?.invoiceRequired ? "" : "not_applicable",
    }));
  }

  function handleException(exceptionCase, action) {
    const note = exceptionNotes[exceptionCase.id] || "";
    const treatmentId = exceptionTreatments[exceptionCase.id] || exceptionCase.accountingTreatments[0]?.id || "";
    const treatment = exceptionCase.accountingTreatments.find((item) => item.id === treatmentId);
    const selectedAccount = exceptionAccounts[exceptionCase.id] || treatment?.account || "";
    if (action === "adopt_treatment" && treatment?.kind === "classification" && businessEvent && treatment.eventType !== businessEvent.eventType) {
      setError("这条异常已绑定人工业务事件；变更业务类型需要回到人工业务确认重新填写对应税务与业务依据");
      return;
    }
    if (action === "adopt_treatment" && treatment?.kind === "classification" && !accountIsActive(accountOptions, selectedAccount)) {
      setError("请选择当前工作台中的有效科目；停用科目只能查看历史记录");
      return;
    }
    const messages = {
      recalculate: "已按当前补件重新计算证据与匹配状态",
      rematch: "已返回匹配队列；无法形成强候选的事项仍保持待核实",
      adopt_treatment: "所选会计处理已人工确认并写回，未自动入账",
      defer: "已记录暂不处理，事项继续阻塞凭证入账",
    };
    run(
      (workspace) => {
        let prepared = workspace;
        let resolvedTreatmentId = treatmentId;
        if (action === "adopt_treatment" && treatment?.kind === "classification" && selectedAccount !== treatment.account) {
          prepared = businessEvent
            ? confirmBusinessEvent(prepared, {
              transactionId: exceptionCase.transaction.id,
              businessType: businessEvent.businessType,
              account: selectedAccount,
              counterparty: businessEvent.counterparty,
              relatedBillId: businessEvent.relatedBillId,
              referenceNo: businessEvent.referenceNo,
              relatedTransactionId: businessEvent.relatedTransactionId
                || businessEvent.originalTransactionId
                || businessEvent.counterpartTransactionId,
              businessPeriod: businessEvent.businessPeriod,
              storeId: businessEvent.storeId || null,
              department: businessEvent.department || null,
              project: businessEvent.project || null,
              taxTreatment: businessEvent.taxAttributes?.treatment,
              invoiceStatus: businessEvent.taxAttributes?.invoiceStatus || "not_applicable",
              evidenceIds: businessEvent.evidenceIds || [],
              confidence: businessEvent.confidence,
              reason: note,
            })
            : applyManualClassification(prepared, {
              transactionId: exceptionCase.transaction.id,
              eventType: treatment.eventType,
              account: selectedAccount,
              reason: note,
            }, { actor, mode: "manual" });
          resolvedTreatmentId = `classification:${treatment.eventType}:${selectedAccount}`;
        }
        return handleReconciliationException(prepared, {
          exceptionId: exceptionCase.id,
          action,
          note,
          treatmentId: action === "adopt_treatment" ? resolvedTreatmentId : undefined,
        }, { actor, mode: "manual" });
      },
      messages[action],
    );
  }

  function selectExceptionTreatment(exceptionCase, treatmentId) {
    const treatment = exceptionCase.accountingTreatments.find((item) => item.id === treatmentId);
    setExceptionTreatments((current) => ({ ...current, [exceptionCase.id]: treatmentId }));
    setExceptionAccounts((current) => ({
      ...current,
      [exceptionCase.id]: treatment?.kind === "classification"
        ? activeAccountOrEmpty(accountOptions, treatment.account)
        : "",
    }));
  }

  function applyAllocations() {
    if (!allocationDraft?.valid) {
      setError(allocationDraft?.message || "请至少填写一笔本次核销金额");
      return;
    }
    const selected = allocationDraft.rows.map((row) => ({ billId: row.billId, amount: row.amount }));
    if (run(
      (workspace) => applyReconciliation(workspace, {
        transactionId,
        allocations: selected,
        note: reviewReason || "财务人员在单笔工作台确认",
      }, { actor, mode: "manual" }),
      "核销已保存；流水余额与账单余额已同步更新",
    )) setAllocationAmounts({});
  }

  function confirmSuggestion(suggestion) {
    run(
      (workspace) => confirmReconciliationSuggestion(workspace, {
        transactionId,
        suggestionId: suggestion.id,
        note: reviewReason || "财务人员在匹配候选中明确确认",
      }, { actor, mode: "manual" }),
      `已确认${reconciliationSuggestionLabel(suggestion.type)}候选；只写入核销分配，未生成或入账凭证`,
    );
  }

  function reverse(allocationId) {
    const posted = vouchersForReconciliation(store.getActiveWorkspace(), transactionId, allocationId).some((voucher) => voucher.status === "posted");
    run(
      (workspace) => posted
        ? createReconciliationCorrection(workspace, { allocationId, billId: correctionTargets[allocationId], reason: reversalReason }, { actor })
        : reverseReconciliation(workspace, { allocationId, reason: reversalReason }, { actor }),
      posted ? "核销更正草稿已生成；在下方复核入账后，核销与凭证才会同步替换" : "核销已撤销，相关旧草稿已失效留痕；可重新核销并生成草稿",
    );
  }

  function linkRefund() {
    run(
      (workspace) => linkRefundToOriginal(workspace, {
        refundTransactionId: transactionId,
        originalSourceId: refundSourceId,
        amount: Math.abs(Number(transaction.amount)),
        reason: reviewReason,
      }, { actor }),
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
      }, { actor }),
      "两端银行流水已确认为内部转账，避免重复计入收支",
    );
  }

  function changeVoucherLine(voucher, lineIndex, changes) {
    updateVoucherLineDraft(setVoucherLineDrafts, voucher, (lines) => lines.map((line, index) => (
      index === lineIndex ? { ...line, ...changes } : line
    )));
  }

  function addVoucherLine(voucher) {
    updateVoucherLineDraft(setVoucherLineDrafts, voucher, (lines) => [...lines, blankVoucherLine(voucher)]);
  }

  function removeVoucherLine(voucher, lineIndex) {
    updateVoucherLineDraft(setVoucherLineDrafts, voucher, (lines) => (
      lines.length > 2 ? lines.filter((_, index) => index !== lineIndex) : lines
    ));
  }

  function clearVoucherEdits(voucherId) {
    setVoucherLineDrafts((current) => {
      const next = { ...current };
      delete next[voucherId];
      return next;
    });
    setVoucherSummaries((current) => {
      const next = { ...current };
      delete next[voucherId];
      return next;
    });
  }

  function createDraft() {
    if (memberBusinessEventBlocked) {
      setError(`${terminology.member}模块已关闭；历史${terminology.member}业务仅保留查看，不能继续生成凭证`);
      return;
    }
    run(
      (workspace) => businessEvent
        ? createBankBusinessEventVoucherDraft(workspace, {
          eventId: businessEvent.id,
          note: voucherNote,
        }, { actor, mode: "manual" })
        : createVoucherDraft(workspace, {
          transactionId,
          note: voucherNote,
        }, { actor }),
      businessEvent ? "已由人工业务事件生成平衡凭证草稿；仍需填写复核意见后入账" : "已生成借贷平衡的凭证草稿与来源链",
    );
  }

  async function postDraft(voucher) {
    if (posting) return;
    if (memberBusinessEventBlocked) {
      setError(`${terminology.member}模块已关闭；历史${terminology.member}业务凭证保持未入账`);
      return;
    }
    const editedLines = voucherLineDrafts[voucher.id] || voucher.lines;
    const validation = voucherDraftValidation(activeWorkspace, editedLines);
    if (!validation.balanced) {
      setError(validation.errors.join("；"));
      return;
    }
    const hasPendingEdits = Boolean(voucherLineDrafts[voucher.id]) || Object.hasOwn(voucherSummaries, voucher.id);
    setError("");
    setPosting(true);
    try {
        const current = store.getActiveWorkspace();
        const prepared = hasPendingEdits
          ? reviseDraftVoucher(current, {
            voucherId: voucher.id,
            summary: voucherSummaries[voucher.id] ?? voucher.summary,
            lines: editedLines,
            reason: voucherNote,
          }, { actor })
          : current;
        const next = await postVoucherWithEvidence(prepared, {
          voucherId: voucher.id,
          mode: "manual",
          reviewNote: voucherNote,
        }, { actor, fileVault });
        if (store.getActiveWorkspace() !== current) throw new Error("复核期间数据已变化，请重新复核入账");
        actions.replaceWorkspace(current.id, next);
        onToast?.(voucher.reconciliationCorrection ? "核销与更正凭证已同步入账，旧核销和旧凭证保留为历史" : "凭证已人工复核入账，编号和附件来源已锁定");
        clearVoucherEdits(voucher.id);
    } catch (caught) {
      setError(displayText(caught.message || "凭证入账失败"));
      if (["VOUCHER_EVIDENCE_REQUIRED", "VOUCHER_ORIGINAL_REQUIRED"].includes(caught.code)) {
        const current = store.getActiveWorkspace();
        if (current.id === activeWorkspace.id) {
          try { actions.replaceWorkspace(current.id, recordManualVoucherEvidenceFailure(current, voucher.id, caught.message, { actor })); }
          catch (recordError) { setError(`${caught.message}；补件任务未保存：${recordError.message}`); }
        }
      }
    } finally { setPosting(false); }
  }

  function reviseVoucher(voucher) {
    const editedLines = voucherLineDrafts[voucher.id] || voucher.lines;
    const validation = voucherDraftValidation(activeWorkspace, editedLines);
    if (!validation.balanced) {
      setError(validation.errors.join("；"));
      return;
    }
    if (run(
      (workspace) => reviseDraftVoucher(workspace, {
        voucherId: voucher.id,
        summary: voucherSummaries[voucher.id] ?? voucher.summary,
        lines: editedLines,
        reason: voucherNote,
      }, { actor }),
      "凭证草稿已形成新版本，旧版本仍保留",
    )) clearVoucherEdits(voucher.id);
  }

  function createRevision(voucherId) {
    run(
      (workspace) => createPostedVoucherRevision(workspace, {
        voucherId,
        reason: voucherNote,
      }, { actor }),
      "已入账凭证未被覆盖，已创建独立更正草稿",
    );
  }

  function cancelRevision(voucherId) {
    run((workspace) => cancelReconciliationCorrection(workspace, { voucherId, reason: voucherNote }, { actor }), "更正草稿已取消，原核销和原凭证继续有效；可以重新选择目标账单");
  }

  function requestVoucherChanges(voucherId) {
    run(
      (workspace) => reviewVoucher(workspace, {
        voucherId,
        decision: "reject",
        note: voucherNote,
      }, { actor }),
      "凭证已退回修改，复核意见和状态已保存在本地",
    );
  }

  function openStep(step) {
    const element = stepRefs.current[step];
    if (!element) return;
    element.open = true;
    element.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  const nextAction = !periodWritable ? null
    : requiresBusinessEventConfirmation ? { label: "确认这笔业务", run: () => openStep("business") }
      : exceptionCases.length ? { label: `处理 ${exceptionCases.length} 项待办`, run: () => openStep("exceptions") }
        : canCreateDraft ? { label: "生成凭证草稿", run: createDraft }
          : activeVouchers.some((voucher) => ["draft", "changes_requested"].includes(voucher.status)) ? { label: "复核待入账凭证", run: () => openStep("vouchers") }
            : directlyPosted ? { label: "查看已入账凭证", run: () => openStep("vouchers") }
            : suggestions.some((suggestion) => !suggestion.requiresManualReview) ? { label: "确认匹配建议", run: () => openStep("suggestions") }
              : eligibleBills.length && settlement.remaining > 0.01 && ![EVENT_TYPES.REFUND, EVENT_TYPES.INTERNAL_TRANSFER, EVENT_TYPES.UNKNOWN].includes(classification.eventType) ? { label: "选择账单核销", run: () => openStep("allocations") }
                : transaction.status !== "posted" && !businessEvent ? { label: "更新判断与资料状态", run: inspect } : null;

  return (
    <section className="accounting-workbench transaction-accounting-workbench">
      <div className="accounting-heading">
        <div><small>{Number(transaction.amount) >= 0 ? "本笔收款" : "本笔付款"}</small><strong>¥{money(Math.abs(Number(transaction.amount)))}</strong></div>
        <span className={assessment.issues.length ? "engine-badge warning" : "engine-badge"}>{assessment.missing.length ? `待补 ${assessment.missing.length} 类资料` : "资料已关联"}</span>
      </div>

      {error && <div className="engine-error"><WarningCircle size={16} />{error}</div>}

      <div className="engine-summary">
        <span><small>业务判断</small><strong>{localizedEventLabel(classification.eventType, activeWorkspace)}</strong></span>
        <span><small>{directlyPosted ? "账务状态" : "核销状态"}</small><strong>{directlyPosted ? "已直接入账" : statusLabel(settlement.status)}</strong></span>
        <span><small>{directlyPosted ? "账单核销" : "未核销"}</small><strong>{directlyPosted ? "本笔无需核销" : `¥${money(settlement.remaining)}`}</strong></span>
      </div>
      {assessment.missing.length > 0 && <p className="engine-next-note">待补：{assessment.missing.map((item) => displayText(item.label)).join("、")}。请在本笔资料区关联原件后继续复核。</p>}
      {nextAction && <button className="primary-button wide" type="button" onClick={nextAction.run}>{nextAction.label}</button>}

      {requiresBusinessEventConfirmation && (
        <details className="engine-section" ref={(node) => { stepRefs.current.business = node; }}><summary>确认业务性质</summary>
        <form className="engine-form" onSubmit={manualClassify}>
          <div className="engine-subheading full"><strong>业务判断</strong><small>保存后仍需复核凭证</small></div>
          <label className="full"><span>业务类型 *</span><select required value={judgement.businessType} onChange={(event) => selectBusinessType(event.target.value)}><option value="">请选择业务类型</option>{availableBusinessTypes.map((definition) => <option value={definition.id} key={definition.id} disabled={!definition.allowedDirections.includes(Number(transaction.amount) >= 0 ? "in" : "out")}>{displayText(definition.label)}</option>)}</select></label>
          {selectedBusinessDefinition && (
            <>
              {selectedBusinessDefinition.counterpartyRequired && <label><span>交易对手 *</span><input required value={judgement.counterparty} onChange={(event) => setJudgement((current) => ({ ...current, counterparty: event.target.value }))} placeholder={`${terminology.customer}、${terminology.supplier}、${terminology.personnel}或资金方`} /></label>}
              <label><span>会计属性 / 主科目 *</span><WorkspaceAccountSelect workspace={activeWorkspace} accounts={accountOptions} value={judgement.account} onChange={(account) => setJudgement((current) => ({ ...current, account }))} ariaLabel="人工确认业务主科目" required /><small>仅列出当前有效科目；用户新增科目与自定义名称会直接进入后续凭证分录。</small></label>
              <label><span>业务期间 *</span><input required type="month" value={judgement.businessPeriod} onChange={(event) => setJudgement((current) => ({ ...current, businessPeriod: event.target.value }))} /></label>
              <label><span>资金期间</span><input readOnly value={String(transaction.date || "").slice(0, 7)} /></label>
              <label><span>{terminology.location}</span><select value={judgement.storeId} onChange={(event) => setJudgement((current) => ({ ...current, storeId: event.target.value }))}><option value="">不设置</option>{judgement.storeId && !businessDimensionOptions.stores.some((item) => item.id === judgement.storeId) && <option value={judgement.storeId}>{voucherLineDimensionInput(transaction, "storeName", "store", "locationName") || judgement.storeId}（历史）</option>}{businessDimensionOptions.stores.map((item) => <option value={item.id} key={item.id}>{item.name || item.id}</option>)}</select></label>
              <label><span>部门</span><input list={businessDepartmentListId} value={judgement.department} onChange={(event) => setJudgement((current) => ({ ...current, department: event.target.value }))} placeholder="选择已有部门或手填" /><datalist id={businessDepartmentListId}>{businessDimensionOptions.departments.map((item) => <option value={item} key={item} />)}</datalist></label>
              <label><span>项目</span><input list={businessProjectListId} value={judgement.project} onChange={(event) => setJudgement((current) => ({ ...current, project: event.target.value }))} placeholder="选择已有项目或手填" /><datalist id={businessProjectListId}>{businessDimensionOptions.projects.map((item) => <option value={item} key={item} />)}</datalist></label>
              {selectedBusinessDefinition.billKinds.length > 0 && <label><span>关联账单{selectedBusinessDefinition.referenceMode === "bill_or_reference" ? "（与编号至少一项）" : ""}</span><select value={judgement.relatedBillId} onChange={(event) => setJudgement((current) => ({ ...current, relatedBillId: event.target.value }))}><option value="">暂不选择账单</option>{businessEventBills.map((bill) => <option value={bill.id} key={bill.id}>{bill.no || bill.id} · {bill.counterparty} · ¥{money(bill.amount)}</option>)}</select></label>}
              {selectedBusinessDefinition.referenceMode !== "none" && <label><span>{displayText(selectedBusinessDefinition.referenceLabel)}{selectedBusinessDefinition.referenceMode === "reference" ? " *" : ""}</span><input value={judgement.referenceNo} onChange={(event) => setJudgement((current) => ({ ...current, referenceNo: event.target.value }))} placeholder="填写可追溯的订单、合同或审批编号" /></label>}
              {selectedBusinessDefinition.relatedTransactionRole && <label className="full"><span>{selectedBusinessDefinition.relatedTransactionRole === "original_transaction" ? "原业务流水 *" : "内部转账另一端流水 *"}</span><select required value={judgement.relatedTransactionId} onChange={(event) => setJudgement((current) => ({ ...current, relatedTransactionId: event.target.value }))}><option value="">请选择关联流水</option>{businessEventRelatedTransactions.map((item) => <option value={item.id} key={item.id}>{item.date} · {item.serial || item.id} · {item.counterparty} · {Number(item.amount) > 0 ? "+" : "−"}¥{money(item.amount)}</option>)}</select></label>}
              {selectedBusinessDefinition.fixedTaxTreatment
                ? <label><span>税务属性</span><input readOnly value={BUSINESS_EVENT_TAX_TREATMENTS.find((item) => item.id === selectedBusinessDefinition.fixedTaxTreatment)?.label || selectedBusinessDefinition.fixedTaxTreatment} /></label>
                : <label><span>税务属性 *</span><select required value={judgement.taxTreatment} onChange={(event) => setJudgement((current) => ({ ...current, taxTreatment: event.target.value }))}><option value="">请选择税务属性</option>{BUSINESS_EVENT_TAX_TREATMENTS.filter((item) => selectedBusinessDefinition.taxTreatments.includes(item.id)).map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>}
              {selectedBusinessDefinition.invoiceRequired && <label><span>发票状态 *</span><select required value={judgement.invoiceStatus} onChange={(event) => setJudgement((current) => ({ ...current, invoiceStatus: event.target.value }))}><option value="">请选择发票状态</option>{BUSINESS_EVENT_INVOICE_STATUSES.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>}
              <label className="full"><span>关联证据（可多选）· 期望：{displayText(selectedBusinessDefinition.evidenceHint)}</span><select multiple size={Math.min(5, Math.max(2, activeWorkspace.documents.length))} value={judgement.evidenceIds} onChange={(event) => setJudgement((current) => ({ ...current, evidenceIds: Array.from(event.target.selectedOptions, (option) => option.value) }))}>{activeWorkspace.documents.map((document) => <option value={document.id} key={document.id}>{document.name || document.title || document.id} · {document.type || "资料"}</option>)}</select></label>
              <label><span>复核后置信度（0–100）* · 原判断 {classification.confidence}%</span><input required type="number" min="0" max="100" step="1" value={judgement.confidence} onChange={(event) => setJudgement((current) => ({ ...current, confidence: event.target.value }))} /></label>
              <label><span>处理说明</span><input readOnly value={`${displayText(selectedBusinessDefinition.accountingTreatment.split("；主科目：")[0])}；主科目：${workspaceAccountLabel(activeWorkspace, accountOptions, judgement.account)}`} /></label>
              {Number(judgement.confidence) < accountingPolicy.confidenceThreshold && <div className="engine-missing full"><span>当前低于复核阈值 {accountingPolicy.confidenceThreshold}%，请完成待办中的人工复核后再继续入账。</span></div>}
              <label className="full"><span>人工判断依据 *</span><textarea required value={judgement.reason} onChange={(event) => setJudgement((current) => ({ ...current, reason: event.target.value }))} placeholder="写明核对了哪些对手、账单或订单、期间、税务和证据" /></label>
              <button className="secondary-button wide" type="submit">{Number(judgement.confidence) < accountingPolicy.confidenceThreshold ? "保存判断并进入人工复核" : "确认业务事件（不入账）"}</button>
            </>
          )}
        </form>
        </details>
      )}

      {businessEvent && (
        <details className="engine-section"><summary>已确认：{displayText(businessEvent.businessTypeLabel)}</summary>
        <div className="engine-special">
          <div className="engine-subheading"><strong>{businessEvent.businessEventNo}</strong><small>凭证仍须人工复核</small></div>
          <div className="engine-summary">
            <span><small>业务期 / 资金期</small><strong>{businessEvent.businessPeriod} / {businessEvent.fundingPeriod}</strong></span>
            <span><small>{terminology.location} / 部门 / 项目</small><strong>{[businessEvent.storeName, businessEvent.department, businessEvent.project].filter(Boolean).join(" · ") || "未设置"}</strong></span>
            <span><small>业务事件原判断</small><strong>{displayText(accountDefinition(businessEvent.accountingAttributes.primaryAccount, activeWorkspace).label)}</strong></span>
            <span><small>税务属性</small><strong>{BUSINESS_EVENT_TAX_TREATMENTS.find((item) => item.id === businessEvent.taxAttributes.treatment)?.label || businessEvent.taxAttributes.treatment}</strong></span>
            <span><small>证据 / 置信度</small><strong>{businessEvent.evidenceCompleteness}% / {businessEvent.confidence}%</strong></span>
            <span><small>凭证状态</small><strong>{voucherStatusLabel(businessEvent.accountingStatus || "unprocessed")}</strong></span>
          </div>
          <ul className="engine-reasons">{businessEvent.reasons.map((reason) => <li key={`${businessEvent.id}-${reason}`}>{displayText(reason)}</li>)}</ul>
          {memberBusinessEventBlocked && <div className="engine-missing"><span>{terminology.member}模块已关闭；这条历史{terminology.member}业务保留只读，不能继续生成、修改或入账凭证。重新启用{terminology.member}模块后才可继续处理。</span></div>}
          {businessEvent.review?.required && <div className="engine-missing"><span>仍需人工复核：{businessEvent.review.reasons.map(displayText).join("；")}</span></div>}
          {!memberBusinessEventBlocked && businessEvent.accountingStatus === "unprocessed" && !businessEventReadyForDraft && <div className="engine-missing"><span>请先补齐证据、确认税务属性并完成待办复核。</span></div>}
        </div>
        </details>
      )}

      {exceptionCases.length > 0 && (
        <details className="engine-section" ref={(node) => { stepRefs.current.exceptions = node; }}><summary>待处理事项 · {exceptionCases.length}</summary>
        <div className="engine-exceptions">
          {exceptionCases.map((item) => {
            const note = exceptionNotes[item.id] || "";
            const selectedTreatmentId = exceptionTreatments[item.id] || item.accountingTreatments[0]?.id || "";
            const selectedTreatment = item.accountingTreatments.find((treatment) => treatment.id === selectedTreatmentId);
            const selectedAccount = exceptionAccounts[item.id] || selectedTreatment?.account || "";
            const accountRequired = selectedTreatment?.kind === "classification";
            const requiresBusinessTypeReconfirmation = Boolean(
              accountRequired && businessEvent && selectedTreatment.eventType !== businessEvent.eventType,
            );
            return <article className="engine-voucher-card" key={item.id}>
              <div className="engine-voucher-row"><WarningCircle size={16} /><span><strong>{displayText(item.triggerReason)}</strong><small>{exceptionWorkflowLabel(item.workflowState)}</small></span><em className="engine-badge warning">待处理</em></div>
              <details><summary>查看相关记录与缺件明细</summary>
              <div className="engine-summary">
                <span><small>相关流水</small><strong>{item.relatedTransactions.map((source) => source.serial || source.id).join("、") || "无"}</strong></span>
                <span><small>相关账单</small><strong>{item.relatedBills.map((bill) => bill.no || bill.id).join("、") || "无"}</strong></span>
                <span><small>相关资料</small><strong>{item.relatedDocuments.map((document) => document.name).join("、") || "无"}</strong></span>
                <span><small>缺少内容</small><strong>{item.missingContents.map((missing) => displayText(missing.label)).join("、") || "未识别出明确缺件"}</strong></span>
              </div>
              </details>
              <details>
                <summary>查看匹配依据和账单余额</summary>
                <ul className="engine-reasons">{item.matchBasis.length ? item.matchBasis.map((reason) => <li key={`${item.id}-${reason}`}>{displayText(reason)}</li>) : <li>当前没有足够依据形成匹配结论</li>}</ul>
                {item.relatedBills.length > 0 && <div className="settlement-source-list">{item.relatedBills.map((bill) => <div key={bill.id}><span><strong>{bill.no || bill.id} · {bill.counterparty}</strong><small>{localizedBillKindMeta(bill.kind, activeWorkspace).label}</small></span><b>未核销 ¥{money(bill.remaining)}</b></div>)}</div>}
              </details>
              <div className="engine-account-grid">
                <label><span>可选会计处理</span><select value={selectedTreatmentId} onChange={(event) => selectExceptionTreatment(item, event.target.value)}>{item.accountingTreatments.length ? item.accountingTreatments.map((treatment) => <option value={treatment.id} key={treatment.id}>{displayText(treatment.label)}</option>) : <option value="">当前无法判断</option>}</select></label>
                {accountRequired && <label><span>采用后的会计科目</span><WorkspaceAccountSelect workspace={activeWorkspace} accounts={accountOptions} value={selectedAccount} onChange={(account) => setExceptionAccounts((current) => ({ ...current, [item.id]: account }))} ariaLabel={`${item.code} 采用后的会计科目`} required /><small>确认后写回流水分类，随后生成的凭证使用此科目。</small></label>}
              </div>
              {requiresBusinessTypeReconfirmation && <div className="engine-missing"><span>该处理会改变已确认的业务类型，请回到人工业务确认重新填写对应税务属性和业务依据。</span></div>}
              <label><span>复核说明 *</span><textarea value={note} onChange={(event) => setExceptionNotes((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="写明补了什么、重新核对了什么，以及为何采用或暂不处理" /></label>
              <div className="engine-inline">
                <button className="secondary-button" type="button" disabled={!note.trim()} onClick={() => handleException(item, "recalculate")}>补件后重算</button>
                <button className="secondary-button" type="button" disabled={!note.trim()} onClick={() => handleException(item, "rematch")}>返回重新匹配</button>
                <button className="primary-button" type="button" disabled={!note.trim() || !selectedTreatment || requiresBusinessTypeReconfirmation || (accountRequired && !accountIsActive(accountOptions, selectedAccount))} onClick={() => handleException(item, "adopt_treatment")}>采用所选处理</button>
                <button className="secondary-button" type="button" disabled={!note.trim()} onClick={() => handleException(item, "defer")}>暂不处理</button>
              </div>
            </article>;
          })}
        </div>
        </details>
      )}

      {suggestions.length > 0 && (
        <details className="engine-section" ref={(node) => { stepRefs.current.suggestions = node; }}><summary>匹配建议 · {suggestions.length}</summary>
        <div className="engine-suggestions">
          <div className="engine-subheading"><strong>自动匹配候选</strong><small>确认前不会写入核销或凭证</small></div>
          {suggestions.map((item) => (
            <article className="engine-voucher-card" key={item.id}>
              <div className="engine-voucher-row">
                <GitBranch size={16} />
                <span>
                  <strong>{reconciliationSuggestionLabel(item.type)} · {item.transactionIds.length} 笔流水 / {item.billIds.length} 张账单</strong>
                  <small>{item.billNos.join(" + ")} · 建议核销 ¥{money(item.matchedAmount)}</small>
                </span>
                <em className={item.requiresManualReview ? "engine-badge warning" : "engine-badge"}>{item.confidence}%</em>
              </div>
              <ul className="engine-reasons">{item.reasons.map((reason) => <li key={`${item.id}-${reason}`}>{displayText(reason)}</li>)}</ul>
              {item.requiresManualReview
                ? <div className="engine-inline"><span className="engine-badge warning"><WarningCircle size={14} />保留异常，需人工核对差额或置信度</span></div>
                : <button className="primary-button wide" type="button" onClick={() => confirmSuggestion(item)}><SealCheck size={16} />确认匹配并写入核销</button>}
            </article>
          ))}
        </div>
        </details>
      )}

      {eligibleBills.length > 0 && ![EVENT_TYPES.REFUND, EVENT_TYPES.INTERNAL_TRANSFER, EVENT_TYPES.UNKNOWN].includes(classification.eventType) && (
        <details className="engine-section" ref={(node) => { stepRefs.current.allocations = node; }}><summary>{directlyPosted ? "选择账单核销" : `选择账单核销 · 未核销 ¥${money(settlement.remaining)}`}</summary>
        <div className="engine-allocation">
          <div className="engine-subheading"><strong>拆分 / 部分核销</strong><small>可一次填写多张账单，合计不超过流水未核销金额</small></div>
          <div className="engine-summary">
            <span><small>{directlyPosted ? "尚未分配到账单" : "流水当前未核销"}</small><strong>¥{money(allocationDraft.transactionRemaining)}</strong></span>
            <span><small>本次已分配</small><strong>¥{money(allocationDraft.requested)}</strong></span>
            <span><small>确认后流水剩余</small><strong>¥{money(allocationDraft.remainingAfter)}</strong></span>
          </div>
          {allocationDraft.rows.length > 0 && !allocationDraft.valid && <div className="engine-missing"><span>{allocationDraft.message}</span></div>}
          {eligibleBills.map((bill) => {
            const remaining = billSettlement(activeWorkspace, bill).remaining;
            const currentAmount = Number(allocationAmounts[bill.id]);
            const currentRequested = Number.isFinite(currentAmount) && currentAmount > 0
              ? Math.round(currentAmount * 100) / 100
              : 0;
            const otherRequested = Math.max(0, allocationDraft.requested - currentRequested);
            const transactionAvailable = Math.max(0, settlement.remaining - otherRequested);
            const maximum = Math.max(0, Math.min(remaining, Math.round(transactionAvailable * 100) / 100));
            return <label key={bill.id}><span><strong>{bill.no || bill.id}</strong><small>{bill.counterparty || bill.summary || "本地账单"} · 账单剩余 ¥{money(remaining)} · 本行最多 ¥{money(maximum)}</small></span><input type="number" min="0" max={maximum} step="0.01" value={allocationAmounts[bill.id] || ""} onChange={(event) => setAllocationAmounts((current) => ({ ...current, [bill.id]: event.target.value }))} placeholder="本次金额" /></label>;
          })}
          <button className="primary-button wide" type="button" disabled={!allocationDraft.valid} onClick={applyAllocations}><SealCheck size={16} />确认本次核销</button>
        </div>
        </details>
      )}

      {allocations.length > 0 && (
        <details className="engine-section"><summary>已核销关系 · {allocations.length}</summary>
        <div className="engine-allocation-history">
          <div className="engine-subheading"><strong>有效核销记录</strong><small>{allocations.length} 条</small></div>
          <label><span>撤销 / 更正原因 *</span><input value={reversalReason} onChange={(event) => setReversalReason(event.target.value)} placeholder="说明原核销错在何处" /></label>
          {!periodWritable && <p>历史或已归档核销保持只读；请在下一开放期间通过手工调整关联原凭证。</p>}
          {allocations.map((allocation) => {
            const related = vouchersForReconciliation(activeWorkspace, transactionId, allocation.id);
            const posted = related.find((voucher) => voucher.status === "posted");
            const pending = posted && activeWorkspace.vouchers.some((voucher) => voucher.revisionOf === posted.id && ["draft", "changes_requested"].includes(voucher.status));
            const targets = activeWorkspace.bills.filter((bill) => bill.id !== allocation.billId && allocationDirectionMatchesBill(transaction, bill) && billSettlement(activeWorkspace, bill).remaining + 0.01 >= Number(allocation.amount));
            return <div key={allocation.id}><span><strong>{allocation.billId}</strong><small>{allocation.businessPeriod || "未分期"} · {posted ? "已入账，需同步更正" : allocation.status}</small>{posted && <select aria-label="核销更正目标账单" disabled={pending || !periodWritable} value={correctionTargets[allocation.id] || ""} onChange={(event) => setCorrectionTargets((current) => ({ ...current, [allocation.id]: event.target.value }))}><option value="">{targets.length ? "选择正确账单，保持本次金额" : "暂无足额账单，请先补充正确账单"}</option>{targets.map((bill) => <option value={bill.id} key={bill.id}>{bill.no || bill.id} · {bill.counterparty} · 剩余 ¥{money(billSettlement(activeWorkspace, bill).remaining)}</option>)}</select>}</span><b>¥{money(allocation.amount)}</b><button type="button" aria-label={posted ? "创建核销更正草稿" : "撤销核销"} disabled={!periodWritable || !reversalReason.trim() || pending || (posted && !correctionTargets[allocation.id])} onClick={() => reverse(allocation.id)}><ArrowCounterClockwise size={15} />{pending ? "更正待入账" : posted ? "更正核销" : "撤销"}</button></div>;
          })}
        </div>
        </details>
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

      <details className="engine-section" ref={(node) => { stepRefs.current.vouchers = node; }}><summary>本笔凭证 · {activeVouchers.length} 张有效记录</summary>
      <div className="engine-vouchers">
        <label><span>复核意见 *</span><textarea disabled={memberBusinessEventBlocked} value={voucherNote} onChange={(event) => setVoucherNote(event.target.value)} placeholder={memberBusinessEventBlocked ? `${terminology.member}模块已关闭，历史业务仅供查看` : "说明业务性质、科目与金额的复核结论"} /></label>
        {vouchers.map((voucher) => {
          const attachments = buildAttachmentPackage(activeWorkspace, voucher.id);
          const trace = traceVoucherSources(activeWorkspace, voucher.id);
          const postable = periodWritable && !memberBusinessEventBlocked && ["draft", "changes_requested"].includes(voucher.status);
          const editable = postable && !voucher.reconciliationCorrection;
          const editableLines = voucherLineDrafts[voucher.id] || voucher.lines;
          const lineValidation = validateVoucherBalance(
            { lines: editableLines },
            accountingRules(activeWorkspace).amountTolerance,
            editable ? activeWorkspace : null,
          );
          return (
            <article className="engine-voucher-card" key={voucher.id}>
              {voucher.status === "invalidated" && <p className="engine-missing">此草稿已失效：{voucher.invalidationReason}。按当前核销重新生成；本记录仅供追溯。</p>}
              {voucher.reconciliationCorrection?.status === "pending" && <p>核销更正：{voucher.reconciliationCorrection.originalAllocation.billId} → {voucher.reconciliationCorrection.replacement.billId}，¥{money(voucher.reconciliationCorrection.replacement.amount)}。复核入账前原核销和原凭证继续有效。</p>}
              <div className="engine-voucher-row"><FileText size={17} /><span><strong>{voucher.no || "草稿"} · {voucher.summary}</strong><small>{lineValidation.balanced ? `借贷各 ¥${money(lineValidation.debit)}` : "分录待修正"} · {attachments.status === "complete" ? "资料已关联" : "资料待补"} · V{voucher.version}</small>{lineValidation.taxTotal > 0 && <small>税额 ¥{money(lineValidation.taxTotal)}</small>}</span><em>{voucherStatusLabel(voucher.status)}</em></div>
              <details className="engine-voucher-edit"><summary>{editable ? "查看 / 修改分录" : "查看分录"}</summary>
              {editable && <input value={voucherSummaries[voucher.id] ?? voucher.summary} onChange={(event) => setVoucherSummaries((current) => ({ ...current, [voucher.id]: event.target.value }))} aria-label="凭证摘要" />}
              <VoucherLineAccountEditor
                workspace={activeWorkspace}
                accounts={accountOptions}
                lines={editableLines}
                editable={editable}
                onChange={(lineIndex, changes) => changeVoucherLine(voucher, lineIndex, changes)}
                onAdd={() => addVoucherLine(voucher)}
                onRemove={(lineIndex) => removeVoucherLine(voucher, lineIndex)}
              />
              {editable && <VoucherLineValidation validation={lineValidation} />}
              {editable && (voucherLineDrafts[voucher.id] || Object.hasOwn(voucherSummaries, voucher.id)) && <button className="secondary-button" type="button" disabled={!voucherNote.trim() || !lineValidation.balanced} onClick={() => reviseVoucher(voucher)}>保存分录修订</button>}
              {editable && voucher.status === "draft" && <button className="secondary-button" type="button" disabled={!voucherNote.trim()} onClick={() => requestVoucherChanges(voucher.id)}>退回修订</button>}
              </details>
              <div className="engine-inline">
                {postable && <button className="primary-button" disabled={posting || !voucherNote.trim() || !lineValidation.balanced} type="button" onClick={() => postDraft(voucher)}><CheckCircle size={16} />{posting ? "正在复核…" : voucher.reconciliationCorrection ? "复核并确认核销更正" : "复核入账"}</button>}
                {postable && voucher.revisionOf && <button className="secondary-button" type="button" disabled={!voucherNote.trim() || posting} onClick={() => cancelRevision(voucher.id)}>取消更正</button>}
                {periodWritable && !memberBusinessEventBlocked && voucher.status === "posted" && <button className="secondary-button" type="button" disabled={!voucherNote.trim()} onClick={() => createRevision(voucher.id)}><Plus size={16} />创建更正草稿</button>}
              </div>
              <details>
                <summary>查看来源与附件清单</summary>
                <p>流水 {trace.transactions.length} · 关联流水 {trace.relatedTransactions?.length || 0} · 业务事件 {trace.businessEvents.length} · 账单 {trace.bills.length} · 订单/合同 {trace.businessReferences?.filter((reference) => reference.kind === "order_contract").length || 0} · 资料 {trace.documents.length} · 历史版本 {trace.versions.length} · 审计 {trace.audit.length}</p>
                <ul className="engine-trace-list">
                  {attachments.manifest.map((item) => <li key={item.id}><strong>{item.kind}</strong><span>{item.name}</span></li>)}
                  {trace.versions.map((version, index) => {
                    const versionAccounts = voucherLineAccountPresentation(activeWorkspace, accountOptions, version.lines || []);
                    return <li key={`${version.version || "history"}-${index}`}><strong>历史版本 V{version.version || index + 1}</strong><span>{version.summary || "凭证修订记录"} · {version.reason || "无单独修订说明"} · 分录科目：{versionAccounts.accountText}</span></li>;
                  })}
                </ul>
                {attachments.missing.length > 0 && <div className="engine-missing">{attachments.missing.map((item) => <span key={item.id}>待补：{item.label || item.id}</span>)}</div>}
              </details>
            </article>
          );
        })}
      </div>
      </details>
    </section>
  );
}
