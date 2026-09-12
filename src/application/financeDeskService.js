import { createId, getWorkspace } from "../domain/foundation.js";
import { activateWorkspacePeriod, isPeriodArchived, validAccountingPeriod } from "../domain/periods.js";
import { BANK_FIELD_DEFINITIONS, bankExceptionTasksForPeriod, buildBankMonthlyReconciliation, inspectBankSourceGroups, matchBankSourceAccounts, prepareBankImport, readBankFile, transactionDedupeKey, validateBankImportOptions } from "../features/intake/bankStatementImport.js";
import { removeLocalDocument, saveLocalDocument, verifyStoredDocumentOriginal } from "../features/intake/documentIntake.js";
import { accountingRules, collectSourceIds, workspaceAccountDefinitions } from "../domain/accounting/model.js";
import { prepareVoucherPosting, reviseDraftVoucher } from "../domain/accounting/vouchers.js";
import { attachReceipt, importLocalReceipt } from "../productWorkflow.js";
import { advanceBalance, billSettlement, reverseAdvanceApplication } from "../features/reconciliation/reconciliationEngine.js";
import { settlementPeriodEnd } from "../features/reconciliation/settlementRecognition.js";

const string = { type: "string", minLength: 1 };
const target = { workspaceId: string, period: { type: "string", pattern: "^[1-9]\\d{3}-(0[1-9]|1[0-2])$" } };
const voucherTarget = { ...target, voucherId: string };
const voucherEdits = { type: "object", properties: {
  summary: string, reason: string, lines: { type: "array", items: { type: "object" } },
  evidenceIds: { type: "array", items: string }, sourceIds: { type: "array", items: string }, basis: { type: "object" },
}, additionalProperties: false };
const definition = (name, description, properties, required, resultFields) => ({
  name, description, parameters: { type: "object", properties, required, additionalProperties: false }, resultFields,
});

// Only these operations accept serialized tool parameters. Files and identities
// enter through the trusted local host, outside this operation catalogue.
export const FINANCE_DESK_OPERATIONS = [
  definition("listWorkspaces", "列出可读取工作台", {}, [], ["workspaces"]),
  definition("getWorkspaceContext", "查询指定工作台和账期的账户及导入记录", target, ["workspaceId", "period"], ["workspaceId", "period", "archived", "periods", "accounts", "imports"]),
  definition("getVoucherContext", "读取指定账期凭证、补件和可用操作", voucherTarget, ["workspaceId", "period", "voucherId"], ["workspaceId", "period", "voucher", "missingItems", "nextActions"]),
  definition("postVoucher", "核验原件后按最新目标工作台入账，可同时保存分录修订", { ...voucherTarget, reviewNote: string, edits: voucherEdits }, ["workspaceId", "period", "voucherId", "reviewNote"], ["workspaceId", "period", "voucher", "missingItems", "nextActions"]),
  definition("reverseAdvanceApplication", "撤回指定账期尚未入账的预收/预付冲销，恢复余额并保留撤回历史", { ...target, applicationId: string, reason: string }, ["workspaceId", "period", "applicationId", "reason"], ["workspaceId", "period", "application", "advance", "target", "cancelledVoucherIds"]),
  definition("importReceipt", "把本地回执原件登记到指定申报包，保存后再次确认包与原件归属", { ...target, fileRef: string, packageId: string, packageHash: string, reportVersionId: string }, ["workspaceId", "period", "fileRef", "packageId", "packageHash", "reportVersionId"], ["workspaceId", "period", "receipt"]),
  definition("prepareBankImport", "对已注册本地文件进行映射和导入预检查", {
    ...target, accountId: string, fileRef: string, sourceGroupId: string, mapping: { type: "object", properties: Object.fromEntries(Object.keys(BANK_FIELD_DEFINITIONS).map((field) => [field, { type: "integer", minimum: 0 }])), additionalProperties: false },
    openingBalance: { type: ["number", "string", "null"] }, statementClosing: { type: ["number", "string", "null"] },
    counterpartyMappings: { type: "object", additionalProperties: { type: "object", properties: {
      rawName: { type: "string" }, counterpartyAccount: { type: "string" }, standardName: { type: "string" },
      objectId: { type: ["string", "null"] }, objectType: { enum: ["manual", "counterparty", "personnelRecord"] },
      kind: { type: "string" }, targetKey: { type: "string" }, ruleId: { type: "string" }, createdAt: { type: "string" },
    }, additionalProperties: false } }, largeTransactionThreshold: { type: "number", minimum: 0 },
  }, ["workspaceId", "period", "accountId", "fileRef"], ["planId", "transactions", "errors", "duplicates", "reconciliation", "missingItems", "nextActions"]),
  definition("executeBankImport", "按最新工作台数据执行服务生成的导入计划", {
    workspaceId: string, planId: string,
  }, ["workspaceId", "planId"], ["status", "workspaceId", "period", "accountId", "importIds", "transactionIds", "documentIds", "counts", "import", "importSnapshots", "currentReconciliation", "missingItems", "nextActions"]),
  definition("getBankImportResult", "读取已保存的银行导入结果", {
    workspaceId: string, importId: string,
  }, ["workspaceId", "importId"], ["status", "workspaceId", "period", "accountId", "importIds", "transactionIds", "documentIds", "counts", "import", "importSnapshots", "currentReconciliation", "missingItems", "nextActions"]),
];

