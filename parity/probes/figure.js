// Probe (avatar.eval, and the driver's state for every avatar): where the avatar is drawn in his
// window (its px) and what he stands on: 'air' (held, flying, mid-jump), 'box' (Claude's prompt box)
// or 'floor' (his strip's floor, the window's bottom edge, the Dock's top). Qubit only (the pixel
// buddy's page exposes nothing without ?debug=1): standingOn is null for him.
// A probe is one JS expression; its value (or what its promise resolves to) is the result.
(() => {
  const Q = window.__qubit;
  if (Q && Q.q) {
    const q = Q.q;
    const th = Q.throw;
    const air = !!(q.air || (th && (th.held || th.flying)) || (Q.press && Q.press.dragging));
    let standingOn = air ? 'air' : 'floor';
    let solid = null;
    if (!air && q.sy > 0.5) {
      // Resting on a solid's top: which one (the engine's solids: { id, L, R, T } in his world units).
      const half = q.side / 2;
      const s = (q.solids || []).find((o) => Math.abs(o.T - q.sy) < 1.5 && q.cx >= o.L - half && q.cx <= o.R + half);
      solid = s ? s.id : null;
      standingOn = !s || s.id === 'box' ? 'box' : 'floor'; // ('ledge': his strip's floor, seen from the lifted window)
    }
    const x = q._rx ?? q.cx;
    const y = q._ry ?? q.ground - q.cy;
    const r = q.side / 2;
    return {
      kind: 'qubit',
      standingOn,
      solid,
      asleep: q.mode === 'asleep',
      mode: q.mode,
      stage: Q.frame, // 'strip' | 'area' (lifted)
      rect: { x: Math.round(x - r), y: Math.round(y - r), w: Math.round(2 * r), h: Math.round(2 * r) },
      box: Q.state && Q.state.box ? Q.state.box : null,
    };
  }
  if (document.querySelector('canvas')) return { kind: 'buddy', standingOn: null, asleep: null };
  return null;
})()
