import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, FileArrowUp, Table, WarningCircle, X } from "@phosphor-icons/react";

import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import {
  BANK_FIELD_DEFINITIONS,
  inspectBankTable,
  prepareBankImport,
  readBankFile,
} from "./bankStatementImport.js";
import { hashLocalFile, removeLocalDocument, saveLocalDocument } from "./documentIntake.js";

const MAPPING_FIELDS = ["date", "amount", "credit", "debit", "direction", "counterparty", "counterpartyAccount", "summary", "serial", "balance", "channel", "currency"];

export function BankImportPanel({ compact = false, onToast, onComplete }) {
  const { activeWorkspace, actions, store, fileVault } = useFinanceDesk();
  const inputRef = useRef(null);
  const [accountId, setAccountId] = useState(activeWorkspace.bankAccounts[0]?.id || "");
  const [parsed, setParsed] = useState(null);
  const [mapping, setMapping] = useState({});
  const [openingBalance, setOpeningBalance] = useState("");
  const [statementClosing, setStatementClosing] = useState("");
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const firstAccountId = activeWorkspace.bankAccounts[0]?.id || "";

  const account = activeWorkspace.bankAccounts.find((item) => item.id === accountId);
  useEffect(() => {
    const next = activeWorkspace.bankAccounts.find((item) => item.id === accountId) || activeWorkspace.bankAccounts[0];
    setAccountId(next?.id || "");
    setOpeningBalance(next?.openingBalance ?? "");
    setStatementClosing(next?.statementClosing ?? "");
    setParsed(null);
    setPlan(null);
    setError("");
  }, [activeWorkspace.id, firstAccountId]);

  useEffect(() => {
    if (!account) return;
    setOpeningBalance(account.openingBalance ?? "");
    setStatementClosing(account.statementClosing ?? "");
    setPlan(null);
  }, [accountId]);

  const inspection = useMemo(() => parsed ? inspectBankTable(parsed.table, { mapping }) : null, [parsed, mapping]);

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
    setPlan(null);
  }

  function previewImport() {
    setError("");
    try {
      const nextPlan = prepareBankImport(activeWorkspace, {
        accountId,
        fileName: parsed.fileName,
        fileHash: parsed.fileHash,
        sheetName: parsed.sheetName,
        table: parsed.table,
        mapping,
        openingBalance,
        statementClosing,
      });
      setPlan(nextPlan);
    } catch (caught) {
      setPlan(null);
      setError(caught.message || "导入预检查失败");
    }
  }

  async function applyImport() {
    setError("");
    let sourceDocument = null;
    try {
      if (!fileVault) throw new Error("当前浏览器无法保存银行流水原文件，请更换支持 IndexedDB 的浏览器");
      sourceDocument = await saveLocalDocument({
        store,
        fileVault,
        workspaceId: activeWorkspace.id,
        file: parsed.file,
        metadata: {
          category: "银行流水",
          period: plan.period,
          relatedObjectIds: [plan.accountId],
          actor: "本地用户",
        },
        relation: "bank-statement-source",
        note: `银行导入 ${plan.id} 的原始文件`,
      });
      const finalPlan = {
        ...plan,
        sourceDocumentId: sourceDocument.id,
        transactions: plan.transactions.map((transaction) => ({
          ...transaction,
          evidenceIds: [...new Set([...(transaction.evidenceIds || []), sourceDocument.id])],
        })),
      };
      actions.applyBankImport(activeWorkspace.id, finalPlan);
      onToast?.(`已导入 ${plan.importableRowCount} 笔流水，跳过 ${plan.duplicateCount} 笔重复`);
      onComplete?.(finalPlan);
      setParsed(null);
      setPlan(null);
    } catch (caught) {
      if (sourceDocument) {
        try {
          await removeLocalDocument({ store, fileVault, workspaceId: activeWorkspace.id, documentId: sourceDocument.id });
        } catch {
          // Keep the original import error; any local residue remains visible in the documents list.
        }
      }
      setError(caught.message || "导入失败");
    }
  }

  return (
    <section className={`foundation-section bank-import-panel ${compact ? "compact" : "intake-wide"}`}>
      <div className="foundation-section-heading"><div><small>CSV / Excel · 不联网</small><h3><Table size={18} />银行流水导入</h3></div>{parsed && <button className="foundation-icon-button" type="button" aria-label="取消当前文件" onClick={() => { setParsed(null); setPlan(null); }}><X size={16} /></button>}</div>
      {!activeWorkspace.bankAccounts.length ? (
        <div className="foundation-error"><WarningCircle size={18} />请先在上方新增银行账户，再导入该账户的流水。</div>
      ) : (
        <>
          <div className="bank-import-start">
            <label className="foundation-field"><span>导入到银行账户</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{activeWorkspace.bankAccounts.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
            <button className="secondary-button" disabled={busy} type="button" onClick={() => inputRef.current?.click()}><FileArrowUp size={17} />{busy ? "正在读取…" : parsed ? "更换文件" : "选择 CSV / Excel"}</button>
            <input ref={inputRef} type="file" hidden accept=".csv,.txt,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={chooseFile} />
          </div>
          <p className="foundation-hint">文件在当前浏览器中解析，不会上传。系统保留文件名、哈希、原始行号和原始单元格，便于追溯。</p>
        </>
      )}

      {error && <div className="foundation-error"><WarningCircle size={18} />{error}</div>}

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

          <div className="foundation-inline-actions"><button className="secondary-button" type="button" onClick={previewImport}>预检查去重与余额</button>{plan && <button className="primary-button" type="button" onClick={applyImport} disabled={!plan.importableRowCount}>确认导入 {plan.importableRowCount} 笔</button>}</div>

          {plan && <div className={`import-report ${plan.reconciliation.passed ? "passed" : "warning"}`}><span>{plan.reconciliation.passed ? <CheckCircle size={19} weight="fill" /> : <WarningCircle size={19} />}</span><div><strong>{plan.reconciliation.message}</strong><p>可导入 {plan.importableRowCount} 笔 · 重复 {plan.duplicateCount} 笔 · 错误 {plan.errorCount} 行 · 流水变动 {plan.reconciliation.movement.toFixed(2)} 元</p>{plan.errors.slice(0, 3).map((item) => <small key={item.rowNumber}>第 {item.rowNumber} 行：{item.message}</small>)}</div></div>}
        </div>
      )}
    </section>
  );
}
