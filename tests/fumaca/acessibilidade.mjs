#!/usr/bin/env node
/**
 * Acessibilidade medida num navegador real: rótulo, foco e contraste.
 *
 * A fumaça já media o alvo de toque (44 px na barra em 390 px), e só isso. Os
 * três defeitos que mais aparecem num app assim — botão só de ícone sem nome,
 * anel de foco que o CSS apaga, texto claro demais sobre fundo claro — passavam
 * porque ninguém olhava: são invisíveis no teste de API e no olho de quem
 * desenhou a tela no monitor bom.
 *
 * O que este arquivo mede, nas duas páginas (`/` e `/admin`) e nos dois temas:
 *
 *   1. nome acessível de todo controle visível (aria-label, texto, title,
 *      placeholder ou label) — o leitor de tela anuncia "botão" e nada mais
 *      quando não há nenhum;
 *   2. anel de foco com o **teclado**: Tab de verdade, comparando o estilo do
 *      elemento focado com o mesmo elemento sem foco (outline, box-shadow,
 *      borda ou fundo têm de mudar). `:focus-visible` só vale para teclado, e
 *      `el.focus()` por script mede outra coisa;
 *   3. contraste WCAG 2.1 AA do texto visível: 4,5:1 (normal) e 3:1 (grande,
 *      ≥24 px ou ≥18,7 px em negrito), fundo efetivo resolvido subindo a árvore
 *      até a primeira cor opaca.
 *
 * Roda numa cópia do app em diretório temporário, como o `smoke.mjs`.
 *
 * Uso:  cd tests/fumaca && node acessibilidade.mjs
 *       PW_HEADED=1 para ver a janela; PW_KEEP=1 guarda a cópia e as capturas.
 */
import { chromium } from 'playwright';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  RAIZ, copiarApp, entrar, esperar, subirServidor
} from './comum.mjs';

const falhas = [];
function ok(mensagem) { console.log('  ok   ' + mensagem); }
function falha(mensagem) { falhas.push(mensagem); console.log('  FALHA ' + mensagem); }
function conferir(condicao, mensagem) { condicao ? ok(mensagem) : falha(mensagem); }

