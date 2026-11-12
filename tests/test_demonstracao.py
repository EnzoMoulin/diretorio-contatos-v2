#!/usr/bin/env python3
"""Trilha de demonstração que o banco grava ao nascer (`_historico_demonstracao`).

No demo público o banco é recriado a cada boot: sem esta trilha o gráfico de
alterações por mês abriria zerado para quem visita. O que o teste trava:

- o total e a distribuição por mês são os declarados (dois meses zerados, de
  propósito — mês sem alteração é informação no gráfico, e é o que o teste da
  janela de 12 meses exercita);
- **o desenho não depende do calendário**: as datas são relativas ao boot, e a
  forma do gráfico (a barra vazia na posição certa, o mês em curso com linha)
  tem de sair igual em qualquer data — virada de mês, virada de ano, 29 de
  fevereiro. O teste antigo provava só "existem dois meses zerados", e por isso
  a virada do mês pôde trocar o calendário no meio da geração sem reprovar;
- a trilha inteira sai de UM instante: com o relógio lido dentro do laço, um
  boot que atravessava a virada do mês gerava 9 meses distintos (medido);
- as datas nunca caem no futuro nem fora da janela do `/api/historico/mensal`;
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
from contextlib import contextmanager

import app


def _instante(ano, mes, dia, hora=0, minuto=5, segundo=0):
    """`time.struct_time` de um instante (campos que o app usa)."""
    return time.struct_time((ano, mes, dia, hora, minuto, segundo, 3, 316, 0))


@contextmanager
def _relogio(fn):
    """Troca o relógio do app por `fn` enquanto o bloco roda.

    Só `time.localtime` é trocada — é a única leitura de relógio da trilha, e
    trocá-la é o que permite testar data relativa sem depender do dia em que a
    suíte roda.
    """
    original = app.time.localtime
    app.time.localtime = fn
    try:
        yield
    finally:
        app.time.localtime = original


def _janela(instante):
    """Os 12 meses do `/api/historico/mensal`, na ordem do gráfico (velho → novo)."""
    meses = []
    for volta in range(11, -1, -1):
        ano, mes = instante.tm_year, instante.tm_mon - volta
        while mes <= 0:
            mes += 12
            ano -= 1
        meses.append("%04d-%02d" % (ano, mes))
    return meses


class TestHistoricoDemonstracao(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript(app.SCHEMA)

    def tearDown(self):
        self.con.close()

    def _linhas(self):
        return self.con.execute("SELECT * FROM historico").fetchall()

    def _datas(self):
        return [r["data"] for r in self._linhas()]

    def _desenho(self, instante):
        """(janela do servidor, quantas linhas por mês da janela)."""
        por_mes = {}
        for data in self._datas():
            por_mes[data[:7]] = por_mes.get(data[:7], 0) + 1
        janela = _janela(instante)
        return janela, [por_mes.get(m, 0) for m in janela]

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
        datas = self._datas()
        self.assertEqual({d[:7] for d in datas} - janela, set(),
                         "data fora da janela de 12 meses")
        agora = time.strftime("%Y-%m-%d %H:%M:%S")
        self.assertTrue(all(d <= agora for d in datas),
                        "o demo não pode registrar alteração no futuro")
        self.assertTrue(all(re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", d)
                            for d in datas), "data fora do formato do banco")

    def test_mes_em_curso_nao_passa_do_agora_mesmo_de_madrugada(self):
        # Regressão do CI em UTC: o corte por dia deixava a linha do mês em curso
        # com a hora do meio da manhã — no futuro de quem boota de madrugada. O
        # relógio é congelado para o caso não depender da hora em que roda.
        fixo = _instante(2026, 11, 12, 0, 5)
        with _relogio(lambda *a: fixo):
            app._historico_demonstracao(self.con)
        agora = "2026-11-12 00:05:00"
        datas = self._datas()
        self.assertTrue(all(d <= agora for d in datas),
                        "de madrugada nenhuma linha pode nascer no futuro")
        self.assertTrue(any(d[:7] == "2026-11" for d in datas),
                        "o mês em curso continua com alteração no gráfico")

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


class TestDesenhoDoGraficoNaoDependeDoCalendario(unittest.TestCase):
    """A trilha é relativa ao boot: o desenho tem de sair igual em qualquer data.

    O que o teste de "dois meses zerados" não cobria: *onde* ficam as barras
    vazias e se o mês em curso tem linha. Sem isso, a virada do mês podia trocar
    o calendário no meio da geração (medido: 9 meses distintos e o mês em curso
    zerado) e nada reprovava — o defeito só apareceria quando o calendário
    virasse, no demo publicado.
    """

    DESIGN = [q for _, q in app.DEMO_HISTORICO]

    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.executescript(app.SCHEMA)

    def tearDown(self):
        self.con.close()

    def _gerar(self, instante):
        with _relogio(lambda *a: instante):
            app._historico_demonstracao(self.con)

    def _desenho(self, instante):
        por_mes = {}
        for (data,) in self.con.execute("SELECT data FROM historico"):
            por_mes[data[:7]] = por_mes.get(data[:7], 0) + 1
        janela = _janela(instante)
        return janela, [por_mes.get(m, 0) for m in janela]

    def test_o_desenho_declarado_tem_dois_meses_zerados_na_posicao_4_e_7(self):
        self.assertEqual(len(self.DESIGN), 12, "a janela do gráfico tem 12 meses")
        self.assertEqual([i for i, q in enumerate(self.DESIGN) if q == 0], [4, 7],
                         "mudou a posição dos meses zerados: é decisão de "
                         "desenho, mude a expectativa aqui de propósito")

    def test_mesma_forma_em_qualquer_data_do_calendario(self):
        casos = [
            ("virada do ano, de madrugada", _instante(2027, 1, 1, 0, 5)),
            ("virada do ano, depois das 9h", _instante(2027, 1, 1, 9, 30)),
            ("virada de mês", _instante(2027, 2, 1, 0, 5)),
            ("véspera de virada", _instante(2026, 12, 31, 23, 59)),
            ("último segundo do mês", _instante(2027, 1, 31, 23, 59, 58)),
            ("meio do mês", _instante(2027, 6, 15, 12, 0)),
            ("29 de fevereiro (bissexto)", _instante(2028, 2, 29, 10, 0)),
        ]
        for rotulo, instante in casos:
            with self.subTest(data=rotulo):
                self.con.execute("DELETE FROM historico")
                self._gerar(instante)
                janela, vetor = self._desenho(instante)
                self.assertEqual(vetor, self.DESIGN,
                                 "o desenho do gráfico mudou com o calendário")
                self.assertEqual(sum(vetor), 32)
                datas = [d for (d,) in self.con.execute("SELECT data FROM historico")]
                self.assertEqual(sorted({d[:7] for d in datas} - set(janela)), [],
                                 "linha fora da janela de 12 meses do servidor")
                agora = time.strftime("%Y-%m-%d %H:%M:%S", instante)
                self.assertEqual([d for d in datas if d > agora], [],
                                 "linha no futuro")
                self.assertTrue(vetor[-1] > 0, "o mês em curso não pode zerar")
                self.assertEqual(len(datas) - len(set(datas)), 0,
                                 "carimbos repetidos na trilha")

    def test_virada_do_mes_no_meio_da_geracao_nao_muda_a_forma(self):
        """Regressão medida: o relógio era lido 12 vezes, uma por mês.

        O boot que atravessava a virada gerava 9 meses distintos em vez de 10,
        empurrava as linhas do mês novo para o mês velho e zerava a barra do mês
        em curso. A trilha tem de sair de um instante só.
        """
        antes = _instante(2027, 1, 31, 23, 59, 58)
        depois = _instante(2027, 2, 1, 0, 0, 1)
        chamadas = []

        def relogio(*a):
            chamadas.append(1)
            return antes if len(chamadas) == 1 else depois

        with _relogio(relogio):
            app._historico_demonstracao(self.con)
        self.assertEqual(len(chamadas), 1, "a trilha lê o relógio uma vez só")
        janela, vetor = self._desenho(antes)
        self.assertEqual(vetor, self.DESIGN)
        self.assertEqual(janela[-1], "2027-01")
        self.assertTrue(vetor[-1] > 0, "o mês em curso (o do boot) tem de ter linha")

    def test_carimbos_do_mes_em_curso_sao_distintos_e_no_passado(self):
        # Dia 1 antes das 9h: o carimbo do dia 5–20 cortado contra o agora
        # empilhava as duas linhas no mesmo instante (dois registros idênticos).
        fixo = _instante(2027, 1, 1, 0, 5)
        self._gerar(fixo)
        do_mes = [d for (d,) in self.con.execute(
            "SELECT data FROM historico WHERE data LIKE '2027-01-%'")]
        self.assertEqual(len(do_mes), 2)
        self.assertEqual(len(set(do_mes)), len(do_mes), "carimbos repetidos")
        self.assertTrue(all(d <= "2027-01-01 00:05:00" for d in do_mes))

    def test_carimbo_no_primeiro_instante_do_mes_fica_no_mes(self):
        # Sem espaço para recuar, o piso é o primeiro segundo do mês: recuar
        # para o mês anterior moveria a barra e zeraria o mês em curso.
        self.assertEqual(app._carimbo_mes_em_curso(2027, 1, 0, "2027-01-01 00:00:00"),
                         "2027-01-01 00:00:00")
        self.assertEqual(app._carimbo_mes_em_curso(2027, 1, 3, "2027-01-01 00:01:00"),
                         "2027-01-01 00:00:00")


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
