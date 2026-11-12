#!/usr/bin/env node
/**
 * Teste de fumaça do /admin num navegador real (Playwright).
 *
 * A suíte de Python bate na API e confere o HTML servido; ela não prova que o
 * JavaScript monta a tela. Este teste abre o /admin, entra com o login local,
 * clica em "Reconfirmar" e confere a primeira linha da fila, baixa o CSV e
 * compara o arquivo com o que está na tela, e confere o gráfico de mudanças por
 * mês — o caminho que ninguém estava olhando. O CSV entra aqui porque o guard
 * de Python é estrutural (lê o JS): só um download de verdade prova que o
 * arquivo sai com o cabeçalho e as linhas certas.
 *
 * Os passos 1–8 rodam em SIMULACAO_AUTO_APROVAR=1. O passo 9 reinicia a mesma
 * cópia em =0 — o modo que o render.yaml publica — e confere o que o visitante
 * lê: o chip "Aguardando Administrador" no cartão do pedido e o aviso de acesso
 * somente leitura. Até então esse modo só tinha guard de Python (a API), e a
 * tela ficava sem prova: rótulo trocado, aria-label vazio ou chip sumido
 * passariam.
 *
 * Roda numa cópia do app em diretório temporário: nunca toca no contatos.db
 * do dono (que pode ter o resultado do teste manual dele).
 *
 * Uso:
 *   cd tests/fumaca && npm ci && npx playwright install chromium
 *   node smoke.mjs
 *
 * Variáveis: PYTHON (padrão python3), PW_HEADED=1 para ver a janela.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..');
const PYTHON = process.env.PYTHON || 'python3';
const falhas = [];

function ok(mensagem) { console.log('  ok   ' + mensagem); }
function falha(mensagem) { falhas.push(mensagem); console.log('  FALHA ' + mensagem); }
function conferir(condicao, mensagem) { condicao ? ok(mensagem) : falha(mensagem); }

function porta_livre() {
  return new Promise((aceitar, rejeitar) => {
    const srv = createServer();
    srv.once('error', rejeitar);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => aceitar(port));
    });
  });
}

async function esperar(url, limiteMs = 40000) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch (e) { /* servidor ainda subindo */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

/** Cópia mínima do app: o que o servidor lê em tempo de execução. */
function copiarApp() {
  const destino = mkdtempSync(join(tmpdir(), 'dc2-fumaca-'));
  for (const nome of ['app.py', 'seed_mascarado.json']) {
    cpSync(join(RAIZ, nome), join(destino, nome));
  }
  cpSync(join(RAIZ, 'frontend'), join(destino, 'frontend'), { recursive: true });
  return destino;
}

/** Sobe a cópia numa porta livre; `auto` é a flag SIMULACAO_AUTO_APROVAR. */
async function subirServidor(pasta, auto) {
  const porta = await porta_livre();
  const proc = spawn(PYTHON, ['app.py'], {
    cwd: pasta,
    env: {
      ...process.env,
      PORT: String(porta),
      HOST: '127.0.0.1',
      LOCAL_LOGIN: '1',
      SIMULACAO_AUTO_APROVAR: auto ? '1' : '0',
      ADMIN_EMAILS: 'dono@exemplo.jus.br',
      INTRANET_ONLY: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let saida = '';
  proc.stdout.on('data', d => { saida += d; });
  proc.stderr.on('data', d => { saida += d; });
  proc.on('exit', codigo => {
    if (codigo && falhas.length === 0) {
      console.error('servidor saiu com código ' + codigo + '\n' + saida.slice(-2000));
    }
  });
  return {
    proc,
    base: 'http://127.0.0.1:' + porta,
    log: () => saida,
    parar: () => new Promise(r => {
      if (proc.exitCode !== null) return r();
      proc.once('exit', r);
      proc.kill('SIGTERM');
    })
  };
}

/** Erros de console da página, com o ruído de CDN (Leaflet/tiles) filtrado. */
function ligarErros(pagina, erros) {
  pagina.on('pageerror', e => erros.push('pageerror: ' + e.message));
  pagina.on('console', m => {
    if (m.type() !== 'error') return;
    const texto = m.text();
    // Leaflet e tiles vêm de CDN: bloqueio de rede externa não é regressão do app.
    if (/unpkg\.com|tile\.openstreetmap|ERR_(BLOCKED|INTERNET|CONNECTION|NAME_NOT_RESOLVED)/.test(texto)) return;
    // A URL entra na mensagem: "Failed to load resource: 403" sozinho não diz
    // qual rota respondeu isso, e é a rota que aponta o defeito.
    const onde = (m.location() && m.location().url) || '';
    erros.push('console: ' + texto + (onde ? ' @ ' + onde : ''));
  });
}

async function entrar(base, usuario, senha) {
  const r = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, senha })
  });
  if (!r.ok) throw new Error('login de ' + usuario + ' falhou: HTTP ' + r.status);
  return (await r.json()).token;
}

