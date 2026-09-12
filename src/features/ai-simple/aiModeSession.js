export const aiSessionContextKey = (workspaceId, period) => JSON.stringify([workspaceId || "", period || ""]);

export function closeAiWorkspaceCreation({ dirty, confirm, onClose }) {
  if (dirty && !confirm("新建工作台信息还没有保存。确定关闭并放弃填写内容吗？")) return false;
  onClose();
  return true;
}

// Only the explicitly submitted draft may resume after the required setup.
// Consume before sending so a second save/close callback cannot send it twice.
export function resumeAiHomeSubmission({ pendingRef, workspace, draft, configured, onSend }) {
  const pending = pendingRef.current;
  pendingRef.current = null;
  if (!pending || !configured || !workspace
    || pending.workspaceId !== workspace.id || pending.period !== workspace.currentPeriod
    || pending.draft !== draft) return false;
  onSend();
  return true;
}

// This store belongs to one mounted tab. Credentials never enter its UI snapshot.
export function createAiTabSession({ defaultModelSettings, normalizeModelSettings = (value) => value }) {
  let apiKey = "";
  let snapshot = { configured: false, modelSettings: normalizeModelSettings(defaultModelSettings), contexts: {} };
  const subscribers = new Set();
  function publish(next) { snapshot = next; subscribers.forEach((listener) => listener()); }
  return {
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    getSnapshot: () => snapshot,
    readKey: () => apiKey,
    setApiKey(value) { apiKey = String(value || "").trim(); publish({ ...snapshot, configured: !!apiKey }); },
    clearApiKey() { apiKey = ""; publish({ ...snapshot, configured: false }); },
    setModelSettings(update) {
      const value = typeof update === "function" ? update(snapshot.modelSettings) : update;
      const { model, thinking, reasoningEffort } = normalizeModelSettings({ ...snapshot.modelSettings, ...value });
      publish({ ...snapshot, modelSettings: { model, thinking, reasoningEffort } });
    },
    updateContext(workspaceId, period, field, update, initialValue) {
      const key = aiSessionContextKey(workspaceId, period);
      const context = snapshot.contexts[key] || {};
      const previous = Object.hasOwn(context, field) ? context[field] : initialValue;
      const value = typeof update === "function" ? update(previous) : update;
      if (Object.is(value, previous) && Object.hasOwn(context, field)) return;
      publish({ ...snapshot, contexts: { ...snapshot.contexts, [key]: { ...context, [field]: value } } });
    },
  };
}

export function getFinanceDeskMode(url) {
  return new URL(url).searchParams.get("mode") === "full" ? "full" : "ai";
}

export function financeDeskModeUrl(url, mode) {
  const target = new URL(url);
  if (mode === "full") target.searchParams.set("mode", "full");
  else target.searchParams.delete("mode");
  return target.href;
}

const HISTORY_KEY = "financeDeskMode";

// Restore the actual history entry on a blocked Back/Forward navigation. Merely
// replacing the URL would leave the history stack inconsistent with the view.
export function createModeHistoryController({ window: browser, onChange, beforeChange = () => true }) {
  const previous = browser.history.state?.[HISTORY_KEY];
  let current = {
    mode: getFinanceDeskMode(browser.location.href),
    url: browser.location.href,
    index: Number.isInteger(previous?.index) ? previous.index : 0,
    navigationRequest: previous?.navigationRequest || null,
  };
  let restoring = false;
  const historyState = (entry) => ({ ...browser.history.state, [HISTORY_KEY]: { index: entry.index, navigationRequest: entry.navigationRequest } });
  browser.history.replaceState(historyState(current), "", current.url);
  function accept(next) { current = next; onChange({ mode: current.mode, navigationRequest: current.navigationRequest }); }
  function popstate(event) {
    if (restoring) { restoring = false; return; }
    const nextState = event.state?.[HISTORY_KEY];
    const next = { mode: getFinanceDeskMode(browser.location.href), url: browser.location.href, index: nextState?.index, navigationRequest: nextState?.navigationRequest || null };
    if (beforeChange(next) === false) {
      if (Number.isInteger(next.index) && next.index !== current.index) {
        restoring = true;
        browser.history.go(current.index - next.index);
      } else browser.history.replaceState(historyState(current), "", current.url);
      return;
    }
    if (!Number.isInteger(next.index)) {
      next.index = current.index;
      browser.history.replaceState(historyState(next), "", next.url);
    }
    accept(next);
  }
  browser.addEventListener("popstate", popstate);
  return {
    getSnapshot: () => ({ mode: current.mode, navigationRequest: current.navigationRequest }),
    navigate(mode, navigationRequest = null) {
      if (restoring) return false;
      if (mode === current.mode && !navigationRequest) return true;
      const next = { mode, url: financeDeskModeUrl(current.url, mode), index: current.index + 1, navigationRequest };
      if (beforeChange(next) === false) return false;
      browser.history.pushState(historyState(next), "", next.url);
      accept(next);
      return true;
    },
    dispose() { browser.removeEventListener("popstate", popstate); },
  };
}
