// The tiny always-on-top orb shown while the main window is minimized.
// Click: open the main window. Drag: move it. Right-click: sleep / wake.
import { useEffect, useRef, useState } from "react";
import { Shdr29 } from "@/components/ui/shdr-29";
import { desktop, orbOpacity, orbProps, type OrbSync } from "./desktop";
import { PULSE_DEFAULT, orbParams } from "./orbLook";

export default function OrbWindow() {
  const [s, setS] = useState<OrbSync>({ phase: "off", input: 0, output: 0, asleep: false, hearing: false, claudeWorking: false, pulseMe: false, pulseGrok: false, pulseAmount: PULSE_DEFAULT });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    return desktop?.onOrbState(setS);
  }, []);

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
      {/* No glow or ring around the orb: its opacity (and colour) say everything about activity. */}
      <div style={{ opacity: orbOpacity(s), transition: "opacity .3s" }}>
        <Shdr29 size={96} {...orbProps(s.phase, s.input, s.output)} params={orbParams(s)} pauseOffscreen={false} interactive />
      </div>
    </div>
  );
}
