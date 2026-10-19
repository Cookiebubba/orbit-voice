// A scroll area with a thin pill scrollbar. Hovering (or dragging) the bar outlines its whole
// track, so you can see how far the page goes. Drawn by hand instead of styling the native
// scrollbar, so it looks and behaves the same everywhere (native scrollbar hover is unreliable).
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const INSET = 8; // px of free space above and below the track
const MIN_THUMB = 32;

export default function PillScroll({ className, children }: { className?: string; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [m, setM] = useState({ show: false, top: 0, size: 0 });
  const [dragging, setDragging] = useState(false);

  const measure = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight + 1) return setM((p) => (p.show ? { show: false, top: 0, size: 0 } : p));
    const track = clientHeight - 2 * INSET;
    const size = Math.max(MIN_THUMB, (track * clientHeight) / scrollHeight);
    const top = ((track - size) * scrollTop) / (scrollHeight - clientHeight);
    setM({ show: true, top, size });
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    const mo = new MutationObserver(() => {
      for (const child of Array.from(el.children)) ro.observe(child);
      measure();
    });
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
      mo.disconnect();
    };
  }, [measure]);

  /** Drag the thumb, or press the track to jump there and keep dragging. */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = box.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const rail = e.currentTarget;
    const rect = rail.getBoundingClientRect();
    const range = el.scrollHeight - el.clientHeight;
    const travel = rect.height - m.size;
    const onThumb = e.clientY >= rect.top + m.top && e.clientY <= rect.top + m.top + m.size;
    if (!onThumb) el.scrollTop = ((e.clientY - rect.top - m.size / 2) / travel) * range; // jump, centred on the pointer
    const startY = e.clientY;
    const startScroll = el.scrollTop;
    rail.setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (ev: PointerEvent) => {
      el.scrollTop = startScroll + ((ev.clientY - startY) / travel) * range;
    };
    const up = () => {
      rail.removeEventListener("pointermove", move);
      rail.removeEventListener("pointerup", up);
      rail.removeEventListener("pointercancel", up);
      setDragging(false);
    };
    rail.addEventListener("pointermove", move);
    rail.addEventListener("pointerup", up);
    rail.addEventListener("pointercancel", up);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={box} className={cn("pill-scroll-area min-h-0 flex-1 overflow-y-auto", className)}>
        {children}
      </div>
      {m.show && (
        <div className={cn("pill-rail", dragging && "dragging")} style={{ top: INSET, bottom: INSET }} onPointerDown={onPointerDown} aria-hidden>
          <div className="pill-thumb" style={{ top: m.top, height: m.size }} />
        </div>
      )}
    </div>
  );
}
