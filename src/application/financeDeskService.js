import { createId, getWorkspace } from "../domain/foundation.js";
import { activateWorkspacePeriod, isPeriodArchived, validAccountingPeriod } from "../domain/periods.js";
import { BANK_FIELD_DEFINITIONS, bankExceptionTasksForPeriod, buildBankMonthlyReconciliation, prepareBankImport, readBankFile, transactionDedupeKey, validateBankImportOptions } from "../features/intake/bankStatementImport.js";
import { removeLocalDocument, saveLocalDocument, verifyStoredDocumentOriginal } from "../features/intake/documentIntake.js";

const string = { type: "string", minLength: 1 };
const target = { workspaceId: string, period: { type: "string", pattern: "^[1-9]\\d{3}-(0[1-9]|1[0-2])$" } };
const definition = (name, description, properties, required, resultFields) => ({
  name, description, parameters: { type: "object", properties, required, additionalProperties: false }, resultFields,
});

// Only these operations accept serialized tool parameters. Files and identities
// enter through the trusted local host, outside this operation catalogue.
export const FINANCE_DESK_OPERATIONS = [
  definition("listWorkspaces", "列出可读取工作台", {}, [], ["workspaces"]),
  definition("getWorkspaceContext", "查询指定工作台和账期的账户及导入记录", target, ["workspaceId", "period"], ["workspaceId", "period", "archived", "periods", "accounts", "imports"]),
  definition("prepareBankImport", "对已注册本地文件进行映射和导入预检查", {
    ...target, accountId: string, fileRef: string, mapping: { type: "object", properties: Object.fromEntries(Object.keys(BANK_FIELD_DEFINITIONS).map((field) => [field, { type: "integer", minimum: 0 }])), additionalProperties: false },
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

  async function registerBankFile(file, { workspaceId, signal, onProgress, fileName, sheetName, encoding } = {}) {
    workspaceFor(workspaceId);
    if (!(file instanceof Blob)) throw failure("本地宿主必须提供真实 File 或 Blob，不能传入文件描述对象");
    const parsed = await readBankFile(file, { signal, onProgress, fileName, sheetName, encoding, computeHash: true });
    signal?.throwIfAborted();
    workspaceFor(workspaceId);
    const fileRef = createId("bank-file");
    files.set(fileRef, { file, parsed, workspaceId, released: false, executing: 0 });
    return jsonCopy({ fileRef, workspaceId, ...parsed });
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
    const transactions = workspace.transactions.filter((item) => keys.has(item.dedupeKey || transactionDedupeKey(item)));
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
    const validateTarget = () => {
      const workspace = workspaceFor(workspaceId);
      store.assertWorkspaceWritable(workspaceId, period, "data.write");
      store.assertWorkspaceWritable(workspaceId, period, "documents.add");
      return workspace;
    };
    async function cleanup() {
      if (!sourceDocument) return;
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
      sourceDocument = await saveLocalDocument({ store, fileVault, workspaceId, file: file.file,
        metadata: { category: "银行流水", period, actor, name: file.parsed.fileName },
      });
      await verifyStoredDocumentOriginal({ fileVault, workspaceId, document: sourceDocument });
      workspace = validateTarget();
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
    ...operations, registerBankFile, releaseBankFile,
    releaseBankPlan(planId) { if (!plans.get(planId)?.pending) plans.delete(planId); },
    dispose() { for (const ref of files.keys()) releaseBankFile(ref); },
    async invoke(name, parameters = {}) {
      try { validate(name, parameters); return { ok: true, data: await operations[name](parameters) }; }
      catch (error) { return { ok: false, error: { code: error.code || "OPERATION_FAILED", message: error.message, ...(error.details ? { details: jsonCopy(error.details) } : {}), ...(error.cleanup ? { cleanup: jsonCopy(error.cleanup) } : {}) } }; }
    },
  };
}
