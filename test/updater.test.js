// The updater's plain-language errors, and that a copy run from source never checks.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createUpdater, describeUpdateError } from '../electron/updater.js';

test('update errors read as short plain reasons', () => {
  assert.equal(describeUpdateError('net::ERR_INTERNET_DISCONNECTED'), "Couldn't reach GitHub. Check your connection.");
  assert.equal(describeUpdateError('getaddrinfo ENOTFOUND github.com'), "Couldn't reach GitHub. Check your connection.");
  assert.equal(describeUpdateError('Cannot find latest.yml in the latest release artifacts'), 'The newest release has no update info yet.');
  assert.equal(describeUpdateError('sha512 checksum mismatch, expected abc'), 'The download was damaged, so it was thrown away. It will retry.');
  assert.equal(describeUpdateError('Cannot find latest-mac.yml in the latest release artifacts'), 'The newest release has no update info yet.');
  assert.match(describeUpdateError('Could not get code signature for running application'), /signed copy of Orbit/);
  assert.equal(describeUpdateError('something else'), "Couldn't check for updates.");
});

test('running from source: status "dev", no checks, nothing to install', async () => {
  const seen = [];
  const u = createUpdater({ isPackaged: false, auto: true, onChange: (s) => seen.push(s) });
  assert.deepEqual(u.state(), { status: 'dev' });
  assert.deepEqual(await u.check(), { status: 'dev' });
  assert.equal(u.install(), false);
  u.stop();
  assert.deepEqual(seen, [], 'no state changes from source');
});

// ---- channels: stable installs never see a beta; beta installs get later betas and stables

import { createRequire } from 'node:module';
import { allowsPrereleases } from '../electron/updater.js';

const require = createRequire(import.meta.url);
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider.js');
const semver = require('semver');

test('only a prerelease version follows prereleases', () => {
  assert.equal(allowsPrereleases('1.2.0'), false);
  assert.equal(allowsPrereleases('v1.2.0'), false);
  assert.equal(allowsPrereleases('1.3.0-beta.1'), true);
  assert.equal(allowsPrereleases('1.3.0-beta.12'), true);
  assert.equal(allowsPrereleases(''), false);
  assert.equal(allowsPrereleases(undefined), false);
});

function fakeAutoUpdater(version) {
  return { currentVersion: semver.parse(version), on() { return this; }, checkForUpdates: async () => {} };
}

test('the installed version sets the channel', () => {
  for (const [version, beta] of [['1.2.0', false], ['1.3.0-beta.1', true]]) {
    const au = fakeAutoUpdater(version);
    const u = createUpdater({ isPackaged: true, auto: false, version, updater: au });
    assert.equal(au.allowPrerelease, beta, version);
    assert.equal(au.allowDowngrade, false, version);
    u.stop();
    // Without an explicit version it reads electron-updater's own (the app's) version.
    const au2 = fakeAutoUpdater(version);
    createUpdater({ isPackaged: true, auto: false, updater: au2 }).stop();
    assert.equal(au2.allowPrerelease, beta, `${version} (from currentVersion)`);
  }
});

/**
 * What electron-updater's real GitHub provider offers an install, given the releases on GitHub
 * (newest first, as the releases feed lists them). GitHub's /releases/latest is the newest release
 * that isn't a prerelease. Nothing touches the network.
 */
