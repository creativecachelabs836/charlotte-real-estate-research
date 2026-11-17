// Fills in missing lat/lng in public/data/homes.csv using the free
// U.S. Census Bureau geocoder (no API key). Run: npm run geocode
import { readFileSync, writeFileSync } from 'node:fs';
import Papa from 'papaparse';

const file = new URL('../public/data/homes.csv', import.meta.url);
const { data, meta } = Papa.parse(readFileSync(file, 'utf8'), { header: true, skipEmptyLines: true });
const fields = [...new Set([...meta.fields, 'lat', 'lng'])];

let filled = 0, failed = [];
for (const row of data) {
  if (row.lat && row.lng) continue;
  if (!row.address) continue;
  const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?' +
    new URLSearchParams({ address: row.address, benchmark: 'Public_AR_Current', format: 'json' });
  try {
    const json = await (await fetch(url)).json();
    const m = json?.result?.addressMatches?.[0];
    if (!m) { failed.push(row.address); continue; }
    row.lat = m.coordinates.y.toFixed(6);
    row.lng = m.coordinates.x.toFixed(6);
    filled++;
    console.log(`✓ ${row.address} → ${row.lat}, ${row.lng}`);
  } catch (e) {
    failed.push(`${row.address} (${e.message})`);
  }
  await new Promise(r => setTimeout(r, 250)); // be polite
}

writeFileSync(file, Papa.unparse(data, { columns: fields }) + '\n');
console.log(`\nGeocoded ${filled}. ${failed.length ? 'Not found:\n  ' + failed.join('\n  ') : 'All rows have coordinates.'}`);
