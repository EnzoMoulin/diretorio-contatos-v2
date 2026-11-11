#!/usr/bin/env python3
"""Trilha de demonstração que o banco grava ao nascer (`_historico_demonstracao`).

No demo público o banco é recriado a cada boot: sem esta trilha o gráfico de
alterações por mês abriria zerado para quem visita. O que o teste trava:

- o total e a distribuição por mês são os declarados (dois meses zerados, de
  propósito — mês sem alteração é informação no gráfico, e é o que o teste da
  janela de 12 meses exercita);
- as datas são relativas ao boot, então nunca envelhecem para fora da janela e
  nunca caem no futuro;
- é idempotente: segundo boot no mesmo banco não duplica;
- a linha é fictícia e declarada: autor `demonstração`, sem contato e sem usuário;
- o detalhe não carrega telefone nem e-mail.

A primeira classe não depende do servidor (SQLite em memória com o `SCHEMA` do
app); a segunda sobe o `init_db()` de verdade num diretório temporário, que é o
caminho do boot no Render.
"""
import pathlib
import re
import sqlite3
import tempfile
import time
import unittest

import app


class TestHistoricoDemonstracao(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript(app.SCHEMA)

    def tearDown(self):
        self.con.close()

    def _linhas(self):
        return self.con.execute("SELECT * FROM historico").fetchall()

    def test_grava_trinta_e_dois_registros_em_dez_meses(self):
        criadas = app._historico_demonstracao(self.con)
        self.assertEqual(criadas, sum(q for _, q in app.DEMO_HISTORICO))
        self.assertEqual(criadas, 32)
        meses = {r["data"][:7] for r in self._linhas()}
        self.assertEqual(len(meses), 10, "dois meses precisam ficar zerados")
        zerados = [atras for atras, q in app.DEMO_HISTORICO if q == 0]
        self.assertEqual(len(zerados), 2)

    def test_datas_ficam_na_janela_e_nunca_no_futuro(self):
        app._historico_demonstracao(self.con)
        janela = {"%04d-%02d" % app._mes_atras(i) for i in range(12)}
        datas = [r["data"] for r in self._linhas()]
        self.assertEqual({d[:7] for d in datas} - janela, set(),
                         "data fora da janela de 12 meses")
        agora = time.strftime("%Y-%m-%d %H:%M:%S")
        self.assertTrue(all(d <= agora for d in datas),
                        "o demo não pode registrar alteração no futuro")
        self.assertTrue(all(re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", d)
                            for d in datas), "data fora do formato do banco")

    def test_idempotente(self):
        app._historico_demonstracao(self.con)
        antes = len(self._linhas())
        self.assertEqual(app._historico_demonstracao(self.con), 0)
        self.assertEqual(len(self._linhas()), antes)

    def test_linha_e_ficticia_declarada_e_sem_dado_pessoal(self):
        app._historico_demonstracao(self.con)
        for r in self._linhas():
            self.assertEqual(r["autor_nome"], app.MARCA_DEMO)
            self.assertIsNone(r["usuario_id"], "linha fictícia não tem autor real")
            self.assertIsNone(r["contato_id"], "linha fictícia não aponta contato")
            self.assertIn("demonstração", r["detalhe"])
            self.assertIsNone(re.search(r"\d{4,}|@", r["detalhe"]),
                              "detalhe não pode trazer telefone ou e-mail")
        acoes = {r["acao"] for r in self._linhas()}
        self.assertTrue(acoes, "precisa de pelo menos uma ação para a legenda")
        self.assertTrue(acoes.issubset({a for a, _ in app.DEMO_ACOES}))


class TestBootComTrilhaDeDemonstracao(unittest.TestCase):
    """O boot de verdade: banco novo ganha a trilha, segundo boot não duplica."""

    def test_banco_novo_ganha_trilha_e_boot_seguinte_nao_duplica(self):
        with tempfile.TemporaryDirectory() as pasta:
            antigo, app.DB = app.DB, pathlib.Path(pasta) / "contatos.db"
            try:
                app._CONT.clear()
                app.init_db()
                con = sqlite3.connect(app.DB)
                try:
                    demo = con.execute(
                        "SELECT COUNT(*) FROM historico WHERE autor_nome=?",
                        (app.MARCA_DEMO,)).fetchone()[0]
                    init = con.execute(
                        "SELECT COUNT(*) FROM historico WHERE acao='init'"
                    ).fetchone()[0]
                finally:
                    con.close()
                self.assertEqual(demo, 32, "banco novo precisa nascer com a trilha")
                self.assertEqual(init, 1)

                app.init_db()  # restart sem disco: o mesmo arquivo, de novo
                con = sqlite3.connect(app.DB)
                try:
                    demo2 = con.execute(
                        "SELECT COUNT(*) FROM historico WHERE autor_nome=?",
                        (app.MARCA_DEMO,)).fetchone()[0]
                finally:
                    con.close()
                self.assertEqual(demo2, 32, "trilha de demonstração não duplica")
            finally:
                app.DB = antigo
                app._CONT.clear()


if __name__ == "__main__":
    unittest.main(verbosity=2)
