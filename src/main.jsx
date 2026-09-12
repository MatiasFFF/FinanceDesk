import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { FinanceDeskProvider } from "./store/FinanceDeskProvider.jsx";
import "./styles.css";

const AiSimpleApp = lazy(() => import("./features/ai-simple/AiSimpleApp.jsx"));
const aiMode = new URLSearchParams(window.location.search).get("mode") === "ai";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <FinanceDeskProvider>
      {aiMode ? <Suspense fallback={<main className="ai-entry-loading" role="status">正在打开财务助手…</main>}><AiSimpleApp /></Suspense> : <App />}
    </FinanceDeskProvider>
  </React.StrictMode>,
);
