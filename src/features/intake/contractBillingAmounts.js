function nonNegativeNumber(value, label) {
  if (value == null || String(value).trim() === "" || !Number.isFinite(Number(value)) || Number(value) < 0) {
    throw new Error(`${label}必须是大于或等于 0 的有效数字`);
  }
  return Number(value);
}

// Decimal inputs become integer fractions before rounding, including 1.005 and scientific notation.
function fraction(number) {
  const [mantissa, exponent = "0"] = String(number).toLowerCase().split("e");
  const [whole, decimals = ""] = mantissa.split(".");
  const scale = decimals.length - Number(exponent);
  const numerator = BigInt(whole + decimals);
  return scale < 0 ? [numerator * 10n ** BigInt(-scale), 1n] : [numerator, 10n ** BigInt(scale)];
}

const roundedDivision = (numerator, denominator) => (numerator * 2n + denominator) / (denominator * 2n);

function cents(amount, label) {
  const [numerator, denominator] = fraction(nonNegativeNumber(amount, label));
  const result = roundedDivision(numerator * 100n, denominator);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label}超出可安全计算的金额范围`);
  return result;
}

export function roundContractMoney(amount) {
  return Number(cents(amount, "合同金额")) / 100;
}

export function sumContractAmounts(amounts) {
  const result = amounts.reduce((sum, amount) => sum + cents(amount, "账单金额"), 0n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("账单合计超出可安全计算的金额范围");
  return Number(result) / 100;
}

export function normalizeContractDiscountRule(input = {}) {
  if (input?.enabled !== true) return { enabled: false, kind: "none", percent: null, fixedAmount: null, source: { kind: "manual", text: "" } };
  if (!["percent", "fixed"].includes(input.kind)) throw new Error("启用优惠后请选择每期比例优惠或固定减免");
  const percent = input.kind === "percent" ? nonNegativeNumber(input.percent, "优惠比例") : null;
  if (percent > 100) throw new Error("优惠比例不能超过 100%");
  const fixedAmount = input.kind === "fixed" ? nonNegativeNumber(input.fixedAmount, "每期固定减免") : null;
  const source = input.source?.kind === "saved_terms" ? {
    kind: "saved_terms", text: String(input.source.text || "").trim(),
    documentId: input.source.documentId || null, documentHash: input.source.documentHash || null,
    documentVersion: input.source.documentVersion ?? null,
  } : { kind: "manual", text: String(input.source?.text || "").trim() };
  return { enabled: true, kind: input.kind, percent, fixedAmount, source };
}

export function calculateContractPeriodAmount(details = {}) {
  try {
    const rule = normalizeContractDiscountRule(details.discountRule);
    const gross = cents(details.periodAmount, rule.enabled ? "每期折前金额" : "每期金额");
    if (gross <= 0n) throw new Error(`${rule.enabled ? "每期折前金额" : "每期金额"}按分舍入后必须大于 0`);
    let discount = 0n;
    if (rule.enabled && rule.kind === "percent") {
      const [numerator, denominator] = fraction(rule.percent);
      discount = roundedDivision(gross * numerator, denominator * 100n);
    }
    if (rule.enabled && rule.kind === "fixed") {
      if (rule.fixedAmount > Number(gross) / 100) throw new Error("每期固定减免不能超过每期折前金额");
      discount = cents(rule.fixedAmount, "每期固定减免");
    }
    if (discount > gross) throw new Error("优惠金额不能超过折前金额");
    const grossAmount = Number(gross) / 100;
    const discountAmount = Number(discount) / 100;
    const netAmount = Number(gross - discount) / 100;
    return { enabled: rule.enabled, discountRule: rule, grossAmount, discountAmount, netAmount, baseAmount: grossAmount, finalAmount: netAmount, errors: [] };
  } catch (error) {
    return { enabled: details.discountRule?.enabled === true, discountRule: null, grossAmount: null, discountAmount: null, netAmount: null, baseAmount: null, finalAmount: null, errors: [error.message] };
  }
}
