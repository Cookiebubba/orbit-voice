// Scrollable history of this conversation (kept in memory only; gone when you quit).
import { useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Caption } from "../useVoice";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default function History({ items, onClose }: { items: Caption[]; onClose: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView(), [items.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pb-2">
        <button onClick={onClose} className="flex items-center gap-1.5 rounded-md py-1 pr-2 text-[13px] text-white/60 hover:text-white">
          <ArrowLeft size={15} /> Back
        </button>
        <span className="text-[12px] text-white/35">This session only</span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-4 select-text">
        {items.length === 0 && <p className="pt-10 text-center text-[13px] text-white/40">Nothing yet. Start talking and the conversation shows up here.</p>}
        {items.map((c) =>
          c.who === "note" ? (
            <p key={c.id} className="text-center text-[11.5px] text-white/35">
              {c.text} · {time(c.at)}
            </p>
          ) : c.who === "sent" ? (
            <div key={c.id} className="rounded-xl border border-emerald-400/30 bg-emerald-400/[0.06] px-3 py-2">
              <div className="text-[10.5px] uppercase tracking-wider text-emerald-300/80">Sent to Claude · {time(c.at)}</div>
              <p className="mt-0.5 text-[13px] leading-snug whitespace-pre-wrap text-white/90">{c.text}</p>
            </div>
          ) : (
            <div key={c.id} className={cn("flex", c.who === "you" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-2xl px-3 py-2 text-[13px] leading-snug whitespace-pre-wrap",
                  c.who === "you" && "bg-white/[0.12] text-white",
                  c.who === "grok" && "bg-white/[0.05] text-white/85",
                  c.who === "error" && "border border-amber-400/30 text-amber-300",
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