/** Medidores injetados na página uma vez; devolvem fatos, não veredito. */
const MEDIDORES = () => {
  const visivel = el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'
      && cs.display !== 'none' && !!el.offsetParent;
  };
  const rotulo = el => {
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria) return aria;
    const por = (el.getAttribute('aria-labelledby') || '').trim();
    if (por) {
      const texto = por.split(/\s+/)
        .map(id => { const n = document.getElementById(id); return n ? n.textContent : ''; })
        .join(' ').replace(/\s+/g, ' ').trim();
      if (texto) return texto;
    }
    const proprio = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (proprio) return proprio;
    const titulo = (el.getAttribute('title') || '').trim();
    if (titulo) return titulo;
    const etiqueta = el.id ? document.querySelector('label[for="' + el.id + '"]') : null;
    if (etiqueta && (etiqueta.textContent || '').trim()) return etiqueta.textContent.trim();
    const dica = (el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || '').trim();
    if (dica) return dica;
    const alt = el.querySelector('img[alt]');
    return alt ? (alt.getAttribute('alt') || '').trim() : '';
  };
  const descrever = el => {
    const classe = typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    const texto = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + classe
      + (texto ? ' "' + texto + '"' : '');
  };
  // Controles: o que o teclado alcança e o leitor de tela anuncia. O mapa é
  // biblioteca (Leaflet) e traz os próprios rótulos; os caminhos SVG das
  // comarcas não são "botão nosso", então ficam fora da conta.
  const controle = el => !el.closest('.leaflet-container');

  return {
    rotulosSemNome() {
      const maus = [];
      let total = 0;
      for (const el of document.querySelectorAll(
        'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [tabindex="0"]')) {
        if (!visivel(el) || !controle(el)) continue;
        if (el.disabled) continue;
        total += 1;
        if (!rotulo(el)) maus.push(descrever(el));
      }
      return { total, maus };
    },

    /**
     * Referências de estilo sem foco, tiradas antes de qualquer Tab:
     * uma por elemento e uma por "família" (tag + classe), porque a lista do
     * admin se redesenha sozinha e os botões novos não estariam no mapa.
     */
    instantaneos() {
      // Referência de repouso: aqui vale também o que é `position:fixed`
      // (o link de pular), que não tem `offsetParent` e ficaria sem comparação.
      const aparente = el => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      const estiloDe = el => {
        const cs = getComputedStyle(el);
        // `transform`/`top` entram na conta: o link de pular não muda de cor,
        // ele desliza para dentro da tela (`translateY(0)`) — esconder isso
        // faria o teste reprovar o único indicador que ele tem.
        return [cs.outlineWidth, cs.outlineStyle, cs.outlineColor, cs.boxShadow,
                cs.borderTopColor, cs.backgroundColor, cs.color,
                cs.transform, cs.top].join('|');
      };
      const familia = el => el.tagName + '|' + (typeof el.className === 'string' ? el.className : '');
      const mapa = new WeakMap();
      const contagem = new Map();
      let quantos = 0;
      for (const el of document.querySelectorAll(
        'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [tabindex="0"]')) {
        if (!aparente(el) || !controle(el) || el.disabled) continue;
        const estilo = estiloDe(el);
        quantos += 1;
        mapa.set(el, estilo);
        const f = familia(el);
        const atual = contagem.get(f) || new Map();
        atual.set(estilo, (atual.get(estilo) || 0) + 1);
        contagem.set(f, atual);
      }
      // A moda da família é o estilo "de repouso" — o que vale para o botão
      // recém-criado que ainda não estava aqui quando a foto foi tirada.
      const familiaEstilo = new Map();
      for (const [f, estilos] of contagem) {
        let melhor = null, quantos = -1;
        for (const [estilo, n] of estilos) if (n > quantos) { melhor = estilo; quantos = n; }
        familiaEstilo.set(f, melhor);
      }
      window.__a11yBase = { mapa, familia, familiaEstilo, contador: { n: 0 } };
      return quantos;
    },

    /** O elemento focado agora, e se ele ganhou algum sinal visível. */
    focoAtual() {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) {
        return { vazio: true };
      }
      if (el.closest('.leaflet-container')) return { ignorado: true };
      const cs = getComputedStyle(el);
      const estilo = [cs.outlineWidth, cs.outlineStyle, cs.outlineColor, cs.boxShadow,
                      cs.borderTopColor, cs.backgroundColor, cs.color,
                      cs.transform, cs.top].join('|');
      const ref = window.__a11yBase;
      if (!ref) return { vazio: true };
      if (!ref.ids) ref.ids = new WeakMap();
      // Identidade é o elemento, não o texto: as 70 linhas da lista têm o mesmo
      // rótulo ("Ir para gestão") e a caminhada acharia que ciclou na segunda
      // parada. Elemento redesenhado ganha id novo, que é o correto.
      if (!ref.ids.has(el)) ref.ids.set(el, 'e' + (ref.contador.n += 1));
      const referencia = ref.mapa.has(el)
        ? ref.mapa.get(el)
        : (ref.familiaEstilo.get(ref.familia(el)) || null);
      return {
        chave: ref.ids.get(el),
        descricao: descrever(el),
        visivel: el.matches(':focus-visible'),
        mudou: referencia ? referencia !== estilo : null,
        estilo
      };
    },

    /** Contraste WCAG de todo trecho de texto visível na página. */
    contrastes() {
      const numeros = c => { const m = (c || '').match(/[\d.]+/g); return m ? m.map(Number) : null; };
      const luminancia = ([r, g, b]) => {
        const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const razao = (a, b) => {
        const l1 = luminancia(a), l2 = luminancia(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      // Fundo efetivo: empilha as camadas até a raiz e compõe de fora para
      // dentro. A primeira versão exigia uma camada opaca e ignorava as
      // semitransparentes (a legenda do mapa é .94, a atribuição do Leaflet é
      // .8) — o cálculo então comparava texto claro com o branco que estava
      // embaixo e reprovava o que estava certo. Fundo com gradiente continua
      // caindo na cor do ancestral, que é o que o CSS declara.
      const fundo = el => {
        const camadas = [];
        for (let n = el; n; n = n.parentElement) {
          const c = numeros(getComputedStyle(n).backgroundColor);
          if (c) camadas.push(c.length === 4 ? c : [...c, 1]);
        }
        let base = [255, 255, 255];
        for (const c of camadas.reverse()) {
          const a = c[3];
          base = [0, 1, 2].map(i => Math.round(c[i] * a + base[i] * (1 - a)));
        }
        return base;
      };
      const itens = [];
      for (const el of document.querySelectorAll('body *')) {
        if (!visivel(el) || el.closest('svg')) continue;
        const texto = [...el.childNodes].filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim()).join(' ').trim();
        if (texto.length < 2) continue;
        if (el.closest('[disabled]')) continue;
        const cs = getComputedStyle(el);
        const cor = numeros(cs.color);
        if (!cor) continue;
        const px = parseFloat(cs.fontSize);
        const peso = parseInt(cs.fontWeight, 10) || 400;
        const grande = px >= 24 || (peso >= 700 && px >= 18.66);
        itens.push({
          alvo: descrever(el).slice(0, 70),
          texto: texto.slice(0, 30),
          px,
          razao: Math.round(razao(cor.slice(0, 3), fundo(el)) * 100) / 100,
          minimo: grande ? 3 : 4.5
        });
      }
      return itens;
    }
  };
};

