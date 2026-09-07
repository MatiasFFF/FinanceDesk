import {
  AccountingRuleError,
  appendAuditEntry,
  cloneAccountingState,
  collectSourceIds,
  nextRecordId,
  operationContext,
  roundMoney,
  sumMoney,
} from "../../domain/accounting/model.js";
import { assertAccountingPeriodWritable, createManualVoucherDraft, createPostedVoucherRevision, reviseDraftVoucher } from "../../domain/accounting/vouchers.js";
import { inventoryVoucherAmountMatches, syncInventoryVoucherIntegrityTasks, syncManualVoucherEvidenceTasks } from "../evidence/evidenceEngine.js";

export const INVENTORY_MOVEMENT_TYPES = Object.freeze({
  RECEIPT: "receipt",
  ISSUE: "issue",
  LOSS: "loss",
  STOCK_GAIN: "stockGain",
  STOCK_LOSS: "stockLoss",
});

export const INVENTORY_MOVEMENT_TYPE_LABELS = Object.freeze({
  [INVENTORY_MOVEMENT_TYPES.RECEIPT]: "入库",
  [INVENTORY_MOVEMENT_TYPES.ISSUE]: "领用",
  [INVENTORY_MOVEMENT_TYPES.LOSS]: "损耗",
  [INVENTORY_MOVEMENT_TYPES.STOCK_GAIN]: "盘盈",
  [INVENTORY_MOVEMENT_TYPES.STOCK_LOSS]: "盘亏",
});

const INBOUND_TYPES = new Set([
  INVENTORY_MOVEMENT_TYPES.RECEIPT,
  INVENTORY_MOVEMENT_TYPES.STOCK_GAIN,
]);

const OUTBOUND_TYPES = new Set([
  INVENTORY_MOVEMENT_TYPES.ISSUE,
  INVENTORY_MOVEMENT_TYPES.LOSS,
  INVENTORY_MOVEMENT_TYPES.STOCK_LOSS,
]);

function inventoryError(code, message, details = {}) {
  return new AccountingRuleError(code, message, details);
}

function finiteNumber(value, label, { min = Number.NEGATIVE_INFINITY, required = true } = {}) {
  if (!required && (value == null || String(value).trim() === "")) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw inventoryError("INVENTORY_NUMBER_INVALID", `${label}必须是有效数字`);
  if (number < min) throw inventoryError("INVENTORY_NUMBER_INVALID", `${label}不能小于 ${min}`);
  return number;
}

function positiveQuantity(value) {
  const quantity = finiteNumber(value, "库存数量", { min: 0 });
  if (quantity <= 0) throw inventoryError("INVENTORY_QUANTITY_REQUIRED", "库存流水数量必须大于 0");
  return Math.round(quantity * 1_000_000) / 1_000_000;
}

function sumQuantity(values) {
  return Math.round(values.reduce((sum, value) => sum + Number(value || 0), 0) * 1_000_000) / 1_000_000;
}

function validCurrentPeriodDate(workspace, value) {
  const date = String(value || "").trim();
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString().slice(0, 10) !== date) {
    throw inventoryError("INVENTORY_DATE_INVALID", "库存流水必须填写有效日期");
  }
  if (date.slice(0, 7) !== workspace.currentPeriod) {
    throw inventoryError("INVENTORY_PERIOD_MISMATCH", `库存流水日期必须属于当前账期 ${workspace.currentPeriod}`);
  }
  return date;
}

function findInventoryItem(workspace, itemId) {
  const item = (workspace.inventoryItems || []).find((candidate) => candidate.id === itemId);
  if (!item) throw inventoryError("INVENTORY_ITEM_NOT_FOUND", `找不到库存物料：${itemId || "未选择"}`);
  return item;
}

function resolveLocation(workspace, input = {}, item = null) {
  let locationId = String(input.locationId || input.storeId || item?.locationId || item?.storeId || "").trim();
  let locationName = String(input.locationName || input.storeName || item?.locationName || item?.storeName || "").trim();
  let location = (workspace.stores || []).find((store) => store.id === locationId)
    || (workspace.stores || []).find((store) => locationName && store.name === locationName);
  if (!locationId && !locationName && (workspace.stores || []).length === 1) location = workspace.stores[0];
  if (location) {
    locationId = location.id;
    locationName = location.name || locationName || location.id;
  }
  return {
    locationId: locationId || "unassigned",
    locationName: locationName || "未归属场所",
  };
}

