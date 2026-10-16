/* Mapa Leaflet compartilhado (público + admin). */
const GEOJSON_URL = 'https://raw.githubusercontent.com/tbrugz/geodata-br/master/geojson/geojs-32-mun.json';
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

let _mapaOK = false;
async function initMapa(mapId, msgId, locs, onSelect) {
  const msg = document.getElementById(msgId);
  if (_mapaOK) return true;
  if (typeof L === 'undefined') {
    if (msg) msg.textContent = 'Mapa indisponível offline — use as localidades abaixo.';
    return false;
  }
  _mapaOK = true;
  const map = L.map(mapId).setView([-19.9, -40.6], 7);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '© OpenStreetMap' }).addTo(map);
  const dens = {};
  (locs || []).forEach(l => { dens[norm(l.nome)] = l.total; });
  try {
    const gj = await (await fetch(GEOJSON_URL)).json();
    const layer = L.geoJSON(gj, {
      style: f => {
        const n = dens[norm(f.properties.name)] || 0;
        return { color: '#475569', weight: 1, fillOpacity: .55,
                 fillColor: !n ? '#e2e8f0' : n <= 3 ? '#bfdbfe' : '#2563eb' };
      },
      onEachFeature: (f, l) => {
        const nome = f.properties.name;
        l.bindTooltip(`${nome} (${dens[norm(nome)] || 0})`);
        l.on('click', () => onSelect && onSelect(nome));
      }
    }).addTo(map);
    map.fitBounds(layer.getBounds());
    return true;
  } catch (e) {
    if (msg) msg.textContent = 'Mapa indisponível offline — use as localidades abaixo.';
    return false;
  }
}