const jsonCopy = (value) => JSON.parse(JSON.stringify(value));
function failure(message, code = "INVALID_OPERATION_INPUT", details) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

function voucherFor(workspace, period, voucherId) {
  const voucher = workspace?.vouchers?.find((item) => item.id === voucherId && (item.period || item.date?.slice(0, 7)) === period);
  if (!voucher) throw failure("找不到目标工作台和账期的凭证", "VOUCHER_NOT_FOUND");
  return voucher;
}

function voucherResult(workspace, period, voucherId) {
  const voucher = voucherFor(workspace, period, voucherId);
  const missingItems = (workspace.exceptionTasks || []).filter((task) => task.sourceId === voucherId && task.status !== "resolved")
    .map(({ id, code, message }) => ({ id, code, message }));
  const nextActions = ["draft", "changes_requested"].includes(voucher.status) && !isPeriodArchived(workspace, period)
    ? [{ action: "review_voucher", workspaceId: workspace.id, period, voucherId }] : [];
  return jsonCopy({ workspaceId: workspace.id, period, voucher, missingItems, nextActions });
}

// Follow only financial records identified by this voucher and its sources.
// A company edit or an unrelated voucher is intentionally outside this snapshot.
function voucherPostingSources(workspace, voucher) {
  const voucherIds = (record) => collectSourceIds(record.id, record.sourceIds, record.relatedSourceIds, record.evidenceIds,
    record.revisionOf, record.memberEventId, record.bankBusinessEventId, record.advanceApplicationId, record.inventoryMovementId,
    record.basis?.voucherIds, record.basis?.calculationDocumentId,
    record.businessReferences?.map((item) => item.id), record.relatedSources?.map((item) => item.id), record.sourceReferences?.map((item) => item.id),
    record.lines?.map((line) => [line.sourceIds, line.billId]), record.reconciliationSources?.map((item) => [item.id, item.billId]),
    record.reconciliationCorrection?.transactionId, record.reconciliationCorrection?.originalAllocation?.id,
    record.reconciliationCorrection?.originalAllocation?.billId, record.reconciliationCorrection?.replacement?.billId);
  const references = (collection, record) => {
    if (collection === "documents") return []; // An original's relatedObjectIds are reverse links, not posting inputs.
    if (collection === "vouchers") return voucherIds(record);
    return collectSourceIds(record.sourceIds, record.evidenceIds, record.documentIds, record.sourceDocumentId,
      record.transactionId, record.allocationId, record.billId, record.relatedBillId, record.advanceBillId, record.targetBillId,
      record.contractId, record.invoiceId, record.memberId, record.personnelRecordId, record.itemId,
      record.originalRechargeId, record.commissionEventId, record.commissionSourceIds,
      record.allocations?.map((allocation) => [allocation.id, allocation.billId]),
      record.voucherSource?.lines?.map((line) => line.sourceIds));
  };
  const ids = new Set(voucherIds(voucher));
  const records = ["transactions", "businessEvents", "bills", "advanceApplications", "vouchers", "documents", "contracts", "invoices", "approvals", "inventoryItems", "inventoryMovements", "members", "personnelRecords", "payrollRecords", "payrollImports"]
    .flatMap((collection) => (workspace[collection] || []).map((record) => ({ collection, record })));
  const selected = new Map();
  let added = true;
  while (added) {
    added = false;
    for (const { collection, record } of records) {
      const key = `${collection}/${record.id}`;
      if (selected.has(key) || !(ids.has(record.id) || (collection === "transactions" && (record.allocations || []).some((item) => ids.has(item.id)))
        || (voucher.payrollAccrual && ["payrollRecords", "payrollImports"].includes(collection) && (record.period || record.date?.slice(0, 7)) === voucher.period))) continue;
      selected.set(key, record);
      references(collection, record).forEach((id) => ids.add(id));
      added = true;
    }
  }
  const links = (workspace.evidenceLinks || []).filter((link) => (link.objectIds || []).some((id) => ids.has(id)));
  const accountIds = new Set((voucher.lines || []).map((line) => line.account));
  const rules = accountingRules(workspace);
  return JSON.stringify({ records: [...selected].sort(([left], [right]) => left.localeCompare(right)), links,
    accounts: workspaceAccountDefinitions(workspace).filter((account) => accountIds.has(account.id)),
    rules: { amountTolerance: rules.amountTolerance, confidenceThreshold: rules.confidenceThreshold, automaticPostingThreshold: rules.automaticPostingThreshold } });
}

