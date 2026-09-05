import test from "node:test";
import assert from "node:assert/strict";
import { buildContractDiscountSuggestion } from "../src/features/intake/contractDiscountTerms.js";

const saved = (discountTerms) => ({ id: "contract-1", hash: "original-hash", version: 3, category: "合同", structuredData: { discountTerms } });

test("明确折数与优惠百分数转换为减免比例，保留原文且不自动启用", () => {
  for (const [text, expected] of [
    ["九折", 10], ["打9.5折", 5], ["折扣条款：按原价九折计价。", 10],
    ["享受九五折优惠", 5], ["九点五折", 5], ["优惠10%", 10],
    ["减免10%", 10], ["给予20%折让", 20], ["优惠１００％", 100], ["打十折", 0],
  ]) {
    const document = saved(text);
    const before = structuredClone(document);
    const suggestion = buildContractDiscountSuggestion(document);
    assert.equal(suggestion.status, "suggested", text);
    assert.equal(suggestion.kind, "percent", text);
    assert.equal(suggestion.value, expected, text);
    assert.equal(suggestion.sourceText, text);
    assert.equal(suggestion.source.documentId, document.id);
    assert.equal(suggestion.source.documentHash, document.hash);
    assert.equal(suggestion.source.documentVersion, 3);
    assert.equal(Object.hasOwn(suggestion, "enabled"), false);
    assert.equal(Object.hasOwn(suggestion, "rule"), false);
    assert.deepEqual(document, before);
  }
});

test("明确固定减免以元为单位，仅建议金额并提醒确认每期适用范围", () => {
  for (const [text, expected] of [["减免100元", 100], ["固定减免人民币1,000.50元", 1000.5], ["直减￥20元", 20], ["优惠0元", 0]]) {
    const suggestion = buildContractDiscountSuggestion(saved(text));
    assert.equal(suggestion.status, "suggested", text);
    assert.equal(suggestion.kind, "fixed", text);
    assert.equal(suggestion.value, expected, text);
    assert.match(suggestion.reason, /每期/);
  }
});

test("条件、阶梯、叠加、多比例、折扣率歧义与不支持的金额不挑第一个数", () => {
  for (const text of [
    "全年预付享九折", "满1000元减100元", "金额达到1000元打九折，否则9.5折",
    "前两期九折，后续八折", "九折后再减100元", "优惠10%，另享5%", "九折，即优惠10%",
    "折扣率10%", "折扣率90%", "一次性减免100元", "最高优惠10%", "会员享9.5折",
    "九折或固定减免100元", "合同总额减免100元", "减免100美元", "减免100", "减免1,00元",
    "减免100.999元", "优惠101%", "优惠-10%", "打95折", "减免-100元", "折扣另行协商",
  ]) {
    const suggestion = buildContractDiscountSuggestion(saved(text));
    assert.equal(suggestion.status, "needs_review", text);
    assert.equal(suggestion.kind, "none", text);
    assert.equal(suggestion.value, null, text);
    assert.equal(suggestion.sourceText, text);
    assert.ok(suggestion.reason.length > 0);
  }
});

test("OCR候选不能代替人工保存条款，相关截断或过期来源必须复核", () => {
  const candidateOnly = { ...saved(""), contentRecognition: { suggestedFields: { discountTerms: { value: "九折" } } } };
  assert.equal(buildContractDiscountSuggestion(candidateOnly).status, "none");
  const document = saved("九折");
  document.contentRecognition = { confirmation: {
    resultId: "recognition-1", sourceHash: document.hash, category: "合同", fields: { discountTerms: "九折" },
    sources: { discountTerms: { value: "九折", sourceText: "折扣条款：九折", pageNumber: 2, sourcePages: [2, 3], sourceTruncated: true } },
  } };
  let suggestion = buildContractDiscountSuggestion(document);
  assert.equal(suggestion.status, "needs_review");
  assert.match(suggestion.reason, /截断/);
  assert.deepEqual(suggestion.source.sourcePages, [2, 3]);
  assert.equal(suggestion.source.originalSourceText, "折扣条款：九折");
  document.contentRecognition.confirmation.sources.discountTerms.sourceTruncated = false;
  assert.equal(buildContractDiscountSuggestion(document).status, "suggested");
  document.version += 1;
  assert.equal(buildContractDiscountSuggestion(document).status, "suggested", "普通保存增加版本不等于原件哈希变更");
  document.hash = "changed-original";
  suggestion = buildContractDiscountSuggestion(document);
  assert.equal(suggestion.status, "needs_review");
  assert.match(suggestion.reason, /来源/);
  document.structuredData.discountTerms = "减免50元";
  assert.equal(buildContractDiscountSuggestion(document).status, "suggested", "后来人工保存的新条款不沿用不匹配的旧OCR来源");
  assert.equal(buildContractDiscountSuggestion(saved("九折…")).status, "needs_review");
});

test("空条款与明确无折扣不产生可启用数值，不能改变已保存计费规则", () => {
  for (const text of ["", "  ", "无折扣", "不打折", "按原价收取"]) {
    const document = saved(text);
    document.structuredData.discountRule = { enabled: true, kind: "percent", percent: 10 };
    const suggestion = buildContractDiscountSuggestion(document);
    assert.equal(suggestion.status, "none", text);
    assert.equal(suggestion.kind, "none");
    assert.equal(suggestion.value, null);
    assert.equal(document.structuredData.discountRule.enabled, true);
  }
});
