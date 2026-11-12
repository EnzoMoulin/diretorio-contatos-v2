#!/usr/bin/env python3
"""Conferência de contato ("✓ Conferi") travada em teste.

Conferir é diferente de editar: o valor e a procedência ficam como estão e o
que se grava é quem olhou e quando. Estes casos garantem que o endpoint exige
sessão, respeita o escopo do setor, devolve o contato atualizado, aparece na
hierarquia (é de lá que o card lê o selo) e deixa rastro no histórico.

Roda contra o servidor local: python3 -m unittest tests.test_conferencia
Base configurável por BASE_API, como as outras suítes.
"""
import json
import os
import sqlite3
import unittest
import urllib.error
import urllib.request

BASE = os.environ.get("BASE_API", "http://localhost:8000")
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(RAIZ, "contatos.db")


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


def entrar(usuario, senha="admin123"):
    return api("POST", "/api/login", {"usuario": usuario, "senha": senha})


def db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


def contato_na_hierarquia(cid):
    """Acha o contato no JSON da árvore (é o que o card usa)."""
    with urllib.request.urlopen(BASE + "/api/hierarquia") as r:
        dados = json.loads(r.read().decode("utf-8"))

    def anda(nos):
        for n in nos or []:
            for c in n.get("contatos") or []:
                if c.get("id") == cid:
                    return c
            achou = anda(n.get("filhos"))
            if achou:
                return achou
        return None

    for m in dados.get("comarcas") or []:
        for f in m.get("foruns") or []:
            achou = anda(f.get("nos"))
            if achou:
                return achou
        achou = anda(m.get("nos"))
        if achou:
            return achou
    return None


class TestConferir(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        st, corpo = entrar("admin")
        assert st == 200, corpo
        cls.tok = corpo["token"]
        _, me = api("GET", "/api/me", token=cls.tok)
        cls.escopo = me.get("escopo")
        # Um contato com procedência: é o tipo que aparece na fila.
        con = db()
        try:
            cls.cid = con.execute(
                "SELECT id FROM contatos WHERE trim(vigente_desde) != ''"
                " ORDER BY id LIMIT 1").fetchone()[0]
            linha = con.execute(
                "SELECT conferido_em, conferido_por FROM contatos WHERE id=?",
                (cls.cid,)).fetchone()
            cls.antes = (linha["conferido_em"], linha["conferido_por"])
            cls.marco_hist = con.execute(
                "SELECT COALESCE(MAX(id), 0) FROM historico").fetchone()[0]
        finally:
            con.close()

    @classmethod
    def tearDownClass(cls):
        """Devolve o contato ao estado anterior: a suíte roda no banco de verdade."""
        con = db()
        try:
            con.execute(
                "UPDATE contatos SET conferido_em=?, conferido_por=? WHERE id=?",
                (cls.antes[0], cls.antes[1], cls.cid))
            con.execute(
                "DELETE FROM historico WHERE id > ? AND acao='conferir'",
                (cls.marco_hist,))
            con.commit()
        finally:
            con.close()

    def test_sem_sessao_403(self):
        st, _ = api("POST", "/api/contatos/%s/conferir" % self.cid)
        self.assertEqual(st, 403)

    def test_contato_inexistente_404(self):
        st, _ = api("POST", "/api/contatos/NAOEXISTE/conferir", token=self.tok)
        self.assertEqual(st, 404)

    def test_sem_escopo_403(self):
        # Usuário aprovado e sem nenhum acesso a local: é o visitante recém-cadastrado.
        # (O login local só aceita contas que existem, então a conta nasce aqui,
        # com senha no formato antigo — o login aceita e converte.)
        import hashlib
        con = db()
        try:
            con.execute("DELETE FROM usuarios WHERE usuario='t_conferir'")
            con.execute(
                "INSERT INTO usuarios (usuario, senha_sha256, aprovado, admin, email)"
                " VALUES ('t_conferir',?,1,0,'t_conferir@exemplo.jus.br')",
                (hashlib.sha256(b"segredo1").hexdigest(),))
            con.commit()
        finally:
            con.close()
        try:
            st, corpo = entrar("t_conferir", "segredo1")
            self.assertEqual(st, 200, corpo)
            st, _ = api("POST", "/api/contatos/%s/conferir" % self.cid,
                        token=corpo["token"])
            self.assertEqual(st, 403)
        finally:
            con = db()
            try:
                con.execute("DELETE FROM usuarios WHERE usuario='t_conferir'")
                con.commit()
            finally:
                con.close()

    def test_admin_confere_e_aparece_na_hierarquia(self):
        if self.escopo != "all":
            self.skipTest("admin com escopo %r nesta configuração" % (self.escopo,))
        st, corpo = api("POST", "/api/contatos/%s/conferir" % self.cid,
                        token=self.tok)
        self.assertEqual(st, 200, corpo)
        self.assertRegex(corpo.get("conferido_em", ""), r"^\d{4}-\d{2}-\d{2}")
        self.assertEqual(corpo.get("conferido_por"), "admin")
        # O valor e a procedência não podem ter mudado: conferir não é editar.
        self.assertEqual(corpo.get("vigente_desde"),
                         db().execute("SELECT vigente_desde FROM contatos WHERE id=?",
                                      (self.cid,)).fetchone()[0])
        c = contato_na_hierarquia(self.cid) or {}
        self.assertTrue(c, "contato sumiu da hierarquia")
        self.assertTrue(c.get("conferido_em"), "hierarquia não expõe conferido_em")
        self.assertEqual(c.get("conferido_por"), "admin")

    def test_historico_registra_a_conferencia(self):
        if self.escopo != "all":
            self.skipTest("admin com escopo %r nesta configuração" % (self.escopo,))
        api("POST", "/api/contatos/%s/conferir" % self.cid, token=self.tok)
        con = db()
        try:
            linha = con.execute(
                "SELECT acao, contato_id, detalhe FROM historico"
                " WHERE acao='conferir' AND contato_id=? ORDER BY id DESC LIMIT 1",
                (self.cid,)).fetchone()
        finally:
            con.close()
        self.assertIsNotNone(linha, "conferência não foi auditada")
        self.assertIn("conferido", linha["detalhe"])


if __name__ == "__main__":
    unittest.main()
