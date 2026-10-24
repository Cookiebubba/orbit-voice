// The pipe keeper under plain Node (tests and development). The packaged app runs the same code as
// "Orbit.exe --orbit-keeper" (electron/keeper.mjs). See keeper-core.js.
import { readKeeperConfig, runKeeper } from './keeper-core.js';

try {
  const cfg = await readKeeperConfig();
  const code = await runKeeper(cfg);
  process.exit(code);
} catch {
  process.exit(2);
}
