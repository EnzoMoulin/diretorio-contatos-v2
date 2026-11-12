#!/usr/bin/env python3
"""O `?v=` de cada asset do front-end tem de ser o hash do arquivo.

O que este caso impede: alguém edita `admin.js` e esquece de trocar o `?v=` no
`admin.html`. O servidor entrega o HTML com a query antiga, o navegador reusa o
JS do cache e a correção não aparece — em teste manual isso vira "não
funcionou", e a rodada seguinte caça um bug que não existe. Verificado na
prática: antes do guard, um ajuste de rótulo exigia bumpar `?v=73 -> 74` na mão.

A regra: `?v=` é o sha256 do arquivo, primeiros 8 hexadecimais. Quem edita roda
`scripts/atualizar-cache-busting.py`, que reescreve todos os HTML de uma vez.

Roda no CI junto com a suíte: `python3 -m unittest discover -s tests -t . -v`.
"""
import hashlib
import os
import re
import unittest

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND = os.path.join(RAIZ, "frontend")
PADRAO = re.compile(r'(?:src|href)="([\w.-]+\.(?:js|css))\?v=([^"]*)"')


def hash_curto(nome):
    with open(os.path.join(FRONTEND, nome), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:8]


def referencias():
    """(html, arquivo, valor_do_v) de cada asset versionado em cada HTML."""
    achados = []
    for nome in sorted(os.listdir(FRONTEND)):
        if not nome.endswith(".html"):
            continue
        with open(os.path.join(FRONTEND, nome), encoding="utf-8") as f:
            texto = f.read()
        for arq, valor in PADRAO.findall(texto):
            achados.append((nome, arq, valor))
    return achados


class TestCacheBusting(unittest.TestCase):
    def test_v_bate_com_o_hash_do_arquivo(self):
        refs = referencias()
        self.assertTrue(refs, "nenhum asset com ?v= encontrado nos HTML do front-end")
        divergentes = [
            f"{html}: {arq}?v={valor} (arquivo tem {hash_curto(arq)})"
            for html, arq, valor in refs
            if valor != hash_curto(arq)
        ]
        self.assertEqual([], divergentes,
                         "?v= desatualizado — rode scripts/atualizar-cache-busting.py")

    def test_todo_asset_referenciado_existe(self):
        faltando = sorted({arq for _, arq, _ in referencias()
                           if not os.path.exists(os.path.join(FRONTEND, arq))})
        self.assertEqual([], faltando)

    def test_todo_js_e_css_e_versionado(self):
        # Um asset novo sem `?v=` entra no cache para sempre: o navegador nem
        # consulta o servidor de novo.
        assets = {n for n in os.listdir(FRONTEND) if n.endswith((".js", ".css"))}
        versionados = {arq for _, arq, _ in referencias()}
        self.assertEqual(set(), assets - versionados,
                         "asset sem ?v= em nenhum HTML")


if __name__ == "__main__":
    unittest.main()
