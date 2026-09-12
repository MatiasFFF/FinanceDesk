import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { App } from "./App.jsx";
import { useFinanceDesk } from "./store/FinanceDeskProvider.jsx";
import { allowPeriodNavigation } from "./features/workspaces/periodNavigation.js";
import { createModeHistoryController, getFinanceDeskMode } from "./features/ai-simple/aiModeSession.js";

const AiSimpleApp = lazy(() => import("./features/ai-simple/AiSimpleApp.jsx"));

export function FinanceDeskShell() {
  const { store } = useFinanceDesk();
  const [location, setLocation] = useState(() => ({ mode: getFinanceDeskMode(window.location.href), navigationRequest: window.history.state?.financeDeskMode?.navigationRequest || null }));
  const [error, setError] = useState("");
  const navigationRef = useRef(null);
  useEffect(() => {
    const controller = createModeHistoryController({ window, onChange: setLocation, beforeChange: () => {
      try { const allowed = allowPeriodNavigation(); if (allowed) setError(""); return allowed; }
      catch (caught) { setError(caught.message || "当前内容尚未处理完成，请稍后切换。"); return false; }
    } });
    navigationRef.current = controller;
    return () => { controller.dispose(); navigationRef.current = null; };
  }, []);
  useEffect(() => { document.title = location.mode === "ai" ? "FinanceDesk · 财务助手" : "FinanceDesk · 财务工作台"; }, [location.mode]);
  useEffect(() => {
    if (!error) return undefined;
    const timer = window.setTimeout(() => setError(""), 6500);
    return () => window.clearTimeout(timer);
  }, [error]);
  function openFullVersion(request) {
    const workspace = store.getActiveWorkspace();
    if (request?.page && ((request.workspaceId && request.workspaceId !== workspace?.id) || (request.period && request.period !== workspace?.currentPeriod))) {
      setError("工作台或账期已变化，请从当前事项重新打开完整工作台。");
      return false;
    }
    const navigationRequest = request?.page ? { ...request, workspaceId: workspace?.id || "", period: workspace?.currentPeriod || "", nonce: crypto.randomUUID() } : null;
    return navigationRef.current?.navigate("full", navigationRequest) ?? false;
  }
  return <>
    {location.mode === "ai" ? <Suspense fallback={<main className="ai-entry-loading" role="status">正在打开财务助手…</main>}><AiSimpleApp onOpenFullVersion={openFullVersion} /></Suspense>
      : <App navigationRequest={location.navigationRequest} onReturnToAssistant={() => navigationRef.current?.navigate("ai")} />}
    {error && <div className="toast danger" role="alert">{error}</div>}
  </>;
}
