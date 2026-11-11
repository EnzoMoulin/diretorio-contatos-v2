#!/usr/bin/env python3
"""Série mensal da trilha de auditoria (`/api/historico/mensal`).

O gráfico do Registro de alterações lê esta rota. O que o teste trava:

- a janela são 12 meses, em ordem, terminando no mês corrente;
- mês sem alteração vem com zero (o JavaScript não completa calendário);
- a soma dos meses é a soma das ações e nada se perde no caminho;
- linha antiga, fora da janela, continua no `total_geral` — o gráfico resume,
  não apaga a história;
- visitante não lê a trilha (mesma regra do `/api/historico`).

Roda contra o servidor local, como o resto da suíte:
`python3 -m unittest discover -s tests -t . -v`.
"""
import sqlite3
import time
import unittest

from tests.test_regras import DB, api
from tests.test_seguranca_demo import apagar_usuario, criar_usuario, login


class TestHistoricoMensal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        st, corpo = api("POST", "/api/login",
                        {"usuario": "admin", "senha": "admin123"})
        assert st == 200, corpo
        cls.tok = corpo["token"]

    def _mensal(self, token=None):
        return api("GET", "/api/historico/mensal", token=token or self.tok)

    def test_sem_token_403(self):
        st, _ = self._mensal(token="nao-existe")
        self.assertEqual(st, 403)

    def test_visitante_403(self):
        criar_usuario("mensal-visitante", "mensal@exemplo.jus.br")
        try:
            tok = login("mensal-visitante")
            st, corpo = self._mensal(token=tok)
            self.assertEqual(st, 403)
            self.assertIn("permissão", corpo.get("erro", ""))
        finally:
            apagar_usuario("mensal-visitante")

    def test_doze_meses_em_ordem(self):
        st, d = self._mensal()
        self.assertEqual(st, 200)
        meses = [m["mes"] for m in d["meses"]]
        self.assertEqual(len(meses), 12)
        self.assertEqual(meses, sorted(meses))
        self.assertEqual(len(set(meses)), 12)
        self.assertEqual(meses[-1], d["mes_atual"])
        self.assertEqual(meses[-1], time.strftime("%Y-%m"))

    def test_soma_dos_meses_e_das_acoes(self):
        st, d = self._mensal()
        self.assertEqual(st, 200)
        self.assertEqual(d["total"], sum(m["total"] for m in d["meses"]))
        self.assertEqual(d["total"], sum(a["total"] for a in d["acoes"]))
        self.assertLessEqual(d["total"], d["total_geral"])
        self.assertTrue(all(m["total"] >= 0 for m in d["meses"]))
        self.assertTrue(all(a["total"] > 0 for a in d["acoes"]))

    def test_contagem_por_mes_bate_com_o_banco(self):
        st, d = self._mensal()
        self.assertEqual(st, 200)
        con = sqlite3.connect(DB)
        try:
            real = {r[0]: r[1] for r in con.execute(
                "SELECT substr(data,1,7), COUNT(*) FROM historico"
                " WHERE COALESCE(data,'')<>'' GROUP BY 1")}
        finally:
            con.close()
        for m in d["meses"]:
            self.assertEqual(m["total"], real.get(m["mes"], 0), m["mes"])

    def test_mes_vazio_recebe_zero_e_recebe_linha(self):
        st, d = self._mensal()
        self.assertEqual(st, 200)
        vazios = [m["mes"] for m in d["meses"] if m["total"] == 0]
        if not vazios:
            self.skipTest("janela de 12 meses já tem atividade em todos os meses")
        alvo = vazios[0]
        con = sqlite3.connect(DB)
        con.execute("INSERT INTO historico (acao, detalhe, data) VALUES (?,?,?)",
                    ("editar", "teste: mês vazio", alvo + "-10 12:00:00"))
        nid = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        con.commit()
        con.close()
        try:
            st, depois = self._mensal()
            self.assertEqual(st, 200)
            por_mes = {m["mes"]: m["total"] for m in depois["meses"]}
            self.assertEqual(por_mes[alvo], 1, "a linha deveria cair no mês " + alvo)
            self.assertEqual(depois["total"], d["total"] + 1)
        finally:
            con = sqlite3.connect(DB)
            con.execute("DELETE FROM historico WHERE id=?", (nid,))
            con.commit()
            con.close()

    def test_linha_fora_da_janela_fica_no_total_geral(self):
        con = sqlite3.connect(DB)
        con.execute("INSERT INTO historico (acao, detalhe, data)"
                    " VALUES ('editar', 'teste: fora da janela', '2001-01-02 03:04:05')")
        nid = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        con.commit()
        con.close()
        try:
            st, d = self._mensal()
            self.assertEqual(st, 200)
            self.assertNotIn("2001-01", [m["mes"] for m in d["meses"]])
            self.assertEqual(d["total_geral"],
                             con_total_historico())
        finally:
            con = sqlite3.connect(DB)
            con.execute("DELETE FROM historico WHERE id=?", (nid,))
            con.commit()
            con.close()


def con_total_historico():
    con = sqlite3.connect(DB)
    try:
        return con.execute("SELECT COUNT(*) FROM historico").fetchone()[0]
    finally:
        con.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
