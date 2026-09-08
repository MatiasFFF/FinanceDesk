import { AccountingRuleError, BILL_KINDS, collectSourceIds, roundMoney, sumMoney } from "./model.js";
import { isPeriodArchived, validAccountingPeriod } from "../periods.js";
import { settlementRecordIsEffective, settlementSourceBillIds, settlementTransactionIsEffective } from "../../features/reconciliation/settlementRecognition.js";

const financialFields = ["amount", "kind", "date", "businessPeriod", "period", "counterparty", "counterpartyId", "counterpartyObjectId", "recognitionBasis", "status"];
const billError = (code, message, details) => new AccountingRuleError(code, message, details);
const dated = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function billFinancialRelations(workspace, billId) {
  const allocations = (workspace.transactions || []).filter((transaction) => settlementTransactionIsEffective(transaction))
    .flatMap((transaction) => (transaction.allocations || []).filter((allocation) => allocation.billId === billId && settlementRecordIsEffective(allocation))
      .map((allocation) => ({ ...allocation, transactionId: transaction.id })));
  const applications = (workspace.advanceApplications || []).filter((application) => settlementRecordIsEffective(application)
    && [application.advanceBillId, application.targetBillId].includes(billId));
  const vouchers = (workspace.vouchers || []).filter((voucher) => voucher.status === "posted" && (
    (workspace.billRecognitionLinks || []).some((link) => link.billId === billId && link.voucherId === voucher.id)
    || settlementSourceBillIds(workspace, collectSourceIds(voucher.sourceIds, voucher.relatedSourceIds,
      voucher.relatedSources?.map((source) => source.id), voucher.sourceReferences?.map((source) => source.id),
      voucher.bankBusinessEventId, voucher.advanceApplicationId, (voucher.lines || []).map((line) => [line.sourceIds, line.billId]))).includes(billId)
    || (voucher.reconciliationSources || []).some((source) => source.billId === billId)));
  const settledAmount = Math.max(sumMoney([...allocations, ...applications.filter((application) => application.targetBillId === billId)].map((record) => record.amount)),
    sumMoney(applications.filter((application) => application.advanceBillId === billId).map((record) => record.amount)));
  return { allocations, applications, vouchers, settledAmount };
}

// Used by the generic editor and dedicated financial actions alike. Notes and
// descriptions stay editable; a financial mutation must respect actual usage.
export function assertBillWrite(workspace, previous, proposed, { operation = "update" } = {}) {
  for (const bill of [previous, proposed].filter(Boolean)) {
    const periods = [bill.businessPeriod, bill.period, String(bill.date || "").slice(0, 7)].filter(validAccountingPeriod);
    if (periods.some((period) => isPeriodArchived(workspace, period))) {
      throw billError("BILL_PERIOD_ARCHIVED", `账单 ${bill.no || bill.id || ""} 属于已归档账期，不能改写；请保留原账单，在当前未归档账期处理调整。`, { billId: bill.id, periods });
    }
  }
  const changedFields = previous && proposed ? financialFields.filter((field) => (
    field === "amount" ? Number(previous[field] ?? "") !== Number(proposed[field] ?? "") : (previous[field] || "") !== (proposed[field] || "")
  )) : [];
  const relations = previous ? billFinancialRelations(workspace, previous.id) : { allocations: [], applications: [], vouchers: [], settledAmount: 0 };
  if (proposed && proposed.dueDate !== previous?.dueDate && proposed.dueDate && !dated(proposed.dueDate)) throw billError("INVALID_BILL_DUE_DATE", "请填写真实有效的到期日期");
  if (proposed && (!previous || changedFields.length)) {
    if (!Object.values(BILL_KINDS).includes(proposed.kind)) throw billError("INVALID_BILL_KIND", "请选择有效的应收、应付、预收或预付类型");
    if (!String(proposed.counterparty || "").trim()) throw billError("BILL_COUNTERPARTY_REQUIRED", "请填写客户或供应商名称");
    for (const field of ["counterpartyId", "counterpartyObjectId"]) if (proposed[field]
      && ![...(workspace.counterparties || []), ...(workspace.members || []), ...(workspace.personnelRecords || [])]
        .some((item) => item.id === proposed[field])) throw billError("BILL_COUNTERPARTY_INVALID", "账单关联的客户、供应商、会员或人员不存在，请重新选择");
    if (!dated(proposed.date)) throw billError("INVALID_BILL_DATE", "请填写真实有效的账单日期");
    if (proposed.dueDate && !dated(proposed.dueDate)) throw billError("INVALID_BILL_DUE_DATE", "请填写真实有效的到期日期");
    for (const field of ["businessPeriod", "period"]) if (proposed[field] && !validAccountingPeriod(proposed[field])) throw billError("INVALID_BILL_PERIOD", "账单所属账期无效");
    const amount = Number(proposed.amount);
    const zeroAdjustment = operation === "red-invoice" || (previous && Number(previous.amount) === 0 && amount === 0);
    if (!["number", "string"].includes(typeof proposed.amount) || String(proposed.amount).trim() === "" || !Number.isFinite(amount)
      || amount < 0 || (!zeroAdjustment && roundMoney(amount) <= 0)) throw billError("INVALID_BILL_AMOUNT", "账单金额必须是大于 0 的有效金额");
    if ((!previous || Number(previous.amount) !== amount) && amount + 0.01 < relations.settledAmount) throw billError("BILL_BELOW_SETTLED", `账单金额不能低于已核销或冲销的 ${relations.settledAmount.toFixed(2)} 元；关联记录：${[...relations.allocations, ...relations.applications].map((record) => record.id).join("、")}。未入账核销可在对应银行流水撤销；预收/预付冲销暂不支持直接撤回。`, { billId: previous?.id, settledAmount: relations.settledAmount });
  }
  const financialChange = operation === "delete" || changedFields.length > 0;
  const explicitRedAdjustment = operation === "red-invoice" && changedFields.every((field) => field === "amount") && !relations.vouchers.length;
  if (financialChange && !explicitRedAdjustment && (relations.allocations.length || relations.applications.length || relations.vouchers.length)) {
    const linked = [...relations.allocations.map((item) => `核销 ${item.id}（流水 ${item.transactionId}）`),
      ...relations.applications.map((item) => `预收/预付冲销 ${item.id}`), ...relations.vouchers.map((item) => `已入账凭证 ${item.no || item.id}`)];
    const route = relations.vouchers.length ? "请在凭证中处理更正并保留原记录；涉及账单金额差异的历史调整尚不支持直接联动，请先核对调整方案。"
      : relations.applications.length ? "预收/预付冲销目前没有直接撤回入口，请保留原账单并先核对调整方案。"
        : "请先在对应银行流水中撤销未入账核销，再修改账单。";
    throw billError("BILL_FINANCIAL_RELATIONS", `账单已关联${linked.join("、")}，不能直接修改财务字段或删除。${route}`, { billId: previous.id, changedFields, ...relations });
  }
  return proposed;
}
