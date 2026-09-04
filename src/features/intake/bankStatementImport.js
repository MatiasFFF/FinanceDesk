import * as XLSX from "xlsx";

import {
  createId,
  deepClone,
  getWorkspace,
  updateWorkspace,
} from "../../domain/foundation.js";

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

const INCOMING_WORDS = new Set(["收入", "收", "贷", "贷方", "入账", "转入", "credit", "in", "income", "+"]);
const OUTGOING_WORDS = new Set(["支出", "付", "借", "借方", "出账", "转出", "debit", "out", "expense", "-"]);

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

function stableHash(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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

function parseExcelDate(serial) {
  if (!Number.isFinite(serial)) return null;
  const parts = XLSX.SSF.parse_date_code(serial);
  if (!parts) return null;
  return `${String(parts.y).padStart(4, "0")}-${String(parts.m).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
}

export function normalizeBankDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === "number") return parseExcelDate(value);
  const text = normalizeText(value);
  if (!text) return null;
  if (/^\d{5}(?:\.\d+)?$/.test(text)) return parseExcelDate(Number(text));
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const match = text.match(/^(\d{4})[\-/.年](\d{1,2})[\-/.月](\d{1,2})日?(?:\s.*)?$/);
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
    const transaction = {
      id: createId("txn"),
      accountId: options.accountId,
      date,
      amount,
      counterparty: normalizeText(valueAt(row, inspection.mapping.counterparty)) || "未识别交易对象",
      counterpartyAccount: normalizeText(valueAt(row, inspection.mapping.counterpartyAccount)),
      summary: normalizeText(valueAt(row, inspection.mapping.summary)) || "银行流水",
      serial: normalizeText(valueAt(row, inspection.mapping.serial)),
      balance: normalizeMoney(valueAt(row, inspection.mapping.balance)),
      channel: normalizeText(valueAt(row, inspection.mapping.channel)),
      currency: normalizeText(valueAt(row, inspection.mapping.currency)) || options.currency || "CNY",
      status: "pending",
      suggestion: "待确认",
      confidence: 0,
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

function reconcileRows(rows, account, options = {}) {
  const openingBalance = normalizeMoney(options.openingBalance ?? account.openingBalance);
  const lastRowBalance = [...rows].reverse().find((transaction) => transaction.balance != null)?.balance;
  const statementClosing = normalizeMoney(options.statementClosing ?? lastRowBalance ?? account.statementClosing);
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

export function prepareBankImport(workspace, input) {
  const account = workspace.bankAccounts.find((candidate) => candidate.id === input.accountId);
  if (!account) throw new Error(`找不到银行账户：${input.accountId}`);
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

  const reconciliation = reconcileRows(statementRows, account, input);
  const period = input.period || statementRows[0]?.date?.slice(0, 7) || workspace.currentPeriod;
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
    importableRowCount: newTransactions.length,
    errorCount: normalized.errors.length,
    duplicateCount: duplicates.length,
    errors: normalized.errors,
    duplicates,
    transactions: newTransactions,
    reconciliation,
    status: normalized.errors.length
      ? "completed_with_errors"
      : reconciliation.available && !reconciliation.passed
        ? "reconciliation_failed"
        : "completed",
  };
}

export function applyBankImport(state, workspaceId, plan, options = {}) {
  if (plan.workspaceId !== workspaceId) throw new Error("导入计划不属于当前工作台");
  const existingWorkspace = getWorkspace(state, workspaceId);
  if (!existingWorkspace) throw new Error(`找不到工作台：${workspaceId}`);
  if (existingWorkspace.bankImports.some((item) => item.id === plan.id)) throw new Error("这份导入计划已经执行过");
  const record = deepClone({ ...plan, transactions: undefined });
  return updateWorkspace(state, workspaceId, (workspace) => ({
    ...workspace,
    bankImports: [...workspace.bankImports, record],
    transactions: [...plan.transactions, ...workspace.transactions],
    bankAccounts: workspace.bankAccounts.map((account) => account.id === plan.accountId ? {
      ...account,
      openingBalance: plan.reconciliation.openingBalance ?? account.openingBalance,
      statementClosing: plan.reconciliation.statementClosing ?? account.statementClosing,
      lastImportedAt: plan.importedAt,
      updatedAt: plan.importedAt,
    } : account),
    stages: {
      ...workspace.stages,
      s3: {
        status: plan.status === "completed" && plan.reconciliation.passed ? "complete" : "needs_review",
        updatedAt: plan.importedAt,
      },
    },
  }), {
    actor: options.actor,
    action: "导入银行流水",
    detail: `${plan.fileName}：新增 ${plan.importableRowCount} 笔，重复 ${plan.duplicateCount} 笔，错误 ${plan.errorCount} 行；${plan.reconciliation.message}`,
    objectType: "bankImports",
    objectId: plan.id,
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
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: "array", cellDates: true });
  const sheetName = options.sheetName || workbook.SheetNames[0];
  if (!sheetName || !workbook.Sheets[sheetName]) throw new Error("Excel 文件中没有可读取的工作表");
  const table = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: true });
  return { fileName, sheetName, sheetNames: workbook.SheetNames, table, inspection: inspectBankTable(table) };
}

export function createBankCsvTemplate() {
  return [
    "交易日期,对方名称,摘要,收入金额,支出金额,流水号,账户余额",
    "2026-08-31,示例客户,课程收入,880.00,,DEMO-001,10880.00",
    "2026-08-31,示例供应商,采购付款,,320.00,DEMO-002,10560.00",
  ].join("\n");
}
