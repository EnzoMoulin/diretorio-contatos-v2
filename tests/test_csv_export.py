#!/usr/bin/env python3
"""O CSV do admin carrega procedência e conferência junto (guard de estrutura).

O export é montado no navegador, a partir do que está na tela. Este teste não
roda o JS: ele trava as peças que fazem procedência e conferência chegarem na
planilha — o card expõe `data-fonte`/`data-vigente-desde` e
`data-conferido-em`/`data-conferido-por`, o cabeçalho do CSV tem as quatro
colunas e a linha lê esses atributos. Se alguém reescrever o export e perder
uma coluna, o dado voltaria a viajar invisível: a planilha não diria de onde
veio o contato nem quem já o revisou.

Verificação de comportamento (arquivo baixado de verdade) fica na fumaça e no
teste manual; aqui é o guard de regressão barato.
"""
import os
import re
import unittest

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADMIN_JS = os.path.join(RAIZ, "frontend", "admin.js")


def fonte():
    with open(ADMIN_JS, encoding="utf-8") as f:
        return f.read()


def cabecalho_csv(js):
    """Devolve a linha de cabeçalho do CSV como texto, ou falha se ela sumiu."""
    cab = re.search(r'const linhas = \[\["Nome".*?\]\];', js)
    if cab is None:
        raise AssertionError("não achei o cabeçalho do CSV em admin.js")
    return cab.group(0)


class TestCsvComProcedenciaEConferencia(unittest.TestCase):
    def test_cabecalho_tem_as_colunas_de_procedencia(self):
        cab = cabecalho_csv(fonte())
        for coluna in ('"Fonte"', '"Desde"'):
            self.assertIn(coluna, cab,
                          "coluna de procedência ausente do CSV: " + coluna)

    def test_cabecalho_tem_as_colunas_da_conferencia(self):
        cab = cabecalho_csv(fonte())
        self.assertIn('"Conferido em"', cab)
        self.assertIn('"Conferido por"', cab)

    def test_card_expoe_a_procedencia_em_data_attribute(self):
        js = fonte()
        self.assertIn('data-fonte=', js)
        self.assertIn('data-vigente-desde=', js)
        # só quando existe: card sem procedência não ganha atributo vazio
        self.assertRegex(js, "c\\.fonte \\? ' data-fonte=")
        self.assertRegex(js, "c\\.vigente_desde \\? ' data-vigente-desde=")

    def test_card_expoe_a_conferencia_em_data_attribute(self):
        js = fonte()
        self.assertIn('data-conferido-em=', js)
        self.assertIn('data-conferido-por=', js)
        # só quando existe conferência: card não conferido não ganha atributo vazio
        self.assertRegex(js, "c\\.conferido_em \\? ' data-conferido-em=")

    def test_linha_do_csv_le_os_atributos(self):
        js = fonte()
        bloco = js[js.index("function exportarCsvVisivel"):]
        bloco = bloco[:bloco.index("function vincularAcoes")]
        for campo in ("dataset.conferidoEm", "dataset.conferidoPor",
                      "dataset.fonte", "dataset.vigenteDesde"):
            self.assertIn(campo, bloco)
        # data legível, não ISO cru: é planilha para humano
        self.assertIn("dataCurta(", bloco)


if __name__ == "__main__":
    unittest.main()
