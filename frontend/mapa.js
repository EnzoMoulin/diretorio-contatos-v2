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
  if (isSel) return { fillColor: '#00adb5', fillOpacity: 0.85, color: '#0f172a', weight: 2.4, opacity: 1 };
  return total
    ? { fillColor: '#60a5fa', fillOpacity: 0.42, color: '#2563eb', weight: 1.2, opacity: 1 }
    : { fillColor: '#cbd5e1', fillOpacity: 0.24, color: '#94a3b8', weight: 0.8, opacity: 1 };
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
    .setView([-19.6, -40.35], 8);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(_map);
  const dens = {};
  (locs || []).forEach(l => { dens[norm(l.nome)] = { total: l.total || 0, foruns: l.foruns || 0 }; });
  try {
    const gj = await (await fetch(GEOJSON_URL)).json();
    _layer = L.geoJSON(gj, {
      style: f => {
        const nome = String(f.properties.name || '').trim();
        return estiloComarca(nome, ((dens[norm(nome)] || {}).total) || 0);
      },
      onEachFeature: (f, l) => {
        const nome = String(f.properties.name || '').trim();
        const info = dens[norm(nome)] || { total: 0, foruns: 0 };
        const n = info.total || 0;
        const nf = info.foruns || 0;
        l._total = n;
        const detalhe = n > 0
          ? `<small>${nf} ${nf === 1 ? 'Fórum' : 'Fóruns'} • ${n} ${n === 1 ? 'contato' : 'contatos'}</small>`
          : `<small>Sem contatos cadastrados</small>`;
        l.bindTooltip(
          `<div class="tooltip-premium">${nome}${detalhe}</div>`,
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
        _map.fitBounds(_layer.getBounds(), { padding: [3, 3] });
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
