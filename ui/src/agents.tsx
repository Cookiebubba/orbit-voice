import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./agents.css";
import AgentsApp from "./AgentsApp";

// The Agents window: a read-only card view of Orbit Agents runs (docs/design/agent-orchestration.md).
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AgentsApp />
  </StrictMode>,
);
