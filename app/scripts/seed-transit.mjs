// Writes public/data/transit.geojson from hand-entered station lists.
// Coordinates are APPROXIMATE (hand-entered, not surveyed). Run
// `npm run refresh:transit` on a machine with internet access to replace
// this file with exact OpenStreetMap geometry.
import { writeFileSync } from 'node:fs';

const blue = [ // south → north
  ['I-485/South Boulevard', 35.0920, -80.8790],
  ['Sharon Road West', 35.1100, -80.8750],
  ['Arrowood', 35.1250, -80.8730],
  ['Archdale', 35.1440, -80.8740],
  ['Tyvola', 35.1580, -80.8770],
  ['Woodlawn', 35.1720, -80.8822],
  ['Scaleybark', 35.1837, -80.8788],
  ['New Bern', 35.1963, -80.8710],
  ['East/West Boulevard', 35.2036, -80.8640],
  ['Bland Street', 35.2085, -80.8589],
  ['Carson', 35.2129, -80.8539],
  ['Stonewall', 35.2172, -80.8485],
  ['3rd Street/Convention Center', 35.2213, -80.8433],
  ['CTC/Arena', 35.2244, -80.8402],
  ['7th Street', 35.2280, -80.8375],
  ['9th Street', 35.2302, -80.8344],
  ['Parkwood', 35.2386, -80.8241],
  ['25th Street', 35.2445, -80.8160],
  ['36th Street', 35.2498, -80.8090],
  ['Sugar Creek', 35.2580, -80.7977],
  ['Old Concord Road', 35.2697, -80.7869],
  ['Tom Hunter', 35.2779, -80.7783],
  ['University City Boulevard', 35.2866, -80.7665],
  ['McCullough', 35.2969, -80.7565],
  ['JW Clay Boulevard/UNC Charlotte', 35.3068, -80.7472],
  ['UNC Charlotte–Main', 35.3115, -80.7339],
];

const gold = [ // west → east (subset of stops; refresh for the full list)
  ['French Street', 35.2468, -80.8577],
  ['Johnson C. Smith University', 35.2434, -80.8547],
  ['Five Points Plaza', 35.2385, -80.8530],
  ['Johnson & Wales Way', 35.2315, -80.8497],
  ['Mint Street', 35.2290, -80.8459],
  ['Tryon Street', 35.2272, -80.8430],
  ['CTC/Arena', 35.2251, -80.8406],
  ['McDowell Street', 35.2205, -80.8355],
  ['CPCC', 35.2168, -80.8312],
  ['Novant Health Presbyterian', 35.2142, -80.8240],
  ['Hawthorne Lane & 5th Street', 35.2183, -80.8195],
  ['Sunnyside Avenue', 35.2230, -80.8165],
];

const lines = {
  blue: { name: 'LYNX Blue Line', mode: 'Light rail', color: '#1E6FD9', stops: blue },
  gold: { name: 'CityLYNX Gold Line', mode: 'Streetcar', color: '#E0A526', stops: gold },
};

const features = [];
for (const [key, l] of Object.entries(lines)) {
  features.push({
    type: 'Feature',
    properties: { kind: 'line', line: key, name: l.name, mode: l.mode, color: l.color, source: 'approximate' },
    geometry: { type: 'LineString', coordinates: l.stops.map(([, lat, lng]) => [lng, lat]) },
  });
  l.stops.forEach(([name, lat, lng], i) => features.push({
    type: 'Feature',
    properties: { kind: 'station', line: key, lineName: l.name, color: l.color, name, order: i, source: 'approximate' },
    geometry: { type: 'Point', coordinates: [lng, lat] },
  }));
}

const out = new URL('../public/data/transit.geojson', import.meta.url);
writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', generated: 'seed (approximate)', features }, null, 1));
console.log(`Wrote ${features.length} features → ${out.pathname}`);
