import { createId, getWorkspace } from "../domain/foundation.js";
import { isPeriodArchived, validAccountingPeriod } from "../domain/periods.js";
import { workspaceAccountDefinitions } from "../domain/accounting/model.js";
import { createVoucherDraft } from "../domain/accounting/vouchers.js";
import { buildFinancialStatements, buildTaxWorkpaper } from "../domain/accounting/reporting.js";
import { BUSINESS_EVENT_INVOICE_STATUSES, BUSINESS_EVENT_TAX_TREATMENTS, confirmBankTransactionBusinessEvent, manualBusinessEventTypesForWorkspace } from "../features/reconciliation/reconciliationEngine.js";
import { BANK_FIELD_DEFINITIONS, inspectBankTable } from "../features/intake/bankStatementImport.js";
import { getLocalDocumentRecognition, getStoredDocumentRecord, hashLocalFile, normalizeDocumentStructuredData, saveLocalDocument, saveLocalDocumentRecognition, updateLocalDocumentMetadata, verifyStoredDocumentOriginal } from "../features/intake/documentIntake.js";
import { createFinanceDeskService, postWorkspaceVoucher } from "./financeDeskService.js";
import { AI_FINANCE_TOOLS } from "./aiFinanceTools.js";
import { DEEPSEEK_REASONING_EFFORTS, isDeepSeekModelId } from "./deepseekModels.js";

const copy = (value) => JSON.parse(JSON.stringify(value));
const fail = (message, code = "AI_INVALID_INPUT") => Object.assign(new Error(message), { code });
const stamp = () => new Date().toISOString();
const periodOf = (record) => record.period || record.businessPeriod || String(record.date || "").slice(0, 7);
const safeText = (value, limit = 32000) => String(value ?? "").replace(/sk-[A-Za-z0-9_-]{12,}/g, "[密钥已隐藏]").slice(0, limit);
const documentVersion = (document) => JSON.stringify([document.id, document.hash, document.version, document.period,
  document.category, document.storage?.blobId, document.structuredData, document.contentRecognition?.resultId, document.archiveStatus, document.lifecycleStatus]);
const fieldNames = { invoice: ["invoiceNumber", "invoiceDate", "counterparty", "amount", "taxAmount", "taxRate"] };
const recoverableToolCodes = new Set(["AI_INVALID_INPUT", "AI_BANK_ACCOUNT_REQUIRED", "BANK_IMPORT_INPUT_INVALID",
  "BUSINESS_EVENT_TYPE_REQUIRED", "BUSINESS_EVENT_DIRECTION_INVALID", "BUSINESS_EVENT_COUNTERPARTY_REQUIRED",
  "BUSINESS_EVENT_REFERENCE_REQUIRED", "BUSINESS_EVENT_BILL_KIND_INVALID", "BUSINESS_EVENT_BILL_DIRECTION_INVALID",
  "BUSINESS_EVENT_TAX_REQUIRED", "BUSINESS_EVENT_INVOICE_STATUS_REQUIRED", "BUSINESS_EVENT_ACCOUNT_INVALID"]);
const select = (record, keys) => Object.fromEntries(keys.filter((key) => record?.[key] !== undefined).map((key) => [key, record[key]]));
const proposalSummary = (proposal) => select(proposal, ["id", "kind", "status", "title", "summary", "sourceIds", "revisesProposalId", "supersededBy", "appliedAt", "message"]);
const documentSummary = (document) => ({ ...select(document, ["id", "name", "period", "category"]), recognitionStatus: document.contentRecognition?.ocrStatus || "not_started" });
const transactionSummary = (transaction) => select(transaction, ["id", "date", "amount", "summary", "counterparty", "accountId", "evidenceIds", "status", "bankBusinessEventId", "classification"]);
const publicProposal = ({ payload, fingerprint, ...proposal }) => copy({ ...proposal,
  editableValues: proposal.kind === "bank_import" ? { mapping: payload.mapping || {} }
    : proposal.kind === "document_fields" ? { fields: payload.fields }
      : { classification: Object.fromEntries(Object.entries(payload).filter(([key]) => !["transactionId", "businessPeriod"].includes(key))) } });

function validateValue(value, schema, path = "参数") {
  if (schema.enum && !schema.enum.includes(value)) throw fail(`${path}不在可选范围内`);
  const types = schema.type ? [schema.type].flat() : [];
  if (types.length && !types.some((type) => type === "object" ? value && typeof value === "object" && !Array.isArray(value)
    : type === "array" ? Array.isArray(value) : type === "integer" ? Number.isInteger(value) : typeof value === type)) throw fail(`${path}类型不正确`);
  if (typeof value === "string" && ((schema.minLength && !value.trim()) || value.length > 32000)) throw fail(`${path}为空或过长`);
  if (typeof value === "number" && (!Number.isFinite(value) || (schema.minimum != null && value < schema.minimum))) throw fail(`${path}必须是有效数值`);
  if (Array.isArray(value)) {
    if (value.length > 100) throw fail(`${path}一次最多选择100项`);
    value.forEach((item) => validateValue(item, schema.items || {}, path));
  } else if (value && typeof value === "object") {
    for (const required of schema.required || []) if (!Object.hasOwn(value, required)) throw fail(`缺少参数：${required}`);
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw fail("不支持的字段名");
      const rule = schema.properties?.[key] || schema.additionalProperties;
      if (!rule) throw fail(`不支持的参数：${key}`);
      validateValue(item, rule === true ? {} : rule, key);
    }
  }
}

