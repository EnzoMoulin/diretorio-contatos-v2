#!/usr/bin/env python3
"""Recalcula o `?v=` dos assets do front-end a partir do conteúdo do arquivo.

Por que existe: o navegador guarda `admin.js?v=74` em cache. Sem trocar a query
quando o arquivo muda, o dono abre o /admin e vê o JS de ontem — um ajuste de
UI some do teste manual e a conclusão errada é "não funcionou". Amarrar o `?v=`
ao começo do sha256 do arquivo resolve na origem: o valor só muda quando o
conteúdo muda, e `tests/test_cache_busting.py` reprova o CI quando os dois
divergem, então esquecer o bump deixa de ser possível.

Uso (idempotente, só reescreve o que diverge):
    scripts/atualizar-cache-busting.py

O hash é de 8 caracteres hexadecimais: curto o bastante para a URL ficar legível
e longo o bastante para não colidir por acidente entre versões.
"""
from __future__ import annotations

import hashlib
import pathlib
import re
import sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent
FRONTEND = RAIZ / "frontend"
PADRAO = re.compile(r'(?P<pre>(?:src|href)=")(?P<arq>[\w.-]+\.(?:js|css))\?v=[^"]*"')


def hash_curto(caminho: pathlib.Path) -> str:
    return hashlib.sha256(caminho.read_bytes()).hexdigest()[:8]


def versoes() -> dict[str, str]:
    return {p.name: hash_curto(p) for p in sorted(FRONTEND.iterdir())
            if p.suffix in {".js", ".css"}}


def atualizar(html: pathlib.Path, versao: dict[str, str]) -> bool:
    texto = html.read_text(encoding="utf-8")
    mudou = False

    def troca(m: re.Match) -> str:
        nonlocal mudou
        arq = m.group("arq")
        if arq not in versao:
            return m.group(0)
        novo = f'{m.group("pre")}{arq}?v={versao[arq]}"'
        if novo != m.group(0):
            mudou = True
        return novo

    novo_texto = PADRAO.sub(troca, texto)
    if mudou:
        html.write_text(novo_texto, encoding="utf-8")
    return mudou


def main() -> int:
    versao = versoes()
    alterados = [h.name for h in sorted(FRONTEND.glob("*.html")) if atualizar(h, versao)]
    if alterados:
        print("?v= atualizado em: " + ", ".join(alterados))
    else:
        print("?v= já estava em dia em todos os HTML do front-end.")
    for nome, valor in versao.items():
        print(f"  {nome} -> {valor}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
