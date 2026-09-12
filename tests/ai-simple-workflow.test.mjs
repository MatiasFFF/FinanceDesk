import test from "node:test";
import assert from "node:assert/strict";
import { buildProposalUpdates, cleanAssistantText, conversationOperations, fileProgressText, filterTransactions,
  markdownBlocks, periodTransactions, proposalAccountLabel, proposalDestinations, proposalEditValues, remainingDraft, safeMarkdownHref } from "../src/features/ai-simple/aiWorkflow.js";

test("voucher preview resolves the selected real bank account and custom chart labels", () => {
  const workspace = { bankAccounts: [{ id: "bank-account-created-by-user", name: "联调基本户" }], chartOfAccounts: [{ id: "expenseFee", label: "银行服务手续费" }] };
  assert.equal(proposalAccountLabel(workspace, "bank-account-created-by-user"), "联调基本户");
  assert.equal(proposalAccountLabel(workspace, "expenseFee"), "银行服务手续费");
  assert.equal(proposalAccountLabel(workspace, "bank"), "银行存款");
  assert.equal(proposalAccountLabel(workspace, ""), "科目待确认");
});

test("sending a captured batch removes only that batch and preserves later draft edits and attachments", () => {
  const sent = { text: "整理第一批", files: [{ id: "file1", uploaded: { documentId: "saved1" } }] };
  const current = { text: "这是下一批的说明", files: [...sent.files, { id: "file2" }] };
  assert.deepEqual(remainingDraft(current, sent), { text: "这是下一批的说明", files: [{ id: "file2" }] });
  assert.deepEqual(remainingDraft(sent, sent), { text: "", files: [] });
  assert.equal(current.files.length, 2);
});

test("superseded revisions and confirmed results stay with their originating request after new messages", () => {
  const messages = [
    { id: "first", role: "user", createdAt: "2026-09-01T10:00:00Z" },
    { id: "reply", role: "assistant", createdAt: "2026-09-01T10:01:00Z" },
    { id: "second", role: "user", createdAt: "2026-09-01T11:00:00Z" },
  ];
  const proposals = [
    { id: "original", status: "superseded", createdAt: "2026-09-01T10:00:30Z" },
    { id: "revision", status: "applied", revisesProposalId: "original", createdAt: "2026-09-01T12:00:00Z" },
    { id: "pending", status: "pending", createdAt: "2026-09-01T11:01:00Z" },
  ];
  const groups = conversationOperations(messages, proposals);
  assert.deepEqual(groups.map((group) => ({ id: group.id, messages: group.messages.map((item) => item.id), proposals: group.proposals.map((item) => item.id) })), [
    { id: "first", messages: ["first", "reply"], proposals: ["revision"] }, { id: "second", messages: ["second"], proposals: ["pending"] },
  ]);
  assert.equal(conversationOperations([], [proposals[2]])[0].proposals[0].id, "pending");
});

test("bank mapping revisions can remove columns and keep numeric column zero", () => {
  const updates = buildProposalUpdates("bank_import", { mapping: { date: "0", amount: "", credit: "3", summary: null } });
  assert.deepEqual(updates, { mapping: { date: 0, credit: 3 } });
});

test("business editing submits only allowed classification fields and cannot change source amounts or targets", () => {
  const updates = buildProposalUpdates("bank_business", { transactionId: "other", classification: {
    businessType: "expense", account: "expenseOther", amount: 1, transactionId: "other", period: "2025-01", evidenceIds: ["original"], relatedBillId: "", referenceNo: "", reason: "核对后修正", counterparty: "真实对方",
  } });
  assert.equal(Object.hasOwn(updates.classification, "amount"), false);
  assert.equal(Object.hasOwn(updates.classification, "transactionId"), false);
  assert.equal(Object.hasOwn(updates.classification, "period"), false);
  assert.equal(updates.classification.relatedBillId, "");
  assert.deepEqual(updates.classification.evidenceIds, ["original"]);
  assert.throws(() => buildProposalUpdates("other", {}));
});

test("editable values are copied without mutating the saved proposal", () => {
  const proposal = { kind: "bank_business", editableValues: { classification: { reason: "旧依据", evidenceIds: ["doc1"] } } };
  const edit = proposalEditValues(proposal);
  edit.classification.reason = "新依据";
  edit.classification.evidenceIds.push("doc2");
  assert.equal(proposal.editableValues.classification.reason, "旧依据");
  assert.deepEqual(proposal.editableValues.classification.evidenceIds, ["doc1"]);
  assert.deepEqual(proposalEditValues({ kind: "document_fields", preview: { fields: [{ key: "amount", after: 0 }] } }), { fields: { amount: 0 } });
});

