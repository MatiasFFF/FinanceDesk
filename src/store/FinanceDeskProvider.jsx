import { createContext, useContext, useMemo, useRef, useSyncExternalStore } from "react";

import { createBrowserFileVault } from "../features/intake/browserFileVault.js";
import { createFinanceDeskStore } from "./financeDeskStore.js";

const FinanceDeskContext = createContext(null);

export function FinanceDeskProvider({ children, store: suppliedStore, fileVault: suppliedFileVault }) {
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = suppliedStore || createFinanceDeskStore();
  const store = storeRef.current;
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const fileVault = useMemo(() => {
    if (suppliedFileVault) return suppliedFileVault;
    if (!globalThis.indexedDB) return null;
    return createBrowserFileVault();
  }, [suppliedFileVault]);
  const value = useMemo(() => ({
    store,
    state,
    activeWorkspace: state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) || state.workspaces[0],
    actions: store.actions,
    fileVault,
    loadReport: store.getLoadReport(),
  }), [store, state, fileVault]);
  return <FinanceDeskContext.Provider value={value}>{children}</FinanceDeskContext.Provider>;
}

export function useFinanceDesk() {
  const context = useContext(FinanceDeskContext);
  if (!context) throw new Error("useFinanceDesk 必须在 FinanceDeskProvider 内使用");
  return context;
}
