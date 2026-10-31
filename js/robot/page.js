/* The #/robot page. site.js imports this file only when the route opens, and calls what mountRobot returns
 * when it closes, so nothing here costs the other pages anything.
 *
 * The canvas sits behind a scroller inside the view; scrolling picks the robot's pose. Reduced motion or no
 * WebGL2: no canvas, the posters stay and the sections stack. Every number the scroll sets is in pose():
 * dist is metres, az and el are degrees, shiftX and shiftY move the robot across the view as a fraction of it.
 *
 * Coffee: every button is a real link to Buy Me a Coffee. When their widget loads, the buttons open its panel
 * here on the page instead, and a blocked or failed script just leaves the links.
 */
const COFFEE_URL = "https://buymeacoffee.com/brandynships";
const WIDGET = "https://cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js";

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = t => t * t * (3 - 2 * t);
const mix = (a, b, t) => a + (b - a) * t;
// eased keyframes: [[t, value], ...]
function kf(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      return mix(v0, v1, smooth((t - t0) / (t1 - t0)));
    }
  }
  return keys[keys.length - 1][1];
}
const hex = s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16));
const WHITE = hex("#ffffff"), INK = hex("#0d0d0d"), BODY = hex("#ec9a2a");

/* ---------------------------------- coffee --------------------------------- */
// Their script builds its button and panel on DOMContentLoaded, which is long past by the time this route
// opens. So it's caught as the script registers it and called directly, once per visit to the page. That
// also means leaving and coming back doesn't load it twice. Its floating button is hidden by our CSS: our own
// buttons click it. No message is set, so it never sets its "visited" cookie or shows its speech bubble.
let widget = null; // a promise of its init function
function loadWidget() {
  return widget ||= new Promise((resolve, reject) => {
    let widgetInit = null;
    const s = document.createElement("script");
    s.src = WIDGET;
    Object.assign(s.dataset, { name: "BMC-Widget", id: "brandynships", description: "Help me build Qubit, the robot.", message: "", color: "#0d0d0d", position: "Right", x_margin: "18", y_margin: "18" });
    const own = Object.getOwnPropertyDescriptor(window, "addEventListener");
    window.addEventListener = function (type, fn, opts) {
      if (type === "DOMContentLoaded") { widgetInit = fn; return; }
      return EventTarget.prototype.addEventListener.call(this, type, fn, opts);
    };
    const done = () => {
      if (own) Object.defineProperty(window, "addEventListener", own); else delete window.addEventListener;
      s.remove();
    };
    s.onload = () => { done(); widgetInit ? resolve(widgetInit) : reject(new Error("no widget init")); };
    s.onerror = () => { done(); widget = null; reject(new Error("widget blocked")); };
    document.head.append(s);
  });
}

function mountCoffee(root, onHover) {
  let added = [];
  let gone = false;
  const before = new Set(document.body.children);
  loadWidget().then(init => {
    if (gone) return;
    init();
    added = [...document.body.children].filter(n => !before.has(n));
    root.classList.add("panel-ready");
  }).catch(() => { /* the links still work */ });

  const open = e => {
    const btn = document.getElementById("bmc-wbtn");
    if (!btn || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    btn.click();
  };
  const links = [...root.querySelectorAll(".coffee")];
  const enter = () => onHover(true), leave = () => onHover(false);
  for (const a of links) {
    a.href = COFFEE_URL;
    a.addEventListener("click", open);
    a.addEventListener("pointerenter", enter);
    a.addEventListener("pointerleave", leave);
    a.addEventListener("focus", enter);
    a.addEventListener("blur", leave);
  }
  return () => { gone = true; added.forEach(n => n.remove()); };
}

/* ---------------------------------- stage ---------------------------------- */
export function mountRobot(root) {
  const scroller = root.querySelector(".r-scroll");
  scroller.focus({ preventScroll: true }); // arrow keys and page up/down scroll straight away

  let hoverCoffee = false;
  const stopCoffee = mountCoffee(root, on => (hoverCoffee = on));

  const rows = root.querySelector(".r-rows");
  const io = new IntersectionObserver((e, o) => {
    if (e[0].isIntersecting) { rows.classList.add("in"); o.disconnect(); }
  }, { root: scroller, threshold: .3 });
  io.observe(rows);

  let stopStage = null, left = false;
  const webgl2 = (() => { try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; } })();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !webgl2) root.classList.add("static");
  else startStage(root, scroller, () => hoverCoffee, () => left).then(stop => {
    if (left) stop(); else stopStage = stop;
  }).catch(e => {
    console.error(e);
    root.classList.add("static");
  });

  return () => {
    left = true;
    io.disconnect();
    stopCoffee();
    stopStage?.();
  };
}