function normalizeItemValues(workspace, input = {}, previous = null) {
  const name = String(input.name ?? previous?.name ?? "").trim();
  const unit = String(input.unit ?? previous?.unit ?? "").trim();
  if (!name) throw inventoryError("INVENTORY_ITEM_NAME_REQUIRED", "物料名称必填");
  if (!unit) throw inventoryError("INVENTORY_ITEM_UNIT_REQUIRED", "物料单位必填");
  const openingQuantity = finiteNumber(
    input.openingQuantity ?? input.initialQuantity ?? previous?.openingQuantity ?? 0,
    "期初数量",
    { min: 0 },
  );
  const openingUnitCost = finiteNumber(
    input.openingUnitCost ?? input.openingPrice ?? input.initialUnitCost ?? previous?.openingUnitCost ?? 0,
    "期初单价",
    { min: 0 },
  );
  const location = resolveLocation(workspace, input, previous);
  const status = String(input.status ?? previous?.status ?? "active").trim();
  if (!["active", "inactive"].includes(status)) {
    throw inventoryError("INVENTORY_ITEM_STATUS_INVALID", "物料状态只能是 active 或 inactive");
  }
  return {
    name,
    unit,
    code: String(input.code ?? previous?.code ?? "").trim(),
    category: String(input.category ?? previous?.category ?? "").trim(),
    specification: String(input.specification ?? previous?.specification ?? "").trim(),
    ...location,
    openingQuantity: Math.round(openingQuantity * 1_000_000) / 1_000_000,
    openingUnitCost: roundMoney(openingUnitCost),
    openingAmount: roundMoney(openingQuantity * openingUnitCost),
    status,
    note: String(input.note ?? previous?.note ?? "").trim(),
    sourceIds: input.sourceIds == null ? collectSourceIds(previous?.sourceIds || []) : collectSourceIds(input.sourceIds),
    evidenceIds: input.evidenceIds == null ? collectSourceIds(previous?.evidenceIds || []) : collectSourceIds(input.evidenceIds),
  };
}

function movementOrder(left, right) {
  return String(left.date || "").localeCompare(String(right.date || ""))
    || String(left.createdAt || "").localeCompare(String(right.createdAt || ""))
    || String(left.id || "").localeCompare(String(right.id || ""));
}

function locationKey(locationId) {
  return String(locationId || "unassigned");
}

