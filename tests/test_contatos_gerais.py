#!/usr/bin/env python3
"""Contato "sem setor" sobe para o dono: fórum ou comarca — construído do zero.

`build_hierarquia` tem dois destinos para os contatos de uma unidade/setor
virtuais ("Contatos Gerais"): fórum, quando a unidade virtual tem `forum_id`, e
comarca, quando não tem (é o caso da estrutura central). No demo os dois caminhos
existem, mas o da comarca por um fio — uma comarca, cinco contatos. Se esse dado
sumir do seed, a auditoria de integridade continua verde sem nunca ter exercitado
o caminho, e a próxima mudança em `build_hierarquia` pode quebrá-lo em silêncio.

Por isso a cena aqui é sintética: banco temporário criado por `init_db()`, uma
comarca e um fórum escolhidos de propósito, e a unidade+setor virtuais inseridos
à mão. Nada é lido do demo, nada toca no `contatos.db` de quem roda.

    python3 -m unittest tests.test_contatos_gerais -v
"""
import os
import shutil
import tempfile
import unittest

import app


class TestContatosGerais(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        cls.db_antigo = app.DB
        app.DB = os.path.join(cls.dir, "contatos.db")
        app.init_db()

    @classmethod
    def tearDownClass(cls):
        app.DB = cls.db_antigo
        shutil.rmtree(cls.dir, ignore_errors=True)

    def setUp(self):
        self.con = app.get_db()
        # `_CONT` guarda o cursor de ids por tabela: zerar evita que o id
        # sintético colida com um já usado no seed.
        app._CONT.clear()

    def tearDown(self):
        self.con.close()

    def _unidade_e_setor_virtuais(self, unidade_id, forum_id, comarca_id, nome):
        self.con.execute(
            "INSERT INTO unidades (id, forum_id, comarca_id, nome, tipo, endereco, cep,"
            " observacao, selecionavel, ordem_num, ordem_idx, virtual)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,1)",
            (unidade_id, forum_id, comarca_id, nome, "unidade", "", "", "", 0, 1, 0))
        setor_id = "S" + unidade_id[1:] + "T"
        self.con.execute(
            "INSERT INTO setores (id, unidade_id, nome, tipo, endereco, cep, observacao,"
            " selecionavel, ordem_num, ordem_idx, virtual) VALUES (?,?,?,?,?,?,?,?,?,?,1)",
            (setor_id, unidade_id, "Contatos Gerais", "setor", "", "", "", 0, 1, 0))
        return setor_id

    def _contato(self, cid, setor_id, nome):
        self.con.execute(
            "INSERT INTO contatos (id, setor_id, nome, cargo, telefone, email, descricao,"
            " observacao, fonte, vigente_desde, ordem_num, ordem_idx, atualizado_em)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (cid, setor_id, nome, "Fulano de Teste", "(27) 9XXXX-XXXX",
             "fulano@exemplo.jus.br", "contato sintético", "", "", "",
             1, 0, "2026-11-12 00:00:00"))
        self.con.commit()

    def _comarca_sem_gerais(self):
        """Comarca que ainda não recebe contatos gerais — a cena tem de ser nova."""
        ocupadas = {r["id"] for r in self.con.execute(
            "SELECT DISTINCT u.comarca_id AS id FROM unidades u"
            " JOIN setores s ON s.unidade_id = u.id"
            " JOIN contatos c ON c.setor_id = s.id"
            " WHERE s.virtual = 1 AND u.virtual = 1 AND u.forum_id IS NULL")}
        for r in self.con.execute("SELECT id FROM comarcas ORDER BY id"):
            if r["id"] not in ocupadas:
                return r["id"]
        self.fail("toda comarca já tem contatos gerais: a cena sintética perdeu o sentido")

    def test_contato_geral_sobe_para_a_comarca(self):
        comarca_id = self._comarca_sem_gerais()
        setor = self._unidade_e_setor_virtuais(
            "U9001", None, comarca_id, "Estrutura central sintética")
        self._contato("C9001", setor, "Contato da comarca")
        self._contato("C9002", setor, "Segundo da comarca")

        arvore = app.build_hierarquia(self.con)
        comarca = next(c for c in arvore["comarcas"] if c["id"] == comarca_id)

        ids = {c["id"] for c in comarca["contatos"]}
        self.assertEqual(ids, {"C9001", "C9002"},
                         "contato de unidade virtual sem fórum não subiu para a comarca")
        # A unidade virtual não vira nó: ela é o "gerais" da comarca, não um filho.
        self.assertNotIn("U9001", {n["id"] for n in comarca["nos"]},
                         "unidade virtual apareceu como nó da árvore")
        filhos = sum(n["qtdContatos"] for n in comarca["nos"])
        filhos += sum(f["qtdContatos"] for f in comarca["foruns"])
        self.assertEqual(comarca["qtdContatos"], len(comarca["contatos"]) + filhos,
                         "qtdContatos da comarca não somou os contatos gerais")

    def test_contato_geral_sobe_para_o_forum(self):
        forum = self.con.execute(
            "SELECT id, comarca_id FROM foruns ORDER BY id LIMIT 1").fetchone()
        setor = self._unidade_e_setor_virtuais(
            "U9002", forum["id"], forum["comarca_id"], "Atendimento geral sintético")
        self._contato("C9003", setor, "Contato do fórum")

        arvore = app.build_hierarquia(self.con)
        no_forum = next(
            f for c in arvore["comarcas"] if c["id"] == forum["comarca_id"]
            for f in c["foruns"] if f["id"] == forum["id"])

        self.assertIn("C9003", {c["id"] for c in no_forum["contatos"]},
                      "contato de unidade virtual com fórum não subiu para o fórum")
        self.assertNotIn("U9002", {n["id"] for n in no_forum["nos"]})
        filhos = sum(n["qtdContatos"] for n in no_forum["nos"])
        self.assertEqual(no_forum["qtdContatos"], len(no_forum["contatos"]) + filhos)

    def test_o_contato_geral_continua_alcancavel_uma_vez_so(self):
        comarca_id = self._comarca_sem_gerais()
        setor = self._unidade_e_setor_virtuais(
            "U9003", None, comarca_id, "Estrutura central 2")
        self._contato("C9004", setor, "Único da comarca")

        arvore = app.build_hierarquia(self.con)
        vistos = []

        def descer(no):
            vistos.extend(c["id"] for c in no.get("contatos") or [])
            for chave in ("foruns", "nos", "filhos"):
                for filho in no.get(chave) or []:
                    descer(filho)

        for comarca in arvore["comarcas"]:
            descer(comarca)
        self.assertEqual(vistos.count("C9004"), 1,
                         "o contato sintético não apareceu na árvore, ou apareceu"
                         " em dois nós (devia estar em exatamente um)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
