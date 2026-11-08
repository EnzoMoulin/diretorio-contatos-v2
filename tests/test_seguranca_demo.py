#!/usr/bin/env python3
"""Segurança do ambiente de avaliação: admin só pela allowlist e gestão fechada.

Os testes batem na API por HTTP (servidor no ar, em modo de avaliação). O caso
da allowlist usa o mesmo `ADMIN_EMAILS` do servidor: se a variável não estiver
no ambiente de quem roda o teste, ele é pulado com aviso (o CI define).
"""
import hashlib
import os
import sqlite3
import unittest

from tests.test_regras import DB, api, notif_marco, notif_limpar

SENHA = "senha-teste-123"


def _senha_legada(senha):
    """sha256 no formato antigo: o login aceita e converte para PBKDF2."""
    return hashlib.sha256(senha.encode("utf-8")).hexdigest()


def criar_usuario(usuario, email, admin=0):
    con = sqlite3.connect(DB)
    try:
        con.execute("DELETE FROM usuarios WHERE usuario=?", (usuario,))
        con.execute(
            "INSERT INTO usuarios (usuario, senha_sha256, aprovado, admin, email)"
            " VALUES (?,?,1,?,?)", (usuario, _senha_legada(SENHA), admin, email))
        con.commit()
        return con.execute("SELECT id FROM usuarios WHERE usuario=?",
                           (usuario,)).fetchone()[0]
    finally:
        con.close()


def apagar_usuario(usuario):
    con = sqlite3.connect(DB)
    try:
        uid = con.execute("SELECT id FROM usuarios WHERE usuario=?",
                          (usuario,)).fetchone()
        if uid:
            con.execute("DELETE FROM acessos WHERE usuario_id=?", (uid[0],))
            con.execute("DELETE FROM notificacoes WHERE usuario_id=?", (uid[0],))
        con.execute("DELETE FROM pedidos WHERE usuario_desejado=?", (usuario,))
        con.execute("DELETE FROM usuarios WHERE usuario=?", (usuario,))
        con.commit()
    finally:
        con.close()


def apagar_pedidos(email):
    """Remove pedidos de um e-mail fictício de teste (rodada anterior interrompida)."""
    con = sqlite3.connect(DB)
    try:
        con.execute("DELETE FROM pedidos WHERE lower(email)=?", (email.lower(),))
        con.commit()
    finally:
        con.close()


def login(usuario):
    st, corpo = api("POST", "/api/login", {"usuario": usuario, "senha": SENHA})
    assert st == 200, corpo
    return corpo["token"]


def status_pedido(pid):
    con = sqlite3.connect(DB)
    try:
        return con.execute("SELECT status FROM pedidos WHERE id=?",
                           (pid,)).fetchone()[0]
    finally:
        con.close()


def admin_do_usuario(usuario):
    con = sqlite3.connect(DB)
    try:
        return con.execute("SELECT admin FROM usuarios WHERE usuario=?",
                           (usuario,)).fetchone()[0]
    finally:
        con.close()


