// Terrain and area features (water, greenery) as grid-cell columns.
//
// Every terrain grid cell is assigned to exactly one class. Each class becomes
// its own closed solid: the cells' top faces (terrain height + a per-class
// offset), flat bottom faces at z = 0, and walls wherever a cell borders a
// different class or the model edge. The parts tile the footprint without
// overlapping, which makes them clean separate colours in a 3MF.

import { MeshBuf } from './meshbuf.js';

/**
 * Even-odd scanline fill of polygons onto cell centres.
 * @param {number[][][]} rings  outer ring followed by holes, in mm
 * @param {(i:number,j:number)=>void} cb
 */
export function rasterizeRings(rings, surface, cb) {
  const { cols, rows, widthMM, heightMM, cellW, cellH } = surface;
  let minY = Infinity, maxY = -Infinity;
  for (const r of rings) for (const p of r) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  const j0 = Math.max(0, Math.ceil((minY + heightMM / 2) / cellH - 0.5));
  const j1 = Math.min(rows - 1, Math.floor((maxY + heightMM / 2) / cellH - 0.5));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const y = -heightMM / 2 + (j + 0.5) * cellH;
    xs.length = 0;
    for (const ring of rings) {
      for (let k = 0, n = ring.length; k < n; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % n];
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] + widthMM / 2) / cellW - 0.5));
      const i1 = Math.min(cols - 1, Math.floor((xs[k + 1] + widthMM / 2) / cellW - 0.5));
      for (let i = i0; i <= i1; i++) cb(i, j);
    }
  }
}

/**
 * @param {import('./meshbuf.js').Surface} surface
 * @param {Uint8Array} classes  cols*rows class id per cell
 * @param {number[]} offsets    top offset in mm per class id
 * @returns {MeshBuf[]} one mesh per class id (empty if unused)
 */
export function buildCellParts(surface, classes, offsets) {
  const { cols, rows } = surface;
  const nodes = (cols + 1) * (rows + 1);
  const meshes = offsets.map(() => new MeshBuf());
  const topIdx = offsets.map(() => null);
  const botIdx = offsets.map(() => null);

  const top = (k, i, j) => {
    const arr = topIdx[k] ?? (topIdx[k] = new Int32Array(nodes).fill(-1));
    const n = j * (cols + 1) + i;
    if (arr[n] < 0) arr[n] = meshes[k].v(surface.nodeX(i), surface.nodeY(j), surface.z[n] + offsets[k]);
    return arr[n];
  };
  const bot = (k, i, j) => {
    const arr = botIdx[k] ?? (botIdx[k] = new Int32Array(nodes).fill(-1));
    const n = j * (cols + 1) + i;
    if (arr[n] < 0) arr[n] = meshes[k].v(surface.nodeX(i), surface.nodeY(j), 0);
    return arr[n];
  };
  const cls = (i, j) => (i < 0 || j < 0 || i >= cols || j >= rows ? -1 : classes[j * cols + i]);

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = classes[j * cols + i];
      const m = meshes[k];
      // corners counter-clockwise seen from above
      const c = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      const T = c.map(([x, y]) => top(k, x, y));
      const B = c.map(([x, y]) => bot(k, x, y));
      m.t(T[0], T[1], T[2]);
      m.t(T[0], T[2], T[3]);
      m.t(B[0], B[2], B[1]);
      m.t(B[0], B[3], B[2]);
      // walls: south, east, north, west neighbours
      const nb = [cls(i, j - 1), cls(i + 1, j), cls(i, j + 1), cls(i - 1, j)];
      for (let e = 0; e < 4; e++) {
        if (nb[e] === k) continue;
        const p = e;
        const q = (e + 1) % 4;
        m.t(T[p], B[p], B[q]);
        m.t(T[p], B[q], T[q]);
      }
    }
  }
  return meshes;
}
