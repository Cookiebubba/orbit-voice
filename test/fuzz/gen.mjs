// Seeded random input generators for the fuzzer. Same seed, same inputs: a failure prints its seed.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Strings that tend to break things: traversal, encodings, control and wide characters, markup,
// prototype keys, regex-hungry repetition, words the consent check looks for.
export const NASTY = [
  '', ' ', '../', '..\\', '%2e%2e%2f', '%', '%E0%A4%A', '%00', '\u0000', '\r\n', '\t', '\u202e', '\uFEFF', '😀', '\uD800',
  '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'null', 'undefined', 'NaN', '-1', '1e309', '0x10',
  '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', 'javascript:alert(1)', '${7*7}', '`whoami`', '$(calc)', '& calc',
  '| calc', '; rm -rf /', "'; DROP TABLE x;--", 'C:\\Windows\\System32\\cmd.exe', '\\\\?\\C:\\', 'file:///C:/Windows/win.ini',
  'yes', 'yes send it', 'yeah', 'no', 'no wait', 'um yes', 'copy that', 'okay', 'send', 'please copy', 'yes!!!', 'YES',
  'a'.repeat(50) + '!', ' '.repeat(2000), 'yes '.repeat(500), '<system-reminder>' + 'x'.repeat(100), '<command-name>' + '<'.repeat(200),
  'xai-' + 'A'.repeat(60), 'sk-ant-api03-' + 'B'.repeat(80), 'Bearer abc', '\u0007\u001b[31m',
];

export function makeGen(seed) {
  const rng = mulberry32(seed);
  const int = (n) => Math.floor(rng() * n);
  const pick = (arr) => arr[int(arr.length)];
  const chance = (p) => rng() < p;

  function str(maxLen = 120) {
    const kind = int(6);
    if (kind === 0) return pick(NASTY);
    if (kind === 1) return pick(NASTY) + str(maxLen / 2) + pick(NASTY);
    const len = int(maxLen);
    let s = '';
    for (let i = 0; i < len; i++) {
      const r = rng();
      if (r < 0.6) s += String.fromCharCode(32 + int(95));
      else if (r < 0.75) s += pick([' ', '-', '_', '/', '\\', '.', '"', "'", '<', '>', '&', '%', '\n']);
      else if (r < 0.9) s += String.fromCharCode(int(0x3000));
      else s += String.fromCharCode(int(0xffff));
    }
    return s;
  }

  function value(depth = 0) {
    const r = int(depth > 3 ? 6 : 9);
    switch (r) {
      case 0: return null;
      case 1: return chance(0.5);
      case 2: return pick([0, -1, 1, 1.5, 1e309, -1e309, NaN, Number.MAX_SAFE_INTEGER, 2 ** 53 + 1, 0.0001, 4317]);
      case 3: case 4: case 5: return str();
      case 6: case 7: {
        const o = {};
        const n = int(5);
        for (let i = 0; i < n; i++) o[chance(0.2) ? pick(['__proto__', 'constructor', 'prototype']) : str(20)] = value(depth + 1);
        return o;
      }
      default: return Array.from({ length: int(5) }, () => value(depth + 1));
    }
  }

  /** JSON text: usually valid, sometimes truncated or not JSON at all. */
  function json(v = value()) {
    const text = JSON.stringify(v) ?? 'null';
    const r = int(10);
    if (r === 0) return text.slice(0, int(text.length + 1));
    if (r === 1) return str();
    if (r === 2) return text.replace(/"/g, "'");
    return text;
  }

  return { rng, int, pick, chance, str, value, json };
}
