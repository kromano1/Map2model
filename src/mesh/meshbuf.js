// Growable indexed triangle mesh (positions in mm).

export class MeshBuf {
  constructor() {
    this.pos = [];
    this.idx = [];
  }
  v(x, y, z) {
    this.pos.push(x, y, z);
    return this.pos.length / 3 - 1;
  }
  t(a, b, c) {
    this.idx.push(a, b, c);
  }
  get vertexCount() {
    return this.pos.length / 3;
  }
  get triCount() {
    return this.idx.length / 3;
  }
  get empty() {
    return this.idx.length === 0;
  }
}

/** Per-vertex height field over the model rectangle, bilinearly interpolated. */
export class Surface {
  /**
   * @param {Float32Array} z  (cols+1)*(rows+1) node heights in mm, row-major from south-west
   */
  constructor(z, cols, rows, widthMM, heightMM) {
    Object.assign(this, { z, cols, rows, widthMM, heightMM });
    this.cellW = widthMM / cols;
    this.cellH = heightMM / rows;
  }
  nodeX(i) {
    return -this.widthMM / 2 + i * this.cellW;
  }
  nodeY(j) {
    return -this.heightMM / 2 + j * this.cellH;
  }
  node(i, j) {
    return this.z[j * (this.cols + 1) + i];
  }
  heightAt(x, y) {
    const u = Math.max(0, Math.min(this.cols, (x + this.widthMM / 2) / this.cellW));
    const v = Math.max(0, Math.min(this.rows, (y + this.heightMM / 2) / this.cellH));
    const i = Math.min(this.cols - 1, Math.floor(u));
    const j = Math.min(this.rows - 1, Math.floor(v));
    const fu = u - i;
    const fv = v - j;
    const a = this.node(i, j);
    const b = this.node(i + 1, j);
    const c = this.node(i, j + 1);
    const d = this.node(i + 1, j + 1);
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
  }
}

/**
 * Check that every edge is used exactly twice, in opposite directions
 * (closed, consistently oriented 2-manifold). Returns the number of bad edges.
 */
export function countBadEdges(mesh) {
  const edges = new Map();
  const { idx } = mesh;
  for (let k = 0; k < idx.length; k += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[k + e];
      const b = idx[k + ((e + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const dir = a < b ? 1 : -1;
      const rec = edges.get(key) ?? { n: 0, sum: 0 };
      rec.n++;
      rec.sum += dir;
      edges.set(key, rec);
    }
  }
  let bad = 0;
  for (const r of edges.values()) if (r.n !== 2 || r.sum !== 0) bad++;
  return bad;
}

/** Signed volume (positive for outward-facing closed meshes). */
export function signedVolume(mesh) {
  const { pos, idx } = mesh;
  let v = 0;
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
    v += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
      - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
      + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return v / 6;
}