function revalueItemMovements(workspace, item, movements) {
  const balances = new Map();
  const openingLocation = resolveLocation(workspace, item, item);
  balances.set(locationKey(openingLocation.locationId), {
    quantity: Number(item.openingQuantity || 0),
    amount: Number(item.openingAmount ?? roundMoney(Number(item.openingQuantity || 0) * Number(item.openingUnitCost || 0))),
  });
  const stateFor = (locationId) => {
    const key = locationKey(locationId);
    if (!balances.has(key)) balances.set(key, { quantity: 0, amount: 0 });
    return balances.get(key);
  };
  return [...movements].sort(movementOrder).map((movement) => {
    const location = resolveLocation(workspace, movement, item);
    const state = stateFor(location.locationId);
    const quantity = positiveQuantity(movement.quantity);
    let unitCost;
    let amount;
    if (INBOUND_TYPES.has(movement.type)) {
      const suppliedCost = Object.hasOwn(movement, "inputUnitCost") ? movement.inputUnitCost : movement.unitCost;
      if (movement.type === INVENTORY_MOVEMENT_TYPES.RECEIPT && (suppliedCost == null || String(suppliedCost).trim() === "")) {
        throw inventoryError("INVENTORY_RECEIPT_UNIT_COST_REQUIRED", "入库流水必须填写非负单价");
      }
      unitCost = finiteNumber(suppliedCost, `${INVENTORY_MOVEMENT_TYPE_LABELS[movement.type]}单价`, { min: 0, required: false });
      if (unitCost == null) unitCost = state.quantity > 0 ? state.amount / state.quantity : 0;
      unitCost = roundMoney(unitCost);
      amount = roundMoney(quantity * unitCost);
      state.quantity = Math.round((state.quantity + quantity) * 1_000_000) / 1_000_000;
      state.amount = roundMoney(state.amount + amount);
    } else {
      if (quantity - state.quantity > 0.000001) {
        throw inventoryError(
          "INVENTORY_NEGATIVE_STOCK",
          `${movement.date} ${INVENTORY_MOVEMENT_TYPE_LABELS[movement.type]} ${quantity} ${item.unit} 会使“${item.name}”在${location.locationName}出现负库存；当时可用 ${state.quantity} ${item.unit}`,
          { itemId: item.id, movementId: movement.id, locationId: location.locationId, availableQuantity: state.quantity, requestedQuantity: quantity },
        );
      }
      unitCost = state.quantity > 0 ? roundMoney(state.amount / state.quantity) : 0;
      amount = roundMoney(quantity * unitCost);
      state.quantity = Math.round((state.quantity - quantity) * 1_000_000) / 1_000_000;
      state.amount = state.quantity <= 0.000001 ? 0 : roundMoney(state.amount - amount);
    }
    const direction = INBOUND_TYPES.has(movement.type) ? "in" : "out";
    return {
      ...movement,
      ...location,
      quantity,
      direction,
      unitCost,
      amount,
      signedQuantity: direction === "in" ? quantity : -quantity,
      signedAmount: direction === "in" ? amount : -amount,
      balanceQuantity: state.quantity,
      balanceAmount: state.amount,
      averageUnitCost: state.quantity > 0 ? roundMoney(state.amount / state.quantity) : 0,
      valuationMethod: "moving_weighted_average",
    };
  });
}

function replaceValuedMovements(workspace, item, valuedMovements) {
  const valuedById = new Map(valuedMovements.map((movement) => [movement.id, movement]));
  workspace.inventoryMovements = (workspace.inventoryMovements || []).map((movement) => (
    movement.itemId === item.id && valuedById.has(movement.id) ? valuedById.get(movement.id) : movement
  ));
}

export function createInventoryItem(workspace, input = {}, context = {}) {
  assertAccountingPeriodWritable(workspace);
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const values = normalizeItemValues(next, input);
  const item = {
    id: nextRecordId(next.inventoryItems || [], "inventory-item"),
    ...values,
    createdAt: resolvedContext.at,
    createdBy: resolvedContext.actor,
    updatedAt: resolvedContext.at,
    updatedBy: resolvedContext.actor,
  };
  next.inventoryItems = [...(next.inventoryItems || []), item];
  next.inventoryMovements = [...(next.inventoryMovements || [])];
  appendAuditEntry(next, {
    action: "inventory.item_create",
    entityType: "inventoryItem",
    entityId: item.id,
    detail: `新增物料：${item.name}；期初 ${item.openingQuantity} ${item.unit}，单价 ${item.openingUnitCost.toFixed(2)}`,
    after: item,
    sourceIds: collectSourceIds(item.id, item.sourceIds, item.evidenceIds),
  }, resolvedContext);
  return next;
}

export function updateInventoryItem(workspace, itemId, input = {}, context = {}) {
  assertAccountingPeriodWritable(workspace);
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const index = (next.inventoryItems || []).findIndex((item) => item.id === itemId);
  if (index < 0) throw inventoryError("INVENTORY_ITEM_NOT_FOUND", `找不到库存物料：${itemId || "未选择"}`);
  const before = cloneAccountingState(next.inventoryItems[index]);
  const values = normalizeItemValues(next, input, before);
  const item = {
    ...before,
    ...values,
    updatedAt: resolvedContext.at,
    updatedBy: resolvedContext.actor,
  };
  next.inventoryItems[index] = item;
  const currentPeriodMovements = (next.inventoryMovements || []).filter((movement) => (
    movement.itemId === item.id && String(movement.date || "").slice(0, 7) === next.currentPeriod
  ));
  replaceValuedMovements(next, item, revalueItemMovements(next, item, currentPeriodMovements));
  synchronizeInventoryCostChanges(next, resolvedContext);
  appendAuditEntry(next, {
    action: "inventory.item_update",
    entityType: "inventoryItem",
    entityId: item.id,
    detail: `更新物料：${item.name}`,
    before,
    after: item,
    sourceIds: collectSourceIds(item.id, item.sourceIds, item.evidenceIds),
  }, resolvedContext);
  return next;
}

