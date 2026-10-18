// Downloads the offline wake-word model into resources/models and checks it against a pinned
// SHA-256, so a tampered or truncated download never ends up in the installer.
// Run with: node scripts/fetch-model.mjs   (does nothing if the verified file is already there)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = {
  name: 'vosk-model-small-en-us-0.15.tar.gz', // Alpha Cephei, Apache-2.0
  url: 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz',
  sha256: 'f0b24bb92a48ca575b6a96500d6b543f0f079c573dfe85bbe16001fc0404e1d8',
  bytes: 41184862,
};

const dir = path.join(ROOT, 'resources', 'models');
const file = path.join(dir, MODEL.name);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === MODEL.sha256) {
  console.log(`model ok: ${MODEL.name}`);
  process.exit(0);
}

console.log(`downloading ${MODEL.name} (${(MODEL.bytes / 1e6).toFixed(0)} MB)…`);
const res = await fetch(MODEL.url);
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
const got = sha256(buf);
if (got !== MODEL.sha256) throw new Error(`checksum mismatch for ${MODEL.name}: expected ${MODEL.sha256}, got ${got}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, buf);
console.log(`model saved and verified: ${file}`);