async function medirPagina(pagina, nome) {
  // Os medidores viram um objeto na página: a mesma leitura serve para os dois
  // temas e para a caminhada de Tab, sem reenviar a função a cada passo.
  await pagina.evaluate(fonte => { window.__a11y = (0, eval)('(' + fonte + ')')(); },
    MEDIDORES.toString());
  const medir = (metodo, ...args) => pagina.evaluate(
    ([m, a]) => window.__a11y[m](...a), [metodo, args]);

  console.log('\n' + nome + ' · rótulos');
  const rotulos = await medir('rotulosSemNome');
  conferir(rotulos.maus.length === 0,
    rotulos.total + ' controles visíveis com nome acessível'
    + (rotulos.maus.length ? ' — sem nome: ' + rotulos.maus.slice(0, 5).join(' | ') : ''));

  console.log(nome + ' · contraste');
  for (const tema of ['claro', 'escuro']) {
    await pagina.evaluate(t => {
      if (t === 'escuro') document.body.setAttribute('data-theme', 'dark');
      else document.body.removeAttribute('data-theme');
    }, tema);
    await pagina.waitForTimeout(250);
    const itens = await medir('contrastes');
    const piores = itens.filter(i => i.razao < i.minimo)
      .sort((a, b) => a.razao - b.razao).slice(0, 4)
      .map(i => i.texto + ' (' + i.razao + ':1, mínimo ' + i.minimo + ')');
    const menor = itens.reduce((m, i) => Math.min(m, i.razao), 99);
    conferir(piores.length === 0,
      'tema ' + tema + ': ' + itens.length + ' trechos de texto, menor razão '
      + menor + ':1' + (piores.length ? ' — reprovam: ' + piores.join(' | ') : ''));
  }
  await pagina.evaluate(() => document.body.removeAttribute('data-theme'));

  console.log(nome + ' · foco pelo teclado');
  const quantos = await medir('instantaneos');
  // O Leaflet põe `tabindex=0` em cada caminho de comarca interativo: são 69
  // paradas antes da barra de busca. Isso é biblioteca, não tela nossa, e
  // afogaria a caminhada — o mapa sai da ordem do Tab durante a medição (e
  // volta depois). O efeito real para quem navega por teclado está anotado
  // como achado: esconder no teste não conserta a página.
  const semMapa = await pagina.addStyleTag({
    content: '.leaflet-container{visibility:hidden!important}'
  });

  const caminhada = async () => {
    await medir('instantaneos');              // referência: estilo sem foco
    await pagina.evaluate(() => document.body.focus());
    const vistos = new Set();
    const semSinal = [];
    let paradas = 0;
    let semReferencia = 0;
    const chaves = new Set();
    for (let i = 0; i < 110; i += 1) {
      await pagina.keyboard.press('Tab');
      await pagina.waitForTimeout(170);       // a transição do anel leva 150 ms
      const atual = await medir('focoAtual');
      if (atual.vazio || atual.ignorado) continue;
      if (chaves.has(atual.chave)) break;     // ciclou: a ordem acabou
      chaves.add(atual.chave);
      paradas += 1;
      vistos.add(atual.descricao);
      if (atual.mudou === false) semSinal.push(atual.descricao);
      if (atual.mudou === null) semReferencia += 1;
    }
    return { paradas, vistos: [...vistos], semSinal, semReferencia };
  };

  // A barra lateral é gaveta abaixo de 900 px (`visibility:hidden` até o
  // hambúrguer): fechada, os itens de menu não são alcançáveis e a caminhada
  // nunca os mediria. Por isso, quando o hambúrguer existe na tela, são duas
  // passadas — gaveta aberta e fechada.
  let paradas = 0;
  let semReferencia = 0;
  const visitados = new Set();
  const semSinal = [];
  const gaveta = await pagina.$('.hamburger');
  if (gaveta && await gaveta.isVisible()) {
    await gaveta.click();
    await pagina.waitForTimeout(350);
    const aberta = await caminhada();
    paradas += aberta.paradas;
    semReferencia += aberta.semReferencia;
    for (const d of aberta.vistos) visitados.add(d);
    semSinal.push(...aberta.semSinal);
    await pagina.keyboard.press('Escape');
    await pagina.waitForTimeout(350);
  }
  const fechada = await caminhada();
  paradas += fechada.paradas;
  semReferencia += fechada.semReferencia;
  for (const d of fechada.vistos) visitados.add(d);
  for (const d of fechada.semSinal) if (!semSinal.includes(d)) semSinal.push(d);
  await semMapa.evaluate(el => el.remove());

  if (process.env.PW_VERBOSE === '1') console.log('       ' + [...visitados].join(' → '));
  conferir(paradas > 0 && semSinal.length === 0,
    paradas + ' paradas de Tab medidas (' + visitados.size + ' controles distintos, de '
    + quantos + ' visíveis), todas com sinal de foco visível'
    + (semReferencia ? '; ' + semReferencia + ' sem comparação (fora do fluxo)' : '')
    + (semSinal.length ? ' — sem sinal: ' + semSinal.slice(0, 5).join(' | ') : ''));


  return { rotulos, visitados };
}

