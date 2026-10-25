// The main page's hero: the avatar carousel with Qubit in the middle, drawn by his real engine and
// directed by hero.js (he stays put and shows off his emotes; while Orbit is live he wears its state).
// The carousel is wired to the `avatar` setting. It offers only Qubit for now, so its arrows are
// disabled and it has one dot, but stepping and choosing already work for more.
import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import "../vendor/avatars/orbit-nav.js";
import "../vendor/avatars/qubit-engine.js";
import { createHero, type Hero } from "./hero.js";
import { CAROUSEL, carouselCan, carouselIndex, carouselStep } from "./carousel.js";
import type { OrbSync } from "../desktop";
import type { Settings } from "../useAppState";

const SIDE = 64; // his body, px
const FLOOR = 18; // the hairline floor, px above the stage's bottom
const STAGE_H = Math.round(FLOOR + SIDE * 3.3); // room above him for his jumps and flips

type Voice = Partial<OrbSync> & { phase: OrbSync["phase"] };

export default function AvatarHero({
  avatar,
  onChoose,
  voice,
  label,
  onActivate,
}: {
  avatar: Settings["avatar"] | undefined;
  onChoose: (id: Settings["avatar"]) => void;
  voice: Voice;
  /** What a click on him does (start talking, wake...), for his accessible name. */
  label: string;
  onActivate: () => void;
}) {
  const index = carouselIndex(avatar);
  const item = CAROUSEL[index];
  const can = carouselCan(index);
  const chosen = item.id === avatar;
  const go = (dir: number) => {
    const next = carouselStep(index, dir);
    if (next !== index) onChoose(CAROUSEL[next].id);
  };
  return (
    <section aria-roledescription="carousel" aria-label="Your avatar" className="flex w-full flex-col items-center">
      <div className="eyebrow flex items-center gap-2">
        <span>{item.name}</span>
        {!chosen && (
          <>
            <span aria-hidden>·</span>
            <button onClick={() => onChoose(item.id)} className="tracking-[inherit] uppercase text-fg underline decoration-black/25 underline-offset-[3px] hover:decoration-fg">
              Use as my avatar
            </button>
          </>
        )}
      </div>
      <div className="relative mt-1 w-full" style={{ height: STAGE_H }}>
        {item.id === "qubit" && <QubitStage voice={voice} label={label} onActivate={onActivate} />}
        <CarouselArrow side="left" disabled={!can.prev} onClick={() => go(-1)} />
        <CarouselArrow side="right" disabled={!can.next} onClick={() => go(1)} />
      </div>
      <div role="tablist" aria-label="Avatars" className="mt-3 flex items-center gap-1.5">
        {CAROUSEL.map((a, i) => (
          <button
            key={a.id}
            role="tab"
            aria-selected={i === index}
            aria-label={a.name}
            title={a.name}
            onClick={() => i !== index && onChoose(a.id)}
            className={cn("h-1.5 rounded-full transition-all", i === index ? "w-4 bg-fg" : "w-1.5 bg-black/20 hover:bg-black/40")}
          />
        ))}
      </div>
    </section>
  );
}

function CarouselArrow({ side, disabled, onClick }: { side: "left" | "right"; disabled: boolean; onClick: () => void }) {
  const label = side === "left" ? "Previous avatar" : "Next avatar";
  return (
    <button
      aria-label={label}
      title={disabled ? `${label} (only one for now)` : label}
      disabled={disabled}
      onClick={onClick}
      className={cn("icon-btn absolute top-1/2 size-8 -translate-y-1/2", side === "left" ? "left-0" : "right-0")}
    >
      {side === "left" ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
    </button>
  );
}

function QubitStage({ voice, label, onActivate }: { voice: Voice; label: string; onActivate: () => void }) {
  const mount = useRef<HTMLDivElement>(null);
  const hero = useRef<Hero | null>(null);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  useEffect(() => {
    const el = mount.current;
    const E = (window as any).QubitEngine;
    if (!el || !E) return;
    const W = Math.max(120, el.clientWidth);
    const q = E.create({ mount: el, width: W, height: STAGE_H, size: SIDE, floor: FLOOR, x: W / 2, mode: "idle" });
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const h = createHero(q, { seed: Math.floor(Math.random() * 0xffffff) + 1, home: W / 2, timing: reduce ? { firstS: Infinity } : {} });
    h.setVoice(voiceRef.current);
    hero.current = h;
    const tick = (dt: number) => h.tick(dt);
    E.ticker.hooks.add(tick);
    (window as any).__hero = { q, hero: h }; // read-only, for the screenshots and tests
    // The cursor: he follows it with his eye (anywhere in the window).
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      q.setPointer({ x: e.clientX - r.left, y: e.clientY - r.top });
    };
    const leave = () => q.setPointer(null);
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    // A new width (the window resized): his stage follows, and he stays in the middle.
    const ro = new ResizeObserver(() => {
      const w = Math.max(120, el.clientWidth);
      if (w === q.W) return;
      const off = q.cx - h.home;
      q.resize(w, STAGE_H, FLOOR);
      h.home = w / 2;
      q.cx = w / 2 + off;
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", leave);
      E.ticker.hooks.delete(tick);
      q.destroy();
      hero.current = null;
      if ((window as any).__hero?.q === q) delete (window as any).__hero;
    };
  }, []);

  useEffect(() => {
    hero.current?.setVoice(voice);
  }, [voice.phase, voice.asleep, voice.hearing, voice.input, voice.output, voice.muted, voice.draft, voice.sending, voice.claudeWorking]);

  return (
    <>
      {/* the floor he stands on: a hairline, as on the website */}
      <div aria-hidden className="absolute inset-x-10 h-px bg-[#e8e8e8]" style={{ bottom: FLOOR }} />
      <div ref={mount} aria-hidden className="absolute inset-0" />
      <button
        aria-label={label}
        title={label}
        onClick={() => {
          hero.current?.poke();
          onActivate();
        }}
        className="absolute left-1/2 -translate-x-1/2 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-black/30"
        style={{ bottom: FLOOR - 4, width: SIDE * 1.3, height: SIDE * 1.3 }}
      />
    </>
  );
}
