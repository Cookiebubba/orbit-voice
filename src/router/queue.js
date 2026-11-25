// Per-session FIFO prompt queue for busy turns.
// Safely holds dictated prompts while a session is working and releases them only when
// the session is genuinely idle (neither working NOR waiting on a permission/question prompt).

const MAX_PROMPT_CHARS = 32_000;

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function clampAgeMs(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 24 * 60 * 60_000);
}

function cloneItem(item) {
  return {
    id: item.id,
    sessionId: item.sessionId,
    prompt: item.prompt,
    meta: item.meta ? { ...item.meta } : null,
    enqueuedAt: item.enqueuedAt,
    expiresAt: item.expiresAt,
  };
}

/**
 * Creates a bounded, expiring per-session prompt queue.
 */
export function createPromptQueue({ maxPerSession = 5, maxAgeMs = 30 * 60_000, now = () => Date.now() } = {}) {
  const cap = clampInt(maxPerSession, 1, 100, 5);
  const ttlMs = clampAgeMs(maxAgeMs, 30 * 60_000);
  const clock = typeof now === 'function' ? now : () => Date.now();

  /** @type {Map<string, Array<{id:string, sessionId:string, prompt:string, meta:object|null, enqueuedAt:number, expiresAt:number}>>} */
  const buckets = new Map();
  let seq = 0;

  function pruneBucket(sessionId, currentMs) {
    const items = buckets.get(sessionId);
    if (!items || !items.length) {
      buckets.delete(sessionId);
      return null;
    }
    const kept = items.filter((item) => currentMs < item.expiresAt);
    if (!kept.length) {
      buckets.delete(sessionId);
      return null;
    }
    if (kept.length !== items.length) {
      buckets.set(sessionId, kept);
      return kept;
    }
    return items;
  }

  function pruneAll(currentMs) {
    for (const sid of [...buckets.keys()]) pruneBucket(sid, currentMs);
  }

  /**
   * Enqueues a prompt for `sessionId`. Rejects cleanly if input is invalid or the session queue is full.
   */
  function enqueue(sessionId, prompt, meta = null) {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    const text = typeof prompt === 'string' ? prompt.trim().slice(0, MAX_PROMPT_CHARS) : '';
    if (!sid || !text) {
      return { ok: false, error: 'invalid_input', id: null, item: null };
    }

    const ts = Number(clock());
    const currentMs = Number.isFinite(ts) ? ts : Date.now();
    const items = pruneBucket(sid, currentMs) || [];

    if (items.length >= cap) {
      return { ok: false, error: 'queue_full', maxPerSession: cap, id: null, item: null };
    }

    seq += 1;
    const item = {
      id: `q_${seq}`,
      sessionId: sid,
      prompt: text,
      meta: meta && typeof meta === 'object' ? { ...meta } : null,
      enqueuedAt: currentMs,
      expiresAt: currentMs + ttlMs,
    };
    items.push(item);
    buckets.set(sid, items);

    const copy = cloneItem(item);
    return {
      ok: true,
      ...copy,
      position: items.length,
      item: copy,
    };
  }

  /**
   * Lists queued items for `sessionId`, or across all sessions when `sessionId` is omitted.
   */
  function list(sessionId = null) {
    const ts = Number(clock());
    const currentMs = Number.isFinite(ts) ? ts : Date.now();

    if (typeof sessionId === 'string' && sessionId.trim()) {
      const items = pruneBucket(sessionId.trim(), currentMs);
      return items ? items.map(cloneItem) : [];
    }

    pruneAll(currentMs);
    const all = [];
    for (const items of buckets.values()) {
      for (const item of items) all.push(cloneItem(item));
    }
    all.sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.id.localeCompare(b.id));
    return all;
  }

  /**
   * Peeks at the next queued item for `sessionId` without removing it.
   */
  function peek(sessionId) {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!sid) return null;
    const ts = Number(clock());
    const currentMs = Number.isFinite(ts) ? ts : Date.now();
    const items = pruneBucket(sid, currentMs);
    return items && items.length ? cloneItem(items[0]) : null;
  }

  /**
   * Cancels a queued item by `id`, by `(sessionId, itemId)`, or clears all items for a `sessionId`.
   */
  function cancel(idOrSessionId, maybeItemId = null) {
    const first = typeof idOrSessionId === 'string' ? idOrSessionId.trim() : '';
    if (!first) return { ok: false, removed: [], count: 0 };

    const ts = Number(clock());
    const currentMs = Number.isFinite(ts) ? ts : Date.now();
    pruneAll(currentMs);

    // Form: cancel(sessionId, itemId)
    if (typeof maybeItemId === 'string' && maybeItemId.trim()) {
      const targetId = maybeItemId.trim();
      const items = buckets.get(first);
      if (!items) return { ok: false, removed: [], count: 0 };
      const idx = items.findIndex((item) => item.id === targetId);
      if (idx < 0) return { ok: false, removed: [], count: 0 };
      const [removed] = items.splice(idx, 1);
      if (!items.length) buckets.delete(first);
      return { ok: true, removed: [cloneItem(removed)], count: 1 };
    }

    // Form: cancel(itemId)
    for (const [sid, items] of buckets.entries()) {
      const idx = items.findIndex((item) => item.id === first);
      if (idx >= 0) {
        const [removed] = items.splice(idx, 1);
        if (!items.length) buckets.delete(sid);
        return { ok: true, removed: [cloneItem(removed)], count: 1 };
      }
    }

    // Form: cancel(sessionId) -> clears that session's queued items
    if (buckets.has(first)) {
      const removed = buckets.get(first).map(cloneItem);
      buckets.delete(first);
      return { ok: true, removed, count: removed.length };
    }

    return { ok: false, removed: [], count: 0 };
  }

  /**
   * Clears all queued prompts across all sessions.
   */
  function clearAll() {
    let cleared = 0;
    for (const items of buckets.values()) cleared += items.length;
    buckets.clear();
    return { cleared };
  }

  /**
   * Dequeues the next prompt for `sessionId` ONLY when the session is neither working NOR waiting.
   * CRITICAL: Always returns `null` if `working === true` OR `waiting === true` so a queued prompt
   * can never accidentally answer a permission or question prompt.
   */
  function takeNextIfReady(sessionId, { working = false, waiting = false } = {}) {
    if (working === true || waiting === true || Boolean(working) || Boolean(waiting)) {
      return null;
    }
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!sid) return null;

    const ts = Number(clock());
    const currentMs = Number.isFinite(ts) ? ts : Date.now();
    const items = pruneBucket(sid, currentMs);
    if (!items || !items.length) return null;

    const next = items.shift();
    if (!items.length) buckets.delete(sid);
    return cloneItem(next);
  }

  return {
    enqueue,
    list,
    peek,
    cancel,
    clearAll,
    takeNextIfReady,
  };
}
