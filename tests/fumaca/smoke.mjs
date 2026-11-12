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
 * Roda numa cópia do app em diretório temporário: nunca toca no contatos.db
 * do dono (que pode ter o resultado do teste manual dele).
 *
 * Uso:
 *   cd tests/fumaca && npm ci && npx playwright install chromium
 *   node smoke.mjs
 *
 * Variáveis: PYTHON (padrão python3), PW_HEADED=1 para ver a janela.
 */
import { spawn } from 'node:child_process';
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

async function main() {
  if (!existsSync(join(RAIZ, 'app.py'))) {
    console.error('Não achei app.py em ' + RAIZ + ' — rode a partir do repositório.');
    process.exit(2);
  }
  const pasta = copiarApp();
  const porta = await porta_livre();
  const base = 'http://127.0.0.1:' + porta;
  const log = join(pasta, 'servidor.log');
  console.log('servidor: ' + base + ' (cópia em ' + pasta + ')');

  const servidor = spawn(PYTHON, ['app.py'], {
    cwd: pasta,
    env: {
      ...process.env,
      PORT: String(porta),
      HOST: '127.0.0.1',
      LOCAL_LOGIN: '1',
      SIMULACAO_AUTO_APROVAR: '1',
      ADMIN_EMAILS: 'dono@exemplo.jus.br',
      INTRANET_ONLY: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let saida = '';
  servidor.stdout.on('data', d => { saida += d; });
  servidor.stderr.on('data', d => { saida += d; });
  servidor.on('exit', codigo => {
    if (codigo && falhas.length === 0) {
      console.error('servidor saiu com código ' + codigo + '\n' + saida.slice(-2000));
    }
  });

  let navegador;
  try {
    if (!await esperar(base + '/api/comarcas')) {
      console.error('servidor não respondeu em 40 s\n' + saida.slice(-2000));
      process.exit(2);
    }

    // Login local: o /admin não tem formulário (o público usa Google), então a
    // sessão nasce pela API e entra no localStorage antes do primeiro script.
    const login = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: 'admin', senha: 'admin123' })
    });
    if (!login.ok) throw new Error('login local falhou: HTTP ' + login.status);
    const { token } = await login.json();

    navegador = await chromium.launch({ headless: !process.env.PW_HEADED });
    const contexto = await navegador.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
    const erros = [];
    await contexto.addInitScript(t => {
      localStorage.setItem('contatos-token', t);
    }, token);
    const pagina = await contexto.newPage();
    pagina.on('pageerror', e => erros.push('pageerror: ' + e.message));
    pagina.on('console', m => {
      if (m.type() !== 'error') return;
      const texto = m.text();
      // Leaflet e tiles vêm de CDN: bloqueio de rede externa não é regressão do app.
      if (/unpkg\.com|tile\.openstreetmap|ERR_(BLOCKED|INTERNET|CONNECTION|NAME_NOT_RESOLVED)/.test(texto)) return;
      erros.push('console: ' + texto);
    });

    console.log('\n1) /admin com sessão local');
    const resposta = await pagina.goto(base + '/admin', { waitUntil: 'domcontentloaded' });
    conferir(resposta && resposta.status() === 200, '/admin responde 200');
    await pagina.waitForSelector('#menu-reg:not(.hidden)', { timeout: 20000 });
    ok('menu "Registro de alterações" aparece para o admin');
    const quem = (await pagina.textContent('#who-line')) || '';
    conferir(!/Sem acesso/i.test(quem), 'rodapé identifica o usuário logado (' + quem.trim() + ')');

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
  } catch (e) {
    falha('exceção: ' + (e && e.message ? e.message : String(e)));
  } finally {
    if (navegador) await navegador.close().catch(() => {});
    servidor.kill('SIGTERM');
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
