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
  const { state, activeWorkspace, actions, fileVault } = useFinanceDesk();
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

  function createWorkspace(event) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) {
      setError("请先填写工作台名称");
      return;
    }
    const input = createMode === "copy"
      ? { name, sourceWorkspaceId }
      : { name, industry: "其他服务业", taxpayerType: "小规模纳税人" };
    if (run(() => actions.createWorkspace(input), `已创建「${name}」`)) setNewName("");
  }

  async function deleteActive() {
    if (!window.confirm(`确定删除「${activeWorkspace.name}」吗？该工作台的浏览器本地数据将一并删除。`)) return;
    setError("");
    try {
      if (fileVault) await fileVault.clearWorkspace(activeWorkspace.id);
      actions.deleteWorkspace(activeWorkspace.id);
      onToast?.(`已删除「${activeWorkspace.name}」`);
    } catch (caught) {
      setError(caught.message || "删除工作台失败");
    }
  }

  async function clearActive() {
    if (!window.confirm(`确定清空「${activeWorkspace.name}」的流水、资料、证据和凭证吗？企业设置会保留。`)) return;
    setError("");
    try {
      if (fileVault) await fileVault.clearWorkspace(activeWorkspace.id);
      actions.clearWorkspace(activeWorkspace.id, { scope: "operational" });
      onToast?.("当前工作台的业务数据已清空");
    } catch (caught) {
      setError(caught.message || "清空工作台失败");
    }
  }

  async function importBackup(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    try {
      const text = await file.text();
      actions.importBackup(text, { mode: importMode });
      onToast?.(importMode === "merge" ? "备份已合并到本地工作台" : "本地数据已由备份替换");
    } catch (caught) {
      setError(caught.message || "备份导入失败");
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
              <button className="secondary-button" type="button" onClick={() => downloadJson(actions.exportBackup(), `财务工作台备份-${new Date().toISOString().slice(0, 10)}.json`)}><DownloadSimple size={16} />导出备份</button>
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
