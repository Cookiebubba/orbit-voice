// Orbit Native's pipe keeper: src/anywhere/keeper-core.js under the sidecar's Node (electron/keeper.mjs
// is the same thing under Electron). Started by the core with its settings file; quits with the app it
// keeps.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = process.env.ORBIT_CORE_DIR ? path.resolve(process.env.ORBIT_CORE_DIR) : path.resolve(HERE, '..', '..');
try {
  const { readKeeperConfig, runKeeper } = await import(pathToFileURL(path.join(CORE, 'src', 'anywhere', 'keeper-core.js')).href);
  process.exit(await runKeeper(await readKeeperConfig()));
} catch {
  process.exit(2);
}
