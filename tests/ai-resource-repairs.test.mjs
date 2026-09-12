import assert from "node:assert/strict";
import test from "node:test";
import { createAccountingFixture } from "../src/domain/accounting/fixtures.js";
import { buildAttachmentPackage } from "../src/domain/accounting/vouchers.js";
import { navigationTargetError, rememberAiVoucherFocus, resolveAiResourceNavigation, resolveWorkbenchNavigation, voucherOriginalTarget } from "../src/features/ai-simple/aiWorkflow.js";

test("手动展开凭证后切换完整工作台保留同一凭证，收起旧记录不会清空当前记录", () => {
  const initial = { tab: "vouchers", options: {}, nonce: 4 };
  const first = rememberAiVoucherFocus(initial, "voucher-0006", true);
  const selected = rememberAiVoucherFocus(first, "voucher-0007", true);
  assert.equal(rememberAiVoucherFocus(selected, "voucher-0006", false), selected);
  assert.equal(rememberAiVoucherFocus(selected, "voucher-0007", true), selected);
  const restored = structuredClone({ location: selected }).location;
  assert.deepEqual(resolveWorkbenchNavigation(restored.tab, restored.options), { page: "reconcile", options: { panel: "vouchers", voucherId: "voucher-0007" } });
  assert.equal(restored.nonce, initial.nonce, "记录手动展开不增加外部定位nonce，也不重置凭证筛选");
  assert.equal(rememberAiVoucherFocus(selected, "voucher-0007", false).options.voucherId, "");
  const documents = { ...selected, tab: "documents" };
  assert.equal(rememberAiVoucherFocus(documents, "voucher-0007", false), documents);
  assert.deepEqual(initial.options, {});
});

test("真实凭证附件清单只将可定位原件转为文档入口，并能回到原凭证", () => {
  const workspace = createAccountingFixture();
  const voucher = workspace.vouchers.find((item) => item.id === "voucher-0007");
  const manifest = buildAttachmentPackage(workspace, voucher.id).manifest;
  const before = structuredClone(workspace);
  const targets = manifest.map((entry) => voucherOriginalTarget(workspace, voucher, entry)).filter(Boolean);
  assert.deepEqual(targets.map((target) => target.options.documentId).sort(), ["doc-approval", "doc-invoice", "doc-purchase"]);
  for (const target of targets) {
    assert.equal(target.page, "documents");
    assert.equal(target.options.workspaceId, workspace.id);
    assert.equal(target.options.period, workspace.currentPeriod);
    assert.equal(navigationTargetError(workspace, { options: target.options }), "");
    const back = resolveAiResourceNavigation(target.options.returnTo.page, target.options.returnTo);
    assert.equal(back.tab, "vouchers");
    assert.equal(back.options.voucherId, voucher.id);
  }
  assert.equal(voucherOriginalTarget(workspace, voucher, manifest.find((entry) => entry.id === "txn-payable")), null, "银行流水条目不是原件文件按钮");
  assert.deepEqual(workspace, before, "查看资料不改变凭证、财务数据或原件关系");
});

test("在流水详情查看凭证原件后返回原流水而非凭证总列表", () => {
  const workspace = createAccountingFixture();
  const voucher = workspace.vouchers.find((item) => item.id === "voucher-0007");
  const entry = buildAttachmentPackage(workspace, voucher.id).manifest.find((item) => item.id === "doc-invoice");
  const target = voucherOriginalTarget(workspace, voucher, entry, { transactionId: "txn-payable" });
  assert.equal(target.options.documentId, "doc-invoice");
  const back = resolveAiResourceNavigation(target.options.returnTo.page, target.options.returnTo);
  assert.equal(back.tab, "transactions");
  assert.equal(back.options.transactionId, "txn-payable");
  assert.equal(navigationTargetError(workspace, { options: back.options }), "");
});

test("失效或其他账期的资料不生成误导按钮，已归档的同账期资料仍可只读查看", () => {
  const workspace = createAccountingFixture();
  const voucher = workspace.vouchers.find((item) => item.id === "voucher-0007");
  const entry = buildAttachmentPackage(workspace, voucher.id).manifest.find((item) => item.id === "doc-invoice");
  assert.equal(voucherOriginalTarget(workspace, voucher, { id: "missing", kind: "发票" }), null);
  const historical = structuredClone(workspace);
  historical.documents.find((item) => item.id === entry.id).period = "2026-07";
  assert.equal(voucherOriginalTarget(historical, voucher, entry), null);
  const missingVoucher = { ...workspace, vouchers: [] };
  assert.equal(voucherOriginalTarget(missingVoucher, voucher, entry), null);
  workspace.delivery = { archives: [{ period: workspace.currentPeriod }] };
  const archived = structuredClone(workspace);
  assert.equal(voucherOriginalTarget(workspace, voucher, entry).options.documentId, entry.id);
  assert.deepEqual(workspace, archived);
});
