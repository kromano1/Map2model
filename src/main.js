import 'leaflet/dist/leaflet.css';
import './style.css';
import L from 'leaflet';
import { searchPlace } from './data/geocode.js';
import { buildQuery, fetchOverpass, parseOverpass } from './data/overpass.js';
import { fetchElevationGrid, ELEVATION_SOURCES } from './data/elevation.js';
import { parseGpx, linesBBox } from './data/gpx.js';
import { bboxSizeMeters } from './geo/project.js';
import { buildModel, gridSize, DEFAULTS, PART_ORDER } from './mesh/build.js';
import { writeSTL } from './export/stl.js';
import { write3MF } from './export/threemf.js';
import { Preview } from './preview.js';

const MAX_OSM_SIDE_KM = 10; // keep public Overpass servers happy
const MAX_SIDE_KM = 400;

const LAYERS = [
  { id: 'terrain', label: 'Terrain / base', color: '#d9cfb8', fixed: true },
  { id: 'buildings', label: 'Buildings', color: '#f3f1ec', on: true },
  { id: 'roads', label: 'Roads', color: '#4a4f55', on: true },
  { id: 'paths', label: 'Paths & tracks', color: '#4a4f55', on: false, part: 'roads' },
  { id: 'rail', label: 'Railways', color: '#7b5a44', on: false },
  { id: 'water', label: 'Water', color: '#3f86c6', on: true },
  { id: 'green', label: 'Parks & forest', color: '#6aa35a', on: true },
  { id: 'gpx', label: 'GPX route', color: '#e0532f', fixed: true },
];

