// Closed solids for buildings (flat prisms) and line features (draped ribbons).

import earcut from 'earcut';
import { signedArea } from '../geo/polygon.js';
import { MeshBuf } from './meshbuf.js';

/**
 * Append a prism with a flat bottom and flat top. Returns false if the
 * polygon could not be triangulated cleanly (it is then skipped).
 * @param {MeshBuf} m
 * @param {number[][]} outer  cleaned ring in mm
 * @param {number[][][]} holes cleaned rings in mm
 */
export function addPrism(m, outer, holes, zBottom, zTop) {
  if (zTop - zBottom < 1e-3) return false;
  const rings = [signedArea(outer) > 0 ? outer : outer.slice().reverse()];
  for (const h of holes) rings.push(signedArea(h) < 0 ? h : h.slice().reverse());

  const flat = [];
  const holeIdx = [];
  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holeIdx.push(flat.length / 2);
    for (const p of rings[r]) flat.push(p[0], p[1]);
  }
  const tris = earcut(flat, holeIdx.length ? holeIdx : undefined);
  if (!tris.length) return false;

  // Reject bad triangulations (self-intersecting input): areas must match.
  let triArea = 0;
  for (let k = 0; k < tris.length; k += 3) triArea += Math.abs(area3(flat, tris[k], tris[k + 1], tris[k + 2]));
  let polyArea = Math.abs(signedArea(rings[0]));
  for (let r = 1; r < rings.length; r++) polyArea -= Math.abs(signedArea(rings[r]));
  if (polyArea <= 0 || Math.abs(triArea - polyArea) > polyArea * 0.01 + 1e-6) return false;

  const n = flat.length / 2;
  const T = new Array(n);
  const B = new Array(n);
  for (let k = 0; k < n; k++) {
    T[k] = m.v(flat[2 * k], flat[2 * k + 1], zTop);
    B[k] = m.v(flat[2 * k], flat[2 * k + 1], zBottom);
  }
  for (let k = 0; k < tris.length; k += 3) {
    let a = tris[k], b = tris[k + 1], c = tris[k + 2];
    if (area3(flat, a, b, c) < 0) [b, c] = [c, b];
    m.t(T[a], T[b], T[c]);
    m.t(B[a], B[c], B[b]);
  }
  let start = 0;
  for (const ring of rings) {
    const len = ring.length;
    for (let k = 0; k < len; k++) {
      const p = start + k;
      const q = start + ((k + 1) % len);
      m.t(T[p], B[p], B[q]);
      m.t(T[p], B[q], T[q]);
    }
    start += len;
  }
  return true;
}

function area3(f, a, b, c) {
  return ((f[2 * b] - f[2 * a]) * (f[2 * c + 1] - f[2 * a + 1]) - (f[2 * c] - f[2 * a]) * (f[2 * b + 1] - f[2 * a + 1])) / 2;
}

/**
 * Split a polyline wherever it turns more sharply than maxTurnDeg, so that
 * ribbons never fold over themselves.
 */
export function splitAtSharpTurns(line, maxTurnDeg = 60) {
  const cosMax = Math.cos((maxTurnDeg * Math.PI) / 180);
  const pieces = [];
  let cur = [line[0]];
  for (let i = 1; i < line.length; i++) {
    cur.push(line[i]);
    if (i < line.length - 1) {
      const a = line[i - 1], b = line[i], c = line[i + 1];
      const ux = b[0] - a[0], uy = b[1] - a[1];
      const vx = c[0] - b[0], vy = c[1] - b[1];
      const cos = (ux * vx + uy * vy) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1);
      if (cos < cosMax) {
        pieces.push(cur);
        cur = [line[i]];
      }
    }
  }
  if (cur.length >= 2) pieces.push(cur);
  return pieces;
}

/**
 * Append a closed ribbon following a densified polyline, draped on the surface.
 * @param {MeshBuf} m
 * @param {number[][]} pts   polyline in mm (no duplicate points)
 * @param {(x:number,y:number)=>number} groundAt
 */
export function addRibbon(m, pts, width, groundAt, heightAbove, sinkBelow) {
  const n = pts.length;
  if (n < 2) return;
  const half = width / 2;
  const segN = [];
  for (let i = 0; i + 1 < n; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const l = Math.hypot(dx, dy) || 1;
    segN.push([-dy / l, dx / l]);
  }
  const L = [], R = [], BL = [], BR = [];
  for (let i = 0; i < n; i++) {
    let nx, ny, scale = 1;
    if (i === 0) [nx, ny] = segN[0];
    else if (i === n - 1) [nx, ny] = segN[n - 2];
    else {
      const a = segN[i - 1], b = segN[i];
      nx = a[0] + b[0]; ny = a[1] + b[1];
      const l = Math.hypot(nx, ny) || 1;
      nx /= l; ny /= l;
      scale = Math.min(2, 1 / Math.max(0.5, nx * a[0] + ny * a[1])); // miter, limited
    }
    const [px, py] = pts[i];
    const lx = px + nx * half * scale, ly = py + ny * half * scale;
    const rx = px - nx * half * scale, ry = py - ny * half * scale;
    const gl = groundAt(lx, ly), gr = groundAt(rx, ry);
    L.push(m.v(lx, ly, gl + heightAbove));
    R.push(m.v(rx, ry, gr + heightAbove));
    BL.push(m.v(lx, ly, Math.max(0.05, gl - sinkBelow)));
    BR.push(m.v(rx, ry, Math.max(0.05, gr - sinkBelow)));
  }
  const wall = (tp, bp, tq, bq) => { m.t(tp, bp, bq); m.t(tp, bq, tq); };
  for (let i = 0; i + 1 < n; i++) {
    m.t(R[i], R[i + 1], L[i + 1]);
    m.t(R[i], L[i + 1], L[i]);
    m.t(BR[i], BL[i + 1], BR[i + 1]);
    m.t(BR[i], BL[i], BL[i + 1]);
    wall(R[i], BR[i], R[i + 1], BR[i + 1]); // right side, walking forward
    wall(L[i + 1], BL[i + 1], L[i], BL[i]); // left side, walking backward
  }
  wall(L[0], BL[0], R[0], BR[0]); // start cap
  wall(R[n - 1], BR[n - 1], L[n - 1], BL[n - 1]); // end cap
}

/** Small octagonal plug used to fill the gap where a ribbon was split. */
export function addJoint(m, center, width, groundAt, heightAbove, sinkBelow) {
  const ring = [];
  const r = width / 2 / Math.cos(Math.PI / 8);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    ring.push([center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r]);
  }
  let lo = Infinity, hi = -Infinity;
  for (const p of ring) { const g = groundAt(p[0], p[1]); lo = Math.min(lo, g); hi = Math.max(hi, g); }
  addPrism(m, ring, [], Math.max(0.05, lo - sinkBelow), hi + heightAbove);
}

export { MeshBuf };
