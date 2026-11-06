// Minimal GPX reader: returns track / route lines as arrays of [lon, lat].

export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not a valid GPX file');
  const lines = [];
  const collect = (nodes) => {
    const pts = [];
    for (const n of nodes) {
      const lat = parseFloat(n.getAttribute('lat'));
      const lon = parseFloat(n.getAttribute('lon'));
      if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lon, lat]);
    }
    if (pts.length >= 2) lines.push(pts);
  };
  for (const seg of doc.getElementsByTagName('trkseg')) collect(seg.getElementsByTagName('trkpt'));
  for (const rte of doc.getElementsByTagName('rte')) collect(rte.getElementsByTagName('rtept'));
  if (!lines.length) throw new Error('No track or route points found in GPX');
  return lines;
}

export function linesBBox(lines) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const l of lines) for (const [lon, lat] of l) {
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  }
  return { west, south, east, north };
}
