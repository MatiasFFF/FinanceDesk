import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowSquareOut, CaretDown, CaretRight, Check, GearSix, Plus, UserCircle } from "@phosphor-icons/react";
import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import { BLANK_WORKSPACE_INITIAL_ROLE_OPTIONS, hasWorkspacePermission } from "../../domain/foundation.js";
import { isPeriodArchived, localAccountingPeriod } from "../../domain/periods.js";
import { AccountingPeriodPicker } from "../workspaces/AccountingPeriodPicker.jsx";
import { allowPeriodNavigation, usePeriodLeaveGuard } from "../workspaces/periodNavigation.js";
import { AiComposer } from "./AiComposer.jsx";
import { AiDialog } from "./AiDialog.jsx";
import { AiSettings } from "./AiSettings.jsx";
import { selectAiAttachments } from "./aiAttachments.js";
import { useAiSession, useAiSessionState } from "./AiSessionContext.jsx";
import { aiSessionContextKey, closeAiWorkspaceCreation, resumeAiHomeSubmission } from "./aiModeSession.js";
import { hasLocalBankAttachments } from "./aiBankSelfService.js";
import blueBackground from "../../assets/ai-blue-background.png";
import "./ai-simple.css";

const Conversation = lazy(() => import("./AiConversation.jsx"));
const Resources = lazy(() => import("./AiResources.jsx").then((module) => ({ default: module.AiResources })));
const blankDraft = () => ({ text: "", files: [] });

