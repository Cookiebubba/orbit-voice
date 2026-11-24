// The strip on top of Settings: Qubit (his real engine, nothing redrawn) or the pixel buddy, and the
// caption beside them. He reacts to whatever you just touched, in the moods he has in the app, and
// says so out loud on the Claude engine: sound never costs Grok minutes, and never plays over a call.
import "../vendor/avatars/qubit-engine.js";
import { ANTENNA } from "../buddy/engine.js";
import { drawBuddy } from "../buddy/sprite.js";
import { DEFAULT_VOLUME, volumeGain } from "../playback.js";
import { chimeLength, playChime, setChimeVolume, type Chime } from "../sounds";
import { createThrowSound } from "../throwSound.js";
import type { Speech } from "./speech";

const HOLD_MS = 1800; // a reaction holds this long, or as long as its sound, then he idles
const SCALE = 58 / 124; // his stage: 124 units wide, drawn 58 wide
const SIDE: Record<number, number> = { 1: 62, 2: 88, 3: 112 }; // Tiny, Small, Big
const FLOOR = 1 / SCALE; // he stands on the hairline, one px over the strip's bottom edge
const MOOD = { idle: "idle", listening: "listening", thinking: "thinking", speaking: "speaking", draft: "curious", sending: "happy", working: "focused", sleepy: "sleepy", sad: "sad", surprised: "surprised" } as const;
export type Mood = keyof typeof MOOD;
// Everything in his modes that moves him: with reduced motion these go, and colour still changes.
const MOVERS = ["breathe", "bounce", "hueCycle", "nods", "leanPulse", "stretch", "superpose", "droop"];

// The pixel buddy: the real figure, drawn from a pose per mood.
const BUDDY: Record<Mood, Record<string, unknown>> = {
  idle: { facing: 0, mouth: "smile", antenna: ANTENNA.sleep },
  listening: { facing: 0, armR: "ear", eyes: "wide", antenna: ANTENNA.listen },
  thinking: { facing: 0, armR: "chin", eyes: "look", lookX: 0.6, lookY: 1, antenna: ANTENNA.think },
  speaking: { facing: 0, mouth: "smile", antenna: ANTENNA.talk },
  draft: { facing: 0, armR: "hold", eyes: "wide", mouth: "o", antenna: ANTENNA.connecting },
  sending: { facing: 0, armL: "up", armR: "up", eyes: "happy", mouth: "grin", antenna: ANTENNA.hear },
  working: { facing: 0, armL: "type0", armR: "type1", mouth: "flat", antenna: ANTENNA.connecting },
  sleepy: { facing: 0, eyes: "half", mouth: "none", antenna: ANTENNA.sleep },
  sad: { facing: 0, eyes: "half", mouth: "flat", antenna: ANTENNA.sleep },
  surprised: { facing: 0, armL: "out", armR: "out", eyes: "wide", mouth: "o", antenna: ANTENNA.connecting },
};

export type Reaction = { line?: string; chime?: Chime; wheee?: boolean };
export type StripEnv = {
  /** Spoken lines play on this engine only. */
  claude: () => boolean;
  volume: () => number;
  /** A call is on: colour and caption only, so nothing plays over it or reaches the mic. */
  live: () => boolean;
  size: () => number;
  buddy: () => boolean;
};

