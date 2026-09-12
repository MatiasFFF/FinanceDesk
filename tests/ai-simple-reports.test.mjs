import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { buildAiReportModel } from "../src/features/ai-simple/aiReportModel.js";
import { buildAiReportExcelWorkbook, generateAiReportExcel, downloadAiReportExcel } from "../src/features/ai-simple/aiReportExcel.js";

const generatedAt = "2026-09-12T08:00:00.000Z";
function voucher(id, amount = 1200, overrides = {}) {
  return { id, no: `记-${id}`, date: "2026-09-06", summary: "已确认服务收入", status: "posted",
    sourceIds: [`txn-${id}`], evidenceIds: [`doc-${id}`],
    lines: [{ account: "bank", debit: amount, credit: 0, sourceIds: [`txn-${id}`] }, { account: "revenueGroup", debit: 0, credit: amount, sourceIds: [`txn-${id}`] }], ...overrides };
}
function workspace(overrides = {}) {
  return { id: "report-workspace", name: "本期报表工作台", currentPeriod: "2026-09", modules: { members: false, inventory: false },
    openingStatus: { status: "confirmed" }, openingLedger: { bank: 500, equity: -500 },
    vouchers: [voucher("income"), voucher("fee", 0, { summary: "银行手续费", lines: [{ account: "expenseFee", debit: 120, credit: 0 }, { account: "bank", debit: 0, credit: 120 }] })],
    transactions: [], bills: [], businessEvents: [], documents: [], delivery: { reportVersions: [], archives: [] }, ...overrides };
}
const section = (model, id) => model.sections.find((item) => item.id === id);
const value = (model, report, id) => section(model, report).rows.find((row) => row.id === id).value;
const rowsOf = (workbook, name) => XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: "" });

test("AI reports include posted vouchers by their accounting date and exclude drafts, cancelled and other periods", () => {
  const current = workspace();
  current.vouchers.push(
    voucher("draft", 90000, { status: "draft" }),
    voucher("returned", 80000, { status: "changes_requested" }),
    voucher("cancelled", 70000, { status: "cancelled" }),
    voucher("history", 60000, { date: "2026-08-31", period: "2026-09" }),
    voucher("old-draft", 50000, { status: "draft", date: "2026-08-31", period: "2026-09" }),
  );
  const model = buildAiReportModel(current);
  assert.equal(model.postedCount, 2);
  assert.equal(model.pendingCount, 2, "drafts without a redundant period field must remain visible");
  assert.deepEqual(model.pending.map((item) => item.id), ["draft", "returned"]);
  assert.equal(value(model, "income", "profit"), 1080);
  assert.equal(value(model, "balance", "assets"), 1580);
  assert.equal(value(model, "balance", "equity"), 1580);
  assert.equal(value(model, "balance", "difference"), 0);
  assert.equal(value(model, "cashflow", "openingCash"), 500);
  assert.equal(value(model, "cashflow", "netChange"), 1080);
  assert.equal(value(model, "cashflow", "closingCash"), 1580);
  assert.deepEqual([...new Set(model.sources.filter((source) => source.type === "voucher").map((source) => source.voucherId))].sort(), ["fee", "income"]);
});

test("account details retain the exact posted voucher and original references, including repeated account lines", () => {
  const current = workspace({ vouchers: [voucher("split", 0, { lines: [
    { account: "bank", debit: 100, credit: 0, sourceIds: ["txn-one"] },
    { account: "bank", debit: 200, credit: 0, sourceIds: ["txn-two"] },
    { account: "revenueGroup", debit: 0, credit: 300 },
  ] })] });
  const model = buildAiReportModel(current);
  const bank = section(model, "balance").details.find((line) => line.id === "bank");
  assert.equal(bank.value, 800);
  assert.deepEqual(bank.entries.map((entry) => entry.debit), [100, 200]);
  assert.ok(bank.entries.every((entry) => entry.voucherId === "split" && entry.voucherNo === "记-split"));
  assert.ok(bank.entries[1].sourceIds.includes("txn-two"));
  assert.deepEqual(bank.entries[0].evidenceIds, ["doc-split"]);
  assert.ok(section(model, "balance").rows.find((row) => row.id === "assets").sourceIds.includes("opening:2026-09:bank"));
  const opening = model.sources.find((source) => source.sourceId === "opening:2026-09:bank");
  assert.equal(opening.opening, 500);
  assert.equal(opening.voucherId, undefined, "opening balances must never acquire a made-up voucher link");
});

test("empty periods show zero financial amounts and expose unresolved opening balances", () => {
  const model = buildAiReportModel(workspace({ vouchers: [], openingLedger: {}, openingStatus: { status: "pending" } }));
  assert.equal(model.postedCount, 0);
  assert.equal(model.hasOpeningBalances, false);
  assert.ok(model.sections.every((item) => item.rows.every((row) => row.value === 0)));
  assert.ok(model.notes.some((note) => note.id === "opening"));
  assert.equal(model.sources.length, 0);
  const openingOnly = buildAiReportModel(workspace({ vouchers: [] }));
  assert.equal(openingOnly.hasOpeningBalances, true);
  assert.equal(value(openingOnly, "balance", "assets"), 500);
  assert.equal(value(openingOnly, "income", "profit"), 0);
});