export async function postWorkspaceVoucher({ store, fileVault }, input) {
  const { workspaceId, period, voucherId, reviewNote, edits } = input || {};
  if (!workspaceId || !voucherId || !validAccountingPeriod(period) || typeof reviewNote !== "string" || !reviewNote.trim()) throw failure("请指定工作台、账期、凭证及复核意见");
  for (const key of Object.keys(input)) if (!["workspaceId", "period", "voucherId", "reviewNote", "edits"].includes(key)) throw failure(`不支持的参数：${key}`);
  if (edits != null) {
    if (typeof edits !== "object" || Array.isArray(edits)) throw failure("分录修订必须是对象");
    for (const key of Object.keys(edits)) if (!Object.hasOwn(voucherEdits.properties, key)) throw failure(`不支持的分录修订参数：${key}`);
    if (edits.lines != null && !Array.isArray(edits.lines)) throw failure("分录必须是数组");
  }
  const initial = getWorkspace(store.getState(), workspaceId);
  const originalVoucher = voucherFor(initial, period, voucherId);
  const permission = originalVoucher.payrollAccrual ? "confirm.finance" : "data.write";
  const user = store.assertWorkspaceWritable(workspaceId, period, permission);
  const actorId = user?.id || null;
  const context = { actor: user?.name || "本地用户", at: new Date().toISOString(), fileVault };
  const parameters = jsonCopy({ voucherId, reviewNote, mode: "manual" });
  const patch = edits ? jsonCopy(edits) : null;
  const prepare = (workspace) => {
    const targetWorkspace = activateWorkspacePeriod(workspace, period);
    return patch ? reviseDraftVoucher(targetWorkspace, { ...patch, voucherId, reason: patch.reason || reviewNote }, context) : targetWorkspace;
  };
  const prepared = prepare(initial);
  const effectiveVoucher = voucherFor(prepared, period, voucherId);
  const sources = voucherPostingSources(initial, effectiveVoucher);
  const originalVersion = JSON.stringify(originalVoucher);
  const postVerified = await prepareVoucherPosting(prepared, parameters, context);
  const latestUser = store.assertWorkspaceWritable(workspaceId, period, permission);
  if ((latestUser?.id || null) !== actorId) throw failure("原件核验期间目标工作台的操作身份已变化，请重新复核", "WORKSPACE_IDENTITY_CHANGED");
  const latest = getWorkspace(store.getState(), workspaceId);
  if (JSON.stringify(voucherFor(latest, period, voucherId)) !== originalVersion || voucherPostingSources(latest, effectiveVoucher) !== sources) {
    throw failure("原件核验期间凭证的业务来源已变化，请按最新数据重新复核", "VOUCHER_SOURCE_CHANGED");
  }
  // No await between reading latest state, domain validation and the store commit.
  const posted = postVerified(prepare(latest));
  const restored = activateWorkspacePeriod(posted, latest.currentPeriod);
  const state = store.actions.replaceWorkspace(workspaceId, restored, { period, requiredPermission: permission });
  return voucherResult(getWorkspace(state, workspaceId), period, voucherId);
}

