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
  sel.loc = ''; sel.uni = ''; sel.set = '';
  $('sel-uni').innerHTML = '<option value="">Unidade…</option>';
  $('sel-set').innerHTML = '<option value="">Setor…</option>';
  $('sel-uni').disabled = true;
  $('sel-set').disabled = true;
}

async function onLoc() {
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
  sync();
}

async function onUni() {
  sel.uni = $('sel-uni').value; sel.set = '';
  const ss = $('sel-set');
  ss.innerHTML = '<option value="">Setor…</option>';
  if (sel.uni) {
    const sets = await (await fetch('/api/setores?unidade_id=' + sel.uni)).json();
    setsCache = sets;
    ss.innerHTML += sets.map(s => `<option value="${s.id}">${esc(s.nome)}${cobre('setor', s.id) ? ' ✓' : ''}</option>`).join('');
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
  refreshSol();
  buscar();
}

// "Solicitar acesso" aparece ao lado de cada nível selecionado sem cobertura.
function refreshSol() {
  $('sol-loc').classList.toggle('hidden', !(logado() && sel.loc && !cobre('municipio', sel.loc)));
  $('sol-uni').classList.toggle('hidden', !(logado() && sel.uni && !cobre('unidade', sel.uni)));
  $('sol-set').classList.toggle('hidden', !(logado() && sel.set && !cobre('setor', sel.set)));
}
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
async function buscar() {
  const q = $('q').value.trim();
  if (!q && !sel.set && !sel.uni && !sel.loc) {
    $('lista').innerHTML = '<tr><td colspan="6" class="hint-cell">Selecione um local no mapa ou nos menus, ou digite uma busca.</td></tr>';
    $('create-box').classList.add('hidden');
    return;
  }
  const params = new URLSearchParams({ q });
  if (sel.set) params.set('setor_id', sel.set);
  else if (sel.uni) params.set('unidade_id', sel.uni);
  else if (sel.loc) params.set('localidade_id', sel.loc);
  const lista = await (await fetch('/api/contatos?' + params)).json();
  lastList = lista;
  $('lista').innerHTML = lista.map(c =>
    `<tr><td>${esc(c.nome)}</td><td>${esc(c.cargo)}</td>` +
    `<td>${esc(c.localidade)} · ${esc(c.unidade)} · ${esc(c.setor)}</td>` +
    `<td>${esc(c.telefone)}</td><td><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></td>` +
    `<td>${cobreContato(c) ? `<button class="btn-edit" data-id="${c.id}">editar</button> <button class="btn-del" data-id="${c.id}">remover</button>` : ''}</td></tr>`
  ).join('') || '<tr><td colspan="6">Nenhum contato.</td></tr>';
  document.querySelectorAll('.btn-edit').forEach(b => {
    b.onclick = () => abrirEdicao(Number(b.dataset.id));
  });
  document.querySelectorAll('.btn-del').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Remover este contato?')) return;
      const r = await fetch('/api/contatos/' + b.dataset.id, { method: 'DELETE', headers: auth() });
      if (!r.ok) alert('Erro: ' + await r.text());
      sync();
    };
  });
  const locNome = optLabel('sel-loc').replace(/ \(\d+\)$/, '');
  const okEscopo = logado() && !!sel.set && locNome && podeEditar(locNome);
  $('create-box').classList.toggle('hidden', !okEscopo);
  $('save-status').textContent = (logado() && sel.set && !okEscopo)
    ? 'Você não tem acesso a este local — peça acesso pelo botão "Solicitar acesso".' : '';
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
  $('who-line').classList.toggle('hidden', !dentro);
  if (dentro) $('who-line').textContent = '👤 ' + me.usuario;
  $('btn-entrar').classList.toggle('hidden', dentro);
  $('btn-sair').classList.toggle('hidden', !dentro);
  $('btn-pedir').onclick = dentro ? abrirPedidoMais : abrirPedidoNovo;
  $('estado-hint').textContent = dentro
    ? 'Logado como ' + me.usuario + (me.escopo === 'all' ? ' (admin: todos os locais).' : ` (locais liberados: ${me.escopo.length}).`)
    : 'Consulta sem login. Com cadastro, entre para gerenciar seus locais.';
  $('escopo-hint').textContent = dentro
    ? (me.escopo === 'all' ? 'Você edita todos os locais.' : 'Você edita os locais liberados para você; nos demais, só consulta.')
    : '';
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
$('sol-loc').onclick = () => abrirConf('municipio', sel.loc, optLabel('sel-loc').replace(/ \(\d+\)( ✓)?$/, ''));
$('sol-uni').onclick = () => abrirConf('unidade', sel.uni, optLabel('sel-uni').replace(/ ✓$/, ''));
$('sol-set').onclick = () => abrirConf('setor', sel.set, optLabel('sel-set').replace(/ ✓$/, ''));
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
  document.body.dataset.theme = localStorage.getItem('demo-theme') || 'light';
}
$('tema-toggle').onclick = () => {
  localStorage.setItem('demo-theme',
    (localStorage.getItem('demo-theme') || 'light') === 'light' ? 'dark' : 'light');
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
