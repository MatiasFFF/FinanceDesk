import { useEffect, useRef, useState } from "react";
import {
  CaretDown,
  Check,
  Copy,
  DownloadSimple,
  Plus,
  Trash,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import { copyWorkspaceLocalFiles, pruneUnreferencedLocalFiles, refreshLocalFileAvailability } from "../intake/documentIntake.js";
import "./foundation-ui.css";

function downloadJson(text, fileName) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function WorkspaceTrigger({ onClick, className = "brand" }) {
  const { activeWorkspace } = useFinanceDesk();
  return (
    <button className={className} type="button" onClick={onClick} aria-label="切换或管理工作台">
      <span className="brand-copy">
        <strong>{activeWorkspace.name}</strong>
        <small>财务工作台 · 浏览器本地</small>
      </span>
      <CaretDown size={14} />
    </button>
  );
}

export function WorkspaceManager({ open, onClose, onToast }) {
  const { state, activeWorkspace, actions, store, fileVault } = useFinanceDesk();
  const [createMode, setCreateMode] = useState("blank");
  const [sourceWorkspaceId, setSourceWorkspaceId] = useState(activeWorkspace.id);
  const [newName, setNewName] = useState("");
  const [renameValue, setRenameValue] = useState(activeWorkspace.name);
  const [importMode, setImportMode] = useState("merge");
  const [error, setError] = useState("");
  const importRef = useRef(null);

  useEffect(() => {
    setRenameValue(activeWorkspace.name);
    setSourceWorkspaceId(activeWorkspace.id);
  }, [activeWorkspace.id, activeWorkspace.name]);

  if (!open) return null;

  function run(action, successMessage) {
    setError("");
    try {
      action();
      onToast?.(successMessage);
      return true;
    } catch (caught) {
      setError(caught.message || "操作失败");
      return false;
    }
  }

  async function createWorkspace(event) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) {
      setError("请先填写工作台名称");
      return;
    }
    setError("");
    let created = null;
    try {
      const input = createMode === "copy"
        ? { name, sourceWorkspaceId }
        : { name, industry: "其他服务业", taxpayerType: "小规模纳税人" };
      created = actions.createWorkspace(input);
      if (createMode === "copy") {
        await copyWorkspaceLocalFiles({ store, fileVault, sourceWorkspaceId, targetWorkspaceId: created.id });
      }
      setNewName("");
      onToast?.(`已创建「${name}」`);
    } catch (caught) {
      if (created) {
        try {
          actions.deleteWorkspace(created.id);
          if (fileVault) await fileVault.clearWorkspace(created.id);
        } catch {
          // Keep the original error; the remaining workspace is visible and can be removed manually.
        }
      }
      setError(caught.message || "创建工作台失败");
    }
  }

  async function deleteActive() {
    if (!window.confirm(`确定删除「${activeWorkspace.name}」吗？该工作台的浏览器本地数据将一并删除。`)) return;
    setError("");
    const workspaceId = activeWorkspace.id;
    const workspaceName = activeWorkspace.name;
    let savedFiles = [];
    try {
      if (fileVault) {
        savedFiles = await fileVault.listByWorkspace(workspaceId);
        await fileVault.clearWorkspace(workspaceId);
      }
      try {
        actions.deleteWorkspace(workspaceId);
      } catch (caught) {
        if (fileVault) for (const record of savedFiles) await fileVault.put(record);
        throw caught;
      }
      onToast?.(`已删除「${workspaceName}」`);
    } catch (caught) {
      setError(caught.message || "删除工作台失败");
    }
  }

  async function clearActive() {
    if (!window.confirm(`确定清空「${activeWorkspace.name}」的流水、资料、证据和凭证吗？企业设置会保留。`)) return;
    setError("");
    const workspaceId = activeWorkspace.id;
    let savedFiles = [];
    try {
      if (fileVault) {
        savedFiles = await fileVault.listByWorkspace(workspaceId);
        await fileVault.clearWorkspace(workspaceId);
      }
      try {
        actions.clearWorkspace(workspaceId, { scope: "operational" });
      } catch (caught) {
        if (fileVault) for (const record of savedFiles) await fileVault.put(record);
        throw caught;
      }
      onToast?.("当前工作台的业务数据已清空");
    } catch (caught) {
      setError(caught.message || "清空工作台失败");
    }
  }

  async function importBackup(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (importMode === "replace" && !window.confirm("替换会覆盖当前所有工作台业务数据和元数据。原文件仅在仍能与导入记录匹配时保留，确定继续吗？")) return;
    setError("");
    try {
      const text = await file.text();
      const previousWorkspaceIds = new Set(store.getState().workspaces.map((workspace) => workspace.id));
      actions.importBackup(text, { mode: importMode });
      if (importMode === "replace" && fileVault) {
        const nextIds = new Set(store.getState().workspaces.map((workspace) => workspace.id));
        for (const workspaceId of previousWorkspaceIds) {
          if (!nextIds.has(workspaceId)) await fileVault.clearWorkspace(workspaceId);
        }
      }
      const availability = await refreshLocalFileAvailability({ store, fileVault });
      const cleanup = await pruneUnreferencedLocalFiles({ store, fileVault });
      const current = store.getActiveWorkspace();
      actions.replaceWorkspace(current.id, current, {
        allowArchivedTransition: true,
        requiredPermission: "workspace.manage",
        audit: {
          actor: "本地用户",
          action: "导入工作台备份",
          detail: `${importMode === "merge" ? "合并" : "替换"}导入；${availability.available} 份原文件仍可用，${availability.repaired} 份旧副本已隔离，${availability.missing} 份需重新关联，清理 ${cleanup.removed} 份孤立文件`,
        },
      });
      onToast?.(`${importMode === "merge" ? "备份已合并" : "本地数据已替换"}；${availability.missing ? `${availability.missing} 份原文件需重新关联` : "本地原文件状态已核对"}`);
    } catch (caught) {
      setError(caught.message || "备份导入失败");
    }
  }

  function exportBackup() {
    setError("");
    try {
      const current = store.getActiveWorkspace();
      actions.replaceWorkspace(current.id, current, {
        allowArchivedTransition: true,
        requiredPermission: "data.read",
        audit: {
          actor: "本地用户",
          action: "导出工作台备份",
          detail: "导出业务数据、资料元数据和审计记录；原文件仍保存在当前浏览器",
        },
      });
      downloadJson(actions.exportBackup(), `财务工作台备份-${new Date().toISOString().slice(0, 10)}.json`);
      onToast?.("工作台 JSON 备份已导出");
    } catch (caught) {
      setError(caught.message || "备份导出失败");
    }
  }

  return (
    <div className="modal-backdrop foundation-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card foundation-manager" role="dialog" aria-modal="true" aria-labelledby="workspace-manager-title">
        <header className="modal-heading">
          <div><p className="eyebrow">浏览器本地</p><h2 id="workspace-manager-title">管理财务工作台</h2></div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={19} /></button>
        </header>

        {error && <div className="foundation-error"><WarningCircle size={18} />{error}</div>}

        <div className="foundation-manager-grid">
          <section className="foundation-section">
            <div className="foundation-section-heading"><div><small>切换</small><h3>我的工作台</h3></div><span>{state.workspaces.length} 个</span></div>
            <div className="workspace-list">
              {state.workspaces.map((workspace) => (
                <button
                  className={`workspace-list-item ${workspace.id === activeWorkspace.id ? "active" : ""}`}
                  key={workspace.id}
                  type="button"
                  onClick={() => run(() => actions.switchWorkspace(workspace.id), `已切换到「${workspace.name}」`)}
                >
                  <span><strong>{workspace.name}</strong><small>{workspace.templateLabel || "本地工作台"}</small></span>
                  {workspace.id === activeWorkspace.id && <Check size={17} weight="bold" />}
                </button>
              ))}
            </div>

            <label className="foundation-field"><span>重命名当前工作台</span><input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} /></label>
            <div className="foundation-inline-actions">
              <button className="secondary-button" type="button" onClick={() => run(() => actions.renameWorkspace(activeWorkspace.id, renameValue), "工作台名称已更新")}>保存名称</button>
              <button className="danger-button" type="button" disabled={state.workspaces.length === 1} onClick={deleteActive}><Trash size={16} />删除</button>
            </div>
            {state.workspaces.length === 1 && <p className="foundation-hint">至少保留一个工作台；先创建新工作台后即可删除当前模板。</p>}
          </section>

          <section className="foundation-section">
            <div className="foundation-section-heading"><div><small>创建</small><h3>新工作台</h3></div><Plus size={19} /></div>
            <form className="foundation-form" onSubmit={createWorkspace}>
              <label className="foundation-field"><span>名称</span><input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="例如：静安门店" /></label>
              <label className="foundation-field"><span>创建方式</span><select value={createMode} onChange={(event) => setCreateMode(event.target.value)}><option value="blank">空白工作台</option><option value="copy">复制现有工作台</option></select></label>
              {createMode === "copy" && <label className="foundation-field"><span>复制来源</span><select value={sourceWorkspaceId} onChange={(event) => setSourceWorkspaceId(event.target.value)}>{state.workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select></label>}
              <button className="primary-button" type="submit"><Plus size={17} />创建并切换</button>
            </form>

            <div className="foundation-divider" />
            <div className="foundation-section-heading"><div><small>备份</small><h3>本地 JSON</h3></div></div>
            <p className="foundation-hint">JSON 包含业务数据、资料元数据和审计记录；资料原文件仍留在本浏览器的 IndexedDB 文件保险箱。</p>
            <div className="foundation-inline-actions wrap">
              <button className="secondary-button" type="button" onClick={exportBackup}><DownloadSimple size={16} />导出备份</button>
              <select className="compact-select" value={importMode} onChange={(event) => setImportMode(event.target.value)} aria-label="备份导入方式"><option value="merge">合并导入</option><option value="replace">替换本地数据</option></select>
              <button className="secondary-button" type="button" onClick={() => importRef.current?.click()}><UploadSimple size={16} />导入备份</button>
              <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={importBackup} />
            </div>
          </section>
        </div>

        <footer className="foundation-manager-footer">
          <span><WarningCircle size={16} />银行、税务、AI 与 OCR 均未连接；当前只处理本地数据。</span>
          <button className="text-danger-button" type="button" onClick={clearActive}>清空当前业务数据</button>
        </footer>
      </section>
    </div>
  );
}