class TestAdminPorAllowlist(unittest.TestCase):
    """Com aprovação automática ligada, admin continua exigindo allowlist."""

    @classmethod
    def setUpClass(cls):
        if os.environ.get("SIMULACAO_AUTO_APROVAR") != "1":
            raise unittest.SkipTest(
                "roda com o servidor em SIMULACAO_AUTO_APROVAR=1 (modo de avaliação)")
        st, corpo = api("POST", "/api/login",
                        {"usuario": "admin", "senha": "admin123"})
        assert st == 200, corpo
        cls.admin_tok = corpo["token"]

    def test_admin_fora_da_allowlist_fica_pendente(self):
        usuario = "t_adm_fora"
        email = "t-adm-fora@exemplo.jus.br"
        marco = notif_marco()
        apagar_pedidos(email)
        criar_usuario(usuario, email)
        try:
            tok = login(usuario)
            st, corpo = api("POST", "/api/pedidos",
                            {"nome": "Fora da allowlist", "usuario": usuario,
                             "admin": True}, token=tok)
            self.assertEqual(st, 201, corpo)
            self.assertFalse(corpo.get("auto_aprovado"),
                             "aprovação automática não pode valer para admin")
            pid = corpo["id"]
            self.assertEqual(status_pedido(pid), "pendente")
            self.assertEqual(admin_do_usuario(usuario), 0)
            st, me = api("GET", "/api/me", token=tok)
            self.assertEqual(st, 200)
            self.assertEqual(me["admin"], 0)
            self.assertFalse(me.get("pode_admin"))
            # nem um admin de verdade efetiva esse pedido
            st, corpo = api("POST", f"/api/pedidos/{pid}/aprovar",
                            {}, token=self.admin_tok)
            self.assertEqual(st, 403, corpo)
            self.assertEqual(status_pedido(pid), "pendente")
            self.assertEqual(admin_do_usuario(usuario), 0)
        finally:
            apagar_usuario(usuario)
            notif_limpar(marco)

    def test_admin_na_allowlist_recebe_admin(self):
        emails = [e.strip().lower() for e in
                  os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()]
        if not emails:
            self.skipTest("ADMIN_EMAILS ausente no ambiente de teste: defina "
                          "o mesmo valor do servidor para exercitar este caso")
        usuario = "t_adm_dentro"
        marco = notif_marco()
        apagar_pedidos(emails[0])
        criar_usuario(usuario, emails[0])
        try:
            tok = login(usuario)
            st, me = api("GET", "/api/me", token=tok)
            self.assertEqual(st, 200)
            self.assertTrue(me.get("pode_admin"),
                            "e-mail da allowlist precisa ver a caixa de Administrador")
            st, corpo = api("POST", "/api/pedidos",
                            {"nome": "Dentro da allowlist", "usuario": usuario,
                             "admin": True}, token=tok)
            self.assertEqual(st, 201, corpo)
            self.assertTrue(corpo.get("auto_aprovado"), corpo)
            self.assertEqual(status_pedido(corpo["id"]), "aprovado")
            self.assertEqual(admin_do_usuario(usuario), 1)
        finally:
            apagar_usuario(usuario)
            notif_limpar(marco)


class TestGestaoFechada(unittest.TestCase):
    """Só admin lê usuários, histórico, pedidos e resumo; visitante recebe 403."""

    @classmethod
    def setUpClass(cls):
        st, corpo = api("POST", "/api/login",
                        {"usuario": "admin", "senha": "admin123"})
        assert st == 200, corpo
        cls.admin_tok = corpo["token"]
        criar_usuario("t_visitante", "t-visitante@exemplo.jus.br")
        cls.visit_tok = login("t_visitante")
        cls.marco = notif_marco()

    @classmethod
    def tearDownClass(cls):
        apagar_usuario("t_visitante")
        notif_limpar(cls.marco)

    def test_visitante_barrado_nas_rotas_de_gestao(self):
        for rota in ("/api/usuarios", "/api/historico", "/api/pedidos",
                     "/api/resumo"):
            st, corpo = api("GET", rota, token=self.visit_tok)
            self.assertEqual(st, 403, f"{rota} vazou para visitante: {corpo}")

    def test_visitante_nao_aprova_nem_recusa(self):
        con = sqlite3.connect(DB)
        try:
            con.execute(
                "INSERT INTO pedidos (nome, email, usuario_desejado, motivo,"
                " nivel, alvo_id, status) VALUES ('Pendente T',"
                " 'pendente-t@exemplo.jus.br','pendente-t','t','setor','S1','pendente')")
            pid = con.execute("SELECT last_insert_rowid()").fetchone()[0]
            con.commit()
        finally:
            con.close()
        try:
            st, corpo = api("POST", f"/api/pedidos/{pid}/aprovar",
                            {}, token=self.visit_tok)
            self.assertEqual(st, 403, corpo)
            st, corpo = api("POST", f"/api/pedidos/{pid}/recusar",
                            {"motivo": "tentativa de visitante"}, token=self.visit_tok)
            self.assertEqual(st, 403, corpo)
            self.assertEqual(status_pedido(pid), "pendente")
        finally:
            con = sqlite3.connect(DB)
            try:
                con.execute("DELETE FROM pedidos WHERE id=?", (pid,))
                con.commit()
            finally:
                con.close()

    def test_visitante_nao_baixa_backup(self):
        st, _ = api("POST", "/api/backup", {}, token=self.visit_tok)
        self.assertEqual(st, 403)

    def test_visitante_segue_com_as_proprias_rotas(self):
        for rota in ("/api/meus-pedidos", "/api/notificacoes"):
            st, corpo = api("GET", rota, token=self.visit_tok)
            self.assertEqual(st, 200, f"{rota} bloqueou o próprio usuário: {corpo}")

    def test_admin_continua_lendo_tudo(self):
        for rota in ("/api/usuarios", "/api/historico", "/api/pedidos",
                     "/api/resumo"):
            st, corpo = api("GET", rota, token=self.admin_tok)
            self.assertEqual(st, 200, f"{rota} quebrou para admin: {corpo}")


