import test from "node:test";
import assert from "node:assert/strict";
import { calculateContractPeriodAmount } from "../src/features/intake/contractBillingAmounts.js";
import { resolveContractCounterparty } from "../src/features/intake/contractCounterparty.js";
import { normalizeDocumentStructuredData, buildContractBillingPlan, applyContractBillingPlan } from "../src/features/intake/documentIntake.js";

const input = { documentId: "contract-discount", asOf: "2026-09-01" };
const context = { actor: "合同账单确认人", at: "2026-09-05T09:00:00.000Z" };
const rule = (kind, value) => ({ enabled: true, kind, ...(kind === "percent" ? { percent: value } : { fixedAmount: value }) });

function fixture(details = {}) {
  return {
    id: "contract-workspace", name: "本地账务", currentPeriod: "2026-09",
    company: { legalName: "本地样例有限公司" }, modules: { members: false },
    bills: [], vouchers: [], evidenceLinks: [], exceptionTasks: [], auditLog: [],
    tax: { frozenAt: "old-freeze", financeConfirmedAt: "old-confirmation" },
    delivery: { reportVersions: [{ id: "frozen-v1", snapshot: { profit: 100 } }], filing: { draftVersionId: "frozen-v1" } },
    documents: [{ id: input.documentId, category: "合同", name: "已保存样例合同.pdf", hash: "existing-original-hash", version: 2,
      structuredData: {
        kind: "contract", partyA: "本地样例有限公司", partyB: "样例客户有限公司", contractType: "sales",
        amount: 3000, periodAmount: 1000, settlementMode: "monthly", firstBillDate: "2026-09-05", billingEndDate: "2026-11-30",
        serviceStartDate: "2026-09-01", serviceEndDate: "2026-11-30", dueDateRule: "month_end",
        discountTerms: "每期优惠10%", ...details,
      },
    }],
  };
}

test("合同优惠金额按分舍入，未明确启用时不采纳条款或候选比例", () => {
  for (const [details, expected] of [
    [{ periodAmount: 1000, discountTerms: "九折", discountRule: { kind: "percent", percent: 10 } }, [1000, 0, 1000]],
    [{ periodAmount: 1000, discountRule: rule("percent", 20) }, [1000, 200, 800]],
    [{ periodAmount: 1.005, discountRule: rule("percent", 50) }, [1.01, 0.51, 0.5]],
    [{ periodAmount: 0.05, discountRule: rule("percent", 10) }, [0.05, 0.01, 0.04]],
    [{ periodAmount: 100, discountRule: rule("fixed", 33.335) }, [100, 33.34, 66.66]],
    [{ periodAmount: 100, discountRule: rule("percent", 100) }, [100, 100, 0]],
  ]) {
    const result = calculateContractPeriodAmount(details);
    assert.deepEqual(result.errors, []);
    assert.deepEqual([result.grossAmount, result.discountAmount, result.netAmount], expected);
  }
  const unchanged = normalizeDocumentStructuredData("合同", fixture().documents[0].structuredData);
  assert.equal(unchanged.discountRule.enabled, false);
  assert.equal(buildContractBillingPlan(fixture(), input).pendingTotalAmount, 3000);
});

test("合同优惠拒绝负数、空值、超比例、超额减免和越过合同净额上限", () => {
  for (const details of [
    { periodAmount: -1 }, { periodAmount: Infinity }, { periodAmount: 0 },
    { periodAmount: 100, discountRule: rule("percent", -1) },
    { periodAmount: 100, discountRule: rule("percent", 100.01) },
    { periodAmount: 100, discountRule: rule("percent", "") },
    { periodAmount: 100, discountRule: rule("fixed", 100.01) },
    { periodAmount: 100, discountRule: rule("fixed", NaN) },
  ]) {
    assert.ok(calculateContractPeriodAmount(details).errors.length);
    const workspace = fixture(details);
    assert.equal(buildContractBillingPlan(workspace, input).canConfirm, false);
    assert.throws(() => applyContractBillingPlan(workspace, input), /不能生成/);
    assert.deepEqual(workspace.bills, []);
  }
  const belowNet = fixture({ amount: 2399.99, discountRule: rule("percent", 20) });
  assert.equal(buildContractBillingPlan(belowNet, input).canConfirm, false);
  assert.match(buildContractBillingPlan(belowNet, input).errors.join("；"), /生成总额 2400.00 超出合同金额 2399.99/);
});

test("合同优惠以实际净额预览并经确认生成应收应付，保留来源与冻结历史", () => {
  for (const contractType of ["sales", "lease"]) {
    const workspace = fixture({ contractType, amount: 2400, discountRule: rule("percent", 20) });
    const before = structuredClone(workspace);
    const plan = buildContractBillingPlan(workspace, input);
    assert.equal(plan.canConfirm, true, plan.errors.join("；"));
    assert.deepEqual(workspace, before, "预览不能生成账单");
    assert.deepEqual([plan.grossAmount, plan.discountAmount, plan.netAmount, plan.plannedTotalAmount, plan.pendingTotalAmount], [1000, 200, 800, 2400, 2400]);
    assert.ok(plan.items.every((item) => item.amount === 800 && item.netAmount === 800));
    const result = applyContractBillingPlan(workspace, input, context);
    assert.equal(result.bills.length, 3);
    for (const bill of result.bills) {
      assert.equal(bill.kind, contractType === "sales" ? "receivable" : "payable");
      assert.equal(bill.counterparty, "样例客户有限公司");
      assert.equal(bill.amount, 800);
      assert.deepEqual([bill.contractBasis.grossAmount, bill.contractBasis.discountAmount, bill.contractBasis.netAmount], [1000, 200, 800]);
      assert.equal(bill.contractBasis.discountRule.source.kind, "manual");
      assert.equal(bill.contractBasis.terms.discountTerms, "每期优惠10%", "人工20%不冒充原文10%的识别结果");
      assert.equal(bill.contractBasis.documentVersion, 2);
      assert.equal(bill.contractBasis.documentHash, before.documents[0].hash);
      assert.equal(bill.contractBasis.acceptedBy, context.actor);
      assert.equal(bill.contractBasis.acceptedAt, context.at);
      assert.equal(bill.contractBasis.counterpartySelection.source.kind, "company_name_match");
    }
    assert.equal(result.workspace.tax.frozenAt, null);
    assert.equal(result.workspace.tax.financeConfirmedAt, null);
    assert.deepEqual(result.workspace.delivery.reportVersions, before.delivery.reportVersions);
    assert.deepEqual(result.workspace.vouchers, []);
    assert.throws(() => applyContractBillingPlan(result.workspace, input, context), /不得重复生成/);
  }
});

