#!/usr/bin/env python3
"""Procedência do contato no v2: `fonte` + `vigente_desde` (stdlib unittest).

O que o v1 e o v2 guardavam como texto livre em `observacao`
("Contato provisório — validar vigência.") passa a ser campo: qual documento
trouxe o valor e de quando ele é. Sem isso não há como filtrar o que precisa
de reconfirmação nem ordenar por idade do dado.

Roda contra o servidor local: python3 -m unittest tests.test_procedencia
Exige o servidor no ar (BASE_API, padrão http://localhost:8000).
"""
import json
import os
import sqlite3
import sys
import time
import unittest
import urllib.error
import urllib.request

BASE = os.environ.get("BASE_API", "http://localhost:8000")
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(RAIZ, "contatos.db")
sys.path.insert(0, RAIZ)

OFICIO = "ofício 432/2024 — diretoria do foro"
CATALOGO = "catálogo de ramais — agosto/2026"
BASE_SEED = "base do sistema (sem documento declarado)"


def api(method, path, corpo=None, token=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(corpo or {}).encode("utf-8"),
        headers={"Content-Type": "application/json", **(
            {"X-Admin-Token": token} if token else {})})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            return e.code, {}


def consulta(sql, args=()):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


class TestProcedenciaNoBanco(unittest.TestCase):
    """A base carregada do seed tem de sair com procedência preenchida."""

    def test_nenhum_contato_sem_fonte(self):
        vazio = consulta(
            "SELECT COUNT(*) AS c FROM contatos WHERE COALESCE(fonte,'')=''")[0]["c"]
        self.assertEqual(vazio, 0, "contato sem procedência no seed")

    def test_as_tres_origens_do_seed(self):
        # 43 vêm do Ofício 432/2024, 286 do catálogo da Sede (agosto/2026)
        # e o resto da base sem documento declarado: 43 + 286 + 1.478 = 1.807
        contagem = {r["fonte"]: r["c"] for r in consulta(
            "SELECT fonte, COUNT(*) AS c FROM contatos GROUP BY fonte")}
        self.assertEqual(contagem.get(OFICIO), 43)
        self.assertEqual(contagem.get(CATALOGO), 286)
        self.assertEqual(contagem.get(BASE_SEED), 1478)

    def test_data_da_fonte_casa_com_o_documento(self):
        datas = {r["fonte"]: r["d"] for r in consulta(
            "SELECT fonte, MIN(vigente_desde) AS d FROM contatos GROUP BY fonte")}
        self.assertEqual(datas[OFICIO], "2024-03-01")
        self.assertEqual(datas[CATALOGO], "2026-08-28")
        # a base sem documento não inventa data de vigência
        self.assertEqual(datas[BASE_SEED], "")

    def test_vigente_desde_so_em_iso_ou_vazio(self):
        ruins = consulta(
            "SELECT id, vigente_desde FROM contatos"
            " WHERE vigente_desde<>'' AND vigente_desde NOT GLOB"
            " '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'")
        self.assertEqual([dict(r) for r in ruins], [])

    def test_provisorio_nao_e_mais_so_texto(self):
        # todo contato que se diz provisório na observação tem fonte de ofício
        orfaos = consulta(
            "SELECT id FROM contatos WHERE lower(observacao) LIKE '%provis%'"
            " AND fonte <> ?", (OFICIO,))
        self.assertEqual([r["id"] for r in orfaos], [])


class TestPreenchimentoIdempotente(unittest.TestCase):
    """`_procedencia_preencher` roda a cada boot: não pode sobrescrever nada."""

    def test_nao_sobrescreve_edicao_manual(self):
        import app  # noqa: E402  (importar não sobe servidor nem toca o banco)
        con = sqlite3.connect(":memory:")
        con.row_factory = sqlite3.Row
        con.execute("CREATE TABLE contatos (id TEXT, fonte TEXT,"
                    " vigente_desde TEXT, observacao TEXT)")
        con.executemany(
            "INSERT INTO contatos VALUES (?,?,?,?)",
            [("C1", "", "", "Contato provisório — validar vigência."),
             ("C2", "", "", "ramal do catálogo de agosto/2026"),
             ("C3", "", "", ""),
             ("C4", "edição manual", "2026-11-11", "Contato provisório.")])
        app._procedencia_preencher(con)
        linhas = {r["id"]: (r["fonte"], r["vigente_desde"])
                  for r in con.execute("SELECT * FROM contatos")}
        self.assertEqual(linhas["C1"], (OFICIO, "2024-03-01"))
        self.assertEqual(linhas["C2"], (CATALOGO, "2026-08-28"))
        self.assertEqual(linhas["C3"], (BASE_SEED, ""))
        self.assertEqual(linhas["C4"], ("edição manual", "2026-11-11"))
        # segunda passada: nada muda
        app._procedencia_preencher(con)
        depois = {r["id"]: (r["fonte"], r["vigente_desde"])
                  for r in con.execute("SELECT * FROM contatos")}
        self.assertEqual(linhas, depois)
        con.close()


class TestProcedenciaNaApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        st, corpo = api("POST", "/api/login",
                        {"usuario": "admin", "senha": "admin123"})
        assert st == 200, corpo
        cls.tok = corpo["token"]

    def test_lista_plana_expoe_fonte(self):
        st, lista = api("GET", "/api/contatos?q=99820")
        self.assertEqual(st, 200)
        self.assertTrue(lista)
        self.assertEqual(lista[0]["fonte"], OFICIO)
        self.assertEqual(lista[0]["vigente_desde"], "2024-03-01")

    def test_edicao_de_telefone_vira_procedencia_manual(self):
        linha = consulta("SELECT * FROM contatos WHERE telefone<>''"
                         " AND email='' ORDER BY id LIMIT 1")[0]
        antes = (linha["fonte"], linha["vigente_desde"])
        hoje = time.strftime("%Y-%m-%d")
        st, _ = api("PUT", "/api/contatos/" + linha["id"],
                    {"nome": linha["nome"], "cargo": linha["cargo"],
                     "telefone": linha["telefone"] + "9", "email": ""},
                    token=self.tok)
        self.assertEqual(st, 200)
        depois = consulta("SELECT fonte, vigente_desde FROM contatos"
                          " WHERE id=?", (linha["id"],))[0]
        self.assertEqual(depois["fonte"], "edição manual")
        self.assertEqual(depois["vigente_desde"], hoje)
        # devolve o dado e a procedência originais: o teste não suja o demo
        con = sqlite3.connect(DB)
        con.execute("UPDATE contatos SET telefone=?, fonte=?, vigente_desde=?"
                    " WHERE id=?",
                    (linha["telefone"], antes[0], antes[1], linha["id"]))
        con.commit()
        con.close()

    def test_edicao_sem_mudar_valor_nao_marca_manual(self):
        linha = consulta("SELECT * FROM contatos WHERE fonte=? AND telefone<>''"
                         " ORDER BY id LIMIT 1", (CATALOGO,))[0]
        st, _ = api("PUT", "/api/contatos/" + linha["id"],
                    {"nome": linha["nome"], "cargo": linha["cargo"],
                     "telefone": linha["telefone"], "email": ""},
                    token=self.tok)
        self.assertEqual(st, 200)
        fonte = consulta("SELECT fonte FROM contatos WHERE id=?",
                         (linha["id"],))[0]["fonte"]
        self.assertEqual(fonte, CATALOGO)


if __name__ == "__main__":
    unittest.main(verbosity=2)
