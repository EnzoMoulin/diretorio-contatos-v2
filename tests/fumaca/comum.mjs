/**
 * Peças comuns aos testes de fumaça: copiar o app, subir numa porta livre,
 * esperar responder e entrar pelo login local.
 *
 * Existe porque o segundo teste de navegador precisava das mesmas cinco
 * funções do `smoke.mjs`. Duas cópias divergem (uma ganha o `INTRANET_ONLY`
 * certo e a outra não) e o defeito aparece como falha de ambiente, não de
 * código. `smoke.mjs` e `smoke-fila.mjs` seguem com as suas cópias: mexer neles
 * agora seria trocar risco de divergência por risco de regressão na entrega.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AQUI = dirname(fileURLToPath(import.meta.url));
export const RAIZ = resolve(AQUI, '..', '..');
export const PYTHON = process.env.PYTHON || 'python3';

export function porta_livre() {
  return new Promise((aceitar, rejeitar) => {
    const srv = createServer();
    srv.once('error', rejeitar);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => aceitar(port));
    });
  });
}

export async function esperar(url, limiteMs = 40000) {
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
export function copiarApp() {
  const destino = mkdtempSync(join(tmpdir(), 'dc2-a11y-'));
  for (const nome of ['app.py', 'seed_mascarado.json']) {
    cpSync(join(RAIZ, nome), join(destino, nome));
  }
  cpSync(join(RAIZ, 'frontend'), join(destino, 'frontend'), { recursive: true });
  return destino;
}

export async function subirServidor(pasta, auto = true, aoFalhar = () => {}) {
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
  proc.on('exit', codigo => { if (codigo) aoFalhar('servidor saiu com código ' + codigo); });
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

export async function entrar(base, usuario, senha) {
  const r = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, senha })
  });
  if (!r.ok) throw new Error('login de ' + usuario + ' falhou: HTTP ' + r.status);
  return (await r.json()).token;
}
