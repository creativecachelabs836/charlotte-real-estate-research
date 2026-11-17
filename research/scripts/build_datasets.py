"""Build app datasets from extracted Zillow searches + researched builder info.

usage: python3 -I research/scripts/build_datasets.py <extracted_dir>
Writes:
  app/public/data/homes.csv     saved homes, grouped by builder
  app/public/data/commute.json  every SF/townhome within 20 min of 214 N Tryon
"""
import csv, glob, json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
src = pathlib.Path(sys.argv[1])

# ---------- Commute set ----------
homes = {}
for f in glob.glob(str(src / '*.json')):
    d = json.load(open(f))
    pf = d['request']['request'].get('propertyFiltersRequest', {})
    mode = pf.get('commuteTimeFilter', {}).get('mode')
    if mode not in ('driving', 'transit'):
        continue
    bit = 1 if mode == 'driving' else 2
    for x in d['results']:
        r = x['result']
        url = r.get('homeDetailsPageUrl', '').split('?')[0]
        ll = r.get('geoRegion', {}).get('latLong')
        if not url or not ll:
            continue
        h = homes.setdefault(url, {
            'a': r['formattedAddress']['line1'],
            'z': r['formattedAddress'].get('postalCode'),
            'la': round(ll['latitude'], 5), 'lo': round(ll['longitude'], 5),
            'p': r.get('price', {}).get('filteredPrice') or None,
            'bd': r.get('bedroomCount'), 'ba': r.get('bathroomCount'),
            'sf': r.get('livingAreaSquareFeet') or None,
            't': 'T' if r.get('homeType') == 'townhome' else 'S',
            'c': r.get('title') if r.get('fixtureClassification') != 'representative' else None,
            'pl': 1 if r.get('fixtureClassification') == 'representative' else 0,
            'nb': 1 if r.get('newConstruction', {}).get('premierBuilder') else 0,
            'u': url.replace('https://www.zillow.com', ''),
            'm': 0,
        })
        h['m'] |= bit

commute = {
    'destination': {'name': 'Truist Center · 214 N Tryon St', 'lat': 35.2285, 'lng': -80.8424},
    'criteria': 'Single-family + townhome for sale; Zillow commute filter ≤20 min (driving, rush hour) or ≤20 min (transit, rush hour)',
    'source': 'Zillow (via Claude connector), pulled 2026-11-17',
    'coverage': 'Transit: 38/38. Driving: complete ≤ $600K except 5 homes in $438–450K; above $600K 300 of ~612 (Zillow returns max 100 per query).',
    'homes': list(homes.values()),
}
out = ROOT / 'app/public/data/commute.json'
out.write_text(json.dumps(commute, separators=(',', ':')))
n_t = sum(1 for h in homes.values() if h['m'] & 2)
print(f'commute.json: {len(homes)} homes ({n_t} transit) → {out}')

