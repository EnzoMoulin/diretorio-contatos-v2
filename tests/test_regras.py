#!/usr/bin/env python3
"""Regras de negócio do v2 travadas em teste (stdlib unittest).

Roda contra o servidor local: python3 -m unittest tests.test_regras
Exige o servidor no ar (http://localhost:8000).
"""
import json
import os
import sqlite3
import unittest
import urllib.error
import urllib.request

# BASE_API permite rodar a suíte contra outra porta sem derrubar o servidor
# que já estiver na 8000 (por exemplo, o demo local aberto pelo dono).
BASE = os.environ.get("BASE_API", "http://localhost:8000")
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(RAIZ, "contatos.db")
BACKUPS = os.path.join(RAIZ, "backups")


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


def notif_marco():
    """Maior id de notificação antes do teste: marco para apagar só o que ele criar."""
    con = sqlite3.connect(DB)
    try:
        return con.execute("SELECT COALESCE(MAX(id), 0) FROM notificacoes").fetchone()[0]
    finally:
        con.close()


def notif_limpar(marco):
    """Apaga exatamente as notificações criadas depois do marco.

    Notificação é efeito colateral de pedido aprovado/recusado: sem isso o
    banco acumula avisos de teste (badge de não lidas no admin).
    """
    con = sqlite3.connect(DB)
    try:
        ids = [r[0] for r in con.execute(
            "SELECT id FROM notificacoes WHERE id > ?", (marco,))]
        for i in ids:
            con.execute("DELETE FROM notificacoes WHERE id = ?", (i,))
        con.commit()
        return len(ids)
    finally:
        con.close()


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
        # Este teste verifica a aprovação automática do pedido; no modo
        # somente leitura (SIMULACAO_AUTO_APROVAR=0) o pedido fica pendente
        # por projeto, então ele não se aplica.
        if os.environ.get("SIMULACAO_AUTO_APROVAR") != "1":
            raise unittest.SkipTest(
                "roda com o servidor em SIMULACAO_AUTO_APROVAR=1 "
                "(modo de avaliação)")
        pid = None
        marco = notif_marco()
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
            # Limpeza do que este teste criou: o pedido (pid) e o acesso
            # (1, setor, S1) concedido pela aprovação automática dele.
            # O DELETE do acesso é condicionado à existência do pedido
            # aprovado — sem pedido, nada é tocado (sem DELETE por padrão).
            con = sqlite3.connect(DB)
            if pid:
                n = con.execute(
                    "DELETE FROM acessos WHERE usuario_id=1 "
                    "AND nivel='setor' AND alvo_id='S1' "
                    "AND EXISTS (SELECT 1 FROM pedidos WHERE id=? "
                    "AND status='aprovado' AND nivel='setor' "
                    "AND alvo_id='S1')", (pid,)).rowcount
                con.execute("DELETE FROM pedidos WHERE id=?", (pid,))
                assert n <= 1, f"limpeza atingiu {n} acessos"
            con.commit()
            con.close()
            notif_limpar(marco)


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
            sys.path.insert(0, RAIZ)
            import types
            src = open(os.path.join(RAIZ,
                       "app.py"), encoding="utf-8").read().replace(
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


class TestRecusa(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        st, corpo = api("POST", "/api/login",
                        {"usuario": "admin", "senha": "admin123"})
        assert st == 200, corpo
        cls.tok = corpo["token"]

    def _pedido_pendente(self):
        con = sqlite3.connect(DB)
        con.execute(
            "INSERT INTO pedidos (nome, email, usuario_desejado, motivo,"
            " nivel, alvo_id, status)"
            " VALUES ('Recusado T','rec-t@exemplo.jus.br','rect','t','setor','S1','pendente')")
        pid = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        con.commit()
        con.close()
        return pid

    def test_recusa_exige_motivo(self):
        pid = self._pedido_pendente()
        try:
            st, corpo = api("POST", f"/api/pedidos/{pid}/recusar",
                            {"motivo": ""}, token=self.tok)
            self.assertEqual(st, 400)
        finally:
            con = sqlite3.connect(DB)
            con.execute("DELETE FROM pedidos WHERE id=?", (pid,))
            con.commit()
            con.close()

    def test_recusa_com_motivo(self):
        pid = self._pedido_pendente()
        try:
            st, corpo = api("POST", f"/api/pedidos/{pid}/recusar",
                            {"motivo": "escopo errado"}, token=self.tok)
            self.assertEqual(st, 200, corpo)
            con = sqlite3.connect(DB)
            row = con.execute(
                "SELECT status, motivo_recusa FROM pedidos WHERE id=?",
                (pid,)).fetchone()
            con.close()
            self.assertEqual(tuple(row), ("recusado", "escopo errado"))
            st2, _ = api("POST", f"/api/pedidos/{pid}/recusar",
                         {"motivo": "x"}, token=self.tok)
            self.assertEqual(st2, 404)
        finally:
            con = sqlite3.connect(DB)
            con.execute("DELETE FROM pedidos WHERE id=?", (pid,))
            con.commit()
            con.close()


class TestMeusPedidos(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        st, corpo = api("POST", "/api/login",
                        {"usuario": "admin", "senha": "admin123"})
        assert st == 200, corpo
        cls.tok = corpo["token"]
        st, me = api("GET", "/api/me", token=cls.tok)
        assert st == 200, me
        cls.email = me["email"]

    def test_meus_pedidos_mostra_recusa_com_motivo(self):
        marco = notif_marco()
        con = sqlite3.connect(DB)
        con.execute(
            "INSERT INTO pedidos (nome, email, usuario_desejado, motivo,"
            " nivel, alvo_id, status) VALUES ('Eu','" +
            self.email.replace("'", "''") +
            "','admin','t','setor','S1','pendente')")
        pid = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        con.commit()
        con.close()
        try:
            st, _ = api("POST", f"/api/pedidos/{pid}/recusar",
                        {"motivo": "ver depois"}, token=self.tok)
            self.assertEqual(st, 200)
            st, lista = api("GET", "/api/meus-pedidos", token=self.tok)
            self.assertEqual(st, 200)
            item = [p for p in lista if p["id"] == pid]
            self.assertTrue(item)
            self.assertEqual(item[0]["status"], "recusado")
            self.assertEqual(item[0]["motivo_recusa"], "ver depois")
        finally:
            con = sqlite3.connect(DB)
            con.execute("DELETE FROM pedidos WHERE id=?", (pid,))
            con.commit()
            con.close()
            notif_limpar(marco)


class TestBuscaBackup(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        st, corpo = api("POST", "/api/login",
                        {"usuario": "admin", "senha": "admin123"})
        assert st == 200, corpo
        cls.tok = corpo["token"]

    def test_busca_fts_com_highlight(self):
        st, lista = api("GET", "/api/busca?q=atendimento&limite=3", token=self.tok)
        self.assertEqual(st, 200)
        self.assertTrue(lista)
        self.assertIn("<b>", lista[0].get("nome_hl", ""))

    def test_backup_gera_arquivo(self):
        import os as _os
        st, corpo = api("POST", "/api/backup", token=self.tok)
        self.assertEqual(st, 200, corpo)
        arq = corpo.get("arquivo", "")
        self.assertTrue(arq.endswith(".db"))
        caminho = os.path.join(BACKUPS, arq)
        try:
            self.assertTrue(_os.path.isfile(caminho))
            import urllib.request as _url
            req = _url.Request(BASE + "/api/backup/" + arq,
                               headers={"X-Admin-Token": self.tok})
            with _url.urlopen(req) as r:
                self.assertEqual(r.status, 200)
                self.assertTrue(r.read(16).startswith(b"SQLite format 3"))
        finally:
            try:
                _os.remove(caminho)
            except OSError:
                pass

    def test_login_faz_upgrade_para_pbkdf2(self):
        import hashlib as _hl
        velho = _hl.sha256(b"segredo1").hexdigest()
        con = sqlite3.connect(DB)
        con.execute(
            "INSERT INTO usuarios (usuario, senha_sha256, aprovado, email)"
            " VALUES ('tmp-hash',?,1,'tmp-hash@exemplo.jus.br')", (velho,))
        con.commit()
        con.close()
        try:
            st, _ = api("POST", "/api/login",
                        {"usuario": "tmp-hash", "senha": "errada"})
            self.assertEqual(st, 401)
            st, corpo = api("POST", "/api/login",
                            {"usuario": "tmp-hash", "senha": "segredo1"})
            self.assertEqual(st, 200, corpo)
            con = sqlite3.connect(DB)
            novo = con.execute(
                "SELECT senha_sha256 FROM usuarios WHERE usuario='tmp-hash'").fetchone()[0]
            con.close()
            self.assertTrue(novo.startswith("pbkdf2$"))
            st, _ = api("POST", "/api/login",
                        {"usuario": "tmp-hash", "senha": "segredo1"})
            self.assertEqual(st, 200)
        finally:
            con = sqlite3.connect(DB)
            con.execute("DELETE FROM usuarios WHERE usuario='tmp-hash'")
            con.commit()
            con.close()


class TestUsuarios(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        st, corpo = api("POST", "/api/login",
                        {"usuario": "admin", "senha": "admin123"})
        assert st == 200, corpo
        cls.tok = corpo["token"]

    def test_lista_e_ativo(self):
        con = sqlite3.connect(DB)
        con.execute(
            "INSERT INTO usuarios (usuario, senha_sha256, aprovado, email)"
            " VALUES ('tmp-rev','x',1,'tmp-rev@exemplo.jus.br')")
        uid = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        con.commit()
        con.close()
        try:
            st, lista = api("GET", "/api/usuarios", token=self.tok)
            self.assertEqual(st, 200)
            item = [u for u in lista if u["usuario"] == "tmp-rev"]
            self.assertTrue(item)
            self.assertIn("ultimo_login", item[0])
            self.assertEqual(item[0]["ativo"], 1)
            st, _ = api("POST", f"/api/usuarios/{uid}/ativo",
                        {"ativo": 0}, token=self.tok)
            self.assertEqual(st, 200)
            st, lista = api("GET", "/api/usuarios", token=self.tok)
            item = [u for u in lista if u["usuario"] == "tmp-rev"]
            self.assertEqual(item[0]["ativo"], 0)
            st, _ = api("POST", f"/api/usuarios/{uid}/ativo",
                        {"ativo": 1}, token=self.tok)
            self.assertEqual(st, 200)
        finally:
            con = sqlite3.connect(DB)
            con.execute("DELETE FROM usuarios WHERE id=?", (uid,))
            con.commit()
            con.close()


class TestHistoricoAutor(unittest.TestCase):
    """Auditoria sem autor não serve: o registro tem de dizer quem fez."""

    @classmethod
    def setUpClass(cls):
        st, corpo = api("POST", "/api/login",
                        {"usuario": "admin", "senha": "admin123"})
        assert st == 200, corpo
        cls.tok = corpo["token"]

    def test_autor_registrado_na_criacao(self):
        con = sqlite3.connect(DB)
        setor = con.execute("SELECT id FROM setores ORDER BY id LIMIT 1"
                            ).fetchone()[0]
        admin_id = con.execute(
            "SELECT id FROM usuarios WHERE usuario='admin'").fetchone()[0]
        con.close()
        marco = notif_marco()
        st, corpo = api("POST", "/api/contatos",
                        {"nome": "Teste Autor", "setor_id": setor},
                        token=self.tok)
        self.assertEqual(st, 201, corpo)
        cid = corpo["id"]
        try:
            con = sqlite3.connect(DB)
            con.row_factory = sqlite3.Row
            linhas = con.execute(
                "SELECT acao, usuario_id, autor_nome FROM historico"
                " WHERE contato_id=?", (cid,)).fetchall()
            self.assertEqual([r["acao"] for r in linhas], ["criar"])
            self.assertEqual(linhas[0]["usuario_id"], admin_id)
            self.assertEqual(linhas[0]["autor_nome"], "admin")
            autor = con.execute(
                "SELECT u.usuario FROM historico h JOIN usuarios u"
                " ON u.id=h.usuario_id WHERE h.contato_id=?", (cid,)
            ).fetchone()
            self.assertEqual(autor[0], "admin")
            con.close()
            st, hist = api("GET", "/api/historico", token=self.tok)
            self.assertEqual(st, 200)
            item = [h for h in hist if h.get("contato_id") == cid]
            self.assertTrue(item, "a criação não apareceu no histórico")
            self.assertEqual(item[0]["autor"], "admin")
        finally:
            api("DELETE", "/api/contatos/" + cid, token=self.tok)
            # Limpeza cirúrgica: só as linhas de auditoria deste contato de
            # teste (o histórico real é append-only e não se toca).
            con = sqlite3.connect(DB)
            con.execute("DELETE FROM historico WHERE contato_id=?", (cid,))
            con.commit()
            con.close()
            notif_limpar(marco)


if __name__ == "__main__":
    unittest.main(verbosity=2)
