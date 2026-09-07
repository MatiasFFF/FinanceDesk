import {
  createId,
  deepClone,
  getWorkspace,
  updateWorkspace,
} from "../../domain/foundation.js";
import { activateWorkspacePeriod, isPeriodArchived } from "../../domain/periods.js";

export const BANK_FIELD_DEFINITIONS = Object.freeze({
  date: { label: "交易日期", required: true, aliases: ["交易日期", "交易时间", "记账日期", "入账日期", "日期", "date", "transaction date"] },
  amount: { label: "交易金额", aliases: ["交易金额", "发生额", "金额", "amount", "transaction amount"] },
  credit: { label: "收入金额", aliases: ["收入", "贷方发生额", "收入金额", "收款金额", "credit", "deposit"] },
  debit: { label: "支出金额", aliases: ["支出", "借方发生额", "支出金额", "付款金额", "debit", "withdrawal"] },
  direction: { label: "收支方向", aliases: ["收支方向", "交易方向", "借贷标志", "方向", "direction", "type"] },
  counterparty: { label: "对方名称", aliases: ["对方户名", "对方名称", "交易对手", "对方", "counterparty", "payee", "payer"] },
  counterpartyAccount: { label: "对方账号", aliases: ["对方账号", "对方账户", "对方卡号", "counterparty account"] },
  summary: { label: "摘要", aliases: ["交易摘要", "摘要", "用途", "备注", "附言", "summary", "description", "memo"] },
  serial: { label: "流水号", aliases: ["银行流水号", "交易流水号", "流水号", "交易号", "参考号", "serial", "reference", "transaction id"] },
  balance: { label: "账户余额", aliases: ["账户余额", "交易后余额", "余额", "balance"] },
  channel: { label: "交易渠道", aliases: ["交易渠道", "渠道", "交易方式", "channel", "method"] },
  currency: { label: "币种", aliases: ["币种", "货币", "currency"] },
});

export const PLATFORM_SETTLEMENT_CHANNELS = Object.freeze({
  wechat: "微信支付",
  alipay: "支付宝",
  pos: "POS",
});

export const PLATFORM_SETTLEMENT_FIELD_DEFINITIONS = Object.freeze({
  settlementDate: { label: "结算日期", required: true, aliases: ["结算日期", "到账日期", "划款日期", "settlement date", "date"] },
  settlementNo: { label: "结算单号", required: true, aliases: ["结算单号", "结算批次号", "批次号", "结算编号", "settlement no", "batch no"] },
  grossAmount: { label: "交易总额", required: true, aliases: ["交易总额", "订单总额", "应结金额", "交易金额", "gross amount", "gross"] },
  feeAmount: { label: "手续费", required: true, aliases: ["手续费", "服务费", "渠道费", "fee", "commission"] },
  refundAmount: { label: "退款", required: true, aliases: ["退款", "退款金额", "退单金额", "refund", "refund amount"] },
  netAmount: { label: "净结算额", required: true, aliases: ["净结算额", "实际结算金额", "实结金额", "划款金额", "到账金额", "net amount", "net"] },
});

const INCOMING_WORDS = new Set(["收入", "收", "贷", "贷方", "入账", "转入", "credit", "in", "income", "+"]);
const OUTGOING_WORDS = new Set(["支出", "付", "借", "借方", "出账", "转出", "debit", "out", "expense", "-"]);
const DEFAULT_LARGE_TRANSACTION_THRESHOLD = 10_000;
const RELATED_PARTY_PATTERN = /关联方|股东|法人|法定代表人|实际控制人|老板/i;
const BANK_FEE_PATTERN = /银行手续费|账户管理费|账户管理手续费|结算手续费|支付手续费|网银服务费|短信服务费|手续费/i;
const DEFAULT_TRANSFER_DAY_WINDOW = 3;
const DETERMINISTIC_EVENT_TYPES = new Set(["internalTransfer", "bankFee"]);
const SUPERSEDED_IMPORT_ANOMALY_CODES = new Set(["bank_unknown_counterparty", "bank_related_party"]);
const BANK_RECONCILIATION_EXCEPTION_CODE = "bank_monthly_reconciliation_incomplete";

function normalizedHeader(value) {
  return String(value ?? "")
    .replace(/^\ufeff/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_()（）【】\[\]：:./\\-]+/g, "");
}

function normalizeText(value) {
  return String(value ?? "").replace(/^\ufeff/, "").trim();
}

function normalizePartyName(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[\s·（）()【】\[\]_-]+/g, "")
    .replace(/有限责任公司|股份有限公司|有限公司|公司|工作室|商户/g, "");
}

function validPeriod(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ""));
}

function partyNames(workspace) {
  const values = [
    ...(workspace.counterparties || []).map((item) => item.name),
    ...(workspace.bills || []).map((item) => item.counterparty),
    ...(workspace.members || []).flatMap((item) => [item.name, item.memberName]),
    ...(workspace.contracts || []).map((item) => item.counterpartyName),
    ...(workspace.invoices || []).flatMap((item) => [item.counterparty, item.sellerName, item.buyerName]),
    ...(workspace.approvals || []).map((item) => item.counterparty),
    ...(workspace.personnelRecords || []).map((item) => item.name),
    ...(workspace.transactions || []).map((item) => item.counterparty),
  ];
  return [...new Set(values.map(normalizePartyName).filter(Boolean))];
}

function namesMatch(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  return Math.min(left.length, right.length) >= 2 && (left.includes(right) || right.includes(left));
}

function largeTransactionThreshold(workspace, override) {
  const activeRuleSet = [...(workspace.ruleSets || [])]
    .filter((ruleSet) => ruleSet.status === "active")
    .sort((left, right) => String(left.updatedAt || "").localeCompare(String(right.updatedAt || "")))
    .at(-1);
  const configured = Number(override ?? activeRuleSet?.largeTransactionThreshold ?? workspace.rules?.largeTransactionThreshold);
  if (Number.isFinite(configured) && configured > 0) return Math.round(configured * 100) / 100;
  const historical = (workspace.transactions || [])
    .map((transaction) => Math.abs(Number(transaction.amount)))
    .filter((amount) => Number.isFinite(amount) && amount > 0)
    .sort((left, right) => left - right);
  const median = historical.length ? historical[Math.floor(historical.length / 2)] : 0;
  return Math.max(DEFAULT_LARGE_TRANSACTION_THRESHOLD, Math.round(median * 5 * 100) / 100);
}

function anomalyCounts(anomalies) {
  return anomalies.reduce((counts, anomaly) => ({
    ...counts,
    [anomaly.code]: (counts[anomaly.code] || 0) + 1,
  }), {});
}

function stableHash(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeCounterpartyAccount(value) {
  return normalizeText(value).toLowerCase().replace(/[\s*＊-]+/g, "");
}

export function counterpartyAliasKey(rawName, counterpartyAccount) {
  return `${normalizePartyName(rawName) || "unknown"}|${normalizeCounterpartyAccount(counterpartyAccount) || "no-account"}`;
}

function aliasRuleMatches(rule, transaction) {
  const rawName = normalizePartyName(transaction.counterpartyRaw ?? transaction.counterparty);
  const account = normalizeCounterpartyAccount(transaction.counterpartyAccount);
  const ruleName = rule.normalizedRawName || normalizePartyName(rule.rawName);
  const ruleAccount = rule.normalizedAccount || normalizeCounterpartyAccount(rule.counterpartyAccount);
  return Boolean((rawName && ruleName && rawName === ruleName) || (account && ruleAccount && account === ruleAccount));
}

function buildAliasRule(mapping, importedAt) {
  const rawName = normalizeText(mapping.rawName);
  const counterpartyAccount = normalizeText(mapping.counterpartyAccount);
  const standardName = normalizeText(mapping.standardName);
  if (!standardName || (!rawName && !counterpartyAccount)) return null;
  const normalizedRawName = normalizePartyName(rawName);
  const normalizedAccount = normalizeCounterpartyAccount(counterpartyAccount);
  return {
    id: mapping.ruleId || `counterparty-alias-${stableHash(`${normalizedRawName}|${normalizedAccount}|${standardName}|${mapping.objectId || "manual"}`)}`,
    rawName,
    normalizedRawName,
    counterpartyAccount,
    normalizedAccount,
    standardName,
    objectId: mapping.objectId || null,
    objectType: mapping.objectType || "manual",
    kind: mapping.kind || "other",
    source: "manual-bank-import",
    createdAt: mapping.createdAt || importedAt,
    updatedAt: importedAt,
  };
}

function applyAliasRule(transaction, rule, source) {
  const rawName = transaction.counterpartyRaw ?? (transaction.counterparty === "未识别交易对象" ? "" : transaction.counterparty);
  return {
    ...transaction,
    counterpartyRaw: rawName,
    counterpartyAliasKey: counterpartyAliasKey(rawName, transaction.counterpartyAccount),
    counterparty: rule.standardName,
    counterpartyObjectId: rule.objectId,
    counterpartyObjectType: rule.objectType,
    counterpartyKind: rule.kind,
    counterpartyAliasRuleId: rule.id,
    counterpartyMappingSource: source,
    counterpartyStandardized: true,
  };
}

export function applyCounterpartyAliasRules(workspace, transactions, mappings = {}, options = {}) {
  const importedAt = options.importedAt || transactions[0]?.importedAt || new Date().toISOString();
  const suppliedRules = options.rules || Object.values(mappings || {}).map((mapping) => buildAliasRule(mapping, importedAt)).filter(Boolean);
  const suppliedIds = new Set(suppliedRules.map((rule) => rule.id));
  const savedRules = [...(workspace.counterpartyAliasRules || [])]
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  const rules = [...suppliedRules, ...savedRules.filter((rule) => !suppliedIds.has(rule.id))];
  const applications = [];
  const standardized = transactions.map((transaction) => {
    const exactMapping = mappings?.[transaction.counterpartyAliasKey];
    const exactRule = exactMapping ? buildAliasRule(exactMapping, importedAt) : null;
    const rule = exactRule || rules.find((candidate) => aliasRuleMatches(candidate, transaction));
    if (!rule) return transaction;
    const mapped = applyAliasRule(transaction, rule, suppliedIds.has(rule.id) || exactRule ? "manual" : "saved-alias");
    applications.push({
      transactionId: transaction.id,
      sourceRow: transaction.sourceRow,
      rawName: mapped.counterpartyRaw,
      counterpartyAccount: transaction.counterpartyAccount,
      standardName: mapped.counterparty,
      objectId: mapped.counterpartyObjectId,
      objectType: mapped.counterpartyObjectType,
      kind: mapped.counterpartyKind,
      ruleId: mapped.counterpartyAliasRuleId,
      source: mapped.counterpartyMappingSource,
    });
    return mapped;
  });
  return { transactions: standardized, rules: suppliedRules, applications };
}

function mergeCounterpartyAliasRules(existingRules, newRules, actor, updatedAt) {
  const merged = [...(existingRules || [])];
  newRules.forEach((rule) => {
    const index = merged.findIndex((candidate) => candidate.id === rule.id
      || (rule.normalizedRawName && (candidate.normalizedRawName || normalizePartyName(candidate.rawName)) === rule.normalizedRawName)
      || (rule.normalizedAccount && (candidate.normalizedAccount || normalizeCounterpartyAccount(candidate.counterpartyAccount)) === rule.normalizedAccount));
    const previous = index >= 0 ? merged[index] : null;
    const next = {
      ...previous,
      ...rule,
      id: rule.id,
      createdAt: previous?.createdAt || rule.createdAt || updatedAt,
      updatedAt,
      updatedBy: actor,
    };
    if (index >= 0) merged[index] = next;
    else merged.push(next);
  });
  return merged;
}

export function detectDelimiter(text) {
  const firstRecord = String(text).replace(/^\ufeff/, "").split(/\r?\n/, 1)[0] || "";
  const candidates = [",", "\t", ";", "|"];
  return candidates
    .map((delimiter) => ({ delimiter, count: firstRecord.split(delimiter).length - 1 }))
    .sort((left, right) => right.count - left.count)[0]?.delimiter || ",";
}

export function parseDelimitedText(text, options = {}) {
  const source = String(text ?? "").replace(/^\ufeff/, "");
  const delimiter = options.delimiter || detectDelimiter(source);
  const table = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, "").trim());
      if (row.some((value) => value !== "")) table.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell.replace(/\r$/, "").trim());
  if (row.some((value) => value !== "")) table.push(row);
  return { table, delimiter };
}

