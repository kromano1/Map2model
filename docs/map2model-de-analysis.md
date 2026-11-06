# Technical analysis of www.map2model.de

Analysed on 2026-11-06 from the public HTML, `robots.txt`, `sitemap.xml`,
`llms.txt`, the web manifest and the client-side JavaScript bundles the site
serves to every visitor. No login, private endpoint or server code was
accessed. This document describes how the site works in our own words; it
does not include the site's source code.

## 1. What the product is

A free, browser-based tool that turns a selected area of a real map into a
3D-printable model (city buildings and/or terrain relief). Output is a
multicolor **3MF** (separate parts per feature class, for AMS/MMU printers) or
a single merged **STL**. No account. Personal use is free; selling prints
requires a commercial license (contact via the Commercial Use page).

It describes itself as an independent successor to smoggy3d's original
map2model.com, which went offline. Launched 2026-06-26 (per the changelog).

## 2. Hosting and stack

| Layer | Finding | Evidence |
|---|---|---|
| Hosting | Vercel (edge cache, `iad1` region seen) | `server: Vercel`, `x-vercel-*` headers |
| Framework | Next.js App Router, built with Turbopack, statically prerendered pages | `/_next/static/chunks/*`, `turbopack-*.js`, `x-nextjs-prerender: 1`, RSC `vary` headers |
| UI | React, Tailwind-style utility classes, Geist font, Lucide icons, light/dark theme | HTML classes, attribution page |
| 2D map | Leaflet, OSM raster tiles (`{s}.tile.openstreetmap.org`), Esri World Imagery as satellite basemap | bundle strings |
| 3D preview | three.js via react-three-fiber, OrbitControls | bundle strings |
| Geometry | three.js `ExtrudeGeometry`, `ShapeUtils` (triangulation), `BufferGeometryUtils` (merging), `TextGeometry` (frame text) | bundle strings |
| Zip/3MF | fflate (worker-based zip; its blob-worker error pattern is in the bundle) | bundle strings |
| Analytics | Vercel Web Analytics | `va.vercel-scripts.com` reference |
| State | `localStorage` for settings; Save/Load Project to a local file | UI labels, bundle |
| Payments | None found | no Stripe/Paddle/etc. |

## 3. Routes

From the sitemap and footer: `/` (the editor plus landing copy), `/guide`,
`/guide/how-to-3d-print-a-map-of-your-city`,
`/guide/how-to-print-a-multicolor-3mf-map`, `/guide/3d-print-gpx-route-map`,
`/map-to-stl`, `/3d-print-terrain-map`, `/map2model-com`, `/alternatives`,
`/faq`, `/about`, `/commercial-use`, `/terms`, `/attribution`, `/changelog`,
`/report`. Most of these are SEO landing/guide pages. There is also an
`llms.txt` aimed at AI assistants.

Deep link: `/?area=west,south,east,north` (WGS84) opens the editor with that
bounding box preselected.

### Server API routes (the only server-side pieces)

| Route | Method | Purpose |
|---|---|---|
| `/api/osm` | POST, form-encoded `data=<Overpass QL>` | Proxy to an Overpass API instance. Returns Overpass JSON. A 403 produces the client error "Map data is unavailable here…", i.e. it refuses requests that are not from the official origin. |
| `/api/gate` | GET, `no-store` | Returns `{"ok":true}`. The client calls it before generating and caches a pass for 15 minutes; if it fails, generation is blocked ("Model generation is currently unavailable. Use the app at map2model.de."). This is an anti-mirroring/kill-switch check. |

Everything else (elevation, imagery, geocoding) is fetched by the browser
directly from third parties.

## 4. Data sources

| Data | Source | Notes |
|---|---|---|
| Vector features | OpenStreetMap via Overpass (proxied through `/api/osm`) | one combined query per area, `[out:json][timeout:60]`, `out geom` |
| Elevation (default) | Mapterhorn: `tiles.mapterhorn.com/{z}/{x}/{y}.webp` | Terrarium encoding, 512 px tiles, z0–15 |
| Elevation (alternative) | AWS Terrain Tiles: `elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png` | Terrarium, 256 px, z0–15 |
| Satellite texture | Esri World Imagery tiles | draped over terrain in "Satellite" color mode |
| Geocoding | Nominatim `/search?format=json&limit=5&q=…` | address search box |

Terrarium decoding is the standard formula: `height = R*256 + G + B/256 − 32768`
metres (a Mapbox Terrain-RGB branch also exists in the decoder).

## 5. OSM feature extraction

The Overpass query is assembled from the layers the user enables, all
filtered by the bbox:

