/* Acesso interno: consulta unificada com a pública (frontend/public.js é a referência)
   + gestão por escopo. Navegação SÓ por /api/hierarquia:
   Início (Comarcas) > Fóruns | TJES > Fórum > Nó (Unidade/Setor).
   "Acesso administrativo" (login e-mail+senha) eleva quem tem cadastro;
   "Solicitar acesso" abre o formulário; "Sair" volta à consulta (continua no interno). */
const $ = id => document.getElementById(id);
let token = localStorage.getItem('contatos-token') || '';
let me = null;            // {id, usuario, admin, escopo: 'all' | [{nivel, alvo_id}]}
let H = { comarcas: [], uteis: [] };  // espelho de /api/hierarquia
let estado = { comarcaId: '', forumId: '', noId: '' };
let mapForumComarca = {};   // forumId -> comarcaId
let mapNoForum = {};        // unidadeId -> forumId ('' quando unidade direta do órgão)
let mapNoComarca = {};      // unidadeId|setorId -> comarcaId
let mapSetorUnidade = {};   // setorId -> unidadeId
let indiceBusca = null;
let fullCache = null;       // id -> contato completo de /api/contatos (p/ edição)
let setorAlvo = null;       // setor_id do create-box atual
let editId = null;
let confPed = null;         // {nivel, alvo_id}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
const auth = () => ({ 'Content-Type': 'application/json', 'X-Admin-Token': token });
const logado = () => !!me;

