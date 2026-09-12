import test from "node:test";
import assert from "node:assert/strict";
import { navigationTargetError, proposalDestinations, rememberAiDocumentFocus, resolveAiResourceNavigation, resolveWorkbenchNavigation } from "../src/features/ai-simple/aiWorkflow.js";

const workspace = {
  id: "company-a", currentPeriod: "2026-09",
  transactions: [
    { id: "tx-a", date: "2026-09-03", importId: "batch-a" },
    { id: "tx-b", date: "2026-09-04", importId: "batch-b" },
    { id: "tx-old", date: "2026-08-20", period: "2026-09" },
  ],
  documents: [
    { id: "invoice", period: "2026-09", name: "已核对发票.pdf" },
    { id: "bank-file", period: "2026-09" },
    { id: "unimported", period: "2026-09" },
    { id: "old-file", period: "2026-08" },
  ],
  vouchers: [{ id: "voucher-a", period: "2026-09", status: "posted" }, { id: "voucher-old", period: "2026-08" }],
  bankImports: [
    { id: "batch-a", period: "2026-09", sourceDocumentId: "bank-file" },
    { id: "batch-b", period: "2026-09", sourceDocumentId: "another-file" },
    { id: "old-batch", period: "2026-08", sourceDocumentId: "bank-file" },
  ],
  delivery: { archives: [], reportVersions: [{ id: "report-a", period: "2026-09" }, { id: "report-old", period: "2026-08" }] },
};

test("补齐凭证资料后返回指定凭证，保留文档编辑动作和返回路径", () => {
  const returnTo = { page: "reconcile", panel: "vouchers", voucherId: "voucher-a" };
  const input = { documentId: "invoice", action: "edit", section: "files", returnTo };
  const original = structuredClone(input);
  const edit = resolveAiResourceNavigation("documents", input);
  assert.equal(edit.mode, "resources");
  assert.equal(edit.tab, "documents");
  assert.deepEqual(edit.options, original);
  assert.equal(navigationTargetError(workspace, { options: edit.options }), "");
  const returned = resolveAiResourceNavigation(returnTo.page, returnTo);
  assert.equal(returned.tab, "vouchers");
  assert.equal(returned.options.voucherId, "voucher-a");
  assert.deepEqual(input, original);
});

test("标题角落切换保留当前文档、流水、批次、凭证和报表目标", () => {
  const targets = [
    ["documents", { documentId: "invoice" }, "documents", undefined],
    ["transactions", { transactionId: "tx-a", importId: "batch-a" }, "reconcile", "transactions"],
    ["transactions", { importDocumentId: "bank-file" }, "reconcile", "transactions"],
    ["vouchers", { voucherId: "voucher-a" }, "reconcile", "vouchers"],
    ["reports", { section: "cashflow" }, "reports", undefined],
    ["reports", { section: "balance", versionId: "report-a" }, "reports", undefined],
    ["bankImport", {}, "bankImport", undefined],
  ];
  for (const [page, options, expectedPage, panel] of targets) {
    const target = resolveWorkbenchNavigation(page, options);
    assert.equal(target.page, expectedPage);
    assert.equal(target.options.panel, panel);
    for (const [key, value] of Object.entries(options)) assert.equal(target.options[key], value);
    assert.equal(navigationTargetError(workspace, { workspaceId: "company-a", period: "2026-09", options: target.options }), "");
  }
});

test("从正在编辑的文档切换完整工作台仍保留编辑动作与返回凭证路径", () => {
  const options = { documentId: "invoice", section: "files", action: "edit", returnTo: { page: "reconcile", panel: "vouchers", voucherId: "voucher-a" } };
  const before = structuredClone(options);
  const target = resolveWorkbenchNavigation("documents", options);
  assert.equal(target.page, "documents");
  assert.deepEqual(target.options, before);
  assert.equal(navigationTargetError(workspace, { workspaceId: workspace.id, period: workspace.currentPeriod, options: target.options }), "");
  assert.deepEqual(resolveAiResourceNavigation(target.options.returnTo.page, target.options.returnTo), { mode: "resources", tab: "vouchers", page: "reconcile", options: before.returnTo });
  assert.deepEqual(options, before);
});

test("手动展开的资料进入完整工作台并从返回快照恢复同一文件，不重放定位请求", () => {
  const initial = { tab: "documents", detail: false, options: {}, nonce: 3 };
  const selected = rememberAiDocumentFocus(initial, "invoice");
  const request = resolveWorkbenchNavigation(selected.tab, selected.options);
  assert.equal(request.page, "documents");
  assert.equal(request.options.documentId, "invoice");
  assert.equal(navigationTargetError(workspace, { workspaceId: workspace.id, period: workspace.currentPeriod, options: request.options }), "");
  const resourceState = { location: selected, history: [], query: "已核对", filter: "all", listScroll: 160 };
  const restored = structuredClone(resourceState).location;
  assert.equal(restored.options.documentId, "invoice");
  assert.equal(restored.nonce, initial.nonce, "手动展开不增加 nonce，不触发筛选重置");
  assert.equal(rememberAiDocumentFocus(selected, "invoice"), selected, "同一文件回报不写入新状态");
  const closed = rememberAiDocumentFocus(selected, null);
  assert.equal(resolveWorkbenchNavigation(closed.tab, closed.options).options.documentId, "");
  assert.equal(closed.nonce, selected.nonce);
  assert.deepEqual(initial.options, {});
});

