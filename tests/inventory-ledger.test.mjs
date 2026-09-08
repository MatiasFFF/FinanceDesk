import assert from "node:assert/strict";
import test from "node:test";

import { createBlankWorkspace } from "../src/domain/foundation.js";
import { activateWorkspacePeriod } from "../src/domain/periods.js";
import { AccountingRuleError } from "../src/domain/accounting/model.js";
import { postVoucherWithEvidence } from "../src/domain/accounting/vouchers.js";
import { createDocumentMetadata } from "../src/features/intake/documentIntake.js";
import { createMemoryFileVault } from "../src/features/intake/browserFileVault.js";
import { assessInventoryVoucherIntegrity, assessManualVoucherEvidence } from "../src/features/evidence/evidenceEngine.js";
import { withVoucherEvidence } from "./helpers/voucherEvidenceFixture.mjs";
import {
  INVENTORY_MOVEMENT_TYPES,
  buildInventorySummary,
  createInventoryItem,
  createInventoryLossVoucherDraft,
  recordInventoryMovement,
  updateInventoryItem,
  updateInventoryLossVoucherDraft,
} from "../src/features/inventory/inventoryLedger.js";

const context = { actor: "测试会计", at: "2026-09-01T08:00:00.000Z" };

test("inventory carries each warehouse across months and empty months without changing archived facts", () => {
  let workspace = createInventoryItem(inventoryWorkspace(), { name: "跨月物料", unit: "件", locationId: "location-main", openingQuantity: 10, openingUnitCost: 10 }, context);
  const itemId = workspace.inventoryItems[0].id;
  workspace = recordInventoryMovement(workspace, { itemId, type: "receipt", date: "2026-09-02", quantity: 5, unitCost: 30, locationId: "location-west" }, context);
  workspace = recordInventoryMovement(workspace, { itemId, type: "issue", date: "2026-09-03", quantity: 2, locationId: "location-main" }, context);
  const historical = structuredClone(workspace.inventoryMovements);
  workspace.delivery = { ...workspace.delivery, archives: [{ period: "2026-09" }] };
  workspace = activateWorkspacePeriod(workspace, "2026-10");
  assert.equal(buildInventorySummary(workspace).totals.openingAmount, 230);
  workspace = recordInventoryMovement(workspace, { itemId, type: "loss", date: "2026-10-01", quantity: 2, locationId: "location-west", reason: "破损" }, context);
  assert.equal(workspace.inventoryMovements.at(-1).amount, 60);
  workspace = createInventoryLossVoucherDraft(workspace, { movementId: workspace.inventoryMovements.at(-1).id }, context);
  assert.equal(workspace.vouchers.at(-1).lines[0].debit, 60);
  assert.deepEqual(workspace.inventoryMovements.slice(0, 2), historical);
  workspace = activateWorkspacePeriod(workspace, "2026-12");
  assert.equal(buildInventorySummary(workspace, { locationId: "location-main" }).totals.openingAmount, 80);
  assert.equal(buildInventorySummary(workspace, { locationId: "location-west" }).totals.openingAmount, 90);
  workspace = updateInventoryItem(workspace, itemId, { name: "新名称", specification: "新版规格" }, context);
  assert.equal(workspace.inventoryItems[0].name, "新名称");
  assert.deepEqual(workspace.inventoryMovements.slice(0, 2), historical);
  assert.throws(() => updateInventoryItem(workspace, itemId, { openingQuantity: 20 }, context), (error) => error.code === "INVENTORY_OPENING_LOCKED");
});

test("new items have one initial period and legacy items use dated evidence instead of displayed month", () => {
  let workspace = activateWorkspacePeriod(inventoryWorkspace(), "2026-10");
  workspace = createInventoryItem(workspace, { name: "十月新增", unit: "件", openingQuantity: 4, openingUnitCost: 5 }, context);
  assert.equal(workspace.inventoryItems[0].openingPeriod, "2026-10");
  assert.equal(buildInventorySummary(workspace, { period: "2026-09" }).items.length, 0);
  assert.equal(buildInventorySummary(workspace, { period: "2026-12" }).totals.openingAmount, 20);
  delete workspace.inventoryItems[0].openingPeriod;
  workspace.inventoryItems[0].createdAt = "2026-09-01T00:00:00Z";
  workspace.inventoryMovements = [{ id: "legacy-issue", itemId: workspace.inventoryItems[0].id, date: "2026-09-05", type: "issue", quantity: 1, amount: 5, unitCost: 5, locationId: "unassigned" }];
  assert.equal(buildInventorySummary(workspace, { period: "2026-12" }).totals.openingAmount, 15);
});

