'use strict';
/**
 * NetCHIEF Smart.exe giriş noktası (tek dosya exe; bkz. pos/build.js).
 * Ayarlar exe'nin yanındaki pos.env ve (varsa) orijinal config.ini dosyasından okunur, sunucu başlatılır ve
 * arayüz Edge/Chrome "uygulama penceresi" olarak açılır. Program zaten açıksa yalnızca pencere açılır.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const base = path.dirname(process.execPath);
const envFile = path.join(base, 'pos.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const ini = path.join(base, 'config.ini');
if (!process.env.POS_CONFIG_INI && fs.existsSync(ini)) process.env.POS_CONFIG_INI = ini;

function openWindow(url) {
  if (process.env.POS_NO_BROWSER === '1') return;
  const flags = [`--app=${url}`, process.env.POS_KIOSK === '1' ? '--kiosk' : '--start-maximized', '--no-first-run', '--disable-pinch', '--overscroll-history-navigation=0'];
  const tries = process.platform === 'win32'
    ? [['cmd', ['/c', 'start', '', 'msedge', ...flags]], ['cmd', ['/c', 'start', '', 'chrome', ...flags]], ['cmd', ['/c', 'start', '', url]]]
    : [['google-chrome', flags], ['chromium', flags], ['xdg-open', [url]]];
  const attempt = (i) => {
    if (i >= tries.length) return;
    const child = spawn(tries[i][0], tries[i][1], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => attempt(i + 1));
    child.on('exit', (code) => { if (code) attempt(i + 1); });
    child.unref();
  };
  attempt(0);
}

require('./server').start().then(({ cfg, server }) => {
  openWindow(`http://localhost:${cfg.port}/`);
  if (!server) setTimeout(() => process.exit(0), 1500); // zaten çalışıyor: pencereyi açıp çık
}).catch((e) => {
  const msg = `NetCHIEF Smart başlatılamadı:\n${e.message}\n`;
  console.error(msg);
  try { fs.writeFileSync(path.join(base, 'pos-hata.txt'), msg); } catch { /* yazılamadı */ }
  setTimeout(() => process.exit(1), 8000);
});
