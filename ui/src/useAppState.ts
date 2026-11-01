// App-wide state from the local bridge: settings (kept in sync live) and what Claude is doing.
import { isMac } from "./desktop";
import { useCallback, useEffect, useRef, useState } from "react";

export type Settings = {
  voice: string;
  speed: number;
  wakeHotkey: string;
  hotkeyLabel: string;
  listenMode: "always" | "tap";
  halfDuplex: boolean;
  voiceVolume: number;
  wakeWord: boolean;
  announce: "speak" | "chime" | "off";
  announceWake: boolean;
  wakeOnResults: boolean;
  costPerMinute: number;
  model: string;
  brainEnabled: boolean;
  brainModel: "auto" | "haiku" | "sonnet" | "opus";
  brainExplore: boolean;
  webSearch: boolean;
  brainConnection: "claude-code" | "api-key";
  brainClaudePath: string;
  voiceEngine: "grok" | "claude" | "openai";
  openaiModel: "gpt-realtime" | "gpt-realtime-mini";
  openaiVoice: string;
  openaiKeySource: "saved" | "system" | "saved-or-system";
  externalAvatarMode: "desktop" | "attached" | "auto";
  claudeVoice: number;
  claudeVoiceModel: "haiku" | "sonnet" | "opus" | "fable";
  claudeVoiceEffort: "low" | "medium" | "high";
  claudeVoiceStt: "moonshine" | "parakeet-110m" | "parakeet-v2";
  avatar: "buddy" | "qubit" | "none";
  buddySize: number;
  avatarClickTalk: boolean;
  avatarThrow: boolean;
  avatarThrowSound: boolean;
  showOrb: boolean;
  autoUpdate: boolean;
  orbStick: boolean;
  orbPulse: boolean;
  orbPulseGrok: boolean;
  orbPulseAmount: number;
  anywhere: boolean;
  anywhereVision: boolean;
  anywhereCdp: boolean;
  anywhereUnderOrbit: string[];
  anywhereMouse: boolean;
  onboarded: boolean;
};

/** voiceWarming: Claude voice's speech is loading and warming up (a call started now waits for it). */
export type OpenAIStatus = { policy: Settings["openaiKeySource"]; savedPresent: boolean; systemAvailable: boolean; systemSource: "process" | "user" | "machine" | null; effectiveSource: "saved" | "process" | "user" | "machine" | null; available: boolean; pending: boolean; error: "saved-unreadable" | "system-invalid" | "system-read-failed" | null; systemError: "system-invalid" | "system-read-failed" | null };
export type AppConfig = { version: string; hasKey: boolean; hasXaiKey?: boolean; hasOpenAIKey?: boolean; openai?: OpenAIStatus; externalHost?: { selected: boolean; connected: boolean; capabilities: string[]; name: string } | null; keyStorage: string; settings: Settings; voiceWarming?: boolean };
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

  // A first config fetch can beat the native registry refresh (or its SSE event can beat config).
  // Poll only cached metadata briefly while pending; never trigger another OS lookup here.
  useEffect(() => {
    if (!config?.openai?.pending) return;
    let reads = 0;
    const timer = setInterval(() => { reload(); if (++reads >= 12) clearInterval(timer); }, 500);
    return () => clearInterval(timer);
  }, [config?.openai?.pending, reload]);

  // Live events from the bridge (reconnects by itself if the connection drops).
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = reload; // reconnect also reconciles availability after an event-stream gap
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
      else if (evt.type === "voice.warming") setConfig((c) => (c ? { ...c, voiceWarming: !!evt.warming } : c));
      else if (evt.type === "openai.credentials") setConfig((c) => (c ? { ...c, openai: evt.openai, hasOpenAIKey: !!evt.openai.savedPresent, ...(c.settings.voiceEngine === "openai" ? { hasKey: !!evt.openai.available } : {}) } : c));
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
      if (patch.voiceEngine || patch.openaiKeySource) reload();
    }
  }, []);

  return { config, failed, reload, claudeWorking, updateSettings, setHasKey: reload };
}

const MAC_MODS: Record<string, string> = { Control: "⌃", Ctrl: "⌃", Alt: "⌥", Option: "⌥", Shift: "⇧", Command: "⌘", Cmd: "⌘", CommandOrControl: "⌘", CmdOrCtrl: "⌘", Super: "⌘", Meta: "⌘" };
/** "Ctrl+Alt+G" on Windows, "⌃⌥G" on a Mac (the same as src/platform/system.js hotkeyLabel). */
export const hotkeyLabel = (accel = "") => {
  if (!isMac) return accel.replace(/CommandOrControl|CmdOrCtrl|Control/g, "Ctrl").replace(/Super|Meta/g, "Win");
  const parts = accel.split("+").filter(Boolean);
  const mods = new Set(parts.filter((p) => MAC_MODS[p]).map((p) => MAC_MODS[p]));
  const keys = parts.filter((p) => !MAC_MODS[p]).map((p) => (p.length === 1 ? p.toUpperCase() : p));
  return ["⌃", "⌥", "⇧", "⌘"].filter((m) => mods.has(m)).join("") + keys.join("+");
};
