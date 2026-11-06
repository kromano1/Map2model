// Place search via the public Nominatim service.
// Usage policy (https://operations.osmfoundation.org/policies/nominatim/):
// max 1 request per second and no search-as-you-type, so we only search on submit.

let lastCall = 0;

export async function searchPlace(query, { signal } = {}) {
  const wait = 1100 - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal, headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const list = await res.json();
  return list.map((r) => ({
    name: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    bbox: r.boundingbox ? r.boundingbox.map(parseFloat) : null, // [south, north, west, east]
  }));
}
