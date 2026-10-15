// 用 Electron 把 assets/icon.svg 渲染成 PNG 并生成 icns：npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const root = join(__dirname, '..');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = readFileSync(join(root, 'assets/icon.svg'), 'utf8');
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, useContentSize: true, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const png = join(root, 'assets/icon.png');
  writeFileSync(png, img.toPNG());

  const set = join(root, 'build/icon.iconset');
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set, { recursive: true });
  for (const s of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(s), String(s), png, '--out', join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
    execFileSync('sips', ['-z', String(s * 2), String(s * 2), png, '--out', join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(root, 'build/icon.icns')]);
  rmSync(set, { recursive: true, force: true });
  app.quit();
});
