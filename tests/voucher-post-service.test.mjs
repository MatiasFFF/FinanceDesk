import assert from "node:assert/strict";
import test from "node:test";
import { createBlankWorkspace, createInitialState } from "../src/domain/foundation.js";
import { activateWorkspacePeriod } from "../src/domain/periods.js";
import { createFinanceDeskStore } from "../src/store/financeDeskStore.js";
import { createLocalFoundationRepository, createMemoryStorage } from "../src/storage/localFoundationRepository.js";
import { createInventoryItem, recordInventoryMovement, createInventoryLossVoucherDraft } from "../src/features/inventory/inventoryLedger.js";
import { reviseDraftVoucher } from "../src/domain/accounting/vouchers.js";
import { postWorkspaceVoucher, createFinanceDeskService } from "../src/application/financeDeskService.js";
import { withVoucherEvidence } from "./helpers/voucherEvidenceFixture.mjs";

async function fixture() {
  let workspace = createBlankWorkspace({ id: "post-target", currentPeriod: "2026-09", modules: { inventory: true } });
  workspace = createInventoryItem(workspace, { name: "材料", unit: "件", openingQuantity: 10, openingUnitCost: 10 });
  for (let index = 1; index <= 2; index += 1) {
    workspace = recordInventoryMovement(workspace, { itemId: workspace.inventoryItems[0].id, type: "loss", date: `2026-09-0${index}`, quantity: 1, reason: "损耗" });
    workspace = createInventoryLossVoucherDraft(workspace, { movementId: workspace.inventoryMovements[index - 1].id });
  }
  const evidence = await withVoucherEvidence(workspace);
  evidence.workspace.documents[0].relatedObjectIds = evidence.workspace.vouchers.map((voucher) => voucher.id);
  const repository = createLocalFoundationRepository({ storage: createMemoryStorage() });
  repository.save({ ...createInitialState(), workspaces: [activateWorkspacePeriod(evidence.workspace, "2026-10")], activeWorkspaceId: workspace.id, activeUserId: null });
  const store = createFinanceDeskStore({ repository });
  return { store, fileVault: evidence.fileVault, input: { workspaceId: workspace.id, period: "2026-09", voucherId: workspace.vouchers[0].id, reviewNote: "已核对损耗与原件" } };
}

test("posting keeps concurrent company, unused account and another voucher changes even with a shared original", async () => {
  const f = await fixture();
  const getOwned = f.fileVault.getOwned.bind(f.fileVault);
  let changed = false;
  f.fileVault.getOwned = async (...args) => {
    const original = await getOwned(...args);
    if (!changed) {
      changed = true;
      const live = f.store.getActiveWorkspace();
      let target = activateWorkspacePeriod(live, "2026-09");
      target = reviseDraftVoucher(target, { voucherId: target.vouchers[1].id, summary: "另一张凭证修改", reason: "补充摘要" });
      target.company.financeContact = "并发联系人";
      target.chartOfAccounts.push({ id: "unused-account", name: "新科目", category: "expense", status: "active" });
      f.store.actions.replaceWorkspace(live.id, activateWorkspacePeriod(target, live.currentPeriod));
    }
    return original;
  };
  const service = createFinanceDeskService(f);
  const result = await service.postVoucher({ ...f.input, edits: { summary: "当前凭证修改后入账", reason: "补充摘要" } });
  assert.equal(result.voucher.status, "posted");
  assert.equal(result.voucher.summary, "当前凭证修改后入账");
  const latest = f.store.getActiveWorkspace();
  assert.equal(latest.currentPeriod, "2026-10");
  assert.equal(latest.company.financeContact, "并发联系人");
  assert.equal(latest.vouchers[1].summary, "另一张凭证修改");
  assert.ok(latest.chartOfAccounts.some((account) => account.id === "unused-account"));
});

test("posting rejects changed voucher, source, original or used account without losing the concurrent edit", async () => {
  for (const scenario of ["voucher", "source", "original", "account"]) {
    const f = await fixture();
    const getOwned = f.fileVault.getOwned.bind(f.fileVault);
    let changed = false;
    f.fileVault.getOwned = async (...args) => {
      const original = await getOwned(...args);
      if (!changed) {
        changed = true;
        const latest = structuredClone(f.store.getActiveWorkspace());
        if (scenario === "voucher") latest.vouchers[0].summary = "并发修改";
        if (scenario === "source") latest.inventoryMovements[0].amount = 20;
        if (scenario === "original") latest.documents[0].version += 1;
        if (scenario === "account") {
          const account = latest.chartOfAccounts.find((item) => item.id === "inventory");
          if (account) account.status = "inactive";
          else latest.chartOfAccounts.push({ id: "inventory", status: "inactive" });
        }
        f.store.actions.replaceWorkspace(latest.id, latest);
      }
      return original;
    };
    await assert.rejects(postWorkspaceVoucher(f, f.input), (error) => error.code === "VOUCHER_SOURCE_CHANGED");
    assert.equal(f.store.getActiveWorkspace().vouchers[0].status, "draft");
  }
});

test("posting uses trusted target identity, rejects actor parameters and stops after identity changes", async () => {
  const f = await fixture();
  const owner = f.store.actions.upsertEntity(f.input.workspaceId, "users", { id: "target-owner", name: "目标负责人", roleId: "role-owner", status: "active" });
  f.store.actions.upsertEntity(f.input.workspaceId, "users", { id: "target-other", name: "另一负责人", roleId: "role-owner", status: "active" });
  const service = createFinanceDeskService(f);
  assert.equal((await service.invoke("postVoucher", { ...f.input, actor: "伪造负责人" })).error.code, "INVALID_OPERATION_INPUT");
  const getOwned = f.fileVault.getOwned.bind(f.fileVault);
  let switched = false;
  f.fileVault.getOwned = async (...args) => {
    const original = await getOwned(...args);
    if (!switched) { switched = true; f.store.actions.switchUser(f.input.workspaceId, "target-other"); }
    return original;
  };
  await assert.rejects(postWorkspaceVoucher(f, f.input), (error) => error.code === "WORKSPACE_IDENTITY_CHANGED");
  assert.equal(f.store.getActiveWorkspace().vouchers[0].status, "draft");
  assert.equal(owner.id, "target-owner");
});
