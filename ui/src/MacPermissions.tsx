// macOS privacy permissions: what Orbit needs from System Settings, whether each is on, and a button
// that asks for it (macOS's own prompt) or opens the right pane. Looked at again every couple of
// seconds while it shows and whenever the window comes back to the front, so turning a switch on in
// System Settings shows up here at once.
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { desktop, type MacPermission, type MacPermissions } from "./desktop";

const ITEMS: { kind: MacPermission; label: string; why: string; needed: boolean }[] = [
  { kind: "accessibility", label: "Accessibility", why: "To type your prompts into Claude, press Send and Stop, answer Claude's questions, follow its window, and work in the windows you ask about.", needed: true },
  { kind: "microphone", label: "Microphone", why: "To hear you (and for the offline “Hey Orbit”).", needed: true },
  { kind: "screen", label: "Screen Recording", why: "Only to look at a window when you ask (“what's on this chart?”). Everything else works without it.", needed: false },
];

const granted = (p: MacPermissions | null, kind: MacPermission) => (kind === "accessibility" ? !!p?.accessibility : p?.[kind] === "granted");

/** The permissions, refreshed while `live`. null outside the Mac app. */
export function useMacPermissions(live = true) {
  const api = desktop?.permissions;
  const [p, setP] = useState<MacPermissions | null>(null);
  const refresh = useCallback(() => {
    api?.get().then(setP).catch(() => {});
  }, [api]);
  useEffect(() => {
    if (!api) return;
    refresh();
    if (!live) return;
    const t = setInterval(refresh, 2000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", refresh);
    };
  }, [api, live, refresh]);
  const request = useCallback(
    async (kind: MacPermission) => {
      if (!api) return;
      setP(await api.request(kind));
    },
    [api],
  );
  return { p: api && p?.platform === "darwin" ? p : null, request, refresh };
}

function Row({ item, on, onAsk }: { item: (typeof ITEMS)[number]; on: boolean; onAsk: () => void }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className={cn("mt-[5px] h-2 w-2 shrink-0 rounded-full", on ? "bg-emerald-500" : item.needed ? "bg-amber-500" : "bg-line")} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-fg">
          {item.label}
          <span className="ml-1.5 text-[11.5px] font-normal text-muted">{on ? "On" : item.needed ? "Off: needed" : "Off"}</span>
        </div>
        <div className="mt-0.5 text-[11.5px] leading-snug text-muted">{item.why}</div>
      </div>
      {!on && (
        <button onClick={onAsk} className="shrink-0 rounded-full bg-fg px-3 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90">
          Turn on
        </button>
      )}
    </div>
  );
}

/** Settings → Mac permissions. */
export function MacPermissionsSection() {
  const { p, request } = useMacPermissions(true);
  if (!p) return null;
  return (
    <section className="border-t border-line pt-5">
      <h3 className="eyebrow mb-3">Mac permissions</h3>
      {ITEMS.map((item) => (
        <Row key={item.kind} item={item} on={granted(p, item.kind)} onAsk={() => request(item.kind)} />
      ))}
      {!p.helper && <p className="mt-2 text-[11.5px] leading-snug text-amber-700">Orbit's helper for the Claude app is missing from this copy of Orbit. Reinstall Orbit to use the Claude app by voice.</p>}
      <p className="mt-2 text-[11.5px] leading-snug text-faint">“Turn on” shows macOS's own question, or opens System Settings → Privacy & Security at the right place: switch Orbit on there. Screen Recording takes effect after Orbit restarts.</p>
    </section>
  );
}

/** On the main screen while something Orbit needs is off: one line, and the button to fix it. */
export function MacPermissionsBanner() {
  const { p, request } = useMacPermissions(true);
  const [hidden, setHidden] = useState(false);
  if (!p || hidden) return null;
  const missing = ITEMS.filter((i) => i.needed && !granted(p, i.kind));
  if (!missing.length) return null;
  const first = missing[0];
  return (
    <div role="status" className="mx-4 mb-2 flex items-center gap-2 rounded-xl bg-soft px-3 py-2 text-[12px] leading-snug text-ink">
      <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-hidden />
      <span className="min-w-0 flex-1">
        Orbit needs <b>{missing.map((m) => m.label).join(" and ")}</b> {first.kind === "accessibility" ? "to use the Claude app for you." : "to hear you."}
      </span>
      <button onClick={() => request(first.kind)} className="shrink-0 rounded-full bg-fg px-2.5 py-1 text-[11.5px] font-medium text-white">
        Turn on
      </button>
      <button onClick={() => setHidden(true)} aria-label="Not now" className="shrink-0 px-1 text-[13px] text-muted hover:text-fg">
        ×
      </button>
    </div>
  );
}