const state = {
  bbox: null,
  settings: {
    ...DEFAULTS,
    elevation: true,
    elevationSource: 'aws',
    layers: Object.fromEntries(LAYERS.filter((l) => !l.fixed).map((l) => [l.id, !!l.on])),
    colors: Object.fromEntries(LAYERS.map((l) => [l.id, l.color])),
  },
  gpx: null,
  gpxName: '',
  model: null,
  abort: null,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- map
const map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([47.3769, 8.5417], 14);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
let rectLayer = null;
let gpxLayer = null;

function setBBox(b, { fit = false } = {}) {
  state.bbox = b;
  rectLayer?.remove();
  rectLayer = L.rectangle([[b.south, b.west], [b.north, b.east]], { color: '#2f7d5b', weight: 2, fillOpacity: 0.08 }).addTo(map);
  if (fit) map.fitBounds(rectLayer.getBounds(), { padding: [30, 30] });
  updateAreaInfo();
  const u = new URL(location.href);
  u.searchParams.set('area', [b.west, b.south, b.east, b.north].map((v) => v.toFixed(5)).join(','));
  history.replaceState(null, '', u);
}

function updateAreaInfo() {
  const el = $('area-info');
  if (!state.bbox) { el.textContent = 'Draw a rectangle on the map.'; $('generate').disabled = true; return; }
  const { width, height } = bboxSizeMeters(state.bbox);
  const wMM = state.settings.widthMM;
  const hMM = (height / width) * wMM;
  const scale = Math.round(width / (wMM / 1000));
  const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
  const tooBig = width / 1000 > MAX_SIDE_KM || height / 1000 > MAX_SIDE_KM;
  const osmOff = width / 1000 > MAX_OSM_SIDE_KM || height / 1000 > MAX_OSM_SIDE_KM;
  el.innerHTML = `${km(width)} × ${km(height)} → <b>${wMM} × ${hMM.toFixed(0)} mm</b>, scale 1:${scale.toLocaleString()}` +
    (tooBig ? `<br><span class="error">Area too large (max ${MAX_SIDE_KM} km per side).</span>` : '') +
    (!tooBig && osmOff ? `<br><span class="muted">Larger than ${MAX_OSM_SIDE_KM} km: only terrain (and GPX) will be generated.</span>` : '');
  $('generate').disabled = tooBig || !!state.abort;
}

// rectangle drawing with pointer events (works with mouse, pen and touch)
let drawing = false;
$('draw').addEventListener('click', () => {
  drawing = !drawing;
  $('map').classList.toggle('drawing', drawing);
  $('draw').textContent = drawing ? 'Drag on the map…' : 'Draw rectangle';
  if (drawing) { map.dragging.disable(); map.boxZoom.disable(); } else { map.dragging.enable(); map.boxZoom.enable(); }
});
{
  let start = null;
  let temp = null;
  const el = map.getContainer();
  el.addEventListener('pointerdown', (e) => {
    if (!drawing || e.button > 0) return;
    start = map.mouseEventToLatLng(e);
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    const cur = map.mouseEventToLatLng(e);
    temp?.remove();
    temp = L.rectangle(L.latLngBounds(start, cur), { color: '#2f7d5b', weight: 2, dashArray: '4 4', fillOpacity: 0.05 }).addTo(map);
  });
  el.addEventListener('pointerup', (e) => {
    if (!start) return;
    const end = map.mouseEventToLatLng(e);
    temp?.remove();
    temp = null;
    const b = L.latLngBounds(start, end);
    start = null;
    drawing = false;
    $('map').classList.remove('drawing');
    $('draw').textContent = 'Draw rectangle';
    map.dragging.enable();
    map.boxZoom.enable();
    if (Math.abs(b.getEast() - b.getWest()) < 1e-5 || Math.abs(b.getNorth() - b.getSouth()) < 1e-5) return;
    setBBox({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
  });
}
$('use-view').addEventListener('click', () => {
  const b = map.getBounds().pad(-0.1);
  setBBox({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
});

// ---------------------------------------------------------------- search
$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search-q').value.trim();
  const list = $('search-results');
  if (!q) return;
  list.hidden = false;
  list.innerHTML = '<li>Searching…</li>';
  try {
    const results = await searchPlace(q);
    list.innerHTML = '';
    if (!results.length) list.innerHTML = '<li>No results</li>';
    for (const r of results) {
      const li = document.createElement('li');
      li.tabIndex = 0;
      li.textContent = r.name;
      const go = () => {
        list.hidden = true;
        if (r.bbox) map.fitBounds([[r.bbox[0], r.bbox[2]], [r.bbox[1], r.bbox[3]]], { maxZoom: 16 });
        else map.setView([r.lat, r.lon], 15);
      };
      li.addEventListener('click', go);
      li.addEventListener('keydown', (ev) => ev.key === 'Enter' && go());
      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = `<li class="error">${err.message}</li>`;
  }
});

// ---------------------------------------------------------------- settings UI
const NUM_FIELDS = ['widthMM', 'baseMM', 'cellMM', 'exaggeration', 'buildingScale', 'minBuildingMM', 'roadScale', 'minRoadMM'];

function renderSettings() {
  for (const id of NUM_FIELDS) $(id).value = state.settings[id];
  $('elevation').checked = state.settings.elevation;
  $('elevationSource').value = state.settings.elevationSource;
  $('exaggeration').disabled = !state.settings.elevation;
  $('elevationSource').disabled = !state.settings.elevation;
  $('elev-credit').textContent = state.settings.elevation ? ELEVATION_SOURCES[state.settings.elevationSource].attribution + '.' : '';

  const box = $('layers');
  box.innerHTML = '';
  for (const l of LAYERS) {
    const row = document.createElement('div');
    row.className = 'layer';
    const colorKey = l.part ?? l.id;
    row.innerHTML = l.fixed
      ? `<span></span><span>${l.label}</span>`
      : `<input type="checkbox" id="layer-${l.id}" ${state.settings.layers[l.id] ? 'checked' : ''} /><label for="layer-${l.id}">${l.label}</label>`;
    if (!l.part) {
      const c = document.createElement('input');
      c.type = 'color';
      c.value = state.settings.colors[colorKey];
      c.title = `${l.label} color`;
      c.addEventListener('input', () => { state.settings.colors[colorKey] = c.value; refreshPreviewColors(); });
      row.appendChild(c);
    } else row.appendChild(document.createElement('span'));
    box.appendChild(row);
    row.querySelector('input[type=checkbox]')?.addEventListener('change', (e) => { state.settings.layers[l.id] = e.target.checked; });
  }
}

for (const id of NUM_FIELDS) {
  $(id).addEventListener('change', () => {
    const v = parseFloat($(id).value);
    if (Number.isFinite(v)) state.settings[id] = v;
    $(id).value = state.settings[id];
    updateAreaInfo();
  });
}
$('elevation').addEventListener('change', (e) => { state.settings.elevation = e.target.checked; renderSettings(); });
$('elevationSource').addEventListener('change', (e) => { state.settings.elevationSource = e.target.value; renderSettings(); });

$('gpx').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  const info = $('gpx-info');
  if (!file) return;
  try {
    state.gpx = parseGpx(await file.text());
    state.gpxName = file.name;
    gpxLayer?.remove();
    gpxLayer = L.polyline(state.gpx.map((l) => l.map(([lon, lat]) => [lat, lon])), { color: state.settings.colors.gpx, weight: 4 }).addTo(map);
    const b = linesBBox(state.gpx);
    const padX = (b.east - b.west) * 0.08 || 0.002;
    const padY = (b.north - b.south) * 0.08 || 0.002;
    if (!state.bbox) setBBox({ west: b.west - padX, south: b.south - padY, east: b.east + padX, north: b.north + padY }, { fit: true });
    else map.fitBounds(gpxLayer.getBounds(), { padding: [30, 30] });
    info.hidden = false;
    info.textContent = `${file.name}: ${state.gpx.reduce((n, l) => n + l.length, 0)} points.`;
  } catch (err) {
    state.gpx = null;
    info.hidden = false;
    info.innerHTML = `<span class="error">${err.message}</span>`;
  }
});

// ---------------------------------------------------------------- tabs
function showView(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.view === name);
  $('map').classList.toggle('active', name === 'map');
  $('preview').classList.toggle('active', name === 'preview');
  if (name === 'map') map.invalidateSize();
  else preview.resize();
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showView(b.dataset.view));
const preview = new Preview($('preview'));

// ---------------------------------------------------------------- generate
function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}
function setProgress(f) {
  $('progress').hidden = f == null;
  $('progress').firstElementChild.style.width = `${Math.round((f ?? 0) * 100)}%`;
}