# ---------- Saved homes ----------
B = {  # builder key → display info
    'ryan': 'Ryan Homes', 'drb': 'DRB Homes', 'lennar': 'Lennar', 'weekley': 'David Weekley Homes',
    'brookline': 'Brookline Homes', 'true': 'True Homes', 'northway': 'Northway Homes',
    'blueheel': 'Blue Heel Development', 'smithdouglas': 'Smith Douglas Homes',
    'infill': 'Infill builder (not identified)', 'resale': 'Resale — original builder not on record',
}
# address, builder key, confidence, community, status/built, coord quality, lat, lng, price, beds, baths, sqft, type, notes, sources
saved = [
 ('2928 Mulberry Church Rd, Charlotte, NC 28208','infill','unknown','9-home infill (Sloan Dr / Mulberry Church Rd)','New construction 2026',None,None,None,None,None,None,None,None,'Small 9-home development; no HOA; builder warranty advertised. Listing agent: EXP Realty (MLS 4384174).','https://www.johnkurtzhomes.com/listings/2928-mulberry-church-road-charlotte-242359362|https://www.houzeo.com/homes/2928-mulberry-church-rd-charlotte-nc-28208/hzid_3386d306'),
 ('4031 Bass River Pkwy, Charlotte, NC 28217','blueheel','likely','Towne Living at City Park','New construction','exact',None,None,None,None,None,None,None,'Zillow plan listing "The Mordecai Plan, Towne Living at City Park" matches this home (1,884 sqft). Neighbors 4055/4059 list Blue Heel Development, Mordecai model. HOA $247/mo.','https://www.zillow.com/homedetails/4031-Bass-River-Pkwy-Charlotte-NC-28217/464664793_zpid|https://www.palmettopark.com/homes/charlotte/4059-bass-river-parkway'),
 ('9926 Wildwood Muse Ct, Charlotte, NC 28273','resale','n/a','Wildwood Meadows','Resale · built 1998','exact',None,None,None,None,None,None,None,'Lot ~0.35 ac. Price reduced per listing history.','https://www.sinkorealty.com/property/9926-wildwood-muse-court-charlotte-nc-28273/CAR293753117'),
 ('7402 Shiras Ct, Charlotte, NC 28273','resale','n/a','Deercreek','Resale · built 1996','exact',None,None,None,None,None,None,None,'Was previously listed as a rental ($2,250–2,300/mo).','https://www.zillow.com/homedetails/7402-Shiras-Ct-Charlotte-NC-28273/6285428_zpid|https://apartmentlist.com/nc/charlotte/7402-shiras-court'),
 ('5023 American Bittern Ln, Charlotte, NC 28214','brookline','likely','Redwood Rookery at The Vineyards','Resale · built 2022','exact',None,None,None,None,None,None,None,'Community built 2022–23 by Brookline Homes; lake-access amenities on Lake Wylie.','https://www.palmettopark.com/charlotte/redwood-rookery-at-the-vineyards|https://www.homesbymarco.com/models/raven-model-by-brookline-homes-3211747/redwood-rookery-at-the-vineyards-in-charlotte-nc'),
 ('4014 Edenborn Ln, Charlotte, NC 28208','ryan','likely','Villages at Beachmont','Townhome','exact',None,None,None,None,None,None,None,'Zillow tags community "Villages at Beachmont" — a Ryan Homes community.','https://jome.com/community/nc/184313-villages-at-beachmont-by-ryan-homes-charlotte-nc|https://sellhomes4u.realgeeks.com/property/4406016/'),
 ('2406 Newland Rd, Charlotte, NC 28216','infill','unknown','—','New construction 2026','exact',None,None,None,None,None,None,None,'Listing brokerage Zoraida Delgado Payne RE (MLS 4382166, parcel 077-015-46). Price cut from $410K.','https://www.coldwellbankerhomes.com/nc/charlotte/2406-newland-rd/pid_71394420/|https://jome.com/new-home/nc/2583027-2406-newland-rd-charlotte-nc-28216'),
 ('2093 Custer St, Charlotte, NC 28216','infill','unknown','Historic West End townhomes (Custer St)','New construction townhome','exact',None,None,None,None,None,None,None,'Part of a ~26-townhome Custer St project; builder not named in listings.','https://www.exprealty.com/charlotte-nc-real-estate/2025-custer-street|https://rumblingbald.com/nc/charlotte/2081-custer-street'),
 ('3027 Rozzelles Ferry Rd, Charlotte, NC 28208','drb','confirmed','Greenway Overlook','New construction · Landon plan','exact',None,None,None,None,None,None,None,'58-unit townhome community. Sales center 2039 Near Point Rd. Price cut from $409,900.','https://www.newhomesource.com/specdetail/3027-rozzelles-ferry-rd-charlotte-nc-28208/3180308'),
 ('2655 Spinalis St, Charlotte, NC 28215','smithdouglas','likely','Smith Douglas (likely Ember Glen area)','New construction (Zillow "Paid Builder" listing)','approx',35.2232,-80.6760,None,None,None,None,'T','Zillow flags it a builder-paid listing; Smith Douglas lists neighbor 2679 Spinalis at $268,990. Location approximate.','https://www.smithdouglas.com/homes/undefined/undefined/undefined/2679-spinalis-street|https://www.smithdouglas.com/communities/charlotte-nc/charlotte/ember-glen'),
 ('8121 McGarry Trl #188, Charlotte, NC 28214','lennar','confirmed','The Vines — Chase','New construction · Taggart plan (end unit)','exact',None,None,None,None,None,None,None,'Sales office 8116 McGarry Trl. Neighbor HOA $224/mo.','https://www.newhomesource.com/specdetail/8121-mcgarry-trail-charlotte-nc-28214/3229209|https://www.lennar.com/new-homes/north-carolina/charlotte/charlotte/the-vines/chase/taggart/24890600190'),
 ('9710 Warriors Way Rd, Charlotte, NC 28269','ryan','likely','Eastfield Station','New construction townhome','exact',None,None,None,None,None,None,None,'Jome lists Eastfield Station (9706 Warriors Way Rd) as a Ryan Homes community from $359,990.','https://jome.com/plan/nc/2737305-mendelssohn|https://www.zillow.com/homedetails/9710-Warriors-Way-Rd-Charlotte-NC-28269/466454951_zpid'),
 ('1126 Bismuth Ln, Charlotte, NC 28211','weekley','likely','Central Living at Craig','New construction townhome','approx',35.18618,-80.78505,None,None,None,None,'T','Not listed on Zillow (no zpid). Neighbors 1128/1132/1136/1140 are David Weekley Homes; 1128 is $429,451, 3 bd/4 ba/1,947 sqft. Sales center 3916 Craig Ave.','https://jome.com/new-home/nc/2485136-1136-bismuth-ln-charlotte-nc-28211|https://www.newhomesource.com/specdetail/1128-bismuth-lane-charlotte-nc-28211/3205154'),
 ('6408 Rockwell Church Rd, Charlotte, NC 28269','infill','unknown','—','Single-family (paired with 6400 at $339K)','exact',None,None,None,None,None,None,None,'Builder not found in public listings.','https://www.zillow.com/homedetails/6408-Rockwell-Church-Rd-Charlotte-NC-28269/465893464_zpid'),
 ('2920 Capitol Dr, Charlotte, NC 28208','northway','confirmed','Capitol Dr townhomes','New construction townhome','exact',None,None,None,None,None,None,None,'NewHomeSource plan listing by Northway Homes (base $330K, 3 bd/2.5 ba, 1-car garage).','https://www.newhomesource.com/plan/2920-capitol-dr-charlotte-nc-28208-northway-homes-charlotte-nc/3836844'),
 ('1679 Sanridge Wind Ln, Charlotte, NC 28262','resale','n/a','Claybrooke','Resale · ~2001 (Zillow "Showcase" listing)','exact',None,None,None,None,None,None,None,'0.47 ac lot.','https://www.zillow.com/homedetails/1679-Sanridge-Wind-Ln-Charlotte-NC-28262/80467217_zpid'),
 ('12037 Basking Dr, Charlotte, NC 28214','true','confirmed','The Landings at Catawba River','Resale · built ~2022','exact',None,None,None,None,None,None,None,'True Homes townhome community near Mountain Island Lake; HOA ~$175/mo.','https://truehomes.com/new-home-communities/the-landings-at-catawba-river|https://www.zillow.com/homedetails/12037-Basking-Dr-Charlotte-NC-28214/2060938682_zpid'),
 ('14033 Pinyon Pine Ln, Charlotte, NC 28215','resale','n/a','Kingstree','Resale · ~2005','approx',35.23225,-80.67732,None,None,None,None,'S','For sale on Zillow; price not available to this connector. Location approximate (next to 14021).','https://www.redfin.com/sitemap/3105/NC/Mecklenburg-County/Charlotte/street/Pinyon+Pine+Ln'),
 ('7334 Reynard Ln, Charlotte, NC 28215','resale','n/a','Bradfield Farms','Resale · built 1990','approx',35.2513,-80.6458,429999,3,2,2151,'S','Price from Coldwell Banker (Mar 2026). Location approximate (near 7300 Reynard).','https://www.coldwellbankerhomes.com/nc/charlotte/7334-reynard-ln/pid_70091196'),
]