test("backdated receipts revalue later open costs atomically and cannot change archived carry forward", async () => {
  let workspace = createInventoryItem(inventoryWorkspace(), { name: "回溯物料", unit: "件", openingQuantity: 10, openingUnitCost: 10 }, context);
  const itemId = workspace.inventoryItems[0].id;
  workspace = activateWorkspacePeriod(workspace, "2026-10");
  workspace = recordInventoryMovement(workspace, { itemId, type: "loss", date: "2026-10-01", quantity: 2, reason: "损耗" }, context);
  workspace = createInventoryLossVoucherDraft(workspace, { movementId: workspace.inventoryMovements[0].id }, context);
  const fixture = await withVoucherEvidence(workspace);
  workspace = await postVoucherWithEvidence(fixture.workspace, { voucherId: workspace.vouchers[0].id, reviewNote: "按初始成本入账" }, { ...context, fileVault: fixture.fileVault });
  const originalVoucher = structuredClone(workspace.vouchers[0]);
  workspace = activateWorkspacePeriod(workspace, "2026-09");
  workspace = recordInventoryMovement(workspace, { itemId, type: "receipt", date: "2026-09-02", quantity: 10, unitCost: 30 }, context);
  assert.equal(workspace.currentPeriod, "2026-09");
  assert.equal(workspace.inventoryMovements[0].amount, 40);
  assert.deepEqual(workspace.vouchers[0], originalVoucher);
  assert.ok(workspace.exceptionTasks.some((task) => task.code === "inventory_posted_cost_changed" && task.period === "2026-10" && task.status === "open"));
  workspace.delivery.archives = [{ period: "2026-10" }];
  const before = structuredClone(workspace);
  assert.throws(() => recordInventoryMovement(workspace, { itemId, type: "receipt", date: "2026-09-03", quantity: 1, unitCost: 60 }, context), (error) => error.code === "INVENTORY_ARCHIVED_CARRY_FORWARD");
  assert.deepEqual(workspace, before);
});

test("archived summary preserves recorded rounding amounts", () => {
  let workspace = createInventoryItem(inventoryWorkspace(), { name: "旧成本舍入", unit: "件", openingQuantity: 3, openingUnitCost: 0.33 }, context);
  const itemId = workspace.inventoryItems[0].id;
  workspace.inventoryItems[0].openingAmount = 1;
  workspace.inventoryMovements = [{ id: "historical-rounded", itemId, date: "2026-09-01", type: "issue", quantity: 3, unitCost: 0.33, amount: 0.99, locationId: "unassigned" }];
  workspace.delivery.archives = [{ period: "2026-09" }];
  assert.equal(buildInventorySummary(workspace).items[0].issues.amount, 0.99);
  assert.equal(buildInventorySummary(workspace).items[0].movements[0].unitCost, 0.33);
  assert.equal(workspace.inventoryMovements[0].amount, 0.99);
});

async function costChangeFixture() {
  let workspace = inventoryWorkspace();
  workspace = createInventoryItem(workspace, { name: "成本变动测试物料", unit: "件", locationId: "location-main", openingQuantity: 10, openingUnitCost: 10 }, context);
  workspace = recordInventoryMovement(workspace, { itemId: workspace.inventoryItems[0].id, type: "loss", date: "2026-09-10", quantity: 2, locationId: "location-main", reason: "报废" }, context);
  workspace = createInventoryLossVoucherDraft(workspace, { movementId: workspace.inventoryMovements[0].id }, context);
  return withVoucherEvidence(workspace);
}

