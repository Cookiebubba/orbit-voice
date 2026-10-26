// Probe (avatar.eval): freezes the avatar's page for 6 s, as a stalled or frozen page is (its timers,
// frames and events all stop: no heartbeat, no hit rect, nothing). It answers at once; the freeze
// starts right after. The shell's own hover poll must keep his last rect meanwhile (main 0edbf9b,
// 346a5bc): a press on him still reaches his page once it runs again.
// A probe is one JS expression; its value (or what its promise resolves to) is the result.
(() => {
  setTimeout(() => {
    const t = Date.now();
    while (Date.now() - t < 6000) {
      // (busy: nothing else on this page runs)
    }
  }, 0);
  return { frozenMs: 6000 };
})()
