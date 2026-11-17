import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import Papa from 'papaparse';
import './style.css';

// ---------- Config ----------
const STYLES = {
  light: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};
const CLT_CENTER = [-80.8431, 35.2271]; // Trade & Tryon
const WALKSHED_MI = 0.5;
const WALK_MIN_PER_MI = 20; // ~3 mph

const state = {
  theme: loadPref('theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  layers: { blue: true, gold: true, homes: true, walksheds: false, ...loadPref('layers') },
  sort: loadPref('sort') ?? 'transit',
  transit: null,
  stations: [],
  homes: [],
  markers: new Map(),
  activeId: null,
  popup: null,
};

// ---------- Helpers ----------
function loadPref(k) { try { return JSON.parse(localStorage.getItem('cltmap.' + k)); } catch { return null; } }
function savePref(k, v) { try { localStorage.setItem('cltmap.' + k, JSON.stringify(v)); } catch {} }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const fmtPrice = p => p == null ? '—' : p >= 1e6 ? `$${(p / 1e6).toFixed(p >= 1e7 ? 0 : 2).replace(/\.?0+$/, '')}M` : `$${Math.round(p / 1e3)}K`;
const fmtMi = d => d < 0.1 ? `${Math.round(d * 5280)} ft` : `${d.toFixed(1)} mi`;

function haversineMi([lng1, lat1], [lng2, lat2]) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function circlePolygon([lng, lat], radiusMi, steps = 64) {
  const dLat = radiusMi / 69.0, dLng = radiusMi / (69.172 * Math.cos(lat * Math.PI / 180));
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return [ring];
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ---------- Data ----------
async function loadTransit() {
  const res = await fetch('./data/transit.geojson');
  const gj = await res.json();
  state.transit = gj;
  state.stations = gj.features.filter(f => f.properties.kind === 'station');
}

async function loadHomes() {
  const text = await (await fetch('./data/homes.csv', { cache: 'no-store' })).text();
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: h => h.trim().toLowerCase() });
  state.homes = data
    .map((r, i) => ({
      id: `h${i}`,
      address: r.address?.trim(),
      price: num(r.price), beds: num(r.beds), baths: num(r.baths), sqft: num(r.sqft),
      status: r.status?.trim(), url: r.url?.trim(), notes: r.notes?.trim(),
      lat: num(r.lat), lng: num(r.lng),
    }))
    .filter(h => h.address);
  for (const h of state.homes) {
    if (h.lat == null || h.lng == null) continue;
    let best = null;
    for (const s of state.stations) {
      const d = haversineMi([h.lng, h.lat], s.geometry.coordinates);
      if (!best || d < best.d) best = { d, s };
    }
    h.nearest = best;
  }
}

function transitData(kind, extra) {
  return { type: 'FeatureCollection', features: state.transit.features.filter(f => f.properties.kind === kind && (!extra || extra(f))) };
}

function walkshedData() {
  // De-duplicate transfer stations that share a name across lines.
  return {
    type: 'FeatureCollection',
    features: state.stations.map(s => ({
      type: 'Feature',
      properties: { line: s.properties.line, color: s.properties.color },
      geometry: { type: 'Polygon', coordinates: circlePolygon(s.geometry.coordinates, WALKSHED_MI) },
    })),
  };
}

// ---------- Map ----------
const OFFLINE_STYLE = {
  version: 8, sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eceae4' } }],
};

async function resolveStyle(theme) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(STYLES[theme], { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(res.status);
    return await res.json();
  } catch {
    console.warn('Basemap unavailable — using offline background.');
    const s = structuredClone(OFFLINE_STYLE);
    if (theme === 'dark') s.layers[0].paint['background-color'] = '#17181a';
    return s;
  }
}

function labelFont(map) {
  // Reuse a font stack the basemap already serves glyphs for.
  if (!map.getStyle().glyphs) return null;
  for (const l of map.getStyle().layers) {
    const f = l.layout?.['text-font'];
    if (Array.isArray(f) && typeof f[0] === 'string') return f;
  }
  return null;
}

