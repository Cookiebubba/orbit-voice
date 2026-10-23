// Renders assets/icon.svg into the PNG/ICO/ICNS files the app and installers need, and
// assets/tray-template.svg into the macOS menu-bar template images.
// Run with: npx electron scripts/make-icons.mjs          (everything)
//           npx electron scripts/make-icons.mjs --mac    (only the macOS files: icon.icns, trayTemplate*.png)
//
// macOS: build/icon.icns holds PNGs from 16 to 1024 px. The tile is drawn at Apple's icon grid size
// (824 of 1024, centred, transparent around it) so it sits right next to other Dock icons; the
// Windows icon keeps the full-bleed tile. The menu-bar icon is black on transparent (a "template"
// image the system tints for light and dark menu bars), 16 pt: trayTemplate.png (16 px) and
// trayTemplate@2x.png (32 px).
import { app, BrowserWindow, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');
const traySvg = fs.readFileSync(path.join(ROOT, 'assets', 'tray-template.svg'), 'utf8');
const MAC_ONLY = process.argv.includes('--mac');

async function render(size, source = svg) {
  const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}" width="${size}" height="${size}"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  return img.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

/** The same artwork on Apple's icon grid: the tile scaled to 824/1024 and centred. */
function macSvg(source) {
  const inner = source.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const k = 824 / 1024;
  const off = (512 * (1 - k)) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><g transform="translate(${off} ${off}) scale(${k})">${inner}</g></svg>`;
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

// ICNS element types that hold PNG data (macOS 10.7+), by pixel size. The @2x types reuse sizes.
export const ICNS_TYPES = Object.freeze([
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024], // 512@2x
  ['ic11', 32], // 16@2x
  ['ic12', 64], // 32@2x
  ['ic13', 256], // 128@2x
  ['ic14', 512], // 256@2x
]);

/** An .icns file: "icns" + total length, then [type, length, PNG] for each element (big-endian). */
export function icns(pngBySize) {
  const parts = ICNS_TYPES.map(([type, size]) => {
    const png = pngBySize(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// Several renders in a row: the app must not quit between one window closing and the next opening.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  const scaler = (big) => (size) => (size === big.size ? big.png : nativeImage.createFromBuffer(big.png).resize({ width: size, height: size, quality: 'best' }).toPNG());

  if (!MAC_ONLY) {
    // Render once, large, then scale down (tiny windows are not reliable to capture).
    const big = { size: 512, png: await render(512) };
    const scaled = scaler(big);
    fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), big.png);
    fs.writeFileSync(path.join(ROOT, 'assets', 'tray.png'), scaled(32));
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico(sizes.map((size) => ({ size, png: scaled(size) }))));
  }

  // macOS app icon.
  const macBig = { size: 1024, png: await render(1024, macSvg(svg)) };
  const macScaled = scaler(macBig);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.icns'), icns(macScaled));
  // macOS menu bar: rendered large and scaled down, black + alpha only.
  const trayBig = { size: 256, png: await render(256, traySvg) };
  const trayScaled = scaler(trayBig);
  fs.writeFileSync(path.join(ROOT, 'assets', 'trayTemplate.png'), trayScaled(16));
  fs.writeFileSync(path.join(ROOT, 'assets', 'trayTemplate@2x.png'), trayScaled(32));
  console.log(MAC_ONLY ? 'macOS icons written' : 'icons written');
  app.quit();
});
