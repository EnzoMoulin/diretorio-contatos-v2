#!/usr/bin/env python3
"""Integridade dos dados servidos: órfãos, nulos, ids repetidos e alcance.

A suíte provava o comportamento (rotas, permissões, procedência) e a fumaça
provava a tela. Faltava provar o **dado**: uma projeção que perde um nó, um seed
que deixa contato sem canal ou um `log()` que grava autor inexistente passavam
despercebidos porque cada teste olhava só o seu recorte.

Régua usada aqui, sempre contra a fonte da verdade local (o banco da própria
cópia), nunca contra número escrito à mão: a base envelhece e o demo muda de
tamanho, mas "a árvore servida alcança a base inteira" continua verdadeiro.

Duas leituras que **não** são defeito e não se testam como tal:
  - nó `virtual` ("Contatos Gerais") é fundido no pai por `ser_no`, então a
    contagem de nós da árvore é menor que unidades+setores do banco — a prova
    de integridade é o número de **contatos** alcançados;
  - `historico.usuario_id` é anulável de propósito (ação sem gente por trás),
    então só se cobra órfão de quem tem autor declarado.

Roda contra o servidor local: python3 -m unittest tests.test_integridade_dados
Exige o servidor no ar (BASE_API, padrão http://localhost:8000).
"""
import json
import os
import sqlite3
import unittest
import urllib.request

BASE = os.environ.get("BASE_API", "http://localhost:8000")
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(RAIZ, "contatos.db")