- **Buildings**: `way`/`relation` with `building` (excluding `no`, `entrance`).
- **Roads**: `way[highway]`.
- **Railways**: rail, light_rail, subway, tram, monorail, narrow/standard gauge, funicular.
- **Aeroways**: runway, taxiway, taxilane, stopway.
- **Ski runs**: `piste:type`.
- **Piers**: `man_made=pier|breakwater`.
- **Water**: `natural=water`, `waterway`.
- **Greenery**: parks, `landuse=forest|grass|meadow|recreation_ground|village_green`, `natural=wood`.
- **Sand**: `natural=beach|sand`, `landuse=sand`.

Multipolygon relations are resolved into outer/inner rings (holes assigned
by point-in-ring), so courtyards and parks with holes come out correctly.

**Building height heuristic**: `height` tag (capped at 600 m) → else
`building:levels × 3 m` → else 8 m default. `min_height` /
`building:min_level × 3` give raised bottoms (bridges, overhangs).
`roof:shape` maps to flat / gabled / pyramidal; `roof:height` is used when
present; `building:colour` is read.

**Road width**: `width` tag if present, else a per-class default in metres
(roughly 14 for motorways down to 2 for footways/paths, 1.5 for steps).

## 6. Generation pipeline (client side)

1. User searches (Nominatim) and draws an area: rectangle, square, circle,
   hexagon or polygon, or a fixed "Custom Size" km rectangle. Touch drawing
   is supported.
2. Gate check (`/api/gate`).
3. Progress steps: "Fetching map data" → "Fetching elevation data" →
   (optional) "Fetching satellite imagery" → "Building the 3D model".
   Cancellable.
4. Elevation tiles covering the area are decoded into a height grid; the
   terrain is a triangulated surface with side walls and a base of chosen
   thickness. Vertical exaggeration is auto-suggested from the relief.
5. Footprints are projected (Web Mercator) into model millimetres, extruded
   to scaled heights, and seated on the terrain surface (sampling terrain
   height under the footprint). Roads/rails/paths are buffered into strips
   and laid on the surface; water bodies are flattened to one shared level
   per connected water body.
6. Addons: GPX route embossed as its own part, frame with text, scale bar
   (chosen from a 10 m…50 km "nice number" list) and north arrow, custom
   buildings, custom lines, landmarks.
7. Optional tiling into rows × columns, optionally as interlocking jigsaw
   pieces (tab size, spacing, rounded corners), with "export single tile".
8. Export:
   - **STL**: all parts merged into one body.
   - **3MF**: a zip (fflate) with `[Content_Types].xml`, `_rels/.rels` and
     `3D/3dmodel.model` using the 3MF core namespace, one object per part
     (terrain, buildings, water, roads, greenery, frame, route, …) so slicers
     can assign one filament per part. A color legend in the export menu
     shows which part maps to which slot.

## 7. User-facing parameters (editor tabs)

- **Model**: model width, base thickness, base color, topography
  (exaggeration, flatten sea, include ocean, "topography only"), color mode
  (solid / elevation bands with snow line / satellite with brightness),
  cliff/base color, tiles & puzzle, brim (width, height), separate parts.
- **Layers**: buildings (height scale, size scale, minimum height, hide
  smaller than, real roofs, bridges, bridge overhangs), roads per class
  (motorway, trunk, primary, secondary, tertiary, residential, service,
  cycleway, footway/path, width multiplier), water (hide smaller than),
  greenery with trees (tree height/radius), sand, railways, aeroways, ski
  runs, piers.
- **Addons**: GPX route (color, width, depth), frame text, scale bar, north
  arrow, custom buildings, custom lines, landmarks.
- Map preview / 3D preview toggle, Generate Mesh, Export, Save/Load Project.

## 8. Observations relevant to building our own tool

- The heavy lifting is entirely client side; a comparable app needs only
  static hosting plus (optionally) an Overpass proxy for rate limiting and
  caching.
- Data dependencies are all open: OSM (ODbL, attribution required),
  Mapterhorn / AWS Terrain Tiles, Nominatim (usage policy: max 1 req/s,
  identify the app), Esri imagery (check terms before use).
- The site's own code is not open source, carries an anti-mirroring gate,
  and its terms restrict commercial use. An independent implementation should
  be written from scratch on the open data sources and libraries above
  (Leaflet or MapLibre, three.js, fflate, earcut, etc.), not copied from the
  site's bundles, and should use its own name and branding.

---

# Appendix: the original map2model.com (smoggy3d)

Source: a Safari `.webarchive` of the Wayback Machine summary page for
map2model.com, provided by the user. It contained the original site's main
app bundle (`/assets/index-BlT0JDrb.js`, ~2.8 MB, Wayback capture
2026-01-19) plus its cookie-consent config. The latest snapshot the Wayback
API reports is 2026-09-16. The live Wayback Machine could not be reached from
this environment, so other pages and lazy-loaded chunks (About, Changelog,
the turf worker) were not inspected. As above, this is a description, not a
copy of the code.

