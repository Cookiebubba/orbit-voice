/*
  Mouse "stirring" for the orb: the same fluid as the Orbit website's background
  (site/js/background.js), the cursor push only.

  A small stable-fluids solver runs at one cell per tile. The cursor pushes velocity in along the
  segment it moved, a pressure solve keeps the flow incompressible, and an offset map carries
  each tile's patch of the pattern along with the flow, then relaxes, so the orb heals back into
  its own motion. The orb shader reads the offset map: tiles stay put (they're the hardware),
  only the light moves.

  The website does this on the GPU; the orb's grid is small (about 48 x 48 tiles), so it runs here
  on the CPU with the website's numbers, and costs nothing once everything has healed.
*/

export const FLOW = { force: 0.25, radius: 1.9, flow: 1.4, heal: 3.8, cap: 160, iterations: 24 };

export type Flow = {
  w: number;
  h: number;
  /** The offset map as RGBA floats, row 0 at the bottom (gl_FragCoord order): x, y in tiles. */
  rgba: Float32Array;
  /** Is anything still moving or displaced? (When false, the shader can skip the map.) */
  active: boolean;
  /** Cursor in tiles (origin bottom-left), or null when it isn't over the window. */
  setMouse(x: number | null, y?: number): void;
  step(dt: number): void;
};