function modelParts() {
  const labels = { terrain: 'Terrain', water: 'Water', green: 'Parks & forest', roads: 'Roads', rail: 'Railways', buildings: 'Buildings', gpx: 'GPX route' };
  return PART_ORDER.map((id) => ({ id, name: id, label: labels[id], color: state.settings.colors[id], mesh: state.model.parts[id] }));
}
function refreshPreviewColors() {
  if (!state.model) return;
  for (const m of preview.group?.children ?? []) m.material.color.set(state.settings.colors[m.name]);
  preview.renderLegend(modelParts());
}

$('generate').addEventListener('click', generate);
$('cancel').addEventListener('click', () => state.abort?.abort());

async function generate() {
  if (!state.bbox) return;
  const bbox = { ...state.bbox };
  const s = structuredClone(state.settings);
  const ctrl = (state.abort = new AbortController());
  $('generate').disabled = true;
  $('cancel').hidden = false;
  for (const b of ['export-3mf', 'export-stl']) $(b).disabled = true;
  const t0 = performance.now();

  try {
    const { width, height } = bboxSizeMeters(bbox);
    const osmAllowed = width / 1000 <= MAX_OSM_SIDE_KM && height / 1000 <= MAX_OSM_SIDE_KM;
    if (!osmAllowed) for (const k of Object.keys(s.layers)) s.layers[k] = false;
    const heightMM = (height / width) * s.widthMM;
    const { cols, rows } = gridSize(s.widthMM, heightMM, s.cellMM);

    let elevation = null;
    if (s.elevation) {
      setStatus('Fetching elevation…');
      setProgress(0);
      const res = await fetchElevationGrid(bbox, cols, rows, {
        sourceId: s.elevationSource,
        signal: ctrl.signal,
        onProgress: (f) => setProgress(f * 0.4),
      });
      elevation = res.grid;
    }

    let features = null;
    const query = buildQuery(bbox, s.layers);
    if (query) {
      setStatus('Fetching OpenStreetMap data… (large cities can take up to a minute)');
      setProgress(0.45);
      features = parseOverpass(await fetchOverpass(query, { signal: ctrl.signal }), { defaultBuildingHeightM: s.defaultBuildingHeightM });
    }

    setStatus('Building 3D model…');
    setProgress(0.8);
    await new Promise((r) => setTimeout(r, 30)); // let the UI paint
    state.model = buildModel({ bbox, settings: s, elevation, cols, rows, features, gpx: state.gpx });
    state.model.bbox = bbox;
    setProgress(1);

    const parts = modelParts();
    showView('preview');
    preview.show(parts, state.model.stats);
    const tris = parts.reduce((n, p) => n + p.mesh.triCount, 0);
    const st = state.model.stats;
    setStatus(
      `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s · ${st.widthMM.toFixed(0)} × ${st.heightMM.toFixed(0)} × ${st.maxZ.toFixed(1)} mm · ` +
      `${tris.toLocaleString()} triangles` +
      (st.elevationRange ? ` · elevation ${Math.round(st.elevationRange[0])}–${Math.round(st.elevationRange[1])} m` : '') +
      (features ? ` · ${features.buildings.length.toLocaleString()} buildings` : '') +
      (!osmAllowed ? ' · area too large for map layers, terrain only' : ''),
    );
    for (const b of ['export-3mf', 'export-stl']) $(b).disabled = false;
  } catch (err) {
    if (ctrl.signal.aborted) setStatus('Cancelled.');
    else { console.error(err); setStatus(err.message || String(err), true); }
  } finally {
    state.abort = null;
    $('cancel').hidden = true;
    setProgress(null);
    updateAreaInfo();
  }
}