const VIEWS = ['consulta', 'dashboard', 'solicitacoes', 'registro', 'config', 'notificacoes', 'pedido'];
function mostrarConsulta() {
  VIEWS.forEach(v => { const s = $('view-' + v); if (s) s.classList.add('hidden'); });
  $('view-consulta').classList.remove('hidden');
}
function marcarMenu(v) {
  document.querySelectorAll('.menu-item[data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === v));
}
document.querySelectorAll('.menu-item[data-view]').forEach(btn => {
  btn.onclick = () => {
    marcarMenu(btn.dataset.view);
    const v = btn.dataset.view;
    if (v === 'consulta') { mostrarConsulta(); renderInicio(); }
    else if (v === 'tjes') { mostrarConsulta(); abrirTJES(); }
    else if (v === 'uteis') { mostrarConsulta(); renderUteis(); }
    else {
      VIEWS.forEach(x => $('view-' + x).classList.add('hidden'));
      $('view-' + v).classList.remove('hidden');
      if (v === 'solicitacoes') carregarPedidos();
      if (v === 'registro') carregarHistorico();
      if (v === 'dashboard') carregarDashboard();
      if (v === 'notificacoes') carregarNotificacoes();
    }
  };
});

/* ---- formato (igual ao público) ---- */
function fmtTipoContato(tipo) {
  const t = String(tipo || '').trim().toUpperCase();
  if (t === 'E_MAIL' || t === 'EMAIL' || t === 'E-MAIL') return 'E-mail';
  if (t === 'WHATSAPP') return 'WhatsApp';
  if (t === 'RAMAL') return 'Ramal';
  if (t === 'FAX') return 'Fax';
  if (t === 'TELEFONE') return 'Telefone';
  return tipo || 'Contato';
}
function fmtTipoNo(tipo) {
  const mapa = { UNIDADE: 'Unidade', SECRETARIA: 'Secretaria', VARA: 'Vara',
    JUIZADO: 'Juizado', SETOR: 'Setor', GABINETE: 'Gabinete',
    ASSESSORIA: 'Assessoria', SALAAUDIENCIA: 'Sala de audiência',
    GENERICO: 'Unidade organizacional' };
  return mapa[String(tipo || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()] ||
    String(tipo || 'Unidade organizacional');
}
function fmtValor(tipo, valor) {
  const t = String(tipo || '').toUpperCase();
  const s = String(valor || '').trim();
  const n = s.replace(/\D/g, '');
  if (!s) return '';
  if ((t.indexOf('TELEFONE') >= 0 || t.indexOf('WHATSAPP') >= 0 || t === 'CELULAR') && n.indexOf('27') === 0) {
    if (n.length === 10) return '(' + n.slice(0, 2) + ') ' + n.slice(2, 6) + '-' + n.slice(6);
    if (n.length === 11) return '(' + n.slice(0, 2) + ') ' + n.slice(2, 7) + '-' + n.slice(7);
  }
  return s;
}
function hrefContato(tipo, valor) {
  const t = String(tipo || '').toUpperCase();
  const s = String(valor || '').trim();
  const n = s.replace(/\D/g, '');
  if (!s) return '';
  if (t === 'WHATSAPP' && n) return 'https://wa.me/' + (n.indexOf('55') === 0 ? n : '55' + n);
  if ((t === 'TELEFONE' || t === 'CELULAR') && n) return 'tel:+55' + (n.indexOf('55') === 0 ? n.slice(2) : n);
  if (t === 'E-MAIL' || t === 'EMAIL' || t === 'E_MAIL') return 'mailto:' + encodeURIComponent(s);
  return '';
}
function linkEndereco(endereco) {
  const texto = String(endereco || '').trim();
  if (!texto) return '<span class="fc-muted">Endereço não informado</span>';
  return '<span class="fc-address-inline"><a class="fc-endereco" href="https://www.google.com/maps/search/?api=1&query=' +
    encodeURIComponent(texto) + '" target="_blank" rel="noopener noreferrer">📍 ' + esc(texto) + '</a>' +
    '<button type="button" class="fc-icon-btn fc-copy-btn" data-copy-value="' + esc(texto) +
    '" data-copy-label="Endereço" title="Copiar endereço" aria-label="Copiar endereço">⧉</button></span>';
}
function copiarTexto(texto) {
  const valor = String(texto || '').trim();
  if (!valor) return;
  function flash() {
    const btn = document.activeElement;
    if (!btn || !btn.textContent) return;
    const t = btn.textContent;
    btn.textContent = '✓';
    setTimeout(function () { btn.textContent = t; }, 1200);
  }
  function fallback() {
    try {
      const area = document.createElement('textarea');
      area.value = valor;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      flash();
    } catch (e) {}
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(valor).then(flash, fallback);
  } else fallback();
}
function vincularCopias() {
  document.querySelectorAll('[data-copy-value]').forEach(btn => {
    if (btn.dataset.copyOk) return;
    btn.dataset.copyOk = '1';
    btn.onclick = (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      copiarTexto(btn.getAttribute('data-copy-value'));
    };
  });
}

/* ---- hierarquia ---- */
function todosNos(lista, saida) {
  saida = saida || [];
  (lista || []).forEach(no => { saida.push(no); todosNos(no.filhos || [], saida); });
  return saida;
}
function qtdSetores(lista) {
  return todosNos(lista || [], []).filter(no =>
    String(no.tipo || '').toUpperCase() === 'SETOR').length;
}
function rotuloQuantidade(valor, singular, plural) {
  const total = Number(valor || 0);
  return total > 0 ? total + ' ' + (total === 1 ? singular : plural) : '';
}
function badgeQuantidade(valor, singular, plural) {
  const texto = rotuloQuantidade(valor, singular, plural);
  return texto ? '<span class="fc-pill">' + esc(texto) + '</span>' : '';
}
function resumoQuantidades(itens) { return itens.filter(Boolean).join(' • '); }
function ehOrgao(comarca) {
  return String(comarca && comarca.tipo || '').toUpperCase() === 'ORGAO';
}
function encontrarComarca(id) {
  return (H.comarcas || []).filter(m => String(m.id) === String(id))[0] || null;
}
function encontrarForum(id) {
  let achado = null;
  (H.comarcas || []).some(m => {
    const f = (m.foruns || []).filter(item => String(item.id) === String(id))[0];
    if (f) { achado = f; return true; }
    return false;
  });
  return achado;
}
function encontrarNo(lista, id) {
  for (const no of (lista || [])) {
    if (String(no.id) === String(id)) return no;
    const filho = encontrarNo(no.filhos || [], id);
    if (filho) return filho;
  }
  return null;
}
// unidade (nó-raiz) por id, em qualquer comarca/fórum/órgão
function acharUnidade(id) {
  for (const m of (H.comarcas || [])) {
    for (const f of (m.foruns || [])) {
      const no = (f.nos || []).filter(n => String(n.id) === String(id))[0];
      if (no) return { no, forum: f, comarca: m };
    }
    const no = (m.nos || []).filter(n => String(n.id) === String(id))[0];
    if (no) return { no, forum: null, comarca: m };
  }
  return null;
}
// setor (filho) por id, em qualquer lugar
function acharSetor(id) {
  for (const m of (H.comarcas || [])) {
    const cands = [];
    (m.foruns || []).forEach(f => (f.nos || []).forEach(n => cands.push({ pai: n, forum: f })));
    (m.nos || []).forEach(n => cands.push({ pai: n, forum: null }));
    for (const c of cands) {
      const s = (c.pai.filhos || []).filter(x => String(x.id) === String(id))[0];
      if (s) return { setor: s, pai: c.pai, forum: c.forum, comarca: m };
    }
  }
  return null;
}
function comarcaAtual() { return encontrarComarca(estado.comarcaId); }
function forumAtual() { return encontrarForum(estado.forumId); }
function raizAtual() {
  const m = comarcaAtual();
  return ehOrgao(m) ? m : forumAtual();
}
function noAtual() {
  const raiz = raizAtual();
  return raiz ? encontrarNo(raiz.nos || [], estado.noId) : null;
}
function caminhoAteNo(lista, id, caminho) {
  caminho = caminho || [];
  for (const no of (lista || [])) {
    const atual = caminho.concat([no]);
    if (String(no.id) === String(id)) return atual;
    const achado = caminhoAteNo(no.filhos || [], id, atual);
    if (achado) return achado;
  }
  return null;
}
function encontrarPai(lista, id, pai) {
  for (const no of (lista || [])) {
    if (String(no.id) === String(id)) return pai || null;
    const achado = encontrarPai(no.filhos || [], id, no);
    if (achado) return achado;
  }
  return null;
}

/* ---- cobertura por escopo ('all' ou [{nivel, alvo_id}]) ---- */
function cobre(nivel, id) {
  if (!logado()) return false;
  if (me.escopo === 'all') return true;
  const g = new Set((me.escopo || []).map(a => a.nivel + ':' + a.alvo_id));
  id = String(id);
  if (g.has(nivel + ':' + id)) return true;
  if (nivel === 'forum') {
    const c = mapForumComarca[id];
    return !!(c && g.has('comarca:' + c));
  }
  if (nivel === 'unidade') {
    const f = mapNoForum[id], c = mapNoComarca[id];
    return (!!f && g.has('forum:' + f)) || (!!c && g.has('comarca:' + c));
  }
  if (nivel === 'setor') {
    const u = mapSetorUnidade[id];
    if (!u) return false;
    const f = mapNoForum[u], c = mapNoComarca[u];
    return g.has('unidade:' + u) || (!!f && g.has('forum:' + f)) || (!!c && g.has('comarca:' + c));
  }
  return false;
}
// ' ✓' nos níveis editáveis (só p/ escopo parcial logado); '' caso contrário.
function covMark(nivel, id) {
  if (!logado() || me.escopo === 'all') return '';
  return cobre(nivel, id) ? ' ✓' : '';
}
function solBtn(nivel, id) {
  if (!logado() || cobre(nivel, id)) return '';
  return '<button type="button" class="fc-access" data-sol="' + esc(nivel) +
    '" data-id="' + esc(id) + '">Solicitar acesso</button>';
}

/* ---- breadcrumb ---- */
function breadcrumbHtml(comarca, forum, no) {
  const itens = [{ tipo: 'COMARCA', id: comarca.id, nome: comarca.nome }];
  if (forum) itens.push({ tipo: 'FORUM', id: forum.id, nome: forum.nome });
  if (no) {
    (caminhoAteNo((forum || comarca).nos || [], no.id, []) || []).forEach(item => {
      itens.push({ tipo: 'NO', id: item.id, nome: item.nome });
    });
  }
  return '<nav class="fc-breadcrumb" aria-label="Caminho da estrutura">' + itens.map((item, i) => {
    const ultimo = i === itens.length - 1;
    const conteudo = ultimo
      ? '<span class="fc-breadcrumb-current" aria-current="page">' + esc(item.nome) + '</span>'
      : '<button type="button" data-breadcrumb-type="' + esc(item.tipo) + '" data-breadcrumb-id="' +
        esc(item.id) + '">' + esc(item.nome) + '</button>';
    return conteudo + (ultimo ? '' : '<span class="fc-breadcrumb-separator" aria-hidden="true">›</span>');
  }).join('') + '</nav>';
}
function vincularBreadcrumbs() {
  document.querySelectorAll('[data-breadcrumb-type]').forEach(btn => {
    btn.onclick = () => {
      const tipo = btn.getAttribute('data-breadcrumb-type');
      const id = btn.getAttribute('data-breadcrumb-id');
      if (tipo === 'COMARCA') {
        estado.comarcaId = id; estado.forumId = ''; estado.noId = '';
        if (ehOrgao(comarcaAtual())) renderOrgao();
        else renderForuns();
      } else if (tipo === 'FORUM') {
        estado.forumId = id; estado.noId = '';
        renderForum();
      } else if (tipo === 'NO') abrirNo(id);
    };
  });
}

/* ---- cards ---- */
function opcoesComarcas(comarcas, selecionado) {
  return '<option value="">Selecione a Comarca</option>' + (comarcas || [])
    .filter(m => !ehOrgao(m)).map(m =>
      '<option value="' + esc(m.id) + '"' + (String(m.id) === String(selecionado) ? ' selected' : '') +
      '>' + esc(m.nome) + '</option>').join('');
}
// ctxOk: o contexto do contato está coberto → mostra Editar/Remover
function contatosCards(contatos, ctxOk) {
  if (!contatos || !contatos.length) return '<div class="fc-empty">Nenhum contato cadastrado.</div>';
  return '<div class="fc-contatos">' + contatos.map(c => {
    const tipo = fmtTipoContato(c.tipo);
    const valor = fmtValor(c.tipo, c.valor);
    const href = hrefContato(c.tipo, c.valor);
    const externo = /^(https?:|mailto:)/.test(href);
    const valorHtml = href
      ? '<a class="fc-contato-valor" href="' + esc(href) + '" ' +
        (externo ? 'target="_blank" rel="noopener noreferrer"' : '') + '>' + esc(valor) + '</a>'
      : '<span class="fc-contato-valor">' + esc(valor) + '</span>';
    let acoes = '<button type="button" class="fc-icon-btn fc-copy-btn" data-copy-value="' + esc(valor) +
      '" data-copy-label="' + esc(tipo) + '" title="Copiar ' + esc(tipo) + '" aria-label="Copiar ' +
      esc(tipo) + '">⧉</button>';
    if (ctxOk) {
      acoes += '<button type="button" class="fc-icon-btn" data-edit="' + esc(c.id) +
        '" title="Editar contato">✏️ Editar</button>' +
        '<button type="button" class="fc-icon-btn fc-icon-btn--danger" data-del="' + esc(c.id) +
        '" title="Remover contato">🗑️ Remover</button>';
    }
    const descricao = String(c.descricao || '').trim();
    const descricaoHtml = descricao && descricao.toLocaleLowerCase('pt-BR') !== String(tipo).toLocaleLowerCase('pt-BR')
      ? '<h4>' + esc(descricao) + '</h4>' : '';
    const observacao = String(c.observacao || '').trim();
    const observacaoHtml = observacao
      ? '<p class="fc-contato-observacao' + (/contato provis[oó]rio/i.test(observacao) ? ' fc-contato-observacao--provisoria' : '') + '">' + esc(observacao) + '</p>'
      : '';
    return '<article class="fc-contato" data-contato="' + esc(c.id) + '">' +
      '<div class="fc-contato-main"><span class="fc-contato-tipo">' + esc(tipo) + '</span>' + descricaoHtml + observacaoHtml + '</div>' +
      '<div class="fc-contato-side">' + valorHtml + '<div class="fc-contato-actions">' + acoes + '</div></div></article>';
  }).join('') + '</div>';
}
function cardContatosGerais(contatos, comPrint, ctxOk) {
  const lista = contatos || [];
  return '<div class="fc-section"><div class="fc-card fc-card--toggle" data-gerais-toggle title="Expandir/recolher contatos gerais">' +
    '<div class="fc-card-head"><div><h4>Contatos Gerais</h4></div>' +
    '<div class="fc-meta">' + badgeQuantidade(lista.length, 'Contato', 'Contatos') +
    (comPrint ? '<button type="button" class="fc-icon-btn" data-gerais-print title="Imprimir / Salvar PDF dos Contatos Gerais">🖨</button>' : '') +
    '<span class="fc-toggle" aria-hidden="true">▾</span></div></div></div>' +
    '<div data-gerais-body hidden>' + (lista.length ? contatosCards(lista, ctxOk) : '<div class="fc-empty">Sem contatos gerais.</div>') + '</div></div>';
}
function cardNo(no) {
  const tipo = fmtTipoNo(no.tipo);
  const nivel = String(no.tipo || '').toUpperCase() === 'SETOR' ? 'setor' : 'unidade';
  return '<div class="fc-card" data-nav="no" data-no="' + esc(no.id) + '">' +
    '<div class="fc-card-head"><div><h4>' + esc(no.nome) + covMark(nivel, no.id) + '</h4></div></div>' +
    '<div class="fc-meta"><span class="fc-pill fc-pill-type">' + esc(tipo) + '</span>' +
    badgeQuantidade(qtdSetores(no.filhos || []), 'Setor', 'Setores') +
    badgeQuantidade(no.qtdContatos, 'Contato', 'Contatos') + solBtn(nivel, no.id) + '</div></div>';
}
function vincularAcoes() {
  vincularCopias();
  document.querySelectorAll('[data-gerais-toggle]').forEach(card => {
    if (card.dataset.tgOk) return;
    card.dataset.tgOk = '1';
    card.onclick = (e) => {
      if (e && e.target && e.target.closest && e.target.closest('[data-gerais-print]')) return;
      const body = card.nextElementSibling;
      if (!body) return;
      const abrir = body.hasAttribute('hidden');
      if (abrir) body.removeAttribute('hidden');
      else body.setAttribute('hidden', '');
      card.classList.toggle('aberto', abrir);
    };
  });
  document.querySelectorAll('[data-scroll-top]').forEach(btn => {
    if (btn.dataset.stOk) return;
    btn.dataset.stOk = '1';
    btn.onclick = () => {
      let el = btn.parentElement;
      while (el) {
        try {
          const st = window.getComputedStyle(el);
          if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
            el.scrollTo({ top: 0, behavior: 'smooth' });
            return;
          }
        } catch (e) {}
        el = el.parentElement;
      }
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {}
    };
  });
  document.querySelectorAll('#lista [data-sol]').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const h4 = el.closest('.fc-card') ? el.closest('.fc-card').querySelector('h4') : null;
      abrirConf(el.dataset.sol, el.dataset.id, h4 ? h4.textContent.replace(/ ✓$/, '') : el.dataset.id);
    };
  });
  document.querySelectorAll('#lista [data-edit]').forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); abrirEdicao(b.dataset.edit); };
  });
  document.querySelectorAll('#lista [data-del]').forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); excluirContato(b.dataset.del); };
  });
}

