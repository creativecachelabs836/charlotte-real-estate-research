"""Build Red Line (proposed CATS LYNX commuter rail) datasets.

usage: python3 -I research/scripts/build_redline.py <extracted_dir> <red.json>
Writes app/public/data/redline.geojson (line + stations) and
app/public/data/redline_homes.json (SF/townhomes within 1.5 mi of a station).
Station positions are approximate, read from the CATS Red Line map; CATS notes
all stations are being reevaluated during the design update.
"""
import glob, json, math, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
src, red = pathlib.Path(sys.argv[1]), json.load(open(sys.argv[2]))
RADIUS = 1.5

def mi(a, b):
    R, t = 3958.8, math.pi / 180
    dlat, dlng = (b[0] - a[0]) * t, (b[1] - a[1]) * t
    h = math.sin(dlat / 2) ** 2 + math.cos(a[0] * t) * math.cos(b[0] * t) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))

feats = [{'type': 'Feature', 'properties': {'kind': 'line', 'line': 'red', 'name': 'LYNX Red Line (proposed)', 'mode': 'Commuter rail', 'color': '#C8102E', 'status': 'proposed', 'source': 'approximate'},
          'geometry': {'type': 'LineString', 'coordinates': [[s[2], s[1]] for s in red]}}]
for i, (name, lat, lng, status) in enumerate(red):
    feats.append({'type': 'Feature', 'properties': {'kind': 'station', 'line': 'red', 'lineName': 'LYNX Red Line (proposed)', 'color': '#C8102E', 'name': name, 'order': i, 'status': status, 'source': 'approximate'},
                  'geometry': {'type': 'Point', 'coordinates': [lng, lat]}})
(ROOT / 'app/public/data/redline.geojson').write_text(json.dumps({'type': 'FeatureCollection', 'note': 'Proposed alignment; station locations approximate (CATS Red Line map, design update underway).', 'features': feats}, indent=1))

homes = {}
def add(r_or_h, from_commute=False):
    if from_commute:
        h = r_or_h; la, lo = h['la'], h['lo']; rec = dict(h)
    else:
        r = r_or_h; ll = r.get('geoRegion', {}).get('latLong')
        if not ll: return
        la, lo = ll['latitude'], ll['longitude']
        url = r['homeDetailsPageUrl'].split('?')[0]
        rec = {'a': r['formattedAddress']['line1'], 'city': r['formattedAddress'].get('city'), 'z': r['formattedAddress'].get('postalCode'),
               'la': round(la, 5), 'lo': round(lo, 5), 'p': r.get('price', {}).get('filteredPrice') or None,
               'bd': r.get('bedroomCount'), 'ba': r.get('bathroomCount'), 'sf': r.get('livingAreaSquareFeet') or None,
               't': 'T' if r.get('homeType') == 'townhome' else 'S',
               'c': r.get('title') if r.get('fixtureClassification') != 'representative' else None,
               'pl': 1 if r.get('fixtureClassification') == 'representative' else 0,
               'nb': 1 if r.get('newConstruction', {}).get('premierBuilder') else 0,
               'u': url.replace('https://www.zillow.com', '')}
    d, st = min((mi((la, lo), (s[1], s[2])), s[0]) for s in red)
    if d > RADIUS: return
    rec['st'] = st; rec['d'] = round(d, 2)
    homes.setdefault(rec['u'], rec)

for f in glob.glob(str(src / '*.json')):
    d = json.load(open(f))
    if d['request']['request'].get('propertySearchRegionFiltersRequest', {}).get('customPolygonWKT'):
        for x in d['results']: add(x['result'])
# Gateway / Camp North End: reuse the in-city commute dataset
for h in json.load(open(ROOT / 'app/public/data/commute.json'))['homes']:
    add(h, from_commute=True)

out = {'radius_mi': RADIUS, 'source': 'Zillow (via Claude connector), pulled 2026-11-17',
       'coverage': 'Complete except Harris (100 of 108) and Huntersville (100 of 101); Gateway and Camp North End use the 20-min commute dataset.',
       'homes': sorted(homes.values(), key=lambda h: (h['st'], h['d']))}
(ROOT / 'app/public/data/redline_homes.json').write_text(json.dumps(out, separators=(',', ':')))
from collections import Counter
c = Counter(h['st'] for h in homes.values())
print(len(homes), 'homes'); [print(f'  {s[0]:<26} {c.get(s[0],0)}') for s in red]
