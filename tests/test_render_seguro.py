#!/usr/bin/env python3
"""Verificação estática do front-end: nenhum innerHTML com dado sem escape.

Os cards, listas e selects são montados por string + `innerHTML`. Uma variável
interpolada direto (`'<b>' + p.nome + '</b>'`) vira XSS armazenado quando o dado
vem de solicitação de acesso ou de contato criado no admin.

A regra: toda expressão dinâmica dentro de um `innerHTML` precisa passar por
`esc(...)` ou por um construtor de HTML que escape por dentro. Ficam liberadas
apenas expressões numéricas (ids, contadores) e literais.

Roda no CI junto com a suíte: `python3 -m unittest discover -s tests -t . -v`.
"""
import os
import re
import unittest

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND = os.path.join(RAIZ, "frontend")

# Funções que devolvem HTML já escapado (cada uma usa esc() por dentro).
SAFE_CALLS = {
    "esc", "Number", "badgeQuantidade", "contatosCards", "cardNo",
    "cardContatosGerais", "breadcrumbHtml", "opcoesComarcas", "realcarBusca",
    "fmtTipoContato", "fmtTipoNo", "fmtValor", "linkEndereco",
    "barraAcoesUnidade", "barraNavegacaoInferior", "acaoSolicitar", "solBtn",
    "covMark", "gestBtn", "linhaFavorito", "cardComarca", "botaoVcf",
    "botaoFav", "botaoLink", "botaoImpressaoLocalidade",
}
# Variáveis locais que já carregam HTML montado com escape.
SAFE_VARS = {
    "valorHtml", "cardsComarcas", "hl", "texto", "conteudo", "descricaoHtml",
    "observacaoHtml", "acoes", "opcoes", "linhas", "html",
}
# Campos numéricos: id e contadores não carregam texto do usuário.
NUMERIC_FIELDS = {
    "id", "nid", "qtdContatos", "n_acessos", "total", "kb", "length", "ordem",
    "ativo", "lida", "admin", "pagina", "qtd", "n", "i", "j", "w", "max",
}


def _split_top(expr, sep="+"):
    """Divide a expressão nos operadores de nível zero (fora de aspas/parênteses)."""
    partes, depth, quote, atual, i = [], 0, None, "", 0
    while i < len(expr):
        ch = expr[i]
        if quote:
            atual += ch
            if ch == "\\":
                atual += expr[i + 1:i + 2]
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in "'\"`":
            quote = ch
            atual += ch
            i += 1
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == sep and depth == 0:
            partes.append(atual)
            atual = ""
            i += 1
            continue
        atual += ch
        i += 1
    partes.append(atual)
    return [p.strip() for p in partes if p.strip()]


def _ternario(e):
    """Devolve (cond, entao, senao) quando `e` é um ternário de nível zero."""
    q, depth, i, pos_int, pos_dois = None, 0, 0, None, None
    while i < len(e):
        ch = e[i]
        if q:
            if ch == "\\":
                i += 2
                continue
            if ch == q:
                q = None
            i += 1
            continue
        if ch in "'\"`":
            q = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == "?" and depth == 0 and pos_int is None:
            pos_int = i
        elif ch == ":" and depth == 0 and pos_int is not None and pos_dois is None:
            pos_dois = i
        i += 1
    if pos_int is None or pos_dois is None:
        return None
    return e[:pos_int].strip(), e[pos_int + 1:pos_dois].strip(), e[pos_dois + 1:].strip()


def _sem_parens(e):
    """Remove parênteses que envolvem a expressão inteira."""
    while e.startswith("(") and e.endswith(")"):
        depth = 0
        for i, ch in enumerate(e):
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0 and i != len(e) - 1:
                    return e
        e = e[1:-1].strip()
    return e


