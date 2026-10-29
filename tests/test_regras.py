#!/usr/bin/env python3
"""Regras de negócio do v2 travadas em teste (stdlib unittest).

Roda contra o servidor local: python3 -m unittest tests.test_regras
Exige o servidor no ar (http://localhost:8000).
"""
import json
import sqlite3
import unittest
import urllib.error
import urllib.request

BASE = "http://localhost:8000"
DB = "/home/enzo/Emprego/Projetos/diretorio-contatos-v2/contatos.db"


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


class TestIdsGlobais(unittest.TestCase):
    def test_prefixos(self):
        con = sqlite3.connect(DB)
        for tab, pre in [("comarcas", "M"), ("foruns", "F"),
                         ("unidades", "U"), ("setores", "S"),
                         ("contatos", "C")]:
            maus = [r[0] for r in con.execute(
                f"SELECT id FROM {tab}").fetchall()
                if not str(r[0]).startswith(pre)]
            self.assertEqual(maus, [], f"{tab} com id fora do padrão")
        con.close()

    def test_sem_orfaos(self):
        con = sqlite3.connect(DB)
        self.assertEqual(con.execute(
            "SELECT COUNT(*) FROM setores s LEFT JOIN unidades u "
            "ON u.id=s.unidade_id WHERE u.id IS NULL").fetchone()[0], 0)
        self.assertEqual(con.execute(
            "SELECT COUNT(*) FROM contatos t LEFT JOIN setores s "
            "ON s.id=t.setor_id WHERE s.id IS NULL").fetchone()[0], 0)
        con.close()


class TestPedido(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        st, corpo = api("POST", "/api/login",
                        {"usuario": "admin", "senha": "admin123"})
        assert st == 200, corpo
        cls.tok = corpo["token"]

    def test_sem_sessao_401(self):
        st, _ = api("POST", "/api/pedidos", {"nome": "X"})
        self.assertEqual(st, 401)

    def test_sem_nome_400(self):
        st, corpo = api("POST", "/api/pedidos", {"nome": ""},
                        token=self.tok)
        self.assertEqual(st, 400)
        self.assertIn("nome", corpo.get("erro", ""))

    def test_admin_pede_admin_400(self):
        st, corpo = api("POST", "/api/pedidos",
                        {"nome": "T", "admin": True}, token=self.tok)
        self.assertEqual(st, 400)

    def test_cadeia_completa_com_limpeza(self):
        pid = None
        st, corpo = api(
            "POST", "/api/pedidos",
            {"nome": "Teste Auto", "motivo": "teste",
             "nivel": "setor", "alvo_id": "S1"}, token=self.tok)
        self.assertEqual(st, 201, corpo)
        try:
            pid = corpo["id"]
            con = sqlite3.connect(DB)
            ped = con.execute(
                "SELECT nivel, alvo_id, comarca_id, status FROM pedidos "
                "WHERE id=?", (pid,)).fetchone()
            self.assertEqual(tuple(ped), ("setor", "S1", "M2", "aprovado"))
            ac = con.execute(
                "SELECT nivel, alvo_id FROM acessos WHERE usuario_id=1 "
                "AND nivel='setor'").fetchall()
            self.assertIn(("setor", "S1"), [tuple(r) for r in ac])
            con.close()
            # aprovar de novo deve falhar (não está mais pendente)
            st2, _ = api("POST", f"/api/pedidos/{pid}/aprovar",
                         {}, token=self.tok)
            self.assertEqual(st2, 404)
        finally:
            con = sqlite3.connect(DB)
            con.execute("DELETE FROM acessos WHERE usuario_id=1 "
                        "AND nivel='setor' AND alvo_id='S1'")
            if pid:
                con.execute("DELETE FROM pedidos WHERE id=?", (pid,))
            con.commit()
            con.close()


class TestHeranca(unittest.TestCase):
    def test_unidade_cobre_setor_sem_vazar(self):
        con = sqlite3.connect(DB)
        con.execute("INSERT INTO usuarios (usuario, senha_sha256, aprovado,"
                    " admin, email) VALUES ('t_regra','x',1,0,'t@t.com')")
        uid = con.execute("SELECT id FROM usuarios WHERE usuario='t_regra'"
                          ).fetchone()[0]
        try:
            u2 = con.execute("SELECT id FROM unidades WHERE forum_id='F1' "
                             "LIMIT 1").fetchone()[0]
            s1 = con.execute("SELECT id FROM setores WHERE unidade_id=? "
                             "LIMIT 1", (u2,)).fetchone()[0]
            u3 = con.execute("SELECT id FROM unidades WHERE id != ? "
                             "LIMIT 1", (u2,)).fetchone()[0]
            con.execute("INSERT INTO acessos (usuario_id, nivel, alvo_id) "
                        "VALUES (?, 'unidade', ?)", (uid, u2))
            import sys
            sys.path.insert(0, "/home/enzo/Emprego/Projetos/"
                               "diretorio-contatos-v2")
            import types
            src = open("/home/enzo/Emprego/Projetos/diretorio-contatos-v2/"
                       "app.py", encoding="utf-8").read().replace(
                           'if __name__ == "__main__":', "if False:")
            g = {"__name__": "x", "__file__": "app.py"}
            exec(compile(src, "app.py", "exec"), g)  # noqa: S102
            con.row_factory = sqlite3.Row
            h = types.SimpleNamespace()
            for m in ("_user", "_escopo", "_pais", "_cobre"):
                setattr(h, m, g["Handler"].__dict__[m].__get__(h, type(h)))
            self.assertTrue(h._cobre(con, uid, "setor", s1))
            self.assertTrue(h._cobre(con, uid, "unidade", u2))
            self.assertFalse(h._cobre(con, uid, "unidade", u3))
            self.assertFalse(h._cobre(con, uid, "forum", "F1"))
        finally:
            con.execute("DELETE FROM acessos WHERE usuario_id=?", (uid,))
            con.execute("DELETE FROM usuarios WHERE id=?", (uid,))
            con.commit()
            con.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