export async function importWorkspaceReceipt({ store, fileVault, file }, input) {
  const { workspaceId, period, packageId, packageHash, reportVersionId } = input || {};
  if (!workspaceId || !validAccountingPeriod(period) || !packageId || !packageHash || !reportVersionId || !(file instanceof Blob)) throw failure("请指定目标账期、申报包与真实回执文件");
  for (const key of Object.keys(input)) if (!["workspaceId", "period", "packageId", "packageHash", "reportVersionId"].includes(key)) throw failure(`不支持的参数：${key}`);
  const actor = store.assertWorkspaceWritable(workspaceId, period, "documents.add");
  const actorId = actor?.id || null;
  const currentTarget = () => {
    const user = store.assertWorkspaceWritable(workspaceId, period, "documents.add");
    store.assertWorkspaceWritable(workspaceId, period, "data.write");
    if ((user?.id || null) !== actorId) throw failure("回执保存期间目标工作台身份已变化，请重新导入", "WORKSPACE_IDENTITY_CHANGED");
    const workspace = getWorkspace(store.getState(), workspaceId);
    const targetWorkspace = activateWorkspacePeriod(workspace, period);
    const savedPackage = targetWorkspace.delivery?.filing?.exportedPackage;
    if (savedPackage?.id !== packageId || savedPackage?.hash !== packageHash || savedPackage?.reportVersionId !== reportVersionId) throw failure("回执对应的申报包已变化，请选用最新申报包的回执重新导入", "RECEIPT_PACKAGE_CHANGED");
    return { workspace, targetWorkspace };
  };
  let document;
  try {
    currentTarget();
    document = await saveLocalDocument({ store, fileVault, workspaceId, file,
      metadata: { category: "申报回执", period, deliveryArtifact: true, actor: actor?.name || "本地用户" } });
    currentTarget();
    const receipt = await importLocalReceipt(file);
    let latest = currentTarget();
    const original = latest.workspace.documents.find((item) => item.id === document.id);
    if (!original || original.hash !== document.hash || receipt.hash !== document.hash) throw failure("回执原件已变化，请重新导入", "RECEIPT_ORIGINAL_CHANGED");
    await verifyStoredDocumentOriginal({ fileVault, workspaceId, document: original });
    latest = currentTarget();
    const currentDocument = latest.workspace.documents.find((item) => item.id === document.id);
    if (!currentDocument || currentDocument.hash !== original.hash || currentDocument.version !== original.version
      || currentDocument.storage?.blobId !== original.storage?.blobId) throw failure("回执原件已变化，请重新导入", "RECEIPT_ORIGINAL_CHANGED");
    const attached = attachReceipt(latest.targetWorkspace, { ...receipt, documentId: document.id, packageId, packageHash, reportVersionId }, actor?.name || "本地用户");
    store.actions.replaceWorkspace(workspaceId, activateWorkspacePeriod(attached, latest.workspace.currentPeriod), { period, requiredPermission: "data.write" });
    return jsonCopy({ workspaceId, period, receipt: attached.delivery.filing.receipt });
  } catch (error) {
    if (document && getWorkspace(store.getState(), workspaceId)?.documents?.some((item) => item.id === document.id)) {
      try { await removeLocalDocument({ store, fileVault, workspaceId, documentId: document.id }); }
      catch (cleanupError) { error.cleanup = { documentId: document.id, message: cleanupError.message }; }
    }
    throw error;
  }
}

export function reverseWorkspaceAdvanceApplication({ store }, input) {
  const { workspaceId, period, applicationId, reason } = input || {};
  if (typeof workspaceId !== "string" || !workspaceId.trim() || !validAccountingPeriod(period)
    || typeof applicationId !== "string" || !applicationId.trim() || typeof reason !== "string" || !reason.trim()) throw failure("请指定工作台、账期、冲销记录及撤回原因");
  for (const key of Object.keys(input)) if (!["workspaceId", "period", "applicationId", "reason"].includes(key)) throw failure(`不支持的参数：${key}`);
  const user = store.assertWorkspaceWritable(workspaceId, period, "data.write");
  const latest = getWorkspace(store.getState(), workspaceId);
  const targetWorkspace = activateWorkspacePeriod(latest, period);
  const next = reverseAdvanceApplication(targetWorkspace, { applicationId, reason }, { actor: user?.name || "本地用户", at: new Date().toISOString(), mode: "manual" });
  const cancelledVoucherIds = (next.vouchers || []).filter((voucher) => voucher.status === "invalidated"
    && (targetWorkspace.vouchers || []).some((previous) => previous.id === voucher.id && ["draft", "changes_requested"].includes(previous.status))).map((voucher) => voucher.id);
  const state = store.actions.replaceWorkspace(workspaceId, activateWorkspacePeriod(next, latest.currentPeriod), { period, requiredPermission: "data.write" });
  const saved = getWorkspace(state, workspaceId);
  const application = saved.advanceApplications.find((item) => item.id === applicationId);
  const asOf = settlementPeriodEnd(period);
  return jsonCopy({ workspaceId, period, application, advance: advanceBalance(saved, application.advanceBillId, { asOf }),
    target: billSettlement(saved, application.targetBillId, { asOf }), cancelledVoucherIds });
}

