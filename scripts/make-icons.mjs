// Renders assets/icon.svg into the PNG/ICO files the app and installer need.
// Run with: npx electron scripts/make-icons.mjs
import { app, BrowserWindow, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');

async function render(size) {
  const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  return img.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

/** ICO file with PNG-compressed entries (supported since Windows Vista). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]);
}

app.whenReady().then(async () => {
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  // Render once, large, then scale down (tiny windows are not reliable to capture).
  const big = await render(512);
  const scaled = (size) => nativeImage.createFromBuffer(big).resize({ width: size, height: size, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), big);
  fs.writeFileSync(path.join(ROOT, 'assets', 'tray.png'), scaled(32));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((size) => ({ size, png: scaled(size) }));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico(pngs));
  console.log('icons written');
  app.quit();
});
