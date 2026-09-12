import { accountDefinition } from "../../domain/accounting/model.js";

export const proposalLabels = { bank_import: "流水导入", bank_business: "业务归属", document_fields: "票据资料" };
export const invoiceFieldLabels = { invoiceNumber: "发票号码", invoiceDate: "开票日期", counterparty: "交易对方", amount: "金额", taxAmount: "税额", taxRate: "税率" };
export const cleanAssistantText = (value, key = "") => (key ? String(value || "").split(key).join("[密钥已隐藏]") : String(value || "")).replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[密钥已隐藏]");

export function proposalAccountLabel(workspace, accountId) {
  return accountId ? accountDefinition(accountId, workspace).label || "科目待确认" : "科目待确认";
}

export function remainingDraft(current, submitted) {
  const ids = new Set(submitted.files.map((entry) => entry.id));
  return { ...current, text: current.text === submitted.text ? "" : current.text, files: current.files.filter((entry) => !ids.has(entry.id)) };
}

export function fileProgressText(progress, fallbackName = "") {
  if (typeof progress === "string") return progress;
  const labels = { saving: "保存原件", loading: "准备本地识别", rendering: "读取页面", extracting: "读取文字", recognizing: "识别文字", completed: "识别完成" };
  const page = progress?.pageNumber ? ` · 第 ${progress.pageNumber}${progress.totalPages ? `/${progress.totalPages}` : ""} 页` : "";
  const percent = progress?.stage === "recognizing" && Number.isFinite(progress.progress) ? ` · ${Math.round(progress.progress * 100)}%` : "";
  return `${progress?.name || fallbackName}${progress?.name || fallbackName ? "：" : ""}${progress?.message || labels[progress?.stage] || "处理资料"}${page}${percent}`;
}

export function conversationOperations(messages, proposals) {
  const operations = [];
  for (const message of messages) {
    if (message.role === "user" || !operations.length) operations.push({ id: message.id, createdAt: message.createdAt || "", messages: [], proposals: [] });
    operations.at(-1).messages.push(message);
  }
  const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  for (const proposal of proposals.filter((item) => ["pending", "applied"].includes(item.status))) {
    let origin = proposal;
    const seen = new Set([origin.id]);
    while (origin.revisesProposalId && byId.has(origin.revisesProposalId) && !seen.has(origin.revisesProposalId)) {
      origin = byId.get(origin.revisesProposalId); seen.add(origin.id);
    }
    const operation = [...operations].reverse().find((item) => item.createdAt <= (origin.createdAt || "")) || operations[0];
    if (operation) operation.proposals.push(proposal);
    else operations.push({ id: "saved-proposals", createdAt: "", messages: [], proposals: [proposal] });
  }
  return operations;
}

export function proposalDestinations(proposal, workspace) {
  const destinations = [];
  const result = proposal.result || {};
  const transactionId = result.transactionId || proposal.preview?.transaction?.id;
  const voucherId = result.voucherId || result.voucher?.id;
  if (voucherId) destinations.push({ label: "查看凭证", initialTab: "vouchers", voucherId });
  if (transactionId) destinations.push({ label: "查看流水", initialTab: "transactions", transactionId });
  if (proposal.kind === "bank_import" && proposal.status === "applied") destinations.push({ label: "查看导入流水", initialTab: "transactions", importDocumentId: proposal.sourceIds?.[0] });
  const ids = new Set([result.documentId, proposal.preview?.documentId, ...(proposal.sourceIds || [])].filter(Boolean));
  for (const document of workspace.documents || []) if (ids.has(document.id)) destinations.push({ label: document.name || "查看原件", initialTab: "documents", documentId: document.id });
  return destinations.map((destination) => ({ ...destination, workspaceId: workspace.id, period: proposal.period || workspace.currentPeriod }));
}

export function resolveWorkbenchNavigation(page, options = {}) {
  const panels = { vouchers: "vouchers", transactions: "transactions", bills: "business", manualVouchers: "manual" };
  return { page: panels[page] ? "reconcile" : page, options: panels[page] ? { ...options, panel: panels[page] } : { ...options } };
}

export function rememberAiDocumentFocus(location, documentId) {
  if (location.tab !== "documents" || (location.options.documentId || "") === (documentId || "")) return location;
  // Remember a local selection without replaying the external focus request.
  // A different file must not inherit another file's edit action or save return.
  const { action, returnTo, ...options } = location.options;
  return { ...location, options: { ...options, documentId: documentId || "", section: "files" } };
}