const workspace = {
  currentPeriod: "2026-09", bankAccounts: [{ id: "acct1", name: "基本户" }], documents: [{ id: "doc1", name: "原始票据.pdf" }],
  transactions: [
    { id: "t1", date: "2026-09-01", amount: -100, counterparty: "甲方公司", summary: "办公支出", accountId: "acct1" },
    { id: "t2", date: "2026-09-02", amount: 200, counterparty: "乙方公司", bankBusinessEventId: "event2" },
    { id: "t3", date: "2026-08-02", period: "2026-09", amount: 300, counterparty: "上期记录" },
  ],
  vouchers: [
    { id: "v1", period: "2026-09", status: "draft", sourceIds: ["t1"] },
    { id: "v2", period: "2026-09", status: "posted", bankBusinessEventId: "event2" },
    { id: "old", period: "2026-08", status: "posted", sourceIds: ["t1"] },
  ], exceptionTasks: [{ sourceId: "t1", status: "open" }],
};

test("transaction search uses the actual period, case-independent terms and source-backed statuses", () => {
  assert.deepEqual(periodTransactions(workspace).map((item) => item.id), ["t1", "t2"]);
  assert.deepEqual(filterTransactions(workspace, { query: "基本户 100", status: "draft" }).map((item) => item.id), ["t1"]);
  assert.deepEqual(filterTransactions(workspace, { status: "posted" }).map((item) => item.id), ["t2"]);
  assert.deepEqual(filterTransactions(workspace, { status: "exception" }).map((item) => item.id), ["t1"]);
  assert.equal(filterTransactions(workspace, { query: "上期" }).length, 0);
  assert.equal(filterTransactions(workspace, { query: "不存在" }).length, 0);
});

test("confirmation results keep links to the concrete voucher, transaction and existing original", () => {
  const links = proposalDestinations({ kind: "bank_business", status: "applied", sourceIds: ["t1", "doc1", "missing"], result: { transactionId: "t1", voucherId: "v1" } }, workspace);
  assert.deepEqual(links.map(({ initialTab, voucherId, transactionId, documentId }) => ({ initialTab, voucherId, transactionId, documentId })), [
    { initialTab: "vouchers", voucherId: "v1", transactionId: undefined, documentId: undefined },
    { initialTab: "transactions", voucherId: undefined, transactionId: "t1", documentId: undefined },
    { initialTab: "documents", voucherId: undefined, transactionId: undefined, documentId: "doc1" },
  ]);
  assert.equal(links.some((link) => link.documentId === "missing"), false);
});

test("Markdown supports common financial headings, lists, tables and code while HTML remains plain text", () => {
  const blocks = markdownBlocks("# 核对结果\n\n1. 核对原件\n2. 确认建议\n\n| 项目 | 金额 |\n| --- | ---: |\n| 办公用品 | 100 |\n\n<script>alert(1)</script>\n\n```js\nconsole.log('text')\n```");
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "list", "table", "paragraph", "code"]);
  assert.deepEqual(blocks[2].rows, [["办公用品", "100"]]);
  assert.equal(blocks[3].text, "<script>alert(1)</script>");
  assert.equal(blocks[4].text, "console.log('text')");
});

test("assistant Markdown links cannot navigate to scripts, local files, data URLs or disguised schemes", () => {
  for (const href of ["javascript:alert(1)", "data:text/html,<script>x</script>", "file:///private/key", "java\nscript:alert(1)", "//example.com", "/private", "javascript&#58;alert(1)"]) assert.equal(safeMarkdownHref(href), null);
  assert.equal(safeMarkdownHref("https://example.com/report?q=1"), "https://example.com/report?q=1");
});

test("file progress identifies the saved/recognition stage and page, while copy content hides credentials", () => {
  assert.equal(fileProgressText({ stage: "saving", name: "流水.csv" }), "流水.csv：保存原件");
  assert.equal(fileProgressText({ stage: "recognizing", pageNumber: 2, totalPages: 3, progress: 0.5 }, "票据.pdf"), "票据.pdf：识别文字 · 第 2/3 页 · 50%");
  const secret = "fixture-secret";
  assert.equal(cleanAssistantText(`${secret} sk-fake123456789`, secret).includes(secret), false);
  assert.equal(cleanAssistantText("sk-fake123456789").includes("sk-"), false);
});
