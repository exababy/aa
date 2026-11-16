'use strict';
/**
 * Tek dosyalık exe üretir (Node "single executable application"):
 *   node pos/build.js            → dist/NetCHIEF-Smart.exe   (Windows x64)
 *   node pos/build.js --linux    → dist/netchief-smart       (bu makinenin Node'u; deneme için)
 * Arayüz dosyaları exe'nin içine gömülür; kurulum gerekmez. İlk çalıştırmada Windows için node.exe indirilir (dist/.cache).
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const linux = process.argv.includes('--linux');

function collect(dir, prefix, out) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) collect(file, `${prefix}/${name}`, out);
    else out[`${prefix}/${name}`] = fs.readFileSync(file).toString('base64');
  }
  return out;
}

(async () => {
  fs.mkdirSync(path.join(dist, '.cache'), { recursive: true });
  const assets = collect(path.join(__dirname, 'public'), '', {});
  for (const f of fs.readdirSync(path.join(root, 'public', 'fonts'))) {
    if (f.startsWith('inter-')) assets[`/fonts/${f}`] = fs.readFileSync(path.join(root, 'public', 'fonts', f)).toString('base64');
  }
  const bundle = path.join(dist, '.cache', 'bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'main.js')], bundle: true, platform: 'node', target: 'node22', outfile: bundle, minify: true, logLevel: 'warning',
    banner: { js: `globalThis.__POS_ASSETS__=${JSON.stringify(assets)};` },
  });
  const blob = path.join(dist, '.cache', 'sea.blob');
  const seaConfig = path.join(dist, '.cache', 'sea.json');
  fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

  let nodeBin = process.execPath;
  const out = path.join(dist, linux ? 'netchief-smart' : 'NetCHIEF-Smart.exe');
  if (!linux) {
    nodeBin = path.join(dist, '.cache', `node-${process.version}-win-x64.exe`);
    if (!fs.existsSync(nodeBin)) {
      const url = `https://nodejs.org/dist/${process.version}/win-x64/node.exe`;
      console.log(`İndiriliyor: ${url}`);
      execFileSync('curl', ['-fsSL', '-o', nodeBin, url], { stdio: 'inherit' });
    }
  }
  fs.copyFileSync(nodeBin, out);
  fs.chmodSync(out, 0o755);
  execFileSync(process.execPath, [require.resolve('postject/dist/cli.js'), out, 'NODE_SEA_BLOB', blob,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--overwrite'], { stdio: 'inherit' });
  console.log(`Hazır: ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