export function detectBankFieldMapping(headers) {
  const normalized = headers.map(normalizedHeader);
  const used = new Set();
  const mapping = {};
  const definitions = Object.entries(BANK_FIELD_DEFINITIONS);

  // First reserve exact aliases for every field. This prevents the generic
  // “金额” field from stealing “收入金额” or “支出金额” during fuzzy matching.
  definitions.forEach(([field, definition]) => {
    const aliases = definition.aliases.map(normalizedHeader);
    const index = normalized.findIndex((header, candidateIndex) => !used.has(candidateIndex) && aliases.includes(header));
    if (index >= 0) {
      mapping[field] = index;
      used.add(index);
    }
  });

  definitions.forEach(([field, definition]) => {
    if (mapping[field] != null) return;
    const aliases = definition.aliases.map(normalizedHeader);
    const index = normalized.findIndex((header, candidateIndex) => !used.has(candidateIndex) && aliases.some((alias) => header.includes(alias) || alias.includes(header)));
    if (index >= 0) {
      mapping[field] = index;
      used.add(index);
    }
  });
  return mapping;
}

export function inspectBankTable(table, options = {}) {
  if (!Array.isArray(table) || !table.length) {
    return { headers: [], mapping: {}, missingFields: ["date", "amount"], preview: [], rowCount: 0 };
  }
  const headers = table[0].map((value, index) => normalizeText(value) || `未命名列 ${index + 1}`);
  const mapping = { ...detectBankFieldMapping(headers), ...(options.mapping || {}) };
  const missingFields = [];
  if (mapping.date == null) missingFields.push("date");
  if (mapping.amount == null && mapping.credit == null && mapping.debit == null) missingFields.push("amount");
  return {
    headers,
    mapping,
    missingFields,
    rowCount: Math.max(0, table.length - 1),
    preview: table.slice(1, 6).map((row, index) => ({ rowNumber: index + 2, cells: headers.map((header, cellIndex) => ({ header, value: row[cellIndex] ?? "" })) })),
  };
}

export function detectPlatformSettlementMapping(headers) {
  const normalized = headers.map(normalizedHeader);
  const used = new Set();
  const mapping = {};
  const definitions = Object.entries(PLATFORM_SETTLEMENT_FIELD_DEFINITIONS);
  definitions.forEach(([field, definition]) => {
    const aliases = definition.aliases.map(normalizedHeader);
    const index = normalized.findIndex((header, candidateIndex) => !used.has(candidateIndex) && aliases.includes(header));
    if (index >= 0) {
      mapping[field] = index;
      used.add(index);
    }
  });
  definitions.forEach(([field, definition]) => {
    if (mapping[field] != null) return;
    const aliases = definition.aliases.map(normalizedHeader);
    const index = normalized.findIndex((header, candidateIndex) => !used.has(candidateIndex) && aliases.some((alias) => header.includes(alias) || alias.includes(header)));
    if (index >= 0) {
      mapping[field] = index;
      used.add(index);
    }
  });
  return mapping;
}

export function inspectPlatformSettlementTable(table, options = {}) {
  if (!Array.isArray(table) || !table.length) {
    return { headers: [], mapping: {}, missingFields: Object.keys(PLATFORM_SETTLEMENT_FIELD_DEFINITIONS), preview: [], rowCount: 0 };
  }
  const headers = table[0].map((value, index) => normalizeText(value) || `未命名列 ${index + 1}`);
  const mapping = { ...detectPlatformSettlementMapping(headers), ...(options.mapping || {}) };
  const missingFields = Object.entries(PLATFORM_SETTLEMENT_FIELD_DEFINITIONS)
    .filter(([field, definition]) => definition.required && mapping[field] == null)
    .map(([field]) => field);
  return {
    headers,
    mapping,
    missingFields,
    rowCount: Math.max(0, table.length - 1),
    preview: table.slice(1, 6).map((row, index) => ({
      rowNumber: index + 2,
      cells: headers.map((header, cellIndex) => ({ header, value: row[cellIndex] ?? "" })),
    })),
  };
}

function parseExcelDate(serial) {
  if (!Number.isFinite(serial)) return null;
  const milliseconds = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
}

