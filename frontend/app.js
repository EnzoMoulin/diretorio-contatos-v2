let token = localStorage.getItem('demo-token') || '';
const $ = id => document.getElementById(id);

async function carregar() {
  const q = $('q').value.trim();
  const r = await fetch('/api/contatos?q=' + encodeURIComponent(q));
  const lista = await r.json();
  $('lista').innerHTML = lista.map(c =>
    `<tr><td>${esc(c.nome)}</td><td>${esc(c.setor)}</td><td>${esc(c.telefone)}</td><td>${esc(c.email)}</td></tr>`
  ).join('') || '<tr><td colspan="4">Nenhum contato.</td></tr>';
}

async function historico() {
  const r = await fetch('/api/historico');
  const h = await r.json();
  $('hist').innerHTML = h.map(x =>
    `<li><b>${esc(x.acao)}</b> — ${esc(x.detalhe)} <i>${esc(x.data)}</i></li>`
  ).join('') || '<li>Sem registros.</li>';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, m =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

$('q').addEventListener('input', carregar);

$('login').onclick = async () => {
  const r = await fetch('/api/login', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({usuario: $('user').value, senha: $('pass').value})
  });
  const j = await r.json();
  if (j.token) {
    token = j.token;
    localStorage.setItem('demo-token', token);
    $('status').textContent = 'logado (demo)';
  } else {
    $('status').textContent = 'falhou';
  }
};

$('salvar').onclick = async () => {
  if (!token) { alert('Faça o login demo primeiro.'); return; }
  const corpo = {nome: $('f-nome').value, setor: $('f-setor').value,
                 telefone: $('f-tel').value, email: $('f-email').value};
  const r = await fetch('/api/contatos', {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-Admin-Token': token},
    body: JSON.stringify(corpo)
  });
  if (r.ok) { $('f-nome').value = ''; carregar(); historico(); }
  else { alert('Erro: ' + await r.text()); }
};

if (token) $('status').textContent = 'logado (demo)';
carregar(); historico();
