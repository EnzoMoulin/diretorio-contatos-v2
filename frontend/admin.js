/* Acesso interno: entra em consulta (sem login, sem funções admin).
   "Acesso administrativo" (login e-mail+senha) eleva quem tem cadastro;
   "Solicitar acesso" abre o formulário; "Sair" volta à consulta (continua no interno). */
const $ = id => document.getElementById(id);
let token = localStorage.getItem('demo-token') || '';
let me = null;            // {id, usuario, admin, escopo}
let sel = { com: '', for: '', uni: '', set: '' };
let coms = [];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
const auth = () => ({ 'Content-Type': 'application/json', 'X-Admin-Token': token });
const logado = () => !!me;

const VIEWS = ['consulta', 'dashboard', 'solicitacoes', 'registro', 'manual', 'config', 'notificacoes'];
document.querySelectorAll('.menu-item[data-view]').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.menu-item[data-view]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    VIEWS.forEach(v => $('view-' + v).classList.add('hidden'));
    $('view-' + btn.dataset.view).classList.remove('hidden');
    if (btn.dataset.view === 'solicitacoes') carregarPedidos();
    if (btn.dataset.view === 'registro') carregarHistorico();
    if (btn.dataset.view === 'dashboard') carregarDashboard();
    if (btn.dataset.view === 'notificacoes') carregarNotificacoes();
  };
});

/* ---- consulta com camadas ---- */
function optLabel(selId) {
  const s = $(selId);
  return s.selectedIndex > 0 ? s.options[s.selectedIndex].text : '';
}

// ✓ nos locais editáveis; fora deles, consulta liberada, edição bloqueada.
function marcaEscopo(comId) {
  if (!logado() || me.escopo === 'all') return '';
  return me.escopo.includes(comId) ? ' ✓' : '';
}

async function loadLocs() {
  $('sel-com').innerHTML = '<option value="">Selecione uma comarca</option>' +
    coms.map(c => `<option value="${c.id}">${esc(c.nome)} (${c.total})${cobre('comarca', c.id) ? ' ✓' : ''}</option>`).join('');
  $('loc-count').textContent = `${coms.length} Comarcas`;
  sel.com = ''; sel.for = ''; sel.uni = ''; sel.set = '';
  $('sel-for').innerHTML = '<option value="">Fórum…</option>';
  $('sel-uni').innerHTML = '<option value="">Unidade…</option>';
  $('sel-set').innerHTML = '<option value="">Setor…</option>';
  $('sel-for').disabled = true;
  $('sel-uni').disabled = true;
  $('sel-set').disabled = true;
}

async function onCom(skip) {
  sel.com = $('sel-com').value; sel.for = ''; sel.uni = ''; sel.set = '';
  const sf = $('sel-for'), su = $('sel-uni'), ss = $('sel-set');
  sf.innerHTML = '<option value="">Fórum…</option>';
  su.innerHTML = '<option value="">Unidade…</option>';
  ss.innerHTML = '<option value="">Setor…</option>';
  su.disabled = true; ss.disabled = true;
  if (sel.com) {
    const fors = await (await fetch('/api/foruns?comarca_id=' + sel.com)).json();
    forsCache = fors;
    sf.innerHTML += fors.map(f => `<option value="${f.id}">${esc(f.nome)}${cobre('forum', f.id) ? ' ✓' : ''}</option>`).join('');
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
    const unis = await (await fetch('/api/unidades?forum_id=' + sel.for)).json();
    unisCache = unis;
    su.innerHTML += unis.map(u => `<option value="${u.id}">${esc(u.nome)}${cobre('unidade', u.id) ? ' ✓' : ''}</option>`).join('');
    su.disabled = false;
  } else su.disabled = true;
  if (!skip) sync();
}

