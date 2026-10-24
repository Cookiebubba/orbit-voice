// A stand-in "app" for keeper tests: speaks the DevTools pipe framing (fd 3 in, fd 4 out, JSON ended
// by a NUL) and answers every command with { id, result: { echo: method, sessionId } }. Quits on the
// command "App.quit" or when its pipe closes.
const fs = require('node:fs');
const input = fs.createReadStream(null, { fd: 3 });
const output = fs.createWriteStream(null, { fd: 4 });
let buf = '';
input.setEncoding('utf8');
input.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.method === 'App.quit') process.exit(0);
    output.write(`${JSON.stringify({ id: m.id, result: { echo: m.method, sessionId: m.sessionId || null, params: m.params } })}\0`);
  }
});
input.on('end', () => process.exit(0));
input.on('error', () => process.exit(0));
setInterval(() => {}, 1000);
