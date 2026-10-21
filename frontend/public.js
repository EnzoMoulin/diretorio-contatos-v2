/* Consulta pública: busca + navegação por níveis em cards + mapa.
   Níveis: comarca > fórum > unidade > setor > contatos. */
const $ = id => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

let sel = { com: '', for: '', uni: '', set: '' };
let coms = [];

const get = async (url) => await (await fetch(url)).json();

function optLabel(selId) {
  const s = $(selId);
  return s.selectedIndex > 0 ? s.options[s.selectedIndex].text : '';
}

async function loadComs() {
  $('sel-com').innerHTML = '<option value="">Selecione uma comarca</option>' +
    coms.map(c => `<option value="${c.id}">${esc(c.nome)} (${c.total})</option>`).join('');
}

async function onCom(skip) {
  sel.com = $('sel-com').value; sel.for = ''; sel.uni = ''; sel.set = '';
  const sf = $('sel-for'), su = $('sel-uni'), ss = $('sel-set');
  sf.innerHTML = '<option value="">Fórum…</option>';
  su.innerHTML = '<option value="">Unidade…</option>';
  ss.innerHTML = '<option value="">Setor…</option>';
  su.disabled = true; ss.disabled = true;
  if (sel.com) {
    const fors = await get('/api/foruns?comarca_id=' + sel.com);
    sf.innerHTML += fors.map(f => `<option value="${f.id}">${esc(f.nome)}</option>`).join('');
    sf.disabled = false;
  } else sf.disabled = true;
  if (!skip) sync();
}

async function onFor(skip) {
  sel.for = $('sel-for').value; sel.uni = ''; sel.set = '';
  const su = $('sel-uni'), ss = $('sel-set');
  su.innerHTML = '<option value="">Unidade…</option>';
  ss.innerHTML = '<option value="">Setor…</option>';
  ss.disabled = true;
  if (sel.for) {
    const unis = await get('/api/unidades?forum_id=' + sel.for);
    su.innerHTML += unis.map(u => `<option value="${u.id}">${esc(u.nome)}</option>`).join('');
    su.disabled = false;
  } else su.disabled = true;
  if (!skip) sync();
}

async function onUni(skip) {
  sel.uni = $('sel-uni').value; sel.set = '';
  const ss = $('sel-set');
  ss.innerHTML = '<option value="">Setor…</option>';
  if (sel.uni) {
    const sets = await get('/api/setores?unidade_id=' + sel.uni);
    ss.innerHTML += sets.map(s => `<option value="${s.id}">${esc(s.nome)}</option>`).join('');
    ss.disabled = false;
  } else ss.disabled = true;
  if (!skip) sync();
}

function onSet(skip) {
  sel.set = $('sel-set').value;
  if (!skip) sync();
}

async function navTo(com, fr, uni, set) {
  $('sel-com').value = com || '';
  await onCom(true);
  if (fr) {
    $('sel-for').value = fr;
    await onFor(true);
  }
  if (uni) {
    $('sel-uni').value = uni;
    await onUni(true);
  }
  if (set) $('sel-set').value = set;
  onSet(true);
  sync();
}

function setLoc(id) { navTo(String(id)); }

function nomeLimpo(selId) {
  return optLabel(selId).replace(/ \(\d+\)( ✓)?$/, '').replace(/ ✓$/, '');
}

function chainHtml() {
  if (!sel.com) return '';
  const com = esc(nomeLimpo('sel-com'));
  const fr = sel.for ? esc(nomeLimpo('sel-for')) : '';
  const uni = sel.uni ? esc(nomeLimpo('sel-uni')) : '';
  const set = sel.set ? esc(nomeLimpo('sel-set')) : '';
  const deep = sel.for || sel.uni || sel.set;
  return `<nav class="«redacted:fc-…»">` +
    (deep ? `<button type="button" data-c="com">${com}</button> › ` : `<span>${com}</span>`) +
    (sel.for ? ((sel.uni || sel.set) ? `<button type="button" data-c="for">${fr}</button> › ` : `<span>${fr}</span>`) : '') +
    (sel.uni ? (sel.set ? `<button type="button" data-c="uni">${uni}</button> › ` : `<span>${uni}</span>`) : '') +
    (sel.set ? `<span class="fc-breadcrumb-current">${set}</span>` : '') +
    `</nav>`;
}

