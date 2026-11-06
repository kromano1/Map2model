// Assemble all printable parts from elevation + OSM features + GPX.

import { makeProjection } from '../geo/project.js';
import { cleanRing, clipRingToRect, clipLineToRect, densifyLine, dedupeLine } from '../geo/polygon.js';
import { PATH_CLASSES } from '../data/overpass.js';
import { MeshBuf, Surface } from './meshbuf.js';
import { buildCellParts, rasterizeRings } from './cells.js';
import { addPrism, addRibbon, addJoint, splitAtSharpTurns } from './solids.js';

export const PART_ORDER = ['terrain', 'water', 'green', 'roads', 'rail', 'buildings', 'gpx'];

export const DEFAULTS = {
  widthMM: 150,
  baseMM: 2,
  cellMM: 0.6,
  exaggeration: 1.5,
  buildingScale: 1.5,
  minBuildingMM: 0.8,
  defaultBuildingHeightM: 10,
  minBuildingAreaM2: 15,
  roadScale: 1,
  minRoadMM: 0.6,
  roadHeightMM: 0.5,
  greenHeightMM: 0.3,
  waterHeightMM: 0,
  gpxWidthMM: 1.2,
  gpxHeightMM: 1.2,
};

/** Grid dimensions for a model; keeps node count bounded. */
export function gridSize(widthMM, heightMM, cellMM, maxNodes = 360000) {
  let cell = Math.max(0.2, cellMM);
  let cols = Math.max(2, Math.round(widthMM / cell));
  let rows = Math.max(2, Math.round(heightMM / cell));
  while ((cols + 1) * (rows + 1) > maxNodes) {
    cell *= 1.1;
    cols = Math.max(2, Math.round(widthMM / cell));
    rows = Math.max(2, Math.round(heightMM / cell));
  }
  return { cols, rows };
}

/**
 * @param {object} p
 * @param {{west:number,south:number,east:number,north:number}} p.bbox
 * @param {object} p.settings     see DEFAULTS, plus layers {buildings,roads,paths,rail,water,green}
 * @param {Float32Array|null} p.elevation  metres at grid nodes, or null for flat
 * @param {number} p.cols
 * @param {number} p.rows
 * @param {ReturnType<import('../data/overpass.js').parseOverpass>|null} p.features
 * @param {number[][][]} [p.gpx]  lines of [lon, lat]
 */
