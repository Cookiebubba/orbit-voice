// The tiny always-on-top orb shown while the main window is minimized.
// Click: open the main window. Drag: move it. Right-click: sleep / wake.
import { useEffect, useRef, useState } from "react";
import { Shdr29 } from "@/components/ui/shdr-29";
import { desktop, orbOpacity, orbProps, type OrbSync } from "./desktop";

export default function OrbWindow() {
  const [s, setS] = useState<OrbSync>({ phase: "off", input: 0, output: 0, asleep: false, hearing: false, claudeWorking: false });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    return desktop?.onOrbState(setS);
  }, []);

  const on = s.phase !== "off";
  return (
    <div
      className="grid h-screen w-screen cursor-pointer place-items-center select-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.screenX, y: e.screenY, moved: false };
        desktop?.orbDragStart();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (Math.abs(e.screenX - d.x) + Math.abs(e.screenY - d.y) > 4) d.moved = true;
        if (d.moved) desktop?.orbDragMove();
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) desktop?.orbRestore();
        else if (d) desktop?.orbDragEnd();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        desktop?.orbAction("toggle-sleep");
      }}
      title="Orbit: click to open · drag to move · right-click to sleep or wake"
    >
      <div className="relative">
        {s.claudeWorking && <span className="claude-ring" aria-hidden />}
        <div style={{ opacity: orbOpacity(s), transition: "opacity .3s" }}>
        <div
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{ boxShadow: on && !s.asleep ? "0 0 24px 2px rgba(255,255,255,.18)" : "none", transition: "box-shadow .4s" }}
        />
        <Shdr29 size={96} {...orbProps(s.phase, s.input, s.output)} pauseOffscreen={false} />
        </div>
      </div>
    </div>
  );
}