export function createStrip({ mount, canvas, sayEl, speech, env }: { mount: HTMLElement; canvas: HTMLCanvasElement; sayEl: HTMLElement; speech: Speech; env: StripEnv }) {
  const E = (window as any).QubitEngine;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => motion.matches;
  const q = E.create({ mount, width: 124, height: 74 / SCALE, size: SIDE[2], floor: FLOOR, mode: "idle", keepAlive: true });
  q.brainT.play = q.brainT.stunt = Infinity; // as in the app: no tricks of his own. He breathes, blinks and looks.

  const throwSound = createThrowSound({ gain: volumeGain });
  let mood: Mood = "idle";
  let moodTimer: ReturnType<typeof setTimeout> | undefined;
  let reactId = 0;

  const setMood = (m: Mood, instant = false) => {
    mood = m;
    q.setMode(MOOD[m], { instant: instant || reduced() });
  };
  const setSize = (instant = false) => {
    const g = SIDE[env.size()] / SIDE[2];
    if (instant || reduced()) q.sp.grow.snap(g);
    else q.sp.grow.to(g);
  };

  // Reduced motion: no breathing or other loops. (MODES is shared with the main page: put back on leave.)
  const kept = new Map<string, Record<string, unknown>>();
  const applyMotion = () => {
    for (const [name, m] of Object.entries<any>(E.MODES)) {
      if (!kept.has(name)) kept.set(name, Object.fromEntries(MOVERS.map((k) => [k, m[k]])));
      for (const k of MOVERS) {
        if (reduced()) delete m[k];
        else if (kept.get(name)![k] !== undefined) m[k] = kept.get(name)![k];
      }
    }
    q.brainT.blink = q.brainT.glance = reduced() ? Infinity : 2;
    if (reduced()) q.setPointer(null);
    setMood(mood, true);
    setSize(true);
  };
  motion.addEventListener("change", applyMotion);

  const onMove = (e: PointerEvent) => {
    if (reduced()) return;
    const r = mount.getBoundingClientRect();
    q.setPointer({ x: (e.clientX - r.left) / SCALE, y: (e.clientY - r.top) / SCALE });
  };
  window.addEventListener("pointermove", onMove, { passive: true });

  const bctx = canvas.getContext("2d")!;
  let buddyKey = "";
  let buddyT = 0;
  const drawBuddyNow = (dt: number, level: number) => {
    buddyT += dt;
    const pose: Record<string, unknown> = { ...BUDDY[mood] };
    if (!reduced()) {
      pose.bob = Math.sin(buddyT * 2.2) > 0 ? 1 : 0;
      if (buddyT % 3.4 < 0.12 && pose.eyes !== "happy") pose.eyes = "closed";
      if (speech.talking()) pose.mouth = level > 0.45 ? "open2" : level > 0.12 ? "open1" : pose.mouth === "grin" ? "grin" : "flat";
    }
    const px = ({ 1: 4, 2: 6, 3: 8 } as Record<number, number>)[env.size()]; // canvas px per art px: 2, 3 or 4 CSS px
    const key = JSON.stringify([pose, px]);
    if (key === buddyKey) return;
    buddyKey = key;
    bctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const [x, y, color] of drawBuddy(pose)) {
      bctx.fillStyle = color;
      bctx.fillRect(Math.round(canvas.width / 2 + x * px), canvas.height - 2 - (y + 1) * px, px, px);
    }
  };

  // Pressed tiles spring back on his own frame: stiffness 400, damping 30.
  const presses = new Map<HTMLElement, { v: number; vel: number; to: number }>();
  const tick = (dt: number) => {
    // His mouth follows the line's real loudness.
    q.talking = speech.talking();
    const level = reduced() ? 0 : speech.level();
    q.setLevels(0, level);
    if (env.buddy()) drawBuddyNow(dt, level);
    for (const [el, p] of presses) {
      const steps = 3;
      for (let i = 0; i < steps; i++) {
        p.vel += (400 * (p.to - p.v) - 30 * p.vel) * (dt / steps);
        p.v += (p.vel * dt) / steps;
      }
      if (p.to === 1 && Math.abs(p.v - 1) < 0.0005 && Math.abs(p.vel) < 0.01) {
        el.style.transform = "";
        presses.delete(el);
      } else el.style.transform = `scale(${p.v.toFixed(4)})`;
    }
  };
  E.ticker.hooks.add(tick);

  const idleAfter = (ms: number) => {
    clearTimeout(moodTimer);
    moodTimer = setTimeout(() => setMood("idle"), ms);
  };
  const setText = (t: string) => {
    if (sayEl.textContent !== t) sayEl.textContent = t;
  };

  const api = {
    q,
    get mood() {
      return mood;
    },
    setText,
    setSize,
    /** Swaps him and the buddy. */
    showKind() {
      canvas.hidden = !env.buddy();
      mount.hidden = env.buddy();
    },
    press(el: HTMLElement, to: number) {
      if (reduced()) return;
      const p = presses.get(el) || { v: 1, vel: 0, to: 1 };
      p.to = to;
      presses.set(el, p);
    },
    /** He reacts: `mode`, `text` and the sound. His mood lasts as long as the sound, else 1.8 s. */
    react(mode: Mood, text: string, o: Reaction = {}) {
      const me = ++reactId;
      setMood(mode);
      setText(text);
      speech.stop();
      const audible = env.volume() > 0 && !env.live();
      let delay = 0;
      setChimeVolume(env.volume());
      if (audible && o.chime) {
        playChime(o.chime);
        delay = chimeLength(o.chime);
      }
      if (audible && o.wheee) throwSound.play(env.volume() ?? DEFAULT_VOLUME);
      if (o.line && audible && env.claude()) {
        idleAfter(HOLD_MS + delay * 1000); // until the line says how long it is
        void speech.say(o.line, delay).then((r) => {
          if (!r || me !== reactId) return;
          if (mood !== mode) setMood(mode); // (a slow line can outlast the hold: he still says it in his mood)
          idleAfter((r.wait + r.seconds) * 1000 + 150);
        });
      } else idleAfter(HOLD_MS);
    },
    /** The caption and mood while a slider moves. Speech already playing carries on, at the new volume. */
    caption(mode: Mood, text: string) {
      ++reactId;
      setMood(mode);
      setText(text);
      idleAfter(HOLD_MS);
    },
    destroy() {
      clearTimeout(moodTimer);
      window.removeEventListener("pointermove", onMove);
      motion.removeEventListener("change", applyMotion);
      E.ticker.hooks.delete(tick);
      for (const [name, was] of kept) for (const k of MOVERS) if (was[k] !== undefined) E.MODES[name][k] = was[k];
      for (const el of presses.keys()) el.style.transform = "";
      presses.clear();
      q.destroy();
    },
  };
  applyMotion();
  api.showKind();
  return api;
}
export type Strip = ReturnType<typeof createStrip>;
