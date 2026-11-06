// Elevation from free, public "Terrarium"-encoded terrain tiles.
//   height_m = R * 256 + G + B / 256 - 32768

export const ELEVATION_SOURCES = {
  aws: {
    label: 'Terrain Tiles on AWS (Mapzen/Tilezen)',
    url: (z, x, y) => `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`,
    tileSize: 256,
    maxZoom: 15,
    attribution: 'Elevation: Terrain Tiles (Mapzen/Tilezen) on AWS — SRTM, GMTED, ETOPO1, NED, and others',
  },
  mapterhorn: {
    label: 'Mapterhorn',
    url: (z, x, y) => `https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`,
    tileSize: 512,
    maxZoom: 12,
    attribution: 'Elevation: © Mapterhorn',
  },
};

const MAX_TILES = 64;
const EARTH_CIRCUMFERENCE = 40075016.686;

export function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToTileY(lat, z) {
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
}

function tileRange(bbox, z) {
  const n = 2 ** z;
  const clampT = (v) => Math.max(0, Math.min(n - 1, Math.floor(v)));
  return {
    x0: clampT(lonToTileX(bbox.west, z)),
    x1: clampT(lonToTileX(bbox.east, z)),
    y0: clampT(latToTileY(bbox.north, z)),
    y1: clampT(latToTileY(bbox.south, z)),
  };
}

const tileCount = (r) => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);

/** Pick a zoom whose pixel size roughly matches the wanted sample spacing. */
export function chooseZoom(bbox, sampleSpacingM, source) {
  const lat = (bbox.south + bbox.north) / 2;
  const mpp = Math.max(0.5, sampleSpacingM / 1.5);
  let z = Math.ceil(Math.log2((EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (source.tileSize * mpp)));
  z = Math.max(0, Math.min(source.maxZoom, z));
  while (z > 0 && tileCount(tileRange(bbox, z)) > MAX_TILES) z--;
  return z;
}

async function loadTilePixels(url, signal) {
  const res = await fetch(url, { signal, mode: 'cors' });
  if (!res.ok) throw new Error(`tile ${res.status}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(bmp.width, bmp.height)
    : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const size = bmp.width; // read before close(): a closed bitmap reports width 0
  const { data } = ctx.getImageData(0, 0, size, bmp.height);
  bmp.close?.();
  const heights = new Float32Array(size * size);
  for (let i = 0; i < heights.length; i++) heights[i] = decodeTerrarium(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  return { size, heights };
}

/**
 * Bilinear sample of a set of decoded tiles.
 * @param {Map<string,{size:number,heights:Float32Array}>} tiles keyed "x/y"
 */
export function sampleTiles(tiles, z, tileSize, lon, lat) {
  const gx = lonToTileX(lon, z) * tileSize - 0.5;
  const gy = latToTileY(lat, z) * tileSize - 0.5;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const px = (x, y) => {
    const tx = Math.floor(x / tileSize);
    const ty = Math.floor(y / tileSize);
    const t = tiles.get(`${tx}/${ty}`);
    if (!t) return NaN;
    const lx = Math.min(t.size - 1, Math.max(0, x - tx * tileSize));
    const ly = Math.min(t.size - 1, Math.max(0, y - ty * tileSize));
    return t.heights[ly * t.size + lx];
  };
  const v00 = px(ix, iy);
  const v10 = px(ix + 1, iy);
  const v01 = px(ix, iy + 1);
  const v11 = px(ix + 1, iy + 1);
  const vals = [v00, v10, v01, v11];
  if (vals.some(Number.isNaN)) {
    const ok = vals.filter((v) => !Number.isNaN(v));
    return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : NaN;
  }
  return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}

/**
 * Elevation in metres at every node of a (cols+1) x (rows+1) grid spanning the
 * bbox; row 0 is the south edge, column 0 the west edge.
 */
export async function fetchElevationGrid(bbox, cols, rows, { sourceId = 'aws', signal, onProgress } = {}) {
  const source = ELEVATION_SOURCES[sourceId] ?? ELEVATION_SOURCES.aws;
  const spacingM = ((bbox.east - bbox.west) * 111320 * Math.cos(((bbox.south + bbox.north) / 2) * Math.PI / 180)) / cols;
  let z = chooseZoom(bbox, spacingM, source);

  for (let attempt = 0; ; attempt++) {
    const r = tileRange(bbox, z);
    const jobs = [];
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) jobs.push([x, y]);
    const tiles = new Map();
    let done = 0;
    let failed = 0;
    await runPool(jobs, 6, async ([x, y]) => {
      try {
        tiles.set(`${x}/${y}`, await loadTilePixels(source.url(z, x, y), signal));
      } catch (e) {
        if (signal?.aborted) throw e;
        console.warn(`Elevation tile ${z}/${x}/${y} failed:`, e?.message ?? e);
        failed++;
      }
      onProgress?.(++done / jobs.length);
    });
    if (failed && attempt < 4 && z > 0) { z--; continue; } // tile missing at this zoom: go coarser
    if (failed === jobs.length) throw new Error('Could not load elevation tiles. Check your connection or switch the elevation source.');

    const grid = new Float32Array((cols + 1) * (rows + 1));
    for (let j = 0; j <= rows; j++) {
      const lat = bbox.south + (j / rows) * (bbox.north - bbox.south);
      for (let i = 0; i <= cols; i++) {
        const lon = bbox.west + (i / cols) * (bbox.east - bbox.west);
        const v = sampleTiles(tiles, z, source.tileSize, lon, lat);
        grid[j * (cols + 1) + i] = Number.isNaN(v) ? 0 : v;
      }
    }
    return { grid, zoom: z, source };
  }
}

async function runPool(items, concurrency, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}
