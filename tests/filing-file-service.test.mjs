import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { createBlankWorkspace, createInitialState } from "../src/domain/foundation.js";
import { activateWorkspacePeriod } from "../src/domain/periods.js";
import { createFinanceDeskStore } from "../src/store/financeDeskStore.js";
import { createLocalFoundationRepository, createMemoryStorage } from "../src/storage/localFoundationRepository.js";
import { createMemoryFileVault } from "../src/features/intake/browserFileVault.js";
import { getLocalDocumentUsage, removeLocalDocument } from "../src/features/intake/documentIntake.js";
import { createFinanceDeskService, importWorkspaceReceipt } from "../src/application/financeDeskService.js";
import { PRODUCT_NAME, attachReceipt, generateLocalFilingPackage, markPackageExported } from "../src/productWorkflow.js";
import { filingWorkspace } from "./helpers/filingFixture.mjs";

function fixture() {
  const target = filingWorkspace();
  const view = createBlankWorkspace({ id: "filing-view", currentPeriod: "2026-10" });
  const repository = createLocalFoundationRepository({ storage: createMemoryStorage() });
  repository.save({ ...createInitialState(), workspaces: [view, activateWorkspacePeriod(target, "2026-10")], activeWorkspaceId: view.id, activeUserId: null });
  const store = createFinanceDeskStore({ repository });
  const fileVault = createMemoryFileVault();
  const file = Object.assign(new Blob(["真实办理回执"], { type: "text/plain" }), { name: "回执.txt" });
  const packet = target.delivery.filing.exportedPackage;
  return { store, fileVault, file, input: { workspaceId: target.id, period: target.currentPeriod, packageId: packet.id, packageHash: packet.hash, reportVersionId: packet.reportVersionId } };
}

test("filing generation works without DOM, includes actual frozen contents and rejects outdated data", async () => {
  const workspace = filingWorkspace();
  assert.equal(typeof globalThis.document, "undefined");
  const generated = await generateLocalFilingPackage(workspace);
  const zip = await JSZip.loadAsync(generated.bytes);
  const folder = `${PRODUCT_NAME}-${workspace.currentPeriod}-本地申报包/`;
  const snapshot = JSON.parse(await zip.file(folder + "报表快照.json").async("string"));
  assert.deepEqual(snapshot, JSON.parse(JSON.stringify(workspace.delivery.reportVersions.at(-1).snapshot)));
  assert.ok(zip.file(folder + "客户确认记录.json"));
  assert.match(generated.metadata.hash, /^[a-f0-9]{64}$/);
  assert.equal(generated.metadata.size, generated.blob.size);
  workspace.openingLedger = { cash: 1, equity: -1 };
  await assert.rejects(generateLocalFilingPackage(workspace));
});

test("receipt operation targets a background workspace and period and lower attach rejects missing original or wrong package", async () => {
  const f = fixture();
  const service = createFinanceDeskService(f);
  const { fileRef } = service.registerReceiptFile(f.file, { workspaceId: f.input.workspaceId });
  const result = await service.importReceipt({ ...f.input, fileRef });
  assert.equal(result.receipt.packageId, f.input.packageId);
  assert.equal(f.store.getState().activeWorkspaceId, "filing-view");
  const latest = f.store.getState().workspaces.find((item) => item.id === f.input.workspaceId);
  assert.equal(latest.currentPeriod, "2026-10");
  const target = activateWorkspacePeriod(latest, f.input.period);
  assert.equal(target.delivery.filing.receipt.hash, result.receipt.hash);
  assert.throws(() => attachReceipt(target, { ...result.receipt, documentId: null }), /有效原件/);
  assert.throws(() => attachReceipt(target, { ...result.receipt, packageId: "another-package" }), /不一致/);
  assert.equal((await f.fileVault.get(result.receipt.documentId)).workspaceId, f.input.workspaceId);
});

test("a newer same-month package rejects the late receipt and removes only its unused new original", async () => {
  for (const referenced of [false, true]) {
    const f = fixture();
    const getOwned = f.fileVault.getOwned.bind(f.fileVault);
    let changed = false;
    f.fileVault.getOwned = async (...args) => {
      const record = await getOwned(...args);
      if (!changed) {
        changed = true;
        const live = f.store.getState().workspaces.find((item) => item.id === f.input.workspaceId);
        let target = activateWorkspacePeriod(live, f.input.period);
        target = markPackageExported(target, { ...target.delivery.filing.exportedPackage, id: "package-new", hash: "new-package-hash" }, "测试会计");
        if (referenced) {
          target.contracts.push({ id: "retained-business", name: "回执关联的服务合同", counterparty: "验收客户", amount: 100,
            date: `${f.input.period}-01`, status: "active" });
          target.evidenceLinks.push({ id: "new-reference", documentIds: [record.id], objectIds: ["retained-business"], status: "active" });
        }
        f.store.actions.replaceWorkspace(live.id, activateWorkspacePeriod(target, live.currentPeriod), { period: f.input.period });
      }
      return record;
    };
    await assert.rejects(importWorkspaceReceipt(f, f.input), (error) => error.code === "RECEIPT_PACKAGE_CHANGED");
    const target = activateWorkspacePeriod(f.store.getState().workspaces.find((item) => item.id === f.input.workspaceId), f.input.period);
    assert.equal(target.delivery.filing.exportedPackage.id, "package-new");
    assert.equal(target.delivery.filing.receipt, null);
    assert.equal(target.documents.filter((item) => item.category === "申报回执").length, referenced ? 1 : 0);
    assert.equal((await f.fileVault.listByWorkspace(target.id)).length, referenced ? 1 : 0);
    if (referenced) {
      const document = target.documents.find((item) => item.category === "申报回执");
      assert.ok(getLocalDocumentUsage(target, document.id).some((usage) => usage.kind === "business-object" && usage.id === "retained-business"));
    }
  }
});

test("receipt import rejects an original deleted while evidence verification is awaiting", async () => {
  const f = fixture();
  const getOwned = f.fileVault.getOwned.bind(f.fileVault);
  let deleted = false;
  let documentId;
  f.fileVault.getOwned = async (...args) => {
    const record = await getOwned(...args);
    if (!deleted) {
      deleted = true;
      documentId = record.id;
      await removeLocalDocument({ store: f.store, fileVault: f.fileVault, workspaceId: f.input.workspaceId, documentId });
    }
    return record;
  };
  await assert.rejects(importWorkspaceReceipt(f, f.input), (error) => error.code === "RECEIPT_ORIGINAL_CHANGED");
  const target = activateWorkspacePeriod(f.store.getState().workspaces.find((item) => item.id === f.input.workspaceId), f.input.period);
  assert.equal(target.delivery.filing.receipt, null);
  assert.equal(target.documents.some((document) => document.id === documentId), false);
  assert.equal(Boolean(await f.fileVault.get(documentId)), false);
});