/** A service belongs to the displayed workspace, period and local identity. */
export function createAiFinanceService({ store, fileVault, workspaceId, period }) {
  if (!store?.getState || !workspaceId || !validAccountingPeriod(period)) throw fail("请选择工作台和有效账期");
  const actorId = store.getState().activeUserId || null;
  const confirming = new Map();
  const revising = new Set();

  function target(permission = "data.read", signal) {
    signal?.throwIfAborted();
    const state = store.getState();
    const workspace = getWorkspace(state, workspaceId);
    if (!workspace || state.activeWorkspaceId !== workspaceId || workspace.currentPeriod !== period
      || (state.activeUserId || null) !== actorId) throw fail("工作台、账期或操作身份已切换，请在当前页面重新发起", "AI_TARGET_CHANGED");
    if (permission !== "data.read" && isPeriodArchived(workspace, period)) throw fail("当前账期已经归档，只能查看", "AI_PERIOD_ARCHIVED");
    try {
      if (permission === "data.read") store.assertWorkspaceAccess(workspaceId, permission);
      else store.assertWorkspaceWritable(workspaceId, period, permission);
    } catch (error) { throw fail(error.message, "AI_ACCESS_DENIED"); }
    return workspace;
  }
  // Existing async financial operations also check the fixed target at their
  // final synchronous write, including cancellation while verifying originals.
  function scopedStore(signal, transform, beforeWrite) {
    return { ...store,
      assertWorkspaceAccess: (...args) => { target("data.read", signal); return store.assertWorkspaceAccess(...args); },
      assertWorkspaceWritable: (...args) => { target("data.read", signal); return store.assertWorkspaceWritable(...args); },
      actions: new Proxy(store.actions, { get(actions, key) {
        if (typeof actions[key] !== "function") return actions[key];
        return (...args) => {
          target("data.read", signal);
          beforeWrite?.();
          if (key === "replaceWorkspace" && transform) args[1] = transform(args[1]);
          return actions[key](...args);
        };
      } }),
    };
  }
  function conversation(workspace = target()) {
    return workspace.aiSimple?.conversations?.[period] || { messages: [], proposals: [] };
  }
  function withConversation(workspace, next) {
    return { ...workspace, aiSimple: { ...workspace.aiSimple, conversations: { ...workspace.aiSimple?.conversations, [period]: next } } };
  }
  function saveConversation(updater, permission = "data.write") {
    const workspace = target(permission);
    store.actions.replaceWorkspace(workspaceId, withConversation(workspace, updater(conversation(workspace))), { period, requiredPermission: permission });
  }
  function documentFor(id, workspace = target()) {
    const document = workspace.documents.find((item) => item.id === id && item.period === period);
    if (!document) throw fail("找不到当前工作台本期的资料", "AI_DOCUMENT_NOT_FOUND");
    return document;
  }
  function transactionFor(id, workspace = target()) {
    const transaction = workspace.transactions.find((item) => item.id === id && String(item.date || "").slice(0, 7) === period);
    if (!transaction) throw fail("找不到当前工作台本期的流水", "AI_TRANSACTION_NOT_FOUND");
    return transaction;
  }
  function sourceFingerprint(kind, payload, workspace = target()) {
    if (kind === "document_fields") return documentVersion(documentFor(payload.documentId, workspace));
    if (kind === "bank_import") {
      const document = documentFor(payload.documentId, workspace);
      return JSON.stringify({ document: documentVersion(document), account: workspace.bankAccounts.find((item) => item.id === payload.accountId),
        imports: workspace.bankImports.filter((item) => item.accountId === payload.accountId && item.period === period && item.fileHash === document.hash) });
    }
    const transaction = transactionFor(payload.transactionId, workspace);
    const relatedTransaction = payload.relatedTransactionId ? transactionFor(payload.relatedTransactionId, workspace) : null;
    const ids = new Set([...(transaction.evidenceIds || []), ...(payload.evidenceIds || []), ...(relatedTransaction?.evidenceIds || [])]);
    const bill = payload.relatedBillId ? workspace.bills.find((item) => item.id === payload.relatedBillId) : null;
    (bill?.evidenceIds || []).forEach((id) => ids.add(id));
    return JSON.stringify({ transaction, relatedTransaction, bill, documents: workspace.documents.filter((item) => ids.has(item.id)),
      events: workspace.businessEvents.filter((item) => item.transactionId === transaction.id),
      vouchers: workspace.vouchers.filter((item) => item.sourceIds?.includes(transaction.id) || item.bankBusinessEventId === transaction.bankBusinessEventId),
      accounts: workspaceAccountDefinitions(workspace), rules: workspace.ruleSets });
  }
  function addProposal(kind, payload, { title, summary, preview, sourceIds }, permission = "data.write", revision = null) {
    const workspace = target(permission);
    if (revision) assertProposalCurrent(revision);
    const fingerprint = sourceFingerprint(kind, payload, workspace);
    const prior = conversation(workspace).proposals.find((item) => item.status === "pending" && item.kind === kind
      && item.fingerprint === fingerprint && JSON.stringify(item.payload) === JSON.stringify(payload));
    if (prior && !revision) return publicProposal(prior);
    const revisedAt = stamp();
    const actor = revision ? store.assertWorkspaceAccess(workspaceId, "data.read") : null;
    const proposal = { id: createId("ai-proposal"), kind, status: "pending", title, summary: safeText(summary, 4000),
      preview: copy(preview), sourceIds, createdAt: revisedAt, payload: copy(payload), fingerprint,
      ...(revision ? { revisesProposalId: revision.id, revisedAt, revisedBy: actor?.name || "本地用户" } : {}) };
    saveConversation((current) => ({ ...current, proposals: [...current.proposals.map((item) => item.id === revision?.id
      ? { ...item, status: "superseded", supersededBy: proposal.id, supersededAt: revisedAt } : item), proposal] }), permission);
    return publicProposal(proposal);
  }
  function proposalFor(id) {
    const proposal = conversation().proposals.find((item) => item.id === id);
    if (!proposal) throw fail("找不到待确认事项", "AI_PROPOSAL_NOT_FOUND");
    return proposal;
  }
  function assertProposalCurrent(proposal, signal) {
    const workspace = target(proposal.kind === "document_fields" ? "documents.add" : "data.write", signal);
    if (proposalFor(proposal.id).status !== "pending") throw fail("该事项已处理，请查看最新状态", "AI_PROPOSAL_CHANGED");
    if (sourceFingerprint(proposal.kind, proposal.payload, workspace) !== proposal.fingerprint) throw fail("来源或人工填写内容已变化，请让助手重新整理后确认", "AI_SOURCE_CHANGED");
    return workspace;
  }
  function appliedWorkspace(workspace, proposal, result, message) {
    const current = conversation(workspace);
    const actor = store.assertWorkspaceAccess(workspaceId, "data.read");
    return withConversation(workspace, { ...current, proposals: current.proposals.map((item) => item.id === proposal.id
      ? { ...item, status: "applied", appliedAt: stamp(), appliedBy: actor?.name || "本地用户", result: copy(result), message } : item) });
  }
  function appliedResponse(id) {
    const proposal = proposalFor(id);
    return { proposal: publicProposal(proposal), result: proposal.result, message: proposal.message, ...(proposal.result?.voucherId ? { voucherId: proposal.result.voucherId } : {}) };
  }

  function getContext(section = "overview", { offset = 0 } = {}) {
    validateValue({ section, offset }, AI_FINANCE_TOOLS[0].function.parameters);
    const workspace = target();
    const documents = workspace.documents.filter((item) => item.period === period);
    const transactions = workspace.transactions.filter((item) => String(item.date || "").slice(0, 7) === period);
    const vouchers = workspace.vouchers.filter((item) => periodOf(item) === period);
    const sourceIds = new Set([...documents, ...transactions, ...vouchers].map((item) => item.id));
    const tasks = (workspace.exceptionTasks || []).filter((item) => periodOf(item) === period || (!periodOf(item) && sourceIds.has(item.sourceId)));
    const context = { workspaceId, name: workspace.name, period, archived: isPeriodArchived(workspace, period) };
    const options = { businessTypes: manualBusinessEventTypesForWorkspace(workspace), accounts: workspace.bankAccounts,
      chartOfAccounts: workspaceAccountDefinitions(workspace), taxTreatments: BUSINESS_EVENT_TAX_TREATMENTS, invoiceStatuses: BUSINESS_EVENT_INVOICE_STATUSES };
    if (section === "overview") return copy({ ...context, ...options, counts: { documents: documents.length, transactions: transactions.length,
      vouchers: vouchers.length, postedVouchers: vouchers.filter((item) => item.status === "posted").length, pendingTasks: tasks.filter((item) => item.status !== "resolved").length },
      pendingTasks: tasks.filter((item) => item.status !== "resolved").slice(0, 30), proposals: conversation(workspace).proposals.filter((item) => item.status === "pending").map(publicProposal) });
    if (section === "reports") return copy({ ...context, reports: buildFinancialStatements(workspace, { period }), tax: buildTaxWorkpaper(workspace, { period }) });
    const lists = { documents, transactions, tasks, vouchers, accounts: workspace.bankAccounts };
    const items = lists[section];
    return copy({ ...context, items: items.slice(offset, offset + 50), total: items.length, offset, nextOffset: offset + 50 < items.length ? offset + 50 : null,
      ...(section === "transactions" ? { options, relatedBills: workspace.bills.filter((item) => periodOf(item) && periodOf(item) <= period && !["cancelled", "void"].includes(item.status)).slice(0, 100) } : {}) });
  }

  function getAssistantContext(section = "overview", options = {}) {
    const context = getContext(section, options);
    const compactOptions = (source) => ({
      accounts: (source.accounts || []).map((item) => select(item, ["id", "name", "accountNumber", "status"])),
      chartOfAccounts: (source.chartOfAccounts || []).map((item) => select(item, ["id", "label", "category", "status"])),
      businessTypes: (source.businessTypes || []).map((item) => select(item, ["id", "label", "account", "allowedDirections", "billKinds", "referenceMode", "referenceLabel", "taxTreatments", "fixedTaxTreatment", "invoiceRequired", "relatedTransactionRole"])),
      taxTreatments: source.taxTreatments, invoiceStatuses: source.invoiceStatuses,
    });
    const base = select(context, ["workspaceId", "name", "period", "archived", "counts"]);
    if (section === "overview") {
      const workspace = target();
      const current = conversation(workspace);
      const lastUser = current.messages.findLast((message) => message.role === "user");
      return copy({ ...base, ...compactOptions(context),
        pendingTasks: context.pendingTasks.slice(0, 10).map((item) => select(item, ["id", "code", "message", "sourceId", "status"])),
        proposals: current.proposals.slice(-12).map(proposalSummary),
        recentDocuments: workspace.documents.filter((item) => item.period === period).slice(-12).map(documentSummary),
        recentTransactions: workspace.transactions.filter((item) => String(item.date || "").slice(0, 7) === period).slice(-10).map(transactionSummary),
        latestRequest: lastUser ? { content: safeText(lastUser.content, 4000), attachments: lastUser.attachments } : null,
        coverage: "仅含近期对象；需要更多本期资料时按section和offset查询，不能将摘要当成全部账务。" });
    }
    if (section === "reports") return copy({ ...base, reports: select(context.reports, ["period", "balanceSheet", "incomeStatement", "cashFlow", "checks"]),
      postingBasis: "报表按现有财务核心计算，待确认建议和未入账草稿不作为已入账数据。" });
    const compact = { documents: documentSummary, transactions: transactionSummary,
      tasks: (item) => select(item, ["id", "code", "message", "sourceId", "status", "missingEvidence"]),
      vouchers: (item) => select(item, ["id", "no", "date", "period", "summary", "status", "lines", "sourceIds", "evidenceIds", "blockers"]),
      accounts: (item) => select(item, ["id", "name", "accountNumber", "status", "openingBalance", "statementClosing"]) }[section];
    const items = context.items.slice(0, 20).map(compact);
    return copy({ ...base, items, total: context.total, offset: context.offset, nextOffset: context.offset + items.length < context.total ? context.offset + items.length : null,
      ...(context.options ? { options: compactOptions(context.options), relatedBills: context.relatedBills.slice(0, 30).map((item) => select(item, ["id", "no", "kind", "counterparty", "date", "amount", "summary", "status"])) } : {}) });
  }

  async function readOriginal(documentId, { signal } = {}) {
    const document = documentFor(documentId, target("data.read", signal));
    const before = documentVersion(document);
    let record;
    try {
      await verifyStoredDocumentOriginal({ fileVault, workspaceId, document });
      record = await getStoredDocumentRecord({ fileVault, workspaceId, document });
    } catch (error) { target("data.read", signal); throw fail(error.message, "AI_ORIGINAL_UNAVAILABLE"); }
    if (documentVersion(documentFor(documentId, target("data.read", signal))) !== before) throw fail("资料原件已变化，请重新打开", "AI_SOURCE_CHANGED");
    return { ...record, documentId, name: document.name, mimeType: document.mimeType || record.blob.type };
  }
  async function readDocument(documentId, signal) {
    await readOriginal(documentId, { signal });
    const document = documentFor(documentId);
    const recognition = await getLocalDocumentRecognition({ fileVault, workspaceId, document });
    if (documentVersion(documentFor(documentId, target("data.read", signal))) !== documentVersion(document)) throw fail("资料已变化，请重新读取", "AI_SOURCE_CHANGED");
    const result = recognition?.result;
    return copy({ documentId, name: document.name, period, category: document.category, version: document.version, hash: document.hash,
      fields: document.structuredData, allowedFields: fieldNames[document.structuredData?.kind] || [], recognitionStatus: document.contentRecognition?.ocrStatus || "not_started",
      text: safeText(result?.text, 24000), truncated: (result?.text?.length || 0) > 24000,
      pages: (result?.pages || []).slice(0, 30).map(({ pageNumber }) => ({ pageNumber })), suggestedFields: document.contentRecognition?.suggestedFields || {} });
  }
  async function uploadFiles(files, { signal, onProgress } = {}) {
    const uploaded = [];
    const selected = Array.from(files || []);
    if (!selected.length || selected.length > 20) throw fail("一次请选择1至20个文件");
    try {
      for (const file of selected) {
        target("documents.add", signal);
        if (!(file instanceof Blob) || !file.size || file.size > 30 * 1024 * 1024) throw fail("请选择不超过30MB的非空文件");
        const name = file.name || "上传资料";
        const bank = /\.(csv|xlsx|xls)$/i.test(name);
        const recognized = /\.(pdf|png|jpe?g|webp|bmp|tiff?)$/i.test(name) || /^(image\/|application\/pdf)/.test(file.type);
        if (!bank && !recognized) throw fail(`暂不支持 ${name}，请选择银行CSV/Excel或票据PDF/图片`);
        onProgress?.({ stage: "saving", name, index: uploaded.length, total: selected.length });
        const hash = await hashLocalFile(file);
        let document = target("documents.add", signal).documents.find((item) => item.period === period && item.hash === hash && item.category === (bank ? "银行流水" : "发票"));
        if (document) await readOriginal(document.id, { signal });
        else document = await saveLocalDocument({ store: scopedStore(signal), fileVault, workspaceId, file,
          metadata: { category: bank ? "银行流水" : "发票", period, name }, isCurrent: () => { target("documents.add", signal); return true; } });
        const attachment = { documentId: document.id, name: document.name, kind: bank ? "bank" : "document", recognitionStatus: document.contentRecognition?.ocrStatus || "not_started" };
        uploaded.push(attachment);
        if (recognized && attachment.recognitionStatus !== "completed") {
          try {
            const { recognizeLocalDocument } = await import("../features/intake/localDocumentRecognition.js");
            target("documents.add", signal);
            const result = await recognizeLocalDocument({ blob: file, name, mimeType: file.type, category: document.category, signal,
              onProgress: (progress) => onProgress?.({ ...progress, name, documentId: document.id }) });
            await saveLocalDocumentRecognition({ store: scopedStore(signal), fileVault, workspaceId, documentId: document.id, period,
              sourceVersion: document.version, sourceHash: document.hash, category: document.category, result, signal,
              isCurrent: () => { target("documents.add", signal); return true; } });
            attachment.recognitionStatus = "completed";
          } catch (error) {
            if (!signal?.aborted && error.name !== "AbortError") {
              attachment.recognitionStatus = "failed";
              attachment.recognitionError = safeText(error.message, 500);
              try {
                const workspace = target("documents.add", signal);
                const current = documentFor(document.id, workspace);
                if (current.hash === document.hash && current.version === document.version && current.contentRecognition?.ocrStatus !== "completed") {
                  store.actions.replaceWorkspace(workspaceId, { ...workspace, documents: workspace.documents.map((item) => item.id === document.id
                    ? { ...item, contentRecognition: { ...item.contentRecognition, ocrStatus: "failed", error: attachment.recognitionError } } : item) }, { period, requiredPermission: "documents.add" });
                }
              } catch { error.recognitionStatusSaved = false; }
            }
            throw error;
          }
        }
      }
      return uploaded;
    } catch (error) { error.uploaded = uploaded; throw error; }
  }

  async function bankPlan(payload, signal, callback, beforeWrite) {
    const document = documentFor(payload.documentId, target("data.write", signal));
    if (!target().bankAccounts.some((account) => account.id === payload.accountId)) throw fail("请先在当前工作台添加或选择银行账户", "AI_BANK_ACCOUNT_REQUIRED");
    if (document.category !== "银行流水") throw fail("请选择已上传的银行CSV或Excel原件");
    if (payload.mapping) for (const key of Object.keys(payload.mapping)) if (!Object.hasOwn(BANK_FIELD_DEFINITIONS, key)) throw fail(`不支持的银行列：${key}`);
    const original = await readOriginal(document.id, { signal });
    const bank = createFinanceDeskService({ store: scopedStore(signal, null, beforeWrite), fileVault });
    const file = await bank.registerBankFile(original.blob, { workspaceId, fileName: document.name, sourceDocumentId: document.id, exactMapping: payload.mapping !== undefined, signal });
    try {
      target("data.write", signal);
      const inspection = inspectBankTable(file.table, { mapping: payload.mapping, exactMapping: payload.mapping !== undefined });
      if (inspection.missingFields.length) return await callback({ bank, plan: null, file, document, inspection });
      const plan = bank.prepareBankImport({ workspaceId, period, accountId: payload.accountId, fileRef: file.fileRef, ...(payload.mapping ? { mapping: payload.mapping } : {}) });
      return await callback({ bank, plan, file, document, inspection });
    } finally { bank.releaseBankFile(file.fileRef); }
  }
  async function prepareImport(input, signal, revision = null) {
    return bankPlan(input, signal, ({ plan, document, inspection }) => {
      if (!plan) return { status: "needs_mapping", message: "请根据原文件表头和样例行指定缺少的列映射", preview: {
        fileName: document.name, headers: inspection.headers, mapping: inspection.mapping, missingFields: inspection.missingFields,
        rows: inspection.preview, mappingFields: BANK_FIELD_DEFINITIONS } };
      const preview = { fileName: document.name, accountId: input.accountId, accountName: target().bankAccounts.find((item) => item.id === input.accountId)?.name,
        headers: inspection.headers, mapping: inspection.mapping, mappingFields: BANK_FIELD_DEFINITIONS,
        importedCount: plan.importableRowCount, duplicateCount: plan.duplicateCount, errorCount: plan.errorCount,
        transactions: plan.transactions.slice(0, 20), errors: plan.errors.slice(0, 30), reconciliation: plan.reconciliation };
      if (plan.errorCount || (!plan.importableRowCount && !plan.duplicateCount)) return { status: "needs_correction", preview, message: "请先核对文件与列映射，尚未创建导入确认事项" };
      const proposal = addProposal("bank_import", { ...input, mapping: preview.mapping }, { title: `导入 ${document.name}`,
        summary: `${plan.importableRowCount}笔可导入，${plan.duplicateCount}笔重复；确认后保存流水。`, preview, sourceIds: [document.id] }, "data.write", revision);
      return { status: "pending_confirmation", proposal };
    });
  }
  function businessInput(input, workspace = target()) {
    transactionFor(input.transactionId, workspace);
    input.evidenceIds.forEach((id) => documentFor(id, workspace));
    if (input.relatedTransactionId) transactionFor(input.relatedTransactionId, workspace);
    if (input.relatedBillId && !workspace.bills.some((item) => item.id === input.relatedBillId && periodOf(item) && periodOf(item) <= period)) throw fail("所选账单不属于可用业务来源");
    return { ...input, businessPeriod: period, reason: safeText(input.reason, 4000) };
  }
  function proposeBusiness(input, revision = null) {
    const workspace = target("data.write");
    const payload = businessInput(input, workspace);
    const prepared = confirmBankTransactionBusinessEvent(workspace, payload, { actor: "待用户确认的AI建议" });
    const transaction = transactionFor(input.transactionId, prepared);
    const event = prepared.businessEvents.find((item) => item.id === transaction.bankBusinessEventId);
    let voucher = null;
    let draftIssue = null;
    try {
      const draft = createVoucherDraft(prepared, { transactionId: transaction.id });
      voucher = draft.vouchers.find((item) => item.id === draft.businessEvents.find((item) => item.id === event?.id)?.draftVoucherId) || draft.vouchers.find((item) => item.bankBusinessEventId === event?.id);
    } catch (error) { draftIssue = { code: error.code, message: error.message }; }
    const preview = { transaction: copy(transactionFor(input.transactionId, workspace)), businessType: input.businessType,
      businessTypeLabel: manualBusinessEventTypesForWorkspace(workspace).find((item) => item.id === input.businessType)?.label,
      account: input.account, accountLabel: workspaceAccountDefinitions(workspace).find((item) => item.id === input.account)?.label,
      taxTreatment: input.taxTreatment, invoiceStatus: input.invoiceStatus, reason: payload.reason, evidenceIds: input.evidenceIds,
      relatedBillId: input.relatedBillId, referenceNo: input.referenceNo, counterparty: input.counterparty, relatedTransactionId: input.relatedTransactionId,
      event, voucher, draftIssue };
    return { status: "pending_confirmation", proposal: addProposal("bank_business", payload, { title: `确认${preview.businessTypeLabel || "流水归属"}`,
      summary: `${transaction.date} · ${transaction.counterparty || "对手待补充"} · ${transaction.amount}；${payload.reason}`, preview,
      sourceIds: [transaction.id, ...input.evidenceIds, ...[input.relatedBillId, input.relatedTransactionId].filter(Boolean)] }, "data.write", revision) };
  }
  async function proposeFields(input, signal, revision = null) {
    const contents = await readDocument(input.documentId, signal);
    target("documents.add", signal);
    const keys = Object.keys(input.fields);
    if (!keys.length || keys.some((key) => !contents.allowedFields.includes(key))) throw fail("请只使用这份票据允许的候选字段");
    if (!contents.text.trim()) throw fail("原件还没有可用识别文字，请先完成本地识别或人工填写");
    if (Object.values(input.fields).some((value) => typeof value === "string" && safeText(value) !== value)) throw fail("候选字段包含不应保存的内容");
    const document = documentFor(input.documentId);
    let normalized;
    try { normalized = normalizeDocumentStructuredData(document.category, { ...document.structuredData, ...input.fields }); }
    catch (error) { throw fail(error.message); }
    const fields = Object.fromEntries(keys.map((key) => [key, normalized[key]]));
    const payload = { documentId: input.documentId, fields, reason: safeText(input.reason, 4000) };
    return { status: "pending_confirmation", proposal: addProposal("document_fields", payload, { title: `核对 ${document.name}`,
      summary: payload.reason, sourceIds: [document.id], preview: { documentId: document.id, name: document.name, category: document.category, allowedFields: contents.allowedFields,
        fields: keys.map((key) => ({ key, before: document.structuredData?.[key] ?? null, after: fields[key] })), reason: payload.reason } }, "documents.add", revision) };
  }

  async function reviseProposal(id, updates, { signal } = {}) {
    const original = proposalFor(id);
    assertProposalCurrent(original, signal);
    if (confirming.has(id) || revising.has(id)) throw fail("该事项正在处理，请完成当前操作后再修改", "AI_PROPOSAL_BUSY");
    const key = { bank_import: "mapping", document_fields: "fields", bank_business: "classification" }[original.kind];
    if (!key || !updates || Array.isArray(updates) || Object.keys(updates).length !== 1 || !Object.hasOwn(updates, key)
      || !updates[key] || typeof updates[key] !== "object" || Array.isArray(updates[key])) throw fail("请只修改本类建议允许的字段");
    const tool = { bank_import: "prepare_bank_import", document_fields: "propose_document_fields", bank_business: "propose_bank_business" }[original.kind];
    const schema = AI_FINANCE_TOOLS.find((item) => item.function.name === tool).function.parameters;
    let input = copy(original.payload);
    if (key === "classification") {
      for (const field of Object.keys(updates.classification)) if (field === "transactionId" || !Object.hasOwn(schema.properties, field)) throw fail(`不能修改流水来源、金额、账期或此字段：${field}`);
      input = { ...input, ...updates.classification };
      delete input.businessPeriod;
      for (const field of ["relatedBillId", "referenceNo", "relatedTransactionId"]) if (input[field] === "") delete input[field];
    } else input[key] = key === "mapping" ? { ...updates.mapping }
      : Object.fromEntries(Object.entries({ ...input.fields, ...updates.fields }).map(([field, value]) => [field, value === null ? "" : value]));
    validateValue(input, schema);
    revising.add(id);
    try {
      if (key === "mapping") return await prepareImport(input, signal, original);
      if (key === "fields") return await proposeFields(input, signal, original);
      for (const documentId of new Set([...original.payload.evidenceIds, ...input.evidenceIds])) await readOriginal(documentId, { signal });
      assertProposalCurrent(original, signal);
      return proposeBusiness(input, original);
    } finally { revising.delete(id); }
  }

  async function applyProposal(id, { reason, signal } = {}) {
    const proposal = proposalFor(id);
    if (proposal.status === "applied") return appliedResponse(id);
    let workspace = assertProposalCurrent(proposal, signal);
    if (proposal.kind === "bank_import") {
      const result = await bankPlan(proposal.payload, signal, async ({ bank, plan }) => {
        assertProposalCurrent(proposal, signal);
        if (!plan) throw fail("银行列映射已失效，请重新整理");
        return bank.executeBankImport({ workspaceId, planId: plan.planId });
      }, () => assertProposalCurrent(proposal, signal));
      workspace = target("data.write", signal);
      const message = `已导入${result.counts.imported}笔流水，跳过${result.counts.duplicates}笔重复；尚未入账。`;
      store.actions.replaceWorkspace(workspaceId, appliedWorkspace(workspace, proposal, result, message), { period, requiredPermission: "data.write" });
    } else if (proposal.kind === "bank_business") {
      const user = store.assertWorkspaceWritable(workspaceId, period, "data.write");
      const context = { actor: user?.name || "本地用户", at: stamp(), mode: "manual" };
      const input = businessInput(proposal.payload, workspace);
      let next = confirmBankTransactionBusinessEvent(workspace, { ...input, reason: safeText(reason || input.reason, 4000) }, context);
      let draftIssue = null;
      try { next = createVoucherDraft(next, { transactionId: input.transactionId }, context); }
      catch (error) { draftIssue = { code: error.code, message: error.message }; }
      const event = next.businessEvents.find((item) => item.id === transactionFor(input.transactionId, next).bankBusinessEventId);
      const voucher = next.vouchers.find((item) => item.id === event?.draftVoucherId) || next.vouchers.find((item) => item.bankBusinessEventId === event?.id && item.status !== "invalidated");
      const result = { transactionId: input.transactionId, businessEventId: event?.id, voucherId: voucher?.id, voucher, draftIssue };
      const message = voucher ? "已确认业务并生成凭证草稿，请核对原件和分录后入账。" : `已确认业务；凭证待补充：${draftIssue?.message || "请在凭证中查看所需资料"}`;
      store.actions.replaceWorkspace(workspaceId, appliedWorkspace(next, proposal, result, message), { period, requiredPermission: "data.write" });
    } else if (proposal.kind === "document_fields") {
      await readOriginal(proposal.payload.documentId, { signal });
      workspace = assertProposalCurrent(proposal, signal);
      const document = documentFor(proposal.payload.documentId, workspace);
      const result = { documentId: document.id, fields: proposal.payload.fields };
      const message = "票据字段已按本次确认保存；业务归属和入账仍需单独确认。";
      updateLocalDocumentMetadata({ store: scopedStore(signal, (next) => appliedWorkspace(next, proposal, result, message)), workspaceId, documentId: document.id,
        patch: { structuredData: proposal.payload.fields }, note: safeText(reason || proposal.payload.reason, 4000),
        audit: { action: "确认AI票据字段", detail: safeText(reason || proposal.payload.reason, 4000) } });
    } else throw fail("不支持的确认事项");
    return appliedResponse(id);
  }

  return {
    getContext, getAssistantContext, uploadFiles, readOriginal, reviseProposal,
    getConversation() { const current = conversation(); return { messages: copy(current.messages), proposals: current.proposals.map(publicProposal) }; },
    appendMessage(input) {
      if (!input || !["user", "assistant"].includes(input.role) || typeof input.content !== "string") throw fail("对话角色或内容不正确");
      const attachments = (input.attachments || []).map(({ documentId }) => {
        const document = documentFor(documentId);
        return { documentId, name: document.name, kind: document.category === "银行流水" ? "bank" : "document" };
      });
      const message = { id: createId("ai-message"), role: input.role, content: safeText(input.content), attachments, createdAt: stamp() };
      const metadata = input.modelMetadata;
      if (input.role === "assistant" && isDeepSeekModelId(metadata?.requestedModel) && ["enabled", "disabled"].includes(metadata?.thinking)) {
        message.modelMetadata = { requestedModel: metadata.requestedModel, responseModel: isDeepSeekModelId(metadata.responseModel) ? metadata.responseModel : null,
          thinking: metadata.thinking, reasoningEffort: metadata.thinking === "enabled" && DEEPSEEK_REASONING_EFFORTS.includes(metadata.reasoningEffort) ? metadata.reasoningEffort : null };
      }
      if (!message.content.trim() && !attachments.length) throw fail("请输入内容或上传资料");
      saveConversation((current) => ({ ...current, messages: [...current.messages, message] }), "documents.add");
      return copy(message);
    },
    async invokeTool(name, input, { signal } = {}) {
      target("data.read", signal);
      const schema = AI_FINANCE_TOOLS.find((item) => item.function.name === name)?.function.parameters;
      if (!schema) throw fail("不支持的AI工具", "AI_UNKNOWN_TOOL");
      try {
        validateValue(input, schema);
        if (name === "get_context") return getAssistantContext(input.section, { offset: input.offset });
        if (name === "read_document") return await readDocument(input.documentId, signal);
        if (name === "prepare_bank_import") return await prepareImport(input, signal);
        if (name === "propose_bank_business") return proposeBusiness(input);
        return await proposeFields(input, signal);
      } catch (error) {
        target("data.read", signal);
        if (!recoverableToolCodes.has(error.code)) throw error;
        return { ok: false, status: "needs_input", error: { code: error.code, message: safeText(error.message, 1000), recoverable: true,
          requiredFields: schema.required, allowedFields: Object.keys(schema.properties), ...(error.details?.field ? { field: error.details.field } : {}) },
          nextAction: "依据已读取的真实资料修正缺项后可重新调用；没有依据就向用户说明缺什么，不能猜测，也不能自动确认或入账。" };
      }
    },
    confirmProposal(id, options = {}) {
      if (revising.has(id)) return Promise.reject(fail("正在重新计算预览，请完成修改后再确认", "AI_PROPOSAL_BUSY"));
      if (confirming.has(id)) return confirming.get(id);
      const pending = applyProposal(id, options).finally(() => confirming.delete(id));
      confirming.set(id, pending);
      return pending;
    },
    dismissProposal(id) {
      const proposal = proposalFor(id);
      if (proposal.status !== "pending") return publicProposal(proposal);
      saveConversation((current) => ({ ...current, proposals: current.proposals.map((item) => item.id === id ? { ...item, status: "dismissed", dismissedAt: stamp() } : item) }), proposal.kind === "document_fields" ? "documents.add" : "data.write");
      return publicProposal(proposalFor(id));
    },
    async postVoucher({ voucherId, reviewNote, signal }) {
      target("data.write", signal);
      return postWorkspaceVoucher({ store: scopedStore(signal), fileVault }, { workspaceId, period, voucherId, reviewNote });
    },
    createBankAccount({ name, accountNumber = "" }) {
      target("data.write");
      if (typeof name !== "string" || !name.trim()) throw fail("请填写银行账户名称");
      return copy(store.actions.upsertEntity(workspaceId, "bankAccounts", { name: name.trim(), accountNumber: String(accountNumber).trim(), openingBalance: null, statementClosing: null, status: "active" }, { period }));
    },
  };
}