test("换开另一份文件时不携带旧文件编辑动作，其他页签不接收迟到的文件回调", () => {
  const editing = { tab: "documents", options: { documentId: "bank-file", action: "edit", returnTo: { page: "reconcile", voucherId: "voucher-a" } }, nonce: 9 };
  const selected = rememberAiDocumentFocus(editing, "invoice");
  assert.equal(selected.options.documentId, "invoice");
  assert.equal(selected.options.action, undefined);
  assert.equal(selected.options.returnTo, undefined);
  const reports = { ...selected, tab: "reports" };
  assert.equal(rememberAiDocumentFocus(reports, null), reports);
});

test("日常明细留在简版，复杂设置、期初、归档和报表版本保留完整目标", () => {
  for (const [page, options] of [["setup", { stage: "s3" }], ["reports", { section: "opening-balances" }], ["archive", {}], ["reports", { versionId: "report-a", section: "cashflow" }], ["reconcile", { panel: "manual" }]]) {
    const target = resolveAiResourceNavigation(page, options);
    assert.equal(target.mode, "full");
    assert.equal(target.page, page);
    assert.deepEqual(target.options, options);
  }
  assert.equal(resolveAiResourceNavigation("reports").mode, "resources");
  assert.equal(resolveAiResourceNavigation("reconcile", { panel: "transactions", transactionId: "tx-a" }).tab, "transactions");
});

test("另一公司或账期即使有相同 ID 也不能被打开", () => {
  assert.match(navigationTargetError(workspace, { workspaceId: "company-b", period: "2026-09", options: { voucherId: "voucher-a" } }), /其他工作台/);
  assert.match(navigationTargetError(workspace, { workspaceId: "company-a", period: "2026-08", options: { voucherId: "voucher-a" } }), /其他账期/);
  assert.match(navigationTargetError(workspace, { options: { workspaceId: "company-b", documentId: "invoice" } }), /其他工作台/);
  assert.match(navigationTargetError(workspace, { options: { period: "2026-08", documentId: "invoice" } }), /其他账期/);
  assert.match(navigationTargetError(null), /没有/);
});

test("失效对象、历史对象及不匹配的批次不得退化为本期全部或另一对象", () => {
  for (const options of [{ transactionId: "missing" }, { voucherId: "missing" }, { documentId: "missing" }, { importId: "missing" }]) assert.match(navigationTargetError(workspace, { options }), /找不到/);
  for (const options of [{ transactionId: "tx-old" }, { voucherId: "voucher-old" }, { documentId: "old-file" }, { importId: "old-batch" }]) assert.match(navigationTargetError(workspace, { options }), /不属于当前账期/);
  assert.match(navigationTargetError(workspace, { options: { importDocumentId: "unimported" } }), /没有.*导入批次/);
  assert.match(navigationTargetError(workspace, { options: { importId: "batch-b", transactionId: "tx-a" } }), /不属于所选导入批次/);
  assert.match(navigationTargetError(workspace, { options: { importDocumentId: "bank-file", transactionId: "tx-b" } }), /不属于所选导入批次/);
  assert.match(navigationTargetError(workspace, { options: { versionId: "report-old" } }), /找不到当前账期/);
  assert.equal(navigationTargetError(workspace, { options: { importDocumentId: "bank-file", transactionId: "tx-a" } }), "");
});

test("查看已归档事项不改变原账本、入账状态或原件关系", () => {
  const archived = structuredClone(workspace);
  archived.delivery.archives.push({ id: "archive-a", period: "2026-09" });
  const before = structuredClone(archived);
  const target = resolveWorkbenchNavigation("vouchers", { voucherId: "voucher-a" });
  assert.equal(navigationTargetError(archived, { workspaceId: archived.id, period: archived.currentPeriod, options: target.options }), "");
  assert.deepEqual(archived, before);
});

test("已确认建议的事项链接携带原工作台和原账期上下文", () => {
  const links = proposalDestinations({ kind: "bank_business", status: "applied", period: "2026-09", sourceIds: ["invoice"], result: { voucherId: "voucher-a", transactionId: "tx-a" } }, workspace);
  assert.deepEqual(links.map((link) => link.initialTab), ["vouchers", "transactions", "documents"]);
  assert.ok(links.every((link) => link.workspaceId === workspace.id && link.period === workspace.currentPeriod));
  const older = proposalDestinations({ kind: "bank_business", period: "2026-08", result: { voucherId: "voucher-a" } }, workspace)[0];
  assert.equal(older.period, "2026-08");
  assert.match(navigationTargetError(workspace, { ...older, options: { voucherId: older.voucherId } }), /其他账期/);
});