export function buildModel({ bbox, settings, elevation, cols, rows, features, gpx }) {
  const s = { ...DEFAULTS, ...settings };
  const layers = s.layers ?? {};
  const proj = makeProjection(bbox, s.widthMM);
  const W = proj.widthMM;
  const H = proj.heightMM;
  const mm = proj.mmPerM;

  // --- height field -------------------------------------------------------
  const nodes = (cols + 1) * (rows + 1);
  const z = new Float32Array(nodes);
  let minE = Infinity, maxE = -Infinity;
  if (elevation) for (const e of elevation) { minE = Math.min(minE, e); maxE = Math.max(maxE, e); }
  for (let n = 0; n < nodes; n++) z[n] = s.baseMM + (elevation ? (elevation[n] - minE) * mm * s.exaggeration : 0);
  const surface = new Surface(z, cols, rows, W, H);
  const ground = (x, y) => surface.heightAt(x, y);

  const rect = { minX: -W / 2, minY: -H / 2, maxX: W / 2, maxY: H / 2 };
  const toMM = (pts) => pts.map(([lon, lat]) => proj.toMM(lon, lat));
  const polyToMM = (poly, r = rect) => {
    const outer = cleanRing(clipRingToRect(toMM(poly.outer), r));
    if (!outer) return null;
    const holes = (poly.holes ?? []).map((h) => cleanRing(clipRingToRect(toMM(h), r))).filter(Boolean);
    return { outer, holes };
  };

  // --- terrain / water / green as cell classes ------------------------------
  const CLASS = { terrain: 0, green: 1, water: 2 };
  const classes = new Uint8Array(cols * rows);
  const paint = (polys, k) => {
    for (const poly of polys) {
      const p = polyToMM(poly);
      if (p) rasterizeRings([p.outer, ...p.holes], surface, (i, j) => { classes[j * cols + i] = k; });
    }
  };
  if (features && layers.green) paint(features.green, CLASS.green);
  if (features && layers.water) paint(features.water, CLASS.water);
  const [terrain, green, water] = buildCellParts(surface, classes, [0, s.greenHeightMM, s.waterHeightMM]);

  const parts = { terrain, water, green, roads: new MeshBuf(), rail: new MeshBuf(), buildings: new MeshBuf(), gpx: new MeshBuf() };
  const step = Math.max(surface.cellW, surface.cellH);

  // --- line features ----------------------------------------------------
  const ribbons = (mesh, line, widthMM, heightAbove) => {
    const inset = { minX: rect.minX + widthMM, minY: rect.minY + widthMM, maxX: rect.maxX - widthMM, maxY: rect.maxY - widthMM };
    for (const piece of clipLineToRect(dedupeLine(toMM(line), 1e-4), inset)) {
      const pts = dedupeLine(piece, 1e-4);
      if (pts.length < 2) continue;
      const split = splitAtSharpTurns(pts, 55);
      split.forEach((part, k) => {
        addRibbon(mesh, dedupeLine(densifyLine(part, step), 1e-4), widthMM, ground, heightAbove, 0.4);
        if (k > 0) addJoint(mesh, part[0], widthMM, ground, heightAbove, 0.4);
      });
    }
  };
  if (features) {
    for (const r of features.roads) {
      const isPath = PATH_CLASSES.has(r.kind);
      if (isPath ? !layers.paths : !layers.roads) continue;
      ribbons(parts.roads, r.line, Math.max(s.minRoadMM, r.widthM * mm * s.roadScale), s.roadHeightMM);
    }
    if (layers.rail) for (const r of features.rail) ribbons(parts.rail, r.line, Math.max(s.minRoadMM, r.widthM * mm * s.roadScale), s.roadHeightMM * 0.8);
    if (layers.water) for (const w of features.waterways) ribbons(parts.water, w.line, Math.max(s.minRoadMM, w.widthM * mm), Math.max(0.1, s.waterHeightMM));
  }
  for (const line of gpx ?? []) ribbons(parts.gpx, line, s.gpxWidthMM, s.gpxHeightMM);

  // --- buildings -------------------------------------------------------
  let skipped = 0;
  if (features && layers.buildings) {
    const minAreaMM2 = s.minBuildingAreaM2 * mm * mm;
    for (const b of features.buildings) {
      const p = polyToMM(b);
      if (!p) continue;
      if (Math.abs(ringArea(p.outer)) < minAreaMM2) continue;
      let lo = Infinity, hi = -Infinity;
      for (const [x, y] of p.outer) { const g = ground(x, y); lo = Math.min(lo, g); hi = Math.max(hi, g); }
      const heightMM = Math.max(s.minBuildingMM, (b.heightM - (b.minHeightM ?? 0)) * mm * s.buildingScale);
      const bottom = Math.max(0.05, lo - 0.4);
      const top = Math.max(lo + heightMM, hi + s.minBuildingMM);
      if (!addPrism(parts.buildings, p.outer, p.holes, bottom, top)) skipped++;
    }
  }

  return {
    parts,
    stats: {
      widthMM: W,
      heightMM: H,
      maxZ: maxOf(parts),
      mmPerM: mm,
      scale: Math.round(1 / (mm / 1000)),
      elevationRange: elevation ? [minE, maxE] : null,
      skippedBuildings: skipped,
    },
  };
}

function ringArea(r) {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function maxOf(parts) {
  let m = 0;
  for (const p of Object.values(parts)) for (let k = 2; k < p.pos.length; k += 3) if (p.pos[k] > m) m = p.pos[k];
  return m;
}
