/* Consulta pública — fluxo idêntico ao original (GAS):
   Início (Órgãos/Comarcas) > Fóruns | Órgão > Fórum > Nó.
   Dados: /api/hierarquia. Sem gestão (isso é papel do /admin). */
(function () {
  "use strict";

  var estado = { dados: { comarcas: [] }, comarcaId: "", forumId: "", noId: "",
    mapa: null, geojson: null, carregando: false, inicializado: false };

  function $(id) { return document.getElementById(id); }
  function host() { return $("lista"); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }

  function fmtTipoContato(tipo) {
    var t = String(tipo || "").trim().toUpperCase();
    if (t === "E_MAIL" || t === "EMAIL" || t === "E-MAIL") return "E-mail";
    if (t === "WHATSAPP") return "WhatsApp";
    if (t === "RAMAL") return "Ramal";
    if (t === "FAX") return "Fax";
    if (t === "TELEFONE") return "Telefone";
    return tipo || "Contato";
  }

  function fmtTipoNo(tipo) {
    var mapa = { UNIDADE: "Unidade", SECRETARIA: "Secretaria", VARA: "Vara",
      JUIZADO: "Juizado", SETOR: "Setor", GABINETE: "Gabinete",
      ASSESSORIA: "Assessoria", SALAAUDIENCIA: "Sala de audiência",
      GENERICO: "Unidade organizacional" };
    return mapa[String(tipo || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase()] ||
      String(tipo || "Unidade organizacional");
  }

  function fmtValor(tipo, valor) {
    var t = String(tipo || "").toUpperCase();
    var s = String(valor || "").trim();
    var n = s.replace(/\D/g, "");
    if (!s) return "";
    if ((t.indexOf("TELEFONE") >= 0 || t.indexOf("WHATSAPP") >= 0 || t === "CELULAR") && n.indexOf("27") === 0) {
      if (n.length === 10) return "(" + n.slice(0, 2) + ") " + n.slice(2, 6) + "-" + n.slice(6);
      if (n.length === 11) return "(" + n.slice(0, 2) + ") " + n.slice(2, 7) + "-" + n.slice(7);
    }
    return s;
  }

  function hrefContato(tipo, valor) {
    var t = String(tipo || "").toUpperCase();
    var s = String(valor || "").trim();
    var n = s.replace(/\D/g, "");
    if (!s) return "";
    if (t === "WHATSAPP" && n) return "https://wa.me/" + (n.indexOf("55") === 0 ? n : "55" + n);
    if ((t === "TELEFONE" || t === "CELULAR") && n) return "tel:+55" + (n.indexOf("55") === 0 ? n.slice(2) : n);
    if (t === "E-MAIL" || t === "EMAIL" || t === "E_MAIL") return "mailto:" + encodeURIComponent(s);
    return "";
  }

  function linkEndereco(endereco) {
    var texto = String(endereco || "").trim();
    if (!texto) return '<span class="fc-muted">Endereço não informado</span>';
    return '<span class="fc-address-inline"><a class="fc-endereco" href="https://www.google.com/maps/search/?api=1&query=' +
      encodeURIComponent(texto) + '" target="_blank" rel="noopener noreferrer">📍 ' + esc(texto) + "</a>" +
      '<button type="button" class="fc-icon-btn fc-copy-btn" data-copy-value="' + esc(texto) +
      '" data-copy-label="Endereço" title="Copiar endereço" aria-label="Copiar endereço"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></span>';
  }

  function copiarTexto(texto) {
    var valor = String(texto || "").trim();
    if (!valor) return;
    function flash() {
      var btn = document.activeElement;
      if (!btn || !btn.textContent) return;
      var t = btn.textContent;
      btn.textContent = "✓";
      setTimeout(function () { btn.textContent = t; }, 1200);
    }
    function fallback() {
      try {
        var area = document.createElement("textarea");
        area.value = valor;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
        flash();
      } catch (e) {}
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(valor).then(flash, fallback);
    } else fallback();
  }

  function vincularCopias() {
    var btns = document.querySelectorAll("[data-copy-value]");
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.onclick = function (e) {
          if (e) { e.preventDefault(); e.stopPropagation(); }
          copiarTexto(btn.getAttribute("data-copy-value"));
        };
      })(btns[i]);
    }
  }

  var FAV_KEY = "dc2-favs";
  function piscarBotao(btn) {
    if (!btn) return;
    try {
      btn.style.background = "#dbeafe";
      setTimeout(function () { btn.style.background = ""; }, 900);
    } catch (e) {}
  }
  function lerFavs() { try { return JSON.parse(localStorage.getItem(FAV_KEY)) || {}; } catch (e) { return {}; } }
  function salvarFavs(f) { try { localStorage.setItem(FAV_KEY, JSON.stringify(f)); } catch (e) {} }
  function chaveFav(o) { return o.id ? "id:" + o.id : "u:" + o.tipo + "|" + o.valor; }
  var SVG_ESTRELA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  var SVG_BAIXAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  var SVG_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
  function botaoLink(id, nome) {
    return '<button type="button" class="fc-icon-btn fc-link-btn" data-link-id="' + esc(id) + '" title="Copiar link do contato" aria-label="Copiar link do contato ' + esc(nome) + '">' + SVG_LINK + "</button>";
  }
  function botaoFav(o, nome) {
    var k = chaveFav(o), on = !!lerFavs()[k];
    return '<button type="button" class="fc-icon-btn fc-fav-btn" data-fav-key="' + esc(k) + '" data-fav-nome="' + esc(nome) + '" data-fav-tipo="' + esc(o.tipo) + '" data-fav-valor="' + esc(o.valor) + '" aria-pressed="' + (on ? "true" : "false") + '" title="Favoritar" aria-label="Favoritar ' + esc(nome) + '">' + SVG_ESTRELA + "</button>";
  }
  function botaoVcf(o, nome) {
    return '<button type="button" class="fc-icon-btn fc-vcf-btn" data-vcf-nome="' + esc(nome) + '" data-vcf-tipo="' + esc(o.tipo) + '" data-vcf-valor="' + esc(o.valor) + '" title="Baixar contato (.vcf)" aria-label="Baixar contato ' + esc(nome) + '">' + SVG_BAIXAR + "</button>";
  }
  function botaoFavChave(k, f) {
    var on = !!lerFavs()[k];
    return '<button type="button" class="fc-icon-btn fc-fav-btn" data-fav-key="' + esc(k) + '" data-fav-nome="' + esc(f.nome) + '" data-fav-tipo="' + esc(f.tipo) + '" data-fav-valor="' + esc(f.valor) + '" aria-pressed="' + (on ? "true" : "false") + '" title="Favoritar" aria-label="Favoritar ' + esc(f.nome) + '">' + SVG_ESTRELA + "</button>";
  }
  function linhaFavorito(k, f) {
    var tipo = fmtTipoContato(f.tipo);
    var valor = fmtValor(f.tipo, f.valor);
    var href = hrefContato(f.tipo, f.valor);
    var externo = /^(https?:|mailto:)/.test(href);
    var valorHtml = href
      ? '<a class="fc-contato-valor" href="' + esc(href) + '" ' +
        (externo ? 'target="_blank" rel="noopener noreferrer"' : "") + ">" + esc(valor) + "</a>"
      : '<span class="fc-contato-valor">' + esc(valor) + "</span>";
    return '<article class="fc-contato">' +
      '<div class="fc-contato-main"><span class="fc-contato-tipo">' + esc(tipo) + "</span><h4>" + esc(f.nome || valor) + "</h4></div>" +
      '<div class="fc-contato-side">' + valorHtml +
      '<div class="fc-contato-actions">' +
      '<button type="button" class="fc-icon-btn fc-copy-btn" data-copy-value="' + esc(valor) +
      '" data-copy-label="' + esc(tipo) + '" title="Copiar ' + esc(tipo) + '" aria-label="Copiar ' + esc(tipo) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' +
      botaoFavChave(k, f) +
    (String(k).indexOf('id:') === 0 ? botaoLink(String(k).slice(3), f.nome || valor) : '') +
      '<button type="button" class="fc-icon-btn fc-vcf-btn" data-vcf-nome="' + esc(f.nome || valor) + '" data-vcf-tipo="' + esc(f.tipo) + '" data-vcf-valor="' + esc(f.valor) + '" title="Baixar contato (.vcf)" aria-label="Baixar contato ' + esc(f.nome || valor) + '">' + SVG_BAIXAR + "</button>" +
      "</div></div></article>";
  }
  function renderFavoritos() {
    var c = host();
    if (!c) return;
    marcarMenuV2("favoritos");
    estado.comarcaId = "";
    estado.forumId = "";
    estado.noId = "";
    var favs = lerFavs();
    var chaves = Object.keys(favs).sort(function (a, b) {
      return String(favs[a].nome || "").localeCompare(String(favs[b].nome || ""), "pt-BR");
    });
    c.innerHTML = '<div class="fc-head"><div><h2 class="fc-title">Favoritos</h2>' +
      '<p class="fc-subtitle">Seus contatos marcados com estrela, neste navegador.</p></div></div>' +
      (chaves.length
        ? '<div class="fc-toolbar"><button type="button" class="fc-btn" id="fc-fav-todos" title="Baixar todos em um .vcf">' + SVG_BAIXAR + ' Baixar todos (.vcf)</button>' +
          '<button type="button" class="fc-btn" id="fc-fav-limpar" title="Remover todos os favoritos">Limpar favoritos</button></div>' +
          '<div class="fc-contatos">' + chaves.map(function (k) { return linhaFavorito(k, favs[k]); }).join("") + "</div>"
        : '<div class="fc-empty">Nenhum favorito ainda. Toque na estrela de um contato para guardar aqui.</div>');
      '<div class="fc-print-footer"><button type="button" class="fc-btn" id="fc-print-fav" title="Imprimir / Salvar PDF"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Imprimir / Salvar PDF</button>' +
      '<button type="button" class="fc-btn" data-scroll-top title="Voltar ao topo">↑ Voltar ao topo</button></div>';
    document.getElementById("fc-print-fav").onclick = function () {
      abrirImpressao("Favoritos — PJES", "<ul>" + chaves.map(function (k) { var f = favs[k]; return contatoPrint({ tipo: f.tipo, descricao: f.nome, valor: f.valor }); }).join("") + "</ul>");
    };
    var btnTodos = document.getElementById("fc-fav-todos");
    if (btnTodos) btnTodos.onclick = function () { baixarVcfTodos(); };
    var btnLimpar = document.getElementById("fc-fav-limpar");
    if (btnLimpar) btnLimpar.onclick = function () { limparFavs(this); };
    vincularAcoes();
  }
  function sincronizarFavs() {
    var f = lerFavs();
    document.querySelectorAll("[data-fav-key]").forEach(function (b) {
      b.setAttribute("aria-pressed", f[b.getAttribute("data-fav-key")] ? "true" : "false");
    });
    var n = Object.keys(f).length;
    var badge = document.getElementById("fav-count");
    if (badge) { badge.textContent = n; badge.classList.toggle("hidden", n === 0); }
    var menuFav = document.querySelector('.menu-item[data-view="favoritos"]');
    if (menuFav && menuFav.classList.contains("active")) renderFavoritos();
  }
  function alternarFavorito(d) {
    var f = lerFavs();
    var era = !!f[d.key];
    if (era) delete f[d.key];
    else f[d.key] = { key: d.key, nome: d.nome, tipo: d.tipo, valor: d.valor };
    salvarFavs(f);
    sincronizarFavs();
    if (typeof mostrarToast === "function") mostrarToast(era ? "Removido dos favoritos." : "Adicionado aos favoritos.", "success");
  }
  function baixarVcf(d) {
    var nome = String(d.nome || "contato").replace(/[\r\n]+/g, " ").trim() || "contato";
    var valor = String(d.valor || "").replace(/[\r\n]+/g, " ").trim();
    if (!valor) return;
    var linhas = ["BEGIN:VCARD", "VERSION:3.0", "FN:" + nome];
    if (/e-?mail/i.test(d.tipo || "")) linhas.push("EMAIL:" + valor);
    else linhas.push("TEL;TYPE=WORK,VOICE:" + valor);
    linhas.push("END:VCARD");
    var blob = new Blob([linhas.join("\r\n")], { type: "text/vcard" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = nome.replace(/[/\\:*?"<>|]+/g, "").slice(0, 60) + ".vcf";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    if (typeof mostrarToast === "function") mostrarToast("Contato baixado.", "success");
  }
  function baixarVcfTodos() {
    var f = lerFavs();
    var chaves = Object.keys(f).sort(function (a, b) {
      return String(f[a].nome || "").localeCompare(String(f[b].nome || ""), "pt-BR");
    });
    if (!chaves.length) {
      if (typeof mostrarToast === "function") mostrarToast("Nada para baixar.", "warning");
      return;
    }
    var blocos = chaves.map(function (k) {
      var d = f[k];
      var nome = String(d.nome || "contato").replace(/[\r\n]+/g, " ").trim() || "contato";
      var valor = String(d.valor || "").replace(/[\r\n]+/g, " ").trim();
      var linhas = ["BEGIN:VCARD", "VERSION:3.0", "FN:" + nome];
      if (/e-?mail/i.test(d.tipo || "")) linhas.push("EMAIL:" + valor);
      else linhas.push("TEL;TYPE=WORK,VOICE:" + valor);
      linhas.push("END:VCARD");
      return linhas.join("\r\n");
    });
    var blob = new Blob([blocos.join("\r\n")], { type: "text/vcard" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "favoritos.vcf";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    if (typeof mostrarToast === "function") mostrarToast(chaves.length + " contato(s) baixado(s).", "success");
  }
  function limparFavs(btn) {
    if (!btn.getAttribute("data-armado")) {
      btn.setAttribute("data-armado", "1");
      btn.textContent = "Confirmar limpeza?";
      setTimeout(function () { btn.removeAttribute("data-armado"); btn.textContent = "Limpar favoritos"; }, 4000);
      return;
    }
    salvarFavs({});
    sincronizarFavs();
    if (typeof mostrarToast === "function") mostrarToast("Favoritos removidos.", "success");
  }
  document.addEventListener("click", function (e) {
    var t = e.target;
    var fb = t && t.closest ? t.closest(".fc-fav-btn") : null;
    if (fb) {
      alternarFavorito({
        key: fb.getAttribute("data-fav-key"), nome: fb.getAttribute("data-fav-nome"),
        tipo: fb.getAttribute("data-fav-tipo"), valor: fb.getAttribute("data-fav-valor")
      });
      return;
    }
    var vb = t && t.closest ? t.closest(".fc-vcf-btn") : null;
    if (vb) {
      baixarVcf({
        nome: vb.getAttribute("data-vcf-nome"), tipo: vb.getAttribute("data-vcf-tipo"),
        valor: vb.getAttribute("data-vcf-valor")
      });
      return;
    }
    var lk = t && t.closest ? t.closest(".fc-link-btn") : null;
    if (lk) {
      var linkId = lk.getAttribute("data-link-id");
      if (linkId) {
        var linkUrl = String(window.location.href).split("?")[0] + "?contato=" + encodeURIComponent(linkId);
        if (navigator.share) { navigator.share({ title: "Contato — Diretório PJES", url: linkUrl }).catch(function () {}); piscarBotao(lk); }
        else { copiarTexto(linkUrl); piscarBotao(lk); }
      }
    }
  });

  function todosNos(lista, saida) {
    saida = saida || [];
    (lista || []).forEach(function (no) { saida.push(no); todosNos(no.filhos || [], saida); });
    return saida;
  }

  function qtdSetores(lista) {
    return todosNos(lista || [], []).filter(function (no) {
      return String(no.tipo || "").toUpperCase() === "SETOR";
    }).length;
  }

  function rotuloQuantidade(valor, singular, plural) {
    var total = Number(valor || 0);
    return total > 0 ? total + " " + (total === 1 ? singular : plural) : "";
  }

  function badgeQuantidade(valor, singular, plural) {
    var texto = rotuloQuantidade(valor, singular, plural);
    return texto ? '<span class="fc-pill">' + esc(texto) + "</span>" : "";
  }

  function resumoQuantidades(itens) { return itens.filter(Boolean).join(" • "); }

  /* ---- Busca global (contato, setor, unidade, valor) ---- */
  function normBusca(s) {
    return String(s == null ? "" : s).toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "");
  }
  var indiceBusca = null;
  var linkContatoProcessado = false;
  function abrirLinkContato() {
    if (linkContatoProcessado) return;
    linkContatoProcessado = true;
    var id = null;
    try { id = new URLSearchParams(window.location.search).get("contato"); } catch (e) {}
    if (!id) return;
    if (indiceBusca === null) indiceBusca = construirIndiceBusca();
    for (var i = 0; i < indiceBusca.length; i++) {
      if (String(indiceBusca[i].contato.id) === String(id)) {
        irParaResultado(indiceBusca[i]);
        return;
      }
    }
  }
  function construirIndiceBusca() {
    var indice = [];
    ((estado.dados && estado.dados.comarcas) || []).forEach(function (m) {
      (m.foruns || []).forEach(function (f) {
        (f.contatos || []).forEach(function (c) {
          indice.push({ contato: c, comarcaId: m.id, forumId: f.id, noId: "",
            caminho: m.nome + " › " + f.nome + " › Contatos gerais" });
        });
        (function percorrer(nos, trilha) {
          (nos || []).forEach(function (no) {
            var rota = trilha.concat([no.nome || fmtTipoNo(no.tipo)]);
            (no.contatos || []).forEach(function (c) {
              indice.push({ contato: c, comarcaId: m.id, forumId: f.id, noId: no.id,
                caminho: m.nome + " › " + f.nome + " › " + rota.join(" › ") });
            });
            percorrer(no.filhos || [], rota);
          });
        })((f.nos || []), []);
      });
    });
    return indice;
  }
  function buscarContatos(termo) {
    if (indiceBusca === null) indiceBusca = construirIndiceBusca();
    var t = normBusca(termo);
    if (t.length < 2) return [];
    var saida = [];
    for (var i = 0; i < indiceBusca.length && saida.length < 8; i++) {
      var item = indiceBusca[i], c = item.contato;
      var texto = normBusca([c.descricao, c.tipo, c.valor, c.observacao, item.caminho].join(" "));
      if (texto.indexOf(t) !== -1) saida.push(item);
    }
    return saida;
  }
  function destacarContato(id) {
    try {
      var el = document.querySelector('[data-contato="' + String(id).replace(/"/g, "") + '"]');
      if (!el) return;
      if (el.scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.remove("fc-contato--achado");
      void el.offsetWidth;
      el.classList.add("fc-contato--achado");
    } catch (e) {}
  }
  function expandirGeraisSePreciso() {
    try {
      var toggles = document.querySelectorAll("[data-gerais-toggle]");
      for (var i = 0; i < toggles.length; i++) {
        var body = toggles[i].nextElementSibling;
        if (body && body.hasAttribute("hidden")) toggles[i].click();
      }
    } catch (e) {}
  }
  function irParaResultado(item) {
    if (!item) return;
    estado.comarcaId = String(item.comarcaId);
    estado.forumId = "";
    estado.noId = "";
    marcarMenuV2("consulta");
    var m = comarcaAtual();
    if (!m) return;
    if (estado.mapa && estado.geojson && m.codigoIbge) destacarMapa(m.codigoIbge);
    if (ehOrgao(m)) { renderOrgao(); }
    else if (item.forumId) {
      estado.forumId = String(item.forumId);
      if (item.noId) abrirNo(item.noId);
      else { renderForum(); expandirGeraisSePreciso(); }
    } else renderForuns();
    destacarContato(item.contato.id);
  }
  function realcarBusca(termo, texto){
    var base = esc(texto), b = esc(String(termo || "").trim());
    if(!b) return base;
    var lower = base.toLowerCase(), alvo = b.toLowerCase(), out = "", i = 0, j;
    while((j = lower.indexOf(alvo, i)) !== -1){
      out += base.slice(i, j) + "<mark>" + base.slice(j, j + b.length) + "</mark>";
      i = j + b.length;
    }
    return out + base.slice(i);
  }
  function vincularBuscaGlobal() {
    var campo = $("fc-busca"), caixa = $("fc-busca-resultados");
    if (!campo || !caixa || campo.getAttribute("data-busca-ok")) return;
    campo.setAttribute("data-busca-ok", "1");
    function fechar() { caixa.setAttribute("hidden", ""); caixa.innerHTML = ""; campo.setAttribute("aria-expanded", "false"); campo.removeAttribute("aria-activedescendant"); }
    var indiceAtivo = -1;
    function pintarAtivo() {
      Array.prototype.forEach.call(caixa.querySelectorAll("[data-busca-i]"), function (btn, i) {
        if (i === indiceAtivo) { btn.classList.add("ativo"); btn.setAttribute("aria-selected", "true"); btn.scrollIntoView({ block: "nearest" }); campo.setAttribute("aria-activedescendant", btn.id); }
        else { btn.classList.remove("ativo"); btn.setAttribute("aria-selected", "false"); }
      });
    }
    campo.addEventListener("input", function () {
      indiceAtivo = -1;
      var resultados = buscarContatos(campo.value);
      if (!resultados.length) { fechar(); return; }
      caixa.innerHTML = resultados.map(function (item, i) {
        var c = item.contato;
        return '<button type="button" class="fc-busca-item" data-busca-i="' + i + '" role="option" id="fc-busca-opcao-' + i + '" aria-selected="false">' +
          "<strong>" + realcarBusca(campo.value, c.descricao || fmtTipoContato(c.tipo)) + "</strong>" +
          "<small>" + realcarBusca(campo.value, fmtTipoContato(c.tipo) + (c.valor ? " · " + c.valor : "")) + "</small>" +
          "<small>" + realcarBusca(campo.value, item.caminho) + "</small></button>";
      }).join("");
      caixa.removeAttribute("hidden");
      campo.setAttribute("aria-expanded", "true");
      var botoes = caixa.querySelectorAll("[data-busca-i]");
      for (var i = 0; i < botoes.length; i++) {
        (function (btn, item, idx) {
          btn.onclick = function () { fechar(); campo.value = ""; irParaResultado(item); };
          btn.onmouseenter = function () { indiceAtivo = idx; pintarAtivo(); };
        })(botoes[i], resultados[+botoes[i].getAttribute("data-busca-i")], i);
      }
    });
    campo.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { fechar(); campo.blur(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        var r = buscarContatos(campo.value);
        if (!r.length) return;
        e.preventDefault();
        indiceAtivo = e.key === "ArrowDown" ? (indiceAtivo + 1) % r.length : (indiceAtivo - 1 + r.length) % r.length;
        pintarAtivo();
      }
      else if (e.key === "Enter") {
        var r = buscarContatos(campo.value);
        if (r.length) { var alvo = indiceAtivo >= 0 ? r[indiceAtivo] : r[0]; fechar(); campo.value = ""; irParaResultado(alvo); }
      }
    });
    document.addEventListener("click", function (e) {
      if (e.target !== campo && !caixa.contains(e.target)) fechar();
    });
  }

  function encontrarComarca(id) {
    return (estado.dados.comarcas || []).filter(function (m) { return String(m.id) === String(id); })[0] || null;
  }

  function ehOrgao(comarca) {
    return String(comarca && comarca.tipo || "").toUpperCase() === "ORGAO";
  }

  function encontrarForum(id) {
    var achado = null;
    (estado.dados.comarcas || []).some(function (m) {
      var f = (m.foruns || []).filter(function (item) { return String(item.id) === String(id); })[0];
      if (f) { achado = f; return true; }
      return false;
    });
    return achado;
  }

  function encontrarNo(lista, id) {
    for (var i = 0; i < (lista || []).length; i++) {
      if (String(lista[i].id) === String(id)) return lista[i];
      var filho = encontrarNo(lista[i].filhos || [], id);
      if (filho) return filho;
    }
    return null;
  }

  function comarcaAtual() { return encontrarComarca(estado.comarcaId); }
  function forumAtual() { return encontrarForum(estado.forumId); }
  function raizAtual() {
    var m = comarcaAtual();
    return ehOrgao(m) ? m : forumAtual();
  }
  function noAtual() {
    var raiz = raizAtual();
    return raiz ? encontrarNo(raiz.nos || [], estado.noId) : null;
  }

  function caminhoAteNo(lista, id, caminho) {
    caminho = caminho || [];
    for (var i = 0; i < (lista || []).length; i++) {
      var atual = caminho.concat(lista[i]);
      if (String(lista[i].id) === String(id)) return atual;
      var encontrado = caminhoAteNo(lista[i].filhos || [], id, atual);
      if (encontrado) return encontrado;
    }
    return null;
  }

  function breadcrumbHtml(comarca, forum, no) {
    var itens = [{ tipo: "COMARCA", id: comarca.id, nome: comarca.nome }];
    if (forum) itens.push({ tipo: "FORUM", id: forum.id, nome: forum.nome });
    if (no) {
      (caminhoAteNo((forum || comarca).nos || [], no.id, []) || []).forEach(function (item) {
        itens.push({ tipo: "NO", id: item.id, nome: item.nome });
      });
    }
    return '<nav class="***" aria-label="Caminho da estrutura">' + itens.map(function (item, indice) {
      var ultimo = indice === itens.length - 1;
      var conteudo = ultimo
        ? '<span class="fc-breadcrumb-current" aria-current="page">' + esc(item.nome) + "</span>"
        : '<button type="button" data-breadcrumb-type="' + esc(item.tipo) + '" data-breadcrumb-id="' +
          esc(item.id) + '">' + esc(item.nome) + "</button>";
      return conteudo + (ultimo ? "" : '<span class="fc-breadcrumb-separator" aria-hidden="true">›</span>');
    }).join("") + "</nav>";
  }

  function vincularBreadcrumbs() {
    var btns = document.querySelectorAll("[data-breadcrumb-type]");
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        btn.onclick = function () {
          var tipo = btn.getAttribute("data-breadcrumb-type");
          var id = btn.getAttribute("data-breadcrumb-id");
          if (tipo === "COMARCA") {
            estado.comarcaId = id;
            estado.forumId = "";
            estado.noId = "";
            if (ehOrgao(comarcaAtual())) renderOrgao();
            else renderForuns();
          } else if (tipo === "FORUM") {
            estado.forumId = id;
            estado.noId = "";
            renderForum();
          } else if (tipo === "NO") abrirNo(id);
        };
      })(btns[i]);
    }
  }

  function opcoesComarcas(comarcas, selecionado) {
    return '<option value="">Selecione a Comarca</option>' + (comarcas || []).filter(function (m) { return !ehOrgao(m); }).map(function (m) {
      var n = m.qtdContatos || 0;
      return '<option value="' + esc(m.id) + '"' + (String(m.id) === String(selecionado) ? " selected" : "") + ">" + esc(m.nome) + " (" + n + (n === 1 ? " contato)" : " contatos)") + "</option>";
    }).join("");
  }

  function botaoImpressaoLocalidade(tipo, tipoNo) {
    var rotulo = tipo === "COMARCA" ? "TJES" : (tipo === "FORUM" ? "Fórum" : (tipoNo === "Setor" ? "Setor" : "Unidade"));
    var artigo = rotulo === "Unidade" ? "da" : "do";
    var id = tipo === "FORUM" ? "fc-print-forum" : (tipo === "COMARCA" ? "fc-print-comarca" : "fc-print-unit");
    return '<div class="fc-print-footer">' +
      '<button type="button" class="fc-btn" id="' + id + '" title="Imprimir / Salvar PDF dos contatos ' +
      artigo + " " + rotulo + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Imprimir / Salvar PDF</button></div>';
  }

  function contatosCards(contatos) {
    if (!contatos || !contatos.length) return '<div class="fc-empty">Nenhum contato cadastrado.</div>';
    return '<div class="fc-contatos">' + contatos.map(function (c) {
      var tipo = fmtTipoContato(c.tipo);
      var valor = fmtValor(c.tipo, c.valor);
      var href = hrefContato(c.tipo, c.valor);
      var externo = /^(https?:|mailto:)/.test(href);
      var valorHtml = href
        ? '<a class="fc-contato-valor" href="' + esc(href) + '" ' +
          (externo ? 'target="_blank" rel="noopener noreferrer"' : "") + ">" + esc(valor) + "</a>"
        : '<span class="fc-contato-valor">' + esc(valor) + "</span>";
      var acoes = '<div class="fc-contato-actions">' +
        '<button type="button" class="fc-icon-btn fc-copy-btn" data-copy-value="' + esc(valor) +
        '" data-copy-label="' + esc(tipo) + '" title="Copiar ' + esc(tipo) + '" aria-label="Copiar ' + esc(tipo) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' +
        botaoFav({ id: c.id, tipo: c.tipo, valor: c.valor }, String(c.descricao || "").trim() || tipo) +
        botaoVcf({ tipo: c.tipo, valor: c.valor }, String(c.descricao || "").trim() || tipo) +
        botaoLink(c.id, String(c.descricao || "").trim() || tipo) + '</div>';
      var descricao = String(c.descricao || "").trim();
      var descricaoHtml = descricao && descricao.toLocaleLowerCase("pt-BR") !== String(tipo).toLocaleLowerCase("pt-BR")
        ? "<h4>" + esc(descricao) + "</h4>" : "";
      var observacao = String(c.observacao || "").trim();
      var observacaoHtml = observacao
        ? '<p class="fc-contato-observacao' + (/contato provis[oó]rio/i.test(observacao) ? " fc-contato-observacao--provisoria" : "") + '">' + esc(observacao) + "</p>"
        : "";
      return '<article class="fc-contato" data-contato="' + esc(c.id) + '">' +
        '<div class="fc-contato-main"><span class="fc-contato-tipo">' + esc(tipo) + "</span>" + descricaoHtml + observacaoHtml + "</div>" +
        '<div class="fc-contato-side">' + valorHtml + acoes + "</div></article>";
    }).join("") + "</div>";
  }

  function cardContatosGerais(contatos, comPrint) {
    var lista = contatos || [];
    return '<div class="fc-section"><div class="fc-card fc-card--toggle" data-gerais-toggle title="Expandir/recolher contatos gerais">' +
      '<div class="fc-card-head"><div><h4>Contatos Gerais</h4></div>' +
      '<div class="fc-meta">' + badgeQuantidade(lista.length, "Contato", "Contatos") +
      (comPrint ? '<button type="button" class="fc-icon-btn" data-gerais-print title="Imprimir / Salvar PDF dos Contatos Gerais"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg></button>' : "") +
      '<span class="fc-toggle" aria-hidden="true">\u25be</span></div></div></div>' +
      '<div data-gerais-body hidden>' + (lista.length ? contatosCards(lista) : '<div class="fc-empty">Sem contatos gerais.</div>') + "</div></div>";
  }

  function exportarCsvVisivel() {
    var host = document.getElementById("lista") || document;
    var linhas = [["Nome", "Tipo", "Valor"]];
    host.querySelectorAll(".fc-contato").forEach(function (a) {
      var t = a.querySelector(".fc-contato-tipo");
      var n = a.querySelector("h4");
      var v = a.querySelector(".fc-contato-valor");
      linhas.push([(n ? n.textContent : "").trim(), (t ? t.textContent : "").trim(), (v ? v.textContent : "").trim()]);
    });
    if (linhas.length < 2) {
      if (typeof mostrarToast === "function") mostrarToast("Nada para exportar.", "warning");
      return;
    }
    var csv = "﻿" + linhas.map(function (r) {
      return r.map(function (x) { return '"' + String(x).replace(/"/g, '""') + '"'; }).join(";");
    }).join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "contatos.csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    if (typeof mostrarToast === "function") mostrarToast("CSV exportado.", "success");
  }
  function vincularAcoes() {
    vincularCopias();
    document.querySelectorAll(".fc-print-footer").forEach(function (ft) {
      if (ft.querySelector("[data-csv]")) return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "fc-btn";
      b.setAttribute("data-csv", "");
      b.title = "Exportar contatos visíveis (CSV)";
      b.setAttribute("aria-label", "Exportar contatos visíveis em CSV");
      b.innerHTML = SVG_BAIXAR + " Exportar CSV";
      b.onclick = function () { exportarCsvVisivel(); };
      ft.appendChild(b);
    });
    var cards = document.querySelectorAll("[data-gerais-toggle]");
    for (var g = 0; g < cards.length; g++) {
      cards[g].onclick = (function (card) {
        return function (e) {
          if (e && e.target && e.target.closest && e.target.closest("[data-gerais-print]")) return;
          var body = card.nextElementSibling;
          if (!body) return;
          var abrir = body.hasAttribute("hidden");
          if (abrir) body.removeAttribute("hidden");
          else body.setAttribute("hidden", "");
          card.classList.toggle("aberto", abrir);
        };
      })(cards[g]);
    }
    var tops = document.querySelectorAll("[data-scroll-top]");
    for (var i = 0; i < tops.length; i++) {
      tops[i].onclick = (function (btn) {
        return function () {
          var el = btn.parentElement;
          while (el) {
            try {
              var st = window.getComputedStyle(el);
              if ((st.overflowY === "auto" || st.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 4) {
                el.scrollTo({ top: 0, behavior: "smooth" });
                return;
              }
            } catch (e) {}
            el = el.parentElement;
          }
          try { window.scrollTo({ top: 0, behavior: "smooth" }); }
          catch (e) { if (host()) host().scrollIntoView({ behavior: "smooth", block: "start" }); }
        };
      })(tops[i]);
    }
  }

  function marcarMenuV2(v) {
    try {
      var all = document.querySelectorAll(".menu-item");
      for (var i = 0; i < all.length; i++) all[i].classList.remove("active");
      var btn = document.querySelector('.menu-item[data-view="' + v + '"]');
      if (btn) btn.classList.add("active");
    } catch (e) {}
  }

  function barraAcoesUnidade(tipoNo, rotuloVoltar) {
    var rotulo = tipoNo === "Setor" ? "Setor" : "Unidade";
    var artigo = rotulo === "Unidade" ? "da" : "do";
    return '<div class="fc-print-footer fc-actions-row">' +
      '<button type="button" class="fc-btn" id="fc-back-bottom">\u2190 ' + esc(rotuloVoltar || "Voltar") + "</button>" +
      '<button type="button" class="fc-btn" id="fc-print-unit" title="Imprimir / Salvar PDF dos contatos ' +
      artigo + " " + rotulo + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Imprimir / Salvar PDF</button>' +
      '<button type="button" class="fc-btn" data-scroll-top title="Voltar ao topo">\u2191 Voltar ao topo</button></div>';
  }

  function barraNavegacaoInferior(rotuloVoltar, semLinha) {
    return '<div class="fc-bottom-nav' + (semLinha ? " fc-bottom-nav--colado" : "") + '"><button type="button" class="fc-btn" id="fc-back-bottom">← ' + esc(rotuloVoltar || "Voltar") + '</button>' +
      '<button type="button" class="fc-btn" data-scroll-top title="Voltar ao topo">↑ Voltar ao topo</button></div>';
  }

  function renderInicio() {
    var c = host();
    if (!c) return;
    marcarMenuV2("consulta");
    estado.comarcaId = "";
    estado.forumId = "";
    estado.noId = "";
    var comarcas = ((estado.dados && estado.dados.comarcas) || []).filter(function (m) { return !ehOrgao(m); });
    var totalComarcas = comarcas.length;
    var cardsComarcas = comarcas.map(function (m) {
      var setores = (m.foruns || []).reduce(function (total, f) { return total + qtdSetores(f.nos || []); }, 0);
      return '<div class="fc-card" data-nav="comarca" data-comarca="' + esc(m.id) + '">' +
        '<div class="fc-card-head"><div><h4>' + esc(m.nome) + "</h4></div></div>" +
        '<div class="fc-meta">' +
        badgeQuantidade(m.qtdForuns, "Fórum", "Fóruns") +
        badgeQuantidade(m.qtdUnidades, "Unidade", "Unidades") +
        badgeQuantidade(setores, "Setor", "Setores") +
        badgeQuantidade(m.qtdContatos, "Contato", "Contatos") + "</div></div>";
    }).join("");
    c.innerHTML = '<div class="fc-head"><div><h2 class="fc-title">Contatos do PJES</h2>' +
      '<p class="fc-subtitle fc-subtitle--intro">Consulte a estrutura completa por Comarca, Fórum, Unidade e Setor. Selecione uma Comarca no mapa, no menu suspenso ou na lista abaixo.</p></div></div>' +
      (comarcas.length ? '<div class="fc-catalog-counts">' +
        (totalComarcas ? '<span class="fc-pill fc-total-comarcas">' + esc(rotuloQuantidade(totalComarcas, "Comarca", "Comarcas")) + "</span>" : "") + "</div>" : "") +
      '<select id="fc-comarca" class="fc-select">' + opcoesComarcas(comarcas.filter(function (m) { return !ehOrgao(m); }), "") + "</select>" +
      '<div class="fc-section fc-section--comarcas"><div class="fc-comarcas-grid">' + cardsComarcas + "</div></div>" +
      '<div class="fc-print-footer"><button type="button" class="fc-btn" data-scroll-top title="Voltar ao topo">↑ Voltar ao topo</button></div>';
    var seletor = document.getElementById("fc-comarca");
    if (seletor) seletor.onchange = function () { if (seletor.value) abrirComarca(seletor.value); };
    var cards = document.querySelectorAll("[data-comarca]");
    for (var i = 0; i < cards.length; i++) {
      (function (el) {
        el.onclick = function () { abrirComarca(el.getAttribute("data-comarca")); };
      })(cards[i]);
    }
    vincularAcoes();
    destacarMapa("");
  }

  function abrirComarca(id) {
    estado.comarcaId = String(id);
    estado.forumId = "";
    estado.noId = "";
    marcarMenuV2("consulta");
    var m = comarcaAtual();
    if (!m) return;
    if (ehOrgao(m)) renderOrgao();
    else if ((m.foruns || []).length === 1) abrirForum(m.foruns[0].id);
    else renderForuns();
    destacarMapa(m.codigoIbge);
  }

  function renderForuns() {
    var c = host();
    var m = comarcaAtual();
    if (!c || !m) return;
    if (ehOrgao(m)) return renderOrgao();
    var resumo = resumoQuantidades([
      rotuloQuantidade(m.qtdForuns, "Fórum", "Fóruns"),
      rotuloQuantidade(m.qtdUnidades, "Unidade", "Unidades"),
      rotuloQuantidade((m.foruns || []).reduce(function (total, f) { return total + qtdSetores(f.nos || []); }, 0), "Setor", "Setores"),
      rotuloQuantidade(m.qtdContatos, "Contato", "Contatos")
    ]);
    c.innerHTML = '<button type="button" class="fc-back" id="fc-back-home">← Comarcas</button>' +
      '<div class="fc-head"><div><h2 class="fc-title">' + esc(m.nome) + "</h2>" +
      '<p class="fc-subtitle">' + esc(resumo) + "</p></div></div>" +
      '<select id="fc-comarca" class="fc-select">' + opcoesComarcas(estado.dados.comarcas || [], m.id) + "</select>" +
      '<div class="fc-section"><h3>Fóruns</h3>' +
      (m.foruns || []).map(function (f) {
        return '<div class="fc-card" data-nav="forum" data-forum="' + esc(f.id) + '">' +
          '<div class="fc-card-head"><div><h4>' + esc(f.nome) + "</h4>" + linkEndereco(f.endereco) +
          "</div></div>" +
          '<div class="fc-meta">' + badgeQuantidade(f.qtdUnidades, "Unidade", "Unidades") +
          badgeQuantidade(qtdSetores(f.nos || []), "Setor", "Setores") +
          badgeQuantidade(f.qtdContatos, "Contato", "Contatos") + "</div></div>";
      }).join("") + "</div>" + barraNavegacaoInferior("Comarcas");
    document.getElementById("fc-back-home").onclick = renderInicio;
    document.getElementById("fc-back-bottom").onclick = renderInicio;
    var seletor = document.getElementById("fc-comarca");
    if (seletor) seletor.onchange = function () { if (seletor.value) abrirComarca(seletor.value); };
    var cards = document.querySelectorAll('[data-nav="forum"]');
    for (var i = 0; i < cards.length; i++) {
      (function (el) {
        el.onclick = function () { abrirForum(el.getAttribute("data-forum")); };
      })(cards[i]);
    }
    vincularAcoes();
    destacarMapa(m.codigoIbge);
  }

  function renderOrgao() {
    var c = host();
    var m = comarcaAtual();
    if (!c || !m || !ehOrgao(m)) return;
    var resumo = resumoQuantidades([
      rotuloQuantidade(m.qtdUnidades, "Unidade", "Unidades"),
      rotuloQuantidade(qtdSetores(m.nos || []), "Setor", "Setores"),
      rotuloQuantidade(m.qtdContatos, "Contato", "Contatos")
    ]);
    c.innerHTML = '<button type="button" class="fc-back" id="fc-back-home">← Comarcas</button>' +
      '<div class="fc-head"><div><h2 class="fc-title">' + esc(m.nome) + "</h2>" +
      '<p class="fc-subtitle">' + esc(resumo) + "</p>" + breadcrumbHtml(m, null, null) + "</div></div>" +
      '<select id="fc-comarca" class="fc-select">' + opcoesComarcas(estado.dados.comarcas || [], m.id) + "</select>" +
      '<div class="fc-meta"><span class="fc-pill fc-total-orgaos">TJES</span>' +
      badgeQuantidade(m.qtdUnidades, "Unidade", "Unidades") + "</div>" +
      '<div class="fc-address-row"><div class="fc-inherit"><strong>Endereço do TJES:</strong> ' + linkEndereco(m.endereco) +
      (m.cep ? " • CEP " + esc(m.cep) : "") + "</div></div>" +
      cardContatosGerais(m.contatos || [], true) +
      '<div class="fc-section"><div class="fc-section-title"><h3>Unidades e Setores</h3></div>' +
      ((m.nos || []).length ? (m.nos || []).map(cardNo).join("") : '<div class="fc-empty">Nenhuma Unidade cadastrada.</div>') +
      "</div>" + barraNavegacaoInferior("Comarcas", true);
    document.getElementById("fc-back-home").onclick = renderInicio;
    document.getElementById("fc-back-bottom").onclick = renderInicio;
    (function () {
      var bp = document.querySelector("[data-gerais-print]");
      if (bp) bp.onclick = function (e) { if (e && e.stopPropagation) e.stopPropagation(); imprimirOrgao(); };
    })();
    var seletor = document.getElementById("fc-comarca");
    if (seletor) seletor.onchange = function () {
      if (this.value && String(this.value) !== String(estado.comarcaId)) abrirComarca(this.value);
    };
    var cards = document.querySelectorAll("[data-no]");
    for (var i = 0; i < cards.length; i++) {
      (function (el) {
        el.onclick = function () { abrirNo(el.getAttribute("data-no")); };
      })(cards[i]);
    }
    vincularBreadcrumbs();
    vincularAcoes();
    destacarMapa(m.codigoIbge);
  }

  function abrirTJES() {
    var comarcas = (estado.dados && estado.dados.comarcas) || [];
    var orgao = null;
    for (var i = 0; i < comarcas.length; i++) {
      if (ehOrgao(comarcas[i])) { orgao = comarcas[i]; break; }
    }
    if (orgao) abrirComarca(orgao.id);
    marcarMenuV2("tjes");
  }

  function renderUteis() {
    var c = host();
    if (!c) return;
    marcarMenuV2("uteis");
    estado.comarcaId = "";
    estado.forumId = "";
    estado.noId = "";
    var uteis = (estado.dados && estado.dados.uteis) || [];
    c.innerHTML = '<div class="fc-head"><div><h2 class="fc-title">Telefones Úteis</h2>' +
      '<p class="fc-subtitle">Canais de atendimento e serviços de apoio do PJES.</p></div></div>' +
      (uteis.length ? '<div class="fc-contatos">' + uteis.map(function (u) {
        var href = hrefContato(u.tipo, u.valor);
        var valorHtml = href ? '<a class="fc-contato-valor" href="' + esc(href) + '">' + esc(u.valor) + "</a>" : '<span class="fc-contato-valor">' + esc(u.valor) + "</span>";
        return '<article class="fc-contato"><div class="fc-contato-main"><span class="fc-contato-tipo">' + esc(fmtTipoContato(u.tipo)) + "</span><h4>" + esc(u.nome || u.valor) + "</h4></div>" +
          '<div class="fc-contato-side">' + valorHtml +
          '<div class="fc-contato-actions"><button type="button" class="fc-icon-btn fc-copy-btn" data-copy-value="' + esc(u.valor) +
          '" data-copy-label="' + esc(fmtTipoContato(u.tipo)) + '" title="Copiar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' +
          botaoFav({ tipo: u.tipo, valor: u.valor }, u.nome || u.valor) +
          botaoVcf({ tipo: u.tipo, valor: u.valor }, u.nome || u.valor) + '</div>' +
          "</div></article>";
      }).join("") + "</div>" : '<div class="fc-empty">Nenhum telefone útil cadastrado.</div>') +
      '<div class="fc-print-footer"><button type="button" class="fc-btn" data-scroll-top title="Voltar ao topo">↑ Voltar ao topo</button>' +
      '<button type="button" class="fc-btn" id="fc-print-uteis" title="Imprimir / Salvar PDF"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Imprimir / Salvar PDF</button></div>';
    document.getElementById("fc-print-uteis").onclick = function () {
      abrirImpressao("Telefones Úteis — PJES", "<ul>" + uteis.map(function (u) { return contatoPrint({ tipo: u.tipo, descricao: u.nome, valor: u.valor }); }).join("") + "</ul>");
    };
    vincularAcoes();
  }

  function abrirForum(id) {
    estado.forumId = String(id);
    estado.noId = "";
    renderForum();
  }

  function cardNo(no) {
    var tipo = fmtTipoNo(no.tipo);
    return '<div class="fc-card" data-nav="no" data-no="' + esc(no.id) + '">' +
      '<div class="fc-card-head"><div><h4>' + esc(no.nome) + "</h4></div></div>" +
      '<div class="fc-meta"><span class="fc-pill fc-pill-type">' + esc(tipo) + "</span>" +
      badgeQuantidade(qtdSetores(no.filhos || []), "Setor", "Setores") +
      badgeQuantidade(no.qtdContatos, "Contato", "Contatos") + "</div></div>";
  }

  function renderForum() {
    var c = host();
    var f = forumAtual();
    var m = comarcaAtual();
    if (!c || !f || !m) return;
    c.innerHTML = '<button type="button" class="fc-back" id="fc-back-comarca">← ' + esc(m.nome) + "</button>" +
      '<div class="fc-head"><div><h2 class="fc-title">' + esc(f.nome) + "</h2>" +
      breadcrumbHtml(m, f, null) + "</div></div>" +
      '<div class="fc-meta"><span class="fc-pill fc-pill-type">Fórum</span>' +
      badgeQuantidade(f.qtdUnidades, "Unidade", "Unidades") + "</div>" +
      '<div class="fc-address-row"><div class="fc-inherit"><strong>Endereço do Fórum:</strong> ' + linkEndereco(f.endereco) +
      (f.cep ? " • CEP " + esc(f.cep) : "") + "</div></div>" +
      cardContatosGerais(f.contatos || [], true) +
      '<div class="fc-section"><div class="fc-section-title"><h3>Unidades e Setores</h3></div>' +
      ((f.nos || []).length ? (f.nos || []).map(cardNo).join("") : '<div class="fc-empty">Nenhuma Unidade cadastrada.</div>') +
      "</div>" + barraNavegacaoInferior("Fóruns", true);
    document.getElementById("fc-back-comarca").onclick = renderForuns;
    document.getElementById("fc-back-bottom").onclick = renderForuns;
    (function () {
      var bp = document.querySelector("[data-gerais-print]");
      if (bp) bp.onclick = function (e) { if (e && e.stopPropagation) e.stopPropagation(); imprimirForum(); };
    })();
    var cards = document.querySelectorAll("[data-no]");
    for (var i = 0; i < cards.length; i++) {
      (function (el) {
        el.onclick = function () { abrirNo(el.getAttribute("data-no")); };
      })(cards[i]);
    }
    vincularBreadcrumbs();
    vincularAcoes();
    destacarMapa(m.codigoIbge);
  }

  function abrirNo(id) {
    estado.noId = String(id);
    renderNo();
  }

  function encontrarPai(lista, id, pai) {
    for (var i = 0; i < (lista || []).length; i++) {
      if (String(lista[i].id) === String(id)) return pai || null;
      var achado = encontrarPai(lista[i].filhos || [], id, lista[i]);
      if (achado) return achado;
    }
    return null;
  }

  function renderNo() {
    var c = host();
    var f = forumAtual();
    var m = comarcaAtual();
    var raiz = raizAtual();
    var no = noAtual();
    if (!c || !raiz || !m || !no) return;
    var pai = encontrarPai(raiz.nos || [], no.id, null);
    var tipo = fmtTipoNo(no.tipo);
    var tipoTela = String(no.tipo || "").toUpperCase() === "SETOR" ? "Setor" : "Unidade";
    c.innerHTML =
      '<button type="button" class="fc-back" id="fc-back-no">← ' + esc(pai ? pai.nome : raiz.nome) + "</button>" +
      '<div class="fc-head"><div><h2 class="fc-title">' + esc(no.nome) + "</h2>" +
      breadcrumbHtml(m, f, no) + "</div></div>" +
      '<div class="fc-meta"><span class="fc-pill fc-pill-type">' + esc(tipo) + "</span>" +
      badgeQuantidade(qtdSetores(no.filhos || []), "Setor", "Setores") + "</div>" +
      '<div class="fc-address-row"><div class="fc-inherit"><strong>Endereço:</strong> ' + linkEndereco(no.enderecoExibicao) +
      (no.cepExibicao ? " • CEP " + esc(no.cepExibicao) : "") +
      (no.endereco ? "" : ' <span class="fc-muted">(' + (pai ? "herdado da Unidade" : (ehOrgao(m) ? "herdado do TJES" : "herdado do Fórum")) + ")</span>") + "</div></div>" +
      '<div class="fc-section"><div class="fc-section-title"><h3>Contatos ' + (tipoTela === "Setor" ? "deste Setor" : "desta Unidade") + "</h3></div>" +
      contatosCards(no.contatos || []) + "</div>" +
      ((no.filhos || []).length
        ? '<div class="fc-section"><div class="fc-section-title"><h3>Setores</h3></div>' +
          no.filhos.map(cardNo).join("") + "</div>"
        : "") +
      barraAcoesUnidade(tipoTela, pai ? "Unidade" : (ehOrgao(m) ? "TJES" : "Fórum"));
    document.getElementById("fc-back-no").onclick = function () {
      if (pai) abrirNo(pai.id);
      else { estado.noId = ""; if (ehOrgao(m)) renderOrgao(); else renderForum(); }
    };
    document.getElementById("fc-back-bottom").onclick = document.getElementById("fc-back-no").onclick;
    document.getElementById("fc-print-unit").onclick = imprimirUnidade;
    var cards = document.querySelectorAll("[data-no]");
    for (var i = 0; i < cards.length; i++) {
      (function (el) {
        el.onclick = function () { abrirNo(el.getAttribute("data-no")); };
      })(cards[i]);
    }
    vincularBreadcrumbs();
    vincularAcoes();
    destacarMapa(m.codigoIbge);
  }

  /* ---- impressão (janela de impressão, como no original) ---- */
  function contatoPrint(c) {
    var tipo = fmtTipoContato(c.tipo);
    var descricao = String(c.descricao || "").trim();
    var observacao = String(c.observacao || "").trim();
    var complemento = descricao && descricao.toLocaleLowerCase("pt-BR") !== String(tipo).toLocaleLowerCase("pt-BR")
      ? " — " + esc(descricao) : "";
    var nota = observacao ? '<small class="note">' + esc(observacao) + "</small>" : "";
    return "<li><strong>" + esc(tipo) + ":</strong> " + esc(c.valor || "") + complemento + nota + "</li>";
  }

  function noPrint(no, nivel) {
    nivel = nivel || 0;
    var titulo = Math.min(6, nivel + 3);
    var contatos = (no.contatos || []).length
      ? "<ul>" + (no.contatos || []).map(contatoPrint).join("") + "</ul>"
      : '<p class="muted">Sem contatos diretos.</p>';
    return '<section class="unit"><h' + titulo + ">" + esc(no.nome) + "</h" + titulo + ">" +
      '<p class="meta">' + esc(fmtTipoNo(no.tipo)) + " • " +
      esc(no.enderecoExibicao || "Endereço não informado") +
      (no.cepExibicao ? " • CEP " + esc(no.cepExibicao) : "") + "</p>" +
      contatos + (no.filhos || []).map(function (filho) { return noPrint(filho, nivel + 1); }).join("") +
      "</section>";
  }

  function forumPrint(f, comarcaNome) {
    var contatos = (f.contatos || []).length
      ? "<ul>" + (f.contatos || []).map(contatoPrint).join("") + "</ul>"
      : '<p class="muted">Sem contatos gerais.</p>';
    return '<section class="forum"><h2>' + esc(f.nome) + "</h2>" +
      '<p class="meta">' + esc(comarcaNome || "") + " • " +
      esc(f.endereco || "Endereço não informado") +
      (f.cep ? " • CEP " + esc(f.cep) : "") + "</p>" +
      contatos + (f.nos || []).map(function (no) { return noPrint(no, 0); }).join("") + "</section>";
  }

  function abrirImpressao(titulo, corpo) {
    var w = window.open("", "_blank");
    if (!w) return;
    var css =
      "body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:24px;line-height:1.45}" +
      "h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;border-bottom:2px solid #0f172a;padding-bottom:5px;margin-top:24px}" +
      "h3,h4,h5,h6{font-size:15px;margin:16px 0 4px}.meta{color:#64748b;font-size:11px;margin:0 0 8px}.muted{color:#94a3b8;font-style:italic;font-size:12px}" +
      "ul{margin:5px 0 10px;padding-left:20px}li{font-size:12px;margin:2px 0}.note{display:block;color:#64748b;font-size:9px;margin-top:1px}.forum{break-before:auto}.unit{break-inside:auto;page-break-inside:auto;border-left:2px solid #e2e8f0;padding-left:10px;margin:9px 0}.unit>h3,.unit>h4,.unit>h5,.unit>h6{break-after:avoid-page;page-break-after:avoid}.unit>ul{break-inside:avoid-page;page-break-inside:avoid}" +
      "@media print{@page{size:A4 portrait;margin:12mm}html,body{margin:0;padding:0}.forum,.unit{break-before:auto;page-break-before:auto}}";
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(titulo) +
      "</title><style>" + css + "</style></head><body><h1>" + esc(titulo) +
      '<p class="meta">Gerado em ' + esc(new Date().toLocaleString("pt-BR")) +
      "</p>" + corpo + "<script>window.onload=function(){setTimeout(function(){window.print();},250)}<\/script></body></html>";
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  function imprimirOrgao() {
    var m = comarcaAtual();
    if (!m) return;
    var corpo = (m.contatos || []).length
      ? "<ul>" + (m.contatos || []).map(contatoPrint).join("") + "</ul>"
      : '<p class="muted">Sem contatos gerais.</p>';
    abrirImpressao("Contatos Gerais — TJES",
      "<section><h2>TJES</h2>" +
      '<p class="meta">' + esc(m.endereco || "Endereço não informado") +
      (m.cep ? " • CEP " + esc(m.cep) : "") + "</p>" + corpo + "</section>");
  }

  function imprimirForum() {
    var f = raizAtual();
    var m = comarcaAtual();
    if (!f || !m) return;
    var corpo = (f.contatos || []).length
      ? "<ul>" + (f.contatos || []).map(contatoPrint).join("") + "</ul>"
      : '<p class="muted">Sem contatos gerais.</p>';
    abrirImpressao("Contatos Gerais — " + f.nome,
      "<section><h2>" + esc(f.nome) + "</h2>" +
      '<p class="meta">' + esc(ehOrgao(m) ? "TJES" : m.nome) + " • " +
      esc(f.endereco || "Endereço não informado") +
      (f.cep ? " • CEP " + esc(f.cep) : "") + "</p>" + corpo + "</section>");
  }

  function imprimirUnidade() {
    var no = noAtual();
    var raiz = raizAtual();
    if (!no || !raiz) return;
    abrirImpressao("Contatos — " + no.nome, noPrint(no, 0));
  }

  /* ---- mapa (GeoJSON IBGE, como no original) ---- */
  var GEOJSON_URL = "https://raw.githubusercontent.com/tbrugz/geodata-br/master/geojson/geojs-32-mun.json";

  function codigoComarca(feature) {
    var p = feature && feature.properties || {};
    return String(p.CD_MUN || p.codmun || p.id || p.code || "").replace(/\D/g, "");
  }

  function comarcaPorCodigo(codigo) {
    var lista = (estado.dados && estado.dados.comarcas) || [];
    for (var i = 0; i < lista.length; i++) {
      if (String(lista[i].codigoIbge || "").replace(/\D/g, "") === codigo) return lista[i];
    }
    return null;
  }

  function rotuloMapaComarca(codigo, nome) {
    var m = comarcaPorCodigo(codigo);
    if (!m || Number(m.qtdContatos || 0) === 0) return esc(nome) + "<br><small>Sem contatos cadastrados</small>";
    var nf = Number(m.qtdForuns || (m.foruns || []).length || 0);
    var nc = Number(m.qtdContatos || 0);
    return esc(nome) + "<br><small>" + nf + (nf === 1 ? " Fórum" : " Fóruns") + " • " + nc + (nc === 1 ? " contato" : " contatos") + "</small>";
  }

  function comarcaComContatos(codigo) {
    return (estado.dados.comarcas || []).some(function (m) {
      return String(m.codigoIbge || "").replace(/\D/g, "") === codigo && Number(m.qtdContatos || 0) > 0;
    });
  }

  function estiloComarca(feature) {
    var tem = comarcaComContatos(codigoComarca(feature));
    return tem
      ? { color: "#2563eb", weight: 1.2, fillColor: "#60a5fa", fillOpacity: 0.42 }
      : { color: "#94a3b8", weight: 0.8, fillColor: "#cbd5e1", fillOpacity: 0.24 };
  }

  function destacarMapa(codigoIbge) {
    if (!estado.mapa || !estado.geojson) return;
    var alvo = String(codigoIbge || "").replace(/\D/g, "");
    estado.geojson.eachLayer(function (layer) {
      var cod = codigoComarca(layer.feature);
      var base = estiloComarca(layer.feature);
      if (!alvo) { layer.setStyle(base); return; }
      var ativo = cod === alvo;
      layer.setStyle({
        color: ativo ? "#0f172a" : base.color,
        weight: ativo ? 3 : base.weight,
        fillColor: ativo ? "#00adb5" : base.fillColor,
        fillOpacity: ativo ? 0.58 : base.fillOpacity
      });
    });
  }

  function iniciarMapa() {
    if (typeof L === "undefined") {
      var msg = $("map-msg");
      if (msg) msg.textContent = "Mapa indisponível offline — use os menus do painel.";
      setTimeout(iniciarMapa, 2000);
      return;
    }
    try {
      if (estado.mapa) estado.mapa.remove();
      estado.mapa = L.map("map", { scrollWheelZoom: true }).setView([-19.7, -40.5], 7.6);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap"
      }).addTo(estado.mapa);
      fetch(GEOJSON_URL).then(function (r) { return r.json(); }).then(function (data) {
        estado.geojson = L.geoJSON(data, {
          style: estiloComarca,
          onEachFeature: function (feature, layer) {
            var codigo = codigoComarca(feature);
            var p = feature.properties || {};
            var nome = String(p.name || "Comarca");
            var tem = comarcaComContatos(codigo);
            layer.bindTooltip(
              rotuloMapaComarca(codigo, nome),
              { sticky: true });
            layer.on("click", function () {
              var lista = (estado.dados && estado.dados.comarcas) || [];
              var m = null;
              for (var i = 0; i < lista.length; i++) {
                if (String(lista[i].codigoIbge || "").replace(/\D/g, "") === codigo) { m = lista[i]; break; }
              }
              if (!m) {
                var alvo = String(nome || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
                for (var j = 0; j < lista.length; j++) {
                  var nm = String(lista[j].nome || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
                  if (nm && nm === alvo) { m = lista[j]; break; }
                }
              }
              if (m) abrirComarca(m.id);
            });
            layer.on("mouseover", function () {
              var sel = String((comarcaAtual() && comarcaAtual().codigoIbge) || "").replace(/\D/g, "");
              if (sel !== codigo) {
                layer.setStyle({ color: "#0f172a", weight: 2.2, fillColor: "#00adb5", fillOpacity: .78 });
              }
            });
            layer.on("mouseout", function () {
              var cur = comarcaAtual();
              destacarMapa(cur ? cur.codigoIbge : "");
            });
          }
        }).addTo(estado.mapa);
        var legenda = L.control({ position: "bottomright" });
        legenda.onAdd = function () {
          var div = L.DomUtil.create("div", "fc-map-legenda");
          div.innerHTML = '<span class="tem-contato">● Comarcas com contatos</span>' +
            '<span class="sem-contato">● Sem contatos cadastrados</span>';
          return div;
        };
        legenda.addTo(estado.mapa);
        estado.mapa.fitBounds(estado.geojson.getBounds(), { padding: [3, 3] });
        var msg2 = $("map-msg");
        if (msg2) msg2.textContent = "";
      }).catch(function () {
        var msg3 = $("map-msg");
        if (msg3) msg3.textContent = "Mapa indisponível offline — use os menus do painel.";
      });
      if (window.ResizeObserver) {
        try {
          new ResizeObserver(function () {
            try { estado.mapa.invalidateSize(); } catch (e) {}
          }).observe(document.getElementById("map"));
        } catch (e) {}
      }
    } catch (e) {}
  }

  function atualizarMapaDados() {
    if (!estado.mapa || !estado.geojson) return;
    try {
      estado.geojson.eachLayer(function (layer) {
        layer.setStyle(estiloComarca(layer.feature));
        var codigo = codigoComarca(layer.feature);
        var p = (layer.feature && layer.feature.properties) || {};
        var nome = String(p.name || "Comarca");
        layer.bindTooltip(rotuloMapaComarca(codigo, nome), { sticky: true });
      });
      estado.mapa.invalidateSize();
    } catch (e) {}
  }

  function recarregar(mostrarCarregando) {
    if (estado.carregando) return;
    estado.carregando = true;
    if (mostrarCarregando && host()) host().innerHTML = '<div aria-hidden="true"><div class="fc-skel-card"><div class="fc-skel-line w60"></div><div class="fc-skel-line w80"></div><div class="fc-skel-line w40"></div></div><div class="fc-skel-card"><div class="fc-skel-line w80"></div><div class="fc-skel-line w40"></div><div class="fc-skel-line w60"></div></div><div class="fc-skel-card"><div class="fc-skel-line w40"></div><div class="fc-skel-line w60"></div><div class="fc-skel-line w80"></div></div></div>';
    fetch("/api/hierarquia").then(function (r) { return r.json(); }).then(function (dados) {
      estado.carregando = false;
      estado.dados = dados && dados.comarcas ? dados : { comarcas: [] };
      atualizarMapaDados();
      renderInicio();
      abrirLinkContato();
    }).catch(function (erro) {
      estado.carregando = false;
      if (host()) {
        host().innerHTML = '<div class="fc-empty">Não foi possível carregar os contatos. ' +
          esc((erro && erro.message) || erro) + ' <button type="button" class="fc-btn" id="fc-retry">Tentar novamente</button></div>';
        var retry = document.getElementById("fc-retry");
        if (retry) retry.onclick = function () { recarregar(true); };
      }
    });
  }

  /* ---- menu + tema (padrão v2) ---- */
  function aplicarTema() {
    var dark = (localStorage.getItem("contatos-theme") || "light") === "dark";
    document.body.dataset.theme = dark ? "dark" : "light";
    var t = $("toggle-dark-mode");
    if (t) t.checked = dark;
  }

  document.addEventListener("DOMContentLoaded", function () {
    aplicarTema();
    vincularBuscaGlobal();
    try { sincronizarFavs(); } catch (e) {}
    var tg = $("toggle-dark-mode");
    if (tg) tg.onchange = function (e) {
      localStorage.setItem("contatos-theme", e.target.checked ? "dark" : "light");
      aplicarTema();
    };
    var itens = document.querySelectorAll('.menu-item[data-view]');
    for (var i = 0; i < itens.length; i++) {
      (function (btn) {
        btn.onclick = function () {
          var all = document.querySelectorAll(".menu-item");
          for (var j = 0; j < all.length; j++) all[j].classList.remove("active");
          btn.classList.add("active");
          var v = btn.getAttribute("data-view");
          ["consulta", "config"].forEach(function (x) { var s = $("view-" + x); if (s) s.classList.add("hidden"); });
          $("view-consulta").classList.remove("hidden");
          if (v === "consulta") { renderInicio(); }
          else if (v === "tjes") { abrirTJES(); }
          else if (v === "uteis") { renderUteis(); }
          else if (v === "favoritos") { renderFavoritos(); }
          else { $("view-consulta").classList.add("hidden"); $("view-" + v).classList.remove("hidden"); }
        };
      })(itens[i]);
    }
    recarregar(true);
    setTimeout(iniciarMapa, 0);
  });

  window.recarregarNavegacaoForum = function () { recarregar(false); };
  window.setLoc = function (id) { abrirComarca(String(id)); };
})();

document.addEventListener("keydown", function(e){
  if(e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  var t = e.target;
  if(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  var ids = ["fc-busca", "campo-pesquisa"];
  for(var i = 0; i < ids.length; i++){
    var b = document.getElementById(ids[i]);
    if(b && b.offsetParent !== null){ e.preventDefault(); b.focus(); return; }
  }
});
window.addEventListener("beforeprint", function(){
  var m = document.getElementById("print-meta");
  if(!m){ m = document.createElement("div"); m.id = "print-meta"; m.className = "print-meta"; document.body.prepend(m); }
  m.textContent = "Diretório Institucional de Contatos – PJES · Gerado em " + new Date().toLocaleString("pt-BR");
});
window.addEventListener("afterprint", function(){
  var m = document.getElementById("print-meta");
  if(m) m.remove();
});

document.addEventListener("keydown", function(e){
  if(e.key !== "Escape") return;
  var cx = document.getElementById("fc-busca-resultados");
  if(cx && !cx.hasAttribute("hidden")){ cx.setAttribute("hidden", ""); cx.innerHTML = ""; }
  var x = document.querySelector(".leaflet-popup-close-button");
  if(x){ x.click(); }
  var ae = document.activeElement;
  if(ae && (ae.id === "fc-busca" || ae.id === "campo-pesquisa")) ae.blur();
  document.querySelectorAll(".modal").forEach(function(m){
    if(m.classList.contains("hidden") || m.style.display === "none" || m.offsetParent === null) return;
    if(m.id === "modal-sem-acesso" && typeof fecharModalSemAcesso === "function") fecharModalSemAcesso();
    else m.classList.add("hidden");
  });
});

(function(){
  var BP = 900;
  function movel(){ return window.matchMedia && window.matchMedia("(max-width:" + BP + "px)").matches; }
  document.querySelectorAll(".fc-page-head").forEach(function(h){
    if (h.querySelector(".hamburger")) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "hamburger";
    b.textContent = "☰";
    b.setAttribute("aria-label", "Abrir menu de navegação");
    b.setAttribute("aria-expanded", "false");
    b.addEventListener("click", function(){ definir(!document.body.classList.contains("nav-open")); });
    h.insertBefore(b, h.firstChild);
  });
  var bd = document.createElement("button");
  bd.type = "button";
  bd.className = "nav-backdrop";
  bd.setAttribute("aria-label", "Fechar menu lateral");
  bd.setAttribute("tabindex", "-1");
  bd.addEventListener("click", function(){ definir(false); });
  document.body.appendChild(bd);
  function botoes(){
    return Array.prototype.slice.call(document.querySelectorAll(".fc-page-head .hamburger"));
  }
  function definir(aberto){
    var ativo = Boolean(aberto && movel());
    document.body.classList.toggle("nav-open", ativo);
    botoes().forEach(function(b){
      b.setAttribute("aria-expanded", ativo ? "true" : "false");
      b.setAttribute("aria-label", ativo ? "Fechar menu de navegação" : "Abrir menu de navegação");
      b.textContent = ativo ? "✕" : "☰";
    });
  }
  document.querySelectorAll(".sidebar .menu-item").forEach(function(m){
    m.addEventListener("click", function(){ definir(false); });
  });
  document.addEventListener("keydown", function(e){
    if (e.key === "Escape" && document.body.classList.contains("nav-open")) definir(false);
  });
  if (window.matchMedia) window.matchMedia("(max-width:" + BP + "px)").addEventListener("change", function(){ definir(false); });
})();
