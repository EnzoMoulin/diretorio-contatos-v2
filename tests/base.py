#!/usr/bin/env python3
"""Seed compartilhado entre classes de teste: um `init_db()` por processo.

`app.init_db()` reconstrói a base a partir do seed e leva ~7 s. Duas classes
precisavam dela (`TestContatosGerais` e a auditoria de dados), e cada uma pagava
a conta inteira: 14 s dos ~45 s da suíte só para montar duas vezes o mesmo
banco.

Aqui a base é montada **uma vez** e cada classe recebe uma cópia do arquivo.
O isolamento é o mesmo de antes (a classe continua livre para inserir, apagar e
deixar lixo), o custo é uma cópia de ~850 KB por classe, e a asserção de cada
teste continua valendo para o seed limpo — que é o que a auditoria diz medir.

    class TestAlgo(base.BaseComSeed):
        def test_alguma_coisa(self):
            self.consulta("SELECT ...")   # conexão da classe, no banco da classe

Quem preferir conexão por teste (para não herdar transação aberta) abre a sua em
`setUp` com `app.get_db()`: `app.DB` já aponta para a cópia da classe.
"""
import atexit
import os
import shutil
import sqlite3
import tempfile
import unittest

import app

_ORIGEM = None
_DIR_ORIGEM = None


def seed_origem():
    """Caminho do banco semeado, criado na primeira chamada do processo."""
    global _ORIGEM, _DIR_ORIGEM
    if _ORIGEM is not None:
        return _ORIGEM
    anterior = app.DB
    _DIR_ORIGEM = tempfile.mkdtemp(prefix="v2-seed-")
    _ORIGEM = os.path.join(_DIR_ORIGEM, "contatos.db")
    app.DB = _ORIGEM
    try:
        app.init_db()
    finally:
        app.DB = anterior
    atexit.register(shutil.rmtree, _DIR_ORIGEM, ignore_errors=True)
    return _ORIGEM


def copiar_seed(destino):
    """Cópia consistente do seed (API de backup do sqlite3, não `cp`).

    `shutil.copy` de um banco em WAL pode levar um arquivo sem as páginas que
    ainda estão no `-wal`. A API de backup resolve isso e é o mesmo mecanismo
    que o `VACUUM INTO` do `/api/backup` usa por baixo.
    """
    origem = sqlite3.connect(seed_origem())
    try:
        alvo = sqlite3.connect(destino)
        try:
            origem.backup(alvo)
        finally:
            alvo.close()
    finally:
        origem.close()


class BaseComSeed(unittest.TestCase):
    """Banco próprio (cópia do seed), conexão de classe e limpeza garantida."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="v2-teste-")
        cls.db_antigo = app.DB
        app.DB = os.path.join(cls.dir, "contatos.db")
        copiar_seed(app.DB)
        cls.con = app.get_db()

    @classmethod
    def tearDownClass(cls):
        cls.con.close()
        app.DB = cls.db_antigo
        shutil.rmtree(cls.dir, ignore_errors=True)
