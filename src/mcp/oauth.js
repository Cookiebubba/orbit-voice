// Signing in to remote MCP servers ("Orbit anywhere", phase 9): OAuth 2.1 with PKCE, as the MCP
// authorization spec has it. Only ever on the user's yes (connect_tool asks first).
//
//   1. The server answers 401 with WWW-Authenticate: Bearer resource_metadata="<url>".
//   2. Orbit reads that (RFC 9728), then the authorization server's metadata (RFC 8414).
//   3. Orbit registers itself as a client (RFC 7591, dynamic registration; a public client).
//   4. The browser opens the server's own sign-in page (PKCE S256, a random state, the resource
//      indicator). The user signs in there; Orbit never sees their password.
//   5. The page sends the browser back to Orbit's bridge (127.0.0.1, /oauth/callback): the code is
//      checked against the state and exchanged for tokens.
//   6. Tokens are kept in an encrypted store (the desktop app: Electron safeStorage, i.e. Windows
//      DPAPI, like the xAI key), keyed by the server; refreshed when they expire. Never logged.
//
// Every URL must be https (127.0.0.1 only for tests), and the token endpoint must belong to the
// authorization server the resource names.

import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const pkcePair = () => {
  const verifier = b64url(crypto.randomBytes(48));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
};

/** resource_metadata="..." from a WWW-Authenticate header. */
export function resourceMetadataUrl(wwwAuthenticate) {
  const m = /resource_metadata="([^"]+)"/i.exec(String(wwwAuthenticate || ''));
  return m ? m[1] : '';
}

const safeUrl = (u, { allowLoopback = false } = {}) => {
  try {
    const x = new URL(u);
    if (x.username || x.password) return null;
    if (x.protocol === 'https:') return x;
    if (allowLoopback && x.protocol === 'http:' && (x.hostname === '127.0.0.1' || x.hostname === 'localhost')) return x;
  } catch {}
  return null;
};

/**
 * `store`: { get(key) -> string|null, set(key, string) } (encrypted by the desktop app).
 * `openExternal(url)`: opens the browser. `redirectUri`: the bridge's /oauth/callback.
 */
