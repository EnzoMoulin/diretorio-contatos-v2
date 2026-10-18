/* Acesso interno: entra em consulta (sem login, sem funções admin).
   "Acesso administrativo" (login e-mail+senha) eleva quem tem cadastro;
   "Solicitar acesso" abre o formulário; "Sair" volta à consulta (continua no interno). */
const $ = id => document.getElementById(id);
let token = localStorage.getItem('demo-token') || '';
let me = null;            // {id, usuario, admin, escopo}
let sel = { loc: '', uni: '', set: '' };
let locs = [];

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
function marcaEscopo(locId) {
  if (!logado() || me.escopo === 'all') return '';
  return me.escopo.includes(locId) ? ' ✓' : '';
}

async function loadLocs() {
  $('sel-loc').innerHTML = '<option value="">Localidade…</option>' +
    locs.map(l => `<option value="${l.id}">${esc(l.nome)} (${l.total})${cobre('municipio', l.id) ? ' ✓' : ''}</option>`).join('');
  $('loc-count').textContent = `${locs.length} Municípios`;
  sel.loc = ''; sel.uni = ''; sel.set = '';
  $('sel-uni').innerHTML = '<option value="">Unidade…</option>';
  $('sel-set').innerHTML = '<option value="">Setor…</option>';
  $('sel-uni').disabled = true;
  $('sel-set').disabled = true;
}