function bindChain(scope) {
  scope.querySelectorAll('[data-c]').forEach(b => {
    b.onclick = () => {
      if (b.dataset.c === 'com') navTo(sel.com);
      else if (b.dataset.c === 'for') navTo(sel.com, sel.for);
      else navTo(sel.com, sel.for, sel.uni);
    };
  });
}

function sync() {
  const row = $('sel-row');
  if (row) row.classList.toggle('hidden', !!(sel.for || sel.uni || sel.set));
  $('loc-count').classList.toggle('hidden', !!sel.com);
  $('panel-head').classList.toggle('hidden', !!sel.com);
  $('btn-print').classList.toggle('hidden', !sel.com);
  const bv = $('btn-voltar');
  if (!sel.com && !sel.for && !sel.uni && !sel.set) bv.classList.add('hidden');
  else {
    bv.classList.remove('hidden');
    bv.onclick = () => {
      if (sel.set) navTo(sel.com, sel.for, sel.uni);
      else if (sel.uni) navTo(sel.com, sel.for);
      else if (sel.for) navTo(sel.com);
      else if (sel.com) navTo('');
      else { buscar(); }
    };
  }
  if (typeof destacarComarcaMapa === 'function') {
    const com = coms.find(x => String(x.id) === String(sel.com));
    destacarComarcaMapa(sel.com && com ? com.nome : '');
  }
  buscar();
}

$('btn-topo').onclick = () =>
  document.querySelector('.fc-panel').scrollTo({ top: 0, behavior: 'smooth' });

function printRow(c, caminho) {
  return `<div class="fc-contato"><div class="fc-contato-main">` +
    `<span class="fc-contato-tipo">${esc(c.cargo || '')}${caminho ? ' · ' + esc(caminho) : ''}</span>` +
    `<h4>${esc(c.nome)}</h4></div><div class="fc-contato-side">` +
    (c.telefone ? `<span class="fc-contato-valor">${esc(c.telefone)}</span>` : '') +
    (c.email ? `<span class="fc-contato-valor">${esc(c.email)}</span>` : '') + `</div></div>`;
}

async function imprimirEscopo() {
  const params = new URLSearchParams();
  let titulo = '';
  if (sel.set) { params.set('setor_id', sel.set); titulo = optLabel('sel-set'); }
  else if (sel.uni) { params.set('unidade_id', sel.uni); titulo = optLabel('sel-uni'); }
  else if (sel.for) { params.set('forum_id', sel.for); titulo = optLabel('sel-for'); }
  else if (sel.com) { params.set('comarca_id', sel.com); titulo = optLabel('sel-com'); }
  else return;
  titulo = titulo.replace(/ \(\d+\)$/, '');
  const ctts = await get('/api/contatos?' + params);
  $('print-area').innerHTML = `<h2 class="fc-title">${esc(titulo)}</h2>` +
    `<p class="fc-subtitle">${ctts.length} contato(s)</p>` +
    ctts.map(c => printRow(c, sel.set ? '' : `${c.comarca} · ${c.forum} · ${c.unidade} · ${c.setor}`)).join('');
  window.print();
}
$('btn-print').onclick = imprimirEscopo;

const pill = (n, s, p) => `<span class="fc-pill">${n} ${n == 1 ? s : p}</span>`;

function cardNivel(tipo, id, nome, meta) {
  return `<div class="fc-card" data-nav="${tipo}" data-id="${id}">` +
    `<div class="fc-card-head"><div><h4>${esc(nome)}</h4></div></div>` +
    `<div class="fc-meta">${meta}</div></div>`;
}

function cardContato(c, caminho) {
  const tel = c.telefone ? `<a class="fc-contato-valor" href="tel:${esc(c.telefone.replace(/\D/g, ''))}">${esc(c.telefone)}</a><button type="button" class="fc-copy-btn" data-copy="${esc(c.telefone)}" title="Copiar">⧉</button>` : '';
  const mail = c.email ? `<a class="fc-contato-valor" href="mailto:${esc(c.email)}">${esc(c.email)}</a><button type="button" class="fc-copy-btn" data-copy="${esc(c.email)}" title="Copiar">⧉</button>` : '';
  return `<div class="fc-contato"><div class="fc-contato-main">` +
    `<span class="fc-contato-tipo">${esc(c.cargo || '')}${caminho ? ' · ' + esc(caminho) : ''}</span>` +
    `<h4>${esc(c.nome)}</h4></div>` +
    `<div class="fc-contato-side">${tel}${mail}</div></div>`;
}

