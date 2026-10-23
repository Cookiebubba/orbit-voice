/* OrbitNav: shared pathing and idle planning for Orbit's avatars (Qubit and Inkey).
 *
 * Pure logic: no rendering, no DOM, no dependencies. Works in a page (global `OrbitNav`) and in node
 * (`require('./orbit-nav.js')`). Each engine executes the planned moves with its own mechanics.
 *
 * ---------------------------------------------------------------- environment
 *   env = { width, height, floor, solids: [{ id, x, y, w, h, kind }], left?, boundaryWalls? }
 *   Units are the engine's own (Qubit: CSS px of his stage; Inkey: his pixel units). y grows down;
 *   `floor` is the y of the ground line (default: height). Solids are axis-aligned rectangles: their
 *   tops are walkable, their sides and undersides climbable for climbers. The world runs from `left`
 *   (default 0, extension) to `width`. `boundaryWalls: true` makes the stage's left and right edges
 *   climbable walls too (extension).
 *   One-way platforms (extension): a solid with `oneWay: true` (or kind 'oneway') is a ledge you can
 *   jump up through from below and stand on, like a line of text in a UI. It never blocks a body; only
 *   its top is a surface (hoppers land on it, climbers walk on it).
 *
 * ---------------------------------------------------------------- abilities
 *   { bodyW, bodyH, walk: true, stepUp, jumpUp, jumpAcross, dropDown, climbWalls, climbCeilings }
 *   bodyW/bodyH   the body box (bodyW along the surface, bodyH away from it, i.e. along the normal).
 *   stepUp        highest step taken with a small hop (no real jump).
 *   jumpUp        highest rise of a jump, contact point to apex (so a platform up to about this high).
 *   jumpAcross    longest horizontal distance one jump carries the contact point.
 *   dropDown      deepest drop he will step off (0: never drops further than stepUp).
 *   climbWalls / climbCeilings   adds wall and ceiling surfaces, corner moves, drops from them.
 *   Extensions: edgeInset (how close to an edge the contact point may stand; default bodyW / 2),
 *   margin (extra clearance mid-flight), lifts / dropLifts (apex heights tried, in bodyH units),
 *   costs { walk, climb, ceiling, hop, jump, drop, corner } (per-unit for walk/climb/ceiling, base in
 *   bodyW for the rest), cornerReach.
 *
 * ---------------------------------------------------------------- API (as briefed, plus extensions)
 *   const nav = OrbitNav.build(env, abilities)
 *   nav.surfaces          [{ id, kind: 'floor'|'top'|'wall'|'ceiling', x1, y1, x2, y2, normal: [nx, ny],
 *                           solidId, axis: 'h'|'v' }]  Each is the stretch a contact point can occupy
 *                           with the whole body clear of every solid (stacked and overhanging solids
 *                           are subtracted), so walking or climbing along one never collides.
 *                           The contact point is the middle of the body's contact edge (Qubit: the
 *                           middle of his bottom face).
 *   nav.locate(x, y, opts) -> { surface, x, y, s, d } nearest standable point (or null).
 *                           opts.mode: 'nearest' (default) | 'gravity' (the surface under the point, or
 *                           the top of the solid the point is inside: what a click means for a hopper)
 *                           | 'auto' (gravity for non-climbers). opts.kinds: allowed surface kinds.
 *   nav.path(from, to, opts) -> [{ type: 'walk'|'hop'|'jump'|'drop'|'climb'|'corner', from:{x,y,surface},
 *                           to:{x,y,surface}, apex? }]  A* over the surface graph; null if unreachable.
 *                           from/to: { x, y, surface? } (surface: object or id). opts as locate's (for
 *                           `to`). The array also carries .cost, .start, .goal.
 *                           Move extras: hop/jump/drop: apex {x, y} (contact-point apex), rise, fall
 *                           (heights from each end to the apex), dx. corner: corner 'convex'|'concave',
 *                           pivot {x, y}. drop from a wall/ceiling: release: true (straight fall).
 *   nav.update(env)       rebuild when the UI moves. Returns true if anything changed. An unchanged
 *                           layout costs one signature compare; a changed one is a pruned full rebuild
 *                           (well under a few ms for UI-sized scenes; see nav-test.mjs).
 *   nav.version           bumps on every rebuild (planners and executors re-plan when it changes).
 *   nav.reachable(from)   Set of surface ids reachable from a point (extension).
 *   nav.trace(path, { offset, step }) points along a path for drawing; offset in bodyH units lifts the
 *                           line off the surface along the normal (0.5: through the body's centre).
 *   nav.transitions       every non-walk edge in the graph (for debugging overlays).
 *   OrbitNav.ballistic(from, to, apexY, g) -> { vx, vy, t1, t2, T, at(t) }  flight parameters for an
 *                           engine with gravity g (y down: vy < 0 is up).
 *
 *   OrbitNav.idle(nav, { seed, interests, home, temperament, fidgets }) -> planner
 *     planner.next(state)  state { x, y, t (seconds), pointer?: {x, y} } -> one intention:
 *       { kind: 'go'|'explore'|'perch'|'return', target, path, style, settleBefore, settleAfter, reason }
 *       { kind: 'rest', duration, style }    { kind: 'look', target, duration, reason }
 *       { kind: 'fidget', action, params, trick, duration }
 *     planner.notice({ x, y, kind, weight, ttl })  a transient interest (a new message, a click)
 *     planner.setInterests(list), planner.setHome(p), planner.reseed(seed), planner.history
 *     temperament: 'qubit' | 'inkey' | { energy, curiosity, sociability, boldness, playfulness,
 *                  patience, homebody } (0..1). fidgets: [{ name, weight, trick?, params? }].
 *     bias (extension): { rest, look, fidget, go, explore, perch, return } factors on top of the
 *                  temperament (e.g. { fidget: 2, rest: 0.5 } for a livelier spell).
 *   Idle life is a weighted behaviour chain (what tends to follow what), scaled by temperament, with
 *   novelty (recent behaviours and recently visited places are less likely), rests drawn from a
 *   log-normal distribution, settle beats before and after every move, and interest points (cursor,
 *   new message, Send button) that pull his attention and his feet. Seeded: the same seed and the same
 *   states give the same run; different seeds diverge within a few steps.
 *   OrbitNav.rng(seed) -> () => [0, 1)  (mulberry32; seed may be a number or a string). Extension.
 *   OrbitNav.TEMPERAMENTS  presets.
 */
