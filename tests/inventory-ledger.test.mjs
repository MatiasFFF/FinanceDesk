import assert from "node:assert/strict";
import test from "node:test";

import { createBlankWorkspace } from "../src/domain/foundation.js";
import { AccountingRuleError } from "../src/domain/accounting/model.js";
import { postVoucher } from "../src/domain/accounting/vouchers.js";
import {
  INVENTORY_MOVEMENT_TYPES,
  buildInventorySummary,
  createInventoryItem,
  createInventoryLossVoucherDraft,
  recordInventoryMovement,
  updateInventoryItem,
} from "../src/features/inventory/inventoryLedger.js";

const context = { actor: "测试会计", at: "2026-09-01T08:00:00.000Z" };

function inventoryWorkspace() {
  const workspace = createBlankWorkspace({
    id: "workspace-inventory",
    name: "零售财务工作台",
    currentPeriod: "2026-09",
    modules: { inventory: true },
  }, { timestamp: context.at });
  workspace.stores = [
    { id: "location-main", name: "主仓", status: "active" },
    { id: "location-west", name: "西区仓", status: "active" },
  ];
  return workspace;
}

test("inventory uses moving weighted average and keeps traceable period totals", () => {
  let workspace = inventoryWorkspace();
  workspace = createInventoryItem(workspace, {
    name: "包装材料",
    code: "PKG-001",
    unit: "件",
    locationId: "location-main",
    openingQuantity: 10,
    openingUnitCost: 10,
    sourceIds: ["opening-sheet"],
  }, context);
  const item = workspace.inventoryItems[0];

  workspace = recordInventoryMovement(workspace, {
    itemId: item.id,
    type: INVENTORY_MOVEMENT_TYPES.RECEIPT,
    date: "2026-09-02",
    quantity: 10,
    unitCost: 20,
    locationId: "location-main",
    sourceIds: ["purchase-order-1"],
  }, { ...context, at: "2026-09-02T08:00:00.000Z" });
  workspace = recordInventoryMovement(workspace, {
    itemId: item.id,
    type: INVENTORY_MOVEMENT_TYPES.ISSUE,
    date: "2026-09-03",
    quantity: 4,
    locationId: "location-main",
    reason: "生产领用",
    sourceIds: ["issue-order-1"],
  }, { ...context, at: "2026-09-03T08:00:00.000Z" });
  workspace = recordInventoryMovement(workspace, {
    itemId: item.id,
    type: INVENTORY_MOVEMENT_TYPES.LOSS,
    date: "2026-09-04",
    quantity: 2,
    locationId: "location-main",
    reason: "运输破损",
    sourceIds: ["loss-form-1"],
    evidenceIds: ["damage-photo-1"],
  }, { ...context, at: "2026-09-04T08:00:00.000Z" });
  workspace = recordInventoryMovement(workspace, {
    itemId: item.id,
    type: INVENTORY_MOVEMENT_TYPES.STOCK_GAIN,
    date: "2026-09-05",
    quantity: 1,
    locationId: "location-main",
    reason: "盘点修正",
    sourceIds: ["stocktake-1"],
  }, { ...context, at: "2026-09-05T08:00:00.000Z" });
  workspace = recordInventoryMovement(workspace, {
    itemId: item.id,
    type: INVENTORY_MOVEMENT_TYPES.STOCK_LOSS,
    date: "2026-09-06",
    quantity: 1,
    locationId: "location-main",
    reason: "盘点短缺",
    sourceIds: ["stocktake-1"],
  }, { ...context, at: "2026-09-06T08:00:00.000Z" });

  const summary = buildInventorySummary(workspace, { period: "2026-09" });
  const row = summary.items[0];
  assert.deepEqual(
    {
      receipt: row.receipts.amount,
      issue: row.issues.amount,
      loss: row.losses.amount,
      stockGain: row.stockAdjustments.gain.amount,
      stockLoss: row.stockAdjustments.loss.amount,
      closingQuantity: row.closing.quantity,
      closingAmount: row.closing.amount,
      averageUnitCost: row.closing.averageUnitCost,
    },
    {
      receipt: 200,
      issue: 60,
      loss: 30,
      stockGain: 15,
      stockLoss: 15,
      closingQuantity: 14,
      closingAmount: 210,
      averageUnitCost: 15,
    },
  );
  assert.ok(["opening-sheet", "purchase-order-1", "issue-order-1", "loss-form-1", "stocktake-1"]
    .every((sourceId) => summary.sourceIds.includes(sourceId)));
  assert.ok(workspace.auditLog.some((entry) => entry.action === "inventory.item_create"));
  assert.equal(workspace.auditLog.filter((entry) => entry.action.startsWith("inventory.movement_")).length, 5);

  const filtered = buildInventorySummary(workspace, { period: "2026-09", locationId: "location-west" });
  assert.equal(filtered.items.length, 0);
  assert.equal(filtered.totals.closingAmount, 0);
});

