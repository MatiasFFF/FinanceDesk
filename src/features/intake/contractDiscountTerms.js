// Pass the saved document, never an OCR candidate or an unsaved form draft.
// Percent values describe the reduction: 九折 => 10 (% off), not 90 (% payable).
const DECIMAL = "\\d+(?:\\.\\d{1,2})?";
const FOLD = "(?:\\d+(?:\\.\\d+)?|[零〇一二三四五六七八九十两]+(?:点[零〇一二三四五六七八九]+)?)";
const MONEY = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?";
const foldPattern = new RegExp(`^(?:统一\\s*)?(?:(?:按原价的?|按|在原价基础上)\\s*)?(?:(?:打|享受|享|给予)\\s*)?(${FOLD})\\s*折(?:优惠)?(?:计价|收取|结算)?$`);
const percentPatterns = [
  new RegExp(`^(?:(?:统一|固定)\\s*)?(?:优惠|减免|减价|折让)\\s*(${DECIMAL})\\s*%$`),
  new RegExp(`^(?:(?:享受|给予)\\s*)?(${DECIMAL})\\s*%\\s*(?:优惠|减免|折让)$`),
];
const fixedPattern = new RegExp(`^(?:(?:统一|固定)\\s*)?(?:减免|直减|立减|优惠|折让)\\s*(?:人民币|[¥￥])?\\s*(${MONEY})\\s*元$`);
const chineseDigits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function foldNumber(token) {
  if (/^\d/.test(token)) return Number(token);
  if (token === "十") return 10;
  if (token.includes("点")) {
    const [whole, decimal] = token.split("点");
    const integer = whole === "十" ? 10 : chineseDigits[whole];
    return integer == null ? NaN : Number(`${integer}.${[...decimal].map((digit) => chineseDigits[digit]).join("")}`);
  }
  if (token.length === 1) return chineseDigits[token];
  // The conventional 九五折 means 9.5折. Longer Chinese strings are left for review.
  if (token.length === 2 && [...token].every((digit) => chineseDigits[digit] != null)) {
    return chineseDigits[token[0]] + chineseDigits[token[1]] / 10;
  }
  return NaN;
}

function savedSource(document, sourceText) {
  const recognition = document.contentRecognition || {};
  const confirmation = recognition.confirmation;
  const confirmed = confirmation?.fields?.discountTerms === sourceText;
  const candidate = confirmed ? confirmation.sources?.discountTerms
    : recognition.suggestedFields?.discountTerms?.value === sourceText ? recognition.suggestedFields.discountTerms : null;
  return {
    documentId: document.id || null,
    documentHash: document.hash || null,
    documentVersion: document.version ?? null,
    recognitionResultId: candidate ? (confirmed ? confirmation.resultId : recognition.resultId) || null : null,
    recognitionSourceHash: candidate ? (confirmed ? confirmation.sourceHash : recognition.sourceHash) || null : null,
    recognitionCategory: candidate ? (confirmed ? confirmation.category : recognition.category) || null : null,
    sourcePages: candidate?.sourcePages || (candidate?.pageNumber ? [candidate.pageNumber] : []),
    originalSourceText: candidate?.sourceText || null,
    truncated: Boolean(candidate?.truncated),
    sourceTruncated: Boolean(candidate?.sourceTruncated),
  };
}

export function buildContractDiscountSuggestion(document = {}) {
  const sourceText = typeof document.structuredData?.discountTerms === "string" ? document.structuredData.discountTerms : "";
  const source = savedSource(document, sourceText);
  const response = (status, reason, kind = "none", value = null) => ({ kind, value, sourceText, status, reason, source });
  const review = (reason) => response("needs_review", reason);
  if (!sourceText.trim()) return response("none", "尚未保存折扣条款。");
  if (source.truncated || source.sourceTruncated || /…|\.{3}|截断|[（(]略[）)]/.test(sourceText)) {
    return review("折扣条款或关联的识别原文有截断标记，请对照完整原件复核。");
  }
  if (source.recognitionResultId && (source.recognitionSourceHash !== document.hash || source.recognitionCategory !== document.category)) {
    return review("关联的识别来源与当前原件或类别不一致，请重新复核条款。");
  }
  const text = sourceText.normalize("NFKC").trim()
    .replace(/^(?:折扣条款|折扣规则|折扣|优惠规则|优惠条款|优惠|减免规则)\s*:\s*/, "")
    .replace(/[。.!！]+$/, "").trim();
  if (/折扣率/.test(text)) return review("“折扣率”可能指优惠比例或应付比例，请人工明确优惠多少。");
  const ratios = text.match(new RegExp(`(?:${DECIMAL})\\s*%|(?:${FOLD})\\s*折`, "g")) || [];
  if (ratios.length > 1) return review("条款出现多个比例，不能自动选择其中一个，请人工明确适用规则。");
  if (/条件|如果|若|满足|达到|累计|满|超过|不足|至少|至多|封顶|最高|最低|阶梯|分档|叠加|另享|再减|再打|再优惠|同时|或者|或|二选一|预付|提前|会员|首单|首期|首次|续约|活动|仅|限|需|须|除外|一次性|每满/.test(text)) {
    return review("条款包含条件、范围、阶梯或叠加规则，请人工核对适用条件后填写明确规则。");
  }
  if (/^(?:无折扣|无优惠|无减免|不打折|不优惠|不减免|不享受折扣|按原价计价|按原价收取)$/.test(text)) {
    return response("none", "已保存条款明确无优惠；不会更改已有计费规则。");
  }
  const fold = text.match(foldPattern);
  if (fold) {
    const payableTenths = foldNumber(fold[1]);
    if (!Number.isFinite(payableTenths) || payableTenths < 0 || payableTenths > 10) return review("折数无法明确换算为 0% 到 100% 的优惠比例，请人工填写。");
    const value = Math.round((100 - payableTenths * 10) * 1e6) / 1e6;
    return response("suggested", `原文表示按原价的 ${100 - value}% 计价，即优惠 ${value}%；需人工采用并确认计费基数。`, "percent", value);
  }
  const percent = percentPatterns.map((pattern) => text.match(pattern)).find(Boolean);
  if (percent) {
    const value = Number(percent[1]);
    if (!Number.isFinite(value) || value < 0 || value > 100) return review("优惠比例超出 0% 到 100%，请人工复核。");
    return response("suggested", `原文明确优惠 ${value}%；需人工采用并确认计费基数。`, "percent", value);
  }
  const fixed = text.match(fixedPattern);
  if (fixed) {
    const value = Number(fixed[1].replace(/,/g, ""));
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100))) return review("固定减免金额无法可靠表示，请人工复核。");
    return response("suggested", `原文明确减免 ${value} 元；需人工确认该减免适用于每期账单后采用。`, "fixed", value);
  }
  return review("这段条款不属于当前支持的明确表述，请保留原文并人工填写优惠比例或每期减免额。");
}
