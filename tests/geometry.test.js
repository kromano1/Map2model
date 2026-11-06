import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { clipRingToRect, clipLineToRect, cleanRing, assembleRings, signedArea } from '../src/geo/polygon.js';
import { makeProjection } from '../src/geo/project.js';
import { MeshBuf, Surface, countBadEdges, signedVolume } from '../src/mesh/meshbuf.js';
import { buildCellParts, rasterizeRings } from '../src/mesh/cells.js';
import { addPrism, addRibbon, splitAtSharpTurns } from '../src/mesh/solids.js';
import { buildModel, gridSize } from '../src/mesh/build.js';
import { buildQuery, parseOverpass } from '../src/data/overpass.js';
import { decodeTerrarium, sampleTiles } from '../src/data/elevation.js';
import { writeSTL } from '../src/export/stl.js';
import { write3MF } from '../src/export/threemf.js';

const rect = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

describe('polygon helpers', () => {
  it('clips a ring to a rectangle', () => {
    const r = clipRingToRect([[-5, 2], [5, 2], [5, 8], [-5, 8]], rect);
    expect(Math.abs(signedArea(r))).toBeCloseTo(30);
  });
  it('clips a polyline into pieces', () => {
    const pieces = clipLineToRect([[-5, 5], [5, 5], [5, 15], [8, 15], [8, 5]], rect);
    expect(pieces.length).toBe(2);
    expect(pieces[0][0]).toEqual([0, 5]);
  });
  it('cleans collinear and duplicate points', () => {
    expect(cleanRing([[0, 0], [1, 0], [2, 0], [2, 2], [2, 2], [0, 2], [0, 0]])).toHaveLength(4);
    expect(cleanRing([[0, 0], [1, 0], [2, 0]])).toBeNull();
  });
  it('assembles relation fragments into rings', () => {
    const rings = assembleRings([[[0, 0], [1, 0]], [[1, 1], [1, 0]], [[1, 1], [0, 1], [0, 0]]]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
  });
});

describe('projection', () => {
  it('maps the bbox to the requested width, centred', () => {
    const p = makeProjection({ west: 8.5, south: 47.3, east: 8.52, north: 47.31 }, 150);
    const [x0] = p.toMM(8.5, 47.305);
    const [x1] = p.toMM(8.52, 47.305);
    expect(x1 - x0).toBeCloseTo(150, 6);
    expect(x0).toBeCloseTo(-75, 6);
    expect(p.heightMM).toBeGreaterThan(100);
  });
});

describe('solids are closed and outward-facing', () => {
  const surface = (() => {
    const cols = 6, rows = 4;
    const z = new Float32Array((cols + 1) * (rows + 1)).map((_, n) => 2 + (n % 5) * 0.3);
    return new Surface(z, cols, rows, 12, 8);
  })();

  it('cell parts', () => {
    const classes = new Uint8Array(24);
    rasterizeRings([[[-2, -2], [3, -2], [3, 3], [-2, 3]]], surface, (i, j) => { classes[j * 6 + i] = 1; });
    classes[0] = 2;
    const parts = buildCellParts(surface, classes, [0, 0.3, 0]);
    expect(parts[1].triCount).toBeGreaterThan(0);
    for (const m of parts) {
      if (m.empty) continue;
      expect(countBadEdges(m)).toBe(0);
      expect(signedVolume(m)).toBeGreaterThan(0);
    }
    // Parts tile the footprint: total volume = plain terrain + the raised green cells.
    const total = parts.reduce((v, m) => v + signedVolume(m), 0);
    const single = buildCellParts(surface, new Uint8Array(24), [0])[0];
    const greenCells = classes.filter((c) => c === 1).length;
    const cellArea = surface.cellW * surface.cellH;
    expect(total).toBeCloseTo(signedVolume(single) + greenCells * cellArea * 0.3, 6);
  });

  it('prism with a hole', () => {
    const m = new MeshBuf();
    const ok = addPrism(m, [[0, 0], [4, 0], [4, 4], [0, 4]], [[[1, 1], [1, 3], [3, 3], [3, 1]]], 1, 3);
    expect(ok).toBe(true);
    expect(countBadEdges(m)).toBe(0);
    expect(signedVolume(m)).toBeCloseTo((16 - 4) * 2, 6);
  });

  it('prism given clockwise outer ring', () => {
    const m = new MeshBuf();
    addPrism(m, [[0, 0], [0, 2], [2, 2], [2, 0]], [], 0, 1);
    expect(signedVolume(m)).toBeCloseTo(4, 6);
  });

  it('ribbon', () => {
    const m = new MeshBuf();
    addRibbon(m, [[-4, -2], [-1, -1], [2, 0], [4, 2]], 0.8, (x, y) => surface.heightAt(x, y), 0.5, 0.4);
    expect(countBadEdges(m)).toBe(0);
    expect(signedVolume(m)).toBeGreaterThan(0);
  });

  it('splits sharp turns', () => {
    expect(splitAtSharpTurns([[0, 0], [1, 0], [0, 0.1]], 60)).toHaveLength(2);
    expect(splitAtSharpTurns([[0, 0], [1, 0], [2, 0.1]], 60)).toHaveLength(1);
  });
});

describe('overpass', () => {
  it('builds a query only for enabled layers', () => {
    const q = buildQuery({ west: 1, south: 2, east: 3, north: 4 }, { buildings: true });
    expect(q).toContain('way["building"](2,1,4,3)');
    expect(q).not.toContain('highway');
    expect(buildQuery({ west: 1, south: 2, east: 3, north: 4 }, {})).toBeNull();
  });
  it('parses buildings, roads and multipolygons', () => {
    const g = (pts) => pts.map(([lon, lat]) => ({ lon, lat }));
    const f = parseOverpass({
      elements: [
        { type: 'way', tags: { building: 'yes', 'building:levels': '4' }, geometry: g([[0, 0], [1, 0], [1, 1], [0, 0]]) },
        { type: 'way', tags: { highway: 'primary' }, geometry: g([[0, 0], [1, 1]]) },
        { type: 'way', tags: { highway: 'service', tunnel: 'yes' }, geometry: g([[0, 0], [1, 1]]) },
        {
          type: 'relation', tags: { type: 'multipolygon', natural: 'water' },
          members: [
            { type: 'way', role: 'outer', geometry: g([[0, 0], [4, 0], [4, 4]]) },
            { type: 'way', role: 'outer', geometry: g([[4, 4], [0, 4], [0, 0]]) },
            { type: 'way', role: 'inner', geometry: g([[1, 1], [2, 1], [2, 2], [1, 1]]) },
          ],
        },
      ],
    });
    expect(f.buildings[0].heightM).toBe(13);
    expect(f.roads).toHaveLength(1);
    expect(f.water[0].holes).toHaveLength(1);
  });
});

describe('elevation', () => {
  it('decodes terrarium', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    expect(decodeTerrarium(128, 100, 128)).toBeCloseTo(100.5);
  });
  it('samples a constant tile', () => {
    const tiles = new Map([['0/0', { size: 4, heights: new Float32Array(16).fill(42) }]]);
    expect(sampleTiles(tiles, 0, 4, 10, 10)).toBeCloseTo(42);
  });
});

