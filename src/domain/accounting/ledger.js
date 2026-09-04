import {
  accountDefinition,
  collectSourceIds,
  periodOf,
  roundMoney,
  sumMoney,
} from "./model.js";

const VOID_MARKERS = new Set(["void", "voided", "cancelled", "canceled", "reversed"]);
const AUXILIARY_LABELS = Object.freeze({
  customer: "客户",
  supplier: "供应商",
  employee: "员工",
  counterparty: "往来对象",
});

function unique(values) {
  return [...new Set(values.flat(Infinity).filter((value) => value != null && String(value).trim()))];
}

function normalizedPeriod(voucher) {
  return voucher.period || periodOf(voucher.date);
}

function isCurrentPostedVoucher(voucher) {
  if (voucher?.status !== "posted") return false;
  if (VOID_MARKERS.has(String(voucher.voidStatus || "").toLowerCase())) return false;
  return !voucher.voidedAt
    && !voucher.cancelledAt
    && !voucher.canceledAt
    && !voucher.reversedAt
    && voucher.isVoided !== true
    && voucher.isCurrent !== false;
}

/**
 * Return only the currently effective posted versions. A draft revision does not
 * hide its posted original; a posted revision hides every posted ancestor even
 * if imported data failed to mark the ancestor as superseded.
 */
export function effectivePostedVouchers(workspace = {}) {
  const vouchers = workspace.vouchers || [];
  const voucherById = new Map(vouchers.map((voucher) => [voucher.id, voucher]));
  const posted = vouchers.filter(isCurrentPostedVoucher);
  const revisedAncestorIds = new Set();

  posted.forEach((voucher) => {
    const visited = new Set();
    let ancestorId = voucher.revisionOf;
    while (ancestorId && !visited.has(ancestorId)) {
      visited.add(ancestorId);
      revisedAncestorIds.add(ancestorId);
      ancestorId = voucherById.get(ancestorId)?.revisionOf;
    }
  });

  return posted
    .filter((voucher) => !revisedAncestorIds.has(voucher.id))
    .sort((left, right) => {
      const periodComparison = normalizedPeriod(left).localeCompare(normalizedPeriod(right));
      if (periodComparison) return periodComparison;
      const dateComparison = String(left.date || "").localeCompare(String(right.date || ""));
      if (dateComparison) return dateComparison;
      return String(left.no || left.id || "").localeCompare(String(right.no || right.id || ""), "zh-CN");
    });
}

function valueFrom(entity, names) {
  for (const name of names) {
    const direct = entity?.[name];
    if (direct != null && String(direct).trim()) return direct;
    const dimension = entity?.dimensions?.[name];
    if (dimension != null && String(dimension).trim()) return dimension;
  }
  return null;
}

function recordsLinkedBySources(records, sourceIds) {
  const ids = new Set(sourceIds);
  return (records || []).filter((record) => (
    ids.has(record.id)
    || (record.sourceIds || []).some((sourceId) => ids.has(sourceId))
  ));
}

function linkedRecords(workspace, voucher, line) {
  const directIds = collectSourceIds(
    line.sourceIds || [],
    line.businessEventId,
    voucher.sourceIds || [],
    voucher.relatedSourceIds || [],
    voucher.businessEventId,
    voucher.bankBusinessEventId,
    voucher.memberEventId,
    voucher.transactionId,
    voucher.advanceApplicationId,
  );
  return {
    sourceIds: directIds,
    events: recordsLinkedBySources(workspace.businessEvents, directIds),
    bills: recordsLinkedBySources(workspace.bills, directIds),
    transactions: recordsLinkedBySources(workspace.transactions, directIds),
    applications: recordsLinkedBySources(workspace.advanceApplications, directIds),
  };
}

function dimensionValues(line, voucher, records, names) {
  return unique([
    valueFrom(line, names),
    valueFrom(voucher, names),
    valueFrom(voucher.accountingAttributes, names),
    records.events.map((record) => valueFrom(record, names)),
    records.bills.map((record) => valueFrom(record, names)),
    records.transactions.map((record) => valueFrom(record, names)),
    records.applications.map((record) => valueFrom(record, names)),
  ]).map(String);
}

