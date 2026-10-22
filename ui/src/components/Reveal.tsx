// Shows or hides its children with a smooth open/close: height, fade and a slight slide. Children
// stay mounted while closing (so they animate out), then unmount. `gap` is space above the content
// that opens and closes with it, so a list of these needs no gaps of its own (no jump at the end).
// Respects "reduce motion".
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const MS = 320;

export default function Reveal({ show, children, gap = 0, className }: { show: boolean; children: React.ReactNode; gap?: number; className?: string }) {
  const [mounted, setMounted] = useState(show);
  const [open, setOpen] = useState(show);

  useEffect(() => {
    if (show) {
      setMounted(true);
      // Two frames: the closed state paints first, so opening animates.
      let b = 0;
      const a = requestAnimationFrame(() => (b = requestAnimationFrame(() => setOpen(true))));
      return () => {
        cancelAnimationFrame(a);
        cancelAnimationFrame(b);
      };
    }
    setOpen(false);
    const t = setTimeout(() => setMounted(false), MS);
    return () => clearTimeout(t);
  }, [show]);

  if (!mounted) return null;
  return (
    <div
      aria-hidden={!open}
      inert={!open}
      className={cn(
        "grid transition-[grid-template-rows,opacity,translate] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
        open ? "grid-rows-[1fr] translate-y-0 opacity-100" : "grid-rows-[0fr] -translate-y-1 opacity-0",
        className,
      )}
      style={{ transitionDuration: `${MS}ms` }}
    >
      <div className="min-h-0 overflow-hidden">
        <div style={gap ? { paddingTop: gap } : undefined}>{children}</div>
      </div>
    </div>
  );
}
