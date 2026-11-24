import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import OrbWindow from "./OrbWindow";

// "/" is the main window. "/#orb" is Orbit Native's floating orb; the Windows app has none.
const isOrb = location.hash === "#orb";

createRoot(document.getElementById("root")!).render(<StrictMode>{isOrb ? <OrbWindow /> : <App />}</StrictMode>);