async function onLoc(skip) {
  sel.loc = $('sel-loc').value; sel.uni = ''; sel.set = '';
  const su = $('sel-uni'), ss = $('sel-set');
  su.innerHTML = '<option value="">Unidade…</option>';
  ss.innerHTML = '<option value="">Setor…</option>';
  ss.disabled = true;
  if (sel.loc) {
  const unis = await (await fetch('/api/unidades?localidade_id=' + sel.loc)).json();
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

async function navTo(loc, uni, set) {
  $('sel-loc').value = loc || '';
  await onLoc(true);
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

function sync() {
  const parts = [optLabel('sel-loc'), optLabel('sel-uni'), optLabel('sel-set')].filter(Boolean);
  $('crumb').textContent = parts.length ? parts.join(' › ') : 'Selecione um local ou busque';
  refreshSol();
  $('btn-print').classList.toggle('hidden', !sel.loc);
  const bv = $('btn-voltar');
  if (!sel.loc && !sel.uni && !sel.set && !$('q').value.trim()) bv.classList.add('hidden');
  else {
    bv.classList.remove('hidden');
    bv.onclick = () => {
      if (sel.set) navTo(sel.loc, sel.uni);
      else if (sel.uni) navTo(sel.loc);
      else if (sel.loc) navTo('');
      else { $('q').value = ''; buscar(); }
    };
  }
  if (typeof destacarMunicipioMapa === 'function') {
    const loc = locs.find(x => String(x.id) === String(sel.loc));
    destacarMunicipioMapa(sel.loc && loc ? loc.nome : '');
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
  else if (sel.loc) { params.set('localidade_id', sel.loc); titulo = optLabel('sel-loc'); }
  else return;
  titulo = titulo.replace(/ \(\d+\)( ✓)?$/, '').replace(/ ✓$/, '');
  const ctts = await (await fetch('/api/contatos?' + params)).json();
  $('print-area').innerHTML = `<h2 class="fc-title">${esc(titulo)}</h2>` +
    `<p class="fc-subtitle">${ctts.length} contato(s)</p>` +
    ctts.map(c => printRow(c, sel.set ? '' : `${c.localidade} · ${c.unidade} · ${c.setor}`)).join('');
  window.print();
}
$('btn-print').onclick = imprimirEscopo;

// "Solicitar acesso" agora vive dentro dos cards sem cobertura.
function refreshSol() {}
function podeEditar(localidade) {
  const l = locs.find(x => x.nome === localidade);
  return l && cobre('municipio', l.id);
}

let unisCache = [], setsCache = [];

// cobertura com herança de cima: municipio > unidade > setor
function cobre(nivel, id) {
  if (!logado()) return false;
  if (me.escopo === 'all') return true;
  const g = new Set(me.escopo.map(a => a.nivel + ':' + a.alvo_id));
  id = Number(id);
  if (g.has(nivel + ':' + id)) return true;
  if (nivel === 'unidade') {
    const u = unisCache.find(x => x.id === id);
    return !!(u && g.has('municipio:' + u.localidade_id));
  }
  if (nivel === 'setor') {
    const s = setsCache.find(x => x.id === id);
    if (!s) return false;
    const u = unisCache.find(x => x.id === s.unidade_id);
    return g.has('unidade:' + s.unidade_id) || !!(u && g.has('municipio:' + u.localidade_id));
  }
  return false;
}

function cobreContato(c) {
  if (!logado()) return false;
  if (me.escopo === 'all') return true;
  const g = new Set(me.escopo.map(a => a.nivel + ':' + a.alvo_id));
  return g.has('setor:' + c.setor_id) || g.has('unidade:' + c.unidade_id) ||
         g.has('municipio:' + c.localidade_id);
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
  const tel = c.telefone ? `<a class="fc-contato-valor" href="tel:${esc(String(c.telefone).replace(/\D/g, ''))}">${esc(c.telefone)}</a>` : '';
  const mail = c.email ? `<a class="fc-contato-valor" href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '';
  const acoes = cobreContato(c)
    ? `<span class="fc-contato-actions"><button class="fc-icon-btn" data-edit="${c.id}">✏️ Editar</button>` +
      `<button class="fc-icon-btn fc-icon-btn--danger" data-del="${c.id}">🗑️ Remover</button></span>` : '';
  return `<div class="fc-contato"><div class="fc-contato-main">` +
    `<span class="fc-contato-tipo">${esc(c.cargo || '')}${caminho ? ' · ' + esc(caminho) : ''}</span>` +
    `<h4>${esc(c.nome)}</h4></div>` +
    `<div class="fc-contato-side">${tel}${mail}${acoes}</div></div>`;
}

function bindCards() {
  document.querySelectorAll('#lista [data-nav]').forEach(el => {
    el.onclick = (e) => {
      if (e.target.closest('[data-sol]')) return;
      const id = el.dataset.id, t = el.dataset.nav;
      if (t === 'loc') navTo(id);
      else if (t === 'uni') navTo(sel.loc, id);
      else if (t === 'set') navTo(sel.loc, sel.uni, id);
    };
  });
  document.querySelectorAll('#lista [data-sol]').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const nomes = { municipio: optLabel('sel-loc').replace(/ \(\d+\)( ✓)?$/, ''),
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
      else if (t === 'loc') navTo(sel.loc);
      else if (t === 'uni') navTo(sel.loc, sel.uni);
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
  const q = $('q').value.trim();
  const box = $('lista');
  $('create-box').classList.add('hidden');
  $('save-status').textContent = '';
  if (!q && !sel.set && !sel.uni && !sel.loc) {
    box.innerHTML = `<div class="fc-section"><h3>Municípios</h3>` + locs.map(l =>
      cardNivel('loc', l.id, l.nome + (cobre('municipio', l.id) ? ' ✓' : ''),
        pill(l.n_unidades || 0, 'Unidade', 'Unidades') +
        pill(l.n_setores || 0, 'Setor', 'Setores') +
        pill(l.total, 'contato', 'contatos'), solBtnNivel('municipio', l.id))
    ).join('') + `</div>` || '<div class="fc-empty">Nenhum local.</div>';
  } else if (!sel.set && !sel.uni && sel.loc && !q) {
    const [unis, ctts] = await Promise.all([
      (await fetch('/api/unidades?localidade_id=' + sel.loc)).json(),
      (await fetch('/api/contatos?localidade_id=' + sel.loc)).json(),
    ]);
    unisCache = unis;
    const porUni = {};
    ctts.forEach(c => { porUni[c.unidade_id] = (porUni[c.unidade_id] || 0) + 1; });
    const loc = locs.find(x => String(x.id) === String(sel.loc));
    box.innerHTML = `<button class="fc-back" data-back="home">← Localidades</button>` +
      `<div class="fc-head"><div><h2 class="fc-title">${esc(loc ? loc.nome : '')}</h2></div></div>` +
      unis.map(u => cardNivel('uni', u.id, u.nome + (cobre('unidade', u.id) ? ' ✓' : ''),
        `<span class="fc-pill fc-pill-type">Unidade</span>` +
        pill(u.n_setores || 0, 'Setor', 'Setores') +
        pill(porUni[u.id] || 0, 'contato', 'contatos'), solBtnNivel('unidade', u.id))).join('');
  } else if (!sel.set && sel.uni) {
    const params = new URLSearchParams({ unidade_id: sel.uni, q });
    const [sets, ctts] = await Promise.all([
      q ? [] : (await fetch('/api/setores?unidade_id=' + sel.uni)).json(),
      (await fetch('/api/contatos?' + params)).json(),
    ]);
    if (!q) setsCache = sets;
    const porSet = {};
    ctts.forEach(c => { porSet[c.setor_id] = (porSet[c.setor_id] || 0) + 1; });
    box.innerHTML = `<button class="fc-back" data-back="loc">← ${esc(optLabel('sel-loc'))}</button>` +
      `<div class="fc-head"><div><h2 class="fc-title">${esc(optLabel('sel-uni'))}</h2></div></div>` +
      (q
        ? ctts.map(c => cardContato(c, c.setor)).join('') || '<div class="fc-empty">Nenhum contato.</div>'
        : sets.map(s => cardNivel('set', s.id, s.nome + (cobre('setor', s.id) ? ' ✓' : ''),
            `<span class="fc-pill fc-pill-type">Setor</span>` + pill(porSet[s.id] || 0, 'contato', 'contatos'), solBtnNivel('setor', s.id))).join(''));
  } else {
    const params = new URLSearchParams({ q });
    if (sel.set) params.set('setor_id', sel.set);
    else if (sel.uni) params.set('unidade_id', sel.uni);
    else if (sel.loc) params.set('localidade_id', sel.loc);
    const ctts = await (await fetch('/api/contatos?' + params)).json();
    lastList = ctts;
    box.innerHTML = (sel.set
      ? `<button class="fc-back" data-back="uni">← ${esc(optLabel('sel-uni'))}</button>` +
        `<div class="fc-head"><div><h2 class="fc-title">${esc(optLabel('sel-set'))}</h2></div></div>`
      : '') +
      ctts.map(c => cardContato(c, sel.set ? '' : `${c.localidade} · ${c.unidade} · ${c.setor}`)).join('') ||
      '<div class="fc-empty">Nenhum contato.</div>';
    if (logado() && sel.set) {
      const ok = cobre('setor', sel.set);
      $('create-box').classList.toggle('hidden', !ok);
      if (!ok) $('save-status').textContent = '';
    }
  }
  bindCards();
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
$('q').addEventListener('input', buscar);
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
    $('p-loc').innerHTML = locs.map(l => `<option value="${l.id}">${esc(l.nome)}</option>`).join('');
  }
}
function abrirPedidoNovo() {
  $('modal-pedido').classList.remove('hidden');
  $('p-status').textContent = '';
  $('ped-hint').textContent = 'Exigido e-mail institucional @empresa-exemplo.com.br (equivale ao vínculo da intranet).';
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
  if (nivel === 'municipio') {
    const unis = await (await fetch('/api/unidades?localidade_id=' + id)).json();
    texto = `Solicitar acesso ao município <b>${esc(nome)}</b> inteiro — ` +
            `todas as ${unis.length} unidade(s) e seus setores?`;
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
                  motivo: $('p-motivo').value.trim(), localidade_id: $('p-loc').value };
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
  const munEdit = locs.filter(l => cobre('municipio', l.id));
  const totalEdit = munEdit.reduce((a, l) => a + l.total, 0);
  const totalGeral = locs.reduce((a, l) => a + l.total, 0);
  $('dash-sub').textContent = me.escopo === 'all'
    ? `Admin: ${totalGeral} contatos em ${locs.length} municípios.`
    : `Você edita ${totalEdit} de ${totalGeral} contatos (${munEdit.length} município(s) com cobertura total).`;
  $('dash-cards').innerHTML = [
    ['🏙️ Municípios', locs.length],
    ['🏢 Unidades', r.por_unidade.length],
    ['🗂️ Setores', r.por_setor.length],
    ['👥 Contatos (total)', totalGeral],
    ['✏️ Contatos editáveis', me.escopo === 'all' ? totalGeral : totalEdit],
    ['⏳ Solicitações pendentes', r.pendentes],
  ].map(([t, v]) => `<div class="dash-card"><span>${v}</span>${t}</div>`).join('');
  const max = Math.max(1, ...locs.map(l => l.total));
  $('dash-mun').innerHTML = locs.map(l => {
    const w = Math.round(100 * l.total / max);
    const ok = cobre('municipio', l.id);
    return `<div class="bar-row"><span class="bar-label">${esc(l.nome)}${ok ? ' ✓' : ''}</span>` +
      `<span class="bar-track"><span class="bar-fill${ok ? '' : ' ro'}" style="width:${w}%"></span></span>` +
      `<span class="bar-num">${l.total}</span></div>`;
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
    (p.alvo_nome ? ` — ${esc(p.nivel)}: <b>${esc(p.alvo_nome)}</b>` : (p.localidade ? ` — local: <b>${esc(p.localidade)}</b>` : '')) +
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
  locs = await (await fetch('/api/localidades')).json();
  $('sel-loc').onchange = onLoc;
  $('sel-uni').onchange = onUni;
  $('sel-set').onchange = onSet;
  await refresh();
  initMapa('map', 'map-msg', locs, nome => {
    const loc = locs.find(x => norm(x.nome) === norm(nome));
    if (loc) setLoc(loc.id);
  });
})();
