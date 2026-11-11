#!/usr/bin/env node
/**
 * Fumaça da fila de reconfirmação em duas bordas que a suíte não vê.
 *
 * O `smoke.mjs` prova o caminho feliz com o admin: clica em Reconfirmar, abre a
 * primeira linha, marca o ✓, exporta o CSV. Ficam de fora dois estados que já
 * foram bug de tela:
 *
 *   1. fila vazia — o botão abria e fechava a caixa no mesmo gesto, sem texto;
 *   2. usuário de escopo parcial — a fila é da base inteira e o `conferir` no
 *      servidor exige escopo do setor, então a fila não é dele.
 *
 * Aqui o banco nasce vazio de vigência (todo `vigente_desde` em branco) e um
 * usuário de escopo parcial é criado antes do segundo boot. A preparação é
 * feita numa cópia descartável: nunca toca no `contatos.db` do dono.
 *
 * Uso:
 *   cd tests/fumaca && node smoke-fila.mjs        (PW_HEADED=1 para ver)
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..');
const PYTHON = process.env.PYTHON || 'python3';
const falhas = [];

function ok(m) { console.log('  ok   ' + m); }
function falha(m) { falhas.push(m); console.log('  FALHA ' + m); }
function conferir(cond, m) { cond ? ok(m) : falha(m); }

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
    } catch (e) { /* ainda subindo */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

/** Sobe uma cópia do app no diretório dado e devolve {base, parar}. */
async function subir(dir) {
  const porta = await porta_livre();
  const env = {
    ...process.env, HOST: '127.0.0.1', PORT: String(porta), INTRANET_ONLY: '0',
    LOCAL_LOGIN: '1', SIMULACAO_AUTO_APROVAR: '1',
    ADMIN_EMAILS: 'admin@exemplo.jus.br'
  };
  const proc = spawn(PYTHON, ['app.py'], { cwd: dir, env });
  let saida = '';
  proc.stdout.on('data', d => { saida += d; });
  proc.stderr.on('data', d => { saida += d; });
  const base = 'http://127.0.0.1:' + porta;
  if (!await esperar(base + '/healthz')) {
    proc.kill('SIGKILL');
    throw new Error('servidor não respondeu\n' + saida.slice(-3000));
  }
  return {
    base,
    parar: () => new Promise(r => {
      if (proc.exitCode !== null) return r();
      proc.once('exit', r);
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000).unref();
    })
  };
}

async function entrar(base, usuario, senha) {
  const r = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, senha })
  });
  if (!r.ok) throw new Error('login de ' + usuario + ' falhou: HTTP ' + r.status);
  return (await r.json()).token;
}

