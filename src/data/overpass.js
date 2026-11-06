// OpenStreetMap features via the public Overpass API.
// Please respect https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances
// (one query per generation, modest areas).

import { assembleRings, pointInRing } from '../geo/polygon.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const GREEN_LANDUSE = 'forest|grass|meadow|village_green|recreation_ground|cemetery|orchard|vineyard|allotments';
const GREEN_LEISURE = 'park|garden|pitch|golf_course|nature_reserve|playground';
const GREEN_NATURAL = 'wood|scrub|grassland|heath';
const RAIL = 'rail|light_rail|tram|subway|narrow_gauge|monorail|funicular';

/** Road width in metres per highway class (before scaling). */
export const ROAD_WIDTH_M = {
  motorway: 22, trunk: 18, primary: 15, secondary: 13, tertiary: 11,
  unclassified: 8, residential: 8, living_street: 6, service: 5, road: 7,
  pedestrian: 6, track: 4, busway: 7,
  motorway_link: 9, trunk_link: 8, primary_link: 8, secondary_link: 7, tertiary_link: 7,
  cycleway: 3, footway: 2.5, path: 2, steps: 2, bridleway: 2.5,
};
export const PATH_CLASSES = new Set(['cycleway', 'footway', 'path', 'steps', 'bridleway', 'track']);
const WATERWAY_WIDTH_M = { river: 20, canal: 12, stream: 3, ditch: 1.5, drain: 1.5 };

/**
 * @param {{west:number,south:number,east:number,north:number}} bbox
 * @param {{buildings?:boolean,roads?:boolean,paths?:boolean,rail?:boolean,water?:boolean,green?:boolean}} layers
 */
export function buildQuery(bbox, layers) {
  const b = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
  const q = [];
  if (layers.buildings) {
    q.push(`way["building"]${b};`, `relation["building"]["type"="multipolygon"]${b};`);
  }
  if (layers.roads || layers.paths) q.push(`way["highway"]${b};`);
  if (layers.rail) q.push(`way["railway"~"^(${RAIL})$"]${b};`);
  if (layers.water) {
    q.push(
      `way["natural"="water"]${b};`,
      `relation["natural"="water"]${b};`,
      `way["landuse"~"^(reservoir|basin)$"]${b};`,
      `way["waterway"="riverbank"]${b};`,
      `relation["waterway"="riverbank"]${b};`,
      `way["waterway"~"^(river|canal|stream)$"]${b};`,
    );
  }
  if (layers.green) {
    q.push(
      `way["landuse"~"^(${GREEN_LANDUSE})$"]${b};`,
      `way["leisure"~"^(${GREEN_LEISURE})$"]${b};`,
      `way["natural"~"^(${GREEN_NATURAL})$"]${b};`,
      `relation["type"="multipolygon"]["landuse"~"^(${GREEN_LANDUSE})$"]${b};`,
      `relation["type"="multipolygon"]["leisure"~"^(${GREEN_LEISURE})$"]${b};`,
      `relation["type"="multipolygon"]["natural"~"^(${GREEN_NATURAL})$"]${b};`,
    );
  }
  if (!q.length) return null;
  return `[out:json][timeout:90];\n(\n  ${q.join('\n  ')}\n);\nout geom;`;
}

/** POST the query, trying each public endpoint in turn. */
export async function fetchOverpass(query, { signal, endpoints = OVERPASS_ENDPOINTS } = {}) {
  let lastErr;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal,
      });
      if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
      const json = await res.json();
      if (typeof json.remark === 'string' && /runtime error|timed out/i.test(json.remark)) {
        throw new Error(`${new URL(url).host}: ${json.remark}`);
      }
      return json;
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw new Error(`Could not load OpenStreetMap data (${lastErr?.message ?? 'no endpoint'}). Try a smaller area or try again in a minute.`);
}