function addOverlay(map) {
  const dark = state.theme === 'dark';
  const casing = dark ? '#0b0b0c' : '#ffffff';
  const lineColor = ['match', ['get', 'line'], 'gold', cssVar('--gold'), cssVar('--blue')];

  map.addSource('walksheds', { type: 'geojson', data: walkshedData() });
  map.addSource('lines', { type: 'geojson', data: transitData('line') });
  map.addSource('stations', { type: 'geojson', data: transitData('station') });

  map.addLayer({ id: 'walkshed-fill', type: 'fill', source: 'walksheds',
    paint: { 'fill-color': lineColor, 'fill-opacity': dark ? 0.1 : 0.08 } });
  map.addLayer({ id: 'walkshed-line', type: 'line', source: 'walksheds',
    paint: { 'line-color': lineColor, 'line-opacity': 0.45, 'line-width': 1, 'line-dasharray': [2, 2] } });

  map.addLayer({ id: 'line-glow', type: 'line', source: 'lines',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': lineColor, 'line-opacity': dark ? 0.55 : 0.35,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 8, 15, 22], 'line-blur': ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 12] } });
  map.addLayer({ id: 'line-casing', type: 'line', source: 'lines',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': casing, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 15, 11] } });
  map.addLayer({ id: 'line-core', type: 'line', source: 'lines',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': lineColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 15, 7] } });

  map.addLayer({ id: 'station-halo', type: 'circle', source: 'stations',
    paint: { 'circle-color': lineColor, 'circle-opacity': 0.25,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 15, 14] } });
  map.addLayer({ id: 'station', type: 'circle', source: 'stations',
    paint: { 'circle-color': casing, 'circle-stroke-color': lineColor,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3.2, 15, 7],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 15, 3.5] } });

  const font = labelFont(map);
  if (font) {
    map.addLayer({ id: 'station-label', type: 'symbol', source: 'stations', minzoom: 11.5,
      layout: { 'text-field': ['get', 'name'], 'text-font': font, 'text-size': ['interpolate', ['linear'], ['zoom'], 11.5, 11, 16, 14],
        'text-offset': [0.9, 0], 'text-anchor': 'left', 'text-max-width': 10, 'text-optional': true },
      paint: { 'text-color': dark ? '#f5f5f7' : '#1d1d1f', 'text-halo-color': dark ? 'rgba(0,0,0,.85)' : 'rgba(255,255,255,.95)', 'text-halo-width': 1.6 } });
  }

  applyLayerVisibility(map);
}

function applyLayerVisibility(map) {
  if (!map.getSource('lines')) return;
  const lines = ['blue', 'gold'].filter(k => state.layers[k]);
  const lineFilter = ['in', ['get', 'line'], ['literal', lines]];
  for (const id of ['line-glow', 'line-casing', 'line-core', 'station-halo', 'station', 'station-label', 'walkshed-fill', 'walkshed-line']) {
    if (map.getLayer(id)) map.setFilter(id, lineFilter);
  }
  for (const id of ['walkshed-fill', 'walkshed-line']) {
    map.setLayoutProperty(id, 'visibility', state.layers.walksheds ? 'visible' : 'none');
  }
  for (const m of state.markers.values()) m.getElement().style.display = state.layers.homes ? '' : 'none';
}

// ---------- Homes markers ----------
function addHomeMarkers(map) {
  for (const h of state.homes) {
    if (h.lat == null || h.lng == null) continue;
    const el = document.createElement('button');
    el.className = 'pin';
    el.setAttribute('aria-label', `${h.address}, ${fmtPrice(h.price)}`);
    const near = h.nearest && h.nearest.d <= WALKSHED_MI ? `<i style="background:${h.nearest.s.properties.color}"></i>` : '';
    el.innerHTML = `${near}${fmtPrice(h.price)}`;
    el.addEventListener('click', e => { e.stopPropagation(); selectHome(map, h.id, { fly: false }); });
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([h.lng, h.lat]).addTo(map);
    state.markers.set(h.id, marker);
  }
}

function homePopupHTML(h) {
  const facts = [h.beds != null && `${h.beds} bd`, h.baths != null && `${h.baths} ba`, h.sqft != null && `${h.sqft.toLocaleString()} sqft`].filter(Boolean).join(' · ');
  const near = h.nearest
    ? `<div class="pop-meta"><span style="color:${h.nearest.s.properties.color}">●</span> ${fmtMi(h.nearest.d)} to ${esc(h.nearest.s.properties.name)} · ~${Math.max(1, Math.round(h.nearest.d * WALK_MIN_PER_MI))} min walk</div>`
    : '';
  return `<div class="pop-eyebrow">${esc(h.status || 'Saved home')}</div>
    <div class="pop-title">${esc(h.address)}</div>
    <div class="pop-meta"><b>${fmtPrice(h.price)}</b>${facts ? ' · ' + facts : ''}</div>
    ${near}
    ${h.notes ? `<div class="pop-meta" style="margin-top:4px">${esc(h.notes)}</div>` : ''}
    ${h.url && /^https?:\/\//.test(h.url) ? `<a class="pop-link" href="${esc(h.url)}" target="_blank" rel="noopener">View listing ↗</a>` : ''}`;
}

function selectHome(map, id, { fly = true } = {}) {
  const h = state.homes.find(x => x.id === id);
  if (!h || h.lat == null) return;
  state.activeId = id;
  for (const [mid, m] of state.markers) m.getElement().classList.toggle('active', mid === id);
  document.querySelectorAll('.home').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  document.querySelector(`.home[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  state.popup?.remove();
  state.popup = new maplibregl.Popup({ offset: 30, maxWidth: '280px' }).setLngLat([h.lng, h.lat]).setHTML(homePopupHTML(h)).addTo(map);
  if (fly) map.flyTo({ center: [h.lng, h.lat], zoom: Math.max(map.getZoom(), 14.5), padding: panelPadding(), speed: 1.4 });
}

// ---------- Panel UI ----------
function renderStats() {
  const unique = new Set(state.stations.map(s => s.properties.name)).size; // CTC/Arena serves both lines
  const mapped = state.homes.filter(h => h.nearest);
  const walkable = mapped.filter(h => h.nearest.d <= WALKSHED_MI).length;
  document.getElementById('stats').innerHTML = `
    <div class="stat"><b>${state.homes.length}</b><span>Saved homes</span></div>
    <div class="stat"><b>${unique}</b><span>Stations</span></div>
    <div class="stat"><b>${mapped.length ? walkable : '—'}</b><span>Within ½ mi</span></div>`;
}

function renderToggles(map) {
  const count = k => state.stations.filter(s => s.properties.line === k).length;
  const items = [
    { k: 'blue', label: 'Blue Line', meta: `Light rail · ${count('blue')}`, sw: `<span class="sw" style="background:var(--blue)"></span>` },
    { k: 'gold', label: 'Gold Line', meta: `Streetcar · ${count('gold')}`, sw: `<span class="sw" style="background:var(--gold)"></span>` },
    { k: 'homes', label: 'Saved homes', meta: '', sw: `<span class="sw dot" style="background:var(--pin)"></span>` },
    { k: 'walksheds', label: '½-mile walksheds', meta: '', sw: `<span class="sw ring"></span>` },
  ];
  const wrap = document.getElementById('toggles');
  wrap.innerHTML = items.map(i => `
    <label class="toggle">${i.sw}<span class="label">${i.label}</span><span class="meta">${i.meta}</span>
      <input type="checkbox" data-k="${i.k}" ${state.layers[i.k] ? 'checked' : ''}><span class="switch"></span></label>`).join('');
  wrap.addEventListener('change', e => {
    const k = e.target.dataset.k; if (!k) return;
    state.layers[k] = e.target.checked; savePref('layers', state.layers);
    applyLayerVisibility(map);
  });
}

function sortedHomes() {
  const arr = [...state.homes];
  const p = h => h.price ?? Infinity;
  if (state.sort === 'priceAsc') arr.sort((a, b) => p(a) - p(b));
  else if (state.sort === 'priceDesc') arr.sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
  else arr.sort((a, b) => (a.nearest?.d ?? Infinity) - (b.nearest?.d ?? Infinity));
  return arr;
}

function renderHomes(map) {
  const list = document.getElementById('homeList');
  if (!state.homes.length) {
    list.innerHTML = `<li class="empty"><strong>No saved homes yet</strong>
      Add the homes from your Charlotte collection to <code>public/data/homes.csv</code>:
      <ol><li>One row per home — <code>address</code> is the only required column.</li>
      <li>Run <code>npm run geocode</code> to fill in coordinates.</li>
      <li>Reload. Each home appears as a price pin with its nearest station.</li></ol></li>`;
    return;
  }
  list.innerHTML = sortedHomes().map(h => {
    const facts = [h.beds != null && `${h.beds} bd`, h.baths != null && `${h.baths} ba`, h.sqft != null && `${h.sqft.toLocaleString()} sqft`].filter(Boolean).join(' · ');
    const near = h.nearest
      ? `<div class="near ${h.nearest.d <= WALKSHED_MI ? 'close' : ''}"><i style="background:${h.nearest.s.properties.color}"></i>${fmtMi(h.nearest.d)} to ${esc(h.nearest.s.properties.name)}</div>`
      : `<div class="near">Not geocoded — run <code>npm run geocode</code></div>`;
    return `<li class="home ${h.id === state.activeId ? 'active' : ''}" data-id="${h.id}" tabindex="0">
      <div class="addr">${esc(h.address.split(',')[0])}</div><div class="price">${fmtPrice(h.price)}</div>
      <div class="facts">${esc(facts || h.address.split(',').slice(1).join(',').trim())}</div><div></div>${near}</li>`;
  }).join('');
}

function bindHomeList(map) {
  const list = document.getElementById('homeList');
  const pick = e => { const li = e.target.closest('.home'); if (li) { selectHome(map, li.dataset.id); collapseSheet(); } };
  list.addEventListener('click', pick);
  list.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); } });
  const sort = document.getElementById('sort');
  sort.value = state.sort;
  sort.addEventListener('change', () => { state.sort = sort.value; savePref('sort', state.sort); renderHomes(map); });
}

function renderSource() {
  const approx = state.stations.some(s => s.properties.source === 'approximate');
  document.getElementById('source').innerHTML = approx
    ? `<span class="warn">Transit stops are approximate (hand-entered seed).</span> Run <code>npm run refresh:transit</code> for exact OpenStreetMap geometry. Distances are straight-line.`
    : `Transit: ${esc(state.transit.attribution || 'OpenStreetMap')}. Distances are straight-line.`;
}

// ---------- Layout helpers ----------
const isPhone = () => matchMedia('(max-width: 720px)').matches;
function panelPadding() {
  return isPhone() ? { top: 40, bottom: innerHeight * 0.48, left: 30, right: 30 } : { top: 60, bottom: 60, left: 400, right: 60 };
}
function collapseSheet() { document.getElementById('panel').classList.remove('expanded'); }

function fitToContent(map, animate = false) {
  const pts = state.homes.filter(h => h.lat != null).map(h => [h.lng, h.lat]);
  const all = pts.length ? pts : state.stations.map(s => s.geometry.coordinates);
  if (!all.length) return;
  const b = all.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(all[0], all[0]));
  map.fitBounds(b, { padding: panelPadding(), maxZoom: 14, duration: animate ? 800 : 0 });
}

// ---------- Boot ----------
async function boot() {
  document.documentElement.dataset.theme = state.theme;
  const [style] = await Promise.all([resolveStyle(state.theme), loadTransit()]);
  await loadHomes();

  const map = new maplibregl.Map({
    container: 'map', style, center: CLT_CENTER, zoom: 11,
    attributionControl: { compact: true }, pitchWithRotate: true,
  });
  window.__map = map;
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');

  map.on('style.load', () => { addOverlay(map); });
  map.once('load', () => { fitToContent(map); addHomeMarkers(map); applyLayerVisibility(map); document.body.dataset.ready = '1'; });

  // Station interactions
  map.on('mouseenter', 'station', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'station', () => (map.getCanvas().style.cursor = ''));
  map.on('click', 'station', e => {
    const f = e.features[0]; const p = f.properties; const c = f.geometry.coordinates;
    const nearby = state.homes.filter(h => h.lat != null && haversineMi([h.lng, h.lat], c) <= WALKSHED_MI);
    state.popup?.remove();
    state.popup = new maplibregl.Popup({ offset: 12, maxWidth: '260px' }).setLngLat(c).setHTML(`
      <div class="pop-eyebrow"><i style="background:${p.color}"></i>${esc(p.lineName)}</div>
      <div class="pop-title">${esc(p.name)}</div>
      <div class="pop-meta">${nearby.length ? `${nearby.length} saved home${nearby.length > 1 ? 's' : ''} within ½ mi` : 'No saved homes within ½ mi'}</div>`).addTo(map);
  });

  // Theme toggle swaps basemap; overlay is re-added on style.load.
  document.getElementById('theme').addEventListener('click', async () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    savePref('theme', state.theme);
    document.documentElement.dataset.theme = state.theme;
    map.setStyle(await resolveStyle(state.theme));
  });

  document.getElementById('grabber').addEventListener('click', () => document.getElementById('panel').classList.toggle('expanded'));

  renderStats(); renderToggles(map); renderHomes(map); bindHomeList(map); renderSource();
}

boot();
