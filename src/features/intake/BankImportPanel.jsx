import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, FileArrowUp, Table, WarningCircle, X } from "@phosphor-icons/react";

import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import {
  BANK_FIELD_DEFINITIONS,
  PLATFORM_SETTLEMENT_CHANNELS,
  PLATFORM_SETTLEMENT_FIELD_DEFINITIONS,
  applyPlatformSettlementImport,
  buildBankAccountReconciliationSummary,
  buildBankMonthlyReconciliation,
  inspectBankTable,
  inspectPlatformSettlementTable,
  prepareBankImport,
  preparePlatformSettlementImport,
  readBankFile,
  readPlatformSettlementFile,
} from "./bankStatementImport.js";
import { hashLocalFile, removeLocalDocument, saveLocalDocument } from "./documentIntake.js";

const MAPPING_FIELDS = ["date", "amount", "credit", "debit", "direction", "counterparty", "counterpartyAccount", "summary", "serial", "balance", "channel", "currency"];
const SETTLEMENT_MAPPING_FIELDS = ["settlementDate", "settlementNo", "grossAmount", "feeAmount", "refundAmount", "netAmount"];

function displayMoney(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function displayDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function displayAccountIdentity(account) {
  const accountNumber = account.accountNumber || account.number || "";
  return [
    account.name || account.accountName || "未命名账户",
    accountNumber ? `尾号 ${accountNumber}` : "账号未填写",
    account.currency || "CNY",
  ].join(" · ");
}

export function BankImportPanel({ compact = false, onToast, onComplete }) {
  const { activeWorkspace, actions, store, fileVault } = useFinanceDesk();
  const inputRef = useRef(null);
  const settlementInputRef = useRef(null);
  const applyingRef = useRef(false);
  const settlementApplyingRef = useRef(false);
  const [accountId, setAccountId] = useState(activeWorkspace.bankAccounts[0]?.id || "");
  const [period, setPeriod] = useState(activeWorkspace.currentPeriod || "");
  const [parsed, setParsed] = useState(null);
  const [mapping, setMapping] = useState({});
  const [openingBalance, setOpeningBalance] = useState("");
  const [statementClosing, setStatementClosing] = useState("");
  const [plan, setPlan] = useState(null);
  const [counterpartyMappings, setCounterpartyMappings] = useState({});
  const [counterpartyMappingDirty, setCounterpartyMappingDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [settlementChannel, setSettlementChannel] = useState("wechat");
  const [settlementParsed, setSettlementParsed] = useState(null);
  const [settlementMapping, setSettlementMapping] = useState({});
  const [settlementPlan, setSettlementPlan] = useState(null);
  const [settlementBusy, setSettlementBusy] = useState(false);
  const [settlementError, setSettlementError] = useState("");
  const firstAccountId = activeWorkspace.bankAccounts[0]?.id || "";
  const bankAccountStateSignature = JSON.stringify(activeWorkspace.bankAccounts.map((item) => [
    item.id,
    item.openingBalance ?? "",
    item.statementClosing ?? "",
  ]));

  const account = activeWorkspace.bankAccounts.find((item) => item.id === accountId);
  useEffect(() => {
    const next = activeWorkspace.bankAccounts.find((item) => item.id === accountId) || activeWorkspace.bankAccounts[0];
    setAccountId(next?.id || "");
    setPeriod(activeWorkspace.currentPeriod || "");
    setOpeningBalance(next?.openingBalance ?? "");
    setStatementClosing(next?.statementClosing ?? "");
    setParsed(null);
    setPlan(null);
    setCounterpartyMappings({});
    setCounterpartyMappingDirty(false);
    setError("");
    setSettlementParsed(null);
    setSettlementPlan(null);
    setSettlementError("");
  }, [activeWorkspace.id, activeWorkspace.currentPeriod, firstAccountId, bankAccountStateSignature]);

  useEffect(() => {
    if (!account) return;
    setOpeningBalance(account.openingBalance ?? "");
    setStatementClosing(account.statementClosing ?? "");
    setPlan(null);
    setSettlementPlan(null);
  }, [accountId]);

  const inspection = useMemo(() => parsed ? inspectBankTable(parsed.table, { mapping }) : null, [parsed, mapping]);
  const settlementInspection = useMemo(() => settlementParsed
    ? inspectPlatformSettlementTable(settlementParsed.table, { mapping: settlementMapping })
    : null, [settlementParsed, settlementMapping]);
  const monthlyReconciliation = useMemo(() => buildBankMonthlyReconciliation(activeWorkspace, {
    accountId,
    period,
  }), [activeWorkspace, accountId, period]);
  const accountReconciliationSummary = useMemo(() => buildBankAccountReconciliationSummary(activeWorkspace, {
    period,
  }), [activeWorkspace, period]);
  const platformSettlements = useMemo(() => (activeWorkspace.platformSettlements || [])
    .filter((settlement) => settlement.accountId === accountId && settlement.period === period)
    .sort((left, right) => String(right.settlementDate || "").localeCompare(String(left.settlementDate || ""))), [activeWorkspace, accountId, period]);
  const counterpartyTargetGroups = useMemo(() => {
    const counterparties = (activeWorkspace.counterparties || []).filter((item) => item.status !== "inactive");
    const targets = (items, objectType, fallbackKind) => items.map((item) => ({
      key: `${objectType}:${item.id}`,
      name: item.name || item.employeeName || item.id,
      objectId: item.id,
      objectType,
      kind: item.kind || fallbackKind,
    }));
    return [
      { label: "已有客户", items: targets(counterparties.filter((item) => item.kind === "customer"), "counterparty", "customer") },
      { label: "已有供应商", items: targets(counterparties.filter((item) => item.kind === "supplier"), "counterparty", "supplier") },
      { label: "已有员工", items: targets(activeWorkspace.personnelRecords || [], "personnelRecord", "employee") },
      { label: "已有关联方", items: targets(counterparties.filter((item) => item.kind === "related_party"), "counterparty", "related_party") },
    ].filter((group) => group.items.length);
  }, [activeWorkspace]);
  const counterpartyPreviewGroups = useMemo(() => {
    const groups = new Map();
    (plan?.transactions || []).forEach((transaction) => {
      const key = transaction.counterpartyAliasKey;
      const existing = groups.get(key);
      if (existing) {
        existing.rowCount += 1;
        return;
      }
      groups.set(key, {
        key,
        rawName: transaction.counterpartyRaw || "",
        counterpartyAccount: transaction.counterpartyAccount || "",
        standardName: transaction.counterparty,
        objectId: transaction.counterpartyObjectId,
        mappingSource: transaction.counterpartyMappingSource,
        rowCount: 1,
      });
    });
    return [...groups.values()];
  }, [plan]);

  function chooseCounterpartyTarget(group, targetKey) {
    setCounterpartyMappings((current) => {
      const next = { ...current };
      if (!targetKey) {
        delete next[group.key];
        return next;
      }
      if (targetKey === "manual") {
        next[group.key] = {
          targetKey,
          rawName: group.rawName,
          counterpartyAccount: group.counterpartyAccount,
          standardName: current[group.key]?.standardName || "",
          objectId: null,
          objectType: "manual",
          kind: current[group.key]?.kind || "other",
        };
        return next;
      }
      const target = counterpartyTargetGroups.flatMap((item) => item.items).find((item) => item.key === targetKey);
      if (target) next[group.key] = {
        targetKey,
        rawName: group.rawName,
        counterpartyAccount: group.counterpartyAccount,
        standardName: target.name,
        objectId: target.objectId,
        objectType: target.objectType,
        kind: target.kind,
      };
      return next;
    });
    setCounterpartyMappingDirty(true);
  }

  function updateManualCounterparty(group, values) {
    setCounterpartyMappings((current) => ({
      ...current,
      [group.key]: {
        ...current[group.key],
        rawName: group.rawName,
        counterpartyAccount: group.counterpartyAccount,
        objectId: null,
        objectType: "manual",
        ...values,
      },
    }));
    setCounterpartyMappingDirty(true);
  }

  async function chooseFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    setPlan(null);
    try {
      const result = await readBankFile(file);
      const fileHash = await hashLocalFile(file);
      setParsed({ ...result, fileHash, file });
      setMapping(result.inspection.mapping);
      setCounterpartyMappings({});
      setCounterpartyMappingDirty(false);
    } catch (caught) {
      setParsed(null);
      setError(caught.message || "银行流水文件读取失败");
    } finally {
      setBusy(false);
    }
  }

  function changeMapping(field, value) {
    setMapping((current) => {
      const next = { ...current };
      if (value === "") delete next[field];
      else next[field] = Number(value);
      return next;
    });
    setCounterpartyMappings({});
    setCounterpartyMappingDirty(false);
    setPlan(null);
  }

  function previewImport() {
    setError("");
    try {
      const incompleteManual = Object.values(counterpartyMappings).find((item) => item.targetKey === "manual" && !item.standardName?.trim());
      if (incompleteManual) throw new Error(`请填写「${incompleteManual.rawName || incompleteManual.counterpartyAccount}」的手工标准名称`);
      const nextPlan = prepareBankImport(activeWorkspace, {
        accountId,
        period,
        fileName: parsed.fileName,
        fileHash: parsed.fileHash,
        sheetName: parsed.sheetName,
        table: parsed.table,
        mapping,
        openingBalance,
        statementClosing,
        counterpartyMappings,
      });
      setPlan(nextPlan);
      setCounterpartyMappingDirty(false);
    } catch (caught) {
      setPlan(null);
      setError(caught.message || "导入预检查失败");
    }
  }

  async function applyImport() {
    if (applyingRef.current || !plan || !parsed) return;
    applyingRef.current = true;
    setBusy(true);
    setError("");
    let sourceDocument = null;
    let committed = false;
    let completedPlan = null;
    const workspaceId = activeWorkspace.id;
    try {
      if (!fileVault) throw new Error("当前浏览器无法保存银行流水原文件，请更换支持 IndexedDB 的浏览器");
      const latestState = store.getState();
      const latestWorkspace = latestState.workspaces.find((workspace) => workspace.id === workspaceId);
      if (!latestWorkspace) throw new Error("当前工作台已不存在，请重新选择工作台");
      const actor = latestWorkspace.users?.find((user) => (
        user.id === latestState.activeUserId && user.status === "active"
      ))?.name?.trim() || latestWorkspace.users?.find((user) => user.status === "active")?.name?.trim() || "本地用户";
      const refreshedPlan = prepareBankImport(latestWorkspace, {
        accountId,
        period,
        fileName: parsed.fileName,
        fileHash: parsed.fileHash,
        sheetName: parsed.sheetName,
        table: parsed.table,
        mapping,
        openingBalance,
        statementClosing,
        importedAt: plan.importedAt,
        importId: plan.id,
        largeTransactionThreshold: plan.largeTransactionThreshold,
        counterpartyMappings,
      });
      if (refreshedPlan.errorCount > 0) throw new Error(`文件仍有 ${refreshedPlan.errorCount} 行错误，请修正后重新预检查`);
      if (!refreshedPlan.reconciliation.available || !refreshedPlan.reconciliation.passed) {
        throw new Error(`余额未勾稽通过：${refreshedPlan.reconciliation.message}`);
      }
      if (!refreshedPlan.importableRowCount) throw new Error("没有可导入的新流水，全部为重复记录");
      sourceDocument = await saveLocalDocument({
        store,
        fileVault,
        workspaceId,
        file: parsed.file,
        metadata: {
          category: "银行流水",
          period: refreshedPlan.period,
          relatedObjectIds: [refreshedPlan.accountId],
          actor,
        },
        relation: "bank-statement-source",
        note: `银行导入 ${refreshedPlan.id} 的原始文件`,
      });
      const finalPlan = {
        ...refreshedPlan,
        sourceDocumentId: sourceDocument.id,
        transactions: refreshedPlan.transactions.map((transaction) => ({
          ...transaction,
          evidenceIds: [...new Set([...(transaction.evidenceIds || []), sourceDocument.id])],
        })),
      };
      const nextState = actions.applyBankImport(workspaceId, finalPlan, { actor });
      committed = true;
      const importedWorkspace = nextState.workspaces.find((workspace) => workspace.id === workspaceId);
      const record = importedWorkspace?.bankImports?.find((item) => item.id === finalPlan.id);
      completedPlan = { ...finalPlan, ...(record || {}) };
      setParsed(null);
      setPlan(null);
      setCounterpartyMappings({});
      setCounterpartyMappingDirty(false);
    } catch (caught) {
      if (sourceDocument && !committed) {
        try {
          await removeLocalDocument({ store, fileVault, workspaceId, documentId: sourceDocument.id });
        } catch {
          // Keep the original import error; any local residue remains visible in the documents list.
        }
      }
      setError(caught.message || "导入失败");
    } finally {
      applyingRef.current = false;
      setBusy(false);
    }
    if (completedPlan) {
      const recognitionText = completedPlan.recognitionCount ? `，自动识别 ${completedPlan.recognitionCount} 项` : "";
      const anomalyText = completedPlan.anomalyCount ? `，形成 ${completedPlan.anomalyCount} 项异常待复核` : "";
      onToast?.(`已导入 ${completedPlan.importableRowCount} 笔流水，跳过 ${completedPlan.duplicateCount} 笔重复${recognitionText}${anomalyText}`);
      onComplete?.(completedPlan);
    }
  }

  async function chooseSettlementFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setSettlementBusy(true);
    setSettlementError("");
    setSettlementPlan(null);
    try {
      const result = await readPlatformSettlementFile(file);
      const fileHash = await hashLocalFile(file);
      setSettlementParsed({ ...result, fileHash, file });
      setSettlementMapping(result.inspection.mapping);
    } catch (caught) {
      setSettlementParsed(null);
      setSettlementError(caught.message || "平台结算文件读取失败");
    } finally {
      setSettlementBusy(false);
    }
  }

  function changeSettlementMapping(field, value) {
    setSettlementMapping((current) => {
      const next = { ...current };
      if (value === "") delete next[field];
      else next[field] = Number(value);
      return next;
    });
    setSettlementPlan(null);
  }

  function previewSettlementImport() {
    setSettlementError("");
    try {
      const nextPlan = preparePlatformSettlementImport(activeWorkspace, {
        accountId,
        period,
        channel: settlementChannel,
        fileName: settlementParsed.fileName,
        fileHash: settlementParsed.fileHash,
        sheetName: settlementParsed.sheetName,
        table: settlementParsed.table,
        mapping: settlementMapping,
      });
      setSettlementPlan(nextPlan);
    } catch (caught) {
      setSettlementPlan(null);
      setSettlementError(caught.message || "平台结算预检查失败");
    }
  }

  async function applySettlementImport() {
    if (settlementApplyingRef.current || !settlementPlan || !settlementParsed) return;
    settlementApplyingRef.current = true;
    setSettlementBusy(true);
    setSettlementError("");
    let sourceDocument = null;
    let committed = false;
    let completedPlan = null;
    const workspaceId = activeWorkspace.id;
    try {
      if (!fileVault) throw new Error("当前浏览器无法保存平台结算原文件，请更换支持 IndexedDB 的浏览器");
      const latestState = store.getState();
      const latestWorkspace = latestState.workspaces.find((workspace) => workspace.id === workspaceId);
      if (!latestWorkspace) throw new Error("当前工作台已不存在，请重新选择工作台");
      const refreshedPlan = preparePlatformSettlementImport(latestWorkspace, {
        accountId,
        period,
        channel: settlementChannel,
        fileName: settlementParsed.fileName,
        fileHash: settlementParsed.fileHash,
        sheetName: settlementParsed.sheetName,
        table: settlementParsed.table,
        mapping: settlementMapping,
        importedAt: settlementPlan.importedAt,
        importId: settlementPlan.id,
      });
      if (refreshedPlan.errorCount > 0) throw new Error(`文件仍有 ${refreshedPlan.errorCount} 行错误，请修正后重新预检查`);
      if (!refreshedPlan.importableRowCount) throw new Error("没有可导入的新结算单，全部为重复记录");
      const actor = latestWorkspace.users?.find((user) => user.id === latestState.activeUserId && user.status === "active")?.name || "本地用户";
      sourceDocument = await saveLocalDocument({
        store,
        fileVault,
        workspaceId,
        file: settlementParsed.file,
        metadata: {
          category: `${PLATFORM_SETTLEMENT_CHANNELS[settlementChannel]}结算单`,
          period: refreshedPlan.period,
          relatedObjectIds: [refreshedPlan.accountId],
          actor,
        },
        relation: "platform-settlement-source",
        note: `平台结算导入 ${refreshedPlan.id} 的原始文件`,
      });
      const finalPlan = {
        ...refreshedPlan,
        sourceDocumentId: sourceDocument.id,
        settlements: refreshedPlan.settlements.map((settlement) => ({
          ...settlement,
          evidenceIds: [...new Set([...(settlement.evidenceIds || []), sourceDocument.id])],
        })),
      };
      const appliedState = applyPlatformSettlementImport(store.getState(), workspaceId, finalPlan, { actor });
      const nextWorkspace = appliedState.workspaces.find((workspace) => workspace.id === workspaceId);
      const nextState = actions.replaceWorkspace(workspaceId, nextWorkspace);
      committed = true;
      const savedWorkspace = nextState.workspaces.find((workspace) => workspace.id === workspaceId);
      const record = savedWorkspace?.platformSettlementImports?.find((item) => item.id === finalPlan.id);
      completedPlan = { ...finalPlan, ...(record || {}) };
      setSettlementParsed(null);
      setSettlementPlan(null);
    } catch (caught) {
      if (sourceDocument && !committed) {
        try {
          await removeLocalDocument({ store, fileVault, workspaceId, documentId: sourceDocument.id });
        } catch {
          // Preserve the import error; any remaining local file stays visible in the document list.
        }
      }
      setSettlementError(caught.message || "平台结算导入失败");
    } finally {
      settlementApplyingRef.current = false;
      setSettlementBusy(false);
    }
    if (completedPlan) {
      onToast?.(`已导入 ${completedPlan.importableRowCount} 份${completedPlan.channelLabel}结算，匹配 ${completedPlan.matchedCount} 份，异常 ${completedPlan.anomalousRowCount} 份`);
      onComplete?.(completedPlan);
    }
  }

  return (
    <section className={`foundation-section bank-import-panel ${compact ? "compact" : "intake-wide"}`}>
      <div className="foundation-section-heading"><div><small>CSV / Excel · 不联网</small><h3><Table size={18} />银行流水导入</h3></div>{parsed && <button className="foundation-icon-button" disabled={busy} type="button" aria-label="取消当前文件" onClick={() => { setParsed(null); setPlan(null); setCounterpartyMappings({}); setCounterpartyMappingDirty(false); }}><X size={16} /></button>}</div>
      {!activeWorkspace.bankAccounts.length ? (
        <div className="foundation-error"><WarningCircle size={18} />请先在上方新增银行账户，再导入该账户的流水。</div>
      ) : (
        <>
          <div className="bank-import-start">
            <label className="foundation-field"><span>导入到银行账户</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{activeWorkspace.bankAccounts.map((item) => <option value={item.id} key={item.id}>{displayAccountIdentity(item)}</option>)}</select></label>
            <label className="foundation-field"><span>所属账期</span><input type="month" value={period} onChange={(event) => { setPeriod(event.target.value); setPlan(null); setSettlementPlan(null); }} /></label>
            <button className="secondary-button" disabled={busy} type="button" onClick={() => inputRef.current?.click()}><FileArrowUp size={17} />{busy ? "正在读取…" : parsed ? "更换文件" : "选择 CSV / Excel"}</button>
            <input ref={inputRef} type="file" hidden accept=".csv,.txt,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={chooseFile} />
          </div>
          <p className="foundation-hint">文件在当前浏览器中解析，不会上传。系统保留文件名、哈希、原始行号和原始单元格，便于追溯。</p>
        </>
      )}

      {error && <div className="foundation-error"><WarningCircle size={18} />{error}</div>}

      {period && accountReconciliationSummary.accountCount > 0 && (
        <div className="bank-import-workspace">
          <div className="bank-file-summary">
            <span><strong>{period} 逐账户勾稽总览</strong><small>{accountReconciliationSummary.completedCount} / {accountReconciliationSummary.accountCount} 个账户已完成</small></span>
            <span className={accountReconciliationSummary.passed ? "mapping-badge" : "mapping-badge warning"}>{accountReconciliationSummary.passed ? "全部完成" : `${accountReconciliationSummary.incompleteCount} 个待完成`}</span>
          </div>
          <div className={`import-report ${accountReconciliationSummary.passed ? "passed" : "warning"}`}>
            <span>{accountReconciliationSummary.passed ? <CheckCircle size={19} weight="fill" /> : <WarningCircle size={19} />}</span>
            <div><strong>{accountReconciliationSummary.message}</strong><p>逐个核对账户身份、导入批次、流水日期范围和余额差额；未完成账户可直接切换后继续导入。</p></div>
          </div>
          <div className="bank-preview-scroll">
            <table>
              <thead><tr><th>银行账户</th><th>批次 / 流水</th><th>数据起止日期</th><th>余额差额</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>{accountReconciliationSummary.accounts.map((row) => (
                <tr key={row.accountId}>
                  <td><strong>{row.accountName}</strong><small>{row.accountNumber ? `尾号 ${row.accountNumber}` : "账号未填写"} · {row.currency}{row.accountStatus === "inactive" ? " · 已停用" : ""}</small></td>
                  <td>{row.batchCount} 批 · {row.transactionCount} 笔</td>
                  <td>{row.dateFrom ? `${row.dateFrom} 至 ${row.dateTo}` : "尚无流水"}</td>
                  <td>{displayMoney(row.difference)}</td>
                  <td>{row.passed ? "已完成" : row.message}</td>
                  <td><button className="secondary-button" type="button" disabled={row.accountId === accountId} onClick={() => setAccountId(row.accountId)}>{row.accountId === accountId ? "当前账户" : row.passed ? "查看" : "继续勾稽"}</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {account && period && (
        <div className="bank-import-workspace">
          <div className="bank-file-summary"><span><strong>{displayAccountIdentity(account)} · {period} 月度勾稽</strong><small>{monthlyReconciliation.batchCount} 个导入批次 · {monthlyReconciliation.transactionCount} 笔账户流水{monthlyReconciliation.dateFrom ? ` · ${monthlyReconciliation.dateFrom} 至 ${monthlyReconciliation.dateTo}` : ""}</small></span><span className={monthlyReconciliation.passed ? "mapping-badge" : "mapping-badge warning"}>{monthlyReconciliation.passed ? "已完成" : "未完成"}</span></div>
          <div className={`import-report ${monthlyReconciliation.passed ? "passed" : "warning"}`}><span>{monthlyReconciliation.passed ? <CheckCircle size={19} weight="fill" /> : <WarningCircle size={19} />}</span><div><strong>{monthlyReconciliation.message}</strong><p>期初 {displayMoney(monthlyReconciliation.openingBalance)} ＋ 收入 {displayMoney(monthlyReconciliation.income)} − 支出 {displayMoney(monthlyReconciliation.expense)} ＝ 计算期末 {displayMoney(monthlyReconciliation.calculatedClosing)}；对账单期末 {displayMoney(monthlyReconciliation.statementClosing)}；差额 {displayMoney(monthlyReconciliation.difference)}</p></div></div>
          {monthlyReconciliation.imports.length > 0 && <div className="bank-preview-scroll"><table><thead><tr><th>导入文件</th><th>数据起止日期</th><th>导入时间</th><th>操作者</th><th>新增</th><th>重复</th><th>异常</th></tr></thead><tbody>{monthlyReconciliation.imports.map((record) => <tr key={record.id}><td>{record.fileName}</td><td>{record.dateFrom || "—"} 至 {record.dateTo || "—"}</td><td>{displayDateTime(record.importedAt)}</td><td>{record.actor}</td><td>{record.importableRowCount} 笔</td><td>{record.duplicateCount} 笔</td><td>{record.anomalousRowCount} 笔</td></tr>)}</tbody></table></div>}
        </div>
      )}

      {parsed && inspection && (
        <div className="bank-import-workspace">
          <div className="bank-file-summary"><span><strong>{parsed.fileName}</strong><small>{parsed.sheetName ? `工作表：${parsed.sheetName} · ` : ""}${inspection.rowCount} 行</small></span><span className={inspection.missingFields.length ? "mapping-badge warning" : "mapping-badge"}>{inspection.missingFields.length ? `缺 ${inspection.missingFields.length} 项映射` : "必要字段已识别"}</span></div>

          <div className="mapping-grid">
            {MAPPING_FIELDS.map((field) => (
              <label className="foundation-field" key={field}><span>{BANK_FIELD_DEFINITIONS[field].label}{BANK_FIELD_DEFINITIONS[field].required ? " *" : ""}</span><select value={mapping[field] ?? ""} onChange={(event) => changeMapping(field, event.target.value)}><option value="">不导入此字段</option>{inspection.headers.map((header, index) => <option value={index} key={`${field}-${index}`}>{header}</option>)}</select></label>
            ))}
          </div>

          <div className="balance-inputs">
            <label className="foundation-field"><span>期初余额</span><input type="number" step="0.01" value={openingBalance} onChange={(event) => { setOpeningBalance(event.target.value); setPlan(null); }} /></label>
            <span>＋ 本期收入 − 本期支出 ＝</span>
            <label className="foundation-field"><span>对账单期末余额</span><input type="number" step="0.01" value={statementClosing} onChange={(event) => { setStatementClosing(event.target.value); setPlan(null); }} /></label>
          </div>

          <div className="bank-preview-scroll"><table><thead><tr><th>原始行</th>{inspection.headers.slice(0, 7).map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{inspection.preview.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td>{row.cells.slice(0, 7).map((cell, index) => <td key={`${row.rowNumber}-${index}`}>{String(cell.value)}</td>)}</tr>)}</tbody></table></div>

          {plan && counterpartyPreviewGroups.length > 0 && <div><div className="bank-file-summary"><span><strong>交易对手标准化</strong><small>把原始名称映射到当前工作台对象，或填写手工标准名称；确认导入后保存为本地别名规则。</small></span><span className={counterpartyMappingDirty ? "mapping-badge warning" : "mapping-badge"}>{counterpartyMappingDirty ? "待重新预检查" : "映射已计入预览"}</span></div>{counterpartyPreviewGroups.map((group) => { const selected = counterpartyMappings[group.key]; return <div key={group.key}><div className="bank-file-summary"><span><strong>{group.rawName || "未提供对方名称"}</strong><small>{group.counterpartyAccount ? `账号 ${group.counterpartyAccount} · ` : ""}${group.rowCount} 笔流水</small></span><span className={group.mappingSource ? "mapping-badge" : "mapping-badge warning"}>{group.mappingSource ? `已套用：${group.standardName}` : "尚未标准化"}</span></div><div className="mapping-grid"><label className="foundation-field"><span>映射到标准对象</span><select value={selected?.targetKey || ""} onChange={(event) => chooseCounterpartyTarget(group, event.target.value)}><option value="">暂不映射</option>{counterpartyTargetGroups.map((targetGroup) => <optgroup label={targetGroup.label} key={targetGroup.label}>{targetGroup.items.map((target) => <option value={target.key} key={target.key}>{target.name}</option>)}</optgroup>)}<option value="manual">手工标准名称</option></select></label>{selected?.targetKey === "manual" && <><label className="foundation-field"><span>标准名称</span><input value={selected.standardName || ""} onChange={(event) => updateManualCounterparty(group, { standardName: event.target.value })} placeholder="例如：上海青禾科技有限公司" /></label><label className="foundation-field"><span>对象类型</span><select value={selected.kind || "other"} onChange={(event) => updateManualCounterparty(group, { kind: event.target.value })}><option value="customer">客户</option><option value="supplier">供应商</option><option value="employee">员工</option><option value="related_party">关联方</option><option value="other">其他</option></select></label></>}</div></div>; })}</div>}

          <div className="foundation-inline-actions"><button className="secondary-button" disabled={busy} type="button" onClick={previewImport}>{counterpartyMappingDirty ? "保存映射并重新预检查" : "预检查去重、余额与异常"}</button>{plan && <button className="primary-button" type="button" onClick={applyImport} disabled={busy || counterpartyMappingDirty || !plan.importableRowCount || plan.errorCount > 0 || !plan.reconciliation.available || !plan.reconciliation.passed}>{busy ? "正在写入…" : `确认导入 ${plan.importableRowCount} 笔`}</button>}</div>

          {plan && <div className={`import-report ${plan.reconciliation.passed && !plan.anomalyCount ? "passed" : "warning"}`}><span>{plan.reconciliation.passed && !plan.anomalyCount ? <CheckCircle size={19} weight="fill" /> : <WarningCircle size={19} />}</span><div><strong>{plan.reconciliation.message}</strong><p>账期 {plan.period} · 可导入 {plan.importableRowCount} 笔 · 重复 {plan.duplicateCount} 笔 · 自动识别 {plan.recognitionCount || 0} 项 · 异常 {plan.anomalyCount || 0} 项 · 错误 {plan.errorCount} 行 · 流水变动 {plan.reconciliation.movement.toFixed(2)} 元</p>{(plan.recognitions || []).slice(0, 5).map((item) => <small key={`${item.id}-${item.transactionId}`}>第 {plan.transactions.find((transaction) => transaction.id === item.transactionId)?.sourceRow || "—"} 行 · {item.label}：{item.message}</small>)}{plan.recognitionCount > 5 && <small>另有 {plan.recognitionCount - 5} 项确定事项将在导入时一并写入。</small>}{plan.errors.slice(0, 3).map((item) => <small key={`error-${item.rowNumber}`}>第 {item.rowNumber} 行：{item.message}</small>)}{(plan.anomalies || []).slice(0, 5).map((item) => <small key={`${item.transactionId}-${item.code}`}>第 {item.sourceRow} 行 · {item.label}：{item.message}</small>)}{plan.anomalyCount > 5 && <small>另有 {plan.anomalyCount - 5} 项异常，导入后进入待复核。</small>}</div></div>}
        </div>
      )}

      {account && period && <div className="bank-import-workspace"><div className="foundation-section-heading"><div><small>微信 / 支付宝 / POS · 本地核对</small><h3><Table size={18} />平台结算单导入</h3></div>{settlementParsed && <button className="foundation-icon-button" disabled={settlementBusy} type="button" aria-label="取消当前结算文件" onClick={() => { setSettlementParsed(null); setSettlementPlan(null); }}><X size={16} /></button>}</div><div className="bank-import-start"><label className="foundation-field"><span>结算渠道</span><select value={settlementChannel} onChange={(event) => { setSettlementChannel(event.target.value); setSettlementPlan(null); }}>{Object.entries(PLATFORM_SETTLEMENT_CHANNELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><button className="secondary-button" disabled={settlementBusy} type="button" onClick={() => settlementInputRef.current?.click()}><FileArrowUp size={17} />{settlementBusy ? "正在处理…" : settlementParsed ? "更换结算文件" : "选择结算单 CSV / Excel"}</button><input ref={settlementInputRef} type="file" hidden accept=".csv,.txt,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={chooseSettlementFile} /></div><p className="foundation-hint">银行只核对净结算额；营业收入保留交易总额，平台手续费与退款分别保存。</p>{settlementError && <div className="foundation-error"><WarningCircle size={18} />{settlementError}</div>}{settlementParsed && settlementInspection && <><div className="bank-file-summary"><span><strong>{settlementParsed.fileName}</strong><small>{settlementParsed.sheetName ? `工作表：${settlementParsed.sheetName} · ` : ""}{settlementInspection.rowCount} 行</small></span><span className={settlementInspection.missingFields.length ? "mapping-badge warning" : "mapping-badge"}>{settlementInspection.missingFields.length ? `缺 ${settlementInspection.missingFields.length} 项映射` : "结算字段已识别"}</span></div><div className="mapping-grid">{SETTLEMENT_MAPPING_FIELDS.map((field) => <label className="foundation-field" key={field}><span>{PLATFORM_SETTLEMENT_FIELD_DEFINITIONS[field].label} *</span><select value={settlementMapping[field] ?? ""} onChange={(event) => changeSettlementMapping(field, event.target.value)}><option value="">请选择列</option>{settlementInspection.headers.map((header, index) => <option value={index} key={`${field}-${index}`}>{header}</option>)}</select></label>)}</div><div className="bank-preview-scroll"><table><thead><tr><th>原始行</th>{settlementInspection.headers.slice(0, 7).map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{settlementInspection.preview.map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td>{row.cells.slice(0, 7).map((cell, index) => <td key={`${row.rowNumber}-${index}`}>{String(cell.value)}</td>)}</tr>)}</tbody></table></div><div className="foundation-inline-actions"><button className="secondary-button" disabled={settlementBusy} type="button" onClick={previewSettlementImport}>预检查结算构成与银行到账</button>{settlementPlan && <button className="primary-button" disabled={settlementBusy || !settlementPlan.importableRowCount || settlementPlan.errorCount > 0} type="button" onClick={applySettlementImport}>{settlementBusy ? "正在写入…" : `确认导入 ${settlementPlan.importableRowCount} 份`}</button>}</div>{settlementPlan && <div className={`import-report ${settlementPlan.anomalyCount ? "warning" : "passed"}`}><span>{settlementPlan.anomalyCount ? <WarningCircle size={19} /> : <CheckCircle size={19} weight="fill" />}</span><div><strong>可导入 {settlementPlan.importableRowCount} 份 · 已匹配到账 {settlementPlan.matchedCount} 份</strong><p>重复 {settlementPlan.duplicateCount} 份 · 异常 {settlementPlan.anomalousRowCount} 份 · 错误 {settlementPlan.errorCount} 行</p>{settlementPlan.errors.slice(0, 3).map((item) => <small key={`settlement-error-${item.rowNumber}`}>第 {item.rowNumber} 行：{item.message}</small>)}{settlementPlan.anomalies.slice(0, 5).map((item) => <small key={`${item.settlementId}-${item.code}`}>{item.settlementNo} · {item.label}：{item.message}</small>)}</div></div>}{settlementPlan && <div className="bank-preview-scroll"><table><thead><tr><th>结算日</th><th>渠道 / 单号</th><th>交易总额</th><th>手续费</th><th>退款</th><th>净结算额</th><th>银行到账</th></tr></thead><tbody>{settlementPlan.settlements.map((item) => <tr key={item.id}><td>{item.settlementDate}</td><td>{item.channelLabel} · {item.settlementNo}</td><td>{displayMoney(item.grossAmount)}</td><td>{displayMoney(item.feeAmount)}</td><td>{displayMoney(item.refundAmount)}</td><td>{displayMoney(item.netAmount)}</td><td>{item.bankTransactionId ? `已匹配 ${displayMoney(item.bankAmount)}` : item.candidateBankTransactionId ? `差异 ${displayMoney(item.amountDifference)}` : "未匹配"}</td></tr>)}</tbody></table></div>}</>}{platformSettlements.length > 0 && <><div className="bank-file-summary"><span><strong>本期已导入平台结算</strong><small>{platformSettlements.length} 份 · 数据保存在当前工作台</small></span></div><div className="bank-preview-scroll"><table><thead><tr><th>结算日</th><th>渠道 / 单号</th><th>交易总额</th><th>手续费</th><th>退款</th><th>净额</th><th>到账状态</th></tr></thead><tbody>{platformSettlements.map((item) => <tr key={item.id}><td>{item.settlementDate}</td><td>{item.channelLabel} · {item.settlementNo}</td><td>{displayMoney(item.grossAmount)}</td><td>{displayMoney(item.feeAmount)}</td><td>{displayMoney(item.refundAmount)}</td><td>{displayMoney(item.netAmount)}</td><td>{item.bankTransactionId ? "已匹配银行流水" : item.candidateBankTransactionId ? `金额差异 ${displayMoney(item.amountDifference)}` : "未匹配"}</td></tr>)}</tbody></table></div></>}</div>}
    </section>
  );
}