export function createOAuth({ fetchImpl = globalThis.fetch, openExternal = async () => {}, redirectUri, store, now = () => Date.now(), allowLoopback = false, waitMs = 5 * 60_000 } = {}) {
  const pending = new Map(); // state -> { resolve, reject, verifier, ... }
  const redirect = () => (typeof redirectUri === 'function' ? redirectUri() : redirectUri);
  const keyFor = (resource) => `mcp-oauth:${new URL(resource).origin}${new URL(resource).pathname}`;
  const getJson = async (url, init) => {
    const res = await fetchImpl(url, { ...init, headers: { accept: 'application/json', ...(init?.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return res.json();
  };
  const read = (resource) => {
    try {
      const v = store.get(keyFor(resource));
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  };
  const write = (resource, v) => store.set(keyFor(resource), JSON.stringify(v));

  async function discover(resource, wwwAuthenticate) {
    const metaUrl = resourceMetadataUrl(wwwAuthenticate) || `${new URL(resource).origin}/.well-known/oauth-protected-resource`;
    if (!safeUrl(metaUrl, { allowLoopback })) throw new Error('The server named an unsafe sign-in address.');
    const rm = await getJson(metaUrl);
    const issuer = Array.isArray(rm?.authorization_servers) ? rm.authorization_servers[0] : '';
    const iss = safeUrl(issuer, { allowLoopback });
    if (!iss) throw new Error('The server named no (safe) sign-in service.');
    const base = issuer.replace(/\/+$/, '');
    let as = null;
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      try {
        as = await getJson(`${iss.origin}${p}${iss.pathname !== '/' ? iss.pathname.replace(/\/+$/, '') : ''}`);
        break;
      } catch {}
    }
    if (!as) as = await getJson(`${base}/.well-known/oauth-authorization-server`);
    for (const k of ['authorization_endpoint', 'token_endpoint']) if (!safeUrl(as?.[k], { allowLoopback })) throw new Error('The sign-in service has an unsafe address.');
    // The endpoints belong to that service (no hand-off to a third party's token endpoint).
    if (new URL(as.token_endpoint).origin !== iss.origin) throw new Error("The sign-in service's token address is on another site.");
    const methods = as.code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes('S256')) throw new Error("The sign-in service doesn't support PKCE.");
    return { issuer: iss.origin, as, resource: rm.resource || resource };
  }

  async function register(as) {
    if (!safeUrl(as.registration_endpoint, { allowLoopback })) throw new Error('The sign-in service does not let new apps register (no dynamic registration).');
    const r = await getJson(as.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Orbit', redirect_uris: [redirect()], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    });
    if (typeof r?.client_id !== 'string' || !r.client_id) throw new Error('The sign-in service did not register Orbit.');
    return r.client_id;
  }

  async function token(as, form) {
    const res = await fetchImpl(as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form).toString() });
    const j = await res.json().catch(() => null);
    if (!res.ok || typeof j?.access_token !== 'string') throw new Error('The sign-in service did not give a token.');
    return j;
  }

  return {
    /**
     * Sign in to `resource` (an MCP server URL). Opens the browser and resolves once the user has
     * signed in (or rejects after `waitMs`). Returns { issuer }.
     */
    async authorize(resource, wwwAuthenticate = '') {
      const d = await discover(resource, wwwAuthenticate);
      const clientId = await register(d.as);
      const { verifier, challenge } = pkcePair();
      const state = b64url(crypto.randomBytes(24));
      const auth = new URL(d.as.authorization_endpoint);
      auth.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect(), code_challenge: challenge, code_challenge_method: 'S256', state, resource: d.resource, ...(d.as.scopes_supported?.length ? {} : {}) }).toString();
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(state);
          reject(new Error('The sign-in was not finished in time.'));
        }, waitMs);
        timer.unref?.();
        pending.set(state, { resolve: (c) => (clearTimeout(timer), resolve(c)), reject: (e) => (clearTimeout(timer), reject(e)) });
        Promise.resolve(openExternal(auth.toString())).catch((e) => pending.get(state)?.reject(e));
      });
      const t = await token(d.as, { grant_type: 'authorization_code', code, redirect_uri: redirect(), client_id: clientId, code_verifier: verifier, resource: d.resource });
      write(resource, { issuer: d.issuer, tokenEndpoint: d.as.token_endpoint, clientId, resource: d.resource, access: t.access_token, refresh: t.refresh_token || '', expiresAt: t.expires_in ? now() + Number(t.expires_in) * 1000 : 0 });
      return { issuer: d.issuer };
    },
    /** The browser came back to /oauth/callback with these query parameters. */
    callback(params) {
      const state = String(params?.state || '');
      const p = pending.get(state);
      if (!p) return { ok: false, error: 'That sign-in was not started by Orbit (or it timed out).' };
      pending.delete(state);
      if (params.error) {
        p.reject(new Error('The sign-in was cancelled or refused.'));
        return { ok: false, error: 'cancelled' };
      }
      if (typeof params.code !== 'string' || !params.code) {
        p.reject(new Error('The sign-in came back without a code.'));
        return { ok: false, error: 'no code' };
      }
      p.resolve(params.code);
      return { ok: true };
    },
    /** The Authorization header for `resource` (refreshing the token if it expired), or {}. */
    async headersFor(resource) {
      const t = read(resource);
      if (!t) return {};
      if (t.expiresAt && now() > t.expiresAt - 30_000 && t.refresh) {
        try {
          const r = await token({ token_endpoint: t.tokenEndpoint }, { grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.clientId, resource: t.resource });
          Object.assign(t, { access: r.access_token, refresh: r.refresh_token || t.refresh, expiresAt: r.expires_in ? now() + Number(r.expires_in) * 1000 : 0 });
          write(resource, t);
        } catch {
          return {};
        }
      }
      return { Authorization: `Bearer ${t.access}` };
    },
    signedIn: (resource) => !!read(resource),
    signOut: (resource) => store.set(keyFor(resource), ''),
    get pendingCount() {
      return pending.size;
    },
  };
}