function inferAuxiliaryType({ account, event, bill, explicitType }) {
  if (AUXILIARY_LABELS[explicitType]) return explicitType;
  const eventText = `${event?.type || ""} ${event?.kind || ""} ${event?.eventType || ""} ${event?.businessType || ""}`.toLowerCase();
  if (eventText.includes("employee") || eventText.includes("payroll") || eventText.includes("commission")) return "employee";
  if (eventText.includes("supplier") || eventText.includes("purchase") || eventText.includes("rent")) return "supplier";
  if (eventText.includes("member") || eventText.includes("customer") || eventText.includes("recharge") || eventText.includes("consumption") || eventText.includes("refund")) return "customer";
  if (["payable", "prepayment"].includes(account) || ["payable", "prepaymentPaid"].includes(bill?.kind)) return "supplier";
  if (["payrollPayable", "socialSecurityPayable", "expensePayroll", "expenseCommission"].includes(account)) return "employee";
  if (["receivable", "contractLiability", "revenuePrivate", "revenueGroup", "salesReturns"].includes(account)
    || ["receivable", "depositReceived"].includes(bill?.kind)) return "customer";
  return "counterparty";
}

function auxiliaryCandidates(line, voucher, records) {
  const explicitId = valueFrom(line, ["auxiliaryId", "counterpartyId"]);
  const explicitLabel = valueFrom(line, ["auxiliaryLabel", "counterparty", "counterpartyName"]);
  const explicitType = valueFrom(line, ["auxiliaryType", "counterpartyType"]);
  if (explicitId || explicitLabel) {
    const id = String(explicitId || explicitLabel);
    return [{
      id,
      label: String(explicitLabel || explicitId),
      type: inferAuxiliaryType({ account: line.account, event: records.events[0], bill: records.bills[0], explicitType }),
    }];
  }

  const candidates = [];
  records.events.forEach((event) => {
    const id = valueFrom(event, ["auxiliaryId", "memberId", "employeeId", "coachId", "counterpartyId", "counterparty", "memberName", "coach"]);
    const label = valueFrom(event, ["auxiliaryLabel", "memberName", "employeeName", "coach", "counterparty", "counterpartyName"]);
    if (id || label) candidates.push({
      id: String(id || label),
      label: String(label || id),
      type: inferAuxiliaryType({ account: line.account, event, bill: records.bills[0], explicitType: event.auxiliaryType }),
    });
  });
  records.bills.forEach((bill) => {
    const id = valueFrom(bill, ["auxiliaryId", "counterpartyId", "counterparty"]);
    const label = valueFrom(bill, ["auxiliaryLabel", "counterparty", "counterpartyName"]);
    if (id || label) candidates.push({
      id: String(id || label),
      label: String(label || id),
      type: inferAuxiliaryType({ account: line.account, event: records.events[0], bill, explicitType: bill.auxiliaryType }),
    });
  });
  records.transactions.forEach((transaction) => {
    const id = valueFrom(transaction, ["auxiliaryId", "counterpartyId", "counterparty"]);
    const label = valueFrom(transaction, ["auxiliaryLabel", "counterparty", "counterpartyName"]);
    if (id || label) candidates.push({
      id: String(id || label),
      label: String(label || id),
      type: inferAuxiliaryType({ account: line.account, event: records.events[0], bill: records.bills[0], explicitType: transaction.auxiliaryType }),
    });
  });

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.type}|${candidate.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareEntries(left, right) {
  const periodComparison = left.period.localeCompare(right.period);
  if (periodComparison) return periodComparison;
  const dateComparison = left.date.localeCompare(right.date);
  if (dateComparison) return dateComparison;
  const voucherComparison = left.voucherNo.localeCompare(right.voucherNo, "zh-CN");
  if (voucherComparison) return voucherComparison;
  return left.lineIndex - right.lineIndex;
}

export function postedLedgerEntries(workspace = {}) {
  return effectivePostedVouchers(workspace).flatMap((voucher) => (
    (voucher.lines || []).map((line, lineIndex) => {
      const records = linkedRecords(workspace, voucher, line);
      const account = line.account || "unknown";
      const definition = accountDefinition(account, workspace);
      const auxiliaries = auxiliaryCandidates(line, voucher, records);
      const storeIds = dimensionValues(line, voucher, records, ["storeId"]);
      const storeNames = dimensionValues(line, voucher, records, ["storeName", "store"]);
      const departments = dimensionValues(line, voucher, records, ["department", "departmentName"]);
      const projects = dimensionValues(line, voucher, records, ["project", "projectName"]);
      const originalSourceIds = collectSourceIds(
        line.sourceIds || [],
        line.businessEventId,
        voucher.sourceIds || [],
        voucher.relatedSourceIds || [],
        voucher.bankBusinessEventId,
        voucher.memberEventId,
        voucher.transactionId,
        voucher.advanceApplicationId,
      );
      return {
        id: `${voucher.id}:${lineIndex}`,
        date: String(voucher.date || ""),
        period: normalizedPeriod(voucher),
        voucherId: voucher.id,
        voucherNo: voucher.no || voucher.id,
        voucherSummary: voucher.summary || "",
        voucherVersion: Number(voucher.version || 1),
        revisionOf: voucher.revisionOf || null,
        lineIndex,
        account,
        accountLabel: definition.label,
        normalSide: definition.normalSide || "debit",
        debit: roundMoney(line.debit),
        credit: roundMoney(line.credit),
        auxiliaries,
        auxiliaryIds: unique(auxiliaries.map((item) => item.id)),
        auxiliaryLabels: unique(auxiliaries.map((item) => item.label)),
        auxiliaryTypes: unique(auxiliaries.map((item) => item.type)),
        storeIds,
        storeNames: storeNames.length ? storeNames : storeIds,
        departments,
        projects,
        originalSourceIds,
        sourceIds: originalSourceIds,
        evidenceIds: collectSourceIds(voucher.evidenceIds || []),
      };
    })
  )).sort(compareEntries);
}

export function normalizeLedgerFilters(filters = {}) {
  const exactPeriod = String(filters.period || "").trim();
  return {
    periodFrom: String(filters.periodFrom || exactPeriod || "").trim(),
    periodTo: String(filters.periodTo || exactPeriod || "").trim(),
    account: String(filters.account || "").trim(),
    auxiliaryType: String(filters.auxiliaryType || "").trim(),
    auxiliaryId: String(filters.auxiliaryId || "").trim(),
    storeId: String(filters.storeId || "").trim(),
    department: String(filters.department || "").trim(),
    project: String(filters.project || "").trim(),
  };
}

function matchesNonPeriodFilters(entry, filters) {
  if (filters.account && entry.account !== filters.account) return false;
  if (filters.auxiliaryType && !entry.auxiliaryTypes.includes(filters.auxiliaryType)) return false;
  if (filters.auxiliaryId && !entry.auxiliaryIds.includes(filters.auxiliaryId)) return false;
  if (filters.storeId && !entry.storeIds.includes(filters.storeId) && !entry.storeNames.includes(filters.storeId)) return false;
  if (filters.department && !entry.departments.includes(filters.department)) return false;
  if (filters.project && !entry.projects.includes(filters.project)) return false;
  return true;
}

function matchesPeriod(entry, filters) {
  if (filters.periodFrom && entry.period < filters.periodFrom) return false;
  if (filters.periodTo && entry.period > filters.periodTo) return false;
  return true;
}

function balanceDetails(signedBalance) {
  const signed = roundMoney(signedBalance);
  return {
    signed,
    balance: Math.abs(signed),
    direction: signed > 0 ? "借" : signed < 0 ? "贷" : "平",
  };
}

function filtersUseAllocatedDimensions(filters) {
  return Boolean(filters.auxiliaryType || filters.auxiliaryId || filters.storeId || filters.department || filters.project);
}

function openingByAccount(workspace, entries, filters) {
  const opening = new Map();
  const sourceIds = new Map();
  const includeStaticOpening = !filtersUseAllocatedDimensions(filters);

  if (includeStaticOpening) {
    Object.entries(workspace.openingLedger || {}).forEach(([account, amount]) => {
      if (filters.account && filters.account !== account) return;
      opening.set(account, roundMoney(amount));
      sourceIds.set(account, [account]);
    });
  }

  if (filters.periodFrom) {
    entries
      .filter((entry) => entry.period < filters.periodFrom && matchesNonPeriodFilters(entry, filters))
      .forEach((entry) => {
        opening.set(entry.account, roundMoney((opening.get(entry.account) || 0) + entry.debit - entry.credit));
        sourceIds.set(entry.account, collectSourceIds(sourceIds.get(entry.account) || [], entry.originalSourceIds));
      });
  }
  return { balances: opening, sourceIds, includeStaticOpening };
}

export function buildJournalLedger(workspace = {}, rawFilters = {}) {
  const filters = normalizeLedgerFilters(rawFilters);
  const rows = postedLedgerEntries(workspace)
    .filter((entry) => matchesNonPeriodFilters(entry, filters) && matchesPeriod(entry, filters));
  return {
    kind: "journal",
    filters,
    rows,
    totals: {
      debit: sumMoney(rows.map((row) => row.debit)),
      credit: sumMoney(rows.map((row) => row.credit)),
    },
    sourceVoucherIds: unique(rows.map((row) => row.voucherId)),
    sourceIds: unique(rows.map((row) => row.originalSourceIds)),
  };
}

export function buildGeneralLedger(workspace = {}, rawFilters = {}) {
  const filters = normalizeLedgerFilters(rawFilters);
  const entries = postedLedgerEntries(workspace);
  const periodRows = entries.filter((entry) => matchesNonPeriodFilters(entry, filters) && matchesPeriod(entry, filters));
  const opening = openingByAccount(workspace, entries, filters);
  const accountIds = unique([
    [...opening.balances.keys()],
    periodRows.map((row) => row.account),
  ]);
  const rows = accountIds.map((account) => {
    const accountRows = periodRows.filter((row) => row.account === account);
    const openingDetails = balanceDetails(opening.balances.get(account) || 0);
    const debit = sumMoney(accountRows.map((row) => row.debit));
    const credit = sumMoney(accountRows.map((row) => row.credit));
    const closingDetails = balanceDetails(openingDetails.signed + debit - credit);
    const definition = accountDefinition(account, workspace);
    return {
      account,
      accountLabel: definition.label,
      normalSide: definition.normalSide || "debit",
      openingBalance: openingDetails.balance,
      openingDirection: openingDetails.direction,
      openingSignedBalance: openingDetails.signed,
      debit,
      credit,
      closingBalance: closingDetails.balance,
      closingDirection: closingDetails.direction,
      closingSignedBalance: closingDetails.signed,
      voucherIds: unique(accountRows.map((row) => row.voucherId)),
      originalSourceIds: collectSourceIds(opening.sourceIds.get(account) || [], accountRows.map((row) => row.originalSourceIds)),
    };
  }).sort((left, right) => left.accountLabel.localeCompare(right.accountLabel, "zh-CN"));

  return {
    kind: "general",
    filters,
    rows,
    sourceVoucherIds: unique(rows.map((row) => row.voucherIds)),
    sourceIds: unique(rows.map((row) => row.originalSourceIds)),
    openingBasis: opening.includeStaticOpening ? "workspace-opening-ledger" : "filtered-posted-movements",
  };
}

export function buildDetailLedger(workspace = {}, rawFilters = {}) {
  const filters = normalizeLedgerFilters(rawFilters);
  const entries = postedLedgerEntries(workspace);
  const opening = openingByAccount(workspace, entries, filters);
  const runningBalances = new Map(opening.balances);
  const rows = entries
    .filter((entry) => matchesNonPeriodFilters(entry, filters) && matchesPeriod(entry, filters))
    .map((entry) => {
      const running = roundMoney((runningBalances.get(entry.account) || 0) + entry.debit - entry.credit);
      runningBalances.set(entry.account, running);
      const details = balanceDetails(running);
      return {
        ...entry,
        runningBalance: details.balance,
        runningDirection: details.direction,
        runningSignedBalance: details.signed,
      };
    });
  const accounts = unique([
    [...opening.balances.keys()],
    rows.map((row) => row.account),
  ]).map((account) => {
    const details = balanceDetails(opening.balances.get(account) || 0);
    return {
      account,
      accountLabel: accountDefinition(account, workspace).label,
      openingBalance: details.balance,
      openingDirection: details.direction,
      openingSignedBalance: details.signed,
      originalSourceIds: opening.sourceIds.get(account) || [],
    };
  });
  return {
    kind: "detail",
    filters,
    rows,
    accounts,
    sourceVoucherIds: unique(rows.map((row) => row.voucherId)),
    sourceIds: unique(rows.map((row) => row.originalSourceIds)),
    openingBasis: opening.includeStaticOpening ? "workspace-opening-ledger" : "filtered-posted-movements",
  };
}

export function buildAccountingLedgers(workspace = {}, filters = {}) {
  return {
    journal: buildJournalLedger(workspace, filters),
    general: buildGeneralLedger(workspace, filters),
    detail: buildDetailLedger(workspace, filters),
  };
}

export function buildLedgerFilterOptions(workspace = {}) {
  const entries = postedLedgerEntries(workspace);
  const accounts = new Map();
  const auxiliaries = new Map();
  const stores = new Map();

  entries.forEach((entry) => {
    accounts.set(entry.account, { id: entry.account, label: entry.accountLabel });
    entry.auxiliaries.forEach((item) => auxiliaries.set(`${item.type}|${item.id}`, {
      id: item.id,
      label: item.label,
      type: item.type,
      typeLabel: AUXILIARY_LABELS[item.type] || item.type,
    }));
    entry.storeIds.forEach((id, index) => stores.set(id, { id, label: entry.storeNames[index] || id }));
    if (!entry.storeIds.length) entry.storeNames.forEach((name) => stores.set(name, { id: name, label: name }));
  });

  return {
    periods: unique(entries.map((entry) => entry.period)).sort(),
    accounts: [...accounts.values()].sort((left, right) => left.label.localeCompare(right.label, "zh-CN")),
    auxiliaryTypes: unique(entries.map((entry) => entry.auxiliaryTypes)).map((id) => ({ id, label: AUXILIARY_LABELS[id] || id })),
    auxiliaries: [...auxiliaries.values()].sort((left, right) => left.label.localeCompare(right.label, "zh-CN")),
    stores: [...stores.values()].sort((left, right) => left.label.localeCompare(right.label, "zh-CN")),
    departments: unique(entries.map((entry) => entry.departments)).sort((left, right) => left.localeCompare(right, "zh-CN")),
    projects: unique(entries.map((entry) => entry.projects)).sort((left, right) => left.localeCompare(right, "zh-CN")),
  };
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(" | ") : String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function csvDocument(headers, rows) {
  return `\ufeff${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

export function ledgerToCsv(kind, ledger) {
  if (kind === "general") {
    return csvDocument(
      ["期间起", "期间止", "科目编码", "科目名称", "期初方向", "期初余额", "借方发生", "贷方发生", "期末方向", "期末余额", "有效凭证IDs", "原始sourceIds"],
      ledger.rows.map((row) => [
        ledger.filters.periodFrom,
        ledger.filters.periodTo,
        row.account,
        row.accountLabel,
        row.openingDirection,
        row.openingBalance,
        row.debit,
        row.credit,
        row.closingDirection,
        row.closingBalance,
        row.voucherIds,
        row.originalSourceIds,
      ]),
    );
  }
  if (kind === "detail") {
    return csvDocument(
      ["日期", "期间", "凭证号", "凭证ID", "摘要", "科目编码", "科目名称", "借方", "贷方", "余额方向", "运行余额", "客户/供应商/员工", "辅助类型", "门店", "部门", "项目", "原始sourceIds", "凭证版本"],
      ledger.rows.map((row) => [
        row.date,
        row.period,
        row.voucherNo,
        row.voucherId,
        row.voucherSummary,
        row.account,
        row.accountLabel,
        row.debit,
        row.credit,
        row.runningDirection,
        row.runningBalance,
        row.auxiliaryLabels,
        row.auxiliaryTypes.map((type) => AUXILIARY_LABELS[type] || type),
        row.storeNames,
        row.departments,
        row.projects,
        row.originalSourceIds,
        row.voucherVersion,
      ]),
    );
  }
  return csvDocument(
    ["日期", "期间", "凭证号", "凭证ID", "摘要", "科目编码", "科目名称", "客户/供应商/员工", "辅助类型", "门店", "部门", "项目", "借方", "贷方", "原始sourceIds", "证据IDs", "凭证版本"],
    ledger.rows.map((row) => [
      row.date,
      row.period,
      row.voucherNo,
      row.voucherId,
      row.voucherSummary,
      row.account,
      row.accountLabel,
      row.auxiliaryLabels,
      row.auxiliaryTypes.map((type) => AUXILIARY_LABELS[type] || type),
      row.storeNames,
      row.departments,
      row.projects,
      row.debit,
      row.credit,
      row.originalSourceIds,
      row.evidenceIds,
      row.voucherVersion,
    ]),
  );
}
