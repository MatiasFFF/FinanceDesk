import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowSquareOut, CaretDown, CaretRight, Check, GearSix, Plus, UserCircle } from "@phosphor-icons/react";
import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import { BLANK_WORKSPACE_INITIAL_ROLE_OPTIONS, hasWorkspacePermission } from "../../domain/foundation.js";
import { localAccountingPeriod } from "../../domain/periods.js";
import { AccountingPeriodPicker } from "../workspaces/AccountingPeriodPicker.jsx";
import { allowPeriodNavigation } from "../workspaces/periodNavigation.js";
import { AiComposer } from "./AiComposer.jsx";
import { AiDialog } from "./AiDialog.jsx";
import { AiSettings } from "./AiSettings.jsx";
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
  return <AiDialog title="新建工作台" onClose={onClose}><form className="ai-settings-form" onSubmit={(event) => {
    event.preventDefault();
    try { const created = actions.createWorkspace({ name: name.trim(), currentPeriod: period, initialUserName: operator.trim(), initialUserRoleId: roleId }); onCreated(created); }
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

export default function AiSimpleApp() {
  const { state, activeWorkspace, actions, persistenceStatus } = useFinanceDesk();
  const [screen, setScreen] = useState("home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [resources, setResources] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sendOnEnter, setSendOnEnter] = useState(0);
  const [notice, setNotice] = useState("");
  const keyRef = useRef("");
  const menuRef = useRef(null);
  const targetKey = `${activeWorkspace?.id || "new"}:${activeWorkspace?.currentPeriod || ""}`;
  const draft = drafts[targetKey] || blankDraft();
  const activeUsers = (activeWorkspace?.users || []).filter((user) => user.status === "active");
  const canManage = !activeWorkspace || hasWorkspacePermission(state, activeWorkspace.id, "workspace.manage");
  const hasDrafts = Object.values(drafts).some((item) => item.text.trim() || item.files.length);
  const readKey = () => keyRef.current;
  function changeDraft(update) {
    setDrafts((current) => ({ ...current, [targetKey]: typeof update === "function" ? update(current[targetKey] || blankDraft()) : update }));
  }
  function addFiles(files) { changeDraft((current) => ({ ...current, files: [...current.files, ...files.map((file) => ({ id: crypto.randomUUID(), file }))] })); }
  function showError(error) { setNotice(error?.message || String(error)); }
  function enterWorkbench() { setMenuOpen(false); if (!activeWorkspace) setCreateOpen(true); else setScreen("workbench"); }
  function sendFromHome() {
    if (!draft.text.trim() && !draft.files.length) return;
    if (!activeWorkspace) { setCreateOpen(true); return; }
    if (!keyRef.current) { setSettingsOpen(true); return; }
    setSendOnEnter((value) => value + 1);
    setScreen("workbench");
  }
  function switchWorkspace(id) {
    try { if (busy || !allowPeriodNavigation()) return; actions.switchWorkspace(id); setResources(null); setMenuOpen(false); setScreen("workbench"); setSendOnEnter(0); }
    catch (error) { showError(error); }
  }
  function switchPeriod(period) {
    try { if (busy || !allowPeriodNavigation()) return false; actions.setPeriod(activeWorkspace.id, period); setResources(null); setSendOnEnter(0); return true; }
    catch (error) { showError(error); return false; }
  }
  function returnFullVersion() {
    try {
      if (busy || !allowPeriodNavigation()) return;
      if (hasDrafts && !window.confirm("还有未发送的输入或附件，返回完整版会离开当前页面。确定离开吗？")) return;
      const url = new URL(window.location.href); url.searchParams.delete("mode"); window.location.assign(url.href);
    } catch (error) { showError(error); }
  }
  useEffect(() => {
    document.title = "FinanceDesk · 财务助手";
    return () => { keyRef.current = ""; };
  }, []);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const outside = (event) => { if (!menuRef.current?.contains(event.target)) setMenuOpen(false); };
    const escape = (event) => { if (event.key === "Escape") { setMenuOpen(false); menuRef.current?.querySelector("button")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [menuOpen]);
  useEffect(() => {
    if (!hasDrafts && !busy) return undefined;
    const leave = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [hasDrafts, busy]);
  useEffect(() => { if (!notice) return undefined; const timer = window.setTimeout(() => setNotice(""), 6500); return () => window.clearTimeout(timer); }, [notice]);

  return <div className={`ai-simple-app ai-${screen}`} style={{ "--ai-background": `url(${blueBackground})` }}>
    <header className="ai-topbar">
      {screen === "workbench" && <button className="ai-home-link" type="button" disabled={busy || !!resources} onClick={() => { setSendOnEnter(0); setScreen("home"); }}><ArrowLeft size={19} />首页</button>}
      <div className="ai-account" ref={menuRef}>
        <button className="ai-account-trigger" type="button" aria-haspopup="menu" aria-expanded={menuOpen} disabled={busy || !!resources} onClick={() => setMenuOpen((value) => !value)}><UserCircle size={43} weight="duotone" aria-hidden="true" /><span>我的工作台</span><CaretDown size={17} /></button>
        {menuOpen && <div className="ai-account-menu" role="menu" aria-label="我的工作台">
          <button className="ai-menu-current" role="menuitem" type="button" onClick={enterWorkbench}><span><strong>{activeWorkspace?.name || "进入工作台"}</strong><small>{activeWorkspace?.currentPeriod || "创建后即可开始"}</small></span><CaretRight size={17} /></button>
          {state.workspaces.length > 1 && <div className="ai-workspace-list">{state.workspaces.map((workspace) => <button role="menuitem" type="button" key={workspace.id} onClick={() => switchWorkspace(workspace.id)}><span>{workspace.name}</span>{workspace.id === activeWorkspace?.id && <Check size={16} />}</button>)}</div>}
          {activeUsers.length > 0 && <label className="ai-menu-identity"><span>操作身份</span><select value={state.activeUserId || ""} onChange={(event) => { try { setSendOnEnter(0); actions.switchUser(activeWorkspace.id, event.target.value); } catch (error) { showError(error); } }}><option value="" disabled>选择操作人</option>{activeUsers.map((user) => <option key={user.id} value={user.id}>{user.name} · {activeWorkspace.roles?.find((role) => role.id === user.roleId)?.name || user.role || "操作人"}</option>)}</select></label>}
          {canManage && <button role="menuitem" type="button" onClick={() => { setMenuOpen(false); setCreateOpen(true); }}><Plus size={18} />新建工作台</button>}
          <button role="menuitem" type="button" onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}><GearSix size={18} />DeepSeek 设置{configured && <Check size={15} className="ai-menu-check" />}</button>
          <button role="menuitem" type="button" onClick={returnFullVersion}><ArrowSquareOut size={18} />返回完整版</button>
        </div>}
      </div>
    </header>
    {screen === "home" ? <main className="ai-home-content"><AiComposer home value={draft.text} files={draft.files} onChange={(text) => changeDraft((current) => ({ ...current, text }))} onFiles={addFiles} onRemoveFile={(id) => changeDraft((current) => ({ ...current, files: current.files.filter((item) => item.id !== id) }))} onSend={sendFromHome} /></main>
      : activeWorkspace && <main className="ai-workbench-main"><div className="ai-workbench-heading"><div className="ai-workbench-title"><h1 title={activeWorkspace.name}>{activeWorkspace.name}</h1><AccountingPeriodPicker workspace={activeWorkspace} disabled={busy || !!resources} onSelect={switchPeriod} /></div><button className="ai-resources-link" type="button" disabled={busy} onClick={() => setResources({ initialTab: "documents" })}>资料与报表<CaretRight size={18} /></button></div>
        {!persistenceStatus.canWrite && <p className="ai-error ai-persistence-error" role="status">{persistenceStatus.message}</p>}
        <Suspense fallback={<div className="ai-conversation-loading" role="status">正在打开工作台…</div>}><Conversation key={`${targetKey}:${state.activeUserId || ""}`} draft={draft} onDraftChange={changeDraft} readKey={readKey} configured={configured} requestSettings={() => setSettingsOpen(true)} autoSendNonce={sendOnEnter} onBusyChange={setBusy} onOpenResources={setResources} onToast={setNotice} /></Suspense>
      </main>}
    {settingsOpen && <AiSettings configured={configured} onClose={() => setSettingsOpen(false)} onSave={(value) => { keyRef.current = value; setConfigured(true); setSettingsOpen(false); setNotice("密钥已在当前标签页设置，输入和附件已保留。"); }} onClear={() => { keyRef.current = ""; setConfigured(false); setSettingsOpen(false); setNotice("当前标签页的密钥已清除。"); }} />}
    {createOpen && <CreateWorkspace onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); setScreen("workbench"); setSendOnEnter(0); }} />}
    {resources && activeWorkspace && <Suspense fallback={<AiDialog title="资料与报表" wide onClose={() => setResources(null)}><p className="ai-helper">正在打开…</p></AiDialog>}><Resources key={targetKey} {...resources} onClose={() => setResources(null)} onToast={setNotice} /></Suspense>}
    {notice && <div className="ai-toast" role="status">{notice}</div>}
  </div>;
}