export function normalizeBankDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === "number") return parseExcelDate(value);
  const text = normalizeText(value);
  if (!text) return null;
  if (/^\d{5}(?:\.\d+)?$/.test(text)) return parseExcelDate(Number(text));
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  const match = compact || text.match(/^(\d{4})[\-/.年](\d{1,2})[\-/.月](\d{1,2})日?(?:\s.*)?$/);
  if (!match) return null;
  const candidate = `${match[1]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}`;
  const date = new Date(`${candidate}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== candidate ? null : candidate;
}

export function normalizeMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  let text = normalizeText(value);
  if (!text || text === "-") return null;
  const negative = /^\(.*\)$/.test(text);
  text = text.replace(/[(),，\s¥￥元]/g, "").replace(/^(RMB|CNY)/i, "");
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return Math.round((negative ? -number : number) * 100) / 100;
}

function valueAt(row, index) {
  return index == null ? undefined : row[index];
}

function rowObject(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
}

function amountFromRow(row, mapping) {
  const direct = normalizeMoney(valueAt(row, mapping.amount));
  const credit = normalizeMoney(valueAt(row, mapping.credit));
  const debit = normalizeMoney(valueAt(row, mapping.debit));
  let amount;
  if (mapping.amount != null) amount = direct;
  else if (credit != null && credit !== 0) amount = Math.abs(credit);
  else if (debit != null && debit !== 0) amount = -Math.abs(debit);
  else amount = null;

  const direction = normalizedHeader(valueAt(row, mapping.direction));
  if (amount != null && direction) {
    if ([...OUTGOING_WORDS].some((word) => normalizedHeader(word) === direction || direction.includes(normalizedHeader(word)))) amount = -Math.abs(amount);
    if ([...INCOMING_WORDS].some((word) => normalizedHeader(word) === direction || direction.includes(normalizedHeader(word)))) amount = Math.abs(amount);
  }
  return amount;
}

export function transactionDedupeKey(transaction) {
  const accountId = normalizeText(transaction.accountId || "unknown-account");
  const serial = normalizeText(transaction.serial);
  if (serial) return `${accountId}|serial|${serial.toLowerCase()}`;
  const fallback = [
    accountId,
    transaction.date,
    Number(transaction.amount || 0).toFixed(2),
    normalizeText(transaction.counterparty).toLowerCase(),
    normalizeText(transaction.summary).toLowerCase(),
  ].join("|");
  return `${accountId}|row|${stableHash(fallback)}`;
}

export function normalizeBankTable(table, mapping, options = {}) {
  const inspection = inspectBankTable(table, { mapping });
  if (inspection.missingFields.length) {
    throw new Error(`缺少必要字段映射：${inspection.missingFields.map((field) => BANK_FIELD_DEFINITIONS[field].label).join("、")}`);
  }
  const importedAt = options.importedAt || new Date().toISOString();
  const importId = options.importId || createId("bank-import");
  const accepted = [];
  const errors = [];
  table.slice(1).forEach((row, index) => {
    const rowNumber = index + 2;
    if (!row.some((value) => normalizeText(value))) return;
    const date = normalizeBankDate(valueAt(row, inspection.mapping.date));
    const amount = amountFromRow(row, inspection.mapping);
    const raw = rowObject(inspection.headers, row);
    const rowErrors = [];
    if (!date) rowErrors.push("交易日期无法识别");
    if (amount == null || amount === 0) rowErrors.push("交易金额为空、为零或无法识别");
    if (rowErrors.length) {
      errors.push({ rowNumber, code: "invalid_row", message: rowErrors.join("；"), raw });
      return;
    }
    const counterpartyRaw = normalizeText(valueAt(row, inspection.mapping.counterparty));
    const counterpartyAccount = normalizeText(valueAt(row, inspection.mapping.counterpartyAccount));
    const transaction = {
      id: createId("txn"),
      accountId: options.accountId,
      date,
      amount,
      counterpartyRaw,
      counterparty: counterpartyRaw || "未识别交易对象",
      counterpartyAccount,
      counterpartyAliasKey: counterpartyAliasKey(counterpartyRaw, counterpartyAccount),
      summary: normalizeText(valueAt(row, inspection.mapping.summary)) || "银行流水",
      serial: normalizeText(valueAt(row, inspection.mapping.serial)),
      balance: normalizeMoney(valueAt(row, inspection.mapping.balance)),
      channel: normalizeText(valueAt(row, inspection.mapping.channel)),
      currency: normalizeText(valueAt(row, inspection.mapping.currency)) || options.currency || "CNY",
      status: "pending",
      suggestion: "待确认",
      evidenceIds: [],
      allocations: [],
      sourceType: "local-file-import",
      sourceFileName: options.fileName || "本地银行流水",
      importId,
      sourceRow: rowNumber,
      raw,
      importedAt,
      createdAt: importedAt,
      updatedAt: importedAt,
    };
    transaction.dedupeKey = transactionDedupeKey(transaction);
    accepted.push(transaction);
  });
  return { importId, headers: inspection.headers, mapping: inspection.mapping, accepted, errors };
}

function dayDistance(left, right) {
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(leftTime - rightTime) / 86_400_000);
}

function deterministicClassification(eventType, transaction, counterpartAccountId = null) {
  const internalTransfer = eventType === "internalTransfer";
  return {
    ruleId: internalTransfer ? "paired-bank-transfer" : "bank-fee-import",
    eventType,
    account: internalTransfer ? "bank" : "expenseFee",
    direction: Number(transaction.amount) >= 0 ? "in" : "out",
    confidence: 99,
    reasons: [internalTransfer ? "不同银行账户存在等额反向且日期接近的流水" : "银行流水摘要明确为手续费"],
    riskFlags: [],
    candidateBillIds: [],
    counterpartAccountId,
    requiresManualReview: false,
    source: "bank-import-rules",
  };
}

function recognitionCounts(recognitions) {
  return recognitions.reduce((counts, recognition) => ({
    ...counts,
    [recognition.type]: (counts[recognition.type] || 0) + 1,
  }), {});
}

function retainedAnomalies(transaction) {
  return (transaction.importAnomalies || []).filter((anomaly) => !SUPERSEDED_IMPORT_ANOMALY_CODES.has(anomaly.code));
}

function withRecognition(transaction, recognition, fields) {
  const remainingAnomalies = retainedAnomalies(transaction);
  const riskFlags = (transaction.riskFlags || []).filter((code) => !SUPERSEDED_IMPORT_ANOMALY_CODES.has(code));
  return {
    ...transaction,
    ...fields,
    recognition,
    recognizedAt: recognition.recognizedAt,
    updatedAt: recognition.recognizedAt || transaction.updatedAt,
    importAnomalies: remainingAnomalies,
    riskFlags,
    status: remainingAnomalies.length ? "exception" : "pending",
    suggestion: remainingAnomalies.length
      ? `${recognition.label}；仍有异常：${remainingAnomalies.map((item) => item.label).join("、")}`
      : recognition.message,
  };
}

export function recognizeBankImportTransactions(workspace, transactions, options = {}) {
  const accountIds = new Set((workspace.bankAccounts || []).map((account) => account.id));
  const accountNames = Object.fromEntries((workspace.bankAccounts || []).map((account) => [account.id, account.name || account.id]));
  const configuredTolerance = Number(options.amountTolerance ?? workspace.rules?.amountTolerance ?? 0.01);
  const configuredDayWindow = Number(options.transferDayWindow ?? workspace.rules?.transferDayWindow ?? DEFAULT_TRANSFER_DAY_WINDOW);
  const amountTolerance = Number.isFinite(configuredTolerance) ? Math.max(0.01, configuredTolerance) : 0.01;
  const dayWindow = Number.isFinite(configuredDayWindow) ? Math.max(0, configuredDayWindow) : DEFAULT_TRANSFER_DAY_WINDOW;
  const usedCounterpartIds = new Set();
  const counterpartUpdates = [];
  const recognitions = [];
  const businessEvents = [];
  const recognizedAt = transactions[0]?.importedAt || new Date().toISOString();

  const recognizedTransactions = transactions.map((transaction) => {
    const text = `${transaction.counterparty || ""} ${transaction.summary || ""}`;
    if (Number(transaction.amount) < 0 && BANK_FEE_PATTERN.test(text)) {
      const eventId = `event-${transaction.id}`;
      const recognition = {
        id: `bank-fee-${transaction.id}`,
        type: "bankFee",
        label: "银行手续费",
        transactionId: transaction.id,
        recognizedAt,
        message: `已识别银行手续费 ${Math.abs(Number(transaction.amount)).toFixed(2)} 元`,
      };
      const recognized = withRecognition(transaction, recognition, {
        businessEventId: eventId,
        directAccount: "expenseFee",
        classification: deterministicClassification("bankFee", transaction),
      });
      recognitions.push(recognition);
      businessEvents.push({
        id: eventId,
        type: "bankFee",
        kind: "bankFee",
        date: transaction.date,
        businessPeriod: transaction.date.slice(0, 7),
        fundingPeriod: transaction.date.slice(0, 7),
        amount: Math.abs(Number(transaction.amount)),
        direction: "out",
        counterparty: transaction.counterparty || "开户银行",
        summary: transaction.summary || "银行手续费",
        account: "expenseFee",
        taxCategory: "待确认",
        confidence: 99,
        sourceIds: [transaction.id],
        status: "recognized",
        reasons: ["银行流水摘要明确为手续费"],
        createdAt: recognizedAt,
        updatedAt: recognizedAt,
      });
      return recognized;
    }

    const candidates = (workspace.transactions || [])
      .filter((candidate) => {
        const candidateEventType = candidate.classification?.eventType;
        const currencyMatches = !candidate.currency || !transaction.currency || candidate.currency === transaction.currency;
        return accountIds.has(candidate.accountId)
          && candidate.accountId !== transaction.accountId
          && !candidate.counterpartTransactionId
          && !candidate.businessEventId
          && !usedCounterpartIds.has(candidate.id)
          && !["posted", "reconciled", "ignored"].includes(candidate.status)
          && !(candidate.allocations || []).some((allocation) => allocation.status !== "reversed")
          && (!candidateEventType || candidateEventType === "unknown")
          && currencyMatches
          && Math.abs(Number(candidate.amount) + Number(transaction.amount)) <= amountTolerance
          && dayDistance(candidate.date, transaction.date) <= dayWindow;
      })
      .sort((left, right) => dayDistance(left.date, transaction.date) - dayDistance(right.date, transaction.date)
        || String(left.date).localeCompare(String(right.date))
        || String(left.id).localeCompare(String(right.id)));
    const counterpart = candidates[0];
    if (!counterpart) return transaction;

    usedCounterpartIds.add(counterpart.id);
    const pairId = `bank-transfer-${stableHash([transaction.id, counterpart.id].sort().join("|"))}`;
    const eventId = `event-${pairId}`;
    const outgoing = Number(transaction.amount) < 0 ? transaction : counterpart;
    const incoming = outgoing.id === transaction.id ? counterpart : transaction;
    const message = `已配对内部转账：${accountNames[outgoing.accountId] || outgoing.accountId} → ${accountNames[incoming.accountId] || incoming.accountId}`;
    const recognition = {
      id: pairId,
      type: "internalTransfer",
      label: "内部转账",
      transactionId: transaction.id,
      counterpartTransactionId: counterpart.id,
      counterpartAccountId: counterpart.accountId,
      dayDistance: dayDistance(transaction.date, counterpart.date),
      recognizedAt,
      message,
    };
    const currentLink = {
      id: pairId,
      counterpartTransactionId: counterpart.id,
      counterpartAccountId: counterpart.accountId,
    };
    const counterpartRecognition = {
      ...recognition,
      transactionId: counterpart.id,
      counterpartTransactionId: transaction.id,
      counterpartAccountId: transaction.accountId,
    };
    const counterpartLink = {
      id: pairId,
      counterpartTransactionId: transaction.id,
      counterpartAccountId: transaction.accountId,
    };
    const recognized = withRecognition(transaction, recognition, {
      businessEventId: eventId,
      transferPairId: pairId,
      internalTransferLink: currentLink,
      counterpartTransactionId: counterpart.id,
      counterpartAccountId: counterpart.accountId,
      classification: deterministicClassification("internalTransfer", transaction, counterpart.accountId),
    });
    counterpartUpdates.push(withRecognition(counterpart, counterpartRecognition, {
      businessEventId: eventId,
      transferPairId: pairId,
      internalTransferLink: counterpartLink,
      counterpartTransactionId: transaction.id,
      counterpartAccountId: transaction.accountId,
      classification: deterministicClassification("internalTransfer", counterpart, transaction.accountId),
    }));
    recognitions.push(recognition);
    businessEvents.push({
      id: eventId,
      type: "internalTransfer",
      kind: "internalTransfer",
      date: outgoing.date,
      businessPeriod: outgoing.date.slice(0, 7),
      fundingPeriod: outgoing.date.slice(0, 7),
      amount: Math.abs(Number(outgoing.amount)),
      direction: "transfer",
      counterparty: `${accountNames[outgoing.accountId] || outgoing.accountId} → ${accountNames[incoming.accountId] || incoming.accountId}`,
      summary: "工作台内银行账户转账",
      account: "bank",
      taxCategory: "不适用",
      confidence: 99,
      sourceIds: [outgoing.id, incoming.id],
      status: "recognized",
      reasons: ["不同银行账户存在等额反向且日期接近的流水"],
      transferPairId: pairId,
      createdAt: recognizedAt,
      updatedAt: recognizedAt,
    });
    return recognized;
  });

  return {
    transactions: recognizedTransactions,
    counterpartUpdates,
    recognitions,
    recognitionCount: recognitions.length,
    counts: recognitionCounts(recognitions),
    businessEvents,
  };
}

export function analyzeBankImportAnomalies(workspace, transactions, options = {}) {
  const knownNames = partyNames(workspace);
  const relatedNames = (workspace.counterparties || [])
    .filter((item) => item.kind === "related_party")
    .map((item) => normalizePartyName(item.name))
    .filter(Boolean);
  const responsibleNames = [
    workspace.company?.legalRepresentative,
    workspace.company?.responsiblePerson,
    workspace.company?.owner,
  ].map(normalizePartyName).filter(Boolean);
  const threshold = largeTransactionThreshold(workspace, options.largeTransactionThreshold);
  const anomalies = [];
  const decoratedTransactions = transactions.map((transaction) => {
    const transactionAnomalies = [];
    const deterministicType = transaction.classification?.eventType;
    const deterministicallyRecognized = DETERMINISTIC_EVENT_TYPES.has(deterministicType);
    const counterpartyConfirmed = Boolean(transaction.counterpartyAliasRuleId || transaction.counterpartyObjectId || transaction.counterpartyMappingSource);
    const normalizedCounterparty = normalizePartyName(transaction.counterparty);
    const relatedParty = transaction.counterpartyKind === "related_party"
      || RELATED_PARTY_PATTERN.test(`${transaction.counterparty || ""} ${transaction.summary || ""}`)
      || relatedNames.some((name) => namesMatch(normalizedCounterparty, name))
      || responsibleNames.some((name) => namesMatch(normalizedCounterparty, name));
    const knownCounterparty = counterpartyConfirmed || knownNames.some((name) => namesMatch(normalizedCounterparty, name));
    const base = {
      transactionId: transaction.id,
      sourceRow: transaction.sourceRow,
      date: transaction.date,
      counterparty: transaction.counterparty,
      amount: transaction.amount,
    };

    if (!deterministicallyRecognized && relatedParty) {
      transactionAnomalies.push({
        ...base,
        code: "bank_related_party",
        label: "疑似关联方",
        message: `交易对手「${transaction.counterparty || "未识别交易对象"}」或摘要疑似关联方往来，需要人工确认`,
      });
    } else if (!deterministicallyRecognized && (!normalizedCounterparty || normalizedCounterparty === normalizePartyName("未识别交易对象") || !knownCounterparty)) {
      transactionAnomalies.push({
        ...base,
        code: "bank_unknown_counterparty",
        label: "未知交易对手",
        message: `交易对手「${transaction.counterparty || "未识别交易对象"}」不在当前往来单位或历史流水中`,
      });
    }

    if (Math.abs(Number(transaction.amount)) >= threshold) {
      transactionAnomalies.push({
        ...base,
        code: "bank_large_amount",
        label: "异常大额",
        message: `单笔金额 ${Math.abs(Number(transaction.amount)).toFixed(2)} 元达到大额阈值 ${threshold.toFixed(2)} 元`,
      });
    }

    anomalies.push(...transactionAnomalies);
    return {
      ...transaction,
      importAnomalies: transactionAnomalies,
      riskFlags: [...new Set([...(transaction.riskFlags || []), ...transactionAnomalies.map((item) => item.code)])],
      status: transactionAnomalies.length ? "exception" : transaction.status,
      suggestion: transactionAnomalies.length
        ? `${transaction.suggestion || "待复核"}；导入异常：${transactionAnomalies.map((item) => item.label).join("、")}`
        : transaction.suggestion,
    };
  });
  return {
    threshold,
    transactions: decoratedTransactions,
    anomalies,
    counts: anomalyCounts(anomalies),
  };
}

function reconcileRows(rows, account, options = {}) {
  const openingInput = options.openingBalance == null || options.openingBalance === ""
    ? account.openingBalance
    : options.openingBalance;
  const openingBalance = normalizeMoney(openingInput);
  const lastRowBalance = [...rows].reverse().find((transaction) => transaction.balance != null)?.balance;
  const statementClosingInput = options.statementClosing == null || options.statementClosing === ""
    ? (lastRowBalance ?? account.statementClosing)
    : options.statementClosing;
  const statementClosing = normalizeMoney(statementClosingInput);
  const movement = Math.round(rows.reduce((sum, transaction) => sum + transaction.amount, 0) * 100) / 100;
  if (openingBalance == null || statementClosing == null) {
    return {
      available: false,
      passed: false,
      openingBalance,
      movement,
      calculatedClosing: openingBalance == null ? null : Math.round((openingBalance + movement) * 100) / 100,
      statementClosing,
      difference: null,
      message: "需要期初余额和期末余额才能完成勾稽",
    };
  }
  const calculatedClosing = Math.round((openingBalance + movement) * 100) / 100;
  const difference = Math.round((statementClosing - calculatedClosing) * 100) / 100;
  const passed = Math.abs(difference) < 0.01;
  return {
    available: true,
    passed,
    openingBalance,
    movement,
    calculatedClosing,
    statementClosing,
    difference,
    message: passed ? "期初余额 + 收入 - 支出 = 期末余额" : `余额相差 ${difference.toFixed(2)} 元`,
  };
}

function reconciliationIssue(reconciliation, { accountId, period } = {}) {
  if (reconciliation?.passed) return null;
  const available = Boolean(reconciliation?.available);
  return {
    code: BANK_RECONCILIATION_EXCEPTION_CODE,
    label: available ? "月度余额差异" : "月度勾稽资料不全",
    message: reconciliation?.message || "月度勾稽尚未完成",
    accountId: accountId || null,
    period: period || null,
    available,
    difference: reconciliation?.difference ?? null,
    openingBalance: reconciliation?.openingBalance ?? null,
    statementClosing: reconciliation?.statementClosing ?? null,
    calculatedClosing: reconciliation?.calculatedClosing ?? null,
  };
}

function reconciliationTaskIdentity(accountId, period) {
  return `${BANK_RECONCILIATION_EXCEPTION_CODE}:${accountId}:${period}`;
}

function synchronizeBankReconciliationTask(tasks, monthly, plan, actor) {
  const next = [...(tasks || [])];
  const identity = reconciliationTaskIdentity(plan.accountId, plan.period);
  const index = next.findIndex((task) => task.identity === identity && task.status !== "resolved");
  const current = index >= 0 ? next[index] : null;
  if (monthly.passed) {
    if (current) next[index] = {
      ...current,
      status: "resolved",
      resolution: "monthly_reconciliation_completed",
      resolvedAt: plan.importedAt,
      resolvedBy: actor,
      updatedAt: plan.importedAt,
      history: [...(current.history || []), {
        at: plan.importedAt,
        actor,
        action: "resolved",
        note: monthly.message,
      }],
    };
    return next;
  }
  const issue = reconciliationIssue(monthly, { accountId: plan.accountId, period: plan.period });
  const accountName = monthly.accountName || plan.accountId;
  const message = `${accountName} · ${plan.period}：${issue.message}。当前流水与余额资料已保留，可继续导入缺失流水或更正余额后重新勾稽。`;
  const sourceIds = [...new Set([...(current?.sourceIds || []), plan.accountId, plan.id, plan.sourceDocumentId].filter(Boolean))];
  if (current) {
    next[index] = {
      ...current,
      message,
      status: "open",
      workflowState: "awaiting_reconciliation",
      updatedAt: plan.importedAt,
      sourceIds,
      reconciliation: issue,
      history: [...(current.history || []), {
        at: plan.importedAt,
        actor,
        action: "recalculated",
        note: issue.message,
      }],
    };
    return next;
  }
  next.push({
    id: createId("exception"),
    identity,
    code: BANK_RECONCILIATION_EXCEPTION_CODE,
    sourceType: "bankReconciliation",
    sourceId: plan.accountId,
    accountId: plan.accountId,
    period: plan.period,
    importId: plan.id || null,
    message,
    missingEvidence: [],
    status: "open",
    workflowState: "awaiting_reconciliation",
    reconciliation: issue,
    createdAt: plan.importedAt,
    updatedAt: plan.importedAt,
    sourceIds,
    history: [{ at: plan.importedAt, actor, action: "created", note: issue.message }],
  });
  return next;
}

export function buildBankMonthlyReconciliation(workspace, { accountId, period }) {
  const account = (workspace.bankAccounts || []).find((item) => item.id === accountId);
  const reviewedBalances = account?.reconciliationBalances?.[period];
  const hasReviewedBalances = Boolean(reviewedBalances && typeof reviewedBalances === "object");
  const transactions = (workspace.transactions || []).filter((transaction) => (
    transaction.accountId === accountId && String(transaction.date || "").slice(0, 7) === period
  ));
  const imports = (workspace.bankImports || [])
    .filter((record) => record.accountId === accountId && record.period === period)
    .map((record) => {
      const batchTransactions = transactions.filter((transaction) => transaction.importId === record.id);
      const dates = batchTransactions.map((transaction) => transaction.date).filter(Boolean).sort();
      const anomalousTransactionIds = new Set((record.anomalies || []).map((anomaly) => anomaly.transactionId).filter(Boolean));
      return {
        ...record,
        dateFrom: record.dateFrom || dates[0] || null,
        dateTo: record.dateTo || dates.at(-1) || null,
        actor: record.actor || "本地用户",
        importableRowCount: Number(record.importableRowCount ?? batchTransactions.length),
        duplicateCount: Number(record.duplicateCount || 0),
        anomalousRowCount: Number(record.anomalousRowCount ?? anomalousTransactionIds.size ?? 0),
      };
    })
    .sort((left, right) => String(right.importedAt || "").localeCompare(String(left.importedAt || "")));
  const chronological = [...imports].sort((left, right) => (
    String(left.dateFrom || left.importedAt || "").localeCompare(String(right.dateFrom || right.importedAt || ""))
    || String(left.importedAt || "").localeCompare(String(right.importedAt || ""))
  ));
  const closingOrder = [...imports].sort((left, right) => (
    String(right.dateTo || right.importedAt || "").localeCompare(String(left.dateTo || left.importedAt || ""))
    || String(right.importedAt || "").localeCompare(String(left.importedAt || ""))
  ));
  const openingRecord = chronological.find((record) => normalizeMoney(record.reconciliation?.openingBalance) != null);
  const closingRecord = closingOrder.find((record) => normalizeMoney(record.reconciliation?.statementClosing) != null);
  const accountFallbackAllowed = imports.length === 0 && period === workspace.currentPeriod;
  const openingBalance = hasReviewedBalances
    ? normalizeMoney(reviewedBalances.openingBalance)
    : normalizeMoney(openingRecord?.reconciliation?.openingBalance
      ?? (accountFallbackAllowed ? account?.openingBalance : null));
  const statementClosing = hasReviewedBalances
    ? normalizeMoney(reviewedBalances.statementClosing)
    : normalizeMoney(closingRecord?.reconciliation?.statementClosing
      ?? (accountFallbackAllowed ? account?.statementClosing : null));
  const income = Math.round(transactions.filter((transaction) => Number(transaction.amount) > 0)
    .reduce((sum, transaction) => sum + Number(transaction.amount), 0) * 100) / 100;
  const expense = Math.round(transactions.filter((transaction) => Number(transaction.amount) < 0)
    .reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount)), 0) * 100) / 100;
  const calculatedClosing = openingBalance == null ? null : Math.round((openingBalance + income - expense) * 100) / 100;
  const difference = calculatedClosing == null || statementClosing == null
    ? null
    : Math.round((statementClosing - calculatedClosing) * 100) / 100;
  const available = openingBalance != null && statementClosing != null;
  const passed = imports.length > 0 && available && Math.abs(difference) < 0.01;
  let status = "complete";
  let message = "本月期初、收支与期末余额已勾稽完成";
  if (!imports.length) {
    status = "not_started";
    message = "本账户本期尚无导入批次，月度勾稽未开始";
  } else if (!available) {
    status = "incomplete";
    const missing = [openingBalance == null ? "期初余额" : null, statementClosing == null ? "期末余额" : null].filter(Boolean);
    message = `缺少${missing.join("和")}，月度勾稽未完成`;
  } else if (!passed) {
    status = "difference";
    message = `月度余额相差 ${difference.toFixed(2)} 元，勾稽未完成`;
  }
  return {
    accountId,
    accountName: account?.name || accountId || "未选择账户",
    period,
    imports,
    batchCount: imports.length,
    transactionCount: transactions.length,
    dateFrom: transactions.map((transaction) => transaction.date).filter(Boolean).sort()[0] || null,
    dateTo: transactions.map((transaction) => transaction.date).filter(Boolean).sort().at(-1) || null,
    openingBalance,
    income,
    expense,
    statementClosing,
    calculatedClosing,
    difference,
    available,
    passed,
    status,
    message,
    balanceSource: hasReviewedBalances ? "account_recheck" : imports.length ? "import_records" : "account_master",
    balanceReviewedAt: hasReviewedBalances ? reviewedBalances.reconciledAt || null : null,
    balanceReviewedBy: hasReviewedBalances ? reviewedBalances.reconciledBy || null : null,
    openingCarryForward: account?.balanceCarryForwards?.[period] ? {
      ...account.balanceCarryForwards[period],
      matchesOpeningBalance: openingBalance === account.balanceCarryForwards[period].openingBalance,
    } : null,
  };
}

export function buildBankAccountReconciliationSummary(workspace, { period }) {
  const bankAccounts = workspace.bankAccounts || [];
  const periodTransactions = (workspace.transactions || []).filter((transaction) => (
    String(transaction.date || "").slice(0, 7) === period
  ));
  const periodImports = (workspace.bankImports || []).filter((record) => record.period === period);
  const accounts = bankAccounts.filter((account) => (
    account.status !== "inactive"
    || periodTransactions.some((transaction) => transaction.accountId === account.id)
    || periodImports.some((record) => record.accountId === account.id)
  ));
  const rows = accounts.map((account) => ({
    ...buildBankMonthlyReconciliation(workspace, { accountId: account.id, period }),
    accountNumber: account.accountNumber || account.number || "",
    currency: account.currency || "CNY",
    accountStatus: account.status || "active",
  }));
  const completedCount = rows.filter((row) => row.passed).length;
  const incompleteCount = rows.length - completedCount;
  const passed = rows.length > 0 && incompleteCount === 0;
  let message = `${incompleteCount} 个账户尚未完成本期勾稽`;
  if (!rows.length) message = "本期没有需要勾稽的银行账户";
  else if (passed) message = `${rows.length} 个账户已全部完成本期勾稽`;
  return {
    period,
    accounts: rows,
    accountCount: rows.length,
    completedCount,
    incompleteCount,
    passed,
    message,
  };
}

function bankReconciliationStageState(workspace, exceptionTasks, period, updatedAt) {
  const accountSummary = buildBankAccountReconciliationSummary(workspace, { period });
  const hasOpenImportTasks = (exceptionTasks || []).some((task) => (
    task.status !== "resolved"
    && ["bankTransaction", "bankReconciliation"].includes(task.sourceType)
  ));
  return {
    accountSummary,
    stage: {
      status: accountSummary.passed && !hasOpenImportTasks ? "complete" : "needs_review",
      updatedAt,
    },
  };
}

export function reconcileBankAccountPeriod(workspace, input = {}) {
  if (!workspace?.id) throw new Error("找不到需要重新勾稽的工作台");
  const accountId = String(input.accountId || "").trim();
  const period = String(input.period || "").trim();
  if (!validPeriod(period)) throw new Error("请选择有效账期后再重新勾稽");
  const account = (workspace.bankAccounts || []).find((item) => item.id === accountId);
  if (!account) throw new Error("找不到需要重新勾稽的银行账户");
  const actor = String(input.actor || "本地用户").trim() || "本地用户";
  const reconciledAt = input.reconciledAt || new Date().toISOString();
  const balanceSnapshot = {
    openingBalance: normalizeMoney(account.openingBalance),
    statementClosing: normalizeMoney(account.statementClosing),
    reconciledAt,
    reconciledBy: actor,
    source: "bank_account_master",
  };
  const bankAccounts = (workspace.bankAccounts || []).map((item) => item.id === accountId ? {
    ...item,
    reconciliationBalances: {
      ...(item.reconciliationBalances || {}),
      [period]: balanceSnapshot,
    },
    updatedAt: reconciledAt,
  } : item);
  const workspaceWithBalances = {
    ...workspace,
    bankAccounts,
    accounts: bankAccounts,
  };
  const monthly = buildBankMonthlyReconciliation(workspaceWithBalances, { accountId, period });
  const identity = reconciliationTaskIdentity(accountId, period);
  const hadOpenException = (workspace.exceptionTasks || []).some((task) => (
    task.identity === identity && task.status !== "resolved"
  ));
  const exceptionTasks = synchronizeBankReconciliationTask(
    workspace.exceptionTasks,
    monthly,
    { accountId, period, importedAt: reconciledAt },
    actor,
  );
  const workspaceWithTasks = { ...workspaceWithBalances, exceptionTasks };
  const { accountSummary, stage } = bankReconciliationStageState(
    workspaceWithTasks,
    exceptionTasks,
    period,
    reconciledAt,
  );
  const exceptionAction = monthly.passed
    ? hadOpenException ? "resolved" : "none"
    : hadOpenException ? "updated" : "created";
  return {
    workspace: {
      ...workspaceWithTasks,
      stages: {
        ...workspace.stages,
        s3: stage,
      },
    },
    reconciliation: monthly,
    accountSummary,
    exceptionAction,
    reconciledAt,
  };
}

export function normalizePlatformSettlementTable(table, mapping, options = {}) {
  const inspection = inspectPlatformSettlementTable(table, { mapping });
  if (inspection.missingFields.length) {
    throw new Error(`缺少必要字段映射：${inspection.missingFields.map((field) => PLATFORM_SETTLEMENT_FIELD_DEFINITIONS[field].label).join("、")}`);
  }
  if (!PLATFORM_SETTLEMENT_CHANNELS[options.channel]) throw new Error("请选择微信、支付宝或 POS 结算渠道");
  const importedAt = options.importedAt || new Date().toISOString();
  const importId = options.importId || createId("platform-import");
  const accepted = [];
  const errors = [];
  table.slice(1).forEach((row, index) => {
    const rowNumber = index + 2;
    if (!row.some((value) => normalizeText(value))) return;
    const settlementDate = normalizeBankDate(valueAt(row, inspection.mapping.settlementDate));
    const settlementNo = normalizeText(valueAt(row, inspection.mapping.settlementNo));
    const grossAmount = normalizeMoney(valueAt(row, inspection.mapping.grossAmount));
    const feeValue = normalizeMoney(valueAt(row, inspection.mapping.feeAmount));
    const refundValue = normalizeMoney(valueAt(row, inspection.mapping.refundAmount));
    const netAmount = normalizeMoney(valueAt(row, inspection.mapping.netAmount));
    const rowErrors = [];
    if (!settlementDate) rowErrors.push("结算日期无法识别");
    if (!settlementNo) rowErrors.push("结算单号为空");
    if (grossAmount == null || grossAmount <= 0) rowErrors.push("交易总额必须大于零");
    if (netAmount == null || netAmount <= 0) rowErrors.push("净结算额必须大于零");
    if (feeValue != null && feeValue < 0) rowErrors.push("手续费不能为负数");
    if (refundValue != null && refundValue < 0) rowErrors.push("退款不能为负数");
    const raw = rowObject(inspection.headers, row);
    if (rowErrors.length) {
      errors.push({ rowNumber, code: "invalid_settlement_row", message: rowErrors.join("；"), raw });
      return;
    }
    const feeAmount = Math.abs(feeValue || 0);
    const refundAmount = Math.abs(refundValue || 0);
    const expectedNetAmount = Math.round((grossAmount - feeAmount - refundAmount) * 100) / 100;
    accepted.push({
      id: createId("platform-settlement"),
      importId,
      channel: options.channel,
      channelLabel: PLATFORM_SETTLEMENT_CHANNELS[options.channel],
      accountId: options.accountId,
      period: options.period || settlementDate.slice(0, 7),
      settlementDate,
      settlementNo,
      dedupeKey: settlementNo.toLowerCase(),
      grossAmount,
      feeAmount,
      refundAmount,
      netAmount,
      expectedNetAmount,
      componentDifference: Math.round((netAmount - expectedNetAmount) * 100) / 100,
      bankTransactionId: null,
      candidateBankTransactionId: null,
      bankAmount: null,
      amountDifference: null,
      matchStatus: "pending",
      sourceFileName: options.fileName || "本地平台结算单",
      sourceRow: rowNumber,
      raw,
      evidenceIds: [],
      importedAt,
      createdAt: importedAt,
      updatedAt: importedAt,
    });
  });
  return { importId, headers: inspection.headers, mapping: inspection.mapping, accepted, errors };
}

export function matchPlatformSettlements(workspace, settlements, options = {}) {
  const amountToleranceValue = Number(options.amountTolerance ?? workspace.rules?.amountTolerance ?? 0.01);
  const dayWindowValue = Number(options.dayWindow ?? workspace.rules?.settlementMatchDayWindow ?? 3);
  const amountTolerance = Number.isFinite(amountToleranceValue) ? Math.max(0.01, amountToleranceValue) : 0.01;
  const dayWindow = Number.isFinite(dayWindowValue) ? Math.max(0, dayWindowValue) : 3;
  const usedTransactionIds = new Set();
  const matches = [];
  const anomalies = [];
  const matchedSettlements = settlements.map((settlement) => {
    const dateCandidates = (workspace.transactions || [])
      .filter((transaction) => transaction.accountId === settlement.accountId
        && Number(transaction.amount) > 0
        && !transaction.platformSettlementId
        && !usedTransactionIds.has(transaction.id)
        && dayDistance(transaction.date, settlement.settlementDate) <= dayWindow)
      .sort((left, right) => dayDistance(left.date, settlement.settlementDate) - dayDistance(right.date, settlement.settlementDate)
        || Math.abs(Number(left.amount) - settlement.netAmount) - Math.abs(Number(right.amount) - settlement.netAmount)
        || String(left.id).localeCompare(String(right.id)));
    const exact = dateCandidates.find((transaction) => Math.abs(Number(transaction.amount) - settlement.netAmount) <= amountTolerance);
    const candidate = exact || dateCandidates[0] || null;
    const settlementAnomalies = [];
    if (Math.abs(settlement.componentDifference) > amountTolerance) {
      settlementAnomalies.push({
        code: "platform_settlement_component_difference",
        label: "结算构成差异",
        message: `交易总额减手续费和退款应为 ${settlement.expectedNetAmount.toFixed(2)} 元，文件净额为 ${settlement.netAmount.toFixed(2)} 元`,
      });
    }
    if (!exact) {
      settlementAnomalies.push(candidate ? {
        code: "platform_settlement_amount_difference",
        label: "到账金额差异",
        message: `净结算额 ${settlement.netAmount.toFixed(2)} 元，近日期银行入账 ${Number(candidate.amount).toFixed(2)} 元，差额 ${(Number(candidate.amount) - settlement.netAmount).toFixed(2)} 元`,
      } : {
        code: "platform_settlement_unmatched",
        label: "未匹配银行到账",
        message: `结算日 ${settlement.settlementDate} 前后 ${dayWindow} 天内未找到净额 ${settlement.netAmount.toFixed(2)} 元的银行入账`,
      });
    }
    if (exact) {
      usedTransactionIds.add(exact.id);
      matches.push({
        settlementId: settlement.id,
        bankTransactionId: exact.id,
        netAmount: settlement.netAmount,
        bankAmount: Number(exact.amount),
        dateDifferenceDays: dayDistance(exact.date, settlement.settlementDate),
      });
    }
    const result = {
      ...settlement,
      bankTransactionId: exact?.id || null,
      candidateBankTransactionId: exact ? null : candidate?.id || null,
      bankAmount: candidate ? Number(candidate.amount) : null,
      amountDifference: candidate ? Math.round((Number(candidate.amount) - settlement.netAmount) * 100) / 100 : null,
      dateDifferenceDays: candidate ? dayDistance(candidate.date, settlement.settlementDate) : null,
      matchStatus: exact ? (settlementAnomalies.length ? "matched_with_alerts" : "matched") : "exception",
      anomalies: settlementAnomalies.map((anomaly) => ({
        ...anomaly,
        settlementId: settlement.id,
        sourceRow: settlement.sourceRow,
        settlementNo: settlement.settlementNo,
      })),
    };
    anomalies.push(...result.anomalies);
    return result;
  });
  return { settlements: matchedSettlements, matches, anomalies, amountTolerance, dayWindow };
}

export function preparePlatformSettlementImport(workspace, input) {
  if (!PLATFORM_SETTLEMENT_CHANNELS[input.channel]) throw new Error("请选择微信、支付宝或 POS 结算渠道");
  if (!(workspace.bankAccounts || []).some((account) => account.id === input.accountId)) throw new Error("请选择结算款到账的银行账户");
  if (!validPeriod(input.period)) throw new Error("请选择有效的结算账期");
  const normalized = normalizePlatformSettlementTable(input.table, input.mapping, {
    channel: input.channel,
    accountId: input.accountId,
    period: input.period,
    fileName: input.fileName,
    importedAt: input.importedAt,
    importId: input.importId,
  });
  const rowPeriods = [...new Set(normalized.accepted.map((row) => row.settlementDate.slice(0, 7)))];
  if (rowPeriods.length > 1) throw new Error(`一次只能导入一个结算账期；当前文件包含 ${rowPeriods.join("、")}`);
  if (rowPeriods[0] && rowPeriods[0] !== input.period) throw new Error(`所选账期 ${input.period} 与结算日期账期 ${rowPeriods[0]} 不一致`);
  const existingKeys = new Set((workspace.platformSettlements || []).map((settlement) => String(settlement.settlementNo || "").trim().toLowerCase()));
  const fileKeys = new Set();
  const importable = [];
  const duplicates = [];
  normalized.accepted.forEach((settlement) => {
    if (fileKeys.has(settlement.dedupeKey) || existingKeys.has(settlement.dedupeKey)) {
      duplicates.push({
        rowNumber: settlement.sourceRow,
        settlementNo: settlement.settlementNo,
        reason: fileKeys.has(settlement.dedupeKey) ? "文件内重复" : "工作台中已存在",
      });
      return;
    }
    fileKeys.add(settlement.dedupeKey);
    importable.push(settlement);
  });
  const matchAnalysis = matchPlatformSettlements(workspace, importable, input);
  const dates = matchAnalysis.settlements.map((settlement) => settlement.settlementDate).sort();
  return {
    id: normalized.importId,
    workspaceId: workspace.id,
    accountId: input.accountId,
    period: input.period,
    channel: input.channel,
    channelLabel: PLATFORM_SETTLEMENT_CHANNELS[input.channel],
    fileName: input.fileName || "本地平台结算单",
    fileHash: input.fileHash || null,
    sheetName: input.sheetName || null,
    importedAt: input.importedAt || new Date().toISOString(),
    mapping: normalized.mapping,
    headers: normalized.headers,
    rowCount: Math.max(0, input.table.length - 1),
    importableRowCount: matchAnalysis.settlements.length,
    duplicateCount: duplicates.length,
    errorCount: normalized.errors.length,
    matchedCount: matchAnalysis.matches.length,
    anomalyCount: matchAnalysis.anomalies.length,
    anomalousRowCount: new Set(matchAnalysis.anomalies.map((anomaly) => anomaly.settlementId)).size,
    dateFrom: dates[0] || null,
    dateTo: dates.at(-1) || null,
    errors: normalized.errors,
    duplicates,
    settlements: matchAnalysis.settlements,
    matches: matchAnalysis.matches,
    anomalies: matchAnalysis.anomalies,
    amountTolerance: matchAnalysis.amountTolerance,
    dayWindow: matchAnalysis.dayWindow,
    status: normalized.errors.length ? "completed_with_errors" : matchAnalysis.anomalies.length ? "completed_with_alerts" : "completed",
  };
}

function platformSettlementBusinessEvent(settlement, importedAt) {
  return {
    id: `event-${settlement.id}`,
    type: "platformSettlement",
    kind: "platformSettlement",
    channel: settlement.channel,
    channelLabel: settlement.channelLabel,
    date: settlement.settlementDate,
    businessPeriod: settlement.period,
    fundingPeriod: settlement.period,
    amount: settlement.grossAmount,
    grossAmount: settlement.grossAmount,
    feeAmount: settlement.feeAmount,
    refundAmount: settlement.refundAmount,
    netAmount: settlement.netAmount,
    direction: "in",
    counterparty: settlement.channelLabel,
    summary: `${settlement.channelLabel}结算单 ${settlement.settlementNo}`,
    account: "revenueGroup",
    feeAccount: "expenseCommission",
    refundAccount: "salesReturns",
    bankTransactionId: settlement.bankTransactionId,
    sourceIds: [settlement.id, ...(settlement.bankTransactionId ? [settlement.bankTransactionId] : [])],
    status: settlement.matchStatus === "matched" ? "recognized" : "needs_review",
    accountingComponents: [
      { kind: "grossRevenue", account: "revenueGroup", amount: settlement.grossAmount, side: "credit" },
      { kind: "platformFee", account: "expenseCommission", amount: settlement.feeAmount, side: "debit" },
      { kind: "refund", account: "salesReturns", amount: settlement.refundAmount, side: "debit" },
      { kind: "bankReceipt", account: settlement.accountId, amount: settlement.netAmount, side: "debit" },
    ],
    accountingBasis: "营业收入取交易总额；平台手续费、退款和银行净到账分别保留，不以净额代替营业收入",
    createdAt: importedAt,
    updatedAt: importedAt,
  };
}

export function applyPlatformSettlementImport(state, workspaceId, plan, options = {}) {
  if (plan.workspaceId !== workspaceId) throw new Error("平台结算导入计划不属于当前工作台");
  const workspace = getWorkspace(state, workspaceId);
  if (!workspace) throw new Error(`找不到工作台：${workspaceId}`);
  if ((workspace.platformSettlementImports || []).some((record) => record.id === plan.id)) throw new Error("这份平台结算导入计划已经执行过");
  if (plan.errorCount > 0) throw new Error(`文件仍有 ${plan.errorCount} 行错误，请修正后重新预检查`);
  if (isPeriodArchived(workspace, plan.period)) throw new Error(`${plan.period} 已归档，不能继续导入`);
  const existingKeys = new Set((workspace.platformSettlements || []).map((settlement) => String(settlement.settlementNo || "").trim().toLowerCase()));
  const importable = (plan.settlements || []).filter((settlement) => !existingKeys.has(settlement.dedupeKey || settlement.settlementNo.toLowerCase()));
  if (!importable.length) throw new Error("没有可导入的新结算单，全部为重复记录");
  const matchAnalysis = matchPlatformSettlements(workspace, importable, plan);
  const actor = options.actor || "本地用户";
  const effectivePlan = {
    ...plan,
    actor,
    settlements: matchAnalysis.settlements,
    matches: matchAnalysis.matches,
    anomalies: matchAnalysis.anomalies,
    importableRowCount: matchAnalysis.settlements.length,
    duplicateCount: Number(plan.duplicateCount || 0) + ((plan.settlements || []).length - importable.length),
    matchedCount: matchAnalysis.matches.length,
    anomalyCount: matchAnalysis.anomalies.length,
    anomalousRowCount: new Set(matchAnalysis.anomalies.map((anomaly) => anomaly.settlementId)).size,
    status: matchAnalysis.anomalies.length ? "completed_with_alerts" : "completed",
  };
  const transactionUpdates = new Map();
  effectivePlan.settlements.filter((settlement) => settlement.bankTransactionId).forEach((settlement) => {
    const transaction = workspace.transactions.find((item) => item.id === settlement.bankTransactionId);
    if (!transaction) return;
    transactionUpdates.set(transaction.id, {
      ...transaction,
      platformSettlementId: settlement.id,
      platformSettlementChannel: settlement.channel,
      platformSettlementNo: settlement.settlementNo,
      platformSettlementEventId: `event-${settlement.id}`,
      settlementBreakdown: {
        grossAmount: settlement.grossAmount,
        feeAmount: settlement.feeAmount,
        refundAmount: settlement.refundAmount,
        netAmount: settlement.netAmount,
      },
      classification: {
        ruleId: "platform-settlement-match",
        eventType: "customerReceipt",
        account: "receivable",
        direction: "in",
        confidence: 99,
        reasons: ["银行流水仅核对平台净到账；营业收入以结算单交易总额为准"],
        riskFlags: [],
        candidateBillIds: [],
        counterpartAccountId: null,
        requiresManualReview: false,
        source: "platform-settlement-import",
      },
      suggestion: `${settlement.channelLabel}结算已核对：总额 ${settlement.grossAmount.toFixed(2)}，手续费 ${settlement.feeAmount.toFixed(2)}，退款 ${settlement.refundAmount.toFixed(2)}，净到账 ${settlement.netAmount.toFixed(2)}`,
      updatedAt: effectivePlan.importedAt,
    });
  });
  const businessEvents = effectivePlan.settlements.map((settlement) => platformSettlementBusinessEvent(settlement, effectivePlan.importedAt));
  const exceptionTasks = effectivePlan.anomalies.map((anomaly) => ({
    id: createId("exception"),
    identity: `${anomaly.settlementId}:${anomaly.code}`,
    code: anomaly.code,
    sourceType: "platformSettlement",
    sourceId: anomaly.settlementId,
    message: anomaly.message,
    status: "open",
    createdAt: effectivePlan.importedAt,
    updatedAt: effectivePlan.importedAt,
    sourceIds: [anomaly.settlementId, ...(effectivePlan.sourceDocumentId ? [effectivePlan.sourceDocumentId] : [])],
    history: [{ at: effectivePlan.importedAt, actor, action: "created", note: anomaly.message }],
  }));
  const record = deepClone({ ...effectivePlan, settlements: undefined });
  return updateWorkspace(state, workspaceId, (source) => {
    const current = activateWorkspacePeriod(source, plan.period);
    return ({
    ...current,
    platformSettlementImports: [...(current.platformSettlementImports || []), record],
    platformSettlements: [...effectivePlan.settlements, ...(current.platformSettlements || [])],
    transactions: current.transactions.map((transaction) => transactionUpdates.get(transaction.id) || transaction),
    businessEvents: [...businessEvents, ...(current.businessEvents || [])],
    exceptionTasks: [...(current.exceptionTasks || []), ...exceptionTasks],
    stages: {
      ...current.stages,
      s3: {
        status: effectivePlan.anomalyCount ? "needs_review" : current.stages?.s3?.status,
        updatedAt: effectivePlan.importedAt,
      },
    },
    });
  }, {
    actor,
    action: "导入平台结算单",
    detail: `${effectivePlan.channelLabel} ${effectivePlan.fileName}：新增 ${effectivePlan.importableRowCount} 份，重复 ${effectivePlan.duplicateCount} 份，匹配到账 ${effectivePlan.matchedCount} 份，异常 ${effectivePlan.anomalousRowCount} 份`,
    objectType: "platformSettlementImports",
    objectId: effectivePlan.id,
  }, options);
}

export function prepareBankImport(workspace, input) {
  const account = workspace.bankAccounts.find((candidate) => candidate.id === input.accountId);
  if (!account) throw new Error(`找不到银行账户：${input.accountId}`);
  const selectedPeriod = input.period == null || input.period === "" ? null : String(input.period);
  if (selectedPeriod && !validPeriod(selectedPeriod)) throw new Error("请选择有效的导入账期");
  const normalized = normalizeBankTable(input.table, input.mapping, {
    accountId: input.accountId,
    fileName: input.fileName,
    currency: account.currency,
    importedAt: input.importedAt,
    importId: input.importId,
  });
  const existingKeys = new Set(workspace.transactions.map((transaction) => transaction.dedupeKey || transactionDedupeKey(transaction)));
  const fileKeys = new Set();
  const statementRows = [];
  const newTransactions = [];
  const duplicates = [];

  normalized.accepted.forEach((transaction) => {
    if (fileKeys.has(transaction.dedupeKey)) {
      duplicates.push({ rowNumber: transaction.sourceRow, reason: "文件内重复", dedupeKey: transaction.dedupeKey, transaction });
      return;
    }
    fileKeys.add(transaction.dedupeKey);
    statementRows.push(transaction);
    if (existingKeys.has(transaction.dedupeKey)) {
      duplicates.push({ rowNumber: transaction.sourceRow, reason: "工作台中已存在", dedupeKey: transaction.dedupeKey, transaction });
      return;
    }
    newTransactions.push(transaction);
  });

  const statementDates = statementRows.map((row) => row.date).filter(Boolean).sort();
  const rowPeriods = [...new Set(statementRows.map((row) => row.date?.slice(0, 7)).filter(Boolean))];
  if (rowPeriods.length > 1) throw new Error(`一次只能导入一个账期；当前文件包含 ${rowPeriods.join("、")}`);
  const detectedPeriod = rowPeriods[0] || null;
  if (selectedPeriod && detectedPeriod && selectedPeriod !== detectedPeriod) {
    throw new Error(`所选账期 ${selectedPeriod} 与流水日期账期 ${detectedPeriod} 不一致`);
  }
  const period = selectedPeriod || detectedPeriod || workspace.currentPeriod;
  if (!validPeriod(period)) throw new Error("无法确定有效账期，请先选择导入账期");
  if (isPeriodArchived(workspace, period)) throw new Error(`${period} 已归档，不能继续导入`);
  const periodWorkspace = activateWorkspacePeriod(workspace, period);
  const periodAccount = periodWorkspace.bankAccounts.find((candidate) => candidate.id === account.id);
  const reconciliation = reconcileRows(statementRows, periodAccount, input);
  const aliasAnalysis = applyCounterpartyAliasRules(workspace, newTransactions, input.counterpartyMappings, {
    importedAt: input.importedAt,
  });
  const recognitionAnalysis = recognizeBankImportTransactions(workspace, aliasAnalysis.transactions, input);
  const anomalyAnalysis = analyzeBankImportAnomalies(workspace, recognitionAnalysis.transactions, input);
  const reconciliationAlert = reconciliationIssue(reconciliation, { accountId: input.accountId, period });
  const canImport = normalized.errors.length === 0 && anomalyAnalysis.transactions.length > 0;
  const blockingReasons = [
    ...(normalized.errors.length ? [`${normalized.errors.length} 行字段错误`] : []),
    ...(!anomalyAnalysis.transactions.length ? [duplicates.length ? "没有新的可导入流水" : "文件中没有有效流水"] : []),
  ];
  return {
    id: normalized.importId,
    workspaceId: workspace.id,
    accountId: input.accountId,
    fileName: input.fileName || "本地银行流水",
    fileHash: input.fileHash || null,
    sheetName: input.sheetName || null,
    period,
    importedAt: input.importedAt || new Date().toISOString(),
    mapping: normalized.mapping,
    headers: normalized.headers,
    rowCount: Math.max(0, input.table.length - 1),
    validRowCount: statementRows.length,
    dateFrom: statementDates[0] || null,
    dateTo: statementDates.at(-1) || null,
    importableRowCount: anomalyAnalysis.transactions.length,
    errorCount: normalized.errors.length,
    duplicateCount: duplicates.length,
    errors: normalized.errors,
    duplicates,
    transactions: anomalyAnalysis.transactions,
    anomalies: anomalyAnalysis.anomalies,
    anomalyCount: anomalyAnalysis.anomalies.length,
    anomalousRowCount: new Set(anomalyAnalysis.anomalies.map((anomaly) => anomaly.transactionId)).size,
    anomalyCounts: anomalyAnalysis.counts,
    largeTransactionThreshold: anomalyAnalysis.threshold,
    recognitions: recognitionAnalysis.recognitions,
    recognitionCount: recognitionAnalysis.recognitionCount,
    recognitionCounts: recognitionAnalysis.counts,
    businessEvents: recognitionAnalysis.businessEvents,
    counterpartyAliasRules: aliasAnalysis.rules,
    counterpartyApplications: aliasAnalysis.applications,
    reconciliation,
    reconciliationIssue: reconciliationAlert,
    reconciliationIssueCount: reconciliationAlert ? 1 : 0,
    canImport,
    blockingReasons,
    importDisposition: !canImport
      ? "blocked"
      : reconciliationAlert
        ? "ready_with_reconciliation_issue"
        : "ready",
    status: normalized.errors.length
      ? "completed_with_errors"
      : !anomalyAnalysis.transactions.length
        ? "completed_without_new_rows"
        : !reconciliation.available
          ? "reconciliation_required"
          : !reconciliation.passed
            ? "reconciliation_failed"
            : anomalyAnalysis.anomalies.length
              ? "completed_with_alerts"
              : "completed",
  };
}

export function applyBankImport(state, workspaceId, plan, options = {}) {
  if (plan.workspaceId !== workspaceId) throw new Error("导入计划不属于当前工作台");
  const existingWorkspace = getWorkspace(state, workspaceId);
  if (!existingWorkspace) throw new Error(`找不到工作台：${workspaceId}`);
  if ((existingWorkspace.bankImports || []).some((item) => item.id === plan.id)) throw new Error("这份导入计划已经执行过");
  if (plan.errorCount > 0) throw new Error(`文件仍有 ${plan.errorCount} 行错误，请修正后重新预检查`);
  if (!validPeriod(plan.period)) throw new Error("导入计划缺少有效账期");
  if ((plan.transactions || []).some((transaction) => transaction.date?.slice(0, 7) !== plan.period)) {
    throw new Error(`导入流水日期与所选账期 ${plan.period} 不一致`);
  }
  if (isPeriodArchived(existingWorkspace, plan.period)) throw new Error(`${plan.period} 已归档，不能继续导入`);
  const existingKeys = new Set((existingWorkspace.transactions || [])
    .map((transaction) => transaction.dedupeKey || transactionDedupeKey(transaction)));
  const incomingKeys = new Set();
  const lateDuplicates = [];
  const importableTransactions = [];
  (plan.transactions || []).forEach((transaction) => {
    const dedupeKey = transaction.dedupeKey || transactionDedupeKey(transaction);
    if (existingKeys.has(dedupeKey) || incomingKeys.has(dedupeKey)) {
      lateDuplicates.push({
        rowNumber: transaction.sourceRow,
        reason: existingKeys.has(dedupeKey) ? "落库前工作台中已存在" : "导入计划内重复",
        dedupeKey,
        transaction,
      });
      return;
    }
    incomingKeys.add(dedupeKey);
    importableTransactions.push({ ...transaction, dedupeKey });
  });
  if (!importableTransactions.length) throw new Error("没有可导入的新流水，全部为重复记录");

  const aliasAnalysis = applyCounterpartyAliasRules(existingWorkspace, importableTransactions, plan.counterpartyMappings, {
    rules: plan.counterpartyAliasRules || [],
    importedAt: plan.importedAt,
  });
  const recognitionAnalysis = recognizeBankImportTransactions(existingWorkspace, aliasAnalysis.transactions, {
    amountTolerance: plan.amountTolerance,
    transferDayWindow: plan.transferDayWindow,
  });
  const anomalyAnalysis = analyzeBankImportAnomalies(existingWorkspace, recognitionAnalysis.transactions, {
    largeTransactionThreshold: plan.largeTransactionThreshold,
  });
  const actor = options.actor || "本地用户";
  const reconciliationAlert = reconciliationIssue(plan.reconciliation, { accountId: plan.accountId, period: plan.period });
  const effectivePlan = {
    ...plan,
    actor,
    importableRowCount: anomalyAnalysis.transactions.length,
    duplicateCount: Number(plan.duplicateCount || 0) + lateDuplicates.length,
    duplicates: [...(plan.duplicates || []), ...lateDuplicates],
    transactions: anomalyAnalysis.transactions,
    anomalies: anomalyAnalysis.anomalies,
    anomalyCount: anomalyAnalysis.anomalies.length,
    anomalousRowCount: new Set(anomalyAnalysis.anomalies.map((anomaly) => anomaly.transactionId)).size,
    anomalyCounts: anomalyAnalysis.counts,
    largeTransactionThreshold: anomalyAnalysis.threshold,
    recognitions: recognitionAnalysis.recognitions,
    recognitionCount: recognitionAnalysis.recognitionCount,
    recognitionCounts: recognitionAnalysis.counts,
    businessEvents: recognitionAnalysis.businessEvents,
    counterpartyAliasRules: aliasAnalysis.rules,
    counterpartyApplications: aliasAnalysis.applications,
    reconciliationIssue: reconciliationAlert,
    reconciliationIssueCount: reconciliationAlert ? 1 : 0,
    canImport: true,
    blockingReasons: [],
    importDisposition: reconciliationAlert ? "imported_with_reconciliation_issue" : "imported",
    status: anomalyAnalysis.anomalies.length || reconciliationAlert ? "completed_with_alerts" : "completed",
  };
  const record = deepClone({ ...effectivePlan, transactions: undefined });
  const exceptionTasks = anomalyAnalysis.anomalies.map((anomaly) => ({
    id: createId("exception"),
    identity: `${anomaly.transactionId}:${anomaly.code}`,
    code: anomaly.code,
    sourceType: "bankTransaction",
    sourceId: anomaly.transactionId,
    message: anomaly.message,
    missingEvidence: [],
    status: "open",
    createdAt: effectivePlan.importedAt,
    updatedAt: effectivePlan.importedAt,
    sourceIds: [
      anomaly.transactionId,
      ...((anomalyAnalysis.transactions.find((transaction) => transaction.id === anomaly.transactionId)?.evidenceIds) || []),
    ],
    history: [{ at: effectivePlan.importedAt, actor, action: "created", note: anomaly.message }],
  }));
  const counterpartUpdates = new Map(recognitionAnalysis.counterpartUpdates.map((transaction) => [transaction.id, transaction]));
  const resolvedCounterpartIds = new Set(counterpartUpdates.keys());
  const newAliasRules = effectivePlan.counterpartyAliasRules || [];
  const aliasUpdates = new Map();
  (existingWorkspace.transactions || []).forEach((transaction) => {
    const rule = newAliasRules.find((candidate) => aliasRuleMatches(candidate, transaction));
    if (!rule) return;
    const base = counterpartUpdates.get(transaction.id) || transaction;
    const mapped = applyAliasRule(base, rule, "manual-alias-backfill");
    const previousAnomalies = base.importAnomalies || [];
    const hadUnknown = previousAnomalies.some((anomaly) => anomaly.code === "bank_unknown_counterparty")
      || (existingWorkspace.exceptionTasks || []).some((task) => task.sourceId === transaction.id && task.code === "bank_unknown_counterparty" && task.status !== "resolved");
    const remainingAnomalies = previousAnomalies.filter((anomaly) => anomaly.code !== "bank_unknown_counterparty");
    if (rule.kind === "related_party" && !remainingAnomalies.some((anomaly) => anomaly.code === "bank_related_party")) {
      remainingAnomalies.push({
        transactionId: transaction.id,
        sourceRow: transaction.sourceRow,
        date: transaction.date,
        counterparty: rule.standardName,
        amount: transaction.amount,
        code: "bank_related_party",
        label: "疑似关联方",
        message: `交易对手「${rule.standardName}」已标记为关联方，需要人工确认`,
      });
    }
    const riskFlags = (base.riskFlags || []).filter((code) => code !== "bank_unknown_counterparty");
    if (rule.kind === "related_party" && !riskFlags.includes("bank_related_party")) riskFlags.push("bank_related_party");
    aliasUpdates.set(transaction.id, {
      ...mapped,
      importAnomalies: remainingAnomalies,
      riskFlags,
      status: remainingAnomalies.length ? "exception" : (hadUnknown && base.status === "exception" ? "pending" : base.status),
      suggestion: rule.kind === "related_party"
        ? `交易对手已标准化为「${rule.standardName}」；关联方待复核`
        : `交易对手已人工确认为「${rule.standardName}」`,
      updatedAt: effectivePlan.importedAt,
    });
  });
  const aliasMappedExistingIds = new Set(aliasUpdates.keys());
  return updateWorkspace(state, workspaceId, (workspace) => {
    workspace = activateWorkspacePeriod(workspace, plan.period);
    const eventsById = new Map((workspace.businessEvents || []).map((event) => [event.id, event]));
    recognitionAnalysis.businessEvents.forEach((event) => eventsById.set(event.id, event));
    const updatedExceptionTasks = (workspace.exceptionTasks || []).map((task) => {
      const resolvedByTransfer = resolvedCounterpartIds.has(task.sourceId) && SUPERSEDED_IMPORT_ANOMALY_CODES.has(task.code);
      const resolvedByAlias = aliasMappedExistingIds.has(task.sourceId) && task.code === "bank_unknown_counterparty";
      if ((!resolvedByTransfer && !resolvedByAlias) || task.status === "resolved") return task;
      return {
        ...task,
        status: "resolved",
        resolution: resolvedByAlias ? "manual_counterparty_mapping" : "deterministic_internal_transfer",
        resolvedAt: effectivePlan.importedAt,
        resolvedBy: actor,
        updatedAt: effectivePlan.importedAt,
        history: [...(task.history || []), {
          at: effectivePlan.importedAt,
          actor,
          action: "resolved",
          note: resolvedByAlias
            ? "交易对手已人工映射为本地标准对象或标准名称"
            : "等额反向流水已在另一银行账户出现，系统已配对为内部转账",
        }],
      };
    });
    const relatedAliasTasks = [...aliasUpdates.values()]
      .filter((transaction) => transaction.counterpartyKind === "related_party")
      .filter((transaction) => !updatedExceptionTasks.some((task) => task.sourceId === transaction.id && task.code === "bank_related_party" && task.status !== "resolved"))
      .map((transaction) => ({
        id: createId("exception"),
        identity: `${transaction.id}:bank_related_party`,
        code: "bank_related_party",
        sourceType: "bankTransaction",
        sourceId: transaction.id,
        message: `交易对手「${transaction.counterparty}」已标记为关联方，需要人工确认`,
        missingEvidence: [],
        status: "open",
        createdAt: effectivePlan.importedAt,
        updatedAt: effectivePlan.importedAt,
        sourceIds: [transaction.id, ...(transaction.evidenceIds || [])],
        history: [{ at: effectivePlan.importedAt, actor, action: "created", note: "人工映射为关联方，保留复核任务" }],
      }));
    const aliasRules = mergeCounterpartyAliasRules(workspace.counterpartyAliasRules, newAliasRules, actor, effectivePlan.importedAt);
    const nextTransactions = [
      ...effectivePlan.transactions,
      ...workspace.transactions.map((transaction) => aliasUpdates.get(transaction.id) || counterpartUpdates.get(transaction.id) || transaction),
    ];
    const nextBankAccounts = workspace.bankAccounts.map((account) => account.id === effectivePlan.accountId ? {
      ...account,
      openingBalance: effectivePlan.reconciliation.openingBalance ?? account.openingBalance,
      statementClosing: effectivePlan.reconciliation.statementClosing ?? account.statementClosing,
      lastImportedAt: effectivePlan.importedAt,
      lastImportedPeriod: effectivePlan.period,
      updatedAt: effectivePlan.importedAt,
    } : account);
    const projectedWorkspace = {
      ...workspace,
      currentPeriod: effectivePlan.period,
      periods: [effectivePlan.period, ...(workspace.periods || []).filter((period) => period !== effectivePlan.period)],
      tax: { ...workspace.tax, period: effectivePlan.period },
      delivery: { ...workspace.delivery, filing: { ...workspace.delivery.filing, period: effectivePlan.period } },
      bankImports: [...workspace.bankImports, record],
      transactions: nextTransactions,
      businessEvents: [...eventsById.values()],
      counterpartyAliasRules: aliasRules,
      bankAccounts: nextBankAccounts,
    };
    const monthly = buildBankMonthlyReconciliation(projectedWorkspace, {
      accountId: effectivePlan.accountId,
      period: effectivePlan.period,
    });
    const monthlyReconciliation = {
      available: monthly.available,
      passed: monthly.passed,
      status: monthly.status,
      message: monthly.message,
      openingBalance: monthly.openingBalance,
      income: monthly.income,
      expense: monthly.expense,
      calculatedClosing: monthly.calculatedClosing,
      statementClosing: monthly.statementClosing,
      difference: monthly.difference,
    };
    const finalRecord = { ...record, monthlyReconciliation };
    const withFinalRecord = {
      ...projectedWorkspace,
      bankImports: [...workspace.bankImports, finalRecord],
    };
    const importTasks = [...updatedExceptionTasks, ...exceptionTasks, ...relatedAliasTasks];
    const reconciledTasks = synchronizeBankReconciliationTask(importTasks, monthly, effectivePlan, actor);
    const { stage } = bankReconciliationStageState(
      { ...withFinalRecord, exceptionTasks: reconciledTasks },
      reconciledTasks,
      effectivePlan.period,
      effectivePlan.importedAt,
    );
    return {
      ...withFinalRecord,
      exceptionTasks: reconciledTasks,
      stages: {
        ...workspace.stages,
        s3: stage,
      },
    };
  }, {
    actor: options.actor,
    action: "导入银行流水",
    detail: `${effectivePlan.fileName}：新增 ${effectivePlan.importableRowCount} 笔，重复 ${effectivePlan.duplicateCount} 笔，识别 ${effectivePlan.recognitionCount} 项，流水异常 ${effectivePlan.anomalyCount} 项，勾稽异常 ${effectivePlan.reconciliationIssueCount} 项，错误 ${effectivePlan.errorCount} 行；${effectivePlan.reconciliation.message}`,
    objectType: "bankImports",
    objectId: effectivePlan.id,
  }, options);
}

export async function readBankFile(file, options = {}) {
  if (!file) throw new Error("请选择银行流水文件");
  const fileName = options.fileName || file.name || "银行流水";
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "csv" || extension === "txt") {
    const text = typeof file.text === "function"
      ? await file.text()
      : new TextDecoder(options.encoding || "utf-8").decode(await file.arrayBuffer());
    const parsed = parseDelimitedText(text, options);
    return { fileName, sheetName: null, table: parsed.table, delimiter: parsed.delimiter, inspection: inspectBankTable(parsed.table) };
  }
  if (extension !== "xlsx" && extension !== "xls") throw new Error("仅支持 CSV、XLSX 和 XLS 银行流水文件");
  const XLSX = await import("xlsx");
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: "array", cellDates: true });
  const sheetName = options.sheetName || workbook.SheetNames[0];
  if (!sheetName || !workbook.Sheets[sheetName]) throw new Error("Excel 文件中没有可读取的工作表");
  const table = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: true });
  return { fileName, sheetName, sheetNames: workbook.SheetNames, table, inspection: inspectBankTable(table) };
}

export async function readPlatformSettlementFile(file, options = {}) {
  const result = await readBankFile(file, options);
  return { ...result, inspection: inspectPlatformSettlementTable(result.table) };
}

export function createBankCsvTemplate() {
  return [
    "交易日期,对方名称,摘要,收入金额,支出金额,流水号,账户余额",
    "2026-08-31,示例客户,课程收入,880.00,,DEMO-001,10880.00",
    "2026-08-31,示例供应商,采购付款,,320.00,DEMO-002,10560.00",
  ].join("\n");
}