export function recordInventoryMovement(workspace, input = {}, context = {}) {
  assertAccountingPeriodWritable(workspace);
  const next = cloneAccountingState(workspace);
  const resolvedContext = operationContext(context);
  const item = findInventoryItem(next, input.itemId);
  if (item.status === "inactive") throw inventoryError("INVENTORY_ITEM_INACTIVE", `物料“${item.name}”已停用，不能新增库存流水`);
  const type = String(input.type || "").trim();
  if (!Object.values(INVENTORY_MOVEMENT_TYPES).includes(type)) {
    throw inventoryError("INVENTORY_MOVEMENT_TYPE_INVALID", "库存流水类型必须是入库、领用、损耗、盘盈或盘亏");
  }
  const date = validCurrentPeriodDate(next, input.date);
  const quantity = positiveQuantity(input.quantity);
  const location = resolveLocation(next, input, item);
  const reason = String(input.reason || "").trim();
  if ([INVENTORY_MOVEMENT_TYPES.LOSS, INVENTORY_MOVEMENT_TYPES.STOCK_LOSS].includes(type) && !reason) {
    throw inventoryError("INVENTORY_LOSS_REASON_REQUIRED", `${INVENTORY_MOVEMENT_TYPE_LABELS[type]}必须填写原因`);
  }
  let inputUnitCost = null;
  if (INBOUND_TYPES.has(type)) {
    inputUnitCost = finiteNumber(input.unitCost, `${INVENTORY_MOVEMENT_TYPE_LABELS[type]}单价`, {
      min: 0,
      required: type === INVENTORY_MOVEMENT_TYPES.RECEIPT,
    });
    if (inputUnitCost != null) inputUnitCost = roundMoney(inputUnitCost);
  }
  const movement = {
    id: nextRecordId(next.inventoryMovements || [], "inventory-movement"),
    itemId: item.id,
    itemName: item.name,
    itemUnit: item.unit,
    type,
    typeLabel: INVENTORY_MOVEMENT_TYPE_LABELS[type],
    date,
    period: next.currentPeriod,
    quantity,
    inputUnitCost,
    ...location,
    reason,
    note: String(input.note || "").trim(),
    referenceNo: String(input.referenceNo || "").trim(),
    sourceIds: collectSourceIds(input.sourceIds),
    evidenceIds: collectSourceIds(input.evidenceIds),
    createdAt: resolvedContext.at,
    createdBy: resolvedContext.actor,
    updatedAt: resolvedContext.at,
    updatedBy: resolvedContext.actor,
    voucherId: null,
  };
  next.inventoryItems = [...(next.inventoryItems || [])];
  next.inventoryMovements = [...(next.inventoryMovements || []), movement];
  const currentPeriodMovements = next.inventoryMovements.filter((candidate) => (
    candidate.itemId === item.id && String(candidate.date || "").slice(0, 7) === next.currentPeriod
  ));
  const valuedMovements = revalueItemMovements(next, item, currentPeriodMovements);
  replaceValuedMovements(next, item, valuedMovements);
  synchronizeInventoryCostChanges(next, resolvedContext);
  const saved = next.inventoryMovements.find((candidate) => candidate.id === movement.id);
  appendAuditEntry(next, {
    action: `inventory.movement_${type}`,
    entityType: "inventoryMovement",
    entityId: saved.id,
    detail: `${saved.typeLabel}：${item.name} ${saved.quantity} ${item.unit}；金额 ${saved.amount.toFixed(2)}；${saved.locationName}${reason ? `；${reason}` : ""}`,
    after: saved,
    sourceIds: collectSourceIds(saved.id, item.id, saved.sourceIds, saved.evidenceIds),
  }, resolvedContext);
  return next;
}

function summaryBucket(movements) {
  return {
    quantity: sumQuantity(movements.map((movement) => movement.quantity)),
    amount: sumMoney(movements.map((movement) => movement.amount)),
    movementIds: movements.map((movement) => movement.id),
    sourceIds: collectSourceIds(movements.map((movement) => [movement.id, movement.sourceIds])),
  };
}