async function onUni(skip) {
  sel.uni = $('sel-uni').value; sel.set = '';
  const ss = $('sel-set');
  ss.innerHTML = '<option value="">Setor…</option>';
  if (sel.uni) {
    const sets = await (await fetch('/api/setores?unidade_id=' + sel.uni)).json();
    setsCache = sets;
    ss.innerHTML += sets.map(s => `<option value="${s.id}">${esc(s.nome)}${cobre('setor', s.id) ? ' ✓' : ''}</option>`).join('');
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

function setLoc(id) {
  navTo(String(id));
}

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
  refreshSol();
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
  titulo = titulo.replace(/ \(\d+\)( ✓)?$/, '').replace(/ ✓$/, '');
  const ctts = await (await fetch('/api/contatos?' + params)).json();
  $('print-area').innerHTML = `<h2 class="fc-title">${esc(titulo)}</h2>` +
    `<p class="fc-subtitle">${ctts.length} contato(s)</p>` +
    ctts.map(c => printRow(c, sel.set ? '' : `${c.comarca} · ${c.forum} · ${c.unidade} · ${c.setor}`)).join('');
  window.print();
}
$('btn-print').onclick = imprimirEscopo;

// "Solicitar acesso" agora vive dentro dos cards sem cobertura.
function refreshSol() {}
function podeEditar(comarca) {
  const c = coms.find(x => x.nome === comarca);
  return c && cobre('comarca', c.id);
}

let forsCache = [], unisCache = [], setsCache = [];

// cobertura com herança de cima: comarca > forum > unidade > setor
function cobre(nivel, id) {
  if (!logado()) return false;
  if (me.escopo === 'all') return true;
  const g = new Set(me.escopo.map(a => a.nivel + ':' + a.alvo_id));
  id = Number(id);
  if (g.has(nivel + ':' + id)) return true;
  const porId = (arr) => arr.find(x => x.id === id);
  if (nivel === 'forum') {
    const f = porId(forsCache);
    return !!(f && g.has('comarca:' + f.comarca_id));
  }
  if (nivel === 'unidade') {
    const u = porId(unisCache);
    if (!u) return false;
    const f = (forsCache.find(x => x.id === u.forum_id)) || null;
    return g.has('unidade:' + u.id) ||
      g.has('forum:' + u.forum_id) || !!(f && g.has('comarca:' + f.comarca_id));
  }
  if (nivel === 'setor') {
    const s = porId(setsCache);
    if (!s) return false;
    const u = unisCache.find(x => x.id === s.unidade_id);
    const f = u && forsCache.find(x => x.id === u.forum_id);
    return g.has('setor:' + s.id) ||
      g.has('unidade:' + s.unidade_id) ||
      !!(u && g.has('forum:' + u.forum_id)) ||
      !!(f && g.has('comarca:' + f.comarca_id));
  }
  return false;
}

function cobreContato(c) {
  if (!logado()) return false;
  if (me.escopo === 'all') return true;
  const g = new Set(me.escopo.map(a => a.nivel + ':' + a.alvo_id));
  return g.has('setor:' + c.setor_id) || g.has('unidade:' + c.unidade_id) ||
         g.has('forum:' + c.forum_id) || g.has('comarca:' + c.comarca_id);
}
const pill = (n, s, p) => `<span class="fc-pill">${n} ${n == 1 ? s : p}</span>`;

function cardNivel(tipo, id, nome, meta, solBtn) {
  return `<div class="fc-card" data-nav="${tipo}" data-id="${id}">` +
    `<div class="fc-card-head"><div><h4>${esc(nome)}</h4></div></div>` +
    `<div class="fc-meta">${meta}</div>${solBtn || ''}</div>`;
}

function solBtnNivel(nivel, id) {
  if (!logado() || cobre(nivel, id)) return '';
  return `<button type="button" class="fc-access" data-sol="${nivel}" data-id="${id}">Solicitar acesso</button>`;
}

function cardContato(c, caminho) {
  const tel = c.telefone ? `<a class="fc-contato-valor" href="tel:${esc(String(c.telefone).replace(/\D/g, ''))}">${esc(c.telefone)}</a><button type="button" class="fc-copy-btn" data-copy="${esc(c.telefone)}" title="Copiar">⧉</button>` : '';
  const mail = c.email ? `<a class="fc-contato-valor" href="mailto:${esc(c.email)}">${esc(c.email)}</a><button type="button" class="fc-copy-btn" data-copy="${esc(c.email)}" title="Copiar">⧉</button>` : '';
  const acoes = cobreContato(c)
    ? `<span class="fc-contato-actions"><button class="fc-icon-btn" data-edit="${c.id}">✏️ Editar</button>` +
      `<button class="fc-icon-btn fc-icon-btn--danger" data-del="${c.id}">🗑️ Remover</button></span>` : '';
  return `<div class="fc-contato"><div class="fc-contato-main">` +
    `<span class="fc-contato-tipo">${esc(c.cargo || '')}${caminho ? ' · ' + esc(caminho) : ''}</span>` +
    `<h4>${esc(c.nome)}</h4></div>` +
    `<div class="fc-contato-side">${tel}${mail}${acoes}</div></div>`;
}

function bindCards() {
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
    el.onclick = (e) => {
      if (e.target.closest('[data-sol]')) return;
      const id = el.dataset.id, t = el.dataset.nav;
      if (t === 'com') navTo(id);
      else if (t === 'for') navTo(sel.com, id);
      else if (t === 'uni') navTo(sel.com, sel.for, id);
      else if (t === 'set') navTo(sel.com, sel.for, sel.uni, id);
    };
  });
  document.querySelectorAll('#lista [data-sol]').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const nomes = { comarca: optLabel('sel-com').replace(/ \(\d+\)( ✓)?$/, ''),
                      forum: optLabel('sel-for').replace(/ ✓$/, ''),
                      unidade: optLabel('sel-uni').replace(/ ✓$/, ''),
                      setor: optLabel('sel-set').replace(/ ✓$/, '') };
      abrirConf(el.dataset.sol, el.dataset.id,
        nomes[el.dataset.sol] || el.dataset.id);
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
  document.querySelectorAll('#lista [data-edit]').forEach(b => {
    b.onclick = () => abrirEdicao(Number(b.dataset.edit));
  });
  document.querySelectorAll('#lista [data-del]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Remover este contato?')) return;
      const r = await fetch('/api/contatos/' + b.dataset.del, { method: 'DELETE', headers: auth() });
      if (!r.ok) alert('Erro: ' + await r.text());
      sync();
    };
  });
}

