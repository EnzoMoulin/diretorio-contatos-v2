#!/usr/bin/env python3
"""Privacidade do que fica publicado: nenhum telefone real no repositório.

Regra dura do projeto: telefone sai da planilha já mascarado (`XXXX` no lugar
dos dígitos variáveis, mantendo o formato) e o dado de exemplo embutido no
`app.py` usa o bloco fictício `3333-00NN`. Este caso varre o seed estruturado
e a árvore inteira: se alguém reintroduzir um número verdadeiro, o CI fica
vermelho antes de o repositório ser publicado ou divulgado.
"""
import json
import os
import re
import unittest

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED = os.path.join(RAIZ, "seed_mascarado.json")
PULAR_DIR = {".git", "node_modules", "__pycache__", "backups", "screenshots"}
PULAR_EXT = {".png", ".jpg", ".jpeg", ".mp4", ".pdf", ".ico", ".woff",
             ".woff2", ".db", ".sqlite", ".zip", ".pyc"}
TIPOS_TELEFONE = {"Telefone", "Ramal", "WhatsApp"}
# Telefone completo: DDD opcional + 8 ou 9 dígitos, com ou sem separadores.
TELEFONE = re.compile(
    r"(?<![\w-])(?:\(?\d{2}\)?[\s.\-]?)?\d{4,5}[\s.\-]?\d{4}(?![\w-])")
EXEMPLO = re.compile(r"\(27\) 3333-00\d\d")  # bloco do dado de exemplo


def mascarado(valor):
    """Máscara `XXXX` ou o bloco fictício do exemplo: só isso passa."""
    return "X" in valor or bool(EXEMPLO.fullmatch(valor.strip()))


class TestSemTelefoneReal(unittest.TestCase):
    def test_seed_nao_guarda_digito_de_telefone(self):
        with open(SEED, encoding="utf-8") as f:
            dados = json.load(f)
        for item in dados["contatos"] + dados["uteis"]:
            if item.get("tipo") in TIPOS_TELEFONE:
                with self.subTest(id=item["id"], tipo=item["tipo"]):
                    self.assertTrue(mascarado(item["valor"]),
                                    "telefone/ramal sem a máscara XXXX")

    def test_nenhum_arquivo_do_repo_tem_telefone_real(self):
        achados = []
        for base, dirs, arquivos in os.walk(RAIZ):
            dirs[:] = [d for d in dirs if d not in PULAR_DIR]
            for nome in arquivos:
                if os.path.splitext(nome)[1].lower() in PULAR_EXT:
                    continue
                caminho = os.path.join(base, nome)
                try:
                    with open(caminho, encoding="utf-8") as f:
                        texto = f.read()
                except (OSError, UnicodeDecodeError):
                    continue
                for achado in TELEFONE.finditer(texto):
                    if mascarado(achado.group()):
                        continue
                    linha = texto.count("\n", 0, achado.start()) + 1
                    achados.append("%s:%d: %s" % (
                        os.path.relpath(caminho, RAIZ), linha, achado.group()))
        self.assertEqual(achados, [],
                         "telefone fora do padrão sintético (XXXX ou 3333-00NN)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