async function main() {
  if (!existsSync(join(RAIZ, 'app.py'))) {
    console.error('Não achei app.py em ' + RAIZ + ' — rode a partir do repositório.');
    process.exit(2);
  }
  const pasta = copiarApp();
  const log = join(pasta, 'servidor.log');
  let servidor = await subirServidor(pasta, true);
  const base = servidor.base;
  console.log('servidor: ' + base + ' (cópia em ' + pasta + ')');

  let navegador;
  try {
    if (!await esperar(base + '/api/comarcas')) {
      console.error('servidor não respondeu em 40 s\n' + servidor.log().slice(-2000));
      process.exit(2);
    }

    // Login local: o /admin não tem formulário (o público usa Google), então a
    // sessão nasce pela API e entra no localStorage antes do primeiro script.
    const token = await entrar(base, 'admin', 'admin123');

    navegador = await chromium.launch({ headless: !process.env.PW_HEADED });
    const contexto = await navegador.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
    const erros = [];
    await contexto.addInitScript(t => {
      localStorage.setItem('contatos-token', t);
    }, token);
    const pagina = await contexto.newPage();
    ligarErros(pagina, erros);

    console.log('\n1) /admin com sessão local');
    const resposta = await pagina.goto(base + '/admin', { waitUntil: 'domcontentloaded' });
    conferir(resposta && resposta.status() === 200, '/admin responde 200');
    await pagina.waitForSelector('#menu-reg:not(.hidden)', { timeout: 20000 });
    ok('menu "Registro de alterações" aparece para o admin');
    const quem = (await pagina.textContent('#who-line')) || '';
    conferir(!/Sem acesso/i.test(quem), 'rodapé identifica o usuário logado (' + quem.trim() + ')');
    // O aviso de acesso é reescrito pelo /api/me (o HTML traz o texto somente
    // leitura como padrão). Em modo automático ele tem de dizer automática: é a
    // prova de que o texto segue o servidor, e o passo 9 confere o outro modo.
    const avisoAuto = ((await pagina.textContent('#ped-dica')) || '').trim();
    conferir(/automática/.test(avisoAuto),
      'o aviso de acesso segue o servidor (modo automático): ' + avisoAuto.slice(0, 60));

    console.log('\n2) clique em Reconfirmar');
    const botao = pagina.locator('#fc-antigos');
    await botao.click();
    await pagina.waitForSelector('#fc-busca-resultados [data-reconf-i="0"]', { timeout: 15000 });
    const itens = await pagina.$$eval('#fc-busca-resultados [data-reconf-i]', els =>
      els.map(el => el.innerText.replace(/\s+/g, ' ').trim()));
    conferir(itens.length > 0, 'fila trouxe ' + itens.length + ' contato(s)');
    const cabecalho = (await pagina.textContent('#fc-busca-resultados .fc-busca-cabecalho') || '').trim();
    const declarado = parseInt(cabecalho, 10);
    conferir(declarado === itens.length,
      'cabeçalho declara ' + declarado + ' e a fila tem ' + itens.length);
    conferir(/desde \d{2}\/\d{4}/.test(itens[0]),
      'primeira linha mostra "desde MM/AAAA": ' + itens[0].slice(0, 120));
    conferir(/ · /g.test(itens[0]) && itens[0].split(' · ').length >= 3,
      'primeira linha traz tipo/valor, caminho e fonte');

    // Ordem: a lista é "mais antigos primeiro". As datas vêm como dd/mm/aaaa.
    const datas = itens.map(t => {
      const m = t.match(/desde (\d{2})\/(\d{4})/);
      return m ? Number(m[2]) * 100 + Number(m[1]) : null;
    }).filter(Boolean);
    const ordenadas = datas.every((v, i) => i === 0 || datas[i - 1] <= v);
    conferir(ordenadas, 'fila está em ordem crescente de vigência');

    console.log('\n3) abrir a primeira linha da fila');
    await pagina.locator('#fc-busca-resultados [data-reconf-i="0"]').click();
    await pagina.waitForFunction(
      () => document.getElementById('fc-busca-resultados').hasAttribute('hidden'),
      null, { timeout: 10000 });
    ok('clique na linha fecha a fila');
    await pagina.waitForFunction(
      () => !!document.querySelector('#lista .fc-contato--achado'),
      null, { timeout: 10000 });
    ok('contato clicado aparece destacado na lista (navegação executou)');

    // Procedência no card, que é o que o visitante lê. O rótulo neutro
    // "base do sistema (sem documento declarado)" foi aposentado em 12/11/2026:
    // quem não tem documento fica sem linha de procedência, não com carimbo.
    // Card que declara `data-fonte` tem de mostrar essa fonte no texto; o
    // caminho de volta do rótulo (seed, backfill ou render) morre aqui.
    const procedencias = await pagina.$$eval('#lista .fc-contato', els => els.map(el => ({
      fonte: (el.dataset.fonte || '').trim(),
      texto: ((el.querySelector('.fc-contato-fonte') || {}).innerText || '')
        .replace(/\s+/g, ' ').trim(),
    })));
    conferir(procedencias.length > 0, 'a tela tem ' + procedencias.length + ' card(s) de contato');
    conferir(!procedencias.some(p => /documento declarado/i.test(p.texto)),
      'nenhum card exibe o rótulo neutro aposentado');
    conferir(procedencias.filter(p => p.fonte).every(p => p.texto.includes(p.fonte)),
      'card com fonte declarada mostra a fonte no texto');
    conferir(procedencias.filter(p => !p.fonte).every(p => !p.texto || p.texto.startsWith('✓')),
      'card sem documento não inventa linha de procedência');

    console.log('\n4) exportar CSV do que está na tela');
    // O CSV era o único caminho de saída do dado e não tinha teste de ponta a
    // ponta: o guard era estrutural (lê o JS). Aqui o arquivo é baixado de
    // verdade e conferido contra a tela, que é a fonte do export.
    const botaoCsv = pagina.locator('#fc-exportar');
    await botaoCsv.waitFor({ state: 'visible', timeout: 15000 });
    const [download] = await Promise.all([
      pagina.waitForEvent('download', { timeout: 20000 }),
      botaoCsv.click()
    ]);
    conferir(/\.csv$/.test(download.suggestedFilename()),
      'download tem nome de CSV (' + download.suggestedFilename() + ')');
    const bruto = readFileSync(await download.path(), 'utf8').replace(/^\uFEFF/, '');
    const linhas = bruto.split('\r\n').filter(l => l.trim() !== '');
    const colunas = linhas[0].split(';').map(c => c.replace(/^"|"$/g, ''));
    conferir(colunas.join('|') === 'Nome|Tipo|Valor|Fonte|Desde|Conferido em|Conferido por',
      'cabeçalho do CSV: ' + colunas.join('; '));
    const naTela = await pagina.$$eval('#lista .fc-contato', els => els.length);
    conferir(linhas.length - 1 === naTela,
      'CSV tem ' + (linhas.length - 1) + ' linha(s) para ' + naTela + ' contato(s) na tela');
    const seteColunas = linhas.slice(1).every(l => (l.match(/;/g) || []).length === 6);
    conferir(linhas.length > 1 && seteColunas,
      'toda linha do CSV traz as 7 colunas');
    // A coluna Fonte é o `data-fonte` do card: contato sem documento sai com a
    // célula vazia, nunca com o rótulo neutro que saiu da tela.
    const colunaFonte = linhas.slice(1).map(l => l.split(';')[3].replace(/^"|"$/g, ''));
    conferir(!colunaFonte.some(v => /documento declarado/i.test(v)),
      'o CSV não carrega o rótulo neutro aposentado');
    const novoNaBarra = await pagina.evaluate(() => {
      const b = document.getElementById('fc-novo');
      return { existe: !!b, oculto: b ? getComputedStyle(b).display === 'none' : null };
    });
    conferir(novoNaBarra.oculto,
      'com contato na tela o "Novo contato" da barra não aparece (a ação mora na seção)');

    console.log('\n5) Exportar CSV fora de uma tela de contatos');
    // O botão só existe onde há contato na tela. Fora daí ele tem de sair de
    // cena com estado coerente — desabilitado e com o motivo escrito —, não
    // sobreviver habilitado de uma tela anterior (clique que exporta nada) nem
    // virar botão cinza morto em toda tela do sistema.
    await pagina.locator('[data-view="consulta"]').click();
    await pagina.waitForFunction(
      () => document.querySelectorAll('#lista .fc-contato').length === 0,
      null, { timeout: 15000 });
    const semContatos = await pagina.evaluate(() => {
      const b = document.getElementById('fc-exportar');
      return {
        oculto: getComputedStyle(b).display === 'none',
        hidden: b.classList.contains('hidden'),
        disabled: b.disabled,
        title: b.title,
        aria: b.getAttribute('aria-label'),
      };
    });
    conferir(semContatos.hidden && semContatos.oculto,
      'sem contato na tela o botão sai de cena (display none)');
    conferir(semContatos.disabled, 'e sai desabilitado, não clicável');
    conferir(/^Nada para exportar/.test(semContatos.title || ''),
      'o title explica o estado: ' + semContatos.title);
    conferir(semContatos.aria === semContatos.title,
      'o aria-label repete o motivo (leitor de tela não lê title)');
    const novoInicio = await pagina.evaluate(() => {
      const b = document.getElementById('fc-novo');
      return b ? getComputedStyle(b).display === 'none' : null;
    });
    conferir(novoInicio, 'no início o "Novo contato" da barra também fica fora de cena');

    console.log('\n6) mudanças por mês no Registro');
    await pagina.locator('#menu-reg').click();
    await pagina.waitForSelector('#hist-mensal .hm-card svg .hm-bar', { timeout: 15000 });
    const barras = await pagina.$$eval('#hist-mensal .hm-bar', els => els.length);
    conferir(barras === 12, 'gráfico tem 12 barras (uma por mês), achou ' + barras);
    const totalTela = (await pagina.textContent('#hist-mensal .hm-num b') || '').trim();
    const mensal = await (await fetch(base + '/api/historico/mensal', {
      headers: { 'X-Admin-Token': token }
    })).json();
    conferir(String(mensal.total) === totalTela,
      'total da tela (' + totalTela + ') bate com a API (' + mensal.total + ')');
    const rotulos = await pagina.$$eval('#hist-mensal .hm-lbl', els => els.map(e => e.textContent));
    conferir(rotulos.length === 12, '12 rótulos de mês');
    conferir(new Set(rotulos).size >= 10, 'rótulos variam (não é um mês repetido)');

    await pagina.screenshot({ path: join(pasta, 'registro.png'), fullPage: true });
    console.log('  evidência: ' + join(pasta, 'registro.png'));

    console.log('\n7) barra do painel em tela pequena');
    // O @media(max-width:600px) é o primeiro ponto onde a barra muda de forma
    // por largura — e o único jeito de o CI notar se uma regra futura desfizer
    // o alvo de toque de 44 px, porque no desktop (o que a fumaça media até
    // aqui) tudo continua idêntico.
    await pagina.setViewportSize({ width: 390, height: 844 });
    await pagina.goto(base + '/admin', { waitUntil: 'domcontentloaded' });
    await pagina.waitForSelector('#fc-antigos:not([disabled])', { timeout: 20000 });
    await pagina.locator('#fc-antigos').click();
    await pagina.waitForSelector('#fc-busca-resultados [data-reconf-i="0"]', { timeout: 15000 });
    await pagina.locator('#fc-busca-resultados [data-reconf-i="0"]').click();
    await pagina.waitForFunction(
      () => !!document.querySelector('#lista .fc-contato'),
      null, { timeout: 15000 });
    const medirBarra = () => pagina.evaluate(() => {
      const alturas = ['fc-antigos', 'fc-exportar'].map(id =>
        Math.round(document.getElementById(id).getBoundingClientRect().height));
      return {
        alturas,
        estouro: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      };
    });
    const pequena = await medirBarra();
    conferir(pequena.alturas.every(h => h >= 44),
      'em 390 px os botões da barra têm 44 px de altura (achou ' + pequena.alturas.join('/') + ')');
    conferir(!pequena.estouro, 'em 390 px a barra não estoura a largura da tela');
    await pagina.setViewportSize({ width: 800, height: 900 });
    const grande = await medirBarra();
    conferir(grande.alturas.every(h => h < 40),
      'acima de 600 px a barra volta ao tamanho de desktop (achou ' + grande.alturas.join('/') + ')');

    console.log('\n8) console do navegador');
    conferir(erros.length === 0, 'sem erro de JavaScript' + (erros.length ? ': ' + erros.slice(0, 3).join(' | ') : ''));

    console.log('\n9) modo somente leitura: chip "Aguardando Administrador"');
    // O render.yaml publica SIMULACAO_AUTO_APROVAR=0 e nenhum passo daqui
    // abria a tela nesse modo — só a suíte de Python olhava a API. Aqui a
    // cópia reinicia em somente leitura, um visitante sem escopo pede uma
    // comarca e o cartão tem de contar a ele que o pedido espera um
    // Administrador (e não "Pedido pendente", que é o rótulo do outro modo).
    await servidor.parar();
    servidor = await subirServidor(pasta, false);
    const baseLeitura = servidor.base;
    if (!await esperar(baseLeitura + '/api/comarcas')) {
      throw new Error('o boot em somente leitura não respondeu\n' + servidor.log().slice(-2000));
    }
    // O /admin não tem rota de criação de conta: o visitante nasce direto no
    // banco da cópia (mesmo caminho do smoke-fila.mjs).
    const senha = execFileSync(PYTHON, ['-c', 'import app; print(app.gerar_hash("leitura123"))'],
      { cwd: pasta }).toString().trim();
    execFileSync(PYTHON, ['-c', `
import sqlite3, sys
con = sqlite3.connect('contatos.db')
con.execute("INSERT INTO usuarios (usuario, senha_sha256, aprovado, admin, email)"
            " VALUES ('visitante', ?, 1, 0, 'visitante@exemplo.jus.br')", (sys.argv[1],))
con.commit()
`, senha], { cwd: pasta });
    const tokenVisitante = await entrar(baseLeitura, 'visitante', 'leitura123');
    const pedido = await fetch(baseLeitura + '/api/pedidos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': tokenVisitante },
      body: JSON.stringify({ nome: 'Visitante Fumaça', motivo: 'avaliação',
                             nivel: 'comarca', alvo_id: 'M2' })
    });
    const corpoPedido = await pedido.json().catch(() => ({}));
    conferir(pedido.status === 201, 'pedido de comarca aceito em somente leitura (' + pedido.status + ')');
    conferir(corpoPedido.auto_aprovado === false,
      'o servidor não aprova sozinho (auto_aprovado=false)');

    const contextoLeitura = await navegador.newContext({ viewport: { width: 1360, height: 900 } });
    await contextoLeitura.addInitScript(t => localStorage.setItem('contatos-token', t), tokenVisitante);
    const paginaLeitura = await contextoLeitura.newPage();
    const errosLeitura = [];
    ligarErros(paginaLeitura, errosLeitura);
    await paginaLeitura.goto(baseLeitura + '/admin', { waitUntil: 'domcontentloaded' });
    // O cartão da comarca pedida é o único com pedido pendente: o chip tem de
    // estar nele, não num cartão qualquer.
    const chip = paginaLeitura.locator('.fc-card[data-comarca="M2"] .fc-access.pendente');
    await chip.waitFor({ state: 'visible', timeout: 20000 });
    const rotulo = ((await chip.textContent()) || '').trim();
    conferir(rotulo === 'Aguardando Administrador',
      'o chip diz "Aguardando Administrador" (achou "' + rotulo + '")');
    conferir(await chip.isDisabled(), 'o chip é estado, não clique: o botão está desabilitado');
    const avisoChip = (await chip.getAttribute('title')) || '';
    conferir(/somente leitura/.test(avisoChip),
      'o title explica o modo: "' + avisoChip + '"');
    const ariaChip = (await chip.getAttribute('aria-label')) || '';
    conferir(ariaChip.startsWith(rotulo) && /somente leitura/.test(ariaChip),
      'o aria-label repete o rótulo e o motivo (leitor de tela não lê title)');
    const quantosChips = await paginaLeitura.$$eval('.fc-access.pendente', els => els.length);
    conferir(quantosChips === 1, 'só o cartão do pedido traz o chip (' + quantosChips + ')');
    const avisoLeitura = ((await paginaLeitura.textContent('#ped-dica')) || '').trim();
    conferir(/somente leitura/.test(avisoLeitura),
      'o aviso do formulário diz somente leitura: ' + avisoLeitura.slice(0, 60));
    const meLeitura = await (await fetch(baseLeitura + '/api/me', {
      headers: { 'X-Admin-Token': tokenVisitante }
    })).json();
    conferir(meLeitura.aprovacao_automatica === false
      && Array.isArray(meLeitura.escopo) && meLeitura.escopo.length === 0,
      'a sessão não ganhou escopo nem aprovação automática');
    conferir(errosLeitura.length === 0,
      'sem erro de JavaScript em somente leitura'
      + (errosLeitura.length ? ': ' + errosLeitura.slice(0, 3).join(' | ') : ''));
    await paginaLeitura.screenshot({ path: join(pasta, 'somente-leitura.png'), fullPage: true });
    // O recorte do cartão é a evidência que casa com a asserção: na página
    // inteira o chip some no meio de 900 px de altura.
    await paginaLeitura.locator('.fc-card[data-comarca="M2"]')
      .screenshot({ path: join(pasta, 'somente-leitura-cartao.png') });
    console.log('  evidência: ' + join(pasta, 'somente-leitura-cartao.png'));
    await contextoLeitura.close();
  } catch (e) {
    falha('exceção: ' + (e && e.message ? e.message : String(e)));
  } finally {
    if (navegador) await navegador.close().catch(() => {});
    await servidor.parar().catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    if (falhas.length === 0 && process.env.PW_KEEP !== '1') {
      rmSync(pasta, { recursive: true, force: true });
    } else if (falhas.length) {
      console.log('\nlog do servidor em ' + log);
    }
  }

  console.log('\n' + (falhas.length === 0 ? 'FUMAÇA OK' : 'FUMAÇA FALHOU (' + falhas.length + ')'));
  process.exit(falhas.length === 0 ? 0 : 1);
}

main();