(function (global) {
  'use strict';
  const EPS = 0.01;
  const BIG = 1e7;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const hyp = Math.hypot;

  // ---------------------------------------------------------------- seeded randomness
  function hashSeed(seed) {
    if (typeof seed === 'number' && isFinite(seed)) return (Math.floor(seed) >>> 0) || 0x9e3779b9;
    const s = String(seed ?? '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return (h >>> 0) || 0x9e3779b9;
  }
  function rng(seed) {
    let a = hashSeed(seed);
    const f = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.range = (lo, hi) => lo + f() * (hi - lo);
    f.normal = () => {
      // Box-Muller (one value)
      const u = Math.max(1e-9, f());
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * f());
    };
    f.logNormal = (median, sigma) => median * Math.exp(sigma * f.normal());
    f.weighted = (items, weightOf) => {
      let total = 0;
      for (const it of items) total += Math.max(0, weightOf(it));
      if (!(total > 0)) return null;
      let r = f() * total;
      for (const it of items) {
        r -= Math.max(0, weightOf(it));
        if (r <= 0) return it;
      }
      return items[items.length - 1];
    };
    return f;
  }

  // ---------------------------------------------------------------- abilities
  function normAbilities(a = {}) {
    const bw = a.bodyW ?? 40;
    const bh = a.bodyH ?? bw;
    const n = (v, d) => (typeof v === 'number' && isFinite(v) ? Math.max(0, v) : v === true ? d : 0);
    return {
      bodyW: bw,
      bodyH: bh,
      walk: a.walk !== false,
      stepUp: n(a.stepUp, bh * 0.3),
      jumpUp: n(a.jumpUp, bh * 2),
      jumpAcross: n(a.jumpAcross, bw * 3),
      dropDown: n(a.dropDown, bh * 6),
      climbWalls: !!a.climbWalls,
      climbCeilings: !!a.climbCeilings,
      edgeInset: a.edgeInset ?? bw * 0.5,
      margin: a.margin ?? Math.min(bw, bh) * 0.06,
      lifts: a.lifts ?? [0.18, 0.36, 0.6, 0.9],
      dropLifts: a.dropLifts ?? [0.1, 0.22, 0.4],
      hopLifts: a.hopLifts ?? [0.16, 0.26, 0.4],
      cornerReach: a.cornerReach ?? Math.max(bw, bh) * 0.8,
      costs: { walk: 1, climb: 1.6, ceiling: 2.4, hop: 0.5, jump: 1.6, drop: 0.9, corner: 0.7, ...(a.costs || {}) },
    };
  }

  // ---------------------------------------------------------------- geometry
  function readEnv(env) {
    const solids = [];
    let maxX = 0;
    (env.solids || []).forEach((s, i) => {
      if (!s || !(s.w > 0) || !(s.h > 0)) return;
      solids.push({ id: s.id != null ? String(s.id) : 's' + i, kind: s.kind, oneWay: !!(s.oneWay || s.kind === 'oneway'), x1: s.x, y1: s.y, x2: s.x + s.w, y2: s.y + s.h });
      maxX = Math.max(maxX, s.x + s.w);
    });
    const floor = env.floor ?? env.height ?? BIG;
    const width = env.width ?? maxX + 1000;
    return { solids, floor, width, left: env.left ?? 0, boundaryWalls: !!env.boundaryWalls };
  }
  function signature(env, ab) {
    const r = (v) => Math.round(v * 4) / 4;
    let s = `${r(env.left ?? 0)}|${r(env.width ?? -1)}|${r(env.floor ?? env.height ?? -1)}|${env.boundaryWalls ? 1 : 0}|${ab.bodyW}|${ab.bodyH}`;
    for (const o of env.solids || []) if (o) s += `|${o.id}:${r(o.x)},${r(o.y)},${r(o.w)},${r(o.h)}${o.oneWay || o.kind === 'oneway' ? 'o' : ''}`;
    return s;
  }
  const overlapsOpen = (a1, a2, b1, b2) => a1 < b2 - EPS && a2 > b1 + EPS;

  /** The body's box at parameter s on a face (or surface): [x1, y1, x2, y2]. */
  function bodyBox(f, s, ab, grow = 0) {
    const bw = ab.bodyW / 2 + grow;
    const bh = ab.bodyH;
    if (f.axis === 'h') {
      const y0 = f.normal[1] < 0 ? f.c - bh : f.c;
      return [s - bw, y0 - grow, s + bw, y0 + bh + grow];
    }
    const x0 = f.normal[0] < 0 ? f.c - bh : f.c;
    return [x0 - grow, s - bw, x0 + bh + grow, s + bw];
  }
  function boxHits(box, blockers, skip1, skip2) {
    for (const b of blockers) {
      if (b.id === skip1 || b.id === skip2) continue;
      if (overlapsOpen(box[0], box[2], b.x1, b.x2) && overlapsOpen(box[1], box[3], b.y1, b.y2)) return b;
    }
    return null;
  }

  function buildFaces(G, ab) {
    const faces = [];
    const { floor, width, left } = G;
    if (floor < BIG) faces.push({ kind: 'floor', axis: 'h', c: floor, a: left, b: width, normal: [0, -1], own: '__ground', solidId: null, inset: 0 });
    for (const s of G.solids) {
      if (s.y1 < floor - EPS) faces.push({ kind: 'top', axis: 'h', c: s.y1, a: s.x1, b: s.x2, normal: [0, -1], own: s.id, solidId: s.id, inset: ab.edgeInset });
      if (s.oneWay) continue; // a ledge to land on, nothing to climb
      if (ab.climbWalls) {
        const yb = Math.min(s.y2, floor);
        if (yb > s.y1 + EPS) {
          faces.push({ kind: 'wall', axis: 'v', c: s.x1, a: s.y1, b: yb, normal: [-1, 0], own: s.id, solidId: s.id, inset: ab.edgeInset, side: 'l' });
          faces.push({ kind: 'wall', axis: 'v', c: s.x2, a: s.y1, b: yb, normal: [1, 0], own: s.id, solidId: s.id, inset: ab.edgeInset, side: 'r' });
        }
      }
      if (ab.climbCeilings && s.y2 < floor - EPS) faces.push({ kind: 'ceiling', axis: 'h', c: s.y2, a: s.x1, b: s.x2, normal: [0, 1], own: s.id, solidId: s.id, inset: ab.edgeInset });
    }
    if (G.boundaryWalls && ab.climbWalls && floor < BIG) {
      faces.push({ kind: 'wall', axis: 'v', c: left, a: 0, b: floor, normal: [1, 0], own: '__left', solidId: '__left', inset: 0, side: 'r' });
      faces.push({ kind: 'wall', axis: 'v', c: width, a: 0, b: floor, normal: [-1, 0], own: '__right', solidId: '__right', inset: 0, side: 'l' });
    }
    return faces;
  }

  /** Cut a face into the stretches where the whole body fits: those are the surfaces. */
  function faceSurfaces(f, blockers, ab) {
    const half = ab.bodyW / 2;
    const inset = Math.min(f.inset, (f.b - f.a) / 2);
    let lo = f.a + inset;
    let hi = f.b - inset;
    if (hi < lo) return [];
    const box = bodyBox(f, 0, ab); // the perpendicular extent doesn't depend on s
    const p1 = f.axis === 'h' ? box[1] : box[0];
    const p2 = f.axis === 'h' ? box[3] : box[2];
    const cuts = [];
    for (const b of blockers) {
      if (b.id === f.own) continue;
      const q1 = f.axis === 'h' ? b.y1 : b.x1;
      const q2 = f.axis === 'h' ? b.y2 : b.x2;
      if (!overlapsOpen(p1, p2, q1, q2)) continue;
      const a1 = (f.axis === 'h' ? b.x1 : b.y1) - half;
      const a2 = (f.axis === 'h' ? b.x2 : b.y2) + half;
      if (a2 <= lo - EPS || a1 >= hi + EPS) continue;
      cuts.push([a1, a2]);
    }
    cuts.sort((u, v) => u[0] - v[0]);
    const out = [];
    let cur = lo;
    for (const [a1, a2] of cuts) {
      if (a1 > cur + EPS) out.push([cur, Math.min(a1, hi)]);
      else if (a1 > cur - EPS && a1 <= hi) out.push([cur, cur]); // touching: a single point
      cur = Math.max(cur, a2);
      if (cur > hi) break;
    }
    if (cur <= hi + EPS) out.push([cur, hi]);
    // Merge exact duplicates and drop inverted bits.
    const res = [];
    for (const [u, v] of out) {
      if (v < u - EPS) continue;
      const last = res[res.length - 1];
      if (last && u <= last[1] + EPS) last[1] = Math.max(last[1], v);
      else res.push([u, Math.max(u, v)]);
    }
    // A single point is only real if the body actually fits there.
    return res.filter(([u, v]) => v - u > EPS || !boxHits(bodyBox(f, u, ab), blockers, f.own));
  }

  // ---------------------------------------------------------------- the nav graph
  class Nav {
    constructor(env, abilities) {
      this.abilities = normAbilities(abilities);
      this.version = 0;
      this._sig = null;
      this.update(env);
    }

    update(env) {
      const sig = signature(env, this.abilities);
      if (sig === this._sig) return false;
      const t0 = now();
      this._sig = sig;
      this.env = env;
      this._build(readEnv(env));
      this.version++;
      this.buildMs = now() - t0;
      return true;
    }

    _build(G) {
      const ab = this.abilities;
      this.G = G;
      const blockers = G.solids.filter((s) => !s.oneWay);
      if (G.floor < BIG) blockers.push({ id: '__ground', x1: -BIG, x2: BIG, y1: G.floor, y2: BIG });
      blockers.push({ id: '__left', x1: -BIG, x2: G.left, y1: -BIG, y2: BIG });
      blockers.push({ id: '__right', x1: G.width, x2: BIG, y1: -BIG, y2: BIG });
      this.blockers = blockers;
      // Surfaces
      const surfaces = [];
      const counts = {};
      for (const f of buildFaces(G, ab)) {
        for (const [u, v] of faceSurfaces(f, blockers, ab)) {
          const base = f.kind === 'floor' ? 'floor' : `${f.own}:${f.kind}${f.side ? '-' + f.side : ''}`;
          const k = (counts[base] = (counts[base] ?? -1) + 1);
          const s = {
            id: `${base}:${k}`,
            kind: f.kind,
            axis: f.axis,
            normal: f.normal.slice(),
            solidId: f.solidId,
            x1: f.axis === 'h' ? u : f.c,
            x2: f.axis === 'h' ? v : f.c,
            y1: f.axis === 'h' ? f.c : u,
            y2: f.axis === 'h' ? f.c : v,
          };
          Object.defineProperties(s, {
            c: { value: f.c },
            s0: { value: u },
            s1: { value: v },
            own: { value: f.own },
            index: { value: surfaces.length },
          });
          surfaces.push(s);
        }
      }
      this.surfaces = surfaces;
      this.byId = new Map(surfaces.map((s) => [s.id, s]));
      // Graph
      this.nodes = [];
      this.adj = [];
      this.nodesOn = surfaces.map(() => []);
      this.transitions = [];
      this._standing = surfaces.filter((s) => s.axis === 'h' && s.normal[1] < 0);
      this._oneWay = new Set(G.solids.filter((s) => s.oneWay).map((s) => s.id));
      this._jumps();
      if (ab.climbWalls || ab.climbCeilings) {
        this._corners();
        this._releases();
      }
      for (const s of surfaces) this._node(s, s.s0), this._node(s, s.s1);
      this._walkEdges();
    }

    _node(surf, s) {
      const list = this.nodesOn[surf.index];
      for (const i of list) if (Math.abs(this.nodes[i].s - s) < 0.25) return i;
      const i = this.nodes.length;
      const p = at(surf, s);
      this.nodes.push({ i, surf, s, x: p.x, y: p.y });
      this.adj.push([]);
      list.push(i);
      return i;
    }
    _edge(a, b, cost, move) {
      this.adj[a].push({ to: b, cost, move });
      if (move.type !== 'walk' && move.type !== 'climb') this.transitions.push({ from: this.nodes[a], to: this.nodes[b], cost, move });
    }
    _walkEdges() {
      const ab = this.abilities;
      for (const surf of this.surfaces) {
        const list = this.nodesOn[surf.index].slice().sort((u, v) => this.nodes[u].s - this.nodes[v].s);
        const unit = unitCost(surf, ab);
        const type = surf.kind === 'floor' || surf.kind === 'top' ? 'walk' : 'climb';
        for (let k = 1; k < list.length; k++) {
          const a = list[k - 1];
          const b = list[k];
          const d = Math.abs(this.nodes[b].s - this.nodes[a].s);
          this.adj[a].push({ to: b, cost: d * unit, move: { type } });
          this.adj[b].push({ to: a, cost: d * unit, move: { type } });
        }
      }
    }

    /** Ballistic moves between standing surfaces: hops, jumps up and across, drops. */
    _jumps() {
      const ab = this.abilities;
      const S = this._standing;
      const bw = ab.bodyW;
      const bh = ab.bodyH;
      const hopReach = bw * 1.6;
      const dropReach = Math.max(bw * 2.8, ab.jumpAcross);
      const jumpReach = Math.max(ab.jumpAcross, bw);
      const maxDX = Math.max(hopReach, dropReach, jumpReach);
      const D = [0.5, 0.9, 1.4, 2.0, 2.8].map((k) => k * bw);
      for (const A of S) {
        for (const B of S) {
          if (A === B) continue;
          const up = A.c - B.c; // > 0: B is higher
          if (up > Math.max(ab.stepUp, ab.jumpUp) + EPS) continue;
          if (-up > Math.max(ab.stepUp, ab.dropDown) + EPS) continue;
          const gap = Math.max(0, B.s0 - A.s1, A.s0 - B.s1);
          if (gap > maxDX + EPS) continue;
          // Candidate take-off and landing points: the ends, and run-ups / landings near the ends.
          const cand = [];
          const seen = new Set();
          const add = (ta, lb) => {
            if (ta < A.s0 - EPS || ta > A.s1 + EPS || lb < B.s0 - EPS || lb > B.s1 + EPS) return;
            ta = clamp(ta, A.s0, A.s1);
            lb = clamp(lb, B.s0, B.s1);
            const key = `${Math.round(ta * 2)}:${Math.round(lb * 2)}`;
            if (seen.has(key)) return;
            seen.add(key);
            cand.push([ta, lb]);
          };
          for (const ta of [A.s0, A.s1]) for (const lb of [B.s0, B.s1]) add(ta, lb);
          if (this._oneWay.has(B.solidId) && up > 0) {
            // A one-way ledge: straight up through it from underneath is fine.
            const n = clamp(Math.round((B.s1 - B.s0) / (bw * 1.5)), 1, 12);
            for (let i = 0; i <= n; i++) {
              const lb = lerp(B.s0, B.s1, i / n);
              for (const k of [-0.5, 0, 0.5]) add(clamp(lb + k * bw, A.s0, A.s1), lb);
            }
          }
          for (const d of D) {
            add(clamp(B.s0 - d, A.s0, A.s1), B.s0);
            add(clamp(B.s1 + d, A.s0, A.s1), B.s1);
            add(A.s1, clamp(A.s1 + d, B.s0, B.s1));
            add(A.s0, clamp(A.s0 - d, B.s0, B.s1));
          }
          // Options: (pair, type, lift) with an estimated cost; check the cheapest first.
          const opts = [];
          const C = ab.costs;
          for (const [ta, lb] of cand) {
            const dx = lb - ta;
            const adx = Math.abs(dx);
            const push = (type, lifts) => {
              for (const L of lifts) {
                const apexY = Math.min(A.c, B.c) - L * bh;
                const rise = A.c - apexY;
                const fall = B.c - apexY;
                if (type === 'jump' && rise > ab.jumpUp + EPS) continue;
                if (type === 'hop' && rise > ab.stepUp + bh * 0.42 + EPS) continue;
                const arc = adx + rise + fall;
                const base = type === 'jump' ? C.jump : type === 'drop' ? C.drop : C.hop;
                const cost = base * bw + arc * (type === 'jump' ? 1.1 : 1) + (type === 'jump' ? rise * 0.4 : 0);
                opts.push({ ta, lb, dx, type, apexY, rise, fall, cost });
              }
            };
            const small = Math.abs(up) <= ab.stepUp + EPS;
            if (small && adx <= hopReach) push('hop', ab.hopLifts);
            if (up > EPS && !small && adx <= jumpReach && ab.jumpUp > 0) push('jump', ab.lifts);
            if (up < -EPS && !small && -up <= ab.dropDown + EPS && adx <= dropReach) push('drop', ab.dropLifts);
            if ((small || up < 0) && adx > hopReach * 0.6 && adx <= jumpReach && ab.jumpUp > 0 && (up >= -EPS || -up <= ab.dropDown)) push('jump', ab.lifts);
          }
          opts.sort((u, v) => u.cost - v.cost);
          const best = {};
          let found = 0;
          const ow = this._oneWay.has(B.solidId); // a long one-way ledge gets a way up at each spot
          for (const o of opts) {
            const cls = (o.dx > 0.5 ? 'r' : o.dx < -0.5 ? 'l' : 'v') + (ow ? '@' + Math.round(o.lb) : '');
            if (best[cls]) continue;
            if (!this._arcClear(A, B, o.ta, o.lb, o.apexY)) continue;
            best[cls] = o;
            if (!ow && ++found >= 3) break;
          }
          for (const cls in best) {
            const o = best[cls];
            const a = this._node(A, o.ta);
            const b = this._node(B, o.lb);
            const T = flight(o.rise, o.fall);
            const apex = { x: o.ta + (o.dx * (T.t1 / T.T || 0)), y: o.apexY };
            this._edge(a, b, o.cost, { type: o.type, apex, rise: o.rise, fall: o.fall, dx: o.dx });
          }
        }
      }
    }

    /** Is the swept body clear along a ballistic arc from (ta on A) to (lb on B)? */
    _arcClear(A, B, ta, lb, apexY) {
      const ab = this.abilities;
      const x0 = ta;
      const y0 = A.c;
      const dx = lb - ta;
      const T = flight(y0 - apexY, B.c - apexY);
      const len = Math.abs(dx) + (y0 - apexY) + (B.c - apexY);
      const N = clamp(Math.ceil(len / (Math.min(ab.bodyW, ab.bodyH) * 0.2)), 6, 80);
      const bw = ab.bodyW / 2;
      const bh = ab.bodyH;
      for (let i = 1; i < N; i++) {
        const u = i / N;
        const t = T.T * u;
        const x = x0 + dx * u;
        const y = y0 - T.v0 * t + 0.5 * t * t;
        // Extra clearance mid-flight only: the ends are surfaces, already known to fit (often flush
        // against a wall), and the bottom face is what lands.
        const m = ab.margin * clamp(Math.min(u, 1 - u) * 5 - 0.15, 0, 1);
        const box = [x - bw - m, y - bh - m, x + bw + m, y];
        if (boxHits(box, this.blockers)) return false;
      }
      return true;
    }

    /** Climbers: wrap round convex corners and turn in concave ones. */
    _corners() {
      const ab = this.abilities;
      const S = this.surfaces;
      const reach = ab.cornerReach;
      for (let i = 0; i < S.length; i++) {
        for (let j = i + 1; j < S.length; j++) {
          const A = S[i];
          const B = S[j];
          if (A.axis === B.axis) continue;
          const c = A.axis === 'h' ? { x: B.c, y: A.c } : { x: A.c, y: B.c };
          for (const sa of A.s1 > A.s0 + EPS ? [A.s0, A.s1] : [A.s0]) {
            for (const sb of B.s1 > B.s0 + EPS ? [B.s0, B.s1] : [B.s0]) {
              const ea = at(A, sa);
              const eb = at(B, sb);
              const va = [ea.x - c.x, ea.y - c.y];
              const vb = [eb.x - c.x, eb.y - c.y];
              if (hyp(...va) > reach || hyp(...vb) > reach) continue;
              const da = va[0] * B.normal[0] + va[1] * B.normal[1];
              const db = vb[0] * A.normal[0] + vb[1] * A.normal[1];
              // A solid's own faces always meet convexly; faces of different things meet concavely.
              const same = A.solidId != null && A.solidId === B.solidId;
              let kind = null;
              if (same && da < EPS && db < EPS) kind = 'convex';
              else if (!same && da > -EPS && db > -EPS && da + db > EPS) kind = 'concave';
              if (!kind) continue;
              const a = this._node(A, sa);
              const b = this._node(B, sb);
              const cost = (kind === 'convex' ? ab.costs.corner * 1.3 : ab.costs.corner) * ab.bodyW + hyp(...va) + hyp(...vb);
              this._edge(a, b, cost, { type: 'corner', corner: kind, pivot: { ...c } });
              this._edge(b, a, cost, { type: 'corner', corner: kind, pivot: { ...c } });
            }
          }
        }
      }
    }

    /** Climbers: let go of a ceiling (or the bottom of a wall) and drop onto what's below. */
    _releases() {
      const ab = this.abilities;
      if (!(ab.dropDown > 0)) return;
      const bw = ab.bodyW / 2;
      const bh = ab.bodyH;
      for (const C of this.surfaces) {
        if (C.kind !== 'ceiling' && C.kind !== 'wall') continue;
        const pts = [];
        if (C.kind === 'ceiling') {
          for (const B of this._standing) {
            const lo = Math.max(C.s0, B.s0);
            const hi = Math.min(C.s1, B.s1);
            if (hi < lo - EPS || B.c <= C.c) continue;
            for (const x of hi - lo > bw ? [lo, (lo + hi) / 2, hi] : [(lo + hi) / 2]) pts.push({ B, from: x, x, top: C.c });
          }
        } else {
          // The body hangs beside the wall; it falls straight down from the wall's lowest point.
          const x = C.c + C.normal[0] * (bh / 2);
          for (const B of this._standing) {
            if (x < B.s0 - EPS || x > B.s1 + EPS || B.c <= C.s1) continue;
            pts.push({ B, from: C.s1, x: clamp(x, B.s0, B.s1), top: C.s1 - bw });
          }
        }
        for (const { B, from, x, top } of pts) {
          const fall = B.c - (C.kind === 'ceiling' ? C.c : C.s1);
          if (fall > ab.dropDown + bh + EPS) continue;
          const box = [x - bw, top + EPS, x + bw, B.c - EPS];
          if (boxHits(box, this.blockers, C.own, B.own)) continue;
          // Only the first surface below counts (nothing in between).
          const a = this._node(C, from);
          const b = this._node(B, x);
          this._edge(a, b, ab.costs.drop * ab.bodyW + fall * 0.4, { type: 'drop', release: true, fall });
        }
      }
    }

    // ---------- queries
    surface(idOrSurf) {
      if (!idOrSurf) return null;
      if (typeof idOrSurf === 'string') return this.byId.get(idOrSurf) || null;
      return this.byId.get(idOrSurf.id) || null;
    }

    locate(x, y, opts = {}) {
      if (x && typeof x === 'object') return this.locate(x.x, x.y, { ...opts, surface: x.surface ?? opts.surface });
      const S = this.surfaces;
      if (!S.length) return null;
      const want = opts.surface ? this.surface(opts.surface) : null;
      if (want) return project(want, x, y);
      const kinds = opts.kinds ? new Set(opts.kinds) : null;
      const ok = (s) => !kinds || kinds.has(s.kind);
      let mode = opts.mode || 'nearest';
      if (mode === 'auto') mode = this.abilities.climbWalls || this.abilities.climbCeilings ? 'nearest' : 'gravity';
      if (mode === 'gravity') {
        // Inside a solid: its top. In the open: the first surface below the point.
        const inside = this.G.solids.find((b) => x > b.x1 && x < b.x2 && y > b.y1 && y < b.y2);
        if (inside) {
          let best = null;
          for (const s of S) if (s.kind === 'top' && s.solidId === inside.id && ok(s)) best = pickNearer(best, project(s, x, y));
          if (best) return best;
        } else {
          let best = null;
          const half = this.abilities.bodyW / 2;
          for (const s of this._standing) {
            if (!ok(s) || s.c < y - EPS || x < s.s0 - half || x > s.s1 + half) continue;
            if (!best || s.c < best.surface.c - EPS || (Math.abs(s.c - best.surface.c) <= EPS && project(s, x, y).d < best.d)) best = project(s, x, y);
          }
          if (best) return best;
        }
      }
      let best = null;
      for (const s of S) if (ok(s)) best = pickNearer(best, project(s, x, y));
      return best;
    }

    _start(p) {
      // The node edges a free point gets on its surface: the nearest node each way.
      const list = this.nodesOn[p.surface.index];
      let lo = null;
      let hi = null;
      for (const i of list) {
        const n = this.nodes[i];
        if (n.s <= p.s + EPS && (!lo || n.s > lo.s)) lo = n;
        if (n.s >= p.s - EPS && (!hi || n.s < hi.s)) hi = n;
      }
      return [lo, hi].filter(Boolean);
    }

    path(from, to, opts = {}) {
      const a = from && from.surface && from.s != null && this.surface(from.surface) === from.surface ? from : this.locate(from.x, from.y, { surface: from.surface, kinds: opts.fromKinds });
      const b = to && to.surface && to.s != null && this.surface(to.surface) === to.surface ? to : this.locate(to.x, to.y, { ...opts, surface: to.surface });
      if (!a || !b) return null;
      const ab = this.abilities;
      const N = this.nodes.length;
      const START = N;
      const GOAL = N + 1;
      const extra = new Map(); // node -> [{to, cost}]
      const unitA = unitCost(a.surface, ab);
      const unitB = unitCost(b.surface, ab);
      const startEdges = [];
      for (const n of this._start(a)) startEdges.push({ to: n.i, cost: Math.abs(n.s - a.s) * unitA, move: { type: walkType(a.surface) } });
      if (a.surface === b.surface) startEdges.push({ to: GOAL, cost: Math.abs(b.s - a.s) * unitA, move: { type: walkType(a.surface) } });
      for (const n of this._start(b)) {
        if (!extra.has(n.i)) extra.set(n.i, []);
        extra.get(n.i).push({ to: GOAL, cost: Math.abs(n.s - b.s) * unitB, move: { type: walkType(b.surface) } });
      }
      const pos = (i) => (i === START ? a : i === GOAL ? b : this.nodes[i]);
      const hScale = 0.3;
      const h = (i) => {
        const p = pos(i);
        return hyp(p.x - b.x, p.y - b.y) * hScale;
      };
      const g = new Map([[START, 0]]);
      const came = new Map();
      const heap = new Heap();
      heap.push(START, h(START));
      const closed = new Set();
      while (heap.size) {
        const cur = heap.pop();
        if (cur === GOAL) break;
        if (closed.has(cur)) continue;
        closed.add(cur);
        const gc = g.get(cur);
        const edges = cur === START ? startEdges : this.adj[cur].concat(extra.get(cur) || []);
        for (const e of edges) {
          const ng = gc + e.cost;
          if (ng < (g.get(e.to) ?? Infinity)) {
            g.set(e.to, ng);
            came.set(e.to, { from: cur, e });
            heap.push(e.to, ng + h(e.to));
          }
        }
      }
      if (!came.has(GOAL) && !(a.surface === b.surface && g.has(GOAL))) return null;
      // Rebuild the move list.
      const chain = [];
      for (let k = GOAL; k !== START; ) {
        const c = came.get(k);
        if (!c) return null;
        chain.push({ from: c.from, to: k, e: c.e });
        k = c.from;
      }
      chain.reverse();
      const pt = (i) => {
        const p = pos(i);
        return { x: p.x, y: p.y, surface: p.surface || p.surf };
      };
      const moves = [];
      for (const c of chain) {
        const m = { ...c.e.move, from: pt(c.from), to: pt(c.to) };
        if (m.apex) m.apex = { ...m.apex };
        if (m.pivot) m.pivot = { ...m.pivot };
        const last = moves[moves.length - 1];
        if ((m.type === 'walk' || m.type === 'climb') && last && last.type === m.type && last.to.surface === m.to.surface && m.from.surface === m.to.surface) {
          last.to = m.to;
          continue;
        }
        moves.push(m);
      }
      const out = moves.filter((m) => !((m.type === 'walk' || m.type === 'climb') && hyp(m.to.x - m.from.x, m.to.y - m.from.y) < 0.5));
      out.cost = g.get(GOAL);
      out.start = a;
      out.goal = b;
      out.version = this.version;
      return out;
    }

    reachable(from) {
      const a = from.surface && from.s != null ? from : this.locate(from.x, from.y, { surface: from.surface });
      const out = new Set();
      if (!a) return out;
      out.add(a.surface.id);
      const stack = this._start(a).map((n) => n.i);
      const seen = new Set(stack);
      while (stack.length) {
        const i = stack.pop();
        out.add(this.nodes[i].surf.id);
        for (const e of this.adj[i]) if (!seen.has(e.to)) seen.add(e.to), stack.push(e.to);
      }
      return out;
    }

    /** Points along a path for drawing. offset: along the normal, in bodyH units. */
    trace(path, { offset = 0, step } = {}) {
      const ab = this.abilities;
      const st = step || Math.min(ab.bodyW, ab.bodyH) * 0.2;
      const pts = [];
      const off = (p, n) => ({ x: p.x + n[0] * offset * ab.bodyH, y: p.y + n[1] * offset * ab.bodyH });
      const push = (p) => {
        const last = pts[pts.length - 1];
        if (!last || hyp(p.x - last.x, p.y - last.y) > 0.3) pts.push(p);
      };
      for (const m of path || []) {
        const nA = m.from.surface.normal;
        const nB = m.to.surface.normal;
        if (m.type === 'walk' || m.type === 'climb') {
          push(off(m.from, nA));
          push(off(m.to, nB));
        } else if (m.type === 'corner') {
          const A = off(m.from, nA);
          const B = off(m.to, nB);
          const c = m.pivot;
          const n = 8;
          for (let k = 0; k <= n; k++) {
            const u = k / n;
            // Ease round the corner: a quadratic through the corner point, offset by the normals.
            const nn = [lerp(nA[0], nB[0], u), lerp(nA[1], nB[1], u)];
            const l = hyp(...nn) || 1;
            const ctrl = { x: c.x + (nn[0] / l) * offset * ab.bodyH, y: c.y + (nn[1] / l) * offset * ab.bodyH };
            const x = (1 - u) * (1 - u) * A.x + 2 * u * (1 - u) * ctrl.x + u * u * B.x;
            const y = (1 - u) * (1 - u) * A.y + 2 * u * (1 - u) * ctrl.y + u * u * B.y;
            push({ x, y });
          }
        } else if (m.release) {
          push(off(m.from, nA));
          push(off(m.to, nB));
        } else {
          const T = flight(m.rise, m.fall);
          const n = clamp(Math.ceil((Math.abs(m.dx) + m.rise + m.fall) / st), 6, 80);
          for (let k = 0; k <= n; k++) {
            const u = k / n;
            const t = T.T * u;
            push({ x: m.from.x + m.dx * u, y: m.from.y - T.v0 * t + 0.5 * t * t - offset * ab.bodyH });
          }
        }
      }
      return pts;
    }
  }

  function unitCost(surf, ab) {
    return surf.kind === 'wall' ? ab.costs.climb : surf.kind === 'ceiling' ? ab.costs.ceiling : ab.costs.walk;
  }
  function walkType(surf) {
    return surf.kind === 'floor' || surf.kind === 'top' ? 'walk' : 'climb';
  }
  function at(surf, s) {
    return surf.axis === 'h' ? { x: s, y: surf.c } : { x: surf.c, y: s };
  }
  function project(surf, x, y) {
    const s = clamp(surf.axis === 'h' ? x : y, surf.s0, surf.s1);
    const p = at(surf, s);
    return { surface: surf, x: p.x, y: p.y, s, d: hyp(p.x - x, p.y - y) };
  }
  function pickNearer(best, cand) {
    return !best || cand.d < best.d - EPS ? cand : best;
  }
  /** Flight with g = 1 (shape only): rise and fall heights to the apex. */
  function flight(rise, fall) {
    const t1 = Math.sqrt(2 * Math.max(0, rise));
    const t2 = Math.sqrt(2 * Math.max(0, fall));
    return { t1, t2, T: t1 + t2, v0: t1 };
  }
  function ballistic(from, to, apexY, g = 1) {
    const rise = Math.max(0, from.y - apexY);
    const fall = Math.max(0, to.y - apexY);
    const t1 = Math.sqrt((2 * rise) / g);
    const t2 = Math.sqrt((2 * fall) / g);
    const T = t1 + t2;
    const vx = T > 0 ? (to.x - from.x) / T : 0;
    const vy = -Math.sqrt(2 * g * rise);
    return { vx, vy, t1, t2, T, rise, fall, at: (t) => ({ x: from.x + vx * t, y: from.y + vy * t + 0.5 * g * t * t }) };
  }
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  class Heap {
    constructor() {
      this.k = [];
      this.p = [];
    }
    get size() {
      return this.k.length;
    }
    push(key, pri) {
      const k = this.k;
      const p = this.p;
      let i = k.length;
      k.push(key);
      p.push(pri);
      while (i > 0) {
        const j = (i - 1) >> 1;
        if (p[j] <= pri) break;
        k[i] = k[j];
        p[i] = p[j];
        i = j;
      }
      k[i] = key;
      p[i] = pri;
    }
    pop() {
      const k = this.k;
      const p = this.p;
      const top = k[0];
      const lk = k.pop();
      const lp = p.pop();
      if (k.length) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= k.length) break;
          if (c + 1 < k.length && p[c + 1] < p[c]) c++;
          if (p[c] >= lp) break;
          k[i] = k[c];
          p[i] = p[c];
          i = c;
        }
        k[i] = lk;
        p[i] = lp;
      }
      return top;
    }
  }

  // ---------------------------------------------------------------- idle planner
  const TEMPERAMENTS = {
    qubit: { energy: 0.62, curiosity: 0.66, sociability: 0.72, boldness: 0.5, playfulness: 0.58, patience: 0.45, homebody: 0.55 },
    inkey: { energy: 0.38, curiosity: 0.82, sociability: 0.42, boldness: 0.74, playfulness: 0.3, patience: 0.72, homebody: 0.3 },
    calm: { energy: 0.3, curiosity: 0.5, sociability: 0.5, boldness: 0.3, playfulness: 0.3, patience: 0.85, homebody: 0.7 },
  };
  // What tends to follow what. Rows: the previous behaviour.
  const CHAIN = {
    start: { rest: 1, look: 0.9, fidget: 0.3, go: 0.5, explore: 0.2, perch: 0.1, return: 0 },
    move: { rest: 1, look: 0.85, fidget: 0.45, go: 0.14, explore: 0.06, perch: 0.05, return: 0.05 },
    rest: { rest: 0.08, look: 0.8, fidget: 0.65, go: 0.8, explore: 0.4, perch: 0.35, return: 0.3 },
    look: { rest: 0.55, look: 0.18, fidget: 0.45, go: 0.85, explore: 0.35, perch: 0.25, return: 0.25 },
    fidget: { rest: 0.85, look: 0.6, fidget: 0.12, go: 0.5, explore: 0.25, perch: 0.18, return: 0.2 },
  };
  const MOVES = new Set(['go', 'explore', 'perch', 'return']);
  const DEFAULT_FIDGETS = [
    { name: 'blink', weight: 1 },
    { name: 'glance', weight: 1 },
    { name: 'stretch', weight: 0.7 },
    { name: 'shift', weight: 0.8 },
  ];

  class IdlePlanner {
    constructor(nav, opts = {}) {
      this.nav = nav;
      this.opts = opts;
      const T = typeof opts.temperament === 'string' ? TEMPERAMENTS[opts.temperament] : opts.temperament;
      this.temper = { ...TEMPERAMENTS.qubit, ...(T || {}) };
      this.fidgets = (opts.fidgets || DEFAULT_FIDGETS).map((f) => (typeof f === 'string' ? { name: f, weight: 1 } : f));
      this.interests = (opts.interests || []).map(normInterest);
      this.home = opts.home || null;
      this.reseed(opts.seed ?? 1);
    }

    reseed(seed) {
      this.seed = seed;
      this.rand = rng(seed);
      this.history = [];
      this.kinds = [];
      this.fidgetLog = [];
      this.mem = new Map(); // place key -> { v (visits, decaying), at }
      this.attended = new Map(); // interest key -> time last attended
      this.transient = [];
      this.prev = 'start';
      this.lastT = null;
      this.awaySince = null;
      this.lingerNext = false;
      this.approach = null;
      this._places = null;
      this._placesV = -1;
      return this;
    }
    setInterests(list) {
      this.interests = (list || []).map(normInterest);
    }
    setHome(p) {
      this.home = p ? { x: p.x, y: p.y } : null;
    }
    /** A transient interest: a new message, a click, a sound. It fades over ttl seconds. */
    notice(i) {
      const n = normInterest(i);
      n.at = i.at ?? this.lastT ?? 0;
      n.ttl = i.ttl ?? 10;
      n.fresh = true;
      this.transient.push(n);
      if (this.transient.length > 8) this.transient.shift();
    }

    places() {
      const nav = this.nav;
      if (this._places && this._placesV === nav.version) return this._places;
      const ab = nav.abilities;
      const spacing = ab.bodyW * 1.25;
      const out = [];
      for (const s of nav.surfaces) {
        if (s.kind !== 'floor' && s.kind !== 'top' && !(this.temper.boldness > 0.6 && (s.kind === 'wall' || s.kind === 'ceiling'))) continue;
        const len = s.s1 - s.s0;
        const n = Math.max(1, Math.round(len / spacing));
        for (let k = 0; k < n; k++) {
          const u = n === 1 ? 0.5 : k / (n - 1);
          const sv = lerp(s.s0, s.s1, n === 1 ? 0.5 : 0.08 + 0.84 * u);
          const p = at(s, sv);
          out.push({ x: p.x, y: p.y, s: sv, surface: s, key: `${s.id}@${Math.round(sv / spacing)}`, high: nav.G.floor - p.y });
        }
      }
      this._places = out;
      this._placesV = nav.version;
      return out;
    }

    _decay(t) {
      const dt = this.lastT == null ? 0 : Math.max(0, t - this.lastT);
      if (dt > 0) {
        const k = Math.pow(0.5, dt / 30);
        for (const m of this.mem.values()) m.v *= k;
      }
      this.lastT = t;
      this.transient = this.transient.filter((i) => t - i.at < i.ttl * 3);
    }
    _novelty(key, t) {
      const m = this.mem.get(key);
      if (!m) return 1;
      return 1 / (1 + m.v * 1.6) * clamp((t - m.at) / 20, 0.25, 1);
    }
    _visit(key, t) {
      const m = this.mem.get(key) || { v: 0, at: t };
      m.v += 1;
      m.at = t;
      this.mem.set(key, m);
    }
    _activeInterests(state, t) {
      const out = [];
      for (const i of this.interests) out.push({ ...i, sal: i.weight });
      for (const i of this.transient) out.push({ ...i, sal: i.weight * Math.exp(-(t - i.at) / i.ttl), ref: i });
      if (state.pointer) out.push({ x: state.pointer.x, y: state.pointer.y, kind: 'cursor', weight: this.opts.cursorWeight ?? 0.9, sal: this.opts.cursorWeight ?? 0.9, key: 'cursor' });
      for (const i of out) {
        const last = this.attended.get(i.key);
        if (last != null) i.sal *= clamp((t - last) / 12, 0.15, 1);
      }
      return out.filter((i) => i.sal > 0.04);
    }

    next(state = {}) {
      const nav = this.nav;
      const R = this.rand;
      const T = this.temper;
      const ab = nav.abilities;
      const t = state.t ?? (this.lastT ?? 0) + 1;
      this._decay(t);
      const here = nav.locate(state.x ?? 0, state.y ?? nav.G.floor, { surface: state.surface });
      if (!here) return this._out({ kind: 'rest', duration: 2, style: 'still' }, t);
      if (!this.home) this.home = { x: here.x, y: here.y };
      const homeD = hyp(here.x - this.home.x, here.y - this.home.y);
      if (homeD < ab.bodyW * 0.9) this.awaySince = null;
      else if (this.awaySince == null) this.awaySince = t;
      const away = this.awaySince == null ? 0 : t - this.awaySince;
      const interests = this._activeInterests(state, t);

      // A fresh, salient interest (a new message, say) gets attention first.
      const fresh = this.transient.find((i) => i.fresh);
      if (fresh) {
        fresh.fresh = false;
        if (R() < 0.85) {
          this._attend(fresh, t);
          if (fresh.weight >= 0.8 && R() < lerp(0.5, 0.95, T.sociability)) this.approach = fresh; // and then go and see
          return this._out({ kind: 'look', target: { x: fresh.x, y: fresh.y }, duration: clamp(R.logNormal(0.9, 0.3), 0.5, 2), reason: 'notice:' + fresh.kind, interest: fresh.kind }, t, here);
        }
      }

      // Behaviour weights: the chain, then temperament, then novelty and context.
      const row = CHAIN[MOVES.has(this.prev) ? 'move' : this.prev] || CHAIN.start;
      const w = { ...row };
      w.rest *= lerp(1.4, 0.6, T.energy) * lerp(0.8, 1.25, T.patience);
      w.go *= lerp(0.6, 1.4, T.energy);
      w.explore *= lerp(0.4, 1.5, T.curiosity) * lerp(0.6, 1.3, T.energy);
      w.perch *= lerp(0.2, 1.6, T.boldness);
      w.fidget *= lerp(0.5, 1.5, T.playfulness);
      w.look *= lerp(0.6, 1.4, T.curiosity);
      w.return *= lerp(0.3, 1.8, T.homebody) * clamp(away / 25, 0, 1.6) * clamp(homeD / (ab.bodyW * 3), 0, 1.2);
      if (homeD < ab.bodyW * 1.5) w.return = 0;
      // A caller's own leaning (opts.bias: a factor per behaviour), on top of the temperament.
      for (const k in this.opts.bias || {}) if (k in w && Number.isFinite(this.opts.bias[k])) w[k] *= Math.max(0, this.opts.bias[k]);
      const topI = interests.reduce((m, i) => (!m || i.sal > m.sal ? i : m), null);
      if (topI) {
        w.look += topI.sal * 0.7 * lerp(0.6, 1.4, T.sociability);
        w.go += topI.sal * 0.45 * T.sociability;
      }
      if (this.approach && t - this.approach.at < this.approach.ttl) {
        w.go = (w.go + 1) * 4;
        w.rest *= 0.4;
      } else this.approach = null;
      if (this.lingerNext) {
        w.rest *= 2.2;
        w.go *= 0.4;
      }
      for (const k in w) {
        let c = 0;
        for (const r of this.kinds.slice(-4)) if (r === k) c++;
        w[k] *= Math.pow(0.55, c);
      }
      let kind = R.weighted(Object.keys(w), (k) => w[k]) || 'rest';

      // Build the intention.
      let it = null;
      if (MOVES.has(kind)) it = this._move(kind, here, interests, t);
      if (!it && kind !== 'rest' && kind !== 'look' && kind !== 'fidget') kind = R() < 0.5 ? 'rest' : 'look';
      if (it) return this._out(it, t, here);
      if (kind === 'look') {
        const look = this._lookTarget(here, interests, t);
        return this._out({ kind: 'look', target: look.target, duration: clamp(R.logNormal(1.3, 0.45), 0.45, 4.5), reason: look.reason }, t, here);
      }
      if (kind === 'fidget') {
        const f = this._fidget();
        if (f) return this._out({ kind: 'fidget', action: f.name, params: f.params ? { ...f.params } : {}, trick: !!f.trick, duration: f.duration ?? 1, rand: R() }, t, here);
      }
      const median = lerp(1.5, 4.2, T.patience) * (this.lingerNext ? 1.7 : 1);
      const duration = clamp(R.logNormal(median, 0.5), 0.6, 14);
      return this._out({ kind: 'rest', duration, style: duration > 5 && R() < 0.5 ? 'deep' : R() < 0.35 ? 'shift' : 'still' }, t, here);
    }

    _attend(i, t) {
      if (i.key) this.attended.set(i.key, t);
      if (i.ref) this.attended.set(i.ref.key, t);
    }

    _lookTarget(here, interests, t) {
      const R = this.rand;
      if (interests.length && R() < 0.7) {
        const i = R.weighted(interests, (x) => x.sal);
        this._attend(i, t);
        return { target: { x: i.x, y: i.y }, reason: 'interest:' + i.kind };
      }
      // Something in the environment: a solid's corner or centre, or a far place.
      const G = this.nav.G;
      const feats = G.solids.map((s) => ({ x: (s.x1 + s.x2) / 2, y: s.y1, key: 'solid:' + s.id }));
      for (const p of this.places()) if (R() < 0.2) feats.push({ x: p.x, y: p.y - this.nav.abilities.bodyH * 0.5, key: p.key });
      if (!feats.length) feats.push({ x: here.x + (R() < 0.5 ? -1 : 1) * this.nav.abilities.bodyW * 4, y: here.y - this.nav.abilities.bodyH, key: 'air' });
      const f = R.weighted(feats, (p) => this._novelty('look:' + p.key, t) * (0.4 + Math.min(1, hyp(p.x - here.x, p.y - here.y) / (this.nav.abilities.bodyW * 4))));
      this._visit('look:' + f.key, t);
      return { target: { x: f.x, y: f.y }, reason: 'scenery' };
    }

    _fidget() {
      const R = this.rand;
      const T = this.temper;
      const recent = this.fidgetLog.slice(-5);
      const f = R.weighted(this.fidgets, (x) => {
        let c = 0;
        for (const r of recent) if (r === x.name) c++;
        return (x.weight ?? 1) * (x.trick ? lerp(0.2, 1.6, T.playfulness) * lerp(0.6, 1.3, T.boldness) : 1) * Math.pow(0.4, c);
      });
      if (f) {
        this.fidgetLog.push(f.name);
        if (this.fidgetLog.length > 12) this.fidgetLog.shift();
      }
      return f;
    }

    _move(kind, here, interests, t) {
      const nav = this.nav;
      const ab = nav.abilities;
      const R = this.rand;
      const T = this.temper;
      const reach = nav.reachable(here);
      const all = this.places().filter((p) => reach.has(p.surface.id) && hyp(p.x - here.x, p.y - here.y) > ab.bodyW * 1.1);
      let target = null;
      let reason = kind;
      if (kind === 'return') {
        const h = nav.locate(this.home.x, this.home.y);
        if (h && reach.has(h.surface.id)) target = { x: h.x, y: h.y, s: h.s, surface: h.surface, key: 'home' };
        reason = 'home';
      } else {
        if (!all.length) return null;
        const maxD = Math.max(...all.map((p) => hyp(p.x - here.x, p.y - here.y)));
        const range = lerp(3, 7, T.energy) * ab.bodyW;
        const highest = Math.max(1, ...all.map((p) => p.high));
        let pull = null;
        if (kind === 'go' && this.approach) pull = this.approach;
        else if (kind === 'go' && interests.length && R() < lerp(0.3, 0.8, T.sociability)) pull = R.weighted(interests, (i) => i.sal);
        this.approach = null;
        const score = (p) => {
          const d = hyp(p.x - here.x, p.y - here.y);
          const nov = this._novelty(p.key, t);
          if (pull) {
            // Approach the interest, but stop politely short of it, on our side.
            const side = Math.sign(here.x - pull.x) || 1;
            const want = pull.x + side * ab.bodyW * 1.2;
            return Math.exp(-Math.abs(p.x - want) / (ab.bodyW * 1.5)) * Math.exp(-Math.max(0, pull.y - p.y) / (ab.bodyH * 6)) * (0.5 + nov);
          }
          if (kind === 'go') return Math.exp(-d / range) * nov * nov;
          if (kind === 'explore') return Math.pow(d / maxD, 0.8) * nov * nov * nov;
          if (kind === 'perch') return Math.pow(p.high / highest, 2) * nov * nov * (p.high > ab.bodyH * 0.5 ? 1 : 0.05);
          return nov;
        };
        if (pull) reason = 'interest:' + pull.kind;
        const pool = all.slice();
        for (let tries = 0; tries < 6 && pool.length; tries++) {
          const p = R.weighted(pool, score);
          if (!p) break;
          const path = nav.path(here, { x: p.x, y: p.y, surface: p.surface, s: p.s });
          if (path) {
            target = p;
            target.path = path;
            if (pull) this._attend(pull, t);
            break;
          }
          pool.splice(pool.indexOf(p), 1);
        }
      }
      if (!target) return null;
      const path = target.path || nav.path(here, { x: target.x, y: target.y, surface: target.surface, s: target.s });
      if (!path) return null;
      const jumps = path.some((m) => m.type === 'jump');
      const style = R.weighted(['amble', 'brisk', 'bold'], (s) => (s === 'amble' ? 1.2 - T.energy : s === 'brisk' ? 0.3 + T.energy : jumps ? T.boldness : T.boldness * 0.3));
      this._visit(target.key, t);
      this.lingerNext = kind === 'perch';
      return {
        kind,
        target: { x: target.x, y: target.y, surface: target.surface },
        path,
        style,
        settleBefore: clamp(R.logNormal(0.32, 0.4), 0.12, 1.1),
        settleAfter: clamp(R.logNormal(0.42, 0.4), 0.15, 1.3),
        reason,
      };
    }

    _out(it, t, here) {
      if (!MOVES.has(it.kind)) this.lingerNext = it.kind === 'rest' ? false : this.lingerNext;
      this.prev = it.kind;
      this.kinds.push(it.kind);
      if (this.kinds.length > 12) this.kinds.shift();
      if (here && it.kind === 'rest') this._visit(this.places().reduce((b, p) => (!b || hyp(p.x - here.x, p.y - here.y) < hyp(b.x - here.x, b.y - here.y) ? p : b), null)?.key ?? 'none', t);
      it.at = t;
      it.seq = this.history.length ? this.history[this.history.length - 1].seq + 1 : 0;
      this.history.push(it);
      if (this.history.length > 60) this.history.shift();
      return it;
    }
  }
  let ikey = 0;
  function normInterest(i) {
    return { x: i.x, y: i.y, kind: i.kind || 'point', weight: i.weight ?? 1, key: i.key ?? i.kind + ':' + ikey++ };
  }

  const OrbitNav = {
    build: (env, abilities) => new Nav(env, abilities),
    idle: (nav, opts) => new IdlePlanner(nav, opts),
    ballistic,
    rng,
    TEMPERAMENTS,
    Nav,
    IdlePlanner,
    version: '1.0',
  };
  global.OrbitNav = OrbitNav;
  if (typeof module !== 'undefined' && module.exports) module.exports = OrbitNav;
})(typeof window !== 'undefined' ? window : globalThis);
