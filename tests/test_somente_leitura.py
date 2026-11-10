#!/usr/bin/env python3
"""Modo somente leitura (`SIMULACAO_AUTO_APROVAR=0`): pedido pendente, sem edição.

A perna do CI com a flag em `0` roda esta classe. No modo automático (`1`) o
pedido nasceria aprovado e o visitante herdaria o escopo na hora, então os três
casos abaixo deixariam de valer: a classe se pula inteira (o `unittest` conta a
classe pulada como um skip só, embora ela tenha três testes).
"""
import os
import sqlite3
import unittest

from tests.test_regras import DB, api, notif_limpar, notif_marco
from tests.test_seguranca_demo import (
    apagar_pedidos, apagar_usuario, criar_usuario, login, status_pedido)


class TestSomenteLeitura(unittest.TestCase):
    """O visitante do demo pede acesso e não edita nada por conta própria."""

    USUARIO = "t_so_leitura"
    EMAIL = "t-so-leitura@exemplo.jus.br"
    COMARCA = "M2"

    @classmethod
    def setUpClass(cls):
        if os.environ.get("SIMULACAO_AUTO_APROVAR") != "0":
            raise unittest.SkipTest(
                "roda com o servidor em SIMULACAO_AUTO_APROVAR=0 "
                "(demo somente leitura)")
        cls.uid = criar_usuario(cls.USUARIO, cls.EMAIL)
        cls.tok = login(cls.USUARIO)
        con = sqlite3.connect(DB)
        try:
            cls.contato = con.execute(
                "SELECT id FROM contatos ORDER BY id LIMIT 1").fetchone()[0]
        finally:
            con.close()

    @classmethod
    def tearDownClass(cls):
        apagar_pedidos(cls.EMAIL)
        apagar_usuario(cls.USUARIO)

    def test_pedido_de_comarca_fica_pendente(self):
        marco = notif_marco()
        pid = None
        try:
            st, corpo = api(
                "POST", "/api/pedidos",
                {"nome": "Visitante Teste", "email": self.EMAIL,
                 "motivo": "avaliação", "nivel": "comarca",
                 "alvo_id": self.COMARCA}, token=self.tok)
            self.assertEqual(st, 201, corpo)
            pid = corpo["id"]
            self.assertIs(corpo.get("auto_aprovado"), False,
                          f"modo somente leitura não aprova sozinho: {corpo}")
            self.assertEqual(status_pedido(pid), "pendente")
            # sem aprovação não há escopo: o visitante segue sem acesso
            st, me = api("GET", "/api/me", token=self.tok)
            self.assertEqual(st, 200, me)
            self.assertEqual(me.get("escopo"), [])
        finally:
            if pid:
                con = sqlite3.connect(DB)
                try:
                    con.execute("DELETE FROM pedidos WHERE id=?", (pid,))
                    con.commit()
                finally:
                    con.close()
            notif_limpar(marco)

    def test_visitante_nao_edita_contato(self):
        st, corpo = api(
            "PUT", f"/api/contatos/{self.contato}",
            {"nome": "Editado por visitante", "cargo": "x"}, token=self.tok)
        self.assertEqual(st, 403, corpo)

    def test_me_declara_aprovacao_automatica_desligada(self):
        st, me = api("GET", "/api/me", token=self.tok)
        self.assertEqual(st, 200, me)
        # booleano JSON, não 0: o front compara com `=== false`
        self.assertIs(me.get("aprovacao_automatica"), False, me)


if __name__ == "__main__":
    unittest.main()
