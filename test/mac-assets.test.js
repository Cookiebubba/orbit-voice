// Orbit Native's icons, from the repo (mac-swift/scripts/build-app.sh copies them into the app): the
// app icon a real .icns, and the menu-bar template images. Read from the files only.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Orbit Native: icon is a real .icns, and the menu-bar template images exist', () => {
  const build = fs.readFileSync(path.join(ROOT, 'mac-swift', 'scripts', 'build-app.sh'), 'utf8');
  assert.match(build, /build\/icon\.icns/);
  assert.match(build, /assets\/trayTemplate\.png" "\$ROOT\/assets\/trayTemplate@2x\.png/);
  const icns = fs.readFileSync(path.join(ROOT, 'build', 'icon.icns'));
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length, 'length header matches');
  const types = [];
  for (let o = 8; o < icns.length; o += icns.readUInt32BE(o + 4)) {
    types.push(icns.toString('ascii', o, o + 4));
    assert.equal(icns.toString('ascii', o + 9, o + 12), 'PNG', `${types.at(-1)} holds a PNG`);
  }
  for (const t of ['icp4', 'icp5', 'ic07', 'ic08', 'ic09', 'ic10']) assert.ok(types.includes(t), t);
  for (const f of ['trayTemplate.png', 'trayTemplate@2x.png']) {
    const png = fs.readFileSync(path.join(ROOT, 'assets', f));
    assert.equal(png.toString('ascii', 1, 4), 'PNG', f);
    assert.equal(png.readUInt32BE(16), f.includes('@2x') ? 32 : 16, `${f} width`);
  }
});

test('the Windows build has no macOS target left (Orbit for Mac is Orbit Native)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.build.mac, undefined);
  assert.equal(pkg.build.dmg, undefined);
  assert.equal(pkg.scripts['dist:mac'], undefined);
  assert.ok(!pkg.build.asarUnpack.some((p) => p.includes('darwin')));
  assert.deepEqual(pkg.build.win.target, [{ target: 'nsis', arch: ['x64'] }]);
});
