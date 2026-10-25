// Scrollable history of this conversation (kept in memory only; gone when you quit).
import { useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Caption } from "../useVoice";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default function History({ items, onClose }: { items: Caption[]; onClose: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  // (Braces: newer Chromium returns a promise from scrollIntoView, and React would take it for a cleanup.)
  useEffect(() => {
    end.current?.scrollIntoView();
  }, [items.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pb-2">
        <button onClick={onClose} className="flex items-center gap-1.5 rounded-md py-1 pr-2 text-[13px] text-muted transition-colors hover:text-fg">
          <ArrowLeft size={15} /> Back
        </button>
        <span className="eyebrow">This session only</span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-4 select-text">
        {items.length === 0 && <p className="pt-10 text-center text-[13px] text-faint">Nothing yet. Start talking and the conversation shows up here.</p>}
        {items.map((c) =>
          c.who === "note" ? (
            <p key={c.id} className="text-center text-[11.5px] text-faint">
              {c.text} · {time(c.at)}
            </p>
          ) : c.who === "sent" ? (
            <div key={c.id} className="rounded-xl border border-emerald-600/20 bg-emerald-50 px-3 py-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-emerald-700">Sent to Claude · {time(c.at)}</div>
              <p className="mt-0.5 text-[13px] leading-snug whitespace-pre-wrap text-fg">{c.text}</p>
            </div>
          ) : (
            <div key={c.id} className={cn("flex", c.who === "you" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-2xl px-3 py-2 text-[13px] leading-snug whitespace-pre-wrap",
                  c.who === "you" && "bg-fg text-white",
                  c.who === "grok" && "bg-soft text-fg",
                  c.who === "error" && "border border-amber-600/30 text-amber-700",
                )}
                title={time(c.at)}
              >
                {c.text}
              </div>
            </div>
          ),
        )}
        <div ref={end} />
      </div>
    </div>
  );
}
