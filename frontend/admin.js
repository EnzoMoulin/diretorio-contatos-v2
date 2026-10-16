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

document.querySelectorAll('.menu-item[data-view]').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.menu-item[data-view]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ['consulta', 'solicitacoes', 'registro'].forEach(v => $('view-' + v).classList.add('hidden'));
    $('view-' + btn.dataset.view).classList.remove('hidden');
    if (btn.dataset.view === 'solicitacoes') carregarPedidos();
    if (btn.dataset.view === 'registro') carregarHistorico();
  };
});

/* ---- consulta com camadas ---- */
function optLabel(selId) {
  const s = $(selId);
  return s.selectedIndex > 0 ? s.options[s.selectedIndex].text : '';
}

function locsPermitidas() {
  if (!logado() || me.escopo === 'all') return locs;
  return locs.filter(l => me.escopo.includes(l.id));
}

async function loadLocs() {
  const lista = locsPermitidas();
  $('sel-loc').innerHTML = '<option value="">Localidade…</option>' +
    lista.map(l => `<option value="${l.id}">${esc(l.nome)} (${l.total})</option>`).join('');
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
function podeEditar(localidade) {
  if (!logado()) return false;
  if (me.escopo === 'all') return true;
  const l = locs.find(x => x.nome === localidade);
  return l && me.escopo.includes(l.id);
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
  $('lista').innerHTML = lista.map(c =>
    `<tr><td>${esc(c.nome)}</td><td>${esc(c.cargo)}</td>` +
    `<td>${esc(c.localidade)} · ${esc(c.unidade)} · ${esc(c.setor)}</td>` +
    `<td>${esc(c.telefone)}</td><td>${esc(c.email)}</td>` +
    `<td>${podeEditar(c.localidade) ? `<button class="btn-del" data-id="${c.id}">remover</button>` : ''}</td></tr>`
  ).join('') || '<tr><td colspan="6">Nenhum contato.</td></tr>';
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
  $('menu-sol').classList.toggle('hidden', !dentro);
  $('menu-reg').classList.toggle('hidden', !dentro);
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

/* ---- solicitações / registro ---- */
async function carregarPedidos() {
  if (!logado()) return;
  const lista = await (await fetch('/api/pedidos', { headers: auth() })).json();
  const n = Array.isArray(lista) ? lista.length : 0;
  $('ped-count').textContent = n || '';
  $('pedidos').innerHTML = (Array.isArray(lista) ? lista : []).map(p =>
    `<li><b>${esc(p.nome)}</b> (${esc(p.email)}) — usuário: <code>${esc(p.usuario_desejado)}</code>` +
    (p.localidade ? ` — local: <b>${esc(p.localidade)}</b>` : '') +
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
    if (loc) {
      if (!$('sel-loc').querySelector(`option[value="${loc.id}"]`)) {
        alert('Você não tem acesso a este local.');
        return;
      }
      setLoc(loc.id);
    }
  });
})();
