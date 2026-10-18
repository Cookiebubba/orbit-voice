import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import OrbWindow from "./OrbWindow";

// The desktop app loads the same page twice: "/" for the main window, "/#orb" for the floating orb.
const isOrb = location.hash === "#orb";

createRoot(document.getElementById("root")!).render(<StrictMode>{isOrb ? <OrbWindow /> : <App />}</StrictMode>);
