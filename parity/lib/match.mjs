// The parity suite's matchers (parity/PROTOCOL.md "Matchers"): dotted paths into a value, literals
// compared deeply, operator objects for everything else, and ${saved} values from earlier steps.
// The Swift runner (mac-swift/Sources/OrbitKit/ParityMatch.swift) implements the same rules; the
// shared cases in parity/test/match-cases.json keep the two in step.

/** A dotted path into a value: "avatars.0.frame.w". Missing → undefined. */
export function at(value, path) {
  if (path === '' || path == null) return value;
  let cur = value;
  for (const part of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(part) ? cur[Number(part)] : cur[part];
  }
  return cur;
}

/** Replaces "${name}" (a whole string) with the saved value, and inside strings with its text. */
export function interpolate(x, vars = {}) {
  if (typeof x === 'string') {
    const whole = x.match(/^\$\{([\w.]+)\}$/);
    if (whole) return at(vars, whole[1]);
    return x.replace(/\$\{([\w.]+)\}/g, (_, k) => {
      const v = at(vars, k);
      return v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(x)) return x.map((v) => interpolate(v, vars));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, interpolate(v, vars)]));
  return x;
}

export function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

const isOp = (e) => e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).length > 0 && Object.keys(e).every((k) => k.startsWith('$'));
const isRect = (r) => r && typeof r === 'object' && ['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number');

/**
 * Does `actual` match `expected`? Returns null when it does, else a short reason (with the path).
 * An object of plain keys is a set of path → expectation pairs (each path into `actual`).
 */
export function match(actual, expected, vars = {}, where = '') {
  const exp = interpolate(expected, vars);
  return matchValue(actual, exp, vars, where);
}

function matchValue(actual, exp, vars, where) {
  if (isOp(exp)) return matchOps(actual, exp, vars, where);
  if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
    if (actual === undefined || actual === null || typeof actual !== 'object') {
      // Every key optional-absent? Then a missing value passes.
      const allAbsent = Object.values(exp).every((e) => isOp(e) && e.$absent === true);
      return allAbsent ? null : `${where || '(value)'}: expected an object, got ${show(actual)}`;
    }
    for (const [path, e] of Object.entries(exp)) {
      const r = matchValue(at(actual, path), e, vars, where ? `${where}.${path}` : path);
      if (r) return r;
    }
    return null;
  }
  return deepEqual(actual, exp) ? null : `${where || '(value)'}: expected ${show(exp)}, got ${show(actual)}`;
}

function matchOps(a, ops, vars, where) {
  const w = where || '(value)';
  for (const [op, arg] of Object.entries(ops)) {
    switch (op) {
      case '$type':
        if (typeOf(a) !== arg && !(arg === 'number' && typeof a === 'number')) return `${w}: expected a ${arg}, got ${show(a)}`;
        break;
      case '$gt':
        if (!(typeof a === 'number' && a > arg)) return `${w}: expected > ${arg}, got ${show(a)}`;
        break;
      case '$gte':
        if (!(typeof a === 'number' && a >= arg)) return `${w}: expected >= ${arg}, got ${show(a)}`;
        break;
      case '$lt':
        if (!(typeof a === 'number' && a < arg)) return `${w}: expected < ${arg}, got ${show(a)}`;
        break;
      case '$lte':
        if (!(typeof a === 'number' && a <= arg)) return `${w}: expected <= ${arg}, got ${show(a)}`;
        break;
      case '$near': {
        const tol = ops.$tol ?? 0.5;
        if (!(typeof a === 'number' && Math.abs(a - arg) <= tol)) return `${w}: expected ${arg} ± ${tol}, got ${show(a)}`;
        break;
      }
      case '$tol':
        break;
      case '$in':
        if (!arg.some((x) => deepEqual(a, x))) return `${w}: expected one of ${show(arg)}, got ${show(a)}`;
        break;
      case '$match':
        if (!(typeof a === 'string' && new RegExp(arg).test(a))) return `${w}: expected to match /${arg}/, got ${show(a)}`;
        break;
      case '$contains':
        if (typeof a === 'string' ? !(typeof arg === 'string' && a.includes(arg)) : !(Array.isArray(a) && a.some((x) => deepEqual(x, arg) || (arg && typeof arg === 'object' && !Array.isArray(arg) && matchValue(x, arg, vars, '') === null)))) return `${w}: expected to contain ${show(arg)}, got ${show(a)}`;
        break;
      case '$len': {
        const n = a == null ? undefined : typeof a === 'string' || Array.isArray(a) ? a.length : typeof a === 'object' ? Object.keys(a).length : undefined;
        if (n === undefined) return `${w}: expected something with a length, got ${show(a)}`;
        const r = typeof arg === 'number' ? (n === arg ? null : `${w}: expected length ${arg}, got ${n}`) : matchValue(n, arg, vars, `${w}.length`);
        if (r) return r;
        break;
      }
      case '$every':
        if (!Array.isArray(a)) return `${w}: expected an array, got ${show(a)}`;
        for (let i = 0; i < a.length; i++) {
          const r = matchValue(a[i], arg, vars, `${w}.${i}`);
          if (r) return r;
        }
        break;
      case '$count': {
        if (!Array.isArray(a)) return `${w}: expected an array, got ${show(a)}`;
        const n = a.filter((x) => matchValue(x, arg.where ?? {}, vars, '') === null).length;
        const r = typeof arg.is === 'number' ? (n === arg.is ? null : `${w}: expected ${arg.is} matching, got ${n}`) : matchValue(n, arg.is, vars, `${w}.count`);
        if (r) return r;
        break;
      }
      case '$some':
        if (!Array.isArray(a) || !a.some((x) => matchValue(x, arg, vars, '') === null)) return `${w}: expected some element to match ${show(arg)}, got ${show(a)}`;
        break;
      case '$inside': {
        if (!isRect(a)) return `${w}: expected a rect, got ${show(a)}`;
        if (!isRect(arg)) return `${w}: $inside needs a rect, got ${show(arg)}`;
        const s = ops.$slack ?? 1;
        if (!(a.x >= arg.x - s && a.y >= arg.y - s && a.x + a.w <= arg.x + arg.w + s && a.y + a.h <= arg.y + arg.h + s)) return `${w}: ${show(a)} is not inside ${show(arg)}`;
        break;
      }
      case '$slack':
        break;
      case '$not':
        if (matchValue(a, arg, vars, w) === null) return `${w}: expected not ${show(arg)}, got ${show(a)}`;
        break;
      case '$absent':
        if (arg === true ? a !== undefined && a !== null : a === undefined) return `${w}: expected ${arg ? 'absent' : 'present'}, got ${show(a)}`;
        break;
      case '$eq':
        if (!deepEqual(a, arg)) return `${w}: expected ${show(arg)}, got ${show(a)}`;
        break;
      default:
        return `${w}: unknown matcher ${op}`;
    }
  }
  return null;
}

export function show(v) {
  if (v === undefined) return 'undefined';
  const s = JSON.stringify(v);
  return s && s.length > 160 ? `${s.slice(0, 157)}...` : s;
}