export function createFlow(w: number, h: number): Flow {
  const n = w * h;
  let vx = new Float32Array(n), vy = new Float32Array(n);
  let ox = new Float32Array(n), oy = new Float32Array(n);
  let p = new Float32Array(n), p2 = new Float32Array(n);
  const div = new Float32Array(n);
  let tx = new Float32Array(n), ty = new Float32Array(n); // scratch for advection
  const rgba = new Float32Array(n * 4);
  let mouse: [number, number] | null = null;
  let lastMouse: [number, number] | null = null;
  let active = false;

  const idx = (i: number, j: number) => j * w + i;
  const clampI = (i: number) => (i < 0 ? 0 : i >= w ? w - 1 : i);
  const clampJ = (j: number) => (j < 0 ? 0 : j >= h ? h - 1 : j);
  /** Bilinear read at tile coords (cell centres at i+0.5), clamped at the edges like CLAMP_TO_EDGE. */
  const sample = (f: Float32Array, x: number, y: number) => {
    const fx = Math.min(Math.max(x - 0.5, 0), w - 1), fy = Math.min(Math.max(y - 0.5, 0), h - 1);
    const i0 = Math.floor(fx), j0 = Math.floor(fy);
    const i1 = Math.min(i0 + 1, w - 1), j1 = Math.min(j0 + 1, h - 1);
    const ax = fx - i0, ay = fy - j0;
    const a = f[idx(i0, j0)] * (1 - ax) + f[idx(i1, j0)] * ax;
    const b = f[idx(i0, j1)] * (1 - ax) + f[idx(i1, j1)] * ax;
    return a * (1 - ay) + b * ay;
  };

  function step(dt: number) {
    if (dt <= 0) return;
    // SPLAT: push velocity along the cursor's path this frame.
    let pushed = false;
    if (mouse && lastMouse) {
      const [ax, ay] = lastMouse, [bx, by] = mouse;
      let pvx = (bx - ax) / dt, pvy = (by - ay) / dt;
      const sp = Math.hypot(pvx, pvy);
      if (sp > FLOW.cap) { pvx *= FLOW.cap / sp; pvy *= FLOW.cap / sp; }
      const k = FLOW.force * Math.min(1, dt * 30); // stamped every frame: a per-second rate
      pvx *= k; pvy *= k;
      if (pvx !== 0 || pvy !== 0) {
        pushed = true;
        const bax = bx - ax, bay = by - ay, bb = Math.max(bax * bax + bay * bay, 1e-4), r2 = FLOW.radius * FLOW.radius;
        // only cells within reach of the segment can feel it
        const reach = FLOW.radius * 4;
        const i0 = clampI(Math.floor(Math.min(ax, bx) - reach)), i1 = clampI(Math.ceil(Math.max(ax, bx) + reach));
        const j0 = clampJ(Math.floor(Math.min(ay, by) - reach)), j1 = clampJ(Math.ceil(Math.max(ay, by) + reach));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const cx = i + 0.5, cy = j + 0.5;
          const pax = cx - ax, pay = cy - ay;
          const t = Math.min(1, Math.max(0, (pax * bax + pay * bay) / bb));
          const dx = pax - bax * t, dy = pay - bay * t;
          const fall = Math.exp(-(dx * dx + dy * dy) / r2);
          const q = idx(i, j);
          vx[q] = Math.min(200, Math.max(-200, vx[q] + pvx * fall));
          vy[q] = Math.min(200, Math.max(-200, vy[q] + pvy * fall));
        }
      }
    }
    lastMouse = mouse;
    if (!pushed && !active) return; // nothing moving, nothing displaced: no work at all

    // DIVERGENCE, PRESSURE (Jacobi), GRADIENT: make the flow incompressible.
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const L = vx[idx(clampI(i - 1), j)], R = vx[idx(clampI(i + 1), j)];
      const B = vy[idx(i, clampJ(j - 1))], T = vy[idx(i, clampJ(j + 1))];
      div[idx(i, j)] = 0.5 * (R - L + T - B);
    }
    for (let it = 0; it < FLOW.iterations; it++) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const L = p[idx(clampI(i - 1), j)], R = p[idx(clampI(i + 1), j)];
        const B = p[idx(i, clampJ(j - 1))], T = p[idx(i, clampJ(j + 1))];
        p2[idx(i, j)] = (L + R + B + T - div[idx(i, j)]) * 0.25;
      }
      [p, p2] = [p2, p];
    }
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const L = p[idx(clampI(i - 1), j)], R = p[idx(clampI(i + 1), j)];
      const B = p[idx(i, clampJ(j - 1))], T = p[idx(i, clampJ(j + 1))];
      const q = idx(i, j);
      vx[q] -= 0.5 * (R - L);
      vy[q] -= 0.5 * (T - B);
    }

    // ADVECT the offset map along the flow, and let it heal back toward zero.
    const heal = Math.exp(-dt / FLOW.heal);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const q = idx(i, j), sx = vx[q] * dt, sy = vy[q] * dt;
      const cx = i + 0.5 - sx, cy = j + 0.5 - sy;
      tx[q] = (sample(ox, cx, cy) - sx) * heal;
      ty[q] = (sample(oy, cx, cy) - sy) * heal;
    }
    [ox, tx] = [tx, ox];
    [oy, ty] = [ty, oy];

    // ADVECT the velocity itself, fading.
    const fade = Math.exp(-dt / FLOW.flow);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const q = idx(i, j), cx = i + 0.5 - vx[q] * dt, cy = j + 0.5 - vy[q] * dt;
      tx[q] = sample(vx, cx, cy) * fade;
      ty[q] = sample(vy, cx, cy) * fade;
    }
    [vx, tx] = [tx, vx];
    [vy, ty] = [ty, vy];

    // Pack the offsets for the shader, and settle to exactly zero once it has all healed.
    let most = 0;
    for (let q = 0; q < n; q++) {
      rgba[q * 4] = ox[q];
      rgba[q * 4 + 1] = oy[q];
      most = Math.max(most, Math.abs(ox[q]), Math.abs(oy[q]), Math.abs(vx[q]) * 0.05, Math.abs(vy[q]) * 0.05);
    }
    active = pushed || most > 0.004;
    if (!active) {
      vx.fill(0); vy.fill(0); ox.fill(0); oy.fill(0); p.fill(0); rgba.fill(0);
    }
  }

  return {
    w,
    h,
    rgba,
    get active() {
      return active;
    },
    setMouse(x, y) {
      if (x === null || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
        mouse = lastMouse = null;
        return;
      }
      mouse = [x, y];
    },
    step,
  };
}