async function buscar() {
  const box = $('lista');
  $('create-box').classList.add('hidden');
  $('save-status').textContent = '';
  const selRow = $('sel-row');
  if (selRow) document.querySelector('.fc-panel').insertBefore(selRow, box);
  if (!sel.set && !sel.uni && !sel.for && !sel.com) {
    document.querySelector('.fc-panel').insertBefore($('sel-row'), $('lista'));
    box.innerHTML = `<div class="fc-section"><h3>Comarcas</h3>` + coms.map(c =>
      cardNivel('com', c.id, c.nome + (cobre('comarca', c.id) ? ' ✓' : ''),
        pill(c.n_foruns || 0, 'Fórum', 'Fóruns') +
        pill(c.n_unidades || 0, 'Unidade', 'Unidades') +
        pill(c.n_setores || 0, 'Setor', 'Setores') +
        pill(c.total, 'contato', 'contatos'), solBtnNivel('comarca', c.id))
    ).join('') + `</div>` || '<div class="fc-empty">Nenhum local.</div>';
  } else if (!sel.set && !sel.uni && !sel.for && sel.com) {
    const [fors, ctts] = await Promise.all([
      (await fetch('/api/foruns?comarca_id=' + sel.com)).json(),
      (await fetch('/api/contatos?comarca_id=' + sel.com)).json(),
    ]);
    forsCache = fors;
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
      fors.map(f => cardNivel('for', f.id, f.nome + (cobre('forum', f.id) ? ' ✓' : ''),
        `<span class="fc-pill fc-pill-type">Fórum</span>` +
        pill(f.n_unidades || 0, 'Unidade', 'Unidades') +
        pill(f.n_setores || 0, 'Setor', 'Setores') +
        pill(porFor[f.id] || 0, 'contato', 'contatos'), solBtnNivel('forum', f.id))).join('') + `</div>`;
  } else if (!sel.set && !sel.uni && sel.for) {
    const [unis, ctts] = await Promise.all([
      (await fetch('/api/unidades?forum_id=' + sel.for)).json(),
      (await fetch('/api/contatos?forum_id=' + sel.for)).json(),
    ]);
    unisCache = unis;
    const porUni = {};
    ctts.forEach(c => { porUni[c.unidade_id] = (porUni[c.unidade_id] || 0) + 1; });
    const nSet = unis.reduce((a, u) => a + (u.n_setores || 0), 0);
    box.innerHTML = `<button class="fc-back" data-back="com">← ${esc(optLabel('sel-com'))}</button>` +
      `<div class="fc-head"><div><h2 class="fc-title">${esc(optLabel('sel-for'))}</h2>` +
      `<p class="fc-subtitle">${unis.length} Unidades · ${nSet} Setores · ${ctts.length} Contatos</p></div></div>` +
      chainHtml() +
      `<div id="sel-slot"></div>` +
      `<div class="fc-section"><h3>Unidades</h3>` +
      unis.map(u => cardNivel('uni', u.id, u.nome + (cobre('unidade', u.id) ? ' ✓' : ''),
        `<span class="fc-pill fc-pill-type">Unidade</span>` +
        pill(u.n_setores || 0, 'Setor', 'Setores') +
        pill(porUni[u.id] || 0, 'contato', 'contatos'), solBtnNivel('unidade', u.id))).join('') + `</div>`;
  } else if (!sel.set && sel.uni) {
    const [sets, ctts] = await Promise.all([
      (await fetch('/api/setores?unidade_id=' + sel.uni)).json(),
      (await fetch('/api/contatos?unidade_id=' + sel.uni)).json(),
    ]);
    setsCache = sets;
    const porSet = {};
    ctts.forEach(c => { porSet[c.setor_id] = (porSet[c.setor_id] || 0) + 1; });
    box.innerHTML = `<button class="fc-back" data-back="for">← ${esc(optLabel('sel-for'))}</button>` +
      `<div class="fc-head"><div><h2 class="fc-title">${esc(optLabel('sel-uni'))}</h2>` +
      `<p class="fc-subtitle">${sets.length} Setores · ${ctts.length} Contatos</p></div></div>` +
      chainHtml() +
      `<div id="sel-slot"></div>` +
      `<div class="fc-section"><h3>Setores</h3>` +
      sets.map(s => cardNivel('set', s.id, s.nome + (cobre('setor', s.id) ? ' ✓' : ''),
        `<span class="fc-pill fc-pill-type">Setor</span>` +
        pill(porSet[s.id] || 0, 'contato', 'contatos'), solBtnNivel('setor', s.id))).join('') + `</div>`;
  } else {
    const params = new URLSearchParams();
    if (sel.set) params.set('setor_id', sel.set);
    else if (sel.uni) params.set('unidade_id', sel.uni);
    else if (sel.for) params.set('forum_id', sel.for);
    else if (sel.com) params.set('comarca_id', sel.com);
    const ctts = await (await fetch('/api/contatos?' + params)).json();
    lastList = ctts;
    box.innerHTML = (sel.set
      ? `<button class="fc-back" data-back="uni">← ${esc(optLabel('sel-uni'))}</button>` +
        `<div class="fc-head"><div><h2 class="fc-title">${esc(optLabel('sel-set'))}</h2></div></div>` +
        chainHtml() +
        `<div><span class="fc-pill fc-pill-type">Setor</span></div>` +
        `<div id="sel-slot"></div>`
      : '') +
      `<div class="fc-section"><h3>Contatos deste setor</h3>` +
      ctts.map(c => cardContato(c, sel.set ? '' : `${c.comarca} · ${c.forum} · ${c.unidade} · ${c.setor}`)).join('') +
      `</div>` ||
      '<div class="fc-empty">Nenhum contato.</div>';
    if (logado() && sel.set) {
      const ok = cobre('setor', sel.set);
      $('create-box').classList.toggle('hidden', !ok);
      if (!ok) $('save-status').textContent = '';
    }
  }
  const slot = $('sel-slot');
  const row2 = $('sel-row');
  if (slot && row2 && !sel.for && !sel.uni && !sel.set) slot.appendChild(row2);
  refreshTopo();
  bindCards();
}

