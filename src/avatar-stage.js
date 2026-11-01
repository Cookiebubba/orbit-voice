// Optional protocol-1 geometry. Kept separate from session/request validation and voice state.
export const STAGE_CAPABILITY = 'avatar.stage.v1';
export const STAGE_FRESH_MS = 2000;
export const STAGE_BYTES = 64 * 1024;
const safeId = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(v);
const finite = (v, max = 1e7) => Number.isFinite(v) && Math.abs(v) <= max;
const positive = (v, max) => finite(v, max) && v > 0;

/** Return a fresh, allowlisted value, or null. Bad geometry never rejects valid session context. */
export function validateStage(value, instanceId) {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > STAGE_BYTES) return null;
    if (!value || value.schema !== 1 || value.instanceId !== instanceId || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.available !== 'boolean') return null;
    const base = { schema: 1, instanceId, revision: value.revision, available: value.available, frame: null };
    if (!value.available) return value.frame === null ? base : null;
    const f = value.frame, w = f?.window, v = f?.viewport;
    if (!w || typeof w.handle !== 'string' || !/^[1-9][0-9]{0,15}$/.test(w.handle) || !Number.isSafeInteger(Number(w.handle)) || !Number.isSafeInteger(w.pid) || w.pid <= 0 || !safeId(w.epoch)) return null;
    if (!v || !positive(v.width, 32768) || !positive(v.height, 32768) || !positive(v.scaleFactor, 16) || !finite(v.physicalOrigin?.x) || !finite(v.physicalOrigin?.y)) return null;
    if (typeof f.suspended !== 'boolean' || !Array.isArray(f.surfaces) || f.surfaces.length > 96 || !Array.isArray(f.exclusions) || f.exclusions.length > 32) return null;
    const rect = (r) => r && [r.x, r.y, r.w, r.h].every((n) => finite(n, 32768)) && r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= v.width + 0.01 && r.y + r.h <= v.height + 0.01 ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
    const ids = new Set(), surfaces = [];
    for (const s of f.surfaces) {
      const r = rect(s?.rect);
      if (!safeId(s?.id) || ids.has(s.id) || !['solid', 'oneWay'].includes(s.kind) || !r) return null;
      ids.add(s.id); surfaces.push({ id: s.id, kind: s.kind, rect: r });
    }
    const exclusions = f.exclusions.map(rect);
    if (exclusions.some((r) => !r) || f.preferredSurfaceId != null && !ids.has(f.preferredSurfaceId)) return null;
    base.frame = { window: { handle: w.handle, pid: w.pid, epoch: w.epoch }, viewport: { width: v.width, height: v.height, scaleFactor: v.scaleFactor, physicalOrigin: { x: v.physicalOrigin.x, y: v.physicalOrigin.y } }, suspended: f.suspended, surfaces, exclusions, ...(f.preferredSurfaceId != null ? { preferredSurfaceId: f.preferredSurfaceId } : {}) };
    return base;
  } catch { return null; }
}

/** Native client bounds are physical pixels, not the decorated outer window. */
export function stageMatchesNative(stage, native, { origin = true } = {}) {
  const f = stage?.frame, v = f?.viewport, c = native?.client;
  return !!(f && c && native.hwnd === Number(f.window.handle) && native.pid === f.window.pid &&
    [c.x, c.y, c.w, c.h, native.dpi].every(Number.isFinite) && c.w > 0 && c.h > 0 &&
    Math.abs(c.w - v.width * v.scaleFactor) <= 2 && Math.abs(c.h - v.height * v.scaleFactor) <= 2 &&
    Math.abs(native.dpi / 96 - v.scaleFactor) < 0.02 &&
    (!origin || Math.abs(c.x - v.physicalOrigin.x) <= 2 && Math.abs(c.y - v.physicalOrigin.y) <= 2));
}
