import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_DEEPSEEK_MODEL_SETTINGS, normalizeDeepSeekModelSettings } from "../../application/deepseekModels.js";
import { aiSessionContextKey, createAiTabSession } from "./aiModeSession.js";

const AiSessionContext = createContext(null);

export function AiSessionProvider({ children }) {
  const sessionRef = useRef(null);
  if (!sessionRef.current) sessionRef.current = createAiTabSession({ defaultModelSettings: DEFAULT_DEEPSEEK_MODEL_SETTINGS, normalizeModelSettings: normalizeDeepSeekModelSettings });
  const session = sessionRef.current;
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const hasDrafts = Object.values(snapshot.contexts).some(({ draft }) => draft && (draft.text?.trim() || draft.files?.length));
  useEffect(() => {
    if (!hasDrafts) return undefined;
    const leave = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [hasDrafts]);
  const value = useMemo(() => ({ ...snapshot, ...session }), [snapshot, session]);
  return <AiSessionContext.Provider value={value}>{children}</AiSessionContext.Provider>;
}

export function useAiSession() {
  const session = useContext(AiSessionContext);
  if (!session) throw new Error("useAiSession 必须在 AiSessionProvider 内使用");
  return session;
}

// A callback always writes back to the workspace/period that created it, even
// when an async operation settles after the active ledger has changed.
export function useAiSessionState(workspaceId, period, field, initialValue) {
  const { contexts, updateContext } = useAiSession();
  const [initial] = useState(initialValue);
  const context = contexts[aiSessionContextKey(workspaceId, period)];
  const value = context && Object.hasOwn(context, field) ? context[field] : initial;
  const setValue = useCallback((update) => updateContext(workspaceId, period, field, update, initial), [workspaceId, period, field, initial, updateContext]);
  return [value, setValue];
}