function refreshTopo() {
  const panel = document.querySelector('.fc-panel');
  $('btn-topo').classList.toggle('hidden',
    panel.scrollHeight <= panel.clientHeight + 1);
}
let lastList = [];
let editId = null;

function abrirEdicao(id) {
  const c = lastList.find(x => x.id === id);
  if (!c) return;
  editId = id;
  $('e-nome').value = c.nome || '';
  $('e-cargo').value = c.cargo || '';
  $('e-tel').value = c.telefone || '';
  $('e-email').value = c.email || '';
  $('e-status').textContent = '';
  $('modal-edit').classList.remove('hidden');
}
$('e-cancel').onclick = () => $('modal-edit').classList.add('hidden');
$('e-salvar').onclick = async () => {
  const corpo = { nome: $('e-nome').value.trim(), cargo: $('e-cargo').value.trim(),
                  telefone: $('e-tel').value.trim(), email: $('e-email').value.trim() };
  const r = await fetch('/api/contatos/' + editId, { method: 'PUT', headers: auth(), body: JSON.stringify(corpo) });
  if (r.ok) { $('modal-edit').classList.add('hidden'); sync(); }
  else $('e-status').textContent = 'Erro: ' + await r.text();
};
/* busca removida — navegação por mapa, menu e cards */
$('salvar').onclick = async () => {
  const corpo = { setor_id: sel.set, nome: $('f-nome').value.trim(),
                  cargo: $('f-cargo').value.trim(), telefone: $('f-tel').value.trim(),
                  email: $('f-email').value.trim() };
  const r = await fetch('/api/contatos', { method: 'POST', headers: auth(), body: JSON.stringify(corpo) });
  if (r.ok) { $('f-nome').value = ''; $('f-cargo').value = ''; $('f-tel').value = ''; $('f-email').value = ''; sync(); }
  else $('save-status').textContent = 'Erro: ' + await r.text();
};

