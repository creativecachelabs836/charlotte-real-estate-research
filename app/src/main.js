import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import Papa from 'papaparse';
import './style.css';

// ---------- Config ----------
const STYLES = {
  light: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};
const CLT_CENTER = [-80.8431, 35.2271];
const WALKSHED_MI = 0.5;
const WALK_MIN_PER_MI = 20;
const ZILLOW = 'https://www.zillow.com';

const BUILDER_COLORS = {
  ryan: '#D1495B', drb: '#00798C', lennar: '#6A4C93', weekley: '#E09F3E', brookline: '#2E9D5B',
  true: '#3D5A80', northway: '#C05299', blueheel: '#1982C4', smithdouglas: '#8D6E63',
  infill: '#8E8E93', resale: '#A89F94',
};
const CONFIDENCE = {
  confirmed: { label: 'Confirmed', cls: 'ok' },
  likely: { label: 'Likely', cls: 'warn' },
  unknown: { label: 'Not identified', cls: 'muted' },
  'n/a': { label: 'Resale', cls: 'muted' },
};

const state = {
  theme: loadPref('theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  layers: { blue: true, gold: true, red: true, homes: true, commute: true, redhomes: true, walksheds: false, ...loadPref('layers') },
  tab: loadPref('tab') ?? 'builders',
  builder: null,
  commuteFilter: { mode: 'all', type: 'all', max: 0, newOnly: false, ...loadPref('commuteFilter') },
  transit: null, stations: [], homes: [], commute: null,
  red: null, redStations: [], redHomes: null, redStation: null,
  redFilter: { type: 'all', max: 0, ...loadPref('redFilter') },
  markers: new Map(), activeId: null, popup: null,
};

// ---------- Helpers ----------
function loadPref(k) { try { return JSON.parse(localStorage.getItem('cltmap.' + k)); } catch { return null; } }
function savePref(k, v) { try { localStorage.setItem('cltmap.' + k, JSON.stringify(v)); } catch {} }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const fmtPrice = p => !p ? '—' : p >= 1e6 ? `$${(p / 1e6).toFixed(2).replace(/\.?0+$/, '')}M` : `$${Math.round(p / 1e3)}K`;
const fmtMi = d => d < 0.1 ? `${Math.round(d * 5280)} ft` : `${d.toFixed(1)} mi`;
const facts = h => [h.beds && `${h.beds} bd`, h.baths && `${h.baths} ba`, h.sqft && `${Number(h.sqft).toLocaleString()} sqft`].filter(Boolean).join(' · ');
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function haversineMi([lng1, lat1], [lng2, lat2]) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function circlePolygon([lng, lat], radiusMi, steps = 64) {
  const dLat = radiusMi / 69.0, dLng = radiusMi / (69.172 * Math.cos(lat * Math.PI / 180));
  const ring = [];
  for (let i = 0; i <= steps; i++) { const t = (i / steps) * 2 * Math.PI; ring.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]); }
  return [ring];
}
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function nearestRed(lngLat) {
  let best = null;
  for (const s of state.redStations) { const d = haversineMi(lngLat, s.geometry.coordinates); if (!best || d < best.d) best = { d, s }; }
  return best;
}
function nearestStation(lngLat) {
  let best = null;
  for (const s of state.stations) { const d = haversineMi(lngLat, s.geometry.coordinates); if (!best || d < best.d) best = { d, s }; }
  return best;
}

// ---------- Data ----------
async function loadData() {
  const opt = url => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
  const [transit, csv, commute, red, redHomes] = await Promise.all([
    fetch('./data/transit.geojson').then(r => r.json()),
    fetch('./data/homes.csv', { cache: 'no-store' }).then(r => r.text()),
    opt('./data/commute.json'), opt('./data/redline.geojson'), opt('./data/redline_homes.json'),
  ]);
  state.red = red; state.redHomes = redHomes;
  state.redStations = red ? red.features.filter(f => f.properties.kind === 'station') : [];
  state.transit = transit;
  state.stations = transit.features.filter(f => f.properties.kind === 'station');
  state.commute = commute;

  const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true, transformHeader: h => h.trim().toLowerCase() });
  state.homes = data.filter(r => r.address?.trim()).map((r, i) => {
    const h = {
      id: `h${i}`, address: r.address.trim(), price: num(r.price), beds: num(r.beds), baths: num(r.baths), sqft: num(r.sqft),
      type: r.type, status: r.status, url: r.url, notes: r.notes,
      sources: (r.sources || '').split('|').filter(Boolean),
      builder: r.builder || 'Builder not set', builderKey: r.builder_key || 'unknown',
      confidence: r.builder_confidence || 'unknown', community: r.community,
      drive20: r.drive_20 === 'yes', transit20: r.transit_20 === 'yes',
      coords: r.coords, lat: num(r.lat), lng: num(r.lng),
    };
    if (h.lat != null) { h.nearest = nearestStation([h.lng, h.lat]); h.nearestRed = nearestRed([h.lng, h.lat]); }
    h.color = BUILDER_COLORS[h.builderKey] || '#8E8E93';
    return h;
  });
}

function builderGroups() {
  const g = new Map();
  for (const h of state.homes) {
    if (!g.has(h.builderKey)) g.set(h.builderKey, { key: h.builderKey, name: h.builder, color: h.color, homes: [] });
    g.get(h.builderKey).homes.push(h);
  }
  const rank = k => (k === 'resale' ? 2 : k === 'infill' ? 1 : 0);
  return [...g.values()].sort((a, b) => rank(a.key) - rank(b.key) || b.homes.length - a.homes.length || a.name.localeCompare(b.name));
}

