#!/usr/bin/env node
// Builds Orbit Test: a Windows installer that sits next to real Orbit and can't replace it. Everything
// that makes it a different app is an override here; package.json's identity is left alone.
//
//   npm --prefix ui run build && node scripts/build-test.mjs [suffix]
//
// Output: dist/test/Orbit-Test-Setup-<version>.exe and dist/test/win-unpacked. Nothing is published:
// there is no publish config in it at all, so it carries no update feed either.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import builder from 'electron-builder';
import { ORBIT_TEST } from '../electron/identity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = `${pkg.version}-${process.argv[2] || 'settings.3'}`;

if (!fs.existsSync(path.join(ROOT, 'public', 'index.html'))) throw new Error('Build the UI first: npm --prefix ui run build');

const files = await builder.build({
  targets: builder.Platform.WINDOWS.createTarget(),
  publish: 'never',
  config: {
    appId: ORBIT_TEST.appId,
    productName: ORBIT_TEST.name,
    // The packaged package.json: electron/identity.js reads orbitTestBuild from it.
    extraMetadata: { version, productName: ORBIT_TEST.name, orbitTestBuild: true },
    directories: { output: 'dist/test', buildResources: 'build' },
    publish: null, // no app-update.yml, so there is no feed to follow even if the updater ever ran
    win: { artifactName: 'Orbit-Test-Setup-${version}.${ext}' },
    nsis: { shortcutName: ORBIT_TEST.name, uninstallDisplayName: `${ORBIT_TEST.name} ${version}` },
  },
});
for (const f of files) console.log(f);
