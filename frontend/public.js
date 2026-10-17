/* Consulta pública: busca + camadas + mapa + modal de solicitação. */
const $ = id => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

let sel = { loc: '', uni: '', set: '' };
let locs = [];

function optLabel(selId) {
  const s = $(selId);
  return s.selectedIndex > 0 ? s.options[s.selectedIndex].text : '';
}

async function loadLocs() {
  $('sel-loc').innerHTML = '<option value="">Localidade…</option>' +
    locs.map(l => `<option value="${l.id}">${esc(l.nome)} (${l.total})</option>`).join('');
}

async function onLoc() {
  sel.loc = $('sel-loc').value; sel.uni = ''; sel.set = '';
  const su = $('sel-uni'), ss = $('sel-set');
  su.innerHTML = '<option value="">Unidade…</option>';
  ss.innerHTML = '<option value="">Setor…</option>';
  ss.disabled = true;
  if (sel.loc) {
    const unis = await (await fetch('/api/unidades?localidade_id=' + sel.loc)).json();
    su.innerHTML += unis.map(u => `<option value="${u.id}">${esc(u.nome)}</option>`).join('');
    su.disabled = false;
  } else su.disabled = true;
  sync();
}

async function onUni() {
  sel.uni = $('sel-uni').value; sel.set = '';
  const ss = $('sel-set');
  ss.innerHTML = '<option value="">Setor…</option>';
  if (sel.uni) {
    const sets = await (await fetch('/api/setores?unidade_id=' + sel.uni)).json();
    ss.innerHTML += sets.map(s => `<option value="${s.id}">${esc(s.nome)}</option>`).join('');
    ss.disabled = false;
  } else ss.disabled = true;
  sync();
}

function onSet() {
  sel.set = $('sel-set').value;
  sync();
}

function setLoc(id) {
  $('sel-loc').value = String(id);
  onLoc();
}

function sync() {
  const parts = [optLabel('sel-loc'), optLabel('sel-uni'), optLabel('sel-set')].filter(Boolean);
  $('crumb').textContent = parts.length ? parts.join(' › ') : 'Selecione um local ou busque';
  buscar();
}

async function buscar() {
  const q = $('q').value.trim();
  if (!q && !sel.set && !sel.uni && !sel.loc) {
    $('lista').innerHTML = '<tr><td colspan="5" class="hint-cell">Selecione um local no mapa ou nos menus, ou digite uma busca.</td></tr>';
    return;
  }
  const params = new URLSearchParams({ q });
  if (sel.set) params.set('setor_id', sel.set);
  else if (sel.uni) params.set('unidade_id', sel.uni);
  else if (sel.loc) params.set('localidade_id', sel.loc);
  const lista = await (await fetch('/api/contatos?' + params)).json();
  $('lista').innerHTML = lista.map(c =>
    `<tr><td>${esc(c.nome)}</td><td>${esc(c.cargo)}</td>` +
    `<td>${esc(c.localidade)} · ${esc(c.unidade)} · ${esc(c.setor)}</td>` +
    `<td>${esc(c.telefone)}</td><td><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></td></tr>`
  ).join('') || '<tr><td colspan="5">Nenhum contato.</td></tr>';
}

$('q').addEventListener('input', buscar);

function aplicarTema() {
  document.body.dataset.theme = localStorage.getItem('demo-theme') || 'light';
}
$('tema-toggle').onclick = () => {
  localStorage.setItem('demo-theme',
    (localStorage.getItem('demo-theme') || 'light') === 'light' ? 'dark' : 'light');
  aplicarTema();
};
(async () => {
  aplicarTema();
  document.querySelectorAll('.menu-item[data-view]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.menu-item[data-view]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ['consulta', 'config'].forEach(v => $('view-' + v).classList.add('hidden'));
      $('view-' + btn.dataset.view).classList.remove('hidden');
    };
  });
  locs = await (await fetch('/api/localidades')).json();
  await loadLocs();
  $('sel-loc').onchange = onLoc;
  $('sel-uni').onchange = onUni;
  $('sel-set').onchange = onSet;
  sync();
  initMapa('map', 'map-msg', locs, nome => {
    const loc = locs.find(x => norm(x.nome) === norm(nome));
    if (loc) setLoc(loc.id);
  });
})();