class TestNomeDeUsuarioNaoEscala(unittest.TestCase):
    """Pedido com usuario='admin' no corpo não pode herdar a linha do admin.

    O corpo do POST /api/pedidos era a fonte do nome de usuário; com a
    aprovação automática, o upsert por nome reescrevia e-mail e `aprovado` da
    linha `admin`, e o login Google por e-mail passava a devolver admin.
    """

    @classmethod
    def setUpClass(cls):
        st, corpo = api("POST", "/api/login",
                        {"usuario": "admin", "senha": "admin123"})
        assert st == 200, corpo
        cls.admin_tok = corpo["token"]

    def test_usuario_do_corpo_e_ignorado(self):
        usuario = "t_escalada"
        email = "t-escalada@exemplo.jus.br"
        marco = notif_marco()
        apagar_pedidos(email)
        uid_visitante = criar_usuario(usuario, email)
        con = sqlite3.connect(DB)
        try:
            antes = con.execute(
                "SELECT usuario, email, admin, aprovado, senha_sha256"
                " FROM usuarios WHERE usuario='admin'").fetchone()
        finally:
            con.close()
        self.assertIsNotNone(antes, "seed sem usuário admin: teste inválido")

        try:
            tok = login(usuario)
            st, corpo = api("POST", "/api/pedidos",
                            {"nome": "Tentativa de escalada",
                             "usuario": "admin",
                             "escopos": [{"tipo": "setor", "id": "S1"}]},
                            token=tok)
            self.assertEqual(st, 201, corpo)
            pid = corpo["id"]
            if not corpo.get("auto_aprovado"):
                # servidor sem SIMULACAO_AUTO_APROVAR: aprova como admin,
                # para exercitar a concessão de acesso do mesmo jeito
                st_ap, _ = api("POST", "/api/pedidos/%s/aprovar" % pid, {},
                               token=self.admin_tok)
                self.assertEqual(st_ap, 200)

            con = sqlite3.connect(DB)
            try:
                depois = con.execute(
                    "SELECT usuario, email, admin, aprovado, senha_sha256"
                    " FROM usuarios WHERE usuario='admin'").fetchone()
                pedido = con.execute(
                    "SELECT usuario_desejado, usuario_id, email FROM pedidos"
                    " WHERE id=?", (pid,)).fetchone()
                por_email = con.execute(
                    "SELECT id, usuario FROM usuarios WHERE lower(email)=?"
                    " AND aprovado=1", (email,)).fetchone()
                acessos_admin = con.execute(
                    "SELECT COUNT(*) FROM acessos WHERE usuario_id="
                    "(SELECT id FROM usuarios WHERE usuario='admin')").fetchone()[0]
            finally:
                con.close()

            self.assertEqual(depois, antes,
                             "a linha 'admin' foi alterada pelo pedido do visitante")
            self.assertEqual(pedido[0], usuario,
                             "usuario_desejado deveria vir da sessão, não do corpo")
            self.assertEqual(pedido[1], uid_visitante,
                             "o pedido deve guardar o id de quem pediu")
            self.assertIsNotNone(por_email)
            self.assertEqual(por_email[0], uid_visitante,
                             "lookup por e-mail do visitante devolveu outro usuário")
            self.assertNotEqual(por_email[1], "admin")
            self.assertEqual(acessos_admin, 0,
                             "acesso concedido ao admin em nome de um visitante")

            # o acesso concedido é do visitante, não de terceiros
            con = sqlite3.connect(DB)
            try:
                dono = con.execute(
                    "SELECT DISTINCT usuario_id FROM acessos WHERE usuario_id=?",
                    (uid_visitante,)).fetchall()
            finally:
                con.close()
            self.assertTrue(dono, "o pedido aprovado não liberou o visitante")
        finally:
            con = sqlite3.connect(DB)
            try:
                con.execute("DELETE FROM pedidos WHERE lower(email)=?", (email,))
                con.execute("DELETE FROM acessos WHERE usuario_id=?", (uid_visitante,))
                con.commit()
            finally:
                con.close()
            apagar_usuario(usuario)
            notif_limpar(marco)


if __name__ == "__main__":
    unittest.main(verbosity=2)