async function offered(current, releases, { platform = 'win32', asked = [] } = {}) {
  const au = fakeAutoUpdater(current);
  createUpdater({ isPackaged: true, auto: false, version: current, updater: au }).stop();
  const updater = { allowPrerelease: au.allowPrerelease, currentVersion: au.currentVersion, channel: null, fullChangelog: false };
  const feed = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${releases
    .map((r) => `<entry><id>tag:github.com,2008:Repository/1/${r.tag}</id><link rel="alternate" type="text/html" href="https://github.com/Cookiebubba/orbit-voice/releases/tag/${r.tag}"/><title>${r.tag}</title><content type="html">notes</content></entry>`)
    .join('')}</feed>`;
  const latestStable = releases.find((r) => !r.prerelease);
  const executor = {
    async request(opts) {
      const p = opts.path;
      if (p.endsWith('/releases.atom')) return feed;
      if (p.endsWith('/releases/latest')) return JSON.stringify({ tag_name: latestStable.tag });
      const yml = /\/releases\/download\/([^/]+)\/([a-z]+(?:-mac)?\.yml)$/.exec(p);
      if (yml) asked.push(yml[2]);
      // Each release has what electron-builder writes: latest.yml (Windows) and latest-mac.yml (Mac).
      const m = /\/releases\/download\/([^/]+)\/latest(-mac)?\.yml$/.exec(p);
      if (m) {
        const v = m[1].replace(/^v/, '');
        if (m[2]) return `version: ${v}\nfiles:\n  - url: Orbit-${v}-arm64.zip\n    sha512: x\n    size: 1\n  - url: Orbit-${v}-x64.zip\n    sha512: x\n    size: 1\npath: Orbit-${v}-arm64.zip\nsha512: x\nreleaseDate: '2026-10-23T00:00:00.000Z'\n`;
        return `version: ${v}\nfiles:\n  - url: Orbit-Setup-${v}.exe\n    sha512: x\n    size: 1\npath: Orbit-Setup-${v}.exe\nsha512: x\nreleaseDate: '2026-10-23T00:00:00.000Z'\n`;
      }
      const err = new (require('builder-util-runtime').HttpError)(404, 'Not Found');
      throw err;
    },
  };
  const provider = new GitHubProvider({ provider: 'github', owner: 'Cookiebubba', repo: 'orbit-voice' }, updater, { executor, platform, isUseMultipleRangeRequest: false });
  const info = await provider.getLatestVersion();
  return semver.gt(info.version, current) ? info.version : null;
}

const beta1 = { tag: 'v1.3.0-beta.1', prerelease: true };
const beta2 = { tag: 'v1.3.0-beta.2', prerelease: true };
const v120 = { tag: 'v1.2.0' };
const v130 = { tag: 'v1.3.0' };

test('a stable install is never offered a beta', async () => {
  assert.equal(await offered('1.2.0', [beta1, v120]), null);
  assert.equal(await offered('1.2.0', [beta2, beta1, v120]), null);
});

test('a stable install gets the next stable, even with a newer beta out', async () => {
  assert.equal(await offered('1.2.0', [v130, beta2, beta1, v120]), '1.3.0');
  assert.equal(await offered('1.2.0', [{ tag: 'v1.4.0-beta.1', prerelease: true }, v130, v120]), '1.3.0');
});

test('a beta install gets later betas, then the stable release', async () => {
  assert.equal(await offered('1.3.0-beta.1', [beta1, v120]), null);
  assert.equal(await offered('1.3.0-beta.1', [beta2, beta1, v120]), '1.3.0-beta.2');
  assert.equal(await offered('1.3.0-beta.1', [v130, beta2, beta1, v120]), '1.3.0');
  // An older stable hotfix published after the beta is never a downgrade.
  assert.equal(await offered('1.3.0-beta.1', [{ tag: 'v1.2.1' }, beta1, v120]), null);
});

test('on a Mac the same channels hold, read from latest-mac.yml (never the Windows latest.yml)', async () => {
  const mac = async (current, releases) => {
    const asked = [];
    const v = await offered(current, releases, { platform: 'darwin', asked });
    return { v, asked };
  };
  let r = await mac('1.2.0', [beta2, beta1, v120]);
  assert.equal(r.v, null, 'a stable Mac install is never offered a beta');
  r = await mac('1.2.0', [v130, beta2, beta1, v120]);
  assert.equal(r.v, '1.3.0');
  assert.deepEqual(r.asked, ['latest-mac.yml']);
  r = await mac('1.3.0-beta.1', [beta2, beta1, v120]);
  assert.equal(r.v, '1.3.0-beta.2', 'a beta Mac install gets later betas');
  // It asks for beta-mac.yml first and falls back to latest-mac.yml, as Windows does with beta.yml.
  assert.deepEqual(r.asked, ['beta-mac.yml', 'latest-mac.yml']);
  r = await mac('1.3.0-beta.1', [v130, beta2, beta1, v120]);
  assert.equal(r.v, '1.3.0', 'then the stable release');
  assert.ok(r.asked.every((f) => f.endsWith('-mac.yml')), r.asked.join());
  // (Windows, for comparison, asks for the plain names.)
  const asked = [];
  await offered('1.3.0-beta.1', [beta2, beta1, v120], { asked });
  assert.deepEqual(asked, ['beta.yml', 'latest.yml']);
});
