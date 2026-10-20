/* ===========================================================================
   The background: Orbit's orb shader (SHDR-29, ui/src/components/ui/shdr-29.tsx,
   from orbkit by zzzzshawn, MIT) as a full-screen LED tile wall that the
   cursor stirs like a liquid.

   A small stable-fluids solver runs at one cell per tile. The cursor pushes
   velocity in, a pressure solve keeps the flow incompressible, and an offset
   map carries the wall's pattern through the flow, then relaxes so the wall
   heals back into its own slow drift.

   The canvas lives outside the page content, so it keeps running untouched
   while the router swaps pages. Settings were tuned in site-lab/.
=========================================================================== */

const BG = {
  tile: 18, coverage: .38, gain: .1, confetti: .14, scale: 1.45, drift: .13, churn: .06, swirl: 1.36, blur: 3.5,
  force: .25, radius: 1.9, flow: 1.4, curl: 0, heal: 3.8,
};

const VERT = `#version 300 es
in vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

// every sim pass works in tile coordinates: gl_FragCoord.xy is the tile centre
const SIM_HEAD = `#version 300 es
precision highp float;
uniform vec2 uGrid;
out vec4 o;
vec4 at(sampler2D s, vec2 c){ return texture(s, c / uGrid); }
`;

const ADVECT = SIM_HEAD + `
uniform sampler2D uVel, uSrc;
uniform float uDt, uFade;
void main(){
  vec2 c = gl_FragCoord.xy;
  o = at(uSrc, c - at(uVel, c).xy * uDt) * uFade;
}`;

// offset map: where this tile's patch of pattern came from, minus where it is
const ADVECT_OFFSET = SIM_HEAD + `
uniform sampler2D uVel, uOff;
uniform float uDt, uHeal;
void main(){
  vec2 c = gl_FragCoord.xy;
  vec2 step = at(uVel, c).xy * uDt;
  o = vec4((at(uOff, c - step).xy - step) * uHeal, 0.0, 1.0);
}`;

const SPLAT = SIM_HEAD + `
uniform sampler2D uVel;
uniform vec2 uA, uB, uPush;     // cursor segment (tiles) and its velocity (tiles/s)
uniform float uRadius;
uniform vec3 uSplash;           // x, y, strength (0 = none)
void main(){
  vec2 c = gl_FragCoord.xy;
  vec2 v = at(uVel, c).xy;
  vec2 pa = c - uA, ba = uB - uA;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
  float d = length(pa - ba * h);
  v += uPush * exp(-d * d / (uRadius * uRadius));
  if (uSplash.z > 0.0) {
    vec2 r = c - uSplash.xy;
    v += normalize(r + 1e-4) * uSplash.z * exp(-dot(r, r) / (uRadius * uRadius * 2.5));
  }
  o = vec4(clamp(v, -200.0, 200.0), 0.0, 1.0);
}`;

const DIVERGENCE = SIM_HEAD + `
uniform sampler2D uVel;
void main(){
  vec2 c = gl_FragCoord.xy;
  float L = at(uVel, c - vec2(1,0)).x, R = at(uVel, c + vec2(1,0)).x;
  float B = at(uVel, c - vec2(0,1)).y, T = at(uVel, c + vec2(0,1)).y;
  o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;

const PRESSURE = SIM_HEAD + `
uniform sampler2D uP, uDiv;
void main(){
  vec2 c = gl_FragCoord.xy;
  float L = at(uP, c - vec2(1,0)).x, R = at(uP, c + vec2(1,0)).x;
  float B = at(uP, c - vec2(0,1)).x, T = at(uP, c + vec2(0,1)).x;
  o = vec4((L + R + B + T - at(uDiv, c).x) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADIENT = SIM_HEAD + `
uniform sampler2D uP, uVel;
void main(){
  vec2 c = gl_FragCoord.xy;
  float L = at(uP, c - vec2(1,0)).x, R = at(uP, c + vec2(1,0)).x;
  float B = at(uP, c - vec2(0,1)).x, T = at(uP, c + vec2(0,1)).x;
  o = vec4(at(uVel, c).xy - 0.5 * vec2(R - L, T - B), 0.0, 1.0);
}`;

const WALL = `#version 300 es
precision highp float;
out vec4 o;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}
float noise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),f.x),f.y);}
float fbm(vec2 p){float v=0.0;float a=0.5;for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.03+vec2(11.7,7.3);a*=0.5;}return v;}