function commuteFeatures() {
  if (!state.commute) return { type: 'FeatureCollection', features: [] };
  const f = state.commuteFilter;
  return {
    type: 'FeatureCollection',
    features: state.commute.homes
      .filter(h => (f.mode === 'transit' ? h.m & 2 : f.mode === 'drive' ? h.m & 1 : true))
      .filter(h => (f.type === 'all' ? true : h.t === f.type))
      .filter(h => (!f.max ? true : h.p && h.p <= f.max))
      .filter(h => (!f.newOnly ? true : h.nb || h.pl))
      .map(h => ({ type: 'Feature', properties: { ...h, transit: h.m & 2 ? 1 : 0 }, geometry: { type: 'Point', coordinates: [h.lo, h.la] } })),
  };
}

function redHomeFeatures() {
  if (!state.redHomes) return { type: 'FeatureCollection', features: [] };
  const f = state.redFilter;
  return { type: 'FeatureCollection', features: state.redHomes.homes
    .filter(h => (f.type === 'all' ? true : h.t === f.type))
    .filter(h => (!f.max ? true : h.p && h.p <= f.max))
    .filter(h => (!state.redStation ? true : h.st === state.redStation))
    .map(h => ({ type: 'Feature', properties: h, geometry: { type: 'Point', coordinates: [h.lo, h.la] } })) };
}

// ---------- Map ----------
const OFFLINE_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eceae4' } }] };
async function resolveStyle(theme) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(STYLES[theme], { signal: ctl.signal }); clearTimeout(t);
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch {
    const s = structuredClone(OFFLINE_STYLE);
    if (theme === 'dark') s.layers[0].paint['background-color'] = '#17181a';
    return s;
  }
}
function labelFont(map) {
  if (!map.getStyle().glyphs) return null;
  for (const l of map.getStyle().layers) { const f = l.layout?.['text-font']; if (Array.isArray(f) && typeof f[0] === 'string') return f; }
  return null;
}