// ---------------------------------------------------------------- export
function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const baseName = () => {
  const b = state.model.bbox;
  return `topoforge_${((b.south + b.north) / 2).toFixed(4)}_${((b.west + b.east) / 2).toFixed(4)}`;
};
const attribution = () =>
  'Map data © OpenStreetMap contributors (ODbL)' + (state.settings.elevation ? '; ' + ELEVATION_SOURCES[state.settings.elevationSource].attribution : '');

$('export-stl').addEventListener('click', () => {
  download(writeSTL(modelParts().map((p) => p.mesh), baseName()), `${baseName()}.stl`, 'model/stl');
});
$('export-3mf').addEventListener('click', () => {
  const parts = modelParts().map((p) => ({ name: p.label, color: p.color, mesh: p.mesh }));
  download(write3MF(parts, { title: baseName(), attribution: attribution() }), `${baseName()}.3mf`, 'model/3mf');
});

// ---------------------------------------------------------------- projects
$('save').addEventListener('click', () => {
  const data = { app: 'topoforge', version: 1, bbox: state.bbox, settings: state.settings, gpx: state.gpx, gpxName: state.gpxName };
  download(JSON.stringify(data), 'topoforge-project.json', 'application/json');
});
$('load').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'topoforge') throw new Error('Not a TopoForge project file');
    state.settings = { ...state.settings, ...data.settings, layers: { ...state.settings.layers, ...data.settings?.layers }, colors: { ...state.settings.colors, ...data.settings?.colors } };
    state.gpx = data.gpx ?? null;
    state.gpxName = data.gpxName ?? '';
    gpxLayer?.remove();
    if (state.gpx) gpxLayer = L.polyline(state.gpx.map((l) => l.map(([lon, lat]) => [lat, lon])), { color: state.settings.colors.gpx, weight: 4 }).addTo(map);
    renderSettings();
    if (data.bbox) setBBox(data.bbox, { fit: true });
    setStatus(`Loaded ${file.name}.`);
  } catch (err) {
    setStatus(err.message, true);
  }
  e.target.value = '';
});

// ---------------------------------------------------------------- boot
renderSettings();
{
  const area = new URLSearchParams(location.search).get('area');
  const v = area?.split(',').map(Number);
  if (v?.length === 4 && v.every(Number.isFinite) && v[0] < v[2] && v[1] < v[3]) {
    setBBox({ west: v[0], south: v[1], east: v[2], north: v[3] }, { fit: true });
  }
}