uniform vec2 uRes, uGrid;
uniform float uCellPx;
uniform float uDrift, uChurn, uShuffle;          // integrated clocks
uniform float uCoverage, uGain, uConfetti, uScale, uSwirl;
uniform sampler2D uOff;
const vec3 LIT = vec3(1.0, 0.949, 0.867);
const vec3 WALLC = vec3(0.086);

void main(){
  vec2 cellIdx = floor(gl_FragCoord.xy / uCellPx);
  vec2 g = fract(gl_FragCoord.xy / uCellPx);
  float mn = min(uRes.x, uRes.y);

  // where this tile's patch of pattern has been dragged from, in tile units
  vec2 src = cellIdx + 0.5 + texture(uOff, (cellIdx + 0.5) / uGrid).xy;
  vec2 suvHome = (2.0 * (cellIdx + 0.5) * uCellPx - uRes) / mn;
  vec2 p2 = (2.0 * src * uCellPx - uRes) / mn * uScale * 1.35;
  float key = clamp(0.75 - 0.32 * length(suvHome - vec2(-0.35, 0.3)), 0.0, 1.0);

  vec2 f1 = vec2(uDrift * 0.5, -uDrift * 0.35);
  vec2 f2 = vec2(-uChurn * 0.4, uChurn * 0.6);
  vec2 warp = vec2(fbm(p2 * 0.9 + f2), fbm(p2 * 0.9 + f2.yx + 13.7)) - 0.5;
  float field = fbm(p2 + f1 + warp * uSwirl * 2.4);
  float lum = smoothstep(1.0 - uCoverage, 1.14 - uCoverage, field + 0.15 * key) * uGain;

  // tile geometry stays on the fixed grid (it's the hardware); only the light moves
  vec2 d2 = abs(g - 0.5);
  float d = max(d2.x, d2.y);
  float face = 1.0 - smoothstep(0.26, 0.36, d);
  float tile = 1.0 - smoothstep(0.42, 0.48, d);
  float led = 1.0 - smoothstep(0.0, 0.34, length(d2));

  // confetti rides with the fluid too: hashed on the dragged-from tile
  vec2 srcIdx = floor(src);
  float promoted = step(1.0 - uConfetti, fract(hash(srcIdx * 1.618 + 7.3) + uShuffle * 0.06));
  vec3 confetti = normalize(0.5 + 0.5 * cos(6.2831 * (hash(srcIdx * 2.113 + 41.7) + vec3(0.0, 0.33, 0.67))) + 0.05) * 1.2;
  vec3 litCol = mix(LIT, confetti, promoted);

  o = vec4(WALLC * tile + litCol * (face * 1.05 + led * 0.5) * lum, 1.0);
}`;

export function startBackground(canvas) {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
  if (!gl || !gl.getExtension("EXT_color_buffer_float")) return false; // the page's black background stands in

  const program = fs => {
    const mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "aPos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  };
  const prog = {
    advect: program(ADVECT), advectOff: program(ADVECT_OFFSET), splat: program(SPLAT),
    div: program(DIVERGENCE), pressure: program(PRESSURE), grad: program(GRADIENT), wall: program(WALL),
  };

  gl.bindVertexArray(gl.createVertexArray());
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const target = (w, h) => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fb, free() { gl.deleteTexture(tex); gl.deleteFramebuffer(fb); } };
  };
  const pair = (w, h) => {
    const t = [target(w, h), target(w, h)];
    return { get read() { return t[0]; }, get write() { return t[1]; }, swap() { t.reverse(); }, free() { t.forEach(x => x.free()); } };
  };

  let dpr = 1, cellPx = 18, grid = [0, 0], T = null, zoom = 1;
  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    const W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
    // tile size is set at the 16px design size and scales with the page (see site.css)
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    cellPx = Math.max(3, Math.round(BG.tile * (rem / 16) * dpr));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    // a blur pulls black in from past the edges; scale up just enough to push that off-screen
    const blur = BG.blur * (rem / 16);
    zoom = blur > 0 ? 1 + (blur * 5) / Math.min(innerWidth, innerHeight) : 1;
    canvas.style.filter = blur > 0 ? `blur(${blur}px)` : "";
    canvas.style.transform = zoom !== 1 ? `scale(${zoom})` : "";
    const next = [Math.ceil(W / cellPx), Math.ceil(H / cellPx)];
    if (T && next[0] === grid[0] && next[1] === grid[1]) return;
    if (T) Object.values(T).forEach(x => x.free());
    grid = next;
    T = { vel: pair(...grid), off: pair(...grid), pres: pair(...grid), div: target(...grid) };
  }
  addEventListener("resize", resize);
  resize();

  // one pass: bind textures to units in order, set uniforms, draw into `out` (null = screen)
  function pass(p, out, tex, uni = {}) {
    gl.useProgram(p.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null);
    if (out) gl.viewport(0, 0, grid[0], grid[1]); else gl.viewport(0, 0, canvas.width, canvas.height);
    let unit = 0;
    for (const [name, t] of Object.entries(tex)) {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform1i(p.u[name], unit++);
    }
    if (p.u.uGrid) gl.uniform2f(p.u.uGrid, grid[0], grid[1]);
    for (const [name, v] of Object.entries(uni)) {
      const loc = p.u[name]; if (!loc) continue;
      if (typeof v === "number") gl.uniform1f(loc, v);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else gl.uniform3f(loc, v[0], v[1], v[2]);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // cursor, in tile coords with the origin bottom-left to match gl_FragCoord
  const toTile = (x, y) => {
    x = (x - innerWidth / 2) / zoom + innerWidth / 2;    // undo the blur overscan
    y = (y - innerHeight / 2) / zoom + innerHeight / 2;
    return [x * dpr / cellPx, (innerHeight - y) * dpr / cellPx];
  };
  let mouse = null, lastMouse = null, splash = null;
  addEventListener("pointermove", e => { if (e.pointerType === "mouse") mouse = toTile(e.clientX, e.clientY); });
  document.addEventListener("pointerleave", () => { mouse = lastMouse = null; });
  // a click on empty space splashes; clicks on links, buttons and reading text don't
  addEventListener("pointerdown", e => {
    if (e.target.closest("a, button, .doc, .install")) return;
    splash = toTile(e.clientX, e.clientY);
  });

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clock = { drift: Math.random() * 50, churn: Math.random() * 50, shuffle: Math.random() * 50 };
  let last = performance.now();

  function frame(now) {
    const dt = Math.max(0, Math.min(0.033, (now - last) / 1000)) * (reduced ? 0.3 : 1);
    last = now;
    // the app's idle clocks run at about half speed (orbkit's flow-speed multiplier at idle)
    clock.drift += BG.drift * dt * 0.5;
    clock.churn += BG.churn * dt * 0.5;
    clock.shuffle += 0.3 * dt;

    if (dt > 0) {
      let a = [-999, -999], b = a, push = [0, 0];
      if (mouse && lastMouse) {
        a = lastMouse; b = mouse;
        let vx = (b[0] - a[0]) / dt, vy = (b[1] - a[1]) / dt;
        const sp = Math.hypot(vx, vy), cap = 160;
        if (sp > cap) { vx *= cap / sp; vy *= cap / sp; }
        const k = BG.force * Math.min(1, dt * 30); // the stamp lands every frame: keep it a per-second rate
        push = [vx * k, vy * k];
      }
      lastMouse = mouse;
      const sp = splash ? [splash[0], splash[1], 60 * BG.force] : [0, 0, 0];
      splash = null;

      pass(prog.splat, T.vel.write, { uVel: T.vel.read }, { uA: a, uB: b, uPush: push, uRadius: BG.radius, uSplash: sp });
      T.vel.swap();
      pass(prog.div, T.div, { uVel: T.vel.read });
      for (let i = 0; i < 24; i++) { pass(prog.pressure, T.pres.write, { uP: T.pres.read, uDiv: T.div }); T.pres.swap(); }
      pass(prog.grad, T.vel.write, { uP: T.pres.read, uVel: T.vel.read });
      T.vel.swap();
      pass(prog.advectOff, T.off.write, { uVel: T.vel.read, uOff: T.off.read }, { uDt: dt, uHeal: Math.exp(-dt / BG.heal) });
      T.off.swap();
      pass(prog.advect, T.vel.write, { uVel: T.vel.read, uSrc: T.vel.read }, { uDt: dt, uFade: Math.exp(-dt / BG.flow) });
      T.vel.swap();
    }

    pass(prog.wall, null, { uOff: T.off.read }, {
      uRes: [canvas.width, canvas.height], uCellPx: cellPx,
      uDrift: clock.drift, uChurn: clock.churn, uShuffle: clock.shuffle,
      uCoverage: BG.coverage, uGain: BG.gain, uConfetti: BG.confetti, uScale: BG.scale, uSwirl: BG.swirl,
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return true;
}
