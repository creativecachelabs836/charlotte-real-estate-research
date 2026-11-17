// Replaces public/data/transit.geojson with exact LYNX geometry from
// OpenStreetMap (Overpass API). Run on a machine with internet access:
//   npm run refresh:transit
import { writeFileSync } from 'node:fs';

const BBOX = '35.0,-81.0,35.4,-80.6'; // Charlotte / Mecklenburg
const query = `
[out:json][timeout:120];
rel["route"~"^(light_rail|tram)$"](${BBOX})->.routes;
.routes out geom;
node(r.routes)->.stops;
.stops out body;`;

const LINES = {
  blue: { name: 'LYNX Blue Line', mode: 'Light rail', color: '#1E6FD9' },
  gold: { name: 'CityLYNX Gold Line', mode: 'Streetcar', color: '#E0A526' },
};
const lineKey = (tags = {}) =>
  /gold/i.test(`${tags.name} ${tags.ref}`) || tags.route === 'tram' ? 'gold' : 'blue';

const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'data=' + encodeURIComponent(query),
});
if (!res.ok) throw new Error(`Overpass ${res.status}: ${await res.text()}`);
const { elements } = await res.json();

const nodes = new Map(elements.filter(e => e.type === 'node').map(n => [n.id, n]));
const routes = elements.filter(e => e.type === 'relation');
if (!routes.length) throw new Error('No light rail / tram routes found in bbox');

const features = [];
const seenLine = new Set();
const stations = new Map(); // `${key}|${name}` → {sumLat,sumLng,n,order}

for (const r of routes) {
  const key = lineKey(r.tags);
  // Line geometry: one direction per line is enough to draw it.
  if (!seenLine.has(key)) {
    const coords = r.members
      .filter(m => m.type === 'way' && m.geometry && !/platform/.test(m.role))
      .map(m => m.geometry.map(p => [p.lon, p.lat]));
    if (coords.length) {
      seenLine.add(key);
      features.push({
        type: 'Feature',
        properties: { kind: 'line', line: key, ...LINES[key], source: 'openstreetmap' },
        geometry: { type: 'MultiLineString', coordinates: coords },
      });
    }
  }
  // Stops: members with a stop role, de-duplicated by name (both directions).
  r.members
    .filter(m => m.type === 'node' && /^stop/.test(m.role))
    .forEach((m, i) => {
      const n = nodes.get(m.ref);
      const name = n?.tags?.name;
      if (!name) return;
      const id = `${key}|${name}`;
      const s = stations.get(id) ?? { key, name, lat: 0, lng: 0, n: 0, order: i };
      s.lat += n.lat; s.lng += n.lon; s.n += 1;
      stations.set(id, s);
    });
}

for (const s of stations.values()) {
  features.push({
    type: 'Feature',
    properties: {
      kind: 'station', line: s.key, lineName: LINES[s.key].name, color: LINES[s.key].color,
      name: s.name, order: s.order, source: 'openstreetmap',
    },
    geometry: { type: 'Point', coordinates: [s.lng / s.n, s.lat / s.n] },
  });
}

const out = new URL('../public/data/transit.geojson', import.meta.url);
writeFileSync(out, JSON.stringify({
  type: 'FeatureCollection',
  generated: `OpenStreetMap via Overpass, ${new Date().toISOString()}`,
  attribution: '© OpenStreetMap contributors (ODbL)',
  features,
}, null, 1));
console.log(`Lines: ${[...seenLine].join(', ')} · stations: ${stations.size} → ${out.pathname}`);
