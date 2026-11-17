# Charlotte Research Map

An interactive map of Charlotte's rail transit and your saved homes.

- **LYNX Blue Line** (light rail, 26 stations) and **CityLYNX Gold Line** (streetcar) drawn as glowing lines, with every stop marked and labeled
- **Saved homes** shown as price pins, each with its distance to the nearest station
- **½-mile walksheds** around every station (toggle)
- Sort homes by nearest station or by price; click a station to see how many saved homes are within ½ mile
- **Builders tab** — saved homes grouped by builder, with confidence (confirmed / likely / not identified), communities, notes and source links; tap a builder to drill down
- **Commute tab** — 2,525 single-family homes + townhomes within a 20-min rush-hour drive or transit ride of Truist Center (214 N Tryon), filterable by mode, type, max price and new construction
- Light and dark mode; on a phone the panel becomes a bottom sheet

## Run it

Requires **Node.js 18 or newer** (check with `node -v`; install the LTS from https://nodejs.org).

```bash
cd app
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173).

## Add your saved homes

Edit `public/data/homes.csv`. One row per home; only `address` is required:

```csv
address,price,beds,baths,sqft,status,url,notes,lat,lng
"123 Example St, Charlotte, NC 28203",525000,3,2,1650,Watching,https://www.zillow.com/homedetails/...,,,
```

Optional builder columns: `builder`, `builder_key`, `builder_confidence`, `community`, `notes`, `sources` (pipe-separated URLs). See `../research/saved-homes-by-builder.md`.

Then fill in coordinates (free U.S. Census geocoder, no API key):

```bash
npm run geocode
```

Reload the map. Tip: open a home on Zillow, copy its address and link into a row, and the map handles the rest.

## Exact transit geometry

`public/data/transit.geojson` starts as a **hand-entered approximation** (station positions within a few hundred feet; the Gold Line has 12 of its stops). The panel shows a warning until you replace it with exact OpenStreetMap data:

```bash
npm run refresh:transit
```

## Files

| Path | What |
|---|---|
| `src/main.js` | Map, layers, panel UI |
| `src/style.css` | Design tokens (light/dark), panel, pins, popups |
| `public/data/homes.csv` | Saved homes + builder, community, confidence, sources |
| `public/data/commute.json` | Homes within 20 min of 214 N Tryon (Zillow, 2026-11-17) |
| `public/data/transit.geojson` | Rail lines and stations |
| `scripts/refresh-transit.mjs` | Pulls exact LYNX geometry from OpenStreetMap |
| `scripts/geocode-homes.mjs` | Adds lat/lng to homes.csv |
| `scripts/seed-transit.mjs` | Regenerates the approximate seed data |

Basemap: CARTO Voyager / Dark Matter (© OpenStreetMap contributors, © CARTO).
