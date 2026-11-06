// Binary STL writer (all parts merged into one file).

/** @param {import('../mesh/meshbuf.js').MeshBuf[]} meshes */
export function writeSTL(meshes, name = 'model') {
  const tris = meshes.reduce((n, m) => n + m.triCount, 0);
  const buf = new ArrayBuffer(84 + tris * 50);
  const view = new DataView(buf);
  const header = `${name} - binary STL`.slice(0, 80);
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i) & 0x7f);
  view.setUint32(80, tris, true);
  let o = 84;
  for (const m of meshes) {
    const { pos, idx } = m;
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (const v of [nx, ny, nz]) { view.setFloat32(o, v, true); o += 4; }
      for (const p of [a, b, c]) for (let d = 0; d < 3; d++) { view.setFloat32(o, pos[p + d], true); o += 4; }
      view.setUint16(o, 0, true);
      o += 2;
    }
  }
  return new Uint8Array(buf);
}