async function startStage(root, scroller, coffeeHovered, left) {
  const { createStage, DEFAULTS } = await import("./stage.js?v=1");
  if (left()) return () => {};
  const canvas = root.querySelector(".r-stage");
  const back = root.querySelector(".r-back");
  const pin = root.querySelector(".r-pin");
  const lineItems = [...root.querySelectorAll(".r-lines li")];
  const veil = root.querySelector(".r-veil");
  const copies = [".r-hero .copy", ".r-robot .copy", ".r-ar .copy"].map(s => root.querySelector(s));
  const phone = () => root.clientWidth <= 760;
  const coarse = matchMedia("(pointer: coarse)").matches;

  const stage = await createStage(canvas, { phone: coarse });
  const room = stage.room;

  let dpr = Math.min(devicePixelRatio || 1, 2);
  let m = {};
  function measure() {
    const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const at = sel => {
      const b = root.querySelector(sel).getBoundingClientRect();
      return { top: b.top - origin, h: b.height };
    };
    const W = root.clientWidth, H = root.clientHeight;
    m = { hero: at(".r-hero"), robot: at(".r-robot"), ar: at(".r-ar"), money: at(".r-money"), coffee: at(".r-last"), vh: H };
    stage.resize(W, H, dpr);
    room.uniforms.uSize.value = 2.5 * dpr * Math.min(1.5, H / 700);
  }
  const ro = new ResizeObserver(measure);
  ro.observe(root);
  measure();

  // the head follows the pointer a little, in the hero and the last section
  const look = { x: 0, y: 0, tx: 0, ty: 0 };
  const onPointer = e => {
    look.tx = (e.clientX / innerWidth - .5) * 2;
    look.ty = (e.clientY / innerHeight - .5) * 2;
  };
  if (!coarse) addEventListener("pointermove", onPointer, { passive: true });

  function pose(y) {
    const n = phone();
    const vh = m.vh;
    const hero = clamp(y / m.hero.h);
    const rob = clamp((y - m.robot.top) / (m.robot.h - vh));
    const into = clamp((y - (m.ar.top - vh)) / vh); // the AR section sliding in
    const a = clamp((y - m.ar.top) / (m.ar.h - vh));
    const covered = y >= m.money.top; // money fills the view, so the stage can change underneath it
    const end = clamp((y - (m.coffee.top - vh)) / vh);

    if (covered) return {
      s: {
        ...DEFAULTS,
        az: kf(end, [[0, -28], [1, n ? -10 : -16]]), el: 5, ty: .178,
        dist: n ? 1.62 : .92, shiftX: n ? 0 : .21, shiftY: n ? -.215 : .01,
        j1: mix(-16, 0, smooth(end)) + look.y * 5, j2: look.x * 7,
        wheel: end * 90,
      },
      bg: BODY, dark: false, mood: "happy", veil: 0, r: 1, fade: [0, 0, 1],
    };

    const reform = smooth(into); // the parts come back together as the dark comes in
    const explode = kf(rob, [[.06, 0], [.62, 1]]) * (1 - reform);

    const heroPose = {
      az: mix(-24, -8, smooth(hero)), el: 5, ty: .178,
      dist: n ? 1.45 : .92,
      shiftX: n ? 0 : .19, shiftY: n ? -.225 : .01,
    };
    const robPose = {
      az: mix(-8, -304, smooth(rob)), el: mix(5, 13, smooth(rob)), ty: mix(.178, .285, smooth(explode)),
      dist: mix(heroPose.dist, n ? 3.85 : 2.3, smooth(explode)),
      shiftX: heroPose.shiftX, shiftY: mix(heroPose.shiftY, n ? -.2 : .01, smooth(explode)),
    };
    const base = rob > 0 ? robPose : heroPose;

    // the room: he's pulled back from, then he turns, flips his head (the LiDAR faces backward, so he drives
    // with his face toward us, as the real one will) and drives round the table, then turns to talk to us
    const scan = kf(a, [[.06, 0], [.6, 1]]);
    const pull = kf(a, [[.02, 0], [.42, 1]]);
    const path = kf(a, [[.34, 0], [.9, 1]]);
    const u = clamp(kf(a, [[.42, 0], [.92, 1]]) * .97);
    const p = room.curve.getPointAt(u);
    const d = room.curve.getTangentAt(u);
    const heading = Math.atan2(d.x, d.z);
    const unwrapped = heading < 0 ? heading + Math.PI * 2 : heading; // the route never crosses due +z, so this stays continuous
    const yaw = kf(a, [[.26, 0], [.38, 1]]) * unwrapped * (1 - kf(a, [[.91, 0], [.985, 1]]));
    const drive = u * room.length * 1000;

    const arPose = {
      az: mix(-18, n ? 12 : 20, pull), el: mix(6, n ? 24 : 18, pull),
      tx: mix(0, (n ? .2 : .1) + p.x * .5, pull), ty: mix(.2, .26, pull), tz: mix(.9, (n ? -.3 : -.2) + p.z * .3, pull),
      dist: mix(n ? 1.7 : 1.25, n ? 6.5 : 3.9, pull),
      shiftX: mix(n ? 0 : .2, n ? 0 : .16, pull), shiftY: n ? -.24 : 0,
    };

    const k = smooth(into);
    const azFrom = ((base.az + 180) % 360 + 360) % 360 - 180; // take the short way round
    return {
      s: {
        ...DEFAULTS,
        explode,
        az: mix(azFrom, arPose.az, k), el: mix(base.el, arPose.el, k), dist: mix(base.dist, arPose.dist, k),
        tx: mix(0, arPose.tx, k), ty: mix(base.ty, arPose.ty, k), tz: mix(0, arPose.tz, k),
        shiftX: mix(base.shiftX, arPose.shiftX, k), shiftY: mix(base.shiftY, arPose.shiftY, k),
        j1: y < m.hero.h ? look.y * 5 * (1 - hero) : 0,
        j2: (y < m.hero.h ? look.x * 7 * (1 - hero) : 0) + kf(a, [[.3, 0], [.42, 175], [.9, 175], [.98, 0]]),
        rigX: mix(0, p.x, k), rigZ: mix(0, p.z, k), rigYaw: yaw,
        wheel: (drive / stage.WHEEL_R) * (180 / Math.PI) + hero * 40,
        dark: smooth(clamp((into - .15) / .75)), scan, path,
      },
      bg: WHITE.map((v, i) => mix(v, INK[i], smooth(clamp((into - .05) / .8)))),
      dark: into > .55,
      mood: into > .5 ? (a > .92 ? "talking" : "listening") : rob > 0 && rob < .8 ? "curious" : "idle",
      veil: clamp((into - .5) * 2),
      r: rob,
      // on a phone the words share the robot's column, so they fade rather than scroll across him
      fade: [1 - clamp(y / (vh * .4)), 1 - clamp(into * 2.5), clamp((into - .55) / .45)],
    };
  }

  const vhHalf = () => m.vh * .5;

  /* ---------------------------------- loop ---------------------------------- */
  let raf = 0, ys = scroller.scrollTop, last = performance.now(), slow = 0, frames = 0, spent = 0, lastBg = "";
  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(.05, (now - last) / 1000);
    last = now;
    const y = scroller.scrollTop;
    ys += (y - ys) * (1 - Math.exp(-dt * 11));
    if (Math.abs(y - ys) < .3) ys = y;
    look.x += (look.tx - look.x) * (1 - Math.exp(-dt * 5));
    look.y += (look.ty - look.y) * (1 - Math.exp(-dt * 5));
    const f = pose(ys);
    const bg = `rgb(${f.bg.map(v => Math.round(v)).join(",")})`;
    if (bg !== lastBg) back.style.background = lastBg = bg;
    pin.classList.toggle("on-dark", f.dark);
    pin.classList.toggle("show", y > m.hero.h * .55 && y < m.coffee.top - vhHalf()); // the hero and the last section have their own
    veil.style.opacity = f.veil.toFixed(3);
    copies.forEach((c, i) => (c.style.opacity = phone() ? f.fade[i].toFixed(3) : ""));
    lineItems.forEach((li, i) => li.classList.toggle("on", f.r >= .1 + (i / lineItems.length) * .72));
    stage.face.setMood(coffeeHovered() ? "happy" : f.mood);
    stage.set(f.s);
    stage.render(dt);
    // when a machine can't keep up, trade sharpness for smoothness
    spent += dt;
    if (++frames === 45) {
      const fps = frames / spent;
      frames = spent = 0;
      if (fps < 42 && dpr > 1) { dpr = Math.max(1, dpr - .34); measure(); }
      else if (fps < 30 && ++slow > 1) stage.renderer.shadowMap.enabled = false;
    }
  }
  stage.set(pose(scroller.scrollTop).s);
  stage.render(0);
  root.classList.add("live");
  window.__robotStage = stage; // for build/shoot.mjs and checks in the console
  raf = requestAnimationFrame(t => { last = t; tick(t); });

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    removeEventListener("pointermove", onPointer);
    delete window.__robotStage;
    stage.dispose();
  };
}