export function rememberAiVoucherFocus(location, voucherId, open) {
  if (location.tab !== "vouchers" || (!open && location.options.voucherId !== voucherId)) return location;
  const selected = open ? voucherId : "";
  if ((location.options.voucherId || "") === selected) return location;
  return { ...location, options: { ...location.options, voucherId: selected } };
}

export function voucherOriginalTarget(workspace, voucher, entry, { transactionId } = {}) {
  if (!(workspace.documents || []).some((document) => document.id === entry.id)) return null;
  const scope = { workspaceId: workspace.id, period: workspace.currentPeriod };
  if (navigationTargetError(workspace, { ...scope, options: { documentId: entry.id, voucherId: voucher.id, transactionId } })) return null;
  const returnTo = { page: "reconcile", ...scope, ...(transactionId ? { panel: "transactions", transactionId } : { panel: "vouchers", voucherId: voucher.id }) };
  return { page: "documents", options: { ...scope, documentId: entry.id, section: "files", returnTo } };
}

export function resolveAiResourceNavigation(page, options = {}) {
  const target = resolveWorkbenchNavigation(page, options);
  const panel = target.options.panel || "transactions";
  const tab = target.page === "reconcile" ? ({ transactions: "transactions", vouchers: "vouchers" }[panel])
    : ["documents", "reports", "bankImport"].includes(target.page) ? target.page : null;
  // Detailed report sections and opening balances belong to the full workbench.
  const full = !tab || (target.page === "reports" && (options.section || options.versionId));
  return { ...target, mode: full ? "full" : "resources", ...(full ? {} : { tab }) };
}

export function navigationTargetError(workspace, { workspaceId, period, options = {} } = {}) {
  if (!workspace) return "当前没有可打开的工作台。";
  if ((workspaceId && workspaceId !== workspace.id) || (options.workspaceId && options.workspaceId !== workspace.id)) return "这条事项属于其他工作台，请回到原工作台后再打开。";
  if ((period && period !== workspace.currentPeriod) || (options.period && options.period !== workspace.currentPeriod)) return "这条事项属于其他账期，请回到原账期后再打开。";
  const recordPeriod = (record, kind) => kind === "transactions" ? String(record.date || "").slice(0, 7) || record.period
    : record.period || String(record.date || "").slice(0, 7);
  const targets = [["transactionId", "transactions", "流水"], ["voucherId", "vouchers", "凭证"], ["documentId", "documents", "资料"], ["importDocumentId", "documents", "导入原件"], ["importId", "bankImports", "导入批次"]];
  for (const [key, collection, label] of targets) {
    if (!options[key]) continue;
    const record = (workspace[collection] || []).find((item) => item.id === options[key]);
    if (!record) return `找不到这条${label}，可能已删除或属于其他工作台。`;
    const targetPeriod = recordPeriod(record, collection);
    if (targetPeriod && targetPeriod !== workspace.currentPeriod) return `这条${label}不属于当前账期，请回到原账期后再打开。`;
  }
  if (options.importDocumentId && !(workspace.bankImports || []).some((item) => item.sourceDocumentId === options.importDocumentId && item.period === workspace.currentPeriod)) return "当前账期没有这份原件的导入批次，请返回原事项重新选择。";
  if (options.transactionId && (options.importId || options.importDocumentId)) {
    const transaction = workspace.transactions.find((item) => item.id === options.transactionId);
    const imports = (workspace.bankImports || []).filter((item) => item.period === workspace.currentPeriod
      && (!options.importId || item.id === options.importId) && (!options.importDocumentId || item.sourceDocumentId === options.importDocumentId));
    if (!imports.some((item) => item.id === transaction.importId)) return "这笔流水不属于所选导入批次，请返回原事项重新选择。";
  }
  if (options.versionId && options.versionId !== "live" && !(workspace.delivery?.reportVersions || []).some((item) => item.id === options.versionId && item.period === workspace.currentPeriod)) return "找不到当前账期的这份报表版本。";
  return "";
}

export function proposalEditValues(proposal) {
  if (proposal.editableValues) return JSON.parse(JSON.stringify(proposal.editableValues));
  const preview = proposal.preview || {};
  if (proposal.kind === "bank_import") return { mapping: { ...preview.mapping } };
  if (proposal.kind === "document_fields") return { fields: Object.fromEntries((preview.fields || []).map((field) => [field.key, field.after ?? ""])) };
  return { classification: Object.fromEntries(["businessType", "account", "taxTreatment", "invoiceStatus", "reason", "evidenceIds", "relatedBillId", "referenceNo", "counterparty", "relatedTransactionId"]
    .map((key) => [key, preview[key] ?? (key === "evidenceIds" ? [] : "")])) };
}

