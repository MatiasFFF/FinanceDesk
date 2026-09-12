import React from "react";
import { createRoot } from "react-dom/client";
import { FinanceDeskShell } from "./FinanceDeskShell.jsx";
import { FinanceDeskProvider } from "./store/FinanceDeskProvider.jsx";
import { AiSessionProvider } from "./features/ai-simple/AiSessionContext.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <FinanceDeskProvider>
      <AiSessionProvider><FinanceDeskShell /></AiSessionProvider>
    </FinanceDeskProvider>
  </React.StrictMode>,
);