async function main() {
  const pasta = copiarApp();
  let servidor;
  let navegador;
  try {
    servidor = await subirServidor(pasta, true, falha);
    const base = servidor.base;
    console.log('servidor: ' + base + ' (cópia em ' + pasta + ')');
    if (!await esperar(base + '/api/comarcas')) {
      console.error('servidor não respondeu em 40 s\n' + servidor.log().slice(-2000));
      process.exit(2);
    }
    const token = await entrar(base, 'admin', 'admin123');
    navegador = await chromium.launch({ headless: !process.env.PW_HEADED });

    const contexto = await navegador.newContext({ viewport: { width: 1360, height: 900 } });
    await contexto.addInitScript(t => localStorage.setItem('contatos-token', t), token);
    const pagina = await contexto.newPage();

    console.log('\n1) página pública');
    await pagina.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await pagina.waitForSelector('.fc-card', { timeout: 30000 });
    await pagina.waitForTimeout(1200);   // mapa e legenda entram depois da árvore

    // A primeira parada do Tab tem de ser o link de pular: quem navega por
    // teclado não pode atravessar o menu inteiro a cada página.
    await pagina.evaluate(() => document.body.focus());
    await pagina.keyboard.press('Tab');
    const primeira = await pagina.evaluate(() => {
      const el = document.activeElement;
      return el ? (el.className || el.tagName).toString() : '';
    });
    conferir(/skip-link/.test(primeira),
      'a primeira parada do Tab é o link "Ir para o conteúdo" (achou "' + primeira + '")');

    await medirPagina(pagina, 'público');

    console.log('\n2) painel do admin');
    await pagina.goto(base + '/admin', { waitUntil: 'domcontentloaded' });
    await pagina.waitForSelector('#lista .fc-card', { timeout: 30000 });
    await pagina.waitForTimeout(800);
    await medirPagina(pagina, 'admin');

    if (falhas.length && process.env.PW_KEEP === '1') {
      await pagina.screenshot({ path: join(pasta, 'acessibilidade.png'), fullPage: true });
      console.log('captura: ' + join(pasta, 'acessibilidade.png'));
    }
  } catch (e) {
    falha('exceção: ' + (e && e.message ? e.message : String(e)));
  } finally {
    if (navegador) await navegador.close().catch(() => {});
    if (servidor) await servidor.parar().catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    if (falhas.length === 0 && process.env.PW_KEEP !== '1') {
      rmSync(pasta, { recursive: true, force: true });
    }
  }

  console.log('\n' + (falhas.length === 0 ? 'ACESSIBILIDADE OK' : 'ACESSIBILIDADE FALHOU (' + falhas.length + ')'));
  process.exit(falhas.length === 0 ? 0 : 1);
}

main();
