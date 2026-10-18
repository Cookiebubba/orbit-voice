// "Hey Grok" wake word. The listening happens in a hidden helper page (wake.html / wake.ts),
// mounted as an iframe only while `enabled`; removing the iframe stops the mic. This hook
// returns that iframe (render it anywhere) and the current status.
import { createElement, useEffect, useRef, useState } from "react";

export type WakeStatus = "off" | "loading" | "listening" | "error";

export function useWakeWord({ enabled, onWake }: { enabled: boolean; onWake: () => void }) {
  const [status, setStatus] = useState<WakeStatus>("off");
  const frame = useRef<HTMLIFrameElement>(null);
  const wake = useRef(onWake);
  wake.current = onWake;

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      return;
    }
    const onMessage = (e: MessageEvent) => {
      // Only our own helper page, in our own iframe.
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow || e.data?.source !== "orbit-wake") return;
      if (e.data.type === "wake") wake.current();
      else if (e.data.type === "status") {
        setStatus(e.data.status);
        if (e.data.status === "error") console.error("wake word:", e.data.detail);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [enabled]);

  const element = enabled
    ? createElement("iframe", {
        ref: frame,
        src: "/wake.html",
        title: "Wake word listener",
        allow: "microphone",
        "aria-hidden": true,
        tabIndex: -1,
        style: { position: "absolute", width: 0, height: 0, border: 0, opacity: 0, pointerEvents: "none" },
      })
    : null;

  return { status, element };
}
