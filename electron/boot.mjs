// Orbit's entry: the pipe keeper ("--orbit-keeper", started by Orbit itself; see electron/keeper.mjs)
// or Orbit. Top-level await holds Electron's ready event until the chosen module has loaded.
if (process.argv.includes('--orbit-keeper')) await import('./keeper.mjs');
else await import('./main.js');
