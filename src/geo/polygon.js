// 2D polygon / polyline helpers. Rings are arrays of [x, y] and are "open":
// the closing point is not repeated.

const EPS = 1e-9;

export function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function samePoint(a, b, eps = EPS) {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
}

/**
 * Remove the closing duplicate, consecutive duplicates and collinear points.
 * Returns null if fewer than 3 points or no area remain.
 */
export function cleanRing(ring, eps = 1e-6) {
  if (!ring || ring.length < 3) return null;
  let pts = ring.slice();
  if (samePoint(pts[0], pts[pts.length - 1], eps)) pts.pop();

  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const prev = out.length ? out[out.length - 1] : pts[n - 1];
      const cur = pts[i];
      const next = pts[(i + 1) % n];
      if (samePoint(prev, cur, eps)) { changed = true; continue; }
      const cross = (cur[0] - prev[0]) * (next[1] - cur[1]) - (cur[1] - prev[1]) * (next[0] - cur[0]);
      const len = Math.hypot(next[0] - prev[0], next[1] - prev[1]) || 1;
      if (Math.abs(cross) / len < eps) { changed = true; continue; }
      out.push(cur);
    }
    // the first point may now duplicate the last kept one
    if (out.length >= 2 && samePoint(out[0], out[out.length - 1], eps)) { out.pop(); changed = true; }
    pts = out;
  }
  if (pts.length < 3 || Math.abs(signedArea(pts)) < eps * eps) return null;
  return pts;
}

export function pointInRing(pt, ring) {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Sutherland–Hodgman clip of a ring against an axis-aligned rectangle. */
export function clipRingToRect(ring, r) {
  const planes = [
    [(p) => p[0] >= r.minX, (a, b) => atX(a, b, r.minX)],
    [(p) => p[0] <= r.maxX, (a, b) => atX(a, b, r.maxX)],
    [(p) => p[1] >= r.minY, (a, b) => atY(a, b, r.minY)],
    [(p) => p[1] <= r.maxY, (a, b) => atY(a, b, r.maxY)],
  ];
  let out = ring;
  for (const [inside, cut] of planes) {
    if (out.length === 0) break;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const cIn = inside(cur);
      const pIn = inside(prev);
      if (cIn) {
        if (!pIn) out.push(cut(prev, cur));
        out.push(cur);
      } else if (pIn) {
        out.push(cut(prev, cur));
      }
    }
  }
  return out;
}

function atX(a, b, x) {
  const t = (x - a[0]) / (b[0] - a[0]);
  return [x, a[1] + t * (b[1] - a[1])];
}
function atY(a, b, y) {
  const t = (y - a[1]) / (b[1] - a[1]);
  return [a[0] + t * (b[0] - a[0]), y];
}

/** Liang–Barsky clip of a polyline against a rectangle; returns 0..n pieces. */
export function clipLineToRect(line, r) {
  const pieces = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= 2) pieces.push(cur);
    cur = [];
  };
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const seg = clipSegment(a, b, r);
    if (!seg) { flush(); continue; }
    const [t0, t1] = seg;
    const pa = lerp(a, b, t0);
    const pb = lerp(a, b, t1);
    if (cur.length === 0 || t0 > 0) { flush(); cur.push(pa); }
    cur.push(pb);
    if (t1 < 1) flush();
  }
  flush();
  return pieces;
}

function clipSegment(a, b, r) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - r.minX, r.maxX - a[0], a[1] - r.minY, r.maxY - a[1]];
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) {
      if (q[k] < 0) return null;
    } else {
      const t = q[k] / p[k];
      if (p[k] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
  }
  return t1 - t0 > 1e-12 ? [t0, t1] : null;
}

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Insert points so that no segment is longer than maxLen. */
export function densifyLine(line, maxLen) {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / maxLen));
    for (let k = 1; k <= n; k++) out.push(lerp(a, b, k / n));
  }
  return out;
}

/** Drop consecutive points closer than eps. */
export function dedupeLine(line, eps = 1e-6) {
  const out = [];
  for (const p of line) if (!out.length || !samePoint(out[out.length - 1], p, eps)) out.push(p);
  return out;
}

/**
 * Join way fragments (arrays of points) into closed rings by matching
 * endpoints. Fragments that cannot be closed are closed implicitly.
 */
export function assembleRings(fragments) {
  const rings = [];
  const pending = [];
  for (const f of fragments) {
    if (!f || f.length < 2) continue;
    if (samePoint(f[0], f[f.length - 1])) rings.push(f.slice(0, -1));
    else pending.push(f.slice());
  }
  while (pending.length) {
    let cur = pending.pop();
    let grew = true;
    while (grew && !samePoint(cur[0], cur[cur.length - 1])) {
      grew = false;
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        const head = cur[0];
        const tail = cur[cur.length - 1];
        if (samePoint(tail, p[0])) cur = cur.concat(p.slice(1));
        else if (samePoint(tail, p[p.length - 1])) cur = cur.concat(p.slice(0, -1).reverse());
        else if (samePoint(head, p[p.length - 1])) cur = p.slice(0, -1).concat(cur);
        else if (samePoint(head, p[0])) cur = p.slice(1).reverse().concat(cur);
        else continue;
        pending.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (samePoint(cur[0], cur[cur.length - 1])) cur = cur.slice(0, -1);
    if (cur.length >= 3) rings.push(cur);
  }
  return rings;
}
