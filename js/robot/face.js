/* Qubit on the phone screen, from robot/face.js. The site's own engine (qubit-engine.js, already on the page
 * for the Qubit along the bottom) runs a second instance with no DOM: its shared ticker moves him, and his
 * body stunts are off, because the whole screen is his body. We read his springs and redraw only when
 * something changed: the screen filled with his current colour (one solid fill) and his eye as true black.
 * Nothing else is drawn.
 */
import * as THREE from './vendor/three.module.min.js';
import { oklchToRgb } from './color.js';

const EYE_ANCHOR_Y = -15; // his resting eye height (body units) sits at the screen's centre
const MODES = { idle: 'idle', listening: 'listening', talking: 'speaking', happy: 'happy', thinking: 'thinking', curious: 'curious', sleepy: 'sleepy' };

export function createFace(screenLong, screenShort) {
  const QE = globalThis.QubitEngine;
  const W = 1000; // landscape: the canvas runs along the phone's length
  const H = Math.round((W * screenShort) / screenLong);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const material = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });

  const q = QE.create({ keepAlive: true, brain: true, mode: 'idle' });
  q.brainT.play = Infinity; // no hops or flips
  q.brainT.stunt = Infinity;
  let last = '';
  let colour = oklchToRgb(...QE.PALETTE.indigo);
  let mood = 'idle';
  let talkT = 0;

  function draw() {
    const s = q.sp;
    const L = s.L.v;
    const C = Math.max(0, s.C.v);
    const Hh = ((s.H.v % 360) + 360) % 360;
    const ex = s.ex.v;
    const ey = s.ey.v;
    const lidH = Math.min(1.2, Math.max(0.04, s.lidH.v));
    const lidV = Math.min(1.2, Math.max(0.04, s.lidV.v));
    const ew = Math.max(0.5, s.ew.v) * lidV;
    const eh = Math.max(0.5, s.eh.v) * lidH;
    const er = s.er.v;
    const key = [L, C, Hh, ex, ey, ew, eh, er].map((v) => v.toFixed(3)).join(',');
    if (key === last) return;
    last = key;
    colour = oklchToRgb(L, C, Hh);
    const [r, g, b] = colour.srgb;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = `rgb(${(r * 255).toFixed(2)},${(g * 255).toFixed(2)},${(b * 255).toFixed(2)})`;
    ctx.fillRect(0, 0, W, H);
    const k = H / 100;
    ctx.translate(W / 2 + ex * k, H / 2 + (ey - EYE_ANCHOR_Y) * k);
    ctx.rotate((er * Math.PI) / 180);
    ctx.fillStyle = '#000';
    ctx.fillRect((-ew / 2) * k, (-eh / 2) * k, ew * k, eh * k);
    tex.needsUpdate = true;
  }
  draw();

  return {
    material,
    q,
    get colour() {
      return colour;
    },
    get mood() {
      return mood;
    },
    setMood(name) {
      if (name === mood || !MODES[name]) return;
      mood = name;
      q.setMode(MODES[name]);
      q.talking = name === 'talking';
    },
    dispose() {
      q.destroy();
      tex.dispose();
      material.dispose();
    },
    /** Settle him fast, for stills. */
    settle(seconds = 2) {
      for (let t = 0; t < seconds; t += 1 / 60) q.update(1 / 60);
      draw();
    },
    update(dt) {
      if (q.talking) {
        talkT += dt;
        const a = Math.max(0, Math.sin(talkT * 13) * 0.5 + Math.sin(talkT * 7.3) * 0.5);
        q.setLevels(0, a);
      } else q.setLevels(0, 0);
      draw();
    },
  };
}
