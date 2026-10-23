// macOS (phase 1): the package.json mac build (targets, icon, entitlements, Info.plist strings,
// the native speech packages unpacked from app.asar, publishing). Read from the files only.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';
import { lockedMacPackages, MAC_NATIVE } from '../scripts/mac-native.mjs';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const mac = pkg.build.mac;

/** A plain plist of <key>…</key><true/> pairs (what entitlements are) as an object; throws if it's anything else. */
function readEntitlements(xml) {
  const body = /<plist version="1\.0">\s*<dict>([\s\S]*)<\/dict>\s*<\/plist>\s*$/.exec(xml.replace(/<!--[\s\S]*?-->/g, ''));
  if (!/^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<!DOCTYPE plist/.test(xml) || !body) throw new Error('not a plist');
  const out = {};
  const rest = body[1].replace(/\s*<key>([^<]+)<\/key>\s*<(true|false)\/>\s*/g, (_m, k, v) => {
    out[k] = v === 'true';
    return '';
  });
  if (rest.trim()) throw new Error(`unexpected plist content: ${rest.trim().slice(0, 80)}`);
  return out;
}

test('mac build: dmg and zip (the zip is what electron-updater installs), arm64 and x64 each', () => {
  const targets = Object.fromEntries(mac.target.map((t) => [t.target, t.arch]));
  assert.deepEqual(targets, { dmg: ['arm64', 'x64'], zip: ['arm64', 'x64'] });
  assert.equal(mac.category, 'public.app-category.productivity');
  assert.equal(mac.artifactName, 'Orbit-${version}-${arch}.${ext}', 'the arch in the name: electron-updater picks the arm64 zip by it');
  assert.equal(pkg.build.dmg.artifactName, mac.artifactName);
  assert.ok(pkg.build.win, 'the Windows build is still there');
  assert.match(pkg.scripts.dist, /electron-builder --win/);
  assert.match(pkg.scripts['dist:mac'], /scripts\/mac-native\.mjs && electron-builder --mac --publish never/);
  assert.match(pkg.scripts['dist:mac'], /build:ui/);
});

test('mac build: icon is a real .icns, and the menu-bar template images exist', () => {
  const icns = fs.readFileSync(path.join(ROOT, mac.icon));
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

test('mac build: hardened runtime, entitlements file exists and parses, with what Orbit needs', () => {
  assert.equal(mac.hardenedRuntime, true);
  assert.equal(mac.gatekeeperAssess, false);
  assert.equal(mac.entitlements, 'build/entitlements.mac.plist');
  assert.equal(mac.entitlementsInherit, 'build/entitlements.mac.plist');
  const ent = readEntitlements(fs.readFileSync(path.join(ROOT, mac.entitlements), 'utf8'));
  assert.deepEqual(ent, {
    'com.apple.security.cs.allow-jit': true,
    'com.apple.security.cs.allow-unsigned-executable-memory': true,
    'com.apple.security.cs.disable-library-validation': true,
    'com.apple.security.device.audio-input': true,
    'com.apple.security.automation.apple-events': true,
  });
  assert.ok(!('com.apple.security.cs.allow-dyld-environment-variables' in ent), 'DYLD_* stays stripped');
});

test('mac build: notarizing is driven by APPLE_* environment variables only (none in the config)', () => {
  assert.equal(mac.notarize, true);
  const text = JSON.stringify(pkg.build);
  for (const secret of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'appleId', 'password', 'teamId', 'identity']) assert.ok(!text.includes(secret), secret);
});

test('mac build: Info.plist says why Orbit wants the microphone, Apple Events and Accessibility', () => {
  const info = mac.extendInfo;
  for (const k of ['NSMicrophoneUsageDescription', 'NSAppleEventsUsageDescription', 'NSAccessibilityUsageDescription']) {
    assert.equal(typeof info[k], 'string', k);
    assert.ok(info[k].length > 30 && info[k].includes('Orbit'), k);
  }
});

test('mac build: sherpa-onnx native packages for both Macs are unpacked from app.asar (and Windows still)', () => {
  const un = pkg.build.asarUnpack;
  for (const p of ['node_modules/sherpa-onnx-node/**', 'node_modules/sherpa-onnx-win-x64/**', 'node_modules/sherpa-onnx-darwin-arm64/**', 'node_modules/sherpa-onnx-darwin-x64/**']) assert.ok(un.includes(p), p);
  // ...at the versions package-lock.json pins (what scripts/mac-native.mjs fetches for the other arch).
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const locked = lockedMacPackages(lock);
  assert.deepEqual(locked.map((p) => p.name), MAC_NATIVE);
  const sherpa = lock.packages['node_modules/sherpa-onnx-node'];
  for (const p of locked) {
    assert.equal(p.version, sherpa.version, `${p.name} matches sherpa-onnx-node`);
    assert.match(p.integrity, /^sha512-/);
    assert.ok(sherpa.optionalDependencies[p.name], `${p.name} is sherpa-onnx-node's optional dependency`);
  }
});

test('mac build: GitHub publishing (so electron-builder writes latest-mac.yml next to the zips)', () => {
  assert.deepEqual(pkg.build.publish.map((p) => [p.provider, p.owner, p.repo]), [['github', 'Cookiebubba', 'orbit-voice']]);
  assert.ok(!('publish' in mac), 'the same publish config as Windows');
});

test("mac build: the whole build config passes electron-builder's own schema (and a typo would not)", async () => {
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
  const { DebugLogger } = require('builder-util');
  await validateConfiguration(structuredClone(pkg.build), new DebugLogger(false));
  const typo = structuredClone(pkg.build);
  typo.mac.hardenedRuntme = true;
  await assert.rejects(validateConfiguration(typo, new DebugLogger(false)), /does not match the API schema/);
});
