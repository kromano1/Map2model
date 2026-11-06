// End-to-end smoke test: builds a model in a real browser and checks the exports.
//   npm run build && node tests/e2e/smoke.mjs [screenshot-dir]
// Overpass is replaced by a synthetic fixture (so the test is deterministic);
// map and elevation tiles are fetched live.

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

// Use the project's playwright if installed, otherwise a global one (NODE_PATH).
const { chromium } = createRequire(import.meta.url)('playwright');

const outDir = process.argv[2] ?? 'test-output';
mkdirSync(outDir, { recursive: true });
const AREA = { west: 8.535, south: 47.370, east: 8.548, north: 47.378 };

function fixture() {
  const els = [];
  const g = (pts) => pts.map(([lon, lat]) => ({ lon, lat }));
  const lon = (f) => AREA.west + f * (AREA.east - AREA.west);
  const lat = (f) => AREA.south + f * (AREA.north - AREA.south);
  for (let a = 0; a < 10; a++) for (let b = 0; b < 8; b++) {
    const x = 0.05 + a * 0.09, y = 0.05 + b * 0.11;
    if (x > 0.55 && y > 0.5) continue; // lake there
    els.push({ type: 'way', tags: { building: 'yes', 'building:levels': String(2 + ((a * 7 + b * 3) % 6)) },
      geometry: g([[lon(x), lat(y)], [lon(x + 0.05), lat(y)], [lon(x + 0.05), lat(y + 0.06)], [lon(x), lat(y + 0.06)], [lon(x), lat(y)]]) });
  }
  for (let a = 0; a <= 10; a++) els.push({ type: 'way', tags: { highway: a % 3 ? 'residential' : 'primary' },
    geometry: g([[lon(0.025 + a * 0.09), lat(-0.1)], [lon(0.03 + a * 0.09), lat(0.5)], [lon(0.02 + a * 0.09), lat(1.1)]]) });
  els.push({ type: 'way', tags: { natural: 'water' },
    geometry: g([[lon(0.6), lat(0.55)], [lon(0.95), lat(0.58)], [lon(0.92), lat(0.95)], [lon(0.62), lat(0.9)], [lon(0.6), lat(0.55)]]) });
  els.push({ type: 'way', tags: { leisure: 'park' },
    geometry: g([[lon(0.0), lat(0.9)], [lon(0.5), lat(0.9)], [lon(0.5), lat(1.0)], [lon(0.0), lat(1.0)], [lon(0.0), lat(0.9)]]) });
  return { elements: els };
}

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', '4317', '--strictPort'], { stdio: 'pipe' });
await new Promise((res) => server.stdout.on('data', (d) => /4317/.test(d) && res()));

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, acceptDownloads: true });
  page.on('console', (m) => m.type() !== 'log' && console.log('browser:', m.text()));
  page.on('pageerror', (e) => { console.error('pageerror', e); failed = true; });
  let overpassCalls = 0;
  await page.route(/overpass|interpreter/, (route) => {
    overpassCalls++;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture()) });
  });

  const area = [AREA.west, AREA.south, AREA.east, AREA.north].join(',');
  await page.goto(`http://localhost:4317/?area=${area}`);
  await page.waitForSelector('#area-info b');
  console.log('area:', await page.textContent('#area-info'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/1-map.png` });

  await page.click('#generate');
  await page.waitForFunction(() => /^Done|error|failed/i.test(document.getElementById('status').textContent), null, { timeout: 120000 });
  const status = await page.textContent('#status');
  console.log('status:', status);
  if (!status.startsWith('Done')) throw new Error('generation failed: ' + status);
  if (overpassCalls !== 1) throw new Error('expected 1 overpass call, got ' + overpassCalls);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/2-preview.png` });

  const [d3mf] = await Promise.all([page.waitForEvent('download'), page.click('#export-3mf')]);
  const files = unzipSync(readFileSync(await d3mf.path()));
  const xml = strFromU8(files['3D/3dmodel.model']);
  const objects = [...xml.matchAll(/<object id="\d+" name="([^"]+)"/g)].map((m) => m[1]);
  console.log('3mf:', d3mf.suggestedFilename(), objects);
  for (const want of ['Terrain', 'Water', 'Parks & forest', 'Roads', 'Buildings']) {
    if (!objects.includes(want.replace('&', '&amp;'))) throw new Error('3MF missing part ' + want);
  }

  const [dstl] = await Promise.all([page.waitForEvent('download'), page.click('#export-stl')]);
  const stl = readFileSync(await dstl.path());
  const tris = stl.readUInt32LE(80);
  console.log('stl:', dstl.suggestedFilename(), stl.length, 'bytes', tris, 'triangles');
  if (stl.length !== 84 + tris * 50) throw new Error('STL size mismatch');
  console.log(failed ? 'FAILED (page errors)' : 'OK');
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