## Stack

| Layer | map2model.com (original) | map2model.de (successor) |
|---|---|---|
| Framework | Vue 3.5 SPA built with Vite, Vue Router, Pinia | Next.js (React) on Vercel |
| UI kit | PrimeVue + Tailwind, Inter font | Tailwind, Geist, Lucide |
| 2D map | Leaflet + Leaflet-Geoman (draw/edit tools, many languages); OSM, OSM-France and OSM-DE tile servers | Leaflet; OSM + Esri imagery |
| 3D | three.js with OrbitControls | three.js via react-three-fiber |
| Geometry | Turf.js run in a pool of Web Workers (up to 8, one per core), a Clipper-style polygon clipping port, three.js extrusion | three.js extrusion/triangulation helpers |
| Elevation | **Own backend**: `POST https://topoapi.map2model.com/elevation` with a list of lat/lng points; response `{status:"OK", results:[{elevation, location}]}` (Google-Elevation-API-like shape) | Mapterhorn / AWS Terrarium tiles fetched by the browser |
| OSM data | Browser calls Overpass directly: overpass-api.de, falling back to overpass.private.coffee and overpass.osm.jp | Proxied through its own `/api/osm` |
| Geocoding | Nominatim | Nominatim |
| Monetization | Google AdSense side card, Buy Me a Coffee link, "Commercial License" page | No ads; commercial license by e-mail |
| Consent / analytics | Cookiebot, Google tag (gtag) | Vercel Analytics |

Routes: `/`, `/about`, `/changelog`, `/privacy-policy`, `/contact`,
`/commercial-license`.

Notable detail: on load the app calls Cloudflare's public `cdn-cgi/trace`
endpoints (several mirrors, first success wins) to read the visitor's country
code. If the country is **not** an EU member state, a "Commercial License"
item is added to the navigation; EU visitors don't see it.

## Workflow and features

1. Search an address (Nominatim) or pan the map; draw a rectangle, circle,
   polygon or hexagon, or set a custom size. Selections larger than
   **150 km × 150 km** are rejected ("Area Too Large").
2. "Generate Mesh": progress messages "Processing features…",
   "Processing terrain…".
3. Terrain: the bbox is sampled as a regular grid of points (the grid is
   thinned when it would exceed a point budget), sent to the elevation API,
   smoothed with a median filter (radius setting), scaled by an exaggeration
   factor and built into a surface over a base. On API failure it falls back
   to a flat base.
4. OSM layers fetched in one Overpass query (`[out:json][timeout:30]`,
   `out geom qt`), toggled per layer: buildings (with roofs), roads (with
   per-type selection, link roads, footpaths, underground roads), railways
   (incl. monorail etc.), aeroways, waterways, water (with "Cut Out Water"
   and a water base), ocean via coastlines, greenery (parks, grass,
   farmland, orchards, vineyards, golf, camping…), beaches/sand, piers.
5. Addons: GPX path (upload, color, height, thickness), frame (color,
   height, thickness), map-wide buildings scale, an in-app building editor
   ("Edit Shape", "Add Point").
6. Export: **3MF**, **STL**, or **split STL (ZIP)** (one STL per part).
   The 3MF uses the core + production extension namespaces plus the
   slic3r/PrusaSlicer namespace, and identifies itself as written by Bambu
   Studio, so Bambu/Prusa slicers open it as a multi-part, multi-color
   project.
7. Save / Load Project.

## Default print parameters found in the bundle (mm unless noted)

Map width 150 · base layer 1 · min building height 1 · road height 0.6
(road depth 0) · water height 0.4, water depth 0.8, water base 0.2 ·
greenery 0.4 · beach 0.2 · pier 0.8 · GPX path height 1 · frame height 1.4,
frame thickness 3 · printable height 256 · elevation exaggeration 1 · median
filter radius 1.

## What the successor changed

- Replaced the private elevation API with public terrain tiles, and moved
  Overpass behind a server proxy (plus an anti-mirroring gate).
- Rewrote the app in React/Next.js; no ads.
- Added: elevation-band and satellite coloring, scale bar / north arrow /
  frame text, tiling and jigsaw puzzles, auto exaggeration, ski runs.
- Dropped/changed: split-STL ZIP export, the EU-gated commercial license
  page, and project-file compatibility with the original.

## Implications for an independent rebuild

The original depended on `topoapi.map2model.com`, which is presumably gone
with the site, so any rebuild needs its own elevation source (Mapterhorn or
AWS Terrarium tiles work client-side with no backend). Everything else
(Overpass, Nominatim, Leaflet, three.js, Turf, a 3MF zip writer) is open
and can be assembled from scratch.