test("unclassified cash movements remain visible even when incoming and outgoing amounts net to zero", () => {
  const current = workspace({ openingLedger: {}, vouchers: [
    voucher("pending-in", 0, { lines: [{ account: "bank", debit: 120, credit: 0 }, { account: "unclear", debit: 0, credit: 120 }] }),
    voucher("pending-out", 0, { lines: [{ account: "bank", debit: 0, credit: 120 }, { account: "unclear", debit: 120, credit: 0 }] }),
  ] });
  const model = buildAiReportModel(current);
  assert.equal(value(model, "cashflow", "pending"), 0);
  assert.equal(section(model, "cashflow").rows.find((row) => row.id === "pending").warning, true);
  assert.equal(section(model, "cashflow").cashGroups.find((group) => group.id === "pending").entries.length, 2);
  const note = model.notes.find((item) => item.id === "cashFlowClassification");
  assert.match(note.detail, /2 笔/);
  assert.deepEqual(note.voucherIds, ["pending-in", "pending-out"]);
});

test("imbalance reasons use actual amounts and archived reports stay read-only", () => {
  const current = workspace({ openingLedger: { bank: 500, equity: -450 }, delivery: { archives: [{ period: "2026-09" }], reportVersions: [] } });
  const before = structuredClone(current);
  const model = buildAiReportModel(current);
  assert.equal(model.archived, true);
  assert.equal(value(model, "balance", "difference"), 50);
  assert.match(model.notes.find((note) => note.id === "balanceSheet").detail, /期初借贷差额为 50\.00 元/);
  assert.deepEqual(current, before);
});

test("working-copy Excel round-trips the same visible amounts and preserves pending state and references without freezing", async () => {
  const current = workspace();
  current.vouchers.push(voucher("draft", 99999, { status: "draft" }));
  const before = structuredClone(current);
  const model = buildAiReportModel(current);
  const generated = await generateAiReportExcel(model, { generatedAt });
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(generated.blob.size, generated.bytes.byteLength);
  assert.equal(generated.metadata.frozen, false);
  assert.equal(generated.metadata.downloadRequested, undefined);
  assert.equal(generated.metadata.pendingCount, 1);
  assert.equal(generated.metadata.localOnly, true);
  assert.equal(generated.metadata.uploaded, false);
  assert.match(generated.metadata.fileName, /本期核对稿\.xlsx$/);
  const reopened = XLSX.read(generated.bytes, { type: "array" });
  assert.deepEqual(reopened.SheetNames, ["利润表", "资产负债表", "现金流量表", "科目明细", "来源明细", "核对状态"]);
  for (const report of model.sections) {
    const rows = rowsOf(reopened, report.title);
    assert.ok(rows.some((row) => row[0] === "账期" && row[1] === "2026-09"));
    assert.ok(rows.some((row) => row[0] === "报表性质" && /非冻结确认版本/.test(row[1])));
    for (const metric of report.rows) {
      const exported = rows.find((row) => row[0] === metric.label);
      assert.equal(exported[1], metric.value);
      assert.equal(exported[2], metric.sourceIds.join("；"));
    }
  }
  const sources = rowsOf(reopened, "来源明细");
  assert.ok(sources.some((row) => row[5] === "income" && row[11] === "doc-income"));
  assert.ok(sources.some((row) => row[10] === "opening:2026-09:bank"));
  assert.ok(!sources.some((row) => row[5] === "draft"));
  assert.ok(rowsOf(reopened, "核对状态").some((row) => row[0] === "未计入报表的凭证" && row[4] === "draft"));
  assert.deepEqual(current, before);
});

test("Excel text stays literal and numbers stay numeric", () => {
  const model = buildAiReportModel(workspace({ name: "=1+1", vouchers: [voucher("literal", 1200, { summary: "=SUM(A1:A9)" })] }));
  const { workbook, metadata } = buildAiReportExcelWorkbook(model, { generatedAt });
  assert.equal(workbook.Sheets["利润表"].B2.t, "s");
  assert.equal(workbook.Sheets["利润表"].B2.f, undefined);
  const summary = Object.values(workbook.Sheets["来源明细"]).find((cell) => cell?.v === "=SUM(A1:A9)");
  assert.equal(summary.t, "s");
  assert.equal(summary.f, undefined);
  assert.equal(rowsOf(workbook, "利润表").find((row) => row[0] === "本期利润")[1], 1200);
  assert.equal(metadata.generatedAt, generatedAt);
});

test("download is a separate browser request and a failed click never reports success", (t) => {
  let clicked = 0;
  let removed = 0;
  const revoked = [];
  let clickError = null;
  const anchor = { click() { if (clickError) throw clickError; clicked += 1; }, remove() { removed += 1; } };
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => anchor, body: { appendChild() {} } } });
  t.after(() => { if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else delete globalThis.document; });
  t.mock.method(URL, "createObjectURL", () => "blob:ai-report-test");
  t.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
  t.mock.method(globalThis, "setTimeout", (callback) => { callback(); return 1; });
  const file = { blob: new Blob(["test"]), metadata: { fileName: "本期核对稿.xlsx", frozen: false } };
  const result = downloadAiReportExcel(file);
  assert.equal(result.downloadRequested, true);
  assert.equal(anchor.download, file.metadata.fileName);
  assert.equal(clicked, 1);
  clickError = new Error("下载被浏览器拒绝");
  assert.throws(() => downloadAiReportExcel(file), /下载被浏览器拒绝/);
  assert.equal(clicked, 1);
  assert.equal(removed, 2);
  assert.deepEqual(revoked, ["blob:ai-report-test", "blob:ai-report-test"]);
});
