// Native-only, fixed-purpose credential lookup. Never import this module into a renderer.
import { execFile } from 'node:child_process';

export function validOpenAIKey(value) {
  if (typeof value !== 'string') return '';
  const key = value.trim();
  return /^sk-[A-Za-z0-9_-]{20,250}$/.test(key) && !/^(?:sk-)?(?:proxy|placeholder|dummy|local|test)(?:[-_]|$)/i.test(key) ? key : '';
}

const REGISTRY_KEYS = Object.freeze({
  user: 'HKCU\\Environment',
  machine: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
});

/** No PATH search, shell, interpolated script, arbitrary variable name or caller-selected command. */
export function readWindowsOpenAIKey(scope, { signal, timeoutMs = 1500, run = execFile } = {}) {
  const registryKey = REGISTRY_KEYS[scope];
  if (!registryKey) return Promise.reject(new Error('System key lookup failed.'));
  return new Promise((resolve, reject) => {
    try {
      run('C:\\Windows\\System32\\reg.exe', ['query', registryKey, '/v', 'OPENAI_API_KEY'], {
        windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 8192, signal,
        // Output is returned only to native memory. Child-process errors can contain stdout: discard them.
        encoding: 'utf8',
      }, (error, stdout) => {
        if (error) {
          if (error.code === 1 && !error.killed && !signal?.aborted) return resolve(null); // missing value
          return reject(new Error('System key lookup failed.'));
        }
        const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const header = scope === 'user' ? 'HKEY_CURRENT_USER\\Environment' : 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
        const match = lines[1]?.match(/^OPENAI_API_KEY[ \t]+REG_(?:SZ|EXPAND_SZ)(?:[ \t]+(.*))?$/);
        // A multiline value or extra output is malformed, not a valid prefix of a credential.
        if (lines.length !== 2 || lines[0].toUpperCase() !== header.toUpperCase() || !match) return reject(new Error('System key lookup failed.'));
        resolve(match[1] || '');
      });
    } catch { reject(new Error('System key lookup failed.')); }
  });
}

/**
 * env and registry are both injectable: tests must supply both, not merely redirect HOME.
 * registry(scope, {signal, timeoutMs}) returns a raw string or null for an absent value.
 * get() is synchronous and native-only; status()/refresh() never return key material.
 */
export function createOpenAICredentials({ env = process.env, registry = readWindowsOpenAIKey, platform = process.platform, timeoutMs = 1500 } = {}) {
  const budget = Number.isFinite(timeoutMs) ? Math.min(5000, Math.max(10, timeoutMs)) : 1500;
  let credential = null;
  let pending = false;
  let error = null;
  let inFlight = null;
  const status = () => ({ available: !!credential, source: credential?.source || null, pending, error });
  const refresh = () => {
    if (inFlight) return inFlight;
    pending = true;
    const controller = new AbortController();
    let timer;
    const lookup = async () => {
      let malformed = false;
      const inherited = typeof env === 'function' ? env() : env?.OPENAI_API_KEY;
      const processKey = validOpenAIKey(inherited);
      if (processKey) return { key: processKey, source: 'process' };
      if (inherited) malformed = true;
      if (platform === 'win32') {
        for (const scope of ['user', 'machine']) {
          const value = await registry(scope, { signal: controller.signal, timeoutMs: budget });
          if (controller.signal.aborted) throw new Error('System key lookup failed.');
          const key = validOpenAIKey(value);
          if (key) return { key, source: scope };
          if (value) malformed = true;
        }
      }
      if (malformed) throw new Error('invalid');
      return null;
    };
    // Bound injected adapters too. Late resolution is never allowed to update this cache.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, budget);
    });
    inFlight = Promise.race([Promise.resolve().then(lookup), deadline])
      .then((next) => { credential = next; error = null; })
      .catch((e) => { credential = null; error = e?.message === 'invalid' ? 'system-invalid' : 'system-read-failed'; })
      .finally(() => { clearTimeout(timer); pending = false; inFlight = null; })
      .then(status);
    return inFlight;
  };
  return Object.freeze({ get: () => credential && { ...credential }, status, refresh });
}
