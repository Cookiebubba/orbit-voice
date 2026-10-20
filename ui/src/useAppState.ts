// App-wide state from the local bridge: settings (kept in sync live) and what Claude is doing.
import { useCallback, useEffect, useRef, useState } from "react";

export type Settings = {
  voice: string;
  speed: number;
  wakeHotkey: string;
  hotkeyLabel: string;
  listenMode: "always" | "tap";
  halfDuplex: boolean;
  wakeWord: boolean;
  announce: "speak" | "chime" | "off";
  announceWake: boolean;
  wakeOnResults: boolean;
  costPerMinute: number;
  model: string;
  brainEnabled: boolean;
  brainModel: "auto" | "haiku" | "sonnet" | "opus";
  brainExplore: boolean;
  brainConnection: "claude-code" | "api-key";
  brainClaudePath: string;
  autoUpdate: boolean;
  orbStick: boolean;
  orbPulse: boolean;
  orbPulseGrok: boolean;
  orbPulseAmount: number;
};

export type AppConfig = { version: string; hasKey: boolean; keyStorage: string; settings: Settings };
export type Finished = { id: string; title: string; summary: string; at: number };

export async function postJson(url: string, body: object) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export function useAppState({ onFinished, onWake }: { onFinished: (f: Finished) => void; onWake: () => void }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [failed, setFailed] = useState(false);
  const [claudeWorking, setClaudeWorking] = useState<{ id: string; title: string }[]>([]);
  const finishedCb = useRef(onFinished);
  finishedCb.current = onFinished;
  const wakeCb = useRef(onWake);
  wakeCb.current = onWake;

  const reload = useCallback(() => {
    fetch("/api/config")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((c: AppConfig) => setConfig(c))
      .catch(() => setFailed(true));
  }, []);

  useEffect(reload, [reload]);

  // Live events from the bridge (reconnects by itself if the connection drops).
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      let evt: any;
      try {
        evt = JSON.parse(m.data);
      } catch {
        return;
      }
      if (evt.type === "claude.status") setClaudeWorking(evt.working || []);
      else if (evt.type === "claude.finished") finishedCb.current({ id: evt.id, title: evt.title, summary: evt.summary || "", at: Date.now() });
      // The bridge decides when Grok wakes by itself (spoken updates, results you asked for).
      else if (evt.type === "orbit.wake") wakeCb.current();
      else if (evt.type === "settings.changed") setConfig((c) => (c ? { ...c, settings: { ...c.settings, ...evt.settings, hotkeyLabel: hotkeyLabel(evt.settings.wakeHotkey) } } : c));
    };
    return () => es.close();
  }, []);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    setConfig((c) => (c ? { ...c, settings: { ...c.settings, ...patch } } : c)); // optimistic
    const r = await postJson("/api/settings", patch);
    if (r.ok) {
      const settings = await r.json();
      setConfig((c) => (c ? { ...c, settings } : c));
    }
  }, []);

  return { config, failed, reload, claudeWorking, updateSettings, setHasKey: () => setConfig((c) => (c ? { ...c, hasKey: true } : c)) };
}

export const hotkeyLabel = (accel = "") => accel.replace(/CommandOrControl|Control/g, "Ctrl").replace(/Super|Meta/g, "Win");