function addOverlay(map) {
  const dark = state.theme === 'dark';
  const casing = dark ? '#0b0b0c' : '#ffffff';
  const lineColor = ['match', ['get', 'line'], 'gold', cssVar('--gold'), cssVar('--blue')];

  map.addSource('walksheds', { type: 'geojson', data: {
    type: 'FeatureCollection',
    features: state.stations.map(s => ({ type: 'Feature', properties: { line: s.properties.line }, geometry: { type: 'Polygon', coordinates: circlePolygon(s.geometry.coordinates, WALKSHED_MI) } })),
  } });
  map.addSource('lines', { type: 'geojson', data: { type: 'FeatureCollection', features: state.transit.features.filter(f => f.properties.kind === 'line') } });
  map.addSource('stations', { type: 'geojson', data: { type: 'FeatureCollection', features: state.stations } });
  map.addSource('commute', { type: 'geojson', data: commuteFeatures() });

  // Commute homes sit under the rail lines so the network stays legible.
  map.addLayer({ id: 'commute-drive', type: 'circle', source: 'commute', filter: ['==', ['get', 'transit'], 0],
    paint: { 'circle-color': cssVar('--commute'), 'circle-opacity': dark ? 0.7 : 0.55,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 1.6, 13, 4, 16, 7],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0, 14, 1], 'circle-stroke-color': casing } });
  map.addLayer({ id: 'commute-transit', type: 'circle', source: 'commute', filter: ['==', ['get', 'transit'], 1],
    paint: { 'circle-color': cssVar('--transit'), 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 13, 6, 16, 9],
      'circle-stroke-width': 1.5, 'circle-stroke-color': casing } });

  map.addLayer({ id: 'walkshed-fill', type: 'fill', source: 'walksheds', paint: { 'fill-color': lineColor, 'fill-opacity': dark ? 0.1 : 0.08 } });
  map.addLayer({ id: 'walkshed-line', type: 'line', source: 'walksheds', paint: { 'line-color': lineColor, 'line-opacity': 0.45, 'line-width': 1, 'line-dasharray': [2, 2] } });
  map.addLayer({ id: 'line-glow', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': lineColor, 'line-opacity': dark ? 0.55 : 0.35, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 8, 15, 22], 'line-blur': ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 12] } });
  map.addLayer({ id: 'line-casing', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': casing, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 15, 11] } });
  map.addLayer({ id: 'line-core', type: 'line', source: 'lines', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': lineColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 15, 7] } });
  map.addLayer({ id: 'station-halo', type: 'circle', source: 'stations',
    paint: { 'circle-color': lineColor, 'circle-opacity': 0.25, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 15, 14] } });
  map.addLayer({ id: 'station', type: 'circle', source: 'stations',
    paint: { 'circle-color': casing, 'circle-stroke-color': lineColor, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3.2, 15, 7], 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 15, 3.5] } });

  if (state.red) {
    const red = cssVar('--red');
    map.addSource('red-line', { type: 'geojson', data: { type: 'FeatureCollection', features: state.red.features.filter(f => f.properties.kind === 'line') } });
    map.addSource('red-stations', { type: 'geojson', data: { type: 'FeatureCollection', features: state.redStations } });
    map.addSource('red-homes', { type: 'geojson', data: redHomeFeatures() });
    map.addLayer({ id: 'red-homes', type: 'circle', source: 'red-homes',
      paint: { 'circle-color': cssVar('--red-homes'), 'circle-opacity': dark ? 0.8 : 0.7,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2, 13, 4.5, 16, 7.5],
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0, 14, 1], 'circle-stroke-color': casing } }, 'walkshed-fill');
    map.addLayer({ id: 'red-glow', type: 'line', source: 'red-line', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': red, 'line-opacity': dark ? 0.5 : 0.3, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 8, 15, 20], 'line-blur': 6 } });
    map.addLayer({ id: 'red-casing', type: 'line', source: 'red-line', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': casing, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 5, 15, 10] } });
    map.addLayer({ id: 'red-core', type: 'line', source: 'red-line', layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': red, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3, 15, 6], 'line-dasharray': [2.2, 1.2] } });
    map.addLayer({ id: 'red-station', type: 'circle', source: 'red-stations',
      paint: { 'circle-color': ['match', ['get', 'status'], 'potential', red, casing], 'circle-stroke-color': red,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 15, 7.5], 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 2, 15, 3.5] } });
  }

  const font = labelFont(map);
  if (font && state.red) {
    map.addLayer({ id: 'red-label', type: 'symbol', source: 'red-stations', minzoom: 9.5,
      layout: { 'text-field': ['get', 'name'], 'text-font': font, 'text-size': ['interpolate', ['linear'], ['zoom'], 9.5, 11, 15, 14], 'text-offset': [0.9, 0], 'text-anchor': 'left', 'text-optional': true },
      paint: { 'text-color': cssVar('--red'), 'text-halo-color': dark ? 'rgba(0,0,0,.85)' : 'rgba(255,255,255,.95)', 'text-halo-width': 1.8 } });
  }
  if (font) {
    map.addLayer({ id: 'station-label', type: 'symbol', source: 'stations', minzoom: 11.5,
      layout: { 'text-field': ['get', 'name'], 'text-font': font, 'text-size': ['interpolate', ['linear'], ['zoom'], 11.5, 11, 16, 14], 'text-offset': [0.9, 0], 'text-anchor': 'left', 'text-max-width': 10, 'text-optional': true },
      paint: { 'text-color': dark ? '#f5f5f7' : '#1d1d1f', 'text-halo-color': dark ? 'rgba(0,0,0,.85)' : 'rgba(255,255,255,.95)', 'text-halo-width': 1.6 } });
  }
  applyLayerVisibility(map);
}

function applyLayerVisibility(map) {
  if (!map.getSource('lines')) return;
  const lines = ['blue', 'gold'].filter(k => state.layers[k]);
  const lineFilter = ['in', ['get', 'line'], ['literal', lines]];
  for (const id of ['line-glow', 'line-casing', 'line-core', 'station-halo', 'station', 'station-label', 'walkshed-fill', 'walkshed-line']) if (map.getLayer(id)) map.setFilter(id, lineFilter);
  const vis = on => (on ? 'visible' : 'none');
  for (const id of ['walkshed-fill', 'walkshed-line']) map.setLayoutProperty(id, 'visibility', vis(state.layers.walksheds));
  for (const id of ['commute-drive', 'commute-transit']) map.setLayoutProperty(id, 'visibility', vis(state.layers.commute));
  for (const id of ['red-glow', 'red-casing', 'red-core', 'red-station', 'red-label']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis(state.layers.red));
  if (map.getLayer('red-homes')) map.setLayoutProperty('red-homes', 'visibility', vis(state.layers.redhomes));
  for (const m of state.markers.values()) m.getElement().style.display = state.layers.homes ? '' : 'none';
}

// ---------- Markers ----------
function addHQMarker(map) {
  const d = state.commute?.destination ?? { lat: 35.2285, lng: -80.8424, name: 'Truist Center · 214 N Tryon St' };
  const el = document.createElement('div');
  el.className = 'hq';
  el.innerHTML = `<span class="hq-dot"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M5 21V4.5L12 2l7 2.5V21h-5v-4h-4v4H5zm3-12h2V7H8v2zm0 4h2v-2H8v2zm6-4h2V7h-2v2zm0 4h2v-2h-2v2z"/></svg></span><span class="hq-label">Truist Center</span>`;
  el.title = d.name;
  new maplibregl.Marker({ element: el, anchor: 'left', offset: [-11, 0] }).setLngLat([d.lng, d.lat]).addTo(map);
}

function addHomeMarkers(map) {
  for (const h of state.homes) {
    if (h.lat == null) continue;
    const el = document.createElement('button');
    el.className = 'pin' + (h.coords === 'approx' ? ' approx' : '');
    el.style.setProperty('--b', h.color);
    el.setAttribute('aria-label', `${h.address}, ${fmtPrice(h.price)}, ${h.builder}`);
    el.innerHTML = `<i></i>${fmtPrice(h.price)}`;
    el.addEventListener('click', e => { e.stopPropagation(); selectHome(map, h.id, { fly: false }); });
    state.markers.set(h.id, new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([h.lng, h.lat]).addTo(map));
  }
}

function chip(text, cls = '') { return `<span class="chip ${cls}">${esc(text)}</span>`; }

function homePopupHTML(h) {
  const conf = CONFIDENCE[h.confidence] ?? CONFIDENCE.unknown;
  const near = h.nearest ? `<div class="pop-meta"><span style="color:${h.nearest.s.properties.color}">●</span> ${fmtMi(h.nearest.d)} to ${esc(h.nearest.s.properties.name)} · ~${Math.max(1, Math.round(h.nearest.d * WALK_MIN_PER_MI))} min walk</div>` : '';
  return `<div class="pop-eyebrow"><i style="background:${h.color}"></i>${esc(h.builder)}</div>
    <div class="pop-title">${esc(h.address.split(',')[0])}</div>
    <div class="pop-meta"><b>${fmtPrice(h.price)}</b>${facts(h) ? ' · ' + facts(h) : ''}</div>
    <div class="pop-meta">${esc(h.community || '')}</div>
    ${near}
    ${redNear(h)}
    <div class="chips">${chip(conf.label, conf.cls)}${h.drive20 ? chip('≤20 min drive', 'ok') : chip('>20 min drive', 'muted')}${h.coords === 'approx' ? chip('Approx. location', 'warn') : ''}</div>
    ${h.url && /^https?:\/\//.test(h.url) ? `<a class="pop-link" href="${esc(h.url)}" target="_blank" rel="noopener">View listing ↗</a>` : ''}`;
}

function redNear(h) {
  const r = h.nearestRed;
  return r && r.d <= 1.5 ? `<div class="pop-meta red-near"><span class="red-dash"></span>${fmtMi(r.d)} to ${esc(r.s.properties.name)} · Red Line (proposed)</div>` : '';
}

function selectHome(map, id, { fly = true } = {}) {
  const h = state.homes.find(x => x.id === id);
  if (!h || h.lat == null) return;
  state.activeId = id;
  for (const [mid, m] of state.markers) m.getElement().classList.toggle('active', mid === id);
  document.querySelectorAll('[data-home]').forEach(el => el.classList.toggle('active', el.dataset.home === id));
  state.popup?.remove();
  state.popup = new maplibregl.Popup({ offset: 30, maxWidth: '300px' }).setLngLat([h.lng, h.lat]).setHTML(homePopupHTML(h)).addTo(map);
  if (fly) map.flyTo({ center: [h.lng, h.lat], zoom: Math.max(map.getZoom(), 14), padding: panelPadding(), speed: 1.4 });
}

function commutePopupHTML(p) {
  const near = nearestStation([p.lo, p.la]);
  return `<div class="pop-eyebrow"><i style="background:${p.transit ? cssVar('--transit') : cssVar('--commute')}"></i>${p.transit ? '≤20 min by transit' : '≤20 min drive'}</div>
    <div class="pop-title">${esc(p.a)}</div>
    <div class="pop-meta"><b>${fmtPrice(p.p)}</b> · ${[p.bd && `${p.bd} bd`, p.ba && `${p.ba} ba`, p.sf && `${Number(p.sf).toLocaleString()} sqft`].filter(Boolean).join(' · ')}</div>
    <div class="pop-meta">${p.t === 'T' ? 'Townhome' : 'Single-family'}${p.c ? ' · ' + esc(p.c) : ''}${p.pl ? ' · Builder plan' : ''}</div>
    ${near ? `<div class="pop-meta"><span style="color:${near.s.properties.color}">●</span> ${fmtMi(near.d)} to ${esc(near.s.properties.name)}</div>` : ''}
    <div class="chips">${p.m & 2 ? chip('Transit ≤20', 'ok') : ''}${p.m & 1 ? chip('Drive ≤20', 'ok') : ''}${p.nb || p.pl ? chip('New construction', 'warn') : ''}</div>
    <a class="pop-link" href="${ZILLOW}${esc(p.u)}" target="_blank" rel="noopener">View on Zillow ↗</a>`;
}

function redHomePopupHTML(p) {
  return `<div class="pop-eyebrow"><span class="red-dash"></span>${fmtMi(p.d)} to ${esc(p.st)} station</div>
    <div class="pop-title">${esc(p.a)}</div>
    <div class="pop-meta">${esc(p.city || '')}${p.z ? ' ' + esc(p.z) : ''}</div>
    <div class="pop-meta"><b>${fmtPrice(p.p)}</b> · ${[p.bd && `${p.bd} bd`, p.ba && `${p.ba} ba`, p.sf && `${Number(p.sf).toLocaleString()} sqft`].filter(Boolean).join(' · ')}</div>
    <div class="pop-meta">${p.t === 'T' ? 'Townhome' : 'Single-family'}${p.c ? ' · ' + esc(p.c) : ''}${p.pl ? ' · Builder plan' : ''}</div>
    <div class="chips">${chip('Red Line (proposed)', 'warn')}${p.nb || p.pl ? chip('New construction', 'warn') : ''}</div>
    <a class="pop-link" href="${ZILLOW}${esc(p.u)}" target="_blank" rel="noopener">View on Zillow ↗</a>`;
}

// ---------- Panel: Red Line ----------
function renderRedline(map) {
  const el = document.getElementById('view-redline');
  if (!state.red || !state.redHomes) { el.innerHTML = `<div class="empty"><strong>No Red Line data</strong>Add <code>public/data/redline.geojson</code>.</div>`; return; }
  const f = state.redFilter;
  const all = state.redHomes.homes.filter(h => (f.type === 'all' || h.t === f.type) && (!f.max || (h.p && h.p <= f.max)));
  const seg = opts => `<div class="seg" data-rf="type">${opts.map(([v, l]) => `<button data-v="${v}" aria-pressed="${f.type === v}">${l}</button>`).join('')}</div>`;
  const filters = `${seg([['all', 'All types'], ['S', 'Single-family'], ['T', 'Townhome']])}
    <div class="row"><label class="sel">Max price <select id="rmax">${[[0, 'Any'], [300000, '$300K'], [350000, '$350K'], [400000, '$400K'], [450000, '$450K'], [500000, '$500K'], [600000, '$600K'], [800000, '$800K']]
      .map(([v, l]) => `<option value="${v}" ${f.max === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <span class="facts">Within 1.5 mi of a station</span></div>`;
  const savedNear = state.homes.filter(h => h.nearestRed && h.nearestRed.d <= 1.5);

  if (state.redStation) {
    const st = state.redStations.find(s => s.properties.name === state.redStation);
    const list = all.filter(h => h.st === state.redStation).sort((a, b) => a.d - b.d);
    el.innerHTML = `
      <button class="back" id="rback"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7"/></svg>All stations</button>
      <div class="drill-head"><span class="red-dot ${st.properties.status}"></span><div><h2 class="drill-title">${esc(st.properties.name)}</h2>
        <p class="drill-sub">${list.length} homes · median ${fmtPrice(median(list.map(h => h.p).filter(Boolean)))}${st.properties.status === 'potential' ? ' · potential new station' : ''}</p></div></div>
      ${filters}
      <ul class="cards compact">${list.map((p, i) => `<li class="c-home" data-ri="${i}" tabindex="0"><i style="background:var(--red-homes)"></i>
        <div class="c-main"><div class="addr">${esc(p.a)}</div><div class="facts">${esc(p.city || '')} · ${p.t === 'T' ? 'Townhome' : 'Single-family'} · ${fmtMi(p.d)}</div></div>
        <div class="price">${fmtPrice(p.p)}</div></li>`).join('') || '<li class="more">No homes match these filters.</li>'}</ul>`;
    el.querySelector('#rback').onclick = () => { state.redStation = null; refreshRed(map); renderRedline(map); el.scrollTop = 0; };
    el.querySelectorAll('.c-home').forEach(li => li.onclick = () => {
      const p = list[Number(li.dataset.ri)];
      state.popup?.remove();
      state.popup = new maplibregl.Popup({ offset: 10, maxWidth: '300px' }).setLngLat([p.lo, p.la]).setHTML(redHomePopupHTML(p)).addTo(map);
      map.flyTo({ center: [p.lo, p.la], zoom: Math.max(map.getZoom(), 14.5), padding: panelPadding(), speed: 1.4 });
      collapseSheet();
    });
  } else {
    const stations = [...state.redStations].sort((a, b) => b.properties.order - a.properties.order);
    el.innerHTML = `
      <p class="red-note"><span class="red-dash"></span><span><b>LYNX Red Line</b> · proposed commuter rail, Uptown to Mooresville. CATS is re-evaluating all stations; positions are approximate.</span></p>
      <div class="stats">
        <div class="stat"><b>${all.length}</b><span>Homes ≤1.5 mi</span></div>
        <div class="stat"><b>${fmtPrice(median(all.map(h => h.p).filter(Boolean)))}</b><span>Median price</span></div>
        <div class="stat"><b>${savedNear.length}</b><span>Saved homes near</span></div>
      </div>
      ${filters}
      <ul class="cards">${stations.map(s => {
        const n = s.properties.name, hs = all.filter(h => h.st === n), ps = hs.map(h => h.p).filter(Boolean);
        const saved = savedNear.filter(h => h.nearestRed.s.properties.name === n);
        return `<li class="builder station-row" data-st="${esc(n)}" tabindex="0">
          <span class="red-dot ${s.properties.status}"></span>
          <div class="b-main"><div class="b-name">${esc(n)}</div><div class="b-sub">${ps.length ? `from ${fmtPrice(Math.min(...ps))} · median ${fmtPrice(median(ps))}` : 'No homes match'}</div></div>
          <div class="b-side"><b>${hs.length}</b><span>homes</span></div>
          <div class="chips b-chips">${s.properties.status === 'potential' ? chip('Potential station', 'muted') : ''}${saved.length ? chip(`${saved.length} saved home${saved.length > 1 ? 's' : ''} nearby`, 'ok') : ''}</div>
          <svg class="chev" viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg></li>`;
      }).join('')}</ul>
      <p class="source">${esc(state.redHomes.source)}. ${esc(state.redHomes.coverage)}</p>`;
    el.querySelectorAll('.station-row').forEach(li => { const go = () => openRedStation(map, li.dataset.st); li.onclick = go; li.onkeydown = e => { if (e.key === 'Enter') go(); }; });
  }
  el.querySelectorAll('[data-rf] button').forEach(b => b.onclick = () => { f.type = b.dataset.v; savePref('redFilter', f); refreshRed(map); renderRedline(map); });
  el.querySelector('#rmax').onchange = e => { f.max = Number(e.target.value); savePref('redFilter', f); refreshRed(map); renderRedline(map); };
}
function openRedStation(map, name) {
  state.redStation = name; refreshRed(map); renderRedline(map);
  document.getElementById('view-redline').scrollTop = 0;
  const st = state.redStations.find(s => s.properties.name === name);
  const [lng, lat] = st.geometry.coordinates, dLat = 1.5 / 69, dLng = 1.5 / (69.17 * Math.cos(lat * Math.PI / 180));
  map.fitBounds([[lng - dLng, lat - dLat], [lng + dLng, lat + dLat]], { padding: panelPadding(), duration: 700 });
}
function refreshRed(map) {
  map.getSource('red-homes')?.setData(redHomeFeatures());
  if (!state.layers.redhomes || !state.layers.red) { state.layers.redhomes = state.layers.red = true; savePref('layers', state.layers); applyLayerVisibility(map); renderToggles(map); }
}

// ---------- Panel: Builders ----------
function renderBuilders(map) {
  const el = document.getElementById('view-builders');
  const groups = builderGroups();
  if (state.builder) {
    const g = groups.find(x => x.key === state.builder);
    if (!g) { state.builder = null; return renderBuilders(map); }
    const prices = g.homes.map(h => h.price).filter(Boolean);
    const comms = [...new Set(g.homes.map(h => h.community).filter(c => c && c !== '—'))];
    el.innerHTML = `
      <button class="back" id="back"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7"/></svg>All builders</button>
      <div class="drill-head"><span class="swatch" style="background:${g.color}"></span><div><h2 class="drill-title">${esc(g.name)}</h2>
        <p class="drill-sub">${g.homes.length} saved home${g.homes.length > 1 ? 's' : ''}${prices.length ? ` · ${fmtPrice(Math.min(...prices))}${prices.length > 1 ? '–' + fmtPrice(Math.max(...prices)) : ''}` : ''}</p></div></div>
      ${comms.length ? `<p class="drill-comms">${comms.map(esc).join(' · ')}</p>` : ''}
      <ul class="cards">${g.homes.map(h => homeCard(h, true)).join('')}</ul>`;
    el.querySelector('#back').onclick = () => { state.builder = null; renderBuilders(map); dimMarkers(null); };
  } else {
    const d20 = state.homes.filter(h => h.drive20).length;
    el.innerHTML = `
      <div class="stats">
        <div class="stat"><b>${state.homes.length}</b><span>Saved homes</span></div>
        <div class="stat"><b>${groups.filter(g => !['infill', 'resale'].includes(g.key)).length}</b><span>Named builders</span></div>
        <div class="stat"><b>${d20}</b><span>≤20 min drive</span></div>
      </div>
      <ul class="cards">${groups.map(g => {
        const prices = g.homes.map(h => h.price).filter(Boolean);
        const confs = [...new Set(g.homes.map(h => h.confidence))];
        return `<li class="builder" data-builder="${g.key}" tabindex="0">
          <span class="swatch" style="background:${g.color}"></span>
          <div class="b-main"><div class="b-name">${esc(g.name)}</div>
            <div class="b-sub">${[...new Set(g.homes.map(h => h.community).filter(c => c && c !== '—'))].slice(0, 2).map(esc).join(' · ') || '&nbsp;'}</div></div>
          <div class="b-side"><b>${g.homes.length}</b><span>${prices.length ? fmtPrice(Math.min(...prices)) + (prices.length > 1 ? '+' : '') : ''}</span></div>
          <div class="chips b-chips">${confs.map(c => chip((CONFIDENCE[c] ?? CONFIDENCE.unknown).label, (CONFIDENCE[c] ?? CONFIDENCE.unknown).cls)).join('')}</div>
          <svg class="chev" viewBox="0 0 24 24" width="14" height="14"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
        </li>`;
      }).join('')}</ul>`;
    const open = key => {
      state.builder = key; renderBuilders(map); dimMarkers(key); el.scrollTop = 0;
      const pts = state.homes.filter(h => h.builderKey === key && h.lat != null).map(h => [h.lng, h.lat]);
      if (pts.length) map.fitBounds(pts.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(pts[0], pts[0])), { padding: panelPadding(), maxZoom: 14, duration: 700 });
    };
    el.querySelectorAll('.builder').forEach(li => {
      li.onclick = () => open(li.dataset.builder);
      li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(li.dataset.builder); } };
    });
  }
  el.querySelectorAll('[data-home]').forEach(li => { li.onclick = e => { if (e.target.closest('a')) return; selectHome(map, li.dataset.home); collapseSheet(); }; });
}

function homeCard(h, detailed) {
  const conf = CONFIDENCE[h.confidence] ?? CONFIDENCE.unknown;
  const near = h.nearest ? `<div class="near"><i style="background:${h.nearest.s.properties.color}"></i>${fmtMi(h.nearest.d)} to ${esc(h.nearest.s.properties.name)}</div>` : '';
  return `<li class="home ${h.id === state.activeId ? 'active' : ''}" data-home="${h.id}" tabindex="0">
    <div class="home-top"><div class="addr">${esc(h.address.split(',')[0])}</div><div class="price">${fmtPrice(h.price)}</div></div>
    <div class="facts">${esc([facts(h), h.type].filter(Boolean).join(' · '))}</div>
    <div class="facts">${esc(h.status || '')}</div>
    ${near}
    ${redNear(h)}
    <div class="chips">${chip(conf.label, conf.cls)}${h.drive20 ? chip('≤20 min drive', 'ok') : chip('>20 min drive', 'muted')}${h.coords === 'approx' ? chip('Approx. pin', 'warn') : ''}</div>
    ${detailed && h.notes ? `<p class="note">${esc(h.notes)}</p>` : ''}
    ${detailed && h.sources.length ? `<div class="srcs">${h.sources.map((s, i) => `<a href="${esc(s)}" target="_blank" rel="noopener">Source ${i + 1} ↗</a>`).join('')}</div>` : ''}
  </li>`;
}

function dimMarkers(key) {
  for (const h of state.homes) { const m = state.markers.get(h.id); if (m) m.getElement().classList.toggle('dim', !!key && h.builderKey !== key); }
}

// ---------- Panel: Commute ----------
function renderCommute(map) {
  const el = document.getElementById('view-commute');
  if (!state.commute) { el.innerHTML = `<div class="empty"><strong>No commute data</strong>Add <code>public/data/commute.json</code>.</div>`; return; }
  const f = state.commuteFilter;
  const fc = commuteFeatures();
  const ps = fc.features.map(x => x.properties);
  const transit = ps.filter(p => p.m & 2).length;
  const seg = (name, opts) => `<div class="seg" data-f="${name}">${opts.map(([v, l]) => `<button data-v="${v}" aria-pressed="${String(f[name]) === String(v)}">${l}</button>`).join('')}</div>`;
  const list = [...ps].sort((a, b) => (b.m & 2) - (a.m & 2) || (a.p || 9e9) - (b.p || 9e9)).slice(0, 60);
  el.innerHTML = `
    <p class="dest"><span class="hq-dot sm"></span><span>To <b>Truist Center</b>, 214 N Tryon · rush hour</span></p>
    <div class="stats">
      <div class="stat"><b>${ps.length.toLocaleString()}</b><span>Homes shown</span></div>
      <div class="stat"><b>${transit}</b><span>By transit</span></div>
      <div class="stat"><b>${fmtPrice(median(ps.map(p => p.p).filter(Boolean)))}</b><span>Median price</span></div>
    </div>
    ${seg('mode', [['all', 'Any'], ['transit', 'Transit'], ['drive', 'Drive']])}
    ${seg('type', [['all', 'All types'], ['S', 'Single-family'], ['T', 'Townhome']])}
    <div class="row">
      <label class="sel">Max price
        <select id="maxp">${[[0, 'Any'], [300000, '$300K'], [350000, '$350K'], [400000, '$400K'], [450000, '$450K'], [500000, '$500K'], [600000, '$600K'], [800000, '$800K']]
          .map(([v, l]) => `<option value="${v}" ${f.max === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" id="newOnly" ${f.newOnly ? 'checked' : ''}> New construction</label>
    </div>
    <ul class="cards compact">${list.map((p, i) => `<li class="c-home" data-ci="${i}" tabindex="0">
      <i style="background:${p.m & 2 ? 'var(--transit)' : 'var(--commute)'}"></i>
      <div class="c-main"><div class="addr">${esc(p.a)}</div><div class="facts">${p.t === 'T' ? 'Townhome' : 'Single-family'} · ${[p.bd && p.bd + ' bd', p.sf && Number(p.sf).toLocaleString() + ' sqft'].filter(Boolean).join(' · ')}</div></div>
      <div class="price">${fmtPrice(p.p)}</div></li>`).join('')}
      ${ps.length > list.length ? `<li class="more">Showing ${list.length} of ${ps.length.toLocaleString()}. All are on the map; narrow the filters to list more.</li>` : ''}</ul>
    <p class="source">${esc(state.commute.criteria)}. ${esc(state.commute.coverage)}</p>`;

  el.querySelectorAll('.seg').forEach(s => s.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    f[s.dataset.f] = b.dataset.v; onFilter(map);
    if (s.dataset.f === 'mode') {
      const pts = commuteFeatures().features.map(x => x.geometry.coordinates);
      if (pts.length) map.fitBounds(pts.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(pts[0], pts[0])), { padding: panelPadding(), maxZoom: 14, duration: 700 });
    }
  }));
  el.querySelector('#maxp').onchange = e => { f.max = Number(e.target.value); onFilter(map); };
  el.querySelector('#newOnly').onchange = e => { f.newOnly = e.target.checked; onFilter(map); };
  el.querySelectorAll('.c-home').forEach(li => li.onclick = () => {
    const p = list[Number(li.dataset.ci)];
    state.popup?.remove();
    state.popup = new maplibregl.Popup({ offset: 10, maxWidth: '300px' }).setLngLat([p.lo, p.la]).setHTML(commutePopupHTML(p)).addTo(map);
    map.flyTo({ center: [p.lo, p.la], zoom: Math.max(map.getZoom(), 14.5), padding: panelPadding(), speed: 1.4 });
    collapseSheet();
  });
}
function onFilter(map) {
  savePref('commuteFilter', state.commuteFilter);
  map.getSource('commute')?.setData(commuteFeatures());
  if (!state.layers.commute) { state.layers.commute = true; savePref('layers', state.layers); applyLayerVisibility(map); renderToggles(map); }
  renderCommute(map);
}

// ---------- Panel: Layers ----------
function renderToggles(map) {
  const count = k => state.stations.filter(s => s.properties.line === k).length;
  const items = [
    { k: 'blue', label: 'Blue Line', meta: `Light rail · ${count('blue')}`, sw: `<span class="sw" style="background:var(--blue)"></span>` },
    { k: 'gold', label: 'Gold Line', meta: `Streetcar · ${count('gold')}`, sw: `<span class="sw" style="background:var(--gold)"></span>` },
    { k: 'red', label: 'Red Line', meta: `Proposed · ${state.redStations.length}`, sw: `<span class="sw dashed" style="background:var(--red)"></span>` },
    { k: 'redhomes', label: 'Red Line homes', meta: state.redHomes ? `${state.redHomes.homes.length}` : '', sw: `<span class="sw dot" style="background:var(--red-homes)"></span>` },
    { k: 'homes', label: 'Saved homes', meta: `${state.homes.length}`, sw: `<span class="sw dot" style="background:var(--pin)"></span>` },
    { k: 'commute', label: '20-min commute homes', meta: state.commute ? state.commute.homes.length.toLocaleString() : '', sw: `<span class="sw dot" style="background:var(--commute)"></span>` },
    { k: 'walksheds', label: '½-mile walksheds', meta: '', sw: `<span class="sw ring"></span>` },
  ];
  const wrap = document.getElementById('toggles');
  wrap.innerHTML = items.map(i => `<label class="toggle">${i.sw}<span class="label">${i.label}</span><span class="meta">${i.meta}</span>
    <input type="checkbox" data-k="${i.k}" ${state.layers[i.k] ? 'checked' : ''}><span class="switch"></span></label>`).join('')
    + `<p class="source" id="source"></p>`;
  wrap.onchange = e => { const k = e.target.dataset.k; if (!k) return; state.layers[k] = e.target.checked; savePref('layers', state.layers); applyLayerVisibility(map); };
  const approx = state.stations.some(s => s.properties.source === 'approximate');
  document.getElementById('source').innerHTML = approx
    ? `<span class="warn">Transit stops are approximate (hand-entered).</span> Run <code>npm run refresh:transit</code> for exact OpenStreetMap geometry.`
    : `Transit: ${esc(state.transit.attribution || 'OpenStreetMap')}.`;
}

// ---------- Tabs & layout ----------
function setTab(tab) {
  state.tab = tab; savePref('tab', tab);
  document.querySelectorAll('.tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  for (const v of ['builders', 'commute', 'redline', 'layers']) document.getElementById(`view-${v}`).hidden = v !== tab;
}
const isPhone = () => matchMedia('(max-width: 720px)').matches;
function panelPadding() { return isPhone() ? { top: 40, bottom: innerHeight * 0.5, left: 30, right: 30 } : { top: 60, bottom: 60, left: 420, right: 60 }; }
function collapseSheet() { document.getElementById('panel').classList.remove('expanded'); }

// ---------- Boot ----------
async function boot() {
  document.documentElement.dataset.theme = state.theme;
  const [style] = await Promise.all([resolveStyle(state.theme), loadData()]);

  const map = new maplibregl.Map({ container: 'map', style, center: CLT_CENTER, zoom: 10.6, attributionControl: { compact: true } });
  window.__map = map;
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');
  map.on('style.load', () => addOverlay(map));
  map.once('load', () => {
    const pts = state.homes.filter(h => h.lat != null).map(h => [h.lng, h.lat]);
    if (pts.length) map.fitBounds(pts.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(pts[0], pts[0])), { padding: panelPadding(), duration: 0 });
    addHQMarker(map); addHomeMarkers(map); applyLayerVisibility(map); dimMarkers(state.builder);
    document.body.dataset.ready = '1';
  });

  map.on('click', 'red-station', e => {
    const p = e.features[0].properties, c = e.features[0].geometry.coordinates;
    const hs = state.redHomes ? state.redHomes.homes.filter(h => h.st === p.name) : [];
    state.popup?.remove();
    state.popup = new maplibregl.Popup({ offset: 12, maxWidth: '260px' }).setLngLat(c).setHTML(`
      <div class="pop-eyebrow"><span class="red-dash"></span>Red Line · ${p.status === 'potential' ? 'potential station' : 'proposed'}</div>
      <div class="pop-title">${esc(p.name)}</div>
      <div class="pop-meta">${hs.length} homes within 1.5 mi · median ${fmtPrice(median(hs.map(h => h.p).filter(Boolean)))}</div>
      <button class="pop-link as-btn" id="open-st">See homes →</button>`).addTo(map);
    document.getElementById('open-st').onclick = () => { setTab('redline'); openRedStation(map, p.name); };
  });
  map.on('click', 'red-homes', e => {
    const p = e.features[0].properties;
    state.popup?.remove();
    state.popup = new maplibregl.Popup({ offset: 8, maxWidth: '300px' }).setLngLat([p.lo, p.la]).setHTML(redHomePopupHTML(p)).addTo(map);
  });
  for (const id of ['station', 'red-station', 'red-homes', 'commute-drive', 'commute-transit']) {
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }
  map.on('click', 'station', e => {
    const f = e.features[0], p = f.properties, c = f.geometry.coordinates;
    const nearby = state.homes.filter(h => h.lat != null && haversineMi([h.lng, h.lat], c) <= WALKSHED_MI);
    state.popup?.remove();
    state.popup = new maplibregl.Popup({ offset: 12, maxWidth: '260px' }).setLngLat(c).setHTML(`
      <div class="pop-eyebrow"><i style="background:${p.color}"></i>${esc(p.lineName)}</div>
      <div class="pop-title">${esc(p.name)}</div>
      <div class="pop-meta">${nearby.length ? `${nearby.length} saved home${nearby.length > 1 ? 's' : ''} within ½ mi` : 'No saved homes within ½ mi'}</div>`).addTo(map);
  });
  for (const id of ['commute-drive', 'commute-transit']) {
    map.on('click', id, e => {
      if (e.originalEvent.defaultPrevented) return;
      const p = e.features[0].properties;
      state.popup?.remove();
      state.popup = new maplibregl.Popup({ offset: 8, maxWidth: '300px' }).setLngLat([p.lo, p.la]).setHTML(commutePopupHTML(p)).addTo(map);
    });
  }

  document.getElementById('theme').addEventListener('click', async () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    savePref('theme', state.theme);
    document.documentElement.dataset.theme = state.theme;
    map.setStyle(await resolveStyle(state.theme));
  });
  document.getElementById('grabber').addEventListener('click', () => document.getElementById('panel').classList.toggle('expanded'));
  document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('[role=tab]'); if (b) setTab(b.dataset.tab); });

  setTab(state.tab); renderBuilders(map); renderCommute(map); renderRedline(map); renderToggles(map);
}

boot();