/* ---- barras inferiores ---- */
function barraAcoesUnidade(tipoNo, rotuloVoltar) {
  const rotulo = tipoNo === 'Setor' ? 'Setor' : 'Unidade';
  const artigo = rotulo === 'Unidade' ? 'da' : 'do';
  return '<div class="fc-print-footer fc-actions-row">' +
    '<button type="button" class="fc-btn" id="fc-back-bottom">← ' + esc(rotuloVoltar || 'Voltar') + '</button>' +
    '<button type="button" class="fc-btn" id="fc-print-unit" title="Imprimir / Salvar PDF dos contatos ' +
    artigo + ' ' + rotulo + '">🖨 Imprimir / Salvar PDF</button>' +
    '<button type="button" class="fc-btn" data-scroll-top title="Voltar ao topo">↑ Voltar ao topo</button></div>';
}
function barraNavegacaoInferior(rotuloVoltar, semLinha) {
  return '<div class="fc-bottom-nav' + (semLinha ? ' fc-bottom-nav--colado' : '') + '">' +
    '<button type="button" class="fc-btn" id="fc-back-bottom">← ' + esc(rotuloVoltar || 'Voltar') + '</button>' +
    '<button type="button" class="fc-btn" data-scroll-top title="Voltar ao topo">↑ Voltar ao topo</button></div>';
}
function destacarMapaAdmin(nome) {
  if (typeof destacarComarcaMapa === 'function') destacarComarcaMapa(nome || '');
}
function locsMapa() {
  return H.comarcas.filter(m => !ehOrgao(m)).map(m => ({ nome: m.nome, total: m.qtdContatos || 0, foruns: m.qtdForuns || 0 }));
}