test("opening cost edit blocks old loss draft and updating current cost keeps one draft", async () => {
  let { workspace, fileVault } = await costChangeFixture();
  const voucherId = workspace.vouchers[0].id;
  workspace = updateInventoryItem(workspace, workspace.inventoryItems[0].id, { openingUnitCost: 20 }, context);
  assert.equal(workspace.inventoryMovements[0].amount, 40);
  assert.equal(workspace.vouchers[0].lines[0].debit, 20);
  assert.ok(assessManualVoucherEvidence(workspace, workspace.vouchers[0]).issues.some((issue) => issue.code === "voucher_inventory_amount_changed"));
  await assert.rejects(postVoucherWithEvidence(workspace, { voucherId, reviewNote: "不能用旧金额入账" }, { ...context, fileVault }), (error) => error.code === "VOUCHER_EVIDENCE_REQUIRED");
  workspace = updateInventoryLossVoucherDraft(workspace, { movementId: workspace.inventoryMovements[0].id }, context);
  assert.equal(workspace.vouchers.length, 1);
  assert.equal(workspace.vouchers[0].id, voucherId);
  workspace = await postVoucherWithEvidence(workspace, { voucherId, reviewNote: "已按当前成本40元复核" }, { ...context, fileVault });
  assert.equal(workspace.vouchers[0].lines[0].debit, 40);
  assert.equal(workspace.vouchers[0].status, "posted");
});

test("backdated receipt changes posted loss cost, preserves original and can complete correction", async () => {
  let { workspace, fileVault } = await costChangeFixture();
  workspace = await postVoucherWithEvidence(workspace, { voucherId: workspace.vouchers[0].id, reviewNote: "原成本20元入账" }, { ...context, fileVault });
  const original = structuredClone(workspace.vouchers[0]);
  const movementId = workspace.inventoryMovements[0].id;
  workspace = recordInventoryMovement(workspace, { itemId: workspace.inventoryItems[0].id, type: "receipt", date: "2026-09-02", quantity: 10, unitCost: 30, locationId: "location-main" }, context);
  assert.deepEqual(workspace.vouchers[0], original);
  assert.equal(workspace.inventoryMovements.find((movement) => movement.id === movementId).amount, 40);
  assert.equal(assessInventoryVoucherIntegrity(workspace).passed, false);
  assert.ok(workspace.exceptionTasks.some((task) => task.code === "inventory_posted_cost_changed" && task.status === "open"));
  workspace.exceptionTasks.forEach((task) => { if (task.code === "inventory_posted_cost_changed") task.status = "resolved"; });
  assert.equal(assessInventoryVoucherIntegrity(workspace).passed, false, "closing a task does not repair the posting");
  workspace = updateInventoryLossVoucherDraft(workspace, { movementId }, context);
  const revision = workspace.vouchers.at(-1);
  assert.equal(revision.revisionOf, original.id);
  assert.deepEqual(workspace.vouchers[0], original);
  workspace = await postVoucherWithEvidence(workspace, { voucherId: revision.id, reviewNote: "已复核补录入库后的当前成本40元" }, { ...context, fileVault });
  assert.equal(workspace.vouchers[0].status, "superseded");
  assert.equal(workspace.vouchers[0].lines[0].debit, 20);
  assert.equal(workspace.vouchers.at(-1).lines[0].debit, 40);
  assert.equal(assessInventoryVoucherIntegrity(workspace).passed, true);
  assert.ok(workspace.exceptionTasks.filter((task) => task.code === "inventory_posted_cost_changed").every((task) => task.status === "resolved"));
});

test("zero current loss cost has a usable replacement and archived inventory stays read-only", async () => {
  let { workspace, fileVault } = await costChangeFixture();
  workspace = await postVoucherWithEvidence(workspace, { voucherId: workspace.vouchers[0].id, reviewNote: "原损耗已核对" }, { ...context, fileVault });
  workspace = updateInventoryItem(workspace, workspace.inventoryItems[0].id, { openingUnitCost: 0 }, context);
  workspace = updateInventoryLossVoucherDraft(workspace, { movementId: workspace.inventoryMovements[0].id }, context);
  workspace = await postVoucherWithEvidence(workspace, { voucherId: workspace.vouchers.at(-1).id, reviewNote: "当前损耗成本确认为零，保留原凭证作为历史" }, { ...context, fileVault });
  assert.equal(assessInventoryVoucherIntegrity(workspace).passed, true);
  assert.equal(workspace.vouchers.at(-1).lines[0].debit, 0);
  workspace.delivery = { archives: [{ period: workspace.currentPeriod }] };
  assert.throws(() => updateInventoryItem(workspace, workspace.inventoryItems[0].id, { openingUnitCost: 1 }, context), (error) => error.code === "PERIOD_ARCHIVED");
});

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

