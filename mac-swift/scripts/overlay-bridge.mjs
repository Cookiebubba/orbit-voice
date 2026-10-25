// Developer use only: Orbit's bridge (src/server.js) headless for OverlayDemo, with a throwaway
// profile (ORBIT_PROFILE_DIR, required) on PORT, printing one line like the sidecar's `ready`:
// {"t":"ready","base":...,"auth":{"main","orb","qubit","buddy","mouse"}} (per-launch sign-in links;
// no keys). `node src/server.js` would use the repo folder as its profile and print only the main link.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = process.env.ORBIT_PROFILE_DIR;
if (!dir) {
  console.error('ORBIT_PROFILE_DIR is required (a throwaway folder).');
  process.exit(2);
}
const { authUrl, startServer } = await import(pathToFileURL(path.join(root, 'src', 'server.js')).href);
try {
  const base = await startServer({ configDir: dir });
  const auth = Object.fromEntries(['main', 'orb', 'qubit', 'buddy', 'mouse'].map((v) => [v, authUrl(v)]));
  console.log(JSON.stringify({ t: 'ready', base, auth }));
} catch (e) {
  console.log(JSON.stringify({ t: 'error', message: String(e?.message || e), code: e?.code || null }));
  process.exit(1);
}
