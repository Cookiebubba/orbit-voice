// A prompt Grok drafted for Claude, waiting for your yes. You can fix the wording first.
import { useEffect, useRef, useState } from "react";
import type { Draft } from "../useVoice";

export default function DraftCard({ draft, onSend, onDiscard, onEdit }: { draft: NonNullable<Draft>; onSend: () => void; onDiscard: () => void; onEdit: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft.text);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setText(draft.text);
  }, [draft.text, editing]);

  useEffect(() => {
    if (editing) {
      area.current?.focus();
      area.current?.setSelectionRange(text.length, text.length);
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => {
    const clean = text.trim();
    if (clean && clean !== draft.text) onEdit(clean);
    setEditing(false);
  };

  return (
    <div className="mx-4 mb-3 rounded-2xl border border-white/15 bg-white/[0.06] p-3">
      <div className="text-[11px] uppercase tracking-wider text-white/40">Send to {draft.targetTitle || "Claude"}?</div>
      {editing ? (
        <textarea
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
            if (e.key === "Escape") {
              setText(draft.text);
              setEditing(false);
            }
          }}
          rows={4}
          className="mt-1.5 w-full resize-none rounded-lg border border-white/20 bg-black/40 p-2 text-[13px] leading-snug text-white outline-none select-text focus:border-white/50"
        />
      ) : (
        <p onDoubleClick={() => setEditing(true)} className="mt-1 line-clamp-5 cursor-text text-[13px] leading-snug whitespace-pre-wrap text-white/90" title="Double-click to edit">
          {draft.text}
        </p>
      )}
      <div className="mt-2.5 flex gap-2">
        {editing ? (
          <>
            <button onClick={save} className="rounded-full bg-white px-3.5 py-1.5 text-[13px] font-medium text-black hover:bg-white/90">
              Save
            </button>
            <button
              onClick={() => {
                setText(draft.text);
                setEditing(false);
              }}
              className="rounded-full px-3.5 py-1.5 text-[13px] text-white/70 hover:bg-white/10"
            >
              Cancel
            </button>
            <span className="ml-auto self-center text-[11px] text-white/35">Ctrl+Enter to save</span>
          </>
        ) : (
          <>
            <button onClick={onSend} className="rounded-full bg-white px-3.5 py-1.5 text-[13px] font-medium text-black hover:bg-white/90">
              Send
            </button>
            <button onClick={() => setEditing(true)} className="rounded-full px-3.5 py-1.5 text-[13px] text-white/80 hover:bg-white/10">
              Edit
            </button>
            <button onClick={onDiscard} className="rounded-full px-3.5 py-1.5 text-[13px] text-white/60 hover:bg-white/10">
              Discard
            </button>
          </>
        )}
      </div>
    </div>
  );
}