export function buildProposalUpdates(kind, values) {
  if (kind === "bank_import") return { mapping: Object.fromEntries(Object.entries(values.mapping || {}).filter(([, value]) => value !== "" && value != null).map(([key, value]) => [key, Number(value)])) };
  if (kind === "document_fields") return { fields: { ...values.fields } };
  if (kind === "bank_business") {
    const allowed = ["businessType", "account", "taxTreatment", "invoiceStatus", "reason", "evidenceIds", "relatedBillId", "referenceNo", "counterparty", "relatedTransactionId"];
    return { classification: Object.fromEntries(allowed.filter((key) => Object.hasOwn(values.classification || {}, key)).map((key) => [key, values.classification[key]])) };
  }
  throw new Error("这类事项暂不支持修改");
}

export function periodTransactions(workspace) {
  return (workspace.transactions || []).filter((transaction) => (String(transaction.date || "").slice(0, 7) || transaction.period) === workspace.currentPeriod);
}

export function transactionBrowseState(transaction, workspace) {
  const vouchers = (workspace.vouchers || []).filter((voucher) => (voucher.period || voucher.date?.slice(0, 7)) === workspace.currentPeriod
    && ((voucher.sourceIds || []).includes(transaction.id) || (transaction.bankBusinessEventId && voucher.bankBusinessEventId === transaction.bankBusinessEventId)));
  const exception = transaction.status === "exception" || (workspace.exceptionTasks || []).some((task) => task.sourceId === transaction.id && task.status !== "resolved");
  const posted = vouchers.some((voucher) => voucher.status === "posted") || transaction.status === "posted";
  const draft = vouchers.some((voucher) => ["draft", "changes_requested"].includes(voucher.status));
  return { exception, posted, draft, pending: !posted && !draft, label: exception ? "待核对" : draft ? "有凭证草稿" : posted ? "有已入账凭证" : transaction.status === "reconciled" ? "已核销" : "待整理" };
}

export function filterTransactions(workspace, { query = "", status = "all" } = {}) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return periodTransactions(workspace).filter((transaction) => {
    const state = transactionBrowseState(transaction, workspace);
    const account = workspace.bankAccounts?.find((item) => item.id === transaction.accountId || item.id === transaction.bankAccountId);
    const text = [transaction.date, transaction.counterparty, transaction.summary, transaction.serial, transaction.amount, account?.name].join(" ").toLocaleLowerCase();
    return (status === "all" || state[status] === true) && terms.every((term) => text.includes(term));
  });
}

export function safeMarkdownHref(value) {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}

const listLine = (line) => /^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/.exec(line);
function tableCells(line) { return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|")); }
const tableSeparator = (line) => line?.includes("|") && tableCells(line).every((cell) => /^:?-{3,}:?$/.test(cell));

// A small text parser: no HTML parsing, network images, embedded scripts, or execution.
export function markdownBlocks(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    if (/^\s*```/.test(line)) {
      const rows = []; i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) rows.push(lines[i++]);
      i += 1; blocks.push({ type: "code", text: rows.join("\n") }); continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { blocks.push({ type: "heading", level: Math.min(heading[1].length + 2, 5), text: heading[2].replace(/\s+#+$/, "") }); i += 1; continue; }
    if (line.includes("|") && tableSeparator(lines[i + 1])) {
      const headers = tableCells(line); const rows = []; i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(tableCells(lines[i++]));
      blocks.push({ type: "table", headers, rows }); continue;
    }
    const item = listLine(line);
    if (item) {
      const ordered = /^\d/.test(item[1]); const items = []; const start = ordered ? Number.parseInt(item[1], 10) : undefined;
      while (i < lines.length) { const next = listLine(lines[i]); if (!next || /^\d/.test(next[1]) !== ordered) break; items.push(next[2]); i += 1; }
      blocks.push({ type: "list", ordered, start, items }); continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const rows = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) rows.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ type: "quote", text: rows.join("\n") }); continue;
    }
    const rows = [line]; i += 1;
    while (i < lines.length && lines[i].trim() && !/^\s*(?:```|#{1,6}\s|>)/.test(lines[i]) && !listLine(lines[i]) && !(lines[i].includes("|") && tableSeparator(lines[i + 1]))) rows.push(lines[i++]);
    blocks.push({ type: "paragraph", text: rows.join("\n") });
  }
  return blocks;
}