# Fill Zillow fields for exact matches
def find(addr_line1):
    for f in glob.glob(str(src / '*.json')):
        for x in json.load(open(f))['results']:
            r = x['result']
            if r['formattedAddress']['line1'].lower() == addr_line1.lower():
                return r
    return None

rows = []
for (addr, bk, conf, comm, status, cq, lat, lng, price, bd, ba, sf, typ, notes, srcs) in saved:
    line1 = addr.split(',')[0]
    r = find(line1)
    url = ''
    if r:
        ll = r.get('geoRegion', {}).get('latLong', {})
        lat = lat or ll.get('latitude'); lng = lng or ll.get('longitude')
        price = price or r.get('price', {}).get('filteredPrice')
        bd = bd or r.get('bedroomCount'); ba = ba or r.get('bathroomCount')
        sf = sf or r.get('livingAreaSquareFeet')
        typ = typ or ('T' if r.get('homeType') == 'townhome' else 'S')
        url = r['homeDetailsPageUrl'].split('?')[0]
        cq = cq or 'exact'
    m = homes.get(url, {}).get('m', 0) if url else 0
    if not url and bk == 'weekley':  # 1126 Bismuth: unlisted; next-door 1128 qualifies
        m = homes.get('https://www.zillow.com/homedetails/1128-Bismuth-Ln-Charlotte-NC-28211/460716259_zpid', {}).get('m', 0)
    rows.append({
        'address': addr, 'builder': B[bk], 'builder_key': bk, 'builder_confidence': conf,
        'community': comm, 'status': status, 'price': price or '', 'beds': bd or '', 'baths': ba or '',
        'sqft': sf or '', 'type': {'T': 'Townhome', 'S': 'Single-family'}.get(typ, ''),
        'drive_20': 'yes' if m & 1 else 'no', 'transit_20': 'yes' if m & 2 else 'no',
        'url': url or srcs.split('|')[0], 'notes': notes, 'sources': srcs,
        'lat': lat or '', 'lng': lng or '', 'coords': cq or '',
    })

with open(ROOT / 'app/public/data/homes.csv', 'w', newline='') as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)
print(f'homes.csv: {len(rows)} saved homes; ' + ', '.join(f"{r['address'].split(',')[0]}={r['drive_20']}" for r in rows if r['drive_20']=='yes'))
