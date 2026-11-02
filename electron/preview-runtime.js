import net from 'node:net';
// A conservative conflict check: do not authenticate to, inspect or terminate another Orbit.
// The preview has its own port/profile/lock, but two voice runtimes must not open together.
export function checkStandaloneConflict({ connect = net.createConnection } = {}) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: 4317 });
    let done = false;
    const finish = (busy) => { if (done) return; done = true; socket.destroy(); resolve(busy); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(600, () => finish(true)); // unknown is not permission to create a second voice
  });
}
