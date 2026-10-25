// The JS stand-in for the Claude desktop driver (test/e2e/fake-desktop.mjs), for the parity suite:
// both apps load it through ORBIT_FAKE_DESKTOP (Electron in-process, Orbit Native in its sidecar), so
// its record lives in another process than the runner. Every call is written to
// $PARITY_RECORD_DIR/fake-desktop.json, which the runner's `fake` step reads. Its starting state
// (sidebar sessions, a pending permission card, the open session...) can be set with
// $PARITY_FAKE_DESKTOP_STATE (JSON merged into the fake's model).
import fs from 'node:fs';
import path from 'node:path';
import fake, { desktopState } from '../../test/e2e/fake-desktop.mjs';

const recordFile = process.env.PARITY_RECORD_DIR ? path.join(process.env.PARITY_RECORD_DIR, 'fake-desktop.json') : '';
const st = desktopState();
try {
  Object.assign(st, JSON.parse(process.env.PARITY_FAKE_DESKTOP_STATE || '{}'));
} catch {}

function save() {
  if (!recordFile) return;
  const { calls, sends, windows, sidebar, answers } = st;
  try {
    fs.writeFileSync(recordFile + '.tmp', JSON.stringify({ calls: calls.map((c) => ({ mode: c.mode, at: c.at })), sends, windows, sidebar, answers: answers || [] }));
    fs.renameSync(recordFile + '.tmp', recordFile);
  } catch {}
}
save();

export default {
  async run(mode, args) {
    const r = await fake.run(mode, args);
    save();
    return r;
  },
  windowHelper: fake.windowHelper,
  get focusHelper() {
    return fake.focusHelper;
  },
};