export function createFinanceDeskService({ store, fileVault }) {
  if (!store?.assertWorkspaceAccess || !store?.assertWorkspaceWritable) throw new Error("应用服务需要 FinanceDesk store");
  const files = new Map();
  const plans = new Map();

  function validate(name, input = {}) {
    const spec = FINANCE_DESK_OPERATIONS.find((item) => item.name === name);
    if (!spec) throw failure(`不支持的操作：${name}`, "UNKNOWN_OPERATION");
    if (!input || Array.isArray(input) || typeof input !== "object") throw failure("操作参数必须是对象");
    for (const key of Object.keys(input)) if (!Object.hasOwn(spec.parameters.properties, key)) throw failure(`不支持的参数：${key}`);
    for (const key of spec.parameters.required) if (typeof input[key] !== "string" || !input[key].trim()) throw failure(`缺少参数：${key}`);
    if (Object.hasOwn(input, "period") && !validAccountingPeriod(input.period)) throw failure("请选择有效的导入账期");
    return name === "prepareBankImport" ? validateBankImportOptions(input) : input;
  }

  function workspaceFor(workspaceId) {
    const workspace = getWorkspace(store.getState(), workspaceId);
    if (!workspace) throw failure(`找不到工作台：${workspaceId}`, "WORKSPACE_NOT_FOUND");
    store.assertWorkspaceAccess(workspaceId, "data.read");
    return workspace;
  }

  function fileFor(fileRef, workspaceId) {
    const entry = files.get(fileRef);
    if (!entry || entry.released || entry.workspaceId !== workspaceId) throw failure("文件引用已失效或不属于目标工作台，请重新选择文件", "FILE_REFERENCE_EXPIRED");
    return entry;
  }

  async function registerBankFile(file, { workspaceId, signal, onProgress, fileName, sheetName, encoding, sourceDocumentId, exactMapping = false } = {}) {
    workspaceFor(workspaceId);
    if (!(file instanceof Blob)) throw failure("本地宿主必须提供真实 File 或 Blob，不能传入文件描述对象");
    const parsed = await readBankFile(file, { signal, onProgress, fileName, sheetName, encoding, computeHash: true });
    parsed.sourceAnalysis = inspectBankSourceGroups(parsed.table, parsed);
    signal?.throwIfAborted();
    const workspace = workspaceFor(workspaceId);
    if (sourceDocumentId) {
      const original = workspace.documents.find((item) => item.id === sourceDocumentId);
      if (!original || original.category !== "银行流水" || original.hash !== parsed.fileHash) throw failure("已保存银行原件与所选文件不一致", "BANK_ORIGINAL_CHANGED");
    }
    const fileRef = createId("bank-file");
    files.set(fileRef, { file, parsed, workspaceId, sourceDocumentId, exactMapping, released: false, executing: 0 });
    return jsonCopy({ fileRef, workspaceId, ...parsed });
  }

  function inspectBankFileSources(input) {
    const { workspaceId, period, fileRef, mapping } = input || {};
    if (!workspaceId || !validAccountingPeriod(period) || !fileRef) throw failure("请指定工作台、账期和已注册的银行文件");
    for (const key of Object.keys(input)) if (!["workspaceId", "period", "fileRef", "mapping"].includes(key)) throw failure(`不支持的参数：${key}`);
    const workspace = activateWorkspacePeriod(workspaceFor(workspaceId), period);
    const file = fileFor(fileRef, workspaceId);
    validateBankImportOptions({ mapping, table: file.parsed.table });
    const analysis = mapping === undefined && !file.exactMapping ? file.parsed.sourceAnalysis
      : inspectBankSourceGroups(file.parsed.table, { ...file.parsed, mapping, exactMapping: file.exactMapping });
    return jsonCopy({ ...analysis, workspaceId, period, fileRef, groups: analysis.groups.map((group) => ({
      ...group, ...matchBankSourceAccounts(group, workspace.bankAccounts, analysis.groups),
    })) });
  }

  function discardReleasedFile(fileRef) {
    const entry = files.get(fileRef);
    if (!entry?.released || entry.executing) return;
    files.delete(fileRef);
    for (const [id, plan] of plans) if (plan.input.fileRef === fileRef) plans.delete(id);
  }

  function releaseBankFile(fileRef) {
    const entry = files.get(fileRef);
    if (entry) entry.released = true;
    discardReleasedFile(fileRef);
  }

  function prepare(entry, workspace, file) {
    const account = activateWorkspacePeriod(workspace, entry.input.period).bankAccounts.find((item) => item.id === entry.input.accountId);
    for (const field of ["openingBalance", "statementClosing"]) {
      const value = entry.input[field];
      if (entry.balances && value != null && value !== "" && account?.[field] !== entry.balances[field]
        && Number(account?.[field]) !== Number(value)) {
        throw failure("预检查后账户余额已修改，请核对最新余额并重新预检查", "BANK_BALANCE_CHANGED", { field, currentValue: account?.[field] ?? null });
      }
    }
    return prepareBankImport(workspace, {
      ...entry.input, ...file.parsed, mapping: entry.input.mapping || file.parsed.inspection.mapping,
      exactMapping: file.exactMapping,
      importId: entry.id, importedAt: entry.importedAt,
    });
  }

  function followup(workspace, record, transactions) {
    const ids = new Set(transactions.map((item) => item.id));
    const { imports, ...currentReconciliation } = buildBankMonthlyReconciliation(activateWorkspacePeriod(workspace, record.period), {
      accountId: record.accountId, period: record.period,
    });
    const missingItems = bankExceptionTasksForPeriod(workspace, record.period, { accountId: record.accountId })
      .filter((task) => task.status !== "resolved")
      .map((task) => ({ id: task.id, code: task.code, message: task.message, sourceId: task.sourceId, missingEvidence: task.missingEvidence || [] }));
    const nextActions = ids.size ? [{ action: "review_bank_transactions", workspaceId: workspace.id, period: record.period, accountId: record.accountId, ...(record.id ? { importId: record.id } : {}), transactionIds: [...ids] }] : [];
    if (!currentReconciliation.passed) nextActions.push({ action: "reconcile_bank_account", workspaceId: workspace.id, period: record.period, accountId: record.accountId });
    return { currentReconciliation, missingItems, nextActions };
  }

  function importSnapshot(record) {
    return { importId: record.id, importedAt: record.importedAt,
      counts: { imported: record.importableRowCount, duplicates: record.duplicateCount, errors: record.errorCount },
      reconciliation: record.reconciliation, monthlyReconciliation: record.monthlyReconciliation,
    };
  }

  function resultFor(workspace, record) {
    const transactions = workspace.transactions.filter((item) => item.importId === record.id);
    return jsonCopy({
      status: "imported", workspaceId: workspace.id, period: record.period, accountId: record.accountId,
      importIds: [record.id], transactionIds: transactions.map((item) => item.id), documentIds: record.sourceDocumentId ? [record.sourceDocumentId] : [],
      counts: { imported: transactions.length, duplicates: record.duplicateCount, errors: record.errorCount },
      import: { ...record, transactions }, importSnapshots: [importSnapshot(record)], ...followup(workspace, record, transactions),
    });
  }

  function duplicateResult(workspace, plan) {
    const keys = new Set(plan.duplicates.map((item) => item.dedupeKey));
    const transactions = workspace.transactions.filter((item) => keys.has(transactionDedupeKey(item)));
    const importIds = [...new Set(transactions.map((item) => item.importId).filter(Boolean))];
    const record = workspace.bankImports.find((item) => item.accountId === plan.accountId && item.period === plan.period && item.fileHash === plan.fileHash)
      || (importIds.length === 1 ? workspace.bankImports.find((item) => item.id === importIds[0]) : null);
    const previous = record ? resultFor(workspace, record) : {};
    const records = workspace.bankImports.filter((item) => importIds.includes(item.id));
    return jsonCopy({
      ...previous, status: "duplicate", workspaceId: workspace.id, period: plan.period, accountId: plan.accountId,
      importIds, transactionIds: transactions.map((item) => item.id),
      documentIds: [...new Set(records.map((item) => item.sourceDocumentId).filter(Boolean))],
      counts: { imported: 0, duplicates: plan.duplicateCount, errors: 0 }, import: previous.import || null,
      importSnapshots: records.map(importSnapshot),
      ...followup(workspace, { accountId: plan.accountId, period: plan.period, ...(record ? { id: record.id } : {}) }, transactions),
    });
  }

  function assertPlan(plan) {
    if (plan.errorCount) throw failure(`文件仍有 ${plan.errorCount} 行错误，请修正后重新预检查`, "BANK_IMPORT_INVALID", { errors: plan.errors });
    if (!plan.importableRowCount && !plan.duplicateCount) throw failure("文件中没有有效流水", "BANK_IMPORT_EMPTY");
  }

  async function execute(entry, file) {
    const { workspaceId, period } = entry.input;
    let sourceDocument = null;
    let createdSourceDocument = false;
    const validateTarget = () => {
      const workspace = workspaceFor(workspaceId);
      store.assertWorkspaceWritable(workspaceId, period, "data.write");
      store.assertWorkspaceWritable(workspaceId, period, "documents.add");
      return workspace;
    };
    async function cleanup() {
      if (!sourceDocument || !createdSourceDocument) return;
      const workspace = getWorkspace(store.getState(), workspaceId);
      if (!workspace?.documents?.some((item) => item.id === sourceDocument.id)) return;
      try { await removeLocalDocument({ store, fileVault, workspaceId, documentId: sourceDocument.id }); }
      catch (error) { return { documentId: sourceDocument.id, message: error.message, ...(error.cleanup ? { original: error.cleanup } : {}) }; }
    }
    try {
      let workspace = workspaceFor(workspaceId);
      const previous = workspace.bankImports.find((item) => item.id === entry.id);
      if (previous) return { ...resultFor(workspace, previous), status: "already_imported" };
      workspace = validateTarget();
      let plan = prepare(entry, workspace, file);
      assertPlan(plan);
      if (!plan.importableRowCount) return duplicateResult(workspace, plan);
      if (!fileVault) throw failure("当前浏览器无法保存银行流水原文件，请更换支持 IndexedDB 的浏览器", "FILE_VAULT_UNAVAILABLE");
      const actor = store.assertWorkspaceAccess(workspaceId, "data.write")?.name || "本地用户";
      // Keep it unlinked until the bank commit. Failed imports can remove this
      // newly created document using the ordinary usage checks, without force.
      if (file.sourceDocumentId) {
        sourceDocument = workspace.documents.find((item) => item.id === file.sourceDocumentId);
        if (!sourceDocument || sourceDocument.period !== period || sourceDocument.category !== "银行流水"
          || sourceDocument.hash !== file.parsed.fileHash) throw failure("已保存银行原件或所属账期已变化", "BANK_ORIGINAL_CHANGED");
      } else {
        sourceDocument = await saveLocalDocument({ store, fileVault, workspaceId, file: file.file,
          metadata: { category: "银行流水", period, actor, name: file.parsed.fileName },
        });
        createdSourceDocument = true;
      }
      await verifyStoredDocumentOriginal({ fileVault, workspaceId, document: sourceDocument });
      workspace = validateTarget();
      const latestOriginal = workspace.documents.find((item) => item.id === sourceDocument.id);
      if (!latestOriginal || latestOriginal.hash !== sourceDocument.hash || latestOriginal.version !== sourceDocument.version
        || latestOriginal.period !== period || latestOriginal.storage?.blobId !== sourceDocument.storage?.blobId) throw failure("导入期间银行原件已变化", "BANK_ORIGINAL_CHANGED");
      plan = prepare(entry, workspace, file);
      assertPlan(plan);
      if (!plan.importableRowCount) {
        const result = duplicateResult(workspace, plan);
        const residue = await cleanup();
        return { ...result, ...(residue ? { cleanup: residue } : {}) };
      }
      const nextState = store.actions.applyBankImport(workspaceId, {
        ...plan, sourceDocumentId: sourceDocument.id,
        transactions: plan.transactions.map((transaction) => ({ ...transaction, evidenceIds: [...new Set([...(transaction.evidenceIds || []), sourceDocument.id])] })),
      });
      workspace = getWorkspace(nextState, workspaceId);
      file.sourceDocumentId = sourceDocument.id;
      return resultFor(workspace, workspace.bankImports.find((item) => item.id === plan.id));
    } catch (error) {
      const workspace = getWorkspace(store.getState(), workspaceId);
      const saved = workspace?.bankImports?.find((item) => item.id === entry.id);
      if (saved) {
        store.assertWorkspaceAccess(workspaceId, "data.read");
        return resultFor(workspace, saved);
      }
      const residue = await cleanup();
      if (residue) error.cleanup = residue;
      throw error;
    }
  }

  const operations = {
    async importReceipt(input) {
      const { fileRef, ...parameters } = validate("importReceipt", input);
      const entry = fileFor(fileRef, parameters.workspaceId);
      if (entry.kind !== "receipt") throw failure("请选择已注册的回执原件", "FILE_REFERENCE_EXPIRED");
      entry.executing += 1;
      try { return await importWorkspaceReceipt({ store, fileVault, file: entry.file }, parameters); }
      finally { entry.executing -= 1; discardReleasedFile(fileRef); }
    },
    getVoucherContext(input) {
      const { workspaceId, period, voucherId } = validate("getVoucherContext", input);
      return voucherResult(workspaceFor(workspaceId), period, voucherId);
    },
    postVoucher(input) {
      return postWorkspaceVoucher({ store, fileVault }, validate("postVoucher", input));
    },
    reverseAdvanceApplication(input) {
      return reverseWorkspaceAdvanceApplication({ store }, validate("reverseAdvanceApplication", input));
    },
    listWorkspaces(input = {}) {
      validate("listWorkspaces", input);
      const workspaces = store.getState().workspaces.filter((workspace) => {
        try { store.assertWorkspaceAccess(workspace.id, "data.read"); return true; } catch { return false; }
      });
      return { workspaces: workspaces.map(({ id, name, currentPeriod }) => ({ id, name, displayedPeriod: currentPeriod })) };
    },
    getWorkspaceContext(input) {
      const { workspaceId, period } = validate("getWorkspaceContext", input);
      const workspace = workspaceFor(workspaceId);
      const targetWorkspace = activateWorkspacePeriod(workspace, period);
      return jsonCopy({ workspaceId, period, displayedPeriod: workspace.currentPeriod, archived: isPeriodArchived(workspace, period),
        periods: [...new Set([workspace.currentPeriod, ...(workspace.periods || []), ...Object.keys(workspace.periodStates || {}), ...(workspace.delivery?.archives || []).map((item) => item.period)])].sort(),
        accounts: targetWorkspace.bankAccounts, imports: workspace.bankImports.filter((item) => item.period === period).map((item) => ({ id: item.id, accountId: item.accountId, fileName: item.fileName, sourceDocumentId: item.sourceDocumentId, importedCount: item.importableRowCount })),
      });
    },
    prepareBankImport(input) {
      input = validate("prepareBankImport", input);
      const workspace = workspaceFor(input.workspaceId);
      const file = fileFor(input.fileRef, input.workspaceId);
      const entry = { id: createId("bank-import"), importedAt: new Date().toISOString(), input: jsonCopy(input), pending: null };
      const plan = prepare(entry, workspace, file);
      const account = activateWorkspacePeriod(workspace, input.period).bankAccounts.find((item) => item.id === input.accountId);
      entry.balances = { openingBalance: account.openingBalance, statementClosing: account.statementClosing };
      plans.set(entry.id, entry);
      return jsonCopy({ ...plan, planId: entry.id, fileRef: input.fileRef,
        missingItems: [...plan.errors.map((error) => ({ code: "invalid_row", ...error })), ...(plan.reconciliationIssue ? [plan.reconciliationIssue] : [])],
        nextActions: [{ action: plan.errorCount ? "correct_bank_mapping_or_file" : plan.importableRowCount ? "executeBankImport" : "review_existing_import", workspaceId: input.workspaceId, planId: entry.id }],
      });
    },
    async executeBankImport(input) {
      const { workspaceId, planId } = validate("executeBankImport", input);
      const entry = plans.get(planId);
      if (!entry || entry.input.workspaceId !== workspaceId) throw failure("导入计划已失效或不属于目标工作台，请重新预检查", "BANK_PLAN_EXPIRED");
      const file = fileFor(entry.input.fileRef, workspaceId);
      if (entry.pending) return jsonCopy(await entry.pending);
      file.executing += 1;
      entry.pending = execute(entry, file);
      try { return jsonCopy(await entry.pending); }
      finally {
        entry.pending = null;
        file.executing -= 1;
        discardReleasedFile(entry.input.fileRef);
      }
    },
    getBankImportResult(input) {
      const { workspaceId, importId } = validate("getBankImportResult", input);
      const workspace = workspaceFor(workspaceId);
      const record = workspace.bankImports.find((item) => item.id === importId);
      if (!record) throw failure("找不到银行导入批次", "BANK_IMPORT_NOT_FOUND");
      return resultFor(workspace, record);
    },
  };

  return {
    ...operations, registerBankFile, releaseBankFile, inspectBankFileSources,
    registerReceiptFile(file, { workspaceId } = {}) {
      workspaceFor(workspaceId);
      if (!(file instanceof Blob)) throw failure("本地宿主必须提供真实回执 File 或 Blob");
      const fileRef = createId("receipt-file");
      files.set(fileRef, { kind: "receipt", file, workspaceId, released: false, executing: 0 });
      return { workspaceId, fileRef };
    },
    releaseReceiptFile: releaseBankFile,
    releaseBankPlan(planId) { if (!plans.get(planId)?.pending) plans.delete(planId); },
    dispose() { for (const ref of files.keys()) releaseBankFile(ref); },
    async invoke(name, parameters = {}) {
      try { validate(name, parameters); return { ok: true, data: await operations[name](parameters) }; }
      catch (error) { return { ok: false, error: { code: error.code || "OPERATION_FAILED", message: error.message, ...(error.details ? { details: jsonCopy(error.details) } : {}), ...(error.cleanup ? { cleanup: jsonCopy(error.cleanup) } : {}) } }; }
    },
  };
}
