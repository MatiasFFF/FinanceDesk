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
import { BLANK_WORKSPACE_INITIAL_ROLE_OPTIONS } from "../../domain/foundation.js";
import { localAccountingPeriod } from "../../domain/periods.js";
import { WORKSPACE_MODULE_OPTIONS, defaultWorkspaceModules } from "../../productWorkflow.js";
import { copyWorkspaceLocalFiles } from "../intake/documentIntake.js";
import { generateWorkspaceBackup, restoreWorkspaceBackup, restoreWorkspaceJsonBackup } from "./workspaceBackup.js";
import "./foundation-ui.css";

const DEFAULT_TERMINOLOGY = Object.freeze({
  customer: "客户",
  supplier: "供应商",
  personnel: "员工",
  location: "门店",
  member: "会员",
  coach: "教练",
  service: "服务",
});

function workspaceTerminology(workspace) {
  return Object.fromEntries(Object.entries(DEFAULT_TERMINOLOGY).map(([key, fallback]) => [
    key,
    String(workspace?.terminology?.[key] || "").trim() || fallback,
  ]));
}

function businessTermCopy(value, terminology) {
  return String(value || "")
    .replaceAll("客户", terminology.customer)
    .replaceAll("供应商", terminology.supplier)
    .replaceAll("员工", terminology.personnel)
    .replaceAll("门店", terminology.location)
    .replaceAll("会员", terminology.member)
    .replaceAll("教练", terminology.coach)
    .replaceAll("服务", terminology.service);
}