test("inventory blocks historical negative stock and revalues after an item opening edit", () => {
  let workspace = inventoryWorkspace();
  workspace = createInventoryItem(workspace, {
    name: "耗材",
    unit: "箱",
    locationId: "location-main",
    openingQuantity: 3,
    openingUnitCost: 50,
  }, context);
  const itemId = workspace.inventoryItems[0].id;

  assert.throws(() => recordInventoryMovement(workspace, {
    itemId,
    type: INVENTORY_MOVEMENT_TYPES.ISSUE,
    date: "2026-09-02",
    quantity: 4,
    locationId: "location-main",
  }, context), (error) => error instanceof AccountingRuleError && error.code === "INVENTORY_NEGATIVE_STOCK");
  assert.throws(() => recordInventoryMovement(workspace, {
    itemId,
    type: INVENTORY_MOVEMENT_TYPES.RECEIPT,
    date: "2026-08-31",
    quantity: 1,
    unitCost: 50,
  }, context), (error) => error instanceof AccountingRuleError && error.code === "INVENTORY_PERIOD_MISMATCH");

  workspace = recordInventoryMovement(workspace, {
    itemId,
    type: INVENTORY_MOVEMENT_TYPES.ISSUE,
    date: "2026-09-02",
    quantity: 2,
    locationId: "location-main",
  }, context);
  workspace = updateInventoryItem(workspace, itemId, {
    name: "生产耗材",
    openingQuantity: 4,
    openingUnitCost: 60,
  }, { ...context, at: "2026-09-02T09:00:00.000Z" });

  const summary = buildInventorySummary(workspace);
  assert.equal(summary.items[0].name, "生产耗材");
  assert.equal(summary.items[0].closing.quantity, 2);
  assert.equal(summary.items[0].closing.amount, 120);
  assert.equal(summary.items[0].movements[0].unitCost, 60);
});

test("loss movements create one reviewed manual inventory voucher", () => {
  let workspace = inventoryWorkspace();
  workspace = createInventoryItem(workspace, {
    name: "成品",
    unit: "件",
    locationId: "location-main",
    openingQuantity: 5,
    openingUnitCost: 80,
  }, context);
  const itemId = workspace.inventoryItems[0].id;
  workspace = recordInventoryMovement(workspace, {
    itemId,
    type: INVENTORY_MOVEMENT_TYPES.LOSS,
    date: "2026-09-10",
    quantity: 1,
    locationId: "location-main",
    reason: "报废",
    sourceIds: ["loss-approval-1"],
    evidenceIds: ["loss-document-1"],
  }, context);
  const movementId = workspace.inventoryMovements[0].id;

  workspace = createInventoryLossVoucherDraft(workspace, { movementId }, context);
  const voucher = workspace.vouchers[0];
  assert.equal(voucher.sourceType, "manual");
  assert.equal(voucher.inventoryMovementId, movementId);
  assert.deepEqual(voucher.lines.map((line) => [line.account, line.debit, line.credit]), [
    ["costOfSales", 80, 0],
    ["inventory", 0, 80],
  ]);
  assert.deepEqual(voucher.evidenceIds, ["loss-document-1"]);
  assert.equal(workspace.inventoryMovements[0].voucherId, voucher.id);
  assert.throws(() => createInventoryLossVoucherDraft(workspace, { movementId }, context), (error) => (
    error instanceof AccountingRuleError && error.code === "INVENTORY_LOSS_VOUCHER_EXISTS"
  ));
  assert.throws(() => postVoucher(workspace, { voucherId: voucher.id, mode: "automatic" }, context), (error) => (
    error instanceof AccountingRuleError && error.code === "MANUAL_VOUCHER_MANUAL_POST_REQUIRED"
  ));

  workspace = postVoucher(workspace, {
    voucherId: voucher.id,
    mode: "manual",
    reviewNote: "已复核损耗依据、数量和移动平均成本",
  }, context);
  assert.equal(workspace.vouchers[0].status, "posted");
});