/* ---- acesso: entrar / pedir / sair ---- */
async function refresh() {
  me = null;
  if (token) {
    const r = await fetch('/api/me', { headers: auth() });
    if (r.ok) me = await r.json();
    else { token = ''; localStorage.removeItem('demo-token'); }
  }
  const dentro = logado();
  $('menu-dash').classList.toggle('hidden', !dentro);
  $('menu-notif').classList.toggle('hidden', !dentro);
  $('menu-sol').classList.toggle('hidden', !dentro);
  $('menu-reg').classList.toggle('hidden', !dentro);
  $('who-line').textContent = dentro ? '👤 ' + me.usuario : 'Sem acesso administrativo';
  $('btn-entrar').classList.toggle('hidden', dentro);
  $('btn-sair').classList.toggle('hidden', !dentro);
  $('btn-pedir').onclick = dentro ? abrirPedidoMais : abrirPedidoNovo;
  $('estado-hint').textContent = dentro
    ? 'Logado como ' + me.usuario + (me.escopo === 'all' ? ' (admin: todos os locais).' : ` (locais liberados: ${me.escopo.length}).`)
    : 'Consulta sem login. Com cadastro, entre para gerenciar seus locais.';
  $('profile-badge').innerHTML = dentro
    ? '👤 ' + esc(me.usuario)
    : '<i>●</i> Visitante';
  if (dentro) carregarPedidos();
  if (dentro) notifBadge(); else $('notif-count').textContent = '';
  VIEWS.forEach(v => $('view-' + v).classList.add('hidden'));
  $('view-consulta').classList.remove('hidden');
  document.querySelectorAll('.menu-item[data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === 'consulta'));
  if (dentro) {
    $('conf-logado').classList.remove('hidden');
    $('conf-conta').textContent = `Usuário: ${me.usuario} · e-mail: ${me.email || '—'}` +
      (me.escopo === 'all' ? ' · admin (todos os locais).' : ` · ${me.escopo.length} acesso(s).`);
  }
  else $('conf-logado').classList.add('hidden');
  loadLocs();
  sync();
}
$('btn-entrar').onclick = () => { $('modal-login').classList.remove('hidden'); $('l-status').textContent = ''; };
$('l-cancel').onclick = () => $('modal-login').classList.add('hidden');
$('login').onclick = async () => {
  const r = await fetch('/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: $('user').value, senha: $('pass').value }) });
  const j = await r.json();
  if (j.token) {
    token = j.token; localStorage.setItem('demo-token', token);
    $('modal-login').classList.add('hidden');
    refresh();
  } else $('l-status').textContent = j.erro || 'falhou';
};
$('btn-sair').onclick = () => {
  token = ''; localStorage.removeItem('demo-token');
  refresh();
};

/* ---- modal pedir acesso (novo cadastro ou mais locais) ---- */
function preencherLocais() {
  if (!$('p-loc').options.length) {
    $('p-loc').innerHTML = coms.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
  }
}
function abrirPedidoNovo() {
  $('modal-pedido').classList.remove('hidden');
  $('p-status').textContent = '';
  $('ped-hint').textContent = 'Exigido e-mail institucional @exemplo.jus.br (equivale ao vínculo da intranet).';
  $('p-user').disabled = false;
  preencherLocais();
}
function abrirPedidoMais() {
  $('modal-pedido').classList.remove('hidden');
  $('p-status').textContent = '';
  $('ped-hint').textContent = 'Pedir acesso a mais um local (entra como ' + me.usuario + ').';
  $('p-user').value = me.usuario;
  $('p-user').disabled = true;
  $('p-email').value = '';
  preencherLocais();
}
$('p-cancel').onclick = () => {
  $('modal-pedido').classList.add('hidden');
  $('p-user').disabled = false;
};

/* ---- confirmação dinâmica de solicitação por nível ---- */
let confPed = null; // {nivel, alvo_id}
async function abrirConf(nivel, id, nome) {
  confPed = { nivel, alvo_id: Number(id) };
  $('c-status').textContent = '';
  $('c-motivo').value = '';
  let texto = '';
  if (nivel === 'comarca') {
    const fors = await (await fetch('/api/foruns?comarca_id=' + id)).json();
    const nUni = fors.reduce((a, f) => a + (f.n_unidades || 0), 0);
    texto = `Solicitar acesso à comarca <b>${esc(nome)}</b> inteira — ` +
            `todos os ${fors.length} fóruns, ${nUni} unidades e seus setores?`;
  } else if (nivel === 'forum') {
    const unis = await (await fetch('/api/unidades?forum_id=' + id)).json();
    const nSet = unis.reduce((a, u) => a + (u.n_setores || 0), 0);
    texto = `Solicitar acesso ao fórum <b>${esc(nome)}</b> inteiro — ` +
            `todas as ${unis.length} unidades e seus ${nSet} setores?`;
  } else if (nivel === 'unidade') {
    const sets = await (await fetch('/api/setores?unidade_id=' + id)).json();
    texto = `Solicitar acesso à unidade <b>${esc(nome)}</b> inteira — ` +
            `todos os ${sets.length} setor(es)?`;
  } else {
    texto = `Solicitar acesso ao setor <b>${esc(nome)}</b>?`;
  }
  $('conf-texto').innerHTML = texto;
  $('modal-conf').classList.remove('hidden');
}
$('c-cancel').onclick = () => $('modal-conf').classList.add('hidden');
$('c-enviar').onclick = async () => {
  const corpo = { nome: me.usuario, email: me.email, usuario: me.usuario,
                  motivo: $('c-motivo').value.trim(),
                  nivel: confPed.nivel, alvo_id: confPed.alvo_id };
  const r = await fetch('/api/pedidos', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  $('c-status').textContent = r.ok
    ? 'Pedido enviado. Aguarde a aprovação do administrador.'
    : 'Erro: ' + await r.text();
};
$('p-enviar').onclick = async () => {
  const corpo = { nome: $('p-nome').value.trim(), email: $('p-email').value.trim(),
                  usuario: ($('p-user').disabled && logado() ? me.usuario : $('p-user').value.trim()),
                  motivo: $('p-motivo').value.trim(), comarca_id: $('p-loc').value };
  const r = await fetch('/api/pedidos', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  $('p-status').textContent = r.ok
    ? 'Pedido enviado. Aguarde a aprovação do administrador.'
    : 'Erro: ' + await r.text();
};

/* ---- dashboard ---- */
async function carregarDashboard() {
  if (!logado()) return;
  const r = await (await fetch('/api/resumo', { headers: auth() })).json();
  const comEdit = coms.filter(c => cobre('comarca', c.id));
  const totalEdit = comEdit.reduce((a, c) => a + c.total, 0);
  const totalGeral = coms.reduce((a, c) => a + c.total, 0);
  $('dash-sub').textContent = me.escopo === 'all'
    ? `Admin: ${totalGeral} contatos em ${coms.length} comarcas.`
    : `Você edita ${totalEdit} de ${totalGeral} contatos (${comEdit.length} comarca(s) com cobertura total).`;
  $('dash-cards').innerHTML = [
    ['🏙️ Comarcas', coms.length],
    ['🏢 Fóruns', r.por_forum.length],
    ['🏬 Unidades', r.por_unidade.length],
    ['🗂️ Setores', r.por_setor.length],
    ['👥 Contatos (total)', totalGeral],
    ['✏️ Contatos editáveis', me.escopo === 'all' ? totalGeral : totalEdit],
    ['⏳ Solicitações pendentes', r.pendentes],
  ].map(([t, v]) => `<div class="dash-card"><span>${v}</span>${t}</div>`).join('');
  const max = Math.max(1, ...coms.map(c => c.total));
  $('dash-mun').innerHTML = coms.map(c => {
    const w = Math.round(100 * c.total / max);
    const ok = cobre('comarca', c.id);
    return `<div class="bar-row"><span class="bar-label">${esc(c.nome)}${ok ? ' ✓' : ''}</span>` +
      `<span class="bar-track"><span class="bar-fill${ok ? '' : ' ro'}" style="width:${w}%"></span></span>` +
      `<span class="bar-num">${c.total}</span></div>`;
  }).join('');
  $('dash-ult').innerHTML = (r.ultimos || []).map(x =>
    `<li><b>${esc(x.acao)}</b> — ${esc(x.detalhe)} <i>${esc(x.data)}</i></li>`
  ).join('') || '<li>Sem registros.</li>';
}

/* ---- configurações: senha + tema ---- */
$('s-salvar').onclick = async () => {
  const r = await fetch('/api/me/senha', { method: 'POST', headers: auth(),
    body: JSON.stringify({ atual: $('s-atual').value, nova: $('s-nova').value }) });
  $('s-status').textContent = r.ok
    ? 'Senha atualizada.'
    : 'Erro: ' + (await r.json()).erro;
  if (r.ok) { $('s-atual').value = ''; $('s-nova').value = ''; }
};
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
aplicarTema();

/* ---- notificações ---- */
async function notifBadge() {
  if (!logado()) { $('notif-count').textContent = ''; return; }
  const r = await (await fetch('/api/notificacoes', { headers: auth() })).json();
  $('notif-count').textContent = r.nao_lidas ? r.nao_lidas : '';
}
async function carregarNotificacoes() {
  $('notif-logado').classList.toggle('hidden', !logado());
  $('notif-entrar').classList.toggle('hidden', logado());
  if (!logado()) return;
  const r = await (await fetch('/api/notificacoes', { headers: auth() })).json();
  $('notifs').innerHTML = (r.lista || []).map(n =>
    `<li${n.lida ? '' : ' class="nao-lida"'}>${esc(n.texto)} <i>${esc(n.data)}</i>` +
    (n.lida ? '' : ` <button class="btn-ghost dark" data-nid="${n.id}">Marcar como lida</button>`) +
    `</li>`).join('') || '<li>Não há notificações.</li>';
  $('notif-count').textContent = r.nao_lidas ? r.nao_lidas : '';
  document.querySelectorAll('#notifs [data-nid]').forEach(b => {
    b.onclick = async () => {
      await fetch('/api/notificacoes/lida', { method: 'POST', headers: auth(),
        body: JSON.stringify({ id: +b.dataset.nid }) });
      carregarNotificacoes();
    };
  });
}
$('btn-todas-lidas').onclick = async () => {
  await fetch('/api/notificacoes/lidas', { method: 'POST', headers: auth() });
  carregarNotificacoes();
};

/* ---- solicitações / registro ---- */
async function carregarPedidos() {
  if (!logado()) return;
  const lista = await (await fetch('/api/pedidos', { headers: auth() })).json();
  const n = Array.isArray(lista) ? lista.length : 0;
  $('ped-count').textContent = n || '';
  $('pedidos').innerHTML = (Array.isArray(lista) ? lista : []).map(p =>
    `<li><b>${esc(p.nome)}</b> (${esc(p.email)}) — usuário: <code>${esc(p.usuario_desejado)}</code>` +
    (p.alvo_nome ? ` — ${esc({comarca:'comarca',forum:'fórum',unidade:'unidade',setor:'setor'}[p.nivel]||p.nivel)}: <b>${esc(p.alvo_nome)}</b>` : (p.localidade ? ` — local: <b>${esc(p.localidade)}</b>` : '')) +
    (p.motivo ? ` — ${esc(p.motivo)}` : '') +
    ` <button class="btn-primary" data-id="${p.id}">aprovar</button></li>`
  ).join('') || '<li>Nenhuma solicitação pendente.</li>';
  document.querySelectorAll('#pedidos button').forEach(b => {
    b.onclick = async () => {
      const r = await fetch('/api/pedidos/' + b.dataset.id + '/aprovar',
        { method: 'POST', headers: auth() });
      const j = await r.json();
      alert(r.ok ? `Aprovado: ${j.usuario} (senha inicial: ${j.senha_inicial})` : 'Erro: ' + (j.erro || ''));
      carregarPedidos();
    };
  });
}
async function carregarHistorico() {
  if (!logado()) return;
  const h = await (await fetch('/api/historico', { headers: auth() })).json();
  $('hist').innerHTML = (Array.isArray(h) ? h : []).map(x =>
    `<li><b>${esc(x.acao)}</b> — ${esc(x.detalhe)} <i>${esc(x.data)}</i></li>`
  ).join('') || '<li>Sem registros.</li>';
}

(async () => {
  coms = await (await fetch('/api/comarcas')).json();
  $('sel-com').onchange = onCom;
  $('sel-for').onchange = onFor;
  $('sel-uni').onchange = onUni;
  $('sel-set').onchange = onSet;
  await refresh();
  initMapa('map', 'map-msg', coms, nome => {
    const com = coms.find(x => norm(x.nome) === norm(nome));
    if (com) setLoc(com.id);
  });
})();
