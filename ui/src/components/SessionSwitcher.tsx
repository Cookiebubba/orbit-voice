// Title-bar dropdown listing the sessions in Claude's sidebar. Click one to open it in Claude
// (no mouse movement: Orbit presses the sidebar button through Windows accessibility), or
// "Ask" to have Grok tell you about it.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, MessageCircleQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import { postJson } from "../useAppState";

type SessionRow = { id: string; title: string; badge: string; project: string; lastActive: string; working: boolean; open: boolean };

export default function SessionSwitcher({
  current,
  workingTitles,
  onAsk,
  onSwitched,
}: {
  current: string | null;
  workingTitles: Set<string>;
  onAsk: (title: string) => void;
  onSwitched: (title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [canSwitch, setCanSwitch] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setRows(null);
    setError("");
    setFilter("");
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((d) => {
        setRows(d.sessions);
        setCanSwitch(!!d.canSwitch);
      })
      .catch(() => setRows([]));
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const switchTo = async (title: string) => {
    if (!canSwitch) return onAsk(title);
    setBusy(title);
    setError("");
    const r = await postJson("/api/switch", { title });
    const result = await r.json().catch(() => ({}));
    setBusy(null);
    if (r.ok) {
      onSwitched(result.sessionTitle || title);
      setOpen(false);
    } else setError(result.message || "Couldn't open that session.");
  };

  const shown = (rows || []).filter((s) => !filter || s.title.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div ref={box} className="relative min-w-0 [-webkit-app-region:no-drag]">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch Claude session"
        className="flex max-w-[150px] items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted transition-colors hover:bg-soft hover:text-fg"
      >
        {workingTitles.size > 0 && <span className="working-dot" aria-hidden />}
        <span className="truncate">{current || "Sessions"}</span>
        <ChevronDown size={12} className="shrink-0" />
      </button>

      {open && (
        <div className="absolute top-8 left-0 z-20 flex max-h-[380px] w-[310px] flex-col rounded-xl border border-line bg-white shadow-[0_1rem_2.5rem_-1rem_rgba(0,0,0,.28)]">
          <div className={cn("p-1.5", (rows !== null || filter) && "border-b border-line")}>
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a session…"
              className="h-8 w-full rounded-lg bg-soft px-2.5 text-[12.5px] text-fg outline-none select-text placeholder:text-faint"
            />
          </div>
          {/* While the list is still loading and nothing is typed, show just the search field. */}
          <div role="listbox" hidden={rows === null && !filter} className="min-h-0 flex-1 overflow-y-auto p-1">
            {rows === null && filter && <div className="px-2.5 py-2 text-[12.5px] text-faint">Loading…</div>}
            {rows !== null && shown.length === 0 && <div className="px-2.5 py-2 text-[12.5px] text-faint">No sessions found.</div>}
            {shown.map((s) => {
              const working = s.working || workingTitles.has(s.title);
              return (
                <div key={s.id + s.title} role="option" aria-selected={s.open} className="group flex items-center rounded-lg hover:bg-black/[0.04]">
                  <button onClick={() => switchTo(s.title)} disabled={!!busy} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left" title={canSwitch ? "Open in Claude" : "Ask Grok about it"}>
                    <span className={cn("size-2 shrink-0 rounded-full", working ? "working-dot" : s.open ? "bg-fg" : "bg-black/15")} aria-label={working ? "Claude is working" : s.open ? "Open" : "Idle"} />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-[13px]", s.open ? "text-fg" : "text-fg")}>{busy === s.title ? "Opening…" : s.title}</span>
                      {(s.project || s.lastActive || working) && (
                        <span className="block truncate text-[11.5px] text-faint">
                          {[s.project, working ? "working" : s.lastActive].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </span>
                    {s.open && <span className="shrink-0 rounded-full border border-black/15 px-1.5 text-[10.5px] text-muted">open</span>}
                  </button>
                  <button
                    onClick={() => {
                      setOpen(false);
                      onAsk(s.title);
                    }}
                    title="Ask Grok about this session"
                    aria-label={`Ask Grok about ${s.title}`}
                    className="mr-1 grid size-7 shrink-0 place-items-center rounded-md text-faint opacity-0 group-hover:opacity-100 hover:bg-black/[0.05] hover:text-fg focus:opacity-100"
                  >
                    <MessageCircleQuestion size={14} />
                  </button>
                </div>
              );
            })}
          </div>
          {error && <div className="border-t border-line px-3 py-2 text-[12px] text-amber-700">{error}</div>}
          {!canSwitch && rows && <div className="border-t border-line px-3 py-2 text-[11.5px] text-faint">Open the Claude app to switch sessions from here.</div>}
        </div>
      )}
    </div>
  );
}
