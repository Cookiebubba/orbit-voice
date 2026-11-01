// Native lifecycle controls reuse useVoice; settings never mount a second audio owner.
import { useEffect, useRef } from "react";
import { desktop } from "./desktop";
import { canTalk } from "./talk.js";
import type { AppConfig } from "./useAppState";
import type { useVoice } from "./useVoice";

export function useManagedVoice(voice: ReturnType<typeof useVoice>, config: AppConfig | null) {
  const current = useRef({ voice, config });
  current.current = { voice, config };
  const lease = useRef(0);
  const intent = useRef(0);
  const startTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canStart = () => !desktop?.managed || lease.current > Date.now();
  useEffect(() => {
    if (!desktop?.managed) return;
    const off = desktop.onManagedControl?.((message) => {
      const c = message?.command;
      if (!c) return;
      if (c.kind === "lease") {
        const until = c.until;
        if (typeof until === "number" && Number.isFinite(until) && until > Date.now() && until <= Date.now() + 10_000) lease.current = until;
        return;
      }
      const apply = async () => {
        const { voice: v, config: cfg } = current.current;
        if (c.kind === "stop") {
          intent.current++;
          if (startTimer.current) clearTimeout(startTimer.current);
          v.stop(); return true;
        }
        if (!canStart() || !cfg) return false;
        if (c.kind === "start") {
          const deadline = message.expiresAt;
          if (!canTalk(cfg) || typeof deadline !== "number" || deadline <= Date.now() || deadline > Date.now() + 10_000) return false;
          const mine = ++intent.current;
          if (startTimer.current) clearTimeout(startTimer.current);
          startTimer.current = setTimeout(() => { if (intent.current === mine) current.current.voice.stop(); }, deadline - Date.now());
          try { return (await v.start()) === true && mine === intent.current && deadline > Date.now(); }
          finally { if (mine === intent.current && startTimer.current) clearTimeout(startTimer.current); }
        }
        if (c.kind === "setMute" && typeof c.muted === "boolean") { v.setMute(c.muted); return true; }
        return false;
      };
      void apply().then((ok) => { if (message.id) desktop?.managedAck?.(message.id, ok); }, () => {
        current.current.voice.stop();
        if (message.id) desktop?.managedAck?.(message.id, false);
      });
    });
    const timer = setInterval(() => {
      if (lease.current <= Date.now() && (current.current.voice.phase !== "off" || current.current.voice.microphone === "active")) current.current.voice.stop();
    }, 250);
    return () => { off?.(); clearInterval(timer); current.current.voice.stop(); };
  }, []);
  useEffect(() => {
    if (!desktop?.managed) return;
    desktop.managedStatus?.({ rendererReady: !!config, phase: voice.phase, microphone: voice.microphone,
      muted: voice.muted, credentialAvailable: !!config && canTalk(config), failure: voice.failure });
  }, [!!config, config?.hasKey, config?.hasXaiKey, config?.openai?.available, voice.phase, voice.microphone, voice.muted, voice.failure]);
  return { canStart };
}