export function buildInventorySummary(workspace, {
  period = workspace.currentPeriod,
  locationId = null,
} = {}) {
  const filterLocationId = String(locationId || "").trim();
  const itemRows = (workspace.inventoryItems || []).map((item) => {
    const allPeriodMovements = (workspace.inventoryMovements || []).filter((movement) => (
      movement.itemId === item.id && String(movement.date || "").slice(0, 7) === period
    ));
    const valuedMovements = revalueItemMovements(workspace, item, allPeriodMovements);
    const openingLocation = resolveLocation(workspace, item, item);
    const movements = filterLocationId
      ? valuedMovements.filter((movement) => movement.locationId === filterLocationId)
      : valuedMovements;
    const includeOpening = !filterLocationId || openingLocation.locationId === filterLocationId;
    const opening = {
      quantity: includeOpening ? Number(item.openingQuantity || 0) : 0,
      unitCost: includeOpening ? Number(item.openingUnitCost || 0) : 0,
      amount: includeOpening ? Number(item.openingAmount || 0) : 0,
      locationId: openingLocation.locationId,
      locationName: openingLocation.locationName,
      sourceIds: includeOpening ? collectSourceIds(item.id, item.sourceIds) : [],
    };
    const receipts = summaryBucket(movements.filter((movement) => movement.type === INVENTORY_MOVEMENT_TYPES.RECEIPT));
    const issues = summaryBucket(movements.filter((movement) => movement.type === INVENTORY_MOVEMENT_TYPES.ISSUE));
    const losses = summaryBucket(movements.filter((movement) => movement.type === INVENTORY_MOVEMENT_TYPES.LOSS));
    const gains = summaryBucket(movements.filter((movement) => movement.type === INVENTORY_MOVEMENT_TYPES.STOCK_GAIN));
    const stockLosses = summaryBucket(movements.filter((movement) => movement.type === INVENTORY_MOVEMENT_TYPES.STOCK_LOSS));
    const stockAdjustments = {
      gain: gains,
      loss: stockLosses,
      netQuantity: Math.round((gains.quantity - stockLosses.quantity) * 1_000_000) / 1_000_000,
      netAmount: roundMoney(gains.amount - stockLosses.amount),
      sourceIds: collectSourceIds(gains.sourceIds, stockLosses.sourceIds),
    };
    const closingQuantity = Math.round((opening.quantity + receipts.quantity + gains.quantity - issues.quantity - losses.quantity - stockLosses.quantity) * 1_000_000) / 1_000_000;
    const closingAmount = roundMoney(opening.amount + receipts.amount + gains.amount - issues.amount - losses.amount - stockLosses.amount);
    const sourceIds = collectSourceIds(opening.sourceIds, receipts.sourceIds, issues.sourceIds, losses.sourceIds, stockAdjustments.sourceIds);
    return {
      itemId: item.id,
      name: item.name,
      unit: item.unit,
      code: item.code || "",
      category: item.category || "",
      status: item.status || "active",
      opening,
      receipts,
      issues,
      losses,
      stockAdjustments,
      closing: {
        quantity: closingQuantity,
        amount: closingAmount,
        averageUnitCost: closingQuantity > 0 ? roundMoney(closingAmount / closingQuantity) : 0,
        sourceIds,
      },
      movements,
      sourceIds,
    };
  }).filter((row) => !filterLocationId
    || row.opening.quantity !== 0
    || row.movements.length > 0);
  return {
    period,
    locationId: filterLocationId || null,
    valuationMethod: "moving_weighted_average",
    items: itemRows,
    totals: {
      openingAmount: sumMoney(itemRows.map((row) => row.opening.amount)),
      receiptAmount: sumMoney(itemRows.map((row) => row.receipts.amount)),
      issueAmount: sumMoney(itemRows.map((row) => row.issues.amount)),
      lossAmount: sumMoney(itemRows.map((row) => row.losses.amount)),
      stockGainAmount: sumMoney(itemRows.map((row) => row.stockAdjustments.gain.amount)),
      stockLossAmount: sumMoney(itemRows.map((row) => row.stockAdjustments.loss.amount)),
      closingAmount: sumMoney(itemRows.map((row) => row.closing.amount)),
    },
    sourceIds: collectSourceIds(itemRows.map((row) => row.sourceIds)),
  };
}