def consulta(sql, args=()):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def hierarquia():
    with urllib.request.urlopen(BASE + "/api/hierarquia", timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def percorrer(no, nivel, achados):
    """Acumula nós por nível e contatos, descendo as chaves que o projeto usa.

    `comarca` traz os fóruns em `foruns` e a estrutura central em `nos`; `forum`
    desce por `nos`; unidade e setor descem por `filhos`. Errar a chave devolve
    zero e parece dado faltando — por isso a caminhada é explícita por nível.
    """
    achados[nivel].append(no)
    achados["contatos"].extend(no.get("contatos") or [])
    filhos = []
    if nivel == "comarca":
        filhos += [("forum", f) for f in (no.get("foruns") or [])]
        filhos += [("unidade", u) for u in (no.get("nos") or [])]
    elif nivel == "forum":
        filhos += [("unidade", u) for u in (no.get("nos") or [])]
    else:
        filhos += [("setor", s) for s in (no.get("filhos") or [])]
    for proximo, filho in filhos:
        percorrer(filho, proximo, achados)


def soma_contatos(no):
    """Contatos do próprio nó + de toda a subárvore (é o que `qtdContatos` diz)."""
    total = len(no.get("contatos") or [])
    for chave in ("foruns", "nos", "filhos"):
        for filho in no.get(chave) or []:
            total += soma_contatos(filho)
    return total


class TestBaseIntegra(unittest.TestCase):
    """Órfãos, nulos e duplicatas no banco que serve as telas."""

    def test_sem_orfaos_entre_os_niveis(self):
        arestas = {
            "contatos.setor_id": ("contatos", "setor_id", "setores"),
            "setores.unidade_id": ("setores", "unidade_id", "unidades"),
            "unidades.forum_id": ("unidades", "forum_id", "foruns"),
            "foruns.comarca_id": ("foruns", "comarca_id", "comarcas"),
        }
        for nome, (filha, coluna, pai) in arestas.items():
            orfaos = consulta(
                f"SELECT f.id FROM {filha} f WHERE f.{coluna} IS NOT NULL"
                f" AND NOT EXISTS (SELECT 1 FROM {pai} p WHERE p.id = f.{coluna})")
            self.assertEqual([r["id"] for r in orfaos], [],
                             f"{nome}: filho apontando para pai inexistente")

    def test_sem_orfaos_de_usuario(self):
        casos = {
            "acessos": "SELECT x.rowid AS id FROM acessos x WHERE NOT EXISTS"
                       " (SELECT 1 FROM usuarios u WHERE u.id = x.usuario_id)",
            "notificacoes": "SELECT x.id FROM notificacoes x WHERE NOT EXISTS"
                            " (SELECT 1 FROM usuarios u WHERE u.id = x.usuario_id)",
            "historico": "SELECT x.id FROM historico x WHERE x.usuario_id IS NOT NULL"
                         " AND NOT EXISTS (SELECT 1 FROM usuarios u"
                         "                 WHERE u.id = x.usuario_id)",
        }
        for tabela, sql in casos.items():
            self.assertEqual([dict(r) for r in consulta(sql)], [],
                             f"{tabela}: linha apontando para usuário inexistente")

    def test_todo_contato_tem_nome_e_um_canal(self):
        maus = consulta(
            "SELECT id FROM contatos WHERE COALESCE(nome,'')=''"
            " OR (COALESCE(telefone,'')='' AND COALESCE(email,'')='')")
        self.assertEqual([r["id"] for r in maus], [],
                         "contato sem nome ou sem nenhum canal de contato")

    def test_ids_unicos_dentro_de_cada_nivel(self):
        for tabela in ("comarcas", "foruns", "unidades", "setores", "contatos"):
            total, distintos = consulta(
                f"SELECT COUNT(*) AS t, COUNT(DISTINCT id) AS d FROM {tabela}")[0]
            self.assertEqual(total, distintos, f"{tabela}: id repetido na tabela")

    def test_sem_folha_vazia_no_modelo(self):
        # setor sem contato não é "vazio legítimo": é dado que sumiu da tela
        vazios = consulta(
            "SELECT s.id FROM setores s WHERE NOT EXISTS"
            " (SELECT 1 FROM contatos c WHERE c.setor_id = s.id)")
        self.assertEqual([r["id"] for r in vazios], [], "setor sem nenhum contato")


class TestArvoreServida(unittest.TestCase):
    """A projeção de `/api/hierarquia`: nada some, nada duplica, nada sem nome."""

    @classmethod
    def setUpClass(cls):
        cls.arvore = hierarquia()
        cls.achados = {"comarca": [], "forum": [], "unidade": [], "setor": [],
                       "contatos": []}
        for comarca in cls.arvore.get("comarcas") or []:
            percorrer(comarca, "comarca", cls.achados)

    def test_a_arvore_alcanca_a_base_inteira(self):
        no_banco = consulta("SELECT COUNT(*) AS c FROM contatos")[0]["c"]
        servidos = {c.get("id") for c in self.achados["contatos"]}
        self.assertEqual(len(self.achados["contatos"]), len(servidos),
                         "o mesmo contato aparece em mais de um nó")
        self.assertEqual(len(servidos), no_banco,
                         "a árvore não serve todos os contatos do banco")

    def test_ids_unicos_dentro_do_nivel(self):
        for nivel in ("comarca", "forum", "unidade", "setor"):
            ids = [n.get("id") for n in self.achados[nivel]]
            self.assertEqual(len(ids), len(set(ids)),
                             f"{nivel}: id repetido entre nós do mesmo nível")

    def test_todo_no_tem_nome(self):
        vazios = [f"{nivel} {n.get('id')}"
                  for nivel in ("comarca", "forum", "unidade", "setor")
                  for n in self.achados[nivel]
                  if not (n.get("nome") or "").strip()]
        self.assertEqual(vazios, [], "nó sem nome na árvore servida")

    def test_qtd_contatos_declarado_bate_com_a_subarvore(self):
        # O contador que a tela mostra é calculado no servidor: tem de fechar
        # com o que a própria árvore entrega, nó por nó.
        problemas = []
        for nivel in ("comarca", "forum", "unidade", "setor"):
            for no in self.achados[nivel]:
                declarado = no.get("qtdContatos")
                if declarado is None:
                    continue
                real = soma_contatos(no)
                if declarado != real:
                    problemas.append(
                        f"{nivel} {no.get('nome')} ({no.get('id')}):"
                        f" declarado {declarado}, árvore {real}")
        self.assertEqual(problemas, [], "contador declarado divergiu da subárvore")


if __name__ == "__main__":
    unittest.main(verbosity=2)
