import { useEffect, useRef, useState } from "react";
import { Archive, DownloadSimple, FileArrowUp, FileText, Trash, WarningCircle } from "@phosphor-icons/react";

import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import { downloadStoredDocument, removeLocalDocument, saveLocalDocument } from "./documentIntake.js";

const CATEGORIES = ["主体资料", "合同", "银行流水", "业务资料", "发票", "审批资料", "人员资料", "会计资料", "其他资料"];

function fileSize(size) {
  if (!Number.isFinite(Number(size))) return "未知大小";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function DocumentIntakePanel({ defaultCategory = "其他资料", compact = false, onToast }) {
  const { activeWorkspace, actions, store, fileVault } = useFinanceDesk();
  const inputRef = useRef(null);
  const [category, setCategory] = useState(defaultCategory);
  const [period, setPeriod] = useState(activeWorkspace.currentPeriod || "");
  const [relatedObjectId, setRelatedObjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setPeriod(activeWorkspace.currentPeriod || "");
    setRelatedObjectId("");
    setError("");
  }, [activeWorkspace.id, activeWorkspace.currentPeriod]);

  async function addFiles(event) {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (!files.length) return;
    setBusy(true);
    setError("");
    try {
      for (const file of files) {
        await saveLocalDocument({
          store,
          fileVault,
          workspaceId: activeWorkspace.id,
          file,
          metadata: {
            category,
            period,
            relatedObjectIds: relatedObjectId.trim() ? [relatedObjectId.trim()] : [],
          },
        });
      }
      onToast?.(`已将 ${files.length} 份资料保存到当前浏览器`);
    } catch (caught) {
      setError(caught.message || "资料保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function download(document) {
    setError("");
    try {
      const record = await fileVault.get(document.storage?.blobId || document.id);
      downloadStoredDocument(record);
      const current = store.getActiveWorkspace();
      actions.replaceWorkspace(current.id, current, {
        audit: {
          actor: "本地用户",
          action: "下载本地资料",
          detail: `${document.name} · 原文件未离开当前设备`,
        },
      });
    } catch (caught) {
      setError(caught.message || "找不到这份资料的本地文件内容");
    }
  }

  async function remove(document) {
    if (!window.confirm(`确定删除「${document.name}」及其浏览器本地文件吗？`)) return;
    setError("");
    try {
      await removeLocalDocument({ store, fileVault, workspaceId: activeWorkspace.id, documentId: document.id });
      onToast?.("本地资料已删除");
    } catch (caught) {
      setError(caught.message || "资料删除失败");
    }
  }

  function archive(document) {
    actions.upsertEntity(activeWorkspace.id, "documents", { ...document, lifecycleStatus: "已归档", archiveStatus: "archived" }, { label: "资料状态" });
    onToast?.("资料已标记归档");
  }

  return (
    <section className={`foundation-section document-intake-panel ${compact ? "compact" : "intake-wide"}`}>
      <div className="foundation-section-heading"><div><small>IndexedDB · 不上传</small><h3><FileText size={18} />资料与证据</h3></div><span>{activeWorkspace.documents.length} 份</span></div>
      {!fileVault && <div className="foundation-error"><WarningCircle size={18} />当前环境不支持浏览器本地文件保险箱，只能查看已有资料元数据。</div>}
      <div className="document-intake-controls">
        <label className="foundation-field"><span>资料类别</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="foundation-field"><span>业务期间</span><input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} /></label>
        <label className="foundation-field"><span>关联对象 ID（可选）</span><input value={relatedObjectId} onChange={(event) => setRelatedObjectId(event.target.value)} placeholder="合同、流水、发票或审批 ID" /></label>
        <button className="secondary-button" type="button" disabled={!fileVault || busy} onClick={() => inputRef.current?.click()}><FileArrowUp size={17} />{busy ? "正在保存…" : "选择本地资料"}</button>
        <input ref={inputRef} type="file" multiple hidden onChange={addFiles} />
      </div>
      <p className="foundation-hint">原文件保存在当前浏览器的 IndexedDB；工作台保存文件哈希、版本、来源、状态和证据关联。不会发送到外部服务。</p>
      {error && <div className="foundation-error"><WarningCircle size={18} />{error}</div>}
      <div className="document-record-grid">
        {activeWorkspace.documents.map((document) => {
          const locallyAvailable = document.storage?.mode === "indexeddb" && document.storage?.availableLocally;
          return <article className="document-record" key={document.id}><span className="document-record-icon"><FileText size={20} /></span><div><strong>{document.name}</strong><small>{document.category} · {fileSize(document.size)} · {document.lifecycleStatus || "已获取"}</small><p>{document.hash ? `哈希 ${document.hash.slice(0, 12)}…` : "模板资料元数据；未保存原文件"}</p></div><span className="foundation-record-actions"><button type="button" disabled={!locallyAvailable || !fileVault} aria-label="下载本地文件" onClick={() => download(document)}><DownloadSimple size={15} /></button><button type="button" aria-label="标记归档" onClick={() => archive(document)}><Archive size={15} /></button><button type="button" aria-label="删除资料" onClick={() => remove(document)}><Trash size={15} /></button></span></article>;
        })}
      </div>
    </section>
  );
}
