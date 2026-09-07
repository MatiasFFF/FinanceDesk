// Monthly state is stored separately; business records retain their original IDs.
const copy = (value) => structuredClone(value);
const BANK_PERIOD_FIELDS = ["openingBalance", "statementClosing", "balancePeriod", "lastImportedAt", "lastImportedPeriod"];
const PERIOD_STAGES = ["s2", "s3", "s4"];

export function validAccountingPeriod(period) {
  return /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(String(period || ""));
}

export function localAccountingPeriod(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function adjacentPeriod(period, offset = 1) {
  if (!validAccountingPeriod(period)) throw new Error("请选择有效的年份和月份");
  const [year, month] = period.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function isPeriodArchived(workspace, period = workspace.currentPeriod) {
  return Boolean(workspace.delivery?.archives?.some((item) => item.period === period)
    || (period === workspace.currentPeriod && workspace.delivery?.filing?.archivedAt)
    || workspace.periodStates?.[period]?.filing?.archivedAt);
}

export function capturePeriodState(workspace) {
  return copy({
    openingLedger: workspace.openingLedger || {},
    openingCarryForward: workspace.openingCarryForward || null,
    openingStatus: workspace.openingStatus || { status: "legacy" },
    tax: workspace.tax || {},
    filing: workspace.delivery?.filing || {},
    stages: Object.fromEntries(PERIOD_STAGES.map((key) => [key, workspace.stages?.[key] || { status: "not_started", updatedAt: null }])),
    bankBalances: Object.fromEntries((workspace.bankAccounts || workspace.accounts || []).map((account) => [account.id,
      Object.fromEntries(BANK_PERIOD_FIELDS.map((key) => [key, account[key] ?? null])),
    ])),
  });
}

export function saveActivePeriodState(workspace) {
  return {
    ...workspace,
    periodStates: { ...workspace.periodStates, [workspace.currentPeriod]: capturePeriodState(workspace) },
  };
}

function emptyPeriodState(workspace, period) {
  const tax = workspace.tax || {};
  return {
    openingLedger: {},
    openingCarryForward: null,
    openingStatus: { status: "pending", fromPeriod: adjacentPeriod(period, -1) },
    tax: { period, vatRate: tax.vatRate ?? 0.03, surtaxRate: tax.surtaxRate ?? 0.12, incomeTaxRate: tax.incomeTaxRate ?? 0.05 },
    filing: { period, archivedAt: null },
    stages: { s2: { status: "collecting", updatedAt: null }, s3: { status: "not_started", updatedAt: null }, s4: { status: "not_started", updatedAt: null } },
    bankBalances: {},
  };
}

function archivedPeriodState(workspace, archive) {
  let sources = {};
  let tax = {};
  try {
    const snapshot = JSON.parse(archive.sourceFingerprint || "{}");
    sources = snapshot.sources || {};
    tax = snapshot.tax || {};
  } catch { /* The saved report remains available even without a source snapshot. */ }
  return {
    ...emptyPeriodState(workspace, archive.period),
    openingLedger: copy(sources.openingLedger || {}),
    openingCarryForward: copy(archive.openingCarryForward || null),
    openingStatus: { status: "archived" },
    tax: { ...tax, ...archive.confirmations, period: archive.period, frozenAt: archive.reportSnapshot?.generatedAt || null },
    filing: { ...archive.filing, period: archive.period, archivedAt: archive.archivedAt },
    bankBalances: Object.fromEntries((sources.bankAccounts || sources.accounts || []).map((account) => [account.id,
      Object.fromEntries(BANK_PERIOD_FIELDS.map((key) => [key, account[key] ?? null])),
    ])),
  };
}

export function activateWorkspacePeriod(workspace, period) {
  if (!validAccountingPeriod(period)) throw new Error("请选择有效的年份和月份");
  if (period === workspace.currentPeriod) return workspace;
  const saved = saveActivePeriodState(workspace);
  const archive = workspace.delivery?.archives?.find((item) => item.period === period);
  const target = copy(saved.periodStates[period] || (archive ? archivedPeriodState(workspace, archive) : emptyPeriodState(workspace, period)));
  const bankAccounts = (workspace.bankAccounts || workspace.accounts || []).map((account) => ({
    ...account,
    ...Object.fromEntries(BANK_PERIOD_FIELDS.map((key) => [key, target.bankBalances?.[account.id]?.[key] ?? null])),
    balancePeriod: period,
  }));
  return saveActivePeriodState({
    ...saved,
    currentPeriod: period,
    periods: [...new Set([period, ...(workspace.periods || [])])],
    openingLedger: target.openingLedger,
    openingCarryForward: target.openingCarryForward,
    openingStatus: target.openingStatus,
    tax: { ...target.tax, period },
    delivery: { ...workspace.delivery, filing: { ...target.filing, period, ...(archive ? { archivedAt: archive.archivedAt } : {}) } },
    stages: { ...workspace.stages, ...target.stages },
    bankAccounts,
    accounts: bankAccounts,
  });
}

export function openingBalancesReady(workspace) {
  return workspace.openingStatus?.status !== "pending" && workspace.openingStatus?.status !== "conflict";
}

export function confirmOpeningBalances(workspace, balances, actor = "本地用户") {
  if (isPeriodArchived(workspace)) throw new Error("已归档账期只能查看");
  const ledger = Object.fromEntries(Object.entries(balances).map(([id, amount]) => {
    const value = Number(amount);
    if (!Number.isFinite(value)) throw new Error("期初余额必须是有效数字");
    return [id, Math.round(value * 100) / 100];
  }));
  if (Math.abs(Object.values(ledger).reduce((sum, value) => sum + value, 0)) > 0.005) throw new Error("期初余额借贷不平，请核对后再确认");
  const at = new Date().toISOString();
  return saveActivePeriodState({
    ...workspace,
    openingLedger: ledger,
    openingCarryForward: null,
    openingStatus: { status: "confirmed", source: "manual", confirmedAt: at, confirmedBy: actor,
      acknowledgedArchiveId: workspace.openingStatus?.sourceArchiveId || workspace.openingCarryForward?.archiveId || null },
    auditLog: [...(workspace.auditLog || []), { id: `period-opening-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`, at, actor, action: "确认期初余额", detail: workspace.currentPeriod }],
  });
}

// A period may reference earlier transactions/contracts; follow explicit IDs rather
// than including unrelated records from every month in a frozen report's sources.
export function periodSourceRecords(workspace) {
  const collections = ["transactions", "bankImports", "platformSettlements", "platformSettlementImports", "businessEvents", "bills", "documents", "payrollRecords", "inventoryItems", "inventoryMovements", "evidenceLinks", "vouchers", "exceptionTasks", "counterparties", "contracts", "invoices", "approvals", "personnelRecords"];
  const byId = new Map();
  for (const key of collections) for (const item of workspace[key] || []) if (item.id) byId.set(item.id, item);
  const selected = new Set();
  const queue = [];
  function add(id) {
    if (byId.has(id) && !selected.has(id)) { selected.add(id); queue.push(byId.get(id)); }
  }
  for (const key of collections) for (const item of workspace[key] || []) {
    const period = item.period || item.businessPeriod || String(item.date || item.invoiceDate || item.dueDate || item.settlementDate || "").slice(0, 7);
    if (period === workspace.currentPeriod) add(item.id);
  }
  // Undated master data remains shared. Membership balances and inventory openings
  // are also shared financial inputs and must continue to invalidate dependent reports.
  for (const key of ["counterparties", "contracts", "personnelRecords", "inventoryItems"]) {
    for (const item of workspace[key] || []) add(item.id);
  }
  function visit(value) {
    if (typeof value === "string") add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  }
  let cursor = 0;
  while (cursor < queue.length) visit(queue[cursor++]);
  // Evidence links and exception tasks often point to their subject in one direction.
  for (const key of ["evidenceLinks", "exceptionTasks"]) for (const item of workspace[key] || []) {
    const references = [item.sourceId, item.objectId, item.targetId, ...(item.sourceIds || []), ...(item.relatedObjectIds || [])];
    if (references.some((id) => selected.has(id)) || (!item.period && !references.some((id) => byId.has(id)))) add(item.id);
  }
  while (cursor < queue.length) visit(queue[cursor++]);
  return Object.fromEntries(collections.map((key) => [key, (workspace[key] || []).filter((item) => selected.has(item.id))]));
}