test("合同优惠规则修改只计算未生成期，旧账单与金额依据不改写或重复优惠", () => {
  const first = fixture({ settlementMode: "one_time", discountRule: rule("fixed", 100) });
  const applied = applyContractBillingPlan(first, input, context).workspace;
  const oldBills = structuredClone(applied.bills);
  applied.documents[0].version = 3;
  applied.documents[0].structuredData = { ...applied.documents[0].structuredData, settlementMode: "monthly", amount: 2400, discountRule: rule("fixed", 200) };
  let plan = buildContractBillingPlan(applied, input);
  assert.deepEqual([plan.generatedTotalAmount, plan.pendingTotalAmount, plan.plannedTotalAmount], [900, 1600, 2500]);
  assert.equal(plan.canConfirm, false, "不能按新规则把旧900重算成800以绕开上限");
  applied.documents[0].structuredData.amount = 2500;
  plan = buildContractBillingPlan(applied, input);
  assert.deepEqual(plan.duplicatePeriods.map((item) => item.period), ["2026-09"]);
  assert.equal(plan.canConfirm, true);
  const next = applyContractBillingPlan(applied, input, context).workspace;
  assert.deepEqual(next.bills.slice(0, oldBills.length), oldBills);
  assert.deepEqual(next.bills.map((bill) => bill.amount), [900, 800, 800]);
  assert.deepEqual(next.bills.map((bill) => bill.contractBasis.documentVersion), [2, 3, 3]);
});

test("采用已保存优惠条款保留具体来源，条款或原件变化需重新采用", () => {
  const workspace = fixture({ discountRule: { ...rule("percent", 10), source: { kind: "saved_terms", text: "每期优惠10%", documentId: input.documentId, documentHash: "existing-original-hash", documentVersion: 1 } } });
  const plan = buildContractBillingPlan(workspace, input);
  assert.equal(plan.canConfirm, true, "保存计划时版本递增不误判为原件变化");
  const result = applyContractBillingPlan(workspace, input, context);
  assert.equal(result.bills[0].contractBasis.discountRule.source.kind, "saved_terms");
  assert.equal(result.bills[0].contractBasis.discountRule.source.documentVersion, 1);
  assert.equal(result.bills[0].contractBasis.documentVersion, 2);
  const changedTerms = structuredClone(workspace);
  changedTerms.documents[0].structuredData.discountTerms = "每期优惠20%";
  assert.equal(buildContractBillingPlan(changedTerms, input).canConfirm, false);
  const changedOriginal = structuredClone(workspace);
  changedOriginal.documents[0].hash = "replaced-original";
  assert.equal(buildContractBillingPlan(changedOriginal, input).canConfirm, false);
});

test("合同对方按企业全名识别甲或乙，归属不明需明确选择且不能选择本企业", () => {
  const workspace = fixture();
  assert.equal(resolveContractCounterparty(workspace, workspace.documents[0].structuredData).party, "partyB");
  const companyIsB = fixture({ partyA: "实际客户", partyB: " 本地样例有限公司 " });
  const bill = applyContractBillingPlan(companyIsB, input, context).bills[0];
  assert.equal(bill.counterparty, "实际客户");
  assert.equal(bill.contractBasis.counterpartySelection.party, "partyA");
  const ambiguous = fixture({ partyA: "样例简称", partyB: "供应商简称", contractType: "purchase" });
  assert.equal(buildContractBillingPlan(ambiguous, input).canConfirm, false);
  ambiguous.documents[0].structuredData.counterpartyParty = "partyB";
  const manual = applyContractBillingPlan(ambiguous, input, context).bills[0];
  assert.equal(manual.counterparty, "供应商简称");
  assert.equal(manual.contractBasis.counterpartySelection.source.kind, "manual");
  assert.equal(manual.contractBasis.acceptedBy, context.actor);
  const self = fixture({ counterpartyParty: "partyA" });
  assert.equal(buildContractBillingPlan(self, input).canConfirm, false);
  assert.match(buildContractBillingPlan(self, input).errors.join("；"), /企业本身/);
  const bothSelf = fixture({ partyB: "本地样例有限公司" });
  assert.equal(buildContractBillingPlan(bothSelf, input).canConfirm, false);
  const withoutLegalName = fixture();
  withoutLegalName.company.legalName = "";
  withoutLegalName.name = withoutLegalName.documents[0].structuredData.partyA;
  assert.equal(buildContractBillingPlan(withoutLegalName, input).canConfirm, false, "不能把工作台显示名当企业法人兜底");
  withoutLegalName.documents[0].structuredData.counterpartyParty = "partyB";
  assert.equal(buildContractBillingPlan(withoutLegalName, input).canConfirm, true);
});
