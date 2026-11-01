// Transient spatial classification, never a setting or an execution/voice recipient.
const contains = (r, p, pad = 0) => !!r && p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
export function sweptRegion(a, b, r) {
  if (!a || !b || !r) return false;
  let lo = 0, hi = 1;
  for (const [k, size] of [['x', 'w'], ['y', 'h']]) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-8) { if (a[k] < r[k] || a[k] > r[k] + r[size]) return false; continue; }
    const t1 = (r[k] - a[k]) / d, t2 = (r[k] + r[size] - a[k]) / d;
    lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
    if (lo > hi) return false;
  }
  return true;
}
export function createRoamClassifier({ hysteresis = 5 } = {}) {
  let domain = 'desktop', key = '', region = null, previous = null, armed = true;
  return {
    update({ region: next, eligible, identity = '', body, pointer = null, initialize = false }) {
      const nextKey = JSON.stringify([next, !!eligible, identity]);
      const changed = key !== nextKey;
      key = nextKey; region = eligible ? next : null;
      const p = body; // pointer may jump ahead of the critically damped body; classify its actual sweep
      if (!region) { domain = 'desktop'; armed = true; previous = { ...p }; return domain; }
      const ex = body.ex || 0, ey = body.ey || 0;
      const inner = { x: region.x + ex, y: region.y + ey, w: region.w - 2 * ex, h: region.h - 2 * ey };
      const inside = inner.w > 0 && inner.h > 0 && contains(inner, body, -hysteresis) && (!pointer || contains(region, pointer, -hysteresis));
      if (initialize) { domain = inside ? 'bro' : 'desktop'; armed = !inside; }
      else if (changed && domain === 'desktop' && contains(region, body, hysteresis)) armed = false;
      if (!contains(region, body, hysteresis) && (!pointer || !contains(region, pointer, hysteresis))) { domain = 'desktop'; armed = true; }
      else if (!changed && armed && previous && Math.hypot(p.x - previous.x, p.y - previous.y) > 0.01 && sweptRegion(previous, p, region) && inside) { domain = 'bro'; armed = false; }
      previous = { ...p };
      return domain;
    },
    get domain() { return domain; },
  };
}
