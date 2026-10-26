// Orbit's pipe keeper, as "Orbit.exe --orbit-keeper" (see src/anywhere/keeper-core.js): no windows,
// no single-instance lock, no GPU. It reads its settings from the file Orbit names (then deletes it), holds the
// approved app under a private DevTools pipe, and quits when that app quits.
import { app } from 'electron';
import { readKeeperConfig, runKeeper } from '../src/anywhere/keeper-core.js';

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // it never has windows

try {
  const cfg = await readKeeperConfig();
  const code = await runKeeper(cfg);
  app.exit(code);
} catch {
  app.exit(2);
}
