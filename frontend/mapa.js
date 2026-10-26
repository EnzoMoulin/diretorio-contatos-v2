/* Mapa Leaflet compartilhado (pública + interna) — espelha o mapa original. */
const GEOJSON_URL = 'https://raw.githubusercontent.com/tbrugz/geodata-br/master/geojson/geojs-32-mun.json';
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

let _mapaOK = false;
let _map = null;
let _layer = null;
let _selecionado = '';

function corPorDensidade(n) {
  if (!n) return '#e2e8f0';
  if (n <= 3) return '#bfdbfe';
  if (n <= 7) return '#60a5fa';
  return '#1d63b8';
}

function estiloComarca(nome, total) {
  const isSel = _selecionado && norm(nome) === norm(_selecionado);
  return {
    fillColor: isSel ? '#00adb5' : (total ? '#93c5fd' : '#f1f5f9'),
    fillOpacity: isSel ? 0.85 : (total ? 0.65 : 0.25),
    color: isSel ? '#0f172a' : (total ? '#2563eb' : '#94a3b8'),
    weight: isSel ? 2.4 : 2,
    opacity: 1,
  };
}

function destacarComarcaMapa(nome) {
  _selecionado = nome || '';
  if (!_layer) return;
  _layer.eachLayer(l => {
    const nm = l.feature.properties.name || '';
    l.setStyle(estiloComarca(nm, l._total || 0));
  });
}

async function initMapa(mapId, msgId, locs, onSelect) {
  const msg = document.getElementById(msgId);
  if (_mapaOK) return true;
  if (typeof L === 'undefined') {
    if (msg) msg.textContent = 'Mapa indisponível offline — use os menus do painel.';
    return false;
  }
  _mapaOK = true;
  _map = L.map(mapId, { zoomControl: true, attributionControl: true, scrollWheelZoom: true, zoomSnap: 0.5 })
    .setView([-19.5, -40.3], 9);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(_map);
  const dens = {};
  (locs || []).forEach(l => { dens[norm(l.nome)] = l.total; });
  try {
    const gj = await (await fetch(GEOJSON_URL)).json();
    _layer = L.geoJSON(gj, {
      style: f => {
        const nome = String(f.properties.name || '').trim();
        return estiloComarca(nome, dens[norm(nome)] || 0);
      },
      onEachFeature: (f, l) => {
        const nome = String(f.properties.name || '').trim();
        const n = dens[norm(nome)] || 0;
        l._total = n;
        l.bindTooltip(
          `<div class="tooltip-premium">${nome}<small>${n} contato(s)</small></div>`,
          { permanent: false, direction: 'auto', sticky: true });
        l.on({
          mouseover: e => {
            if (norm(_selecionado) !== norm(nome)) {
              e.target.setStyle({ fillColor: '#00adb5', fillOpacity: 0.78, weight: 2.2, color: '#0f172a' });
              e.target.bringToFront();
            }
          },
          mouseout: e => {
            if (norm(_selecionado) === norm(nome)) {
              e.target.setStyle({ fillColor: '#00adb5', fillOpacity: 0.85, weight: 2.4, color: '#0f172a' });
            } else _layer.resetStyle(e.target);
          },
          click: () => onSelect && onSelect(nome),
        });
      },
    }).addTo(_map);
    _layer.eachLayer(l => { if (l._total) l.bringToFront(); });
    const enquadrar = () => {
      try {
        _map.fitBounds(_layer.getBounds(), { padding: [-14, -14] });
        _map.setZoom(_map.getZoom() + 0.5, { animate: false });
      } catch (e) {}
    };
    enquadrar();
    setTimeout(() => { try { _map.invalidateSize(); enquadrar(); } catch (e) {} }, 220);
    const legenda = L.control({ position: 'bottomright' });
    legenda.onAdd = () => {
      const div = L.DomUtil.create('div', 'fc-map-legenda');
      div.innerHTML = '<span class="tem-contato">● Comarcas com contatos</span>' +
        '<span class="sem-contato">● Sem contatos cadastrados</span>';
      return div;
    };
    legenda.addTo(_map);
    if (msg) msg.textContent = '';
    return true;
  } catch (e) {
    if (msg) msg.textContent = 'Mapa indisponível offline — use os menus do painel.';
    return false;
  }
}