test("loss movements create one reviewed manual inventory voucher", async (t) => {
  let workspace = inventoryWorkspace();
  workspace = createInventoryItem(workspace, {
    name: "成品",
    unit: "件",
    locationId: "location-main",
    openingQuantity: 5,
    openingUnitCost: 80,
  }, context);
  const itemId = workspace.inventoryItems[0].id;
  const fileVault = createMemoryFileVault();
  const blob = new Blob(["报废审批：成品 1 件，移动平均成本 80 元，同意报废。"], { type: "text/plain" });
  const document = await createDocumentMetadata(blob, {
    id: "loss-document-1",
    name: "报废审批.txt",
    period: workspace.currentPeriod,
    actor: context.actor,
    createdAt: context.at,
    relatedObjectIds: ["loss-approval-1"],
  });
  await fileVault.put({
    id: document.id,
    workspaceId: workspace.id,
    name: document.name,
    mimeType: document.mimeType,
    size: document.size,
    hash: document.hash,
    blob,
    createdAt: document.createdAt,
  });
  workspace.documents = [document];
  workspace.approvals = [{ id: "loss-approval-1", name: "成品报废审批", status: "approved", evidenceIds: [document.id] }];
  workspace = recordInventoryMovement(workspace, {
    itemId,
    type: INVENTORY_MOVEMENT_TYPES.LOSS,
    date: "2026-09-10",
    quantity: 1,
    locationId: "location-main",
    reason: "报废",
    referenceNo: "报废单 2026-09-001",
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
  assert.ok([movementId, itemId, "loss-approval-1"].every((id) => voucher.sourceIds.includes(id)));
  assert.equal(workspace.inventoryMovements[0].itemId, itemId);
  assert.equal(workspace.inventoryMovements[0].referenceNo, "报废单 2026-09-001");
  assert.equal(voucher.sourceIds.includes("报废单 2026-09-001"), false);
  assert.equal(workspace.inventoryMovements[0].voucherId, voucher.id);
  assert.throws(() => createInventoryLossVoucherDraft(workspace, { movementId }, context), (error) => (
    error instanceof AccountingRuleError && error.code === "INVENTORY_LOSS_VOUCHER_EXISTS"
  ));
  await assert.rejects(() => postVoucherWithEvidence(workspace, { voucherId: voucher.id, mode: "automatic" }, { ...context, fileVault }), (error) => (
    error instanceof AccountingRuleError && error.code === "MANUAL_VOUCHER_MANUAL_POST_REQUIRED"
  ));

  const withAnotherItem = createInventoryItem(workspace, {
    name: "另一物料", unit: "件", openingQuantity: 0, openingUnitCost: 0, locationId: "location-main",
  }, context);
  const otherItemId = withAnotherItem.inventoryItems.at(-1).id;
  for (const scenario of [
    { name: "missing movement", change: (current) => { current.inventoryMovements = []; } },
    { name: "missing item", change: (current) => { current.inventoryItems = current.inventoryItems.filter((item) => item.id !== itemId); } },
    { name: "movement references a different existing item", change: (current) => { current.inventoryMovements[0].itemId = otherItemId; } },
    { name: "unregistered source id", change: (current) => { current.vouchers[0].sourceIds.push("free-form-approval-number"); } },
    { name: "attachment index does not exist", change: (current) => { current.documents = []; } },
  ]) {
    await t.test(scenario.name, async () => {
      const current = structuredClone(withAnotherItem);
      scenario.change(current);
      const before = structuredClone(current);
      await assert.rejects(() => postVoucherWithEvidence(current, {
        voucherId: voucher.id, mode: "manual", reviewNote: "库存来源与附件必须真实有效",
      }, { ...context, fileVault }), (error) => error instanceof AccountingRuleError && error.code === "VOUCHER_EVIDENCE_REQUIRED");
      assert.deepEqual(current, before);
      assert.equal(current.vouchers[0].status, "draft");
    });
  }

  workspace = await postVoucherWithEvidence(workspace, {
    voucherId: voucher.id,
    mode: "manual",
    reviewNote: "已复核损耗依据、数量和移动平均成本",
  }, { ...context, fileVault });
  assert.equal(workspace.vouchers[0].status, "posted");
  assert.deepEqual(workspace.vouchers[0].evidenceVerification.files, [{ documentId: document.id, hash: document.hash, size: document.size }]);
});
