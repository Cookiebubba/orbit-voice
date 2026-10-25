// The parity suite's stand-in Claude window: the macOS port's fake Claude page
// (test/e2e/mac-fake-claude.html: Claude's page structure, an editor with its own model, cards, the
// model picker) in a Chromium window like the real Claude app's, so both Orbit builds find it through
// the accessibility API exactly as they'd find Claude. Never the real Claude app.
//
// Started by the runner with the repo's Electron: `Electron.app --args parity/fixtures/standin`.
// A control port (127.0.0.1:$PARITY_STANDIN_PORT, token $PARITY_STANDIN_TOKEN) lets the runner read
// and set the page's state:
//   GET  /state            window.fake.state() plus the window's frame and the prompt box's rect (screen points)
//   POST /set   {patch}    window.fake.set(patch)
//   POST /type  {text}     type into the prompt as the user would
//   POST /move  {x,y,w,h}  move/resize the window
//   POST /quit
const { app, BrowserWindow, screen } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = [path.join(ROOT, 'test', 'e2e', 'mac-fake-claude.html'), path.join(__dirname, 'mac-fake-claude.html')].find((f) => fs.existsSync(f));
const PORT = Number(process.env.PARITY_STANDIN_PORT || 0);
const TOKEN = String(process.env.PARITY_STANDIN_TOKEN || '');
const GEOM = (() => {
  try {
    return JSON.parse(process.env.PARITY_STANDIN_FRAME || 'null');
  } catch {
    return null;
  }
})();

app.setName('Claude');
app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  const area = screen.getPrimaryDisplay().workArea;
  const f = GEOM || { x: area.x + 160, y: area.y + 80, w: 980, h: 680 };
  const win = new BrowserWindow({ x: f.x, y: f.y, width: f.w, height: f.h, title: 'Claude', show: true, webPreferences: { contextIsolation: true, sandbox: true } });
  if (!PAGE) {
    console.error('stand-in: mac-fake-claude.html not found');
    return app.exit(2);
  }
  await win.loadFile(PAGE);
  const page = (js) => win.webContents.executeJavaScript(js);
  const promptRect = () =>
    page(`(() => { const r = document.getElementById('prompt').closest('#composer').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);

  if (!PORT) return;
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-standin-token'] !== TOKEN || !TOKEN) return send(403, { error: 'forbidden' });
    let body = '';
    for await (const c of req) body += c;
    let j = {};
    try {
      j = body ? JSON.parse(body) : {};
    } catch {}
    try {
      if (req.method === 'GET' && req.url === '/state') {
        const b = win.getBounds();
        const c = win.getContentBounds();
        const r = await promptRect();
        return send(200, { pid: process.pid, state: await page('window.fake.state()'), frame: { x: b.x, y: b.y, w: b.width, h: b.height }, content: { x: c.x, y: c.y, w: c.width, h: c.height }, composer: { x: c.x + r.x, y: c.y + r.y, w: r.w, h: r.h }, focused: win.isFocused(), minimized: win.isMinimized() });
      }
      if (req.method === 'POST' && req.url === '/set') return send(200, { ok: await page(`window.fake.set(${JSON.stringify(j.patch || {})})`) });
      if (req.method === 'POST' && req.url === '/type') return send(200, { model: await page(`window.fake.typeAsUser(${JSON.stringify(String(j.text || ''))})`) });
      if (req.method === 'POST' && req.url === '/move') {
        win.setBounds({ x: Math.round(j.x), y: Math.round(j.y), width: Math.round(j.w), height: Math.round(j.h) });
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/quit') {
        send(200, { ok: true });
        return setTimeout(() => app.quit(), 50);
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: String(e?.message || e) });
    }
  });
  server.listen(PORT, '127.0.0.1');
});