export function createInventoryLossVoucherDraft(workspace, {
  movementId,
  debitAccount = "costOfSales",
} = {}, context = {}) {
  const resolvedContext = operationContext({ ...context, mode: "manual" });
  assertAccountingPeriodWritable(workspace);
  const movement = (workspace.inventoryMovements || []).find((candidate) => candidate.id === movementId);
  if (!movement) throw inventoryError("INVENTORY_MOVEMENT_NOT_FOUND", `找不到库存流水：${movementId || "未选择"}`);
  if (![INVENTORY_MOVEMENT_TYPES.LOSS, INVENTORY_MOVEMENT_TYPES.STOCK_LOSS].includes(movement.type)) {
    throw inventoryError("INVENTORY_LOSS_MOVEMENT_REQUIRED", "只有损耗或盘亏流水可以生成损耗凭证");
  }
  const duplicate = (workspace.vouchers || []).find((voucher) => (
    ["draft", "changes_requested", "posted"].includes(voucher.status)
    && (voucher.inventoryMovementId === movement.id || voucher.sourceIds?.includes(movement.id))
  ));
  if (duplicate) {
    throw inventoryError("INVENTORY_LOSS_VOUCHER_EXISTS", `该${INVENTORY_MOVEMENT_TYPE_LABELS[movement.type]}已生成有效凭证 ${duplicate.no || duplicate.id}`);
  }
  const item = findInventoryItem(workspace, movement.itemId);
  const periodMovements = (workspace.inventoryMovements || []).filter((candidate) => (
    candidate.itemId === item.id && String(candidate.date || "").slice(0, 7) === workspace.currentPeriod
  ));
  const valuedMovement = revalueItemMovements(workspace, item, periodMovements).find((candidate) => candidate.id === movement.id);
  if (!valuedMovement || valuedMovement.amount <= 0) {
    throw inventoryError("INVENTORY_LOSS_AMOUNT_INVALID", "损耗或盘亏金额必须大于 0，才能生成凭证");
  }
  const sourceIds = collectSourceIds(movement.id, item.id, movement.sourceIds);
  const next = createManualVoucherDraft(workspace, {
    date: movement.date,
    summary: `${INVENTORY_MOVEMENT_TYPE_LABELS[movement.type]} · ${item.name} · ${movement.quantity} ${item.unit}`,
    note: movement.reason || movement.note || "库存损耗转主营业务成本",
    evidenceIds: movement.evidenceIds || [],
    lines: [
      {
        account: debitAccount || "costOfSales",
        storeId: movement.locationId,
        storeName: movement.locationName,
        debit: valuedMovement.amount,
        credit: 0,
        sourceIds,
      },
      {
        account: "inventory",
        storeId: movement.locationId,
        storeName: movement.locationName,
        debit: 0,
        credit: valuedMovement.amount,
        sourceIds,
      },
    ],
  }, resolvedContext);
  const voucher = (next.vouchers || []).find((candidate) => (
    candidate.sourceType === "manual"
    && candidate.sourceIds?.includes(movement.id)
    && !(workspace.vouchers || []).some((previous) => previous.id === candidate.id)
  ));
  if (!voucher) throw inventoryError("INVENTORY_LOSS_VOUCHER_CREATE_FAILED", "损耗凭证草稿未能写入工作台");
  const savedMovement = next.inventoryMovements.find((candidate) => candidate.id === movement.id);
  savedMovement.voucherId = voucher.id;
  savedMovement.updatedAt = resolvedContext.at;
  savedMovement.updatedBy = resolvedContext.actor;
  voucher.inventoryMovementId = movement.id;
  syncManualVoucherEvidenceTasks(next, voucher, resolvedContext);
  appendAuditEntry(next, {
    action: "inventory.loss_voucher_create",
    entityType: "inventoryMovement",
    entityId: movement.id,
    detail: `${INVENTORY_MOVEMENT_TYPE_LABELS[movement.type]} ${valuedMovement.amount.toFixed(2)} 已生成手工凭证草稿 ${voucher.id}`,
    after: { voucherId: voucher.id, amount: valuedMovement.amount, debitAccount: debitAccount || "costOfSales", creditAccount: "inventory" },
    sourceIds: collectSourceIds(movement.id, item.id, voucher.id, sourceIds, movement.evidenceIds),
  }, resolvedContext);
  return next;
}