function downloadBackup(bytes, fileName) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
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
  const [newModules, setNewModules] = useState(() => defaultWorkspaceModules("blank"));
  const [newName, setNewName] = useState("");
  const [newPeriod, setNewPeriod] = useState(localAccountingPeriod);
  const [newOperatorName, setNewOperatorName] = useState("");
  const [newOperatorRoleId, setNewOperatorRoleId] = useState(BLANK_WORKSPACE_INITIAL_ROLE_OPTIONS[0]?.id || "role-owner");
  const [newFinanceContact, setNewFinanceContact] = useState("");
  const [renameValue, setRenameValue] = useState(activeWorkspace.name);
  const [importMode, setImportMode] = useState("merge");
  const [backupBusy, setBackupBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const importRef = useRef(null);
  const importButtonRef = useRef(null);
  const confirmationDialogRef = useRef(null);
  const confirmationCancelRef = useRef(null);
  const confirmationTriggerRef = useRef(null);
  const activeTerminology = workspaceTerminology(activeWorkspace);
  const copySourceWorkspace = state.workspaces.find((workspace) => workspace.id === sourceWorkspaceId);
  const newWorkspaceTerminology = createMode === "copy"
    ? workspaceTerminology(copySourceWorkspace)
    : DEFAULT_TERMINOLOGY;

  function currentActorName() {
    const latest = store.getState();
    const currentWorkspace = latest.workspaces.find((workspace) => workspace.id === latest.activeWorkspaceId);
    const activeUsers = currentWorkspace?.users?.filter((user) => user.status === "active") || [];
    return activeUsers.find((user) => user.id === latest.activeUserId)?.name?.trim() || "未选择操作身份";
  }

  useEffect(() => {
    setRenameValue(activeWorkspace.name);
    setSourceWorkspaceId(activeWorkspace.id);
    setNewModules(createMode === "copy" ? { ...activeWorkspace.modules } : defaultWorkspaceModules("blank"));
  }, [activeWorkspace.id, activeWorkspace.name, createMode]);

  useEffect(() => {
    if (open) return;
    setPendingConfirmation(null);
    setConfirmationBusy(false);
    confirmationTriggerRef.current = null;
  }, [open]);

  useEffect(() => {
    if (!open || pendingConfirmation) return undefined;
    function handleManagerKeyDown(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setConfirmationBusy(false);
      confirmationTriggerRef.current = null;
      onClose();
    }
    document.addEventListener("keydown", handleManagerKeyDown);
    return () => document.removeEventListener("keydown", handleManagerKeyDown);
  }, [open, pendingConfirmation, onClose]);

  useEffect(() => {
    if (pendingConfirmation) confirmationCancelRef.current?.focus();
  }, [pendingConfirmation]);

  useEffect(() => {
    if (!pendingConfirmation) return undefined;
    function handleConfirmationKeyDown(event) {
      if (event.key === "Escape") {
        if (confirmationBusy) return;
        event.preventDefault();
        const trigger = confirmationTriggerRef.current;
        setPendingConfirmation(null);
        confirmationTriggerRef.current = null;
        window.requestAnimationFrame(() => {
          if (trigger?.isConnected) trigger.focus();
        });
        return;
      }
      if (event.key !== "Tab") return;
      const buttons = Array.from(confirmationDialogRef.current?.querySelectorAll("button:not([disabled])") || []);
      if (!buttons.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleConfirmationKeyDown);
    return () => document.removeEventListener("keydown", handleConfirmationKeyDown);
  }, [pendingConfirmation, confirmationBusy]);

  if (!open) return null;

  function requestConfirmation(type, trigger, file = null) {
    setError("");
    setConfirmationBusy(false);
    confirmationTriggerRef.current = trigger || null;
    setPendingConfirmation({ type, file });
  }

  function cancelConfirmation() {
    if (confirmationBusy) return;
    const trigger = confirmationTriggerRef.current;
    setPendingConfirmation(null);
    confirmationTriggerRef.current = null;
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  }

  function closeManager() {
    setPendingConfirmation(null);
    setConfirmationBusy(false);
    confirmationTriggerRef.current = null;
    onClose();
  }

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
        ? { name, sourceWorkspaceId, modules: newModules }
        : {
          name,
          currentPeriod: newPeriod,
          industry: "其他服务业",
          taxpayerType: "小规模纳税人",
          modules: newModules,
          initialUserName: newOperatorName.trim(),
          initialUserRoleId: newOperatorRoleId,
          financeContact: newFinanceContact.trim(),
        };
      created = actions.createWorkspace(input);
      if (createMode === "copy") {
        await copyWorkspaceLocalFiles({ store, fileVault, sourceWorkspaceId, targetWorkspaceId: created.id });
      }
      setNewName("");
      setNewOperatorName("");
      setNewOperatorRoleId(BLANK_WORKSPACE_INITIAL_ROLE_OPTIONS[0]?.id || "role-owner");
      setNewFinanceContact("");
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

  function setCreationMode(mode) {
    setCreateMode(mode);
    const source = state.workspaces.find((workspace) => workspace.id === sourceWorkspaceId) || activeWorkspace;
    setNewModules(mode === "copy" ? { ...source.modules } : defaultWorkspaceModules("blank"));
  }

  function selectCopySource(workspaceId) {
    setSourceWorkspaceId(workspaceId);
    const source = state.workspaces.find((workspace) => workspace.id === workspaceId);
    if (source) setNewModules({ ...source.modules });
  }

  function toggleActiveModule(moduleId, enabled) {
    const moduleLabel = WORKSPACE_MODULE_OPTIONS.find((item) => item.id === moduleId)?.label || "模块";
    run(
      () => actions.updateWorkspaceModules(activeWorkspace.id, { [moduleId]: enabled }),
      `${businessTermCopy(moduleLabel, activeTerminology)}已${enabled ? "启用" : "停用"}`,
    );
  }

  async function deleteActive() {
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

  async function applyBackupImport(file, mode) {
    setError("");
    setBackupBusy(true);
    try {
      if (/\.zip$/i.test(file.name)) {
        const result = await restoreWorkspaceBackup({ store, fileVault, file, mode, actor: currentActorName() });
        onToast?.(`已恢复 ${result.workspaces} 个工作台、${result.restored} 份原件${result.missing ? `；${result.missing} 份资料缺少原件` : ""}${result.retainedOldFiles ? "；部分旧原件仍保留在本机" : ""}`);
        return;
      }
      const text = await file.text();
      const availability = await restoreWorkspaceJsonBackup({ store, fileVault, text, mode, actor: currentActorName() });
      onToast?.(`${mode === "merge" ? "备份已合并" : "本地数据已替换"}；${availability.missing ? `${availability.missing} 份原文件需重新关联` : "本地原文件状态已核对"}`);
    } catch (caught) {
      setError(caught.message || "备份导入失败");
    } finally {
      setBackupBusy(false);
    }
  }

  async function importBackup(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (importMode === "replace") {
      requestConfirmation("replace-backup", importButtonRef.current, file);
      return;
    }
    await applyBackupImport(file, "merge");
  }

  async function confirmPendingAction() {
    if (!pendingConfirmation || confirmationBusy) return;
    const confirmation = pendingConfirmation;
    setConfirmationBusy(true);
    try {
      if (confirmation.type === "delete-workspace") await deleteActive();
      if (confirmation.type === "clear-business") await clearActive();
      if (confirmation.type === "replace-backup") {
        if (!confirmation.file) throw new Error("未找到待导入的备份文件，请重新选择");
        await applyBackupImport(confirmation.file, "replace");
      }
    } catch (caught) {
      setError(caught.message || "操作失败");
    } finally {
      setPendingConfirmation(null);
      setConfirmationBusy(false);
      confirmationTriggerRef.current = null;
    }
  }

  async function exportBackup() {
    setError("");
    setBackupBusy(true);
    try {
      const current = store.getActiveWorkspace();
      actions.replaceWorkspace(current.id, current, {
        allowArchivedTransition: true,
        requiredPermission: "data.read",
        audit: {
          actor: currentActorName(),
          action: "导出工作台备份",
          detail: "导出全部工作台的业务数据、审计记录与可用原文件",
        },
      });
      const result = await generateWorkspaceBackup({ store, fileVault });
      downloadBackup(result.bytes, result.fileName);
      onToast?.(result.manifest.complete
        ? `完整备份已导出，包含 ${result.manifest.files.length} 份原件`
        : `已导出不完整备份；${result.manifest.missingFiles.length} 份原件不可用：${result.manifest.missingFiles.slice(0, 3).map((item) => item.name).join("、")}${result.manifest.missingFiles.length > 3 ? "等" : ""}`);
    } catch (caught) {
      setError(caught.message || "备份导出失败");
    } finally {
      setBackupBusy(false);
    }
  }

  const confirmationDetails = pendingConfirmation ? {
    "delete-workspace": {
      title: `删除「${activeWorkspace.name}」？`,
      summary: "这个工作台及其本地文件将被删除。",
      description: "业务数据、资料元数据和浏览器本地原文件会一并删除，且无法从本页面恢复。其他工作台不受影响。",
      confirmLabel: "确认删除",
    },
    "clear-business": {
      title: `清空「${activeWorkspace.name}」？`,
      summary: "企业设置会保留，业务记录会被清空。",
      description: "流水、资料、证据和凭证将被删除，且无法从本页面恢复。",
      confirmLabel: "确认清空",
    },
    "replace-backup": {
      title: "用这份备份替换本地数据？",
      summary: "当前所有工作台的业务数据和元数据会被覆盖。",
      description: "完整备份会恢复包内原件；旧 JSON 只恢复数据与原件索引。",
      confirmLabel: "确认替换并导入",
    },
  }[pendingConfirmation.type] : null;

  return (
    <div className="modal-backdrop foundation-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeManager()}>
      <section className="modal-card foundation-manager workspace-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-manager-title">
        <header className="modal-heading">
          <div><h2 id="workspace-manager-title">管理财务工作台</h2></div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={closeManager}><X size={19} /></button>
        </header>

        {error && <div className="foundation-error"><WarningCircle size={18} />{error}</div>}

        <div className="foundation-manager-grid">
          <section className="foundation-section">
            <div className="foundation-section-heading"><div><h3>我的工作台</h3></div><span>{state.workspaces.length} 个</span></div>
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

            <details className="foundation-disclosure">
              <summary><span><strong>当前工作台设置</strong></span><CaretDown size={16} /></summary>
              <div className="foundation-disclosure-body">
            <label className="foundation-field"><span>重命名当前工作台</span><input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} /></label>
            <div className="foundation-inline-actions">
              <button className="secondary-button" type="button" onClick={() => run(() => actions.renameWorkspace(activeWorkspace.id, renameValue), "工作台名称已更新")}>保存名称</button>
              <button className="danger-button" type="button" disabled={state.workspaces.length === 1} onClick={(event) => requestConfirmation("delete-workspace", event.currentTarget)}><Trash size={16} />删除</button>
            </div>
            {state.workspaces.length === 1 && <p className="foundation-hint">至少保留一个工作台；先创建新工作台后即可删除当前模板。</p>}
            <div className="foundation-divider" />
            <div className="foundation-section-heading"><div><h3>启用模块</h3></div></div>
            <div className="workspace-module-grid" role="group" aria-label="当前工作台启用模块">
              {WORKSPACE_MODULE_OPTIONS.map((module) => {
                const enabled = Boolean(activeWorkspace.modules?.[module.id]);
                return (
                  <label className={`workspace-module-card ${enabled ? "active" : ""}`} key={module.id}>
                    <input
                      className="workspace-module-card-input"
                      type="checkbox"
                      name="active-workspace-modules"
                      value={module.id}
                      checked={enabled}
                      onChange={(event) => toggleActiveModule(module.id, event.target.checked)}
                    />
                    <span className="workspace-module-card-copy">
                      <strong className="workspace-module-card-title">{businessTermCopy(module.label, activeTerminology)}</strong>
                      <small className="workspace-module-card-description">{businessTermCopy(module.description, activeTerminology)}</small>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="foundation-hint">月结总览、报表中心、资料归档和基础资料始终保留。</p>
              </div>
            </details>
          </section>

          <section className="foundation-section">
            <details className="foundation-disclosure">
              <summary><span><strong>新建或复制工作台</strong></span><CaretDown size={16} /></summary>
              <div className="foundation-disclosure-body">
            <form className="foundation-form" onSubmit={createWorkspace}>
              <label className="foundation-field"><span>名称</span><input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder={`例如：静安${newWorkspaceTerminology.location}`} /></label>
              <label className="foundation-field"><span>创建方式</span><select value={createMode} onChange={(event) => setCreationMode(event.target.value)}><option value="blank">空白工作台</option><option value="copy">复制现有工作台</option></select></label>
              {createMode === "copy" && <label className="foundation-field"><span>复制来源</span><select value={sourceWorkspaceId} onChange={(event) => selectCopySource(event.target.value)}>{state.workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select></label>}
              {createMode === "blank" && <>
                <label className="foundation-field"><span>起始账期</span><input required type="month" min="1900-01" max="9999-12" value={newPeriod} onChange={(event) => setNewPeriod(event.target.value)} /></label>
                <label className="foundation-field"><span>首位本地操作人员（可选）</span><input value={newOperatorName} onChange={(event) => setNewOperatorName(event.target.value)} placeholder="填写实际姓名" /></label>
                <label className="foundation-field"><span>首位人员角色</span><select value={newOperatorRoleId} onChange={(event) => setNewOperatorRoleId(event.target.value)} disabled={!newOperatorName.trim()}>{BLANK_WORKSPACE_INITIAL_ROLE_OPTIONS.map((role) => <option value={role.id} key={role.id}>{role.name}</option>)}</select></label>
                <label className="foundation-field"><span>财务负责人（可选）</span><input value={newFinanceContact} onChange={(event) => setNewFinanceContact(event.target.value)} placeholder="填写实际姓名或岗位" /></label>
                <p className="foundation-hint">人员和财务负责人都可留空；首位人员角色创建后仍可在基础资料中调整。</p>
              </>}
              <div className="workspace-module-grid" role="group" aria-label="新工作台启用模块">
                {WORKSPACE_MODULE_OPTIONS.map((module) => {
                  const enabled = Boolean(newModules[module.id]);
                  return (
                    <label className={`workspace-module-card ${enabled ? "active" : ""}`} key={module.id}>
                      <input
                        className="workspace-module-card-input"
                        type="checkbox"
                        name="new-workspace-modules"
                        value={module.id}
                        checked={enabled}
                        onChange={(event) => setNewModules((current) => ({ ...current, [module.id]: event.target.checked }))}
                      />
                      <span className="workspace-module-card-copy">
                        <strong className="workspace-module-card-title">{businessTermCopy(module.label, newWorkspaceTerminology)}</strong>
                        <small className="workspace-module-card-description">{businessTermCopy(module.description, newWorkspaceTerminology)}</small>
                      </span>
                    </label>
                  );
                })}
              </div>
              <button className="primary-button" type="submit"><Plus size={17} />创建并切换</button>
            </form>
              </div>
            </details>

            <div className="foundation-divider" />
            <div className="foundation-section-heading"><h3>备份与恢复</h3></div>
            <p className="foundation-hint">备份包含所有工作台的数据与原文件，也可导入旧 JSON。</p>
            <div className="foundation-inline-actions wrap">
              <button className="secondary-button" type="button" disabled={backupBusy} onClick={exportBackup}><DownloadSimple size={16} />导出备份</button>
              <select className="compact-select" disabled={backupBusy} value={importMode} onChange={(event) => setImportMode(event.target.value)} aria-label="备份导入方式"><option value="merge">合并导入</option><option value="replace">替换本地数据</option></select>
              <button ref={importButtonRef} className="secondary-button" type="button" disabled={backupBusy} onClick={() => importRef.current?.click()}><UploadSimple size={16} />导入备份</button>
              <input ref={importRef} type="file" accept="application/zip,.zip,application/json,.json" hidden onChange={importBackup} />
            </div>
          </section>
        </div>

        <footer className="foundation-manager-footer">
          <span><WarningCircle size={16} />资料在本机处理；银行、税务与外部 AI 未连接。</span>
          <button className="text-danger-button" type="button" onClick={(event) => requestConfirmation("clear-business", event.currentTarget)}>清空当前业务数据</button>
        </footer>
      </section>

      {confirmationDetails && (
        <div className="modal-backdrop foundation-backdrop workspace-confirm-backdrop">
          <section
            ref={confirmationDialogRef}
            className="modal-card workspace-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="workspace-confirm-title"
            aria-describedby="workspace-confirm-description"
            aria-busy={confirmationBusy}
          >
            <header className="modal-heading">
              <div><h2 id="workspace-confirm-title">{confirmationDetails.title}</h2></div>
            </header>
            <div className="delete-warning" id="workspace-confirm-description">
              <WarningCircle size={24} />
              <div>
                <strong>{confirmationDetails.summary}</strong>
                <p>{confirmationDetails.description}</p>
                {pendingConfirmation.type === "replace-backup" && <p>待导入文件：{pendingConfirmation.file?.name || "未选择文件"}</p>}
              </div>
            </div>
            <div className="modal-actions">
              <button ref={confirmationCancelRef} className="secondary-button" type="button" disabled={confirmationBusy} onClick={cancelConfirmation}>取消</button>
              <button className="danger-button" type="button" disabled={confirmationBusy} onClick={confirmPendingAction}>{confirmationBusy ? "处理中…" : confirmationDetails.confirmLabel}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