function CreateWorkspace({ onClose, onCreated }) {
  const { actions } = useFinanceDesk();
  const [name, setName] = useState("");
  const [period, setPeriod] = useState(localAccountingPeriod);
  const [operator, setOperator] = useState("");
  const [roleId, setRoleId] = useState(BLANK_WORKSPACE_INITIAL_ROLE_OPTIONS[0]?.id || "role-owner");
  const [error, setError] = useState("");
  const [initialPeriod] = useState(period);
  const dirty = !!name.trim() || !!operator.trim() || period !== initialPeriod || roleId !== (BLANK_WORKSPACE_INITIAL_ROLE_OPTIONS[0]?.id || "role-owner");
  const dirtyGuardId = usePeriodLeaveGuard({ dirty });
  useEffect(() => {
    if (!dirty) return undefined;
    const leave = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);
  return <AiDialog title="新建工作台" onClose={() => closeAiWorkspaceCreation({ dirty, confirm: (message) => window.confirm(message), onClose })}><form className="ai-settings-form" onSubmit={(event) => {
    event.preventDefault();
    try {
      if (!allowPeriodNavigation({ ignoreDirtyGuardId: dirtyGuardId })) return;
      const created = actions.createWorkspace({ name: name.trim(), currentPeriod: period, initialUserName: operator.trim(), initialUserRoleId: roleId }); onCreated(created);
    }
    catch (caught) { setError(caught.message || "工作台未能创建，请核对填写内容。"); }
  }}>
    <label className="ai-field"><span>工作台名称</span><input required value={name} maxLength={80} placeholder="公司或工作室名称" onChange={(event) => setName(event.target.value)} /></label>
    <label className="ai-field"><span>起始账期</span><input required type="month" value={period} onChange={(event) => setPeriod(event.target.value)} /></label>
    <label className="ai-field"><span>你的姓名</span><input required value={operator} maxLength={60} placeholder="用于记录资料和财务确认" onChange={(event) => setOperator(event.target.value)} /></label>
    <label className="ai-field"><span>操作身份</span><select value={roleId} onChange={(event) => setRoleId(event.target.value)}>{BLANK_WORKSPACE_INITIAL_ROLE_OPTIONS.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
    {error && <p className="ai-error" role="alert">{error}</p>}
    <div className="ai-dialog-actions"><button className="ai-primary-button" type="submit" disabled={!name.trim() || !operator.trim() || !period}>创建工作台</button></div>
  </form></AiDialog>;
}

export default function AiSimpleApp({ onOpenFullVersion }) {
  const { state, activeWorkspace, actions, persistenceStatus, store } = useFinanceDesk();
  const { readKey, configured, updateContext, getSnapshot } = useAiSession();
  const workspaceId = activeWorkspace?.id || "";
  const period = activeWorkspace?.currentPeriod || "";
  const [screen, setScreen] = useAiSessionState(workspaceId, period, "screen", "home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, changeDraft] = useAiSessionState(workspaceId, period, "draft", blankDraft);
  const [resources, setResources] = useAiSessionState(workspaceId, period, "resources", null);
  const rememberResourceState = useCallback((resourceState) => setResources((current) => current ? { ...current, resourceState } : current), [setResources]);
  const [busy, setBusy] = useState(false);
  const [sendOnEnter, setSendOnEnter] = useState(0);
  const [notice, setNotice] = useState("");
  const [attachmentNotice, setAttachmentNotice] = useState(null);
  const [dragging, setDragging] = useState(false);
  const menuRef = useRef(null);
  const menuPanelRef = useRef(null);
  const dragDepthRef = useRef(0);
  const pendingHomeSendRef = useRef(null);
  const targetKey = aiSessionContextKey(workspaceId, period);
  const activeUsers = (activeWorkspace?.users || []).filter((user) => user.status === "active");
  const canManage = !activeWorkspace || hasWorkspacePermission(state, activeWorkspace.id, "workspace.manage");
  const canAttach = !busy && !resources && !settingsOpen && !createOpen && persistenceStatus.canWrite && !!activeWorkspace && !isPeriodArchived(activeWorkspace) && hasWorkspacePermission(state, activeWorkspace.id, "documents.add");
  function addFiles(files) { changeDraft((current) => ({ ...current, files: [...current.files, ...files.map((file) => ({ id: crypto.randomUUID(), file }))] })); }
  const isFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes("Files") && !event.target.closest(".ai-dialog-backdrop");
  function resetDrag() { dragDepthRef.current = 0; setDragging(false); }
  function dropFiles(event) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    resetDrag();
    if (!canAttach) { setNotice(busy ? "当前正在处理资料，完成或停止后再添加。" : "请在可编辑的账期和操作身份下添加资料。"); return; }
    const result = selectAiAttachments(event.dataTransfer.files, draft.files);
    if (result.accepted.length) addFiles(result.accepted);
    setAttachmentNotice({ message: result.message, tone: result.tone, targetKey, revision: Date.now() });
  }
  function showError(error) { setNotice(error?.message || String(error)); }
  function enterWorkbench() { setMenuOpen(false); if (!activeWorkspace) setCreateOpen(true); else setScreen("workbench"); }
  function continueHomeSubmission() {
    const current = store.getActiveWorkspace();
    const currentDraft = getSnapshot().contexts[aiSessionContextKey(current?.id, current?.currentPeriod)]?.draft;
    return resumeAiHomeSubmission({ pendingRef: pendingHomeSendRef, workspace: current, draft: currentDraft, configured: !!readKey() || hasLocalBankAttachments(currentDraft), onSend: () => {
      setSendOnEnter((value) => value + 1);
      updateContext(current.id, current.currentPeriod, "screen", "workbench");
    } });
  }
  function sendFromHome() {
    if (!draft.text.trim() && !draft.files.length) return;
    pendingHomeSendRef.current = { workspaceId, period, draft };
    if (!activeWorkspace) { setCreateOpen(true); return; }
    if (!readKey() && !hasLocalBankAttachments(draft)) { setSettingsOpen(true); return; }
    continueHomeSubmission();
  }
  function switchWorkspace(id) {
    try {
      if (busy || !allowPeriodNavigation()) return;
      actions.switchWorkspace(id);
      const nextWorkspace = state.workspaces.find((item) => item.id === id);
      updateContext(id, nextWorkspace?.currentPeriod || "", "screen", "workbench");
      setMenuOpen(false); setSendOnEnter(0);
    }
    catch (error) { showError(error); }
  }
  function switchPeriod(period) {
    try { if (busy || !allowPeriodNavigation()) return false; actions.setPeriod(activeWorkspace.id, period); updateContext(workspaceId, period, "screen", "workbench"); setSendOnEnter(0); return true; }
    catch (error) { showError(error); return false; }
  }
  function returnFullVersion(request) {
    try {
      const switched = onOpenFullVersion?.(request);
      if (switched) { setMenuOpen(false); setSendOnEnter(0); }
      return switched;
    } catch (error) { showError(error); }
  }
  function openFullWorkbench(page, options = {}, resourceState) {
    if (resourceState) setResources((current) => ({ ...current, resourceState }));
    return returnFullVersion({ page, options, workspaceId, period });
  }
  useEffect(() => {
    const pending = pendingHomeSendRef.current;
    if (pending && (pending.workspaceId !== workspaceId || pending.period !== period)) pendingHomeSendRef.current = null;
  }, [workspaceId, period]);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const frame = requestAnimationFrame(() => menuPanelRef.current?.querySelector("button")?.focus({ preventScroll: true }));
    const outside = (event) => { if (!menuRef.current?.contains(event.target)) setMenuOpen(false); };
    const escape = (event) => { if (event.key === "Escape") { event.preventDefault(); setMenuOpen(false); menuRef.current?.querySelector("button")?.focus({ preventScroll: true }); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [menuOpen]);
  useEffect(resetDrag, [targetKey, busy, resources]);
  useEffect(() => {
    if (!busy) return undefined;
    const leave = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [busy]);
  useEffect(() => { if (!notice) return undefined; const timer = window.setTimeout(() => setNotice(""), 6500); return () => window.clearTimeout(timer); }, [notice]);

  return <div className={`ai-simple-app ai-${screen}`} style={{ "--ai-background": `url(${blueBackground})` }}>
    <header className="ai-topbar">
      {screen === "workbench" && <button className="ai-home-link" type="button" disabled={busy || !!resources} onClick={() => { setSendOnEnter(0); setScreen("home"); }}><ArrowLeft size={19} />首页</button>}
      <div className="ai-topbar-actions">
      <button className="ai-text-button ai-version-switch" type="button" disabled={busy} onClick={() => returnFullVersion()}><ArrowSquareOut size={18} />完整工作台</button>
      <div className="ai-account" ref={menuRef} onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false); }}>
        <button className="ai-account-trigger" type="button" aria-haspopup="dialog" aria-expanded={menuOpen} disabled={busy || !!resources} onClick={() => setMenuOpen((value) => !value)}><UserCircle size={43} weight="duotone" aria-hidden="true" /><span>我的工作台</span><CaretDown size={17} /></button>
        {menuOpen && <div ref={menuPanelRef} className="ai-account-menu" role="dialog" aria-label="我的工作台" onKeyDown={(event) => {
          if (event.target.tagName === "SELECT" || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const items = Array.from(event.currentTarget.querySelectorAll("button:not(:disabled), select:not(:disabled)"));
          const index = items.indexOf(document.activeElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          event.preventDefault(); items[next]?.focus({ preventScroll: true });
        }}>
          {!!state.workspaces.length && <div className="ai-workspace-list">{state.workspaces.map((workspace) => <button type="button" key={workspace.id} aria-current={workspace.id === activeWorkspace?.id ? "true" : undefined} onClick={() => workspace.id === activeWorkspace?.id ? enterWorkbench() : switchWorkspace(workspace.id)}><span><strong>{workspace.name}</strong><small>{workspace.currentPeriod}</small></span>{workspace.id === activeWorkspace?.id && <Check size={16} />}</button>)}</div>}
          {activeUsers.length === 1 && activeUsers[0].id === state.activeUserId ? <div className="ai-menu-identity"><span>操作身份</span><strong>{activeUsers[0].name} · {activeWorkspace.roles?.find((role) => role.id === activeUsers[0].roleId)?.name || activeUsers[0].role || "操作人"}</strong></div> : activeUsers.length > 0 && <label className="ai-menu-identity"><span>操作身份</span><select value={state.activeUserId || ""} onChange={(event) => { try { if (busy || !allowPeriodNavigation()) return; setSendOnEnter(0); actions.switchUser(activeWorkspace.id, event.target.value); } catch (error) { showError(error); } }}><option value="" disabled>选择操作人</option>{activeUsers.map((user) => <option key={user.id} value={user.id}>{user.name} · {activeWorkspace.roles?.find((role) => role.id === user.roleId)?.name || user.role || "操作人"}</option>)}</select></label>}
          {canManage && <button type="button" onClick={() => { setMenuOpen(false); setCreateOpen(true); }}><Plus size={18} />新建工作台</button>}
          <button type="button" onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}><GearSix size={18} />DeepSeek 设置{configured && <Check size={15} className="ai-menu-check" />}</button>
        </div>}
      </div>
      </div>
    </header>
    {screen === "home" ? <main className="ai-home-content"><AiComposer home value={draft.text} files={draft.files} onChange={(text) => changeDraft((current) => ({ ...current, text }))} onFiles={addFiles} onRemoveFile={(id) => changeDraft((current) => ({ ...current, files: current.files.filter((item) => item.id !== id) }))} onSend={sendFromHome} /></main>
      : activeWorkspace && <main className={`ai-workbench-main${dragging ? " is-dragging" : ""}`} onDragEnterCapture={(event) => { if (!isFileDrag(event) || !canAttach) return; dragDepthRef.current += 1; setDragging(true); }} onDragLeaveCapture={(event) => { if (!isFileDrag(event)) return; dragDepthRef.current = Math.max(0, dragDepthRef.current - 1); if (!dragDepthRef.current) setDragging(false); }} onDragOver={(event) => { if (!isFileDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = canAttach ? "copy" : "none"; }} onDropCapture={resetDrag} onDrop={dropFiles} onDragEnd={resetDrag}>
        {dragging && <div className="ai-drop-overlay" aria-hidden="true"><span>松开即可添加流水或票据</span></div>}
        <div className="ai-workbench-heading"><div className="ai-workbench-title"><h1 title={activeWorkspace.name}>{activeWorkspace.name}</h1><AccountingPeriodPicker workspace={activeWorkspace} disabled={busy || !!resources} onSelect={switchPeriod} /></div><button className="ai-resources-link" type="button" disabled={busy} onClick={() => setResources({ initialTab: "documents" })}>资料与报表<CaretRight size={18} /></button></div>
        {!persistenceStatus.canWrite && <p className="ai-error ai-persistence-error" role="status">{persistenceStatus.message}</p>}
        <Suspense fallback={<div className="ai-conversation-loading" role="status">正在打开工作台…</div>}><Conversation key={`${targetKey}:${state.activeUserId || ""}`} draft={draft} onDraftChange={changeDraft} attachmentNotice={attachmentNotice?.targetKey === targetKey ? attachmentNotice : null} readKey={readKey} configured={configured} requestSettings={() => setSettingsOpen(true)} autoSendNonce={sendOnEnter} onBusyChange={setBusy} onOpenResources={setResources} onToast={setNotice} /></Suspense>
      </main>}
    {settingsOpen && <AiSettings onClose={() => { pendingHomeSendRef.current = null; setSettingsOpen(false); }} onSaved={() => { setSettingsOpen(false); setNotice("DeepSeek 设置已保存。"); continueHomeSubmission(); }} onCleared={() => { setNotice("DeepSeek 密钥已清除。"); }} />}
    {createOpen && <CreateWorkspace onClose={() => { pendingHomeSendRef.current = null; setCreateOpen(false); }} onCreated={(created) => {
      const pending = pendingHomeSendRef.current;
      const continueSubmission = !activeWorkspace && pending?.workspaceId === workspaceId && pending.period === period && pending.draft === draft;
      if (!activeWorkspace) { updateContext(created.id, created.currentPeriod, "draft", draft); changeDraft(blankDraft()); }
      updateContext(created.id, created.currentPeriod, "screen", "workbench");
      setCreateOpen(false); setSendOnEnter(0);
      pendingHomeSendRef.current = continueSubmission ? { ...pending, workspaceId: created.id, period: created.currentPeriod } : null;
      if (continueSubmission) { if (readKey() || hasLocalBankAttachments(draft)) continueHomeSubmission(); else setSettingsOpen(true); }
    }} />}
    {resources && activeWorkspace && <Suspense fallback={<AiDialog title="资料与报表" wide onClose={() => setResources(null)}><p className="ai-helper">正在打开…</p></AiDialog>}><Resources key={targetKey} {...resources} onRememberState={rememberResourceState} onOpenFullWorkbench={openFullWorkbench} onClose={() => setResources(null)} onToast={setNotice} /></Suspense>}
    {notice && <div className="ai-toast" role="status">{notice}</div>}
  </div>;
}