function synchronizeInventoryCostChanges(workspace, context) {
  (workspace.vouchers || []).filter((voucher) => voucher.inventoryMovementId && ["draft", "changes_requested"].includes(voucher.status)
    && voucher.period === workspace.currentPeriod).forEach((voucher) => syncManualVoucherEvidenceTasks(workspace, voucher, context));
  syncInventoryVoucherIntegrityTasks(workspace, context);
}

export function updateInventoryLossVoucherDraft(workspace, { movementId }, context = {}) {
  assertAccountingPeriodWritable(workspace);
  const movement = (workspace.inventoryMovements || []).find((item) => item.id === movementId);
  if (!movement || !["loss", "stockLoss"].includes(movement.type) || String(movement.date).slice(0, 7) !== workspace.currentPeriod) {
    throw inventoryError("INVENTORY_MOVEMENT_NOT_FOUND", "请选择当前未归档账期的损耗或盘亏流水");
  }
  const originals = (workspace.vouchers || []).filter((voucher) => voucher.inventoryMovementId === movementId && ["draft", "changes_requested", "posted"].includes(voucher.status));
  let voucher = originals.find((item) => ["draft", "changes_requested"].includes(item.status)) || originals.find((item) => item.status === "posted");
  if (!voucher) return createInventoryLossVoucherDraft(workspace, { movementId }, context);
  if (voucher.status === "posted" && inventoryVoucherAmountMatches(voucher, movement)) throw inventoryError("INVENTORY_LOSS_VOUCHER_EXISTS", "损耗成本与已入账凭证一致，无需更正");
  if (roundMoney(movement.amount) < 0 || !Number.isFinite(Number(movement.amount))) throw inventoryError("INVENTORY_LOSS_AMOUNT_INVALID", "当前损耗成本无效，请核对库存流水");
  if (roundMoney(movement.amount) === 0 && voucher.status !== "posted" && !voucher.revisionOf) {
    const next = cloneAccountingState(workspace);
    const saved = next.vouchers.find((item) => item.id === voucher.id);
    saved.status = "invalidated";
    saved.invalidationReason = "当前损耗成本为零，无需入账";
    next.inventoryMovements.find((item) => item.id === movement.id).voucherId = null;
    (next.exceptionTasks || []).filter((task) => task.sourceId === voucher.id && task.status !== "resolved").forEach((task) => { task.status = "resolved"; task.resolution = "zero_inventory_cost"; });
    appendAuditEntry(next, { action: "inventory.zero_cost_draft_cancel", entityType: "voucher", entityId: voucher.id, detail: saved.invalidationReason, sourceIds: collectSourceIds(voucher.id, movement.id) }, operationContext(context));
    return next;
  }
  let next = workspace;
  const reason = `库存移动平均成本更新，损耗金额按当前流水调整为 ${roundMoney(movement.amount).toFixed(2)} 元`;
  if (voucher.status === "posted") {
    next = createPostedVoucherRevision(next, { voucherId: voucher.id, reason }, context);
    voucher = next.vouchers.at(-1);
  }
  const sourceIds = collectSourceIds(movement.id, movement.itemId, movement.sourceIds);
  const debitLine = (voucher.lines || []).find((line) => Number(line.debit) > 0 && line.account !== "inventory");
  const amount = roundMoney(movement.amount);
  next = reviseDraftVoucher(next, {
    voucherId: voucher.id, reason, evidenceIds: collectSourceIds(voucher.evidenceIds, movement.evidenceIds),
    lines: [
      { ...debitLine, account: debitLine?.account || "costOfSales", debit: amount, credit: 0, sourceIds },
      { account: "inventory", storeId: movement.locationId, storeName: movement.locationName, debit: 0, credit: amount, sourceIds },
    ],
  }, context);
  const savedMovement = next.inventoryMovements.find((item) => item.id === movement.id);
  savedMovement.voucherId = voucher.id;
  synchronizeInventoryCostChanges(next, operationContext(context));
  return next;
}