/* ---- telas ---- */
function host() { return $('lista'); }
function renderInicio() {
  const c = host();
  if (!c) return;
  marcarMenu('consulta');
  estado.comarcaId = ''; estado.forumId = ''; estado.noId = '';
  esconderCreate();
  const comarcas = (H.comarcas || []).filter(m => !ehOrgao(m));
  const totalComarcas = comarcas.length;
  const cardsComarcas = comarcas.map(m => {
    const setores = (m.foruns || []).reduce((t, f) => t + qtdSetores(f.nos || []), 0);
    return '<div class="fc-card" data-nav="comarca" data-comarca="' + esc(m.id) + '">' +
      '<div class="fc-card-head"><div><h4>' + esc(m.nome) + covMark('comarca', m.id) + '</h4></div></div>' +
      '<div class="fc-meta">' +
      badgeQuantidade(m.qtdForuns, 'Fórum', 'Fóruns') +
      badgeQuantidade(m.qtdUnidades, 'Unidade', 'Unidades') +
      badgeQuantidade(setores, 'Setor', 'Setores') +
      badgeQuantidade(m.qtdContatos, 'Contato', 'Contatos') + solBtn('comarca', m.id) + '</div></div>';
  }).join('');
  c.innerHTML = '<div class="fc-head"><div><h2 class="fc-title">Contatos do PJES</h2>' +
    '<p class="fc-subtitle fc-subtitle--intro">Consulte a estrutura completa por Comarca, Fórum, Unidade e Setor. Selecione uma Comarca no mapa, no menu suspenso ou na lista abaixo.</p></div></div>' +
    (comarcas.length ? '<div class="fc-catalog-counts">' +
      (totalComarcas ? '<span class="fc-pill fc-total-comarcas">' + esc(rotuloQuantidade(totalComarcas, 'Comarca', 'Comarcas')) + '</span>' : '') + '</div>' : '') +
    '<select id="fc-comarca" class="fc-select">' + opcoesComarcas(comarcas, '') + '</select>' +
    '<div class="fc-section fc-section--comarcas"><div class="fc-section-title"><h3>Comarcas</h3></div><div class="fc-comarcas-grid">' + cardsComarcas + '</div></div>' +
    '<div class="fc-print-footer"><button type="button" class="fc-btn" data-scroll-top title="Voltar ao topo">↑ Voltar ao topo</button></div>';
  $('fc-comarca').onchange = (e) => { if (e.target.value) abrirComarca(e.target.value); };
  c.querySelectorAll('[data-comarca]').forEach(el => {
    el.onclick = () => abrirComarca(el.getAttribute('data-comarca'));
  });
  vincularAcoes();
  destacarMapaAdmin('');
}
function abrirComarca(id) {
  estado.comarcaId = String(id);
  estado.forumId = ''; estado.noId = '';
  marcarMenu('consulta');
  const m = comarcaAtual();
  if (!m) return;
  if (ehOrgao(m)) renderOrgao();
  else if ((m.foruns || []).length === 1) abrirForum(m.foruns[0].id);
  else renderForuns();
  destacarMapaAdmin(m.nome);
}
function renderForuns() {
  const c = host();
  const m = comarcaAtual();
  if (!c || !m) return;
  if (ehOrgao(m)) return renderOrgao();
  esconderCreate();
  const resumo = resumoQuantidades([
    rotuloQuantidade(m.qtdForuns, 'Fórum', 'Fóruns'),
    rotuloQuantidade(m.qtdUnidades, 'Unidade', 'Unidades'),
    rotuloQuantidade((m.foruns || []).reduce((t, f) => t + qtdSetores(f.nos || []), 0), 'Setor', 'Setores'),
    rotuloQuantidade(m.qtdContatos, 'Contato', 'Contatos')
  ]);
  c.innerHTML = '<button type="button" class="fc-back" id="fc-back-home">← Comarcas</button>' +
    '<div class="fc-head"><div><h2 class="fc-title">' + esc(m.nome) + '</h2>' +
    '<p class="fc-subtitle">' + esc(resumo) + '</p></div></div>' +
    '<select id="fc-comarca" class="fc-select">' + opcoesComarcas(H.comarcas || [], m.id) + '</select>' +
    '<div class="fc-section"><h3>Fóruns</h3>' +
    (m.foruns || []).map(f =>
      '<div class="fc-card" data-nav="forum" data-forum="' + esc(f.id) + '">' +
      '<div class="fc-card-head"><div><h4>' + esc(f.nome) + covMark('forum', f.id) + '</h4>' + linkEndereco(f.endereco) + '</div></div>' +
      '<div class="fc-meta">' + badgeQuantidade(f.qtdUnidades, 'Unidade', 'Unidades') +
      badgeQuantidade(qtdSetores(f.nos || []), 'Setor', 'Setores') +
      badgeQuantidade(f.qtdContatos, 'Contato', 'Contatos') + solBtn('forum', f.id) + '</div></div>'
    ).join('') + '</div>' + barraNavegacaoInferior('Comarcas');
  $('fc-back-home').onclick = renderInicio;
  $('fc-back-bottom').onclick = renderInicio;
  $('fc-comarca').onchange = (e) => { if (e.target.value) abrirComarca(e.target.value); };
  c.querySelectorAll('[data-nav="forum"]').forEach(el => {
    el.onclick = () => abrirForum(el.getAttribute('data-forum'));
  });
  vincularAcoes();
  destacarMapaAdmin(m.nome);
}
function renderOrgao() {
  const c = host();
  const m = comarcaAtual();
  if (!c || !m || !ehOrgao(m)) return;
  esconderCreate();
  const ctxOk = cobre('comarca', m.id);
  const resumo = resumoQuantidades([
    rotuloQuantidade(m.qtdUnidades, 'Unidade', 'Unidades'),
    rotuloQuantidade(qtdSetores(m.nos || []), 'Setor', 'Setores'),
    rotuloQuantidade(m.qtdContatos, 'Contato', 'Contatos')
  ]);
  c.innerHTML = '<button type="button" class="fc-back" id="fc-back-home">← Comarcas</button>' +
    '<div class="fc-head"><div><h2 class="fc-title">' + esc(m.nome) + '</h2>' +
    '<p class="fc-subtitle">' + esc(resumo) + '</p>' + breadcrumbHtml(m, null, null) + '</div></div>' +
    '<select id="fc-comarca" class="fc-select">' + opcoesComarcas(H.comarcas || [], m.id) + '</select>' +
    '<div class="fc-meta"><span class="fc-pill fc-total-orgaos">TJES</span>' +
    badgeQuantidade(m.qtdUnidades, 'Unidade', 'Unidades') + '</div>' +
    '<div class="fc-address-row"><div class="fc-inherit"><strong>Endereço do TJES:</strong> ' + linkEndereco(m.endereco) +
    (m.cep ? ' • CEP ' + esc(m.cep) : '') + '</div></div>' +
    cardContatosGerais(m.contatos || [], true, ctxOk) +
    '<div class="fc-section"><div class="fc-section-title"><h3>Unidades e Setores</h3></div>' +
    ((m.nos || []).length ? (m.nos || []).map(cardNo).join('') : '<div class="fc-empty">Nenhuma Unidade cadastrada.</div>') +
    '</div>' + barraNavegacaoInferior('Comarcas', true);
  $('fc-back-home').onclick = renderInicio;
  $('fc-back-bottom').onclick = renderInicio;
  const bp = document.querySelector('[data-gerais-print]');
  if (bp) bp.onclick = (e) => { if (e && e.stopPropagation) e.stopPropagation(); imprimirOrgao(); };
  $('fc-comarca').onchange = function () {
    if (this.value && String(this.value) !== String(estado.comarcaId)) abrirComarca(this.value);
  };
  c.querySelectorAll('[data-no]').forEach(el => {
    el.onclick = () => abrirNo(el.getAttribute('data-no'));
  });
  vincularBreadcrumbs();
  vincularAcoes();
  destacarMapaAdmin(m.nome);
}
function abrirTJES() {
  const orgao = (H.comarcas || []).filter(ehOrgao)[0];
  if (orgao) abrirComarca(orgao.id);
  marcarMenu('tjes');
}
function renderUteis() {
  const c = host();
  if (!c) return;
  marcarMenu('uteis');
  estado.comarcaId = ''; estado.forumId = ''; estado.noId = '';
  esconderCreate();
  const uteis = H.uteis || [];
  c.innerHTML = '<div class="fc-head"><div><h2 class="fc-title">Telefones Úteis</h2>' +
    '<p class="fc-subtitle">Canais de atendimento e serviços de apoio do PJES.</p></div></div>' +
    (uteis.length ? '<div class="fc-contatos">' + uteis.map(u => {
      const href = hrefContato(u.tipo, u.valor);
      const valorHtml = href ? '<a class="fc-contato-valor" href="' + esc(href) + '">' + esc(u.valor) + '</a>'
        : '<span class="fc-contato-valor">' + esc(u.valor) + '</span>';
      return '<article class="fc-contato"><div class="fc-contato-main"><span class="fc-contato-tipo">' +
        esc(fmtTipoContato(u.tipo)) + '</span><h4>' + esc(u.nome || u.valor) + '</h4></div>' +
        '<div class="fc-contato-side">' + valorHtml +
        '<div class="fc-contato-actions"><button type="button" class="fc-icon-btn fc-copy-btn" data-copy-value="' + esc(u.valor) +
        '" data-copy-label="' + esc(fmtTipoContato(u.tipo)) + '" title="Copiar">⧉</button></div>' +
        '</div></article>';
    }).join('') + '</div>' : '<div class="fc-empty">Nenhum telefone útil cadastrado.</div>') +
    '<div class="fc-print-footer"><button type="button" class="fc-btn" data-scroll-top title="Voltar ao topo">↑ Voltar ao topo</button>' +
    '<button type="button" class="fc-btn" id="fc-print-uteis" title="Imprimir / Salvar PDF">🖨 Imprimir / Salvar PDF</button></div>';
  $('fc-print-uteis').onclick = () => {
    abrirImpressao('Telefones Úteis — PJES', '<ul>' + uteis.map(u =>
      contatoPrint({ tipo: u.tipo, descricao: u.nome, valor: u.valor })).join('') + '</ul>');
  };
  vincularAcoes();
}
function abrirForum(id) {
  estado.forumId = String(id);
  estado.noId = '';
  renderForum();
}
function renderForum() {
  const c = host();
  const f = forumAtual();
  const m = comarcaAtual();
  if (!c || !f || !m) return;
  esconderCreate();
  const ctxOk = cobre('forum', f.id);
  c.innerHTML = '<button type="button" class="fc-back" id="fc-back-comarca">← ' + esc(m.nome) + '</button>' +
    '<div class="fc-head"><div><h2 class="fc-title">' + esc(f.nome) + '</h2>' +
    breadcrumbHtml(m, f, null) + '</div></div>' +
    '<div class="fc-meta"><span class="fc-pill fc-pill-type">Fórum</span>' +
    badgeQuantidade(f.qtdUnidades, 'Unidade', 'Unidades') + '</div>' +
    '<div class="fc-address-row"><div class="fc-inherit"><strong>Endereço do Fórum:</strong> ' + linkEndereco(f.endereco) +
    (f.cep ? ' • CEP ' + esc(f.cep) : '') + '</div></div>' +
    cardContatosGerais(f.contatos || [], true, ctxOk) +
    '<div class="fc-section"><div class="fc-section-title"><h3>Unidades e Setores</h3></div>' +
    ((f.nos || []).length ? (f.nos || []).map(cardNo).join('') : '<div class="fc-empty">Nenhuma Unidade cadastrada.</div>') +
    '</div>' + barraNavegacaoInferior('Fóruns', true);
  $('fc-back-comarca').onclick = renderForuns;
  $('fc-back-bottom').onclick = renderForuns;
  const bp = document.querySelector('[data-gerais-print]');
  if (bp) bp.onclick = (e) => { if (e && e.stopPropagation) e.stopPropagation(); imprimirForum(); };
  c.querySelectorAll('[data-no]').forEach(el => {
    el.onclick = () => abrirNo(el.getAttribute('data-no'));
  });
  vincularBreadcrumbs();
  vincularAcoes();
  destacarMapaAdmin(m.nome);
}
function abrirNo(id) {
  estado.noId = String(id);
  renderNo();
}
function renderNo() {
  const c = host();
  const f = forumAtual();
  const m = comarcaAtual();
  const raiz = raizAtual();
  const no = noAtual();
  if (!c || !raiz || !m || !no) return;
  const pai = encontrarPai(raiz.nos || [], no.id, null);
  const tipo = fmtTipoNo(no.tipo);
  const tipoTela = String(no.tipo || '').toUpperCase() === 'SETOR' ? 'Setor' : 'Unidade';
  const nivelNo = tipoTela === 'Setor' ? 'setor' : 'unidade';
  const ctxOk = cobre(nivelNo, no.id);
  c.innerHTML =
    '<button type="button" class="fc-back" id="fc-back-no">← ' + esc(pai ? pai.nome : raiz.nome) + '</button>' +
    '<div class="fc-head"><div><h2 class="fc-title">' + esc(no.nome) + covMark(nivelNo, no.id) + '</h2>' +
    breadcrumbHtml(m, f, no) + '</div></div>' +
    '<div class="fc-meta"><span class="fc-pill fc-pill-type">' + esc(tipo) + '</span>' +
    badgeQuantidade(qtdSetores(no.filhos || []), 'Setor', 'Setores') + solBtn(nivelNo, no.id) + '</div>' +
    '<div class="fc-address-row"><div class="fc-inherit"><strong>Endereço:</strong> ' + linkEndereco(no.enderecoExibicao) +
    (no.cepExibicao ? ' • CEP ' + esc(no.cepExibicao) : '') +
    (no.endereco ? '' : ' <span class="fc-muted">(' + (pai ? 'herdado da Unidade' : (ehOrgao(m) ? 'herdado do TJES' : 'herdado do Fórum')) + ')</span>') + '</div></div>' +
    '<div class="fc-section"><div class="fc-section-title"><h3>Contatos ' + (tipoTela === 'Setor' ? 'deste Setor' : 'desta Unidade') + '</h3></div>' +
    contatosCards(no.contatos || [], ctxOk) + '</div>' +
    ((no.filhos || []).length
      ? '<div class="fc-section"><div class="fc-section-title"><h3>Setores</h3></div>' +
        no.filhos.map(cardNo).join('') + '</div>'
      : '') +
    barraAcoesUnidade(tipoTela, pai ? 'Unidade' : (ehOrgao(m) ? 'TJES' : 'Fórum'));
  $('fc-back-no').onclick = () => {
    if (pai) abrirNo(pai.id);
    else { estado.noId = ''; if (ehOrgao(m)) renderOrgao(); else renderForum(); }
  };
  $('fc-back-bottom').onclick = $('fc-back-no').onclick;
  $('fc-print-unit').onclick = imprimirUnidade;
  c.querySelectorAll('[data-no]').forEach(el => {
    el.onclick = () => abrirNo(el.getAttribute('data-no'));
  });
  vincularBreadcrumbs();
  vincularAcoes();
  destacarMapaAdmin(m.nome);
  // create-box: só no setor coberto
  if (logado() && tipoTela === 'Setor' && cobre('setor', no.id)) {
    setorAlvo = Number(no.id);
    $('create-box').classList.remove('hidden');
    $('save-status').textContent = '';
  } else {
    esconderCreate();
  }
}
function esconderCreate() {
  setorAlvo = null;
  const box = $('create-box');
  if (box) box.classList.add('hidden');
}
function renderEstadoAtual() {
  if (!estado.comarcaId) return renderInicio();
  const m = comarcaAtual();
  if (!m) return renderInicio();
  if (ehOrgao(m)) return renderOrgao();
  if (estado.noId && noAtual()) return renderNo();
  if (estado.forumId && forumAtual()) return renderForum();
  return renderForuns();
}