def _corpo_map(e):
    """Extrai a expressão do `return` de um `.map(fn)` inline (se houver)."""
    m = re.search(r"\.map\(", e)
    if not m:
        return None
    i, depth = m.end(), 1
    quote = None
    while i < len(e) and depth:
        ch = e[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "'\"`":
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        i += 1
    corpo = e[m.end():i - 1]
    r = re.search(r"\breturn\s+", corpo)
    if not r:
        # Arrow sem bloco: o corpo é tudo depois de `=>`.
        seta = corpo.find("=>")
        return corpo[seta + 2:].strip() if seta != -1 else None
    resto = corpo[r.end():]
    depth, quote, j = 0, None, 0
    while j < len(resto):
        ch = resto[j]
        if quote:
            if ch == "\\":
                j += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "'\"`":
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == ";" and depth == 0:
            break
        j += 1
    return resto[:j].strip()


def seguro(expr):
    """True quando a expressão não injeta texto cru no HTML."""
    e = _sem_parens(expr.strip())
    if not e:
        return True
    if re.fullmatch(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"|`(?:[^`\\]|\\.)*`", e, re.S):
        return True
    if re.fullmatch(r"[\d\s.+\-*/()%,]+", e):
        return True
    t = _ternario(e)
    if t:
        return seguro(t[1]) and seguro(t[2])
    for op in ("||", "&&"):
        partes = _split_top(e, op[0])
        if len(partes) > 1:
            return all(seguro(p.strip("&| ")) for p in partes)
    partes = _split_top(e, "+")
    if len(partes) > 1:
        return all(seguro(p) for p in partes)
    if e.startswith(("ICON_", "SVG_")):
        return True
    m = re.match(r"^([A-Za-z_$][\w$]*)\s*\(", e)
    if m and m.group(1) in SAFE_CALLS:
        return True
    m = re.match(r"^(.+?)\.map\(\s*([A-Za-z_$][\w$]*)\s*\)", e, re.S)
    if m and m.group(2) in SAFE_CALLS:
        return True
    corpo = _corpo_map(e)
    if corpo:
        return seguro(corpo)
    if re.fullmatch(r"[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*", e):
        if e.split(".")[0] in SAFE_VARS:
            return True
        return e.split(".")[-1] in NUMERIC_FIELDS
    return False


def _statements(text):
    """(linha, trecho) de cada atribuição innerHTML/outerHTML ou insertAdjacentHTML."""
    i, n = 0, len(text)
    pat = re.compile(r"\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(")
    while True:
        m = pat.search(text, i)
        if not m:
            return
        j, depth, quote = m.end(), 0, None
        while j < n:
            ch = text[j]
            if quote:
                if ch == "\\":
                    j += 2
                    continue
                if ch == quote:
                    quote = None
                j += 1
                continue
            if ch in "'\"`":
                quote = ch
                j += 1
                continue
            if ch in "([{":
                depth += 1
            elif ch in ")]}":
                depth -= 1
                if depth < 0:
                    break
            elif ch == ";" and depth == 0:
                break
            j += 1
        yield text[:m.start()].count("\n") + 1, text[m.start():j]
        i = j + 1


def _dinamicas(trecho):
    """Expressões dinâmicas: ${...} em template e o lado direito da atribuição."""
    for m in re.finditer(r"\$\{([^{}]*)\}", trecho):
        yield "template", m.group(1).strip()
    corpo = trecho.split("=", 1)[1] if "=" in trecho else trecho
    yield "atribuicao", corpo.strip().rstrip(";").strip()


class TestRenderSeguro(unittest.TestCase):
    def test_pega_dado_cru(self):
        """O próprio verificador precisa reprovar o padrão que ele combate."""
        amostras = [
            "el.innerHTML = '<b>' + p.nome + '</b>' + esc(p.email);",
            "el.innerHTML = `<b>${p.nome}</b>`;",
        ]
        for amostra in amostras:
            achados = [expr for _l, t in _statements(amostra)
                       for _k, expr in _dinamicas(t) if not seguro(expr)]
            self.assertTrue(achados, f"não reprovou: {amostra}")

    def test_innerhtml_sem_dado_cru(self):
        problemas = []
        for nome in sorted(os.listdir(FRONTEND)):
            if not nome.endswith(".js"):
                continue
            caminho = os.path.join(FRONTEND, nome)
            with open(caminho, encoding="utf-8") as f:
                txt = f.read()
            for linha, trecho in _statements(txt):
                for _tipo, expr in _dinamicas(trecho):
                    if not seguro(expr):
                        problemas.append(f"{nome}:{linha}: {expr[:90]}")
        self.assertEqual(
            problemas, [],
            "innerHTML com dado sem escape (use esc() ou um construtor que "
            "escape):\n  " + "\n  ".join(problemas))


if __name__ == "__main__":
    unittest.main(verbosity=2)