function num(v) {
  if (v == null) return null;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  if (/ft|'/.test(String(v))) n *= 0.3048;
  return Number.isFinite(n) ? n : null;
}

const geomToPts = (g) => (Array.isArray(g) ? g.filter(Boolean).map((p) => [p.lon, p.lat]) : []);

function relationPolygons(rel) {
  const outerFr = [];
  const innerFr = [];
  for (const m of rel.members ?? []) {
    if (m.type !== 'way' || !m.geometry) continue;
    (m.role === 'inner' ? innerFr : outerFr).push(geomToPts(m.geometry));
  }
  const outers = assembleRings(outerFr);
  const inners = assembleRings(innerFr);
  return outers.map((outer) => ({
    outer,
    holes: inners.filter((h) => pointInRing(h[0], outer)),
  }));
}

function wayPolygon(way) {
  const pts = geomToPts(way.geometry);
  if (pts.length < 4) return null;
  const closed = pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  if (!closed) return null;
  return { outer: pts.slice(0, -1), holes: [] };
}

function buildingHeight(tags, defaultHeightM) {
  const h = num(tags.height);
  if (h != null && h > 0) return Math.min(h, 800);
  const lv = num(tags['building:levels']);
  if (lv != null && lv > 0) return Math.min(lv * 3 + 1, 800);
  return defaultHeightM;
}

function buildingMinHeight(tags) {
  const h = num(tags.min_height);
  if (h != null && h > 0) return h;
  const lv = num(tags['building:min_level']);
  return lv != null && lv > 0 ? lv * 3 : 0;
}

const isUnderground = (t) =>
  t.tunnel === 'yes' || t.tunnel === 'building_passage' || t.covered === 'yes' || (num(t.layer) ?? 0) < 0;

/**
 * Turn Overpass JSON into plain feature lists (coordinates in [lon, lat]).
 */
export function parseOverpass(json, { defaultBuildingHeightM = 10 } = {}) {
  const out = { buildings: [], roads: [], rail: [], water: [], waterways: [], green: [] };
  for (const el of json?.elements ?? []) {
    const t = el.tags ?? {};
    const polys = () => (el.type === 'relation' ? relationPolygons(el) : [wayPolygon(el)].filter(Boolean));

    if (t.building && t.building !== 'no' && !t['building:part']) {
      const heightM = buildingHeight(t, defaultBuildingHeightM);
      const minHeightM = buildingMinHeight(t);
      for (const p of polys()) out.buildings.push({ ...p, heightM, minHeightM });
      continue;
    }
    if (el.type === 'way' && t.highway && ROAD_WIDTH_M[t.highway] != null) {
      if (isUnderground(t) || t.area === 'yes') continue;
      const w = num(t.width);
      out.roads.push({
        line: geomToPts(el.geometry),
        kind: t.highway,
        widthM: w != null && w > 0 && w < 60 ? w : ROAD_WIDTH_M[t.highway],
        bridge: t.bridge === 'yes',
      });
      continue;
    }
    if (el.type === 'way' && t.railway) {
      if (isUnderground(t)) continue;
      out.rail.push({ line: geomToPts(el.geometry), widthM: 4 });
      continue;
    }
    if (t.natural === 'water' || t.landuse === 'reservoir' || t.landuse === 'basin' || t.waterway === 'riverbank') {
      out.water.push(...polys());
      continue;
    }
    if (el.type === 'way' && t.waterway && WATERWAY_WIDTH_M[t.waterway] != null) {
      if (isUnderground(t)) continue;
      const w = num(t.width);
      out.waterways.push({ line: geomToPts(el.geometry), widthM: w != null && w > 0 ? w : WATERWAY_WIDTH_M[t.waterway] });
      continue;
    }
    if (
      new RegExp(`^(${GREEN_LANDUSE})$`).test(t.landuse ?? '') ||
      new RegExp(`^(${GREEN_LEISURE})$`).test(t.leisure ?? '') ||
      new RegExp(`^(${GREEN_NATURAL})$`).test(t.natural ?? '')
    ) {
      out.green.push(...polys());
    }
  }
  return out;
}