/* ---- busca global do cabeçalho ---- */
function normBusca(s) {
  return String(s == null ? '' : s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function construirIndiceBusca() {
  const indice = [];
  (H.comarcas || []).forEach(m => {
    (m.foruns || []).forEach(f => {
      (f.contatos || []).forEach(c => {
        indice.push({ contato: c, comarcaId: m.id, forumId: f.id, noId: '',
          caminho: m.nome + ' › ' + f.nome + ' › Contatos gerais' });
      });
      (function percorrer(nos, trilha) {
        (nos || []).forEach(no => {
          const rota = trilha.concat([no.nome || fmtTipoNo(no.tipo)]);
          (no.contatos || []).forEach(c => {
            indice.push({ contato: c, comarcaId: m.id, forumId: f.id, noId: no.id,
              caminho: m.nome + ' › ' + f.nome + ' › ' + rota.join(' › ') });
          });
          percorrer(no.filhos || [], rota);
        });
      })((f.nos || []), []);
    });
    // contatos gerais do órgão + unidades diretas da comarca
    (m.contatos || []).forEach(c => {
      indice.push({ contato: c, comarcaId: m.id, forumId: '', noId: '',
        caminho: m.nome + ' › Contatos gerais' });
    });
    (function percorrer(nos, trilha) {
      (nos || []).forEach(no => {
        const rota = trilha.concat([no.nome || fmtTipoNo(no.tipo)]);
        (no.contatos || []).forEach(c => {
          indice.push({ contato: c, comarcaId: m.id, forumId: '', noId: no.id,
            caminho: m.nome + ' › ' + rota.join(' › ') });
        });
        percorrer(no.filhos || [], rota);
      });
    })((m.nos || []), []);
  });
  return indice;
}
function buscarContatos(termo) {
  if (indiceBusca === null) indiceBusca = construirIndiceBusca();
  const t = normBusca(termo);
  if (t.length < 2) return [];
  const saida = [];
  for (let i = 0; i < indiceBusca.length && saida.length < 8; i++) {
    const item = indiceBusca[i], c = item.contato;
    const texto = normBusca([c.descricao, c.tipo, c.valor, c.observacao, item.caminho].join(' '));
    if (texto.indexOf(t) !== -1) saida.push(item);
  }
  return saida;
}
function destacarContato(id) {
  try {
    const el = document.querySelector('[data-contato="' + String(id).replace(/"/g, '') + '"]');
    if (!el) return;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('fc-contato--achado');
    void el.offsetWidth;
    el.classList.add('fc-contato--achado');
  } catch (e) {}
}
function expandirGeraisSePreciso() {
  try {
    document.querySelectorAll('[data-gerais-toggle]').forEach(tg => {
      const body = tg.nextElementSibling;
      if (body && body.hasAttribute('hidden')) tg.click();
    });
  } catch (e) {}
}
function irParaResultado(item) {
  if (!item) return;
  mostrarConsulta();
  marcarMenu('consulta');
  estado.comarcaId = String(item.comarcaId);
  estado.forumId = '';
  estado.noId = '';
  const m = comarcaAtual();
  if (!m) return;
  destacarMapaAdmin(m.nome);
  if (ehOrgao(m)) {
    if (item.noId) abrirNo(item.noId);
    else { renderOrgao(); expandirGeraisSePreciso(); }
  } else if (item.forumId) {
    estado.forumId = String(item.forumId);
    if (item.noId) abrirNo(item.noId);
    else { renderForum(); expandirGeraisSePreciso(); }
  } else renderForuns();
  destacarContato(item.contato.id);
}
function vincularBuscaGlobal() {
  const campo = $('fc-busca'), caixa = $('fc-busca-resultados');
  if (!campo || !caixa || campo.getAttribute('data-busca-ok')) return;
  campo.setAttribute('data-busca-ok', '1');
  function fechar() { caixa.setAttribute('hidden', ''); caixa.innerHTML = ''; }
  campo.addEventListener('input', () => {
    const resultados = buscarContatos(campo.value);
    if (!resultados.length) { fechar(); return; }
    caixa.innerHTML = resultados.map((item, i) => {
      const c = item.contato;
      return '<button type="button" class="fc-busca-item" data-busca-i="' + i + '">' +
        '<strong>' + esc(c.descricao || fmtTipoContato(c.tipo)) + '</strong>' +
        '<small>' + esc(fmtTipoContato(c.tipo) + (c.valor ? ' · ' + c.valor : '')) + '</small>' +
        '<small>' + esc(item.caminho) + '</small></button>';
    }).join('');
    caixa.removeAttribute('hidden');
    caixa.querySelectorAll('[data-busca-i]').forEach(btn => {
      const item = resultados[+btn.getAttribute('data-busca-i')];
      btn.onclick = () => { fechar(); campo.value = ''; irParaResultado(item); };
    });
  });
  campo.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { fechar(); campo.blur(); }
    else if (e.key === 'Enter') {
      const r = buscarContatos(campo.value);
      if (r.length) { fechar(); campo.value = ''; irParaResultado(r[0]); }
    }
  });
  document.addEventListener('click', (e) => {
    if (e.target !== campo && !caixa.contains(e.target)) fechar();
  });
}

/* ---- impressão (janela de impressão, como no original) ---- */
function contatoPrint(c) {
  const tipo = fmtTipoContato(c.tipo);
  const descricao = String(c.descricao || '').trim();
  const observacao = String(c.observacao || '').trim();
  const complemento = descricao && descricao.toLocaleLowerCase('pt-BR') !== String(tipo).toLocaleLowerCase('pt-BR')
    ? ' — ' + esc(descricao) : '';
  const nota = observacao ? '<small class="note">' + esc(observacao) + '</small>' : '';
  return '<li><strong>' + esc(tipo) + ':</strong> ' + esc(c.valor || '') + complemento + nota + '</li>';
}
function noPrint(no, nivel) {
  nivel = nivel || 0;
  const titulo = Math.min(6, nivel + 3);
  const contatos = (no.contatos || []).length
    ? '<ul>' + (no.contatos || []).map(contatoPrint).join('') + '</ul>'
    : '<p class="muted">Sem contatos diretos.</p>';
  return '<section class="unit"><h' + titulo + '>' + esc(no.nome) + '</h' + titulo + '>' +
    '<p class="meta">' + esc(fmtTipoNo(no.tipo)) + ' • ' +
    esc(no.enderecoExibicao || 'Endereço não informado') +
    (no.cepExibicao ? ' • CEP ' + esc(no.cepExibicao) : '') + '</p>' +
    contatos + (no.filhos || []).map(filho => noPrint(filho, nivel + 1)).join('') +
    '</section>';
}
function abrirImpressao(titulo, corpo) {
  const w = window.open('', '_blank');
  if (!w) return;
  const css =
    'body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:24px;line-height:1.45}' +
    'h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;border-bottom:2px solid #0f172a;padding-bottom:5px;margin-top:24px}' +
    'h3,h4,h5,h6{font-size:15px;margin:16px 0 4px}.meta{color:#64748b;font-size:11px;margin:0 0 8px}.muted{color:#94a3b8;font-style:italic;font-size:12px}' +
    'ul{margin:5px 0 10px;padding-left:20px}li{font-size:12px;margin:2px 0}.note{display:block;color:#64748b;font-size:9px;margin-top:1px}.forum{break-before:auto}.unit{break-inside:auto;page-break-inside:auto;border-left:2px solid #e2e8f0;padding-left:10px;margin:9px 0}.unit>h3,.unit>h4,.unit>h5,.unit>h6{break-after:avoid-page;page-break-after:avoid}.unit>ul{break-inside:avoid-page;page-break-inside:avoid}' +
    '@media print{@page{size:A4 portrait;margin:12mm}html,body{margin:0;padding:0}.forum,.unit{break-before:auto;page-break-before:auto}}';
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(titulo) +
    '</title><style>' + css + '</style></head><body><h1>' + esc(titulo) +
    '<p class="meta">Gerado em ' + esc(new Date().toLocaleString('pt-BR')) +
    '</p>' + corpo + '<script>window.onload=function(){setTimeout(function(){window.print();},250)}<\/script></body></html>';
  w.document.open();
  w.document.write(html);
  w.document.close();
}
function imprimirOrgao() {
  const m = comarcaAtual();
  if (!m) return;
  const corpo = (m.contatos || []).length
    ? '<ul>' + (m.contatos || []).map(contatoPrint).join('') + '</ul>'
    : '<p class="muted">Sem contatos gerais.</p>';
  abrirImpressao('Contatos Gerais — TJES',
    '<section><h2>TJES</h2>' +
    '<p class="meta">' + esc(m.endereco || 'Endereço não informado') +
    (m.cep ? ' • CEP ' + esc(m.cep) : '') + '</p>' + corpo + '</section>');
}
function imprimirForum() {
  const f = raizAtual();
  const m = comarcaAtual();
  if (!f || !m) return;
  const corpo = (f.contatos || []).length
    ? '<ul>' + (f.contatos || []).map(contatoPrint).join('') + '</ul>'
    : '<p class="muted">Sem contatos gerais.</p>';
  abrirImpressao('Contatos Gerais — ' + f.nome,
    '<section><h2>' + esc(f.nome) + '</h2>' +
    '<p class="meta">' + esc(ehOrgao(m) ? 'TJES' : m.nome) + ' • ' +
    esc(f.endereco || 'Endereço não informado') +
    (f.cep ? ' • CEP ' + esc(f.cep) : '') + '</p>' + corpo + '</section>');
}
function imprimirUnidade() {
  const no = noAtual();
  if (!no) return;
  abrirImpressao('Contatos — ' + no.nome, noPrint(no, 0));
}

/* ---- carga da hierarquia (única fonte da navegação) ---- */
function construirMapas() {
  mapForumComarca = {}; mapNoForum = {}; mapNoComarca = {}; mapSetorUnidade = {};
  (H.comarcas || []).forEach(m => {
    (m.foruns || []).forEach(f => {
      mapForumComarca[String(f.id)] = String(m.id);
      (f.nos || []).forEach(no => {
        const nid = String(no.id);
        mapNoForum[nid] = String(f.id);
        mapNoComarca[nid] = String(m.id);
        (no.filhos || []).forEach(s => {
          const sid = String(s.id);
          mapSetorUnidade[sid] = nid;
          mapNoComarca[sid] = String(m.id);
        });
      });
    });
    (m.nos || []).forEach(no => {
      const nid = String(no.id);
      if (!(nid in mapNoForum)) mapNoForum[nid] = '';
      mapNoComarca[nid] = String(m.id);
      (no.filhos || []).forEach(s => {
        const sid = String(s.id);
        mapSetorUnidade[sid] = nid;
        mapNoComarca[sid] = String(m.id);
      });
    });
  });
}
async function recarregarHierarquia(preservar) {
  const dados = await (await fetch('/api/hierarquia')).json();
  H = dados && dados.comarcas ? dados : { comarcas: [], uteis: [] };
  construirMapas();
  indiceBusca = null;
  fullCache = null;
  if (preservar) renderEstadoAtual();
  else renderInicio();
}
async function fullContatos() {
  if (!fullCache) {
    const todos = await (await fetch('/api/contatos')).json();
    fullCache = {};
    (Array.isArray(todos) ? todos : []).forEach(c => { fullCache[c.id] = c; });
  }
  return fullCache;
}

/* ---- gestão: editar / remover / criar ---- */
async function abrirEdicao(id) {
  const todos = await fullContatos();
  const c = todos[id];
  if (!c) { alert('Contato não encontrado.'); return; }
  editId = Number(id);
  $('e-nome').value = c.nome || c.descricao || '';
  $('e-cargo').value = c.cargo || c.tipo || '';
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
  if (r.ok) { $('modal-edit').classList.add('hidden'); await recarregarHierarquia(true); }
  else $('e-status').textContent = 'Erro: ' + await r.text();
};
async function excluirContato(id) {
  if (!confirm('Remover este contato?')) return;
  const r = await fetch('/api/contatos/' + id, { method: 'DELETE', headers: auth() });
  if (!r.ok) alert('Erro: ' + await r.text());
  await recarregarHierarquia(true);
}
$('salvar').onclick = async () => {
  if (!setorAlvo) { $('save-status').textContent = 'Setor inválido.'; return; }
  const corpo = { setor_id: setorAlvo, nome: $('f-nome').value.trim(),
                  cargo: $('f-cargo').value.trim(), telefone: $('f-tel').value.trim(),
                  email: $('f-email').value.trim() };
  const r = await fetch('/api/contatos', { method: 'POST', headers: auth(), body: JSON.stringify(corpo) });
  if (r.ok) {
    $('f-nome').value = ''; $('f-cargo').value = ''; $('f-tel').value = ''; $('f-email').value = '';
    await recarregarHierarquia(true);
  } else $('save-status').textContent = 'Erro: ' + await r.text();
};

/* ---- acesso: entrar / pedir / sair ---- */
async function refresh() {
  me = null;
  if (token) {
    const r = await fetch('/api/me', { headers: auth() });
    if (r.ok) me = await r.json();
    else { token = ''; localStorage.removeItem('contatos-token'); }
  }
  const dentro = logado();
  $('menu-dash').classList.toggle('hidden', !dentro);
  $('menu-notif').classList.toggle('hidden', !dentro);
  $('menu-sol').classList.toggle('hidden', !dentro);
  $('menu-reg').classList.toggle('hidden', !dentro);
  $('who-mail').classList.toggle('hidden', !dentro);
  if (dentro) $('who-mail').textContent = '👤 ' + (me.email || me.usuario);
  $('who-line').textContent = dentro ? '👤 ' + me.usuario : 'Sem acesso administrativo';
  $('btn-entrar').classList.toggle('hidden', dentro);
  $('btn-pedir').classList.toggle('hidden', dentro);
  $('btn-pedir-locais').classList.toggle('hidden', !dentro);
  $('btn-sair').classList.toggle('hidden', !dentro);
  $('btn-pedir').onclick = () => {
    if (logado()) { abrirPedidoNovo('cadastro'); return; }
    sessionStorage.setItem('pedirAposLogin', 'cadastro');
    location.href = '/oauth/login';
  };
  $('btn-pedir-locais').onclick = () => abrirPedidoNovo('locais');
  const ehAdmin = dentro && (me.admin === 1 || me.escopo === 'all');
  const ehVisitante = dentro && !ehAdmin && !(me.escopo || []).length;
  $('estado-hint').textContent = !dentro
    ? 'Consulta sem login. Com cadastro, entre para gerenciar seus locais.'
    : (ehAdmin
      ? 'Logado como ' + me.usuario + ' (admin: todos os locais).'
      : (ehVisitante
        ? 'Visitante — ' + me.usuario + ' (' + (me.email || 'sem e-mail') + '). Solicite acesso ou locais.'
        : 'Logado como ' + me.usuario + ` (locais liberados: ${me.escopo.length}).`));
  $('profile-badge').innerHTML = dentro
    ? '👤 ' + esc(me.usuario)
    : '<i>●</i> Visitante';
  if (dentro) carregarPedidos();
  if (dentro) notifBadge(); else $('notif-count').textContent = '';
  mostrarConsulta();
  marcarMenu('consulta');
  if (dentro) {
    $('conf-logado').classList.remove('hidden');
    $('conf-conta').textContent = `Usuário: ${me.usuario} · e-mail: ${me.email || '—'}` +
      (me.escopo === 'all' ? ' · admin (todos os locais).' : ` · ${me.escopo.length} acesso(s).`);
  }
  else $('conf-logado').classList.add('hidden');
  await recarregarHierarquia(true);
  initMapa('map', 'map-msg', locsMapa(), nome => {
    const com = H.comarcas.find(x => !ehOrgao(x) && norm(x.nome) === norm(nome));
    if (com) abrirComarca(com.id);
  });
}
$('btn-entrar').onclick = () => { $('modal-login').classList.remove('hidden'); $('l-status').textContent = ''; };
$('l-cancel').onclick = () => $('modal-login').classList.add('hidden');
$('l-pedir').onclick = () => {
  $('modal-login').classList.add('hidden');
  sessionStorage.setItem('pedirAposLogin', 'cadastro');
  location.href = '/oauth/login';
};
(function capturarTokenGoogle() {
  const m = (location.hash || '').match(/[#&]token=([A-Za-z0-9]+)/);
  if (m) {
    token = m[1]; localStorage.setItem('contatos-token', token);
    history.replaceState(null, '', location.pathname + location.search);
  }
})();
$('btn-sair').onclick = async () => {
  try {
    await fetch('/api/logout', { method: 'POST', headers: auth() });
  } catch (e) {}
  token = ''; localStorage.removeItem('contatos-token');
  refresh();
};

/* ---- árvore de locais do pedido (comarca > fórum > unidade > setor) ---- */
let pedSel = new Set(), pedForumAberto = '', pedUnidAberta = '';
const chavePed = (nivel, id) => nivel + ':' + id;
function pedCobertos() {
  if (!logado()) return new Set();
  if (me.escopo === 'all') return 'all';
  return new Set((me.escopo || []).map(a => a.nivel + ':' + a.alvo_id));
}
function pedDescendentes(com) {
  const fora = [];
  (com.foruns || []).forEach(f => {
    fora.push(chavePed('forum', f.id));
    (f.nos || []).forEach(u => {
      fora.push(chavePed('unidade', u.id));
      (u.filhos || []).forEach(s => fora.push(chavePed('setor', s.id)));
    });
  });
  return fora;
}
function preencherLocais() {
  const sel = $('p-comarca');
  sel.innerHTML = (H.comarcas || []).filter(m => !ehOrgao(m))
    .map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
  sel.onchange = renderArvore;
  pedSel = new Set(); pedForumAberto = ''; pedUnidAberta = '';
  renderArvore();
}
function pedLinha(nivel, id, nome, detalhe, extraCls, temFilhos, aberto, onAbrir) {
  const cob = pedCobertos();
  const k = chavePed(nivel, id);
  const ja = cob === 'all' || cob.has(k);
  const linha = document.createElement('div');
  linha.className = 'fa-loc' + (extraCls ? ' ' + extraCls : '');
  const chk = document.createElement('input');
  chk.type = 'checkbox'; chk.className = 'fa-loc-check';
  chk.checked = pedSel.has(k); chk.disabled = ja;
  chk.onchange = () => { pedAlternar(nivel, id, chk.checked); };
  linha.appendChild(chk);
  const meio = document.createElement('div');
  meio.className = 'fa-loc-body';
  if (temFilhos) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'fa-nome-btn';
    btn.textContent = (aberto ? '▾ ' : '▸ ') + nome;
    btn.onclick = e => { e.preventDefault(); e.stopPropagation(); onAbrir(); };
    meio.appendChild(btn);
  } else {
    const b = document.createElement('span'); b.className = 'fa-loc-nome'; b.textContent = nome; meio.appendChild(b);
  }
  if (detalhe) { const sm = document.createElement('small'); sm.textContent = detalhe; meio.appendChild(sm); }
  if (ja && cob !== 'all') { const jv = document.createElement('small'); jv.textContent = 'já liberado'; meio.appendChild(jv); }
  linha.appendChild(meio);
  linha.onclick = e => {
    if (e.target === chk || (e.target.closest && e.target.closest('button'))) return;
    if (chk.disabled) return;
    chk.checked = !chk.checked;
    pedAlternar(nivel, id, chk.checked);
  };
  return linha;
}
function pedAlternar(nivel, id, marcado) {
  const k = chavePed(nivel, id);
  const com = encontrarComarca($('p-comarca').value);
  if (marcado) {
    if (nivel === 'comarca' && com) pedDescendentes(com).forEach(x => pedSel.delete(x));
    if (nivel === 'forum' && com) {
      const f = (com.foruns || []).find(x => String(x.id) === String(id));
      (f && f.nos || []).forEach(u => {
        pedSel.delete(chavePed('unidade', u.id));
        (u.filhos || []).forEach(s => pedSel.delete(chavePed('setor', s.id)));
      });
    }
    if (nivel === 'unidade' && com) {
      (com.foruns || []).forEach(f => (f.nos || []).forEach(u => {
        if (String(u.id) === String(id)) (u.filhos || []).forEach(s => pedSel.delete(chavePed('setor', s.id)));
      }));
    }
    pedSel.add(k);
  } else pedSel.delete(k);
  renderArvore();
}
function renderArvore() {
  const box = $('p-arvore');
  const com = encontrarComarca($('p-comarca') && $('p-comarca').value);
  if (!com) { box.textContent = 'Selecione uma comarca.'; return; }
  box.textContent = '';
  const detC = `${(com.foruns || []).length} fórum(ns) • ${com.qtdContatos || 0} contato(s)`;
  box.appendChild(pedLinha('comarca', com.id, com.nome + ' (inteira)', detC, '', false));
  (com.foruns || []).forEach(f => {
    const abertoF = String(pedForumAberto) === String(f.id);
    box.appendChild(pedLinha('forum', f.id, f.nome + ' (' + (f.qtdContatos || 0) + ')', null, '', true, abertoF,
      () => { pedForumAberto = abertoF ? '' : f.id; renderArvore(); }));
    if (abertoF) (f.nos || []).forEach(u => {
      const abertoU = String(pedUnidAberta) === String(u.id);
      const disU = u.selecionavelAcesso === false;
      const linhaU = pedLinha('unidade', u.id, u.nome, null, 'fa-loc--sub', (u.filhos || []).length > 0, abertoU,
        () => { pedUnidAberta = abertoU ? '' : u.id; renderArvore(); });
      if (disU) linhaU.querySelector('input').disabled = true;
      box.appendChild(linhaU);
      if (abertoU) (u.filhos || []).forEach(s => {
        const linhaS = pedLinha('setor', s.id, s.nome, null, 'fa-loc--sub2', false);
        if (s.selecionavelAcesso === false) linhaS.querySelector('input').disabled = true;
        box.appendChild(linhaS);
      });
    });
  });
  const n = pedSel.size;
  $('ped-sel-count').textContent = n ? `(${n} selecionado${n === 1 ? '' : 's'})` : '';
}
async function abrirPedidoNovo(modo) {
  if (!logado()) {
    sessionStorage.setItem('pedirAposLogin', modo === 'locais' ? 'locais' : 'cadastro');
    $('modal-login').classList.remove('hidden');
    $('l-status').textContent = 'Entre com sua conta Google para solicitar acesso.';
    return;
  }
  window._pedModo = (modo === 'locais') ? 'locais' : 'cadastro';
  mostrarPedido();
  $('p-status').textContent = '';
  $('ped-hint').textContent = window._pedModo === 'locais'
    ? 'Escolha mais locais para o seu acesso.'
    : 'Primeiro acesso: só a identidade. Os locais vêm depois, em Solicitar locais.';
  if (logado()) {
    $('p-nome').value = '';
    $('p-email').value = me.email || '';
    $('p-email').readOnly = true;
    $('p-user').value = me.usuario;
    $('p-user').disabled = true;
  } else {
    $('p-email').readOnly = false;
    $('p-user').disabled = false;
  }
  if (!(H.comarcas || []).length) { try { await recarregarHierarquia(true); } catch (e) {} }
  preencherLocais();
  $('bloco-locais').classList.toggle('hidden', window._pedModo !== 'locais');
  $('bloco-admin').classList.toggle('hidden', window._pedModo !== 'locais');
  if (window._pedModo !== 'locais') { try { $('p-admin').checked = false; } catch (e) {} }
}
function mostrarPedido() {
  VIEWS.forEach(v => { const s = $('view-' + v); if (s) s.classList.add('hidden'); });
  $('view-pedido').classList.remove('hidden');
  document.querySelectorAll('.menu-item[data-view]').forEach(b => b.classList.remove('active'));
  try { window.scrollTo(0, 0); } catch (e) {}
}
function voltarConsulta() {
  mostrarConsulta();
  marcarMenu('consulta');
  renderInicio();
}
$('p-cancel').onclick = () => {
  voltarConsulta();
  $('p-user').disabled = false;
};
$('ped-voltar').onclick = () => voltarConsulta();

/* ---- confirmação dinâmica de solicitação por nível (via hierarquia) ---- */
async function abrirConf(nivel, id, nome) {
  confPed = { nivel, alvo_id: Number(id) };
  $('c-status').textContent = '';
  $('c-motivo').value = '';
  let texto = '';
  if (nivel === 'comarca') {
    const m = encontrarComarca(id);
    texto = `Solicitar acesso à comarca <b>${esc(nome || (m && m.nome) || id)}</b> inteira — ` +
            `todos os ${m ? m.qtdForuns : 0} fóruns, ${m ? m.qtdUnidades : 0} unidades e seus setores?`;
  } else if (nivel === 'forum') {
    const f = encontrarForum(id);
    const nSet = f ? qtdSetores(f.nos || []) : 0;
    texto = `Solicitar acesso ao fórum <b>${esc(nome || (f && f.nome) || id)}</b> inteiro — ` +
            `todas as ${(f ? f.nos : []).length} unidades e seus ${nSet} setores?`;
  } else if (nivel === 'unidade') {
    const ach = acharUnidade(id);
    const nSet = ach ? (ach.no.filhos || []).length : 0;
    texto = `Solicitar acesso à unidade <b>${esc(nome || (ach && ach.no.nome) || id)}</b> inteira — ` +
            `todos os ${nSet} setor(es)?`;
  } else {
    texto = `Solicitar acesso ao setor <b>${esc(nome || id)}</b>?`;
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
  const emCadastro = window._pedModo !== 'locais';
  const corpo = { nome: $('p-nome').value.trim(),
                  email: (logado() ? me.email : $('p-email').value.trim()),
                  usuario: (($('p-user').disabled && logado()) ? me.usuario : $('p-user').value.trim()),
                  motivo: $('p-motivo').value.trim(),
                  admin: (!emCadastro && $('p-admin').checked === true),
                  escopos: [...pedSel].map(k => {
                    const i = k.indexOf(':');
                    return { tipo: k.slice(0, i), id: Number(k.slice(i + 1)) };
                  }) };
  if (!corpo.nome) { $('p-status').textContent = 'Informe seu nome.'; return; }
  if (!emCadastro && !corpo.escopos.length && !corpo.admin) { $('p-status').textContent = 'Selecione ao menos um local na árvore.'; return; }
  const r = await fetch('/api/pedidos', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  const txt = await r.text();
  let j = {};
  try { j = JSON.parse(txt); } catch (e) {}
  if (r.ok && j.auto_aprovado) {
    $('p-status').textContent = 'Acesso liberado automaticamente (demonstração).';
    try { me = await (await fetch('/api/me', { headers: auth() })).json(); } catch (e) {}
    setTimeout(() => voltarConsulta(), 900);
    return;
  }
  $('p-status').textContent = r.ok
    ? 'Pedido enviado. Aguarde a aprovação do administrador.'
    : 'Erro: ' + (j.erro || txt);
};

/* ---- dashboard ---- */
async function carregarDashboard() {
  if (!logado()) return;
  const r = await (await fetch('/api/resumo', { headers: auth() })).json();
  const coms = (H.comarcas || []).filter(m => !ehOrgao(m));
  const comEdit = coms.filter(c => cobre('comarca', c.id));
  const totalEdit = comEdit.reduce((a, c) => a + (c.qtdContatos || 0), 0);
  const totalGeral = coms.reduce((a, c) => a + (c.qtdContatos || 0), 0);
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
  const max = Math.max(1, ...coms.map(c => c.qtdContatos || 0));
  $('dash-mun').innerHTML = coms.map(c => {
    const w = Math.round(100 * (c.qtdContatos || 0) / max);
    const ok = cobre('comarca', c.id);
    return `<div class="bar-row"><span class="bar-label">${esc(c.nome)}${ok && me.escopo !== 'all' ? ' ✓' : ''}</span>` +
      `<span class="bar-track"><span class="bar-fill${ok ? '' : ' ro'}" style="width:${w}%"></span></span>` +
      `<span class="bar-num">${c.qtdContatos || 0}</span></div>`;
  }).join('');
  $('dash-ult').innerHTML = (r.ultimos || []).map(x =>
    `<li><b>${esc(x.acao)}</b> — ${esc(x.detalhe)} <i>${esc(x.data)}</i></li>`
  ).join('') || '<li>Sem registros.</li>';
}

/* ---- configurações: tema ---- */
function aplicarTema() {
  const dark = (localStorage.getItem('contatos-theme') || 'light') === 'dark';
  document.body.dataset.theme = dark ? 'dark' : 'light';
  const t = $('toggle-dark-mode');
  if (t) t.checked = dark;
}
$('toggle-dark-mode').onchange = (e) => {
  localStorage.setItem('contatos-theme', e.target.checked ? 'dark' : 'light');
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
    (p.nivel === 'sistema' && !p.alvo_id ? ` — <b>gestor do sistema</b>` :
    (p.alvo_nome ? ` — ${esc({comarca:'comarca',forum:'fórum',unidade:'unidade',setor:'setor'}[p.nivel]||p.nivel)}: <b>${esc(p.alvo_nome)}</b>` : (p.localidade ? ` — local: <b>${esc(p.localidade)}</b>` : ''))) +
    (p.motivo ? ` — ${esc(p.motivo)}` : '') +
    ` <button class="btn-primary" data-id="${p.id}">aprovar</button></li>`
  ).join('') || '<li>Nenhuma solicitação pendente.</li>';
  document.querySelectorAll('#pedidos button').forEach(b => {
    b.onclick = async () => {
      const r = await fetch('/api/pedidos/' + b.dataset.id + '/aprovar',
        { method: 'POST', headers: auth() });
      const j = await r.json();
      alert(r.ok ? `Aprovado: ${j.usuario} (entra com a conta Google)` : 'Erro: ' + (j.erro || ''));
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
  vincularBuscaGlobal();
  await refresh();
  try {
    if (sessionStorage.getItem('pedirAposLogin') && logado()) {
      sessionStorage.removeItem('pedirAposLogin');
      abrirPedidoNovo('cadastro');
    }
  } catch (e) {}
})();