function bindNav() {
  bindChain($('lista'));
  document.querySelectorAll('#lista [data-copy]').forEach(b => {
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = b.dataset.copy;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e2) {}
        ta.remove();
      }
      const t = b.textContent;
      b.textContent = '✓';
      setTimeout(() => { b.textContent = t; }, 1200);
    };
  });
  document.querySelectorAll('#lista [data-nav]').forEach(el => {
    el.onclick = () => {
      const id = el.dataset.id, t = el.dataset.nav;
      if (t === 'com') navTo(id);
      else if (t === 'for') navTo(sel.com, id);
      else if (t === 'uni') navTo(sel.com, sel.for, id);
      else if (t === 'set') navTo(sel.com, sel.for, sel.uni, id);
    };
  });
  document.querySelectorAll('#lista [data-back]').forEach(el => {
    el.onclick = () => {
      const t = el.dataset.back;
      if (t === 'home') navTo('');
      else if (t === 'com') navTo(sel.com);
      else if (t === 'for') navTo(sel.com, sel.for);
      else if (t === 'uni') navTo(sel.com, sel.for, sel.uni);
    };
  });
}

async function buscar() {
  const box = $('lista');
  const selRow = $('sel-row');
  if (selRow) document.querySelector('.fc-panel').insertBefore(selRow, box);
  if (!sel.set && !sel.uni && !sel.for && !sel.com) {
    document.querySelector('.fc-panel').insertBefore($('sel-row'), $('lista'));
    box.innerHTML = `<div class="fc-section"><h3>Comarcas</h3>` + coms.map(c =>
      cardNivel('com', c.id, c.nome,
        pill(c.n_foruns || 0, 'Fórum', 'Fóruns') +
        pill(c.n_unidades || 0, 'Unidade', 'Unidades') +
        pill(c.n_setores || 0, 'Setor', 'Setores') +
        pill(c.total, 'contato', 'contatos'))
    ).join('') + `</div>` || '<div class="fc-empty">Nenhum local.</div>';
  } else if (!sel.set && !sel.uni && !sel.for && sel.com) {
    const [fors, ctts] = await Promise.all([
      get('/api/foruns?comarca_id=' + sel.com),
      get('/api/contatos?comarca_id=' + sel.com),
    ]);
    const porFor = {};
    ctts.forEach(c => { porFor[c.forum_id] = (porFor[c.forum_id] || 0) + 1; });
    const com = coms.find(x => String(x.id) === String(sel.com));
    const nUni = fors.reduce((a, f) => a + (f.n_unidades || 0), 0);
    const nSet = fors.reduce((a, f) => a + (f.n_setores || 0), 0);
    box.innerHTML = `<button class="fc-back" data-back="home">← Comarcas</button>` +
      `<div class="fc-head"><div><h2 class="fc-title">${esc(com ? com.nome : '')}</h2>` +
      `<p class="fc-subtitle">${fors.length} Fóruns · ${nUni} Unidades · ${nSet} Setores · ${ctts.length} Contatos</p></div></div>` +
      `<div id="sel-slot"></div>` +
      `<div class="fc-section"><h3>Fóruns</h3>` +
      fors.map(f => cardNivel('for', f.id, f.nome,
        `<span class="fc-pill fc-pill-type">Fórum</span>` +
        pill(f.n_unidades || 0, 'Unidade', 'Unidades') +
        pill(f.n_setores || 0, 'Setor', 'Setores') +
        pill(porFor[f.id] || 0, 'contato', 'contatos'))).join('') + `</div>`;
  } else if (!sel.set && !sel.uni && sel.for) {
    const [unis, ctts] = await Promise.all([
      get('/api/unidades?forum_id=' + sel.for),
      get('/api/contatos?forum_id=' + sel.for),
    ]);
    const porUni = {};
    ctts.forEach(c => { porUni[c.unidade_id] = (porUni[c.unidade_id] || 0) + 1; });
    const nSet = unis.reduce((a, u) => a + (u.n_setores || 0), 0);
    box.innerHTML = `<button class="fc-back" data-back="com">← ${esc(optLabel('sel-com'))}</button>` +
      `<div class="fc-head"><div><h2 class="fc-title">${esc(optLabel('sel-for'))}</h2>` +
      `<p class="fc-subtitle">${unis.length} Unidades · ${nSet} Setores · ${ctts.length} Contatos</p></div></div>` +
      chainHtml() +
      `<div id="sel-slot"></div>` +
      `<div class="fc-section"><h3>Unidades</h3>` +
      unis.map(u => cardNivel('uni', u.id, u.nome,
        `<span class="fc-pill fc-pill-type">Unidade</span>` +
        pill(u.n_setores || 0, 'Setor', 'Setores') +
        pill(porUni[u.id] || 0, 'contato', 'contatos'))).join('') + `</div>`;
  } else if (!sel.set && sel.uni) {
    const [sets, ctts] = await Promise.all([
      get('/api/setores?unidade_id=' + sel.uni),
      get('/api/contatos?unidade_id=' + sel.uni),
    ]);
    const porSet = {};
    ctts.forEach(c => { porSet[c.setor_id] = (porSet[c.setor_id] || 0) + 1; });
    box.innerHTML = `<button class="fc-back" data-back="for">← ${esc(optLabel('sel-for'))}</button>` +
      `<div class="fc-head"><div><h2 class="fc-title">${esc(optLabel('sel-uni'))}</h2>` +
      `<p class="fc-subtitle">${sets.length} Setores · ${ctts.length} Contatos</p></div></div>` +
      chainHtml() +
      `<div id="sel-slot"></div>` +
      `<div class="fc-section"><h3>Setores</h3>` +
      sets.map(s => cardNivel('set', s.id, s.nome,
        `<span class="fc-pill fc-pill-type">Setor</span>` +
        pill(porSet[s.id] || 0, 'contato', 'contatos'))).join('') + `</div>`;
  } else {
    const params = new URLSearchParams();
    if (sel.set) params.set('setor_id', sel.set);
    else if (sel.uni) params.set('unidade_id', sel.uni);
    else if (sel.for) params.set('forum_id', sel.for);
    else if (sel.com) params.set('comarca_id', sel.com);
    const ctts = await get('/api/contatos?' + params);
    const setNome = sel.set ? optLabel('sel-set') : '';
    box.innerHTML = (sel.set
      ? `<button class="fc-back" data-back="uni">← ${esc(optLabel('sel-uni'))}</button>` +
        `<div class="fc-head"><div><h2 class="fc-title">${esc(setNome)}</h2></div></div>` +
        chainHtml() +
        `<div><span class="fc-pill fc-pill-type">Setor</span></div>` +
        `<div id="sel-slot"></div>`
      : '') +
      `<div class="fc-section"><h3>Contatos deste setor</h3>` +
      ctts.map(c => cardContato(c, sel.set ? '' : `${c.comarca} · ${c.forum} · ${c.unidade} · ${c.setor}`)).join('') +
      `</div>` ||
      '<div class="fc-empty">Nenhum contato.</div>';
  }
  const slot = $('sel-slot');
  const row2 = $('sel-row');
  if (slot && row2 && !sel.for && !sel.uni && !sel.set) slot.appendChild(row2);
  refreshTopo();
  bindNav();
}