async function abrirAdmin(navegador, base, token, marcar) {
  const ctx = await navegador.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addInitScript(t => localStorage.setItem('contatos-token', t), token);
  const pagina = await ctx.newPage();
  const erros = [];
  pagina.on('pageerror', e => erros.push('pageerror: ' + e.message));
  await pagina.goto(base + '/admin', { waitUntil: 'domcontentloaded' });
  await pagina.waitForFunction(marcar, null, { timeout: 25000 });
  return { pagina, ctx, erros };
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'fila-'));
  const copia = join(tmp, 'app');
  cpSync(RAIZ, copia, {
    recursive: true,
    filter: src => !/[/\\](\.git|node_modules|contatos\.db)([/\\]|$)/.test(src)
  });

  let servidor = await subir(copia);
  let navegador;
  try {
    // ---- prepara o estado: sem vigência e com um usuário de escopo parcial ----
    await servidor.parar();
    const senha = execFileSync(PYTHON, ['-c', 'import app; print(app.gerar_hash("parcial123"))'],
      { cwd: copia }).toString().trim();
    const preparo = `
import sqlite3, sys
con = sqlite3.connect('contatos.db')
con.execute("UPDATE contatos SET vigente_desde=''")
con.execute("INSERT INTO usuarios (usuario, senha_sha256, aprovado, admin, email) VALUES ('parcial', ?, 1, 0, 'parcial@exemplo.jus.br')", (sys.argv[1],))
uid = con.execute("SELECT id FROM usuarios WHERE usuario='parcial'").fetchone()[0]
for nivel, alvo in (('comarca', 'M1'), ('comarca', 'M2')):
    con.execute("INSERT INTO acessos (usuario_id, nivel, alvo_id) VALUES (?,?,?)", (uid, nivel, alvo))
con.commit()
print('vigentes restantes:', con.execute("SELECT COUNT(*) FROM contatos WHERE trim(vigente_desde)<>''").fetchone()[0])
`;
    console.log('\n0) preparo da cópia (sem vigência, usuário de escopo parcial)');
    const saidaPrep = execFileSync(PYTHON, ['-c', preparo, senha], { cwd: copia }).toString().trim();
    conferir(/vigentes restantes: 0/.test(saidaPrep), saidaPrep);
    servidor = await subir(copia);
    navegador = await chromium.launch({ headless: !process.env.PW_HEADED });

    // ---- 1) admin: fila vazia vira estado no botão, não clique morto ----
    console.log('\n1) admin com a fila vazia');
    const tokenAdmin = await entrar(servidor.base, 'admin', 'admin123');
    const a = await abrirAdmin(navegador, servidor.base, tokenAdmin,
      () => !document.getElementById('menu-reg').classList.contains('hidden'));
    const botao = a.pagina.locator('#fc-antigos');
    // A barra aparece antes de a hierarquia chegar e, nesse instante, o botão
    // fica desabilitado por estar carregando. O sinal real de "pronto" é o
    // início renderizado, que só existe depois de H — esperar o `visible` do
    // botão lia o estado transitório e a asserção corria contra a carga.
    await a.pagina.waitForFunction(
      () => document.querySelectorAll('#lista .fc-card').length > 0, null, { timeout: 15000 });
    await botao.waitFor({ state: 'visible', timeout: 15000 });
    ok('o botão Reconfirmar aparece para o admin');
    conferir(await botao.isDisabled(), 'sem nada para reconfirmar, o botão está desabilitado');
    const titulo = (await botao.getAttribute('title')) || '';
    conferir(/Nada para reconfirmar/.test(titulo), 'o title explica o estado: "' + titulo + '"');
    const rotulo = (await botao.getAttribute('aria-label')) || '';
    conferir(/Nada para reconfirmar/.test(rotulo), 'o aria-label repete o motivo (leitor de tela não lê title)');
    const visivel = ((await botao.textContent()) || '').replace(/\s+/g, ' ').trim();
    conferir(/^Nada para reconfirmar$/.test(visivel),
      'o estado também está escrito no botão: "' + visivel + '"');
    conferir(await a.pagina.locator('#fc-antigos-n').evaluate(n => n.classList.contains('hidden')),
      'a contagem não aparece quando não há fila');
    await a.pagina.evaluate(() => document.getElementById('fc-antigos').click());
    await a.pagina.waitForTimeout(400);
    conferir(await a.pagina.locator('#fc-busca-resultados').evaluate(c => c.hasAttribute('hidden')),
      'clicar (por script) não abre caixa vazia');
    conferir(a.erros.length === 0, 'nenhum erro de JS no console');
    if (process.env.CAPTURA) {
      await a.pagina.screenshot({ path: process.env.CAPTURA, fullPage: false });
      console.log('  captura: ' + process.env.CAPTURA);
    }
    await a.ctx.close();

    // ---- 2) escopo parcial: a fila não é dele ----
    console.log('\n2) usuário de escopo parcial (sem admin)');
    const tokenParcial = await entrar(servidor.base, 'parcial', 'parcial123');
    const b = await abrirAdmin(navegador, servidor.base, tokenParcial,
      () => /parcial/.test((document.getElementById('who-line') || {}).textContent || ''));
    ok('a sessão parcial entra no /admin (é usuário interno, mas não admin)');
    conferir(await b.pagina.locator('#fc-antigos').evaluate(x => x.classList.contains('hidden')),
      'o botão Reconfirmar fica oculto para quem não vê todos os locais');
    conferir(b.erros.length === 0, 'nenhum erro de JS no console');

    // O servidor continua aceitando conferir no escopo dele: é a primitiva que o
    // v3 vai usar numa fila filtrada. A UI é que não oferece a fila da base.
    const hier = await (await fetch(servidor.base + '/api/hierarquia')).json();
    const doEscopo = [];
    const foraDoEscopo = [];
    const coletar = (lista, comarcaId) => {
      for (const c of lista || []) {
        (comarcaId === 'M1' || comarcaId === 'M2' ? doEscopo : foraDoEscopo).push(c.id);
      }
    };
    for (const m of hier.comarcas) {
      coletar(m.contatos, m.id);
      for (const f of m.foruns || []) {
        coletar(f.contatos, m.id);
        (function andar(nos) {
          for (const n of nos || []) { coletar(n.contatos, m.id); andar(n.filhos); }
        })(f.nos);
      }
      (function andar(nos) {
        for (const n of nos || []) { coletar(n.contatos, m.id); andar(n.filhos); }
      })(m.nos);
    }
    const r1 = await fetch(servidor.base + '/api/contatos/' + doEscopo[0] + '/conferir', {
      method: 'POST', headers: { 'X-Admin-Token': tokenParcial, 'Content-Type': 'application/json' }, body: '{}'
    });
    conferir(r1.ok, 'conferir dentro do escopo do parcial responde ' + r1.status);
    if (foraDoEscopo.length) {
      const r2 = await fetch(servidor.base + '/api/contatos/' + foraDoEscopo[0] + '/conferir', {
        method: 'POST', headers: { 'X-Admin-Token': tokenParcial, 'Content-Type': 'application/json' }, body: '{}'
      });
      conferir(r2.status === 403,
        'conferir fora do escopo devolve 403 (' + r2.status + ') — é por isso que a fila da base não é dele');
    }
    await b.ctx.close();
  } finally {
    if (navegador) await navegador.close().catch(() => {});
    await servidor.parar().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log('');
  if (falhas.length) {
    console.log('FUMAÇA DA FILA FALHOU (' + falhas.length + ')');
    falhas.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('FUMAÇA DA FILA OK');
}

main().catch(e => { console.error(e); process.exit(2); });