describe('full model + exporters', () => {
  const bbox = { west: 8.54, south: 47.37, east: 8.545, north: 47.373 };
  const lonlat = (x, y) => [8.54 + x * 0.005, 47.37 + y * 0.003];
  const features = {
    buildings: [{ outer: [lonlat(0.2, 0.2), lonlat(0.4, 0.2), lonlat(0.4, 0.4), lonlat(0.2, 0.4)], holes: [], heightM: 20, minHeightM: 0 }],
    roads: [{ line: [lonlat(-0.1, 0.5), lonlat(1.1, 0.55)], widthM: 10, kind: 'primary' }],
    rail: [],
    water: [{ outer: [lonlat(0.6, 0.6), lonlat(0.9, 0.6), lonlat(0.9, 0.9), lonlat(0.6, 0.9)], holes: [] }],
    waterways: [],
    green: [{ outer: [lonlat(0.0, 0.0), lonlat(0.15, 0.0), lonlat(0.15, 0.15), lonlat(0.0, 0.15)], holes: [] }],
  };
  const settings = { widthMM: 60, cellMM: 1, layers: { buildings: true, roads: true, water: true, green: true } };
  const { cols, rows } = gridSize(60, 60 * 0.82, 1);
  const elevation = new Float32Array((cols + 1) * (rows + 1)).map((_, n) => 400 + (n % (cols + 1)));
  const model = buildModel({ bbox, settings, elevation, cols, rows, features, gpx: [[lonlat(0.1, 0.9), lonlat(0.9, 0.1)]] });

  it('produces every part as a closed solid', () => {
    for (const name of ['terrain', 'water', 'green', 'roads', 'buildings', 'gpx']) {
      const m = model.parts[name];
      expect(m.triCount, name).toBeGreaterThan(0);
      expect(countBadEdges(m), name).toBe(0);
      expect(signedVolume(m), name).toBeGreaterThan(0);
    }
    expect(model.stats.widthMM).toBeCloseTo(60);
  });

  it('writes a binary STL of the right size', () => {
    const meshes = Object.values(model.parts);
    const stl = writeSTL(meshes);
    const tris = meshes.reduce((n, m) => n + m.triCount, 0);
    expect(stl.length).toBe(84 + 50 * tris);
    expect(new DataView(stl.buffer).getUint32(80, true)).toBe(tris);
  });

  it('writes a 3MF with one object per part plus a parent', () => {
    const zip = write3MF(Object.entries(model.parts).map(([name, mesh]) => ({ name, mesh, color: '#123456' })), { title: 'Test & <check>' });
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
    const xml = strFromU8(files['3D/3dmodel.model']);
    expect((xml.match(/<object /g) ?? []).length).toBe(7); // 6 non-empty parts (rail empty) + parent
    expect(xml).toContain('Test &amp; &lt;check&gt;');
    expect(xml).toContain('displaycolor="#123456FF"');
  });
});
