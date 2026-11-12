#!/usr/bin/env python3
"""Backup que não restaura não é backup: ida e volta sobre o arquivo real.

O `/api/backup` gera o arquivo com `VACUUM INTO` e o entrega por download, e o
`test_regras` já provava que ele **sai** (200, magic bytes). Faltava a metade
que importa: que ele **volta**. Um dump truncado, uma cópia feita no meio de
uma escrita ou um arquivo que só o `sqlite3` abre e o app não consegue servir
passariam pelo teste anterior sem uma ruga.

O caminho aqui é o de um desastre de verdade:

    base viva → /api/backup → download → apagar → restaurar → contagens iguais

E a prova final não é o `PRAGMA integrity_check`: é `app.build_hierarquia`
lendo o arquivo restaurado e alcançando os mesmos contatos da base viva. Abrir
um SQLite não prova que o app o serve — row factory, tipos e chaves são outra
pergunta.

O segundo caso é o contraprove: um arquivo truncado tem de **reprovar** na
mesma conferência, senão ela não mede nada.

Roda contra o servidor local: python3 -m unittest tests.test_backup_restauracao
"""
import json
import os
import shutil
import sqlite3
import tempfile
import unittest
import urllib.error
import urllib.request

import app

BASE = os.environ.get("BASE_API", "http://localhost:8000")
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(RAIZ, "contatos.db")
BACKUPS = os.path.join(RAIZ, "backups")
TABELAS = ("comarcas", "foruns", "unidades", "setores", "contatos")


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


def contagens(caminho):
    """Contagem das tabelas do catálogo — o que não pode mudar no round trip."""
    con = sqlite3.connect(caminho)
    try:
        return {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                for t in TABELAS}
    finally:
        con.close()


def integridade(caminho):
    """"ok" ou o primeiro problema que o SQLite apontar (nunca exceção)."""
    try:
        con = sqlite3.connect(caminho)
        try:
            return con.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            con.close()
    except sqlite3.DatabaseError as exc:
        return f"ilegível: {exc}"


def contatos_alcancados(arvore):
    """Quantos contatos a árvore servida entrega (a régua de integridade)."""
    total = 0
    for comarca in arvore.get("comarcas") or []:
        pilha = [comarca]
        while pilha:
            no = pilha.pop()
            total += len(no.get("contatos") or [])
            for chave in ("foruns", "nos", "filhos"):
                pilha.extend(no.get(chave) or [])
    return total


def historico_marco():
    con = sqlite3.connect(DB)
    try:
        return con.execute("SELECT COALESCE(MAX(id), 0) FROM historico").fetchone()[0]
    finally:
        con.close()


def historico_limpar(marco):
    """Apaga só as linhas de auditoria que este teste criou (a do backup)."""
    con = sqlite3.connect(DB)
    try:
        con.execute("DELETE FROM historico WHERE id > ? AND acao = 'backup'", (marco,))
        con.commit()
    finally:
        con.close()


class TestBackupRestaura(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        st, corpo = api("POST", "/api/login",
                        {"usuario": "admin", "senha": "admin123"})
        assert st == 200, corpo
        cls.tok = corpo["token"]

    def _gerar_e_baixar(self, destino):
        """Backup gerado pela rota e trazido pelo HTTP, como o admin faz."""
        st, corpo = api("POST", "/api/backup", token=self.tok)
        self.assertEqual(st, 200, corpo)
        arquivo = corpo.get("arquivo", "")
        self.assertTrue(arquivo.endswith(".db"), arquivo)
        self.addCleanup(self._apagar_backup, arquivo)
        req = urllib.request.Request(
            BASE + "/api/backup/" + arquivo,
            headers={"X-Admin-Token": self.tok})
        with urllib.request.urlopen(req) as r:
            self.assertEqual(r.status, 200)
            dados = r.read()
        self.assertTrue(dados.startswith(b"SQLite format 3"), "não é um SQLite")
        with open(destino, "wb") as f:
            f.write(dados)
        return arquivo

    def _apagar_backup(self, arquivo):
        try:
            os.remove(os.path.join(BACKUPS, arquivo))
        except OSError:
            pass

    def test_apagar_restaurar_devolve_as_contagens(self):
        vivo = contagens(DB)
        self.assertGreater(vivo["contatos"], 0, "base sem contato: a prova seria vazia")
        marco = historico_marco()
        self.addCleanup(historico_limpar, marco)
        pasta = tempfile.mkdtemp(prefix="v2-backup-")
        self.addCleanup(shutil.rmtree, pasta, True)
        copia = os.path.join(pasta, "restaurado.db")

        self._gerar_e_baixar(copia)
        self.assertEqual(contagens(copia), vivo, "backup não é cópia fiel da base")
        self.assertEqual(integridade(copia), "ok")

        # Apagar: a mesma cópia fica sem contato nenhum — e a árvore, vazia.
        con = sqlite3.connect(copia)
        con.row_factory = sqlite3.Row
        try:
            con.execute("DELETE FROM contatos")
            con.commit()
            self.assertEqual(contagens(copia)["contatos"], 0)
            self.assertEqual(contatos_alcancados(app.build_hierarquia(con)), 0,
                             "apagar contato não esvaziou a árvore: o teste não apagou nada")
        finally:
            con.close()

        # Restaurar: o arquivo baixado volta por cima do apagado.
        os.remove(copia)
        self._gerar_e_baixar(copia)
        self.assertEqual(contagens(copia), vivo, "restaurar não devolveu as contagens")
        self.assertEqual(integridade(copia), "ok")

        # E o app serve a base restaurada, não só o sqlite3 abre o arquivo.
        con = sqlite3.connect(copia)
        con.row_factory = sqlite3.Row
        try:
            self.assertEqual(contatos_alcancados(app.build_hierarquia(con)),
                             vivo["contatos"],
                             "a árvore da base restaurada não alcançou a base inteira")
        finally:
            con.close()

    def test_backup_truncado_reprova_na_conferencia(self):
        # Contraprove: se o arquivo quebrado passasse, a conferência do caso
        # anterior estaria medindo nada.
        pasta = tempfile.mkdtemp(prefix="v2-backup-cortado-")
        self.addCleanup(shutil.rmtree, pasta, True)
        inteiro = os.path.join(pasta, "inteiro.db")
        cortado = os.path.join(pasta, "cortado.db")
        self._gerar_e_baixar(inteiro)
        with open(inteiro, "rb") as f:
            dados = f.read()
        with open(cortado, "wb") as f:
            f.write(dados[:4096])
        self.assertEqual(integridade(inteiro), "ok")
        self.assertNotEqual(integridade(cortado), "ok",
                            "arquivo truncado passou no integrity_check")


if __name__ == "__main__":
    unittest.main(verbosity=2)