function refreshTopo() {
  const panel = document.querySelector('.fc-panel');
  $('btn-topo').classList.toggle('hidden',
    panel.scrollHeight <= panel.clientHeight + 1);
}

/* busca removida — navegação por mapa, menu e cards */

function aplicarTema() {
  const dark = (localStorage.getItem('demo-theme') || 'light') === 'dark';
  document.body.dataset.theme = dark ? 'dark' : 'light';
  const t = $('toggle-dark-mode');
  if (t) t.checked = dark;
}
$('toggle-dark-mode').onchange = (e) => {
  localStorage.setItem('demo-theme', e.target.checked ? 'dark' : 'light');
  aplicarTema();
};
(async () => {
  aplicarTema();
  document.querySelectorAll('.menu-item[data-view]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.menu-item[data-view]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ['consulta', 'config', 'manual'].forEach(v => $('view-' + v).classList.add('hidden'));
      $('view-' + btn.dataset.view).classList.remove('hidden');
    };
  });
  coms = await get('/api/comarcas');
  $('loc-count').textContent = `${coms.length} Comarcas`;
  await loadComs();
  $('sel-com').onchange = () => onCom();
  $('sel-for').onchange = () => onFor();
  $('sel-uni').onchange = () => onUni();
  $('sel-set').onchange = () => onSet();
  sync();
  initMapa('map', 'map-msg', coms, nome => {
    const com = coms.find(x => norm(x.nome) === norm(nome));
    if (com) setLoc(com.id);
  });
})();
